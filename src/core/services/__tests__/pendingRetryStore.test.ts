import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PendingRetryStorage, PersistedPendingRetry } from '../pendingRetryStore';
import {
  getPersistedRetries,
  persistRetry,
  clearPersistedRetry,
  clearAllPersistedRetries,
  PENDING_RETRIES_LS_KEY,
  MAX_PERSISTED_RETRIES,
} from '../pendingRetryStore';


function createMockStorage(): PendingRetryStorage {
  const data = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
    removeItem: vi.fn((key: string) => { data.delete(key); }),
  };
}

function makeRetry(overrides: Partial<PersistedPendingRetry> = {}): PersistedPendingRetry {
  return {
    sessionId: 'session-1',
    userMessageText: 'Hello world',
    failedAt: Date.now(),
    retryCount: 1,
    ...overrides,
  };
}

describe('pendingRetryStore', () => {
  let storage: PendingRetryStorage;

  beforeEach(() => {
    storage = createMockStorage();
  });

  describe('getPersistedRetries', () => {
    it('returns empty array when nothing stored', () => {
      expect(getPersistedRetries(storage)).toEqual([]);
    });

    it('returns empty array when stored value is null', () => {
      expect(getPersistedRetries(storage)).toEqual([]);
      expect(storage.getItem).toHaveBeenCalledWith(PENDING_RETRIES_LS_KEY);
    });

    it('loads persisted retries from storage', () => {
      const retry = makeRetry();
      storage.setItem(PENDING_RETRIES_LS_KEY, JSON.stringify([retry]));
      expect(getPersistedRetries(storage)).toEqual([retry]);
    });

    it('returns empty array for corrupt JSON', () => {
      storage.setItem(PENDING_RETRIES_LS_KEY, '{not valid json!!!');
      expect(getPersistedRetries(storage)).toEqual([]);
    });

    it('returns empty array when stored value is not an array', () => {
      storage.setItem(PENDING_RETRIES_LS_KEY, JSON.stringify({ not: 'array' }));
      expect(getPersistedRetries(storage)).toEqual([]);
    });

    it('filters out invalid entries', () => {
      const valid = makeRetry({ sessionId: 'valid' });
      const entries = [
        valid,
        { sessionId: 123, userMessageText: 'bad' }, // invalid sessionId type
        { sessionId: 'ok' }, // missing fields
        null,
        'not-an-object',
      ];
      storage.setItem(PENDING_RETRIES_LS_KEY, JSON.stringify(entries));
      expect(getPersistedRetries(storage)).toEqual([valid]);
    });

    it('filters entries with non-finite numbers', () => {
      const valid = makeRetry({ sessionId: 'valid' });
      const entries = [
        valid,
        { sessionId: 'bad1', userMessageText: 'x', failedAt: NaN, retryCount: 1 },
        { sessionId: 'bad2', userMessageText: 'x', failedAt: 100, retryCount: Infinity },
      ];
      storage.setItem(PENDING_RETRIES_LS_KEY, JSON.stringify(entries));
      expect(getPersistedRetries(storage)).toEqual([valid]);
    });

    it('validates attachmentCacheIds as string array', () => {
      const valid = makeRetry({ attachmentCacheIds: ['id1', 'id2'] });
      const invalid = makeRetry({
        sessionId: 'bad',
        attachmentCacheIds: [123, 'id1'] as unknown as string[],
      });
      storage.setItem(PENDING_RETRIES_LS_KEY, JSON.stringify([valid, invalid]));
      expect(getPersistedRetries(storage)).toEqual([valid]);
    });

    it('caps results at MAX_PERSISTED_RETRIES', () => {
      const entries = Array.from({ length: MAX_PERSISTED_RETRIES + 5 }, (_, i) =>
        makeRetry({ sessionId: `session-${i}`, failedAt: i }),
      );
      storage.setItem(PENDING_RETRIES_LS_KEY, JSON.stringify(entries));
      const result = getPersistedRetries(storage);
      expect(result).toHaveLength(MAX_PERSISTED_RETRIES);
      // Should keep last MAX entries (tail)
      expect(result[0]?.sessionId).toBe(`session-5`);
    });

    it('handles storage.getItem throwing', () => {
      const throwStorage: PendingRetryStorage = {
        getItem: () => { throw new Error('Storage unavailable'); },
        setItem: vi.fn(),
        removeItem: vi.fn(),
      };
      expect(getPersistedRetries(throwStorage)).toEqual([]);
    });
  });

  describe('persistRetry', () => {
    it('persists a new retry entry', () => {
      const retry = makeRetry();
      persistRetry(storage, retry);
      const stored = JSON.parse(storage.getItem(PENDING_RETRIES_LS_KEY)!);
      expect(stored).toEqual([retry]);
    });

    it('replaces existing entry for same sessionId', () => {
      const retry1 = makeRetry({ retryCount: 1 });
      const retry2 = makeRetry({ retryCount: 2 });
      persistRetry(storage, retry1);
      persistRetry(storage, retry2);
      const stored = JSON.parse(storage.getItem(PENDING_RETRIES_LS_KEY)!);
      expect(stored).toHaveLength(1);
      expect(stored[0].retryCount).toBe(2);
    });

    it('accumulates entries for different sessions', () => {
      persistRetry(storage, makeRetry({ sessionId: 'a' }));
      persistRetry(storage, makeRetry({ sessionId: 'b' }));
      persistRetry(storage, makeRetry({ sessionId: 'c' }));
      const stored = JSON.parse(storage.getItem(PENDING_RETRIES_LS_KEY)!);
      expect(stored).toHaveLength(3);
    });

    it('evicts oldest entries (FIFO) when exceeding MAX_PERSISTED_RETRIES', () => {
      // Fill to max
      for (let i = 0; i < MAX_PERSISTED_RETRIES; i++) {
        persistRetry(storage, makeRetry({ sessionId: `session-${i}`, failedAt: i }));
      }
      // One more should evict session-0
      persistRetry(storage, makeRetry({ sessionId: 'overflow', failedAt: 999 }));
      const stored: PersistedPendingRetry[] = JSON.parse(storage.getItem(PENDING_RETRIES_LS_KEY)!);
      expect(stored).toHaveLength(MAX_PERSISTED_RETRIES);
      expect(stored.find((r) => r.sessionId === 'session-0')).toBeUndefined();
      expect(stored.find((r) => r.sessionId === 'overflow')).toBeDefined();
    });

    it('preserves attachmentCacheIds', () => {
      const retry = makeRetry({ attachmentCacheIds: ['cache-1', 'cache-2'] });
      persistRetry(storage, retry);
      const stored = JSON.parse(storage.getItem(PENDING_RETRIES_LS_KEY)!);
      expect(stored[0].attachmentCacheIds).toEqual(['cache-1', 'cache-2']);
    });

    it('handles storage.setItem throwing without propagating', () => {
      const throwStorage: PendingRetryStorage = {
        getItem: () => null,
        setItem: () => { throw new Error('QuotaExceeded'); },
        removeItem: vi.fn(),
      };
      // Should not throw
      expect(() => persistRetry(throwStorage, makeRetry())).not.toThrow();
    });
  });

  describe('clearPersistedRetry', () => {
    it('removes a specific session from persisted retries', () => {
      persistRetry(storage, makeRetry({ sessionId: 'a' }));
      persistRetry(storage, makeRetry({ sessionId: 'b' }));
      clearPersistedRetry(storage, 'a');
      const stored = JSON.parse(storage.getItem(PENDING_RETRIES_LS_KEY)!);
      expect(stored).toHaveLength(1);
      expect(stored[0].sessionId).toBe('b');
    });

    it('removes storage key when last entry cleared', () => {
      persistRetry(storage, makeRetry({ sessionId: 'only' }));
      clearPersistedRetry(storage, 'only');
      expect(storage.getItem(PENDING_RETRIES_LS_KEY)).toBeNull();
      expect(storage.removeItem).toHaveBeenCalledWith(PENDING_RETRIES_LS_KEY);
    });

    it('is a no-op when sessionId not found', () => {
      persistRetry(storage, makeRetry({ sessionId: 'a' }));
      clearPersistedRetry(storage, 'nonexistent');
      const stored = JSON.parse(storage.getItem(PENDING_RETRIES_LS_KEY)!);
      expect(stored).toHaveLength(1);
    });

    it('handles errors without propagating', () => {
      const throwStorage: PendingRetryStorage = {
        getItem: () => { throw new Error('Storage error'); },
        setItem: vi.fn(),
        removeItem: vi.fn(),
      };
      expect(() => clearPersistedRetry(throwStorage, 'any')).not.toThrow();
    });
  });

  describe('clearAllPersistedRetries', () => {
    it('removes the storage key entirely', () => {
      persistRetry(storage, makeRetry({ sessionId: 'a' }));
      persistRetry(storage, makeRetry({ sessionId: 'b' }));
      clearAllPersistedRetries(storage);
      expect(storage.getItem(PENDING_RETRIES_LS_KEY)).toBeNull();
      expect(storage.removeItem).toHaveBeenCalledWith(PENDING_RETRIES_LS_KEY);
    });

    it('is safe to call when nothing is stored', () => {
      expect(() => clearAllPersistedRetries(storage)).not.toThrow();
    });

    it('handles errors without propagating', () => {
      const throwStorage: PendingRetryStorage = {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: () => { throw new Error('Storage error'); },
      };
      expect(() => clearAllPersistedRetries(throwStorage)).not.toThrow();
    });
  });
});
