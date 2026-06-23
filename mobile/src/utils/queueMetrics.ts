// mobile/src/utils/queueMetrics.ts
//
// Periodic structured-log metrics for the offline queue.
//
// WHY?
// ----
// Breadcrumbs (queueBreadcrumbs.ts) give us per-event context attached to
// captured issues, but they don't give us a time series. For operational
// visibility — "is the queue healthy right now?" — we emit a flat,
// PII-free metrics log at a fixed cadence. Log pipeline can tail these and
// build dashboards.
//
// DESIGN CONSTRAINTS (per Operational lens review)
// ------------------------------------------------
// - Emit ONLY while the queue is doing something worth watching:
//     - has pending items, OR
//     - limitedConnectivityAt is set, OR
//     - authExpiredAt is set, OR
//     - queueFullAt is set
//   Idle periods are silent — no log spam.
// - Pause while the app is backgrounded (AppState !== 'active'). When we
//   come back to foreground, we resume emitting.
// - Keep fields PII-free. Only counts, ids/types, and timestamps.
//
// WIRING
// ------
// `startQueueMetrics({ getSnapshot, getAppState, intervalMs, emit })`
// returns a `stop()` function. The caller owns the timer lifecycle.
// We inject `getSnapshot` + `getAppState` so this module is unit-testable
// without pulling in the store or AppState directly.

import type { QueueItem, QueueStateSnapshot } from '@rebel/cloud-client';

export interface QueueMetricsSample {
  /** Milliseconds since epoch when the sample was taken. */
  timestamp: number;
  /** Number of items currently pending in the queue. */
  pendingCount: number;
  /** Count by item type: 'text-message', 'meeting-chunk', etc. */
  countsByType: Record<string, number>;
  /** Count of items that are eligible to retry right now. */
  readyCount: number;
  /** Count of items waiting on their `nextRetryAt`. */
  retryBackoffCount: number;
  /** Max retry count across all pending items. */
  maxAttempts: number;
  /** Number of items with a non-null `errorCategory`. */
  failedItemCount: number;
  /** Count by errorCategory across all pending items. */
  countsByErrorCategory: Record<string, number>;
  /** Queue-level state flags. */
  limitedConnectivity: boolean;
  authExpired: boolean;
  queueFull: boolean;
  /** ms since the oldest item was enqueued, or null if empty. */
  oldestAgeMs: number | null;
}

export interface StartQueueMetricsOptions {
  /** Returns the current queue snapshot. Typically `useOfflineQueueStore.getState()`. */
  getSnapshot: () => QueueStateSnapshot | undefined;
  /** Returns the current AppState ('active' | 'background' | 'inactive'). */
  getAppState: () => string;
  /** How often to evaluate + emit. Default 60s. */
  intervalMs?: number;
  /** Callback invoked with each sample. */
  emit: (sample: QueueMetricsSample) => void;
  /**
   * Optional clock override for tests. Defaults to `Date.now`.
   */
  now?: () => number;
}

function summarizeItems(items: QueueItem[], now: number): {
  countsByType: Record<string, number>;
  readyCount: number;
  retryBackoffCount: number;
  maxAttempts: number;
  failedItemCount: number;
  countsByErrorCategory: Record<string, number>;
  oldestAgeMs: number | null;
} {
  if (items.length === 0) {
    return {
      countsByType: {},
      readyCount: 0,
      retryBackoffCount: 0,
      maxAttempts: 0,
      failedItemCount: 0,
      countsByErrorCategory: {},
      oldestAgeMs: null,
    };
  }

  const countsByType: Record<string, number> = {};
  const countsByErrorCategory: Record<string, number> = {};
  let readyCount = 0;
  let retryBackoffCount = 0;
  let maxAttempts = 0;
  let failedItemCount = 0;
  let oldestEnqueued = Infinity;

  for (const item of items) {
    const t = item.type;
    countsByType[t] = (countsByType[t] ?? 0) + 1;

    const nextRetryAt = item.nextRetryAt ?? 0;
    if (nextRetryAt <= now) readyCount += 1; else retryBackoffCount += 1;

    if ((item.attempts ?? 0) > maxAttempts) maxAttempts = item.attempts ?? 0;

    if (item.errorCategory) {
      failedItemCount += 1;
      const key = String(item.errorCategory);
      countsByErrorCategory[key] = (countsByErrorCategory[key] ?? 0) + 1;
    }

    const enqueuedAt = item.enqueuedAt ?? now;
    if (enqueuedAt < oldestEnqueued) oldestEnqueued = enqueuedAt;
  }

  return {
    countsByType,
    readyCount,
    retryBackoffCount,
    maxAttempts,
    failedItemCount,
    countsByErrorCategory,
    oldestAgeMs: oldestEnqueued === Infinity ? null : Math.max(0, now - oldestEnqueued),
  };
}

export function buildQueueMetricsSample(
  snapshot: QueueStateSnapshot,
  now: number,
): QueueMetricsSample {
  const summary = summarizeItems(snapshot.items, now);
  return {
    timestamp: now,
    pendingCount: snapshot.items.length,
    countsByType: summary.countsByType,
    readyCount: summary.readyCount,
    retryBackoffCount: summary.retryBackoffCount,
    maxAttempts: summary.maxAttempts,
    failedItemCount: summary.failedItemCount,
    countsByErrorCategory: summary.countsByErrorCategory,
    limitedConnectivity: snapshot.limitedConnectivityAt !== null,
    authExpired: snapshot.authExpiredAt !== null,
    queueFull: snapshot.queueFullAt !== null,
    oldestAgeMs: summary.oldestAgeMs,
  };
}

export function shouldEmit(snapshot: QueueStateSnapshot, appState: string): boolean {
  if (appState !== 'active') return false;
  if (snapshot.items.length > 0) return true;
  if (snapshot.limitedConnectivityAt !== null) return true;
  if (snapshot.authExpiredAt !== null) return true;
  if (snapshot.queueFullAt !== null) return true;
  return false;
}

export interface StopQueueMetrics {
  stop: () => void;
  /** Invoke immediately — exposed for tests. Normal callers should not use this. */
  emitNow: () => QueueMetricsSample | null;
}

export function startQueueMetrics(opts: StartQueueMetricsOptions): StopQueueMetrics {
  const intervalMs = opts.intervalMs ?? 60_000;
  const now = opts.now ?? (() => Date.now());

  const evaluate = (): QueueMetricsSample | null => {
    const snapshot = opts.getSnapshot();
    if (!snapshot) return null;
    const appState = opts.getAppState();
    if (!shouldEmit(snapshot, appState)) return null;
    const sample = buildQueueMetricsSample(snapshot, now());
    opts.emit(sample);
    return sample;
  };

  const handle = setInterval(evaluate, intervalMs);

  return {
    stop: () => clearInterval(handle),
    emitNow: evaluate,
  };
}
