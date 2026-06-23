import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VOLUME_SIZE_GB,
  FLY_BILLING_WALL_GB,
  recommendVolumeGb,
} from '../volumeDefaults';

const GB = 1024 ** 3;

/**
 * Spec-level invariants for the shared volume-size defaults. These checks
 * encode product rules that cannot be violated without regressing the
 * Fly.io billing-wall UX fixed by commit `6146c509d`.
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 2, Review-Driven Amendments — DEFAULT_VOLUME_SIZE_GB = 15 < 20)
 */
describe('volumeDefaults', () => {
  it('DEFAULT_VOLUME_SIZE_GB sits below Fly.io\'s 20 GB billing wall', () => {
    expect(DEFAULT_VOLUME_SIZE_GB).toBeLessThan(20);
  });

  it('DEFAULT_VOLUME_SIZE_GB is below FLY_BILLING_WALL_GB by construction', () => {
    expect(DEFAULT_VOLUME_SIZE_GB).toBeLessThan(FLY_BILLING_WALL_GB);
  });

  it('DEFAULT_VOLUME_SIZE_GB is a sensible minimum (>= 10 GB)', () => {
    // The IPC Zod schema clamps `volumeSizeGb` to [10, 500]; anything
    // below 10 would be rejected before reaching the provider anyway.
    expect(DEFAULT_VOLUME_SIZE_GB).toBeGreaterThanOrEqual(10);
  });

  it('FLY_BILLING_WALL_GB matches Fly.io\'s published 20 GB threshold', () => {
    expect(FLY_BILLING_WALL_GB).toBe(20);
  });
});

/**
 * Recommendation math: `max(10, ceil(3× bytes_in_GB / 5) × 5)`, clamped
 * to [10, 500]. Zero or non-positive input falls back to the no-data
 * default (15 GB, below Fly's billing wall).
 *
 * See planning doc Stage 3 — Recommendation math.
 */
describe('recommendVolumeGb', () => {
  it('returns DEFAULT_VOLUME_SIZE_GB for zero bytes (no-data fallback)', () => {
    expect(recommendVolumeGb(0)).toBe(DEFAULT_VOLUME_SIZE_GB);
    expect(recommendVolumeGb(0)).toBe(15);
  });

  it('returns DEFAULT_VOLUME_SIZE_GB for negative input (defensive)', () => {
    expect(recommendVolumeGb(-1)).toBe(DEFAULT_VOLUME_SIZE_GB);
    expect(recommendVolumeGb(-1 * GB)).toBe(DEFAULT_VOLUME_SIZE_GB);
  });

  it('returns DEFAULT_VOLUME_SIZE_GB for NaN / Infinity (defensive)', () => {
    expect(recommendVolumeGb(Number.NaN)).toBe(DEFAULT_VOLUME_SIZE_GB);
    expect(recommendVolumeGb(Number.POSITIVE_INFINITY)).toBe(DEFAULT_VOLUME_SIZE_GB);
  });

  it('4 GB workspace → recommends 15 GB (from planning doc example)', () => {
    // 4 GB * 3 = 12; ceil(12 / 5) * 5 = 15
    expect(recommendVolumeGb(4 * GB)).toBe(15);
  });

  it('40 GB workspace → recommends 120 GB (from planning doc example)', () => {
    // 40 GB * 3 = 120; ceil(120 / 5) * 5 = 120
    expect(recommendVolumeGb(40 * GB)).toBe(120);
  });

  it('enforces the 10 GB floor for very small footprints', () => {
    // 1 GB * 3 = 3; ceil(3/5)*5 = 5 → clamped up to 10
    expect(recommendVolumeGb(1 * GB)).toBe(10);
    // 0.5 GB * 3 = 1.5; ceil(1.5/5)*5 = 5 → clamped up to 10
    expect(recommendVolumeGb(0.5 * GB)).toBe(10);
  });

  it('clamps to the 500 GB max (IPC schema upper bound)', () => {
    // 1 TB = 1024 GB * 3 = 3072; ceil(3072/5)*5 = 3075 → clamped to 500
    expect(recommendVolumeGb(1024 * GB)).toBe(500);
    expect(recommendVolumeGb(1e15)).toBe(500);
  });

  it('always returns a multiple of 5 GB (industry convention)', () => {
    for (let gb = 0.1; gb < 200; gb += 1.3) {
      const result = recommendVolumeGb(gb * GB);
      expect(result % 5).toBe(0);
    }
  });

  it('result is always within the IPC schema range [10, 500]', () => {
    for (const bytes of [0, 1, 1 * GB, 50 * GB, 500 * GB, 10_000 * GB]) {
      const result = recommendVolumeGb(bytes);
      expect(result).toBeGreaterThanOrEqual(10);
      expect(result).toBeLessThanOrEqual(500);
    }
  });

  it('monotonic: for positive inputs, more bytes never recommends a smaller volume', () => {
    // Note: zero/non-positive input returns DEFAULT_VOLUME_SIZE_GB (15), which
    // is intentionally higher than the 10 GB floor applied to tiny positive
    // footprints. The monotonic property applies within the positive range.
    let prev = 0;
    for (const gb of [0.1, 0.5, 2, 4, 7, 10, 15, 25, 50, 100, 170]) {
      const result = recommendVolumeGb(gb * GB);
      expect(result).toBeGreaterThanOrEqual(prev);
      prev = result;
    }
  });
});
