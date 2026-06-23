import { describe, it, expect } from 'vitest';
import { getEffectiveInputTokens, ZERO_TOKEN_USAGE, type TokenUsage } from '../modelTypes';

describe('getEffectiveInputTokens', () => {
  it('returns sum of input + cacheRead + cacheCreation', () => {
    const usage: TokenUsage = {
      inputTokens: 40_000,
      outputTokens: 500,
      cacheReadTokens: 120_000,
      cacheCreationTokens: 40_000,
    };
    expect(getEffectiveInputTokens(usage)).toBe(200_000);
  });

  it('returns raw inputTokens when cache tokens are zero', () => {
    const usage: TokenUsage = {
      inputTokens: 100_000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    expect(getEffectiveInputTokens(usage)).toBe(100_000);
  });

  it('returns 0 for zero usage', () => {
    expect(getEffectiveInputTokens(ZERO_TOKEN_USAGE)).toBe(0);
  });

  it('handles high cache ratio (compaction threshold regression)', () => {
    // Regression: raw inputTokens = 40K on a 200K window looks like 20% utilized.
    // Effective tokens = 200K = 100% utilized → compaction should trigger.
    const usage: TokenUsage = {
      inputTokens: 40_000,
      outputTokens: 2000,
      cacheReadTokens: 150_000,
      cacheCreationTokens: 10_000,
    };
    const effective = getEffectiveInputTokens(usage);
    expect(effective).toBe(200_000);
    // At 200K context window, utilization is 100%
    expect(effective / 200_000).toBeGreaterThanOrEqual(0.95);
  });
});
