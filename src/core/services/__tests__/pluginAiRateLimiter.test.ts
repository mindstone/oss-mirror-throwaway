import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { checkRateLimit, recordCall, _resetForTesting } from '../pluginAiRateLimiter';

describe('pluginAiRateLimiter', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows the first call for a new plugin', () => {
    const result = checkRateLimit('test-plugin');
    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBeUndefined();
  });

  it('allows up to 10 calls within the window', () => {
    const pluginId = 'test-plugin';
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit(pluginId).allowed).toBe(true);
      recordCall(pluginId);
    }
  });

  it('blocks the 11th call within the window', () => {
    const pluginId = 'test-plugin';
    for (let i = 0; i < 10; i++) {
      recordCall(pluginId);
    }

    const result = checkRateLimit(pluginId);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeDefined();
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(60000);
  });

  it('allows calls again after the window expires', () => {
    const pluginId = 'test-plugin';
    for (let i = 0; i < 10; i++) {
      recordCall(pluginId);
    }

    expect(checkRateLimit(pluginId).allowed).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(61000);

    const result = checkRateLimit(pluginId);
    expect(result.allowed).toBe(true);
  });

  it('tracks rate limits independently per plugin', () => {
    // Fill up plugin-a
    for (let i = 0; i < 10; i++) {
      recordCall('plugin-a');
    }

    expect(checkRateLimit('plugin-a').allowed).toBe(false);
    expect(checkRateLimit('plugin-b').allowed).toBe(true);
  });

  it('uses a sliding window (older entries expire first)', () => {
    const pluginId = 'test-plugin';

    // Record 5 calls at T=0
    for (let i = 0; i < 5; i++) {
      recordCall(pluginId);
    }

    // Advance 30s and record 5 more calls
    vi.advanceTimersByTime(30000);
    for (let i = 0; i < 5; i++) {
      recordCall(pluginId);
    }

    // All 10 are within the window — should be blocked
    expect(checkRateLimit(pluginId).allowed).toBe(false);

    // Advance 31s more (total 61s from first batch) — first 5 expire
    vi.advanceTimersByTime(31000);

    // Now only 5 calls in the window — should be allowed
    const result = checkRateLimit(pluginId);
    expect(result.allowed).toBe(true);
  });

  it('returns retryAfterMs relative to oldest entry expiry', () => {
    const pluginId = 'test-plugin';

    // Record 10 calls at T=0
    for (let i = 0; i < 10; i++) {
      recordCall(pluginId);
    }

    // Advance 30s
    vi.advanceTimersByTime(30000);

    const result = checkRateLimit(pluginId);
    expect(result.allowed).toBe(false);
    // The oldest entry was at T=0, window is 60s, so it expires at T=60s
    // We're at T=30s, so retryAfterMs should be ~30s
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(29000);
    expect(result.retryAfterMs).toBeLessThanOrEqual(31000);
  });

  it('_resetForTesting clears all state', () => {
    recordCall('plugin-a');
    recordCall('plugin-b');

    _resetForTesting();

    expect(checkRateLimit('plugin-a').allowed).toBe(true);
    expect(checkRateLimit('plugin-b').allowed).toBe(true);
  });
});
