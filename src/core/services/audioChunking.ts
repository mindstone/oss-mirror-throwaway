/**
 * Canonical Audio Chunking Utility
 *
 * Consolidates three separate chunking implementations:
 *   1. src/core/services/audioService.ts — WebM chunking via ffmpeg segment
 *   2. src/main/services/physicalRecording/transcriptionService.ts — WAV PCM byte splitting
 *   3. src/main/services/plaud/plaudSyncService.ts — MP3 chunking via ffmpeg segment
 *
 * Provides a unified API for:
 *   - Determining whether chunking is required for a given file size and provider
 *   - Detecting audio duration via ffprobe, WAV header parsing, or bitrate estimation
 *   - Splitting audio files into STT-API-safe chunks (WAV via PCM slicing, others via ffmpeg)
 *   - Checking ffmpeg/ffprobe availability with cached results
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'audioChunking' });

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Standard STT API file size limit (20 MB, with ~5 MB headroom below the 25 MB hard limit). */
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

/** Target chunk size — leave ~2 MB headroom below MAX to absorb ffmpeg splitting variance. */
export const TARGET_CHUNK_SIZE_BYTES = 18 * 1024 * 1024;

/** ElevenLabs Scribe accepts up to 1 GB natively — skip chunking for files under this limit. */
export const ELEVENLABS_MAX_FILE_SIZE_BYTES = 1024 * 1024 * 1024;

/** WAV header size in bytes (RIFF header + fmt chunk + data chunk header). */
const WAV_HEADER_SIZE = 44;

/** Bytes per sample for 16-bit mono PCM audio. */
const WAV_BYTES_PER_SAMPLE = 2;

/** Conservative fallback bitrate assumption (32 kbps) for duration estimation when ffprobe and WAV header are unavailable. */
const FALLBACK_BITRATE_BYTES_PER_SEC = 4000;

/** Minimum chunk duration in seconds to pass to ffmpeg (prevents `-segment_time 0` errors). */
const MIN_CHUNK_DURATION_SEC = 1;

/** Minimum ffmpeg chunk duration clamp (2 min), matching plaudSync's lower bound. */
const MIN_FFMPEG_CHUNK_DURATION_SEC = 120;

/** Maximum ffmpeg chunk duration clamp (30 min). */
const MAX_FFMPEG_CHUNK_DURATION_SEC = 1800;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of splitting an audio file into chunks. */
export interface ChunkResult {
  /** Ordered temp file paths for each chunk. */
  chunkPaths: string[];
  /** Deletes all temp chunk files and the temp directory. */
  cleanup: () => Promise<void>;
}

/** Result of audio duration detection with source attribution. */
export interface AudioDuration {
  /** Duration in milliseconds. */
  durationMs: number;
  /** How the duration was determined. */
  source: 'ffprobe' | 'wav-header' | 'bitrate-estimate';
}

/** Options for `chunkAudioFile()`. */
export interface ChunkOptions {
  /** Target size per chunk in bytes. Defaults to TARGET_CHUNK_SIZE_BYTES. */
  targetChunkSizeBytes?: number;
  /** Known duration in ms — skips ffprobe if provided. */
  durationMs?: number;
  /** Sample rate for WAV PCM splitting. Defaults to 16000. */
  sampleRate?: number;
}

// ---------------------------------------------------------------------------
// Availability checks (cached)
// ---------------------------------------------------------------------------

let _ffmpegAvailable: boolean | null = null;
let _ffprobeAvailable: boolean | null = null;

/**
 * Check if ffmpeg is available on the system.
 * Result is cached after first check.
 */
export async function checkFfmpegAvailable(): Promise<boolean> {
  if (_ffmpegAvailable !== null) {
    return _ffmpegAvailable;
  }

  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000, windowsHide: true });
    _ffmpegAvailable = true;
    log.info('ffmpeg is available for audio chunking');
  } catch {
    _ffmpegAvailable = false;
    log.info('ffmpeg not available — large non-WAV audio files cannot be chunked');
  }

  return _ffmpegAvailable;
}

/**
 * Check if ffprobe is available on the system.
 * Result is cached after first check.
 */
export async function checkFfprobeAvailable(): Promise<boolean> {
  if (_ffprobeAvailable !== null) {
    return _ffprobeAvailable;
  }

  try {
    await execFileAsync('ffprobe', ['-version'], { timeout: 5000, windowsHide: true });
    _ffprobeAvailable = true;
    log.info('ffprobe is available for audio duration detection');
  } catch {
    _ffprobeAvailable = false;
    log.info('ffprobe not available — duration detection will use fallback methods');
  }

  return _ffprobeAvailable;
}

/**
 * Reset cached availability checks. Exposed for testing only.
 * @internal
 */
export function _resetAvailabilityCache(): void {
  _ffmpegAvailable = null;
  _ffprobeAvailable = null;
}

// ---------------------------------------------------------------------------
// isChunkingRequired
// ---------------------------------------------------------------------------

/**
 * Determine whether an audio file needs to be split into chunks for STT.
 *
 * @param fileSizeBytes - File size in bytes.
 * @param provider - Optional STT provider identifier. ElevenLabs Scribe accepts up to 1 GB.
 * @returns true if the file exceeds the provider's size limit.
 */
export function isChunkingRequired(fileSizeBytes: number, provider?: string): boolean {
  if (provider === 'elevenlabs' || provider === 'elevenlabs-scribe') {
    return fileSizeBytes > ELEVENLABS_MAX_FILE_SIZE_BYTES;
  }
  return fileSizeBytes > MAX_FILE_SIZE_BYTES;
}

// ---------------------------------------------------------------------------
// getAudioDurationMs
// ---------------------------------------------------------------------------

/**
 * Detect audio duration using the best available method.
 *
 * Tries (in order):
 *   1. ffprobe — most accurate, works for all formats
 *   2. WAV header parsing — for RIFF/WAVE files
 *   3. Bitrate estimation — conservative fallback from file size
 *
 * @param filePath - Absolute path to the audio file.
 * @returns Duration in ms and the detection method used.
 */
export async function getAudioDurationMs(filePath: string): Promise<AudioDuration> {
  // 1. Try ffprobe
  const probeAvailable = await checkFfprobeAvailable();
  if (probeAvailable) {
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
        { timeout: 10_000, windowsHide: true }
      );
      const durationSec = parseFloat(stdout.trim());
      if (Number.isFinite(durationSec) && durationSec > 0) {
        return { durationMs: Math.round(durationSec * 1000), source: 'ffprobe' };
      }
    } catch (err) {
      log.warn({ err: (err as Error).message, filePath }, 'ffprobe duration detection failed, trying fallback');
    }
  }

  // 2. Try WAV header parsing
  const wavDuration = await tryParseWavDuration(filePath);
  if (wavDuration !== null) {
    return { durationMs: wavDuration, source: 'wav-header' };
  }

  // 3. Fallback: estimate from file size using conservative bitrate
  const stats = await fs.stat(filePath);
  const estimatedDurationSec = stats.size / FALLBACK_BITRATE_BYTES_PER_SEC;
  log.info(
    { filePath, fileSizeBytes: stats.size, estimatedDurationSec: Math.round(estimatedDurationSec) },
    'Using bitrate estimation for audio duration'
  );
  return { durationMs: Math.round(estimatedDurationSec * 1000), source: 'bitrate-estimate' };
}

/**
 * Attempt to parse duration from a WAV file header.
 * Returns duration in ms, or null if the file is not a valid WAV.
 */
async function tryParseWavDuration(filePath: string): Promise<number | null> {
  let fd: fs.FileHandle | null = null;
  try {
    fd = await fs.open(filePath, 'r');
    const headerBuf = Buffer.alloc(WAV_HEADER_SIZE);
    const { bytesRead } = await fd.read(headerBuf, 0, WAV_HEADER_SIZE, 0);

    if (bytesRead < WAV_HEADER_SIZE) return null;

    // Check RIFF/WAVE magic bytes
    const riff = headerBuf.toString('ascii', 0, 4);
    const wave = headerBuf.toString('ascii', 8, 12);
    if (riff !== 'RIFF' || wave !== 'WAVE') return null;

    // Parse fmt chunk
    const audioFormat = headerBuf.readUInt16LE(20);
    if (audioFormat !== 1) return null; // Only PCM

    const numChannels = headerBuf.readUInt16LE(22);
    const sampleRate = headerBuf.readUInt32LE(24);
    const bitsPerSample = headerBuf.readUInt16LE(34);

    // Parse data chunk size
    const dataSize = headerBuf.readUInt32LE(40);
    if (dataSize === 0 || sampleRate === 0 || numChannels === 0 || bitsPerSample === 0) return null;

    const bytesPerSample = (bitsPerSample / 8) * numChannels;
    const totalSamples = dataSize / bytesPerSample;
    const durationSec = totalSamples / sampleRate;

    if (!Number.isFinite(durationSec) || durationSec <= 0) return null;

    return Math.round(durationSec * 1000);
  } catch {
    return null;
  } finally {
    await fd?.close();
  }
}

// ---------------------------------------------------------------------------
// chunkAudioFile
// ---------------------------------------------------------------------------

/**
 * Split an audio file into chunks suitable for STT API upload.
 *
 * - **WAV files**: uses direct PCM byte splitting (no ffmpeg dependency).
 * - **Non-WAV files** (WebM, MP3, M4A, etc.): uses ffmpeg segment splitting.
 *
 * The returned `cleanup` function removes all temp chunk files and the temp directory.
 * Always call `cleanup()` in a `finally` block.
 *
 * @param filePath - Absolute path to the source audio file.
 * @param options - Optional chunk configuration.
 * @returns Ordered chunk file paths and a cleanup function.
 * @throws If ffmpeg is required but unavailable, or if splitting fails.
 */
export async function chunkAudioFile(filePath: string, options?: ChunkOptions): Promise<ChunkResult> {
  const targetSize = options?.targetChunkSizeBytes ?? TARGET_CHUNK_SIZE_BYTES;
  const ext = path.extname(filePath).toLowerCase();
  const isWav = ext === '.wav';

  // Create temp directory for chunks
  const tempDir = path.join(os.tmpdir(), `rebel-audio-chunks-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });

  try {
    if (isWav) {
      return await chunkWavFile(filePath, tempDir, targetSize, options);
    } else {
      return await chunkWithFfmpeg(filePath, tempDir, ext, targetSize, options);
    }
  } catch (err) {
    // On error, clean up the temp directory before re-throwing
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      log.warn({ tempDir, err: (cleanupErr as Error).message }, 'Failed to clean up temp directory after chunking error');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// WAV PCM splitting (ported from physicalRecording/transcriptionService.ts)
// ---------------------------------------------------------------------------

/**
 * Split a WAV file into chunks by slicing raw PCM data and re-wrapping
 * each chunk with a valid WAV header.
 */
async function chunkWavFile(
  filePath: string,
  tempDir: string,
  targetSize: number,
  options?: ChunkOptions
): Promise<ChunkResult> {
  const audioBuffer = await fs.readFile(filePath);
  const sampleRate = options?.sampleRate ?? parseSampleRateFromWavHeader(audioBuffer);

  // Calculate chunk size in PCM bytes
  const bytesPerSecond = sampleRate * WAV_BYTES_PER_SAMPLE;
  // Subtract WAV_HEADER_SIZE from target since each chunk gets its own header
  const pcmChunkSize = Math.max(bytesPerSecond, targetSize - WAV_HEADER_SIZE);

  const audioData = audioBuffer.subarray(WAV_HEADER_SIZE);
  const chunkPaths: string[] = [];
  let offset = 0;
  let chunkIndex = 0;

  while (offset < audioData.length) {
    const chunkEnd = Math.min(offset + pcmChunkSize, audioData.length);
    const pcmSlice = audioData.subarray(offset, chunkEnd);
    const wavChunk = createWavChunk(pcmSlice, sampleRate);

    const chunkPath = path.join(tempDir, `chunk_${String(chunkIndex).padStart(3, '0')}.wav`);
    await fs.writeFile(chunkPath, wavChunk);
    chunkPaths.push(chunkPath);

    offset = chunkEnd;
    chunkIndex++;
  }

  if (chunkPaths.length === 0) {
    throw new Error('WAV file produced zero chunks — file may be empty');
  }

  log.info(
    { totalChunks: chunkPaths.length, sampleRate, pcmChunkSize, filePath },
    'WAV file split into PCM chunks'
  );

  return {
    chunkPaths,
    cleanup: createCleanupFn(tempDir),
  };
}

/**
 * Parse sample rate from a WAV header buffer.
 * Falls back to 16000 Hz if parsing fails.
 */
function parseSampleRateFromWavHeader(wavBuffer: Buffer): number {
  if (wavBuffer.length < WAV_HEADER_SIZE) return 16000;
  const riff = wavBuffer.toString('ascii', 0, 4);
  const wave = wavBuffer.toString('ascii', 8, 12);
  if (riff !== 'RIFF' || wave !== 'WAVE') return 16000;
  const sampleRate = wavBuffer.readUInt32LE(24);
  return sampleRate > 0 ? sampleRate : 16000;
}

/**
 * Create a valid WAV file from raw PCM data.
 * Produces mono 16-bit PCM at the given sample rate.
 *
 * Ported from physicalRecording/transcriptionService.ts `createWavChunk()`.
 */
export function createWavChunk(pcmData: Buffer, sampleRate: number): Buffer {
  const dataSize = pcmData.length;
  const buffer = Buffer.alloc(WAV_HEADER_SIZE + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size for PCM
  buffer.writeUInt16LE(1, 20); // AudioFormat: PCM
  buffer.writeUInt16LE(1, 22); // NumChannels: Mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * WAV_BYTES_PER_SAMPLE, 28); // ByteRate
  buffer.writeUInt16LE(WAV_BYTES_PER_SAMPLE, 32); // BlockAlign
  buffer.writeUInt16LE(16, 34); // BitsPerSample

  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmData.copy(buffer, WAV_HEADER_SIZE);

  return buffer;
}

// ---------------------------------------------------------------------------
// ffmpeg segment splitting (ported from audioService.ts + plaudSyncService.ts)
// ---------------------------------------------------------------------------

/**
 * Split a non-WAV audio file into chunks using ffmpeg's segment muxer.
 * Calculates optimal chunk duration from file size and audio duration.
 */
async function chunkWithFfmpeg(
  filePath: string,
  tempDir: string,
  ext: string,
  targetSize: number,
  options?: ChunkOptions
): Promise<ChunkResult> {
  const ffmpegReady = await checkFfmpegAvailable();
  if (!ffmpegReady) {
    throw new Error('ffmpeg is required for chunking non-WAV audio files but is not available on this system');
  }

  const stats = await fs.stat(filePath);
  const fileSize = stats.size;

  // Determine duration (from options, or detect)
  let durationMs: number;
  if (options?.durationMs && options.durationMs > 0) {
    durationMs = options.durationMs;
  } else {
    const detected = await getAudioDurationMs(filePath);
    durationMs = detected.durationMs;
  }

  const durationSec = durationMs / 1000;
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('Invalid audio duration — cannot calculate chunk size');
  }

  // Calculate optimal chunk duration from bitrate
  const bytesPerSec = fileSize / durationSec;
  const rawChunkDurationSec = Math.floor(targetSize / bytesPerSec);
  const chunkDurationSec = Math.max(
    MIN_FFMPEG_CHUNK_DURATION_SEC,
    Math.min(MAX_FFMPEG_CHUNK_DURATION_SEC, Math.max(MIN_CHUNK_DURATION_SEC, rawChunkDurationSec))
  );

  // Normalize extension for the output pattern
  const outputExt = ext.startsWith('.') ? ext : `.${ext}`;
  const chunkPattern = path.join(tempDir, `chunk_%03d${outputExt}`);

  log.info(
    {
      filePath,
      fileSize,
      durationSec: Math.round(durationSec),
      bytesPerSec: Math.round(bytesPerSec),
      chunkDurationSec,
      tempDir,
    },
    'Splitting audio with ffmpeg segment muxer'
  );

  // Run ffmpeg
  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-i', filePath,
        '-f', 'segment',
        '-segment_time', String(chunkDurationSec),
        '-c', 'copy',
        '-y', // Overwrite existing files
        chunkPattern,
      ],
      { windowsHide: true }
    );

    let stderr = '';
    ffmpeg.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        log.error({ code, stderr: stderr.slice(-500) }, 'ffmpeg chunking failed');
        reject(new Error(`ffmpeg failed with exit code ${code}`));
      }
    });

    ffmpeg.on('error', (err) => {
      log.error({ err: err.message }, 'ffmpeg spawn failed');
      reject(err);
    });
  });

  // Discover chunk files (sorted lexicographically to preserve order)
  const files = await fs.readdir(tempDir);
  const chunkFiles = files
    .filter((f) => f.startsWith('chunk_') && f.endsWith(outputExt))
    .sort();

  if (chunkFiles.length === 0) {
    throw new Error('ffmpeg produced zero chunks — check input file format');
  }

  const chunkPaths = chunkFiles.map((f) => path.join(tempDir, f));

  log.info(
    { chunkCount: chunkPaths.length, chunkDurationSec },
    'Audio split into chunks via ffmpeg'
  );

  return {
    chunkPaths,
    cleanup: createCleanupFn(tempDir),
  };
}

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------

/**
 * Create a cleanup function that removes the temp directory and all its contents.
 */
function createCleanupFn(tempDir: string): () => Promise<void> {
  return async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      log.debug({ tempDir }, 'Cleaned up audio chunk temp directory');
    } catch (err) {
      log.warn({ tempDir, err: (err as Error).message }, 'Failed to clean up audio chunk temp directory');
    }
  };
}
