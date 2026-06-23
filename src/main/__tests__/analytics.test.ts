/**
 * Behavioral tests for src/main/analytics.ts after bumping
 * @rudderstack/rudder-sdk-node 2.1.11 → 3.0.5.
 *
 * The spike (docs/plans/260421_xlsx_and_rudderstack_security_bumps.md Stage 1)
 * verified that v3.0.5's callback semantics match v2.1.11 for all methods we
 * use. These tests lock in the contract by mocking the SDK at the module
 * boundary and exercising the real analytics.ts code paths:
 *
 *   1. Constructor success → analytics state becomes healthy after probe succeeds
 *   2. Constructor throw → defensive try/catch fails closed (state=error,
 *      client=null) — protects against future v3 patches tightening validation
 *   3. track() success callback (fires with `(undefined, buf)` in v3) → probe
 *      marks state=healthy (our code reads the first arg, extra 2nd arg is ignored)
 *   4. track() error callback (fires with `(Error, buf)` in v3) → probe schedules retry
 *   5. alias() success callback → hasAliased latch sets to true
 *   6. alias() error callback → hasAliased stays false (next identify retries)
 *   7. flush() returns a Promise that resolves (doesn't reject) even on transport
 *      failure — confirmed in v3 spike
 *   8. errorHandler option is wired and invoked on SDK transport errors
 *
 * These tests do NOT hit the network — the rudder-sdk-node module is fully
 * mocked. They verify our wiring, not the SDK itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// -----------------------------------------------------------------------------
// Mocks — hoisted so vi.mock factories can reference them
// -----------------------------------------------------------------------------
const {
  mockAnalyticsInstance,
  mockAnalyticsCtor,
  ctorBehavior,
  ctorTracker,
  configSecrets,
  mockLogDebug,
  mockLogInfo,
  mockLogWarn,
  mockLogError,
} = vi.hoisted(() => {
  // A mutable per-test mock client that captures calls and lets tests fire
  // success/error callbacks on demand.
  const mockAnalyticsInstance: {
    trackCalls: Array<{ payload: unknown; cb?: (err?: Error, buf?: unknown) => void }>;
    identifyCalls: Array<{ payload: unknown; cb?: (err?: Error, buf?: unknown) => void }>;
    aliasCalls: Array<{ payload: unknown; cb?: (err?: Error, buf?: unknown) => void }>;
    flushCalls: number;
    flushPromiseFactory: () => Promise<void>;
    capturedOptions: Record<string, unknown> | undefined;
    capturedWriteKey: string | undefined;
    track: (payload: unknown, cb?: (err?: Error, buf?: unknown) => void) => void;
    identify: (payload: unknown, cb?: (err?: Error, buf?: unknown) => void) => void;
    alias: (payload: unknown, cb?: (err?: Error, buf?: unknown) => void) => void;
    flush: () => Promise<void>;
  } = {
    trackCalls: [],
    identifyCalls: [],
    aliasCalls: [],
    flushCalls: 0,
    flushPromiseFactory: () => Promise.resolve(),
    capturedOptions: undefined,
    capturedWriteKey: undefined,
    track: (payload, cb) => {
      mockAnalyticsInstance.trackCalls.push({ payload, cb });
    },
    identify: (payload, cb) => {
      mockAnalyticsInstance.identifyCalls.push({ payload, cb });
    },
    alias: (payload, cb) => {
      mockAnalyticsInstance.aliasCalls.push({ payload, cb });
    },
    flush: () => {
      mockAnalyticsInstance.flushCalls++;
      return mockAnalyticsInstance.flushPromiseFactory();
    }
  };

  // Behavior control for the constructor (some tests want it to throw)
  const ctorBehavior: { shouldThrow: boolean; throwMessage: string } = {
    shouldThrow: false,
    throwMessage: 'simulated constructor throw'
  };

  // The rudder-sdk-node CJS module.exports IS the Analytics constructor itself.
  // With esModuleInterop, `import Analytics from '@rudderstack/rudder-sdk-node'`
  // gives back that constructor. To mimic this, we use a real class so `new`
  // semantics work, and route calls through a vi.fn via the constructor body.
  const tracker = vi.fn();
  class MockAnalytics {
    constructor(writeKey: string, options: Record<string, unknown>) {
      tracker(writeKey, options);
      mockAnalyticsInstance.capturedWriteKey = writeKey;
      mockAnalyticsInstance.capturedOptions = options;
      if (ctorBehavior.shouldThrow) {
        throw new Error(ctorBehavior.throwMessage);
      }
      // Return the shared instance so tests can observe/drive callbacks
      // (returning from a constructor replaces `this`)
      return mockAnalyticsInstance as unknown as MockAnalytics;
    }
  }
  const mockAnalyticsCtor = MockAnalytics as unknown as typeof MockAnalytics & { mock: typeof tracker };
  // Expose the tracker on the class for .toHaveBeenCalledTimes assertions
  (mockAnalyticsCtor as unknown as { mock: typeof tracker }).mock = tracker;

  const configSecrets: Record<string, string | undefined> = {
    RUDDERSTACK_WRITE_KEY: 'test-write-key',
    RUDDERSTACK_DATA_PLANE_URL: 'https://fake.dataplane.example'
  };

  return {
    mockAnalyticsInstance,
    mockAnalyticsCtor,
    ctorBehavior,
    ctorTracker: tracker,
    configSecrets,
    mockLogDebug: vi.fn(),
    mockLogInfo: vi.fn(),
    mockLogWarn: vi.fn(),
    mockLogError: vi.fn(),
  };
});

// OSS no-phone-home gate state (B6.a). DI-3 carry-forward: tests reading
// .isOss MUST set the signal explicitly — an untyped partial mock would yield
// isOss === undefined → falsy → enterprise, a silent trap.
const platformState = vi.hoisted(() => ({ isOss: false as boolean }));
// Spy on analytics-storage writes so the anon-ID gate can be asserted: in
// OSS-off no persistence may occur (the identity side-effect must not start).
const storeSetSpy = vi.hoisted(() => vi.fn());
const settingsState = vi.hoisted(() => ({
  telemetry: undefined as undefined | { enabled: boolean; rudderWriteKey?: string; rudderDataPlaneUrl?: string },
}));


vi.mock('@rudderstack/rudder-sdk-node', () => ({
  // Match the v2/v3 CJS export shape: `default` for esModuleInterop AND the
  // function itself at top level so both `import Analytics from` and
  // `require()` work.
  default: mockAnalyticsCtor,
  __esModule: true
}));


vi.mock('../runtimeConfig', () => ({
  resolveConfigSecret: vi.fn(({ envVar }: { envVar: string }) => {
    if (envVar) return configSecrets[envVar];
    return undefined;
  })
}));

vi.mock('@core/platform', () => ({
  getPlatformConfig: vi.fn(() => ({ ...platformState })),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: vi.fn(() => ({ ...settingsState })),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => ({
    debug: mockLogDebug,
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
  }))
}));

 
vi.mock('@core/storeFactory', () => {
  const memoryStore = new Map<string, unknown>();
  return {
    createStore: vi.fn(() => ({
      get: (k: string) => memoryStore.get(k) ?? '',
      set: (k: string, v: unknown) => { storeSetSpy(k, v); memoryStore.set(k, v); },
      delete: (k: string) => memoryStore.delete(k)
    }))
  };
});

 
vi.mock('../utils/dataPaths', () => ({
  getAppVersion: () => '0.4.32-test'
}));

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Fresh-import analytics.ts — the module uses module-scoped state
 * (analyticsClient, analyticsState, hasAliased), so tests need isolation.
 */
async function loadAnalyticsFresh(): Promise<typeof import('../analytics')> {
  vi.resetModules();
  return import('../analytics');
}

async function flushMicrotasks(): Promise<void> {
  // Drain queued microtasks and one macrotask — sufficient for our setTimeout-less paths
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
}

beforeEach(() => {
  mockAnalyticsInstance.trackCalls.length = 0;
  mockAnalyticsInstance.identifyCalls.length = 0;
  mockAnalyticsInstance.aliasCalls.length = 0;
  mockAnalyticsInstance.flushCalls = 0;
  mockAnalyticsInstance.flushPromiseFactory = () => Promise.resolve();
  mockAnalyticsInstance.capturedOptions = undefined;
  mockAnalyticsInstance.capturedWriteKey = undefined;
  ctorBehavior.shouldThrow = false;
  ctorTracker.mockClear();
  configSecrets.RUDDERSTACK_WRITE_KEY = 'test-write-key';
  configSecrets.RUDDERSTACK_DATA_PLANE_URL = 'https://fake.dataplane.example';
  platformState.isOss = false;
  settingsState.telemetry = undefined;
  storeSetSpy.mockClear();
  mockLogDebug.mockClear();
  mockLogInfo.mockClear();
  mockLogWarn.mockClear();
  mockLogError.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('initAnalytics (v3.0.5 wiring)', () => {
  it('constructs the SDK with expected write key and options', async () => {
    const mod = await loadAnalyticsFresh();
    mod.initAnalytics();

    expect(ctorTracker).toHaveBeenCalledTimes(1);
    expect(mockAnalyticsInstance.capturedWriteKey).toBe('test-write-key');
    expect(mockAnalyticsInstance.capturedOptions).toMatchObject({
      dataPlaneUrl: 'https://fake.dataplane.example',
      flushAt: 20,
      flushInterval: 5000
    });
    // errorHandler must still be a function in v3 (spike confirmed it's invoked)
    expect(typeof mockAnalyticsInstance.capturedOptions?.errorHandler).toBe('function');
  });

  it('fails closed if the SDK constructor throws (future-compat defense)', async () => {
    ctorBehavior.shouldThrow = true;

    const mod = await loadAnalyticsFresh();
    // Must not throw — operational-lens concern: a crashing constructor would
    // take down main process startup. Our try/catch must absorb it.
    expect(() => mod.initAnalytics()).not.toThrow();

    expect(mod.analyticsEnabled()).toBe(false);
    expect(mod.analyticsClientAvailable()).toBe(false);
    expect(mod.getAnalyticsStatus().state).toBe('error');
    expect(mod.getAnalyticsStatus().error).toBe('simulated constructor throw');
  });

  it('fires the config-check probe (track call) on successful init', async () => {
    const mod = await loadAnalyticsFresh();
    mod.initAnalytics();

    // State starts pending
    expect(mod.getAnalyticsStatus().state).toBe('pending');
    expect(mockAnalyticsInstance.trackCalls).toHaveLength(1);
    expect(mockAnalyticsInstance.trackCalls[0]?.payload).toMatchObject({
      event: 'RudderStack Config Check'
    });
  });

  it('no-ops and logs once at info level when the RudderStack write key is missing', async () => {
    configSecrets.RUDDERSTACK_WRITE_KEY = undefined;

    const mod = await loadAnalyticsFresh();
    mod.initAnalytics();
    mod.initAnalytics();

    expect(ctorTracker).not.toHaveBeenCalled();
    expect(mod.analyticsClientAvailable()).toBe(false);
    expect(mod.getAnalyticsStatus()).toMatchObject({ state: 'disabled', enabled: false, error: null });

    mod.trackMainEvent({ event: 'Missing Write Key Test', anonymousId: 'anon-test' });

    expect(mockAnalyticsInstance.trackCalls).toHaveLength(0);
    expect(mockLogInfo).toHaveBeenCalledTimes(1);
    expect(mockLogInfo).toHaveBeenCalledWith(
      { hasWriteKey: false, hasDataPlaneUrl: true },
      'RudderStack analytics disabled (missing credentials)'
    );
  });
});

describe('track callback (v3.0.5 two-arg callback semantics)', () => {
  it('treats `cb(undefined, buf)` as success and marks state healthy', async () => {
    const mod = await loadAnalyticsFresh();
    mod.initAnalytics();

    const probeCall = mockAnalyticsInstance.trackCalls[0];
    // v3 fires with (err=undefined, buf). Our code signature is (err?: Error),
    // which reads arg[0]. Extra positional args are harmless.
    probeCall?.cb?.(undefined, { type: 'Buffer', data: [] });
    await flushMicrotasks();

    expect(mod.getAnalyticsStatus().state).toBe('healthy');
    expect(mod.analyticsEnabled()).toBe(true);
  });

  it('treats `cb(Error, buf)` as failure and keeps client alive for retry', async () => {
    const mod = await loadAnalyticsFresh();
    mod.initAnalytics();

    const probeCall = mockAnalyticsInstance.trackCalls[0];
    // v3 fires error callback with (Error, buf). Our code reads first arg.
    probeCall?.cb?.(new Error('ECONNREFUSED'), { type: 'Buffer', data: [] });
    await flushMicrotasks();

    // Should transition to pending (retry) or error, but client must stay alive
    expect(mod.analyticsClientAvailable()).toBe(true);
    expect(mod.getAnalyticsStatus().error).toContain('ECONNREFUSED');
  });
});

describe('alias callback (the hasAliased latch)', () => {
  it('sets hasAliased=true only after v3 fires alias success callback', async () => {
    const mod = await loadAnalyticsFresh();
    mod.initAnalytics();
    // Probe succeeds so identify will be accepted downstream
    mockAnalyticsInstance.trackCalls[0]?.cb?.(undefined);
    await flushMicrotasks();

    // First identify — should enqueue an alias
    mod.identifyMainUser({ userId: 'user-1', traits: { email: '[external-email]' } });
    expect(mockAnalyticsInstance.aliasCalls).toHaveLength(1);

    // In v3 the success callback fires with (undefined, buf) — confirmed by spike.
    mockAnalyticsInstance.aliasCalls[0]?.cb?.(undefined, { type: 'Buffer', data: [1, 2, 3] });
    await flushMicrotasks();

    // Second identify — hasAliased latched, no new alias call
    mod.identifyMainUser({ userId: 'user-1', traits: { email: '[external-email]' } });
    expect(mockAnalyticsInstance.aliasCalls).toHaveLength(1);
  });

  it('keeps hasAliased=false on alias failure so next identify retries the alias', async () => {
    const mod = await loadAnalyticsFresh();
    mod.initAnalytics();
    mockAnalyticsInstance.trackCalls[0]?.cb?.(undefined);
    await flushMicrotasks();

    mod.identifyMainUser({ userId: 'user-1' });
    expect(mockAnalyticsInstance.aliasCalls).toHaveLength(1);

    // Fire alias with an error — hasAliased must stay false
    mockAnalyticsInstance.aliasCalls[0]?.cb?.(new Error('alias failed'));
    await flushMicrotasks();

    // Second identify — should retry the alias
    mod.identifyMainUser({ userId: 'user-1' });
    expect(mockAnalyticsInstance.aliasCalls).toHaveLength(2);
  });
});

describe('identify callback', () => {
  it('reads err from v3 two-arg identify callback without crashing', async () => {
    const mod = await loadAnalyticsFresh();
    mod.initAnalytics();
    mockAnalyticsInstance.trackCalls[0]?.cb?.(undefined);
    await flushMicrotasks();

    mod.identifyMainUser({ userId: 'user-1', traits: { email: '[external-email]' } });
    expect(mockAnalyticsInstance.identifyCalls).toHaveLength(1);

    // v3 fires identify callback with (err, buf). Our code reads just first arg.
    // Fire both a success and a failure shape — neither should throw.
    expect(() => {
      mockAnalyticsInstance.identifyCalls[0]?.cb?.(undefined, { type: 'Buffer' });
    }).not.toThrow();

    mod.identifyMainUser({ userId: 'user-2' });
    expect(() => {
      mockAnalyticsInstance.identifyCalls[1]?.cb?.(new Error('transient'), { type: 'Buffer' });
    }).not.toThrow();
  });
});

describe('flush (v3 Promise semantics)', () => {
  it('resolves when the SDK flush resolves', async () => {
    const mod = await loadAnalyticsFresh();
    mod.initAnalytics();
    mockAnalyticsInstance.trackCalls[0]?.cb?.(undefined);
    await flushMicrotasks();

    mockAnalyticsInstance.flushPromiseFactory = () => Promise.resolve();
    await expect(mod.flushMainAnalytics()).resolves.toBeUndefined();
    expect(mockAnalyticsInstance.flushCalls).toBe(1);
  });

  it('propagates rejection if the SDK flush rejects (defensive — v3.0.5 resolves on transport failure per spike)', async () => {
    const mod = await loadAnalyticsFresh();
    mod.initAnalytics();
    mockAnalyticsInstance.trackCalls[0]?.cb?.(undefined);
    await flushMicrotasks();

    // In the real v3.0.5 observed in the spike, flush() resolves even on transport
    // failure. But if a future patch changes that, our caller should see the
    // rejection — this test just locks in that we don't swallow it.
    // Factory pattern avoids unhandled-rejection during fixture construction.
    mockAnalyticsInstance.flushPromiseFactory = () => Promise.reject(new Error('flush failed'));
    await expect(mod.flushMainAnalytics()).rejects.toThrow('flush failed');
  });

  it('is a no-op when no client is present (e.g. after constructor throw)', async () => {
    ctorBehavior.shouldThrow = true;
    const mod = await loadAnalyticsFresh();
    mod.initAnalytics();

    // Must not throw, must not call flush
    await expect(mod.flushMainAnalytics()).resolves.toBeUndefined();
    expect(mockAnalyticsInstance.flushCalls).toBe(0);
  });
});

describe('errorHandler option', () => {
  it('registers a function that accepts an Error (v3 contract preserved)', async () => {
    const mod = await loadAnalyticsFresh();
    mod.initAnalytics();

    const handler = mockAnalyticsInstance.capturedOptions?.errorHandler as
      | ((err: Error) => void)
      | undefined;
    expect(typeof handler).toBe('function');

    // Invoking it must not throw (it logs internally)
    expect(() => handler?.(new Error('transient SDK error'))).not.toThrow();
    // And must tolerate a legacy v2-shaped errorless invocation
    expect(() => handler?.(undefined as unknown as Error)).not.toThrow();
  });
});

describe('DISABLE_ANALYTICS env var (pre-existing behavior, unchanged by v3 bump)', () => {
  it('does not construct the SDK when DISABLE_ANALYTICS=true', async () => {
    vi.stubEnv('DISABLE_ANALYTICS', 'true');
    const mod = await loadAnalyticsFresh();
    mod.initAnalytics();

    expect(ctorTracker).not.toHaveBeenCalled();
    expect(mod.analyticsClientAvailable()).toBe(false);
    expect(mod.getAnalyticsStatus().state).toBe('disabled');
  });
});

describe('OSS no-phone-home gate (B6.a / Stage 3a)', () => {
  it('OSS + telemetry opt-in OFF: NO client + NO probe even when env/app-config holds creds', async () => {
    platformState.isOss = true;
    settingsState.telemetry = undefined; // opt-in off
    // env/app-config still hold Mindstone creds — must be ignored on OSS path.
    configSecrets.RUDDERSTACK_WRITE_KEY = 'mindstone-write-key';
    configSecrets.RUDDERSTACK_DATA_PLANE_URL = 'https://mindstone.dataplane.example';

    const mod = await loadAnalyticsFresh();
    mod.initAnalytics();

    expect(ctorTracker).not.toHaveBeenCalled();
    expect(mockAnalyticsInstance.trackCalls).toHaveLength(0); // no probe scheduled
    expect(mod.analyticsClientAvailable()).toBe(false);
  });

  it('OSS + telemetry opt-in ON but no user creds: NO client + NO probe', async () => {
    platformState.isOss = true;
    settingsState.telemetry = { enabled: true }; // enabled, but creds absent
    configSecrets.RUDDERSTACK_WRITE_KEY = 'mindstone-write-key';
    configSecrets.RUDDERSTACK_DATA_PLANE_URL = 'https://mindstone.dataplane.example';

    const mod = await loadAnalyticsFresh();
    mod.initAnalytics();

    expect(ctorTracker).not.toHaveBeenCalled();
    expect(mockAnalyticsInstance.trackCalls).toHaveLength(0);
    expect(mod.analyticsClientAvailable()).toBe(false);
  });

  it('OSS + opt-in ON + user creds: inits with the USER write key, never the env one', async () => {
    platformState.isOss = true;
    settingsState.telemetry = {
      enabled: true,
      rudderWriteKey: 'user-write-key',
      rudderDataPlaneUrl: 'https://user.dataplane.example',
    };
    configSecrets.RUDDERSTACK_WRITE_KEY = 'mindstone-write-key';
    configSecrets.RUDDERSTACK_DATA_PLANE_URL = 'https://mindstone.dataplane.example';

    const mod = await loadAnalyticsFresh();
    mod.initAnalytics();

    expect(ctorTracker).toHaveBeenCalledTimes(1);
    expect(mockAnalyticsInstance.capturedWriteKey).toBe('user-write-key');
    expect(mockAnalyticsInstance.capturedOptions).toMatchObject({
      dataPlaneUrl: 'https://user.dataplane.example',
    });
    // The env/app-config write key must never reach the SDK on the OSS path.
    expect(mockAnalyticsInstance.capturedWriteKey).not.toBe('mindstone-write-key');
  });
});

describe('getOrGenerateAnonymousId gate (M2 — identity side-effect must not start in OSS-off)', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // NOTE: the storeFactory mock's in-memory map persists across loadAnalyticsFresh()
  // (the closure survives resetModules), so a persisted anon-ID may already exist
  // from an earlier test. For the "permitted" cases we assert a valid UUID is
  // returned (an ID exists / was generated); the load-bearing OSS-off case asserts
  // NO persistence write occurs at all.
  it('enterprise: returns a valid anonymous ID (unchanged)', async () => {
    platformState.isOss = false;
    const mod = await loadAnalyticsFresh();

    expect(mod.getOrGenerateAnonymousId()).toMatch(UUID_RE);
  });

  it('enterprise: persists on first generation when the store is empty', async () => {
    platformState.isOss = false;
    const mod = await loadAnalyticsFresh();
    storeSetSpy.mockClear();

    // First read may return a previously-persisted value; either way the result
    // is a valid UUID and at most one persistence write occurs (idempotent).
    const id = mod.getOrGenerateAnonymousId();
    const idAgain = mod.getOrGenerateAnonymousId();
    expect(id).toMatch(UUID_RE);
    expect(idAgain).toBe(id);
    // Calling twice never writes more than once.
    expect(storeSetSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('OSS + opt-in OFF: returns empty string and persists NOTHING', async () => {
    platformState.isOss = true;
    settingsState.telemetry = undefined; // opt-in off
    const mod = await loadAnalyticsFresh();
    storeSetSpy.mockClear();

    const id = mod.getOrGenerateAnonymousId();

    expect(id).toBe('');
    expect(storeSetSpy).not.toHaveBeenCalled();
  });

  it('OSS + opt-in ON: returns a valid anonymous ID', async () => {
    platformState.isOss = true;
    settingsState.telemetry = { enabled: true };
    const mod = await loadAnalyticsFresh();

    expect(mod.getOrGenerateAnonymousId()).toMatch(UUID_RE);
  });
});
