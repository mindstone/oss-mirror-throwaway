// CORE-MOVE-EXEMPT: Desktop adapter wiring the core embedding boundary to the existing Electron runtime embedding service.
import { EMBEDDING_DIMENSION, type CallerIntent, type EmbeddingGenerator } from '@core/embeddingGenerator';
import { generateEmbedding, generateEmbeddings, generateQueryEmbedding } from '../embeddingService';

export class ElectronEmbeddingGenerator implements EmbeddingGenerator {
  /** Stable per-model dimension consumed by the embed-time NaN/dimension guard. */
  readonly embeddingDimension = EMBEDDING_DIMENSION;

  generateEmbedding(text: string, callerIntent?: CallerIntent | boolean): Promise<Float32Array> {
    if (typeof callerIntent === 'boolean') {
      return generateEmbedding(text, callerIntent);
    }
    return generateEmbedding(text, callerIntent);
  }

  generateQueryEmbedding(query: string): Promise<Float32Array> {
    return generateQueryEmbedding(query);
  }

  generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
    return generateEmbeddings(texts);
  }
}
