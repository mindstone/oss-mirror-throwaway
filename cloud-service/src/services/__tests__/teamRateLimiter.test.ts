import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { TeamRateLimiter } from '../teamRateLimiter';

describe('TeamRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows 100 immediate requests when configured with a 100-request burst', () => {
    const limiter = new TeamRateLimiter({ burstCapacity: 100 });

    const results = Array.from({ length: 100 }, () => limiter.consume('T-A'));

    expect(results.every((result) => result.allowed)).toBe(true);
  });

  it('rejects same-team requests that exceed the default 60-request burst', () => {
    const limiter = new TeamRateLimiter();

    const results = Array.from({ length: 100 }, () => limiter.consume('T-A'));

    expect(results.filter((result) => result.allowed)).toHaveLength(60);
    expect(results.filter((result) => !result.allowed)).toHaveLength(40);
    expect(results.at(-1)).toMatchObject({ allowed: false, retryAfter: 1 });
  });

  it('isolates buckets by team id', () => {
    const limiter = new TeamRateLimiter();

    const teamA = Array.from({ length: 100 }, () => limiter.consume('T-A'));
    const teamB = Array.from({ length: 100 }, () => limiter.consume('T-B'));

    expect(teamA.filter((result) => result.allowed)).toHaveLength(60);
    expect(teamB.filter((result) => result.allowed)).toHaveLength(60);
  });

  it('refills the team bucket after one minute', () => {
    const limiter = new TeamRateLimiter();

    Array.from({ length: 60 }, () => limiter.consume('T-A'));
    expect(limiter.consume('T-A')).toMatchObject({ allowed: false });

    vi.advanceTimersByTime(60_000);

    const refilled = Array.from({ length: 60 }, () => limiter.consume('T-A'));
    expect(refilled.every((result) => result.allowed)).toBe(true);
  });

  it('evicts buckets after the idle TTL on the next consume', () => {
    const limiter = new TeamRateLimiter({ bucketTtlMs: 60 * 60 * 1000 });
    limiter.consume('T-A');
    expect(limiter.getBucketCountForTesting()).toBe(1);

    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    limiter.consume('T-B');

    expect(limiter.getBucketCountForTesting()).toBe(1);
  });

  it('caps buckets by evicting the least-recently-used bucket', () => {
    const limiter = new TeamRateLimiter({ maxBuckets: 2 });
    limiter.consume('T-A');
    limiter.consume('T-B');
    limiter.consume('T-A');
    limiter.consume('T-C');

    expect(limiter.getBucketCountForTesting()).toBe(2);
    expect(limiter.consume('T-B').remaining).toBe(59);
  });
});
