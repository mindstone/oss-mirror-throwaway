import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
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

// Mock logger BEFORE imports — captured here so tests can assert on retry-log
// enrichment (Stage 3 of 260521_supermcp_startup_error_path_diagnosability).
const { mockLoggerInfo, mockLoggerWarn, mockLoggerError, mockLoggerDebug } = vi.hoisted(() => ({
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLoggerDebug: vi.fn(),
}));
vi.mock('@core/logger', () => {
  const stub = {
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
    debug: mockLoggerDebug,
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => stub),
    bindings: vi.fn(() => ({})),
    flush: vi.fn(),
  };
  return {
    logger: stub,
    createScopedLogger: vi.fn(() => stub),
    createTurnSessionLogger: vi.fn(() => stub),
    runWithTurnContext: vi.fn(<T,>(_ctx: unknown, fn: () => T) => fn()),
  };
});

// Mock buildChannel (canonical location is now @core/utils/buildChannel)
vi.mock('@core/utils/buildChannel', () => ({
  getBuildChannel: () => 'dev',
}));

 
vi.mock('@core/utils/processStartTime', () => ({
  getProcessStartTimeMs: vi.fn(() => Promise.resolve(1_730_000_000_000)),
}));

// Create mock child process factory
function createMockChildProcess() {
  const emitter = new EventEmitter();
  const mockProcess = {
    pid: 12345,
    killed: false,
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    kill: vi.fn(() => { mockProcess.killed = true; return true; }),
    unref: vi.fn(),
  };
  return mockProcess;
}

let mockChildProcess: ReturnType<typeof createMockChildProcess>;
const mockSpawn = vi.fn(() => mockChildProcess);

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
  exec: vi.fn(
    (cmd: string, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, '', '');
    },
  ),
}));

// net mock — use process.nextTick so events fire even with fake timers.
// MUST include `default` export since superMcpHttpManager uses `import net from 'node:net'`.
vi.mock('node:net', () => {
  const mock = {
    createServer: vi.fn(() => {
      const mockServer = new EventEmitter() as EventEmitter & {
        listen: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        unref: ReturnType<typeof vi.fn>;
      };
      mockServer.listen = vi.fn((_port: number, _host: string) => {
        process.nextTick(() => mockServer.emit('listening'));
      });
      mockServer.close = vi.fn((cb?: () => void) => { if (cb) cb(); });
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
        process.nextTick(() => socket.emit('connect'));
      });
      socket.destroy = vi.fn();
      return socket;
    }),
  };
  return { ...mock, default: mock };
});

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

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/mock/app/path',
    getPath: (name: string) => {
      if (name === 'userData') return '/mock/userData';
      return '/mock/path';
    },
  },
}));

// Imports after mocks
let SuperMcpHttpManager: typeof import('../superMcpHttpManager').SuperMcpHttpManager;
let MissingBundledSuperMcpError: typeof import('../superMcpHttpManager').MissingBundledSuperMcpError;
let manager: InstanceType<typeof SuperMcpHttpManager>;
let getDefaultSuperMcpPort: typeof import('../superMcpHttpManager').getDefaultSuperMcpPort;

beforeEach(async () => {
  vi.clearAllMocks();
  mockChildProcess = createMockChildProcess();
  mockSpawn.mockReturnValue(mockChildProcess);

  vi.useFakeTimers();

  vi.resetModules();
  await initTestPlatformConfig();

  vi.doMock('@core/errorReporter', () => ({
    setErrorReporter: vi.fn(),
    getErrorReporter: () => ({
      captureException: mockCaptureException,
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
    }),
  }));

  const module = await import('../superMcpHttpManager');
  SuperMcpHttpManager = module.SuperMcpHttpManager;
  MissingBundledSuperMcpError = module.MissingBundledSuperMcpError;
  getDefaultSuperMcpPort = module.getDefaultSuperMcpPort;
  manager = new SuperMcpHttpManager();
});

afterEach(async () => {
  try {
    await (manager as unknown as { stopNow: () => Promise<void> } | null)?.stopNow();
  } catch { /* ignore */ }
  vi.useRealTimers();
});

/**
 * Helper: run startWithRetries() while advancing fake timers to flush retry delays.
 * The retry delays [0, 5000, 10000, 20000]ms total 35s. We advance 50s to cover all.
 */
async function runWithTimers(
  mgr: InstanceType<typeof SuperMcpHttpManager>,
  configPath: string,
  options?: { logContext?: string; force?: boolean; scheduleBackgroundRecovery?: boolean },
) {
  const promise = mgr.startWithRetries(configPath, {
    scheduleBackgroundRecovery: false,
    ...options,
  });
  // Advance past all retry delays — advanceTimersByTimeAsync flushes microtasks between steps
  await vi.advanceTimersByTimeAsync(50_000);
  return promise;
}

// =============================================================================
// Circuit Breaker
// =============================================================================

describe('Circuit Breaker', () => {
  it('blocks startup within cooldown period, error includes remaining time and last error', async () => {
    vi.spyOn(manager, 'start').mockRejectedValue(new Error('Port bind failed'));

    const result = await runWithTimers(manager, '/mock/config.json', { logContext: 'startup' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Port bind failed');

    // Breaker engaged. Advance a little and try again.
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(
      manager.startWithRetries('/mock/config.json', { logContext: 'lazy-recovery' }),
    ).rejects.toThrow(/circuit breaker active/);
  });

  it('circuit breaker still blocks at 30s into the cooldown', async () => {
    vi.spyOn(manager, 'start').mockRejectedValue(new Error('fail'));

    await runWithTimers(manager, '/mock/config.json', { logContext: 'startup' });

    // 30s later — still within 120s cooldown
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(
      manager.startWithRetries('/mock/config.json', { logContext: 'lazy-recovery' }),
    ).rejects.toThrow(/circuit breaker active/);
  });

  it('resetCircuitBreaker() clears state, allowing a new attempt', async () => {
    vi.spyOn(manager, 'start').mockRejectedValue(new Error('fail'));

    await runWithTimers(manager, '/mock/config.json', { logContext: 'startup' });

    // Blocked
    await expect(
      manager.startWithRetries('/mock/config.json', { logContext: 'lazy-recovery' }),
    ).rejects.toThrow(/circuit breaker active/);

    // Reset
    manager.resetCircuitBreaker();

    // Now should attempt (not throw breaker error)
    const result = await runWithTimers(manager, '/mock/config.json', { logContext: 'startup' });
    expect(result.success).toBe(false); // Still fails, but was attempted (not blocked)
    expect(result.attempts).toBe(4);
  });

  it('force: true bypasses circuit breaker', async () => {
    const startSpy = vi.spyOn(manager, 'start').mockRejectedValue(new Error('fail'));

    await runWithTimers(manager, '/mock/config.json', { logContext: 'startup' });
    expect(startSpy).toHaveBeenCalledTimes(4);

    // Normal call blocked
    await expect(
      manager.startWithRetries('/mock/config.json', { logContext: 'lazy-recovery' }),
    ).rejects.toThrow(/circuit breaker active/);

    // force: true bypasses
    const result = await runWithTimers(manager, '/mock/config.json', {
      logContext: 'config-change',
      force: true,
    });
    expect(result.success).toBe(false);
    expect(startSpy).toHaveBeenCalledTimes(8); // 4 original + 4 forced
  });

  it('expires after the 120s cooldown period', async () => {
    const startSpy = vi.spyOn(manager, 'start').mockRejectedValue(new Error('fail'));

    await runWithTimers(manager, '/mock/config.json', { logContext: 'startup' });

    // Still blocked right after
    await expect(
      manager.startWithRetries('/mock/config.json', { logContext: 'lazy-recovery' }),
    ).rejects.toThrow(/circuit breaker active/);

    // The failure is recorded ~35s into the 50s advancement (after retry delays
    // [0, 5, 10, 20]s = 35s). Advance 130s more to guarantee we're past 120s cooldown.
    await vi.advanceTimersByTimeAsync(130_000);

    // Should be allowed through now
    startSpy.mockClear();
    const result = await runWithTimers(manager, '/mock/config.json', { logContext: 'startup' });
    expect(result.success).toBe(false); // Still fails, but was actually attempted
    expect(startSpy).toHaveBeenCalledTimes(4);
  });

  it('resets on successful startup', async () => {
    const startSpy = vi.spyOn(manager, 'start').mockRejectedValue(new Error('fail'));
    vi.spyOn(manager, 'getSkippedServers').mockReturnValue([]);

    await runWithTimers(manager, '/mock/config.json', { logContext: 'startup' });

    // Make start succeed
    startSpy.mockResolvedValue(undefined);

    // Force through the breaker
    const result = await runWithTimers(manager, '/mock/config.json', { force: true });
    expect(result.success).toBe(true);

    // Breaker should be cleared now — fail start again
    startSpy.mockRejectedValue(new Error('fail again'));

    // Non-forced call should attempt (breaker was cleared by success)
    const result2 = await runWithTimers(manager, '/mock/config.json', { logContext: 'startup' });
    expect(result2.success).toBe(false);
    expect(result2.error).toContain('fail again');
  });
});

// =============================================================================
// startWithRetries()
// =============================================================================

describe('startWithRetries()', () => {
  it('does not retry deterministic packaged-missing-bundle startup failures', async () => {
    const missingBundleError = new MissingBundledSuperMcpError(
      '/Applications/Rebel.app/Contents/Resources/super-mcp/dist/cli.js',
    );
    const startSpy = vi.spyOn(manager, 'start').mockRejectedValue(missingBundleError);

    const resultPromise = manager.startWithRetries('/mock/config.json', {
      logContext: 'startup',
      scheduleBackgroundRecovery: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.error).toContain('Packaged Rebel is missing its bundled Super-MCP runtime');
    expect(result.lastErrorObj).toBe(missingBundleError);
    expect(result.failureCategory).toBe('missing_bundle');
    expect(result.attemptErrors).toEqual([
      {
        attempt: 1,
        phase: 'spawn-or-health-check',
        error: missingBundleError.message,
      },
    ]);
    expect(result.attemptSummary).toEqual([
      {
        attempt: 1,
        phase: 'spawn-or-health-check',
        category: 'missing_bundle',
      },
    ]);
    expect(startSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50_000);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('retries on failure with 4 attempts', async () => {
    const startSpy = vi.spyOn(manager, 'start').mockRejectedValue(new Error('fail'));

    const result = await runWithTimers(manager, '/mock/config.json', { logContext: 'startup' });

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(4);
    expect(startSpy).toHaveBeenCalledTimes(4);
  });

  it('calls configure() on each retry for port reselection', async () => {
    const configureSpy = vi.spyOn(manager, 'configure');
    vi.spyOn(manager, 'start').mockRejectedValue(new Error('fail'));

    await runWithTimers(manager, '/mock/config.json', { logContext: 'startup' });

    expect(configureSpy).toHaveBeenCalledTimes(4);
  });

  it('returns correct SuperMcpStartResult on success', async () => {
    vi.spyOn(manager, 'start').mockResolvedValue(undefined);
    vi.spyOn(manager, 'getSkippedServers').mockReturnValue([]);
    const recoveryListener = vi.fn();
    const unsubscribeRecovery = manager.onRecoverySuccess(recoveryListener);

    const result = await runWithTimers(manager, '/mock/config.json', { logContext: 'startup' });

    expect(result).toMatchObject({
      success: true,
      port: expect.any(Number),
      attempts: 1,
    });
    expect(result.error).toBeUndefined();
    expect(recoveryListener).not.toHaveBeenCalled();
    unsubscribeRecovery();
  });

  it('returns skippedServers when present on success', async () => {
    vi.spyOn(manager, 'start').mockResolvedValue(undefined);
    vi.spyOn(manager, 'getSkippedServers').mockReturnValue([
      { id: 'test-server', reason: 'config invalid' },
    ]);

    const result = await runWithTimers(manager, '/mock/config.json', { logContext: 'startup' });

    expect(result.success).toBe(true);
    expect(result.skippedServers).toEqual([
      { id: 'test-server', reason: 'config invalid' },
    ]);
  });

  it('serializes concurrent callers (coalescing)', async () => {
    const startSpy = vi.spyOn(manager, 'start').mockResolvedValue(undefined);
    vi.spyOn(manager, 'getSkippedServers').mockReturnValue([]);

    // Fire two concurrent calls
    const p1 = manager.startWithRetries('/mock/config.json', { logContext: 'caller-1' });
    const p2 = manager.startWithRetries('/mock/config.json', { logContext: 'caller-2' });

    await vi.advanceTimersByTimeAsync(5_000);

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    // Only one actual startup — the second coalesced
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('captures Sentry only for startup contexts, not manual restarts', async () => {
    vi.spyOn(manager, 'start').mockRejectedValue(new Error('fail'));

    // Startup context — should capture via getErrorReporter().captureException()
    const r1 = await runWithTimers(manager, '/mock/config.json', { logContext: 'startup' });
    // sentryEventId is no longer set (captureException returns void)
    expect(r1.sentryEventId).toBeUndefined();
    expect(mockCaptureException).toHaveBeenCalledTimes(1);

    manager.resetCircuitBreaker();
    mockCaptureException.mockClear();

    // ipc-restart context — should NOT capture
    const r2 = await runWithTimers(manager, '/mock/config.json', { logContext: 'ipc-restart' });
    expect(r2.sentryEventId).toBeUndefined();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('captures Sentry for preflight and app-ready contexts', async () => {
    vi.spyOn(manager, 'start').mockRejectedValue(new Error('fail'));

    for (const ctx of ['preflight', 'app-ready']) {
      manager.resetCircuitBreaker();
      mockCaptureException.mockClear();
      await runWithTimers(manager, '/mock/config.json', { logContext: ctx });
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
    }
  });

  it('schedules background recovery after exhausted startup retries', async () => {
    const startSpy = vi.spyOn(manager, 'start').mockRejectedValue(new Error('fail'));

    const resultPromise = manager.startWithRetries('/mock/config.json', {
      logContext: 'startup',
      scheduleBackgroundRecovery: true,
    });
    await vi.advanceTimersByTimeAsync(50_000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(startSpy).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(170_000);

    expect(startSpy.mock.calls.length).toBeGreaterThanOrEqual(8);
  });

  it('emits recovery-success callback when background recovery starts the manager', async () => {
    const startSpy = vi.spyOn(manager, 'start')
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockRejectedValueOnce(new Error('fail 3'))
      .mockRejectedValueOnce(new Error('fail 4'))
      .mockResolvedValue(undefined);
    const recoveryListener = vi.fn();
    const unsubscribeRecovery = manager.onRecoverySuccess(recoveryListener);

    const resultPromise = manager.startWithRetries('/mock/config.json', {
      logContext: 'startup',
      scheduleBackgroundRecovery: true,
    });
    await vi.advanceTimersByTimeAsync(50_000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(recoveryListener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(170_000);

    expect(startSpy).toHaveBeenCalledTimes(5);
    expect(recoveryListener).toHaveBeenCalledTimes(1);
    expect(recoveryListener).toHaveBeenCalledWith({
      port: expect.any(Number),
      attempts: 1,
      context: 'background-recovery',
    });

    unsubscribeRecovery();
  });

  it('emits recovery-success callback for lazy recovery after circuit-breaker cooldown', async () => {
    const startSpy = vi.spyOn(manager, 'start').mockRejectedValue(new Error('fail'));
    const recoveryListener = vi.fn();
    const unsubscribeRecovery = manager.onRecoverySuccess(recoveryListener);

    const failed = await runWithTimers(manager, '/mock/config.json', { logContext: 'startup' });
    expect(failed.success).toBe(false);
    expect(recoveryListener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(121_000);
    startSpy.mockResolvedValue(undefined);

    const recovered = await manager.startWithRetries('/mock/config.json', {
      logContext: 'lazy-recovery',
      scheduleBackgroundRecovery: false,
    });

    expect(recovered.success).toBe(true);
    expect(recoveryListener).toHaveBeenCalledTimes(1);
    expect(recoveryListener).toHaveBeenCalledWith({
      port: expect.any(Number),
      attempts: 1,
      context: 'lazy-recovery',
    });

    unsubscribeRecovery();
  });

  it('does NOT emit recovery-success for a lazy start with no prior failure', async () => {
    vi.spyOn(manager, 'start').mockResolvedValue(undefined);
    const recoveryListener = vi.fn();
    const unsubscribeRecovery = manager.onRecoverySuccess(recoveryListener);

    const result = await manager.startWithRetries('/mock/config.json', {
      logContext: 'lazy-recovery',
      scheduleBackgroundRecovery: false,
    });

    expect(result.success).toBe(true);
    // No failure episode preceded this start — a routine lazy start must stay silent.
    expect(recoveryListener).not.toHaveBeenCalled();

    unsubscribeRecovery();
  });

  it('populates attemptErrors[] and attemptSummary[] with one entry per attempt on full-failure path', async () => {
    const thrown = Object.assign(new Error('Port bind failed'), { code: 'EADDRINUSE' });
    vi.spyOn(manager, 'start').mockRejectedValue(thrown);

    const result = await runWithTimers(manager, '/mock/config.json', { logContext: 'startup' });

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(4);
    expect(result.error).toBe('Port bind failed');
    expect(result.lastError).toBe('Port bind failed');
    expect(result.lastErrorObj).toBe(thrown);
    expect(result.failureCategory).toBe('port_conflict');
    expect(result.attemptErrors).toBeDefined();
    expect(result.attemptSummary).toBeDefined();
    expect(result.attemptErrors).toHaveLength(4);
    expect(result.attemptSummary).toHaveLength(4);
    const phases: Array<'port-finder' | 'configure' | 'spawn-or-health-check' | 'unknown'> =
      ['port-finder', 'configure', 'spawn-or-health-check', 'unknown'];
    for (let i = 0; i < 4; i++) {
      const entry = result.attemptErrors![i];
      expect(entry.attempt).toBe(i + 1);
      expect(entry.error).toBe('Port bind failed');
      expect(phases).toContain(entry.phase);
      const summary = result.attemptSummary![i];
      expect(summary.attempt).toBe(i + 1);
      expect(summary.category).toBe('port_conflict');
      expect(phases).toContain(summary.phase);
    }
    // start() throws → at least one attempt should be classified as
    // 'spawn-or-health-check' (since findAvailablePort + configure succeed in
    // the mocked harness and only start() rejects).
    expect(result.attemptErrors!.some((e) => e.phase === 'spawn-or-health-check')).toBe(true);
  });

  it('retry log line carries previousError + previousPhase from the prior attempt (undefined on attempt 1)', async () => {
    vi.spyOn(manager, 'start').mockRejectedValue(new Error('Port bind failed'));

    await runWithTimers(manager, '/mock/config.json', { logContext: 'startup' });

    const retryLogs = mockLoggerInfo.mock.calls.filter(
      (call) => typeof call[1] === 'string' && call[1].startsWith('Retrying Super-MCP startup'),
    );
    expect(retryLogs).toHaveLength(3);
    for (const [payload] of retryLogs) {
      expect((payload as { previousError?: string }).previousError).toBe('Port bind failed');
      expect(
        (payload as { previousPhase?: string }).previousPhase,
      ).toMatch(/^(port-finder|configure|spawn-or-health-check|unknown)$/);
    }
  });
});

// =============================================================================
// getDefaultSuperMcpPort()
// =============================================================================

describe('getDefaultSuperMcpPort()', () => {
  it('returns 3200 for dev channel', () => {
    expect(getDefaultSuperMcpPort()).toBe(3200);
  });

  it('respects SUPER_MCP_HTTP_PORT env override', () => {
    const original = process.env['SUPER_MCP_HTTP_PORT'];
    process.env['SUPER_MCP_HTTP_PORT'] = '4567';
    try {
      expect(getDefaultSuperMcpPort()).toBe(4567);
    } finally {
      if (original === undefined) delete process.env['SUPER_MCP_HTTP_PORT'];
      else process.env['SUPER_MCP_HTTP_PORT'] = original;
    }
  });
});
