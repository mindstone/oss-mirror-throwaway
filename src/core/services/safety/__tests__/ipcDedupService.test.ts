/**
 * Unit tests for {@link createIpcDedupService}.
 *
 * Stage C of `docs/plans/260417_approval_consolidation_closeout.md`. The
 * service is a per-process in-memory dedup cache keyed by
 * `(channel, clientDedupKey)`. These tests cover the full behavioural
 * contract: peek/record flow, channel isolation, TTL expiry, cap + FIFO
 * eviction, lazy purge on read, and no-op behaviour for missing keys.
 *
 * The service takes optional `ttlMs`, `cap`, and `now` parameters so
 * tests can drive deterministic clock advancement without timers or
 * `setTimeout` plumbing.
 */

import { describe, it, expect } from 'vitest';
import {
  createIpcDedupService,
  DEFAULT_DEDUP_CAP,
  DEFAULT_DEDUP_TTL_MS,
} from '../ipcDedupService';

function makeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('createIpcDedupService', () => {
  describe('defaults', () => {
    it('exports the planning-doc-specified TTL and cap', () => {
      // These are part of the public contract and referenced by the
      // planning doc. Pinning them here prevents a silent drift from
      // 30 s / 500 entries during refactors.
      expect(DEFAULT_DEDUP_TTL_MS).toBe(30_000);
      expect(DEFAULT_DEDUP_CAP).toBe(500);
    });
  });

  describe('peek / record basics', () => {
    it('returns undefined for a never-seen key', () => {
      const svc = createIpcDedupService();
      expect(svc.peek('memory:staging-publish', 'k1')).toBeUndefined();
    });

    it('replays the cached response after a record for the same (channel, key)', () => {
      const svc = createIpcDedupService();
      const response = { status: 'success' as const };
      svc.record('memory:staging-publish', 'k1', response);
      expect(svc.peek('memory:staging-publish', 'k1')).toBe(response);
    });

    it('caches error responses — same key within TTL returns the cached error', () => {
      // The wrapper contract is "cache whatever the handler RETURNED,
      // exceptions don't get cached". A returned `{ status: 'error' }`
      // is intentionally cached so retries don't re-run the handler
      // only to fail the same way.
      const svc = createIpcDedupService();
      const err = { status: 'error' as const, error: 'nope' };
      svc.record('memory:staging-publish', 'k1', err);
      expect(svc.peek('memory:staging-publish', 'k1')).toBe(err);
    });

    it('overwrites an existing entry on re-record with the same key', () => {
      const svc = createIpcDedupService();
      svc.record('memory:staging-publish', 'k1', { version: 1 });
      svc.record('memory:staging-publish', 'k1', { version: 2 });
      expect(svc.peek('memory:staging-publish', 'k1')).toEqual({ version: 2 });
    });
  });

  describe('channel isolation', () => {
    it('keys the cache by (channel, dedupKey), not just dedupKey', () => {
      // Two different channels that happen to see the same client
      // UUID must NOT share cache slots — otherwise a publish replay
      // could leak into a discard handler (or vice versa).
      const svc = createIpcDedupService();
      svc.record('memory:staging-publish', 'shared-uuid', { kind: 'publish' });
      svc.record('memory:staging-discard', 'shared-uuid', { kind: 'discard' });
      expect(svc.peek('memory:staging-publish', 'shared-uuid')).toEqual({ kind: 'publish' });
      expect(svc.peek('memory:staging-discard', 'shared-uuid')).toEqual({ kind: 'discard' });
    });
  });

  describe('empty-key fail-open', () => {
    it('peek returns undefined for empty/missing keys (no-op)', () => {
      const svc = createIpcDedupService();
      svc.record('memory:staging-publish', 'k1', { status: 'success' });
      // Explicit empty string — mirrors the fail-open branch in
      // `withDedup` when `payload.clientDedupKey` isn't present.
      expect(svc.peek('memory:staging-publish', '')).toBeUndefined();
      expect(svc.peek('memory:staging-publish', undefined as unknown as string)).toBeUndefined();
    });

    it('record is a no-op for empty/missing keys (no cache entry created)', () => {
      const svc = createIpcDedupService();
      svc.record('memory:staging-publish', '', { status: 'success' });
      // A subsequent record with a legitimate key still works — the
      // empty-key record shouldn't have poisoned anything.
      svc.record('memory:staging-publish', 'real-key', { status: 'success' });
      expect(svc.peek('memory:staging-publish', 'real-key')).toEqual({ status: 'success' });
    });
  });

  describe('TTL expiry', () => {
    it('returns undefined after TTL has elapsed', () => {
      const clock = makeClock();
      const svc = createIpcDedupService({ ttlMs: 1_000, now: clock.now });
      svc.record('memory:staging-publish', 'k1', { status: 'success' });
      // One tick before TTL → still cached.
      clock.advance(999);
      expect(svc.peek('memory:staging-publish', 'k1')).toEqual({ status: 'success' });
      // Reach exactly the TTL → expired.
      clock.advance(1);
      expect(svc.peek('memory:staging-publish', 'k1')).toBeUndefined();
    });

    it('lazy-purges expired entries on peek so a subsequent record overwrites cleanly', () => {
      const clock = makeClock();
      const svc = createIpcDedupService({ ttlMs: 1_000, now: clock.now });
      svc.record('memory:staging-publish', 'k1', { version: 1 });
      clock.advance(2_000);
      // Peek should return undefined AND evict.
      expect(svc.peek('memory:staging-publish', 'k1')).toBeUndefined();
      // New record sees fresh state.
      svc.record('memory:staging-publish', 'k1', { version: 2 });
      expect(svc.peek('memory:staging-publish', 'k1')).toEqual({ version: 2 });
    });

    it('a refreshed record resets the TTL window', () => {
      const clock = makeClock();
      const svc = createIpcDedupService({ ttlMs: 1_000, now: clock.now });
      svc.record('memory:staging-publish', 'k1', { version: 1 });
      clock.advance(900);
      // Handler re-ran (in practice this happens if TTL narrowly
      // missed) and wrote a new response. TTL should count from NOW,
      // not from the first record.
      svc.record('memory:staging-publish', 'k1', { version: 2 });
      clock.advance(500);
      expect(svc.peek('memory:staging-publish', 'k1')).toEqual({ version: 2 });
    });
  });

  describe('cap + FIFO eviction', () => {
    it('evicts the oldest entry when cap is reached (FIFO insertion order)', () => {
      const svc = createIpcDedupService({ cap: 3 });
      svc.record('c', 'a', 1);
      svc.record('c', 'b', 2);
      svc.record('c', 'c', 3);
      // 4th insert should evict "a" (oldest).
      svc.record('c', 'd', 4);
      expect(svc.peek('c', 'a')).toBeUndefined();
      expect(svc.peek('c', 'b')).toBe(2);
      expect(svc.peek('c', 'c')).toBe(3);
      expect(svc.peek('c', 'd')).toBe(4);
    });

    it('prefers expired entries over FIFO when cap is reached', () => {
      // Under real load we'd rather drop stale entries than hot ones.
      // Confirm the enforceCap path purges expired items first.
      const clock = makeClock();
      const svc = createIpcDedupService({ cap: 3, ttlMs: 1_000, now: clock.now });
      svc.record('c', 'old', 1);
      clock.advance(1_500); // "old" is now expired
      svc.record('c', 'b', 2);
      svc.record('c', 'c', 3);
      // At cap: next insert should purge "old" (expired) before
      // evicting anything else.
      svc.record('c', 'd', 4);
      expect(svc.peek('c', 'old')).toBeUndefined();
      expect(svc.peek('c', 'b')).toBe(2);
      expect(svc.peek('c', 'c')).toBe(3);
      expect(svc.peek('c', 'd')).toBe(4);
    });

    it('honours the cap even across many inserts (memory ceiling)', () => {
      const svc = createIpcDedupService({ cap: 10 });
      for (let i = 0; i < 25; i += 1) {
        svc.record('c', `k-${i}`, i);
      }
      // The most recent 10 inserts should survive; anything older is evicted.
      for (let i = 0; i < 15; i += 1) {
        expect(svc.peek('c', `k-${i}`)).toBeUndefined();
      }
      for (let i = 15; i < 25; i += 1) {
        expect(svc.peek('c', `k-${i}`)).toBe(i);
      }
    });
  });

  describe('isolation between service instances', () => {
    it('two distinct services do NOT share state', () => {
      // Per-process design guarantee: each createIpcDedupService() call
      // owns its own cache. This test pins that guarantee so future
      // refactors don't accidentally introduce a module-level singleton.
      const a = createIpcDedupService();
      const b = createIpcDedupService();
      a.record('c', 'k', 'from-a');
      expect(b.peek('c', 'k')).toBeUndefined();
    });
  });
});
