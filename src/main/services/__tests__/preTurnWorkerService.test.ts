import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';

const generateQueryEmbeddingMock = vi.fn();
const generateSearchQueriesMock = vi.fn();
const parseSearchKeywordsMock = vi.fn();
const getSettingsMock = vi.fn();
const addBreadcrumbMock = vi.fn();
const captureExceptionMock = vi.fn();

// Mock logger BEFORE imports
const mockLoggerMethods = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn()
};
vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLoggerMethods,
  logger: mockLoggerMethods
}));

vi.mock('@core/platform', () => ({
  getPlatformConfig: vi.fn(() => ({
    isPackaged: false,
    appPath: '/mock/app/path',
    userDataPath: '/mock/userData',
  })),
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    addBreadcrumb: addBreadcrumbMock,
    captureException: captureExceptionMock,
  }),
}));

vi.mock('../embeddingService', () => ({
  generateQueryEmbedding: generateQueryEmbeddingMock,
}));

vi.mock('../semanticContextService', () => ({
  parseSearchKeywords: parseSearchKeywordsMock,
}));

vi.mock('@core/services/queryGenerationService', () => ({
  generateSearchQueries: generateSearchQueriesMock,
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: getSettingsMock,
}));

// Create mock worker factory
function createMockWorker(autoReady = true) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const eventHandlers = new Map<string, (data: unknown) => void>();

  return {
    stdout,
    stderr,
    pid: 12345,
    on: vi.fn((event: string, handler: (data: unknown) => void) => {
      eventHandlers.set(event, handler);
    }),
    postMessage: vi.fn((msg: { type: string; config?: unknown }) => {
      // Simulate worker ready response after init
      if (autoReady && msg.type === 'init') {
        setTimeout(() => {
          const messageHandler = eventHandlers.get('message');
          if (messageHandler) {
            messageHandler({ type: 'ready' });
          }
        }, 10);
      }
    }),
    kill: vi.fn(),
    _emitMessage: (msg: unknown) => {
      const handler = eventHandlers.get('message');
      if (handler) handler(msg);
    },
    _emitExit: (code: number) => {
      const handler = eventHandlers.get('exit');
      if (handler) handler(code);
    }
  };
}

let mockWorker: ReturnType<typeof createMockWorker>;

// Mock electron BEFORE imports
const mockElectronModule = {
  app: {
    isPackaged: false,
    getAppPath: () => '/mock/app/path',
    getPath: (name: string) => {
      if (name === 'userData') return '/mock/userData';
      return '/mock/path';
    },
    on: vi.fn(),
  },
  utilityProcess: {
    fork: vi.fn(() => mockWorker)
  }
};

vi.mock('electron', () => mockElectronModule);

vi.mock('@core/lazyElectron', () => ({
  getElectronModule: () => mockElectronModule,
  onElectronAppEvent: vi.fn(),
}));

// Mock fs to control worker path existence
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((path: string) => {
        // Return true for worker path checks
        if (path.includes('preTurnWorker.js')) return true;
        if (path.includes('models') || path.includes('transformers')) return true;
        return false;
      }),
      mkdirSync: vi.fn()
    },
    existsSync: vi.fn((path: string) => {
      if (path.includes('preTurnWorker.js')) return true;
      if (path.includes('models') || path.includes('transformers')) return true;
      return false;
    }),
    mkdirSync: vi.fn()
  };
});

// Mock sentry to avoid electron dependency in tests
vi.mock('../../sentry', () => ({
  recordMainBreadcrumb: vi.fn(),
}));

// Import after mocks
let waitForWorkerReady: typeof import('../preTurnWorkerService').waitForWorkerReady;
let disposeWorker: typeof import('../preTurnWorkerService').disposeWorker;
let assemblePreTurnContext: typeof import('../preTurnWorkerService').assemblePreTurnContext;
let getWorkerStatus: typeof import('../preTurnWorkerService').getWorkerStatus;
let getPreTurnWorkerStats: typeof import('../preTurnWorkerService').getPreTurnWorkerStats;
let utilityProcessFork: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  const module = await import('../preTurnWorkerService');
  waitForWorkerReady = module.waitForWorkerReady;
  disposeWorker = module.disposeWorker;
  assemblePreTurnContext = module.assemblePreTurnContext;
  getWorkerStatus = module.getWorkerStatus;
  getPreTurnWorkerStats = module.getPreTurnWorkerStats;

  // Collapse the production 2s LanceDB-cleanup wait in doDispose() to 0 for the
  // whole suite. Every test's afterEach calls disposeWorker(); the real 2s × N
  // tests dominated this file's CI runtime (~24s). Behaviour under test is
  // unchanged — only the disposal delay, which no test asserts on, is shortened.
  module._setDisposeCleanupMsForTests(0);

  const electron = await import('electron');
  utilityProcessFork = electron.utilityProcess.fork as ReturnType<typeof vi.fn>;
});

beforeEach(() => {
  vi.clearAllMocks();
  mockLoggerMethods.info.mockClear();
  mockLoggerMethods.warn.mockClear();
  mockLoggerMethods.error.mockClear();
  mockLoggerMethods.debug.mockClear();
  parseSearchKeywordsMock.mockReturnValue({ hasExplicitSearch: false, sanitizedPrompt: 'sanitized prompt' });
  generateSearchQueriesMock.mockResolvedValue(null);
  generateQueryEmbeddingMock.mockResolvedValue(new Float32Array([0.1, 0.2, 0.3]));
  getSettingsMock.mockReturnValue({ behindTheScenesModel: 'claude-sonnet-4-5' });
  addBreadcrumbMock.mockReset();
  captureExceptionMock.mockReset();
  mockWorker = createMockWorker();
});

afterEach(async () => {
  // Clean up worker state between tests
  await disposeWorker().catch(() => undefined);
});

describe('preTurnWorkerService pipe draining', () => {
  describe('worker initialization', () => {
    it('calls utilityProcess.fork with stdio: "pipe"', async () => {
      const readyPromise = waitForWorkerReady('/test/workspace');

      await readyPromise;

      expect(utilityProcessFork).toHaveBeenCalledWith(
        expect.stringContaining('preTurnWorker.js'),
        [],
        expect.objectContaining({
          serviceName: 'Pre-Turn Context Worker',
          stdio: 'pipe'
        })
      );
    });

    it('attaches handlers to stdout and stderr pipes', async () => {
      const readyPromise = waitForWorkerReady('/test/workspace');

      await readyPromise;

      // Verify stdout.on was called (via the PassThrough stream's listeners)
      expect(mockWorker.stdout.listenerCount('data')).toBeGreaterThan(0);
      expect(mockWorker.stderr.listenerCount('data')).toBeGreaterThan(0);
    });
  });

  describe('bounded logging for stdout', () => {
    it('logs stdout output at debug level', async () => {
      await waitForWorkerReady('/test/workspace');

      // Write some data to stdout
      mockWorker.stdout.write(Buffer.from('test output line\n'));

      // Give time for async handlers
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockLoggerMethods.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          output: 'test output line',
          source: 'pre-turn-worker-stdout'
        }),
        'Worker stdout'
      );
    });

    it('stops logging after 100 stdout lines but continues draining', async () => {
      await waitForWorkerReady('/test/workspace');

      // Clear previous debug calls
      mockLoggerMethods.debug.mockClear();

      // Write 150 lines to stdout
      for (let i = 0; i < 150; i++) {
        mockWorker.stdout.write(Buffer.from(`line ${i}\n`));
      }

      // Give time for async handlers
      await new Promise(resolve => setTimeout(resolve, 50));

      // Count debug calls with stdout source
      const stdoutDebugCalls = mockLoggerMethods.debug.mock.calls.filter(
        call => call[0]?.source === 'pre-turn-worker-stdout'
      );

      // Should have exactly 100 log calls (the bounded limit)
      expect(stdoutDebugCalls.length).toBe(100);

      // Verify the pipe is still being drained (no error thrown, process not blocked)
      // We can verify this by writing more data successfully
      const moreWriteResult = mockWorker.stdout.write(Buffer.from('more data\n'));
      expect(moreWriteResult).toBe(true);
    });
  });

  describe('bounded logging for stderr', () => {
    it('logs stderr output at warn level', async () => {
      await waitForWorkerReady('/test/workspace');

      // Write some data to stderr
      mockWorker.stderr.write(Buffer.from('error message\n'));

      // Give time for async handlers
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockLoggerMethods.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'error message',
          source: 'pre-turn-worker-stderr'
        }),
        'Worker stderr'
      );
    });

    it('stops logging after 100 stderr lines but continues draining', async () => {
      await waitForWorkerReady('/test/workspace');

      // Clear previous warn calls
      mockLoggerMethods.warn.mockClear();

      // Write 150 lines to stderr
      for (let i = 0; i < 150; i++) {
        mockWorker.stderr.write(Buffer.from(`error ${i}\n`));
      }

      // Give time for async handlers
      await new Promise(resolve => setTimeout(resolve, 50));

      // Count warn calls with stderr source
      const stderrWarnCalls = mockLoggerMethods.warn.mock.calls.filter(
        call => call[0]?.source === 'pre-turn-worker-stderr'
      );

      // Should have exactly 100 log calls (the bounded limit)
      expect(stderrWarnCalls.length).toBe(100);

      // Verify the pipe is still being drained
      const moreWriteResult = mockWorker.stderr.write(Buffer.from('more errors\n'));
      expect(moreWriteResult).toBe(true);
    });
  });

  describe('empty output handling', () => {
    it('does not log empty stdout output', async () => {
      await waitForWorkerReady('/test/workspace');

      mockLoggerMethods.debug.mockClear();

      // Write whitespace-only data
      mockWorker.stdout.write(Buffer.from('   \n'));
      mockWorker.stdout.write(Buffer.from('\n'));
      mockWorker.stdout.write(Buffer.from('\t\n'));

      await new Promise(resolve => setTimeout(resolve, 10));

      const stdoutDebugCalls = mockLoggerMethods.debug.mock.calls.filter(
        call => call[0]?.source === 'pre-turn-worker-stdout'
      );

      expect(stdoutDebugCalls.length).toBe(0);
    });

    it('does not log empty stderr output', async () => {
      await waitForWorkerReady('/test/workspace');

      mockLoggerMethods.warn.mockClear();

      // Write whitespace-only data
      mockWorker.stderr.write(Buffer.from('   \n'));
      mockWorker.stderr.write(Buffer.from('\n'));

      await new Promise(resolve => setTimeout(resolve, 10));

      const stderrWarnCalls = mockLoggerMethods.warn.mock.calls.filter(
        call => call[0]?.source === 'pre-turn-worker-stderr'
      );

      expect(stderrWarnCalls.length).toBe(0);
    });
  });
});

describe('preTurnWorkerService crash cooldown', () => {
  it('temporarily cools down after repeated crashes and retries later', async () => {
    await disposeWorker().catch(() => undefined);
    vi.useFakeTimers();
    try {
      mockWorker = createMockWorker(false);
      const readyPromise = waitForWorkerReady('/test/workspace').catch((error: Error) => error);

      mockWorker._emitExit(1);
      await readyPromise;

      mockWorker = createMockWorker(false);
      await vi.advanceTimersByTimeAsync(1_000);
      const secondReadyPromise = waitForWorkerReady('/test/workspace').catch((error: Error) => error);

      mockWorker._emitExit(1);
      await secondReadyPromise;
      mockWorker = createMockWorker(false);
      await vi.advanceTimersByTimeAsync(1_000);
      const thirdReadyPromise = waitForWorkerReady('/test/workspace').catch((error: Error) => error);

      mockWorker._emitExit(1);
      await thirdReadyPromise;
      let status = getWorkerStatus();
      expect(status.permanentlyDisabled).toBe(false);
      expect(status.crashCooldownRemainingMs).toBeGreaterThan(0);
      expect(captureExceptionMock).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Pre-turn worker disabled temporarily after repeated crashes' }),
        expect.objectContaining({
          tags: { area: 'agent', component: 'pre-turn-worker' },
          extra: expect.objectContaining({ cooldownMs: 60_000 }),
        }),
      );

      await expect(waitForWorkerReady('/test/workspace')).rejects.toThrow(/cooling down/);

      mockWorker = createMockWorker();
      await vi.advanceTimersByTimeAsync(60_020);
      status = getWorkerStatus();
      expect(status.permanentlyDisabled).toBe(false);
      expect(status.crashCooldownRemainingMs).toBe(0);
      expect(getWorkerStatus().isReady).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('assemblePreTurnContext tool search intent', () => {
  it('passes toolSearchIntentionallySkipped when smart queries say no tools are needed', async () => {
    generateSearchQueriesMock.mockResolvedValue({
      file_query: 'workspace history',
      tool_query: '',
      conversation_query: '',
      skill_query: '',
    });

    const requestPromise = assemblePreTurnContext('/test/workspace', {
      prompt: 'let’s have a whimsical conversation',
    });

    // Wait for async search-query generation + embedding to post the worker message
    await vi.waitFor(() => {
      expect(mockWorker.postMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    const [, workerRequestCall] = mockWorker.postMessage.mock.calls;
    const workerRequest = workerRequestCall?.[0] as {
      type: string;
      id: string;
      request: {
        prompt: string;
        toolSearchIntentionallySkipped?: boolean;
        fileQueryText?: string;
        toolQueryEmbedding?: unknown;
      };
    };

    expect(workerRequest).toMatchObject({
      type: 'preTurnContext',
      request: expect.objectContaining({
        prompt: 'let’s have a whimsical conversation',
        toolSearchIntentionallySkipped: true,
        fileQueryText: 'workspace history',
      }),
    });
    expect(workerRequest.request.toolQueryEmbedding).toBeUndefined();

    const requestId = workerRequest.id;
    mockWorker._emitMessage({
      type: 'preTurnResult',
      id: requestId,
      result: { toolSearchStatus: 'skipped' },
    });

    await expect(requestPromise).resolves.toEqual({ toolSearchStatus: 'skipped' });
  });

  it('passes toolIndexUsable=false and skips tool embeddings when index is stale', async () => {
    generateSearchQueriesMock.mockResolvedValue({
      file_query: 'project status',
      tool_query: 'send an email update',
      conversation_query: '',
      skill_query: '',
    });

    const requestPromise = assemblePreTurnContext('/test/workspace', {
      prompt: 'send an email update about project status',
      toolIndexUsable: false,
    });

    await vi.waitFor(() => {
      expect(mockWorker.postMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    const [, workerRequestCall] = mockWorker.postMessage.mock.calls;
    const workerRequest = workerRequestCall?.[0] as {
      type: string;
      id: string;
      request: {
        prompt: string;
        toolIndexUsable?: boolean;
        toolQueryEmbedding?: unknown;
      };
    };

    expect(workerRequest).toMatchObject({
      type: 'preTurnContext',
      request: expect.objectContaining({
        prompt: 'send an email update about project status',
        toolIndexUsable: false,
      }),
    });
    expect(workerRequest.request.toolQueryEmbedding).toBeUndefined();
    expect(generateQueryEmbeddingMock).toHaveBeenCalledTimes(1);

    mockWorker._emitMessage({
      type: 'preTurnResult',
      id: workerRequest.id,
      result: { toolSearchStatus: 'unavailable' },
    });

    await expect(requestPromise).resolves.toEqual({ toolSearchStatus: 'unavailable' });
  });
});

describe('preTurnWorkerService stats tracking', () => {
  it('tracks spawn count, restarts, and duration stats correctly', async () => {
    // Initial state after waitForWorkerReady
    await waitForWorkerReady('/test/workspace');
    const initialStats = getPreTurnWorkerStats();
    expect(initialStats.since).toBe('app_start');
    expect(initialStats.spawnCount).toBeGreaterThan(0);
    expect(initialStats.restartCount).toBeGreaterThanOrEqual(0);

    const prevRestartCount = initialStats.restartCount;

    // Simulate crash with exit code that maps to OOM (134)
    mockWorker._emitExit(134);
    
    // Wait for the restart
    await waitForWorkerReady('/test/workspace').catch(() => {});
    
    const crashStats = getPreTurnWorkerStats();
    expect(crashStats.restartCount).toBe(prevRestartCount + 1);
    expect(crashStats.lastCrashCategory).toBe('oom');
    expect(crashStats.lastCrashAt).toBeDefined();

    // Simulate an RPC to track duration
    const requestPromise = assemblePreTurnContext('/test/workspace', { prompt: 'test' });
    
    // Wait for the message to be sent
    await vi.waitFor(() => {
      expect(mockWorker.postMessage.mock.calls.some(call => call[0].type === 'preTurnContext')).toBe(true);
    });
    
    const requestCall = mockWorker.postMessage.mock.calls.find(call => call[0].type === 'preTurnContext');
    expect(requestCall).toBeDefined();
    if (!requestCall) {
      throw new Error('Expected preTurnContext request call');
    }
    const requestMessage = requestCall[0] as { type: string; config?: unknown; id?: unknown };
    expect(typeof requestMessage.id).toBe('string');
    if (typeof requestMessage.id !== 'string') {
      throw new Error('Expected preTurnContext message id');
    }
    const requestId = requestMessage.id;
    
    // Resolve the RPC
    mockWorker._emitMessage({
      type: 'preTurnResult',
      id: requestId,
      result: { toolSearchStatus: 'skipped' },
    });
    
    await requestPromise;
    
    const finalStats = getPreTurnWorkerStats();
    expect(finalStats.averagePreTurnDurationBucket).toBeDefined();
    expect(['<100ms', '<500ms', '<2s', '>=2s']).toContain(finalStats.averagePreTurnDurationBucket);
  });
});

