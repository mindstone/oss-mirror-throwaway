import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('ErrorReporter', () => {
  let setErrorReporter: typeof import('@core/errorReporter').setErrorReporter;
  let getErrorReporter: typeof import('@core/errorReporter').getErrorReporter;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@core/errorReporter');
    setErrorReporter = mod.setErrorReporter;
    getErrorReporter = mod.getErrorReporter;
  });

  it('returns silent no-op reporter by default', () => {
    const reporter = getErrorReporter();
    expect(() => reporter.captureException(new Error('test'))).not.toThrow();
    // `level` is required on raw message captures (Stage 6 of
    // docs/plans/260610_improve-sentry-noise/PLAN.md).
    expect(() => reporter.captureMessage('test', { level: 'warning' })).not.toThrow();
    expect(() => reporter.addBreadcrumb({ category: 'test', message: 'msg' })).not.toThrow();
  });

  it('uses the set reporter', () => {
    const mock = {
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
    };
    setErrorReporter(mock);

    const err = new Error('boom');
    getErrorReporter().captureException(err, { tags: { x: 1 } });
    expect(mock.captureException).toHaveBeenCalledWith(err, { tags: { x: 1 } });
  });
});

describe('StoreFactory', () => {
  let setStoreFactory: typeof import('@core/storeFactory').setStoreFactory;
  let createStore: typeof import('@core/storeFactory').createStore;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@core/storeFactory');
    setStoreFactory = mod.setStoreFactory;
    createStore = mod.createStore;
  });

  it('throws before initialization', () => {
    expect(() => createStore({ name: 'test' })).toThrow('StoreFactory not initialized');
  });

  it('creates a store after setStoreFactory', () => {
    const mockStore = {
      get: vi.fn(),
      set: vi.fn(),
      has: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
      store: {},
      path: '/mock/test.json',
    };
    setStoreFactory(() => mockStore as any);

    const store = createStore({ name: 'test', defaults: { x: 1 } });
    // Store is wrapped in a write-gating Proxy, so identity check won't match.
    // Verify it delegates reads to the underlying store instead.
    store.get('x');
    expect(mockStore.get).toHaveBeenCalledWith('x');
  });
});

describe('Tracker', () => {
  let setTracker: typeof import('@core/tracking').setTracker;
  let getTracker: typeof import('@core/tracking').getTracker;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@core/tracking');
    setTracker = mod.setTracker;
    getTracker = mod.getTracker;
  });

  it('returns no-op tracker by default', () => {
    expect(() => getTracker().track('event')).not.toThrow();
    expect(() => getTracker().identify('user')).not.toThrow();
    expect(getTracker().getAnonymousId()).toBe('');
    expect(getTracker().isAvailable()).toBe(false);
  });

  it('uses the set tracker', () => {
    const mock = { track: vi.fn(), identify: vi.fn(), getAnonymousId: () => 'test-id', isAvailable: () => true };
    setTracker(mock);

    getTracker().track('purchase', { amount: 42 });
    expect(mock.track).toHaveBeenCalledWith('purchase', { amount: 42 });
    expect(getTracker().getAnonymousId()).toBe('test-id');
    expect(getTracker().isAvailable()).toBe(true);
  });
});

describe('BroadcastService', () => {
  let setBroadcastService: typeof import('@core/broadcastService').setBroadcastService;
  let getBroadcastService: typeof import('@core/broadcastService').getBroadcastService;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@core/broadcastService');
    setBroadcastService = mod.setBroadcastService;
    getBroadcastService = mod.getBroadcastService;
  });

  it('throws before initialization', () => {
    expect(() => getBroadcastService()).toThrow('BroadcastService not initialized');
  });

  it('delegates to the set service', () => {
    const mock = {
      sendToAllWindows: vi.fn(),
      sendToFocusedWindow: vi.fn(),
    };
    setBroadcastService(mock);

    getBroadcastService().sendToAllWindows('channel', 'data');
    expect(mock.sendToAllWindows).toHaveBeenCalledWith('channel', 'data');
  });
});
