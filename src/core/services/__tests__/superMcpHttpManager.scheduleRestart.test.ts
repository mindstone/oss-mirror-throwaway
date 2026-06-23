import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks – declared before imports so vi.mock hoisting works correctly
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
}));

const mockSendToAllWindows = vi.fn();
const mockGetBroadcastService = vi.fn(() => ({
  sendToAllWindows: mockSendToAllWindows,
  sendToFocusedWindow: vi.fn(),
}));

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => mockGetBroadcastService(),
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

// Mock agentTurnRegistry with controllable getActiveTurnCount and onDrained
const mockGetActiveTurnCount = vi.fn<() => number>().mockReturnValue(0);
const mockOnDrained = vi.fn<(cb: () => void) => void>();

vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getActiveTurnCount: () => mockGetActiveTurnCount(),
    onDrained: (cb: () => void) => mockOnDrained(cb),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are set up)
// ---------------------------------------------------------------------------

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

function asPrivate(manager: SuperMcpHttpManager): {
  restartNow: () => Promise<void>;
  executeConfigChangeRestart: (configPath: string, context: string) => Promise<void>;
} {
  return manager as unknown as ReturnType<typeof asPrivate>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SuperMcpHttpManager.scheduleRestartWhenIdle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockGetBroadcastService.mockReturnValue({
      sendToAllWindows: mockSendToAllWindows,
      sendToFocusedWindow: vi.fn(),
    });
    mockGetActiveTurnCount.mockReturnValue(0);
    mockOnDrained.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('restarts immediately when no active turns', () => {
    const manager = createConfiguredManager();
    const restartSpy = vi.spyOn(asPrivate(manager), 'restartNow').mockResolvedValue();

    mockGetActiveTurnCount.mockReturnValue(0);

    manager.scheduleRestartWhenIdle();

    // restart() should have been called (fire-and-forget)
    expect(restartSpy).toHaveBeenCalledOnce();
    // onDrained should NOT have been registered
    expect(mockOnDrained).not.toHaveBeenCalled();
  });

  it('defers restart when active turns exist', () => {
    const manager = createConfiguredManager();
    const restartSpy = vi.spyOn(asPrivate(manager), 'restartNow').mockResolvedValue();

    mockGetActiveTurnCount.mockReturnValue(2);

    manager.scheduleRestartWhenIdle();

    // restart() should NOT have been called yet
    expect(restartSpy).not.toHaveBeenCalled();
    // onDrained should have been registered
    expect(mockOnDrained).toHaveBeenCalledOnce();
  });

  it('broadcasts config-change restart deferral when active turns exist', () => {
    const manager = createConfiguredManager();

    mockGetActiveTurnCount.mockReturnValue(2);

    void manager.requestRestartForConfigChangeAndAwaitExecution({
      configPath: '/tmp/config-change.json',
      context: 'settings-upsert:Linear',
    });

    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      'super-mcp:restart-deferred',
      expect.objectContaining({
        context: 'settings-upsert:Linear',
        activeTurns: 2,
        deferredAt: expect.any(Number),
      }),
    );
    expect(mockOnDrained).toHaveBeenCalledOnce();
  });

  it('broadcasts config-change restart deferral when coalescing into an already pending restart', () => {
    const manager = createConfiguredManager();

    mockGetActiveTurnCount.mockReturnValue(2);

    void manager.requestRestartForConfigChangeAndAwaitExecution({
      configPath: '/tmp/config-change-a.json',
      context: 'settings-upsert:Linear',
    });
    void manager.requestRestartForConfigChangeAndAwaitExecution({
      configPath: '/tmp/config-change-b.json',
      context: 'mcp-server-removal:Slack',
    });

    expect(mockSendToAllWindows).toHaveBeenCalledTimes(2);
    expect(mockSendToAllWindows).toHaveBeenNthCalledWith(
      1,
      'super-mcp:restart-deferred',
      expect.objectContaining({
        context: 'settings-upsert:Linear',
        activeTurns: 2,
        deferredAt: expect.any(Number),
      }),
    );
    expect(mockSendToAllWindows).toHaveBeenNthCalledWith(
      2,
      'super-mcp:restart-deferred',
      expect.objectContaining({
        context: 'mcp-server-removal:Slack',
        activeTurns: 2,
        deferredAt: expect.any(Number),
      }),
    );
    expect(mockOnDrained).toHaveBeenCalledOnce();
  });

  it('does not broadcast config-change restart deferral when restart runs immediately', () => {
    const manager = createConfiguredManager();
    const configRestartSpy = vi
      .spyOn(asPrivate(manager), 'executeConfigChangeRestart')
      .mockResolvedValue();

    mockGetActiveTurnCount.mockReturnValue(0);

    void manager.requestRestartForConfigChangeAndAwaitExecution({
      configPath: '/tmp/config-change.json',
      context: 'settings-upsert:Linear',
    });

    expect(configRestartSpy).toHaveBeenCalledOnce();
    expect(mockSendToAllWindows).not.toHaveBeenCalledWith(
      'super-mcp:restart-deferred',
      expect.anything(),
    );
    expect(mockOnDrained).not.toHaveBeenCalled();
  });

  it('keeps config-change restart scheduled when deferral broadcast is unavailable', () => {
    const manager = createConfiguredManager();

    mockGetActiveTurnCount.mockReturnValue(1);
    mockGetBroadcastService.mockImplementation(() => {
      throw new Error('BroadcastService not initialized');
    });

    expect(() => {
      void manager.requestRestartForConfigChangeAndAwaitExecution({
        configPath: '/tmp/config-change.json',
        context: 'mcp-server-removal:Linear',
      });
    }).not.toThrow();

    expect(mockOnDrained).toHaveBeenCalledOnce();
  });

  it('fires restart when turns drain (via onDrained callback)', async () => {
    const manager = createConfiguredManager();
    const restartSpy = vi.spyOn(asPrivate(manager), 'restartNow').mockResolvedValue();

    mockGetActiveTurnCount.mockReturnValue(2);

    manager.scheduleRestartWhenIdle();

    expect(restartSpy).not.toHaveBeenCalled();

    // Simulate drain: set turn count to 0 and invoke the callback
    mockGetActiveTurnCount.mockReturnValue(0);
    const drainCallback = mockOnDrained.mock.calls[0][0];
    drainCallback();

    // Allow microtask to settle
    await vi.advanceTimersByTimeAsync(0);

    expect(restartSpy).toHaveBeenCalledOnce();
  });

  it('re-registers onDrained if new turns started between drain and callback (TOCTOU)', async () => {
    const manager = createConfiguredManager();
    const restartSpy = vi.spyOn(asPrivate(manager), 'restartNow').mockResolvedValue();

    mockGetActiveTurnCount.mockReturnValue(1);

    manager.scheduleRestartWhenIdle();

    // First drain callback fires, but a new turn has started
    mockGetActiveTurnCount.mockReturnValue(1); // Turn started between drain and callback
    const firstDrainCallback = mockOnDrained.mock.calls[0][0];
    firstDrainCallback();

    await vi.advanceTimersByTimeAsync(0);

    // restart() should NOT have been called (TOCTOU protection)
    expect(restartSpy).not.toHaveBeenCalled();
    // A new onDrained callback should have been registered
    expect(mockOnDrained).toHaveBeenCalledTimes(2);

    // Now simulate actual drain
    mockGetActiveTurnCount.mockReturnValue(0);
    const secondDrainCallback = mockOnDrained.mock.calls[1][0];
    secondDrainCallback();

    await vi.advanceTimersByTimeAsync(0);

    expect(restartSpy).toHaveBeenCalledOnce();
  });

  it('coalesces multiple calls into one restart', () => {
    const manager = createConfiguredManager();
    const restartSpy = vi.spyOn(asPrivate(manager), 'restartNow').mockResolvedValue();

    mockGetActiveTurnCount.mockReturnValue(3);

    manager.scheduleRestartWhenIdle();
    manager.scheduleRestartWhenIdle();
    manager.scheduleRestartWhenIdle();

    // Only one onDrained callback should be registered (coalesced)
    expect(mockOnDrained).toHaveBeenCalledOnce();
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('forces restart after the deferral safety ceiling (aligned with watchdog AUTO_ABORT_MS)', async () => {
    const manager = createConfiguredManager();
    const restartSpy = vi.spyOn(asPrivate(manager), 'restartNow').mockResolvedValue();

    mockGetActiveTurnCount.mockReturnValue(5);

    manager.scheduleRestartWhenIdle();

    expect(restartSpy).not.toHaveBeenCalled();

    // Advance to just before the ceiling (30 min)
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1);
    expect(restartSpy).not.toHaveBeenCalled();

    // Advance past the ceiling
    await vi.advanceTimersByTimeAsync(1);

    expect(restartSpy).toHaveBeenCalledOnce();
  });

  it('does not fire forced restart if pending flag was cleared (drain happened before ceiling)', async () => {
    const manager = createConfiguredManager();
    const restartSpy = vi.spyOn(asPrivate(manager), 'restartNow').mockResolvedValue();

    mockGetActiveTurnCount.mockReturnValue(1);

    manager.scheduleRestartWhenIdle();

    // Simulate drain before ceiling fires
    mockGetActiveTurnCount.mockReturnValue(0);
    const drainCallback = mockOnDrained.mock.calls[0][0];
    drainCallback();
    await vi.advanceTimersByTimeAsync(0);

    // First restart from drain
    expect(restartSpy).toHaveBeenCalledOnce();

    // Advance past the ceiling — should NOT restart again
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    expect(restartSpy).toHaveBeenCalledOnce(); // Still 1
  });

  it('ignores call when not configured', () => {
    const manager = new SuperMcpHttpManager();
    // Should not throw, just log and return
    expect(() => manager.scheduleRestartWhenIdle()).not.toThrow();
    expect(mockOnDrained).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Stage 3 (260610_gworkspace-mcp-error-disconnect-hang): per-request deferral
  // signal. `onRestartDeferred` is a fire-once, fire-now signal for the LOCAL
  // request — it must fire at BOTH deferral sites (fresh-defer + coalesce) and
  // must NOT fire on the idle path or re-fire when the drained work executes.
  // -------------------------------------------------------------------------

  describe('onRestartDeferred per-request deferral signal', () => {
    it('invokes onRestartDeferred once when the restart is deferred behind active turns', () => {
      const manager = createConfiguredManager();

      mockGetActiveTurnCount.mockReturnValue(2);
      const onRestartDeferred = vi.fn();

      void manager.requestRestartForConfigChangeAndAwaitExecution({
        configPath: '/tmp/config-change.json',
        context: 'google-workspace-connect',
        onRestartDeferred,
      });

      expect(onRestartDeferred).toHaveBeenCalledTimes(1);
      expect(onRestartDeferred).toHaveBeenCalledWith({ activeTurns: 2 });
      // Broadcast still fires alongside the local callback.
      expect(mockSendToAllWindows).toHaveBeenCalledWith(
        'super-mcp:restart-deferred',
        expect.objectContaining({ context: 'google-workspace-connect' }),
      );
    });

    it('invokes the coalescing request\'s own onRestartDeferred (merge must not drop it)', () => {
      const manager = createConfiguredManager();

      mockGetActiveTurnCount.mockReturnValue(2);
      const firstDeferred = vi.fn();
      const secondDeferred = vi.fn();

      void manager.requestRestartForConfigChangeAndAwaitExecution({
        configPath: '/tmp/config-change-a.json',
        context: 'google-workspace-connect',
        onRestartDeferred: firstDeferred,
      });
      void manager.requestRestartForConfigChangeAndAwaitExecution({
        configPath: '/tmp/config-change-b.json',
        context: 'slack-connect',
        onRestartDeferred: secondDeferred,
      });

      // Each request's callback fires exactly once, at its own deferral site.
      expect(firstDeferred).toHaveBeenCalledTimes(1);
      expect(secondDeferred).toHaveBeenCalledTimes(1);
      expect(secondDeferred).toHaveBeenCalledWith({ activeTurns: 2 });
    });

    it('does not invoke onRestartDeferred when the restart runs immediately (idle path)', async () => {
      const manager = createConfiguredManager();
      vi.spyOn(asPrivate(manager), 'executeConfigChangeRestart').mockResolvedValue();

      mockGetActiveTurnCount.mockReturnValue(0);
      const onRestartDeferred = vi.fn();

      await manager.requestRestartForConfigChangeAndAwaitExecution({
        configPath: '/tmp/config-change.json',
        context: 'google-workspace-connect',
        onRestartDeferred,
      });

      expect(onRestartDeferred).not.toHaveBeenCalled();
    });

    it('does not re-invoke onRestartDeferred when the drained pending work executes (and completions still resolve)', async () => {
      const manager = createConfiguredManager();
      vi.spyOn(asPrivate(manager), 'executeConfigChangeRestart').mockResolvedValue();

      mockGetActiveTurnCount.mockReturnValue(1);
      const firstDeferred = vi.fn();
      const secondDeferred = vi.fn();

      const firstCompletion = manager.requestRestartForConfigChangeAndAwaitExecution({
        configPath: '/tmp/config-change-a.json',
        context: 'google-workspace-connect',
        onRestartDeferred: firstDeferred,
      });
      const secondCompletion = manager.requestRestartForConfigChangeAndAwaitExecution({
        configPath: '/tmp/config-change-b.json',
        context: 'slack-connect',
        onRestartDeferred: secondDeferred,
      });

      // Drain: turns hit 0, the registered drain callback runs the merged work.
      mockGetActiveTurnCount.mockReturnValue(0);
      const drainCallback = mockOnDrained.mock.calls[0][0];
      drainCallback();
      await vi.advanceTimersByTimeAsync(0);

      await expect(firstCompletion).resolves.toBeUndefined();
      await expect(secondCompletion).resolves.toBeUndefined();

      // Fire-once contract: execution of the merged work must not re-signal.
      expect(firstDeferred).toHaveBeenCalledTimes(1);
      expect(secondDeferred).toHaveBeenCalledTimes(1);
    });
  });
});
