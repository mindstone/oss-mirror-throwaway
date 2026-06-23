/**
 * Unit tests for the Stage 1 `isKnownPlugin` hot-path counter AND the Stage 4
 * `CoalescedCache`-based plugin identity cache.
 *
 * Covers (Stage 1):
 *  - built-in `__`-prefixed IDs short-circuit BEFORE the counter increment
 *    (so they do not pollute hit-rate numbers — reviewer-requested)
 *  - `requests` increments exactly once per non-built-in call
 *  - persisted-plugin match → `hits` increments, no underlying fetch
 *  - post-complete cache hit → `hits` increments, no underlying fetch
 *  - cache miss → `misses` + `underlyingFetches` increment, scan is called
 *  - underlying scan rejection → `fetchErrors` increments
 *  - `_resetForTesting()` zeros all fields
 *
 * Covers (Stage 4):
 *  - built-ins bypass the cache entirely (snapshot untouched)
 *  - persisted-plugin match short-circuits before the cache
 *  - cold-cache concurrent callers coalesce to ONE underlying fetch
 *  - install/uninstall invalidation flips cache membership
 *  - error rejections are NOT cached (next call retries)
 *  - workspace switch via `clearPluginIdentityCache()` produces a cold cache
 *  - kill switch `REBEL_DISABLE_PLUGIN_COALESCE=1` falls back to legacy
 *    post-complete caching (no in-flight dedup)
 *
 * See docs/plans/260420_perf_observability_and_low_risk_wins.md § Stage 1 & 4.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

async function waitForCallCount(mock: ReturnType<typeof vi.fn>, count: number, maxIters = 100): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    if (mock.mock.calls.length >= count) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

const mockLoadPersistedPluginEntries = vi.fn();
vi.mock('../../../services/pluginFilePersistence', () => ({
  loadPersistedPluginEntries: () => mockLoadPersistedPluginEntries(),
}));

const mockScanSpacePlugins = vi.fn();
vi.mock('../../../services/pluginSpaceService', () => ({
  scanSpacePlugins: (...args: unknown[]) => mockScanSpacePlugins(...args),
}));

// shared.ts now reads scanSpacePlugins through pluginIdentityRegistry. The
// real pluginSpaceService self-registers at module load, but since the line
// above replaces that module with a stub (no side effects), we must register
// the mock onto the registry ourselves before any test runs `isKnownPlugin`.
const { registerScanSpacePlugins } = await import('../pluginIdentityRegistry');
registerScanSpacePlugins((...args: unknown[]) => mockScanSpacePlugins(...args) as any);

// Dynamic coreDirectory — tests can mutate this to simulate workspace switches.
let mockCoreDirectory: string = '/mock/core';
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => ({ coreDirectory: mockCoreDirectory }),
}));

vi.mock('electron-store', () => ({
  default: class {
    store: Record<string, unknown> = {};
    get = vi.fn((key: string) => this.store[key]);
    set = vi.fn();
  },
}));

const {
  isKnownPlugin,
  getIsKnownPluginCounters,
  _resetIsKnownPluginCountersForTesting,
  _clearSpaceScanCacheForTesting,
  _resetPluginIdentityCacheForTesting,
  _resetScanSpacePluginsResolverForTesting,
  invalidatePluginIdentityCache,
  clearPluginIdentityCache,
} = await import('../shared');

/** Deferred promise helper (for concurrent in-flight tests). */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(count = 5): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

describe('isKnownPlugin counter', () => {
  beforeEach(() => {
    mockLoadPersistedPluginEntries.mockReset();
    mockScanSpacePlugins.mockReset();
    _resetIsKnownPluginCountersForTesting();
    _clearSpaceScanCacheForTesting();
    _resetScanSpacePluginsResolverForTesting();
    mockCoreDirectory = '/mock/core';
    delete process.env.REBEL_DISABLE_PLUGIN_COALESCE;
  });

  it('_resetForTesting zeros all counter fields', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([]);
    mockScanSpacePlugins.mockResolvedValue({ plugins: [], conflicts: [] });

    await isKnownPlugin('some-plugin');
    expect(getIsKnownPluginCounters().requests).toBe(1);

    _resetIsKnownPluginCountersForTesting();
    expect(getIsKnownPluginCounters()).toEqual({
      requests: 0,
      hits: 0,
      misses: 0,
      inflightJoins: 0,
      underlyingFetches: 0,
      fetchErrors: 0,
      maxConcurrentInflight: 0,
    });
  });

  it('built-in __-prefixed IDs short-circuit BEFORE the counter increment', async () => {
    const result = await isKnownPlugin('__rebel-canvas');
    expect(result).toBe(true);

    const snap = getIsKnownPluginCounters();
    // Built-ins skip the counter entirely — no pollution of hit-rate numbers.
    expect(snap.requests).toBe(0);
    expect(snap.hits).toBe(0);
    expect(snap.misses).toBe(0);
    expect(snap.underlyingFetches).toBe(0);
    // And loadPersistedPluginEntries was never called.
    expect(mockLoadPersistedPluginEntries).not.toHaveBeenCalled();
    expect(mockScanSpacePlugins).not.toHaveBeenCalled();
  });

  it('persisted-plugin match → counts as hit, no underlying fetch', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([
      { manifest: { id: 'meeting-prep' }, source: '' },
    ]);

    const result = await isKnownPlugin('meeting-prep');
    expect(result).toBe(true);

    const snap = getIsKnownPluginCounters();
    expect(snap.requests).toBe(1);
    expect(snap.hits).toBe(1);
    expect(snap.misses).toBe(0);
    expect(snap.underlyingFetches).toBe(0);
    expect(mockScanSpacePlugins).not.toHaveBeenCalled();
  });

  it('cache miss → misses + underlyingFetches increment, scan is called', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([]);
    mockScanSpacePlugins.mockResolvedValue({
      plugins: [{ pluginId: 'space-only-plugin' } as unknown as { pluginId: string }],
      conflicts: [],
    });

    const result = await isKnownPlugin('space-only-plugin');
    expect(result).toBe(true);

    const snap = getIsKnownPluginCounters();
    expect(snap.requests).toBe(1);
    expect(snap.hits).toBe(0);
    expect(snap.misses).toBe(1);
    expect(snap.underlyingFetches).toBe(1);
    expect(mockScanSpacePlugins).toHaveBeenCalledTimes(1);
  });

  it('second rapid call after miss hits the post-complete spaceScanCache', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([]);
    mockScanSpacePlugins.mockResolvedValue({
      plugins: [{ pluginId: 'space-plugin' } as unknown as { pluginId: string }],
      conflicts: [],
    });

    await isKnownPlugin('space-plugin');
    await isKnownPlugin('other-plugin');

    const snap = getIsKnownPluginCounters();
    expect(snap.requests).toBe(2);
    expect(snap.misses).toBe(1); // First call missed.
    expect(snap.hits).toBe(1);   // Second call hit the spaceScanCache.
    expect(snap.underlyingFetches).toBe(1);
    expect(mockScanSpacePlugins).toHaveBeenCalledTimes(1);
  });

  it('scanSpacePlugins rejection → fetchErrors increments + returns false', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([]);
    mockScanSpacePlugins.mockRejectedValue(new Error('scan failed'));

    const result = await isKnownPlugin('unknown-plugin');
    expect(result).toBe(false);

    const snap = getIsKnownPluginCounters();
    expect(snap.requests).toBe(1);
    expect(snap.misses).toBe(1);
    expect(snap.underlyingFetches).toBe(1);
    expect(snap.fetchErrors).toBe(1);
  });

  it('loadPersistedPluginEntries rejection → fetchErrors increments + returns false', async () => {
    mockLoadPersistedPluginEntries.mockRejectedValue(new Error('persistence read failed'));

    const result = await isKnownPlugin('some-plugin');
    expect(result).toBe(false);

    const snap = getIsKnownPluginCounters();
    expect(snap.requests).toBe(1);
    expect(snap.fetchErrors).toBe(1);
    // Did not reach the space-scan fallback.
    expect(snap.misses).toBe(0);
    expect(snap.underlyingFetches).toBe(0);
    expect(mockScanSpacePlugins).not.toHaveBeenCalled();
  });

  it('concurrent cold-cache callers coalesce to a single underlying fetch (Stage 4 behavior)', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([]);

    const d = deferred<{ plugins: Array<{ pluginId: string }>; conflicts: unknown[] }>();
    mockScanSpacePlugins.mockImplementation(() => d.promise);

    const p1 = isKnownPlugin('plugin-a');
    const p2 = isKnownPlugin('plugin-b');
    const p3 = isKnownPlugin('plugin-c');

    await flushMicrotasks();
    const duringSnap = getIsKnownPluginCounters();
    // Post-Stage-4: only ONE underlying fetch fires — joiners piggyback.
    expect(duringSnap.underlyingFetches).toBe(1);
    expect(duringSnap.maxConcurrentInflight).toBe(1);

    d.resolve({ plugins: [], conflicts: [] });
    await Promise.all([p1, p2, p3]);

    const afterSnap = getIsKnownPluginCounters();
    expect(afterSnap.requests).toBe(3);
    // One leader (miss) + two joiners (inflight).
    expect(afterSnap.misses).toBe(1);
    expect(afterSnap.inflightJoins).toBe(2);
    expect(afterSnap.underlyingFetches).toBe(1);
    // Max stays latched after all callers settle.
    expect(afterSnap.maxConcurrentInflight).toBe(1);
  });

  it('sequential non-overlapping calls do not raise maxConcurrentInflight above 1', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([]);
    mockScanSpacePlugins.mockResolvedValue({ plugins: [], conflicts: [] });

    await isKnownPlugin('p1');
    _clearSpaceScanCacheForTesting();
    await isKnownPlugin('p2');
    _clearSpaceScanCacheForTesting();
    await isKnownPlugin('p3');

    const snap = getIsKnownPluginCounters();
    expect(snap.requests).toBe(3);
    expect(snap.underlyingFetches).toBe(3);
    expect(snap.maxConcurrentInflight).toBe(1);
  });
});

// ── Stage 4: CoalescedCache on isKnownPlugin ────────────────────────────
// See docs/plans/260420_perf_observability_and_low_risk_wins.md § Stage 4.
//
// The Stage 4 cache lives in `shared.ts` as `pluginIdentityCache`
// (`CoalescedCache<Set<string>>`), keyed on `coreDirectory`. These tests
// exercise the identity-cache semantics: built-in shortcuts, persisted
// short-circuit, coalescing, invalidation on mutations, workspace switch,
// error non-caching, and the `REBEL_DISABLE_PLUGIN_COALESCE` kill switch.

describe('isKnownPlugin identity cache (Stage 4)', () => {
  beforeEach(() => {
    mockLoadPersistedPluginEntries.mockReset();
    mockScanSpacePlugins.mockReset();
    _resetIsKnownPluginCountersForTesting();
    _resetPluginIdentityCacheForTesting();
    _resetScanSpacePluginsResolverForTesting();
    mockCoreDirectory = '/mock/core';
    delete process.env.REBEL_DISABLE_PLUGIN_COALESCE;
  });

  afterEach(() => {
    delete process.env.REBEL_DISABLE_PLUGIN_COALESCE;
  });

  it('built-in __-prefixed IDs never touch the coalesced cache', async () => {
    const result = await isKnownPlugin('__rebel-canvas');
    expect(result).toBe(true);

    // No counter activity, no scan, no persisted read.
    const snap = getIsKnownPluginCounters();
    expect(snap.requests).toBe(0);
    expect(snap.hits).toBe(0);
    expect(snap.misses).toBe(0);
    expect(snap.inflightJoins).toBe(0);
    expect(snap.underlyingFetches).toBe(0);
    expect(mockLoadPersistedPluginEntries).not.toHaveBeenCalled();
    expect(mockScanSpacePlugins).not.toHaveBeenCalled();
  });

  it('persisted-plugin match short-circuits BEFORE the coalesced cache', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([
      { manifest: { id: 'locally-persisted' }, source: '' },
    ]);

    const result = await isKnownPlugin('locally-persisted');
    expect(result).toBe(true);

    // Cache was never consulted for this call.
    expect(mockScanSpacePlugins).not.toHaveBeenCalled();

    const snap = getIsKnownPluginCounters();
    expect(snap.hits).toBe(1);
    expect(snap.misses).toBe(0);
    expect(snap.inflightJoins).toBe(0);
    expect(snap.underlyingFetches).toBe(0);
  });

  it('5 concurrent cold-cache calls trigger exactly 1 underlying scan (coalescing)', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([]);
    const d = deferred<{ plugins: Array<{ pluginId: string }>; conflicts: unknown[] }>();
    mockScanSpacePlugins.mockImplementation(() => d.promise);

    const calls = [
      isKnownPlugin('real-plugin-id'),
      isKnownPlugin('real-plugin-id'),
      isKnownPlugin('real-plugin-id'),
      isKnownPlugin('real-plugin-id'),
      isKnownPlugin('real-plugin-id'),
    ];

    await flushMicrotasks();
    d.resolve({ plugins: [{ pluginId: 'real-plugin-id' }], conflicts: [] });
    const results = await Promise.all(calls);

    // All 5 joiners received the same `true` result.
    expect(results).toEqual([true, true, true, true, true]);

    // Exactly one underlying scan — the coalescing guarantee.
    expect(mockScanSpacePlugins).toHaveBeenCalledTimes(1);
    const snap = getIsKnownPluginCounters();
    expect(snap.requests).toBe(5);
    expect(snap.misses).toBe(1);
    expect(snap.inflightJoins).toBe(4);
    expect(snap.underlyingFetches).toBe(1);
    expect(snap.maxConcurrentInflight).toBe(1);
  });

  it('install flow: invalidate flips a cached false to a fresh true', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([]);
    // First scan: empty → cache a `false` for 'new-plugin'.
    mockScanSpacePlugins.mockResolvedValueOnce({ plugins: [], conflicts: [] });
    expect(await isKnownPlugin('new-plugin')).toBe(false);

    // Simulate install: a subsequent scan would find 'new-plugin'.
    mockScanSpacePlugins.mockResolvedValueOnce({
      plugins: [{ pluginId: 'new-plugin' }],
      conflicts: [],
    });

    // Without invalidation, the TTL would serve the cached `false` Set.
    invalidatePluginIdentityCache('test-install');

    expect(await isKnownPlugin('new-plugin')).toBe(true);
    expect(mockScanSpacePlugins).toHaveBeenCalledTimes(2);
  });

  it('uninstall flow: invalidate flips a cached true to a fresh false', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([]);
    mockScanSpacePlugins.mockResolvedValueOnce({
      plugins: [{ pluginId: 'doomed-plugin' }],
      conflicts: [],
    });
    expect(await isKnownPlugin('doomed-plugin')).toBe(true);

    // Uninstall mutated the Space — next scan would find nothing.
    mockScanSpacePlugins.mockResolvedValueOnce({ plugins: [], conflicts: [] });
    invalidatePluginIdentityCache('test-uninstall');

    expect(await isKnownPlugin('doomed-plugin')).toBe(false);
    expect(mockScanSpacePlugins).toHaveBeenCalledTimes(2);
  });

  it('underlying scan rejection is not cached — next call retries', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([]);
    mockScanSpacePlugins.mockRejectedValueOnce(new Error('transient IO'));
    expect(await isKnownPlugin('retry-me')).toBe(false);

    const snap1 = getIsKnownPluginCounters();
    expect(snap1.fetchErrors).toBe(1);
    expect(snap1.underlyingFetches).toBe(1);

    // A subsequent scan that succeeds should be observed — the rejection was
    // NOT cached, so the next call retries with a fresh fetcher.
    mockScanSpacePlugins.mockResolvedValueOnce({
      plugins: [{ pluginId: 'retry-me' }],
      conflicts: [],
    });
    expect(await isKnownPlugin('retry-me')).toBe(true);
    expect(mockScanSpacePlugins).toHaveBeenCalledTimes(2);

    const snap2 = getIsKnownPluginCounters();
    expect(snap2.fetchErrors).toBe(1); // no new error
    expect(snap2.underlyingFetches).toBe(2);
  });

  it('workspace switch: clearPluginIdentityCache() flushes entries for all coreDirectories', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([]);

    // Populate /a with a cached true.
    mockCoreDirectory = '/a';
    mockScanSpacePlugins.mockResolvedValueOnce({
      plugins: [{ pluginId: 'plugin-on-a' }],
      conflicts: [],
    });
    expect(await isKnownPlugin('plugin-on-a')).toBe(true);

    // Switch workspace — clear the cache entirely.
    clearPluginIdentityCache('test-switch');

    // /b must pay cold-cache cost; /a's entry is gone.
    mockCoreDirectory = '/b';
    mockScanSpacePlugins.mockResolvedValueOnce({
      plugins: [{ pluginId: 'plugin-on-b' }],
      conflicts: [],
    });
    expect(await isKnownPlugin('plugin-on-b')).toBe(true);
    // Two underlying scans — proves /a's cache did not leak into /b's lookup.
    expect(mockScanSpacePlugins).toHaveBeenCalledTimes(2);

    const snap = getIsKnownPluginCounters();
    // Both calls were cold-cache misses; no inflight joins.
    expect(snap.misses).toBe(2);
    expect(snap.inflightJoins).toBe(0);
    expect(snap.underlyingFetches).toBe(2);
  });

  it('kill switch REBEL_DISABLE_PLUGIN_COALESCE=1 disables coalescing for concurrent calls', async () => {
    process.env.REBEL_DISABLE_PLUGIN_COALESCE = '1';
    mockLoadPersistedPluginEntries.mockResolvedValue([]);

    const d1 = deferred<{ plugins: Array<{ pluginId: string }>; conflicts: unknown[] }>();
    const d2 = deferred<{ plugins: Array<{ pluginId: string }>; conflicts: unknown[] }>();
    mockScanSpacePlugins
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise);

    const p1 = isKnownPlugin('plugin-x');
    const p2 = isKnownPlugin('plugin-y');

    // Wait until BOTH calls have reached the scan. With the kill switch ON,
    // legacy cache is set only after the scan resolves, so both concurrent
    // calls should reach `scanSpacePlugins` before we resolve the deferreds.
    await waitForCallCount(mockScanSpacePlugins, 2);
    // Legacy path: BOTH concurrent calls run underlying scans (no in-flight
    // dedup). This matches pre-Stage-4 behavior.
    expect(mockScanSpacePlugins).toHaveBeenCalledTimes(2);

    d1.resolve({ plugins: [{ pluginId: 'plugin-x' }], conflicts: [] });
    d2.resolve({ plugins: [{ pluginId: 'plugin-y' }], conflicts: [] });
    await Promise.all([p1, p2]);

    const snap = getIsKnownPluginCounters();
    // No inflight joins — kill switch bypasses the coalesced cache entirely.
    expect(snap.inflightJoins).toBe(0);
    expect(snap.underlyingFetches).toBe(2);
  });

  it('kill switch off: second rapid call hits the coalesced cache', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([]);
    mockScanSpacePlugins.mockResolvedValueOnce({
      plugins: [{ pluginId: 'cached-plugin' }],
      conflicts: [],
    });

    expect(await isKnownPlugin('cached-plugin')).toBe(true);
    // Second call within TTL hits the cache via `onHit` → `recordHit()`.
    expect(await isKnownPlugin('cached-plugin')).toBe(true);

    expect(mockScanSpacePlugins).toHaveBeenCalledTimes(1);
    const snap = getIsKnownPluginCounters();
    expect(snap.hits).toBe(1);
    expect(snap.misses).toBe(1);
  });
});
