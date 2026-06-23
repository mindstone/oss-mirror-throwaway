/**
 * Hot-path performance counters for Stage 1 observability.
 *
 * Shared counter struct + tiny helper used by the three Stage 1 hotspots:
 *  - `src/main/ipc/plugins/shared.ts` (isKnownPlugin)
 *  - `src/main/services/pluginSpaceService.ts` (scanSpacePlugins — "true bottom")
 *  - `src/main/services/spaceService.ts` (scanSpaces, per-lane)
 *
 * Contract:
 *  - Counter updates are O(1) primitive ops and NEVER gated on REBEL_PERF_MODE
 *    (the periodic log block that emits them is gated at the emit site).
 *  - `maxConcurrentInflight` is a high-water mark of concurrent underlying
 *    fetches — increments on `recordUnderlyingFetchStart`, decrements on
 *    `recordUnderlyingFetchEnd`, max latches even after callers settle.
 *  - `inflightJoins` stays 0 pre-Stage-4/5 (no in-flight dedup yet).
 *
 * See docs/plans/260420_perf_observability_and_low_risk_wins.md § Stage 1.
 */

export interface HotPathCounters {
  /** Total calls to the observed function path. */
  requests: number;
  /** Served from cache (no underlying fetch). */
  hits: number;
  /** Cache miss — fell through to an underlying fetch. */
  misses: number;
  /** N where a concurrent call piggybacked on an in-flight fetch. Pre-Stage-4/5 this is 0. */
  inflightJoins: number;
  /** Real calls to the underlying expensive op. */
  underlyingFetches: number;
  /** Underlying op rejected. */
  fetchErrors: number;
  /** High-water mark of concurrent UNDERLYING fetches observed in this session. */
  maxConcurrentInflight: number;
}

export interface WindowedCounterSnapshot {
  /** Count observed in the rolling 5-minute window. */
  rate5m: number;
  /** Session-lifetime cumulative count. */
  cumulative: number;
}

export interface HotPathWindowedCounters {
  requests: WindowedCounterSnapshot;
  hits: WindowedCounterSnapshot;
  misses: WindowedCounterSnapshot;
  inflightJoins: WindowedCounterSnapshot;
  underlyingFetches: WindowedCounterSnapshot;
  fetchErrors: WindowedCounterSnapshot;
  /**
   * Gauge field, not an incrementing counter. `rate5m` mirrors the current
   * session high-water mark for compatibility with the shared snapshot shape.
   */
  maxConcurrentInflight: WindowedCounterSnapshot;
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

/**
 * Rolling counter with a fixed 5-minute rate window + cumulative total.
 *
 * Uses a compacted timestamp queue (head index + occasional slice) so hot
 * paths can increment cheaply without unbounded array-shift cost.
 */
export class WindowedCounter {
  private readonly windowMs: number;
  private readonly now: () => number;
  private cumulativeCount = 0;
  private timestamps: number[] = [];
  private headIndex = 0;

  constructor(options?: { windowMs?: number; now?: () => number }) {
    this.windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options?.now ?? (() => Date.now());
  }

  increment(amount = 1): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const wholeAmount = Math.floor(amount);
    if (wholeAmount <= 0) return;

    const nowMs = this.now();
    this.cumulativeCount += wholeAmount;
    for (let index = 0; index < wholeAmount; index += 1) {
      this.timestamps.push(nowMs);
    }
    this.prune(nowMs);
  }

  snapshot(): WindowedCounterSnapshot {
    const nowMs = this.now();
    this.prune(nowMs);
    return {
      rate5m: this.timestamps.length - this.headIndex,
      cumulative: this.cumulativeCount,
    };
  }

  _resetForTesting(): void {
    this.cumulativeCount = 0;
    this.timestamps = [];
    this.headIndex = 0;
  }

  private prune(nowMs: number): void {
    const cutoffMs = nowMs - this.windowMs;
    while (this.headIndex < this.timestamps.length && this.timestamps[this.headIndex] < cutoffMs) {
      this.headIndex += 1;
    }

    // Compact occasionally to keep memory bounded in long sessions.
    if (this.headIndex > 0 && this.headIndex * 2 >= this.timestamps.length) {
      this.timestamps = this.timestamps.slice(this.headIndex);
      this.headIndex = 0;
    }
  }
}

export function createEmptyHotPathCounters(): HotPathCounters {
  return {
    requests: 0,
    hits: 0,
    misses: 0,
    inflightJoins: 0,
    underlyingFetches: 0,
    fetchErrors: 0,
    maxConcurrentInflight: 0,
  };
}

/**
 * Tiny tracker that bundles the counter struct with an in-flight gauge and
 * exposes the increment helpers the three hotspots need. Everything is module-
 * level state in the owning service — this class is just a typed namespace.
 *
 * Why a class and not free functions on each module? Two reasons:
 *   1. The `maxConcurrentInflight` latching logic is non-trivial to inline in
 *      three places and easy to get subtly wrong (decrement-but-max-stays).
 *   2. Stage 4/5 will reuse the same tracker for coalesced-cache observability
 *      hooks (`onHit` / `onInflight`) without changing the struct shape.
 */
export class HotPathCounterTracker {
  readonly counters: HotPathCounters = createEmptyHotPathCounters();
  private inFlight = 0;
  private readonly requestsWindow = new WindowedCounter();
  private readonly hitsWindow = new WindowedCounter();
  private readonly missesWindow = new WindowedCounter();
  private readonly inflightJoinsWindow = new WindowedCounter();
  private readonly underlyingFetchesWindow = new WindowedCounter();
  private readonly fetchErrorsWindow = new WindowedCounter();

  recordRequest(): void {
    this.counters.requests++;
    this.requestsWindow.increment();
  }

  recordHit(): void {
    this.counters.hits++;
    this.hitsWindow.increment();
  }

  recordMiss(): void {
    this.counters.misses++;
    this.missesWindow.increment();
  }

  /** Increment `inflightJoins` — a concurrent call piggybacked on an existing in-flight fetch. */
  recordInflightJoin(): void {
    this.counters.inflightJoins++;
    this.inflightJoinsWindow.increment();
  }

  /**
   * Increment `underlyingFetches` + bump the in-flight gauge and latch
   * `maxConcurrentInflight` if we're a new peak. Pair with
   * `recordUnderlyingFetchEnd()` in a `finally` block.
   */
  recordUnderlyingFetchStart(): void {
    this.counters.underlyingFetches++;
    this.underlyingFetchesWindow.increment();
    this.inFlight++;
    if (this.inFlight > this.counters.maxConcurrentInflight) {
      this.counters.maxConcurrentInflight = this.inFlight;
    }
  }

  /** Decrements the in-flight gauge. Safe to call more times than start (clamps at 0). */
  recordUnderlyingFetchEnd(): void {
    if (this.inFlight > 0) this.inFlight--;
  }

  recordFetchError(): void {
    this.counters.fetchErrors++;
    this.fetchErrorsWindow.increment();
  }

  /** Returns a plain copy of the counter struct (safe to log/serialise). */
  snapshot(): HotPathCounters {
    return { ...this.counters };
  }

  /** Returns rolling-window + cumulative snapshots for all counter fields. */
  windowedSnapshot(): HotPathWindowedCounters {
    return {
      requests: this.requestsWindow.snapshot(),
      hits: this.hitsWindow.snapshot(),
      misses: this.missesWindow.snapshot(),
      inflightJoins: this.inflightJoinsWindow.snapshot(),
      underlyingFetches: this.underlyingFetchesWindow.snapshot(),
      fetchErrors: this.fetchErrorsWindow.snapshot(),
      maxConcurrentInflight: {
        rate5m: this.counters.maxConcurrentInflight,
        cumulative: this.counters.maxConcurrentInflight,
      },
    };
  }

  /** Zeros all counters and the in-flight gauge. Test-only. */
  _resetForTesting(): void {
    this.counters.requests = 0;
    this.counters.hits = 0;
    this.counters.misses = 0;
    this.counters.inflightJoins = 0;
    this.counters.underlyingFetches = 0;
    this.counters.fetchErrors = 0;
    this.counters.maxConcurrentInflight = 0;
    this.inFlight = 0;
    this.requestsWindow._resetForTesting();
    this.hitsWindow._resetForTesting();
    this.missesWindow._resetForTesting();
    this.inflightJoinsWindow._resetForTesting();
    this.underlyingFetchesWindow._resetForTesting();
    this.fetchErrorsWindow._resetForTesting();
  }
}
