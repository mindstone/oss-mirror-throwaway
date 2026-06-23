import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessSpawner, ProcessSpawnOptions, SpawnedProcess } from '@core/processSpawner';
import { setProcessSpawnerFactory } from '@core/processSpawner';
import {
  SUPER_MCP_RESTART_REASONS,
  SUPER_MCP_SPAWN_ARGV_FIXED_VALUES,
  SUPER_MCP_SPAWN_ARGV_FLAGS,
  SUPER_MCP_SPAWN_ENV_KEYS,
} from '@core/rebelCore/superMcpContract';

// Cross-platform temp path so the mocked getDataPath() reads sensibly on any
// platform (Linux CI, macOS local). fs is fully mocked below, so no real
// filesystem write ever happens — but using a real-tmpdir-shaped path makes
// intent obvious to readers and avoids the macOS-only `/private/tmp/...`
// fixture that previously masked a Linux-CI fs failure. Computed via
// `vi.hoisted` so the value is available when the (hoisted) `vi.mock` factory
// runs (the regular module-level `const` would be in the TDZ at factory time).
const TEST_DATA_DIR = vi.hoisted(() => {
  const pathMod: typeof import('node:path') = require('node:path');
  const osMod: typeof import('node:os') = require('node:os');
  return pathMod.join(osMod.tmpdir(), 'rebel-super-mcp-stage2b-test');
});

const mockOwnerRegistry = {
  register: vi.fn<(...args: unknown[]) => Promise<void>>(),
  startHeartbeatTimer: vi.fn(),
  attachChild: vi.fn<(...args: unknown[]) => Promise<void>>(),
  unregister: vi.fn<(...args: unknown[]) => Promise<void>>(),
  stopHeartbeatTimer: vi.fn(),
};

const mockGetProcessStartTimeMs = vi.fn<(pid: number) => Promise<number | null>>();

const mockGetActiveTurnCount = vi.fn<() => number>();
const mockOnDrained = vi.fn<(cb: () => void) => void>();

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

vi.mock('@core/services/diagnosticEventsLedger', () => ({
  appendDiagnosticEvent: vi.fn(),
}));

vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => TEST_DATA_DIR,
  isPackaged: () => false,
  getAppRoot: () => process.cwd(),
}));

vi.mock('@core/utils/buildChannel', () => ({
  getBuildChannel: () => 'dev',
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: () => ({ coreDirectory: '/tmp/test-core' }),
}));

vi.mock('@core/services/superMcpOwnerRegistrySingleton', () => ({
  getOwnerRegistry: () => mockOwnerRegistry,
}));

vi.mock('@core/utils/processStartTime', () => ({
  getProcessStartTimeMs: (pid: number) => mockGetProcessStartTimeMs(pid),
}));

vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getActiveTurnCount: () => mockGetActiveTurnCount(),
    onDrained: (cb: () => void) => mockOnDrained(cb),
  },
}));

// Mock node:fs / node:fs/promises to eliminate the real-fs dependency in the
// `doStart()` chain (`cleanupOrphanedProcess` readFile, `getAppIconDataUrl`
// readFile, spawn-log `mkdir` + `openSync`, post-spawn `writePidFile`
// `mkdir`+`writeFile`). Without this:
//   - Linux CI: the (formerly macOS-only) mocked `getDataPath` made
//     `fs.mkdir('/private/...')` fail outright, so spawn never happened.
//   - Any CI under load: cumulative real-fs latency can exceed the
//     fixed 1000 ms wall-clock budget of `vi.waitFor` while fake timers
//     are active for the rest of the test.
// Mirrors the non-flaky sibling pattern in
// `superMcpHttpManager.preRestartHook.test.ts` (~lines 99-133). Diagnosis:
// docs-private/investigations/260601_supermcp_spawn_conformance_test_isolation.md
vi.mock('node:fs/promises', () => {
  // Local helper — the factory body runs in its own closure scope and the
  // top-level `vi.mock` call is hoisted above imports, so we can't reference
  // module-level consts from here without hitting TDZ.
  const enoent = (): never => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };
  return {
    default: {
      readFile: vi.fn().mockImplementation(async () => enoent()),
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockImplementation(async () => enoent()),
      readdir: vi.fn().mockResolvedValue([]),
    },
    readFile: vi.fn().mockImplementation(async () => enoent()),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockImplementation(async () => enoent()),
    readdir: vi.fn().mockResolvedValue([]),
  };
});

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

import { existsSync } from 'node:fs';
import { SuperMcpHttpManager } from '../superMcpHttpManager';

class FakeSpawnedProcess extends EventEmitter implements SpawnedProcess {
  readonly pid: number;
  killed = false;
  stdout = null;
  stderr = null;
  readonly kill = vi.fn((signal?: NodeJS.Signals | number) => {
    void signal;
    this.killed = true;
    return true;
  });
  readonly unref = vi.fn();

  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createConfiguredManager(): SuperMcpHttpManager {
  const manager = new SuperMcpHttpManager();
  manager.configure({
    enabled: true,
    port: 3221,
    configPath: '/tmp/stage2b-super-mcp.json',
    startupTimeoutMs: 10_000,
    healthCheckIntervalMs: 50,
  });
  return manager;
}

function asPrivate(manager: SuperMcpHttpManager): {
  restartNow: () => Promise<void>;
  stopNow: () => Promise<void>;
} {
  return manager as unknown as ReturnType<typeof asPrivate>;
}

describe('SuperMcpHttpManager lifecycle/spawn conformance', () => {
  let spawnCalls: Array<{
    command: string;
    args: string[];
    options: ProcessSpawnOptions | undefined;
    proc: FakeSpawnedProcess;
  }>;
  let killCalls: Array<{ pid: number; signal?: NodeJS.Signals | number }>;
  // Deterministic gates: resolved synchronously inside the spawner.spawn
  // and mockOwnerRegistry.attachChild mocks, so tests can `await` the
  // exact signal instead of polling with `vi.waitFor` against a fixed
  // 1000ms wall-clock budget that CI parallel CPU contention can blow.
  let spawnDeferred: ReturnType<typeof createDeferred<FakeSpawnedProcess>>;
  let attachChildDeferred: ReturnType<typeof createDeferred<unknown[]>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    spawnCalls = [];
    killCalls = [];
    spawnDeferred = createDeferred<FakeSpawnedProcess>();
    attachChildDeferred = createDeferred<unknown[]>();

    mockOwnerRegistry.register.mockResolvedValue(undefined);
    mockOwnerRegistry.attachChild.mockImplementation(async (...args: unknown[]) => {
      attachChildDeferred.resolve(args);
    });
    mockOwnerRegistry.unregister.mockResolvedValue(undefined);
    mockGetProcessStartTimeMs.mockImplementation(async (pid: number) => {
      if (pid === process.pid) return 1_730_000_000_000;
      if (pid === 43_210) return 1_730_000_100_000;
      return null;
    });
    mockGetActiveTurnCount.mockReturnValue(0);
    mockOnDrained.mockReset();

    const spawner: ProcessSpawner = {
      spawn: vi.fn((command: string, args: string[], options?: ProcessSpawnOptions) => {
        const proc = new FakeSpawnedProcess(43_210);
        spawnCalls.push({ command, args, options, proc });
        spawnDeferred.resolve(proc);
        return proc;
      }),
      exec: vi.fn(async () => ({ stdout: '', stderr: '', error: null })),
      kill: vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
        killCalls.push({ pid, signal });
        return true;
      }),
      waitForExit: vi.fn(async () => ({ code: 0, signal: null, timedOut: false })),
    };
    setProcessSpawnerFactory(() => spawner);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 404,
      ok: false,
      json: async () => ({ packages: [] }),
    })));
  });

  afterEach(() => {
    // Reset the module-level spawner factory so a leftover in-flight
    // startup chain from this test can't reuse it (or push a phantom
    // spawn into the next test's `spawnCalls`). Each beforeEach wires
    // a fresh factory before its test runs, so this throw-stub is
    // dormant during the next test. Diagnosis:
    // docs-private/investigations/260601_supermcp_spawn_conformance_test_isolation.md
    setProcessSpawnerFactory(() => {
      throw new Error('ProcessSpawner not configured (cleared in afterEach)');
    });
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('guards 251221 concurrent-start: raw start() coalesces to one spawn, one owner registration, and one in-flight startup', async () => {
    const manager = createConfiguredManager();
    const healthGate = createDeferred<boolean>();
    const checkHealthSpy = vi
      .spyOn(manager, 'checkHealth')
      .mockImplementation(() => healthGate.promise);

    const firstStart = manager.start();
    const secondStart = manager.start();

    try {
      // Deterministic spawn signal: the spawner.spawn mock resolves
      // spawnDeferred synchronously when invoked. Replaces a
      // `vi.waitFor(() => spawnCalls.length === 1)` poll whose 1000 ms
      // wall-clock budget was racing CI parallel CPU contention.
      await spawnDeferred.promise;

      expect(spawnCalls).toHaveLength(1);
      expect(checkHealthSpy).toHaveBeenCalledTimes(1);
      expect(mockOwnerRegistry.register).toHaveBeenCalledTimes(1);
      expect(mockOwnerRegistry.startHeartbeatTimer).toHaveBeenCalledTimes(1);
      expect((manager as unknown as { startPromise: Promise<void> | null }).startPromise).toBeInstanceOf(Promise);

      const secondStartBeforeHealthGate = await Promise.race([
        secondStart.then(() => 'resolved' as const),
        Promise.resolve('pending' as const),
      ]);
      expect(secondStartBeforeHealthGate).toBe('pending');

      healthGate.resolve(true);
      await Promise.all([firstStart, secondStart]);

      expect(spawnCalls).toHaveLength(1);
      expect(mockOwnerRegistry.register).toHaveBeenCalledTimes(1);
      expect(manager.getState().process?.pid).toBe(43_210);
      expect(manager.getState().isRunning).toBe(true);
    } finally {
      // Guarantee no in-flight startup chain leaks into the next test
      // even if an assertion above throws after spawn but before the
      // health gate resolution. Idempotent: a second `resolve(true)`
      // on an already-resolved deferred is a no-op.
      healthGate.resolve(true);
      await Promise.allSettled([firstStart, secondStart]);
    }
  });

  it('guards 260429 owner-tag spawn parity: argv/env use the contract constants and register one owner for the child', async () => {
    const manager = createConfiguredManager();
    vi.spyOn(manager, 'checkHealth').mockResolvedValue(true);

    await manager.start();

    expect(spawnCalls).toHaveLength(1);
    const [{ args, options, proc }] = spawnCalls;

    expect(args).toEqual(expect.arrayContaining([
      SUPER_MCP_SPAWN_ARGV_FLAGS.TRANSPORT,
      SUPER_MCP_SPAWN_ARGV_FIXED_VALUES.TRANSPORT_HTTP,
      SUPER_MCP_SPAWN_ARGV_FLAGS.PORT,
      '3221',
      SUPER_MCP_SPAWN_ARGV_FLAGS.CONFIG,
      '/tmp/stage2b-super-mcp.json',
      SUPER_MCP_SPAWN_ARGV_FLAGS.REBEL_OWNER_ID,
      SUPER_MCP_SPAWN_ARGV_FLAGS.REBEL_OWNER_PID,
      String(process.pid),
      SUPER_MCP_SPAWN_ARGV_FLAGS.REBEL_OWNER_START,
      '1730000000000',
    ]));
    const ownerIdIndex = args.indexOf(SUPER_MCP_SPAWN_ARGV_FLAGS.REBEL_OWNER_ID);
    const ownerId = args[ownerIdIndex + 1];
    expect(ownerId).toMatch(/^[0-9a-f-]{36}$/i);

    expect(options?.env).toMatchObject({
      [SUPER_MCP_SPAWN_ENV_KEYS.NODE_ENV]: 'production',
      [SUPER_MCP_SPAWN_ENV_KEYS.NODE_PATH]: expect.any(String),
      [SUPER_MCP_SPAWN_ENV_KEYS.SUPER_MCP_APP_NAME]: 'Rebel',
      [SUPER_MCP_SPAWN_ENV_KEYS.SUPER_MCP_PRIMARY_COLOR]: '#8b5cf6',
      [SUPER_MCP_SPAWN_ENV_KEYS.SUPER_MCP_ICON_TEXT]: 'R',
      [SUPER_MCP_SPAWN_ENV_KEYS.REBEL_WORKSPACE_PATH]: '/tmp/test-core',
    });
    expect(options?.stdio).toEqual(['ignore', expect.any(Number), expect.any(Number)]);
    expect(options?.windowsHide).toBe(true);
    if (process.platform !== 'win32' && process.env.REBEL_E2E_TEST_MODE !== '1' && process.env.REBEL_HEADLESS !== '1') {
      expect(options?.detached).toBe(true);
      expect(proc.unref).toHaveBeenCalledOnce();
    }

    expect(mockOwnerRegistry.register).toHaveBeenCalledWith(expect.objectContaining({
      ownerId,
      ownerPid: process.pid,
      ownerStartTimeMs: 1_730_000_000_000,
      childPid: null,
      childStartTimeMs: null,
      childPort: 3221,
    }));
    // Deterministic attachChild signal: the mockOwnerRegistry.attachChild
    // implementation (wired in beforeEach) resolves attachChildDeferred
    // synchronously when invoked. Replaces a `vi.waitFor(() => ...)` poll
    // whose 1000 ms wall-clock budget was racing CI CPU contention.
    await attachChildDeferred.promise;
    expect(mockOwnerRegistry.attachChild).toHaveBeenCalledWith(
      ownerId,
      43_210,
      3221,
      1_730_000_100_000,
    );
  });

  it('keeps REBEL_SUPER_MCP_PINNED_VERSION ahead of the generated npx fallback default', async () => {
    const envKey = SUPER_MCP_SPAWN_ENV_KEYS.REBEL_SUPER_MCP_PINNED_VERSION;
    const originalEnvValue = process.env[envKey];
    process.env[envKey] = '9.9.9-test-override';
    vi.mocked(existsSync).mockReturnValue(false);

    try {
      const manager = createConfiguredManager();
      vi.spyOn(manager, 'checkHealth').mockResolvedValue(true);

      await manager.start();

      expect(spawnCalls).toHaveLength(1);
      const [{ command, args }] = spawnCalls;
      expect(command).toBe(process.platform === 'win32' ? 'npx.cmd' : 'npx');
      expect(args).toEqual(expect.arrayContaining([
        '--yes',
        'super-mcp-router@9.9.9-test-override',
      ]));
    } finally {
      if (originalEnvValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = originalEnvValue;
      }
      vi.mocked(existsSync).mockReturnValue(true);
    }
  });

  it('guards 260427 restart-race primitive: scheduleRestartWhenIdle coalesces active-turn restarts and attributes the drained restart reason', async () => {
    const manager = createConfiguredManager();
    const restartSpy = vi.spyOn(asPrivate(manager), 'restartNow').mockResolvedValue(undefined);

    mockGetActiveTurnCount.mockReturnValue(1);
    manager.scheduleRestartWhenIdle();
    manager.scheduleRestartWhenIdle();

    expect(restartSpy).not.toHaveBeenCalled();
    expect(mockOnDrained).toHaveBeenCalledOnce();
    expect(SUPER_MCP_RESTART_REASONS).toContain('idle-restart');
    expect(manager.getSubprocessInfo().lastRestartReason).toBeNull();

    // This proves the idle-drain primitive and pendingRestart coalescing only.
    // It does not prove desktop config-change callers use the primitive; the
    // skipped Stage 7 repro below documents that still-live caller seam.
    mockGetActiveTurnCount.mockReturnValue(0);
    mockOnDrained.mock.calls[0][0]();
    await vi.advanceTimersByTimeAsync(0);

    expect(restartSpy).toHaveBeenCalledOnce();
    expect(mockOnDrained).toHaveBeenCalledOnce();
    expect(manager.getSubprocessInfo().lastRestartReason).toBe('idle-restart');
  });

  it('260427 caller-seam: a config-change restart during an active turn does not kill the router carrying the in-flight result', async () => {
    const manager = createConfiguredManager();
    const proc = new FakeSpawnedProcess(43_210);
    Object.assign((manager as unknown as { state: { isRunning: boolean; process: FakeSpawnedProcess } }).state, {
      isRunning: true,
      process: proc,
    });
    const stopSpy = vi.spyOn(asPrivate(manager), 'stopNow').mockResolvedValue(undefined);
    const startWithRetriesSpy = vi
      .spyOn(manager, 'startWithRetries')
      .mockResolvedValue({
        success: true,
        attempts: 1,
      });

    mockGetActiveTurnCount.mockReturnValue(1);
    const restartPromise = manager.requestRestartForConfigChangeAndAwaitExecution({
      configPath: '/tmp/stage7-updated-super-mcp.json',
      context: 'stage7-caller-seam-repro',
    });

    expect(stopSpy).not.toHaveBeenCalled();
    expect(startWithRetriesSpy).not.toHaveBeenCalled();

    mockGetActiveTurnCount.mockReturnValue(0);
    expect(mockOnDrained).toHaveBeenCalledOnce();
    mockOnDrained.mock.calls[0][0]();
    await restartPromise;

    expect(stopSpy).toHaveBeenCalledOnce();
    expect(startWithRetriesSpy).toHaveBeenCalledOnce();
  });

  it('Stage 7 carve-out: chat materialization reload executes immediately even during an active turn', async () => {
    const manager = createConfiguredManager();
    const proc = new FakeSpawnedProcess(43_210);
    Object.assign((manager as unknown as { state: { isRunning: boolean; process: FakeSpawnedProcess } }).state, {
      isRunning: true,
      process: proc,
    });
    const stopSpy = vi.spyOn(asPrivate(manager), 'stopNow').mockResolvedValue(undefined);
    const startWithRetriesSpy = vi
      .spyOn(manager, 'startWithRetries')
      .mockResolvedValue({
        success: true,
        attempts: 1,
      });

    mockGetActiveTurnCount.mockReturnValue(1);
    await manager.requestImmediateConfigReloadForChatMaterialization({
      configPath: '/tmp/stage7-chat-materialized-super-mcp.json',
      context: 'bridge-upsert',
      reason: 'chat-package-materialization',
    });

    expect(mockOnDrained).not.toHaveBeenCalled();
    expect(stopSpy).toHaveBeenCalledOnce();
    expect(startWithRetriesSpy).toHaveBeenCalledOnce();
  });
});
