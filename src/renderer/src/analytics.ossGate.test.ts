/**
 * OSS no-phone-home gate for the renderer RudderStack analytics (B6.a / Stage 3a),
 * plus the async single-flight + pending-track-buffer behavior added by
 * 260618_oss-rudderstack-strip.
 *
 * Asserts the gate sits BEFORE the SDK module is even imported (let alone
 * `new RudderAnalytics()`, `client.load()`, the ready() timeout):
 *  - OSS + opt-in OFF: dynamic import NEVER executes, no ctor, no load(), no timeout.
 *  - OSS + opt-in ON + user creds: load() called with the USER write key/data
 *    plane, never runtimeConfig/env creds.
 *  - Enterprise (rendererIsOss() false): reads runtimeConfig exactly as before.
 *
 * And the new async behavior (F1/F2/F5/F6):
 *  - A track() called synchronously after init() (before it settles) is BUFFERED
 *    and flushed AFTER the identify/alias identity sequence (F1 ordering).
 *  - Buffered track() events are DROPPED when creds are missing (OSS-on-no-creds)
 *    or when the import/load FAILS (health → error).
 *  - Concurrent/repeat init() calls SHARE one import + load (single-flight; ctor
 *    constructed once).
 *  - The dynamic import is NEVER executed before the credential gate (F6 — a
 *    module-load sentinel, distinct from the ctor not being constructed).
 *
 * DI-3 carry-forward: each test sets the `__REBEL_IS_OSS__` build signal
 * explicitly (default undefined → false → enterprise, a silent trap).
 *
 * init() is now async (returns Promise<void>) — tests `await analytics.init()`
 * (or await the captured promise) to observe post-load assertions. Vitest hoisted
 * mocks intercept the guarded dynamic import of the SDK the same as a static
 * import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadMock = vi.hoisted(() => vi.fn());
const readyMock = vi.hoisted(() => vi.fn());
const setAnonymousIdMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
const identifyMock = vi.hoisted(() => vi.fn());
const aliasMock = vi.hoisted(() => vi.fn());
const ctorMock = vi.hoisted(() => vi.fn());
// F6: module-load sentinel. Fires whenever `loadRudderConstructor()` reads
// `mod.RudderAnalytics` off the dynamically-imported module — proving the
// guarded dynamic import of the SDK actually executed and was consumed
// (stronger than asserting the ctor was not constructed: the import could resolve
// without `new`-ing). Implemented as a GETTER so it re-fires every test (the
// mock-factory body is memoised by Vitest and would only fire on the first import
// across the file). Stays at 0 when the cred gate returns before the await.
const moduleLoadMock = vi.hoisted(() => vi.fn());

vi.mock('@rudderstack/analytics-js', () => {
  class RudderAnalytics {
    constructor() {
      ctorMock();
    }
    load = loadMock;
    ready = readyMock;
    setAnonymousId = setAnonymousIdMock;
    track = trackMock;
    identify = identifyMock;
    alias = aliasMock;
  }
  return {
    get RudderAnalytics() {
      moduleLoadMock();
      return RudderAnalytics;
    },
  };
});

vi.mock('./sentry', () => ({
  captureRendererMessage: vi.fn(),
  captureRendererException: vi.fn(),
}));

const setWindow = (opts: {
  isOss: boolean;
  runtimeConfig?: unknown;
  telemetryConfig?: unknown;
  anonymousId?: string | null;
  userEmail?: string | null;
}): void => {
  (globalThis as Record<string, unknown>).__REBEL_IS_OSS__ = opts.isOss;
  vi.stubGlobal('window', {
    electronEnv: {
      appVersion: '1.0.0-test',
      anonymousId: opts.anonymousId ?? null,
      userEmail: opts.userEmail ?? null,
      analyticsDisabled: false,
      runtimeConfig: opts.runtimeConfig ?? null,
      telemetryConfig: opts.telemetryConfig ?? null,
    },
    miscApi: { rendererHealth: vi.fn() },
    api: {},
  });
};

const ENTERPRISE_RUNTIME_CONFIG = {
  analytics: {
    rudderstack: {
      writeKey: 'mindstone-write-key',
      dataPlaneUrl: 'https://mindstone.dataplane.example',
    },
  },
};

const ENTERPRISE_TELEMETRY_CONFIG_USER_CREDS = {
  enabled: true,
  rudderWriteKey: 'user-write-key',
  rudderDataPlaneUrl: 'https://user.dataplane.example',
};

describe('renderer analytics OSS no-phone-home gate', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).__REBEL_IS_OSS__;
  });

  it('OSS + opt-in OFF: SDK module NEVER imported, NO ctor, NO load(), NO ready timeout — even with env/app-config creds', async () => {
    setWindow({ isOss: true, runtimeConfig: ENTERPRISE_RUNTIME_CONFIG, telemetryConfig: null });

    const { analytics } = await import('./analytics');
    await analytics.init();

    // F6: the gate returned BEFORE the await import() — the SDK module never loaded.
    expect(moduleLoadMock).not.toHaveBeenCalled();
    expect(ctorMock).not.toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
    expect(readyMock).not.toHaveBeenCalled();
    expect(analytics.getIdentifiedEmail()).toBeNull();
  });

  it('OSS + opt-in ON but no user creds: SDK module NEVER imported, NO ctor, NO load()', async () => {
    setWindow({
      isOss: true,
      runtimeConfig: ENTERPRISE_RUNTIME_CONFIG,
      telemetryConfig: { enabled: true },
    });

    const { analytics } = await import('./analytics');
    await analytics.init();

    // F6: missing-creds gate returns before the await import().
    expect(moduleLoadMock).not.toHaveBeenCalled();
    expect(ctorMock).not.toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('OSS + opt-in ON + user creds: load() uses the USER creds, never runtimeConfig/env', async () => {
    setWindow({
      isOss: true,
      runtimeConfig: ENTERPRISE_RUNTIME_CONFIG,
      telemetryConfig: ENTERPRISE_TELEMETRY_CONFIG_USER_CREDS,
    });

    const { analytics } = await import('./analytics');
    await analytics.init();

    expect(moduleLoadMock).toHaveBeenCalledTimes(1);
    expect(ctorMock).toHaveBeenCalledTimes(1);
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(loadMock).toHaveBeenCalledWith(
      'user-write-key',
      'https://user.dataplane.example',
      expect.anything(),
    );
    // The runtimeConfig (env/app-config) creds must never reach load().
    expect(JSON.stringify(loadMock.mock.calls)).not.toContain('mindstone-write-key');
  });

  it('enterprise (rendererIsOss() false): reads runtimeConfig exactly as before', async () => {
    setWindow({ isOss: false, runtimeConfig: ENTERPRISE_RUNTIME_CONFIG, telemetryConfig: null });

    const { analytics } = await import('./analytics');
    await analytics.init();

    expect(moduleLoadMock).toHaveBeenCalledTimes(1);
    expect(ctorMock).toHaveBeenCalledTimes(1);
    expect(loadMock).toHaveBeenCalledWith(
      'mindstone-write-key',
      'https://mindstone.dataplane.example',
      expect.anything(),
    );
  });
});

describe('renderer analytics async single-flight + pending-track buffer', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).__REBEL_IS_OSS__;
  });

  it('F1: a track() before init settles is FLUSHED after success AND lands after the identify/alias identity sequence', async () => {
    // Enterprise build with an anonymousId + preload email so init() runs the
    // full identity sequence (setAnonymousId → alias → identify) before the flush.
    setWindow({
      isOss: false,
      runtimeConfig: ENTERPRISE_RUNTIME_CONFIG,
      telemetryConfig: null,
      anonymousId: 'anon-123',
      userEmail: 'user@example.com',
    });

    const { analytics } = await import('./analytics');

    // Fire-and-forget init (NOT awaited) so we can track WHILE it is in flight —
    // exactly main.tsx's ordering: init(); track('Renderer Boot', ...).
    const initDone = analytics.init();
    analytics.track('Renderer Boot', { path: '/' });

    // Buffered, not emitted yet (SDK still loading via the dynamic import).
    expect(trackMock).not.toHaveBeenCalled();

    await initDone;

    // The boot event is flushed exactly once.
    const bootTrackIndex = trackMock.mock.calls.findIndex((c) => c[0] === 'Renderer Boot');
    expect(bootTrackIndex).toBeGreaterThanOrEqual(0);
    expect(trackMock.mock.calls.filter((c) => c[0] === 'Renderer Boot')).toHaveLength(1);

    // F1 ordering: identifyEmail runs inside init() BEFORE the buffer flush, so
    // the alias + the identify-from-email both hit the SDK before the boot track.
    expect(aliasMock).toHaveBeenCalledTimes(1);
    expect(identifyMock).toHaveBeenCalled();
    const aliasOrder = aliasMock.mock.invocationCallOrder[0];
    const identifyOrder = identifyMock.mock.invocationCallOrder[0];
    const bootTrackOrder = trackMock.mock.invocationCallOrder[bootTrackIndex];
    expect(aliasOrder).toBeLessThan(bootTrackOrder);
    expect(identifyOrder).toBeLessThan(bootTrackOrder);
  });

  it('F5: buffered track() events are DROPPED when creds are missing (OSS-on-no-creds)', async () => {
    setWindow({ isOss: true, telemetryConfig: { enabled: true } });

    const { analytics } = await import('./analytics');

    // track() before init: in OSS/disabled `enabling` is never set, so this is a
    // plain no-op (nothing buffered).
    analytics.track('Renderer Boot', { path: '/' });
    await analytics.init();

    expect(moduleLoadMock).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('F5: buffered track() events are DROPPED on import/load failure (health → error)', async () => {
    setWindow({ isOss: false, runtimeConfig: ENTERPRISE_RUNTIME_CONFIG, telemetryConfig: null });
    // Make load() throw so doInit() takes the failure-safe path.
    loadMock.mockImplementationOnce(() => {
      throw new Error('load boom');
    });

    const analyticsModule = await import('./analytics');
    const { analytics, getRendererAnalyticsHealth } = analyticsModule;

    const initDone = analytics.init();
    analytics.track('Renderer Boot', { path: '/' }); // buffered while in flight
    // init() must RESOLVE, never reject (fire-and-forget at main.tsx).
    await expect(initDone).resolves.toBeUndefined();

    // Buffer dropped → boot event never emitted; health flipped to error.
    expect(trackMock).not.toHaveBeenCalled();
    const health = getRendererAnalyticsHealth();
    expect(health.state).toBe('error');
    expect(health.error).toContain('load boom');
    expect(health.enabled).toBe(false);
  });

  it('F2: concurrent/repeat init() calls SHARE one import + load (single-flight, ctor once)', async () => {
    setWindow({
      isOss: true,
      telemetryConfig: ENTERPRISE_TELEMETRY_CONFIG_USER_CREDS,
    });

    const { analytics } = await import('./analytics');

    await Promise.all([analytics.init(), analytics.init(), analytics.init()]);
    // A late repeat call after settle also shares the memoised result.
    await analytics.init();

    expect(moduleLoadMock).toHaveBeenCalledTimes(1);
    expect(ctorMock).toHaveBeenCalledTimes(1);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('GPT-F2: when MORE than PENDING_TRACK_CAP (50) track() calls are buffered in flight, exactly the cap is preserved with the OLDEST dropped (drop-oldest)', async () => {
    // Commercial/enterprise path so the cred gate passes, `enabling` is set, and
    // track() calls made WHILE init is in flight are buffered (not no-op'd). No
    // anonymousId/userEmail so the only track() events flushed are our own — the
    // identity sequence (alias/identify) doesn't add stray track() calls.
    setWindow({ isOss: false, runtimeConfig: ENTERPRISE_RUNTIME_CONFIG, telemetryConfig: null });

    const { analytics } = await import('./analytics');

    const CAP = 50;
    const OVERFLOW = 5; // enqueue CAP + OVERFLOW = 55 > cap, forcing drop-oldest
    const total = CAP + OVERFLOW;

    // Fire-and-forget init (NOT awaited) so all track() calls land while the SDK
    // is still loading via the pending dynamic import — i.e. the "enabling but not
    // enabled" window. Each event carries its sequence index so we can assert
    // exactly WHICH ones survived.
    const initDone = analytics.init();
    for (let i = 0; i < total; i++) {
      analytics.track('Buffered Event', { seq: i });
    }

    // Nothing emitted yet — all buffered (and the buffer already capped to 50, so
    // the oldest 5 were dropped on push).
    expect(trackMock).not.toHaveBeenCalled();

    await initDone;

    // Exactly the cap was preserved.
    expect(trackMock).toHaveBeenCalledTimes(CAP);

    // The OLDEST events (seq 0..OVERFLOW-1) were dropped; the LAST 50 (seq
    // OVERFLOW..total-1) flushed, in order.
    const flushedSeqs = trackMock.mock.calls.map((c) => (c[1] as { seq: number }).seq);
    const expectedSeqs = Array.from({ length: CAP }, (_, k) => OVERFLOW + k);
    expect(flushedSeqs).toEqual(expectedSeqs);

    // Explicit drop assertions: the first OVERFLOW events are gone; the newest
    // event is present.
    expect(flushedSeqs).not.toContain(0);
    expect(flushedSeqs[0]).toBe(OVERFLOW);
    expect(flushedSeqs[flushedSeqs.length - 1]).toBe(total - 1);
  });
});
