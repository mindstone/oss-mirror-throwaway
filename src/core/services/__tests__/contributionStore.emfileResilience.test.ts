/**
 * Regression tests for REBEL-1HF — contribution-store EMFILE / ENFILE
 * resilience.
 *
 * Bug:
 *   Under sustained Windows file-descriptor pressure, the contribution
 *   store amplified the saturation because:
 *     1. Hot reads (`listContributions`, `getActiveContributionBySession`,
 *        etc.) hit the underlying `conf` `fs.readFileSync` on every call —
 *        no in-memory cache like `settingsStore` / `toolUsageStore` had.
 *     2. The renderer polled `contribution:get-by-session` every 2s and
 *        `contribution:list` every 3s, multiplying the disk-read cadence.
 *     3. There was no graceful degradation when `EMFILE` / `ENFILE` hit
 *        the read path, so each poll would re-trigger the same FD-bound
 *        failure.
 *
 *   The fix mirrors the proven `toolUsageStore` (REBEL-1C8) pattern:
 *     - In-memory cache populated on first successful read.
 *     - On `EMFILE` / `ENFILE` read failure: serve cached / default,
 *       NEVER reset-write (which would escalate a read EMFILE into a
 *       write EMFILE on the tmp-file).
 *     - The ephemeral default served on a cache-miss EMFILE is NOT
 *       cached — recovery hydrates from disk once descriptors clear.
 *
 * These tests should FAIL before the fix and PASS after it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable backing store state shared with the mocked createStore().
interface MockStoreControls {
  data: Record<string, unknown>;
  getCount: number;
  setCount: number;
  storeReadCount: number;
  storeWriteCount: number;
  throwOnGet: NodeJS.ErrnoException | null;
  throwOnSet: NodeJS.ErrnoException | null;
  throwOnStoreRead: NodeJS.ErrnoException | null;
}

const mockControls: MockStoreControls = {
  data: { version: 5, contributions: [] },
  getCount: 0,
  setCount: 0,
  storeReadCount: 0,
  storeWriteCount: 0,
  throwOnGet: null,
  throwOnSet: null,
  throwOnStoreRead: null,
};

 
vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get(key: string) {
      mockControls.getCount++;
      if (mockControls.throwOnGet) {
        throw mockControls.throwOnGet;
      }
      return (mockControls.data as Record<string, unknown>)[key];
    },
    set(keyOrObj: string | Record<string, unknown>, value?: unknown) {
      mockControls.setCount++;
      if (mockControls.throwOnSet) {
        throw mockControls.throwOnSet;
      }
      if (typeof keyOrObj === 'string') {
        (mockControls.data as Record<string, unknown>)[keyOrObj] = value;
      } else {
        Object.assign(mockControls.data, keyOrObj);
      }
    },
    has(key: string) { return key in mockControls.data; },
    delete(key: string) { delete (mockControls.data as Record<string, unknown>)[key]; },
    clear() { mockControls.data = { version: 5, contributions: [] }; },
    get store() {
      mockControls.storeReadCount++;
      if (mockControls.throwOnStoreRead) {
        throw mockControls.throwOnStoreRead;
      }
      return mockControls.data;
    },
    set store(val: Record<string, unknown>) {
      mockControls.storeWriteCount++;
      if (mockControls.throwOnSet) {
        throw mockControls.throwOnSet;
      }
      mockControls.data = val;
    },
    path: '/mock/path',
  })),
}));

// Pass-through migration so tests focus on cache + error-handling paths.
 
vi.mock('@core/utils/storeMigration', () => ({
  createMigrationRegistry: <T extends Record<string, unknown>>(
    migrations: Record<number, (data: T) => T>,
  ): Record<number, (data: T) => T> => migrations,
  migrateStore: vi.fn((stored: Record<string, unknown>) => ({
    data: stored,
    status: 'current',
    shouldPersist: false,
    fromVersion: (stored as { version?: number }).version ?? 5,
    toVersion: 5,
    backupPath: null,
  })),
  shouldEnterReadOnlyMode: (result: { status: string; shouldPersist: boolean }): boolean =>
    result.status === 'future_version' ||
    (result.status === 'corrupted' && result.shouldPersist === false),
}));

// Import after mocks so the module picks up the mocked dependencies.
import {
  listContributions,
  createContribution,
  getActiveContributionBySession,
  __resetContributionCacheForTests,
  _resetStore,
} from '../contributionStore';
import type { ConnectorContribution } from '../contributionTypes';

const makeErrnoError = (code: 'EMFILE' | 'ENFILE'): NodeJS.ErrnoException => {
  const err: NodeJS.ErrnoException = new Error(`${code}: too many open files, open 'connector-contributions.json'`);
  err.code = code;
  return err;
};

const seedStoredState = (records: ConnectorContribution[]): void => {
  mockControls.data = {
    version: 5,
    contributions: records,
  };
};

const makeRecord = (
  overrides: Partial<ConnectorContribution> & Pick<ConnectorContribution, 'id' | 'sessionId' | 'connectorName'>,
): ConnectorContribution => ({
  status: 'draft',
  attributionMode: 'anonymous',
  acknowledgedEvents: [],
  createdAt: '2026-04-28T00:00:00.000Z',
  updatedAt: '2026-04-28T00:00:00.000Z',
  linkedSessionIds: [overrides.sessionId],
  ...overrides,
});

const resetMockControls = (): void => {
  mockControls.data = { version: 5, contributions: [] };
  mockControls.getCount = 0;
  mockControls.setCount = 0;
  mockControls.storeReadCount = 0;
  mockControls.storeWriteCount = 0;
  mockControls.throwOnGet = null;
  mockControls.throwOnSet = null;
  mockControls.throwOnStoreRead = null;
};

describe('contributionStore — EMFILE resilience (REBEL-1HF)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockControls();
    _resetStore();
    __resetContributionCacheForTests();
  });

  describe('in-memory cache for hot reads', () => {
    it('reads the backing store at most once across many listContributions() calls', () => {
      seedStoredState([
        makeRecord({ id: 'c-1', sessionId: 's-1', connectorName: 'first' }),
        makeRecord({ id: 'c-2', sessionId: 's-2', connectorName: 'second' }),
      ]);

      // First call primes the cache via initialization.
      const first = listContributions();
      expect(first).toHaveLength(2);

      const getsAfterFirst = mockControls.getCount;
      const storeReadsAfterFirst = mockControls.storeReadCount;

      // Simulate poll-storm: hundreds of rapid reads matching the 2s
      // useMcpBuildCardState polling cadence amplified across many sessions.
      for (let i = 0; i < 100; i++) {
        listContributions();
        getActiveContributionBySession('s-1');
        getActiveContributionBySession('s-2');
      }

      // Before the fix: getCount grows linearly with call count (300+ new gets).
      // After the fix: the cache serves every subsequent call with zero disk reads.
      expect(mockControls.getCount).toBe(getsAfterFirst);
      expect(mockControls.storeReadCount).toBe(storeReadsAfterFirst);
    });

    it('returns cached state across distinct read APIs without re-reading the disk', () => {
      seedStoredState([
        makeRecord({ id: 'c-1', sessionId: 's-1', connectorName: 'foo' }),
      ]);

      // Prime cache.
      listContributions();
      const baselineGets = mockControls.getCount;

      // Different read APIs should all hit the cache.
      expect(getActiveContributionBySession('s-1')?.id).toBe('c-1');
      expect(getActiveContributionBySession('s-missing')).toBeUndefined();
      expect(listContributions()).toHaveLength(1);
      expect(mockControls.getCount).toBe(baselineGets);
    });
  });

  describe('EMFILE / ENFILE load failures', () => {
    it('does NOT reset-write the store when initial read fails with EMFILE and no cache exists', () => {
      mockControls.throwOnStoreRead = makeErrnoError('EMFILE');

      // Should not throw and must not escalate the read error into a write.
      const result = listContributions();

      expect(result).toEqual([]); // ephemeral default
      expect(mockControls.setCount).toBe(0);
      expect(mockControls.storeWriteCount).toBe(0);
    });

    it('does NOT reset-write the store when initial read fails with ENFILE', () => {
      mockControls.throwOnStoreRead = makeErrnoError('ENFILE');

      const result = listContributions();

      expect(result).toEqual([]);
      expect(mockControls.setCount).toBe(0);
      expect(mockControls.storeWriteCount).toBe(0);
    });

    it('returns cached state when a later read hits EMFILE', () => {
      seedStoredState([
        makeRecord({ id: 'c-1', sessionId: 's-1', connectorName: 'cached-record' }),
      ]);

      // First call primes the cache with real state from disk.
      const primed = listContributions();
      expect(primed).toHaveLength(1);
      expect(primed[0].connectorName).toBe('cached-record');

      // Now simulate FD exhaustion on subsequent reads.
      mockControls.throwOnStoreRead = makeErrnoError('EMFILE');
      mockControls.throwOnGet = makeErrnoError('EMFILE');
      const setsBefore = mockControls.setCount;
      const writesBefore = mockControls.storeWriteCount;

      // Cache should serve the read with zero disk hits.
      const fromCache = listContributions();
      expect(fromCache).toHaveLength(1);
      expect(fromCache[0].connectorName).toBe('cached-record');
      expect(mockControls.setCount).toBe(setsBefore);
      expect(mockControls.storeWriteCount).toBe(writesBefore);

      // Force cache-miss path; backing store read still EMFILEs.
      __resetContributionCacheForTests();
      _resetStore();

      const afterEmfileNoCache = listContributions();
      expect(afterEmfileNoCache).toEqual([]);
      // Critically: never reset-writes during EMFILE.
      expect(mockControls.setCount).toBe(setsBefore);
      expect(mockControls.storeWriteCount).toBe(writesBefore);
    });

    it('does not cache the ephemeral default so recovery can happen once EMFILE clears', () => {
      mockControls.throwOnStoreRead = makeErrnoError('EMFILE');
      mockControls.throwOnGet = makeErrnoError('EMFILE');

      // First call: EMFILE, returns empty default.
      expect(listContributions()).toEqual([]);

      // Clear the EMFILE condition and seed real state.
      mockControls.throwOnStoreRead = null;
      mockControls.throwOnGet = null;
      seedStoredState([
        makeRecord({ id: 'c-7', sessionId: 's-9', connectorName: 'recovered' }),
      ]);

      // Next call must read from disk again (no cached default) and get real data.
      const recovered = listContributions();
      expect(recovered).toHaveLength(1);
      expect(recovered[0].connectorName).toBe('recovered');
    });

    it('serves cached state across distinct read APIs even while EMFILE is firing on disk', () => {
      seedStoredState([
        makeRecord({ id: 'c-1', sessionId: 's-1', connectorName: 'first' }),
        makeRecord({ id: 'c-2', sessionId: 's-2', connectorName: 'second' }),
      ]);

      // Prime cache from healthy disk.
      listContributions();

      // Disk now EMFILEs.
      mockControls.throwOnStoreRead = makeErrnoError('EMFILE');
      mockControls.throwOnGet = makeErrnoError('EMFILE');

      // Every API still serves cached values.
      expect(listContributions()).toHaveLength(2);
      expect(getActiveContributionBySession('s-1')?.id).toBe('c-1');
      expect(getActiveContributionBySession('s-2')?.id).toBe('c-2');
      expect(getActiveContributionBySession('s-unknown')).toBeUndefined();
    });
  });

  describe('write path integration with cache', () => {
    it('createContribution updates the cache so subsequent reads do not re-hit disk', () => {
      // Prime cache with empty initial state.
      listContributions();
      const baselineGets = mockControls.getCount;
      const baselineStoreReads = mockControls.storeReadCount;

      // Add a record.
      const created = createContribution({
        sessionId: 's-1',
        connectorName: 'fresh',
        status: 'draft',
        attributionMode: 'anonymous',
      });
      expect(created.id).toMatch(/^contrib-/);

      // Hot read path served entirely from in-memory cache.
      for (let i = 0; i < 25; i++) {
        listContributions();
      }

      expect(mockControls.getCount).toBe(baselineGets);
      expect(mockControls.storeReadCount).toBe(baselineStoreReads);

      // Sanity: read returns the freshly-created record.
      const list = listContributions();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(created.id);
    });

    it('write failures (EMFILE on set) leave the cache unchanged so later reads stay consistent', () => {
      seedStoredState([
        makeRecord({ id: 'c-1', sessionId: 's-1', connectorName: 'pre-existing' }),
      ]);
      // Prime cache with the on-disk state.
      expect(listContributions()).toHaveLength(1);

      // EMFILE on the next write.
      mockControls.throwOnSet = makeErrnoError('EMFILE');
      expect(() =>
        createContribution({
          sessionId: 's-99',
          connectorName: 'should-fail',
          status: 'draft',
          attributionMode: 'anonymous',
        }),
      ).toThrow(/EMFILE/);

      // Cache must NOT have absorbed the failed write.
      const stillCached = listContributions();
      expect(stillCached).toHaveLength(1);
      expect(stillCached[0].connectorName).toBe('pre-existing');
    });
  });
});
