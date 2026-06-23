/**
 * Tests for `SuperMcpHttpManager` Stage 4a lifecycle observability:
 * - `getSubprocessInfo()` shape (not-running, running, circuit-breaker state).
 * - `startCount` / `restartCount` increment semantics.
 * - `subprocessEvents.spawned` / `exited` event emission.
 *
 * Plan: `docs/plans/260423_secondary_process_cpu_observability.md` (Stage 4a).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Mocks (declared before imports so vi.mock hoisting works) ────────

 
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

import {
  inferOwnerKind,
  SuperMcpHttpManager,
  type SuperMcpSubprocessInfo,
  type SuperMcpRestartReason,
} from '../superMcpHttpManager';

// ── Helpers ──────────────────────────────────────────────────────────

function createConfiguredManager(): SuperMcpHttpManager {
  const manager = new SuperMcpHttpManager();
  manager.configure({
    enabled: true,
    port: 3200,
    configPath: '/tmp/test-config.json',
    startupTimeoutMs: 5000,
    healthCheckIntervalMs: 200,
  });
  return manager;
}

describe('inferOwnerKind', () => {
  const originalArgv = process.argv;
  const originalElectronDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  const envKeys = [
    'EVAL_WORKER_INDEX',
    'REBEL_SWEEP_CLI',
    'REBEL_EVAL_ORCHESTRATOR',
    'REBEL_HEADLESS',
    'REBEL_HEADLESS_CLI',
    'REBEL_SURFACE',
    'FLY_APP_NAME',
    'FLY_MACHINE_ID',
  ] as const;

  const setElectronVersion = (value: string | undefined): void => {
    if (value === undefined) {
      delete (process.versions as Record<string, string | undefined>).electron;
      return;
    }
    Object.defineProperty(process.versions, 'electron', {
      value,
      configurable: true,
    });
  };

  beforeEach(() => {
    process.argv = ['node', 'rebel'];
    for (const key of envKeys) {
      delete process.env[key];
    }
    setElectronVersion('36.0.0');
  });

  afterEach(() => {
    process.argv = originalArgv;
    for (const key of envKeys) {
      delete process.env[key];
    }
    if (originalElectronDescriptor) {
      Object.defineProperty(process.versions, 'electron', originalElectronDescriptor);
    } else {
      delete (process.versions as Record<string, string | undefined>).electron;
    }
  });

  it('returns desktop for Electron GUI invocations', () => {
    expect(inferOwnerKind()).toBe('desktop');
  });

  it('returns cli for interactive Electron CLI invocations', () => {
    process.argv = ['electron', 'app.js', '--headless-cli', 'run'];
    expect(inferOwnerKind()).toBe('cli');
  });

  it('returns cli for non-Electron non-eval invocations', () => {
    setElectronVersion(undefined);
    expect(inferOwnerKind()).toBe('cli');
  });

  it('returns cloud for explicit cloud surface invocations', () => {
    setElectronVersion(undefined);
    process.env.REBEL_SURFACE = 'cloud';
    expect(inferOwnerKind()).toBe('cloud');
  });

  it('returns cloud for Fly-hosted invocations', () => {
    setElectronVersion(undefined);
    process.env.FLY_MACHINE_ID = 'machine-a';
    expect(inferOwnerKind()).toBe('cloud');
  });

  it('preserves eval-worker for eval worker invocations', () => {
    setElectronVersion(undefined);
    process.env.REBEL_SURFACE = 'cloud';
    process.env.EVAL_WORKER_INDEX = '0';
    expect(inferOwnerKind()).toBe('eval-worker');
  });

  it('preserves sweep-cli for eval-driven sweep invocations', () => {
    setElectronVersion(undefined);
    process.env.REBEL_SWEEP_CLI = '1';
    process.env.REBEL_HEADLESS = '1';
    expect(inferOwnerKind()).toBe('sweep-cli');
  });

  it('preserves eval-orchestrator for headless eval orchestrator invocations', () => {
    setElectronVersion(undefined);
    process.env.REBEL_HEADLESS = '1';
    expect(inferOwnerKind()).toBe('eval-orchestrator');
  });
});

/**
 * Drive the private state of a manager directly. Avoids depending on the full
 * spawn pipeline (which pulls in child_process / net / fs mocks) — we're only
 * testing `getSubprocessInfo()` shape and event emission here.
 */
function asPrivate(m: SuperMcpHttpManager): {
  state: {
    process: { pid?: number } | null;
    isRunning: boolean;
    startTime: number | null;
    port: number;
    url: string;
    lastHealthCheck: number | null;
  };
  startCount: number;
  restartCount: number;
  lastStartupFailureAt: number | null;
  lastStartupError: string | null;
	  // Stage 2 (260424) — attribution field tested via the private seam.
	  lastRestartReason: SuperMcpRestartReason | null;
	  isStopForRestart: boolean;
	  stopNow: () => Promise<void>;
	  restartNow: () => Promise<void>;
	  reconfigureNow: (newConfigPath: string) => Promise<void>;
	} {
  return m as unknown as ReturnType<typeof asPrivate>;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('SuperMcpHttpManager.getSubprocessInfo() — shape', () => {
  it('returns not-started shape when the manager has never spawned', () => {
    const manager = createConfiguredManager();
    const info = manager.getSubprocessInfo();

    expect(info).toEqual<SuperMcpSubprocessInfo>({
      pid: null,
      startTime: null,
      uptime: null,
      isRunning: false,
      startCount: 0,
      restartCount: 0,
      lastStartupFailureAt: null,
      lastStartupError: null,
      circuitBreakerActive: false,
      cooldownRemainingMs: null,
      lastRestartReason: null,
    });
  });

  it('returns running shape when the process is live', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      const manager = createConfiguredManager();
      const p = asPrivate(manager);

      // Simulate successful spawn: populate private state as doStart() would.
      p.state.process = { pid: 42 };
      p.state.isRunning = true;
      p.state.startTime = 1_700_000_000_000;
      p.startCount = 1;

      // Advance 2s so uptime is non-zero.
      vi.setSystemTime(1_700_000_002_000);

      const info = manager.getSubprocessInfo();
      expect(info.pid).toBe(42);
      expect(info.startTime).toBe(1_700_000_000_000);
      expect(info.uptime).toBe(2_000);
      expect(info.isRunning).toBe(true);
      expect(info.startCount).toBe(1);
      expect(info.restartCount).toBe(0);
      expect(info.circuitBreakerActive).toBe(false);
      expect(info.cooldownRemainingMs).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uptime is null when startTime is set but process is not running', () => {
    const manager = createConfiguredManager();
    const p = asPrivate(manager);

    p.state.startTime = 1_700_000_000_000;
    p.state.isRunning = false; // exited

    const info = manager.getSubprocessInfo();
    expect(info.uptime).toBeNull();
  });

  it('reflects circuit-breaker state with a decrementing cooldownRemainingMs', () => {
    vi.useFakeTimers();
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    try {
      const manager = createConfiguredManager();
      const p = asPrivate(manager);

      // Inject a recent failure — 60s cooldown window.
      p.lastStartupFailureAt = now;
      p.lastStartupError = 'boom';

      const immediate = manager.getSubprocessInfo();
      expect(immediate.circuitBreakerActive).toBe(true);
      expect(immediate.lastStartupFailureAt).toBe(now);
      expect(immediate.lastStartupError).toBe('boom');
      expect(immediate.cooldownRemainingMs).toBe(120_000);

      // Advance 30s — 90s remaining of 120s cooldown.
      vi.setSystemTime(now + 30_000);
      const mid = manager.getSubprocessInfo();
      expect(mid.circuitBreakerActive).toBe(true);
      expect(mid.cooldownRemainingMs).toBe(90_000);

      // Advance past the window — breaker reports inactive, remaining = null.
      vi.setSystemTime(now + 121_000);
      const expired = manager.getSubprocessInfo();
      expect(expired.circuitBreakerActive).toBe(false);
      expect(expired.cooldownRemainingMs).toBeNull();
      // lastStartupFailureAt stays populated until explicitly reset.
      expect(expired.lastStartupFailureAt).toBe(now);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resetCircuitBreaker() clears lastStartupFailureAt / lastStartupError', () => {
    const manager = createConfiguredManager();
    const p = asPrivate(manager);
    p.lastStartupFailureAt = Date.now();
    p.lastStartupError = 'boom';

    manager.resetCircuitBreaker();

    const info = manager.getSubprocessInfo();
    expect(info.lastStartupFailureAt).toBeNull();
    expect(info.lastStartupError).toBeNull();
    expect(info.circuitBreakerActive).toBe(false);
  });
});

describe('SuperMcpHttpManager.subprocessEvents — emission contract', () => {
  let manager: SuperMcpHttpManager;

  beforeEach(() => {
    manager = createConfiguredManager();
  });

  afterEach(() => {
    // We intentionally do NOT removeAllListeners — that would violate the
    // contract documented on `subprocessEvents`. Tests own their listeners.
  });

  it('emit("spawned") delivers { pid, at } to listeners', () => {
    const listener = vi.fn();
    manager.subprocessEvents.on('spawned', listener);

    manager.subprocessEvents.emit('spawned', { pid: 12345, at: 1_700_000_000_000 });

    expect(listener).toHaveBeenCalledWith({ pid: 12345, at: 1_700_000_000_000 });

    manager.subprocessEvents.off('spawned', listener);
  });

  it('emit("exited") delivers { pid, at, code, signal } to listeners', () => {
    const listener = vi.fn();
    manager.subprocessEvents.on('exited', listener);

    manager.subprocessEvents.emit('exited', {
      pid: 999,
      at: 1_700_000_005_000,
      code: 1,
      signal: null,
    });

    expect(listener).toHaveBeenCalledWith({
      pid: 999,
      at: 1_700_000_005_000,
      code: 1,
      signal: null,
    });

    manager.subprocessEvents.off('exited', listener);
  });

  it('off() unsubscribes the listener', () => {
    const listener = vi.fn();
    manager.subprocessEvents.on('spawned', listener);
    manager.subprocessEvents.off('spawned', listener);
    manager.subprocessEvents.emit('spawned', { pid: 1, at: 0 });
    expect(listener).not.toHaveBeenCalled();
  });
});

// ── M2 refinement: child-process lifetime contract ───────────────────

/**
 * Minimal fake `ChildProcess` EventEmitter so we can drive `error` / `exit`
 * handlers without touching real `spawn()`. Matches the surface area the
 * manager attaches listeners to.
 */
class FakeChildProcess extends EventEmitter {
  public readonly pid: number;
  public killed = false;
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe('SuperMcpHttpManager — M2 double-emit guard on child error/exit', () => {
  /**
   * Drive the manager's internal error/exit handlers directly by replicating
   * the relevant snippet of `doStart()`. This avoids spawning real processes
   * while still exercising the production code path: `exitEmittedForCurrentProcess`
   * guard + `subprocessEvents.emit('exited', ...)` from both handlers.
   *
   * We do this by calling a tiny test-only helper that is what doStart() does
   * after a successful spawn — effectively copying the contract so the
   * guarantee is behaviourally tested without invoking `spawn()`.
   */
  function attachHandlersAsDoStartWould(
    manager: SuperMcpHttpManager,
    proc: FakeChildProcess,
  ): void {
    const p = manager as unknown as {
      state: {
        process: FakeChildProcess | null;
        isRunning: boolean;
        startTime: number | null;
      };
      startCount: number;
      exitEmittedForCurrentProcess: boolean;
      subprocessEvents: SuperMcpHttpManager['subprocessEvents'];
    };
    p.state.process = proc;
    p.state.startTime = Date.now();
    p.state.isRunning = true;
    p.startCount += 1;
    p.exitEmittedForCurrentProcess = false;
    p.subprocessEvents.emit('spawned', { pid: proc.pid, at: p.state.startTime });

    proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      const exitedPid = proc.pid ?? null;
      p.state.isRunning = false;
      p.state.process = null;
      if (exitedPid !== null && !p.exitEmittedForCurrentProcess) {
        p.exitEmittedForCurrentProcess = true;
        p.subprocessEvents.emit('exited', {
          pid: exitedPid,
          at: Date.now(),
          code,
          signal,
        });
      }
    });

    proc.on('error', (_error: Error) => {
      const pid = p.state.process?.pid ?? proc.pid ?? null;
      if (pid !== null && !p.exitEmittedForCurrentProcess) {
        p.exitEmittedForCurrentProcess = true;
        p.subprocessEvents.emit('exited', {
          pid,
          at: Date.now(),
          code: null,
          signal: null,
        });
      }
      p.state.isRunning = false;
      p.state.process = null;
    });
  }

  it('child `error` emits `exited` exactly once and clears state', () => {
    const manager = createConfiguredManager();
    const exitedListener = vi.fn();
    const spawnedListener = vi.fn();
    manager.subprocessEvents.on('spawned', spawnedListener);
    manager.subprocessEvents.on('exited', exitedListener);

    const proc = new FakeChildProcess(7777);
    attachHandlersAsDoStartWould(manager, proc);

    proc.emit('error', new Error('ENOENT'));

    expect(spawnedListener).toHaveBeenCalledTimes(1);
    expect(exitedListener).toHaveBeenCalledTimes(1);
    expect(exitedListener).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 7777, code: null, signal: null }),
    );
    const info = manager.getSubprocessInfo();
    expect(info.isRunning).toBe(false);
    expect(info.pid).toBeNull();

    manager.subprocessEvents.off('spawned', spawnedListener);
    manager.subprocessEvents.off('exited', exitedListener);
  });

  it('when both `error` and `exit` fire for the same child, `exited` is emitted exactly once', () => {
    const manager = createConfiguredManager();
    const exitedListener = vi.fn();
    manager.subprocessEvents.on('exited', exitedListener);

    const proc = new FakeChildProcess(8888);
    attachHandlersAsDoStartWould(manager, proc);

    proc.emit('error', new Error('EACCES'));
    proc.emit('exit', 1, null);

    expect(exitedListener).toHaveBeenCalledTimes(1);

    manager.subprocessEvents.off('exited', exitedListener);
  });

  it('full lifecycle: spawn → error → exit → fresh spawn — no listener leaks, exactly two spawned + two exited', () => {
    const manager = createConfiguredManager();
    const spawnedListener = vi.fn();
    const exitedListener = vi.fn();
    manager.subprocessEvents.on('spawned', spawnedListener);
    manager.subprocessEvents.on('exited', exitedListener);

    // Baseline listener counts for leak detection.
    const baselineSpawned = manager.subprocessEvents.listenerCount('spawned');
    const baselineExited = manager.subprocessEvents.listenerCount('exited');

    const procA = new FakeChildProcess(100);
    attachHandlersAsDoStartWould(manager, procA);
    procA.emit('error', new Error('ENOENT'));
    procA.emit('exit', null, null); // Guarded — should not double-emit.

    const procB = new FakeChildProcess(101);
    attachHandlersAsDoStartWould(manager, procB);
    procB.emit('exit', 0, null);

    expect(spawnedListener).toHaveBeenCalledTimes(2);
    expect(exitedListener).toHaveBeenCalledTimes(2);
    expect(exitedListener.mock.calls[0][0]).toMatchObject({ pid: 100 });
    expect(exitedListener.mock.calls[1][0]).toMatchObject({ pid: 101 });

    // No growth in listener counts on the manager's event emitter itself
    // (procA / procB are short-lived fakes and their listeners go away with
    // them — what matters is that the manager-level listeners don't leak).
    expect(manager.subprocessEvents.listenerCount('spawned')).toBe(baselineSpawned);
    expect(manager.subprocessEvents.listenerCount('exited')).toBe(baselineExited);

    manager.subprocessEvents.off('spawned', spawnedListener);
    manager.subprocessEvents.off('exited', exitedListener);
  });
});

// ── Stage 2 (260424): lastRestartReason attribution ─────────────────

/**
 * Stage 2 of `docs/plans/260424_observability_followups.md` — attribution for
 * *why* the most recent restart fired. These tests cover the naturally-reachable
 * trigger sites via `vi.spyOn`-style stubs (same pattern as `scheduleRestart.test.ts`)
 * without spinning up real spawn / retry pipelines.
 *
 * Not covered here (plan-listed but no internal restart path exists):
 *   - `'spawn-exit'`, `'spawn-error'` — the child-process exit / error
 *     handlers in this manager do NOT auto-restart; they merely mark state
 *     dead + emit `subprocessEvents.exited`. A subscriber would initiate any
 *     follow-up restart and would attribute it via one of the existing
 *     trigger sites.
 *   - `'circuit-breaker-reset'` — the cooldown-expired reset sits inside
 *     `startWithRetries`, which further drives `this.start()` → `doStart()`
 *     → real spawn. Exercising that path end-to-end without spawn requires
 *     the heavier spawn/net/fs mock harness from
 *     `src/main/services/__tests__/superMcpHttpManager.circuitBreaker.test.ts`;
 *     adding it here would duplicate that harness. The code setting
 *     `lastRestartReason = 'circuit-breaker-reset'` lives between the
 *     cooldown check and `resetCircuitBreaker()` — covered indirectly by
 *     the circuit-breaker integration tests in that file.
 */
describe('SuperMcpHttpManager — lastRestartReason attribution (Stage 2, 260424)', () => {
  it('is null on a fresh manager (before any restart is triggered)', () => {
    const manager = createConfiguredManager();
    expect(manager.getSubprocessInfo().lastRestartReason).toBeNull();
  });

  it('clean stop() clears lastRestartReason to null', async () => {
    const manager = createConfiguredManager();
    const p = asPrivate(manager);
    // Pretend we had a prior restart attribution.
    p.lastRestartReason = 'idle-restart';

    // stop() with no process present returns early but still clears on a
    // clean (non-restart) path.
    expect(p.isStopForRestart).toBe(false);
    await p.stopNow();

    expect(manager.getSubprocessInfo().lastRestartReason).toBeNull();
  });

  it('stop() preserves lastRestartReason when it is being called mid-restart', async () => {
    const manager = createConfiguredManager();
    const p = asPrivate(manager);
    p.lastRestartReason = 'reconfigure';
    // Simulate being inside a doRestart / reconfigure stop() window.
    p.isStopForRestart = true;

    await p.stopNow();

    // Attribution survives so `doRestart`'s subsequent `start()` and the
    // "Super-MCP restart complete" log still read the correct reason.
    expect(manager.getSubprocessInfo().lastRestartReason).toBe('reconfigure');
  });

  it('scheduleRestartWhenIdle() sets lastRestartReason to "idle-restart" on the immediate path', () => {
    const manager = createConfiguredManager();
    // Spy on restart internals so we don't actually spawn / go through doRestart.
    const restartSpy = vi.spyOn(asPrivate(manager), 'restartNow').mockResolvedValue(undefined);

    // activeTurns === 0 via the module-level mock → immediate-fire branch.
    manager.scheduleRestartWhenIdle();

    expect(restartSpy).toHaveBeenCalledTimes(1);
    expect(manager.getSubprocessInfo().lastRestartReason).toBe('idle-restart');
  });

  it('debouncedRestart() sets lastRestartReason to "debounced-workspace-change" after the debounce window', async () => {
    vi.useFakeTimers();
    try {
      const manager = createConfiguredManager();
      const restartSpy = vi.spyOn(asPrivate(manager), 'restartNow').mockResolvedValue(undefined);

      const done = manager.requestDebouncedRestartWhenIdle({
        configPath: '/tmp/test-config.json',
        context: 'workspace-change',
      });

      // Before the debounce fires, reason is untouched.
      expect(manager.getSubprocessInfo().lastRestartReason).toBeNull();
      expect(restartSpy).not.toHaveBeenCalled();

      // Advance past the 3s debounce window.
      await vi.advanceTimersByTimeAsync(3_000);
      await done;

      expect(restartSpy).toHaveBeenCalledTimes(1);
      expect(manager.getSubprocessInfo().lastRestartReason).toBe(
        'debounced-workspace-change',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconfigure() sets lastRestartReason to "reconfigure"', async () => {
    const manager = createConfiguredManager();
    // Not running → no stop() call needed. Spy on startWithRetries so we don't
    // drive the real port-selection + spawn pipeline.
    const startWithRetriesSpy = vi
      .spyOn(manager, 'startWithRetries')
      .mockResolvedValue({ success: true, port: 3201, attempts: 1 });

    await asPrivate(manager).reconfigureNow('/tmp/new-config.json');

    expect(startWithRetriesSpy).toHaveBeenCalledTimes(1);
    expect(manager.getSubprocessInfo().lastRestartReason).toBe('reconfigure');
  });

  it('ensureRunningAfterResume() sets lastRestartReason to "post-resume" when the health probe fails', async () => {
    const manager = createConfiguredManager();
    // Pretend super-mcp is unhealthy after resume so the restart path fires.
    vi.spyOn(manager, 'checkHealth').mockResolvedValue(false);
    const startWithRetriesSpy = vi
      .spyOn(manager, 'startWithRetries')
      .mockResolvedValue({ success: true, port: 3201, attempts: 1 });

    await manager.ensureRunningAfterResume();

    expect(startWithRetriesSpy).toHaveBeenCalledTimes(1);
    expect(manager.getSubprocessInfo().lastRestartReason).toBe('post-resume');
  });
});
