/**
 * graceful-fs Observability
 *
 * Two complementary signals for production validation of the graceful-fs
 * EMFILE/ENFILE resilience layer (see
 * docs/plans/260428_graceful_fs_emfile_fix.md, Stage 3):
 *
 * 1. {@link installGracefulFsObservability} — high-frequency queue sampler
 *    that emits 60s breadcrumbs when graceful-fs is throttling, plus a
 *    rate-limited `captureMessage` escalation when peakDepth crosses 1000
 *    in any 60s window. Also drains the bootstrap-banner / leaf-module
 *    install-failure stash on first call.
 *
 * 2. {@link tagFsExhaustion} — per-event scoped Sentry tagging for fatal
 *    EMFILE/ENFILE that surfaces despite graceful-fs (e.g. native-module
 *    bypass, fs/promises path, retry-helper final rethrow). Uses
 *    {@link ErrorReporter.captureExceptionWithScope} which wraps
 *    `Sentry.withScope` internally — never pollutes global isolation
 *    scope.
 *
 * Best-effort — every function is wrapped so an observability failure can
 * never break the underlying retry / detection semantics.
 */

import type { ErrorReporter, ErrorReporterEventScope } from '@core/errorReporter';

/** graceful-fs queue tuple shape (verified against graceful-fs@4.2.11):
 *  `[fn, args, err, startTime, lastTime]` */
type GracefulFsQueueEntry = unknown[];

/** Threshold for escalating from breadcrumb-only to a captureMessage. */
const QUEUE_DEPTH_ESCALATION_THRESHOLD = 1000;

/** Sampler interval — fast enough to catch transient queue spikes. */
const SAMPLER_INTERVAL_MS = 500;

/** Breadcrumb emission cadence — long enough to avoid Sentry quota issues. */
const BREADCRUMB_INTERVAL_MS = 60_000;

/** Rate limit between captureMessage escalations (per process, in-memory). */
const CAPTURE_RATE_LIMIT_MS = 60 * 60_000; // 1 hour

/** Delay before retrying a failed bootstrap graceful-fs install. */
const BOOTSTRAP_INSTALL_RETRY_DELAY_MS = 1_000;

/** Small grace window so the leaf module's own retry can update its stash. */
const BOOTSTRAP_PENDING_RETRY_GRACE_MS = 250;

/** Globals where bootstrap install failures are stashed by the banner / leaf. */
interface BootstrapStashGlobal {
  __REBEL_BOOTSTRAP_BANNER_ERROR__?: unknown;
  __REBEL_BOOTSTRAP_LEAF_ERROR__?: unknown;
}

type BootstrapStashKey = keyof BootstrapStashGlobal;

type SerializedInstallError = {
  name?: string;
  message?: string;
  stack?: string;
  code?: unknown;
};

type BootstrapInstallFailureStash = {
  kind?: unknown;
  error?: unknown;
  at?: unknown;
  retry?: {
    status?: unknown;
    delayMs?: unknown;
    scheduledAt?: unknown;
    attemptedAt?: unknown;
    error?: unknown;
  };
  [key: string]: unknown;
};

/**
 * Module-scoped reporter. Set by {@link installGracefulFsObservability} so
 * {@link tagFsExhaustion} can report scoped events without the caller
 * threading the reporter through.
 */
let _reporter: ErrorReporter | null = null;
let _surface: string = 'unknown';
/** Active sampler cleanup — replaced on each install, cleared on cleanup. */
let _currentCleanup: (() => void) | null = null;
/** Pending delayed bootstrap retry/report timers — cleared on reinstall/cleanup. */
let _pendingBootstrapRetryTimers: ReturnType<typeof setTimeout>[] = [];

/** Latest queue snapshot — kept fresh for {@link tagFsExhaustion}. */
let _latestQueueDepth = 0;
let _latestQueuePeak = 0;
let _latestOldestPendingAgeMs: number | undefined;

/**
 * Lifetime counters for {@link tagFsExhaustion} calls per source class.
 * Surfaced in diagnostic bundles so a triager can see "EMFILE retries
 * exhausted N times this process" without reading raw Sentry events.
 * Reset only on process restart or {@link _resetForTesting}.
 *
 * Keys are the non-sentinel members of {@link FsExhaustionSource} (declared
 * later in this file). The literal union is repeated here because TS forbids
 * forward references in module-scope `const` initializers.
 */
const _fsExhaustionCountsBySource: Record<
  Exclude<
    'graceful_fs_queue' | 'emfile_retry_final' | 'native_bypass' | 'log_event_handler' | 'console_message_relay' | 'diagnostics_snapshot_refresh',
    'unknown'
  >,
  number
> = {
  graceful_fs_queue: 0,
  emfile_retry_final: 0,
  native_bypass: 0,
  log_event_handler: 0,
  console_message_relay: 0,
  diagnostics_snapshot_refresh: 0,
};
let _fsExhaustionLastSource: keyof typeof _fsExhaustionCountsBySource | undefined;
let _fsExhaustionLastTaggedAt: number | undefined;

/**
 * Read the current graceful-fs queue length.
 * Best-effort: returns 0 if graceful-fs hasn't installed or the symbol
 * registry shape changed.
 */
function readQueueLength(): number {
  try {
    const fs = require('node:fs') as Record<symbol, unknown>;
    const queue = fs[Symbol.for('graceful-fs.queue')] as GracefulFsQueueEntry[] | undefined;
    if (!Array.isArray(queue)) return 0;
    return queue.length;
  } catch {
    return 0;
  }
}

/**
 * Read the oldest pending op's age in ms (best-effort).
 * graceful-fs queue tuple shape: `[fn, args, err, startTime, lastTime]`.
 */
function readOldestPendingAgeMs(): number | undefined {
  try {
    const fs = require('node:fs') as Record<symbol, unknown>;
    const queue = fs[Symbol.for('graceful-fs.queue')] as GracefulFsQueueEntry[] | undefined;
    if (!Array.isArray(queue) || queue.length === 0) return undefined;
    let oldestStart = Number.POSITIVE_INFINITY;
    for (const entry of queue) {
      if (Array.isArray(entry) && entry.length >= 4) {
        const startTime = entry[3];
        if (typeof startTime === 'number' && startTime < oldestStart) {
          oldestStart = startTime;
        }
      }
    }
    if (!Number.isFinite(oldestStart)) return undefined;
    return Math.max(0, Date.now() - oldestStart);
  } catch {
    return undefined;
  }
}

function serializeInstallError(error: unknown): SerializedInstallError {
  const maybeError = error as NodeJS.ErrnoException | undefined;
  return {
    name: maybeError?.name,
    message: maybeError?.message,
    stack: maybeError?.stack,
    code: maybeError?.code,
  };
}

function tryInstallGracefulFs(): { ok: true } | { ok: false; error: SerializedInstallError } {
  try {
    const gracefulFs = require('graceful-fs') as { gracefulify: (fs: typeof import('node:fs')) => void };
    const fs = require('node:fs') as typeof import('node:fs');
    gracefulFs.gracefulify(fs);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: serializeInstallError(error) };
  }
}

function asBootstrapInstallFailureStash(value: unknown): BootstrapInstallFailureStash {
  return value && typeof value === 'object'
    ? value as BootstrapInstallFailureStash
    : { error: value };
}

function scheduleBootstrapRetryTimer(callback: () => void, delayMs: number): void {
  const timer = setTimeout(() => {
    _pendingBootstrapRetryTimers = _pendingBootstrapRetryTimers.filter((candidate) => candidate !== timer);
    callback();
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  _pendingBootstrapRetryTimers.push(timer);
}

function clearBootstrapRetryTimers(): void {
  for (const timer of _pendingBootstrapRetryTimers) {
    try { clearTimeout(timer); } catch { /* swallow */ }
  }
  _pendingBootstrapRetryTimers = [];
}

function addRecoveredInstallBreadcrumb(
  reporter: ErrorReporter,
  message: string,
  extra: BootstrapInstallFailureStash,
): void {
  try {
    reporter.addBreadcrumb?.({
      category: 'fs.bootstrap',
      level: 'warning',
      message,
      data: { extra },
    });
  } catch {
    /* Never let recovery logging break startup. */
  }
}

function captureInstallFailure(
  reporter: ErrorReporter,
  message: string,
  extra: BootstrapInstallFailureStash,
): void {
  try {
    reporter.captureMessage?.(message, {
      level: 'error',
      extra,
    });
  } catch {
    /* Never let stash-drain failures break installation. */
  }
}

function finishBootstrapInstallReport(
  reporter: ErrorReporter,
  key: BootstrapStashKey,
  failureMessage: string,
  recoveredMessage: string,
  fallbackStash: BootstrapInstallFailureStash,
): void {
  const g = globalThis as BootstrapStashGlobal;
  const stash = asBootstrapInstallFailureStash(g[key] ?? fallbackStash);
  const retryStatus = stash.retry?.status;

  if (retryStatus === 'succeeded') {
    addRecoveredInstallBreadcrumb(reporter, recoveredMessage, stash);
    delete g[key];
    return;
  }

  if (retryStatus === 'failed') {
    captureInstallFailure(reporter, failureMessage, stash);
    delete g[key];
    return;
  }

  const retryResult = tryInstallGracefulFs();
  const attemptedStash: BootstrapInstallFailureStash = {
    ...stash,
    retry: retryResult.ok
      ? {
          status: 'succeeded',
          delayMs: BOOTSTRAP_INSTALL_RETRY_DELAY_MS,
          attemptedAt: Date.now(),
        }
      : {
          status: 'failed',
          delayMs: BOOTSTRAP_INSTALL_RETRY_DELAY_MS,
          attemptedAt: Date.now(),
          error: retryResult.error,
        },
  };

  if (retryResult.ok) {
    addRecoveredInstallBreadcrumb(reporter, recoveredMessage, attemptedStash);
  } else {
    captureInstallFailure(reporter, failureMessage, attemptedStash);
  }
  delete g[key];
}

function scheduleBootstrapInstallReport(
  reporter: ErrorReporter,
  key: BootstrapStashKey,
  failureMessage: string,
  recoveredMessage: string,
): void {
  const g = globalThis as BootstrapStashGlobal;
  const stash = asBootstrapInstallFailureStash(g[key]);
  const retryStatus = stash.retry?.status;

  if (retryStatus === 'succeeded' || retryStatus === 'failed') {
    finishBootstrapInstallReport(reporter, key, failureMessage, recoveredMessage, stash);
    return;
  }

  const scheduledAt = typeof stash.retry?.scheduledAt === 'number' ? stash.retry.scheduledAt : Date.now();
  const delayMs = typeof stash.retry?.delayMs === 'number'
    ? stash.retry.delayMs
    : BOOTSTRAP_INSTALL_RETRY_DELAY_MS;
  const waitMs = retryStatus === 'pending'
    ? Math.max(0, scheduledAt + delayMs + BOOTSTRAP_PENDING_RETRY_GRACE_MS - Date.now())
    : BOOTSTRAP_INSTALL_RETRY_DELAY_MS;

  scheduleBootstrapRetryTimer(
    () => finishBootstrapInstallReport(reporter, key, failureMessage, recoveredMessage, stash),
    waitMs,
  );
}

/**
 * Drain bootstrap install-failure stashes onto the reporter. Each stash gets
 * one delayed recovery check: recovered installs become warning breadcrumbs,
 * while installs that still fail after retry surface as a single
 * `captureMessage` (per "silent failure is a bug").
 */
function drainBootstrapStash(reporter: ErrorReporter): void {
  const g = globalThis as BootstrapStashGlobal;
  try {
    if (g.__REBEL_BOOTSTRAP_BANNER_ERROR__) {
      scheduleBootstrapInstallReport(
        reporter,
        '__REBEL_BOOTSTRAP_BANNER_ERROR__',
        'graceful-fs install failed at banner',
        'graceful-fs install recovered after banner retry',
      );
    }
  } catch {
    /* Never let stash-drain failures break installation. */
  }
  try {
    if (g.__REBEL_BOOTSTRAP_LEAF_ERROR__) {
      scheduleBootstrapInstallReport(
        reporter,
        '__REBEL_BOOTSTRAP_LEAF_ERROR__',
        'graceful-fs install failed at leaf module',
        'graceful-fs install recovered after leaf retry',
      );
    }
  } catch {
    /* Never let stash-drain failures break installation. */
  }
}

/**
 * Install the graceful-fs queue sampler + bootstrap-stash drain.
 *
 * Call once per Node process after the `ErrorReporter` boundary is wired
 * (e.g. immediately after `setErrorReporter(...)`). Returns a cleanup
 * function that stops the sampler — wire this into the existing shutdown
 * handler (`app.on('will-quit')` on desktop, `shutdown()` on cloud).
 *
 * Idempotent: calling again replaces the prior sampler/reporter binding
 * and returns a fresh cleanup function (the previous interval is cleared).
 */
export function installGracefulFsObservability(
  reporter: ErrorReporter,
  opts?: { surface?: string },
): () => void {
  // Replace any prior installation to keep the latest reporter binding.
  if (_currentCleanup) {
    try { _currentCleanup(); } catch { /* swallow */ }
    _currentCleanup = null;
  }
  clearBootstrapRetryTimers();

  _reporter = reporter;
  _surface = opts?.surface ?? 'unknown';

  // Drain bootstrap install-failure stashes synchronously — this is the
  // first opportunity to surface a banner / leaf-module failure now that
  // the reporter is wired.
  drainBootstrapStash(reporter);

  // Sampler state for the current breadcrumb window.
  let peakDepth = 0;
  let activeSamples = 0;
  let lastBreadcrumbAt = Date.now();

  // Threshold-escalation rate-limit state (per process, in-memory).
  let lastCaptureAt = 0;
  let suppressedCount = 0;

  const sampler = setInterval(() => {
    try {
      const currentDepth = readQueueLength();
      _latestQueueDepth = currentDepth;
      if (currentDepth > 0) {
        activeSamples++;
        if (currentDepth > peakDepth) peakDepth = currentDepth;
      }
      const oldestPendingAgeMs = readOldestPendingAgeMs();
      _latestOldestPendingAgeMs = oldestPendingAgeMs;
      if (peakDepth > _latestQueuePeak) _latestQueuePeak = peakDepth;

      const now = Date.now();
      if (now - lastBreadcrumbAt < BREADCRUMB_INTERVAL_MS) return;

      // Window boundary — emit breadcrumb if queue was non-empty at any point.
      if (peakDepth > 0) {
        try {
          reporter.addBreadcrumb?.({
            category: 'fs.queue',
            level: 'info',
            message: 'graceful-fs throttled',
            data: {
              peakDepth,
              currentDepth,
              activeSamples,
              oldestPendingAgeMs,
              surface: _surface,
            },
          });
        } catch {
          /* never break sampler on breadcrumb error */
        }

        // Threshold escalation — captureMessage with rate limiting.
        if (peakDepth > QUEUE_DEPTH_ESCALATION_THRESHOLD) {
          const timeSinceLastCapture = now - lastCaptureAt;
          if (lastCaptureAt === 0 || timeSinceLastCapture >= CAPTURE_RATE_LIMIT_MS) {
            try {
              reporter.captureMessage?.('graceful-fs queue threshold exceeded', {
                level: 'warning',
                extra: {
                  peakDepth,
                  currentDepth,
                  activeSamples,
                  oldestPendingAgeMs,
                  surface: _surface,
                  suppressedCount: lastCaptureAt === 0 ? 0 : suppressedCount,
                },
              });
              lastCaptureAt = now;
              suppressedCount = 0;
            } catch {
              /* never break sampler on capture error */
            }
          } else {
            suppressedCount++;
          }
        }
      }

      // Reset window stats.
      peakDepth = 0;
      activeSamples = 0;
      lastBreadcrumbAt = now;
    } catch {
      /* swallow — sampler must never throw */
    }
  }, SAMPLER_INTERVAL_MS);

  // Don't keep the process alive just for this sampler.
  if (typeof sampler.unref === 'function') sampler.unref();

  const cleanup = (): void => {
    try { clearInterval(sampler); } catch { /* swallow */ }
    clearBootstrapRetryTimers();
    if (_currentCleanup === cleanup) {
      _currentCleanup = null;
      _reporter = null;
    }
  };
  _currentCleanup = cleanup;
  return cleanup;
}

/**
 * Source classification for an EMFILE/ENFILE event that escaped graceful-fs.
 * `'unknown'` is a sentinel — no capture is performed, preserving prior
 * behaviour (final-attempt rethrows without classification did not double
 * report).
 */
export type FsExhaustionSource =
  | 'graceful_fs_queue'
  | 'emfile_retry_final'
  | 'native_bypass'
  | 'log_event_handler'
  | 'console_message_relay'
  | 'diagnostics_snapshot_refresh'
  | 'unknown';

/**
 * Tag a fatal EMFILE/ENFILE event with `fs_exhaustion.source` and a context
 * snapshot. Per-event scoped via {@link ErrorReporter.captureExceptionWithScope}
 * (which wraps `Sentry.withScope`) so global isolation scope is never
 * polluted.
 *
 * Best-effort: any reporter-side failure is swallowed to preserve retry
 * semantics.
 */
export function tagFsExhaustion(error: unknown, source: FsExhaustionSource): void {
  if (source === 'unknown') return; // preserve prior no-capture behaviour

  // Counter bookkeeping happens regardless of whether a reporter is wired:
  // a process running without Sentry still benefits from the bundle snapshot.
  try {
    _fsExhaustionCountsBySource[source]++;
    _fsExhaustionLastSource = source;
    _fsExhaustionLastTaggedAt = Date.now();
  } catch {
    /* counter must never break retry semantics */
  }

  const reporter = _reporter;
  if (!reporter || typeof reporter.captureExceptionWithScope !== 'function') return;

  try {
    // Snapshot stats at moment of tagging (best-effort).
    const queueDepth = readQueueLength();
    const oldestPendingAgeMs = readOldestPendingAgeMs();
    const queuePeak = Math.max(_latestQueuePeak, queueDepth);
    const surface = _surface;

    reporter.captureExceptionWithScope(error, (scope: ErrorReporterEventScope) => {
      scope.setTag('fs_exhaustion.source', source);
      scope.setContext('fs_exhaustion', {
        source,
        surface,
        queueDepth,
        queuePeak,
        oldestPendingAgeMs,
      });
    });
  } catch {
    /* tagging must never break retry semantics */
  }
}

/**
 * Snapshot of graceful-fs / EMFILE pressure observed during this process
 * lifetime. Embedded in diagnostic bundles so EMFILE retry exhaustion shows
 * up alongside other resource-pressure signals without anyone reading raw
 * Sentry events.
 *
 * Counters are lifetime-since-process-start; queue stats are the latest
 * sampler observation (peak is the all-time high, depth is the current snapshot).
 */
export interface FsExhaustionSnapshot {
  /** Per-source lifetime tag count. Keys with zero count are still present. */
  sourceCounts: Record<keyof typeof _fsExhaustionCountsBySource, number>;
  /** Last source that crossed `tagFsExhaustion`, if any. */
  lastSource?: keyof typeof _fsExhaustionCountsBySource;
  /** Epoch ms when {@link lastSource} was tagged. */
  lastTaggedAt?: number;
  /** Current graceful-fs queue depth (last sampler observation). */
  queueDepth: number;
  /** Highest queue depth observed during this process lifetime. */
  queuePeak: number;
  /** Age of the oldest pending op currently in the queue, in ms. */
  oldestPendingAgeMs?: number;
}

/**
 * Read a defensive copy of the EMFILE / fs-exhaustion counters and queue
 * stats. Best-effort: returns zeroed counters and `queueDepth:0` if anything
 * goes wrong, never throws.
 */
export function getFsExhaustionSnapshot(): FsExhaustionSnapshot {
  try {
    return {
      sourceCounts: { ..._fsExhaustionCountsBySource },
      lastSource: _fsExhaustionLastSource,
      lastTaggedAt: _fsExhaustionLastTaggedAt,
      queueDepth: _latestQueueDepth,
      queuePeak: _latestQueuePeak,
      oldestPendingAgeMs: _latestOldestPendingAgeMs,
    };
  } catch {
    return {
      sourceCounts: {
        graceful_fs_queue: 0,
        emfile_retry_final: 0,
        native_bypass: 0,
        log_event_handler: 0,
        console_message_relay: 0,
        diagnostics_snapshot_refresh: 0,
      },
      queueDepth: 0,
      queuePeak: 0,
    };
  }
}

/**
 * Test-only reset hook — clears module-scoped state so tests get a clean
 * slate between runs.
 * @internal
 */
export function _resetForTesting(): void {
  if (_currentCleanup) {
    try { _currentCleanup(); } catch { /* swallow */ }
  }
  clearBootstrapRetryTimers();
  _currentCleanup = null;
  _reporter = null;
  _surface = 'unknown';
  _latestQueueDepth = 0;
  _latestQueuePeak = 0;
  _latestOldestPendingAgeMs = undefined;
  for (const key of Object.keys(_fsExhaustionCountsBySource) as Array<keyof typeof _fsExhaustionCountsBySource>) {
    _fsExhaustionCountsBySource[key] = 0;
  }
  _fsExhaustionLastSource = undefined;
  _fsExhaustionLastTaggedAt = undefined;
  const g = globalThis as BootstrapStashGlobal;
  delete g.__REBEL_BOOTSTRAP_BANNER_ERROR__;
  delete g.__REBEL_BOOTSTRAP_LEAF_ERROR__;
}
