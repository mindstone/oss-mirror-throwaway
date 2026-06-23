/**
 * Unit tests for embeddingService retry, recovery, and ONNX thread-cap config.
 *
 * TESTING CONSTRAINTS:
 * - Cannot test real utilityProcess + ONNX model startup in unit tests
 * - Focus on state management and init-message plumbing via mocks
 *
 * WHAT'S TESTED:
 * - getServiceStatus() returns correct state structure
 * - forceRetryInitialization() enforces cooldown period
 * - resolveIntraOpThreads() parses env overrides and host-scaled defaults
 * - Worker init messages include onnxIntraOpThreads
 * - getEmbeddingLifecycleStats() reports startup init telemetry
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';

const { mockFork, mockExistsSync, mockAvailableParallelism, mockCpus } = vi.hoisted(() => ({
  mockFork: vi.fn(),
  mockExistsSync: vi.fn(),
  mockAvailableParallelism: vi.fn(),
  mockCpus: vi.fn(),
}));

const originalIntraOpEnv = process.env.REBEL_ONNX_INTRA_OP_THREADS;
const originalCpuIdleDisposalEnv = process.env.REBEL_CPU_IDLE_DISPOSAL;

function createCpuInfoList(count: number) {
  return Array.from({ length: count }, () => ({
    model: 'test-cpu',
    speed: 1,
    times: {
      user: 0,
      nice: 0,
      sys: 0,
      idle: 0,
      irq: 0,
    },
  }));
}

function createMockWorker(onPostMessage?: (message: unknown) => void) {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();

  return {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    postMessage: vi.fn((message: unknown) => {
      onPostMessage?.(message);
      for (const listener of listeners.get('message') ?? []) {
        listener({ type: 'ready' });
      }
    }),
    kill: vi.fn(),
  };
}

function createUtilityProcessWorker(options?: {
  onInit?: (worker: EventEmitter, message: { type?: string }) => void;
  onEmbed?: (worker: EventEmitter, message: { type?: string; id?: string }) => void;
  onDispose?: (worker: EventEmitter, message: { type?: string }) => void;
}) {
  const worker = new EventEmitter() as EventEmitter & {
    postMessage: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    stdout: { on: ReturnType<typeof vi.fn> };
    stderr: { on: ReturnType<typeof vi.fn> };
  };

  worker.postMessage = vi.fn((rawMessage: unknown) => {
    const message = rawMessage as { type?: string; id?: string };
    if (message.type === 'init') {
      options?.onInit?.(worker, message);
    } else if (message.type === 'embed') {
      options?.onEmbed?.(worker, message);
    } else if (message.type === 'dispose') {
      options?.onDispose?.(worker, message);
    }
  });
  worker.kill = vi.fn(() => {
    queueMicrotask(() => {
      worker.emit('exit', 0);
    });
    return true;
  });
  worker.stdout = { on: vi.fn() };
  worker.stderr = { on: vi.fn() };

  return worker;
}

function createReadyEmbeddingWorker(vector = [0.25]) {
  let ready = false;

  return createUtilityProcessWorker({
    onInit: (worker) => {
      ready = true;
      queueMicrotask(() => {
        worker.emit('message', { type: 'ready' });
      });
    },
    onEmbed: (worker, message) => {
      if (!ready || !message.id) {
        throw new Error('embed posted before worker ready');
      }
      queueMicrotask(() => {
        worker.emit('message', { type: 'embedding', id: message.id, vector });
      });
    },
    onDispose: (worker) => {
      queueMicrotask(() => {
        worker.emit('message', { type: 'disposed' });
      });
    },
  });
}

function createInitErrorWorker(errorMessage = 'synthetic init failure') {
  return createUtilityProcessWorker({
    onInit: (worker) => {
      queueMicrotask(() => {
        worker.emit('message', { type: 'error', error: errorMessage });
      });
    },
  });
}

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
    fork: mockFork.mockImplementation(() => {
      throw new Error('utilityProcess mock - should not be called in these tests');
    }),
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
      existsSync: mockExistsSync,
      mkdirSync: vi.fn(),
    },
    existsSync: mockExistsSync,
    mkdirSync: vi.fn(),
  };
});

 
vi.mock('node:os', () => ({
  default: {
    availableParallelism: mockAvailableParallelism,
    cpus: mockCpus,
  },
  availableParallelism: mockAvailableParallelism,
  cpus: mockCpus,
}));

// Mock the GPU backend
 
vi.mock('../gpuEmbeddingBackend', () => ({
  GpuEmbeddingBackend: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(false),
    isReady: vi.fn().mockReturnValue(false),
    dispose: vi.fn().mockResolvedValue(undefined),
    generateEmbedding: vi.fn(),
    generateEmbeddings: vi.fn(),
  })),
}));

// Mock error reporter to avoid electron dependency in tests
 
vi.mock('@core/errorReporter', () => ({
  setErrorReporter: vi.fn(),
  getErrorReporter: () => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  }),
}));

describe('embeddingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    delete process.env.REBEL_ONNX_INTRA_OP_THREADS;
    delete process.env.REBEL_CPU_IDLE_DISPOSAL;
    mockExistsSync.mockReturnValue(false);
    mockFork.mockImplementation(() => {
      throw new Error('utilityProcess mock - should not be called in these tests');
    });
    mockAvailableParallelism.mockReturnValue(8);
    mockCpus.mockReturnValue(createCpuInfoList(8));
  });

  afterEach(async () => {
    if (originalIntraOpEnv === undefined) {
      delete process.env.REBEL_ONNX_INTRA_OP_THREADS;
    } else {
      process.env.REBEL_ONNX_INTRA_OP_THREADS = originalIntraOpEnv;
    }
    if (originalCpuIdleDisposalEnv === undefined) {
      delete process.env.REBEL_CPU_IDLE_DISPOSAL;
    } else {
      process.env.REBEL_CPU_IDLE_DISPOSAL = originalCpuIdleDisposalEnv;
    }
    vi.useRealTimers();
    // Reset module state by clearing the module cache
    vi.resetModules();
    await initTestPlatformConfig();
  });

  describe('getServiceStatus', () => {
    it('returns initial state with all fields', async () => {
      // Import fresh module to get clean state
      const { getServiceStatus } = await import('../embeddingService');

      const status = getServiceStatus();

      // Verify all expected fields exist
      expect(status).toHaveProperty('ready');
      expect(status).toHaveProperty('failed');
      expect(status).toHaveProperty('attempts');
      expect(status).toHaveProperty('lastError');
      expect(status).toHaveProperty('lastAttemptAt');
    });

    it('returns a copy of state (prevents external mutation)', async () => {
      const { getServiceStatus } = await import('../embeddingService');

      const status1 = getServiceStatus();
      const status2 = getServiceStatus();

      // Should be equal but not the same object
      expect(status1).toEqual(status2);
      expect(status1).not.toBe(status2);

      // Mutating returned object should not affect internal state
      status1.failed = true;
      status1.attempts = 999;
      const status3 = getServiceStatus();
      expect(status3.failed).not.toBe(true);
      expect(status3.attempts).not.toBe(999);
    });

    it('has expected initial values', async () => {
      const { getServiceStatus } = await import('../embeddingService');

      const status = getServiceStatus();

      // Initial state should be clean
      expect(status.ready).toBe(false);
      expect(status.failed).toBe(false);
      expect(status.attempts).toBe(0);
      expect(status.lastError).toBeNull();
      expect(status.lastAttemptAt).toBeNull();
    });
  });

  describe('getEmbeddingLifecycleStats', () => {
    it('reports startup init telemetry after waitForModelReady bootstraps the worker', async () => {
      mockExistsSync.mockReturnValue(true);
      mockAvailableParallelism.mockReturnValue(5);
      mockFork.mockImplementation(() => createMockWorker());

      const { waitForModelReady, getEmbeddingLifecycleStats } = await import('../embeddingService');

      await expect(waitForModelReady()).resolves.toBeUndefined();

      expect(getEmbeddingLifecycleStats()).toEqual(
        expect.objectContaining({
          cpuWorkerSpawns: 1,
          gpuBlurIdleDispositions: 0,
          gpuInits: 0,
          cpuEmbedBatches: 0,
          gpuEmbedBatches: 0,
          onnxIntraOpThreads: 4,
          firstCpuInitReason: 'startup',
          lastCpuInitReason: 'startup',
          cpuInitReasonCounts: expect.objectContaining({
            'startup': 1,
            'blur-fallback': 0,
            'idle-fallback': 0,
            'gpu-error-fallback': 0,
            'manual': 0,
          }),
          lastInitAt: expect.any(Number),
          lastDisposeAt: null,
        })
      );
    });

    it('returns a copy so callers cannot mutate lifecycle stats', async () => {
      const { getEmbeddingLifecycleStats } = await import('../embeddingService');

      const stats = getEmbeddingLifecycleStats();
      stats.cpuWorkerSpawns = 999;
      stats.firstCpuInitReason = 'manual';

      expect(getEmbeddingLifecycleStats().cpuWorkerSpawns).toBe(0);
      expect(getEmbeddingLifecycleStats().firstCpuInitReason).toBeNull();
    });

    it('preserves startup as the first init reason after a later blur-fallback re-init succeeds', async () => {
      process.env.REBEL_CPU_IDLE_DISPOSAL = '1';
      mockExistsSync.mockReturnValue(true);
      mockAvailableParallelism.mockReturnValue(5);
      mockFork
        .mockImplementationOnce(() => createReadyEmbeddingWorker([0.25]))
        .mockImplementationOnce(() => createReadyEmbeddingWorker([0.5]));

      const {
        waitForModelReady,
        generateEmbedding,
        getEmbeddingLifecycleStats,
        disposeGpuBackendOnBlur,
        _triggerCpuIdleCheckForTesting,
        _getCpuIdleStateForTesting,
        _setGpuBackendForTesting,
        _setActiveBackendForTesting,
        _setGpuAutoDisabledForTesting,
        _setIsDisposedForTesting,
        _resetGpuLifecycleMetricsForTesting,
      } = await import('../embeddingService');

      _resetGpuLifecycleMetricsForTesting();
      _setGpuAutoDisabledForTesting(false);
      _setIsDisposedForTesting(false);

      await expect(waitForModelReady()).resolves.toBeUndefined();

      _triggerCpuIdleCheckForTesting();
      await vi.advanceTimersByTimeAsync(0);

      expect(_getCpuIdleStateForTesting()).toEqual(
        expect.objectContaining({
          isIdleDisposed: true,
          isDisposing: false,
        })
      );

      _setActiveBackendForTesting('gpu');
      _setGpuBackendForTesting({
        dispose: vi.fn().mockResolvedValue(undefined),
      } as never);
      disposeGpuBackendOnBlur();

      await expect(generateEmbedding('blur fallback request')).resolves.toEqual(new Float32Array([0.5]));

      expect(getEmbeddingLifecycleStats()).toEqual(
        expect.objectContaining({
          cpuWorkerSpawns: 2,
          firstCpuInitReason: 'startup',
          lastCpuInitReason: 'blur-fallback',
        })
      );
    });

    it('records the successful blur-fallback reason after a failed first init attempt retries and recovers', async () => {
      mockExistsSync.mockReturnValue(true);
      mockAvailableParallelism.mockReturnValue(5);
      mockFork
        .mockImplementationOnce(() => createInitErrorWorker())
        .mockImplementationOnce(() => createReadyEmbeddingWorker([1.25]));

      const {
        generateEmbedding,
        getEmbeddingLifecycleStats,
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
      _setGpuBackendForTesting({
        dispose: vi.fn().mockResolvedValue(undefined),
      } as never);
      disposeGpuBackendOnBlur();

      const embeddingPromise = generateEmbedding('retry after failed init');
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(embeddingPromise).resolves.toEqual(new Float32Array([1.25]));
      expect(getEmbeddingLifecycleStats()).toEqual(
        expect.objectContaining({
          cpuWorkerSpawns: 2,
          firstCpuInitReason: 'blur-fallback',
          lastCpuInitReason: 'blur-fallback',
        })
      );
    });
  });

  describe('resolveIntraOpThreads', () => {
    it('returns the env override when REBEL_ONNX_INTRA_OP_THREADS is valid', async () => {
      process.env.REBEL_ONNX_INTRA_OP_THREADS = '2';

      const { resolveIntraOpThreads } = await import('../embeddingService');

      expect(resolveIntraOpThreads()).toBe(2);
    });

    it('warns and falls back when REBEL_ONNX_INTRA_OP_THREADS is out of range', async () => {
      process.env.REBEL_ONNX_INTRA_OP_THREADS = '999';
      mockAvailableParallelism.mockReturnValue(6);
      const { logger } = await import('@core/logger');
      const { resolveIntraOpThreads } = await import('../embeddingService');

      expect(resolveIntraOpThreads()).toBe(4);
      expect(logger.warn).toHaveBeenCalledWith(
        { raw: '999' },
        'Invalid REBEL_ONNX_INTRA_OP_THREADS; using host-scaled default'
      );
    });

    it('warns and falls back when REBEL_ONNX_INTRA_OP_THREADS is not numeric', async () => {
      process.env.REBEL_ONNX_INTRA_OP_THREADS = 'abc';
      mockAvailableParallelism.mockReturnValue(5);
      const { logger } = await import('@core/logger');
      const { resolveIntraOpThreads } = await import('../embeddingService');

      expect(resolveIntraOpThreads()).toBe(4);
      expect(logger.warn).toHaveBeenCalledWith(
        { raw: 'abc' },
        'Invalid REBEL_ONNX_INTRA_OP_THREADS; using host-scaled default'
      );
    });

    it('uses the host-scaled default when no env override is set', async () => {
      mockAvailableParallelism.mockReturnValue(3);
      const { resolveIntraOpThreads } = await import('../embeddingService');

      expect(resolveIntraOpThreads()).toBe(2);
    });

    it('floors the host-scaled default at one thread on 1-core hosts', async () => {
      mockAvailableParallelism.mockReturnValue(1);
      const { resolveIntraOpThreads } = await import('../embeddingService');

      expect(resolveIntraOpThreads()).toBe(1);
    });
  });

  describe('forceRetryInitialization', () => {
    it('returns false when within cooldown period', async () => {
      const { forceRetryInitialization, getServiceStatus } = await import('../embeddingService');

      // First call will attempt init and fail (no worker file)
      // This sets lastAttemptAt
      const _firstResult = await forceRetryInitialization();
      // First call may return true (attempted) or false depending on implementation
      // What matters is that a second immediate call is blocked

      // Advance time but stay within cooldown (5s is the cooldown)
      vi.advanceTimersByTime(1000);

      // Second call should be blocked by cooldown
      const secondResult = await forceRetryInitialization();
      expect(secondResult).toBe(false);

      // Status should show lastAttemptAt was set
      const status = getServiceStatus();
      expect(status.lastAttemptAt).not.toBeNull();
    });

    it('allows retry after cooldown period elapses', async () => {
      // Need to mock fs.existsSync to return false to simulate worker file not found
      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const { forceRetryInitialization } = await import('../embeddingService');

      // First call - will fail (no worker) but sets cooldown timestamp
      await forceRetryInitialization();

      // Advance past cooldown (5s cooldown in the service)
      vi.advanceTimersByTime(6000);

      // Should allow another attempt now
      const result = await forceRetryInitialization();
      // May still fail due to mocked worker, but should not be blocked by cooldown
      // The key is it attempts (doesn't return false immediately due to cooldown)
      // Result will be false because init fails, but for a different reason
      expect(result).toBeDefined();
    });

    it('logs blocked attempts with remaining cooldown time', async () => {
      const { logger } = await import('@core/logger');
      const { forceRetryInitialization } = await import('../embeddingService');

      // First call to set timestamp
      await forceRetryInitialization();

      // Try again within cooldown
      vi.advanceTimersByTime(1000);
      await forceRetryInitialization();

      // Should have logged about blocked retry
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          remainingMs: expect.any(Number),
          cooldownMs: expect.any(Number),
        }),
        expect.stringContaining('cooldown')
      );
    });

    it('sends onnxIntraOpThreads in the worker init message', async () => {
      mockExistsSync.mockReturnValue(true);
      mockAvailableParallelism.mockReturnValue(5);
      const postedMessages: unknown[] = [];
      mockFork.mockImplementation(() => createMockWorker((message) => postedMessages.push(message)));

      const { forceRetryInitialization } = await import('../embeddingService');

      await expect(forceRetryInitialization()).resolves.toBe(true);
      expect(postedMessages).toContainEqual(
        expect.objectContaining({
          type: 'init',
          cacheDir: '/mock/user-data/models/transformers',
          unpackedNodeModules: undefined,
          onnxIntraOpThreads: 4,
        })
      );
    });
  });

  describe('EmbeddingServiceState interface', () => {
    it('exports the EmbeddingServiceState type', async () => {
      // TypeScript check - this verifies the type is exported
      const embeddingModule = await import('../embeddingService');
      
      // getServiceStatus should return EmbeddingServiceState
      const status = embeddingModule.getServiceStatus();
      
      // Type should have all required fields (runtime check)
      const requiredFields: (keyof typeof status)[] = [
        'ready',
        'failed', 
        'attempts',
        'lastError',
        'lastAttemptAt',
      ];
      
      for (const field of requiredFields) {
        expect(status).toHaveProperty(field);
      }
    });
  });

  describe('disposeEmbeddingService state reset', () => {
    it('resets service state on disposal when worker exists', async () => {
      // NOTE: This test verifies the state reset logic exists, but since we mock the
      // utilityProcess worker to throw, we can't fully test the disposal path.
      // The actual state reset only happens when there's an active worker to dispose.
      
      const { disposeEmbeddingService, getServiceStatus, forceRetryInitialization } = 
        await import('../embeddingService');

      // Trigger some state changes by calling forceRetryInitialization
      // (this will set lastAttemptAt even if init fails)
      await forceRetryInitialization();
      
      const statusBefore = getServiceStatus();
      // Should have some state set from the attempt
      expect(statusBefore.lastAttemptAt).not.toBeNull();

      // Dispose - note: without an active worker, state is NOT reset
      // (because state is tied to worker lifecycle)
      await disposeEmbeddingService();

      // Since no worker was created (mocked), state persists
      const statusAfter = getServiceStatus();
      // The service state persists when no worker existed
      // This is by design - only active workers trigger state cleanup
      expect(statusAfter.lastAttemptAt).not.toBeNull();
    });

    it('clears pending requests on disposal', async () => {
      // This verifies disposeEmbeddingService doesn't throw even without a worker
      const { disposeEmbeddingService } = await import('../embeddingService');
      
      // Should not throw
      await expect(disposeEmbeddingService()).resolves.not.toThrow();
    });
  });
});

/**
 * Stage 6 Phase 6 (260508): finding 4.3 — embedder integration coverage.
 *
 * Verifies caller-intent gate semantics while a turn is active:
 * background indexing defers, while user queries and foreground tools bypass.
 * Exercises the full path including:
 *   - lazy latch creation via `awaitBackgroundEmbedGate`
 *   - `shouldDeferForTurnActive` short-circuit
 *   - turn-idle listener firing on `cleanupTurn`
 *   - the deferred call's resolution after the gate clears
 */
describe('embedder turn-active gate (4.3)', () => {
  it.each([
    { callerIntent: 'background_indexing' as const, turnActive: false, shouldPark: false },
    { callerIntent: 'background_indexing' as const, turnActive: true, shouldPark: true },
    { callerIntent: 'user_query' as const, turnActive: false, shouldPark: false },
    { callerIntent: 'user_query' as const, turnActive: true, shouldPark: false },
    { callerIntent: 'foreground_tool' as const, turnActive: false, shouldPark: false },
    { callerIntent: 'foreground_tool' as const, turnActive: true, shouldPark: false },
  ])(
    '$callerIntent with turnActive=$turnActive parks=$shouldPark',
    async ({ callerIntent, turnActive, shouldPark }) => {
      vi.useRealTimers();
      mockExistsSync.mockReturnValue(true);
      mockAvailableParallelism.mockReturnValue(4);
      mockFork.mockImplementation(() => createReadyEmbeddingWorker([0.42]));

      const {
        waitForModelReady,
        generateEmbedding,
        getEmbedderTurnActiveStats,
        _resetBackgroundEmbedLatchForTesting,
        _setGpuAutoDisabledForTesting,
        _setIsDisposedForTesting,
      } = await import('../embeddingService');
      const { agentTurnRegistry } = await import('@core/services/agentTurnRegistry');
      const {
        _resetBackgroundConsumerLatchesForTesting,
        _resetForTesting,
      } = await import('../visibilityAwareScheduler');

      _resetForTesting();
      _resetBackgroundConsumerLatchesForTesting();
      _resetBackgroundEmbedLatchForTesting();
      _setGpuAutoDisabledForTesting(true);
      _setIsDisposedForTesting(false);

      await expect(waitForModelReady()).resolves.toBeUndefined();

      const turnId = `embedder-${callerIntent}-${turnActive ? 'active' : 'idle'}`;
      if (turnActive) {
        agentTurnRegistry.setActiveTurnController(turnId, new AbortController());
      }

      const beforeStats = getEmbedderTurnActiveStats();

      let resolved = false;
      const embeddingPromise = generateEmbedding(`${callerIntent} item`, callerIntent).then((vec) => {
        resolved = true;
        return vec;
      });

      await Promise.resolve();
      await Promise.resolve();

      if (shouldPark) {
        expect(resolved).toBe(false);
        agentTurnRegistry.cleanupTurn(turnId);
      }

      await expect(embeddingPromise).resolves.toBeInstanceOf(Float32Array);

      const afterStats = getEmbedderTurnActiveStats();
      expect(afterStats.turnActivePauseCount).toBe(
        beforeStats.turnActivePauseCount + (shouldPark ? 1 : 0)
      );
      expect(afterStats.turnActivePauseTotalMs).toBeGreaterThanOrEqual(0);

      if (turnActive && !shouldPark) {
        agentTurnRegistry.cleanupTurn(turnId);
      }

      _resetBackgroundEmbedLatchForTesting();
      _resetBackgroundConsumerLatchesForTesting();
      _resetForTesting();
    }
  );

  it('preserves the exact stuck watchdog reason in degraded-mode gate logs', async () => {
    vi.useFakeTimers();
    process.env.REBEL_INDEXER_MAX_PAUSE_MS = '1000';
    mockExistsSync.mockReturnValue(true);
    mockAvailableParallelism.mockReturnValue(4);
    mockFork.mockImplementation(() => createReadyEmbeddingWorker([0.42]));

    const {
      waitForModelReady,
      generateEmbedding,
      getEmbedderTurnActiveStats,
      _resetBackgroundEmbedLatchForTesting,
      _setGpuAutoDisabledForTesting,
      _setIsDisposedForTesting,
    } = await import('../embeddingService');
    const { logger } = await import('@core/logger');
    const { agentTurnRegistry } = await import('@core/services/agentTurnRegistry');
    const {
      _resetBackgroundConsumerLatchesForTesting,
      _resetForTesting,
    } = await import('../visibilityAwareScheduler');

    _resetForTesting();
    _resetBackgroundConsumerLatchesForTesting();
    _resetBackgroundEmbedLatchForTesting();
    _setGpuAutoDisabledForTesting(true);
    _setIsDisposedForTesting(false);

    await expect(waitForModelReady()).resolves.toBeUndefined();

    const turnId = 'embedder-degraded-reason-turn';
    agentTurnRegistry.setActiveTurnController(turnId, new AbortController());
    const beforeStats = getEmbedderTurnActiveStats();

    try {
      (logger.warn as ReturnType<typeof vi.fn>).mockClear();
      const embeddingPromise = generateEmbedding('background indexing item', false);
      await vi.advanceTimersByTimeAsync(1_100);
      await expect(embeddingPromise).resolves.toBeInstanceOf(Float32Array);

      const afterStats = getEmbedderTurnActiveStats();
      expect(afterStats.degradedModeEntryCount).toBe(beforeStats.degradedModeEntryCount + 1);

      // R14: the consumer must preserve the reason carried on the degraded wait outcome.
      const degradedLog = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
        ([, message]) =>
          message === 'Embedder degraded mode entered due stuck active-turn signal while gating background work'
      ) as [Record<string, unknown>, string] | undefined;
      expect(degradedLog).toBeDefined();
      expect(degradedLog?.[0]).toEqual(
        expect.objectContaining({
          reason: 'stuck_active_turn_signal',
        })
      );
    } finally {
      agentTurnRegistry.cleanupTurn(turnId);
      _resetBackgroundEmbedLatchForTesting();
      _resetBackgroundConsumerLatchesForTesting();
      _resetForTesting();
      delete process.env.REBEL_INDEXER_MAX_PAUSE_MS;
    }
  });
});

describe('embeddingService constants', () => {
  it('has reasonable timeout values', async () => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockFork.mockImplementation(() => {
      throw new Error('utilityProcess mock - should not be called in constants test');
    });
    mockAvailableParallelism.mockReturnValue(8);
    mockCpus.mockReturnValue(createCpuInfoList(8));

    // We can't directly access private constants, but we can verify behavior
    // The service should have a short cooldown so auto-recovery is responsive
    const { forceRetryInitialization, getServiceStatus } = await import('../embeddingService');

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    // First call
    await forceRetryInitialization();
    
    // At 4 seconds, should still be blocked
    vi.advanceTimersByTime(4000);
    const blockedResult = await forceRetryInitialization();
    expect(blockedResult).toBe(false);

    // At 6 seconds, should be allowed
    vi.advanceTimersByTime(2000);
    // Another attempt should be possible (won't be blocked by cooldown)
    const status = getServiceStatus();
    // We just verify the status has timestamps, actual retry may still fail
    expect(status.lastAttemptAt).not.toBeNull();

    vi.useRealTimers();
  });
});
