import { describe, expect, it } from 'vitest';
import { validateContiguousChunkRange } from '../validateContiguousChunkRange';

describe('validateContiguousChunkRange', () => {
  it('accepts contiguous chunks', () => {
    expect(validateContiguousChunkRange({ chunks: [{ index: 0 }, { index: 1 }] }, 2)).toEqual({ isValid: true, missing: [], extras: [] });
  });

  it('reports missing chunks', () => {
    expect(validateContiguousChunkRange({ chunks: [{ index: 0 }, { index: 2 }] }, 3)).toMatchObject({ isValid: false, missing: [1] });
  });

  it('reports extra chunks sorted', () => {
    expect(validateContiguousChunkRange({ chunks: [{ index: 3 }, { index: 0 }, { index: 2 }] }, 2)).toEqual({ isValid: false, missing: [1], extras: [2, 3] });
  });
});
