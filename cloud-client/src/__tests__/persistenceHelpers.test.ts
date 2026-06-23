/**
 * Unit tests for persistence infrastructure: hydrateStore, persistStore,
 * flushPending, clearKeysForPrefix, buildCacheKey/buildCacheKeyPrefix.
 */

import type { PersistenceAdapter } from '../persistence/types';
import { initPersistence, resetPersistence } from '../persistence/persistenceRegistry';
import {
  hydrateStore,
  persistStore,
  flushPending,
  clearKeysForPrefix,
  buildCacheKey,
  buildCacheKeyPrefix,
} from '../persistence/persistenceHelpers';

// ---------------------------------------------------------------------------
// Mock adapter factory
// ---------------------------------------------------------------------------

function createMockAdapter(overrides: Partial<PersistenceAdapter> = {}): PersistenceAdapter {
  return {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  resetPersistence();
});

afterEach(() => {
  vi.useRealTimers();
  resetPersistence();
});

// ---------------------------------------------------------------------------
// buildCacheKey / buildCacheKeyPrefix
// ---------------------------------------------------------------------------

describe('buildCacheKey', () => {
  it('returns a versioned, namespaced key', () => {
    const key = buildCacheKey('https://cloud.example.com', 'sessions');
    expect(key).toMatch(/^rebel:v1:[0-9a-f]+:sessions$/);
  });

  it('produces different keys for different cloudUrls', () => {
    const key1 = buildCacheKey('https://a.com', 'sessions');
    const key2 = buildCacheKey('https://b.com', 'sessions');
    expect(key1).not.toBe(key2);
  });

  it('produces different keys for different store names', () => {
    const key1 = buildCacheKey('https://cloud.com', 'sessions');
    const key2 = buildCacheKey('https://cloud.com', 'inbox');
    expect(key1).not.toBe(key2);
  });

  it('produces the same key for the same inputs', () => {
    const key1 = buildCacheKey('https://cloud.com', 'sessions');
    const key2 = buildCacheKey('https://cloud.com', 'sessions');
    expect(key1).toBe(key2);
  });
});

describe('buildCacheKeyPrefix', () => {
  it('returns the prefix portion (cloudUrl hash)', () => {
    const prefix = buildCacheKeyPrefix('https://cloud.example.com');
    expect(prefix).toMatch(/^rebel:v1:[0-9a-f]+:$/);
  });

  it('matches keys built for that cloudUrl', () => {
    const prefix = buildCacheKeyPrefix('https://cloud.example.com');
    const key = buildCacheKey('https://cloud.example.com', 'sessions');
    expect(key.startsWith(prefix)).toBe(true);
  });

  it('does not match keys for a different cloudUrl', () => {
    const prefix = buildCacheKeyPrefix('https://a.com');
    const key = buildCacheKey('https://b.com', 'sessions');
    expect(key.startsWith(prefix)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hydrateStore
// ---------------------------------------------------------------------------

describe('hydrateStore', () => {
  it('returns validated data from the adapter', async () => {
    const data = [{ id: '1', name: 'test' }];
    const adapter = createMockAdapter({
      getItem: vi.fn().mockResolvedValue(JSON.stringify(data)),
    });
    initPersistence(adapter);

    const result = await hydrateStore('test-key', (d) =>
      Array.isArray(d) ? (d as typeof data) : null,
    );

    expect(result).toEqual(data);
    expect(adapter.getItem).toHaveBeenCalledWith('test-key');
  });

  it('returns null when key is missing', async () => {
    const adapter = createMockAdapter({
      getItem: vi.fn().mockResolvedValue(null),
    });
    initPersistence(adapter);

    const result = await hydrateStore('missing-key', () => []);

    expect(result).toBeNull();
    expect(adapter.removeItem).not.toHaveBeenCalled();
  });

  it('returns null and removes key on corrupt JSON', async () => {
    const adapter = createMockAdapter({
      getItem: vi.fn().mockResolvedValue('not valid json{{{'),
    });
    initPersistence(adapter);

    const result = await hydrateStore('corrupt-key', () => []);

    expect(result).toBeNull();
    expect(adapter.removeItem).toHaveBeenCalledWith('corrupt-key');
  });

  it('returns null and removes key when validation fails', async () => {
    const adapter = createMockAdapter({
      getItem: vi.fn().mockResolvedValue(JSON.stringify({ wrong: 'shape' })),
    });
    initPersistence(adapter);

    const result = await hydrateStore('bad-data-key', (d) =>
      Array.isArray(d) ? d : null, // expects array, gets object
    );

    expect(result).toBeNull();
    expect(adapter.removeItem).toHaveBeenCalledWith('bad-data-key');
  });

  it('returns null when no adapter is initialised', async () => {
    // resetPersistence() in beforeEach ensures no adapter
    const result = await hydrateStore('any-key', () => []);

    expect(result).toBeNull();
  });

  it('returns null when adapter.getItem throws', async () => {
    const adapter = createMockAdapter({
      getItem: vi.fn().mockRejectedValue(new Error('MMKV crash')),
    });
    initPersistence(adapter);

    const result = await hydrateStore('crash-key', () => []);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// persistStore
// ---------------------------------------------------------------------------

describe('persistStore', () => {
  it('debounces writes (500ms)', async () => {
    const adapter = createMockAdapter();
    initPersistence(adapter);

    persistStore('key', { a: 1 });

    // Not written immediately
    expect(adapter.setItem).not.toHaveBeenCalled();

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(500);

    expect(adapter.setItem).toHaveBeenCalledTimes(1);
    expect(adapter.setItem).toHaveBeenCalledWith('key', JSON.stringify({ a: 1 }));
  });

  it('replaces pending write for the same key when called multiple times', async () => {
    const adapter = createMockAdapter();
    initPersistence(adapter);

    persistStore('key', { version: 1 });
    persistStore('key', { version: 2 });
    persistStore('key', { version: 3 });

    await vi.advanceTimersByTimeAsync(500);

    // Only the last value should be written
    expect(adapter.setItem).toHaveBeenCalledTimes(1);
    expect(adapter.setItem).toHaveBeenCalledWith('key', JSON.stringify({ version: 3 }));
  });

  it('writes different keys independently', async () => {
    const adapter = createMockAdapter();
    initPersistence(adapter);

    persistStore('key-a', { a: 1 });
    persistStore('key-b', { b: 2 });

    await vi.advanceTimersByTimeAsync(500);

    expect(adapter.setItem).toHaveBeenCalledTimes(2);
    expect(adapter.setItem).toHaveBeenCalledWith('key-a', JSON.stringify({ a: 1 }));
    expect(adapter.setItem).toHaveBeenCalledWith('key-b', JSON.stringify({ b: 2 }));
  });

  it('skips write when serialised data exceeds maxBytes', async () => {
    const adapter = createMockAdapter();
    initPersistence(adapter);

    const largeData = 'x'.repeat(100);
    persistStore('key', largeData, 10); // maxBytes = 10

    await vi.advanceTimersByTimeAsync(500);

    expect(adapter.setItem).not.toHaveBeenCalled();
  });

  it('no-ops when no adapter is initialised', async () => {
    // No adapter
    persistStore('key', { data: true });
    await vi.advanceTimersByTimeAsync(500);
    // Nothing to assert on the adapter — just verify no error thrown
  });

  it('catches write failures without throwing', async () => {
    const adapter = createMockAdapter({
      setItem: vi.fn().mockRejectedValue(new Error('disk full')),
    });
    initPersistence(adapter);

    persistStore('key', { data: true });

    // Should not throw
    await vi.advanceTimersByTimeAsync(500);

    expect(adapter.setItem).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// flushPending
// ---------------------------------------------------------------------------

describe('flushPending', () => {
  it('immediately writes all pending debounced data', async () => {
    const adapter = createMockAdapter();
    initPersistence(adapter);

    persistStore('key-1', { one: 1 });
    persistStore('key-2', { two: 2 });

    // Not yet written (within debounce window)
    expect(adapter.setItem).not.toHaveBeenCalled();

    await flushPending();

    expect(adapter.setItem).toHaveBeenCalledTimes(2);
    expect(adapter.setItem).toHaveBeenCalledWith('key-1', JSON.stringify({ one: 1 }));
    expect(adapter.setItem).toHaveBeenCalledWith('key-2', JSON.stringify({ two: 2 }));
  });

  it('clears pending map so debounce timers do not double-write', async () => {
    const adapter = createMockAdapter();
    initPersistence(adapter);

    persistStore('key', { v: 1 });
    await flushPending();

    // Advance past the original debounce timer
    await vi.advanceTimersByTimeAsync(1000);

    // Should have been written only once (by flush)
    expect(adapter.setItem).toHaveBeenCalledTimes(1);
  });

  it('no-ops when no adapter is initialised', async () => {
    // No adapter — should not throw
    await flushPending();
  });

  it('no-ops when there is nothing pending', async () => {
    const adapter = createMockAdapter();
    initPersistence(adapter);

    await flushPending();

    expect(adapter.setItem).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// clearKeysForPrefix
// ---------------------------------------------------------------------------

describe('clearKeysForPrefix', () => {
  it('removes keys matching the prefix via getAllKeys', async () => {
    const adapter = createMockAdapter({
      getAllKeys: vi.fn().mockResolvedValue([
        'rebel:v1:abc:sessions',
        'rebel:v1:abc:inbox',
        'rebel:v1:def:sessions',
      ]),
    });
    initPersistence(adapter);

    await clearKeysForPrefix('rebel:v1:abc:');

    expect(adapter.removeItem).toHaveBeenCalledTimes(2);
    expect(adapter.removeItem).toHaveBeenCalledWith('rebel:v1:abc:sessions');
    expect(adapter.removeItem).toHaveBeenCalledWith('rebel:v1:abc:inbox');
  });

  it('does not remove keys that do not match the prefix', async () => {
    const adapter = createMockAdapter({
      getAllKeys: vi.fn().mockResolvedValue([
        'rebel:v1:def:sessions',
        'rebel:v1:def:inbox',
      ]),
    });
    initPersistence(adapter);

    await clearKeysForPrefix('rebel:v1:abc:');

    expect(adapter.removeItem).not.toHaveBeenCalled();
  });

  it('falls back to tracked keys when adapter lacks getAllKeys', async () => {
    const adapter = createMockAdapter();
    // No getAllKeys method on this adapter
    initPersistence(adapter);

    // Write some keys so they get tracked
    persistStore('rebel:v1:abc:sessions', { data: true });
    persistStore('rebel:v1:abc:inbox', { data: true });
    persistStore('rebel:v1:def:sessions', { data: true });

    // Flush to ensure keys are tracked
    await flushPending();

    await clearKeysForPrefix('rebel:v1:abc:');

    // Should have removed the matching keys (the 2 abc keys)
    const removeCalls = vi.mocked(adapter.removeItem).mock.calls.map((c) => c[0]);
    expect(removeCalls).toContain('rebel:v1:abc:sessions');
    expect(removeCalls).toContain('rebel:v1:abc:inbox');
  });

  it('no-ops when no adapter is initialised', async () => {
    // No adapter — should not throw
    await clearKeysForPrefix('rebel:v1:abc:');
  });
});
