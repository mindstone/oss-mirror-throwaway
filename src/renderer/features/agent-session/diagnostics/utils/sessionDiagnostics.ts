import { TURN_ID_FALLBACK } from '@renderer/constants';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import { extractTurnUsage, getCacheEfficiencyPercent } from '@shared/utils/usageAggregator';
import { formatCostCompact, formatTokenCount } from '@shared/utils/usageFormatters';
import { safeParseDetail } from '../../utils/safeParseDetail';

export type SessionContextWindowMode = string;

export type SessionDiagnosticsStats = {
  turnCount: number;
  totalDurationMs: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  contextWindowMode: SessionContextWindowMode;
  errorCount: number;
  modelName: string;
  isCompacted: boolean;
  cacheEfficiencyPercent: number;
};

const isTrackedTurnId = (turnId: string | null | undefined): turnId is string =>
  Boolean(turnId) && turnId !== TURN_ID_FALLBACK;

const resolveContextWindowMode = (modes: Set<string>): SessionContextWindowMode => {
  if (modes.size === 0) {
    return '—';
  }
  if (modes.size === 1) {
    return Array.from(modes)[0];
  }
  return 'Mixed';
};

const resolveModelName = (models: Set<string>): string => {
  if (models.size === 0) {
    return '—';
  }
  if (models.size === 1) {
    return Array.from(models)[0];
  }
  return 'Mixed';
};

const computeSessionDurationMs = (
  eventsByTurn: Record<string, AgentEvent[]>,
  messages: AgentTurnMessage[]
): number => {
  let minTimestamp = Number.POSITIVE_INFINITY;
  let maxTimestamp = Number.NEGATIVE_INFINITY;

  for (const [turnId, events] of Object.entries(eventsByTurn)) {
    if (!isTrackedTurnId(turnId)) continue;
    for (const event of events) {
      minTimestamp = Math.min(minTimestamp, event.timestamp);
      maxTimestamp = Math.max(maxTimestamp, event.timestamp);
    }
  }

  if (Number.isFinite(minTimestamp) && Number.isFinite(maxTimestamp)) {
    return Math.max(0, maxTimestamp - minTimestamp);
  }

  for (const message of messages) {
    minTimestamp = Math.min(minTimestamp, message.createdAt);
    maxTimestamp = Math.max(maxTimestamp, message.createdAt);
  }

  if (Number.isFinite(minTimestamp) && Number.isFinite(maxTimestamp)) {
    return Math.max(0, maxTimestamp - minTimestamp);
  }

  return 0;
};

const collectTurnIds = (
  eventsByTurn: Record<string, AgentEvent[]>,
  messages: AgentTurnMessage[]
): Set<string> => {
  const turnIds = new Set<string>();

  for (const [turnId, events] of Object.entries(eventsByTurn)) {
    if (!isTrackedTurnId(turnId) || events.length === 0) {
      continue;
    }
    turnIds.add(turnId);
  }

  for (const message of messages) {
    if (isTrackedTurnId(message.turnId)) {
      turnIds.add(message.turnId);
    }
  }

  return turnIds;
};

/**
 * Detect whether a session has compacted events.
 *
 * Compaction (eventCompaction.ts) replaces tool details with '' or path-only JSON,
 * strips assistant text, and drops status/context_overflow/compaction_* events.
 * We detect compaction by checking for empty assistant text or empty/path-only tool details.
 */
const detectCompactedSession = (
  eventsByTurn: Record<string, AgentEvent[]>
): boolean => {
  for (const events of Object.values(eventsByTurn)) {
    // Compaction drops status events — if a turn has result but no status events, likely compacted
    const hasResult = events.some((e) => e.type === 'result');
    const hasAssistant = events.some((e) => e.type === 'assistant');

    // Compacted assistant events have text === ''
    if (hasResult && hasAssistant) {
      const emptyAssistant = events.some((e) => e.type === 'assistant' && e.text === '');
      if (emptyAssistant) return true;
    }

    for (const event of events) {
      if (event.type === 'tool' && event.stage === 'end') {
        // Empty detail = compacted non-file tool
        if (event.detail === '') return true;
        // Path-only JSON = compacted file tool (e.g. '{"file_path":"/foo/bar.ts"}')
        if (isPathOnlyDetail(event.detail)) return true;
      }
    }
  }

  return false;
};

/**
 * Check if a tool detail string is a path-only JSON stub from compaction.
 * Compaction replaces file tool details with minimal JSON containing only the path.
 */
function isPathOnlyDetail(detail: string): boolean {
  if (!detail.startsWith('{')) return false;
  // A path-only compaction stub is tiny; over-budget / malformed detail is, by
  // definition, not one — so a guarded parse failure maps to `false`.
  const parsed = safeParseDetail(detail);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
    return false;
  }
  const keys = Object.keys(parsed.value);
  return keys.length === 1 && (keys[0] === 'file_path' || keys[0] === 'path' || keys[0] === 'filePath');
}

export const computeSessionStats = (
  eventsByTurn: Record<string, AgentEvent[]>,
  messages: AgentTurnMessage[]
): SessionDiagnosticsStats => {
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let errorCount = 0;

  const models = new Set<string>();
  const contextModes = new Set<string>();

  for (const [turnId, events] of Object.entries(eventsByTurn)) {
    if (!isTrackedTurnId(turnId) || events.length === 0) {
      continue;
    }

    const usage = extractTurnUsage(turnId, events);
    if (usage) {
      totalCostUsd += usage.costUsd;
      totalInputTokens += usage.inputTokens;
      totalOutputTokens += usage.outputTokens;
      totalCacheReadTokens += usage.cacheReadTokens;
      totalCacheWriteTokens += usage.cacheCreationTokens;

      if (usage.contextWindow != null) {
        contextModes.add(usage.contextWindow >= 1_000_000 ? '1M' : `${Math.round(usage.contextWindow / 1000)}K`);
      }
    }

    for (const event of events) {
      if (event.type === 'result') {
        const model = event.model?.trim();
        if (model) {
          models.add(model);
        }
      }

      if (event.type === 'error') {
        errorCount += 1;
      }

      if (event.type === 'tool' && event.stage === 'end' && event.isError) {
        errorCount += 1;
      }
    }
  }

  const turnCount = collectTurnIds(eventsByTurn, messages).size;
  const cacheEfficiencyPercent = getCacheEfficiencyPercent({
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheCreationTokens: totalCacheWriteTokens,
    cacheReadTokens: totalCacheReadTokens,
    costUsd: totalCostUsd,
    turnCount
  });

  return {
    turnCount,
    totalDurationMs: computeSessionDurationMs(eventsByTurn, messages),
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    contextWindowMode: resolveContextWindowMode(contextModes),
    errorCount,
    modelName: resolveModelName(models),
    isCompacted: detectCompactedSession(eventsByTurn),
    cacheEfficiencyPercent
  };
};

export const formatSessionCost = (costUsd: number): string => formatCostCompact(costUsd);

export const formatSessionTokensInOut = (inputTokens: number, outputTokens: number): string =>
  `${formatTokenCount(inputTokens)} / ${formatTokenCount(outputTokens)}`;

export const formatSessionCacheTokens = (cacheReadTokens: number, cacheWriteTokens: number): string =>
  `${formatTokenCount(cacheReadTokens)} / ${formatTokenCount(cacheWriteTokens)}`;
