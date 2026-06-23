import { beforeEach, describe, expect, it, vi } from 'vitest';

function installBootstrapMocks(): void {
  vi.doMock('@sentry/node', () => ({
    init: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
    withScope: vi.fn(),
  }));
  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      debug: vi.fn(),
    }),
  }));
  vi.doMock('@core/errorReporter', () => ({
    setErrorReporter: vi.fn(),
    getErrorReporter: vi.fn(() => ({
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
    })),
  }));
  vi.doMock('@core/utils/gracefulFsObservability', () => ({
    installGracefulFsObservability: vi.fn(() => vi.fn()),
  }));
  vi.doMock('@core/storeFactory', () => ({ setStoreFactory: vi.fn() }));
  vi.doMock('@core/tracking', () => ({ setTracker: vi.fn() }));
  vi.doMock('@core/broadcastService', () => ({ setBroadcastService: vi.fn() }));
  vi.doMock('@core/codexAuth', () => ({ setCodexAuthProvider: vi.fn() }));
  vi.doMock('@core/services/defaultCodexAuthProvider', () => ({ DEFAULT_CODEX_AUTH_PROVIDER: {} }));
  vi.doMock('@core/services/diagnosticEventsLedger', () => ({
    setDiagnosticEventsLedgerReader: vi.fn(),
    setDiagnosticEventsLedgerWriter: vi.fn(),
    setDiagnosticEventsSurface: vi.fn(),
  }));
  vi.doMock('@core/handlerRegistry', () => ({
    setHandlerRegistry: vi.fn(),
    getHandlerRegistry: vi.fn(() => ({ register: vi.fn() })),
  }));
  vi.doMock('@core/safetyEvaluationService', () => ({ setSafetyEvaluationService: vi.fn() }));
  vi.doMock('@core/featureGating', () => ({ setLicenseTier: vi.fn() }));
  vi.doMock('@rebel/cloud-client', () => ({ setLogErrorReporter: vi.fn() }));
  vi.doMock('../mapHandlerRegistry', () => ({ MapHandlerRegistry: class MapHandlerRegistry {} }));
  vi.doMock('../cloudEventBroadcaster', () => ({
    cloudEventBroadcaster: { broadcast: vi.fn(), virtualWindow: {} },
  }));
  vi.doMock('../services/cloudDiagnosticEventsLedger', () => ({
    cloudDiagnosticEventsLedgerReader: {},
    cloudDiagnosticEventsLedgerWriter: {},
  }));
  vi.doMock('@core/services/settingsStore/index', () => ({
    ensureNormalizedSettings: vi.fn(),
    getSettings: vi.fn(() => ({})),
    settingsStore: {},
    updateSettings: vi.fn(),
  }));
  vi.doMock('@core/services/settingsStore', () => ({ setSettingsStoreAdapter: vi.fn() }));
  vi.doMock('@core/services/safety/btsSafetyEvalService', () => ({ createBtsSafetyEvalService: vi.fn(() => ({})) }));
  vi.doMock('@core/services/incrementalSessionStore', () => ({ getIncrementalSessionStore: vi.fn() }));
  vi.doMock('@core/services/agentTurnService', () => ({ startAgentTurn: vi.fn() }));
  vi.doMock('@core/services/agentTurnRegistry', () => ({ agentTurnRegistry: {} }));
  vi.doMock('@core/services/turnPipeline/agentTurnExecute', () => ({ executeAgentTurn: vi.fn() }));
  vi.doMock('@core/services/agentEventDispatcher', () => ({ dispatchAgentEvent: vi.fn() }));
  vi.doMock('@core/services/recovery/recoveryPipeline', () => ({ runRecoveryPipeline: vi.fn() }));
  vi.doMock('../services/cloudRecoveryAdapter', () => ({ createCloudRecoveryAdapter: vi.fn() }));
  vi.doMock('@core/services/superMcpHttpManager', () => ({ superMcpHttpManager: {}, findAvailablePort: vi.fn() }));
  vi.doMock('@main/services/coreStartup', () => ({ initCoreServices: vi.fn() }));
  vi.doMock('@main/services/safety', () => ({ createMemoryWriteHook: vi.fn() }));
  vi.doMock('@core/services/safety/mcpDenyHook', () => ({ createMcpDenyHook: vi.fn() }));
  vi.doMock('@shared/utils/btsModelResolver', () => ({ resolveBtsModel: vi.fn(() => 'test-model') }));
  vi.doMock('@shared/utils/modelNormalization', () => ({ DEFAULT_AUXILIARY_MODEL: 'test-model', MODEL_OPTIONS: [] }));
  vi.doMock('@core/services/continuity/serverClock', () => ({
    clearServerClockSession: vi.fn(),
    seedServerClock: vi.fn(),
    stampCloudUpdatedAt: vi.fn(),
  }));
  vi.doMock('@core/services/continuity/sessionSeqIndex', () => ({
    getMaxSeqFromSession: vi.fn(),
    getSessionSeqIndex: vi.fn(),
  }));
  vi.doMock('@core/services/continuity/outboxStallMonitor', () => ({
    getOutboxStallMonitor: vi.fn(),
  }));
  vi.doMock('@core/services/continuity/sessionTombstoneStore', () => ({
    getSessionTombstoneStore: vi.fn(),
  }));
  vi.doMock('../services/cleanupLeakedSessionsBridge', () => ({
    createCleanupLeakedSessionDeletedCallback: vi.fn(),
  }));
  vi.doMock('../services/externalConversationServiceFactory', () => ({
    initExternalConversationService: vi.fn(),
  }));
}

describe('Fly single-machine self-check', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete process.env.FLY_MACHINE_ID;
    delete process.env.FLY_API_TOKEN;
    delete process.env.FLY_APP_NAME;
    process.env.REBEL_USER_DATA = '/tmp/mindstone-rebel-tests';
    installBootstrapMocks();
  });

  it('passes when exactly one machine is started and it is ours', async () => {
    process.env.FLY_MACHINE_ID = 'machine-a';
    process.env.FLY_API_TOKEN = 'token';
    process.env.FLY_APP_NAME = 'rebel-cloud';
    const { assertSingleFlyMachineRunning } = await import('../bootstrap');
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ id: 'machine-a', state: 'started' }, { id: 'machine-b', state: 'stopped' }],
    })) as unknown as typeof fetch;

    await expect(assertSingleFlyMachineRunning(fetchImpl)).resolves.toBeUndefined();
  });

  it('passes during rolling deploy when N>=1 started includes our machine', async () => {
    // Fly rolling/in-place deploys transiently run old + new in `started`
    // state. The check must tolerate this; the single-writer guarantee is
    // enforced per-volume by Fly (volumes are single-attach).
    process.env.FLY_MACHINE_ID = 'machine-a';
    process.env.FLY_API_TOKEN = 'token';
    process.env.FLY_APP_NAME = 'rebel-cloud';
    const { assertSingleFlyMachineRunning } = await import('../bootstrap');
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ id: 'machine-a', state: 'started' }, { id: 'machine-b', state: 'started' }],
    })) as unknown as typeof fetch;

    await expect(assertSingleFlyMachineRunning(fetchImpl)).resolves.toBeUndefined();
  });

  it('soft-warns when our machine is not in the started list (boot race)', async () => {
    // Boot race: at the time this self-check runs, our own machine may still
    // be in `starting` state. The volume single-attach invariant holds, so we
    // soft-warn rather than crash-loop the new machine before it can listen.
    process.env.FLY_MACHINE_ID = 'machine-a';
    process.env.FLY_API_TOKEN = 'token';
    process.env.FLY_APP_NAME = 'rebel-cloud';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { assertSingleFlyMachineRunning } = await import('../bootstrap');
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ id: 'machine-b', state: 'started' }, { id: 'machine-c', state: 'started' }],
    })) as unknown as typeof fetch;

    await expect(assertSingleFlyMachineRunning(fetchImpl)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"reason":"own-machine-not-yet-started"'));
  });

  it('soft-warns when no machines are started yet (boot race)', async () => {
    process.env.FLY_MACHINE_ID = 'machine-a';
    process.env.FLY_API_TOKEN = 'token';
    process.env.FLY_APP_NAME = 'rebel-cloud';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { assertSingleFlyMachineRunning } = await import('../bootstrap');
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ id: 'machine-a', state: 'stopped' }],
    })) as unknown as typeof fetch;

    await expect(assertSingleFlyMachineRunning(fetchImpl)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"reason":"no-started-machines-yet"'));
  });

  it('soft-warns when fetch throws (network/DNS error)', async () => {
    process.env.FLY_MACHINE_ID = 'machine-a';
    process.env.FLY_API_TOKEN = 'token';
    process.env.FLY_APP_NAME = 'rebel-cloud';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { assertSingleFlyMachineRunning } = await import('../bootstrap');
    const fetchImpl = vi.fn(async () => { throw new Error('ENOTFOUND _api.internal'); }) as unknown as typeof fetch;

    await expect(assertSingleFlyMachineRunning(fetchImpl)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"reason":"api-error"'));
  });

  it('soft-warns when API returns non-2xx', async () => {
    process.env.FLY_MACHINE_ID = 'machine-a';
    process.env.FLY_API_TOKEN = 'token';
    process.env.FLY_APP_NAME = 'rebel-cloud';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { assertSingleFlyMachineRunning } = await import('../bootstrap');
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    await expect(assertSingleFlyMachineRunning(fetchImpl)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"reason":"api-non-2xx"'));
  });

  it('warns and skips when the Fly token is unavailable', async () => {
    process.env.FLY_MACHINE_ID = 'machine-a';
    process.env.FLY_APP_NAME = 'rebel-cloud';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { assertSingleFlyMachineRunning } = await import('../bootstrap');
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(assertSingleFlyMachineRunning(fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"fly-self-check-skipped"'));
  });
});
