/**
 * Filesystem-backed diagnostic events ledger factory.
 *
 * The desktop wrapper and cloud bootstrap each construct their own instance so
 * queue/timer/line-count state cannot leak across surfaces or tests.
 */

import fsPromises from 'node:fs/promises';
import path from 'node:path';

import type pino from 'pino';

import {
  diagnosticEventEntrySchema,
  type DiagnosticEventsLedgerReader,
  type DiagnosticEventsLedgerWriter,
} from '@core/services/diagnosticEventsLedger';
import {
  MAX_DIAGNOSTIC_EVENTS,
  MAX_DIAGNOSTIC_EVENTS_BYTES,
  type DiagnosticEventEntry,
} from '@core/services/diagnostics/manifest';
import { fireAndForget } from '@shared/utils/fireAndForget';

const FLUSH_INTERVAL_MS = 50;
const FLUSH_BATCH_SIZE = 32;
const DEFAULT_LEDGER_FILENAME = 'diagnostic-events.jsonl';

export interface FsLedgerFsLike {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readFile(path: string): Promise<Buffer>;
  appendFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
}

export interface FsDiagnosticLedgerOptions {
  /** Resolves the directory containing the live + old ledger files. May be sync or async. */
  resolveDir: () => string | Promise<string>;
  /** Scoped pino logger to use for warn/info/debug. */
  logger: pino.Logger;
  /** Optional fs override for tests. Defaults to node:fs/promises. */
  fs?: FsLedgerFsLike;
  /** Optional rotation override; defaults to MAX_DIAGNOSTIC_EVENTS / single .old companion. */
  rotation?: { maxLines: number; maxFiles: 1 };
  /** Filename basename. Defaults to 'diagnostic-events.jsonl'. */
  liveFilename?: string;
  /** Old companion basename. Defaults to '<liveFilename>.old'. */
  oldFilename?: string;
  /** Optional max-bytes for read budget. Defaults to MAX_DIAGNOSTIC_EVENTS_BYTES. */
  maxReadBytes?: number;
}

export interface FsDiagnosticLedger {
  readonly writer: DiagnosticEventsLedgerWriter;
  readonly reader: DiagnosticEventsLedgerReader;
  /** Drains the queue. Used at shutdown and in tests. */
  flush(): Promise<void>;
  /** Closes any timers; safe to call multiple times. */
  shutdown(): Promise<void>;
  /** Test-only: clears all internal state without touching disk. */
  resetForTests(): void;
}

interface QueuedEntry {
  line: string;
}

interface LedgerPaths {
  live: string;
  old: string;
}

export function createFsDiagnosticEventsLedger(opts: FsDiagnosticLedgerOptions): FsDiagnosticLedger {
  const fsImpl: FsLedgerFsLike = opts.fs ?? fsPromises;
  const logger = opts.logger;
  const maxLines = opts.rotation?.maxLines ?? MAX_DIAGNOSTIC_EVENTS;
  const maxReadBytes = opts.maxReadBytes ?? MAX_DIAGNOSTIC_EVENTS_BYTES;
  const liveFilename = opts.liveFilename ?? DEFAULT_LEDGER_FILENAME;
  const oldFilename = opts.oldFilename ?? `${liveFilename}.old`;

  const queue: QueuedEntry[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let flushInFlight: Promise<void> | null = null;
  let approxLiveLineCount: number | null = null;

  const resolveLedgerPaths = async (): Promise<LedgerPaths | null> => {
    try {
      const dir = await opts.resolveDir();
      return {
        live: path.join(dir, liveFilename),
        old: path.join(dir, oldFilename),
      };
    } catch (err) {
      logger.debug({ err }, 'Diagnostic events ledger path not available yet (pre-bootstrap)');
      return null;
    }
  };

  const ensureLineCount = async (paths: { live: string }): Promise<number> => {
    if (approxLiveLineCount !== null) return approxLiveLineCount;
    try {
      const buf = await fsImpl.readFile(paths.live, 'utf8');
      approxLiveLineCount = buf.length === 0 ? 0 : buf.split('\n').filter((line) => line.length > 0).length;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        approxLiveLineCount = 0;
      } else {
        logger.warn({ err }, 'Failed to seed diagnostic-events line count, assuming 0');
        approxLiveLineCount = 0;
      }
    }
    return approxLiveLineCount;
  };

  const rotateIfNeeded = async (
    paths: { live: string; old: string },
    pendingBatchSize: number,
  ): Promise<void> => {
    const lineCount = await ensureLineCount(paths);
    if (lineCount + pendingBatchSize < maxLines) return;
    try {
      // On Windows, `rename` onto an existing file fails. `unlink` then
      // `rename` is the simplest pattern that works on every supported
      // platform; the small race window between the two operations is
      // acceptable for a diagnostic ledger.
      try {
        await fsImpl.unlink(paths.old);
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn({ err: unlinkErr }, 'Failed to remove previous diagnostic-events .old companion');
        }
      }
      await fsImpl.rename(paths.live, paths.old);
      approxLiveLineCount = 0;
      logger.info({ lineCount, pendingBatchSize }, 'Rotated diagnostic-events ledger');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        approxLiveLineCount = 0;
        return;
      }
      logger.warn({ err }, 'Failed to rotate diagnostic-events ledger; continuing without rotation');
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer || queue.length === 0) return;
    if (queue.length >= FLUSH_BATCH_SIZE) {
      fireAndForget(flushNow(), 'diagnosticEventsLedger.flushNow.batch');
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      fireAndForget(flushNow(), 'diagnosticEventsLedger.flushNow.timer');
    }, FLUSH_INTERVAL_MS);
    // Don't keep the event loop alive just for diagnostics flushing.
    flushTimer.unref?.();
  };

  const flushNow = async (): Promise<void> => {
    if (flushInFlight) return flushInFlight;
    if (queue.length === 0) return;

    flushInFlight = (async () => {
      try {
        const paths = await resolveLedgerPaths();
        if (!paths) {
          queue.length = 0;
          return;
        }
        const batch = queue.splice(0, queue.length);
        if (batch.length === 0) return;

        await rotateIfNeeded(paths, batch.length);
        const payload = batch.map((queued) => queued.line).join('');
        try {
          await fsImpl.appendFile(paths.live, payload, 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            await fsImpl.mkdir(path.dirname(paths.live), { recursive: true });
            await fsImpl.appendFile(paths.live, payload, 'utf8');
          } else {
            throw err;
          }
        }
        approxLiveLineCount = (approxLiveLineCount ?? 0) + batch.length;
      } catch (err) {
        logger.warn({ err }, 'Failed to flush diagnostic-events batch');
      } finally {
        flushInFlight = null;
        if (queue.length > 0) scheduleFlush();
      }
    })();

    return flushInFlight;
  };

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (queue.length === 0 && !flushInFlight) return;
      if (flushInFlight) {
        await flushInFlight;
      }
      if (queue.length > 0) {
        await flushNow();
      }
    }
  };

  const readFileLines = async (
    filePath: string,
    byteBudget: number,
  ): Promise<{ entries: DiagnosticEventEntry[]; bytesConsumed: number }> => {
    let buf: Buffer;
    try {
      buf = await fsImpl.readFile(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { entries: [], bytesConsumed: 0 };
      }
      throw err;
    }
    const startOffset = buf.length > byteBudget ? buf.length - byteBudget : 0;
    const tail = buf.subarray(startOffset).toString('utf8');
    const lines = tail.split('\n');
    // If we trimmed the head, drop the first (likely partial) line.
    if (startOffset > 0) lines.shift();

    const entries: DiagnosticEventEntry[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const parsed = diagnosticEventEntrySchema.safeParse(JSON.parse(line));
        if (parsed.success) entries.push(parsed.data);
      } catch {
        // Skip malformed line; matches costLedger behaviour.
      }
    }
    return { entries, bytesConsumed: buf.length - startOffset };
  };

  const writer: DiagnosticEventsLedgerWriter = {
    append(entry: DiagnosticEventEntry): void {
      try {
        const line = JSON.stringify(entry) + '\n';
        queue.push({ line });
        scheduleFlush();
      } catch (err) {
        logger.warn({ err }, 'Failed to enqueue diagnostic event');
      }
    },
    async flush(): Promise<void> {
      await flush();
    },
  };

  const reader: DiagnosticEventsLedgerReader = {
    async readRecent({ limit, maxBytes }) {
      const paths = await resolveLedgerPaths();
      if (!paths) return [];

      try {
        const cap = Math.min(maxBytes, maxReadBytes);
        const live = await readFileLines(paths.live, cap);
        let combined: DiagnosticEventEntry[] = live.entries;
        const remaining = cap - live.bytesConsumed;
        if (remaining > 0 && combined.length < limit) {
          const old = await readFileLines(paths.old, remaining);
          combined = [...old.entries, ...combined];
        }
        if (combined.length > limit) {
          return combined.slice(combined.length - limit);
        }
        return combined;
      } catch (err) {
        logger.warn({ err }, 'Failed to read diagnostic-events ledger');
        return [];
      }
    },
  };

  return {
    writer,
    reader,
    flush,
    async shutdown(): Promise<void> {
      await flush();
    },
    resetForTests(): void {
      queue.length = 0;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushInFlight = null;
      approxLiveLineCount = null;
    },
  };
}
