import { describe, expect, it } from 'vitest';
import type { AssetResolutionReason } from '../agent';
import {
  isKnownAssetResolutionReason,
  summarizeAssetResolutionReason,
} from '../agent';

describe('AssetResolutionReason helpers', () => {
  it('isKnownAssetResolutionReason returns true for known values', () => {
    expect(isKnownAssetResolutionReason('not-found')).toBe(true);
  });

  it('isKnownAssetResolutionReason returns false for future values while open union accepts them', () => {
    const futureReason: AssetResolutionReason = 'future-reason';
    expect(isKnownAssetResolutionReason(futureReason)).toBe(false);
  });

  it('summarizeAssetResolutionReason marks known values', () => {
    expect(summarizeAssetResolutionReason('not-found')).toEqual({ known: true });
  });

  it('summarizeAssetResolutionReason marks unknown values with fallback', () => {
    expect(summarizeAssetResolutionReason('unknown-fallback')).toEqual({
      known: false,
      fallback: 'unknown-fallback',
    });
  });
});
