/**
 * Canonical dimension of the embedding model's output vectors (BGE-small-en-v1.5
 * → 384). This is the SSOT for the expected embedding dimension across the app:
 * `embeddingService` derives its `EMBEDDING_DIMS` from it, and the embed-time
 * NaN/dimension guard in `fileIndexService` validates against the live
 * generator's declared `embeddingDimension` (which the real generator sets to
 * this value).
 *
 * It lives here, in the electron-free core boundary, on purpose: the
 * fileIndexService unit harness mocks `@core/embeddingGenerator` and cannot
 * import `embeddingService` (which pulls in `electron` at module top). Sourcing
 * the expected dimension from a STABLE per-model constant — never from the
 * shape of a single embedding batch — is what makes the guard correct for
 * 1-chunk files and 2-chunk dimension ties (a buggy short vector can no longer
 * redefine "correct").
 */
export const EMBEDDING_DIMENSION = 384;

export type CallerIntent = 'user_query' | 'foreground_tool' | 'background_indexing';

export interface EmbeddingGenerator {
  generateEmbedding(text: string, callerIntent?: CallerIntent): Promise<Float32Array>;
  generateEmbedding(text: string, legacyIsPriority: boolean): Promise<Float32Array>;
  generateQueryEmbedding(query: string): Promise<Float32Array>;
  generateEmbeddings(texts: string[]): Promise<Float32Array[]>;
  /**
   * The fixed dimension of the vectors this generator produces. Optional so test
   * doubles may omit it (the guard then falls back to the table schema and
   * finally to skipping the dimension check), but the production generator MUST
   * declare it so the embed-time guard has a stable expected dimension.
   */
  readonly embeddingDimension?: number;
}

export type EmbeddingGeneratorFactory = () => EmbeddingGenerator;

let _factory: EmbeddingGeneratorFactory | undefined;
let _instance: EmbeddingGenerator | undefined;

export function setEmbeddingGeneratorFactory(factory: EmbeddingGeneratorFactory): void {
  _factory = factory;
  _instance = undefined;
}

export function getEmbeddingGenerator(): EmbeddingGenerator {
  if (_instance) return _instance;
  if (!_factory) {
    throw new Error(
      'EmbeddingGenerator not initialized. Call setEmbeddingGeneratorFactory() before use.',
    );
  }
  _instance = _factory();
  return _instance;
}
