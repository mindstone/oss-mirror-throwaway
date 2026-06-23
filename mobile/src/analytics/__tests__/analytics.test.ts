/**
 * Stage B1 — the analytics singleton must be INERT until permitted: no SDK
 * calls when `isAnalyticsPermitted()` is false (no creds / kill-switch on), and
 * correct gate + reset semantics once permitted.
 */

const mockSetup = jest.fn().mockResolvedValue(undefined);
const mockTrack = jest.fn().mockResolvedValue(undefined);
const mockIdentify = jest.fn().mockResolvedValue(undefined);
const mockFlush = jest.fn().mockResolvedValue(undefined);
const mockReset = jest.fn().mockResolvedValue(undefined);
const mockSetAnonymousId = jest.fn().mockResolvedValue(undefined);

jest.mock('@rudderstack/rudder-sdk-react-native', () => ({
  __esModule: true,
  default: {
    setup: (...args: unknown[]) => mockSetup(...args),
    track: (...args: unknown[]) => mockTrack(...args),
    identify: (...args: unknown[]) => mockIdentify(...args),
    flush: (...args: unknown[]) => mockFlush(...args),
    reset: (...args: unknown[]) => mockReset(...args),
    setAnonymousId: (...args: unknown[]) => mockSetAnonymousId(...args),
  },
}));

// anonymousId reconciliation reads secure storage; stub it deterministically.
jest.mock('../anonymousId', () => ({
  resolveAnonymousId: jest.fn().mockResolvedValue('install-id-123'),
}));

import {
  analytics,
  isAnalyticsPermitted,
  getMobileAnalyticsHealth,
  __resetAnalyticsStateForTests,
} from '../analytics';

const WRITE_KEY = 'EXPO_PUBLIC_RUDDERSTACK_WRITE_KEY';
const DATA_PLANE = 'EXPO_PUBLIC_RUDDERSTACK_DATA_PLANE_URL';
const KILL = 'EXPO_PUBLIC_DISABLE_ANALYTICS';

function clearEnv() {
  delete process.env[WRITE_KEY];
  delete process.env[DATA_PLANE];
  delete process.env[KILL];
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetAnalyticsStateForTests();
  clearEnv();
});

afterAll(() => clearEnv());

describe('isAnalyticsPermitted (the single chokepoint)', () => {
  it('is false with no credentials', () => {
    expect(isAnalyticsPermitted()).toBe(false);
  });

  it('is false with only a write key', () => {
    process.env[WRITE_KEY] = 'wk';
    expect(isAnalyticsPermitted()).toBe(false);
  });

  it('is true with both credentials and kill-switch off', () => {
    process.env[WRITE_KEY] = 'wk';
    process.env[DATA_PLANE] = 'https://dp.example';
    expect(isAnalyticsPermitted()).toBe(true);
  });

  it('is false when the kill-switch is on, even with credentials', () => {
    process.env[WRITE_KEY] = 'wk';
    process.env[DATA_PLANE] = 'https://dp.example';
    process.env[KILL] = 'true';
    expect(isAnalyticsPermitted()).toBe(false);
  });
});

// Stage B2 — consent model SETTLED by user (2026-06-12): match desktop, analytics
// ALWAYS-ON, identified by email, disclosed in the privacy policy. There is NO
// user-consent gate: no in-app toggle, no persisted consent flag, no first-run
// gate. The ONLY levers are credential presence and the non-user kill-switch.
describe('always-on semantics (no user-consent gate)', () => {
  it('is permitted purely on credentials when the kill-switch is unset (default = on)', () => {
    // No consent value is read or required; creds present + kill-switch absent = on.
    process.env[WRITE_KEY] = 'wk';
    process.env[DATA_PLANE] = 'https://dp.example';
    expect(process.env[KILL]).toBeUndefined();
    expect(isAnalyticsPermitted()).toBe(true);
  });

  it.each([
    ['1', false],
    ['true', false],
    ['TRUE', false],
    ['yes', false],
    ['0', true],
    ['false', true],
    ['no', true],
    ['', true],
  ])('kill-switch=%j → permitted=%s (with creds present)', (killValue, expected) => {
    process.env[WRITE_KEY] = 'wk';
    process.env[DATA_PLANE] = 'https://dp.example';
    process.env[KILL] = killValue as string;
    expect(isAnalyticsPermitted()).toBe(expected);
  });

  it('cleanly disables (no throw) when creds are missing AND kill-switch is on', () => {
    process.env[KILL] = 'true';
    expect(() => isAnalyticsPermitted()).not.toThrow();
    expect(isAnalyticsPermitted()).toBe(false);
  });
});

describe('inert until permitted', () => {
  it('init() never calls SDK setup() when no credentials are present', async () => {
    await analytics.init();
    expect(mockSetup).not.toHaveBeenCalled();
    expect(analytics.isAvailable()).toBe(false);
    expect(getMobileAnalyticsHealth()).toEqual({
      initialized: true,
      enabled: false,
      permitted: false,
    });
  });

  it('track() / identify() / flush() are no-ops while uninitialised', () => {
    analytics.track('Screen Viewed', { name: 'home' });
    analytics.identify('worker@example.com');
    analytics.flush();
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockIdentify).not.toHaveBeenCalled();
    expect(mockFlush).not.toHaveBeenCalled();
  });

  it('init() never calls setup() when the kill-switch is on', async () => {
    process.env[WRITE_KEY] = 'wk';
    process.env[DATA_PLANE] = 'https://dp.example';
    process.env[KILL] = '1';
    await analytics.init();
    expect(mockSetup).not.toHaveBeenCalled();
    expect(analytics.isAvailable()).toBe(false);
  });
});

describe('once permitted', () => {
  beforeEach(() => {
    process.env[WRITE_KEY] = 'wk';
    process.env[DATA_PLANE] = 'https://dp.example';
  });

  it('init() calls setup() with the IDFA-free / device-id-free config and seeds the anonymousId via the setup options (non-deprecated path)', async () => {
    await analytics.init();
    expect(mockSetup).toHaveBeenCalledTimes(1);
    const [writeKey, config, options] = mockSetup.mock.calls[0];
    expect(writeKey).toBe('wk');
    expect(config).toMatchObject({
      dataPlaneUrl: 'https://dp.example',
      autoCollectAdvertId: false,
      collectDeviceId: false,
      trackAppLifecycleEvents: false,
    });
    // anonymousId is seeded through the setup `options` arg, NOT the deprecated
    // `setAnonymousId()` method (B1 note → B3).
    expect(options).toEqual({ anonymousId: 'install-id-123' });
    expect(mockSetAnonymousId).not.toHaveBeenCalled();
    expect(analytics.isAvailable()).toBe(true);
  });

  it('init() still succeeds (no options) when anonymousId resolution fails', async () => {
    const { resolveAnonymousId } = jest.requireMock('../anonymousId') as {
      resolveAnonymousId: jest.Mock;
    };
    resolveAnonymousId.mockRejectedValueOnce(new Error('secure storage unavailable'));
    await analytics.init();
    expect(mockSetup).toHaveBeenCalledTimes(1);
    const [, , options] = mockSetup.mock.calls[0];
    // No anonymousId available → pass null so the SDK mints its own id.
    expect(options).toBeNull();
    expect(analytics.isAvailable()).toBe(true);
  });

  it('init() is idempotent', async () => {
    await analytics.init();
    await analytics.init();
    expect(mockSetup).toHaveBeenCalledTimes(1);
  });

  it('track() emits with a client_surface tag once enabled', async () => {
    await analytics.init();
    analytics.track('Message Sent', { thread: 'abc' });
    expect(mockTrack).toHaveBeenCalledTimes(1);
    const [event, props] = mockTrack.mock.calls[0];
    expect(event).toBe('Message Sent');
    expect(props).toMatchObject({ client_surface: 'mobile', thread: 'abc' });
  });

  it("track() client_surface:'mobile' is NOT overridable by caller props (partition discriminator)", async () => {
    await analytics.init();
    // A caller (mistakenly) passes client_surface — it must NOT win over 'mobile'.
    analytics.track('Message Sent', { client_surface: 'desktop' });
    const [, props] = mockTrack.mock.calls[0];
    expect((props as Record<string, unknown>).client_surface).toBe('mobile');
  });

  it('init() is memoised: concurrent callers await ONE setup', async () => {
    const [a, b] = [analytics.init(), analytics.init()];
    await Promise.all([a, b]);
    expect(mockSetup).toHaveBeenCalledTimes(1);
    expect(analytics.isAvailable()).toBe(true);
  });

  it('whenReady() resolves after init() setup completes (serialises identify — F2)', async () => {
    // Make setup resolve on a deferred promise so we can observe ordering.
    let resolveSetup: () => void = () => {};
    let setupCalled: () => void = () => {};
    const setupInvoked = new Promise<void>((res) => { setupCalled = res; });
    mockSetup.mockImplementationOnce(
      () => new Promise<void>((res) => {
        resolveSetup = res;
        setupCalled();
      }),
    );
    void analytics.init();
    // Before setup resolves, identify is dropped (not yet enabled)...
    analytics.identify('worker@example.com');
    expect(mockIdentify).not.toHaveBeenCalled();

    // A caller that awaits whenReady() only proceeds after setup settles.
    const readyPromise = analytics.whenReady().then(() => {
      analytics.identify('worker@example.com');
    });
    // Wait until runInit has actually reached setup() (past the awaited
    // anonymousId resolution) before resolving its deferred promise.
    await setupInvoked;
    resolveSetup();
    await readyPromise;
    expect(analytics.isAvailable()).toBe(true);
    // identify reaches the SDK (singleton passes (userId, traits={})).
    expect(mockIdentify).toHaveBeenCalledWith('worker@example.com', {});
  });

  it('whenReady() resolves immediately when init() was never called', async () => {
    await expect(analytics.whenReady()).resolves.toBeUndefined();
  });

  it('reset() keeps the anonymousId AND analytics stays enabled (always-on)', async () => {
    await analytics.init();
    analytics.reset();
    // reset(false) → anonymousId preserved; SDK NOT torn down.
    expect(mockReset).toHaveBeenLastCalledWith(false);
    expect(analytics.isAvailable()).toBe(true);
    // Anonymous emission continues after reset (no disable on unpair).
    analytics.track('Screen Viewed', { name: '(tabs)/index' });
    expect(mockTrack).toHaveBeenCalledTimes(1);
  });

  it('reset() keeps the anonymousId by default and can clear it on request', async () => {
    await analytics.init();
    analytics.reset();
    expect(mockReset).toHaveBeenLastCalledWith(false);
    analytics.reset(true);
    expect(mockReset).toHaveBeenLastCalledWith(true);
  });

  it('flush() / reset() stop hitting the SDK after a post-init kill-switch flip (F2)', async () => {
    await analytics.init();
    expect(analytics.isAvailable()).toBe(true);

    // Sanity: while permitted, flush()/reset() reach the SDK.
    analytics.flush();
    analytics.reset();
    expect(mockFlush).toHaveBeenCalledTimes(1);
    expect(mockReset).toHaveBeenCalledTimes(1);

    // Flip the kill-switch AFTER init+enable — isAnalyticsPermitted() is now false.
    process.env[KILL] = 'true';
    expect(isAnalyticsPermitted()).toBe(false);

    analytics.flush();
    analytics.reset();
    analytics.reset(true);

    // No additional SDK calls — the gate caught the post-init permission flip.
    expect(mockFlush).toHaveBeenCalledTimes(1);
    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  it('track() / identify() also stop after a post-init kill-switch flip', async () => {
    await analytics.init();
    process.env[KILL] = 'true';
    analytics.track('Message Sent', { thread: 'abc' });
    analytics.identify('worker@example.com');
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockIdentify).not.toHaveBeenCalled();
  });

  it('a setup() failure leaves analytics inert, never throwing', async () => {
    mockSetup.mockRejectedValueOnce(new Error('native bridge unavailable'));
    await expect(analytics.init()).resolves.toBeUndefined();
    expect(analytics.isAvailable()).toBe(false);
    analytics.track('Screen Viewed');
    expect(mockTrack).not.toHaveBeenCalled();
  });

  // F3 — pre-ready event queue: cold-start events tracked BEFORE the async
  // fire-and-forget init() finishes must not be dropped.
  describe('pre-ready event queue (F3)', () => {
    it('buffers an event tracked BEFORE init completes and emits it (in order) after setup', async () => {
      // Defer setup so we can track WHILE init is in flight (realistic ordering —
      // we do NOT pre-await init()).
      let resolveSetup: () => void = () => {};
      const setupGate = new Promise<void>((res) => { resolveSetup = res; });
      mockSetup.mockImplementationOnce(() => setupGate);

      const initDone = analytics.init(); // fire-and-forget (NOT awaited yet)

      // These fire before setup resolves — at this point enabled === false.
      analytics.track('App Opened', { cold: true });
      analytics.track('Screen Viewed', { name: '(tabs)/index' });
      expect(mockTrack).not.toHaveBeenCalled(); // buffered, not emitted yet

      // Setup completes → buffered events flush in order.
      resolveSetup();
      await initDone;

      expect(mockTrack).toHaveBeenCalledTimes(2);
      expect(mockTrack.mock.calls.map((c) => c[0])).toEqual(['App Opened', 'Screen Viewed']);
      // client_surface tag injected on flushed events too.
      for (const call of mockTrack.mock.calls) {
        expect((call[1] as Record<string, unknown>).client_surface).toBe('mobile');
      }
    });

    it('DROPS buffered events when init resolves not-permitted (no creds)', async () => {
      // No creds in this case → not permitted, so the event is a no-op (and any
      // buffer is dropped at init). Clear env to force not-permitted.
      delete process.env[WRITE_KEY];
      delete process.env[DATA_PLANE];
      expect(isAnalyticsPermitted()).toBe(false);

      analytics.track('App Opened', { cold: true }); // not permitted → no-op
      await analytics.init();
      expect(mockTrack).not.toHaveBeenCalled();
    });

    it('DROPS buffered events when setup() FAILS', async () => {
      mockSetup.mockRejectedValueOnce(new Error('native bridge unavailable'));
      const initDone = analytics.init();
      analytics.track('App Opened', { cold: true }); // buffered while in flight
      await initDone;
      // Setup failed → buffer dropped, nothing emitted.
      expect(mockTrack).not.toHaveBeenCalled();
    });

    it('caps the buffer at 50 events (drops the oldest) while init is in flight', async () => {
      let resolveSetup: () => void = () => {};
      const setupGate = new Promise<void>((res) => { resolveSetup = res; });
      mockSetup.mockImplementationOnce(() => setupGate);
      const initDone = analytics.init();

      // Enqueue 55 events while setup is pending; only the newest 50 survive.
      for (let i = 0; i < 55; i++) {
        analytics.track('Screen Viewed', { seq: i });
      }
      resolveSetup();
      await initDone;

      expect(mockTrack).toHaveBeenCalledTimes(50);
      // Oldest 5 (seq 0..4) were evicted; first flushed is seq 5.
      const firstFlushed = mockTrack.mock.calls[0][1] as Record<string, unknown>;
      const lastFlushed = mockTrack.mock.calls[49][1] as Record<string, unknown>;
      expect(firstFlushed.seq).toBe(5);
      expect(lastFlushed.seq).toBe(54);
    });

    it('does NOT buffer once init has SETTLED to disabled (kill-switch flip)', async () => {
      // init settles enabled, then kill-switch flips → not permitted → no-op,
      // never buffered.
      await analytics.init();
      process.env[KILL] = 'true';
      analytics.track('App Opened');
      expect(mockTrack).not.toHaveBeenCalled();
    });

    it('DROPS buffered events at FLUSH time when the kill-switch flips between enqueue and setup', async () => {
      // Permission is re-checked at flush time, not only at enqueue: a kill-switch
      // flip during init must drop the queue rather than emit buffered events.
      let resolveSetup: () => void = () => {};
      const setupGate = new Promise<void>((res) => { resolveSetup = res; });
      mockSetup.mockImplementationOnce(() => setupGate);

      const initDone = analytics.init(); // fire-and-forget; setup still pending

      // Enqueue while permitted + init in flight (buffered).
      analytics.track('App Opened', { cold: true });
      analytics.track('Screen Viewed', { name: '(tabs)/index' });
      expect(mockTrack).not.toHaveBeenCalled();

      // Kill-switch flips ON before setup resolves → no longer permitted.
      process.env[KILL] = 'true';
      expect(isAnalyticsPermitted()).toBe(false);

      // Setup completes → flushPreReadyQueue() re-checks permission and DROPS the
      // queue instead of emitting.
      resolveSetup();
      await initDone;
      expect(mockTrack).not.toHaveBeenCalled();
    });
  });
});
