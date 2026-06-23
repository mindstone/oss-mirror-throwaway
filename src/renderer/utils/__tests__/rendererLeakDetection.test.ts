import { describe, it, expect } from 'vitest';

import {
  detectSustainedHeapGrowth,
  type HeapSample,
} from '../rendererLeakDetection';

const NOMINAL_INTERVAL_MS = 5 * 60 * 1000; // 5 min — matches App.tsx prod cadence.
const BASE_TS = 1_700_000_000_000;

/** Build a contiguous series of heap values at the nominal interval. */
function series(heaps: number[], opts?: { startTs?: number; intervalMs?: number }): HeapSample[] {
  const startTs = opts?.startTs ?? BASE_TS;
  const intervalMs = opts?.intervalMs ?? NOMINAL_INTERVAL_MS;
  return heaps.map((heapUsedMB, i) => ({ heapUsedMB, timestamp: startTs + i * intervalMs }));
}

/**
 * The OLD endpoint-only predicate (inlined here so we can PROVE the new logic
 * fixes a real regression on the step-then-plateau fixture). Mirrors the
 * pre-fix App.tsx block: growthMB > 50 && rate > 30 over window endpoints.
 */
function oldEndpointPredicate(samples: HeapSample[]): boolean {
  if (samples.length < 6) return false;
  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  const growthMB = newest.heapUsedMB - oldest.heapUsedMB;
  const timeSpanMinutes = (newest.timestamp - oldest.timestamp) / 60000;
  const rate = timeSpanMinutes > 0 ? (growthMB / timeSpanMinutes) * 60 : 0;
  return growthMB > 50 && rate > 30;
}

const NO_THROTTLE = { lastFiredHeapMB: null, lastFiredAtMs: null } as const;

function detect(samples: HeapSample[], throttle = NO_THROTTLE, now?: number) {
  return detectSustainedHeapGrowth({
    samples,
    nominalIntervalMs: NOMINAL_INTERVAL_MS,
    lastFiredHeapMB: throttle.lastFiredHeapMB,
    lastFiredAtMs: throttle.lastFiredAtMs,
    now: now ?? samples[samples.length - 1].timestamp,
  });
}

describe('detectSustainedHeapGrowth', () => {
  it('(a) step-then-plateau does NOT fire, but the OLD predicate DID (proves the fix)', () => {
    // One step-up 159→228 then flat — the dominant v0.4.47 false-positive shape.
    const samples = series([159, 228, 228, 228, 228, 228, 228, 228, 228, 228, 228, 228]);

    expect(oldEndpointPredicate(samples)).toBe(true); // regression was real
    const verdict = detect(samples);
    expect(verdict.shouldWarn).toBe(false); // latter half is flat → slope ≈ 0
    expect(verdict.slopeMBPerHr).toBeLessThanOrEqual(0.0001);
  });

  it('(b) sawtooth-with-GC-dips genuine leak fires (GC robustness)', () => {
    // Net rising with dips — the key true positive a consecutive-increase
    // check would miss.
    const samples = series([200, 210, 205, 220, 228, 238, 233, 250, 260, 255, 272, 285]);
    const verdict = detect(samples);
    expect(verdict.shouldWarn).toBe(true);
    expect(verdict.slopeMBPerHr).toBeGreaterThan(0);
  });

  it('(c) GPT short-window slow leak 200..244 (+4/sample, 48MB/52MB·hr) fires (floor blind spot fixed)', () => {
    const samples = series([200, 204, 208, 212, 216, 220, 224, 228, 232, 236, 240, 244]);
    expect(samples[samples.length - 1].heapUsedMB - samples[0].heapUsedMB).toBe(44); // <45 absolute, but...
    const verdict = detect(samples);
    // ...the rate path fires: 44MB over 55min = 48MB/hr > 30.
    expect(verdict.ratePerHour).toBeGreaterThan(30);
    expect(verdict.shouldWarn).toBe(true);
    // Confirm the OLD strict >50 floor would have MISSED this (growth 44 < 50... and even at 48):
    expect(oldEndpointPredicate(samples)).toBe(false);
  });

  it('(c2) exact GPT worst-case 48MB growth still fires via rate path', () => {
    // 200..248 step +4 except last +8 → 48MB total. Old floor (>50) misses; rate fires.
    const samples = series([200, 204, 208, 212, 216, 220, 224, 228, 232, 236, 240, 248]);
    expect(samples[11].heapUsedMB - samples[0].heapUsedMB).toBe(48);
    expect(oldEndpointPredicate(samples)).toBe(false); // 48 !> 50
    expect(detect(samples).shouldWarn).toBe(true);
  });

  it('(d) throttle: a second qualifying tick within 30min is suppressed', () => {
    const samples = series([200, 210, 205, 220, 228, 238, 233, 250, 260, 255, 272, 285]);
    const firstNow = samples[samples.length - 1].timestamp;
    const first = detect(samples, NO_THROTTLE, firstNow);
    expect(first.shouldWarn).toBe(true);

    // Second tick 5 min later, heap still climbing, throttle active.
    const secondNow = firstNow + NOMINAL_INTERVAL_MS;
    const verdict = detectSustainedHeapGrowth({
      samples,
      nominalIntervalMs: NOMINAL_INTERVAL_MS,
      lastFiredHeapMB: 285,
      lastFiredAtMs: firstNow,
      now: secondNow,
    });
    expect(verdict.shouldWarn).toBe(false); // suppressed by throttle
  });

  it('(e) throttle RESETS when heap drops ≥20MB below last-fired then climbs', () => {
    // New rising segment whose newest heap is ≥20MB below the last fired level.
    const samples = series([200, 210, 205, 220, 228, 238]); // newest 238
    const verdict = detectSustainedHeapGrowth({
      samples,
      nominalIntervalMs: NOMINAL_INTERVAL_MS,
      lastFiredHeapMB: 285, // 238 <= 285 - 20 → reset
      lastFiredAtMs: samples[samples.length - 1].timestamp - NOMINAL_INTERVAL_MS,
      now: samples[samples.length - 1].timestamp,
    });
    expect(verdict.shouldWarn).toBe(true);
  });

  it('(e2) throttle does NOT reset when heap has only dropped slightly', () => {
    const samples = series([200, 210, 205, 220, 228, 270]); // newest 270, only 15 below 285
    const verdict = detectSustainedHeapGrowth({
      samples,
      nominalIntervalMs: NOMINAL_INTERVAL_MS,
      lastFiredHeapMB: 285, // 270 > 285 - 20 → still throttled
      lastFiredAtMs: samples[samples.length - 1].timestamp - NOMINAL_INTERVAL_MS,
      now: samples[samples.length - 1].timestamp,
    });
    expect(verdict.shouldWarn).toBe(false);
  });

  it('(f) sleep-gap: only the newest contiguous segment is used for math', () => {
    // 6 OLD high samples, then a >2x-interval gap, then 6 NEW lower flat samples.
    const oldHigh = series([400, 500, 600, 700, 800, 900]);
    const gapStart = oldHigh[oldHigh.length - 1].timestamp + 30 * 60 * 1000; // 30min gap (>2x interval)
    const newFlat = series([150, 150, 150, 150, 150, 150], { startTs: gapStart });
    const samples = [...oldHigh, ...newFlat];

    const verdict = detect(samples);
    expect(verdict.segmentSampleCount).toBe(6); // only the post-gap segment
    expect(verdict.growthMB).toBe(0); // newest segment is flat
    expect(verdict.shouldWarn).toBe(false);
  });

  it('(f2) sleep-gap does not fabricate a rate spike from the cross-gap pair', () => {
    // Low pre-sleep, big post-sleep jump across the gap, then flat — must NOT fire
    // (cross-gap pair discarded; newest segment is flat).
    const pre = series([100, 100, 100, 100, 100, 100]);
    const gapStart = pre[pre.length - 1].timestamp + 60 * 60 * 1000; // 1h sleep
    const post = series([300, 300, 300, 300, 300, 300], { startTs: gapStart });
    const verdict = detect([...pre, ...post]);
    expect(verdict.segmentSampleCount).toBe(6);
    expect(verdict.shouldWarn).toBe(false);
  });

  it('(g) fewer than 6 contiguous samples never fires', () => {
    const samples = series([200, 250, 300, 350, 400]); // steep, but only 5 samples
    const verdict = detect(samples);
    expect(verdict.segmentSampleCount).toBe(5);
    expect(verdict.shouldWarn).toBe(false);
  });

  it('strictly-monotonic steep leak fires (basic true positive)', () => {
    const samples = series([100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300, 320]);
    const verdict = detect(samples);
    expect(verdict.shouldWarn).toBe(true);
    expect(verdict.growthMB).toBe(220);
  });

  it('declining heap (post-GC recovery) does not fire even with large window', () => {
    const samples = series([300, 280, 260, 240, 220, 200]);
    expect(detect(samples).shouldWarn).toBe(false);
  });

  it('PHASE-5 PIN: minimal-segment genuine leak with a single trailing GC dip still fires', () => {
    // [100,121,142,163,184,160]: 60MB / 144MB·hr endpoint rate, but the newest
    // sample is a GC dip. With floor(n/2) the latter half [163,184,160] slopes
    // DOWN (−1.5) and would wrongly suppress; widening to the newest 4
    // [142,163,184,160] gives a positive slope so the leak still fires.
    const samples = series([100, 121, 142, 163, 184, 160]);
    const verdict = detect(samples);
    expect(verdict.segmentSampleCount).toBe(6);
    expect(verdict.slopeMBPerHr).toBeGreaterThan(0);
    expect(verdict.shouldWarn).toBe(true);
  });

  it('widening only affects small segments: an n=12 plateau still does NOT fire', () => {
    // For n≥8 the latter-half start is floor(n/2) (newest 6) — unchanged by the
    // ≥4 widening. A 12-sample step-then-plateau stays a non-fire.
    const samples = series([159, 326, 326, 326, 326, 326, 326, 326, 326, 326, 326, 326]);
    expect(samples.length).toBe(12);
    const verdict = detect(samples);
    expect(verdict.shouldWarn).toBe(false);
    expect(verdict.slopeMBPerHr).toBeLessThanOrEqual(0.0001);
  });
});
