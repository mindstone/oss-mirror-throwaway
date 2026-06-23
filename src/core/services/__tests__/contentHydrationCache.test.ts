import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { ContentHydrationCache } from '../contentHydrationCache';

describe('ContentHydrationCache', () => {
  it('stores and reads hydrated content by session/content id', () => {
    const cache = new ContentHydrationCache();
    cache.set('sess-1', 'cid-1', {
      bytes: Buffer.from('hello', 'utf8'),
      mimeType: 'text/plain',
    });
    const hit = cache.get('sess-1', 'cid-1');
    expect(hit?.mimeType).toBe('text/plain');
    expect(hit?.bytes.toString('utf8')).toBe('hello');
  });

  it('evicts least-recently-used entries over maxEntries', () => {
    const cache = new ContentHydrationCache({ maxEntries: 2 });
    cache.set('s', 'a', { bytes: Buffer.from('a'), mimeType: 'text/plain' });
    cache.set('s', 'b', { bytes: Buffer.from('b'), mimeType: 'text/plain' });
    // touch "a" so "b" becomes LRU
    cache.get('s', 'a');
    cache.set('s', 'c', { bytes: Buffer.from('c'), mimeType: 'text/plain' });
    expect(cache.get('s', 'a')).toBeDefined();
    expect(cache.get('s', 'b')).toBeUndefined();
    expect(cache.get('s', 'c')).toBeDefined();
  });

  it('expires entries after ttl', () => {
    let now = 1_000;
    const cache = new ContentHydrationCache({
      ttlMs: 100,
      now: () => now,
    });
    cache.set('s', 'a', { bytes: Buffer.from('a'), mimeType: 'text/plain' });
    expect(cache.get('s', 'a')).toBeDefined();
    now = 1_200;
    expect(cache.get('s', 'a')).toBeUndefined();
  });

  it('clearSession removes only matching keys', () => {
    const cache = new ContentHydrationCache();
    cache.set('s1', 'a', { bytes: Buffer.from('a'), mimeType: 'text/plain' });
    cache.set('s2', 'b', { bytes: Buffer.from('b'), mimeType: 'text/plain' });
    cache.clearSession('s1');
    expect(cache.get('s1', 'a')).toBeUndefined();
    expect(cache.get('s2', 'b')).toBeDefined();
  });
});
