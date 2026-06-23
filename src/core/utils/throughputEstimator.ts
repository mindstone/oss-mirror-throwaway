/**
 * ThroughputEstimator
 *
 * Rolling-window slope estimator for byte throughput. Used by the cloud
 * migration UI (Stage 7) to render honest ETAs ("3 min · 27% · 240/900 MB")
 * instead of the static "1–5 minutes depending on size" lie we used to ship.
 *
 * Despite earlier drafts calling this an "EMA" (exponential moving average),
 * it is not one: the estimate is `(newestBytes − oldestBytes) / windowSpan`,
 * i.e. the slope of a straight line through the window endpoints, not an
 * exponentially weighted average of per-sample rates. Renamed for honesty.
 *
 * Design notes:
 *   - Samples are `(timestamp, bytesSent)` observations. The estimator
 *     computes `deltaBytes / deltaTime` across the rolling window.
 *   - We discard samples older than `windowMs` before computing throughput,
 *     so a brief stall naturally drags the estimate toward zero.
 *   - `hasEnoughSamples` gates the UI: before we have two samples spanning
 *     at least `minSpanMs` we show "Estimating..." rather than a made-up
 *     ETA. No fabrication — a core principle of this plan.
 *   - Clock is injectable so tests can run without `vi.useFakeTimers`-level
 *     ceremony.
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 1 — Shared Utilities; Stage 7 consumer)
 */

export interface ThroughputClock {
  now(): number;
}

const DEFAULT_CLOCK: ThroughputClock = {
  now: () => Date.now(),
};

export interface ThroughputEstimatorOptions {
  /** Size of the rolling window, in ms. Older samples are evicted. */
  windowMs?: number;
  /**
   * Minimum span between oldest and newest sample before we publish a
   * throughput estimate. Prevents whipsawing on the first ~second of data.
   */
  minSpanMs?: number;
  /**
   * Minimum number of samples required before we publish an estimate.
   * Defaults to 2 (you need at least a pair to compute a delta).
   */
  minSamples?: number;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  clock?: ThroughputClock;
}

interface Sample {
  /** Monotonic timestamp (ms). */
  t: number;
  /** Cumulative bytes observed at `t`. */
  bytes: number;
}

export interface ThroughputSnapshot {
  /** Bytes per second over the rolling window. `0` when stalled. */
  bytesPerSecond: number;
  /**
   * Estimated seconds remaining given `bytesRemaining`. `Infinity` when the
   * current rate is zero. Callers should clamp / show `—` as appropriate.
   */
  etaSeconds: number;
  /**
   * `true` once we've collected enough samples to publish a useful estimate.
   * UIs should render "Estimating..." while this is `false`.
   */
  hasEnoughSamples: boolean;
}

/**
 * Rolling-window throughput estimator. One instance per migration run — see
 * Stage 7's `useRef` pattern keyed on `MigrationStep.runId`.
 */
export class ThroughputEstimator {
  private readonly samples: Sample[] = [];
  private readonly windowMs: number;
  private readonly minSpanMs: number;
  private readonly minSamples: number;
  private readonly clock: ThroughputClock;

  constructor(options: ThroughputEstimatorOptions = {}) {
    this.windowMs = options.windowMs ?? 30_000;
    this.minSpanMs = options.minSpanMs ?? 500;
    this.minSamples = Math.max(2, options.minSamples ?? 2);
    this.clock = options.clock ?? DEFAULT_CLOCK;
  }

  /**
   * Record a new cumulative byte count. `bytes` is the total bytes observed
   * so far (NOT a delta). A timestamp may be provided for tests; otherwise
   * the injected clock is used.
   */
  addSample(bytes: number, timestampMs?: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) {
      // Ignore garbage — never let bad input corrupt the window.
      return;
    }
    const t = timestampMs ?? this.clock.now();

    // Defend against non-monotonic clock jumps (e.g. system sleep/wake):
    // if a new sample is older than the newest we have, discard it rather
    // than letting the window logic produce negative durations.
    const newest = this.samples[this.samples.length - 1];
    if (newest !== undefined && t < newest.t) {
      return;
    }

    this.samples.push({ t, bytes });
    this.evictStale(t);
  }

  /**
   * Snapshot the current throughput and optionally an ETA against a known
   * remaining byte count. Pass `Number.POSITIVE_INFINITY` (or omit) when the
   * remaining count is unknown — the returned `etaSeconds` will also be
   * infinite, which callers should render as `—`.
   */
  snapshot(bytesRemaining: number = Number.POSITIVE_INFINITY): ThroughputSnapshot {
    this.evictStale(this.clock.now());

    const count = this.samples.length;
    if (count < this.minSamples) {
      return { bytesPerSecond: 0, etaSeconds: Infinity, hasEnoughSamples: false };
    }

    const oldest = this.samples[0];
    const newest = this.samples[count - 1];
    const deltaMs = newest.t - oldest.t;
    if (deltaMs < this.minSpanMs) {
      return { bytesPerSecond: 0, etaSeconds: Infinity, hasEnoughSamples: false };
    }

    const deltaBytes = newest.bytes - oldest.bytes;
    // If cumulative bytes went backwards (e.g. retry reset the counter),
    // treat this as "no useful estimate yet" rather than lying.
    if (deltaBytes <= 0) {
      return { bytesPerSecond: 0, etaSeconds: Infinity, hasEnoughSamples: false };
    }

    const bytesPerSecond = (deltaBytes / deltaMs) * 1000;
    const etaSeconds =
      Number.isFinite(bytesRemaining) && bytesPerSecond > 0
        ? Math.max(0, bytesRemaining) / bytesPerSecond
        : Infinity;

    return {
      bytesPerSecond,
      etaSeconds,
      hasEnoughSamples: true,
    };
  }

  /** Drop the rolling window. Useful when switching between migration runs. */
  reset(): void {
    this.samples.length = 0;
  }

  /** Test-only: number of samples currently retained. */
  get sampleCount(): number {
    return this.samples.length;
  }

  private evictStale(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    // Samples are pushed in monotonic order, so we can shift from the front.
    while (this.samples.length > 0 && this.samples[0].t < cutoff) {
      this.samples.shift();
    }
  }
}
