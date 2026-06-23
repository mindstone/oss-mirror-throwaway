import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { LruCache } from '../lruCache';

describe('LruCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns cached values until TTL expiry', () => {
    const cache = new LruCache<string>({ maxEntries: 2, ttlMs: 1_000 });

    cache.set('a', 'alpha');
    expect(cache.get('a')).toBe('alpha');

    vi.advanceTimersByTime(1_001);
    expect(cache.get('a')).toBeUndefined();
  });

  it('evicts the least-recently-used entry when capacity is exceeded', () => {
    const cache = new LruCache<string>({ maxEntries: 2, ttlMs: 60_000 });

    cache.set('a', 'alpha');
    cache.set('b', 'bravo');
    expect(cache.get('a')).toBe('alpha');
    cache.set('c', 'charlie');

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('alpha');
    expect(cache.get('c')).toBe('charlie');
  });

  it('reports size after pruning expired entries', () => {
    const cache = new LruCache<string>({ maxEntries: 2, ttlMs: 1_000 });
    cache.set('a', 'alpha');

    vi.advanceTimersByTime(1_001);

    expect(cache.size).toBe(0);
  });
});
