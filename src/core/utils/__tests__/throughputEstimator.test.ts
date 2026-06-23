import { describe, it, expect } from 'vitest';
import {
  ThroughputEstimator,
  type ThroughputClock,
} from '../throughputEstimator';

/**
 * Tests for ThroughputEstimator.
 *
 * Uses an injected clock so timing is deterministic and there are no real
 * setTimeouts to wait on in CI (per Testability specialist's guidance in the
 * planning doc).
 */

class FakeClock implements ThroughputClock {
  private ms = 0;
  now(): number {
    return this.ms;
  }
  advance(delta: number): void {
    this.ms += delta;
  }
  set(to: number): void {
    this.ms = to;
  }
}

describe('ThroughputEstimator', () => {
  describe('cold start', () => {
    it('returns hasEnoughSamples=false with zero samples', () => {
      const clock = new FakeClock();
      const est = new ThroughputEstimator({ clock });
      const snap = est.snapshot();
      expect(snap.hasEnoughSamples).toBe(false);
      expect(snap.bytesPerSecond).toBe(0);
      expect(snap.etaSeconds).toBe(Infinity);
    });

    it('returns hasEnoughSamples=false with one sample', () => {
      const clock = new FakeClock();
      const est = new ThroughputEstimator({ clock });
      est.addSample(1000);
      expect(est.snapshot().hasEnoughSamples).toBe(false);
    });

    it('returns hasEnoughSamples=false before minSpanMs has elapsed', () => {
      const clock = new FakeClock();
      const est = new ThroughputEstimator({ clock, minSpanMs: 500 });
      est.addSample(0);
      clock.advance(100);
      est.addSample(1_000_000);
      expect(est.snapshot().hasEnoughSamples).toBe(false);
    });

    it('publishes estimate once minSpanMs is satisfied', () => {
      const clock = new FakeClock();
      const est = new ThroughputEstimator({ clock, minSpanMs: 500 });
      est.addSample(0);
      clock.advance(1000);
      est.addSample(500_000);
      const snap = est.snapshot();
      expect(snap.hasEnoughSamples).toBe(true);
      // 500 KB in 1000 ms → 500 KB/s
      expect(snap.bytesPerSecond).toBeCloseTo(500_000, 0);
    });
  });

  describe('steady state', () => {
    it('computes bytesPerSecond for a linear stream', () => {
      const clock = new FakeClock();
      const est = new ThroughputEstimator({ clock });
      // 1 MB / sec for 5 seconds
      for (let i = 0; i <= 5; i++) {
        est.addSample(i * 1_000_000);
        if (i < 5) clock.advance(1000);
      }
      const snap = est.snapshot();
      expect(snap.hasEnoughSamples).toBe(true);
      expect(snap.bytesPerSecond).toBeCloseTo(1_000_000, 0);
    });

    it('calculates ETA against bytesRemaining', () => {
      const clock = new FakeClock();
      const est = new ThroughputEstimator({ clock });
      est.addSample(0);
      clock.advance(1000);
      est.addSample(1_000_000); // 1 MB/s
      // 9 MB remaining → 9 s ETA
      const snap = est.snapshot(9_000_000);
      expect(snap.etaSeconds).toBeCloseTo(9, 2);
    });
  });

  describe('variable throughput', () => {
    it('reacts when rate changes — old samples evicted', () => {
      const clock = new FakeClock();
      const est = new ThroughputEstimator({ clock, windowMs: 5_000 });
      // Phase A: 100 KB/s for 3 seconds (3 samples spanning 3s)
      est.addSample(0);
      clock.advance(1000);
      est.addSample(100_000);
      clock.advance(1000);
      est.addSample(200_000);
      clock.advance(1000);
      est.addSample(300_000);

      let snap = est.snapshot();
      expect(snap.bytesPerSecond).toBeCloseTo(100_000, 0);

      // Phase B: speed up to 1 MB/s. Push through enough time (>windowMs)
      // to evict all phase-A samples so only phase-B samples remain.
      for (let i = 1; i <= 8; i++) {
        clock.advance(1000);
        est.addSample(300_000 + i * 1_000_000);
      }

      snap = est.snapshot();
      // Window now holds only phase-B samples → 1 MB/s
      expect(snap.bytesPerSecond).toBeCloseTo(1_000_000, 0);
    });
  });

  describe('stall detection', () => {
    it('drops to zero when cumulative bytes stop advancing', () => {
      const clock = new FakeClock();
      const est = new ThroughputEstimator({ clock, windowMs: 3000 });
      // Send 3s of progress
      est.addSample(0);
      clock.advance(1000);
      est.addSample(100_000);
      clock.advance(1000);
      est.addSample(200_000);

      // Now stall: keep emitting the same byte count
      clock.advance(1000);
      est.addSample(200_000);
      clock.advance(1000);
      est.addSample(200_000);
      clock.advance(1000);
      est.addSample(200_000);

      // After the window, deltaBytes == 0 → "no useful estimate yet"
      const snap = est.snapshot();
      expect(snap.bytesPerSecond).toBe(0);
      expect(snap.hasEnoughSamples).toBe(false);
    });
  });

  describe('input hardening', () => {
    it('ignores NaN and negative byte counts', () => {
      const clock = new FakeClock();
      const est = new ThroughputEstimator({ clock });
      est.addSample(Number.NaN);
      est.addSample(-5);
      expect(est.sampleCount).toBe(0);
    });

    it('ignores backwards-in-time samples', () => {
      const clock = new FakeClock();
      const est = new ThroughputEstimator({ clock });
      est.addSample(0, 1000);
      est.addSample(100, 500); // older than the last one
      expect(est.sampleCount).toBe(1);
    });

    it('handles bytesRemaining === Infinity', () => {
      const clock = new FakeClock();
      const est = new ThroughputEstimator({ clock });
      est.addSample(0);
      clock.advance(1000);
      est.addSample(1_000_000);
      const snap = est.snapshot(Number.POSITIVE_INFINITY);
      expect(snap.etaSeconds).toBe(Infinity);
    });

    it('returns etaSeconds=0 when bytesRemaining is 0', () => {
      const clock = new FakeClock();
      const est = new ThroughputEstimator({ clock });
      est.addSample(0);
      clock.advance(1000);
      est.addSample(1_000_000);
      const snap = est.snapshot(0);
      expect(snap.etaSeconds).toBe(0);
    });

    it('reset() clears samples', () => {
      const clock = new FakeClock();
      const est = new ThroughputEstimator({ clock });
      est.addSample(0);
      clock.advance(1000);
      est.addSample(500_000);
      expect(est.sampleCount).toBe(2);
      est.reset();
      expect(est.sampleCount).toBe(0);
      expect(est.snapshot().hasEnoughSamples).toBe(false);
    });
  });

  describe('window eviction', () => {
    it('keeps the window bounded', () => {
      const clock = new FakeClock();
      const est = new ThroughputEstimator({ clock, windowMs: 2000 });
      for (let i = 0; i < 20; i++) {
        est.addSample(i * 100);
        clock.advance(200);
      }
      // 20 samples × 200ms = 4000ms elapsed; windowMs=2000 → roughly half evicted.
      expect(est.sampleCount).toBeLessThan(20);
      expect(est.sampleCount).toBeGreaterThan(0);
    });
  });

  describe('clock injection', () => {
    it('uses the injected clock consistently (no wall-clock leakage)', () => {
      const clock = new FakeClock();
      const est = new ThroughputEstimator({ clock });
      clock.set(1_000_000); // arbitrary far-from-now value
      est.addSample(0);
      clock.advance(2000);
      est.addSample(200_000);
      const snap = est.snapshot(800_000);
      expect(snap.hasEnoughSamples).toBe(true);
      expect(snap.bytesPerSecond).toBeCloseTo(100_000, 0);
      expect(snap.etaSeconds).toBeCloseTo(8, 2);
    });
  });
});
