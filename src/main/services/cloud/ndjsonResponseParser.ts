/**
 * NDJSON response parser — chunk-fragmentation-safe line accumulator for
 * Stage 6 of the "Cloud Setup Adaptive Sizing + Honest Progress" plan.
 *
 * The cloud-service `POST /api/data/upload-archive` route now returns either:
 *   - `application/x-ndjson` — one `{type:'progress',...}` line per ~500ms
 *     plus a terminal `{type:'result',...}` line. Client sets
 *     `Accept: application/x-ndjson` to opt in.
 *   - `application/json` — the pre-Stage-6 single-JSON response. Old server
 *     or client that didn't set Accept. Parser is not used in that path.
 *
 * This helper handles:
 *   - chunk boundaries that split a line (incl. mid-JSON)
 *   - malformed lines (warn-log + skip)
 *   - EOF without trailing newline (flush final line)
 *   - EOF without a `result` event (returns error sentinel so the caller
 *     can surface a clean failure instead of hanging)
 *
 * See the Stage 0 spike `tmp/agent-tests/ndjson-spike.ts` for the parser's
 * reference implementation and fragmentation test vectors.
 */

import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'cloudServiceClient.ndjson' });

/**
 * Progress event emitted by the cloud-service mid-extract.
 * `bytesTotal` is optional — server only emits it when the desktop client
 * passed an `X-Migration-Bytes-Total` request header.
 */
export interface NdjsonProgressEvent {
  type: 'progress';
  phase: string;
  bytesProcessed: number;
  bytesTotal?: number;
}

/**
 * Terminal event emitted after extract completes (success or failure).
 * Shape matches the legacy single-JSON body when `success === true` so
 * callers can treat the two transports uniformly.
 */
export interface NdjsonResultEvent {
  type: 'result';
  success: boolean;
  fileCount?: number;
  archiveSize?: number;
  error?: string;
}

type NdjsonEvent = NdjsonProgressEvent | NdjsonResultEvent;

/** Source of chunks — matches Node fetch's `res.body` async iterable shape. */
export type NdjsonChunkSource = AsyncIterable<Buffer | Uint8Array | string>;

export interface ParseNdjsonResult {
  /** Terminal result event. Absent if the stream ended before one arrived. */
  result?: NdjsonResultEvent;
  /**
   * Message describing why parsing could not produce a result event. Distinct
   * from the `result.error` field — that comes from the server, this is a
   * client-side detection (e.g. EOF without a terminal line).
   */
  error?: string;
}

/**
 * Line-buffer accumulator. Dispatches:
 *   - `type: 'progress'` events → `onProgress(evt)`
 *   - `type: 'result'` events → stashed, returned from the promise
 *
 * Uses a streaming `TextDecoder` so a chunk boundary inside a multi-byte
 * UTF-8 sequence (e.g. emoji or non-ASCII localised text in an error
 * message) does not corrupt the line — without `{ stream: true }` each
 * chunk would be decoded independently and partial bytes would collapse
 * into U+FFFD replacement characters.
 *
 * Never throws on malformed lines — just warn-logs and continues.
 */
export async function parseNdjsonResponse(
  source: NdjsonChunkSource,
  onProgress?: (evt: NdjsonProgressEvent) => void,
): Promise<ParseNdjsonResult> {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let result: NdjsonResultEvent | undefined;

  const handleLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (!line) return;
    let evt: NdjsonEvent | null = null;
    try {
      evt = JSON.parse(line) as NdjsonEvent;
    } catch (err) {
      log.warn({ err, line }, 'Skipping malformed NDJSON line');
      return;
    }
    if (!evt || typeof evt !== 'object' || typeof (evt as { type?: unknown }).type !== 'string') {
      log.warn({ evt }, 'Skipping NDJSON line with no `type` discriminator');
      return;
    }
    if (evt.type === 'progress') {
      try {
        onProgress?.(evt);
      } catch (callbackErr) {
        // Don't let a consumer callback crash the parse loop.
        log.warn({ err: callbackErr }, 'onProgress callback threw — continuing parse');
      }
      return;
    }
    if (evt.type === 'result') {
      result = evt;
      return;
    }
    log.warn({ evt }, 'Skipping NDJSON event with unknown `type`');
  };

  for await (const raw of source) {
    if (typeof raw === 'string') {
      buf += raw;
    } else {
      // Buffer/Uint8Array → streaming UTF-8 decode. `stream: true` buffers any
      // partial multi-byte sequence and emits it with the next chunk (so a
      // 4-byte emoji split across two chunks is not corrupted into U+FFFD).
      buf += decoder.decode(raw, { stream: true });
    }
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      handleLine(line);
    }
  }
  // Drain the decoder's internal buffer. Any still-pending bytes become
  // whatever characters they complete to; an incomplete multi-byte sequence
  // at EOF (malformed stream) produces U+FFFD and the line is skipped by
  // `handleLine` via JSON.parse failure.
  buf += decoder.decode();
  // Flush any trailing partial line (EOF without terminating newline).
  if (buf.trim()) handleLine(buf);

  if (!result) {
    return { error: 'EOF without result event' };
  }
  return { result };
}
