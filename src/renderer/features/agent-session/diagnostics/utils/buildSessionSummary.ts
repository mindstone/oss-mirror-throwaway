import { TURN_ID_FALLBACK } from '@renderer/constants';
import { createMessageSnippet } from '@renderer/utils/formatters';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import { extractTurnUsage, getCacheEfficiencyPercent } from '@shared/utils/usageAggregator';
import type { InsightTurnSummary } from '../../work-surface/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContextUtilizationLevel = 'low' | 'medium' | 'high' | 'unknown';

export type TurnDigest = {
  turnId: string;
  turnNumber: number;
  userMessageSnippet: string;
  toolCallCount: number;
  errorCount: number;
  durationMs: number;
  costUsd: number;
  hasErrors: boolean;
  modelName: string | null;
};

export type SessionSummary = {
  overview: {
    turnCount: number;
    totalDurationMs: number;
    totalCostUsd: number;
  };
  turnDigests: TurnDigest[];
  keyFindings: {
    longestTurn: { turnNumber: number; durationMs: number } | null;
    mostExpensiveTurn: { turnNumber: number; costUsd: number } | null;
    mostToolHeavyTurn: { turnNumber: number; toolCalls: number } | null;
    totalErrors: number;
    hasFallbacks: boolean;
    hasCompaction: boolean;
  };
  efficiency: {
    cacheEfficiencyPercent: number;
    contextUtilizationTrend: ContextUtilizationLevel[];
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isTrackedTurnId = (turnId: string | null | undefined): turnId is string =>
  Boolean(turnId) && turnId !== TURN_ID_FALLBACK;

export const classifyContextUtilization = (
  pct: number | null | undefined
): ContextUtilizationLevel => {
  if (pct == null) return 'unknown';
  if (pct < 33) return 'low';
  if (pct <= 66) return 'medium';
  return 'high';
};

const countToolCalls = (events: AgentEvent[]): number => {
  // Prefer toolMetrics from result event (always preserved even in compacted sessions).
  for (const event of events) {
    if (event.type === 'result' && event.toolMetrics) {
      return event.toolMetrics.totalToolCalls;
    }
  }
  // Fall back to counting tool start events.
  return events.filter((e) => e.type === 'tool' && e.stage === 'start').length;
};

const countErrors = (events: AgentEvent[]): number => {
  let count = 0;
  for (const event of events) {
    if (event.type === 'error') count += 1;
    if (event.type === 'tool' && event.stage === 'end' && event.isError) count += 1;
  }
  return count;
};

const getModelName = (events: AgentEvent[]): string | null => {
  for (const event of events) {
    if (event.type === 'result' && event.model) return event.model;
  }
  return null;
};

const hasTurnFallbacks = (events: AgentEvent[]): boolean => {
  for (const event of events) {
    if (event.type === 'result' && event.fallbacks && event.fallbacks.length > 0) return true;
  }
  return false;
};

const hasCompactionEvents = (eventsByTurn: Record<string, AgentEvent[]>): boolean => {
  for (const events of Object.values(eventsByTurn)) {
    for (const event of events) {
      if (
        event.type === 'compaction_started' ||
        event.type === 'compaction_completed' ||
        event.type === 'recovery:started' ||
        event.type === 'recovery:succeeded'
      ) {
        return true;
      }
    }
  }
  return false;
};

const computeSessionDuration = (eventsByTurn: Record<string, AgentEvent[]>): number => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const events of Object.values(eventsByTurn)) {
    for (const event of events) {
      min = Math.min(min, event.timestamp);
      max = Math.max(max, event.timestamp);
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? Math.max(0, max - min) : 0;
};

const findUserMessageSnippet = (
  turnId: string,
  messages: AgentTurnMessage[]
): string => {
  const userMsg = messages.find((m) => m.turnId === turnId && m.role === 'user');
  if (userMsg) return createMessageSnippet(userMsg.text, 50);
  return '(no user message)';
};

/**
 * Describe the context utilization trend as a short human-readable string.
 */
export const describeContextTrend = (trend: ContextUtilizationLevel[]): string => {
  const known = trend.filter((t) => t !== 'unknown');
  if (known.length === 0) return 'No context utilization data available';

  const first = known[0];
  const last = known[known.length - 1];

  if (known.every((t) => t === first)) return `Stayed ${first} throughout`;
  return `Went from ${first} to ${last}`;
};

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build a structured session summary from raw event data.
 * Pure function — no side effects, no LLM calls.
 */
export const buildSessionSummary = (
  eventsByTurn: Record<string, AgentEvent[]>,
  messages: AgentTurnMessage[],
  turnSummaries: InsightTurnSummary[]
): SessionSummary => {
  const turnDigests: TurnDigest[] = [];
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let hasFallbacks = false;
  const contextUtilizationTrend: ContextUtilizationLevel[] = [];

  for (let i = 0; i < turnSummaries.length; i++) {
    const summary = turnSummaries[i];
    if (!isTrackedTurnId(summary.turnId)) continue;

    const events = eventsByTurn[summary.turnId] ?? [];
    const usage = extractTurnUsage(summary.turnId, events);
    const turnErrors = countErrors(events);
    const turnCost = usage?.costUsd ?? 0;

    totalCostUsd += turnCost;
    if (usage) {
      totalInputTokens += usage.inputTokens;
      totalOutputTokens += usage.outputTokens;
      totalCacheCreationTokens += usage.cacheCreationTokens;
      totalCacheReadTokens += usage.cacheReadTokens;
    }

    if (hasTurnFallbacks(events)) hasFallbacks = true;

    contextUtilizationTrend.push(classifyContextUtilization(usage?.contextUtilization));

    const durationMs = Math.max(0, summary.lastTimestamp - summary.startedAt);

    turnDigests.push({
      turnId: summary.turnId,
      turnNumber: i + 1,
      userMessageSnippet: findUserMessageSnippet(summary.turnId, messages),
      toolCallCount: countToolCalls(events),
      errorCount: turnErrors,
      durationMs,
      costUsd: turnCost,
      hasErrors: turnErrors > 0,
      modelName: getModelName(events)
    });
  }

  // --- Key findings (only meaningful with ≥2 turns to compare) ---
  let longestTurn: { turnNumber: number; durationMs: number } | null = null;
  let mostExpensiveTurn: { turnNumber: number; costUsd: number } | null = null;
  let mostToolHeavyTurn: { turnNumber: number; toolCalls: number } | null = null;
  let totalErrors = 0;

  for (const digest of turnDigests) {
    totalErrors += digest.errorCount;

    if (
      digest.durationMs > 0 &&
      (longestTurn === null || digest.durationMs > longestTurn.durationMs)
    ) {
      longestTurn = { turnNumber: digest.turnNumber, durationMs: digest.durationMs };
    }

    if (
      digest.costUsd > 0 &&
      (mostExpensiveTurn === null || digest.costUsd > mostExpensiveTurn.costUsd)
    ) {
      mostExpensiveTurn = { turnNumber: digest.turnNumber, costUsd: digest.costUsd };
    }

    if (
      digest.toolCallCount > 0 &&
      (mostToolHeavyTurn === null || digest.toolCallCount > mostToolHeavyTurn.toolCalls)
    ) {
      mostToolHeavyTurn = { turnNumber: digest.turnNumber, toolCalls: digest.toolCallCount };
    }
  }

  // Comparative findings are noise with a single turn.
  if (turnDigests.length <= 1) {
    longestTurn = null;
    mostExpensiveTurn = null;
    mostToolHeavyTurn = null;
  }

  const cacheEfficiencyPercent = getCacheEfficiencyPercent({
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheCreationTokens: totalCacheCreationTokens,
    cacheReadTokens: totalCacheReadTokens,
    costUsd: totalCostUsd,
    turnCount: turnDigests.length
  });

  return {
    overview: {
      turnCount: turnDigests.length,
      totalDurationMs: computeSessionDuration(eventsByTurn),
      totalCostUsd
    },
    turnDigests,
    keyFindings: {
      longestTurn,
      mostExpensiveTurn,
      mostToolHeavyTurn,
      totalErrors,
      hasFallbacks,
      hasCompaction: hasCompactionEvents(eventsByTurn)
    },
    efficiency: {
      cacheEfficiencyPercent,
      contextUtilizationTrend
    }
  };
};
