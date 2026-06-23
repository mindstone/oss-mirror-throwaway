import { describe, expect, it } from 'vitest';
import {
  decideCompaction,
  DEFAULT_COMPACTION_CONFIG,
  type CompactionConfig,
  type ProviderCapabilities,
} from '../contextPolicy';

const ANTHROPIC_CAPABILITIES: ProviderCapabilities = {
  hasNativeContextEditing: true,
  hasNativeCompaction: false,
  cacheStrategy: 'ephemeral',
  cacheHeuristicTtlMs: 300_000,
  supportsImageContent: () => true,
};

const ANTHROPIC_WITH_COMPACT: ProviderCapabilities = {
  hasNativeContextEditing: true,
  hasNativeCompaction: true,
  cacheStrategy: 'ephemeral',
  cacheHeuristicTtlMs: 300_000,
  supportsImageContent: () => true,
};

const OPENAI_CAPABILITIES: ProviderCapabilities = {
  hasNativeContextEditing: false,
  hasNativeCompaction: false,
  cacheStrategy: 'implicit',
  cacheHeuristicTtlMs: 600_000,
  supportsImageContent: () => true,
};

const LOCAL_CAPABILITIES: ProviderCapabilities = {
  hasNativeContextEditing: false,
  hasNativeCompaction: false,
  cacheStrategy: 'none',
  cacheHeuristicTtlMs: 0,
  supportsImageContent: () => false,
};

const CONTEXT_WINDOW = 200_000;
const config = DEFAULT_COMPACTION_CONFIG;

describe('decideCompaction', () => {
  describe('edge cases — invalid/missing data', () => {
    it('returns none when inputTokens is 0', () => {
      const result = decideCompaction(0, CONTEXT_WINDOW, 0, config, ANTHROPIC_CAPABILITIES);
      expect(result).toEqual({ action: 'none' });
    });

    it('returns none when contextWindow is 0', () => {
      const result = decideCompaction(100_000, 0, 0, config, ANTHROPIC_CAPABILITIES);
      expect(result).toEqual({ action: 'none' });
    });

    it('returns none when inputTokens is negative', () => {
      const result = decideCompaction(-1, CONTEXT_WINDOW, 0, config, ANTHROPIC_CAPABILITIES);
      expect(result).toEqual({ action: 'none' });
    });

    it('returns none when contextWindow is negative', () => {
      const result = decideCompaction(100_000, -1, 0, config, ANTHROPIC_CAPABILITIES);
      expect(result).toEqual({ action: 'none' });
    });
  });

  describe('below threshold — no action', () => {
    it('returns none when utilization is well below 75%', () => {
      const inputTokens = 100_000; // 50%
      const result = decideCompaction(inputTokens, CONTEXT_WINDOW, 0, config, ANTHROPIC_CAPABILITIES);
      expect(result).toEqual({ action: 'none' });
    });

    it('returns none when utilization is just below 75%', () => {
      const inputTokens = 149_999; // 74.9995%
      const result = decideCompaction(inputTokens, CONTEXT_WINDOW, 0, config, ANTHROPIC_CAPABILITIES);
      expect(result).toEqual({ action: 'none' });
    });
  });

  describe('clear tool uses tier (75%–90%)', () => {
    it('returns clear_tool_uses for Anthropic at exactly 75%', () => {
      const inputTokens = 150_000; // exactly 75%
      const result = decideCompaction(inputTokens, CONTEXT_WINDOW, 0, config, ANTHROPIC_CAPABILITIES);
      expect(result).toEqual({ action: 'clear_tool_uses' });
    });

    it('returns clear_tool_uses for Anthropic at 80%', () => {
      const inputTokens = 160_000; // 80%
      const result = decideCompaction(inputTokens, CONTEXT_WINDOW, 0, config, ANTHROPIC_CAPABILITIES);
      expect(result).toEqual({ action: 'clear_tool_uses' });
    });

    it('returns clear_tool_uses for Anthropic just below 90%', () => {
      const inputTokens = 179_999; // 89.9995%
      const result = decideCompaction(inputTokens, CONTEXT_WINDOW, 0, config, ANTHROPIC_CAPABILITIES);
      expect(result).toEqual({ action: 'clear_tool_uses' });
    });

    it('returns client_prune_tool_pairs for OpenAI at 75%', () => {
      const inputTokens = 150_000;
      const result = decideCompaction(inputTokens, CONTEXT_WINDOW, 0, config, OPENAI_CAPABILITIES);
      expect(result).toEqual({ action: 'client_prune_tool_pairs' });
    });

    it('returns client_prune_tool_pairs for local models at 80%', () => {
      const inputTokens = 160_000;
      const result = decideCompaction(inputTokens, CONTEXT_WINDOW, 0, config, LOCAL_CAPABILITIES);
      expect(result).toEqual({ action: 'client_prune_tool_pairs' });
    });
  });

  describe('BTS tier (90%–95%) — cache-aware', () => {
    it('returns native_compact at 90% when provider supports native compaction', () => {
      const inputTokens = 180_000; // 90%
      const msSinceLastCall = 60_000; // 1 min — well within 5-min TTL
      const result = decideCompaction(inputTokens, CONTEXT_WINDOW, msSinceLastCall, config, ANTHROPIC_WITH_COMPACT);
      expect(result).toEqual({ action: 'native_compact' });
    });

    it('returns bts_deferred when cache is warm (Anthropic without native compaction)', () => {
      const inputTokens = 180_000; // 90%
      const msSinceLastCall = 60_000; // 1 min — well within 5-min TTL
      const result = decideCompaction(inputTokens, CONTEXT_WINDOW, msSinceLastCall, config, ANTHROPIC_CAPABILITIES);
      expect(result.action).toBe('bts_deferred');
      expect((result as { reason: string }).reason).toContain('Cache warm');
    });

    it('returns bts_immediate when cache is cold (Anthropic without native compaction, >5min)', () => {
      const inputTokens = 180_000; // 90%
      const msSinceLastCall = 400_000; // ~6.7 min — beyond 5-min TTL
      const result = decideCompaction(inputTokens, CONTEXT_WINDOW, msSinceLastCall, config, ANTHROPIC_CAPABILITIES);
      expect(result.action).toBe('bts_immediate');
      expect((result as { reason: string }).reason).toContain('Cache cold');
    });

    it('returns bts_deferred when cache is warm (OpenAI, within 10-min TTL)', () => {
      const inputTokens = 185_000; // 92.5%
      const msSinceLastCall = 300_000; // 5 min — within 10-min TTL
      const result = decideCompaction(inputTokens, CONTEXT_WINDOW, msSinceLastCall, config, OPENAI_CAPABILITIES);
      expect(result.action).toBe('bts_deferred');
    });

    it('returns bts_immediate when cache is cold (OpenAI, >10min)', () => {
      const inputTokens = 185_000;
      const msSinceLastCall = 700_000; // ~11.7 min — beyond 10-min TTL
      const result = decideCompaction(inputTokens, CONTEXT_WINDOW, msSinceLastCall, config, OPENAI_CAPABILITIES);
      expect(result.action).toBe('bts_immediate');
    });

    it('returns bts_immediate for providers with no cache (TTL=0)', () => {
      const inputTokens = 180_000; // 90%
      const msSinceLastCall = 0; // just called
      const result = decideCompaction(inputTokens, CONTEXT_WINDOW, msSinceLastCall, config, LOCAL_CAPABILITIES);
      expect(result.action).toBe('bts_immediate');
      expect((result as { reason: string }).reason).toContain('Cache cold');
    });

    it('returns bts_deferred at exactly 90% without native compaction', () => {
      const inputTokens = 180_000; // exactly 90%
      const msSinceLastCall = 1_000; // cache warm
      const result = decideCompaction(inputTokens, CONTEXT_WINDOW, msSinceLastCall, config, ANTHROPIC_CAPABILITIES);
      expect(result.action).toBe('bts_deferred');
    });
  });

  describe('emergency tier (≥95%)', () => {
    it('returns native_compact at exactly 95% when provider supports native compaction', () => {
      const inputTokens = 190_000; // exactly 95%
      const result = decideCompaction(inputTokens, CONTEXT_WINDOW, 0, config, ANTHROPIC_WITH_COMPACT);
      expect(result).toEqual({ action: 'native_compact' });
    });

    it('returns native_compact at 99% regardless of warm cache when provider supports native compaction', () => {
      const inputTokens = 198_000; // 99%
      const msSinceLastCall = 1_000; // very fresh cache
      const result = decideCompaction(inputTokens, CONTEXT_WINDOW, msSinceLastCall, config, ANTHROPIC_WITH_COMPACT);
      expect(result).toEqual({ action: 'native_compact' });
    });

    it('returns native_compact at 100% (fully saturated) when provider supports native compaction', () => {
      const inputTokens = 200_000;
      const result = decideCompaction(inputTokens, CONTEXT_WINDOW, 0, config, ANTHROPIC_WITH_COMPACT);
      expect(result).toEqual({ action: 'native_compact' });
    });

    it('returns native_compact when inputTokens exceeds contextWindow and provider supports native compaction', () => {
      const inputTokens = 250_000; // 125%
      const result = decideCompaction(inputTokens, CONTEXT_WINDOW, 0, config, ANTHROPIC_WITH_COMPACT);
      expect(result).toEqual({ action: 'native_compact' });
    });
  });

  describe('custom config overrides', () => {
    it('respects custom thresholds', () => {
      const customConfig: CompactionConfig = {
        clearToolUsesThreshold: 0.50,
        btsThreshold: 0.70,
        emergencyThreshold: 0.80,
      };

      // 55% — above custom clear threshold
      const result1 = decideCompaction(110_000, CONTEXT_WINDOW, 0, customConfig, ANTHROPIC_CAPABILITIES);
      expect(result1).toEqual({ action: 'clear_tool_uses' });

      // 75% — above custom BTS threshold
      const result2 = decideCompaction(150_000, CONTEXT_WINDOW, 500_000, customConfig, ANTHROPIC_CAPABILITIES);
      expect(result2.action).toBe('bts_immediate');

      // 85% — above custom emergency threshold
      const result3 = decideCompaction(170_000, CONTEXT_WINDOW, 0, customConfig, ANTHROPIC_CAPABILITIES);
      expect(result3.action).toBe('bts_immediate');
      expect((result3 as { reason: string }).reason).toContain('Emergency');
    });
  });

  describe('boundary values', () => {
    it('transitions correctly at each threshold boundary', () => {
      // Just below 75% → none
      const below75 = decideCompaction(149_999, CONTEXT_WINDOW, 0, config, ANTHROPIC_CAPABILITIES);
      expect(below75.action).toBe('none');

      // Exactly 75% → clear
      const at75 = decideCompaction(150_000, CONTEXT_WINDOW, 0, config, ANTHROPIC_CAPABILITIES);
      expect(at75.action).toBe('clear_tool_uses');

      // Just below 90% → clear
      const below90 = decideCompaction(179_999, CONTEXT_WINDOW, 0, config, ANTHROPIC_CAPABILITIES);
      expect(below90.action).toBe('clear_tool_uses');

      // Exactly 90% with native compaction → native_compact
      const at90warm = decideCompaction(180_000, CONTEXT_WINDOW, 1_000, config, ANTHROPIC_WITH_COMPACT);
      expect(at90warm.action).toBe('native_compact');

      // Just below 95% with native compaction → native_compact
      const below95 = decideCompaction(189_999, CONTEXT_WINDOW, 1_000, config, ANTHROPIC_WITH_COMPACT);
      expect(below95.action).toBe('native_compact');

      // Exactly 95% → native compaction
      const at95 = decideCompaction(190_000, CONTEXT_WINDOW, 1_000, config, ANTHROPIC_WITH_COMPACT);
      expect(at95.action).toBe('native_compact');
    });
  });

  describe('provider capability variations', () => {
    it('distinguishes native vs client-side pruning at clear tier', () => {
      const inputTokens = 160_000; // 80%

      const anthropicResult = decideCompaction(inputTokens, CONTEXT_WINDOW, 0, config, ANTHROPIC_CAPABILITIES);
      expect(anthropicResult.action).toBe('clear_tool_uses');

      const openaiResult = decideCompaction(inputTokens, CONTEXT_WINDOW, 0, config, OPENAI_CAPABILITIES);
      expect(openaiResult.action).toBe('client_prune_tool_pairs');
    });

    it('distinguishes native compaction from BTS fallback at emergency tier', () => {
      const inputTokens = 195_000; // 97.5%

      const withCompact = decideCompaction(inputTokens, CONTEXT_WINDOW, 0, config, ANTHROPIC_WITH_COMPACT);
      const openaiResult = decideCompaction(inputTokens, CONTEXT_WINDOW, 0, config, OPENAI_CAPABILITIES);

      expect(withCompact.action).toBe('native_compact');
      expect(openaiResult.action).toBe('bts_immediate');
    });
  });
});
