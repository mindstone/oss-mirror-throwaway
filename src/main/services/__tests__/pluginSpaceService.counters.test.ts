/**
 * Unit tests for the Stage 1 `scanSpacePlugins` hot-path counter.
 *
 * Covers:
 *  - increments happen exactly once per call
 *  - maxConcurrentInflight latches a true high-water mark (stays latched even
 *    after all callers settle — the decrement happens, but `max` does not)
 *  - _resetForTesting() zeros all fields
 *  - error path increments `fetchErrors`
 *
 * Concurrency is exercised via deferred promises: we hold N fetchers in-flight
 * simultaneously, assert the max, then release them and assert it is latched.
 *
 * See docs/plans/260420_perf_observability_and_low_risk_wins.md § Stage 1.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const mockGetSettings = vi.fn();
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => mockGetSettings(),
}));

// Mock spaceService.scanSpaces so we can hold it in-flight via deferred promises.
const mockScanSpaces = vi.fn();
vi.mock('../spaceService', () => ({
  scanSpaces: (...args: unknown[]) => mockScanSpaces(...args),
}));

// detectPluginConflicts is called per-space; for counter tests we don't care.
vi.mock('../pluginConflictDetector', () => ({
  detectPluginConflicts: vi.fn(async () => []),
}));

vi.mock('electron-store', () => ({
  default: class {
    store: Record<string, unknown> = {};
    get = vi.fn((key: string) => this.store[key]);
    set = vi.fn();
  },
}));

const {
  scanSpacePlugins,
  getScanSpacePluginsCounters,
  _resetScanSpacePluginsCountersForTesting,
} = await import('../pluginSpaceService');

/** Build a deferred promise whose resolver we can call later. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let pending microtasks / awaits drain. */
async function flushMicrotasks(count = 5): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

describe('scanSpacePlugins counter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-plugin-counter-'));
    mockGetSettings.mockReset();
    mockScanSpaces.mockReset();
    _resetScanSpacePluginsCountersForTesting();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('_resetForTesting zeros all counter fields', async () => {
    mockGetSettings.mockReturnValue({ coreDirectory: '' });
    await scanSpacePlugins();
    const before = getScanSpacePluginsCounters();
    expect(before.requests).toBeGreaterThan(0);

    _resetScanSpacePluginsCountersForTesting();
    const after = getScanSpacePluginsCounters();
    expect(after).toEqual({
      requests: 0,
      hits: 0,
      misses: 0,
      inflightJoins: 0,
      underlyingFetches: 0,
      fetchErrors: 0,
      maxConcurrentInflight: 0,
    });
  });

  it('increments requests + underlyingFetches exactly once per call', async () => {
    mockGetSettings.mockReturnValue({ coreDirectory: tempDir });
    mockScanSpaces.mockResolvedValue([]);

    await scanSpacePlugins();
    let snap = getScanSpacePluginsCounters();
    expect(snap.requests).toBe(1);
    expect(snap.underlyingFetches).toBe(1);
    expect(snap.fetchErrors).toBe(0);

    await scanSpacePlugins();
    snap = getScanSpacePluginsCounters();
    expect(snap.requests).toBe(2);
    expect(snap.underlyingFetches).toBe(2);
  });

  it('increments fetchErrors when scanSpaces rejects + propagates the error', async () => {
    mockGetSettings.mockReturnValue({ coreDirectory: tempDir });
    mockScanSpaces.mockRejectedValue(new Error('boom'));

    await expect(scanSpacePlugins()).rejects.toThrow('boom');
    const snap = getScanSpacePluginsCounters();
    expect(snap.requests).toBe(1);
    expect(snap.underlyingFetches).toBe(1);
    expect(snap.fetchErrors).toBe(1);
  });

  it('maxConcurrentInflight latches true high-water mark (stays latched after settle)', async () => {
    mockGetSettings.mockReturnValue({ coreDirectory: tempDir });

    // Three deferred scanSpaces calls — release them in controlled order.
    const d1 = deferred<unknown[]>();
    const d2 = deferred<unknown[]>();
    const d3 = deferred<unknown[]>();

    mockScanSpaces
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise)
      .mockImplementationOnce(() => d3.promise);

    // Fire three concurrent scans without awaiting.
    const p1 = scanSpacePlugins();
    const p2 = scanSpacePlugins();
    const p3 = scanSpacePlugins();

    await flushMicrotasks();
    // At this point, all three have called recordUnderlyingFetchStart() and
    // are awaiting the deferred scanSpaces mock — so in-flight is 3.
    let snap = getScanSpacePluginsCounters();
    expect(snap.underlyingFetches).toBe(3);
    expect(snap.maxConcurrentInflight).toBe(3);

    // Resolve all three — in-flight gauge drops back to 0, but max stays 3.
    d1.resolve([]);
    d2.resolve([]);
    d3.resolve([]);
    await Promise.all([p1, p2, p3]);

    snap = getScanSpacePluginsCounters();
    expect(snap.maxConcurrentInflight).toBe(3);
    expect(snap.requests).toBe(3);
    expect(snap.underlyingFetches).toBe(3);
  });

  it('does NOT raise maxConcurrentInflight for sequential (non-overlapping) calls', async () => {
    mockGetSettings.mockReturnValue({ coreDirectory: tempDir });
    mockScanSpaces.mockResolvedValue([]);

    await scanSpacePlugins();
    await scanSpacePlugins();
    await scanSpacePlugins();

    const snap = getScanSpacePluginsCounters();
    expect(snap.requests).toBe(3);
    expect(snap.underlyingFetches).toBe(3);
    expect(snap.maxConcurrentInflight).toBe(1);
  });
});
