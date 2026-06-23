import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSlidingWindowRateLimiter } from '../pluginRateLimiter';

describe('pluginRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enforces max calls within the window', () => {
    const limiter = createSlidingWindowRateLimiter(60_000, 3);

    expect(limiter.check('plugin-a')).toEqual({ allowed: true });
    limiter.record('plugin-a');
    limiter.record('plugin-a');
    limiter.record('plugin-a');

    const result = limiter.check('plugin-a');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('allows calls again after window expiry', () => {
    const limiter = createSlidingWindowRateLimiter(60_000, 2);

    limiter.record('plugin-a');
    limiter.record('plugin-a');
    expect(limiter.check('plugin-a').allowed).toBe(false);

    vi.advanceTimersByTime(60_001);

    expect(limiter.check('plugin-a')).toEqual({ allowed: true });
  });

  it('isolates rate limits per plugin id', () => {
    const limiter = createSlidingWindowRateLimiter(60_000, 1);

    limiter.record('plugin-a');

    expect(limiter.check('plugin-a').allowed).toBe(false);
    expect(limiter.check('plugin-b').allowed).toBe(true);
  });

  it('resets all state for testing', () => {
    const limiter = createSlidingWindowRateLimiter(60_000, 1);
    limiter.record('plugin-a');
    expect(limiter.check('plugin-a').allowed).toBe(false);

    limiter._resetForTesting();

    expect(limiter.check('plugin-a').allowed).toBe(true);
  });
});
