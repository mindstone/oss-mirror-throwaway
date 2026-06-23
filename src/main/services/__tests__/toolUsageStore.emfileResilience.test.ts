/**
 * Regression tests for REBEL-1C8 / 260422_emfile_tool_usage_store_hardening.
 *
 * Bug:
 *   Under Windows `EMFILE` / `ENFILE` conditions, `toolUsageStore` can
 *   escalate a non-critical personalization read into a user-visible turn
 *   failure because:
 *     1. Hot reads (`getFrequentTools`) hit the backing `conf` store on every
 *        call — no in-memory cache like `settingsStore` has.
 *     2. The load-failure catch path immediately reset-writes the store,
 *        turning an `EMFILE` read error into a second `EMFILE` write error
 *        against `tool-usage.json.tmp-*`.
 *
 * These tests should FAIL before the fix and PASS after it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable backing store state shared with the mocked createStore().
interface MockStoreControls {
  data: Record<string, unknown>;
  readCount: number;
  writeCount: number;
  throwOnRead: NodeJS.ErrnoException | null;
  throwOnWrite: NodeJS.ErrnoException | null;
}

const mockControls: MockStoreControls = {
  data: { version: 6, tools: [], lastUpdatedAt: 0 },
  readCount: 0,
  writeCount: 0,
  throwOnRead: null,
  throwOnWrite: null,
};

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get store() {
      mockControls.readCount++;
      if (mockControls.throwOnRead) {
        throw mockControls.throwOnRead;
      }
      return mockControls.data;
    },
    set store(val: Record<string, unknown>) {
      mockControls.writeCount++;
      if (mockControls.throwOnWrite) {
        throw mockControls.throwOnWrite;
      }
      mockControls.data = val;
    },
  })),
}));

// Keep migrations as a no-op pass-through so tests focus on cache + error handling.
vi.mock('@core/utils/storeMigration', () => ({
  migrateStore: vi.fn((stored: Record<string, unknown>) => ({
    data: stored,
    status: 'current',
    shouldPersist: false,
    fromVersion: stored.version ?? 6,
    toVersion: 6,
  })),
  shouldEnterReadOnlyMode: (result: { status: string; shouldPersist: boolean }): boolean =>
    result.status === 'future_version' ||
    (result.status === 'corrupted' && result.shouldPersist === false),
}));

// Import after mocks so the module picks up the mocked dependencies.
import {
  getFrequentTools,
  getAllToolUsage,
  recordToolUsage,
  removeToolsForServer,
  __resetToolUsageCacheForTests,
} from '../toolUsageStore';

const makeErrnoError = (code: 'EMFILE' | 'ENFILE'): NodeJS.ErrnoException => {
  const err: NodeJS.ErrnoException = new Error(`${code}: too many open files, open 'tool-usage.json'`);
  err.code = code;
  return err;
};

const seedStoredState = (tools: Array<{ toolName: string; usageCount: number }>): void => {
  mockControls.data = {
    version: 6,
    tools: tools.map(t => ({
      toolName: t.toolName,
      usageCount: t.usageCount,
      firstUsedAt: 1,
      lastUsedAt: Date.now(),
      seenParams: [],
    })),
    lastUpdatedAt: Date.now(),
  };
};

const resetMockControls = (): void => {
  mockControls.data = { version: 6, tools: [], lastUpdatedAt: Date.now() };
  mockControls.readCount = 0;
  mockControls.writeCount = 0;
  mockControls.throwOnRead = null;
  mockControls.throwOnWrite = null;
};

describe('toolUsageStore — EMFILE resilience (REBEL-1C8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockControls();
    __resetToolUsageCacheForTests();
  });

  describe('in-memory cache for hot reads', () => {
    it('reads the backing store at most once across many getFrequentTools() calls', () => {
      seedStoredState([
        { toolName: 'RebelInbox/rebel_inbox_add', usageCount: 5 },
        { toolName: 'Linear/search_issues', usageCount: 3 },
      ]);

      // First call primes the cache.
      const first = getFrequentTools();
      expect(first.length).toBeGreaterThan(0);

      const readsAfterFirst = mockControls.readCount;

      // Simulate turn-startup hot-path amplification: hundreds of rapid reads.
      for (let i = 0; i < 100; i++) {
        getFrequentTools();
        getAllToolUsage();
      }

      // Before the fix: readCount grows linearly with call count (200+ new reads).
      // After the fix: the cache serves every subsequent call with zero disk reads.
      expect(mockControls.readCount).toBe(readsAfterFirst);
    });
  });

  describe('EMFILE / ENFILE load failures', () => {
    it('does NOT reset-write the store when .store read fails with EMFILE and no cache exists', () => {
      mockControls.throwOnRead = makeErrnoError('EMFILE');

      // Should not throw and must not escalate the read error into a write.
      const result = getFrequentTools();

      expect(result).toEqual([]); // default state
      expect(mockControls.writeCount).toBe(0);
    });

    it('does NOT reset-write the store when .store read fails with ENFILE', () => {
      mockControls.throwOnRead = makeErrnoError('ENFILE');

      const result = getFrequentTools();

      expect(result).toEqual([]);
      expect(mockControls.writeCount).toBe(0);
    });

    it('returns cached state when a later read hits EMFILE', () => {
      seedStoredState([
        { toolName: 'RebelMeetings/rebel_meetings_today', usageCount: 8 },
      ]);

      // First call primes the cache with real state from disk.
      const primed = getFrequentTools();
      expect(primed).toHaveLength(1);
      expect(primed[0].toolName).toBe('RebelMeetings/rebel_meetings_today');

      // Now simulate FD exhaustion.
      mockControls.throwOnRead = makeErrnoError('EMFILE');
      const writesBefore = mockControls.writeCount;

      // Force cache-miss path by clearing only the cache; backing store read will EMFILE.
      __resetToolUsageCacheForTests();

      // Even without cache, load must NOT reset-write on EMFILE — it must return default.
      const afterEmfileNoCache = getFrequentTools();
      expect(afterEmfileNoCache).toEqual([]);
      expect(mockControls.writeCount).toBe(writesBefore);

      // Now re-prime the cache (EMFILE clears), then simulate a post-cache EMFILE:
      mockControls.throwOnRead = null;
      getFrequentTools(); // reloads real state, primes cache
      expect(mockControls.writeCount).toBe(writesBefore); // still no resets

      // With cache present, a new read attempt should use the cache and never hit disk.
      mockControls.throwOnRead = makeErrnoError('EMFILE');
      const fromCache = getFrequentTools();
      expect(fromCache).toHaveLength(1);
      expect(fromCache[0].toolName).toBe('RebelMeetings/rebel_meetings_today');
      expect(mockControls.writeCount).toBe(writesBefore);
    });

    it('does not cache the ephemeral default so recovery can happen once EMFILE clears', () => {
      mockControls.throwOnRead = makeErrnoError('EMFILE');

      // First call: EMFILE, returns default, does not cache.
      expect(getFrequentTools()).toEqual([]);

      // Clear the EMFILE condition and seed real state.
      mockControls.throwOnRead = null;
      seedStoredState([
        { toolName: 'Slack/post_message', usageCount: 2 },
      ]);

      // Next call must read from disk again (no cached default) and get real data.
      const recovered = getFrequentTools();
      expect(recovered).toHaveLength(1);
      expect(recovered[0].toolName).toBe('Slack/post_message');
    });
  });

  describe('non-EMFILE load failures NEVER reset-write (F1 data-loss guard)', () => {
    it('does NOT reset-write on a generic (non-FD) load failure — preserves on-disk data', () => {
      // F1: the old behavior reset-wrote defaults over the user's real data on
      // any non-FD load error (corrupt JSON / schema / transient IO), silently
      // wiping it. The guard now classifies + preserves instead of resetting:
      // the backing file is never overwritten with defaults.
      const genericError: NodeJS.ErrnoException = new Error('JSON parse error');
      genericError.code = 'SOMETHING_ELSE';
      mockControls.throwOnRead = genericError;

      const result = getFrequentTools();

      expect(result).toEqual([]); // ephemeral in-memory defaults
      // The critical assertion: NO reset-write. (Here the backing file doesn't
      // exist in the test env, so the guard classifies absent and serves fresh
      // defaults; either way it must never reset-write over real data.)
      expect(mockControls.writeCount).toBe(0);
    });
  });

  describe('write path integration with cache', () => {
    it('recordToolUsage updates the cache so subsequent reads do not re-hit disk', () => {
      // Prime the cache with a single recorded tool.
      recordToolUsage('Linear/search_issues', ['query']);
      const writesAfterRecord = mockControls.writeCount;
      const readsAfterRecord = mockControls.readCount;

      // Hot read path should be served entirely from the in-memory cache.
      for (let i = 0; i < 25; i++) {
        getFrequentTools();
      }

      expect(mockControls.readCount).toBe(readsAfterRecord);
      expect(mockControls.writeCount).toBe(writesAfterRecord);
    });

    it('does not overwrite learned history when first load fails with EMFILE before hydration', () => {
      seedStoredState([
        { toolName: 'Slack/post_message', usageCount: 7 },
      ]);
      mockControls.throwOnRead = makeErrnoError('EMFILE');

      // First write attempt is based on an unhydrated EMFILE fallback and must
      // be skipped rather than overwriting the on-disk history with a synthetic
      // empty-state merge.
      recordToolUsage('Linear/search_issues', ['query']);
      expect(mockControls.writeCount).toBe(0);

      // Once EMFILE clears, the next read should hydrate from disk and preserve
      // the original learned history.
      mockControls.throwOnRead = null;
      const recovered = getFrequentTools();
      expect(recovered).toHaveLength(1);
      expect(recovered[0].toolName).toBe('Slack/post_message');
    });

    it('removeToolsForServer skips writes until the store hydrates after first-load EMFILE', () => {
      seedStoredState([
        { toolName: 'Slack/post_message', usageCount: 7 },
      ]);
      mockControls.throwOnRead = makeErrnoError('EMFILE');

      const removed = removeToolsForServer('Slack');
      expect(removed).toBe(0);
      expect(mockControls.writeCount).toBe(0);

      mockControls.throwOnRead = null;
      const recovered = getFrequentTools();
      expect(recovered).toHaveLength(1);
      expect(recovered[0].toolName).toBe('Slack/post_message');
    });
  });
});
