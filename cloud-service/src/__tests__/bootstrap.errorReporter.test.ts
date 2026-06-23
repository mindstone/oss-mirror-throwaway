import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentryCaptureExceptionMock = vi.hoisted(() => vi.fn());
const sentryCaptureMessageMock = vi.hoisted(() => vi.fn());
const setErrorReporterMock = vi.hoisted(() => vi.fn());
const getErrorReporterMock = vi.hoisted(() => vi.fn(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
})));

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: sentryCaptureExceptionMock,
  captureMessage: sentryCaptureMessageMock,
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
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

describe('cloud bootstrap error reporter adapter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Sentry is opt-in via SENTRY_DSN (bootstrap computes `cloudSentryEnabled`
    // at module load). The captureException/captureMessage forwarding these
    // tests assert on only fires when Sentry is enabled, so stub a DSN before
    // the dynamic bootstrap import so the module-load-time const reads it.
    // Mirrors the fix in searchToolsBootstrap.test.ts (1d02dea8d).
    vi.stubEnv('SENTRY_DSN', 'https://[external-email]/0');
    process.env.REBEL_USER_DATA = '/tmp/mindstone-rebel-tests';
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes captureException context through to Sentry', async () => {
    await import('../bootstrap');

    const registered = setErrorReporterMock.mock.calls.at(-1)?.[0] as {
      captureException: (error: unknown, context?: Record<string, unknown>) => void;
    };

    const error = new Error('boom');
    const context = { fingerprint: ['x'], level: 'warning', tags: { foo: 'bar' }, extra: { z: 1 } };
    registered.captureException(error, context);

    expect(sentryCaptureExceptionMock).toHaveBeenCalledWith(error, context);
  });

  it('passes captureMessage context through to Sentry', async () => {
    await import('../bootstrap');

    const registered = setErrorReporterMock.mock.calls.at(-1)?.[0] as {
      captureMessage: (message: string, context?: Record<string, unknown>) => void;
    };

    const context = { fingerprint: ['x'], level: 'warning', tags: { foo: 'bar' }, extra: { z: 1 } };
    registered.captureMessage('hello', context);

    expect(sentryCaptureMessageMock).toHaveBeenCalledWith('hello', context);
  });
});
