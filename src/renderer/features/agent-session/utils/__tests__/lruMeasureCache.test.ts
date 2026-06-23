/**
 * Regression tests for the bounded LRU measurement cache helper used by
 * `ConversationPane`.
 *
 * Context: commit 9c2b98d75 (Mar 8, 2026; shipped in v0.4.25) cleared the
 * measurement cache on every session switch to "prevent stale heights from a
 * previous conversation affecting the new one". Because message IDs are
 * globally unique UUIDs this concern was a non-issue, but the clear caused
 * the 25-RAF chase loop in `scrollToBottom` to under-converge on long threads
 * after switch-back (the secondary amplifier of the "thread jumps to top on
 * switch" bug, docs-private/investigations/260416_thread_scroll_jumps_to_top_on_switch.md).
 *
 * Fix: remove the per-switch clear, keep the cache warm across sessions, and
 * bound it with a small LRU cap so long-lived app sessions don't leak memory.
 * These tests pin that behaviour.
 */

import { describe, expect, it } from 'vitest';
import { setMeasureCacheEntryLru } from '../lruMeasureCache';

describe('setMeasureCacheEntryLru', () => {
  it('stores a new entry', () => {
    const cache = new Map<string, number>();
    setMeasureCacheEntryLru(cache, 'a', 150, 10);
    expect(cache.get('a')).toBe(150);
    expect(cache.size).toBe(1);
  });

  it('updates an existing entry without growing the cache', () => {
    const cache = new Map<string, number>([
      ['a', 100],
      ['b', 200],
    ]);
    setMeasureCacheEntryLru(cache, 'a', 175, 10);
    expect(cache.get('a')).toBe(175);
    expect(cache.size).toBe(2);
  });

  it('moves an updated entry to the tail (most-recently-used)', () => {
    const cache = new Map<string, number>([
      ['a', 100],
      ['b', 200],
      ['c', 300],
    ]);
    // Re-set 'a'. Now insertion order (MRU at tail) should be: b, c, a.
    setMeasureCacheEntryLru(cache, 'a', 175, 10);
    expect(Array.from(cache.keys())).toEqual(['b', 'c', 'a']);
  });

  it('evicts the least-recently-used entry when exceeding the cap', () => {
    const cache = new Map<string, number>();
    setMeasureCacheEntryLru(cache, 'a', 100, 3);
    setMeasureCacheEntryLru(cache, 'b', 200, 3);
    setMeasureCacheEntryLru(cache, 'c', 300, 3);
    // Now adding a 4th entry should evict 'a' (the oldest / least-recently-used).
    setMeasureCacheEntryLru(cache, 'd', 400, 3);
    expect(cache.size).toBe(3);
    expect(cache.has('a')).toBe(false);
    expect(Array.from(cache.keys())).toEqual(['b', 'c', 'd']);
  });

  it('updating an entry protects it from LRU eviction', () => {
    const cache = new Map<string, number>();
    setMeasureCacheEntryLru(cache, 'a', 100, 3);
    setMeasureCacheEntryLru(cache, 'b', 200, 3);
    setMeasureCacheEntryLru(cache, 'c', 300, 3);

    // Touch 'a' to make it MRU.
    setMeasureCacheEntryLru(cache, 'a', 150, 3);

    // Now adding a 4th entry evicts 'b' (the new LRU), not 'a'.
    setMeasureCacheEntryLru(cache, 'd', 400, 3);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(Array.from(cache.keys())).toEqual(['c', 'a', 'd']);
  });

  it('respects very small caps (cap = 1)', () => {
    const cache = new Map<string, number>();
    setMeasureCacheEntryLru(cache, 'a', 100, 1);
    setMeasureCacheEntryLru(cache, 'b', 200, 1);
    expect(cache.size).toBe(1);
    expect(cache.has('a')).toBe(false);
    expect(cache.get('b')).toBe(200);
  });

  it('handles sustained churn well past the cap (bound holds)', () => {
    const cache = new Map<string, number>();
    const cap = 50;
    for (let i = 0; i < 500; i++) {
      setMeasureCacheEntryLru(cache, `msg-${i}`, i, cap);
    }
    expect(cache.size).toBe(cap);
    // The last `cap` insertions (msg-450 … msg-499) should be the ones retained.
    expect(cache.has('msg-450')).toBe(true);
    expect(cache.has('msg-499')).toBe(true);
    expect(cache.has('msg-449')).toBe(false);
    expect(cache.has('msg-0')).toBe(false);
  });

  it('persists entries across simulated session switches (no clear)', () => {
    // Simulates the fix: switching from session A to session B and back to A
    // should keep A's measured heights hot. (The production code no longer
    // clears the cache on session switch; this test pins that behaviour at
    // the helper level by showing that nothing in the helper itself clears.)
    const cache = new Map<string, number>();
    const cap = 2000;

    // Session A warms up.
    setMeasureCacheEntryLru(cache, 'a-msg-1', 120, cap);
    setMeasureCacheEntryLru(cache, 'a-msg-2', 240, cap);
    expect(cache.size).toBe(2);

    // Session B adds its own messages — A's entries remain hot.
    setMeasureCacheEntryLru(cache, 'b-msg-1', 150, cap);
    expect(cache.get('a-msg-1')).toBe(120);
    expect(cache.get('a-msg-2')).toBe(240);

    // Re-visiting session A: no rebuild needed, estimates come out accurate.
    expect(cache.get('a-msg-1')).toBe(120);
    expect(cache.get('a-msg-2')).toBe(240);
  });
});
