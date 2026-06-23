import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

// Mock global fetch to prevent real network requests during tests
const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  status: 200,
  json: async () => ({ packages: [] }),
});
vi.stubGlobal('fetch', mockFetch);

// Mock error reporter BEFORE imports
const mockCaptureException = vi.fn();
vi.mock('@core/errorReporter', () => ({
  setErrorReporter: vi.fn(),
  getErrorReporter: () => ({
    captureException: mockCaptureException,
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  }),
}));

// Mock core settingsStore (superMcpHttpManager now imports from @core/)
vi.mock('@core/services/settingsStore', () => ({
  getSettings: () => ({ coreDirectory: '' }),
  updateSettings: vi.fn(),
  setSettingsStoreAdapter: vi.fn(),
}));

 
vi.mock('@core/utils/processStartTime', () => ({
  getProcessStartTimeMs: vi.fn(() => Promise.resolve(1_730_000_000_000)),
}));

// Create mock child process factory
function createMockChildProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();

  const mockProcess = {
    stdout,
    stderr,
    pid: 12345,
    killed: false,
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    kill: vi.fn(() => {
      mockProcess.killed = true;
      return true;
    }),
    unref: vi.fn()
  };

  return mockProcess;
}

let mockChildProcess: ReturnType<typeof createMockChildProcess>;
const mockSpawn = vi.fn((_cmd: string, _args: string[]) => mockChildProcess);

// Mock child_process BEFORE imports
vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
  exec: vi.fn((cmd: string, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    // Simulate successful exec for process tree kill
    cb(null, '', '');
  }),
}));

// Mock processSpawner BEFORE imports (canonical core path; superMcpHttpManager
// now goes through getProcessSpawner() instead of importing child_process
// directly). Keep the existing node:child_process mock above as a belt-and-
// braces guard for code paths that may still drop down to raw child_process.
vi.mock('@core/processSpawner', () => ({
  getProcessSpawner: () => ({
    spawn: (cmd: string, args: string[]) => mockSpawn(cmd, args),
    exec: vi.fn(async () => ({ stdout: '', stderr: '', error: null })),
    kill: vi.fn(() => true),
    waitForExit: vi.fn(async () => ({ code: 0, signal: null, timedOut: false })),
  }),
  setProcessSpawnerFactory: vi.fn(),
}));

// Mock net BEFORE imports
vi.mock('node:net', () => {
  const actualNet = {
    createServer: vi.fn(() => {
      const mockServer = new EventEmitter() as EventEmitter & {
        listen: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        unref: ReturnType<typeof vi.fn>;
      };
      mockServer.listen = vi.fn((_port: number, _host: string) => {
        // Simulate port available
        setTimeout(() => mockServer.emit('listening'), 0);
      });
      mockServer.close = vi.fn((cb?: () => void) => {
        if (cb) cb();
      });
      mockServer.unref = vi.fn();
      return mockServer;
    }),
    Socket: vi.fn().mockImplementation(() => {
      const socket = new EventEmitter() as EventEmitter & {
        setTimeout: ReturnType<typeof vi.fn>;
        connect: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
      };
      socket.setTimeout = vi.fn();
      socket.connect = vi.fn((_port: number, _host: string) => {
        // Simulate immediate connection for health check
        setTimeout(() => socket.emit('connect'), 0);
      });
      socket.destroy = vi.fn();
      return socket;
    })
  };
  return { ...actualNet, default: actualNet };
});

// Mock fs BEFORE imports
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn().mockResolvedValue(Buffer.from('mock-image-data')),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
  },
  readFile: vi.fn().mockResolvedValue(Buffer.from('mock-image-data')),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
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

// Mock electron BEFORE imports
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/mock/app/path',
    getPath: (name: string) => {
      if (name === 'userData') return '/mock/userData';
      return '/mock/path';
    }
  }
}));

// Import after mocks - use dynamic import to ensure mocks are applied
let superMcpHttpManager: typeof import('../superMcpHttpManager').superMcpHttpManager;

beforeEach(async () => {
  vi.clearAllMocks();
  mockFetch.mockClear();
  mockCaptureException.mockClear();

  // Create fresh mock process for each test
  mockChildProcess = createMockChildProcess();
  mockSpawn.mockReturnValue(mockChildProcess);

  // Reset module to get fresh singleton state
  vi.resetModules();
  await initTestPlatformConfig();

  // Re-mock error reporter after module reset
  vi.doMock('@core/errorReporter', () => ({
    setErrorReporter: vi.fn(),
    getErrorReporter: () => ({
      captureException: mockCaptureException,
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
    }),
  }));

  // Re-import the module to get fresh singleton
  const module = await import('../superMcpHttpManager');
  superMcpHttpManager = module.superMcpHttpManager;
});

afterEach(async () => {
  // Clean up manager state
  try {
    await (superMcpHttpManager as unknown as { stopNow: () => Promise<void> } | undefined)?.stopNow();
  } catch {
    // Ignore cleanup errors
  }
});

describe('SuperMcpHttpManager Sentry capture', () => {
  it('captures startup failure category and attempt summary without changing error identity or first line', async () => {
    vi.useFakeTimers();
    try {
      const startupError = new Error(
        'Super-MCP process died during startup\n' +
          'Child process output (last 4KB):\npermission timeout EADDRINUSE',
      );
      vi.spyOn(superMcpHttpManager, 'start').mockRejectedValue(startupError);

      const resultPromise = superMcpHttpManager.startWithRetries('/mock/config.json', {
        logContext: 'startup',
        scheduleBackgroundRecovery: false,
      });

      await vi.advanceTimersByTimeAsync(50_000);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.failureCategory).toBe('process_crash');
      expect(result.attemptSummary).toEqual([
        { attempt: 1, phase: 'spawn-or-health-check', category: 'process_crash' },
        { attempt: 2, phase: 'spawn-or-health-check', category: 'process_crash' },
        { attempt: 3, phase: 'spawn-or-health-check', category: 'process_crash' },
        { attempt: 4, phase: 'spawn-or-health-check', category: 'process_crash' },
      ]);

      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      const [capturedError, captureContext] = mockCaptureException.mock.calls[0] as [
        Error,
        { tags?: Record<string, unknown>; extra?: Record<string, unknown> },
      ];
      expect(capturedError).toBe(startupError);
      expect(capturedError.message.split('\n')[0]).toBe('Super-MCP process died during startup');
      expect(captureContext.tags).toEqual(expect.objectContaining({
        area: 'startup',
        component: 'super-mcp',
        startup_context: 'startup',
        failureCategory: 'process_crash',
      }));
      expect(captureContext.extra).toEqual(expect.objectContaining({
        attempts: 4,
        lastError: startupError.message,
        failureCategory: 'process_crash',
        attemptSummary: result.attemptSummary,
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('appends owner-tag argv tokens when spawning super-mcp', async () => {
    superMcpHttpManager.configure({
      enabled: true,
      port: 3100,
      configPath: '/mock/config.json',
      startupTimeoutMs: 10000,
      healthCheckIntervalMs: 100,
    });

    const startPromise = superMcpHttpManager.start();
    void startPromise.catch(() => {});

    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    const spawnArgsUnknown = (mockSpawn.mock.calls as unknown[][])[0]?.[1];
    expect(Array.isArray(spawnArgsUnknown)).toBe(true);
    if (!Array.isArray(spawnArgsUnknown)) {
      throw new Error('Expected spawn args array');
    }
    const spawnArgs = spawnArgsUnknown as string[];

    const ownerIdIndex = spawnArgs.indexOf('--rebel-owner-id');
    const ownerPidIndex = spawnArgs.indexOf('--rebel-owner-pid');
    const ownerStartIndex = spawnArgs.indexOf('--rebel-owner-start');

    expect(ownerIdIndex).toBeGreaterThanOrEqual(0);
    expect(ownerPidIndex).toBeGreaterThanOrEqual(0);
    expect(ownerStartIndex).toBeGreaterThanOrEqual(0);

    expect(spawnArgs[ownerIdIndex + 1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const ownerPidValue = Number.parseInt(spawnArgs[ownerPidIndex + 1] ?? '', 10);
    expect(Number.isInteger(ownerPidValue)).toBe(true);
    expect(ownerPidValue).toBeGreaterThan(0);

    const ownerStartValue = Number.parseInt(spawnArgs[ownerStartIndex + 1] ?? '', 10);
    expect(Number.isInteger(ownerStartValue)).toBe(true);
    expect(ownerStartValue).toBeGreaterThanOrEqual(0);

    const syntheticError = Object.assign(new Error('spawn EBADF'), {
      code: 'EBADF',
      errno: -9,
      syscall: 'spawn',
    });
    mockChildProcess.emit('error', syntheticError);
    await expect(startPromise).rejects.toThrow();
  });

  it('calls captureMainException when process emits EBADF error', async () => {
    // Configure the manager
    superMcpHttpManager.configure({
      enabled: true,
      port: 3100,
      configPath: '/mock/config.json',
      startupTimeoutMs: 10000,
      healthCheckIntervalMs: 100
    });

    // Start the manager (this spawns the process)
    const startPromise = superMcpHttpManager.start();
    void startPromise.catch(() => {});

    // Wait for spawn to be called
    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalled();
    });

    // Simulate EBADF error on the process
    const ebadfError = Object.assign(new Error('spawn EBADF'), {
      code: 'EBADF',
      errno: -9,
      syscall: 'spawn'
    });
    mockChildProcess.emit('error', ebadfError);

    // Wait for the error handler to execute and report to Sentry
    await vi.waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
    });

    // Verify the error object
    expect(mockCaptureException).toHaveBeenCalledWith(
      ebadfError,
      expect.objectContaining({
        tags: expect.objectContaining({
          area: 'super-mcp',
          component: 'superMcpHttpManager',
          error_code: 'EBADF'
        }),
        extra: expect.objectContaining({
          port: 3100,
          errorCode: 'EBADF',
          errorErrno: -9,
          errorSyscall: 'spawn',
          pid: 12345
        })
      })
    );

    // The extra should also include uptime (which may be a number or null depending on timing)
    const capturedExtra = mockCaptureException.mock.calls[0][1].extra;
    expect(capturedExtra).toHaveProperty('uptime');

    // Verify startup failure propagates correctly
    await expect(startPromise).rejects.toThrow(/Super-MCP process died during startup/);
  });

  it('captures unknown error code as "unknown"', async () => {
    // Configure the manager
    superMcpHttpManager.configure({
      enabled: true,
      port: 3200,
      configPath: '/mock/config.json',
      startupTimeoutMs: 10000,
      healthCheckIntervalMs: 100
    });

    // Start the manager
    const startPromise = superMcpHttpManager.start();
    void startPromise.catch(() => {});

    // Wait for spawn
    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalled();
    });

    // Simulate error without a code property
    const genericError = new Error('Generic process error');
    mockChildProcess.emit('error', genericError);

    // Wait for the error handler to execute and report to Sentry
    await vi.waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
    });

    // Verify captureMainException was called with unknown error_code
    expect(mockCaptureException).toHaveBeenCalledWith(
      genericError,
      expect.objectContaining({
        tags: expect.objectContaining({
          error_code: 'unknown'
        })
      })
    );

    // Verify startup failure propagates correctly
    await expect(startPromise).rejects.toThrow(/Super-MCP process died during startup/);
  });

  it('includes correct diagnostic context in Sentry capture', async () => {
    // Configure the manager with a specific port
    superMcpHttpManager.configure({
      enabled: true,
      port: 3300,
      configPath: '/mock/config.json',
      startupTimeoutMs: 10000,
      healthCheckIntervalMs: 100
    });

    // Start the manager
    const startPromise = superMcpHttpManager.start();
    void startPromise.catch(() => {});

    // Wait for spawn
    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalled();
    });

    // Simulate EMFILE error (too many open files)
    const emfileError = Object.assign(new Error('spawn EMFILE'), {
      code: 'EMFILE',
      errno: -24,
      syscall: 'open'
    });
    mockChildProcess.emit('error', emfileError);

    // Wait for the error handler to execute and report to Sentry
    await vi.waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
    });

    const [capturedError, capturedContext] = mockCaptureException.mock.calls[0];

    // Verify the error
    expect(capturedError).toBe(emfileError);

    // Verify tags
    expect(capturedContext.tags).toEqual({
      area: 'super-mcp',
      component: 'superMcpHttpManager',
      error_code: 'EMFILE'
    });

    // Verify extra fields
    expect(capturedContext.extra).toMatchObject({
      port: 3300,
      errorCode: 'EMFILE',
      errorErrno: -24,
      errorSyscall: 'open',
      pid: 12345
    });

    // Uptime should be present (as number or null)
    expect('uptime' in capturedContext.extra).toBe(true);

    // Verify startup failure propagates correctly
    await expect(startPromise).rejects.toThrow(/Super-MCP process died during startup/);
  });
});
