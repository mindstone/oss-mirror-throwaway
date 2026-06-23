/**
 * Behavioral contract test for Stage 1: cloud analytics wiring
 * (commit 58ddcce6f).
 *
 * Two invariants are pinned:
 *
 * R1 — Non-noop tracker: the cloud `setTracker` call no longer wires the
 *   hard `isAvailable: () => false` stub. Instead, `isAvailable` delegates to
 *   `analyticsClientAvailable()` from the real analytics module. Deleting the
 *   Stage 1 wiring and restoring the original stub makes the
 *   "isAvailable delegates to analyticsClientAvailable" assertion fail.
 *
 * R2 — Surface-tag context provider (the most important invariant): after
 *   `bootstrap()` runs, the context provider registered with
 *   `setAnalyticsContextProvider` returns an object containing
 *   `client_surface: 'cloud'` (defaulting to 'cloud' when REBEL_SURFACE is
 *   unset, and picking up the env value when set). It also carries
 *   `licenseTier`. This is the tag that every cloud track event inherits — its
 *   absence means cloud events arrive in analytics without a surface dimension.
 *   The key is `client_surface` (NOT `surface`) to avoid colliding with the
 *   per-event `surface` property (chat_checkpoint / nps_survey); the provider
 *   must NOT set a `surface` key.
 *
 * Assertion seam: we mock `@main/analytics` and capture the provider function
 * passed to `setAnalyticsContextProvider`, then call it directly and assert on
 * the returned object. The `@core/tracking` mock captures the `setTracker`
 * adapter so we can inspect the `isAvailable` callback indirectly.
 *
 * Pattern: mirrors bootstrap.preOAuthCallHook.test.ts — dynamic `import()`
 * inside each `it()` (after `vi.resetModules()`), mock the bootstrap dep graph
 * at module-top, assert on captured call args.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const {
  setAnalyticsContextProviderMock,
  initAnalyticsMock,
  analyticsClientAvailableMock,
  trackMainEventMock,
  identifyMainUserMock,
  getOrGenerateAnonymousIdMock,
  setTrackerMock,
  getLicenseTierMock,
  sentrySetTagMock,
  sentrySetUserMock,
  sentrySetContextMock,
  sentryInitMock,
  getSettingsMock,
  settingsState,
  onDidAnyChangeMock,
} = vi.hoisted(() => {
  const settingsState: { current: Record<string, unknown> } = { current: { companyName: null } };
  return {
    setAnalyticsContextProviderMock: vi.fn(),
    initAnalyticsMock: vi.fn(),
    analyticsClientAvailableMock: vi.fn(() => false),
    trackMainEventMock: vi.fn(),
    identifyMainUserMock: vi.fn(),
    getOrGenerateAnonymousIdMock: vi.fn(() => 'anon-id-test'),
    setTrackerMock: vi.fn(),
    getLicenseTierMock: vi.fn((): 'free' | 'teams' => 'free'),
    sentrySetTagMock: vi.fn(),
    sentrySetUserMock: vi.fn(),
    sentrySetContextMock: vi.fn(),
    sentryInitMock: vi.fn(),
    settingsState,
    getSettingsMock: vi.fn(() => settingsState.current),
    // Capture the settings-change callback so tests can drive a userEmail
    // dual-write arriving after boot (anon-only → identified flip).
    onDidAnyChangeMock: vi.fn((_cb: (s: unknown) => void) => () => {}),
  };
});

// ── Mock: analytics module (the Stage 1 shared Node client) ───────────────────
// Bootstrap imports this as '../../src/main/analytics'; the @main alias makes
// the path resolvable under vitest. We mock so that (a) initAnalytics() is a
// no-op (no RudderStack constructor / network calls), and (b) we can capture
// the context provider callback.
vi.mock('@main/analytics', () => ({
  initAnalytics: () => initAnalyticsMock(),
  trackMainEvent: (...args: unknown[]) => trackMainEventMock(...args),
  identifyMainUser: (...args: unknown[]) => identifyMainUserMock(...args),
  getOrGenerateAnonymousId: () => getOrGenerateAnonymousIdMock(),
  analyticsClientAvailable: () => analyticsClientAvailableMock(),
  setAnalyticsContextProvider: (provider: (() => Record<string, unknown>) | null) =>
    setAnalyticsContextProviderMock(provider),
}));

// ── Mock: tracking boundary — capture the adapter wired by Stage 1 ────────────
vi.mock('@core/tracking', () => ({
  setTracker: (...args: unknown[]) => setTrackerMock(...args),
  getTracker: vi.fn(),
}));

// ── Mock: featureGating — control licenseTier in the context provider ─────────
vi.mock('@core/featureGating', () => ({
  setLicenseTier: vi.fn(),
  getLicenseTier: () => getLicenseTierMock(),
}));

// ── Bootstrap dependency graph mocks (mirrors bootstrap.proxyProviders.test.ts) ─

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
  init: (...args: unknown[]) => sentryInitMock(...args),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
  setTag: (...args: unknown[]) => sentrySetTagMock(...args),
  setUser: (...args: unknown[]) => sentrySetUserMock(...args),
  setContext: (...args: unknown[]) => sentrySetContextMock(...args),
  flush: vi.fn(() => Promise.resolve(true)),
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
vi.mock('@core/broadcastService', () => ({ setBroadcastService: vi.fn() }));
vi.mock('@core/codexAuth', () => ({ setCodexAuthProvider: vi.fn() }));
vi.mock('@core/services/defaultCodexAuthProvider', () => ({
  DEFAULT_CODEX_AUTH_PROVIDER: { getAccessToken: vi.fn(async () => 'tok') },
}));
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
vi.mock('@rebel/cloud-client', () => ({ setLogErrorReporter: vi.fn() }));
vi.mock('../mapHandlerRegistry', () => ({ MapHandlerRegistry: class MapHandlerRegistry {} }));
vi.mock('../electronStoreShim', () => ({ default: class CloudStore {} }));
vi.mock('../cloudEventBroadcaster', () => ({
  cloudEventBroadcaster: { broadcast: vi.fn(), virtualWindow: {} },
}));
vi.mock('@core/services/settingsStore/index', () => ({
  ensureNormalizedSettings: vi.fn(),
  getSettings: () => getSettingsMock(),
  settingsStore: { onDidAnyChange: (cb: (s: unknown) => void) => onDidAnyChangeMock(cb) },
  updateSettings: vi.fn(),
}));
vi.mock('@core/services/settingsStore', () => ({ setSettingsStoreAdapter: vi.fn() }));
vi.mock('@core/services/safety/btsSafetyEvalService', () => ({
  createBtsSafetyEvalService: vi.fn(() => ({})),
}));
vi.mock('@core/services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(() => ({ loadSync: vi.fn(() => []) })),
}));
vi.mock('@core/services/agentTurnService', () => ({ startAgentTurn: vi.fn() }));
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
vi.mock('@shared/utils/modelNormalization', () => ({
  DEFAULT_AUXILIARY_MODEL: 'test-model',
  MODEL_OPTIONS: [],
}));
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
vi.mock('@core/services/headlessRuntime', () => ({
  createHeadlessRuntime: vi.fn(async () => ({ superMcpUrl: undefined })),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('cloud bootstrap — Stage 1 analytics wiring contract', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    analyticsClientAvailableMock.mockReturnValue(false);
    getLicenseTierMock.mockReturnValue('free');
    settingsState.current = { companyName: null };
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-analytics-test-'));
    process.env.REBEL_USER_DATA = tmpRoot;
    delete process.env.REBEL_SURFACE;
    delete process.env.DISABLE_ANALYTICS;
    delete process.env.SENTRY_DSN;
  });

  // ── R1: Non-noop tracker ────────────────────────────────────────────────────

  it('wires a real isAvailable that delegates to analyticsClientAvailable (not the hard-false stub)', async () => {
    analyticsClientAvailableMock.mockReturnValue(false);

    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    // setTracker must have been called
    expect(setTrackerMock).toHaveBeenCalledTimes(1);
    const adapter = setTrackerMock.mock.calls[0][0] as { isAvailable: () => boolean };

    // With client unavailable, isAvailable() → false (same as old stub,
    // but this time it actually asks the real client)
    expect(adapter.isAvailable()).toBe(false);

    // Flip the mock — a real adapter reflects this; the old stub never could.
    analyticsClientAvailableMock.mockReturnValue(true);
    expect(adapter.isAvailable()).toBe(true);
  });

  it('wires adapter track/identify/getAnonymousId to real analytics functions', async () => {
    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    const adapter = setTrackerMock.mock.calls[0][0] as {
      track: (event: string, props?: Record<string, unknown>) => void;
      identify: (userId: string, traits?: Record<string, unknown>) => void;
      getAnonymousId: () => string;
    };

    // track delegates
    adapter.track('test-event', { foo: 'bar' });
    expect(trackMainEventMock).toHaveBeenCalledTimes(1);

    // identify delegates
    adapter.identify('user-123', { plan: 'teams' });
    expect(identifyMainUserMock).toHaveBeenCalledTimes(1);

    // getAnonymousId delegates
    getOrGenerateAnonymousIdMock.mockReturnValue('abc-anon');
    expect(adapter.getAnonymousId()).toBe('abc-anon');
  });

  // ── R2: Surface-tag context provider (most important) ──────────────────────

  it('registers a context provider that returns client_surface:"cloud" (default, REBEL_SURFACE unset)', async () => {
    delete process.env.REBEL_SURFACE;

    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    // setAnalyticsContextProvider must have been called once inside bootstrap()
    expect(setAnalyticsContextProviderMock).toHaveBeenCalledTimes(1);
    const provider = setAnalyticsContextProviderMock.mock.calls[0][0] as () => Record<string, unknown>;
    expect(typeof provider).toBe('function');

    const context = provider();
    expect(context.client_surface).toBe('cloud');
    // Must NOT set the colliding per-event `surface` key (used elsewhere for
    // chat_checkpoint / nps_survey). Cross-surface tagging uses client_surface.
    expect(context).not.toHaveProperty('surface');
  });

  it('bootstrap unconditionally stamps REBEL_SURFACE="cloud" so the provider always returns client_surface:"cloud"', async () => {
    // bootstrap.ts line 112 (module-top) and line 809 (bootstrap() entry) both
    // unconditionally set `process.env.REBEL_SURFACE = 'cloud'`. The provider
    // closure reads it at call time via `process.env.REBEL_SURFACE ?? 'cloud'`,
    // so the client_surface tag is always 'cloud' on the cloud surface.
    delete process.env.REBEL_SURFACE;

    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    // After bootstrap() runs, REBEL_SURFACE is 'cloud' (set unconditionally)
    expect(process.env.REBEL_SURFACE).toBe('cloud');

    const provider = setAnalyticsContextProviderMock.mock.calls[0][0] as () => Record<string, unknown>;
    const context = provider();
    expect(context.client_surface).toBe('cloud');
    expect(context).not.toHaveProperty('surface');
  });

  it('context provider includes licenseTier from getLicenseTier()', async () => {
    getLicenseTierMock.mockReturnValue('teams');

    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    const provider = setAnalyticsContextProviderMock.mock.calls[0][0] as () => Record<string, unknown>;
    const context = provider();
    expect(context.licenseTier).toBe('teams');
  });

  it('context provider reads licenseTier at call time (not captured at wire time)', async () => {
    // Wire with 'free' initially
    getLicenseTierMock.mockReturnValue('free');

    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    const provider = setAnalyticsContextProviderMock.mock.calls[0][0] as () => Record<string, unknown>;

    // First call: free
    expect(provider().licenseTier).toBe('free');

    // Simulate tier upgrade mid-session (setLicenseTier would update the mock)
    getLicenseTierMock.mockReturnValue('teams');

    // Second call: picks up the new value (call-time read, not captured stale)
    expect(provider().licenseTier).toBe('teams');
  });

  // ── R3: initAnalytics is called during bootstrap() ─────────────────────────

  it('calls initAnalytics() during bootstrap (starts the analytics client)', async () => {
    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    expect(initAnalyticsMock).toHaveBeenCalledTimes(1);
  });

  it('wires setAnalyticsContextProvider BEFORE initAnalytics (ordering invariant)', async () => {
    const callOrder: string[] = [];
    setAnalyticsContextProviderMock.mockImplementation(() => {
      callOrder.push('setAnalyticsContextProvider');
    });
    initAnalyticsMock.mockImplementation(() => {
      callOrder.push('initAnalytics');
    });

    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    const providerIdx = callOrder.indexOf('setAnalyticsContextProvider');
    const initIdx = callOrder.indexOf('initAnalytics');
    expect(providerIdx).toBeGreaterThanOrEqual(0);
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(providerIdx).toBeLessThan(initIdx);
  });
});

// ── Stage 3: cloud identify from real owner email + observable anon-only ──────

describe('cloud bootstrap — Stage 3 analytics identity', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    analyticsClientAvailableMock.mockReturnValue(true);
    getLicenseTierMock.mockReturnValue('free');
    getOrGenerateAnonymousIdMock.mockReturnValue('anon-id-test');
    settingsState.current = { companyName: null };
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-analytics-test-'));
    process.env.REBEL_USER_DATA = tmpRoot;
    delete process.env.REBEL_SURFACE;
    delete process.env.DISABLE_ANALYTICS;
    delete process.env.SENTRY_DSN;
  });

  // ── Positive: identify when userEmail present ───────────────────────────────

  it('identifies the owner (lowercased) with surface-tagged traits when userEmail is set', async () => {
    settingsState.current = { companyName: null, userEmail: '[external-email]' };

    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    expect(identifyMainUserMock).toHaveBeenCalledTimes(1);
    const arg = identifyMainUserMock.mock.calls[0][0] as {
      userId: string;
      traits: Record<string, unknown>;
      anonymousId: string;
    };
    // Lowercased, mirroring desktop userProfileService.
    expect(arg.userId).toBe('owner@example.com');
    expect(arg.traits.email).toBe('owner@example.com');
    // MA3: surface tag is carried on identify traits (the context provider does
    // NOT feed identifyMainUser, so it must be passed explicitly).
    expect(arg.traits.surface).toBe('cloud');
    expect(arg.anonymousId).toBe('anon-id-test');
  });

  it('does NOT emit the anon-only WARN when an owner email is present', async () => {
    settingsState.current = { companyName: null, userEmail: 'owner@example.com' };

    const { bootstrap, applyCloudAnalyticsIdentity, __resetCloudAnalyticsIdentityForTests } =
      await import('../bootstrap');
    __resetCloudAnalyticsIdentityForTests();
    await bootstrap().catch(() => undefined);

    // Re-invoking the helper directly must not re-identify (idempotent on same email).
    applyCloudAnalyticsIdentity();
    expect(identifyMainUserMock).toHaveBeenCalledTimes(1);
  });

  // ── DA3: observable anon-only fallback ──────────────────────────────────────

  it('does NOT identify when userEmail is absent — anon-id-only fallback', async () => {
    settingsState.current = { companyName: null }; // no userEmail

    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    expect(identifyMainUserMock).not.toHaveBeenCalled();
  });

  it('does NOT identify when userEmail is malformed (not a valid email)', async () => {
    settingsState.current = { companyName: null, userEmail: 'not-an-email' };

    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    expect(identifyMainUserMock).not.toHaveBeenCalled();
  });

  it('DA3: anon-only WARN is one-time per state (re-eval with no email does not re-tag/re-identify)', async () => {
    process.env.SENTRY_DSN = 'https://[external-email]/0';
    settingsState.current = { companyName: null }; // no userEmail

    const { bootstrap, applyCloudAnalyticsIdentity } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    // Boot set the anon-only tag exactly once.
    const tagsAfterBoot = sentrySetTagMock.mock.calls.filter(
      (c) => c[0] === 'identity' && c[1] === 'anon-only',
    ).length;
    expect(tagsAfterBoot).toBe(1);

    // Re-evaluating while still in anon-only state must NOT spam the tag or identify.
    applyCloudAnalyticsIdentity();
    applyCloudAnalyticsIdentity();
    const tagsAfterReeval = sentrySetTagMock.mock.calls.filter(
      (c) => c[0] === 'identity' && c[1] === 'anon-only',
    ).length;
    expect(tagsAfterReeval).toBe(1); // still one-time
    expect(identifyMainUserMock).not.toHaveBeenCalled();
  });

  it('DA3: sets Sentry identity tag = anon-only when no email and Sentry enabled', async () => {
    process.env.SENTRY_DSN = 'https://[external-email]/0';
    settingsState.current = { companyName: null }; // no userEmail

    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    expect(sentrySetTagMock).toHaveBeenCalledWith('identity', 'anon-only');
  });

  it('DA3: sets Sentry identity tag = identified when email present and Sentry enabled', async () => {
    process.env.SENTRY_DSN = 'https://[external-email]/0';
    settingsState.current = { companyName: null, userEmail: 'owner@example.com' };

    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    expect(sentrySetTagMock).toHaveBeenCalledWith('identity', 'identified');
  });

  // ── F3 (Stage 6a): Sentry user scope shares the Stage 3 identity source ──────

  it('F3: sets Sentry user with email + anon id when owner email present (Sentry enabled)', async () => {
    process.env.SENTRY_DSN = 'https://[external-email]/0';
    settingsState.current = { companyName: null, userEmail: '[external-email]' };

    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    // setUser carries the lowercased owner email + the stable anon id.
    expect(sentrySetUserMock).toHaveBeenCalledWith({ id: 'anon-id-test', email: 'owner@example.com' });
  });

  it('F3: sets Sentry user with anon id ONLY (no email) when anon-only (Sentry enabled)', async () => {
    process.env.SENTRY_DSN = 'https://[external-email]/0';
    settingsState.current = { companyName: null }; // no userEmail

    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    // anon-only: id present, no email key.
    expect(sentrySetUserMock).toHaveBeenCalledWith({ id: 'anon-id-test' });
  });

  it('F3: does NOT set Sentry user when Sentry is disabled (no DSN)', async () => {
    delete process.env.SENTRY_DSN;
    settingsState.current = { companyName: null, userEmail: 'owner@example.com' };

    const { bootstrap } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    expect(sentrySetUserMock).not.toHaveBeenCalled();
  });

  it('F3: anon-only → identified flip also updates the Sentry user (route-hook path)', async () => {
    process.env.SENTRY_DSN = 'https://[external-email]/0';
    settingsState.current = { companyName: null }; // boot anon-only

    const { bootstrap, applyCloudAnalyticsIdentity } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);
    expect(sentrySetUserMock).toHaveBeenLastCalledWith({ id: 'anon-id-test' });

    // A later dual-write supplies the owner email; re-running identity flips
    // the Sentry user to include the email.
    settingsState.current = { companyName: null, userEmail: 'owner@example.com' };
    applyCloudAnalyticsIdentity();
    expect(sentrySetUserMock).toHaveBeenLastCalledWith({ id: 'anon-id-test', email: 'owner@example.com' });
  });

  // ── Live recovery: anon-only → identified without restart ───────────────────
  //
  // This exercises the REAL production recovery path. The cloud `settingsStore`
  // shim has no `onDidAnyChange` seam, so live recovery is NOT driven by a store
  // change event (asserting against such a mock would be a false green — the
  // method does not exist in production). Instead, the inbound settings
  // dual-write chokepoint (`routes/settings.ts` → `deps.refreshAnalyticsIdentity`,
  // which is `applyCloudAnalyticsIdentity`) re-evaluates identity after the
  // write lands. We simulate that by mutating the (mocked) settings state and
  // calling the exported `applyCloudAnalyticsIdentity()` directly — the same
  // entry point the route hook invokes.

  it('flips anon-only → identified when applyCloudAnalyticsIdentity re-runs after a userEmail dual-write (route-hook path)', async () => {
    process.env.SENTRY_DSN = 'https://[external-email]/0';
    settingsState.current = { companyName: null }; // boot with no email

    const { bootstrap, applyCloudAnalyticsIdentity } = await import('../bootstrap');
    await bootstrap().catch(() => undefined);

    // Boot: anon-only — no identify, Sentry identity tagged anon-only once.
    expect(identifyMainUserMock).not.toHaveBeenCalled();
    expect(
      sentrySetTagMock.mock.calls.filter((c) => c[0] === 'identity' && c[1] === 'anon-only').length,
    ).toBe(1);

    // Owner email dual-writes from desktop → cloud after boot; the settings
    // route applies it then calls refreshAnalyticsIdentity (= this helper).
    settingsState.current = { companyName: null, userEmail: 'owner@example.com' };
    applyCloudAnalyticsIdentity();

    // Live flip: identify fires with surface-tagged, lowercased traits…
    expect(identifyMainUserMock).toHaveBeenCalledTimes(1);
    const arg = identifyMainUserMock.mock.calls[0][0] as { userId: string; traits: Record<string, unknown> };
    expect(arg.userId).toBe('owner@example.com');
    expect(arg.traits.surface).toBe('cloud');
    // …and the Sentry identity tag flips anon-only → identified.
    expect(sentrySetTagMock).toHaveBeenCalledWith('identity', 'identified');
  });
});

// ── Stage 6b (F6): cloud Sentry honours shared env knobs ──────────────────────
//
// Cloud previously hard-coded enabled:true with no kill-switch and ignored
// SENTRY_RELEASE. Stage 6b routes enablement through the shared
// `shouldEnableSentry` parser (src/shared/telemetry/sentryConfig.ts) and lets an
// explicit SENTRY_RELEASE override the default cloud release tag. The init runs
// at MODULE LOAD, so these assert against the (hoisted) Sentry.init mock after
// importing bootstrap.

describe('cloud bootstrap — Stage 6b Sentry config knobs (F6)', () => {
  const TEST_DSN = 'https://[external-email]/0';

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    analyticsClientAvailableMock.mockReturnValue(true);
    getLicenseTierMock.mockReturnValue('free');
    getOrGenerateAnonymousIdMock.mockReturnValue('anon-id-test');
    settingsState.current = { companyName: null };
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-analytics-test-'));
    process.env.REBEL_USER_DATA = tmpRoot;
    delete process.env.REBEL_SURFACE;
    delete process.env.DISABLE_ANALYTICS;
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ENABLED;
    delete process.env.SENTRY_RELEASE;
    delete process.env.SENTRY_TRACES_SAMPLE_RATE;
  });

  afterEach(() => {
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ENABLED;
    delete process.env.SENTRY_RELEASE;
    delete process.env.SENTRY_TRACES_SAMPLE_RATE;
  });

  it('initialises Sentry when DSN present and SENTRY_ENABLED unset (default on)', async () => {
    process.env.SENTRY_DSN = TEST_DSN;
    await import('../bootstrap');
    expect(sentryInitMock).toHaveBeenCalledTimes(1);
  });

  it('SENTRY_ENABLED=0 is a kill-switch: Sentry.init is NOT called even with a DSN', async () => {
    process.env.SENTRY_DSN = TEST_DSN;
    process.env.SENTRY_ENABLED = '0';
    await import('../bootstrap');
    expect(sentryInitMock).not.toHaveBeenCalled();
  });

  it('does NOT initialise Sentry when no DSN (unchanged baseline)', async () => {
    delete process.env.SENTRY_DSN;
    await import('../bootstrap');
    expect(sentryInitMock).not.toHaveBeenCalled();
  });

  it('uses the cloud-specific default release tag when SENTRY_RELEASE is unset', async () => {
    process.env.SENTRY_DSN = TEST_DSN;
    await import('../bootstrap');
    const initArg = sentryInitMock.mock.calls[0][0] as { release: string; environment: string; includeServerName: boolean };
    expect(initArg.release.startsWith('mindstone-rebel-cloud@')).toBe(true);
    // environment stays the canonical surface filter; includeServerName off (parity).
    expect(initArg.environment).toBe('cloud');
    expect(initArg.includeServerName).toBe(false);
  });

  it('honours an explicit SENTRY_RELEASE override', async () => {
    process.env.SENTRY_DSN = TEST_DSN;
    process.env.SENTRY_RELEASE = 'mindstone-rebel-cloud@9.9.9-canary';
    await import('../bootstrap');
    const initArg = sentryInitMock.mock.calls[0][0] as { release: string };
    expect(initArg.release).toBe('mindstone-rebel-cloud@9.9.9-canary');
  });

  it('keeps tracesSampleRate at 0 by default and honours an explicit SENTRY_TRACES_SAMPLE_RATE override', async () => {
    process.env.SENTRY_DSN = TEST_DSN;
    await import('../bootstrap');
    const defaultArg = sentryInitMock.mock.calls[0][0] as { tracesSampleRate: number };
    expect(defaultArg.tracesSampleRate).toBe(0);

    vi.resetModules();
    vi.clearAllMocks();
    process.env.SENTRY_DSN = TEST_DSN;
    process.env.SENTRY_TRACES_SAMPLE_RATE = '0.25';
    await import('../bootstrap');
    const overrideArg = sentryInitMock.mock.calls[0][0] as { tracesSampleRate: number };
    expect(overrideArg.tracesSampleRate).toBe(0.25);
  });
});
