/**
 * Conversation Summary Service
 *
 * Generates comprehensive summaries for conversation mentions using Claude Haiku.
 * Used when @-mentioning a past conversation to provide structured context.
 * Emphasis is on completeness over brevity.
 */

import type { AppSettings, AgentSession } from '@shared/types';
import type { ConversationSummary } from '@shared/ipc/schemas/sessions';
import { ConversationSummarySchema } from '@shared/ipc/schemas/sessions';
import { z } from 'zod';
import { createScopedLogger } from '@core/logger';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { hasValidAuth } from '../utils/authEnvUtils';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';
import { createUseCaseClient, type UseCaseClientSpec } from './bts/clients/useCaseClient';

const log = createScopedLogger({ service: 'conversationSummary' });

/** Maximum transcript size in characters (~100k tokens leaving room for prompt/output) */
const MAX_TRANSCRIPT_CHARS = 350_000;

/** Timeout for summary generation (30s for comprehensive processing) */
const SUMMARY_TIMEOUT_MS = 30_000;

/** Maximum output tokens for the summary response */
const SUMMARY_MAX_TOKENS = 4096;

/**
 * JSON schema for structured output.
 */
export const ConversationSummaryWireSchema = z.object({
  overview: z.string().describe('Thorough overview of the conversation'),
  userIntent: z.string().describe('The user\'s original goal and how intent evolved'),
  currentStatus: z.string().describe('Where things ended: completed, in progress, remaining'),
  keyDecisions: z
    .array(z.string())
    .describe('All important decisions, conclusions, and user intent'),
  openQuestions: z
    .array(z.string())
    .describe('Unresolved questions, pending decisions, areas needing follow-up'),
  gotchasAndInsights: z
    .array(z.string())
    .describe('Warnings, surprises, edge cases, learnings'),
  resourcesMentioned: z
    .array(z.string())
    .describe('Skills, files, URLs, or tools referenced — quoted verbatim'),
});

export type ConversationSummaryWireOutput = z.infer<typeof ConversationSummaryWireSchema>;

export const conversationSummaryUseCaseSpec = {
  name: 'conversationSummary',
  category: 'metadata',
  outputSchema: ConversationSummaryWireSchema,
  // Wire schema is intentionally stricter than parse schema today (7 required
  // fields on the wire vs optional userIntent/currentStatus/openQuestions when
  // parsing). Reconciling this drift is a tracked follow-up.
  parseSchema: ConversationSummarySchema,
  buildPrompt: ({ transcript }) => ({
    codexConnectivity: resolveCodexConnectivity(),
    messages: [{ role: 'user', content: transcript }],
    system: getPrompt(PROMPT_IDS.CONVERSATION_SUMMARY),
    maxTokens: SUMMARY_MAX_TOKENS,
    timeout: SUMMARY_TIMEOUT_MS,
  }),
  parseTextToJson: ({ text }) => {
    try {
      return JSON.parse(text);
    } catch (error) {
      // Parse failures intentionally map to null so the caller can return a
      // non-throwing null summary; the log.warn above makes the swallow observable.
      log.warn({ err: error, responseText: text.slice(0, 200) }, 'Failed to parse summary JSON');
      return null;
    }
  },
  buildInvalidStructureDetail: ({ issues }) => {
    log.warn({ errors: issues }, 'Summary response validation failed');
    return undefined;
  },
} satisfies UseCaseClientSpec<{ transcript: string }, ConversationSummaryWireOutput, ConversationSummary>;

const conversationSummaryClient = createUseCaseClient(conversationSummaryUseCaseSpec);

/**
 * Format session messages into a transcript for the summary prompt.
 * Includes compaction summaries for older context and all messages.
 * Only truncates if conversation exceeds generous limit.
 */
export function formatTranscriptForSummary(session: AgentSession): string {
  // Filter out 'result' role messages (these are tool outputs, already summarized in context)
  const messages = session.messages.filter((m) => m.role !== 'result');

  let transcript = '';

  // Include compaction summaries if available (for very long conversations)
  if (session.compactionBoundaries?.length) {
    transcript += '## Earlier Context (Previously Summarized)\n';
    for (const boundary of session.compactionBoundaries) {
      transcript += boundary.summary + '\n\n';
    }
    transcript += '---\n\n';
  }

  // Include all messages - we want full context
  transcript += '## Full Conversation\n\n';
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const label = msg.role === 'user' ? 'User' : 'Assistant';
    transcript += `[Turn ${i + 1}] ${label}:\n${msg.text}\n\n`;
  }

  // Tail-biased truncation: keep initial context + recent context (most valuable for "picking up")
  // Per Review #3 consensus: recent context is typically more relevant for continuation
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    const INITIAL_CONTEXT_CHARS = 100_000;  // ~25k tokens for initial context
    const TAIL_CONTEXT_CHARS = MAX_TRANSCRIPT_CHARS - INITIAL_CONTEXT_CHARS;  // ~62.5k tokens for recent
    
    log.warn(
      {
        sessionId: session.id,
        originalLength: transcript.length,
      },
      'Conversation exceeds 350k chars, using tail-biased truncation'
    );
    
    const head = transcript.slice(0, INITIAL_CONTEXT_CHARS);
    const tail = transcript.slice(-TAIL_CONTEXT_CHARS);
    transcript = head + '\n\n[...middle of conversation truncated...]\n\n' + tail;
  }

  return transcript;
}

/**
 * Parse and validate the LLM response into a ConversationSummary.
 */
export function parseSummaryResponse(responseText: string): ConversationSummary | null {
  try {
    const parsed = JSON.parse(responseText);
    const result = ConversationSummarySchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    log.warn({ errors: result.error.issues }, 'Summary response validation failed');
    return null;
  } catch (error) {
    log.warn({ err: error, responseText: responseText.slice(0, 200) }, 'Failed to parse summary JSON');
    return null;
  }
}

/**
 * Generate a comprehensive summary for a conversation.
 *
 * Uses Claude Haiku via callBehindTheScenes for structured JSON output.
 * Requires an API key (OAuth-only users will get null gracefully).
 *
 * Note: privateMode sessions are NOT blocked from summarization. The conversation content
 * was already sent to Anthropic during the original interaction. Private mode only affects
 * tool safety levels and memory write approvals, not LLM access to conversation content.
 * This matches the behavior of conversationTitleService.ts.
 *
 * @returns The generated summary, or null if generation fails or no API key
 */
export async function generateConversationSummary(
  settings: AppSettings,
  session: AgentSession
): Promise<ConversationSummary | null> {
  // Gracefully return null if no valid auth
  if (!hasValidAuth(settings)) {
    log.debug('No valid auth available for summary generation, skipping');
    return null;
  }

  // Empty conversation check
  if (!session.messages || session.messages.length === 0) {
    log.debug({ sessionId: session.id }, 'Session has no messages, skipping summary generation');
    return null;
  }

  const transcript = formatTranscriptForSummary(session);

  try {
    log.debug(
      {
        sessionId: session.id,
        transcriptLength: transcript.length,
        messageCount: session.messages.length,
      },
      'Generating conversation summary'
    );

    const result = await conversationSummaryClient.run(
      settings,
      { transcript },
      { tracking: { outcomePolicy: 'turn_bearing' } },
    );

    if (result.kind === 'success') {
      const summary = result.value;
      log.debug(
        {
          sessionId: session.id,
          overviewLength: summary.overview.length,
          decisionCount: summary.keyDecisions.length,
        },
        'Generated conversation summary'
      );
      return summary;
    }

    log.warn({ response: result.response }, 'Haiku returned empty or invalid summary response');
    return null;
  } catch (error) {
    // Handle abort/timeout gracefully
    if (error instanceof Error && error.name === 'AbortError') {
      log.warn({ sessionId: session.id }, 'Conversation summary generation timed out');
      return null;
    }

    log.error({ err: error, sessionId: session.id }, 'Failed to generate conversation summary');
    captureKnownCondition(
      'bts_summary_failure',
      { sessionId: session.id },
      error instanceof Error ? error : undefined,
    );
    return null;
  }
}
