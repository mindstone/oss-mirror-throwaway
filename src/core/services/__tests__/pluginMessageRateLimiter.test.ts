import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkMessageRateLimit,
  recordMessageCall,
  _resetForTesting,
} from '../pluginMessageRateLimiter';

describe('pluginMessageRateLimiter', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('allows first call', () => {
    const result = checkMessageRateLimit('plugin-1');
    expect(result.allowed).toBe(true);
  });

  it('allows up to 5 calls per minute', () => {
    for (let i = 0; i < 5; i++) {
      recordMessageCall('plugin-1');
    }
    const result = checkMessageRateLimit('plugin-1');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('allows exactly 5 calls', () => {
    for (let i = 0; i < 4; i++) {
      recordMessageCall('plugin-1');
    }
    expect(checkMessageRateLimit('plugin-1').allowed).toBe(true);

    recordMessageCall('plugin-1');
    expect(checkMessageRateLimit('plugin-1').allowed).toBe(false);
  });

  it('rate limits are per-plugin', () => {
    for (let i = 0; i < 5; i++) {
      recordMessageCall('plugin-1');
    }
    expect(checkMessageRateLimit('plugin-1').allowed).toBe(false);
    expect(checkMessageRateLimit('plugin-2').allowed).toBe(true);
  });

  it('_resetForTesting clears all state', () => {
    for (let i = 0; i < 5; i++) {
      recordMessageCall('plugin-1');
    }
    expect(checkMessageRateLimit('plugin-1').allowed).toBe(false);

    _resetForTesting();
    expect(checkMessageRateLimit('plugin-1').allowed).toBe(true);
  });
});
