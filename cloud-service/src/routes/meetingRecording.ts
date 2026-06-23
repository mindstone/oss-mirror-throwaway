/**
 * Meeting Recording routes — Handle mobile meeting audio upload and processing.
 *
 * POST /api/meeting/recording-upload
 *   Accepts raw audio upload, saves to durable storage, and kicks off async
 *   processing (chunking → transcription → analysis). Returns 202 immediately.
 *
 * GET /api/meeting/recording-status/:id
 *   Polls for processing completion status.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sendJson, log, sendRouteError, RouteError } from '../httpUtils';
import { transcribeAudio } from '../../../src/core/services/audioService';
import {
  getAudioDurationMs,
  isChunkingRequired,
  chunkAudioFile,
  type ChunkResult,
} from '../../../src/core/services/audioChunking';
import {
  runFallbackAnalysis,
  type CloudMeetingAnalysisDeps,
} from '../services/cloudMeetingAnalysis';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum upload size: 500 MB (2hr at 64kbps AAC ≈ 60MB, generous headroom). */
const MAX_UPLOAD_SIZE_BYTES = 500 * 1024 * 1024;

/** Durable storage directory for meeting recordings (Fly.io persistent volume). */
const RECORDINGS_DIR = '/data/meeting-recordings';

/** Status persistence file path. */
const STATUS_FILE = path.join(RECORDINGS_DIR, 'status.json');

// ---------------------------------------------------------------------------
// Recording Status Tracking
// ---------------------------------------------------------------------------

interface RecordingStatus {
  status: 'processing' | 'complete' | 'failed';
  error?: string;
  startedAt: string;
  completedAt?: string;
}

/** In-memory status map, persisted to disk on each change. */
const recordingStatuses = new Map<string, RecordingStatus>();

/** Idempotency key → recordingId mapping for dedup. */
const idempotencyIndex = new Map<string, string>();

/**
 * Load persisted status from disk on startup.
 * Silently creates the recordings directory if it doesn't exist.
 */
async function loadPersistedStatus(): Promise<void> {
  try {
    await fs.mkdir(RECORDINGS_DIR, { recursive: true });
    const data = await fs.readFile(STATUS_FILE, 'utf-8');
    const parsed = JSON.parse(data) as {
      statuses: Record<string, RecordingStatus>;
      idempotencyKeys: Record<string, string>;
    };

    if (parsed.statuses) {
      for (const [id, status] of Object.entries(parsed.statuses)) {
        recordingStatuses.set(id, status);
      }
    }
    if (parsed.idempotencyKeys) {
      for (const [key, id] of Object.entries(parsed.idempotencyKeys)) {
        idempotencyIndex.set(key, id);
      }
    }

    // Recover stale processing items — if the server crashed during processing,
    // mark them as failed so mobile clients can see the error and retry
    let staleCount = 0;
    for (const [id, status] of recordingStatuses.entries()) {
      if (status.status === 'processing') {
        const startedMs = new Date(status.startedAt).getTime();
        if (Date.now() - startedMs > 60 * 60 * 1000) {
          // Processing for >1hr — almost certainly orphaned
          recordingStatuses.set(id, {
            ...status,
            status: 'failed',
            error: 'Processing interrupted by server restart',
            completedAt: new Date().toISOString(),
          });
          staleCount++;
        }
      }
    }
    if (staleCount > 0) {
      log({ level: 'warn', msg: 'Recovered stale processing recordings', count: staleCount });
      await persistStatus();
    }

    log({ level: 'info', msg: 'Loaded meeting recording statuses', count: recordingStatuses.size });
  } catch (err) {
    // File doesn't exist yet or is invalid — start fresh
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log({ level: 'warn', msg: 'Failed to load recording statuses, starting fresh', error: (err as Error).message });
    }
  }
}

/**
 * Persist current status map to disk.
 */
async function persistStatus(): Promise<void> {
  try {
    const data = {
      statuses: Object.fromEntries(recordingStatuses),
      idempotencyKeys: Object.fromEntries(idempotencyIndex),
    };
    await fs.writeFile(STATUS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    log({ level: 'error', msg: 'Failed to persist recording statuses', error: (err as Error).message });
  }
}

/**
 * Update status for a recording and persist to disk.
 */
async function setRecordingStatus(recordingId: string, status: RecordingStatus): Promise<void> {
  recordingStatuses.set(recordingId, status);
  await persistStatus();
}

// Load persisted status on module load
const _statusLoadPromise = loadPersistedStatus();

// ---------------------------------------------------------------------------
// POST /api/meeting/recording-upload
// ---------------------------------------------------------------------------

export async function handleMeetingRecordingUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: CloudMeetingAnalysisDeps,
): Promise<void> {
  if (req.method !== 'POST') {
    return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only POST is allowed' }));
  }

  // Ensure status is loaded before processing
  await _statusLoadPromise;

  // Validate content type
  const contentType = req.headers['content-type'];
  if (!contentType || !contentType.startsWith('audio/')) {
    return sendRouteError(res, undefined, new RouteError('INVALID_CONTENT_TYPE', { status: 400, message: 'Content-Type must be an audio mime type' }));
  }

  // Parse metadata from headers
  const meetingTitle = decodeHeaderValue(req.headers['x-meeting-title']);
  const meetingStartTime = decodeHeaderValue(req.headers['x-meeting-start-time']);
  const idempotencyKey = decodeHeaderValue(req.headers['x-idempotency-key']);

  // Check content-length hint for early rejection (clients should send this)
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > MAX_UPLOAD_SIZE_BYTES) {
    return sendRouteError(res, undefined, new RouteError('FILE_TOO_LARGE', { status: 413, message: `Upload exceeds maximum size of ${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB` }));
  }

  // Idempotency check: if this key was already used, return the existing status
  if (idempotencyKey) {
    const existingId = idempotencyIndex.get(idempotencyKey);
    if (existingId) {
      const existingStatus = recordingStatuses.get(existingId);
      if (existingStatus) {
        log({ level: 'info', msg: 'Idempotent upload — returning existing status', recordingId: existingId, status: existingStatus.status, idempotencyKey });
        if (existingStatus.status === 'complete') {
          return sendJson(res, 200, { recordingId: existingId, status: 'complete' });
        }
        if (existingStatus.status === 'failed') {
          // Failed: return 200 with failed status so mobile can surface the error
          return sendJson(res, 200, { recordingId: existingId, status: 'failed', error: existingStatus.error });
        }
        // Still processing
        return sendJson(res, 202, { recordingId: existingId, status: 'processing' });
      }
    }
  }

  // Generate recording ID
  const recordingId = randomUUID();
  const ext = contentType.includes('m4a') || contentType.includes('mp4') ? 'm4a'
    : contentType.includes('webm') ? 'webm'
    : contentType.includes('ogg') ? 'ogg'
    : contentType.includes('wav') ? 'wav'
    : contentType.includes('mp3') || contentType.includes('mpeg') ? 'mp3'
    : 'm4a'; // Default for audio/aac and similar
  const audioFilename = `${recordingId}.${ext}`;
  const audioPath = path.join(RECORDINGS_DIR, audioFilename);

  log({
    level: 'info',
    msg: 'Receiving meeting recording upload',
    recordingId,
    contentType,
    contentLength: contentLength || 'unknown',
    meetingTitle: meetingTitle || 'untitled',
    idempotencyKey: idempotencyKey || 'none',
  });

  // Ensure recordings directory exists
  await fs.mkdir(RECORDINGS_DIR, { recursive: true });

  // Stream request body to durable storage
  const fileHandle = await fs.open(audioPath, 'w');
  const writeStream = fileHandle.createWriteStream();
  let totalBytes = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_UPLOAD_SIZE_BYTES) {
          req.destroy();
          reject(new Error('Upload exceeds maximum size'));
          return;
        }
      });
      req.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      req.on('error', reject);
    });
  } catch (err) {
    // Clean up partial file on error
    const closePromise = new Promise<void>((resolve) => {
      if (writeStream.closed) {
        resolve();
        return;
      }
      writeStream.once('close', resolve);
    });
    writeStream.destroy();
    await closePromise;
    await fs.unlink(audioPath).catch(() => {});

    if ((err as Error).message.includes('maximum size')) {
      return sendRouteError(res, undefined, new RouteError('FILE_TOO_LARGE', { status: 413, message: `Upload exceeds maximum size of ${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB` }));
    }
    log({ level: 'error', msg: 'Failed to save uploaded audio', recordingId, error: (err as Error).message });
    return sendRouteError(res, undefined, new RouteError('UPLOAD_FAILED', { status: 500, message: 'Failed to save uploaded audio' }));
  }

  log({ level: 'info', msg: 'Audio saved to durable storage', recordingId, audioPath, totalBytes });

  // Register idempotency key before responding
  if (idempotencyKey) {
    idempotencyIndex.set(idempotencyKey, recordingId);
  }

  // Set initial processing status
  const startedAt = new Date().toISOString();
  await setRecordingStatus(recordingId, { status: 'processing', startedAt });

  // Respond 202 immediately — audio is safely on disk
  sendJson(res, 202, { recordingId, status: 'processing' });

  // Kick off async processing (errors are caught and stored in status)
  processRecordingAsync(recordingId, audioPath, ext, meetingTitle, meetingStartTime, deps).catch((err) => {
    log({ level: 'error', msg: 'Unhandled error in async recording processing', recordingId, error: (err as Error).message });
  });
}

// ---------------------------------------------------------------------------
// GET /api/meeting/recording-status/:id
// ---------------------------------------------------------------------------

export async function handleMeetingRecordingStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  recordingId: string,
): Promise<void> {
  if (req.method !== 'GET') {
    return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only GET is allowed' }));
  }

  // Ensure status is loaded
  await _statusLoadPromise;

  const status = recordingStatuses.get(recordingId);
  if (!status) {
    return sendRouteError(res, undefined, new RouteError('NOT_FOUND', { status: 404, message: 'Recording not found' }));
  }

  return sendJson(res, 200, status);
}

// ---------------------------------------------------------------------------
// Async Processing Pipeline
// ---------------------------------------------------------------------------

/**
 * Process a meeting recording asynchronously:
 * 1. Derive duration via ffprobe
 * 2. Chunk if needed (via core audioChunking)
 * 3. Transcribe each chunk
 * 4. Run fallback analysis with the assembled transcript
 * 5. Update status to complete or failed
 */
async function processRecordingAsync(
  recordingId: string,
  audioPath: string,
  ext: string,
  meetingTitle: string | undefined,
  meetingStartTime: string | undefined,
  deps: CloudMeetingAnalysisDeps,
): Promise<void> {
  let chunkResult: ChunkResult | undefined;

  try {
    log({ level: 'info', msg: 'Starting async recording processing', recordingId });

    // 1. Derive duration
    const duration = await getAudioDurationMs(audioPath);
    log({ level: 'info', msg: 'Audio duration detected', recordingId, durationMs: duration.durationMs, source: duration.source });

    // 2. Check if chunking is needed
    const stats = await fs.stat(audioPath);
    const needsChunking = isChunkingRequired(stats.size);

    let fullTranscript: string;

    if (needsChunking) {
      // 3a. Chunk and transcribe each chunk
      log({ level: 'info', msg: 'Audio requires chunking', recordingId, fileSizeBytes: stats.size });

      chunkResult = await chunkAudioFile(audioPath, { durationMs: duration.durationMs });

      log({ level: 'info', msg: 'Audio chunked', recordingId, chunkCount: chunkResult.chunkPaths.length });

      // Transcribe each chunk sequentially
      const transcripts: string[] = [];
      for (let i = 0; i < chunkResult.chunkPaths.length; i++) {
        const chunkPath = chunkResult.chunkPaths[i];
        const chunkBuffer = await fs.readFile(chunkPath);
        const chunkStats = await fs.stat(chunkPath);

        // Estimate chunk duration proportionally
        const chunkDurationMs = Math.round((chunkStats.size / stats.size) * duration.durationMs);

        log({ level: 'info', msg: 'Transcribing chunk', recordingId, chunk: i + 1, total: chunkResult.chunkPaths.length, chunkSizeBytes: chunkBuffer.length });

        const mimeType = `audio/${ext === 'm4a' ? 'mp4' : ext}`;
        const transcript = await transcribeAudio({
          audio: chunkBuffer.buffer as ArrayBuffer,
          mimeType,
          durationMs: chunkDurationMs,
        });

        transcripts.push(transcript.trim());
        log({ level: 'info', msg: 'Chunk transcribed', recordingId, chunk: i + 1, transcriptLength: transcript.length });
      }

      fullTranscript = transcripts.join('\n');
    } else {
      // 3b. Transcribe the whole file
      log({ level: 'info', msg: 'Audio does not require chunking, transcribing whole file', recordingId, fileSizeBytes: stats.size });

      const audioBuffer = await fs.readFile(audioPath);
      const mimeType = `audio/${ext === 'm4a' ? 'mp4' : ext}`;

      fullTranscript = await transcribeAudio({
        audio: audioBuffer.buffer as ArrayBuffer,
        mimeType,
        durationMs: duration.durationMs,
      });
    }

    log({ level: 'info', msg: 'Transcription complete', recordingId, transcriptLength: fullTranscript.length });

    if (!fullTranscript.trim()) {
      log({ level: 'warn', msg: 'Empty transcript from recording', recordingId });
      await setRecordingStatus(recordingId, {
        status: 'failed',
        error: 'Transcription produced empty result',
        startedAt: recordingStatuses.get(recordingId)?.startedAt ?? new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      return;
    }

    // 4. Resolve meeting metadata
    const resolvedStartTime = meetingStartTime
      ? parseInt(meetingStartTime, 10) || Date.now()
      : Date.now();
    const resolvedTitle = meetingTitle || `Recording ${new Date(resolvedStartTime).toLocaleString()}`;

    // 5. Run fallback analysis
    log({ level: 'info', msg: 'Running meeting analysis', recordingId, meetingTitle: resolvedTitle });

    const analysisResult = await runFallbackAnalysis(
      {
        botId: recordingId,
        userId: 'mobile-recording',
        meetingTitle: resolvedTitle,
        transcript: fullTranscript,
        participants: [],
        meetingStartTime: resolvedStartTime,
      },
      deps,
      'mobile-recording',
    );

    if (analysisResult.success) {
      log({ level: 'info', msg: 'Meeting recording processing complete', recordingId });
      await setRecordingStatus(recordingId, {
        status: 'complete',
        startedAt: recordingStatuses.get(recordingId)?.startedAt ?? new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
    } else {
      log({ level: 'error', msg: 'Meeting analysis failed', recordingId, error: analysisResult.error });
      await setRecordingStatus(recordingId, {
        status: 'failed',
        error: analysisResult.error || 'Analysis failed',
        startedAt: recordingStatuses.get(recordingId)?.startedAt ?? new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    log({ level: 'error', msg: 'Recording processing failed', recordingId, error: (err as Error).message });
    await setRecordingStatus(recordingId, {
      status: 'failed',
      error: (err as Error).message,
      startedAt: recordingStatuses.get(recordingId)?.startedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
  } finally {
    // Always clean up chunk temp files
    if (chunkResult) {
      await chunkResult.cleanup();
      log({ level: 'debug', msg: 'Cleaned up temp chunk files', recordingId });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely decode a header value, handling string | string[] | undefined.
 */
function decodeHeaderValue(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
