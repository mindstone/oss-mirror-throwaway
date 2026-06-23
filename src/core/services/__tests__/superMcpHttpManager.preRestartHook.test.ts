import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const mockSpawn = vi.hoisted(() => vi.fn());
const mockExec = vi.hoisted(() => vi.fn());
const mockGetActiveTurnCount = vi.hoisted(() => vi.fn(() => 0));
const mockOnDrained = vi.hoisted(() => vi.fn());
const mockOwnerRegistry = vi.hoisted(() => ({
  register: vi.fn().mockResolvedValue(undefined),
  unregister: vi.fn().mockResolvedValue(undefined),
  startHeartbeatTimer: vi.fn(),
  stopHeartbeatTimer: vi.fn(),
  attachChild: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@core/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    captureException: vi.fn(),
  }),
}));

vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-data',
  isPackaged: () => false,
  getAppRoot: () => '/tmp/test-app',
}));

vi.mock('@core/utils/buildChannel', () => ({
  getBuildChannel: () => 'dev',
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: () => ({ coreDirectory: '/tmp/test-core' }),
}));

vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getActiveTurnCount: () => mockGetActiveTurnCount(),
    onDrained: (cb: () => void) => mockOnDrained(cb),
  },
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  exec: (command: string, callback: (error: Error | null, stdout: string, stderr: string) => void) =>
    mockExec(command, callback),
}));

vi.mock('@core/processSpawner', () => ({
  getProcessSpawner: () => ({
    spawn: (...args: Parameters<typeof mockSpawn>) => mockSpawn(...args),
    exec: vi.fn(async (command: string) => {
      return await new Promise<{ stdout: string; stderr: string; error: Error | null }>((resolve) => {
        mockExec(command, (err: Error | null, stdout: string, stderr: string) =>
          resolve({ stdout, stderr, error: err }),
        );
      });
    }),
    kill: vi.fn(() => true),
    waitForExit: vi.fn(async () => ({ code: 0, signal: null, timedOut: false })),
  }),
  setProcessSpawnerFactory: vi.fn(),
}));

vi.mock('@core/utils/processStartTime', () => ({
  getProcessStartTimeMs: vi.fn().mockResolvedValue(1_730_000_000_000),
}));

vi.mock('../superMcpOwnerRegistrySingleton', () => ({
  getOwnerRegistry: () => mockOwnerRegistry,
}));

vi.mock('../superMcpOwnerTag', () => ({
  buildOwnerTagArgs: () => [],
}));

vi.mock('../superMcpOwnershipClassifier', () => ({
  classifyByPid: vi.fn(),
  killProcessTreeIfStillIdentity: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockImplementation(async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  },
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockImplementation(async () => {
    const error = new Error('ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    throw error;
  }),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    openSync: vi.fn().mockReturnValue(42),
    closeSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(true),
  openSync: vi.fn().mockReturnValue(42),
  closeSync: vi.fn(),
}));

import { SuperMcpHttpManager } from '../superMcpHttpManager';

class MockChildProcess extends EventEmitter {
  public readonly pid: number;
  public killed = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  public unref = vi.fn();

  public kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function createConfiguredManager(): SuperMcpHttpManager {
  const manager = new SuperMcpHttpManager();
  manager.configure({
    enabled: true,
    port: 3200,
    configPath: '/tmp/test-config.json',
    startupTimeoutMs: 5000,
    healthCheckIntervalMs: 200,
  });
  const managerPrivate = manager as unknown as {
    waitForServerReady: () => Promise<void>;
    fetchSkippedServers: () => Promise<void>;
  };
  vi.spyOn(managerPrivate, 'waitForServerReady').mockResolvedValue(undefined);
  vi.spyOn(managerPrivate, 'fetchSkippedServers').mockResolvedValue(undefined);
  return manager;
}

function asPrivate(manager: SuperMcpHttpManager): { restartNow: () => Promise<void> } {
  return manager as unknown as ReturnType<typeof asPrivate>;
}

async function waitForSpawnCallCount(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (mockSpawn.mock.calls.length >= expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for spawn call count ${expected}`);
}

describe('SuperMcpHttpManager.setPreRestartHook', () => {
  let nextPid = 10_000;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveTurnCount.mockReturnValue(0);
    mockExec.mockImplementation((_: string, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, '', '');
    });
    mockSpawn.mockImplementation(() => new MockChildProcess(nextPid += 1));
  });

  it('fires the hook exactly once before spawn on start()', async () => {
    const manager = createConfiguredManager();
    const callOrder: string[] = [];
    mockSpawn.mockImplementation(() => {
      callOrder.push('spawn');
      return new MockChildProcess(nextPid += 1);
    });

    manager.setPreRestartHook(() => {
      callOrder.push('hook');
    });
    await manager.start();

    expect(callOrder).toEqual(['hook', 'spawn']);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('fires the hook exactly once before spawn on restart()', async () => {
    const manager = createConfiguredManager();
    const callOrder: string[] = [];
    mockSpawn.mockImplementation(() => {
      callOrder.push('spawn');
      return new MockChildProcess(nextPid += 1);
    });

    manager.setPreRestartHook(() => {
      callOrder.push('hook');
    });
    await asPrivate(manager).restartNow();

    expect(callOrder).toEqual(['hook', 'spawn']);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('fires the hook exactly once before spawn on scheduleRestartWhenIdle()', async () => {
    const manager = createConfiguredManager();
    const callOrder: string[] = [];
    mockSpawn.mockImplementation(() => {
      callOrder.push('spawn');
      return new MockChildProcess(nextPid += 1);
    });

    manager.setPreRestartHook(() => {
      callOrder.push('hook');
    });
    manager.scheduleRestartWhenIdle();
    await waitForSpawnCallCount(1);

    expect(callOrder).toEqual(['hook', 'spawn']);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('fires the hook exactly once before spawn on debouncedRestart()', async () => {
    vi.useFakeTimers();
    try {
      const manager = createConfiguredManager();
      const callOrder: string[] = [];
      mockSpawn.mockImplementation(() => {
        callOrder.push('spawn');
        return new MockChildProcess(nextPid += 1);
      });

      manager.setPreRestartHook(() => {
        callOrder.push('hook');
      });

      const debounced = manager.requestDebouncedRestartWhenIdle({
        configPath: '/tmp/test-config.json',
        context: 'workspace-change',
      });
      await vi.advanceTimersByTimeAsync(3000);
      await debounced;

      expect(callOrder).toEqual(['hook', 'spawn']);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts spawn when the hook throws', async () => {
    const manager = createConfiguredManager();
    manager.setPreRestartHook(() => {
      throw new Error('pre-restart hook failed');
    });

    await expect(manager.start()).rejects.toThrow('pre-restart hook failed');
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
