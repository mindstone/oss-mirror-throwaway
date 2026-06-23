import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

 

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
    getActiveTurnCount: () => 0,
    onDrained: vi.fn(),
  },
}));

const mockClassifyByPid = vi.fn();
const mockKillProcessTreeIfStillIdentity = vi.fn();
vi.mock('../superMcpOwnershipClassifier', () => ({
  classifyByPid: (...args: unknown[]) => mockClassifyByPid(...args),
  killProcessTreeIfStillIdentity: (...args: unknown[]) =>
    mockKillProcessTreeIfStillIdentity(...args),
}));

const mockExec = vi.fn(
  (command: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    if (command.startsWith('lsof -iTCP:')) {
      callback(null, '4321\n', '');
      return;
    }
    callback(null, '', '');
  },
);

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  exec: (command: string, callback: (error: Error | null, stdout: string, stderr: string) => void) =>
    mockExec(command, callback),
}));

vi.mock('@core/processSpawner', () => ({
  getProcessSpawner: () => ({
    spawn: vi.fn(),
    exec: vi.fn(async (command: string) => {
      return await new Promise<{ stdout: string; stderr: string; error: Error | null }>((resolve) => {
        mockExec(command, (err, stdout, stderr) => resolve({ stdout, stderr, error: err }));
      });
    }),
    kill: vi.fn(() => true),
    waitForExit: vi.fn(async () => ({ code: 0, signal: null, timedOut: false })),
  }),
  setProcessSpawnerFactory: vi.fn(),
}));

vi.mock('node:net', () => {
  const netMock = {
    createServer: vi.fn(() => {
      const server = new EventEmitter() as EventEmitter & {
        listen: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        unref: ReturnType<typeof vi.fn>;
      };
      server.listen = vi.fn((_port: number, _host: string) => {
        process.nextTick(() => {
          const error = Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' });
          server.emit('error', error);
        });
      });
      server.close = vi.fn((cb?: () => void) => {
        if (cb) cb();
      });
      server.unref = vi.fn();
      return server;
    }),
  };

  return {
    ...netMock,
    default: netMock,
  };
});

vi.mock('node:fs/promises', () => ({
  default: {
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    unlink: vi.fn(),
    rename: vi.fn(),
  },
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
  rename: vi.fn(),
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

import { findAvailablePort } from '../superMcpHttpManager';

describe('findAvailablePort orphan cleanup protections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClassifyByPid.mockResolvedValue({
      decision: 'protected',
      reason: 'owner-alive-via-cmdline-tag',
      identity: {
        pid: 4321,
        observedStartTimeMs: 1_730_000_000_000,
      },
      ownerSnapshot: {
        ownerPid: 9999,
      },
    });
    mockKillProcessTreeIfStillIdentity.mockResolvedValue({
      killed: true,
      reason: 'killed',
    });
  });

  it('F4 scenario: protected classifier result prevents kill in range cleanup', async () => {
    await expect(findAvailablePort(3200, 1)).rejects.toThrow(
      /Unable to find available port starting at 3200/,
    );

    expect(mockClassifyByPid).toHaveBeenCalledWith(4321);
    expect(mockKillProcessTreeIfStillIdentity).not.toHaveBeenCalled();
  });
});
