import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import {
  formatCostApprox,
  formatCostCompact,
  formatTokenCount,
  formatUsage,
} from '../usageFormatters';

describe('usageFormatters', () => {
  describe('formatCostCompact', () => {
    it('returns em dash for nullish and zero values', () => {
      expect(formatCostCompact(undefined)).toBe('—');
      expect(formatCostCompact(null)).toBe('—');
      expect(formatCostCompact(0)).toBe('—');
    });

    it('formats sub-cent, cent-level, dollar-level, and large values', () => {
      expect(formatCostCompact(0.009)).toBe('<1¢');
      expect(formatCostCompact(0.05)).toBe('5¢');
      expect(formatCostCompact(1.5)).toBe('$1.50');
      expect(formatCostCompact(1234.567)).toBe('$1234.57');
    });
  });

  describe('formatTokenCount', () => {
    it('formats values across key boundaries', () => {
      expect(formatTokenCount(0)).toBe('0');
      expect(formatTokenCount(999)).toBe('999');
      expect(formatTokenCount(1000)).toBe('1.0k');
      expect(formatTokenCount(1500)).toBe('1.5k');
      expect(formatTokenCount(1000000)).toBe('1.0M');
    });
  });

  describe('formatCostApprox', () => {
    it('returns em dash for nullish and zero values', () => {
      expect(formatCostApprox(undefined)).toBe('—');
      expect(formatCostApprox(null)).toBe('—');
      expect(formatCostApprox(0)).toBe('—');
    });

    it('formats sub-cent, cent-level, dollar-level, and large values with approximation prefix', () => {
      expect(formatCostApprox(0.009)).toBe('c. <1¢');
      expect(formatCostApprox(0.05)).toBe('c. 5¢');
      expect(formatCostApprox(1.5)).toBe('c. $1.50');
      expect(formatCostApprox(1234.567)).toBe('c. $1234.57');
    });
  });

  describe('formatUsage', () => {
    it('returns empty string for non-result events or missing usage', () => {
      const assistantEvent: AgentEvent = { type: 'assistant', text: 'hi', timestamp: 1 };
      const resultWithoutUsage: AgentEvent = { type: 'result', text: 'done', timestamp: 2 };

      expect(formatUsage(assistantEvent)).toBe('');
      expect(formatUsage(resultWithoutUsage)).toBe('');
    });

    it('formats usage with tokens, cost, and context utilization', () => {
      const resultEvent: AgentEvent = {
        type: 'result',
        text: 'done',
        timestamp: 1,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationTokens: 10,
          cacheReadTokens: 20,
          costUsd: 0.1234,
          contextUtilization: 42,
          contextWindow: 200000,
        },
      };

      expect(formatUsage(resultEvent)).toBe(
        'in: 100 · out: 50 · cache+: 10 · cache✓: 20 · $0.1234 · ctx: 42% of 200K',
      );
    });

    it('handles context window details when cost/tokens are omitted', () => {
      const oneMillionWindow: AgentEvent = {
        type: 'result',
        text: 'done',
        timestamp: 1,
        usage: {
          contextWindow: 1000000,
        },
      };
      const standardWindowWithUtilization: AgentEvent = {
        type: 'result',
        text: 'done',
        timestamp: 2,
        usage: {
          contextWindow: 200000,
          contextUtilization: 0,
        },
      };

      expect(formatUsage(oneMillionWindow)).toBe('ctx: 1M');
      expect(formatUsage(standardWindowWithUtilization)).toBe('ctx: 0% of 200K');
    });
  });
});
