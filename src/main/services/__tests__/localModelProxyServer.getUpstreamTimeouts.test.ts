import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetUpstreamTimeoutsScaleForTesting,
  _setUpstreamTimeoutsScaleForTesting,
  getUpstreamTimeouts,
} from '../localModelProxyServer';

describe('getUpstreamTimeouts', () => {
  afterEach(() => {
    _resetUpstreamTimeoutsScaleForTesting();
  });

  it.each([
    [undefined, { firstByteMs: 30_000, firstChunkMs: 45_000, streamChunkMs: 90_000 }],
    ['low' as const, { firstByteMs: 45_000, firstChunkMs: 60_000, streamChunkMs: 90_000 }],
    ['medium' as const, { firstByteMs: 90_000, firstChunkMs: 120_000, streamChunkMs: 90_000 }],
    ['high' as const, { firstByteMs: 150_000, firstChunkMs: 200_000, streamChunkMs: 90_000 }],
    ['xhigh' as const, { firstByteMs: 240_000, firstChunkMs: 300_000, streamChunkMs: 90_000 }],
  ])('returns production timeouts for reasoning effort %s', (reasoningEffort, expected) => {
    expect(getUpstreamTimeouts(reasoningEffort)).toEqual(expected);
  });

  it('scales all three values uniformly when scale override is set', () => {
    _setUpstreamTimeoutsScaleForTesting(0.5);
    try {
      expect(getUpstreamTimeouts(undefined)).toEqual({
        firstByteMs: 15_000, firstChunkMs: 22_500, streamChunkMs: 45_000,
      });
    } finally {
      _resetUpstreamTimeoutsScaleForTesting();
    }
    // After reset, production values returned.
    expect(getUpstreamTimeouts(undefined)).toEqual({
      firstByteMs: 30_000, firstChunkMs: 45_000, streamChunkMs: 90_000,
    });
  });

  it('isLocal doubles firstByte/firstChunk but NOT streamChunkMs', () => {
    // Production: streamChunkMs is independent of isLocal per FOX-2656 design.
    expect(getUpstreamTimeouts(undefined, { isLocal: true })).toEqual({
      firstByteMs: 60_000, firstChunkMs: 90_000, streamChunkMs: 90_000,
    });
  });

  it('isLocal × scale composition preserves the asymmetry', () => {
    _setUpstreamTimeoutsScaleForTesting(0.5);
    try {
      // firstByte: 30_000 * 2 (isLocal) * 0.5 (scale) = 30_000
      // firstChunk: 45_000 * 2 (isLocal) * 0.5 (scale) = 45_000
      // streamChunkMs: 90_000 * 0.5 (scale) — NOT touched by isLocal = 45_000
      expect(getUpstreamTimeouts(undefined, { isLocal: true })).toEqual({
        firstByteMs: 30_000, firstChunkMs: 45_000, streamChunkMs: 45_000,
      });
    } finally {
      _resetUpstreamTimeoutsScaleForTesting();
    }
  });

  it('rejects non-finite or non-positive scale values', () => {
    expect(() => _setUpstreamTimeoutsScaleForTesting(0)).toThrow();
    expect(() => _setUpstreamTimeoutsScaleForTesting(-1)).toThrow();
    expect(() => _setUpstreamTimeoutsScaleForTesting(NaN)).toThrow();
    expect(() => _setUpstreamTimeoutsScaleForTesting(Infinity)).toThrow();
  });
});
