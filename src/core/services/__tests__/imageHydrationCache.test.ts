import { describe, it, expect, beforeEach } from 'vitest';
import { Buffer } from 'node:buffer';
import { TurnScopedHydrationCache, type CacheKey } from '../imageHydrationCache';

describe('TurnScopedHydrationCache', () => {
  let cache: TurnScopedHydrationCache;

  beforeEach(() => {
    cache = new TurnScopedHydrationCache();
  });

  const createEntry = (sizeMB: number, mimeType = 'image/png') => {
    const byteSize = sizeMB * 1024 * 1024;
    return {
      bytes: Buffer.alloc(byteSize),
      mimeType,
      byteSize,
    };
  };

  it('stores and retrieves items accurately', () => {
    const key: CacheKey = 'sess1::asset1::orig::openai';
    const entry = createEntry(10);
    
    cache.set(key, entry);
    const retrieved = cache.get(key);
    
    expect(retrieved).toBeDefined();
    expect(retrieved?.byteSize).toBe(entry.byteSize);
    expect(cache.size()).toEqual({ count: 1, bytes: 10 * 1024 * 1024 });
  });

  it('evicts the oldest item when cap is exceeded (100MB)', () => {
    const key1: CacheKey = 'sess1::asset1::orig::openai';
    const key2: CacheKey = 'sess1::asset2::orig::openai';
    const key3: CacheKey = 'sess1::asset3::orig::openai';

    cache.set(key1, createEntry(40)); // 40MB
    cache.set(key2, createEntry(40)); // 80MB
    cache.set(key3, createEntry(40)); // 120MB - exceeds 100MB cap

    expect(cache.size().count).toBe(2);
    expect(cache.size().bytes).toBe(80 * 1024 * 1024);
    
    // First item should be evicted
    expect(cache.get(key1)).toBeUndefined();
    expect(cache.get(key2)).toBeDefined();
    expect(cache.get(key3)).toBeDefined();
  });

  it('updates LRU order on get()', () => {
    const key1: CacheKey = 'sess1::asset1::orig::openai';
    const key2: CacheKey = 'sess1::asset2::orig::openai';
    const key3: CacheKey = 'sess1::asset3::orig::openai';

    cache.set(key1, createEntry(40));
    cache.set(key2, createEntry(40));

    // Access key1 to make it most recently used
    cache.get(key1);

    // Add key3, exceeding 100MB. key2 is now the oldest.
    cache.set(key3, createEntry(40));

    expect(cache.get(key2)).toBeUndefined(); // key2 is evicted
    expect(cache.get(key1)).toBeDefined();   // key1 survived
    expect(cache.get(key3)).toBeDefined();   // key3 survived
  });

  it('handles overwriting existing keys correctly', () => {
    const key: CacheKey = 'sess1::asset1::orig::openai';
    
    cache.set(key, createEntry(20));
    expect(cache.size().bytes).toBe(20 * 1024 * 1024);

    cache.set(key, createEntry(30));
    expect(cache.size().bytes).toBe(30 * 1024 * 1024);
    expect(cache.size().count).toBe(1);
  });

  it('clears all items and resets size', () => {
    const key1: CacheKey = 'sess1::asset1::orig::openai';
    const key2: CacheKey = 'sess1::asset2::orig::openai';

    cache.set(key1, createEntry(10));
    cache.set(key2, createEntry(20));

    expect(cache.size().count).toBe(2);
    
    cache.clear();

    expect(cache.size().count).toBe(0);
    expect(cache.size().bytes).toBe(0);
    expect(cache.get(key1)).toBeUndefined();
  });
});
