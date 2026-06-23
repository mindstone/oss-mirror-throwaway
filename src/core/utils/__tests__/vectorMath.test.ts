import { describe, expect, it } from 'vitest';
import {
  computeAveragedNormalizedVector,
  cosineDistance,
  getInvalidVectorReason,
  l2Normalize,
} from '@core/utils/vectorMath';

function makeTypicalVector(length: number, offset: number = 1): number[] {
  return Array.from({ length }, (_, index) => (index + offset) / length);
}

function vectorNorm(vector: ReadonlyArray<number>): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('cosineDistance', () => {
  it('returns 0 for identical vectors', () => {
    expect(cosineDistance([1, 2, 3], [1, 2, 3])).toBeCloseTo(0, 10);
  });

  it('returns 1 for orthogonal vectors', () => {
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 10);
  });

  it('returns 2 for opposite vectors', () => {
    expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(2, 10);
  });

  it('returns 1 when either vector is all zeros', () => {
    expect(cosineDistance([0, 0], [3, 4])).toBe(1);
    expect(cosineDistance([0, 0], [0, 0])).toBe(1);
  });

  it('handles single-element vectors', () => {
    expect(cosineDistance([5], [5])).toBeCloseTo(0, 10);
    expect(cosineDistance([5], [-5])).toBeCloseTo(2, 10);
  });

  it('remains stable for very large finite values', () => {
    expect(cosineDistance([1e308, 1e308], [1e308, 1e308])).toBeCloseTo(0, 10);
  });

  it('remains stable for very small finite values', () => {
    expect(cosineDistance([1e-308, 0], [0, 1e-308])).toBeCloseTo(1, 10);
  });

  it('supports Float32Array inputs', () => {
    expect(cosineDistance(new Float32Array([3, 4]), new Float32Array([3, 4]))).toBeCloseTo(0, 10);
  });

  it('supports Arrow-like iterable vectors without bracket indexing', () => {
    const values = [1, 2, 3];
    const arrowLikeVector = {
      length: values.length,
      [Symbol.iterator]: function* () {
        yield* values;
      },
      get: (index: number) => values[index],
    } as unknown as number[];

    expect(arrowLikeVector[0]).toBeUndefined();
    expect(cosineDistance([1, 2, 3], arrowLikeVector)).toBeCloseTo(0, 10);
  });

  it('throws for vectors with different lengths', () => {
    expect(() => cosineDistance([1, 2], [1, 2, 3])).toThrow(/equal length/i);
  });

  it('returns NaN for NaN values instead of throwing', () => {
    expect(cosineDistance([1, Number.NaN], [1, 2])).toBeNaN();
    expect(cosineDistance([1, 2], [Number.NaN, 3])).toBeNaN();
  });

  it('returns NaN for Infinity values instead of throwing', () => {
    expect(cosineDistance([1, Number.POSITIVE_INFINITY], [1, 2])).toBeNaN();
    expect(cosineDistance([1, 2], [1, Number.NEGATIVE_INFINITY])).toBeNaN();
  });
});

describe('l2Normalize', () => {
  it('normalizes a typical 384-dim vector to unit magnitude', () => {
    const result = l2Normalize(makeTypicalVector(384));

    expect(result).not.toBeNull();
    expect(result).toHaveLength(384);
    expect(vectorNorm(result ?? [])).toBeCloseTo(1, 10);
  });

  it('keeps an already-normalized vector at unit magnitude and returns a fresh array', () => {
    const normalized = l2Normalize(makeTypicalVector(384));
    expect(normalized).not.toBeNull();

    const result = l2Normalize(normalized ?? []);

    expect(result).not.toBeNull();
    expect(result).not.toBe(normalized);
    expect(vectorNorm(result ?? [])).toBeCloseTo(1, 10);
  });

  it('returns null for empty input', () => {
    expect(l2Normalize([])).toBeNull();
  });

  it('returns null for non-finite input', () => {
    expect(l2Normalize([1, Number.NaN, 2])).toBeNull();
    expect(l2Normalize([1, Number.POSITIVE_INFINITY, 2])).toBeNull();
  });

  it('returns null for a zero vector', () => {
    expect(l2Normalize([0, 0, 0])).toBeNull();
  });
});

describe('computeAveragedNormalizedVector', () => {
  it('averages three typical 384-dim vectors and returns a unit vector', () => {
    const { vector, validCount, skippedCount } = computeAveragedNormalizedVector([
      makeTypicalVector(384, 1),
      makeTypicalVector(384, 2),
      makeTypicalVector(384, 3),
    ]);

    expect(vector).not.toBeNull();
    expect(vector).toHaveLength(384);
    expect(vectorNorm(vector ?? [])).toBeCloseTo(1, 10);
    expect(validCount).toBe(3);
    expect(skippedCount).toBe(0);
  });

  it('normalizes a single-vector input equivalently to l2Normalize', () => {
    const source = makeTypicalVector(384);
    const { vector: averaged } = computeAveragedNormalizedVector([source]);
    const normalized = l2Normalize(source);

    if (!averaged || !normalized) {
      throw new Error('Expected typical vector normalization to succeed');
    }

    expect(averaged).toHaveLength(normalized.length);
    averaged.forEach((value, index) => {
      expect(value).toBeCloseTo(normalized[index], 10);
    });
  });

  it('returns null for empty input', () => {
    expect(computeAveragedNormalizedVector([]).vector).toBeNull();
  });

  it('skips non-finite vectors and averages only the valid ones (one NaN no longer nukes the file)', () => {
    // A single NaN chunk among valid chunks must NOT null the whole file: the
    // result is the normalized average of the finite vectors only.
    const result = computeAveragedNormalizedVector([[1, 2], [Number.NaN, 3], [3, 4]]);
    const expected = l2Normalize([2, 3]); // mean of [1,2] and [3,4]

    expect(result.vector).not.toBeNull();
    expect(result.validCount).toBe(2);
    expect(result.skippedCount).toBe(1);
    expect(result.invalidReasons).toEqual(['non_finite']);
    expect(expected).not.toBeNull();
    result.vector?.forEach((value, index) => {
      expect(value).toBeCloseTo((expected ?? [])[index], 10);
    });

    // Infinity is treated identically to NaN (skipped, not poisoning).
    const infResult = computeAveragedNormalizedVector([[1, 2], [Number.NEGATIVE_INFINITY, 3], [3, 4]]);
    expect(infResult.vector).not.toBeNull();
    infResult.vector?.forEach((value, index) => {
      expect(value).toBeCloseTo((expected ?? [])[index], 10);
    });
  });

  it('is unaffected when the FIRST vector is the non-finite one', () => {
    // Regression: the reference dimension must come from the first FINITE vector,
    // not vectors[0] — so a leading NaN chunk does not poison the result.
    const result = computeAveragedNormalizedVector([[Number.NaN, Number.NaN], [1, 2], [3, 4]]);
    const expected = l2Normalize([2, 3]);

    expect(result.vector).not.toBeNull();
    result.vector?.forEach((value, index) => {
      expect(value).toBeCloseTo((expected ?? [])[index], 10);
    });
  });

  it('returns null only when ALL vectors are invalid (non-finite)', () => {
    expect(computeAveragedNormalizedVector([[Number.NaN, 1], [Number.POSITIVE_INFINITY, 2]]).vector).toBeNull();
  });

  it('skips dimension-mismatched vectors and averages the rest', () => {
    // The mismatched vector is skipped; the two matching vectors are averaged.
    const result = computeAveragedNormalizedVector([[1, 2], [3, 4, 5], [3, 4]]);
    const expected = l2Normalize([2, 3]);

    expect(result.vector).not.toBeNull();
    result.vector?.forEach((value, index) => {
      expect(value).toBeCloseTo((expected ?? [])[index], 10);
    });
  });

  it('returns null when the averaged vector has zero norm', () => {
    expect(computeAveragedNormalizedVector([[1, 0], [-1, 0]]).vector).toBeNull();
  });

  // MA3 — Layer 1 / Layer 2 agree on "invalid". When the caller passes the
  // stable expected dimension, a legacy MINORITY-dimension chunk can never
  // define the reference dimension and drop the valid majority.
  it('never returns a minority-dimension vector for mixed-dimension legacy rows (MA3)', () => {
    // One legacy len-2 chunk + two valid len-3 chunks. With the WRONG (batch)
    // logic, the len-2 vector appearing first could set dims=2 and skip the
    // two valid vectors → a 2-dim file vector. With the expected dimension
    // pinned to 3, the len-2 row is skipped as wrong_dimension and the result
    // is the normalized average of the two len-3 vectors.
    const result = computeAveragedNormalizedVector([[9, 9], [1, 0, 0], [0, 1, 0]], 3);
    expect(result.vector).not.toBeNull();
    expect(result.vector).toHaveLength(3); // NOT 2 — the minority dimension never wins
    expect(result.validCount).toBe(2);
    expect(result.skippedCount).toBe(1);
    expect(result.invalidReasons).toEqual(['wrong_dimension']);

    const expected = l2Normalize([0.5, 0.5, 0]);
    result.vector?.forEach((value, index) => {
      expect(value).toBeCloseTo((expected ?? [])[index], 10);
    });
  });

  it('treats an individual zero-norm chunk as invalid when an expected dimension is given (MA3)', () => {
    // Layer 1 rejects zero-norm; Layer 2 must agree when the dimension is known.
    const result = computeAveragedNormalizedVector([[0, 0, 0], [1, 0, 0], [0, 1, 0]], 3);
    expect(result.vector).not.toBeNull();
    expect(result.validCount).toBe(2);
    expect(result.skippedCount).toBe(1);
    expect(result.invalidReasons).toEqual(['zero_norm']);
  });

  it('returns null with full skip accounting when every vector is the wrong dimension (MA3)', () => {
    const result = computeAveragedNormalizedVector([[1, 2], [3, 4]], 384);
    expect(result.vector).toBeNull();
    expect(result.validCount).toBe(0);
    expect(result.skippedCount).toBe(2);
    expect(result.invalidReasons).toEqual(['wrong_dimension', 'wrong_dimension']);
  });

  it('matches the legacy inline average then L2-normalize implementation', () => {
    const random = createSeededRandom(0x5eed);
    const vectors = Array.from({ length: 5 }, () =>
      Array.from({ length: 384 }, () => random() * 2 - 1),
    );

    const legacyAverage = new Array<number>(vectors[0].length).fill(0);
    for (const vector of vectors) {
      for (let i = 0; i < vector.length; i++) {
        legacyAverage[i] += vector[i];
      }
    }
    for (let i = 0; i < legacyAverage.length; i++) {
      legacyAverage[i] /= vectors.length;
    }

    const norm = Math.sqrt(legacyAverage.reduce((sum, value) => sum + value * value, 0));
    if (norm <= 0) {
      throw new Error('Expected seeded vectors to produce a non-zero legacy average');
    }
    const legacyNormalized = legacyAverage.map(value => value / norm);

    const { vector: result } = computeAveragedNormalizedVector(vectors);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(legacyNormalized.length);
    result?.forEach((value, index) => {
      expect(Math.abs(value - legacyNormalized[index])).toBeLessThanOrEqual(1e-9);
    });
  });
});

describe('getInvalidVectorReason (embed-time NaN guard)', () => {
  it('returns null for a valid finite, correctly-dimensioned, non-zero vector', () => {
    expect(getInvalidVectorReason([0.1, 0.2, 0.3], 3)).toBeNull();
    expect(getInvalidVectorReason(new Float32Array([0.1, 0.2, 0.3]), 3)).toBeNull();
  });

  it('flags an all-NaN vector as non_finite (the observed corruption)', () => {
    const allNaN = Array.from({ length: 384 }, () => Number.NaN);
    expect(getInvalidVectorReason(allNaN, 384)).toBe('non_finite');
  });

  it('flags a vector with a single NaN/Inf element as non_finite', () => {
    expect(getInvalidVectorReason([0.1, Number.NaN, 0.3], 3)).toBe('non_finite');
    expect(getInvalidVectorReason([0.1, Number.POSITIVE_INFINITY, 0.3], 3)).toBe('non_finite');
  });

  it('flags a wrong-dimension vector', () => {
    expect(getInvalidVectorReason([0.1, 0.2], 384)).toBe('wrong_dimension');
  });

  it('flags a zero-norm (all-zero) vector', () => {
    expect(getInvalidVectorReason([0, 0, 0], 3)).toBe('zero_norm');
    expect(getInvalidVectorReason([], 0)).toBe('zero_norm');
  });

  it('checks dimension before finiteness (wrong_dimension wins)', () => {
    expect(getInvalidVectorReason([Number.NaN, Number.NaN], 384)).toBe('wrong_dimension');
  });

  it('skips the dimension check when expectedDimension is omitted or zero', () => {
    expect(getInvalidVectorReason([0.1, 0.2])).toBeNull();
    expect(getInvalidVectorReason([0.1, 0.2], 0)).toBeNull();
  });
});
