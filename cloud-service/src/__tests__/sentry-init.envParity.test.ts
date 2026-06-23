import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const sentryInitMock = vi.hoisted(() => vi.fn());
const setErrorReporterMock = vi.hoisted(() => vi.fn());
const getErrorReporterMock = vi.hoisted(() => vi.fn(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
})));

vi.mock('@sentry/node', () => ({
  init: sentryInitMock,
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
  flush: vi.fn(),
  // Stage 6b bootstrap sets global scope tags/context at module-eval time.
  setTag: vi.fn(),
  setContext: vi.fn(),
  setUser: vi.fn(),
}));

vi.mock('@core/errorReporter', () => ({
  setErrorReporter: setErrorReporterMock,
  getErrorReporter: getErrorReporterMock,
}));

vi.mock('@core/utils/gracefulFsObservability', () => ({
  installGracefulFsObservability: vi.fn(() => vi.fn()),
}));
vi.mock('@core/storeFactory', () => ({ setStoreFactory: vi.fn() }));
vi.mock('@core/tracking', () => ({ setTracker: vi.fn() }));
vi.mock('@core/broadcastService', () => ({ setBroadcastService: vi.fn() }));
vi.mock('@core/codexAuth', () => ({ setCodexAuthProvider: vi.fn() }));
vi.mock('@core/services/defaultCodexAuthProvider', () => ({ DEFAULT_CODEX_AUTH_PROVIDER: {} }));
vi.mock('@core/handlerRegistry', () => ({
  setHandlerRegistry: vi.fn(),
  getHandlerRegistry: vi.fn(() => ({ register: vi.fn() })),
}));
vi.mock('@core/safetyEvaluationService', () => ({ setSafetyEvaluationService: vi.fn() }));
vi.mock('@core/featureGating', () => ({ setLicenseTier: vi.fn() }));
vi.mock('@rebel/cloud-client', () => ({ setLogErrorReporter: vi.fn() }));
vi.mock('../mapHandlerRegistry', () => ({ MapHandlerRegistry: class MapHandlerRegistry {} }));
vi.mock('../electronStoreShim', () => ({ default: class CloudStore {} }));
vi.mock('../cloudEventBroadcaster', () => ({
  cloudEventBroadcaster: { broadcast: vi.fn(), virtualWindow: {} },
}));
vi.mock('@core/services/settingsStore/index', () => ({
  ensureNormalizedSettings: vi.fn(),
  getSettings: vi.fn(() => ({})),
  settingsStore: {},
  updateSettings: vi.fn(),
}));
vi.mock('@core/services/settingsStore', () => ({ setSettingsStoreAdapter: vi.fn() }));
vi.mock('@core/services/safety/btsSafetyEvalService', () => ({
  createBtsSafetyEvalService: vi.fn(() => ({})),
}));
vi.mock('@core/services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(),
}));
vi.mock('@core/services/agentTurnService', () => ({
  startAgentTurn: vi.fn(),
}));
vi.mock('@core/services/agentTurnRegistry', () => ({ agentTurnRegistry: {} }));
vi.mock('@core/services/turnPipeline/agentTurnExecute', () => ({ executeAgentTurn: vi.fn() }));
vi.mock('@core/services/agentEventDispatcher', () => ({ dispatchAgentEvent: vi.fn() }));
vi.mock('@core/services/superMcpHttpManager', () => ({
  superMcpHttpManager: {},
  findAvailablePort: vi.fn(),
}));
vi.mock('@main/services/coreStartup', () => ({ initCoreServices: vi.fn() }));
vi.mock('@main/services/safety', () => ({ createMemoryWriteHook: vi.fn() }));
vi.mock('@core/services/safety/mcpDenyHook', () => ({ createMcpDenyHook: vi.fn() }));
vi.mock('@core/services/transcriptService', () => ({ cleanupOldTranscripts: vi.fn() }));
vi.mock('@shared/utils/btsModelResolver', () => ({ resolveBtsModel: vi.fn() }));
vi.mock('@shared/utils/modelNormalization', () => ({ DEFAULT_AUXILIARY_MODEL: 'test-model', MODEL_OPTIONS: [] }));
vi.mock('@core/services/continuity/serverClock', () => ({
  clearServerClockSession: vi.fn(),
  seedServerClock: vi.fn(),
  stampCloudUpdatedAt: vi.fn(),
}));
vi.mock('@core/services/continuity/sessionSeqIndex', () => ({
  getMaxSeqFromSession: vi.fn(),
  getSessionSeqIndex: vi.fn(),
}));
vi.mock('@core/services/continuity/outboxStallMonitor', () => ({
  getOutboxStallMonitor: vi.fn(),
}));
vi.mock('@core/services/continuity/sessionTombstoneStore', () => ({
  getSessionTombstoneStore: vi.fn(),
}));
vi.mock('../services/cleanupLeakedSessionsBridge', () => ({
  createCleanupLeakedSessionDeletedCallback: vi.fn(),
}));

describe('cloud Sentry env parity', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    process.env.REBEL_USER_DATA = '/tmp/mindstone-rebel-tests';
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('does not call Sentry.init when SENTRY_DSN is unset', async () => {
    vi.stubEnv('SENTRY_DSN', '');

    const { isCloudSentryEnabled } = await import('../bootstrap');

    expect(sentryInitMock).not.toHaveBeenCalled();
    expect(isCloudSentryEnabled()).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith(JSON.stringify({
      level: 'info',
      surface: 'cloud',
      event: 'sentry-disabled',
      reason: 'SENTRY_DSN env var not set',
    }));
  });

  it('calls Sentry.init with the env DSN when SENTRY_DSN is set', async () => {
    const testDsn = 'https://public@example.invalid/1';
    vi.stubEnv('SENTRY_DSN', testDsn);

    const { isCloudSentryEnabled } = await import('../bootstrap');

    expect(sentryInitMock).toHaveBeenCalledTimes(1);
    expect(sentryInitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: testDsn,
        enabled: true,
        environment: 'cloud',
      }),
    );
    expect(isCloudSentryEnabled()).toBe(true);
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(testDsn);
  });
});
