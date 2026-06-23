import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setTokenSyncCoordinatorMock = vi.hoisted(() => vi.fn());
const setCrossProcessLeaseMock = vi.hoisted(() => vi.fn());
const setOAuthToolResolverMock = vi.hoisted(() => vi.fn());

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('@core/errorReporter', () => ({
  setErrorReporter: vi.fn(),
  getErrorReporter: vi.fn(() => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  })),
}));
vi.mock('@core/feedbackReporter', () => ({ setFeedbackReporter: vi.fn() }));
vi.mock('@core/utils/gracefulFsObservability', () => ({
  installGracefulFsObservability: vi.fn(() => vi.fn()),
}));
vi.mock('@core/storeFactory', () => ({ setStoreFactory: vi.fn() }));
vi.mock('@core/tracking', () => ({ setTracker: vi.fn() }));
vi.mock('@core/broadcastService', () => ({ setBroadcastService: vi.fn() }));
vi.mock('@core/codexAuth', () => ({ setCodexAuthProvider: vi.fn() }));
vi.mock('@core/setTokenSyncCoordinator', () => ({
  setTokenSyncCoordinator: setTokenSyncCoordinatorMock,
}));
vi.mock('@core/setTokenSyncTransport', () => ({
  NULL_TOKEN_SYNC_TRANSPORT: { mode: 'null-sync' },
  setTokenSyncTransport: vi.fn(),
}));
vi.mock('@core/setCrossProcessLease', async (importOriginal) => ({
  // Keep the real ownership-identity helpers (mint/parse/equals/describe) so
  // CloudFileLockLease still works; only swap the registration sink.
  ...(await importOriginal<typeof import('@core/setCrossProcessLease')>()),
  setCrossProcessLease: setCrossProcessLeaseMock,
}));
vi.mock('@core/setOAuthToolResolver', () => ({
  setOAuthToolResolver: setOAuthToolResolverMock,
}));
vi.mock('@core/services/defaultCodexAuthProvider', () => ({ DEFAULT_CODEX_AUTH_PROVIDER: {} }));
vi.mock('@core/services/diagnosticEventsLedger', () => ({
  setDiagnosticEventsLedgerReader: vi.fn(),
  setDiagnosticEventsLedgerWriter: vi.fn(),
  setDiagnosticEventsSurface: vi.fn(),
}));
vi.mock('@core/handlerRegistry', () => ({
  setHandlerRegistry: vi.fn(),
  getHandlerRegistry: vi.fn(() => ({ register: vi.fn() })),
}));
vi.mock('@core/safetyEvaluationService', () => ({ setSafetyEvaluationService: vi.fn() }));
vi.mock('@core/featureGating', () => ({ setLicenseTier: vi.fn() }));
vi.mock('@rebel/cloud-client', () => ({ setLogErrorReporter: vi.fn() }));
vi.mock('../mapHandlerRegistry', () => ({ MapHandlerRegistry: class MapHandlerRegistry {} }));
vi.mock('../sentryFeedbackReporter', () => ({ createCloudFeedbackReporter: vi.fn(() => ({})) }));
vi.mock('../services/sentryRedaction', () => ({
  redactObjectDeep: vi.fn((value: unknown) => value),
  redactSensitiveString: vi.fn((value: string) => value),
  redactSentryEvent: vi.fn((value: unknown) => value),
}));
vi.mock('../electronStoreShim', () => ({ default: class CloudStore {} }));
vi.mock('../cloudEventBroadcaster', () => ({
  cloudEventBroadcaster: { broadcast: vi.fn(), virtualWindow: {} },
}));
vi.mock('../services/cloudDiagnosticEventsLedger', () => ({
  cloudDiagnosticEventsLedgerReader: {},
  cloudDiagnosticEventsLedgerWriter: {},
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
vi.mock('@core/services/agentTurnService', () => ({ startAgentTurn: vi.fn() }));
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

describe('cloud bootstrap token coordinator wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.REBEL_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-token-coordinator-bootstrap-'));
  });

  it('registers cloud coordinator, lease, and resolver boundaries', async () => {
    await import('../bootstrap');

    expect(setTokenSyncCoordinatorMock).toHaveBeenCalledTimes(1);
    expect(setCrossProcessLeaseMock).toHaveBeenCalledTimes(1);
    expect(setOAuthToolResolverMock).toHaveBeenCalledTimes(1);

    const coordinator = setTokenSyncCoordinatorMock.mock.calls[0]?.[0] as {
      getStatus: () => Promise<Record<string, unknown>>;
    };
    const coordinatorStatus = await coordinator.getStatus();
    expect(coordinatorStatus).toMatchObject({
      surface: 'cloud',
      pendingPullCount: 0,
      transportWired: true,
    });

    const lease = setCrossProcessLeaseMock.mock.calls[0]?.[0] as {
      acquire: (scope: string, ttlMs: number) => Promise<{
        scope: string;
      } | null>;
      release: (handle: { scope: string }) => Promise<void>;
    };
    const leaseScope = 'sync:google:user@example.com';
    const firstLease = await lease.acquire(leaseScope, 1_000);
    expect(firstLease).not.toBeNull();
    const secondLease = await lease.acquire(leaseScope, 1_000);
    expect(secondLease).toBeNull();
    await lease.release(firstLease as { scope: string });
    const thirdLease = await lease.acquire(leaseScope, 1_000);
    expect(thirdLease).not.toBeNull();

    const resolver = setOAuthToolResolverMock.mock.calls[0]?.[0] as {
      resolve: (toolName: string) => { provider: string; accountKey: string } | null;
    };
    expect(
      resolver.resolve('GoogleWorkspace-user-example-com/list_workspace_calendar_events'),
    ).toEqual({
      provider: 'google',
      accountKey: 'GoogleWorkspace-user-example-com',
    });
  });
});
