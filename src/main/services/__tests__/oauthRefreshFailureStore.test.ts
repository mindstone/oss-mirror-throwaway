import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

 

type StorePayload = Record<string, unknown>;

const storeStateByName: Record<string, StorePayload> = {};

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function ensureStore(name: string, defaults?: StorePayload): StorePayload {
  if (!storeStateByName[name]) {
    storeStateByName[name] = defaults ? deepClone(defaults) : {};
  }
  return storeStateByName[name];
}

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Factory shared by the hoisted vi.mock AND the beforeEach re-doMock: tests
// that `vi.doUnmock('@core/storeFactory')` (read-error / failing-write cases)
// cancel the top-level mock for every later dynamic import, so each test
// re-establishes the in-memory mock before importing the module under test.
function createInMemoryStoreFactoryModule() {
  return {
    createStore: vi.fn((opts: { name: string; defaults: StorePayload }) => {
      const name = opts.name;
      ensureStore(name, opts.defaults);

      return {
        get: (key: string) => ensureStore(name)[key],
        set: (key: string, value: unknown) => { ensureStore(name)[key] = value; },
        has: (key: string) => Object.prototype.hasOwnProperty.call(ensureStore(name), key),
        delete: (key: string) => { delete ensureStore(name)[key]; },
        clear: () => { storeStateByName[name] = {}; },
        get store() {
          return ensureStore(name);
        },
        set store(value: StorePayload) {
          storeStateByName[name] = value;
        },
        path: `/tmp/${name}.json`,
      };
    }),
  };
}

vi.mock('@core/storeFactory', () => createInMemoryStoreFactoryModule());

type StoreModule = typeof import('../oauthRefreshFailureStore');
let store: StoreModule;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-01T09:00:00.000Z'));
  vi.restoreAllMocks();
  for (const key of Object.keys(storeStateByName)) {
    delete storeStateByName[key];
  }
  vi.resetModules();
  vi.doMock('@core/storeFactory', () => createInMemoryStoreFactoryModule());
  store = await import('../oauthRefreshFailureStore');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('oauthRefreshFailureStore', () => {
  it('applies 5m → 15m → 1h → 6h → 24h backoff when jitter is neutral', () => {
    const slug = 'GoogleWorkspace-test-backoff';
    const now = Date.now();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // neutral jitter factor (1.0x)

    const expectedBackoffs = [
      5 * 60 * 1000,
      15 * 60 * 1000,
      60 * 60 * 1000,
      6 * 60 * 60 * 1000,
      24 * 60 * 60 * 1000,
    ];

    expectedBackoffs.forEach((expectedBackoff, index) => {
      const timestamp = now + index * 1000;
      const state = store.recordFailure(slug, 'unknown', timestamp, { provider: 'google' });
      expect(state.nextRetryAt - timestamp).toBe(expectedBackoff);
    });
  });

  it('keeps jitter within ±20% bounds', () => {
    const lowerSlug = 'GoogleWorkspace-jitter-lower';
    const upperSlug = 'GoogleWorkspace-jitter-upper';
    const now = Date.now();
    const baseBackoff = 5 * 60 * 1000;

    vi.spyOn(Math, 'random').mockReturnValue(0); // 0.8x
    const lower = store.recordFailure(lowerSlug, 'unknown', now, { provider: 'google' });
    expect(lower.nextRetryAt - now).toBe(Math.round(baseBackoff * 0.8));

    vi.spyOn(Math, 'random').mockReturnValue(1); // 1.2x
    const upper = store.recordFailure(upperSlug, 'unknown', now, { provider: 'google' });
    expect(upper.nextRetryAt - now).toBe(Math.round(baseBackoff * 1.2));
  });

  it('flips needsReconnect after 3 consecutive invalid_grant failures', () => {
    const slug = 'GoogleWorkspace-test-reauth';
    const now = Date.now();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    expect(store.recordFailure(slug, 'invalid_grant', now, { provider: 'google' }).needsReconnect).toBe(false);
    expect(store.recordFailure(slug, 'invalid_grant', now + 1000, { provider: 'google' }).needsReconnect).toBe(false);
    expect(store.recordFailure(slug, 'invalid_grant', now + 2000, { provider: 'google' }).needsReconnect).toBe(true);

    const shortCircuit = store.shouldShortCircuit(slug, now + 2500);
    expect(shortCircuit).toEqual({ skip: true, reason: 'reauth_required' });
  });

  it('clears tracked state on success and explicit clear', () => {
    const slug = 'GoogleWorkspace-test-clear';
    const now = Date.now();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    store.recordFailure(slug, 'invalid_grant', now, { provider: 'google' });
    expect(store.getStateForSlug(slug)).not.toBeNull();

    store.recordSuccess(slug, { provider: 'google' });
    expect(store.getStateForSlug(slug)).toBeNull();

    store.recordFailure(slug, 'unknown', now + 1000, { provider: 'google' });
    expect(store.getStateForSlug(slug)).not.toBeNull();
    store.clearForSlug(slug);
    expect(store.getStateForSlug(slug)).toBeNull();
  });

  it('throttles Sentry reporting to one event per backoff window', () => {
    const slug = 'GoogleWorkspace-test-throttle';
    const now = Date.now();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    store.recordFailure(slug, 'invalid_grant', now, { provider: 'google' });
    const state = store.getStateForSlug(slug);
    expect(state).not.toBeNull();
    if (!state) {
      throw new Error('Expected failure state to exist');
    }

    expect(store.shouldReportToSentry(slug, now)).toBe(true);
    expect(store.shouldReportToSentry(slug, now + 60_000)).toBe(false);

    const backoffWindow = state.nextRetryAt - state.lastFailureAt;
    expect(store.shouldReportToSentry(slug, now + backoffWindow + 1)).toBe(true);
  });

  it('short-circuits transient failures until the current retry window expires', () => {
    const slug = 'GoogleWorkspace-test-transient';
    const now = Date.now();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    store.recordFailure(slug, 'unknown', now, { provider: 'google' });
    const state = store.getStateForSlug(slug);
    expect(state).not.toBeNull();
    if (!state) {
      throw new Error('Expected failure state to exist');
    }

    expect(store.shouldShortCircuit(slug, now + 1)).toEqual({ skip: true, reason: 'transient' });
    expect(store.shouldShortCircuit(slug, state.nextRetryAt + 1)).toEqual({ skip: false });
  });
});

describe('listNeedsReconnectProviders', () => {
  function flipToNeedsReconnect(slug: string, provider: 'google' | 'microsoft', now: number) {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    store.recordFailure(slug, 'invalid_grant', now, { provider });
    store.recordFailure(slug, 'invalid_grant', now + 1_000, { provider });
    const flipped = store.recordFailure(slug, 'invalid_grant', now + 2_000, { provider });
    if (!flipped.needsReconnect) {
      throw new Error(`Failed to flip ${slug} to needsReconnect for test setup`);
    }
  }

  it('returns an empty providers list when the store is empty', () => {
    const result = store.listNeedsReconnectProviders();
    expect(result).toEqual({ ok: true, providers: [] });
  });

  it('returns a single GoogleWorkspace provider when one account is in needsReconnect', () => {
    flipToNeedsReconnect('GoogleWorkspace-teammember-mindstone-com', 'google', Date.now());

    const result = store.listNeedsReconnectProviders();
    expect(result).toEqual({
      ok: true,
      providers: [{ providerBaseName: 'GoogleWorkspace' }],
    });
  });

  it('omits accounts that have not crossed the needsReconnect threshold', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    store.recordFailure('GoogleWorkspace-foo', 'invalid_grant', Date.now(), { provider: 'google' });

    const result = store.listNeedsReconnectProviders();
    expect(result).toEqual({ ok: true, providers: [] });
  });

  it('deduplicates multiple accounts belonging to the same base provider', () => {
    const now = Date.now();
    flipToNeedsReconnect('GoogleWorkspace-teammember-mindstone-com', 'google', now);
    flipToNeedsReconnect('GoogleWorkspace-jess-mindstone-com', 'google', now + 10_000);
    flipToNeedsReconnect('GoogleWorkspace-team-acme-com', 'google', now + 20_000);

    const result = store.listNeedsReconnectProviders();
    expect(result).toEqual({
      ok: true,
      providers: [{ providerBaseName: 'GoogleWorkspace' }],
    });
  });

  it('returns multiple providers sorted alphabetically by base name', () => {
    const now = Date.now();
    flipToNeedsReconnect('Microsoft365Mail-finance-acme-com', 'google' /* provider arg unused for slug routing */, now);
    flipToNeedsReconnect('GoogleWorkspace-teammember-mindstone-com', 'google', now + 10_000);

    const result = store.listNeedsReconnectProviders();
    expect(result).toEqual({
      ok: true,
      providers: [
        { providerBaseName: 'GoogleWorkspace' },
        { providerBaseName: 'Microsoft365Mail' },
      ],
    });
  });

  it('maps slugs outside the allowlist to "unknown" instead of leaking the prefix', () => {
    const now = Date.now();
    flipToNeedsReconnect('SomeUnknownConnector-user-example-com', 'google', now);

    const result = store.listNeedsReconnectProviders();
    expect(result).toEqual({
      ok: true,
      providers: [{ providerBaseName: 'unknown' }],
    });
  });

  it('never leaks email-like substrings from slugs in the serialized result', () => {
    const now = Date.now();
    flipToNeedsReconnect('GoogleWorkspace-teammember-mindstone-com', 'google', now);
    flipToNeedsReconnect('Microsoft365Mail-jess-acme-com', 'google', now + 10_000);
    flipToNeedsReconnect('UnknownConnector-leak-mindstone-com', 'google', now + 20_000);

    const result = store.listNeedsReconnectProviders();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/@/);
    expect(serialized).not.toMatch(/mindstone-com/);
    expect(serialized).not.toMatch(/acme-com/);
    expect(serialized).not.toMatch(/harry|jess|leak/);
  });

  it('coerces malformed raw store shapes to unknown without leaking key text (privacy chokepoint)', () => {
    // Seed the raw underlying store directly with hostile slug shapes — bypasses
    // the recordFailure path so we exercise the migration/normalisation chokepoint.
    const malformedEntry = {
      consecutiveFailures: 3,
      lastErrorCode: 'invalid_grant',
      lastFailureAt: 1000,
      nextRetryAt: 2000,
      needsReconnect: true,
      lastSentryReportAt: 0,
      invalidGrantStreak: 3,
    };
    storeStateByName['oauth-refresh-failures'] = {
      version: 1,
      failuresBySlug: {
        'user@example.com': malformedEntry,
        'GoogleWorkspace-someone@example.com': malformedEntry,
        '-leadingHyphen-foo': malformedEntry,
      },
    };

    const result = store.listNeedsReconnectProviders();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/@/);
    expect(serialized).not.toMatch(/example\.com/);
    expect(serialized).not.toMatch(/someone/);
    expect(serialized).not.toMatch(/leadingHyphen/);
    if (result.ok) {
      for (const p of result.providers) {
        expect(['GoogleWorkspace', 'Microsoft365Calendar', 'Microsoft365Mail', 'unknown']).toContain(p.providerBaseName);
      }
    }
  });

  it('returns ok:false with read-error when the underlying store throws on read', async () => {
    vi.resetModules();
    const throwingMock = vi.fn(() => ({
      get store(): never { throw new Error('boom'); },
      set store(_v: unknown) { /* no-op */ },
      get: () => undefined,
      set: () => undefined,
      has: () => false,
      delete: () => undefined,
      clear: () => undefined,
      path: '/tmp/throwing.json',
    }));
    vi.doMock('@core/storeFactory', () => ({ createStore: throwingMock }));

    const throwingModule = await import('../oauthRefreshFailureStore');
    const result = throwingModule.listNeedsReconnectProviders();
    expect(result).toEqual({ ok: false, reason: 'read-error' });

    vi.doUnmock('@core/storeFactory');
  });
});

// ---------------------------------------------------------------------------
// Stage 2 (260611_calendar-cache-attention): latch lifecycle store surface.
// ---------------------------------------------------------------------------

/** Load the store module against a backing store that reads fine but throws on write. */
async function importStoreWithFailingWrites(initialState: StorePayload): Promise<StoreModule> {
  vi.resetModules();
  let state = deepClone(initialState);
  vi.doMock('@core/storeFactory', () => ({
    createStore: vi.fn(() => ({
      get store() { return state; },
      set store(_v: StorePayload) { throw new Error('disk full'); },
      get: (key: string) => state[key],
      set: () => { throw new Error('disk full'); },
      has: (key: string) => Object.prototype.hasOwnProperty.call(state, key),
      delete: (key: string) => { delete state[key]; },
      clear: () => { state = {}; },
      path: '/tmp/failing-writes.json',
    })),
  }));
  const module = await import('../oauthRefreshFailureStore');
  vi.doUnmock('@core/storeFactory');
  return module;
}

function seedFailure(slug: string, now = Date.now()): void {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  store.recordFailure(slug, 'invalid_grant', now, { provider: 'google' });
}

describe('clearForSlug result contract [RS-F8]', () => {
  it('returns true when an entry was cleared', () => {
    const slug = 'GoogleWorkspace-clear-result';
    seedFailure(slug);
    expect(store.getStateForSlug(slug)).not.toBeNull();

    expect(store.clearForSlug(slug)).toBe(true);
    expect(store.getStateForSlug(slug)).toBeNull();
  });

  it('returns true when nothing was tracked for the slug (idempotent no-op)', () => {
    expect(store.clearForSlug('GoogleWorkspace-never-tracked')).toBe(true);
    expect(store.clearForSlug('')).toBe(true);
  });

  it('returns false when the store read fails (must not vacuously claim cleared) [Stage 4]', async () => {
    vi.resetModules();
    vi.doMock('@core/storeFactory', () => ({
      createStore: vi.fn(() => ({
        get store(): never { throw new Error('boom'); },
        set store(_v: unknown) { /* no-op */ },
        get: () => undefined,
        set: () => undefined,
        has: () => false,
        delete: () => undefined,
        clear: () => undefined,
        path: '/tmp/throwing.json',
      })),
    }));

    const throwingModule = await import('../oauthRefreshFailureStore');
    // A failed read means the entry's existence is UNKNOWN — reporting
    // "cleared" would let a disconnect look successful while the latch
    // silently survives on disk.
    expect(throwingModule.clearForSlug('GoogleWorkspace-unknowable')).toBe(false);

    vi.doUnmock('@core/storeFactory');
  });

  it('returns false when the underlying store write is swallowed', async () => {
    const slug = 'GoogleWorkspace-write-fails';
    const failingModule = await importStoreWithFailingWrites({
      version: 1,
      failuresBySlug: {
        [slug]: {
          consecutiveFailures: 3,
          lastErrorCode: 'invalid_grant',
          lastFailureAt: 1000,
          nextRetryAt: 2000,
          needsReconnect: true,
          lastSentryReportAt: 0,
          invalidGrantStreak: 3,
        },
      },
    });

    expect(failingModule.clearForSlug(slug)).toBe(false);
    // Latch survives the failed write — caller must be able to see that.
    expect(failingModule.getStateForSlug(slug)?.needsReconnect).toBe(true);
  });
});

describe('removeOrphanedSlugs [RS-F2]', () => {
  const PREFIX = 'GoogleWorkspace-';

  it('removes prefix-matched slugs missing from the keep-set and returns the count', () => {
    const now = Date.now();
    seedFailure('GoogleWorkspace-gone-account', now);
    seedFailure('GoogleWorkspace-kept-account', now + 1000);

    const removed = store.removeOrphanedSlugs(PREFIX, ['GoogleWorkspace-kept-account']);

    expect(removed).toBe(1);
    expect(store.getStateForSlug('GoogleWorkspace-gone-account')).toBeNull();
    expect(store.getStateForSlug('GoogleWorkspace-kept-account')).not.toBeNull();
  });

  it('never touches entries outside the prefix (prefix guard lives in the store)', () => {
    const now = Date.now();
    seedFailure('Microsoft365Mail-other-provider', now);
    seedFailure('GoogleWorkspace', now + 1000); // legacy non-instance slug: not prefix-matched
    seedFailure('GoogleWorkspace-orphan', now + 2000);

    const removed = store.removeOrphanedSlugs(PREFIX, []);

    expect(removed).toBe(1);
    expect(store.getStateForSlug('Microsoft365Mail-other-provider')).not.toBeNull();
    expect(store.getStateForSlug('GoogleWorkspace')).not.toBeNull();
    expect(store.getStateForSlug('GoogleWorkspace-orphan')).toBeNull();
  });

  it('is idempotent — a second sweep removes nothing', () => {
    seedFailure('GoogleWorkspace-orphan-twice');

    expect(store.removeOrphanedSlugs(PREFIX, [])).toBe(1);
    expect(store.removeOrphanedSlugs(PREFIX, [])).toBe(0);
  });

  it('returns 0 on an empty store and on an empty prefix', () => {
    expect(store.removeOrphanedSlugs(PREFIX, [])).toBe(0);
    seedFailure('GoogleWorkspace-anything');
    expect(store.removeOrphanedSlugs('', [])).toBe(0);
    expect(store.getStateForSlug('GoogleWorkspace-anything')).not.toBeNull();
  });

  it('reports 0 when the removal write is swallowed (entries survive)', async () => {
    const failingModule = await importStoreWithFailingWrites({
      version: 1,
      failuresBySlug: {
        'GoogleWorkspace-orphan': {
          consecutiveFailures: 1,
          lastErrorCode: 'invalid_grant',
          lastFailureAt: 1000,
          nextRetryAt: 2000,
          needsReconnect: false,
          lastSentryReportAt: 0,
          invalidGrantStreak: 1,
        },
      },
    });

    expect(failingModule.removeOrphanedSlugs(PREFIX, [])).toBe(0);
    expect(failingModule.getStateForSlug('GoogleWorkspace-orphan')).not.toBeNull();
  });
});

describe('listNeedsReconnectSlugsForMainProcess [RS-F4/GPT-F6]', () => {
  it('returns only slugs latched to needsReconnect', () => {
    const now = Date.now();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    // One latched slug (3x invalid_grant) + one transient (single failure).
    store.recordFailure('GoogleWorkspace-latched', 'invalid_grant', now, { provider: 'google' });
    store.recordFailure('GoogleWorkspace-latched', 'invalid_grant', now + 1000, { provider: 'google' });
    store.recordFailure('GoogleWorkspace-latched', 'invalid_grant', now + 2000, { provider: 'google' });
    store.recordFailure('GoogleWorkspace-transient', 'unknown', now, { provider: 'google' });

    const result = store.listNeedsReconnectSlugsForMainProcess();
    expect(result).toEqual({ ok: true, slugs: ['GoogleWorkspace-latched'] });
  });

  it('returns an empty ok result when nothing is latched', () => {
    expect(store.listNeedsReconnectSlugsForMainProcess()).toEqual({ ok: true, slugs: [] });
  });

  it('returns ok:false read-error when the store read throws (mirrors listNeedsReconnectProviders)', async () => {
    vi.resetModules();
    vi.doMock('@core/storeFactory', () => ({
      createStore: vi.fn(() => ({
        get store(): never { throw new Error('boom'); },
        set store(_v: unknown) { /* no-op */ },
        get: () => undefined,
        set: () => undefined,
        has: () => false,
        delete: () => undefined,
        clear: () => undefined,
        path: '/tmp/throwing.json',
      })),
    }));

    const throwingModule = await import('../oauthRefreshFailureStore');
    expect(throwingModule.listNeedsReconnectSlugsForMainProcess()).toEqual({ ok: false, reason: 'read-error' });

    vi.doUnmock('@core/storeFactory');
  });
});
