/**
 * Diagnostic Context Service
 *
 * Gathers lightweight diagnostic summaries for conversation diagnosis.
 * Provides enough context for initial analysis without overflowing context,
 * with file paths enabling the agent to fetch full details on demand.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';
import type { AgentSession, AgentEvent } from '@shared/types';
import type { DiagnosticSummary } from '@shared/ipc/schemas/sessions';
import { formatNavigationUrl } from '@shared/navigation/urlParser';
import { getIncrementalSessionStore } from './incrementalSessionStore';

const log = createScopedLogger({ service: 'diagnosticContextService' });

const PREVIEW_MAX_LENGTH = 300;
const RECENT_MESSAGES_COUNT = 5;

/**
 * Get the session logs directory path.
 * Logs are stored per-turn as: logs/sessions/<timestamp>-turn-<turnId>[-renderer-<sessionId>].log
 */
function getSessionLogsDir(): string | null {
  const logsDir = path.join(getDataPath(), 'logs', 'sessions');
  if (fs.existsSync(logsDir)) {
    return logsDir;
  }
  return null;
}

/**
 * Extract error events from a turn.
 */
function getErrorsInTurn(events: AgentEvent[]): number {
  return events.filter(e =>
    e.type === 'error' ||
    (e.type === 'status' && e.message.toLowerCase().includes('error'))
  ).length;
}

/**
 * Count tool calls and failures in a turn.
 */
function getToolMetricsFromEvents(events: AgentEvent[]): {
  calls: number;
  failures: number;
  byTool: Record<string, { calls: number; failures: number }>;
} {
  const byTool: Record<string, { calls: number; failures: number }> = {};
  let totalCalls = 0;
  let totalFailures = 0;

  for (const event of events) {
    if (event.type === 'tool') {
      const toolName = event.toolName || 'unknown';
      if (!byTool[toolName]) {
        byTool[toolName] = { calls: 0, failures: 0 };
      }
      byTool[toolName].calls++;
      totalCalls++;

      // Check for failure indicators
      const isFailure = event.isError === true;
      if (isFailure) {
        byTool[toolName].failures++;
        totalFailures++;
      }
    }
  }

  return { calls: totalCalls, failures: totalFailures, byTool };
}

/**
 * Get compaction event count from events.
 */
function getCompactionCount(eventsByTurn: Record<string, AgentEvent[]>): number {
  let count = 0;
  for (const events of Object.values(eventsByTurn)) {
    for (const event of events) {
      if (event.type === 'status' && event.message.toLowerCase().includes('compaction')) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Get max context utilization from result events.
 */
function getMaxContextUtilization(eventsByTurn: Record<string, AgentEvent[]>): number {
  let maxUtilization = 0;

  for (const events of Object.values(eventsByTurn)) {
    for (const event of events) {
      if (event.type === 'result' && event.usage) {
        const reportedUtilization = event.usage.contextUtilization;
        if (typeof reportedUtilization === 'number') {
          const utilization = reportedUtilization / 100;
          if (utilization > maxUtilization) {
            maxUtilization = utilization;
          }
          continue;
        }

        const contextWindow = event.usage.contextWindow;
        const inputTokens = event.usage.inputTokens || 0;
        if (!contextWindow || contextWindow <= 0 || inputTokens <= 0) {
          continue;
        }
        const utilization = inputTokens / contextWindow;
        if (utilization > maxUtilization) {
          maxUtilization = utilization;
        }
      }
    }
  }

  return maxUtilization;
}

/**
 * Calculate total cost from events.
 */
function getTotalCost(eventsByTurn: Record<string, AgentEvent[]>): number {
  let totalCost = 0;

  for (const events of Object.values(eventsByTurn)) {
    for (const event of events) {
      if (event.type === 'result' && event.usage?.costUsd) {
        totalCost += event.usage.costUsd;
      }
    }
  }

  return totalCost;
}

/**
 * Calculate total duration from session timestamps.
 */
function getTotalDuration(session: AgentSession): number {
  if (!session.messages.length) return 0;

  const firstMsg = session.messages[0];
  const lastMsg = session.messages[session.messages.length - 1];

  return lastMsg.createdAt - firstMsg.createdAt;
}

/**
 * Build the diagnostic summary for a session.
 */
export async function getDiagnosticSummary(sessionId: string): Promise<DiagnosticSummary | null> {
  try {
    const session = await getIncrementalSessionStore().getSession(sessionId);
    if (!session) {
      log.warn({ sessionId }, 'Session not found for diagnostic summary');
      return null;
    }

    const eventsByTurn = session.eventsByTurn || {};
    const turnIds = Object.keys(eventsByTurn);

    // Aggregate metrics across all turns
    let totalErrors = 0;
    let totalToolCalls = 0;
    let totalToolFailures = 0;
    const aggregatedByTool: Record<string, { calls: number; failures: number }> = {};

    for (const turnId of turnIds) {
      const events = eventsByTurn[turnId] || [];
      totalErrors += getErrorsInTurn(events);

      const toolMetrics = getToolMetricsFromEvents(events);
      totalToolCalls += toolMetrics.calls;
      totalToolFailures += toolMetrics.failures;

      for (const [toolName, stats] of Object.entries(toolMetrics.byTool)) {
        if (!aggregatedByTool[toolName]) {
          aggregatedByTool[toolName] = { calls: 0, failures: 0 };
        }
        aggregatedByTool[toolName].calls += stats.calls;
        aggregatedByTool[toolName].failures += stats.failures;
      }
    }

    // Build recent messages array (include 'result' role, normalized to 'assistant')
    const recentMessages = session.messages
      .slice(-RECENT_MESSAGES_COUNT)
      .filter(msg => (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'result') && !msg.isHidden)
      .map(msg => {
        const turnEvents = eventsByTurn[msg.turnId] || [];
        return {
          role: (msg.role === 'result' ? 'assistant' : msg.role) as 'user' | 'assistant',
          preview: msg.text.slice(0, PREVIEW_MAX_LENGTH),
          turnId: msg.turnId,
          hasErrors: getErrorsInTurn(turnEvents) > 0,
        };
      });

    // Find file paths for deeper investigation
    const claudeTranscript = null;
    const sessionLogsDir = getSessionLogsDir();

    // Build Rebel conversation link
    const rebelConversationLink = formatNavigationUrl({ type: 'sessions', sessionId: session.id });

    const summary: DiagnosticSummary = {
      sessionId: session.id,
      sessionTitle: session.title || 'Untitled',
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,

      turnCount: turnIds.length,
      messageCount: session.messages.length,
      totalDurationMs: getTotalDuration(session),
      totalCostUsd: getTotalCost(eventsByTurn),

      errorCount: totalErrors,
      toolFailureCount: totalToolFailures,
      compactionCount: getCompactionCount(eventsByTurn),
      maxContextUtilization: getMaxContextUtilization(eventsByTurn),

      toolMetrics: {
        totalCalls: totalToolCalls,
        byTool: aggregatedByTool,
      },

      recentMessages,

      paths: {
        claudeTranscript,
        sessionLogsDir,
      },

      rebelConversationLink,
    };

    log.debug({ sessionId, errorCount: totalErrors, toolFailureCount: totalToolFailures }, 'Built diagnostic summary');
    return summary;
  } catch (error) {
    log.error({ sessionId, err: error }, 'Error building diagnostic summary');
    return null;
  }
}
