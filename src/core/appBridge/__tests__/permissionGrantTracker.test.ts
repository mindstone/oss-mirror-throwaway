import { describe, expect, it, vi } from 'vitest';
import { PermissionGrantTracker } from '../server/permissionGrantTracker';

describe('PermissionGrantTracker', () => {
  it('resolves true when a grant arrives within the timeout', async () => {
    const tracker = new PermissionGrantTracker({ recencyMs: 0 });
    const promise = tracker.awaitGrant({
      origin: 'https://example.com',
      timeoutMs: 5_000,
    });
    tracker.recordGrant({ origin: 'https://example.com', at: Date.now() });
    expect(await promise).toBe(true);
  });

  it('resolves false when the timeout elapses with no grant', async () => {
    const tracker = new PermissionGrantTracker({ recencyMs: 0 });
    const granted = await tracker.awaitGrant({
      origin: 'https://example.com',
      timeoutMs: 10,
    });
    expect(granted).toBe(false);
  });

  it('honors a recent grant that landed before awaitGrant was called', async () => {
    const tracker = new PermissionGrantTracker({ recencyMs: 5_000 });
    tracker.recordGrant({ origin: 'https://example.com', at: Date.now() });
    const granted = await tracker.awaitGrant({
      origin: 'https://example.com',
      timeoutMs: 10,
    });
    expect(granted).toBe(true);
  });

  it('does NOT honor a stale grant outside the recency window', async () => {
    const tracker = new PermissionGrantTracker({ recencyMs: 100 });
    tracker.recordGrant({
      origin: 'https://example.com',
      at: Date.now() - 10_000,
    });
    const granted = await tracker.awaitGrant({
      origin: 'https://example.com',
      timeoutMs: 10,
    });
    expect(granted).toBe(false);
  });

  it('bounds future-dated grant timestamps to the tracker clock', async () => {
    let now = 10_000;
    const tracker = new PermissionGrantTracker({
      recencyMs: 100,
      now: () => now,
    });
    tracker.recordGrant({
      origin: 'https://example.com',
      at: Number.MAX_SAFE_INTEGER,
    });

    now = 10_200;

    const granted = await tracker.awaitGrant({
      origin: 'https://example.com',
      timeoutMs: 10,
    });

    expect(granted).toBe(false);
  });

  it('only matches by exact origin', async () => {
    const tracker = new PermissionGrantTracker({ recencyMs: 0 });
    const a = tracker.awaitGrant({
      origin: 'https://example.com',
      timeoutMs: 50,
    });
    const b = tracker.awaitGrant({
      origin: 'https://other.com',
      timeoutMs: 50,
    });
    tracker.recordGrant({ origin: 'https://example.com', at: Date.now() });
    expect(await a).toBe(true);
    // Other origin still pending — must time out, not be incorrectly granted.
    expect(await b).toBe(false);
  });

  it('broadcasts a single grant to all same-origin waiters', async () => {
    const tracker = new PermissionGrantTracker({ recencyMs: 0 });
    const w1 = tracker.awaitGrant({
      origin: 'https://example.com',
      timeoutMs: 1_000,
    });
    const w2 = tracker.awaitGrant({
      origin: 'https://example.com',
      timeoutMs: 1_000,
    });
    expect(tracker.pendingWaiterCount()).toBe(2);
    tracker.recordGrant({ origin: 'https://example.com', at: Date.now() });
    expect(await w1).toBe(true);
    expect(await w2).toBe(true);
    expect(tracker.pendingWaiterCount()).toBe(0);
  });

  it('resolves false when an abort signal fires', async () => {
    const tracker = new PermissionGrantTracker({ recencyMs: 0 });
    const ac = new AbortController();
    const promise = tracker.awaitGrant({
      origin: 'https://example.com',
      timeoutMs: 5_000,
      signal: ac.signal,
    });
    ac.abort();
    expect(await promise).toBe(false);
  });

  it('resolves false immediately if the signal is already aborted', async () => {
    const tracker = new PermissionGrantTracker({ recencyMs: 0 });
    const ac = new AbortController();
    ac.abort();
    expect(
      await tracker.awaitGrant({
        origin: 'https://example.com',
        timeoutMs: 5_000,
        signal: ac.signal,
      }),
    ).toBe(false);
    // No timer leaked, no waiter retained.
    expect(tracker.pendingWaiterCount()).toBe(0);
  });

  it('bounds the recent-grants ring to maxRecentGrants', () => {
    const tracker = new PermissionGrantTracker({ maxRecentGrants: 3 });
    for (let i = 0; i < 10; i += 1) {
      tracker.recordGrant({ origin: `https://o${i}.com`, at: Date.now() });
    }
    // Internal — verify via a probe: only the last 3 grants serve recent
    // matches. We probe by calling awaitGrant for each origin synchronously
    // (recencyMs default is 5s, so any recent match resolves immediately).
    const probe = (origin: string) =>
      tracker.awaitGrant({ origin, timeoutMs: 5 });
    return Promise.all([
      probe('https://o9.com'),
      probe('https://o8.com'),
      probe('https://o7.com'),
      probe('https://o0.com'),
    ]).then(([n9, n8, n7, n0]) => {
      expect(n9).toBe(true);
      expect(n8).toBe(true);
      expect(n7).toBe(true);
      // Older grant evicted.
      expect(n0).toBe(false);
    });
  });

  it('dispose drains all waiters as false', async () => {
    const tracker = new PermissionGrantTracker({ recencyMs: 0 });
    const w = tracker.awaitGrant({
      origin: 'https://example.com',
      timeoutMs: 5_000,
    });
    tracker.dispose();
    expect(await w).toBe(false);
    expect(tracker.pendingWaiterCount()).toBe(0);
  });

  it('logs grants when a logger is configured', () => {
    const info = vi.fn();
    const logger = {
      info,
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      // Pino's Logger type is structural enough that the runtime methods we
      // exercise are the only ones we need; the rest is filled by `unknown`.
    } as unknown as import('pino').Logger;
    const tracker = new PermissionGrantTracker({ logger });
    tracker.recordGrant({ origin: 'https://example.com', at: 12345 });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'https://example.com',
        at: 12345,
      }),
      'Permission grant recorded',
    );
  });
});
