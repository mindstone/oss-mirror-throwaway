import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DAY_MS = 24 * 60 * 60 * 1000;
const DATA_PATH = '/mock/userData';
const HISTORY_PATH = `${DATA_PATH}/preturn-worker-history.json`;

const mocks = vi.hoisted(() => {
  type EventHandler = (data: unknown) => void;

  const files = new Map<string, string>();
  const operations: Array<{ op: string; path: string; to?: string }> = [];
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };

  const makeWorker = () => {
    const handlers = new Map<string, EventHandler>();
    return {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      pid: 12345,
      on: vi.fn((event: string, handler: EventHandler) => {
        handlers.set(event, handler);
      }),
      postMessage: vi.fn((msg: { type: string }) => {
        if (msg.type === 'init') {
          handlers.get('message')?.({ type: 'ready' });
        }
      }),
      kill: vi.fn(),
      _emitExit: (code: number) => {
        handlers.get('exit')?.(code);
      },
    };
  };

  return {
    files,
    operations,
    logger,
    getDataPathMock: vi.fn(() => '/mock/userData'),
    makeWorker,
    state: {
      currentWorker: null as ReturnType<typeof makeWorker> | null,
    },
    addBreadcrumbMock: vi.fn(),
    captureExceptionMock: vi.fn(),
  };
});

type MockWorker = ReturnType<typeof mocks.makeWorker>;

 
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (filePath: string) => {
    mocks.operations.push({ op: 'readFile', path: filePath });
    const value = mocks.files.get(filePath);
    if (value === undefined) {
      const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return value;
  }),
  mkdir: vi.fn(async (dirPath: string) => {
    mocks.operations.push({ op: 'mkdir', path: dirPath });
  }),
  writeFile: vi.fn(async (filePath: string, data: string) => {
    mocks.operations.push({ op: 'writeFile', path: filePath });
    mocks.files.set(filePath, data);
  }),
  rename: vi.fn(async (fromPath: string, toPath: string) => {
    mocks.operations.push({ op: 'rename', path: fromPath, to: toPath });
    const value = mocks.files.get(fromPath);
    if (value === undefined) {
      const error = new Error(`ENOENT: no such file or directory, rename '${fromPath}'`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    mocks.files.set(toPath, value);
    mocks.files.delete(fromPath);
  }),
}));

 
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const existsSync = vi.fn((filePath: string) => filePath.includes('preTurnWorker.js'));
  return {
    ...actual,
    default: {
      ...actual,
      existsSync,
    },
    existsSync,
  };
});

 
vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: mocks.getDataPathMock,
}));

 
vi.mock('@core/platform', () => ({
  getPlatformConfig: vi.fn(() => ({
    isPackaged: false,
    appPath: '/mock/app/path',
    userDataPath: '/mock/userData',
  })),
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => mocks.logger,
  logger: mocks.logger,
}));

 
vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    addBreadcrumb: mocks.addBreadcrumbMock,
    captureException: mocks.captureExceptionMock,
  }),
}));

 
vi.mock('@core/lazyElectron', () => ({
  getElectronModule: () => ({
    utilityProcess: {
      fork: vi.fn(() => {
        if (!mocks.state.currentWorker) {
          mocks.state.currentWorker = mocks.makeWorker();
        }
        return mocks.state.currentWorker;
      }),
    },
  }),
}));

 
vi.mock('../embeddingService', () => ({
  generateQueryEmbedding: vi.fn(),
}));

 
vi.mock('../semanticContextService', () => ({
  parseSearchKeywords: vi.fn(),
}));

 
vi.mock('@core/services/queryGenerationService', () => ({
  generateSearchQueries: vi.fn(),
}));

 
vi.mock('@core/services/urlDetectionService', () => ({
  sanitizeUrlsForEmbedding: vi.fn((value: string) => value),
}));

 
vi.mock('@core/services/settingsStore', () => ({
  getSettings: vi.fn(() => ({})),
}));

async function importService(): Promise<typeof import('../preTurnWorkerService')> {
  return import('../preTurnWorkerService');
}

async function startWorker(): Promise<{
  service: typeof import('../preTurnWorkerService');
  worker: MockWorker;
}> {
  const service = await importService();
  await service.waitForWorkerReady('/test/workspace');
  const worker = mocks.state.currentWorker;
  if (!worker) {
    throw new Error('Expected worker to be created');
  }
  return { service, worker };
}

function readPersistedHistory(): unknown {
  const raw = mocks.files.get(HISTORY_PATH);
  if (!raw) {
    throw new Error('Expected persisted pre-turn worker history file');
  }
  return JSON.parse(raw);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-08T00:00:00.000Z'));
  vi.resetModules();
  mocks.files.clear();
  mocks.operations.length = 0;
  mocks.state.currentWorker = mocks.makeWorker();
  mocks.logger.info.mockClear();
  mocks.logger.warn.mockClear();
  mocks.logger.error.mockClear();
  mocks.logger.debug.mockClear();
  mocks.logger.trace.mockClear();
  mocks.getDataPathMock.mockClear();
  mocks.addBreadcrumbMock.mockClear();
  mocks.captureExceptionMock.mockClear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('preTurnWorkerHistory persistence', () => {
  it('returns empty persisted stats when no history file exists', async () => {
    const { service } = await startWorker();

    expect(service.getPreTurnWorkerStats()).toEqual(expect.objectContaining({
      persistedLastCrashAt: undefined,
      persistedLastCrashCategory: undefined,
      crashesInLast7Days: 0,
      totalCrashesAllTime: 0,
    }));
    expect(mocks.operations).toContainEqual({ op: 'readFile', path: HISTORY_PATH });
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('continues with empty history and logs a structured warning on parse error', async () => {
    mocks.files.set(HISTORY_PATH, '{ definitely-not-json');

    const { service } = await startWorker();

    expect(service.getPreTurnWorkerStats()).toEqual(expect.objectContaining({
      persistedLastCrashAt: undefined,
      persistedLastCrashCategory: undefined,
      crashesInLast7Days: 0,
      totalCrashesAllTime: 0,
    }));
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ historyPath: HISTORY_PATH, err: expect.any(SyntaxError) }),
      'Failed to read pre-turn worker crash history; starting with empty history',
    );
  });

  it('appends a crash entry and can read it back from disk', async () => {
    const { service, worker } = await startWorker();

    worker._emitExit(134);
    await service._getLastPreTurnWorkerHistoryWriteForTests();

    const persisted = readPersistedHistory();
    expect(persisted).toEqual({
      v: 1,
      recentCrashes: [{ at: Date.now(), category: 'oom' }],
      lastCrashAt: Date.now(),
      lastCrashCategory: 'oom',
      totalCrashesAllTime: 1,
    });

    const { readPreTurnWorkerHistory } = await import('../preTurnWorkerHistory');
    await expect(readPreTurnWorkerHistory(DATA_PATH)).resolves.toEqual(persisted);
  });

  it('prunes crashes outside the 7-day rolling window while retaining the all-time counter', async () => {
    const now = Date.now();
    mocks.files.set(HISTORY_PATH, JSON.stringify({
      v: 1,
      recentCrashes: [{ at: now - (10 * DAY_MS), category: 'unknown' }],
      lastCrashAt: now - (10 * DAY_MS),
      lastCrashCategory: 'unknown',
      totalCrashesAllTime: 7,
    }));
    const { service, worker } = await startWorker();

    worker._emitExit(134);
    await service._getLastPreTurnWorkerHistoryWriteForTests();

    expect(readPersistedHistory()).toEqual({
      v: 1,
      recentCrashes: [{ at: now, category: 'oom' }],
      lastCrashAt: now,
      lastCrashCategory: 'oom',
      totalCrashesAllTime: 8,
    });
  });

  it('writes through a temporary file before atomic rename', async () => {
    const { service, worker } = await startWorker();

    worker._emitExit(134);
    await service._getLastPreTurnWorkerHistoryWriteForTests();

    const writeIndex = mocks.operations.findIndex((operation) => operation.op === 'writeFile');
    const renameIndex = mocks.operations.findIndex((operation) => operation.op === 'rename');
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(renameIndex).toBeGreaterThan(writeIndex);
    expect(mocks.operations[writeIndex]).toEqual({ op: 'writeFile', path: `${HISTORY_PATH}.tmp` });
    expect(mocks.operations[renameIndex]).toEqual({
      op: 'rename',
      path: `${HISTORY_PATH}.tmp`,
      to: HISTORY_PATH,
    });
  });

  it('exposes persisted crash fields in the stats snapshot after a crash', async () => {
    const { service, worker } = await startWorker();

    worker._emitExit(134);
    await service._getLastPreTurnWorkerHistoryWriteForTests();

    expect(service.getPreTurnWorkerStats()).toEqual(expect.objectContaining({
      persistedLastCrashAt: Date.now(),
      persistedLastCrashCategory: 'oom',
      crashesInLast7Days: 1,
      totalCrashesAllTime: 1,
    }));
  });
});
