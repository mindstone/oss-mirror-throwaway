/**
 * Cross-surface parity test for the BTS pre-OAuth call hook (Stage 9).
 *
 * The `preOAuthCallHook` refreshes the Codex/ChatGPT access token before any
 * behind-the-scenes OAuth-token Anthropic call (see
 * src/core/services/bts/transports/anthropic.ts — `getPreOAuthCallHook()` is
 * invoked on the `oauth-token` auth path). Desktop wires it at
 * src/main/index.ts (`preOAuthCallHook: async () => { await
 * DEFAULT_CODEX_AUTH_PROVIDER.getAccessToken(); }`). Cloud MUST wire the
 * identical hook at cloud-service/src/bootstrap.ts so headless/background BTS
 * turns on cloud (and mobile, which inherits cloud's executeAgentTurn) get the
 * same token refresh and don't silently 401 when the Codex token has expired.
 *
 * This test PINS the existing cloud registration so it can't silently regress.
 *
 * IMPORTANT — the assertion seam. Unlike the sibling proxy-provider parity test
 * (bootstrap.proxyProviders.test.ts), the hook is NOT registered via a direct
 * `registerPreOAuthCallHook(...)` call in bootstrap. It flows as the *required*
 * `preOAuthCallHook` field of the config object passed to
 * `createHeadlessRuntime` (which is the sole caller of
 * `registerPreOAuthCallHook`, at src/core/services/headlessRuntime.ts:363). So
 * this test mocks `@core/services/headlessRuntime` to capture that config arg
 * and asserts (a) `preOAuthCallHook` is a function, and (b) invoking it calls
 * `DEFAULT_CODEX_AUTH_PROVIDER.getAccessToken()`. Deleting/nulling the cloud
 * wiring makes both assertions fail (verified by the implementer via a
 * fail-then-revert demonstration).
 *
 * Drift contract: docs/project/boundary-registry.yaml#bts-preoauth-hook-registration-sites.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import type { HeadlessRuntimeConfig } from '@core/services/headlessRuntime';

const { createHeadlessRuntimeMock, getAccessTokenMock } = vi.hoisted(() => ({
  createHeadlessRuntimeMock: vi.fn(),
  getAccessTokenMock: vi.fn(async () => 'codex-access-token'),
}));

// Capture the config passed into createHeadlessRuntime — this is the actual
// wiring seam for preOAuthCallHook on every surface.
vi.mock('@core/services/headlessRuntime', () => ({
  createHeadlessRuntime: (config: HeadlessRuntimeConfig) => createHeadlessRuntimeMock(config),
}));

// Real spy for the Codex auth provider so invoking the captured hook is
// observable. (The proxy-provider test mocks this to `{}` because it never
// exercises the hook; we need getAccessToken to be a callable spy.)
vi.mock('@core/services/defaultCodexAuthProvider', () => ({
  DEFAULT_CODEX_AUTH_PROVIDER: { getAccessToken: getAccessTokenMock },
}));

// Mock the rest of the bootstrap dependency graph so bootstrap() can run far
// enough to reach the createHeadlessRuntime call. Mirrors
// bootstrap.proxyProviders.test.ts.
vi.mock('@main/services/localModelProxyServer', () => ({
  proxyManager: {
    isRunning: () => false,
    ensureRunningForBts: vi.fn(),
    getUrl: () => null,
    getAuthToken: () => null,
  },
}));
vi.mock('@core/services/behindTheScenesClient', () => ({
  registerManagedKeyAvailability: vi.fn(),
  registerBtsProxyProviders: vi.fn(),
}));
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
  getIncrementalSessionStore: vi.fn(() => ({ loadSync: vi.fn(() => []) })),
}));
vi.mock('@core/services/agentTurnService', () => ({
  startAgentTurn: vi.fn(),
}));
vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: { setEventListener: vi.fn(), deleteEventListener: vi.fn() },
}));
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

describe('cloud bootstrap — BTS preOAuthCallHook parity', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getAccessTokenMock.mockResolvedValue('codex-access-token');
    // createHeadlessRuntime returns a runtime object with no superMcpUrl so the
    // post-init warmup branch is skipped.
    createHeadlessRuntimeMock.mockResolvedValue({ superMcpUrl: undefined });
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-preoauth-test-'));
    process.env.REBEL_USER_DATA = tmpRoot;
  });

  it('supplies a preOAuthCallHook function to createHeadlessRuntime', async () => {
    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    expect(createHeadlessRuntimeMock).toHaveBeenCalledTimes(1);
    const config = createHeadlessRuntimeMock.mock.calls[0][0] as HeadlessRuntimeConfig;
    expect(typeof config.preOAuthCallHook).toBe('function');
  });

  it('the registered preOAuthCallHook refreshes the Codex token (parity with desktop)', async () => {
    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    const config = createHeadlessRuntimeMock.mock.calls[0][0] as HeadlessRuntimeConfig;
    expect(getAccessTokenMock).not.toHaveBeenCalled();

    // Invoking the hook MUST drive the Codex auth provider refresh — this is the
    // behaviour desktop wires identically at src/main/index.ts.
    await config.preOAuthCallHook();

    expect(getAccessTokenMock).toHaveBeenCalledTimes(1);
  });
});
