/**
 * Silence Boundary Service — ffmpeg silencedetect wrapper
 *
 * Detects silence boundaries in audio file tails using ffmpeg's silencedetect
 * filter. Used by the meeting transcription engine to find natural speech pauses
 * near chunk boundaries, enabling tail carry-forward between chunks.
 *
 * Also provides audio manipulation helpers (concat, split) needed for the
 * tail carry-forward pipeline.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createScopedLogger } from '@core/logger';
import { getAudioDurationMs } from '@core/services/audioChunking';

const log = createScopedLogger({ service: 'silence-boundary' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SilenceBoundary {
  /** Offset from the start of the analyzed audio segment (ms) */
  silenceStartMs: number;
  /** Offset from the start of the analyzed audio segment (ms) */
  silenceEndMs: number;
  /** Duration of the silence interval (ms) */
  silenceDurationMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default noise floor threshold for silence detection (dB) */
const DEFAULT_NOISE_THRESHOLD_DB = -35;

/** Default minimum silence duration to be detected (seconds) */
const DEFAULT_MIN_SILENCE_DURATION_S = 0.4;

/** Timeout for ffmpeg silence detection commands (ms) */
const FFMPEG_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Pure parser
// ---------------------------------------------------------------------------

/**
 * Parse ffmpeg silencedetect stderr output into structured silence boundaries.
 *
 * ffmpeg outputs lines like:
 *   [silencedetect @ ...] silence_start: 1.234
 *   [silencedetect @ ...] silence_end: 2.567 | silence_duration: 1.333
 *
 * Only complete boundaries (with both start and end) are returned.
 * This is a pure function — no I/O.
 *
 * @param stderr - Raw stderr output from ffmpeg silencedetect
 * @returns Array of silence boundaries in chronological order
 */
export function parseSilencedetectOutput(stderr: string): SilenceBoundary[] {
  const boundaries: SilenceBoundary[] = [];
  let pendingStart: number | null = null;

  const startRegex = /silence_start:\s*([\d.]+)/;
  const endRegex = /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/;

  for (const line of stderr.split('\n')) {
    const startMatch = line.match(startRegex);
    if (startMatch) {
      pendingStart = parseFloat(startMatch[1]);
      continue;
    }

    const endMatch = line.match(endRegex);
    if (endMatch && pendingStart !== null) {
      const silenceEndSec = parseFloat(endMatch[1]);
      const silenceDurationSec = parseFloat(endMatch[2]);

      if (Number.isFinite(silenceEndSec) && Number.isFinite(silenceDurationSec)) {
        boundaries.push({
          silenceStartMs: Math.round(pendingStart * 1000),
          silenceEndMs: Math.round(silenceEndSec * 1000),
          silenceDurationMs: Math.round(silenceDurationSec * 1000),
        });
      }
      pendingStart = null;
    }
  }

  return boundaries;
}

// ---------------------------------------------------------------------------
// Silence detection
// ---------------------------------------------------------------------------

/**
 * Run ffmpeg silencedetect on the last `tailWindowMs` of an audio file.
 * Returns the offset (from the start of the FULL audio) of the end of the
 * last silence boundary in the tail window — the ideal split point so speech
 * resumes cleanly on the next chunk.
 *
 * Returns null if no silence is found or ffmpeg fails (graceful fallback).
 *
 * @param audioFilePath - Path to the audio file
 * @param totalDurationMs - Total duration of the audio in ms
 * @param tailWindowMs - How many ms from the end to analyze
 * @param options - Optional noise threshold and minimum silence duration overrides
 */
export async function findLastSilenceInTail(
  audioFilePath: string,
  totalDurationMs: number,
  tailWindowMs: number,
  options?: { noiseThresholdDb?: number; minSilenceDurationS?: number },
): Promise<{ offsetFromStartMs: number } | null> {
  const noiseDb = options?.noiseThresholdDb ?? DEFAULT_NOISE_THRESHOLD_DB;
  const minSilenceS = options?.minSilenceDurationS ?? DEFAULT_MIN_SILENCE_DURATION_S;

  // Calculate the start of the tail window
  const tailStartMs = Math.max(0, totalDurationMs - tailWindowMs);
  const tailStartSec = tailStartMs / 1000;

  try {
    const stderr = await runFfmpegSilencedetect(audioFilePath, tailStartSec, noiseDb, minSilenceS);
    const boundaries = parseSilencedetectOutput(stderr);

    if (boundaries.length === 0) {
      log.info(
        { audioFilePath, tailStartMs, tailWindowMs },
        'No silence boundaries found in tail window',
      );
      return null;
    }

    // Take the LAST boundary — closest to chunk end, best split point
    const lastBoundary = boundaries[boundaries.length - 1];

    // Convert from tail-relative to full-audio-relative offset
    // We split at the END of the silence so speech resumes cleanly
    const offsetFromStartMs = tailStartMs + lastBoundary.silenceEndMs;

    // Sanity: offset must be within the audio
    if (offsetFromStartMs >= totalDurationMs || offsetFromStartMs <= 0) {
      log.warn(
        { offsetFromStartMs, totalDurationMs, lastBoundary },
        'Silence boundary offset out of bounds, ignoring',
      );
      return null;
    }

    log.info(
      { audioFilePath, offsetFromStartMs, silenceDurationMs: lastBoundary.silenceDurationMs },
      'Found silence boundary in tail window',
    );

    return { offsetFromStartMs };
  } catch (err) {
    log.warn(
      { audioFilePath, error: err instanceof Error ? err.message : String(err) },
      'Silence detection failed, falling back to full-chunk transcription',
    );
    return null;
  }
}

/**
 * Run ffmpeg silencedetect and return the raw stderr output.
 */
async function runFfmpegSilencedetect(
  audioFilePath: string,
  startSec: number,
  noiseDb: number,
  minSilenceS: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const args = [
      '-i', audioFilePath,
      '-ss', String(startSec),
      '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilenceS}`,
      '-f', 'null',
      '-',
    ];

    const ffmpeg = spawn('ffmpeg', args, { windowsHide: true });
    let stderr = '';

    const timeout = setTimeout(() => {
      ffmpeg.kill('SIGKILL');
      reject(new Error(`ffmpeg silencedetect timed out after ${FFMPEG_TIMEOUT_MS}ms`));
    }, FFMPEG_TIMEOUT_MS);

    ffmpeg.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stderr);
      } else {
        reject(new Error(`ffmpeg silencedetect exited with code ${code}`));
      }
    });

    ffmpeg.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Audio manipulation helpers
// ---------------------------------------------------------------------------

/**
 * Generate a unique temp file path with the given extension.
 */
function tempFilePath(ext: string): string {
  return path.join(os.tmpdir(), `rebel-audio-${randomUUID()}${ext}`);
}

/**
 * Concatenate two audio files using ffmpeg's concat demuxer.
 * Both files should be the same format. Output is written to a temp file.
 *
 * @returns Path to the concatenated temp file. Caller is responsible for cleanup.
 */
export async function concatAudioFiles(file1: string, file2: string): Promise<string> {
  // Determine extension from the first file
  const ext = path.extname(file1) || '.m4a';
  const outputPath = tempFilePath(ext);

  // Create a concat list file for the demuxer
  const listPath = tempFilePath('.txt');
  const listContent = `file '${file1}'\nfile '${file2}'\n`;
  await fs.writeFile(listPath, listContent, 'utf-8');

  try {
    await runFfmpegCommand([
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      '-y',
      outputPath,
    ]);

    return outputPath;
  } finally {
    // Clean up the list file
    await fs.unlink(listPath).catch(() => {});
  }
}

/**
 * Split an audio file at the given offset, producing head and tail temp files.
 *
 * @param inputPath - Path to the source audio file
 * @param offsetMs - Split point in milliseconds from the start
 * @returns Paths to head and tail temp files, plus tail duration. Caller responsible for cleanup.
 */
export async function splitAudioAtOffset(
  inputPath: string,
  offsetMs: number,
): Promise<{ headPath: string; tailPath: string; tailDurationMs: number }> {
  const ext = path.extname(inputPath) || '.m4a';
  const headPath = tempFilePath(ext);
  const tailPath = tempFilePath(ext);
  const offsetSec = offsetMs / 1000;

  // Extract head: start → offset
  await runFfmpegCommand([
    '-i', inputPath,
    '-to', String(offsetSec),
    '-c', 'copy',
    '-y',
    headPath,
  ]);

  // Extract tail: offset → end
  await runFfmpegCommand([
    '-i', inputPath,
    '-ss', String(offsetSec),
    '-c', 'copy',
    '-y',
    tailPath,
  ]);

  // Get tail duration
  const tailDuration = await getAudioDurationMs(tailPath).catch(() => null);
  const tailDurationMs = tailDuration?.durationMs ?? 0;

  return { headPath, tailPath, tailDurationMs };
}

/**
 * Run an ffmpeg command with a timeout.
 */
async function runFfmpegCommand(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args, { windowsHide: true });
    let stderr = '';

    const timeout = setTimeout(() => {
      ffmpeg.kill('SIGKILL');
      reject(new Error(`ffmpeg command timed out after ${FFMPEG_TIMEOUT_MS}ms`));
    }, FFMPEG_TIMEOUT_MS);

    ffmpeg.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-200)}`));
      }
    });

    ffmpeg.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
