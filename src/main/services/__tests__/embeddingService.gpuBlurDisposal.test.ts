/**
 * Unit tests for GPU blur disposal lifecycle (Stage 1 performance optimization).
 *
 * Tests the three new exported functions:
 * - disposeGpuBackendOnBlur() — dispose GPU on app blur to free ~811MB
 * - warmUpGpuBackend() — lazy re-init GPU on app focus
 * - getGpuLifecycleMetrics() — diagnostic lifecycle counters
 *
 * Uses test helpers (_set*ForTesting) to manipulate module-level state
 * without needing full GPU/CPU worker initialization.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const utilityProcessForkMock = vi.fn();
const ORIGINAL_DISABLE_LAZY_CPU_WARMUP = process.env.REBEL_DISABLE_LAZY_CPU_WARMUP;

// Mock electron before importing the module
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user-data'),
    getAppPath: vi.fn().mockReturnValue('/mock/app'),
    isPackaged: false,
    commandLine: {
      hasSwitch: vi.fn().mockReturnValue(false),
    },
  },
  utilityProcess: {
    fork: utilityProcessForkMock,
  },
}));

// Mock the logger
vi.mock('@core/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  // Stage 6 (260508): visibilityAwareScheduler (transitively imported via the
  // background-embed latch) and agentTurnRegistry both call createScopedLogger
  // at module load. Stub it so the module graph resolves cleanly.
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  }),
}));

// Mock fs to control worker path existence
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    default: {
      // @ts-expect-error - accessing actual module
      ...actual.default,
      existsSync: vi.fn().mockReturnValue(false),
      mkdirSync: vi.fn(),
    },
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
  };
});

// Mock the GPU backend — create a factory for fresh mocks per test
function createMockGpuBackend() {
  return {
    initialize: vi.fn().mockResolvedValue(true),
    isReady: vi.fn().mockReturnValue(true),
    dispose: vi.fn().mockResolvedValue(undefined),
    generateEmbedding: vi.fn(),
    generateEmbeddings: vi.fn(),
    setThrottling: vi.fn(),
    onDisposal: vi.fn(),
    markActivity: vi.fn(),
    startIdleTimer: vi.fn(),
    isPermanentlyDisabled: vi.fn().mockReturnValue(false),
    hasGpuSupport: vi.fn().mockReturnValue(true),
  };
}

function createReadyUtilityProcessMock() {
  const worker = new EventEmitter() as EventEmitter & {
    postMessage: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    stdout: null;
    stderr: null;
  };

  worker.postMessage = vi.fn((message: { type?: string }) => {
    if (message.type === 'init') {
      queueMicrotask(() => {
        worker.emit('message', { type: 'ready' });
      });
    }
  });
  worker.kill = vi.fn(() => {
    queueMicrotask(() => {
      worker.emit('exit', 0);
    });
    return true;
  });
  worker.stdout = null;
  worker.stderr = null;

  return worker;
}

function createDeferredInitUtilityProcessMock(vector = [0.25]) {
  let ready = false;

  const worker = new EventEmitter() as EventEmitter & {
    postMessage: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    stdout: null;
    stderr: null;
    emitReady: () => void;
  };

  worker.postMessage = vi.fn((message: { type?: string; id?: string }) => {
    if (message.type === 'init') {
      return;
    }

    if (message.type === 'embed' && message.id) {
      if (!ready) {
        throw new Error('embed posted before worker ready');
      }

      queueMicrotask(() => {
        worker.emit('message', { type: 'embedding', id: message.id, vector });
      });
    }
  });
  worker.kill = vi.fn(() => {
    queueMicrotask(() => {
      worker.emit('exit', 0);
    });
    return true;
  });
  worker.stdout = null;
  worker.stderr = null;
  worker.emitReady = () => {
    ready = true;
    queueMicrotask(() => {
      worker.emit('message', { type: 'ready' });
    });
  };

  return worker;
}

vi.mock('../gpuEmbeddingBackend', () => ({
  GpuEmbeddingBackend: vi.fn().mockImplementation(function MockGpuEmbeddingBackend() {
    return createMockGpuBackend();
  }),
}));

// Mock error reporter
const mockAddBreadcrumb = vi.fn();
vi.mock('@core/errorReporter', () => ({
  setErrorReporter: vi.fn(),
  getErrorReporter: () => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: mockAddBreadcrumb,
  }),
}));

// Mock shutdown state
vi.mock('../shutdownState', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
  ShutdownError: class ShutdownError extends Error {
    constructor(message: string) { super(message); this.name = 'ShutdownError'; }
  },
}));

describe('GPU blur disposal lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    utilityProcessForkMock.mockReset();
    utilityProcessForkMock.mockImplementation(() => {
      throw new Error('utilityProcess.fork should not be called in this test');
    });
    delete process.env.REBEL_DISABLE_LAZY_CPU_WARMUP;
  });

  afterEach(() => {
    if (ORIGINAL_DISABLE_LAZY_CPU_WARMUP === undefined) {
      delete process.env.REBEL_DISABLE_LAZY_CPU_WARMUP;
    } else {
      process.env.REBEL_DISABLE_LAZY_CPU_WARMUP = ORIGINAL_DISABLE_LAZY_CPU_WARMUP;
    }
    vi.resetModules();
  });

  // ── disposeGpuBackendOnBlur ─────────────────────────────────────

  describe('disposeGpuBackendOnBlur()', () => {
    it('skips when no GPU backend exists', async () => {
      const {
        disposeGpuBackendOnBlur,
        getGpuLifecycleMetrics,
        _setGpuBackendForTesting,
        _setActiveBackendForTesting,
        _resetGpuLifecycleMetricsForTesting,
      } = await import('../embeddingService');

      _resetGpuLifecycleMetricsForTesting();
      _setActiveBackendForTesting('gpu');
      _setGpuBackendForTesting(null); // No GPU backend

      disposeGpuBackendOnBlur();

      const metrics = getGpuLifecycleMetrics();
      expect(metrics.blurDisposalCount).toBe(0);
    });

    it('skips when gpuAutoDisabled is true', async () => {
      const {
        disposeGpuBackendOnBlur,
        getGpuLifecycleMetrics,
        _setGpuBackendForTesting,
        _setActiveBackendForTesting,
        _setGpuAutoDisabledForTesting,
        _resetGpuLifecycleMetricsForTesting,
      } = await import('../embeddingService');

      _resetGpuLifecycleMetricsForTesting();
      _setActiveBackendForTesting('gpu');
      _setGpuAutoDisabledForTesting(true);

      const mockBackend = createMockGpuBackend();
      // @ts-expect-error — passing mock as GpuEmbeddingBackend for testing
      _setGpuBackendForTesting(mockBackend);

      disposeGpuBackendOnBlur();

      expect(mockBackend.dispose).not.toHaveBeenCalled();
      const metrics = getGpuLifecycleMetrics();
      expect(metrics.blurDisposalCount).toBe(0);
    });

    it('disposes GPU backend, keeps activeBackend=gpu, increments metric', async () => {
      const {
        disposeGpuBackendOnBlur,
        getGpuLifecycleMetrics,
        getActiveBackend,
        hasGpuSupport,
        _setGpuBackendForTesting,
        _setActiveBackendForTesting,
        _setGpuAutoDisabledForTesting,
        _setIsDisposedForTesting,
        _resetGpuLifecycleMetricsForTesting,
      } = await import('../embeddingService');

      _resetGpuLifecycleMetricsForTesting();
      _setActiveBackendForTesting('gpu');
      _setGpuAutoDisabledForTesting(false);
      _setIsDisposedForTesting(false);

      const mockBackend = createMockGpuBackend();
      // @ts-expect-error — passing mock as GpuEmbeddingBackend for testing
      _setGpuBackendForTesting(mockBackend);

      disposeGpuBackendOnBlur();

      // GPU backend dispose() was called (fire-and-forget)
      expect(mockBackend.dispose).toHaveBeenCalledTimes(1);

      // activeBackend stays 'gpu' for lazy re-init
      expect(getActiveBackend()).toBe('gpu');

      // gpuBackend is now null (hasGpuSupport checks gpuBackend !== null)
      expect(hasGpuSupport()).toBe(false);

      // Lifecycle metric incremented
      const metrics = getGpuLifecycleMetrics();
      expect(metrics.blurDisposalCount).toBe(1);
      expect(metrics.lastBlurDisposalAt).toBeTypeOf('number');

      // Breadcrumb was added
      expect(mockAddBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'embedding',
          message: expect.stringContaining('blur'),
        })
      );
    });

    it('skips when service is disposed (shutdown)', async () => {
      const {
        disposeGpuBackendOnBlur,
        getGpuLifecycleMetrics,
        _setGpuBackendForTesting,
        _setActiveBackendForTesting,
        _setIsDisposedForTesting,
        _resetGpuLifecycleMetricsForTesting,
      } = await import('../embeddingService');

      _resetGpuLifecycleMetricsForTesting();
      _setActiveBackendForTesting('gpu');
      _setIsDisposedForTesting(true);

      const mockBackend = createMockGpuBackend();
      // @ts-expect-error — passing mock as GpuEmbeddingBackend for testing
      _setGpuBackendForTesting(mockBackend);

      disposeGpuBackendOnBlur();

      expect(mockBackend.dispose).not.toHaveBeenCalled();
      expect(getGpuLifecycleMetrics().blurDisposalCount).toBe(0);
    });
  });

  describe('Stage 3 — no eager CPU worker init on blur/idle disposal', () => {
    it('disposeGpuBackendOnBlur does NOT call initializeCpuWorker by default', async () => {
      const {
        disposeGpuBackendOnBlur,
        _setGpuBackendForTesting,
        _setActiveBackendForTesting,
        _setGpuAutoDisabledForTesting,
        _setIsDisposedForTesting,
        _resetGpuLifecycleMetricsForTesting,
      } = await import('../embeddingService');

      _resetGpuLifecycleMetricsForTesting();
      _setActiveBackendForTesting('gpu');
      _setGpuAutoDisabledForTesting(false);
      _setIsDisposedForTesting(false);

      const mockBackend = createMockGpuBackend();
      // @ts-expect-error — passing mock as GpuEmbeddingBackend for testing
      _setGpuBackendForTesting(mockBackend);

      expect(() => disposeGpuBackendOnBlur()).not.toThrow();
      expect(utilityProcessForkMock).not.toHaveBeenCalled();
    });

    it('disposeGpuBackendOnBlur DOES call initializeCpuWorker when REBEL_DISABLE_LAZY_CPU_WARMUP=1', async () => {
      process.env.REBEL_DISABLE_LAZY_CPU_WARMUP = '1';

      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.default.existsSync).mockReturnValue(true);
      utilityProcessForkMock.mockImplementation(() => createReadyUtilityProcessMock());

      const {
        disposeGpuBackendOnBlur,
        _setGpuBackendForTesting,
        _setActiveBackendForTesting,
        _setGpuAutoDisabledForTesting,
        _setIsDisposedForTesting,
        _resetGpuLifecycleMetricsForTesting,
      } = await import('../embeddingService');

      _resetGpuLifecycleMetricsForTesting();
      _setActiveBackendForTesting('gpu');
      _setGpuAutoDisabledForTesting(false);
      _setIsDisposedForTesting(false);

      const mockBackend = createMockGpuBackend();
      // @ts-expect-error — passing mock as GpuEmbeddingBackend for testing
      _setGpuBackendForTesting(mockBackend);

      disposeGpuBackendOnBlur();

      await vi.waitFor(() => {
        expect(utilityProcessForkMock).toHaveBeenCalledTimes(1);
      });
    });

    it('treats non-"1" REBEL_DISABLE_LAZY_CPU_WARMUP values as lazy init defaults', async () => {
      for (const envValue of ['0', '', 'true'] as const) {
        process.env.REBEL_DISABLE_LAZY_CPU_WARMUP = envValue;
        utilityProcessForkMock.mockReset();
        utilityProcessForkMock.mockImplementation(() => createReadyUtilityProcessMock());
        vi.resetModules();

        const fs = await import('node:fs');
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.default.existsSync).mockReturnValue(true);

        const {
          disposeGpuBackendOnBlur,
          _setGpuBackendForTesting,
          _setActiveBackendForTesting,
          _setGpuAutoDisabledForTesting,
          _setIsDisposedForTesting,
          _resetGpuLifecycleMetricsForTesting,
        } = await import('../embeddingService');

        _resetGpuLifecycleMetricsForTesting();
        _setActiveBackendForTesting('gpu');
        _setGpuAutoDisabledForTesting(false);
        _setIsDisposedForTesting(false);

        const mockBackend = createMockGpuBackend();
        // @ts-expect-error — passing mock as GpuEmbeddingBackend for testing
        _setGpuBackendForTesting(mockBackend);

        disposeGpuBackendOnBlur();
        await Promise.resolve();

        expect(utilityProcessForkMock).not.toHaveBeenCalled();
      }
    });

    it('deduplicates concurrent lazy CPU worker init after blur disposal', async () => {
      const deferredWorker = createDeferredInitUtilityProcessMock([1, 2, 3]);
      utilityProcessForkMock.mockImplementation(() => deferredWorker);

      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.default.existsSync).mockReturnValue(true);

      const {
        disposeGpuBackendOnBlur,
        generateEmbedding,
        _setGpuBackendForTesting,
        _setActiveBackendForTesting,
        _setGpuAutoDisabledForTesting,
        _setIsDisposedForTesting,
        _resetGpuLifecycleMetricsForTesting,
      } = await import('../embeddingService');

      _resetGpuLifecycleMetricsForTesting();
      _setActiveBackendForTesting('gpu');
      _setGpuAutoDisabledForTesting(false);
      _setIsDisposedForTesting(false);

      const mockBackend = createMockGpuBackend();
      // @ts-expect-error — passing mock as GpuEmbeddingBackend for testing
      _setGpuBackendForTesting(mockBackend);

      disposeGpuBackendOnBlur();

      const requests = Array.from({ length: 5 }, (_unused, index) =>
        generateEmbedding(`concurrent blur request ${index}`)
      );

      await vi.waitFor(() => {
        expect(utilityProcessForkMock).toHaveBeenCalledTimes(1);
      });
      expect(deferredWorker.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'init' })
      );

      deferredWorker.emitReady();

      const results = await Promise.all(requests);
      expect(results).toHaveLength(5);
      for (const result of results) {
        expect(Array.from(result)).toEqual([1, 2, 3]);
      }
      expect(utilityProcessForkMock).toHaveBeenCalledTimes(1);
    });

    it('GPU idle disposal does NOT call initializeCpuWorker by default', async () => {
      const { GpuEmbeddingBackend } = await import('../gpuEmbeddingBackend');
      let idleDisposalHandler: (() => void) | undefined;

      const initializedBackend = createMockGpuBackend();
      initializedBackend.onDisposal.mockImplementation((callback: () => void) => {
        idleDisposalHandler = callback;
      });

      vi.mocked(GpuEmbeddingBackend).mockImplementationOnce(function MockGpuEmbeddingBackend() {
        return initializedBackend;
      });

      const {
        warmUpGpuBackend,
        _setGpuBackendForTesting,
        _setActiveBackendForTesting,
        _setGpuAutoDisabledForTesting,
        _setIsDisposedForTesting,
        _resetGpuLifecycleMetricsForTesting,
      } = await import('../embeddingService');

      _resetGpuLifecycleMetricsForTesting();
      _setActiveBackendForTesting('gpu');
      _setGpuBackendForTesting(null);
      _setGpuAutoDisabledForTesting(false);
      _setIsDisposedForTesting(false);

      warmUpGpuBackend();

      await vi.waitFor(() => {
        expect(initializedBackend.initialize).toHaveBeenCalledTimes(1);
        expect(idleDisposalHandler).toBeTypeOf('function');
      });

      expect(() => idleDisposalHandler?.()).not.toThrow();
      expect(utilityProcessForkMock).not.toHaveBeenCalled();
    });

    it('GPU idle disposal DOES call initializeCpuWorker when REBEL_DISABLE_LAZY_CPU_WARMUP=1', async () => {
      process.env.REBEL_DISABLE_LAZY_CPU_WARMUP = '1';

      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.default.existsSync).mockReturnValue(true);
      utilityProcessForkMock.mockImplementation(() => createReadyUtilityProcessMock());

      const { GpuEmbeddingBackend } = await import('../gpuEmbeddingBackend');
      let idleDisposalHandler: (() => void) | undefined;

      const initializedBackend = createMockGpuBackend();
      initializedBackend.onDisposal.mockImplementation((callback: () => void) => {
        idleDisposalHandler = callback;
      });

      vi.mocked(GpuEmbeddingBackend).mockImplementationOnce(function MockGpuEmbeddingBackend() {
        return initializedBackend;
      });

      const {
        warmUpGpuBackend,
        _setGpuBackendForTesting,
        _setActiveBackendForTesting,
        _setGpuAutoDisabledForTesting,
        _setIsDisposedForTesting,
        _resetGpuLifecycleMetricsForTesting,
      } = await import('../embeddingService');

      _resetGpuLifecycleMetricsForTesting();
      _setActiveBackendForTesting('gpu');
      _setGpuBackendForTesting(null);
      _setGpuAutoDisabledForTesting(false);
      _setIsDisposedForTesting(false);

      warmUpGpuBackend();

      await vi.waitFor(() => {
        expect(initializedBackend.initialize).toHaveBeenCalledTimes(1);
        expect(idleDisposalHandler).toBeTypeOf('function');
      });

      idleDisposalHandler?.();

      await vi.waitFor(() => {
        expect(utilityProcessForkMock).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ── warmUpGpuBackend ────────────────────────────────────────────

  describe('warmUpGpuBackend()', () => {
    it('skips when activeBackend is cpu', async () => {
      const {
        warmUpGpuBackend,
        getGpuLifecycleMetrics,
        _setActiveBackendForTesting,
        _resetGpuLifecycleMetricsForTesting,
      } = await import('../embeddingService');

      _resetGpuLifecycleMetricsForTesting();
      _setActiveBackendForTesting('cpu');

      warmUpGpuBackend();

      expect(getGpuLifecycleMetrics().focusWarmUpCount).toBe(0);
    });

    it('skips when gpuBackend already exists', async () => {
      const {
        warmUpGpuBackend,
        getGpuLifecycleMetrics,
        _setGpuBackendForTesting,
        _setActiveBackendForTesting,
        _resetGpuLifecycleMetricsForTesting,
      } = await import('../embeddingService');

      _resetGpuLifecycleMetricsForTesting();
      _setActiveBackendForTesting('gpu');

      const mockBackend = createMockGpuBackend();
      // @ts-expect-error — passing mock as GpuEmbeddingBackend for testing
      _setGpuBackendForTesting(mockBackend);

      warmUpGpuBackend();

      // No warm-up needed — backend already exists
      expect(getGpuLifecycleMetrics().focusWarmUpCount).toBe(0);
    });

    it('calls tryReinitGpuBackend fire-and-forget and increments metric', async () => {
      const {
        warmUpGpuBackend,
        getGpuLifecycleMetrics,
        _setGpuBackendForTesting,
        _setActiveBackendForTesting,
        _setGpuAutoDisabledForTesting,
        _setIsDisposedForTesting,
        _resetGpuLifecycleMetricsForTesting,
      } = await import('../embeddingService');

      _resetGpuLifecycleMetricsForTesting();
      _setActiveBackendForTesting('gpu');
      _setGpuBackendForTesting(null); // GPU was disposed (blur or idle)
      _setGpuAutoDisabledForTesting(false);
      _setIsDisposedForTesting(false);

      warmUpGpuBackend();

      // Metric incremented immediately (re-init is fire-and-forget)
      const metrics = getGpuLifecycleMetrics();
      expect(metrics.focusWarmUpCount).toBe(1);
      expect(metrics.lastFocusWarmUpAt).toBeTypeOf('number');
    });

    it('disposes a newly initialized backend if blur suppresses re-init mid-initialization', async () => {
      const {
        disposeGpuBackendOnBlur,
        getActiveBackend,
        hasGpuSupport,
        warmUpGpuBackend,
        _setGpuBackendForTesting,
        _setActiveBackendForTesting,
        _setGpuAutoDisabledForTesting,
        _setIsDisposedForTesting,
        _resetGpuLifecycleMetricsForTesting,
      } = await import('../embeddingService');
      const { GpuEmbeddingBackend } = await import('../gpuEmbeddingBackend');
      const { logger } = await import('@core/logger');

      let resolveInitialize: ((value: boolean) => void) | undefined;
      const initializePromise = new Promise<boolean>(resolve => {
        resolveInitialize = resolve;
      });

      const delayedBackend = createMockGpuBackend();
      delayedBackend.initialize.mockReturnValueOnce(initializePromise);

      vi.mocked(GpuEmbeddingBackend).mockImplementationOnce(function MockGpuEmbeddingBackend() {
        return delayedBackend;
      });

      _resetGpuLifecycleMetricsForTesting();
      _setActiveBackendForTesting('gpu');
      _setGpuBackendForTesting(null);
      _setGpuAutoDisabledForTesting(false);
      _setIsDisposedForTesting(false);

      warmUpGpuBackend();
      await vi.waitFor(() => {
        expect(delayedBackend.initialize).toHaveBeenCalledTimes(1);
      });

      // Blur arrives while GPU initialize() is still in flight.
      disposeGpuBackendOnBlur();

      resolveInitialize?.(true);

      await vi.waitFor(() => {
        expect(delayedBackend.dispose).toHaveBeenCalledTimes(1);
      });

      expect(hasGpuSupport()).toBe(false);
      expect(getActiveBackend()).toBe('gpu');
      expect(logger.info).toHaveBeenCalledWith(
        { gpuReinitSuppressed: true, isDisposed: false },
        'GPU re-init completed but lifecycle state changed — disposing new backend'
      );
    });

    it('skips when gpuAutoDisabled is true', async () => {
      const {
        warmUpGpuBackend,
        getGpuLifecycleMetrics,
        _setGpuBackendForTesting,
        _setActiveBackendForTesting,
        _setGpuAutoDisabledForTesting,
        _resetGpuLifecycleMetricsForTesting,
      } = await import('../embeddingService');

      _resetGpuLifecycleMetricsForTesting();
      _setActiveBackendForTesting('gpu');
      _setGpuBackendForTesting(null);
      _setGpuAutoDisabledForTesting(true);

      warmUpGpuBackend();

      expect(getGpuLifecycleMetrics().focusWarmUpCount).toBe(0);
    });

    it('skips when service is disposed (shutdown)', async () => {
      const {
        warmUpGpuBackend,
        getGpuLifecycleMetrics,
        _setGpuBackendForTesting,
        _setActiveBackendForTesting,
        _setIsDisposedForTesting,
        _resetGpuLifecycleMetricsForTesting,
      } = await import('../embeddingService');

      _resetGpuLifecycleMetricsForTesting();
      _setActiveBackendForTesting('gpu');
      _setGpuBackendForTesting(null);
      _setIsDisposedForTesting(false); // First set not disposed
      _setIsDisposedForTesting(true); // Then set disposed

      warmUpGpuBackend();

      expect(getGpuLifecycleMetrics().focusWarmUpCount).toBe(0);
    });
  });

  // ── getGpuLifecycleMetrics ──────────────────────────────────────

  describe('getGpuLifecycleMetrics()', () => {
    it('returns a copy of metrics (mutation isolation)', async () => {
      const {
        getGpuLifecycleMetrics,
        _resetGpuLifecycleMetricsForTesting,
      } = await import('../embeddingService');

      _resetGpuLifecycleMetricsForTesting();

      const metrics1 = getGpuLifecycleMetrics();
      const metrics2 = getGpuLifecycleMetrics();

      // Should be structurally equal but different object references
      expect(metrics1).toEqual(metrics2);
      expect(metrics1).not.toBe(metrics2);

      // Mutating returned object should not affect internal state
      metrics1.blurDisposalCount = 999;
      metrics1.focusWarmUpCount = 888;
      const metrics3 = getGpuLifecycleMetrics();
      expect(metrics3.blurDisposalCount).toBe(0);
      expect(metrics3.focusWarmUpCount).toBe(0);
    });

    it('returns initial zero values', async () => {
      const {
        getGpuLifecycleMetrics,
        _resetGpuLifecycleMetricsForTesting,
      } = await import('../embeddingService');

      _resetGpuLifecycleMetricsForTesting();

      const metrics = getGpuLifecycleMetrics();
      expect(metrics.blurDisposalCount).toBe(0);
      expect(metrics.focusWarmUpCount).toBe(0);
      expect(metrics.lastBlurDisposalAt).toBeNull();
      expect(metrics.lastFocusWarmUpAt).toBeNull();
    });
  });
});
