import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlackInboundRateLimiter } from '../slackInboundRateLimiter';

describe('SlackInboundRateLimiter', () => {
  let limiter: SlackInboundRateLimiter | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-24T00:00:00Z'));
  });

  afterEach(() => {
    limiter?.dispose();
    limiter = null;
    vi.useRealTimers();
  });

  function createLimiter(options: ConstructorParameters<typeof SlackInboundRateLimiter>[0] = {}): SlackInboundRateLimiter {
    limiter?.dispose();
    limiter = new SlackInboundRateLimiter(options);
    return limiter;
  }

  it('fills and drains tokens for a principal key', () => {
    const rateLimiter = createLimiter({
      tokensPerWindow: 2,
      windowMs: 60_000,
      cleanupIntervalMs: 5 * 60_000,
    });

    expect(rateLimiter.consume('slack:T1:human:U1', false)).toEqual({ allowed: true });
    expect(rateLimiter.consume('slack:T1:human:U1', false)).toEqual({ allowed: true });
    const blocked = rateLimiter.consume('slack:T1:human:U1', false);

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills capacity over the configured time window', () => {
    const rateLimiter = createLimiter({
      tokensPerWindow: 2,
      windowMs: 60_000,
      cleanupIntervalMs: 5 * 60_000,
    });

    rateLimiter.consume('slack:T1:human:U1', false);
    rateLimiter.consume('slack:T1:human:U1', false);
    expect(rateLimiter.consume('slack:T1:human:U1', false).allowed).toBe(false);

    vi.advanceTimersByTime(30_000);

    expect(rateLimiter.consume('slack:T1:human:U1', false).allowed).toBe(true);
    expect(rateLimiter.consume('slack:T1:human:U1', false).allowed).toBe(false);
  });

  it('exempts owner principals from rate limiting', () => {
    const rateLimiter = createLimiter({
      tokensPerWindow: 1,
      windowMs: 60_000,
      cleanupIntervalMs: 5 * 60_000,
    });

    const attempts = Array.from({ length: 50 }, () => rateLimiter.consume('slack:T1:human:U_OWNER', true));
    expect(attempts.every((result) => result.allowed)).toBe(true);
    expect(rateLimiter.getBucketCountForTesting()).toBe(0);
  });

  it('isolates buckets by principal key', () => {
    const rateLimiter = createLimiter({
      tokensPerWindow: 2,
      windowMs: 60_000,
      cleanupIntervalMs: 5 * 60_000,
    });

    rateLimiter.consume('slack:T1:human:U_A', false);
    rateLimiter.consume('slack:T1:human:U_A', false);
    expect(rateLimiter.consume('slack:T1:human:U_A', false).allowed).toBe(false);

    expect(rateLimiter.consume('slack:T1:human:U_B', false).allowed).toBe(true);
    expect(rateLimiter.consume('slack:T1:human:U_B', false).allowed).toBe(true);
  });

  it('evicts stale buckets after two windows during periodic cleanup', () => {
    const rateLimiter = createLimiter({
      tokensPerWindow: 1,
      windowMs: 1_000,
      cleanupIntervalMs: 500,
    });

    rateLimiter.consume('slack:T1:human:U_STALE', false);
    expect(rateLimiter.getBucketCountForTesting()).toBe(1);

    vi.advanceTimersByTime(2_500);

    expect(rateLimiter.getBucketCountForTesting()).toBe(0);
  });

  it('evicts least-recently-seen bucket when maxBuckets is exceeded', () => {
    const debug = vi.fn();
    const rateLimiter = createLimiter({
      tokensPerWindow: 1,
      windowMs: 60_000,
      cleanupIntervalMs: 5 * 60_000,
      maxBuckets: 2,
      logger: { debug } as any,
    });

    expect(rateLimiter.consume('slack:T1:human:U_A', false)).toEqual({ allowed: true });
    vi.advanceTimersByTime(1);
    expect(rateLimiter.consume('slack:T1:human:U_B', false)).toEqual({ allowed: true });

    // Touch U_A so U_B becomes the least recently seen bucket.
    vi.advanceTimersByTime(1);
    expect(rateLimiter.consume('slack:T1:human:U_A', false).allowed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(rateLimiter.consume('slack:T1:human:U_C', false)).toEqual({ allowed: true });

    expect(rateLimiter.getBucketCountForTesting()).toBe(2);
    expect(rateLimiter.consume('slack:T1:human:U_A', false).allowed).toBe(false);
    expect(rateLimiter.consume('slack:T1:human:U_B', false).allowed).toBe(true);
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'slack_inbound_rate_limiter_evicted',
        evictedPrincipalKeyHash: expect.stringMatching(/^[a-f0-9]{12}$/),
      }),
      'slack_inbound_rate_limiter_evicted',
    );
  });
});
