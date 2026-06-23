import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setEmbeddingGeneratorFactory } from '@core/embeddingGenerator';
import { cloudBootstrapWarmup } from '../services/cloudBootstrapWarmup';

const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
const EMBEDDING_DIMS = 384;
const DEFAULT_BATCH_SIZE = 16;
const EMBEDDING_OPTIONS = { pooling: 'mean', normalize: true } as const;

function firstEmbeddingValueForText(text: string): number {
  const seed = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 17);
  return (seed % 997) / 997 + 0.001;
}

const {
  state,
  pipelineMock,
  extractorMock,
  addBreadcrumbMock,
} = vi.hoisted(() => {
  const state = {
    initializeDelayMs: 0,
    extractionDelayMs: 0,
  };
  const vectorForText = (text: string): number[] => {
    const seed = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 17);
    return Array.from({ length: EMBEDDING_DIMS }, (_, index) => {
      const value = ((seed + index * 31) % 997) / 997;
      return value + 0.001;
    });
  };

  const extractorMock = vi.fn(async (input: string | string[]) => {
    if (state.extractionDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, state.extractionDelayMs));
    }
    const inputs = Array.isArray(input) ? input : [input];
    const vectors = inputs.map(vectorForText);
    return {
      tolist: () => vectors,
      dispose: vi.fn(),
    };
  });
  (extractorMock as unknown as { dispose?: () => void }).dispose = vi.fn();

  const pipelineMock = vi.fn(async () => {
    if (state.initializeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, state.initializeDelayMs));
    }
    return extractorMock;
  });

  const addBreadcrumbMock = vi.fn();

  return { state, pipelineMock, extractorMock, addBreadcrumbMock };
});

vi.mock('@huggingface/transformers', () => ({
  env: {
    cacheDir: '',
    allowLocalModels: false,
    allowRemoteModels: true,
  },
  pipeline: pipelineMock,
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: vi.fn(() => ({
    addBreadcrumb: addBreadcrumbMock,
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  })),
}));

describe('CloudEmbeddingGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.initializeDelayMs = 0;
    state.extractionDelayMs = 0;
    delete process.env.REBEL_FORCE_EMBEDDING_WARMUP;
    delete process.env.REBEL_CLOUD_EMBEDDING_IDLE_EVICT_MIN;
    cloudBootstrapWarmup.resetForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('generateEmbedding returns a non-zero 384-dim Float32Array', async () => {
    const { CloudEmbeddingGenerator } = await import('../services/cloudEmbeddingGenerator');
    const generator = new CloudEmbeddingGenerator();

    const vector = await generator.generateEmbedding('hello');

    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector).toHaveLength(EMBEDDING_DIMS);
    const norm = Math.hypot(...Array.from(vector));
    expect(norm).toBeGreaterThan(0);
  });

  it('generateQueryEmbedding differs from generateEmbedding for same raw text', async () => {
    const { CloudEmbeddingGenerator } = await import('../services/cloudEmbeddingGenerator');
    const generator = new CloudEmbeddingGenerator();

    const plain = await generator.generateEmbedding('q');
    const query = await generator.generateQueryEmbedding('q');

    expect(Array.from(query)).not.toEqual(Array.from(plain));
    expect(extractorMock).toHaveBeenNthCalledWith(
      2,
      [`${BGE_QUERY_PREFIX}q`],
      EMBEDDING_OPTIONS,
    );
  });

  it('splits large embedding batches while preserving order and count', async () => {
    const { CloudEmbeddingGenerator } = await import('../services/cloudEmbeddingGenerator');
    const generator = new CloudEmbeddingGenerator();
    const texts = Array.from({ length: 35 }, (_, index) => `batch-text-${index}`);

    const vectors = await generator.generateEmbeddings(texts);

    expect(vectors).toHaveLength(texts.length);
    expect(extractorMock).toHaveBeenCalledTimes(3);
    expect(extractorMock).toHaveBeenNthCalledWith(
      1,
      texts.slice(0, DEFAULT_BATCH_SIZE),
      EMBEDDING_OPTIONS,
    );
    expect(extractorMock).toHaveBeenNthCalledWith(
      2,
      texts.slice(DEFAULT_BATCH_SIZE, DEFAULT_BATCH_SIZE * 2),
      EMBEDDING_OPTIONS,
    );
    expect(extractorMock).toHaveBeenNthCalledWith(
      3,
      texts.slice(DEFAULT_BATCH_SIZE * 2),
      EMBEDDING_OPTIONS,
    );
    for (const [input] of extractorMock.mock.calls) {
      expect(Array.isArray(input)).toBe(true);
      expect((input as string[]).length).toBeLessThanOrEqual(DEFAULT_BATCH_SIZE);
    }

    expect(vectors.map((vector) => vector[0])).toEqual(
      texts.map((text) => Math.fround(firstEmbeddingValueForText(text))),
    );
  });

  it('keeps single-batch behavior for small embedding requests', async () => {
    const { CloudEmbeddingGenerator } = await import('../services/cloudEmbeddingGenerator');
    const generator = new CloudEmbeddingGenerator();
    const texts = Array.from({ length: DEFAULT_BATCH_SIZE }, (_, index) => `single-batch-${index}`);

    const vectors = await generator.generateEmbeddings(texts);

    expect(vectors).toHaveLength(texts.length);
    expect(extractorMock).toHaveBeenCalledTimes(1);
    expect(extractorMock).toHaveBeenCalledWith(texts, EMBEDDING_OPTIONS);
  });

  it('splits 17 inputs into 16-plus-1 boundary batches', async () => {
    const { CloudEmbeddingGenerator } = await import('../services/cloudEmbeddingGenerator');
    const generator = new CloudEmbeddingGenerator();
    const texts = Array.from({ length: 17 }, (_, index) => `boundary-batch-${index}`);

    const vectors = await generator.generateEmbeddings(texts);

    expect(extractorMock).toHaveBeenCalledTimes(2);
    expect(extractorMock).toHaveBeenNthCalledWith(
      1,
      texts.slice(0, DEFAULT_BATCH_SIZE),
      EMBEDDING_OPTIONS,
    );
    expect(extractorMock).toHaveBeenNthCalledWith(
      2,
      texts.slice(DEFAULT_BATCH_SIZE),
      EMBEDDING_OPTIONS,
    );
    expect(vectors).toHaveLength(17);
    expect(vectors.map((vector) => vector[0])).toEqual(
      texts.map((text) => Math.fround(firstEmbeddingValueForText(text))),
    );
  });

  it('throws when a chunk returns mismatched row count', async () => {
    const { CloudEmbeddingGenerator } = await import('../services/cloudEmbeddingGenerator');
    const generator = new CloudEmbeddingGenerator();
    const texts = Array.from({ length: 17 }, (_, index) => `mismatch-batch-${index}`);
    extractorMock.mockImplementationOnce(async (input: string | string[]) => {
      const inputs = Array.isArray(input) ? input : [input];
      const vectors = inputs.slice(1).map(() => Array.from({ length: EMBEDDING_DIMS }, () => 0.25));
      return {
        tolist: () => vectors,
        dispose: vi.fn(),
      };
    });

    await expect(generator.generateEmbeddings(texts)).rejects.toThrow(
      'Embedding pipeline returned 15 rows for a batch of 16',
    );
    expect(extractorMock).toHaveBeenCalledTimes(1);
  });

  it('returns empty embeddings early without pipeline or inflight bookkeeping', async () => {
    const { CloudEmbeddingGenerator } = await import('../services/cloudEmbeddingGenerator');
    const recordSpy = vi.spyOn(
      CloudEmbeddingGenerator.prototype as unknown as { recordEmbeddingCall(): void },
      'recordEmbeddingCall',
    );
    try {
      const generator = new CloudEmbeddingGenerator();

      expect((generator as unknown as { inflightEmbeddingCalls: number }).inflightEmbeddingCalls).toBe(0);
      await expect(generator.generateEmbeddings([])).resolves.toEqual([]);
      expect((generator as unknown as { inflightEmbeddingCalls: number }).inflightEmbeddingCalls).toBe(0);
      expect(recordSpy).not.toHaveBeenCalled();
      expect(pipelineMock).not.toHaveBeenCalled();
    } finally {
      recordSpy.mockRestore();
    }
  });

  it('honors REBEL_CLOUD_EMBEDDING_BATCH_SIZE override for chunking', async () => {
    const previousBatchSize = process.env.REBEL_CLOUD_EMBEDDING_BATCH_SIZE;
    process.env.REBEL_CLOUD_EMBEDDING_BATCH_SIZE = '5';
    vi.resetModules();
    vi.clearAllMocks();

    try {
      const { CloudEmbeddingGenerator } = await import('../services/cloudEmbeddingGenerator');
      const generator = new CloudEmbeddingGenerator();
      const texts = Array.from({ length: 12 }, (_, index) => `override-batch-${index}`);

      await generator.generateEmbeddings(texts);

      expect(extractorMock).toHaveBeenCalledTimes(3);
      expect(extractorMock).toHaveBeenNthCalledWith(
        1,
        texts.slice(0, 5),
        EMBEDDING_OPTIONS,
      );
      expect(extractorMock).toHaveBeenNthCalledWith(
        2,
        texts.slice(5, 10),
        EMBEDDING_OPTIONS,
      );
      expect(extractorMock).toHaveBeenNthCalledWith(
        3,
        texts.slice(10),
        EMBEDDING_OPTIONS,
      );
    } finally {
      if (previousBatchSize === undefined) {
        delete process.env.REBEL_CLOUD_EMBEDDING_BATCH_SIZE;
      } else {
        process.env.REBEL_CLOUD_EMBEDDING_BATCH_SIZE = previousBatchSize;
      }
      vi.resetModules();
    }
  });

  it.each(['0', '-1', 'abc'])(
    'falls back to default batch size for invalid REBEL_CLOUD_EMBEDDING_BATCH_SIZE=%s',
    async (rawBatchSize) => {
      const previousBatchSize = process.env.REBEL_CLOUD_EMBEDDING_BATCH_SIZE;
      process.env.REBEL_CLOUD_EMBEDDING_BATCH_SIZE = rawBatchSize;
      vi.resetModules();
      vi.clearAllMocks();

      try {
        const { CloudEmbeddingGenerator } = await import('../services/cloudEmbeddingGenerator');
        const generator = new CloudEmbeddingGenerator();
        const texts = Array.from({ length: 17 }, (_, index) => `invalid-env-${rawBatchSize}-${index}`);

        await generator.generateEmbeddings(texts);

        expect(extractorMock).toHaveBeenCalledTimes(2);
        expect(extractorMock).toHaveBeenNthCalledWith(
          1,
          texts.slice(0, DEFAULT_BATCH_SIZE),
          EMBEDDING_OPTIONS,
        );
        expect(extractorMock).toHaveBeenNthCalledWith(
          2,
          texts.slice(DEFAULT_BATCH_SIZE),
          EMBEDDING_OPTIONS,
        );
      } finally {
        if (previousBatchSize === undefined) {
          delete process.env.REBEL_CLOUD_EMBEDDING_BATCH_SIZE;
        } else {
          process.env.REBEL_CLOUD_EMBEDDING_BATCH_SIZE = previousBatchSize;
        }
        vi.resetModules();
      }
    },
  );

  it('warmup initializes pipeline once and reuses it for later embeddings', async () => {
    process.env.REBEL_FORCE_EMBEDDING_WARMUP = '1';
    const { CloudEmbeddingGenerator } = await import('../services/cloudEmbeddingGenerator');
    const generator = new CloudEmbeddingGenerator();

    await expect(generator.warmup()).resolves.toBeUndefined();
    expect(pipelineMock).toHaveBeenCalledTimes(1);

    await generator.generateEmbedding('post-warmup');
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(extractorMock).toHaveBeenCalledTimes(1);
  });

  it('does not install idle-eviction polling when env is unset or 0', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { CloudEmbeddingGenerator } = await import('../services/cloudEmbeddingGenerator');

    new CloudEmbeddingGenerator();
    process.env.REBEL_CLOUD_EMBEDDING_IDLE_EVICT_MIN = '0';
    new CloudEmbeddingGenerator();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('does not eagerly warm embeddings during simulated cloud bootstrap warmup flow', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ packages: [] }),
    })) as unknown as typeof fetch);
    const { CloudEmbeddingGenerator } = await import('../services/cloudEmbeddingGenerator');
    const warmupSpy = vi.spyOn(CloudEmbeddingGenerator.prototype, 'warmup');
    const initializeSpy = vi.spyOn(
      CloudEmbeddingGenerator.prototype as unknown as { initializePipeline: () => Promise<unknown> },
      'initializePipeline',
    );

    setEmbeddingGeneratorFactory(() => new CloudEmbeddingGenerator());
    cloudBootstrapWarmup.configure({
      superMcpUrl: 'https://super-mcp.example/mcp',
      idleTriggerMs: 60_000,
      watchdogDelayMs: 65_000,
    });
    cloudBootstrapWarmup.observeRequest('POST', '/api/sessions', false);

    await new Promise((resolve) => setImmediate(resolve));

    expect(warmupSpy).not.toHaveBeenCalled();
    expect(initializeSpy).not.toHaveBeenCalled();
  });

  it('disposes stale in-flight initialization instead of resurrecting an evicted pipeline', async () => {
    process.env.REBEL_FORCE_EMBEDDING_WARMUP = '1';
    state.initializeDelayMs = 150;
    const { CloudEmbeddingGenerator } = await import('../services/cloudEmbeddingGenerator');
    const generator = new CloudEmbeddingGenerator();

    const warmupPromise = generator.warmup();
    await Promise.resolve();

    await expect(generator.disposePipeline()).resolves.toBe(true);
    await expect(warmupPromise).resolves.toBeUndefined();
    expect((extractorMock as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalledTimes(1);

    await generator.generateEmbedding('after-eviction-race');
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });

  it('evicts the cached pipeline when idle eviction is enabled', async () => {
    vi.useFakeTimers();
    process.env.REBEL_CLOUD_EMBEDDING_IDLE_EVICT_MIN = '1';
    const { CloudEmbeddingGenerator } = await import('../services/cloudEmbeddingGenerator');
    const generator = new CloudEmbeddingGenerator();
    const disposePipelineSpy = vi.spyOn(generator, 'disposePipeline');

    await generator.generateEmbedding('first-call');
    expect(pipelineMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(61_000);

    expect(disposePipelineSpy).toHaveBeenCalled();
    expect(addBreadcrumbMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'cloud.embedding.pipeline.evicted',
    }));
  });

  it('defers idle eviction until in-flight embedding calls complete', async () => {
    vi.useFakeTimers();
    process.env.REBEL_CLOUD_EMBEDDING_IDLE_EVICT_MIN = '1';
    state.extractionDelayMs = 90_000;
    const { CloudEmbeddingGenerator } = await import('../services/cloudEmbeddingGenerator');
    const generator = new CloudEmbeddingGenerator();
    const disposePipelineSpy = vi.spyOn(generator, 'disposePipeline');

    const inflightEmbedding = generator.generateEmbedding('slow-call');
    await vi.advanceTimersByTimeAsync(61_000);

    expect(disposePipelineSpy).toHaveBeenCalledTimes(1);
    expect(addBreadcrumbMock).not.toHaveBeenCalledWith(expect.objectContaining({
      message: 'cloud.embedding.pipeline.evicted',
    }));

    await vi.advanceTimersByTimeAsync(30_000);
    await inflightEmbedding;

    expect(addBreadcrumbMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'cloud.embedding.pipeline.evicted',
      data: expect.objectContaining({ deferred: true }),
    }));
  });

  it('re-initializes once after eviction and dedupes concurrent first callers', async () => {
    vi.useFakeTimers();
    const { CloudEmbeddingGenerator } = await import('../services/cloudEmbeddingGenerator');
    const generator = new CloudEmbeddingGenerator();

    await generator.generateEmbedding('initial-call');
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    await expect(generator.disposePipeline()).resolves.toBe(true);

    state.initializeDelayMs = 150;
    const concurrentEmbeddings = Promise.all([
      generator.generateEmbedding('after-evict-a'),
      generator.generateEmbedding('after-evict-b'),
    ]);

    await vi.advanceTimersByTimeAsync(200);
    const [vectorA, vectorB] = await concurrentEmbeddings;

    expect(vectorA).toBeInstanceOf(Float32Array);
    expect(vectorB).toBeInstanceOf(Float32Array);
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });
});
