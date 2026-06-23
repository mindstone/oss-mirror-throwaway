/**
 * Pure detection predicate for the production "Renderer memory leak suspected"
 * alarm emitted from `src/renderer/App.tsx`.
 *
 * Why this exists (intent — see docs/project/APP_PERFORMANCE_AND_MEMORY.md and
 * docs/plans/260614_perf-leak-alarm-quality/PLAN.md):
 *
 * The original in-line detector compared the two endpoints of the retained
 * heap-sample window (`oldest = history[0]` vs `newest`) and fired whenever
 * `growthMB > 50 && rate > 30`. That has three defects that made the alarm
 * noisy and untrustworthy in production:
 *   1. A single one-time heap step-up (e.g. 159→228, then flat) persisted in
 *      the window and kept registering as "growth" for many ticks.
 *   2. The window's wall-span is untrusted — under background throttling /
 *      machine sleep, 12 samples can span hours, so the endpoint "rate" is
 *      computed over a misleading denominator (and a post-sleep snapshot can
 *      fabricate a rate spike).
 *   3. The strict `growthMB > 50` floor silently missed an exact ~50 MB/hr
 *      leak that only accrues ~48 MB inside the ≤55-min window.
 *
 * This function is intentionally PURE: zero imports, no `Date.now()` inside
 * (the caller passes `now`), so unit tests can drive realistic wall-clock gaps
 * without mocking the clock. The App.tsx throttle state (last-fired timestamp /
 * heap) lives in the caller; this function only *reads* it to report whether a
 * fire would be throttle-suppressed via the structured verdict.
 *
 * Accepted residual (Phase-5): on a *minimal* 6-sample contiguous segment, a
 * mid-window step-then-plateau (the step landing at index ≥2) can fire ONCE —
 * the latter-half slope is briefly positive before the plateau dominates. The
 * ≤1/30min throttle dedups it, and a recent step-up is worth surfacing once;
 * this is acceptable versus the old endpoint detector's 280-firing storm.
 */

export interface HeapSample {
  /** Resident V8 heap (MB) at this sample. */
  heapUsedMB: number;
  /** Wall-clock timestamp (ms epoch) of this sample. */
  timestamp: number;
}

export interface DetectSustainedHeapGrowthInput {
  /** Heap samples in chronological (oldest → newest) order. */
  samples: HeapSample[];
  /** Nominal sampling interval (ms). Used to detect sleep/throttle gaps. */
  nominalIntervalMs: number;
  /** Heap (MB) at the last WARN firing, or null if never fired this session. */
  lastFiredHeapMB: number | null;
  /** Timestamp (ms) of the last WARN firing, or null if never fired. */
  lastFiredAtMs: number | null;
  /** Current wall-clock time (ms). Passed in so the fn stays pure/testable. */
  now: number;
}

export interface DetectSustainedHeapGrowthResult {
  /**
   * True when a genuine sustained leak is detected AND the throttle does not
   * suppress it. The caller still owns advancing the throttle state on a fire.
   */
  shouldWarn: boolean;
  /** Endpoint growth (MB) over the newest contiguous segment. */
  growthMB: number;
  /** Endpoint rate (MB/hr) over the newest contiguous segment. */
  ratePerHour: number;
  /** Least-squares slope (MB/hr) over the latter half of the segment. */
  slopeMBPerHr: number;
  /** Number of contiguous samples in the newest segment. */
  segmentSampleCount: number;
  /** Wall-span (minutes) of the newest contiguous segment. */
  segmentSpanMinutes: number;
}

/** Minimum contiguous samples required before any firing. */
const MIN_SEGMENT_SAMPLES = 6;
/** Absolute growth floor (MB) — magnitude OR-path with the rate path. */
const GROWTH_FLOOR_MB = 45;
/** Endpoint-rate floor (MB/hr) — magnitude OR-path with the growth path. */
const RATE_FLOOR_MB_PER_HOUR = 30;
/** Inter-sample gaps beyond this multiple of nominal interval break a segment. */
const SEGMENT_GAP_MULTIPLE = 2;
/** Re-fire throttle window (ms): suppress repeat WARNs within this period. */
export const LEAK_WARN_THROTTLE_MS = 30 * 60 * 1000;
/** Heap-drop (MB) below the last-fired level that RESETS the throttle. */
export const LEAK_WARN_THROTTLE_RESET_DROP_MB = 20;

/**
 * Least-squares slope of heapUsedMB vs. time, normalised to MB/hour.
 * Returns 0 for <2 points or zero time variance (degenerate / single instant).
 */
function leastSquaresSlopeMBPerHour(samples: HeapSample[]): number {
  const n = samples.length;
  if (n < 2) return 0;
  // Use hours as the x-unit so the slope is directly MB/hr.
  const xs = samples.map((s) => s.timestamp / 3_600_000);
  const ys = samples.map((s) => s.heapUsedMB);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    num += dx * (ys[i] - meanY);
    den += dx * dx;
  }
  if (den === 0) return 0;
  return num / den;
}

/**
 * Walk from the newest sample backwards, breaking the segment where an
 * inter-sample gap exceeds `SEGMENT_GAP_MULTIPLE × nominalIntervalMs`
 * (sleep/background-throttle). Returns the newest contiguous segment in
 * chronological order.
 */
function newestContiguousSegment(samples: HeapSample[], nominalIntervalMs: number): HeapSample[] {
  if (samples.length === 0) return [];
  const gapThresholdMs = SEGMENT_GAP_MULTIPLE * nominalIntervalMs;
  // Start from the newest; extend backwards while gaps stay within threshold.
  let startIdx = samples.length - 1;
  for (let i = samples.length - 1; i > 0; i--) {
    const gap = samples[i].timestamp - samples[i - 1].timestamp;
    if (gap > gapThresholdMs) {
      startIdx = i;
      break;
    }
    startIdx = i - 1;
  }
  return samples.slice(startIdx);
}

/**
 * Detect a sustained renderer heap leak. See file header for intent.
 *
 * Criterion (all must hold to fire, throttle aside):
 *   1. Newest contiguous segment has ≥ MIN_SEGMENT_SAMPLES samples.
 *   2. Shape: positive least-squares slope over the LATTER HALF of the segment
 *      (GC-robust — tolerates a single V8 GC dip that "N consecutive increases"
 *      would reject; rejects step-then-plateau whose latter half is ~flat).
 *   3. Magnitude: segment endpoint rate > RATE_FLOOR_MB_PER_HOUR OR
 *      growthMB >= GROWTH_FLOOR_MB.
 * The throttle (≤1 fire / LEAK_WARN_THROTTLE_MS, reset when heap drops
 * ≥ LEAK_WARN_THROTTLE_RESET_DROP_MB below the last-fired level) is applied
 * here so the caller only has to advance the throttle state on a real fire.
 */
export function detectSustainedHeapGrowth(
  input: DetectSustainedHeapGrowthInput,
): DetectSustainedHeapGrowthResult {
  const { samples, nominalIntervalMs, lastFiredHeapMB, lastFiredAtMs, now } = input;

  const segment = newestContiguousSegment(samples, nominalIntervalMs);
  const segmentSampleCount = segment.length;

  const empty: DetectSustainedHeapGrowthResult = {
    shouldWarn: false,
    growthMB: 0,
    ratePerHour: 0,
    slopeMBPerHr: 0,
    segmentSampleCount,
    segmentSpanMinutes: 0,
  };

  if (segmentSampleCount < MIN_SEGMENT_SAMPLES) {
    return empty;
  }

  const oldest = segment[0];
  const newest = segment[segment.length - 1];
  const growthMB = newest.heapUsedMB - oldest.heapUsedMB;
  const segmentSpanMinutes = (newest.timestamp - oldest.timestamp) / 60000;
  const ratePerHour = segmentSpanMinutes > 0 ? (growthMB / segmentSpanMinutes) * 60 : 0;

  // Latter half of the segment, widened to AT LEAST the newest 4 samples.
  // On a minimal 6–7-sample segment a plain floor(n/2) leaves only the newest
  // 2–3 points, so a single trailing V8 GC dip on the newest sample can flip
  // the slope negative and wrongly suppress one tick of a genuine leak (Phase-5
  // false-negative: [100,121,142,163,184,160] = 144 MB/hr but newest-3 slopes
  // down). Requiring ≥4 points makes a lone trailing dip non-decisive; min
  // segment is 6 so ≥4 are always available, and for n≥8 this is exactly
  // floor(n/2) (larger segments are naturally dip-robust).
  const latterHalfStart = Math.max(0, Math.min(segmentSampleCount - 4, Math.floor(segmentSampleCount / 2)));
  const latterHalf = segment.slice(latterHalfStart);
  const slopeMBPerHr = leastSquaresSlopeMBPerHour(latterHalf);

  const result: DetectSustainedHeapGrowthResult = {
    shouldWarn: false,
    growthMB,
    ratePerHour,
    slopeMBPerHr,
    segmentSampleCount,
    segmentSpanMinutes,
  };

  // Shape gate: sustained recent growth (rejects step-then-plateau).
  const shapeOk = slopeMBPerHr > 0;
  // Magnitude gate: rate path OR absolute-growth floor (no strict >50 blind spot).
  const magnitudeOk = ratePerHour > RATE_FLOOR_MB_PER_HOUR || growthMB >= GROWTH_FLOOR_MB;

  if (!shapeOk || !magnitudeOk) {
    return result;
  }

  // Throttle: suppress repeat WARNs within the window, EXCEPT when the heap has
  // dropped materially below the last-fired level (a distinct new leak after a
  // GC / session-end should not be hidden).
  if (lastFiredAtMs !== null && now - lastFiredAtMs < LEAK_WARN_THROTTLE_MS) {
    const heapDroppedEnough =
      lastFiredHeapMB !== null &&
      newest.heapUsedMB <= lastFiredHeapMB - LEAK_WARN_THROTTLE_RESET_DROP_MB;
    if (!heapDroppedEnough) {
      return result; // throttle-suppressed
    }
  }

  result.shouldWarn = true;
  return result;
}
