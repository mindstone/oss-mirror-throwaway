import { beforeEach, describe, expect, it, vi } from 'vitest';

const flushPendingWrites = vi.fn(async () => undefined);
const finalizeActiveSessionsOnShutdown = vi.fn();
const abortAllTurns = vi.fn();
const getActiveTurnCount = vi.fn(() => 0);
const stopBundledInboxBridge = vi.fn(async () => undefined);
const stopOfficeSidecar = vi.fn(async () => undefined);
const closeConversationIndex = vi.fn(async () => undefined);
const disposeEmbeddingService = vi.fn(async () => undefined);
const stopEnhancement = vi.fn();
const stopWatching = vi.fn(async () => undefined);
const ollamaStop = vi.fn(async () => undefined);
const superMcpStop = vi.fn(async () => undefined);
const closeToolIndex = vi.fn(async () => undefined);
const closeFileIndex = vi.fn(async () => undefined);
const disposeMoonshine = vi.fn(async () => undefined);
const workspaceWatcherStop = vi.fn(async () => undefined);
const workspaceWatcherStart = vi.fn();
const workspaceWatcherGetCurrentDirectory = vi.fn<() => string | null>(() => '/workspace');
const cloudTokenRelayStop = vi.fn(async () => undefined);
const cloudTokenRelayStart = vi.fn();
const cloudTokenRelayGetConnection = vi.fn<() => { cloudUrl: string; cloudToken: string } | null>(() => ({
  cloudUrl: 'https://cloud.example',
  cloudToken: 'token-123',
}));
const libraryBroadcasterStop = vi.fn();
const libraryBroadcasterStart = vi.fn();
const stopTutorialPlayerServer = vi.fn(async () => undefined);
const disposePreTurnWorker = vi.fn(async () => undefined);
const terminateAllAtlasWorkers = vi.fn(async () => undefined);
const flushMainAnalytics = vi.fn(async () => undefined);
const trackMainEvent = vi.fn();
const getOrGenerateAnonymousId = vi.fn(() => 'anon-id');
const appendDiagnosticEvent = vi.fn();
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};
const immediateExitWithFseventsSweep = vi.fn(async () => undefined);
const cleanExitStoreGet = vi.fn((_key: string, defaultValue?: unknown) => defaultValue);
const cleanExitStoreSet = vi.fn();
// Reassigned per-test: null = cloud surface (matches the legacy fixed mock).
let electronModuleMock: {
  app: {
    on: ReturnType<typeof vi.fn>;
    exit: ReturnType<typeof vi.fn>;
    isPackaged: boolean;
    removeListener: ReturnType<typeof vi.fn>;
    releaseSingleInstanceLock: ReturnType<typeof vi.fn>;
  };
} | null = null;

vi.mock('@core/services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({
    flushPendingWrites,
    finalizeActiveSessionsOnShutdown,
  }),
}));
vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    abortAllTurns,
    getActiveTurnCount,
  },
}));
vi.mock('../bundledInboxBridge', () => ({
  stopBundledInboxBridge,
}));
vi.mock('../officeSidecarManager', () => ({
  stopOfficeSidecar,
}));
vi.mock('../conversationIndexService', () => ({
  closeConversationIndex,
}));
vi.mock('../embeddingService', () => ({
  disposeEmbeddingService,
}));
vi.mock('../enhancementService', () => ({
  stopEnhancement,
}));
vi.mock('../fileWatcherService', () => ({
  stopWatching,
}));
vi.mock('../ollamaService', () => ({
  ollamaService: {
    stop: ollamaStop,
  },
}));
vi.mock('../superMcpHttpManager', () => ({
  superMcpHttpManager: {
    stop: superMcpStop,
  },
  // gracefulShutdown imports this named export; omitting it makes the module
  // re-evaluation after vi.resetModules() throw a mock-shape error.
  stopSuperMcpForAppShutdown: superMcpStop,
}));
vi.mock('../toolIndexService', () => ({
  closeToolIndex,
}));
vi.mock('../fileIndexService', () => ({
  closeIndex: closeFileIndex,
}));
vi.mock('../moonshineTranscriber', () => ({
  dispose: disposeMoonshine,
}));
vi.mock('../workspaceWatcherService', () => ({
  workspaceWatcherService: {
    getCurrentDirectory: workspaceWatcherGetCurrentDirectory,
    start: workspaceWatcherStart,
    stop: workspaceWatcherStop,
  },
}));
vi.mock('../cloud/cloudTokenRelay', () => ({
  cloudTokenRelay: {
    getConnection: cloudTokenRelayGetConnection,
    start: cloudTokenRelayStart,
    stop: cloudTokenRelayStop,
  },
}));
vi.mock('../libraryBroadcaster', () => ({
  libraryBroadcaster: {
    start: libraryBroadcasterStart,
    stop: libraryBroadcasterStop,
  },
}));
vi.mock('../tutorialPlayerServer', () => ({
  stopTutorialPlayerServer,
}));
vi.mock('../preTurnWorkerService', () => ({
  disposeWorker: disposePreTurnWorker,
}));
vi.mock('../atlasService', () => ({
  terminateAllAtlasWorkers,
}));
vi.mock('../../analytics', () => ({
  flushMainAnalytics,
  getOrGenerateAnonymousId,
  trackMainEvent,
}));
vi.mock('@core/logger', () => ({
  logger,
  createScopedLogger: () => logger,
}));
vi.mock('@core/services/diagnosticEventsLedger', () => ({
  appendDiagnosticEvent,
}));
vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({
    version: '0.0.0-test',
  }),
}));
vi.mock('../autoUpdateService', () => ({
  isUpdateDownloading: () => false,
}));
vi.mock('./shutdownState', () => ({
  isShuttingDown: () => false,
  setShuttingDown: vi.fn(),
}));
vi.mock('@core/lazyElectron', () => ({
  getElectronModule: () => electronModuleMock,
}));
vi.mock('../finalExit', () => ({
  immediateExitWithFseventsSweep,
}));
vi.mock('@core/storeFactory', () => ({
  createStore: () => ({
    get: cleanExitStoreGet,
    set: cleanExitStoreSet,
  }),
}));

describe('gracefulShutdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceWatcherStop.mockResolvedValue(undefined);
    cloudTokenRelayStop.mockResolvedValue(undefined);
    workspaceWatcherGetCurrentDirectory.mockReturnValue('/workspace');
    cloudTokenRelayGetConnection.mockReturnValue({
      cloudUrl: 'https://cloud.example',
      cloudToken: 'token-123',
    });
  });

  it('drains active app-bridge pair sessions before stopping the manager', async () => {
    const manager = {
      isRunning: vi.fn(() => true),
      getActivePairSessions: vi.fn(() => [
        { pairSessionId: 'pair-1', browserId: 'chrome' },
        { pairSessionId: 'pair-2', browserId: 'edge' },
      ]),
      endPairSession: vi.fn(),
      stop: vi.fn(async () => undefined),
    };

    const shutdown = await import('../gracefulShutdown');
    shutdown.setAppBridgeManagerForShutdown(manager as never);

    await shutdown.gracefulShutdownServicesOnly();

    expect(manager.endPairSession).toHaveBeenNthCalledWith(1, 'pair-1', {
      stage: 'before-quit',
      reason: 'app-quit',
    });
    expect(manager.endPairSession).toHaveBeenNthCalledWith(2, 'pair-2', {
      stage: 'before-quit',
      reason: 'app-quit',
    });
    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  it('closes the file index and disposes moonshine ORT sessions on the shutdown roster (Stage 4)', async () => {
    // PLAN.md Stage 4: both native owners now have a bounded disposer on the
    // normal-quit roster (previously a tracked-gap — moonshine had none,
    // fileIndex.closeIndex was only wired on headless/cloud quit).
    const shutdown = await import('../gracefulShutdown');
    shutdown.setAppBridgeManagerForShutdown(null);

    await shutdown.gracefulShutdownServicesOnly();

    expect(closeFileIndex).toHaveBeenCalledTimes(1);
    expect(disposeMoonshine).toHaveBeenCalledTimes(1);
  });

  it('does not let a slow file-index close exceed the per-service budget (3s) or mislabel as completed', async () => {
    // The per-service cleanupService wrapper races each cleanup against
    // SERVICE_CLEANUP_TIMEOUT_MS (3s). A close that hangs past it must NOT block
    // shutdown unboundedly nor be logged as completed (it is a 'timeout').
    vi.useFakeTimers();
    closeFileIndex.mockImplementationOnce(() => new Promise<undefined>(() => undefined));
    const shutdown = await import('../gracefulShutdown');
    shutdown.setAppBridgeManagerForShutdown(null);

    const pending = shutdown.gracefulShutdownServicesOnly();
    // Advance well past the 3s per-service budget; the whole shutdown must settle.
    await vi.advanceTimersByTimeAsync(3500);
    await pending;

    // The summary log records fileIndex as a timeout, never 'completed'.
    const summaryCall = logger.info.mock.calls.find(
      ([arg]) => arg && typeof arg === 'object' && 'cleanupStatus' in arg,
    );
    expect(summaryCall).toBeDefined();
    const status = (summaryCall![0] as { cleanupStatus: Record<string, string> }).cleanupStatus;
    expect(status['fileIndex']).toBe('timeout');
    vi.useRealTimers();
  });

  it('records moonshine as timeout (not completed) when its disposer never resolves (F5)', async () => {
    // The per-service cleanupService wrapper races disposeMoonshine() against
    // SERVICE_CLEANUP_TIMEOUT_MS (3s). This locks the intended cleanup-status
    // labelling for the MOCKABLE async case. NOTE: in production a synchronously-
    // blocking native InferenceSession.release() is NOT bounded by this race (the
    // native dispose runs before the await yields, per the ORT spike / Stage-4
    // review F3) — the external WATCHDOG is the floor for that. This test only
    // proves the async-timeout labelling, not sync-native preemption.
    vi.useFakeTimers();
    disposeMoonshine.mockImplementationOnce(() => new Promise<undefined>(() => undefined));
    const shutdown = await import('../gracefulShutdown');
    shutdown.setAppBridgeManagerForShutdown(null);

    const pending = shutdown.gracefulShutdownServicesOnly();
    await vi.advanceTimersByTimeAsync(3500);
    await pending;

    const summaryCall = logger.info.mock.calls.find(
      ([arg]) => arg && typeof arg === 'object' && 'cleanupStatus' in arg,
    );
    expect(summaryCall).toBeDefined();
    const status = (summaryCall![0] as { cleanupStatus: Record<string, string> }).cleanupStatus;
    expect(status['moonshine']).toBe('timeout');
    vi.useRealTimers();
  });

  it('does NOT finalize sessions during gracefulShutdownServicesOnly (non-exit path)', async () => {
    // gracefulShutdownServicesOnly is used for workspace rename and pre-update
    // cleanup where the app continues running. Session finalization (which locks
    // the store read-only) must NOT run in this path.
    const shutdown = await import('../gracefulShutdown');
    shutdown.setAppBridgeManagerForShutdown(null);

    await shutdown.gracefulShutdownServicesOnly();

    expect(finalizeActiveSessionsOnShutdown).not.toHaveBeenCalled();
    expect(abortAllTurns).toHaveBeenCalledTimes(1);
  });

  it('finalizes active sessions during real app quit after aborting turns', async () => {
    // Verifies the post-drain shutdown finalization step runs during real quit,
    // fixing the false "Pick Up Where You Left Off" modal race.
    // See: docs/plans/260426_fix_shutdown_persistence_race.md
    const shutdown = await import('../gracefulShutdown');
    shutdown.setAppBridgeManagerForShutdown(null);

    // removeBeforeQuitHandlerForUpdate sets isQuitting = true internally,
    // simulating the state during a real app quit.
    shutdown.removeBeforeQuitHandlerForUpdate();

    await shutdown.gracefulShutdownServicesOnly();

    expect(finalizeActiveSessionsOnShutdown).toHaveBeenCalledTimes(1);
    expect(abortAllTurns).toHaveBeenCalledTimes(1);

    const abortOrder = abortAllTurns.mock.invocationCallOrder[0];
    const finalizeOrder = finalizeActiveSessionsOnShutdown.mock.invocationCallOrder[0];
    expect(finalizeOrder).toBeGreaterThan(abortOrder);
  });
});

describe('closeNativeWatchersForUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    workspaceWatcherStop.mockResolvedValue(undefined);
    cloudTokenRelayStop.mockResolvedValue(undefined);
    workspaceWatcherGetCurrentDirectory.mockReturnValue('/workspace');
    cloudTokenRelayGetConnection.mockReturnValue({
      cloudUrl: 'https://cloud.example',
      cloudToken: 'token-123',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops native-backed watchers and reports completed cleanup', async () => {
    const shutdown = await import('../gracefulShutdown');

    const result = await shutdown.closeNativeWatchersForUpdate();

    expect(result.completed).toBe(true);
    expect(libraryBroadcasterStop).toHaveBeenCalledOnce();
    expect(workspaceWatcherStop).toHaveBeenCalledOnce();
    expect(cloudTokenRelayStop).toHaveBeenCalledOnce();
    expect(libraryBroadcasterStop.mock.invocationCallOrder[0]).toBeLessThan(
      workspaceWatcherStop.mock.invocationCallOrder[0],
    );
    expect(libraryBroadcasterStop.mock.invocationCallOrder[0]).toBeLessThan(
      cloudTokenRelayStop.mock.invocationCallOrder[0],
    );
  });

  it('returns completed false on timeout and emits loud telemetry', async () => {
    vi.useFakeTimers();
    workspaceWatcherStop.mockImplementation(() => new Promise<undefined>(() => undefined));
    const shutdown = await import('../gracefulShutdown');

    const pending = shutdown.closeNativeWatchersForUpdate(25);
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(result.completed).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      { timeoutMs: 25 },
      'native watcher cleanup timed out before update quit; crash risk remains',
    );
    expect(appendDiagnosticEvent).toHaveBeenCalledWith({
      kind: 'auto_update_state_change',
      data: {
        transition: 'native_watcher_cleanup_timeout',
        platform: process.platform,
        timeoutMs: 25,
      },
    });
  });

  it('restores captured workspace watcher, library broadcaster, and token relay state', async () => {
    const shutdown = await import('../gracefulShutdown');

    const result = await shutdown.closeNativeWatchersForUpdate();
    workspaceWatcherGetCurrentDirectory.mockReturnValue(null);
    cloudTokenRelayGetConnection.mockReturnValue(null);

    result.restore();
    result.restore();

    expect(workspaceWatcherStart).toHaveBeenCalledOnce();
    expect(workspaceWatcherStart).toHaveBeenCalledWith('/workspace');
    expect(libraryBroadcasterStart).toHaveBeenCalledOnce();
    expect(cloudTokenRelayStart).toHaveBeenCalledOnce();
    expect(cloudTokenRelayStart).toHaveBeenCalledWith('https://cloud.example', 'token-123');
  });

  it('never sweeps fsevents instances (update path can be followed by a watcher restore)', async () => {
    // Stage 2 scoping (Arbitrator F1): force-stopping a pool-refcounted
    // instance before the failed-update restore would dead-watcher the
    // resumed watcher. The sweep lives ONLY in the final-exit primitive.
    const shutdown = await import('../gracefulShutdown');

    await shutdown.closeNativeWatchersForUpdate();

    expect(immediateExitWithFseventsSweep).not.toHaveBeenCalled();
  });
});

describe('point-of-no-return exit wiring (260611 fsevents quit-SIGABRT fix, Stage 2)', () => {
  beforeEach(() => {
    // Fresh module state per test: earlier describes leave isQuitting=true
    // (removeBeforeQuitHandlerForUpdate), which would short-circuit the
    // before-quit handler under test.
    vi.resetModules();
    vi.clearAllMocks();
    cleanExitStoreGet.mockImplementation((_key: string, defaultValue?: unknown) => defaultValue);
    workspaceWatcherStop.mockResolvedValue(undefined);
    cloudTokenRelayStop.mockResolvedValue(undefined);
    workspaceWatcherGetCurrentDirectory.mockReturnValue('/workspace');
    cloudTokenRelayGetConnection.mockReturnValue({
      cloudUrl: 'https://cloud.example',
      cloudToken: 'token-123',
    });
    electronModuleMock = {
      app: {
        on: vi.fn(),
        exit: vi.fn(),
        isPackaged: true,
        removeListener: vi.fn(),
        releaseSingleInstanceLock: vi.fn(),
      },
    };
  });

  afterEach(() => {
    electronModuleMock = null;
    vi.resetModules();
  });

  function capturedBeforeQuitHandler(): (event: { preventDefault: () => void }) => void {
    const call = electronModuleMock!.app.on.mock.calls.find(([eventName]) => eventName === 'before-quit');
    expect(call).toBeDefined();
    return call![1] as (event: { preventDefault: () => void }) => void;
  }

  it('writes the clean-exit flag BEFORE exiting through the final-exit primitive (never a bare app.exit)', async () => {
    const shutdown = await import('../gracefulShutdown');
    shutdown.setAppBridgeManagerForShutdown(null);
    shutdown.initGracefulShutdown();

    const event = { preventDefault: vi.fn() };
    capturedBeforeQuitHandler()(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();

    await vi.waitFor(() => {
      expect(immediateExitWithFseventsSweep).toHaveBeenCalledExactlyOnceWith('graceful-shutdown-complete', 0);
    });

    // Ordering: cleanExit=true persisted before the sweep+exit primitive runs.
    const cleanExitTrueCall = cleanExitStoreSet.mock.calls.findIndex(
      ([key, value]) => key === 'cleanExit' && value === true,
    );
    expect(cleanExitTrueCall).toBeGreaterThanOrEqual(0);
    expect(cleanExitStoreSet.mock.invocationCallOrder[cleanExitTrueCall]).toBeLessThan(
      immediateExitWithFseventsSweep.mock.invocationCallOrder[0],
    );

    // The exit itself belongs to the primitive — gracefulShutdown must not
    // call app.exit directly anymore (that path bypassed the sweep).
    expect(electronModuleMock!.app.exit).not.toHaveBeenCalled();

    // The full quit path still stopped the watchers via their normal awaited
    // closes (the sweep is a leak backstop, not a replacement).
    expect(workspaceWatcherStop).toHaveBeenCalledOnce();
    expect(cloudTokenRelayStop).toHaveBeenCalledOnce();
  });

  it('gracefulShutdownServicesOnly (restartable path) never touches the final-exit primitive', async () => {
    // Stage 2 scoping (Arbitrator F1): services-only shutdown precedes
    // watcher RESTARTS (workspace rename) — sweeping here would silently
    // dead-watcher the resumed watcher.
    const shutdown = await import('../gracefulShutdown');
    shutdown.setAppBridgeManagerForShutdown(null);

    await shutdown.gracefulShutdownServicesOnly();

    expect(immediateExitWithFseventsSweep).not.toHaveBeenCalled();
    expect(workspaceWatcherStop).toHaveBeenCalledOnce();
  });

  it('gracefulShutdownForUpdate (pre-ShipIt cleanup) never touches the final-exit primitive', async () => {
    const shutdown = await import('../gracefulShutdown');
    shutdown.setAppBridgeManagerForShutdown(null);

    await shutdown.gracefulShutdownForUpdate();

    expect(immediateExitWithFseventsSweep).not.toHaveBeenCalled();
  });
});
