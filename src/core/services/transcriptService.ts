/**
 * Transcript Service
 *
 * Append-only JSONL transcript logging for full-fidelity conversation diagnostics.
 * Given any conversation ID and turn ID, the exact sequence of events — full tool
 * inputs, full tool outputs, assistant reasoning, usage per API call, subagent
 * activity — is recoverable from a JSONL file on disk.
 *
 * Design:
 * - JSONL format for O(1) appends (no file rewrite needed)
 * - Fire-and-forget appends (non-blocking, errors logged not thrown)
 * - One file per session ({userData}/transcripts/{sessionId}.jsonl)
 * - Follows costLedgerService.ts patterns
 *
 * @see docs/plans/260413_rebel_core_transcript_logging.md
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getAssetStore } from '@core/assetStore';
import { createScopedLogger } from '@core/logger';
import { materializeImageRefsForEvent } from '@core/services/imageAssetMaterialization';
import { getDataPath } from '@core/utils/dataPaths';
import type { RebelCoreEvent } from '../rebelCore/types';

const log = createScopedLogger({ service: 'transcript' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Discriminated union for transcript event payloads.
 *
 * - `core`: Normal runtime events from the agent loop (RebelCoreEvent)
 * - `error`: Serialized errors (Error objects don't JSON.stringify cleanly)
 * - `synthetic`: Injected events not in RebelCoreEvent (turn:start, direct-answer, plan-seed)
 */
export type TranscriptEvent =
  | { kind: 'core'; event: RebelCoreEvent }
  | { kind: 'error'; message: string; stack?: string }
  | { kind: 'synthetic'; tag: string; data: unknown };

/**
 * Envelope for a single JSONL line in the transcript file.
 *
 * Every entry is self-describing: includes schema version, timestamps,
 * session/turn/sequence IDs, depth/namespace for subagent attribution,
 * and the event payload.
 */
export interface TranscriptEntry {
  /** Schema version for forward-compatibility. */
  v: 1;
  /** Unix timestamp in milliseconds. */
  ts: number;
  /** Session ID. */
  sid: string;
  /** Turn ID. */
  tid: string;
  /** Monotonic sequence number within the turn. */
  seq: number;
  /** Agent depth: 0 = main, 1+ = subagent. */
  depth: number;
  /** Agent namespace: 'main', 'main/Forager', etc. */
  ns: string;
  /** The event payload. */
  event: TranscriptEvent;
}

function resolveImageAssetSurface(): 'desktop' | 'cloud' {
  return process.env.REBEL_SURFACE === 'cloud' ? 'cloud' : 'desktop';
}

function isToolUseResultCoreEvent(
  entry: TranscriptEntry,
): entry is TranscriptEntry & {
  event: {
    kind: 'core';
    event: Extract<RebelCoreEvent, { type: 'tool_use:result' }>;
  };
} {
  return entry.event.kind === 'core' && entry.event.event.type === 'tool_use:result';
}

async function prepareTranscriptEntryForAppend(
  entry: TranscriptEntry,
): Promise<TranscriptEntry> {
  if (!isToolUseResultCoreEvent(entry)) {
    return entry;
  }

  const coreEvent = entry.event.event;
  const imageContent = coreEvent.imageContent ?? [];
  if (imageContent.length === 0) {
    return entry;
  }

  let imageRef = coreEvent.imageRef ?? [];
  if (imageRef.length === 0) {
    try {
      const materialization = await materializeImageRefsForEvent(
        {
          sessionId: entry.sid,
          turnId: entry.tid,
          eventSeq: entry.seq,
          imageContent,
          surface: resolveImageAssetSurface(),
        },
        getAssetStore(),
      );
      imageRef = materialization.refs;
      if (materialization.failures.length > 0) {
        log.warn(
          {
            sid: entry.sid,
            tid: entry.tid,
            seq: entry.seq,
            failureCount: materialization.failures.length,
            failures: materialization.failures.map((failure) => ({
              index: failure.index,
              reason: failure.reason,
            })),
          },
          'Transcript image ref materialization had failures; persisting legacy image payload',
        );
      }
    } catch (error) {
      log.warn(
        {
          sid: entry.sid,
          tid: entry.tid,
          seq: entry.seq,
          err: error instanceof Error ? error.message : String(error),
        },
        'Transcript image ref materialization failed; persisting legacy image payload',
      );
      return entry;
    }
  }

  if (imageRef.length !== imageContent.length || imageRef.length === 0) {
    return entry;
  }

  const retainedImageContent = imageContent.filter((_image, index) => !imageRef[index]);
  const { imageContent: _ignoredImageContent, ...eventWithoutImageContent } = coreEvent;
  const sanitizedEvent: Extract<RebelCoreEvent, { type: 'tool_use:result' }> = {
    ...eventWithoutImageContent,
    imageRef,
    ...(retainedImageContent.length > 0 ? { imageContent: retainedImageContent } : {}),
  };

  return {
    ...entry,
    event: {
      ...entry.event,
      event: sanitizedEvent,
    },
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const TRANSCRIPTS_DIR_NAME = 'transcripts';

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i;

/**
 * Sanitize a raw string for use as a filename.
 * Replaces unsafe chars with hyphens (preserving uniqueness), then guards
 * against empty results and Windows reserved device names.
 */
export function sanitizeFilename(raw: string): string {
  // Replace path separators, dots, and non-alphanumeric (except hyphen) with hyphen.
  // Using replacement (not stripping) prevents distinct IDs from colliding.
  let result = raw
    .replace(/[/\\\.]/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')     // collapse consecutive hyphens
    .replace(/^-|-$/g, '');     // trim leading/trailing hyphens

  if (!result) result = 'unnamed';
  if (WINDOWS_RESERVED.test(result)) result = `_${result}`;

  return result;
}

/**
 * Get the absolute path to the transcript file for a session.
 *
 * Returns `{userData}/transcripts/{sanitizedSessionId}.jsonl`.
 */
export function getTranscriptPath(sessionId: string): string {
  const sanitized = sanitizeFilename(sessionId);
  return path.join(getDataPath(), TRANSCRIPTS_DIR_NAME, `${sanitized}.jsonl`);
}

/**
 * Create the transcripts directory if it doesn't exist.
 * Synchronous and idempotent. Call at turn start.
 *
 * Callers should wrap in try/catch for fail-open behavior.
 */
export function ensureTranscriptDir(): void {
  const dir = path.join(getDataPath(), TRANSCRIPTS_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Sequence counter
// ---------------------------------------------------------------------------

/**
 * Create a shared mutable monotonic counter.
 *
 * Returned object is passed by reference from the main agent into subagent
 * contexts so all events within a turn share one sequence. JavaScript's
 * single-threaded event loop ensures `next()` is atomic.
 */
export function createSeqCounter(): { next(): number } {
  let seq = 0;
  return {
    next(): number {
      return seq++;
    },
  };
}

// ---------------------------------------------------------------------------
// Error serialization
// ---------------------------------------------------------------------------

/**
 * Serialize an unknown error into a `TranscriptEvent` with `kind: 'error'`.
 *
 * `JSON.stringify(new Error('x'))` produces `{}`, losing message and stack.
 * This helper extracts those fields explicitly.
 */
export function serializeError(err: unknown): TranscriptEvent {
  if (err instanceof Error) {
    return {
      kind: 'error',
      message: err.message,
      stack: err.stack,
    };
  }
  return {
    kind: 'error',
    message: String(err),
  };
}

// ---------------------------------------------------------------------------
// Append (fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Append a transcript entry to the session's JSONL file.
 *
 * Fire-and-forget: errors are logged but never thrown or propagated.
 * Uses callback-based `fs.appendFile` for non-blocking I/O.
 */
export function appendTranscriptEntry(entry: TranscriptEntry): void {
  try {
    void prepareTranscriptEntryForAppend(entry)
      .then((preparedEntry) => {
        const filePath = getTranscriptPath(preparedEntry.sid);
        const line = JSON.stringify(preparedEntry) + '\n';

        fs.appendFile(filePath, line, 'utf8', (err) => {
          if (err) {
            log.warn(
              { err, sid: preparedEntry.sid, tid: preparedEntry.tid },
              'Failed to append transcript entry',
            );
          }
        });
      })
      .catch((error) => {
        log.warn(
          { err: error, sid: entry.sid, tid: entry.tid },
          'Failed to prepare transcript entry for append',
        );
      });
  } catch (err) {
    // Guard against JSON.stringify failures, getTranscriptPath issues, etc.
    log.warn({ err, sid: entry.sid }, 'Failed to prepare transcript entry for append');
  }
}

// ---------------------------------------------------------------------------
// Retention / cleanup
// ---------------------------------------------------------------------------

const DEFAULT_MAX_AGE_DAYS = 14;

/**
 * Delete transcript `.jsonl` files older than `maxAgeDays`.
 *
 * Fire-and-forget at the call-site: errors on individual files are logged but
 * do not stop cleanup of the remaining files. If the transcripts directory
 * doesn't exist, returns `{ deleted: 0, errors: 0 }` silently.
 */
export async function cleanupOldTranscripts(
  maxAgeDays: number = DEFAULT_MAX_AGE_DAYS,
): Promise<{ deleted: number; errors: number }> {
  const dir = path.join(getDataPath(), TRANSCRIPTS_DIR_NAME);
  try {
    const files = await fsp.readdir(dir);
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let deleted = 0;
    let errors = 0;

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;

      const filePath = path.join(dir, file);
      try {
        const stat = await fsp.stat(filePath);
        if (stat.mtimeMs < cutoff) {
          await fsp.unlink(filePath);
          deleted++;
        }
      } catch (err) {
        log.warn({ err, file }, 'Failed to clean up transcript file');
        errors++;
      }
    }

    if (deleted > 0 || errors > 0) {
      log.info({ deleted, errors, maxAgeDays }, 'Transcript cleanup complete');
    }

    return { deleted, errors };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err }, 'Failed to read transcripts directory for cleanup');
    }
    return { deleted: 0, errors: 0 };
  }
}
