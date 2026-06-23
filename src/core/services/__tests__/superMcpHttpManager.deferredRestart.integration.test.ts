import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Stage 3 (260616_cross-module-test-coverage) — MCP connector deferred-restart
// queued-op RESOLUTION + DRAIN-ORDER contract.
//
// Class under test: a config-restart op (the backing operation for a connector
// connect/disconnect/toggle) enqueued WHILE an in-flight restart is deferred
// behind active agent turns must, on drain ("reconnect"):
//   (1) RESOLVE — not hang, not silently drop; and
//   (2) the await form must resolve ONLY after the deferred restart actually
//       EXECUTES (the 260610 resolve-on-execution contract), never while still
//       deferred; and
//   (3) multiple queued ops must DRAIN IN ARRIVAL ORDER through the single
//       coalesced restart.
//
// Bugs this guards: 260610_connector_disconnect_deferred_restart_ipc_hang
// (the IPC promise was coupled to a deferred restart and could hang up to 30
// min) and 260610_connector_queued_state_incomplete_entrypoint_coverage (a
// queued op on a sibling entrypoint silently bypassed the tracked path).
//
// Distinct from the existing `superMcpHttpManager.scheduleRestart.test.ts`,
// which asserts resolution-after-drain and onRestartDeferred fire-once
// semantics but NEVER pins (a) the resolve-ONLY-after-execution timing of the
// deferred await form, nor (b) the ARRIVAL-ORDER drain of coalesced queued
// work. Mocks only the transport/IPC boundary (subprocess restart +
// agentTurnRegistry); the manager's real defer/coalesce/drain state machine
// runs unmocked.
// ---------------------------------------------------------------------------

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
  setErrorReporter: vi.fn(),
}));

const mockSendToAllWindows = vi.fn();
vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({
    sendToAllWindows: mockSendToAllWindows,
    sendToFocusedWindow: vi.fn(),
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

// Controllable turn registry — this is the only "transport"/IPC boundary mock.
const mockGetActiveTurnCount = vi.fn<() => number>().mockReturnValue(0);
const mockOnDrained = vi.fn<(cb: () => void) => void>();

vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getActiveTurnCount: () => mockGetActiveTurnCount(),
    onDrained: (cb: () => void) => mockOnDrained(cb),
  },
}));

import { SuperMcpHttpManager } from '../superMcpHttpManager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Stub the actual subprocess-restart boundary (`executeConfigChangeRestart`)
 * so the real defer/coalesce/drain state machine runs but no process spawns.
 * Records the order in which the underlying restart executes.
 */
function stubRestartBoundary(
  manager: SuperMcpHttpManager,
  log: string[],
): ReturnType<typeof vi.fn> {
  return vi
    .spyOn(
      manager as unknown as {
        executeConfigChangeRestart: (configPath: string, context: string) => Promise<void>;
      },
      'executeConfigChangeRestart',
    )
    .mockImplementation(async (_configPath: string, context: string) => {
      log.push(`restart:${context}`);
    });
}

/** Drive the registered drain callback (simulates "reconnect" after turns finish). */
async function drainTurns(): Promise<void> {
  mockGetActiveTurnCount.mockReturnValue(0);
  const drainCallback = mockOnDrained.mock.calls[0]?.[0];
  if (!drainCallback) throw new Error('expected a drain callback to be registered');
  drainCallback();
  await vi.advanceTimersByTimeAsync(0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SuperMcpHttpManager deferred-restart queued-op resolution + drain order (260610)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockGetActiveTurnCount.mockReturnValue(0);
    mockOnDrained.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // (1) + (2): a single op enqueued mid-restart RESOLVES on reconnect, and the
  // await form resolves ONLY after the deferred restart executes — never while
  // still deferred (the 260610 resolve-on-execution contract). Bounded by a
  // fake timer so a regression to "never resolves" is observed as a hang
  // without a real wait.
  it('resolves a queued-during-restart op after reconnect — and not before execution', async () => {
    const manager = createConfiguredManager();
    const log: string[] = [];
    const restartSpy = stubRestartBoundary(manager, log);

    // Active turns → the restart (and thus the await form) is deferred.
    mockGetActiveTurnCount.mockReturnValue(2);

    let resolved = false;
    const completion = manager
      .requestRestartForConfigChangeAndAwaitExecution({
        configPath: '/tmp/disconnect.json',
        context: 'mcp-server-removal:Slack',
      })
      .then(() => {
        resolved = true;
      });

    // Contract: while deferred, the op has NOT resolved (the inverse of the
    // 260610 hang — the await form must wait for execution, not resolve early).
    await vi.advanceTimersByTimeAsync(0);
    expect(restartSpy).not.toHaveBeenCalled();
    expect(resolved).toBe(false);

    // It must also not silently resolve at any point short of drain (bounded,
    // deterministic — no real sleep). One minute of deferral, still pending.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolved).toBe(false);

    // Reconnect: turns drain → the deferred restart executes → op resolves.
    await drainTurns();
    await completion; // would hang the test (fake-timer bounded) on a drop/never-resolve regression

    expect(restartSpy).toHaveBeenCalledOnce();
    expect(resolved).toBe(true);
    expect(log).toEqual(['restart:mcp-server-removal:Slack']);
  });

  // (3): multiple ops queued mid-defer coalesce into ONE restart and drain
  // their completion + afterRestart callbacks in ARRIVAL ORDER on reconnect.
  it('drains coalesced queued ops in arrival order on reconnect', async () => {
    const manager = createConfiguredManager();
    const log: string[] = [];
    const restartSpy = stubRestartBoundary(manager, log);

    mockGetActiveTurnCount.mockReturnValue(3);

    // Three connector ops enqueued while a restart is deferred.
    const first = manager
      .requestRestartForConfigChangeAndAwaitExecution({
        configPath: '/tmp/a.json',
        context: 'google-workspace-connect',
        afterRestart: () => log.push('after:google-workspace-connect'),
      })
      .then(() => log.push('resolve:google-workspace-connect'));
    const second = manager
      .requestRestartForConfigChangeAndAwaitExecution({
        configPath: '/tmp/b.json',
        context: 'slack-connect',
        afterRestart: () => log.push('after:slack-connect'),
      })
      .then(() => log.push('resolve:slack-connect'));
    const third = manager
      .requestRestartForConfigChangeAndAwaitExecution({
        configPath: '/tmp/c.json',
        context: 'mcp-server-removal:Linear',
        afterRestart: () => log.push('after:mcp-server-removal:Linear'),
      })
      .then(() => log.push('resolve:mcp-server-removal:Linear'));

    await vi.advanceTimersByTimeAsync(0);
    // Coalesced: nothing has executed while deferred.
    expect(restartSpy).not.toHaveBeenCalled();
    expect(log).toEqual([]);

    // Reconnect.
    await drainTurns();
    await Promise.all([first, second, third]);

    // Exactly ONE coalesced restart executed (last-writer execute fn).
    expect(restartSpy).toHaveBeenCalledOnce();

    // Drain order: restart executes first, then afterRestart callbacks in
    // arrival order, then completion resolutions in arrival order. None
    // dropped; none reordered.
    expect(log).toEqual([
      'restart:mcp-server-removal:Linear',
      'after:google-workspace-connect',
      'after:slack-connect',
      'after:mcp-server-removal:Linear',
      'resolve:google-workspace-connect',
      'resolve:slack-connect',
      'resolve:mcp-server-removal:Linear',
    ]);
  });
});
