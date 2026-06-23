/**
 * Done Safety Service
 *
 * Evaluates whether a conversation is safe to auto-mark-done after turn completion.
 * Uses Haiku for fast assessment with structured JSON output.
 *
 * Safe to mark done when:
 * - Task was completed successfully
 * - No follow-up questions from the agent
 * - No errors or issues that need user attention
 *
 * NOT safe to mark done when:
 * - Agent asked a clarifying question
 * - Task failed or encountered errors
 * - Agent explicitly needs user input
 * - Response indicates uncertainty or partial completion
 */

import { AppSettings } from '@shared/types';
import { callWithModelAuthAware, CodexDisconnectedBtsError } from './behindTheScenesClient';
import { resolveBtsModel } from '@shared/utils/btsModelResolver';
import { safeJsonParseFromModelText } from '@shared/utils/safeJsonParse';
import { createScopedLogger } from '@core/logger';
import { getRawPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';

const logger = createScopedLogger({ service: 'doneSafetyService' });

export interface DoneSafetyResult {
  safeToMarkDone: boolean;
  reason: string;
}

export interface DoneSafetyRequest {
  lastUserMessage: string;
  responseText: string;
}

export const DONE_SAFETY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    safeToMarkDone: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['safeToMarkDone', 'reason'],
  additionalProperties: false,
} as const;

/**
 * Truncate response text using head+tail strategy.
 * Preserves the beginning (context) and end (conclusion) of the response.
 */
function truncateResponse(text: string, headChars = 500, tailChars = 1500): string {
  if (text.length <= headChars + tailChars) {
    return text;
  }
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  return `${head}\n\n[... middle truncated for brevity ...]\n\n${tail}`;
}

// NOTE: Prompt is reproduced in evals/done-safety.ts — update both when changing
const DONE_SAFETY_PROMPT = `You are evaluating whether a conversation task was ACTUALLY COMPLETED, not just attempted.

The user wants completed tasks filed away automatically — but ONLY when the task is truly done. If the task slips through incomplete, the user loses track of it. Err on the side of keeping it visible.

<user_message>
{{user_message}}
</user_message>

<assistant_response>
{{response_text}}
</assistant_response>

Evaluate whether this conversation is SAFE TO MARK DONE based on these criteria:

SAFE to mark done (safeToMarkDone: true):
- The task was completed successfully: the requested action was EXECUTED, not just prepared
- A clear, complete answer was provided to a question
- Conversational pleasantries like "let me know if you need anything else" do NOT count as needing input — these are safe

NOT safe to mark done (safeToMarkDone: false):
- The assistant DRAFTED something but is waiting for user approval/confirmation before executing (e.g., "Ready to post?", "Say the word", "Want me to send this?", "Shall I proceed?")
- The assistant asked a clarifying question that must be answered before proceeding
- The task failed or encountered an error the user must address
- The response is clearly incomplete (e.g., "I'll continue..." or work was cut short)
- The user asked for something to be DONE (sent, posted, submitted, filed, scheduled) but the assistant only PREPARED it (drafted, wrote, composed) without executing

CRITICAL DISTINCTION: "Here's the draft, ready to send?" is NOT done. "Sent." or "Posted." or "Done." IS done. The difference between preparing and executing is the key signal.

Respond with JSON only:
{
  "safeToMarkDone": boolean,
  "reason": "brief explanation (1 sentence)"
}`;

/**
 * Evaluate whether a conversation is safe to auto-mark-done.
 *
 * @param settings - App settings containing auth credentials and model preferences
 * @param request - The last user message and response text to evaluate
 * @param signal - Optional abort signal for cancellation
 * @returns Safety evaluation result (fail-closed: defaults to not safe on error)
 */
export async function evaluateDoneSafety(
  settings: AppSettings,
  request: DoneSafetyRequest,
  signal?: AbortSignal
): Promise<DoneSafetyResult> {
  const { lastUserMessage, responseText } = request;

  const truncatedResponse = truncateResponse(responseText);

  const prompt = getRawPrompt(PROMPT_IDS.SAFETY_DONE_EVALUATION)
    .replace('{{user_message}}', lastUserMessage.slice(0, 1000))
    .replace('{{response_text}}', truncatedResponse);

  try {
    const response = await callWithModelAuthAware(
      settings,
      resolveBtsModel(settings, 'done-safety'),
      {
        codexConnectivity: resolveCodexConnectivity(),
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 128,
        outputFormat: {
          type: 'json_schema',
          schema: DONE_SAFETY_JSON_SCHEMA,
        },
        timeout: 5000,
        signal,
      },
      { category: 'done-safety' }
    );

    const content = response.content?.[0];
    if (content?.type === 'text' && content.text) {
      const parsed = safeJsonParseFromModelText<DoneSafetyResult>(
        content.text,
        'doneSafety.evaluate',
        logger
      );

      if (parsed && typeof parsed.safeToMarkDone === 'boolean') {
        logger.info(
          { safeToMarkDone: parsed.safeToMarkDone, reason: parsed.reason },
          'Done safety evaluation complete'
        );
        return {
          safeToMarkDone: parsed.safeToMarkDone,
          reason: parsed.reason || 'Evaluation complete',
        };
      }
    }

    logger.warn({ response }, 'Failed to parse done safety response');
    return {
      safeToMarkDone: false,
      reason: 'Safety evaluation failed to parse - keeping conversation visible',
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      logger.debug('Done safety evaluation aborted');
      return {
        safeToMarkDone: false,
        reason: 'Check skipped — keeping conversation visible',
      };
    }

    if (error instanceof CodexDisconnectedBtsError) {
      logger.error(
        { reason: 'codex-profile-bts-blocked', caller: 'doneSafety' },
        'Done safety BTS blocked'
      );
    } else {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, 'Done safety evaluation failed');
    }
    return {
      safeToMarkDone: false,
      reason: 'Safety evaluation failed - keeping conversation visible',
    };
  }
}
