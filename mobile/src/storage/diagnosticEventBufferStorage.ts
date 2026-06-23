// mobile/src/storage/diagnosticEventBufferStorage.ts
//
// Local mobile diagnostic-event buffer.
//
// PURPOSE
// -------
// Mobile emits continuity / queue events to Sentry breadcrumbs only. Those
// breadcrumbs are great for live triage but never end up in the user-shareable
// diagnostic bundle (the ZIP / Markdown the user attaches to a bug report).
// This module fills that gap: a small, mobile-only, on-device JSONL buffer
// that surfaces "the last N things that happened" inside the diagnostic
// bundle, with the same shape mindset desktop and cloud already have.
//
// MOBILE-ONLY, NEVER UPLOADED
// ---------------------------
// Per the I-mobile-emit-transport decision, mobile diagnostic events stay
// mobile-only — they are NOT shipped to cloud and NOT written into the
// shared `appendDiagnosticEvent` ledger. This keeps the cloud/desktop
// schema clean and avoids re-introducing the cross-surface emit pattern
// the `mobile-emit-transport-invariant` guard test was added to prevent.
//
// The exported emit symbol is deliberately named `appendMobileDiagnosticEvent`
// so it can never be confused with `appendDiagnosticEvent` (the cloud-shipped
// API) and so the existing AST guard scan stays narrowly scoped to the
// disallowed pattern.
//
// ON-DISK FORMAT
// --------------
// `<documentDirectory>/diagnostic-events/events.jsonl`
//
// Each line is one JSON event. Atomic-rename pattern mirrors
// `offlineQueueStorage.ts`: write to `events.jsonl.tmp`, then rename to
// `events.jsonl`. On read, if the primary is missing but `.tmp` exists,
// recover from `.tmp` (mirrors offlineQueueStorage.loadSnapshot recovery).
//
// CAPS
// ----
// - `RING_BUFFER_CAP` (500): the file is rewritten on each flush so it
//   never exceeds RING_BUFFER_CAP lines on disk. Older lines age out.
// - `MAX_BYTES_ON_READ` (256 KB): bundle reads cap returned bytes so the
//   ZIP / MD can't blow up if the file fills with large entries.
// - Debounced flush: appends accumulate in memory and flush after
//   `FLUSH_DEBOUNCE_MS` (1500 ms) of quiet, or on explicit `flush()`.
//
// CRASH SAFETY
// ------------
// The flush sequence is: read existing file → concat in-memory entries →
// trim to RING_BUFFER_CAP → write tmp → delete primary → rename tmp.
// A crash mid-flush leaves either a stale primary (acceptable, just a
// missed batch) or a `.tmp` file (recovered on next read).
//
// CORRUPT-LINE HANDLING
// ---------------------
// Each line is JSON.parse-d in isolation. A single malformed line is
// skipped (logged at warn) and reads still return the valid lines.
// This means a partial-write at app-kill still yields readable history.

import { Paths, Directory, File as ExpoFile } from 'expo-file-system';
import { createLogger } from '@rebel/cloud-client';

const log = createLogger('MobileDiagnosticEventBuffer');

const BUFFER_DIR_NAME = 'diagnostic-events';
const LEDGER_FILENAME = 'events.jsonl';
const TMP_LEDGER_FILENAME = 'events.jsonl.tmp';
const RING_BUFFER_CAP = 500;
const FLUSH_DEBOUNCE_MS = 1500;
const DEFAULT_MAX_BYTES_ON_READ = 256 * 1024;

export interface MobileDiagnosticBufferEvent {
  /** Wall-clock timestamp (ms since epoch) at the moment the event was appended. */
  ts: number;
  /** Always 'mobile' so consumers can tell at a glance where the event was emitted. */
  surface: 'mobile';
  /** Free-form source tag (e.g. 'continuity_breadcrumb', 'queue_event'). */
  source: string;
  /** Family / kind of event (mobile taxonomy — NOT desktop's DiagnosticEventKind). */
  family?: string;
  /** Event-specific message string (already on a closed allowlist at the emit site). */
  message?: string;
  /** Severity hint, when one is available. */
  level?: 'info' | 'warning' | 'error';
  /** Already-sanitized data block. Emit-sites must run their own PII allowlist BEFORE calling append. */
  data?: Record<string, string | number | boolean | null | Array<string | number>>;
}

interface ReadOptions {
  limit?: number;
  maxBytes?: number;
}

export class MobileDiagnosticEventBuffer {
  private readonly dir: Directory;
  private inMemory: MobileDiagnosticBufferEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushInFlight: Promise<void> | null = null;
  private dirEnsured = false;

  constructor(parentDir?: Directory) {
    this.dir = new Directory(parentDir ?? Paths.document, BUFFER_DIR_NAME);
  }

  /**
   * Schedule an event to be persisted. Synchronous and never throws —
   * a buffer failure must never break a Sentry breadcrumb path.
   */
  append(entry: MobileDiagnosticBufferEvent): void {
    try {
      this.inMemory.push(entry);
      // Defensive in-memory cap so a hot loop without flushes can't blow heap.
      if (this.inMemory.length > RING_BUFFER_CAP * 2) {
        this.inMemory = this.inMemory.slice(-RING_BUFFER_CAP);
      }
      this.scheduleFlush();
    } catch (err) {
      log.warn('Failed to append mobile diagnostic event to in-memory buffer', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Force an immediate flush. Resolves once the on-disk file reflects all
   * events appended before this call. Concurrent calls coalesce onto the
   * same in-flight promise.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushInFlight) return this.flushInFlight;
    this.flushInFlight = this.doFlush().finally(() => {
      this.flushInFlight = null;
    });
    return this.flushInFlight;
  }

  /**
   * Read the buffer for inclusion in a diagnostic bundle. Flushes first so
   * the result includes any in-memory tail. Returns oldest-first events,
   * bounded by `limit` and `maxBytes`. Corrupt lines are skipped.
   */
  async readRecent(opts: ReadOptions = {}): Promise<MobileDiagnosticBufferEvent[]> {
    await this.flush();
    const limit = Math.max(0, opts.limit ?? RING_BUFFER_CAP);
    const maxBytes = Math.max(0, opts.maxBytes ?? DEFAULT_MAX_BYTES_ON_READ);
    const lines = await this.readLedgerLines();
    if (lines.length === 0) return [];

    const out: MobileDiagnosticBufferEvent[] = [];
    let bytes = 0;
    // Walk newest-to-oldest so the size cap drops the oldest events first,
    // then reverse to return oldest-first per contract.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const lineBytes = line.length + 1;
      if (bytes + lineBytes > maxBytes) break;
      bytes += lineBytes;
      out.push(parsed as MobileDiagnosticBufferEvent);
      if (out.length >= limit) break;
    }
    out.reverse();
    return out;
  }

  /** Clear in-memory and persisted diagnostic events for account teardown. */
  async clear(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.inMemory = [];

    if (this.flushInFlight) {
      await this.flushInFlight;
      this.inMemory = [];
    }

    const primaryFile = new ExpoFile(this.dir, LEDGER_FILENAME);
    const tmpFile = new ExpoFile(this.dir, TMP_LEDGER_FILENAME);
    if (primaryFile.exists) primaryFile.delete();
    if (tmpFile.exists) tmpFile.delete();
  }

  /** Test-only: clear in-memory buffer and pending timer. Does NOT delete on-disk file. */
  __resetForTests(): void {
    this.inMemory = [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushInFlight = null;
    this.dirEnsured = false;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  private ensureDir(): void {
    if (this.dirEnsured) return;
    try {
      if (!this.dir.exists) {
        this.dir.create({ intermediates: true, idempotent: true });
      }
      this.dirEnsured = true;
    } catch (err) {
      log.warn('Failed to create diagnostic-events directory', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async doFlush(): Promise<void> {
    if (this.inMemory.length === 0) return;
    const drained = this.inMemory;
    this.inMemory = [];
    try {
      this.ensureDir();
      const existingLines = await this.readLedgerLines();
      const newLines = drained.map((entry) => JSON.stringify(entry));
      const combined = [...existingLines, ...newLines];
      const trimmed = combined.length > RING_BUFFER_CAP ? combined.slice(-RING_BUFFER_CAP) : combined;
      const payload = trimmed.length > 0 ? trimmed.join('\n') + '\n' : '';

      // Atomic rename pattern: write tmp, delete primary, rename tmp → primary.
      // Fresh File references because rename() mutates the URI on the instance.
      const tmpFile = new ExpoFile(this.dir, TMP_LEDGER_FILENAME);
      const primaryFile = new ExpoFile(this.dir, LEDGER_FILENAME);
      if (tmpFile.exists) tmpFile.delete();
      tmpFile.create();
      tmpFile.write(payload);
      if (primaryFile.exists) primaryFile.delete();
      tmpFile.rename(LEDGER_FILENAME);
    } catch (err) {
      log.warn('Failed to flush mobile diagnostic events to disk', {
        error: err instanceof Error ? err.message : String(err),
        droppedEntries: drained.length,
      });
      // Re-prepend so a transient failure doesn't lose the batch; capped by
      // the in-memory defensive trim in append().
      this.inMemory = [...drained, ...this.inMemory];
    }
  }

  private async readLedgerLines(depth = 0): Promise<string[]> {
    try {
      const primaryFile = new ExpoFile(this.dir, LEDGER_FILENAME);
      const tmpFile = new ExpoFile(this.dir, TMP_LEDGER_FILENAME);
      if (!primaryFile.exists) {
        if (!tmpFile.exists) return [];
        if (depth > 0) {
          log.warn('Diagnostic events ledger recovery exceeded max depth, returning empty.');
          return [];
        }
        log.warn('Primary diagnostic events ledger missing, recovering from tmp.');
        tmpFile.rename(LEDGER_FILENAME);
        return this.readLedgerLines(depth + 1);
      }
      const text = await primaryFile.text();
      if (!text) return [];
      return text.split('\n').filter((line) => line.length > 0);
    } catch (err) {
      log.warn('Failed to read diagnostic events ledger', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton wrappers (production callers use these; tests construct their own
// MobileDiagnosticEventBuffer instances against mocked expo-file-system).
// ---------------------------------------------------------------------------

let singleton: MobileDiagnosticEventBuffer | null = null;

function getSingleton(): MobileDiagnosticEventBuffer {
  if (!singleton) singleton = new MobileDiagnosticEventBuffer();
  return singleton;
}

/**
 * Append a mobile-local diagnostic event. Fire-and-forget: the buffer
 * schedules a debounced flush internally. Never throws.
 *
 * MUST NOT be confused with `appendDiagnosticEvent` from cloud-client.
 * Mobile events stay mobile-local; the AST guard in
 * `continuityTransition.test.ts` ensures the cloud-shipped emit pattern
 * never gets re-introduced under `mobile/**`.
 */
export function appendMobileDiagnosticEvent(entry: MobileDiagnosticBufferEvent): void {
  getSingleton().append(entry);
}

export async function flushMobileDiagnosticEvents(): Promise<void> {
  await getSingleton().flush();
}

export async function readRecentMobileDiagnosticEvents(
  opts?: ReadOptions,
): Promise<MobileDiagnosticBufferEvent[]> {
  return getSingleton().readRecent(opts);
}

export async function clearMobileDiagnosticEvents(): Promise<void> {
  await getSingleton().clear();
}

/** Test-only: drop the singleton so a fresh one is constructed next call. */
export function __resetMobileDiagnosticEventBufferSingletonForTests(): void {
  if (singleton) singleton.__resetForTests();
  singleton = null;
}
