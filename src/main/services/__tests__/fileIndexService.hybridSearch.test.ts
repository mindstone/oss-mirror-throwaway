import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({ isPackaged: false, userDataPath: '/tmp/test', version: '0.0.0' }),
}));
vi.mock('@core/lazyElectron', () => ({
  onElectronAppEvent: vi.fn(),
}));
vi.mock('./embeddingService', () => ({
  generateEmbedding: vi.fn(),
  generateEmbeddings: vi.fn(),
  generateQueryEmbedding: vi.fn(),
  getEmbeddingDimensions: vi.fn(() => 384),
}));
vi.mock('./sourceMetadataStore', () => ({
  isSourcePath: vi.fn(() => false),
  indexSource: vi.fn(),
}));
vi.mock('./entityMetadataStore', () => ({
  isEntityFile: vi.fn(() => false),
  indexEntity: vi.fn(),
  removeEntity: vi.fn(),
}));
vi.mock('../utils/systemUtils', () => ({
  tryConvertToWorkspacePath: vi.fn(() => null),
}));
vi.mock('../utils/emfileRetry', () => ({
  isTooManyOpenFilesError: vi.fn(() => false),
}));
vi.mock('../utils/enfileState', () => ({
  isEnfileActive: vi.fn(() => false),
  markEnfileDetected: vi.fn((_error?: unknown) => ({ isFirstDetection: false })),
}));

describe('fileIndexService cosineDistance', () => {
  let cosineDistance: (a: number[] | Float32Array, b: number[] | Float32Array) => number;

  beforeAll(async () => {
    const mod = await import('../fileIndexService');
    cosineDistance = mod.cosineDistance;
  });

  it('returns 0 for identical vectors', () => {
    expect(cosineDistance([1, 2, 3], [1, 2, 3])).toBeCloseTo(0, 10);
  });

  it('returns 1 for orthogonal vectors', () => {
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 10);
  });

  it('returns 2 for opposite vectors', () => {
    expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(2, 10);
  });

  it('returns 1 for degenerate zero-vector comparisons', () => {
    expect(cosineDistance([0, 0], [3, 4])).toBe(1);
    expect(cosineDistance([0, 0], [0, 0])).toBe(1);
  });

  it('matches a hand-computed known value', () => {
    // dot([1,2],[2,0]) = 2
    // ||[1,2]|| * ||[2,0]|| = sqrt(5) * 2
    // similarity = 1 / sqrt(5), distance = 1 - 1/sqrt(5)
    const expected = 1 - 1 / Math.sqrt(5);
    expect(cosineDistance([1, 2], [2, 0])).toBeCloseTo(expected, 10);
  });

  it('works for 384-dimensional vectors', () => {
    const a = Float32Array.from({ length: 384 }, (_, i) => i + 1);
    const b = Float32Array.from({ length: 384 }, (_, i) => i + 1);
    expect(cosineDistance(a, b)).toBeCloseTo(0, 8);
  });

  it('handles LanceDB Arrow Vector objects that lack bracket indexing', () => {
    // LanceDB hybrid queries return Arrow Vector objects where v[i] === undefined
    // but Array.from(v) and v.length work. This simulates that exact behavior.
    const realValues = [1, 2, 3];
    const arrowLikeVector = {
      length: 3,
      [Symbol.iterator]: function* () { yield* realValues; },
      get: (i: number) => realValues[i],
    } as unknown as number[];

    // Confirm bracket indexing is broken (like real Arrow Vector)
    expect(arrowLikeVector[0]).toBeUndefined();

    // cosineDistance should still produce correct results via conversion
    const result = cosineDistance([1, 2, 3], arrowLikeVector);
    expect(result).toBeCloseTo(0, 10);
  });

  it('handles Arrow Vector for both arguments', () => {
    const makeArrowLike = (values: number[]) => ({
      length: values.length,
      [Symbol.iterator]: function* () { yield* values; },
      get: (i: number) => values[i],
    } as unknown as number[]);

    const a = makeArrowLike([1, 0]);
    const b = makeArrowLike([0, 1]);
    expect(cosineDistance(a, b)).toBeCloseTo(1, 10);
  });

  it('handles mixed types: Float32Array vs Arrow Vector', () => {
    const a = new Float32Array([3, 4]);
    const vals = [3, 4];
    const arrowB = {
      length: 2,
      [Symbol.iterator]: function* () { yield* vals; },
      get: (i: number) => vals[i],
    } as unknown as Float32Array;

    expect(cosineDistance(a, arrowB)).toBeCloseTo(0, 10);
  });

  it('handles Arrow Vector with 384 dimensions (real-world BGE size)', () => {
    const values = Array.from({ length: 384 }, (_, i) => Math.sin(i));
    const arrowVector = {
      length: 384,
      [Symbol.iterator]: function* () { yield* values; },
      get: (i: number) => values[i],
    } as unknown as number[];

    const f32 = new Float32Array(values);
    // Same vector compared to itself should be ~0
    expect(cosineDistance(f32, arrowVector)).toBeCloseTo(0, 6);
  });
});
