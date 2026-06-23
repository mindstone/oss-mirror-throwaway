/**
 * Regression test for cloud BTS Codex proxy wiring.
 *
 * Cloud bootstrap MUST register the BTS proxy URL/auth providers so that
 * Codex-routed BTS calls (auto-title, safety eval, compaction, memory update)
 * can reach the local Codex proxy. Without this, BTS calls throw
 * "Codex proxy not available for background task. proxyUrl=missing, proxyAuth=missing".
 *
 * See docs-private/investigations/260514_cloud_bts_codex_proxy_unwired_auto_title.md.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const {
  ensureRunningForBtsMock,
  isRunningMock,
  getUrlMock,
  getAuthTokenMock,
  registerManagedKeyAvailabilityMock,
  registerBtsProxyProvidersMock,
} = vi.hoisted(() => ({
  ensureRunningForBtsMock: vi.fn(),
  isRunningMock: vi.fn(),
  getUrlMock: vi.fn(),
  getAuthTokenMock: vi.fn(),
  registerManagedKeyAvailabilityMock: vi.fn(),
  registerBtsProxyProvidersMock: vi.fn(),
}));

type ProxyValueProvider = () => string | null | Promise<string | null>;
function registeredProxyProviders(): { url: ProxyValueProvider; auth: ProxyValueProvider } {
  return registerBtsProxyProvidersMock.mock.calls[0][0] as { url: ProxyValueProvider; auth: ProxyValueProvider };
}

vi.mock('@main/services/localModelProxyServer', () => ({
  proxyManager: {
    isRunning: () => isRunningMock(),
    ensureRunningForBts: () => ensureRunningForBtsMock(),
    getUrl: () => getUrlMock(),
    getAuthToken: () => getAuthTokenMock(),
  },
}));

vi.mock('@core/services/behindTheScenesClient', () => ({
  registerBtsProxyProviders: (...args: unknown[]) => registerBtsProxyProvidersMock(...args),
}));

// The managed-key seam is now wired directly from the leaf module BEFORE the
// startup codex provider heal reads it (FOX-3494 F1 refinement), not via the
// behindTheScenesClient re-export inside the BTS block.
vi.mock('@core/rebelCore/managedKeyAvailability', () => ({
  registerManagedKeyAvailability: (...args: unknown[]) => registerManagedKeyAvailabilityMock(...args),
  getManagedKeyAvailability: () => false,
}));

// Mock the rest of the bootstrap dependency graph so bootstrap() can complete.
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
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

describe('cloud bootstrap — BTS Codex proxy provider wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // bootstrap() creates /data/* dirs eagerly; point at a real tmp dir so
    // mkdirSync succeeds in CI/dev sandboxes that don't have /data writable.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-bootstrap-test-'));
    process.env.REBEL_USER_DATA = tmpRoot;
  });

  it('registers the BTS proxy providers atomically (url+auth) when bootstrap runs', async () => {
    const { bootstrap } = await import('../bootstrap');
    // Bootstrap will throw after our registration blocks when later deps
    // (e.g. coreResult.errors) hit the mock surface. We only care that
    // the registrations ran first.
    await bootstrap().catch(() => undefined);

    // The managed-key seam is registered up front (before the startup codex
    // provider heal reads it), not in the BTS block — FOX-3494 F1 refinement.
    expect(registerManagedKeyAvailabilityMock).toHaveBeenCalledTimes(1);
    // Single atomic registration — url+auth can no longer be wired separately.
    expect(registerBtsProxyProvidersMock).toHaveBeenCalledTimes(1);
    expect(typeof registerManagedKeyAvailabilityMock.mock.calls[0][0]).toBe('function');
    const providers = registeredProxyProviders();
    expect(typeof providers.url).toBe('function');
    expect(typeof providers.auth).toBe('function');
  });

  it('registered URL provider returns proxyManager URL without restart when already running', async () => {
    isRunningMock.mockReturnValue(true);
    getUrlMock.mockReturnValue('http://127.0.0.1:18765');

    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    const url = await registeredProxyProviders().url();

    expect(url).toBe('http://127.0.0.1:18765');
    expect(isRunningMock).toHaveBeenCalled();
    expect(ensureRunningForBtsMock).not.toHaveBeenCalled();
  });

  it('registered URL provider lazily starts the proxy via ensureRunningForBts when not running', async () => {
    let running = false;
    isRunningMock.mockImplementation(() => running);
    ensureRunningForBtsMock.mockImplementation(async () => {
      running = true;
    });
    getUrlMock.mockImplementation(() => (running ? 'http://127.0.0.1:18765' : null));

    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    const url = await registeredProxyProviders().url();

    expect(url).toBe('http://127.0.0.1:18765');
    expect(ensureRunningForBtsMock).toHaveBeenCalledTimes(1);
  });

  it('registered auth provider returns proxyManager auth token', async () => {
    getAuthTokenMock.mockReturnValue('test-auth-token');

    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    const auth = await registeredProxyProviders().auth();

    expect(auth).toBe('test-auth-token');
    expect(getAuthTokenMock).toHaveBeenCalled();
  });
});
