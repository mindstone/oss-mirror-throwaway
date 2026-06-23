import type { CallerIntent, EmbeddingGenerator } from '@core/embeddingGenerator';
import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import { fireAndForget } from '@shared/utils/fireAndForget';

const MODEL_NAME = 'Xenova/bge-small-en-v1.5';
const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
const MAX_EMBEDDING_TEXT_CHARS = 8000;
const DEFAULT_CLOUD_EMBEDDING_BATCH_SIZE = 16;
const parsedBatchSize = Number.parseInt(process.env.REBEL_CLOUD_EMBEDDING_BATCH_SIZE ?? '', 10);
const MAX_EMBEDDING_BATCH_SIZE = Number.isFinite(parsedBatchSize) && parsedBatchSize > 0
  ? parsedBatchSize
  : DEFAULT_CLOUD_EMBEDDING_BATCH_SIZE;
const logger = createScopedLogger({ service: 'cloud-embedding-generator' });

type EmbeddingPipeline = ((
  input: string | string[],
  options?: {
    pooling?: 'mean' | 'cls' | 'none';
    normalize?: boolean;
  },
) => Promise<{ tolist(): number[][] | number[]; dispose?: () => void | Promise<void> }>) & {
  dispose?: () => void | Promise<void>;
};

export class CloudEmbeddingGenerator implements EmbeddingGenerator {
  private embeddingPipeline: EmbeddingPipeline | null = null;
  private initPromise: Promise<EmbeddingPipeline> | null = null;
  private readonly idleEvictMinutes: number;
  private readonly idleEvictionPollMs = 60_000;
  private lastEmbeddingCallAt = 0;
  private inflightEmbeddingCalls = 0;
  private pendingDispose = false;
  private pendingIdleEviction = false;

  /**
   * Optional cloud-only tuning lever:
   * - `REBEL_CLOUD_EMBEDDING_IDLE_EVICT_MIN=<positive integer>` enables a 60s poller that
   *   evicts the cached embedding pipeline after this many idle minutes.
   * - Unset/`0` keeps eviction disabled (default) to avoid reload churn until Stage B+ pressure
   *   telemetry validates the memory-vs-latency trade-off for enabling this by default.
   */
  constructor() {
    this.idleEvictMinutes = this.readIdleEvictMinutesFromEnv();
    if (this.idleEvictMinutes > 0) {
      this.lastEmbeddingCallAt = Date.now();
      const idleEvictionTimer = setInterval(() => {
        fireAndForget(
          this.maybeEvictIdlePipeline(),
          'cloud.embeddingGenerator.maybeEvictIdlePipeline',
        );
      }, this.idleEvictionPollMs);
      idleEvictionTimer.unref?.();
    }
  }

  // Cloud has no active-turn embedder gate, so the caller-intent / legacy-priority
  // hint is accepted (to satisfy the EmbeddingGenerator interface) but ignored.
  async generateEmbedding(text: string, _callerIntent?: CallerIntent | boolean): Promise<Float32Array> {
    const vectors = await this.generateEmbeddings([text]);
    return vectors[0] ?? new Float32Array();
  }

  async generateQueryEmbedding(query: string): Promise<Float32Array> {
    return this.generateEmbedding(`${BGE_QUERY_PREFIX}${query}`);
  }

  async generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    this.recordEmbeddingCall();
    this.inflightEmbeddingCalls += 1;
    try {
      const pipeline = await this.getPipeline();
      const truncatedTexts = texts.map((text) => text.slice(0, MAX_EMBEDDING_TEXT_CHARS));

      if (truncatedTexts.length > MAX_EMBEDDING_BATCH_SIZE) {
        const batches = Math.ceil(truncatedTexts.length / MAX_EMBEDDING_BATCH_SIZE);
        logger.debug(
          { total: truncatedTexts.length, maxBatchSize: MAX_EMBEDDING_BATCH_SIZE, batches },
          'Splitting large batch into sub-batches',
        );
      }

      const vectors: Float32Array[] = [];
      // Batching is output-invariant here because mean pooling honors attention_mask,
      // so padding tokens are excluded and each text embedding is independent of its
      // neighboring texts in a batch. MAX_EMBEDDING_BATCH_SIZE is resolved at module
      // load from env (same as desktop), so changes require process restart.
      for (let index = 0; index < truncatedTexts.length; index += MAX_EMBEDDING_BATCH_SIZE) {
        const batch = truncatedTexts.slice(index, index + MAX_EMBEDDING_BATCH_SIZE);
        const result = await pipeline(batch, { pooling: 'mean', normalize: true });
        try {
          const rows = this.coerceRows(result.tolist());
          if (rows.length !== batch.length) {
            throw new Error(`Embedding pipeline returned ${rows.length} rows for a batch of ${batch.length}`);
          }
          vectors.push(...rows.map((row) => Float32Array.from(row)));
        } finally {
          await result.dispose?.();
        }
      }

      return vectors;
    } finally {
      this.inflightEmbeddingCalls = Math.max(0, this.inflightEmbeddingCalls - 1);
      await this.maybeDisposePendingPipeline();
    }
  }

  async warmup(): Promise<void> {
    // Bootstrap tests exercise cloud startup wiring without model downloads.
    if (process.env.NODE_ENV === 'test' && process.env.REBEL_FORCE_EMBEDDING_WARMUP !== '1') {
      return;
    }
    await this.getPipeline();
  }

  private async getPipeline(): Promise<EmbeddingPipeline> {
    if (this.embeddingPipeline) {
      return this.embeddingPipeline;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    let currentInitPromise: Promise<EmbeddingPipeline>;
    currentInitPromise = this.initializePipeline()
      .then(async (pipeline) => {
        // If initPromise changed while this initializer was running, this
        // pipeline has already been evicted/replaced and must not be cached.
        if (this.initPromise !== currentInitPromise) {
          await pipeline.dispose?.();
          return pipeline;
        }
        this.embeddingPipeline = pipeline;
        return pipeline;
      })
      .catch((error) => {
        if (this.initPromise === currentInitPromise) {
          this.initPromise = null;
        }
        throw error;
      });

    this.initPromise = currentInitPromise;
    return currentInitPromise;
  }

  private async initializePipeline(): Promise<EmbeddingPipeline> {
    const { env, pipeline } = await import('@huggingface/transformers');
    const cacheDir = process.env.TRANSFORMERS_CACHE ?? process.env.HF_HOME;
    if (cacheDir) {
      env.cacheDir = cacheDir;
    }
    env.allowLocalModels = true;
    env.allowRemoteModels = true;
    // Transformers.js v3 switched from `quantized: true` to `dtype: 'q8'`.
    const pipelineOptions = { dtype: 'q8' } as unknown as Parameters<typeof pipeline>[2];
    const builtPipeline = await pipeline('feature-extraction', MODEL_NAME, pipelineOptions);
    return builtPipeline as unknown as EmbeddingPipeline;
  }

  async disposePipeline(): Promise<boolean> {
    if (this.inflightEmbeddingCalls > 0) {
      this.pendingDispose = true;
      return false;
    }

    return this.disposePipelineNow();
  }

  private coerceRows(values: number[][] | number[]): number[][] {
    if (values.length === 0) {
      return [];
    }
    if (typeof values[0] === 'number') {
      return [values as number[]];
    }
    return values as number[][];
  }

  private recordEmbeddingCall(): void {
    this.lastEmbeddingCallAt = Date.now();
  }

  private readIdleEvictMinutesFromEnv(): number {
    const rawMinutes = process.env.REBEL_CLOUD_EMBEDDING_IDLE_EVICT_MIN?.trim();
    if (!rawMinutes) {
      return 0;
    }

    const parsedMinutes = Number.parseInt(rawMinutes, 10);
    if (!Number.isFinite(parsedMinutes) || parsedMinutes <= 0) {
      return 0;
    }

    return parsedMinutes;
  }

  private async maybeEvictIdlePipeline(): Promise<void> {
    if (this.idleEvictMinutes <= 0) {
      return;
    }
    if (!this.embeddingPipeline && !this.initPromise) {
      return;
    }

    const idleMinutes = (Date.now() - this.lastEmbeddingCallAt) / 60_000;
    if (idleMinutes < this.idleEvictMinutes) {
      return;
    }

    this.pendingIdleEviction = true;
    const evicted = await this.disposePipeline();
    if (evicted) {
      this.pendingIdleEviction = false;
      this.recordEvictionBreadcrumb(idleMinutes, false);
    }
  }

  private async maybeDisposePendingPipeline(): Promise<void> {
    if (this.inflightEmbeddingCalls > 0 || !this.pendingDispose) {
      return;
    }

    const idleEviction = this.pendingIdleEviction;
    const idleMinutes = (Date.now() - this.lastEmbeddingCallAt) / 60_000;
    const evicted = await this.disposePipelineNow();
    this.pendingIdleEviction = false;

    if (evicted && idleEviction) {
      this.recordEvictionBreadcrumb(idleMinutes, true);
    }
  }

  private async disposePipelineNow(): Promise<boolean> {
    const pipeline = this.embeddingPipeline;
    if (!pipeline && !this.initPromise) {
      this.pendingDispose = false;
      return false;
    }

    this.embeddingPipeline = null;
    this.initPromise = null;
    this.pendingDispose = false;
    await pipeline?.dispose?.();
    return true;
  }

  private recordEvictionBreadcrumb(idleMinutes: number, deferred: boolean): void {
    getErrorReporter().addBreadcrumb({
      category: 'cloud.embedding',
      level: 'info',
      message: 'cloud.embedding.pipeline.evicted',
      data: {
        idleMinutes: Math.round(idleMinutes * 1000) / 1000,
        idleEvictMinutes: this.idleEvictMinutes,
        deferred,
      },
    });
  }
}
