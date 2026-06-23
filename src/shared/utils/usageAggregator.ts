import type { AgentEvent } from '@shared/types';

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  turnCount: number;
}

export interface TurnUsage {
  turnId: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  /** Context window utilization as percentage (0-100) */
  contextUtilization: number | null;
  /** Context window size in tokens (200000 standard, 1000000 extended) */
  contextWindow: number | null;
  timestamp: number;
}

/**
 * Extract usage from a single turn's events.
 * Returns null if no result event with usage exists.
 */
export function extractTurnUsage(turnId: string, events: AgentEvent[]): TurnUsage | null {
  for (const event of events) {
    if (event.type === 'result' && event.usage) {
      return {
        turnId,
        inputTokens: event.usage.inputTokens ?? 0,
        outputTokens: event.usage.outputTokens ?? 0,
        cacheCreationTokens: event.usage.cacheCreationTokens ?? 0,
        cacheReadTokens: event.usage.cacheReadTokens ?? 0,
        costUsd: event.usage.costUsd ?? 0,
        contextUtilization: event.usage.contextUtilization ?? null,
        contextWindow: event.usage.contextWindow ?? null,
        timestamp: event.timestamp
      };
    }
  }
  return null;
}

/**
 * Aggregate usage across all turns in a session.
 * Handles null/undefined values gracefully.
 */
export function aggregateSessionUsage(
  eventsByTurn: Record<string, AgentEvent[]>
): UsageStats {
  const stats: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    turnCount: 0
  };

  for (const [turnId, events] of Object.entries(eventsByTurn)) {
    const turnUsage = extractTurnUsage(turnId, events);
    if (turnUsage) {
      stats.inputTokens += turnUsage.inputTokens;
      stats.outputTokens += turnUsage.outputTokens;
      stats.cacheCreationTokens += turnUsage.cacheCreationTokens;
      stats.cacheReadTokens += turnUsage.cacheReadTokens;
      stats.costUsd += turnUsage.costUsd;
      stats.turnCount += 1;
    }
  }

  return stats;
}

/**
 * Calculate cache efficiency as percentage.
 * Returns percentage of input tokens that were read from cache.
 */
export function getCacheEfficiencyPercent(stats: UsageStats): number {
  const totalInput = stats.inputTokens + stats.cacheCreationTokens;
  if (totalInput === 0) return 0;
  return Math.round((stats.cacheReadTokens / totalInput) * 100);
}
