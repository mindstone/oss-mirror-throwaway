import type { CallerIntent, EmbeddingGenerator } from '@core/embeddingGenerator';

const STANDALONE_EMBEDDING_ERROR = 'Local embedding generator is unavailable in standalone CLI';

export class StandaloneEmbeddingGenerator implements EmbeddingGenerator {
  async generateEmbedding(_text: string, _callerIntent?: CallerIntent | boolean): Promise<Float32Array> {
    throw new Error(STANDALONE_EMBEDDING_ERROR);
  }

  async generateQueryEmbedding(_query: string): Promise<Float32Array> {
    throw new Error(STANDALONE_EMBEDDING_ERROR);
  }

  async generateEmbeddings(_texts: string[]): Promise<Float32Array[]> {
    throw new Error(STANDALONE_EMBEDDING_ERROR);
  }
}
