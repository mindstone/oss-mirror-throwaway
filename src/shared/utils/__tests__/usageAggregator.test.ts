import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@shared/types';
import {
  extractTurnUsage,
  aggregateSessionUsage,
  getCacheEfficiencyPercent
} from '../usageAggregator';

describe('usageAggregator', () => {
  describe('extractTurnUsage', () => {
    it('should extract usage from result event', () => {
      const events: AgentEvent[] = [
        { type: 'assistant', text: 'Hello', timestamp: 1000 },
        {
          type: 'result',
          text: 'Done',
          timestamp: 2000,
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheCreationTokens: 10,
            cacheReadTokens: 20,
            costUsd: 0.05
          }
        }
      ];

      const result = extractTurnUsage('turn-1', events);
      expect(result).toEqual({
        turnId: 'turn-1',
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 10,
        cacheReadTokens: 20,
        costUsd: 0.05,
        contextUtilization: null,
        contextWindow: null,
        timestamp: 2000
      });
    });

    it('should return null if no result event', () => {
      const events: AgentEvent[] = [{ type: 'assistant', text: 'Hello', timestamp: 1000 }];
      const result = extractTurnUsage('turn-1', events);
      expect(result).toBeNull();
    });

    it('should return null if result has no usage', () => {
      const events: AgentEvent[] = [{ type: 'result', text: 'Done', timestamp: 1000 }];
      const result = extractTurnUsage('turn-1', events);
      expect(result).toBeNull();
    });

    it('should handle null/undefined usage values', () => {
      const events: AgentEvent[] = [
        {
          type: 'result',
          text: 'Done',
          timestamp: 1000,
          usage: {
            inputTokens: null,
            outputTokens: undefined,
            costUsd: 0.01
          }
        }
      ];

      const result = extractTurnUsage('turn-1', events);
      expect(result).toEqual({
        turnId: 'turn-1',
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.01,
        contextUtilization: null,
        contextWindow: null,
        timestamp: 1000
      });
    });

    it('should extract context utilization when present', () => {
      const events: AgentEvent[] = [
        {
          type: 'result',
          text: 'Done',
          timestamp: 2000,
          usage: {
            inputTokens: 50000,
            outputTokens: 1000,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            costUsd: 0.10,
            contextUtilization: 25,
            contextWindow: 200000
          }
        }
      ];

      const result = extractTurnUsage('turn-1', events);
      expect(result).toEqual({
        turnId: 'turn-1',
        inputTokens: 50000,
        outputTokens: 1000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.10,
        contextUtilization: 25,
        contextWindow: 200000,
        timestamp: 2000
      });
    });

    it('should extract context utilization for 1M context window', () => {
      const events: AgentEvent[] = [
        {
          type: 'result',
          text: 'Done',
          timestamp: 3000,
          usage: {
            inputTokens: 100000,
            outputTokens: 5000,
            cacheCreationTokens: 10000,
            cacheReadTokens: 40000,
            costUsd: 0.50,
            contextUtilization: 15,
            contextWindow: 1000000
          }
        }
      ];

      const result = extractTurnUsage('turn-1', events);
      expect(result?.contextUtilization).toBe(15);
      expect(result?.contextWindow).toBe(1000000);
    });
  });

  describe('aggregateSessionUsage', () => {
    it('should aggregate usage across multiple turns', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [
          {
            type: 'result',
            text: '',
            timestamp: 1000,
            usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.05 }
          }
        ],
        'turn-2': [
          {
            type: 'result',
            text: '',
            timestamp: 2000,
            usage: { inputTokens: 80, outputTokens: 40, costUsd: 0.03 }
          }
        ]
      };

      const stats = aggregateSessionUsage(eventsByTurn);
      expect(stats.costUsd).toBe(0.08);
      expect(stats.inputTokens).toBe(180);
      expect(stats.outputTokens).toBe(90);
      expect(stats.turnCount).toBe(2);
    });

    it('should handle empty eventsByTurn', () => {
      const stats = aggregateSessionUsage({});
      expect(stats.costUsd).toBe(0);
      expect(stats.inputTokens).toBe(0);
      expect(stats.turnCount).toBe(0);
    });

    it('should skip turns without result events', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [
          {
            type: 'result',
            text: '',
            timestamp: 1000,
            usage: { costUsd: 0.05, inputTokens: 100, outputTokens: 50 }
          }
        ],
        'turn-2': [{ type: 'assistant', text: 'Hello', timestamp: 2000 }]
      };

      const stats = aggregateSessionUsage(eventsByTurn);
      expect(stats.costUsd).toBe(0.05);
      expect(stats.turnCount).toBe(1);
    });
  });

  describe('getCacheEfficiencyPercent', () => {
    it('should calculate cache efficiency percentage', () => {
      const stats = {
        inputTokens: 80,
        outputTokens: 50,
        cacheCreationTokens: 20,
        cacheReadTokens: 50,
        costUsd: 0.05,
        turnCount: 1
      };

      const efficiency = getCacheEfficiencyPercent(stats);
      expect(efficiency).toBe(50);
    });

    it('should return 0 when no input tokens', () => {
      const stats = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        turnCount: 0
      };

      const efficiency = getCacheEfficiencyPercent(stats);
      expect(efficiency).toBe(0);
    });
  });
});
