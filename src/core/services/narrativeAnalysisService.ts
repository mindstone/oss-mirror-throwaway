/**
 * Narrative Analysis Service
 *
 * Generates a structured "conversation autopsy" using Claude Haiku.
 * Identifies waste, inefficiency, and provides an efficiency verdict
 * for the diagnostics Narrative tab.
 *
 * Follows the same pattern as conversationSummaryService.ts.
 */

import type { AppSettings, AgentSession, AgentEvent } from '@shared/types';
import type { NarrativeAnalysis } from '@shared/ipc/schemas/sessions';
import { NarrativeAnalysisSchema } from '@shared/ipc/schemas/sessions';
import { extractTurnUsage } from '@shared/utils/usageAggregator';
import { createScopedLogger } from '@core/logger';
import { callBehindTheScenesWithAuth } from './behindTheScenesClient';
import { hasValidAuth } from '../utils/authEnvUtils';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';

const log = createScopedLogger({ service: 'narrativeAnalysis' });

/** Timeout for narrative analysis generation (45s for comprehensive processing) */
const ANALYSIS_TIMEOUT_MS = 45_000;

/** Maximum output tokens for the analysis response */
const ANALYSIS_MAX_TOKENS = 4096;

/** Maximum characters for individual tool details in the transcript */
const MAX_TOOL_DETAIL_CHARS = 500;

const SYSTEM_PROMPT = `You are a conversation efficiency analyst for an AI assistant app. Analyze this conversation data and produce a structured JSON diagnosis.

You will receive:
1. A turn-by-turn breakdown with tool calls, durations, output sizes, and token usage
2. Aggregate metrics (total time, tokens, cost, context utilization)

Your job is to explain WHY this conversation took the time and resources it did, and identify specific waste.

Output JSON with these fields:
- goal: The user's actual goal (1 sentence)
- idealEstimate: { time, tokens, cost } - what this SHOULD have taken
- narrative: What actually happened (3-5 sentences, chronological, specific)
- wasteItems: Array of waste items, each with: description, category (slow_tool|redundant_call|large_output|context_bloat|sub_agent_overhead), timeWasted, tokensWasted, suggestion, turnNumber (optional)
- efficiencyScore: 0-100 (100 = perfectly efficient)
- verdict: One-sentence bottom line

Be specific and quantitative. Reference specific tool names and turn numbers. If the agent wasted time searching for files or making redundant calls, say so.`;

const ANALYSIS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string', description: 'The user\'s actual goal (1 sentence)' },
    idealEstimate: {
      type: 'object',
      properties: {
        time: { type: 'string', description: 'Ideal time estimate' },
        tokens: { type: 'string', description: 'Ideal token estimate' },
        cost: { type: 'string', description: 'Ideal cost estimate' },
      },
      required: ['time', 'tokens', 'cost'],
      additionalProperties: false,
    },
    narrative: { type: 'string', description: 'What actually happened (3-5 sentences)' },
    wasteItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          category: { type: 'string', enum: ['slow_tool', 'redundant_call', 'large_output', 'context_bloat', 'sub_agent_overhead'] },
          timeWasted: { type: 'string' },
          tokensWasted: { type: 'string' },
          suggestion: { type: 'string' },
          turnNumber: { type: 'number' },
        },
        required: ['description', 'category', 'timeWasted', 'tokensWasted', 'suggestion'],
        additionalProperties: false,
      },
    },
    efficiencyScore: { type: 'number', description: '0-100 efficiency score' },
    verdict: { type: 'string', description: 'One-sentence bottom line' },
  },
  required: ['goal', 'idealEstimate', 'narrative', 'wasteItems', 'efficiencyScore', 'verdict'],
  additionalProperties: false,
};

/**
 * Truncate a string to a max length, appending "[…N chars]" if truncated.
 */
function truncateDetail(detail: string, maxLen: number): string {
  if (!detail || detail.length <= maxLen) return detail || '';
  return `${detail.slice(0, maxLen)}[…${detail.length} chars total]`;
}

/**
 * Build a structured transcript for the narrative analysis prompt.
 * Includes tool calls, durations, output sizes, and token usage per turn.
 */
export function formatTranscriptForNarrative(session: AgentSession): string {
  const lines: string[] = [];
  const turnIds = Object.keys(session.eventsByTurn);

  // Aggregate metrics
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let maxContextUtilization = 0;
  let totalDurationMs = 0;

  for (let i = 0; i < turnIds.length; i++) {
    const turnId = turnIds[i];
    const events = session.eventsByTurn[turnId] ?? [];
    const turnNumber = i + 1;
    const usage = extractTurnUsage(turnId, events);

    // Accumulate aggregates
    if (usage) {
      totalCostUsd += usage.costUsd;
      totalInputTokens += usage.inputTokens;
      totalOutputTokens += usage.outputTokens;
      totalCacheRead += usage.cacheReadTokens;
      totalCacheWrite += usage.cacheCreationTokens;
      if (usage.contextUtilization != null && usage.contextUtilization > maxContextUtilization) {
        maxContextUtilization = usage.contextUtilization;
      }
    }

    // Calculate turn duration from first to last event timestamp
    const timestamps = events.map((e) => e.timestamp).filter(Boolean);
    const turnDurationMs = timestamps.length >= 2
      ? Math.max(...timestamps) - Math.min(...timestamps)
      : 0;
    totalDurationMs += turnDurationMs;

    lines.push(`\n--- Turn ${turnNumber} (${turnDurationMs > 0 ? `${(turnDurationMs / 1000).toFixed(1)}s` : 'N/A'}) ---`);

    // Token usage for this turn
    if (usage) {
      const totalTurnTokens = usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
      lines.push(`Tokens: ${totalTurnTokens} total (in: ${usage.inputTokens}, out: ${usage.outputTokens}, cache_read: ${usage.cacheReadTokens}, cache_write: ${usage.cacheCreationTokens}) | Cost: $${usage.costUsd.toFixed(4)}`);
      if (usage.contextUtilization != null) {
        lines.push(`Context utilization: ${usage.contextUtilization}%`);
      }
    }

    // Extract user/assistant messages
    for (const event of events) {
      if (event.type === 'assistant') {
        lines.push(`[Assistant]: ${truncateDetail(event.text ?? '', 300)}`);
      }
    }

    // Extract tool calls with timing
    const toolStarts = new Map<string, Extract<AgentEvent, { type: 'tool' }>>();
    for (const event of events) {
      if (event.type === 'tool') {
        const id = event.toolUseId ?? `synthetic-${event.toolName}-${event.timestamp}`;
        if (event.stage === 'start') {
          toolStarts.set(id, event);
        } else {
          const startEvent = toolStarts.get(id);
          const durationMs = startEvent ? event.timestamp - startEvent.timestamp : null;
          const outputChars = event.detail?.length ?? 0;

          // Recover from archive if compacted
          let outputDetail = event.detail ?? '';
          const archived = session.toolDetailArchive?.[id];
          if (archived) {
            outputDetail = archived.output || outputDetail;
          }

          const durationStr = durationMs != null ? `${(durationMs / 1000).toFixed(1)}s` : 'N/A';
          const errorStr = event.isError ? ' [ERROR]' : '';
          lines.push(`  [Tool] ${event.toolName}: duration=${durationStr}, output=${outputChars} chars${errorStr}`);
          if (outputDetail && outputChars > 5000) {
            lines.push(`    Output preview: ${truncateDetail(outputDetail, MAX_TOOL_DETAIL_CHARS)}`);
          }
          toolStarts.delete(id);
        }
      }
    }
  }

  // Prepend aggregate summary
  const header = [
    '## Conversation Metrics',
    `Total turns: ${turnIds.length}`,
    `Total duration: ${(totalDurationMs / 1000).toFixed(1)}s`,
    `Total tokens: ${totalInputTokens + totalOutputTokens + totalCacheRead + totalCacheWrite} (in: ${totalInputTokens}, out: ${totalOutputTokens}, cache_read: ${totalCacheRead}, cache_write: ${totalCacheWrite})`,
    `Total cost: $${totalCostUsd.toFixed(4)}`,
    `Max context utilization: ${maxContextUtilization}%`,
    '',
    '## Turn-by-Turn Breakdown',
  ];

  return header.join('\n') + '\n' + lines.join('\n');
}

/**
 * Parse and validate the LLM response into a NarrativeAnalysis.
 */
export function parseNarrativeResponse(responseText: string): NarrativeAnalysis | null {
  try {
    const parsed = JSON.parse(responseText);
    const result = NarrativeAnalysisSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    log.warn({ errors: result.error.issues }, 'Narrative analysis response validation failed');
    return null;
  } catch (error) {
    log.warn({ err: error, responseText: responseText.slice(0, 200) }, 'Failed to parse narrative analysis JSON');
    return null;
  }
}

/**
 * Generate a narrative analysis for a conversation.
 *
 * Uses Claude Haiku via callBehindTheScenes for structured JSON output.
 * Requires an API key (OAuth-only users will get null gracefully).
 *
 * @returns The generated analysis, or null if generation fails or no API key
 */
export async function generateNarrativeAnalysis(
  settings: AppSettings,
  session: AgentSession
): Promise<NarrativeAnalysis | null> {
  if (!hasValidAuth(settings)) {
    log.debug('No valid auth available for narrative analysis, skipping');
    return null;
  }

  if (!session.eventsByTurn || Object.keys(session.eventsByTurn).length === 0) {
    log.debug({ sessionId: session.id }, 'Session has no events, skipping narrative analysis');
    return null;
  }

  const transcript = formatTranscriptForNarrative(session);

  try {
    log.debug(
      {
        sessionId: session.id,
        transcriptLength: transcript.length,
        turnCount: Object.keys(session.eventsByTurn).length,
      },
      'Generating narrative analysis'
    );

    const response = await callBehindTheScenesWithAuth(
      settings,
      {
        codexConnectivity: resolveCodexConnectivity(),
        messages: [{ role: 'user', content: transcript }],
        system: getPrompt(PROMPT_IDS.INTELLIGENCE_NARRATIVE_ANALYSIS),
        maxTokens: ANALYSIS_MAX_TOKENS,
        timeout: ANALYSIS_TIMEOUT_MS,
        outputFormat: { type: 'json_schema', schema: ANALYSIS_JSON_SCHEMA },
      },
      { category: 'metadata' }
    );

    const content = response.content?.[0];
    if (content?.type === 'text' && content.text) {
      const analysis = parseNarrativeResponse(content.text);
      if (analysis) {
        log.debug(
          {
            sessionId: session.id,
            efficiencyScore: analysis.efficiencyScore,
            wasteItemCount: analysis.wasteItems.length,
          },
          'Generated narrative analysis'
        );
        return analysis;
      }
    }

    log.warn({ response }, 'Haiku returned empty or invalid narrative analysis response');
    return null;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      log.warn({ sessionId: session.id }, 'Narrative analysis generation timed out');
      return null;
    }

    log.error({ err: error, sessionId: session.id }, 'Failed to generate narrative analysis');
    return null;
  }
}
