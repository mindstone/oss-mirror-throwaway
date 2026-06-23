/**
 * Event-loop-lag telemetry service (Stage 2 of
 * `docs/plans/260423_secondary_process_cpu_observability.md`).
 *
 * Platform-agnostic: uses only Node core `perf_hooks`. Zero imports from
 * `electron` or `src/main/*` so cloud-service (same event-loop-lag risk) can
 * consume it unchanged — see plan § Code Layout / core-first convention.
 *
 * Usage:
 * ```ts
 * const monitor = startEventLoopLagMonitor({ logger });
 * // per diagnostic tick:
 * const sample = monitor.sample();
 * // on shutdown:
 * monitor.dispose();
 * ```
 *
 * Sampling model:
 *  - One `monitorEventLoopDelay({ resolution })` histogram, enabled immediately.
 *  - Each `sample()` reads `percentile(50/95/99)`, `max`, `min`, `mean` (all
 *    nanoseconds), converts to ms, then calls `histogram.reset()` so the next
 *    window is fresh. Without the reset, percentiles become monotonically
 *    polluted and a single early spike dominates every subsequent report.
 *  - `windowDurationMs` is measured from the previous `sample()` (or monitor
 *    start) so consumers can reason about window length independent of the
 *    diagnostic cadence.
 *
 * Fail-observable contract (per plan § Fail-Observable Contract):
 *  - `monitorEventLoopDelay(...)` / `.enable()` failures are caught at init:
 *    the monitor logs once at warn and returns a **degraded sampler** whose
 *    `sample()` emits `{ status: 'unavailable', error, windowDurationMs: 0 }`.
 *    `dispose()` is a no-op on degraded.
 *  - A real monitor whose downstream `percentile` call throws will surface
 *    the same `status: 'unavailable'` shape from that tick rather than
 *    propagating. `reset()` still runs in `finally`, so the next window
 *    starts fresh regardless of read outcome.
 *  - After `dispose()`, `sample()` returns `{ status: 'unavailable', error:
 *    'monitor disposed', windowDurationMs: 0 }` — disposed is an expected
 *    terminal state (no log) and prevents emitting stale/garbage percentiles
 *    from a disabled histogram.
 */

import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'node:perf_hooks';

import type { Logger } from '@core/logger';

/** Discriminated union — either a healthy sample or an explicit unavailable marker. */
export type EventLoopLagSample =
  | {
      status: 'ok';
      /** 50th percentile lag within the window, in milliseconds. */
      p50: number;
      /** 95th percentile lag within the window, in milliseconds. */
      p95: number;
      /** 99th percentile lag within the window, in milliseconds. */
      p99: number;
      /** Maximum lag observed within the window, in milliseconds. */
      max: number;
      /** Minimum lag observed within the window, in milliseconds. */
      min: number;
      /** Mean lag within the window, in milliseconds. */
      mean: number;
      /** Elapsed time (ms) since the previous `sample()` call (or monitor start). */
      windowDurationMs: number;
    }
  | {
      status: 'unavailable';
      /** Human-readable reason. */
      error: string;
      /** 0 on init failure; non-zero if a downstream call fails mid-window. */
      windowDurationMs: number;
    };

export interface EventLoopLagMonitor {
  /** Read the current window's lag histogram and reset for the next window. */
  sample(): EventLoopLagSample;
  /** Disable the underlying histogram. Idempotent. */
  dispose(): void;
}

export interface StartEventLoopLagMonitorOptions {
  /**
   * Histogram resolution in milliseconds. Passed to `monitorEventLoopDelay`.
   * Default: 20.
   */
  resolution?: number;
  /**
   * Optional Pino logger. Used at init to emit a single `warn` if the
   * histogram cannot be constructed / enabled.
   */
  logger?: Logger;
  /**
   * @internal Test-only DI seam: override histogram construction. When
   * provided, its return value is used in place of
   * `monitorEventLoopDelay()`. If the factory throws, the monitor degrades
   * to `status: 'unavailable'` exactly as it would on real init failure.
   */
  _createHistogramForTesting?: () => IntervalHistogram;
}

const NS_PER_MS = 1_000_000;

/**
 * Minimal histogram interface used internally — matches Node's
 * `IntervalHistogram` surface we actually call. Kept narrow so test fakes
 * don't need to mock unused methods (`exceeds`, etc).
 */
interface HistogramLike {
  percentile(n: number): number;
  max: number;
  min: number;
  mean: number;
  reset(): void;
  enable?(): boolean;
  disable?(): boolean;
}

export function startEventLoopLagMonitor(
  opts: StartEventLoopLagMonitorOptions = {},
): EventLoopLagMonitor {
  const { resolution = 20, logger, _createHistogramForTesting } = opts;

  let histogram: HistogramLike | null = null;
  let initError: string | null = null;
  let disposed = false;
  let lastSampleMs = performance.now();

  try {
    histogram = _createHistogramForTesting
      ? (_createHistogramForTesting() as unknown as HistogramLike)
      : (monitorEventLoopDelay({ resolution }) as unknown as HistogramLike);
    histogram.enable?.();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    initError = msg;
    histogram = null;
    if (logger) {
      logger.warn({ err }, 'eventLoopLagService: failed to initialize event-loop-delay histogram');
    }
  }

  return {
    sample(): EventLoopLagSample {
      // Disposed is an expected terminal state — no log, no reset (handle
      // already disabled), no throw. Preserves the fail-observable contract
      // by surfacing an explicit `status: 'unavailable'` instead of returning
      // stale / garbage percentiles from a disabled histogram.
      if (disposed) {
        return {
          status: 'unavailable',
          error: 'monitor disposed',
          windowDurationMs: 0,
        };
      }

      const now = performance.now();
      const windowDurationMs = Math.max(0, now - lastSampleMs);
      lastSampleMs = now;

      if (!histogram) {
        return {
          status: 'unavailable',
          error: initError ?? 'event-loop-delay histogram not initialized',
          windowDurationMs: initError ? 0 : windowDurationMs,
        };
      }

      // Read stats then reset in `finally`. Guarantees exactly-once
      // `reset()` per `sample()` attempt: both the success path and the
      // read-failure path hand the next window a fresh histogram. Without
      // this, a thrown percentile read would leave the window polluted and
      // the next `sample()` would return tainted percentiles.
      let result: EventLoopLagSample;
      try {
        result = {
          status: 'ok',
          p50: histogram.percentile(50) / NS_PER_MS,
          p95: histogram.percentile(95) / NS_PER_MS,
          p99: histogram.percentile(99) / NS_PER_MS,
          max: histogram.max / NS_PER_MS,
          min: histogram.min / NS_PER_MS,
          mean: histogram.mean / NS_PER_MS,
          windowDurationMs,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result = {
          status: 'unavailable',
          error: msg,
          windowDurationMs,
        };
      } finally {
        // Reset so the next window starts fresh. Without this, percentiles
        // accumulate and early spikes dominate every subsequent report.
        // If reset() itself throws, log at debug and move on — the next
        // sample() will either succeed or surface its own failure.
        try {
          histogram.reset();
        } catch (resetErr) {
          logger?.warn({ err: resetErr }, 'eventLoopLagService: reset() threw');
        }
      }
      return result;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (histogram) {
        try {
          histogram.disable?.();
        } catch {
          // Ignore — the underlying handle may already be gone.
        }
      }
    },
  };
}
