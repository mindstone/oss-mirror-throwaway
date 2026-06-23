/**
 * Shared vector math utilities for semantic search.
 */

type VectorInput = ReadonlyArray<number> | Float32Array;

/** Why a chunk vector failed validation (for counted, structured logging). */
export type InvalidVectorReason = 'non_finite' | 'wrong_dimension' | 'zero_norm';

/**
 * Validate a single chunk embedding vector at the write boundary (Layer 1 of the
 * NaN-corruption fix). A vector is usable iff it has the expected dimension, is
 * fully finite (no NaN/Inf), and has a non-zero norm. Returns the failure reason
 * when invalid, or `null` when the vector is usable.
 *
 * `expectedDimension` is checked only when > 0; pass 0/undefined to skip the
 * dimension check (e.g. when the model dimension is not known to the caller).
 */
export function getInvalidVectorReason(
  vector: VectorInput,
  expectedDimension?: number,
): InvalidVectorReason | null {
  if (expectedDimension !== undefined && expectedDimension > 0 && vector.length !== expectedDimension) {
    return 'wrong_dimension';
  }

  let maxAbs = 0;
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i];
    if (!Number.isFinite(value)) {
      return 'non_finite';
    }
    const absValue = Math.abs(value);
    if (absValue > maxAbs) {
      maxAbs = absValue;
    }
  }

  if (vector.length === 0 || maxAbs === 0) {
    return 'zero_norm';
  }

  return null;
}

/**
 * L2-normalize a vector.
 * Returns a fresh array. Returns null if input is empty, contains non-finite values, or has zero norm.
 */
export function l2Normalize(vec: VectorInput): number[] | null {
  const normalized = normalizeVector(vec);
  if (normalized.hasNonFinite || normalized.data.length === 0) {
    return null;
  }

  const maxAbs = getMaxAbsoluteValue(normalized.data);
  if (maxAbs === 0) {
    return null;
  }

  let scaledNormSquared = 0;
  for (let i = 0; i < normalized.data.length; i++) {
    const scaled = normalized.data[i] / maxAbs;
    scaledNormSquared += scaled * scaled;
  }

  const scaledNorm = Math.sqrt(scaledNormSquared);
  if (scaledNorm === 0) {
    return null;
  }

  const result = new Array<number>(normalized.data.length);
  for (let i = 0; i < normalized.data.length; i++) {
    result[i] = normalized.data[i] / maxAbs / scaledNorm;
  }
  return result;
}

/**
 * Rich result of {@link computeAveragedNormalizedVector}. Carries enough
 * information for the file-vector write path to log partial-quality healing
 * (Layer-2 observability, MA4) — how many source chunks were skipped and why —
 * without the caller re-validating the vectors itself.
 */
export interface AveragedVectorResult {
  /** The averaged + L2-normalized vector, or null when no usable chunk existed. */
  vector: number[] | null;
  /** Count of chunks that passed validation and contributed to the average. */
  validCount: number;
  /** Count of chunks that were skipped (non-finite / wrong-dimension / zero-norm). */
  skippedCount: number;
  /** The skip reason per skipped chunk, in input order (for diagnostics). */
  invalidReasons: InvalidVectorReason[];
}

/**
 * Average a list of vectors and L2-normalize the result, robustly skipping
 * invalid chunk vectors (defense in depth — Layer 2 of the NaN-corruption fix).
 *
 * A single corrupt chunk vector (NaN/Inf, observed from a transient GPU backend
 * glitch) must NOT be able to nuke an entire multi-chunk file. So instead of the
 * previous "any non-finite vector ⇒ null" behavior, this skips invalid chunks
 * and averages over the VALID ones, using the SAME validity semantics as the
 * embed-time guard ({@link getInvalidVectorReason}: expected-dimension + finite
 * + non-zero-norm). The two layers therefore agree on what "invalid" means
 * (MA3) — a legacy minority-dimension chunk can no longer define the reference
 * dimension and silently drop the valid majority.
 *
 * - When `expectedDimension` is provided (the caller knows the model dimension —
 *   the stable per-model source, NOT the batch shape), a vector is VALID iff
 *   `getInvalidVectorReason(vector, expectedDimension)` is null. Wrong-dimension
 *   vectors (including legacy minority dimensions) are skipped.
 * - When `expectedDimension` is omitted (pure unit-test / no-model use), the
 *   reference dimension is the first finite vector's length and only finiteness
 *   + non-zero-norm are enforced. This is the sensible default for callers that
 *   genuinely don't know the model dimension; production callers should pass it.
 * - Returns the averaged-and-normalized vector whenever ≥1 valid vector exists.
 * - `vector` is null only when there is NO usable vector: empty input, every
 *   vector invalid, or the average of the valid vectors has zero norm. (These
 *   remain `invalid_vectors`/`empty_chunks` at the call site.)
 *
 * `vector` is a fresh number[] (not Float32Array) for ergonomic interop with fileIndexService.
 */
export function computeAveragedNormalizedVector(
  vectors: ReadonlyArray<VectorInput>,
  expectedDimension?: number,
): AveragedVectorResult {
  const empty: AveragedVectorResult = { vector: null, validCount: 0, skippedCount: 0, invalidReasons: [] };
  if (vectors.length === 0) {
    return empty;
  }

  // Determine the reference dimension. When the caller knows the stable model
  // dimension we use it directly (so a minority/legacy dimension can never win).
  // Otherwise we fall back to the first FINITE vector's length — a non-finite
  // leading vector no longer poisons it.
  let dims = expectedDimension !== undefined && expectedDimension > 0 ? expectedDimension : -1;
  if (dims < 0) {
    for (let vectorIndex = 0; vectorIndex < vectors.length; vectorIndex++) {
      const candidate = normalizeVector(vectors[vectorIndex]);
      if (!candidate.hasNonFinite && candidate.data.length > 0) {
        dims = candidate.data.length;
        break;
      }
    }
  }

  const invalidReasons: InvalidVectorReason[] = [];
  let skippedCount = 0;

  if (dims < 0) {
    // No finite reference dimension at all ⇒ every vector is unusable.
    for (let i = 0; i < vectors.length; i++) {
      invalidReasons.push(getInvalidVectorReason(vectors[i]) ?? 'non_finite');
      skippedCount++;
    }
    return { vector: null, validCount: 0, skippedCount, invalidReasons };
  }

  const avgVector = new Array<number>(dims).fill(0);
  let validCount = 0;

  for (let vectorIndex = 0; vectorIndex < vectors.length; vectorIndex++) {
    // Same validity contract as Layer 1: expected-dimension + finite + non-zero-norm.
    const reason = getInvalidVectorReason(vectors[vectorIndex], dims);
    if (reason) {
      invalidReasons.push(reason);
      skippedCount++;
      continue;
    }
    const vector = normalizeVector(vectors[vectorIndex]);
    for (let i = 0; i < dims; i++) {
      avgVector[i] += vector.data[i];
    }
    validCount++;
  }

  if (validCount === 0) {
    return { vector: null, validCount: 0, skippedCount, invalidReasons };
  }

  for (let i = 0; i < dims; i++) {
    avgVector[i] /= validCount;
  }

  return { vector: l2Normalize(avgVector), validCount, skippedCount, invalidReasons };
}

/**
 * Compute the cosine distance between two vectors.
 *
 * Returns a value in [0, 2] where 0 = identical direction, 1 = orthogonal, 2 = opposite.
 *
 * **NaN handling**: If either vector contains non-finite values (NaN, ±Infinity),
 * the function returns `NaN` instead of throwing. This is intentional — when called
 * in a search loop over many vectors (e.g., hybrid search iterating LanceDB results),
 * one corrupted embedding should not crash the entire search. Callers can filter
 * NaN results with `Number.isNaN()`.
 *
 * **Length mismatch**: Throws an `Error` — this is always a programming bug, not data corruption.
 */
export function cosineDistance(a: number[] | Float32Array, b: number[] | Float32Array): number {
  const aNorm = normalizeVector(a);
  const bNorm = normalizeVector(b);

  if (aNorm.hasNonFinite || bNorm.hasNonFinite) {
    return NaN;
  }

  const aArr = aNorm.data;
  const bArr = bNorm.data;

  if (aArr.length !== bArr.length) {
    throw new Error(`cosineDistance requires vectors of equal length (received ${aArr.length} and ${bArr.length})`);
  }

  const maxAbsA = getMaxAbsoluteValue(aArr);
  const maxAbsB = getMaxAbsoluteValue(bArr);
  if (maxAbsA === 0 || maxAbsB === 0) {
    return 1;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < aArr.length; i++) {
    const scaledA = aArr[i] / maxAbsA;
    const scaledB = bArr[i] / maxAbsB;

    dotProduct += scaledA * scaledB;
    normA += scaledA * scaledA;
    normB += scaledB * scaledB;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) {
    return 1;
  }

  const similarity = clamp(dotProduct / denominator, -1, 1);
  return 1 - similarity;
}

function normalizeVector(vector: VectorInput): { data: VectorInput; hasNonFinite: boolean } {
  const normalized =
    vector instanceof Float32Array || Array.isArray(vector)
      ? vector
      : Array.from(vector as ArrayLike<number> | Iterable<number>);

  for (let i = 0; i < normalized.length; i++) {
    if (!Number.isFinite(normalized[i])) {
      return { data: normalized, hasNonFinite: true };
    }
  }

  return { data: normalized, hasNonFinite: false };
}

function getMaxAbsoluteValue(vector: VectorInput): number {
  let maxAbs = 0;

  for (let i = 0; i < vector.length; i++) {
    const absValue = Math.abs(vector[i]);
    if (absValue > maxAbs) {
      maxAbs = absValue;
    }
  }

  return maxAbs;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
