/**
 * Meeting Transcription Engine — Incremental chunk transcription
 *
 * Transcribes audio chunks as they arrive on the cloud service, maintaining
 * a rolling transcript buffer per meeting session. Every 3rd chunk triggers
 * a lightweight BTS call to update conversation state (topic/summary/decisions).
 *
 * Chunks for the same session are serialized via a per-session promise chain.
 * Each chunk goes through the silence-detect + tail carry-forward pipeline:
 * 1. Prepend any carried tail audio from the previous chunk
 * 2. Run ffmpeg silencedetect on the last 10s to find a natural speech boundary
 * 3. Split at the silence boundary — transcribe head, carry tail to next chunk
 * 4. Pass the previous chunk's transcript as Whisper prompt conditioning
 *
 * When incremental transcription is active, finalize flushes any remaining
 * tail buffer before marking complete.
 */

import * as fs from 'node:fs/promises';
import { createScopedLogger } from '@core/logger';
import { transcribeAudio } from '@core/services/audioService';
import { getAudioDurationMs } from '@core/services/audioChunking';
import { getSettings } from '@core/services/settingsStore';
import { callBehindTheScenesWithAuth } from '@core/services/behindTheScenesClient';
import { hashSessionId } from '@shared/trackingTypes';

const log = createScopedLogger({ service: 'meeting-transcription-engine' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChunkTranscript {
  chunkIndex: number;
  transcript: string;
  transcribedAt: string;
}

export interface ConversationState {
  currentTopic?: string;
  summary?: string;
  openQuestions?: string[];
  recentDecisions?: string[];
  lastUpdatedAt?: string;
}

export interface MeetingTranscriptionState {
  chunkTranscripts: ChunkTranscript[];
  rollingTranscript: string;
  conversationState?: ConversationState;
  incrementalTranscriptionComplete: boolean;
  /** When true, no more chunks will be accepted (session has been finalized) */
  finalized: boolean;
}

export interface MeetingSegmentAppendedPayload {
  sessionId: string;
  text: string;
  segmentTimestamp: number;
  isFinal: boolean;
}

export interface MeetingTranscriptionAudioOps {
  findLastSilenceInTail: (
    audioFilePath: string,
    totalDurationMs: number,
    tailWindowMs: number,
    options?: { noiseThresholdDb?: number; minSilenceDurationS?: number },
  ) => Promise<{ offsetFromStartMs: number } | null>;
  concatAudioFiles: (file1: string, file2: string) => Promise<string>;
  splitAudioAtOffset: (
    inputPath: string,
    offsetMs: number,
  ) => Promise<{ headPath: string; tailPath: string; tailDurationMs: number }>;
}

type SegmentAppendedCallback = (payload: MeetingSegmentAppendedPayload) => void;
type SessionCleanupCallback = (sessionId: string) => void;

// ---------------------------------------------------------------------------
// In-memory state per session
// ---------------------------------------------------------------------------

const sessionTranscriptionState = new Map<string, MeetingTranscriptionState>();

const CONVERSATION_STATE_INTERVAL = 3; // Update every 3rd chunk

// Timeout per chunk transcription to prevent queue deadlocks (30s)
const CHUNK_TRANSCRIPTION_TIMEOUT_MS = 30_000;

// Silence detection: analyze the last N ms of each chunk for a natural split point
const TAIL_WINDOW_MS = 10_000;

// Minimum tail duration worth carrying forward (avoid trivially short tails)
const MIN_TAIL_DURATION_MS = 100;

// Maximum words from previous transcript to use as Whisper prompt conditioning
const PROMPT_CONDITIONING_MAX_WORDS = 100;

const defaultMeetingTranscriptionAudioOps: MeetingTranscriptionAudioOps = {
  findLastSilenceInTail: async () => null,
  concatAudioFiles: async () => {
    throw new Error('meeting-transcription-audio-ops-missing-concat');
  },
  splitAudioAtOffset: async () => {
    throw new Error('meeting-transcription-audio-ops-missing-split');
  },
};

let meetingTranscriptionAudioOps: MeetingTranscriptionAudioOps = defaultMeetingTranscriptionAudioOps;

export function setMeetingTranscriptionAudioOps(
  updates: Partial<MeetingTranscriptionAudioOps>,
): void {
  meetingTranscriptionAudioOps = {
    ...meetingTranscriptionAudioOps,
    ...updates,
  };
}

function getMeetingTranscriptionAudioOps(): MeetingTranscriptionAudioOps {
  return meetingTranscriptionAudioOps;
}

// ---------------------------------------------------------------------------
// Per-session tail buffer and prompt conditioning state
// ---------------------------------------------------------------------------

interface TailBuffer {
  /** Path to the tail audio temp file */
  audioFilePath: string;
  /** Duration of the tail audio in ms */
  durationMs: number;
  /** Chunk index this tail was split from */
  fromChunkIndex: number;
}

/**
 * Carried tail audio from the previous chunk — prepended to the next chunk
 * so transcription starts at a natural speech boundary.
 */
const sessionTailBuffers = new Map<string, TailBuffer>();

/**
 * Previous chunk's transcript text — passed as Whisper prompt conditioning
 * to improve continuity across chunk boundaries.
 */
const sessionPreviousTranscripts = new Map<string, string>();

// ---------------------------------------------------------------------------
// Per-session serialization queue
// ---------------------------------------------------------------------------

/**
 * Per-session promise chain. Chunks for the same session are serialized so that
 * tail carry-forward (Stage 2) can safely depend on the previous chunk's result.
 * Different sessions process independently and in parallel.
 */
const sessionQueues = new Map<string, Promise<void>>();
const segmentAppendedCallbacks = new Set<SegmentAppendedCallback>();
const sessionCleanupCallbacks = new Set<SessionCleanupCallback>();

/**
 * Enqueue async work for a session. Work items execute sequentially per session.
 * The chain continues even if a work item rejects (errors are caught internally).
 */
function enqueueSessionWork(sessionId: string, work: () => Promise<void>): void {
  const prev = sessionQueues.get(sessionId) ?? Promise.resolve();
  const next = prev.then(work, work); // always continue chain even on error
  sessionQueues.set(sessionId, next);
}

/**
 * Wait for all queued work for a session to complete.
 * Used by finalize to ensure no in-flight chunks are lost.
 */
async function drainSessionQueue(sessionId: string): Promise<void> {
  const queue = sessionQueues.get(sessionId);
  if (queue) await queue;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function onSegmentAppended(callback: SegmentAppendedCallback): () => void {
  segmentAppendedCallbacks.add(callback);
  return () => {
    segmentAppendedCallbacks.delete(callback);
  };
}

export function onTranscriptionSessionCleanup(callback: SessionCleanupCallback): () => void {
  sessionCleanupCallbacks.add(callback);
  return () => {
    sessionCleanupCallbacks.delete(callback);
  };
}

/**
 * Transcribe a single chunk asynchronously (fire-and-forget from chunk upload handler).
 * Chunks for the same session are serialized via the per-session promise chain.
 * The outer function remains fire-and-forget compatible (no await needed by caller).
 */
export function transcribeChunkAsync(
  sessionId: string,
  chunkIndex: number,
  chunkFilePath: string,
): void {
  enqueueSessionWork(sessionId, () => transcribeChunkWork(sessionId, chunkIndex, chunkFilePath));
}

/**
 * Internal: the actual chunk transcription work, executed within the session queue.
 * Wrapped with a timeout to prevent deadlocks from hung transcription calls.
 */
async function transcribeChunkWork(
  sessionId: string,
  chunkIndex: number,
  chunkFilePath: string,
): Promise<void> {
  // Timeout wrapper to prevent a single hung chunk from blocking the entire queue
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Chunk transcription timed out after ${CHUNK_TRANSCRIPTION_TIMEOUT_MS}ms`)),
      CHUNK_TRANSCRIPTION_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([
      transcribeChunkInner(sessionId, chunkIndex, chunkFilePath),
      timeoutPromise,
    ]);
  } catch (err) {
    log.error(
      { sessionId, chunkIndex, error: err instanceof Error ? err.message : String(err) },
      'Chunk transcription failed',
    );
  }
}

/**
 * Core chunk transcription logic (no timeout or queue concerns).
 *
 * Full flow:
 * 1. Prepend carried tail from previous chunk (if available and sequential)
 * 2. Run ffmpeg silencedetect on the tail window of the (combined) audio
 * 3. If silence found: split at boundary → transcribe head, save tail for next chunk
 * 4. If no silence: transcribe full audio, no tail saved (graceful fallback)
 * 5. Pass previous chunk's transcript as Whisper prompt conditioning
 * 6. Apply duration-scaled hallucination filter
 * 7. Save transcript for next chunk's prompt conditioning
 */
async function transcribeChunkInner(
  sessionId: string,
  chunkIndex: number,
  chunkFilePath: string,
): Promise<void> {
  log.info({ sessionId, chunkIndex }, 'Starting incremental chunk transcription');

  // Temp files created during this chunk's processing — cleaned up in finally
  const tempFilesToCleanup: string[] = [];
  // Track whether we consumed the prior tail (only delete on success — RF-4)
  let consumedTail: TailBuffer | null = null;
  const audioOps = getMeetingTranscriptionAudioOps();

  try {
    // -----------------------------------------------------------------------
    // 1. Get carried tail from previous chunk
    // -----------------------------------------------------------------------
    const prevTail = sessionTailBuffers.get(sessionId);
    let audioToProcess = chunkFilePath;

    if (prevTail && prevTail.fromChunkIndex === chunkIndex - 1) {
      log.info(
        { sessionId, chunkIndex, tailFromChunk: prevTail.fromChunkIndex, tailDurationMs: prevTail.durationMs },
        'Prepending carried tail from previous chunk',
      );

      // Concat tail + current chunk
      const combinedPath = await audioOps.concatAudioFiles(prevTail.audioFilePath, chunkFilePath);
      tempFilesToCleanup.push(combinedPath);
      audioToProcess = combinedPath;

      // Mark tail as consumed (will delete on success)
      consumedTail = prevTail;
      sessionTailBuffers.delete(sessionId);
    } else if (prevTail) {
      // Tail exists but is non-sequential — discard it
      log.warn(
        { sessionId, chunkIndex, tailFromChunk: prevTail.fromChunkIndex },
        'Discarding non-sequential tail buffer',
      );
      await fs.unlink(prevTail.audioFilePath).catch(() => {});
      sessionTailBuffers.delete(sessionId);
    }

    // -----------------------------------------------------------------------
    // 2. Get audio duration of the (potentially combined) audio
    // -----------------------------------------------------------------------
    const duration = await getAudioDurationMs(audioToProcess).catch(() => null);
    const totalDurationMs = duration?.durationMs ?? 0;

    // -----------------------------------------------------------------------
    // 3. Run silence detection on the tail window
    // -----------------------------------------------------------------------
    let transcriptionAudioPath = audioToProcess;
    let actualTranscriptionDurationMs = totalDurationMs;

    if (totalDurationMs > 0) {
      const silenceBoundary = await audioOps.findLastSilenceInTail(
        audioToProcess,
        totalDurationMs,
        TAIL_WINDOW_MS,
      );

      if (silenceBoundary) {
        // ---------------------------------------------------------------
        // 4a. Split at silence boundary
        // ---------------------------------------------------------------
        const { headPath, tailPath, tailDurationMs } = await audioOps.splitAudioAtOffset(
          audioToProcess,
          silenceBoundary.offsetFromStartMs,
        );
        tempFilesToCleanup.push(headPath);

        transcriptionAudioPath = headPath;

        // Get head duration for hallucination filter
        const headDuration = await getAudioDurationMs(headPath).catch(() => null);
        actualTranscriptionDurationMs = headDuration?.durationMs ?? silenceBoundary.offsetFromStartMs;

        // Save tail for next chunk (only if non-trivial duration)
        if (tailDurationMs > MIN_TAIL_DURATION_MS) {
          sessionTailBuffers.set(sessionId, {
            audioFilePath: tailPath,
            durationMs: tailDurationMs,
            fromChunkIndex: chunkIndex,
          });
          log.info(
            { sessionId, chunkIndex, tailDurationMs },
            'Saved tail buffer for next chunk',
          );
        } else {
          // Trivial tail — clean up
          tempFilesToCleanup.push(tailPath);
        }
      }
      // 4b. No silence found — transcribe full audio, no tail saved
    }

    // -----------------------------------------------------------------------
    // 5. Prompt conditioning from previous chunk's transcript
    // -----------------------------------------------------------------------
    const previousTranscript = sessionPreviousTranscripts.get(sessionId);
    const promptText = previousTranscript
      ? truncateToLastNWords(previousTranscript, PROMPT_CONDITIONING_MAX_WORDS)
      : undefined;

    // -----------------------------------------------------------------------
    // 6. Transcribe
    // -----------------------------------------------------------------------
    const audioBuffer = await fs.readFile(transcriptionAudioPath);
    const transcript = await transcribeAudio({
      audio: audioBuffer.buffer as ArrayBuffer,
      mimeType: 'audio/mp4',
      durationMs: actualTranscriptionDurationMs || undefined,
      prompt: promptText,
    });
    const chunkCompletedAt = Date.now();

    // -----------------------------------------------------------------------
    // 7. Duration-scaled hallucination filter (RF-5)
    // -----------------------------------------------------------------------
    const minWords = durationScaledMinWords(actualTranscriptionDurationMs);
    const wordCount = transcript.trim().split(/\s+/).length;

    if (wordCount < minWords && transcript.trim().length > 0) {
      log.info(
        { sessionId, chunkIndex, wordCount, minWords, durationMs: actualTranscriptionDurationMs },
        'Discarding likely hallucinated transcript (too few words for audio duration)',
      );
      appendChunkTranscript(sessionId, chunkIndex, '', chunkCompletedAt);
    } else {
      appendChunkTranscript(sessionId, chunkIndex, transcript.trim(), chunkCompletedAt);

      // Save transcript for next chunk's prompt conditioning
      if (transcript.trim()) {
        sessionPreviousTranscripts.set(sessionId, transcript.trim());
      }
    }

    log.info(
      { sessionId, chunkIndex, transcriptLength: transcript.length },
      'Chunk transcription complete',
    );

    // -----------------------------------------------------------------------
    // 8. Success — delete consumed tail (RF-4: only after successful transcription)
    // -----------------------------------------------------------------------
    if (consumedTail) {
      await fs.unlink(consumedTail.audioFilePath).catch(() => {});
    }

    // Update conversation state every Nth chunk
    const state = ensureRollingTranscriptState(sessionId);
    const transcribedCount = state.chunkTranscripts.filter((ct) => ct.transcript.length > 0).length;
    if (transcribedCount > 0 && transcribedCount % CONVERSATION_STATE_INTERVAL === 0) {
      void updateConversationState(sessionId).catch((err) => {
        log.warn(
          { sessionId, error: err instanceof Error ? err.message : String(err) },
          'Failed to update conversation state',
        );
      });
    }
  } finally {
    // -----------------------------------------------------------------------
    // Temp file cleanup — always runs, even on error
    // -----------------------------------------------------------------------
    for (const tmpFile of tempFilesToCleanup) {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }
}

function createMeetingTranscriptionState(): MeetingTranscriptionState {
  return {
    chunkTranscripts: [],
    rollingTranscript: '',
    incrementalTranscriptionComplete: false,
    finalized: false,
  };
}

/**
 * Return the current transcription state for a session, if it exists.
 * Read-only helper: does NOT initialize missing session state.
 */
export function getTranscriptionState(sessionId: string): MeetingTranscriptionState | undefined {
  return sessionTranscriptionState.get(sessionId);
}

/**
 * Ensure transcription state exists for a session.
 * Write paths must call this helper before mutating state.
 */
export function ensureRollingTranscriptState(sessionId: string): MeetingTranscriptionState {
  const existing = getTranscriptionState(sessionId);
  if (existing) return existing;

  const created = createMeetingTranscriptionState();
  sessionTranscriptionState.set(sessionId, created);
  return created;
}

/**
 * Get the rolling transcript for a session (used by coaching engine).
 * Returns undefined when no transcription state exists for the session.
 */
export function getRollingTranscript(sessionId: string): string | undefined {
  return getTranscriptionState(sessionId)?.rollingTranscript;
}

/**
 * Get conversation state for a session (used by coaching engine).
 */
export function getConversationState(sessionId: string): ConversationState | undefined {
  return getTranscriptionState(sessionId)?.conversationState;
}

/**
 * Drain the session's chunk queue, flush any remaining tail buffer,
 * then mark incremental transcription as complete.
 * Returns the rolling transcript for use in analysis. Must be awaited by the caller.
 */
export async function flushAndMarkTranscriptionComplete(sessionId: string): Promise<string | null> {
  // Wait for all in-flight chunk transcriptions to finish
  await drainSessionQueue(sessionId);

  // Flush remaining tail buffer — transcribe any carried audio that hasn't been processed
  const tailBuffer = sessionTailBuffers.get(sessionId);
  if (tailBuffer) {
    try {
      log.info(
        { sessionId, tailFromChunk: tailBuffer.fromChunkIndex, tailDurationMs: tailBuffer.durationMs },
        'Flushing remaining tail buffer at finalization',
      );

      const audioBuffer = await fs.readFile(tailBuffer.audioFilePath);
      const previousTranscript = sessionPreviousTranscripts.get(sessionId);
      const promptText = previousTranscript
        ? truncateToLastNWords(previousTranscript, PROMPT_CONDITIONING_MAX_WORDS)
        : undefined;

      const tailTranscript = await transcribeAudio({
        audio: audioBuffer.buffer as ArrayBuffer,
        mimeType: 'audio/mp4',
        durationMs: tailBuffer.durationMs || undefined,
        prompt: promptText,
      });

      // Duration-scaled hallucination filter for tail
      const minWords = durationScaledMinWords(tailBuffer.durationMs);
      const wordCount = tailTranscript.trim().split(/\s+/).length;

      if (wordCount >= minWords || tailTranscript.trim().length === 0) {
        // Append tail transcript directly to rolling transcript (RF-9: no synthetic chunk index)
        const state = ensureRollingTranscriptState(sessionId);
        if (tailTranscript.trim()) {
          state.rollingTranscript = state.rollingTranscript
            ? `${state.rollingTranscript}\n\n${tailTranscript.trim()}`
            : tailTranscript.trim();
        }
      } else {
        log.info(
          { sessionId, wordCount, minWords },
          'Discarding likely hallucinated tail flush transcript',
        );
      }
    } catch (err) {
      log.warn(
        { sessionId, error: err instanceof Error ? err.message : String(err) },
        'Failed to transcribe tail buffer during flush',
      );
    } finally {
      // Always clean up the tail buffer file
      await fs.unlink(tailBuffer.audioFilePath).catch(() => {});
      sessionTailBuffers.delete(sessionId);
    }
  }

  const state = sessionTranscriptionState.get(sessionId);
  if (!state || state.chunkTranscripts.length === 0) {
    return null;
  }
  state.incrementalTranscriptionComplete = true;
  state.finalized = true;
  return state.rollingTranscript;
}

/**
 * Check whether incremental transcription produced a usable transcript.
 */
export function hasIncrementalTranscript(sessionId: string): boolean {
  const state = sessionTranscriptionState.get(sessionId);
  return Boolean(state && state.rollingTranscript.trim().length > 0);
}

/**
 * Clean up transcription state, tail buffers, and session queue for a session.
 */
export function cleanupTranscriptionState(sessionId: string): void {
  // Clean up tail buffer file if it exists
  const tailBuffer = sessionTailBuffers.get(sessionId);
  if (tailBuffer) {
    void fs.unlink(tailBuffer.audioFilePath).catch(() => {});
    sessionTailBuffers.delete(sessionId);
  }

  sessionPreviousTranscripts.delete(sessionId);
  sessionTranscriptionState.delete(sessionId);
  sessionQueues.delete(sessionId);

  for (const callback of [...sessionCleanupCallbacks]) {
    invokeSessionCleanupCallback(callback, sessionId);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function invokeTranscriptionCallback(
  callback: SegmentAppendedCallback,
  payload: MeetingSegmentAppendedPayload,
): void {
  try {
    callback(payload);
  } catch (err) {
    log.error(
      {
        sessionIdHash: hashSessionId(payload.sessionId),
        segmentTimestamp: payload.segmentTimestamp,
        error: err instanceof Error ? err.message : String(err),
      },
      'transcription-callback-error',
    );
  }
}

function invokeSessionCleanupCallback(
  callback: SessionCleanupCallback,
  sessionId: string,
): void {
  try {
    callback(sessionId);
  } catch (err) {
    log.error(
      {
        sessionIdHash: hashSessionId(sessionId),
        error: err instanceof Error ? err.message : String(err),
      },
      'transcription-callback-error',
    );
  }
}

/**
 * Truncate text to approximately N words from the end.
 * Used to cap Whisper prompt conditioning to avoid hallucination from overly long prompts.
 */
function truncateToLastNWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();
  return words.slice(-maxWords).join(' ');
}

/**
 * Duration-scaled hallucination filter (RF-5).
 * Returns the minimum number of words expected for audio of the given duration.
 * Formula: max(1, ceil(3 * durationMs / 60000))
 * - 60s audio → 3 words minimum (matches original MIN_WORDS_FOR_60S_CHUNK)
 * - 30s audio → 2 words minimum
 * - 10s audio → 1 word minimum
 */
function durationScaledMinWords(durationMs: number): number {
  if (!durationMs || durationMs <= 0) return 1;
  return Math.max(1, Math.ceil(3 * durationMs / 60_000));
}

function appendChunkTranscript(
  sessionId: string,
  chunkIndex: number,
  transcript: string,
  segmentTimestamp: number = Date.now(),
): void {
  const state = ensureRollingTranscriptState(sessionId);

  // Refuse work after finalization
  if (state.finalized) {
    log.warn(
      { sessionId, chunkIndex },
      'Rejecting chunk transcript append after finalization',
    );
    return;
  }

  // Avoid duplicates (idempotency)
  const existing = state.chunkTranscripts.find((ct) => ct.chunkIndex === chunkIndex);
  if (existing) {
    return;
  }

  state.chunkTranscripts.push({
    chunkIndex,
    transcript,
    transcribedAt: new Date(segmentTimestamp).toISOString(),
  });

  // Sort by chunk index and rebuild rolling transcript
  state.chunkTranscripts.sort((a, b) => a.chunkIndex - b.chunkIndex);
  state.rollingTranscript = state.chunkTranscripts
    .map((ct) => ct.transcript)
    .filter(Boolean)
    .join('\n\n');

  const payload: MeetingSegmentAppendedPayload = {
    sessionId,
    text: transcript,
    segmentTimestamp,
    isFinal: true,
  };
  for (const callback of [...segmentAppendedCallbacks]) {
    invokeTranscriptionCallback(callback, payload);
  }
}

async function updateConversationState(sessionId: string): Promise<void> {
  const state = ensureRollingTranscriptState(sessionId);
  if (!state.rollingTranscript.trim()) return;

  log.info({ sessionId }, 'Updating conversation state via BTS');

  const settings = getSettings();

  // Use last ~2000 words to keep BTS call fast and cheap
  const words = state.rollingTranscript.split(/\s+/);
  const recentTranscript = words.length > 2000
    ? words.slice(-2000).join(' ')
    : state.rollingTranscript;

  const prompt = `Given this meeting transcript excerpt, extract:
1. Current topic being discussed
2. Brief summary of key points
3. Any open questions raised
4. Any decisions made
Reply as JSON: { "currentTopic": "string", "summary": "string", "openQuestions": ["string"], "recentDecisions": ["string"] }

[TRANSCRIPT]
${recentTranscript}
[/TRANSCRIPT]`;

  try {
    const response = await callBehindTheScenesWithAuth(
      settings,
      {
        codexConnectivity: 'unsupported',
        messages: [{ role: 'user', content: prompt }],
        system: 'You extract conversation state from meeting transcripts. Return strict JSON only.',
        maxTokens: 1024,
        timeout: 15000,
      },
      { category: 'coaching' },
    );

    const textContent = response.content
      .flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
      .join('\n')
      .trim();

    if (!textContent) return;

    // Strip markdown fences if present
    const cleaned = textContent
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?\s*```$/, '')
      .trim();

    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    state.conversationState = {
      currentTopic: typeof parsed.currentTopic === 'string' ? parsed.currentTopic : undefined,
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
      openQuestions: Array.isArray(parsed.openQuestions)
        ? parsed.openQuestions.filter((q): q is string => typeof q === 'string')
        : undefined,
      recentDecisions: Array.isArray(parsed.recentDecisions)
        ? parsed.recentDecisions.filter((d): d is string => typeof d === 'string')
        : undefined,
      lastUpdatedAt: new Date().toISOString(),
    };

    log.info(
      { sessionId, topic: state.conversationState.currentTopic },
      'Conversation state updated',
    );
  } catch (err) {
    log.warn(
      { sessionId, error: err instanceof Error ? err.message : String(err) },
      'Failed to parse conversation state response',
    );
  }
}
