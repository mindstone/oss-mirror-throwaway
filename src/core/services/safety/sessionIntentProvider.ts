/**
 * Session Intent Provider
 *
 * Builds an `ActionContextSessionIntent` payload from the most recent user
 * messages in a session so the safety evaluator can see sustained user intent
 * across turns. Used as the lazily-invoked supplier wired into the
 * tool-safety hook (Stage 2 / P0.7).
 *
 * Behaviour:
 * - Last 5 user messages, oldest-first.
 * - Each message truncated to 1000 chars (suffixed with U+2026 when truncated).
 * - Total budget 4000 chars; oldest messages are dropped until the budget fits.
 * - Fail-closed-soft: any error from the session store yields `null` and emits
 *   an observable warn log. Never blocks the safety eval flow.
 *
 * @see docs/plans/260526_safety_eval_context_completeness.md (Stage 2, P0.7)
 * @see safetyPromptLogic.ts — `fenceSessionIntent` and `buildEvalUserMessage`
 *      consume the payload produced here.
 */

import { createScopedLogger } from '@core/logger';
import { getIncrementalSessionStore } from '@core/services/incrementalSessionStore';
import type { ActionContextSessionIntent } from '@core/safetyPromptTypes';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

const log = createScopedLogger({ service: 'sessionIntentProvider' });

export const SESSION_INTENT_MAX_RECENT_MESSAGES = 5;
export const SESSION_INTENT_MAX_CHARS_PER_MESSAGE = 1000;
export const SESSION_INTENT_MAX_TOTAL_CHARS = 4000;

const TRUNCATION_SUFFIX = '…';

function truncateMessage(text: string): string {
  if (text.length <= SESSION_INTENT_MAX_CHARS_PER_MESSAGE) return text;
  return text.slice(0, SESSION_INTENT_MAX_CHARS_PER_MESSAGE) + TRUNCATION_SUFFIX;
}

function sumChars(messages: string[]): number {
  let total = 0;
  for (const msg of messages) total += msg.length;
  return total;
}

export async function buildSessionIntent(
  sessionId: string | undefined,
): Promise<ActionContextSessionIntent | null> {
  if (!sessionId) return null;

  try {
    const session = await getIncrementalSessionStore().getSession(sessionId);
    if (!session || !Array.isArray(session.messages) || session.messages.length === 0) {
      return null;
    }

    const userMessages: string[] = [];
    for (const msg of session.messages) {
      if (msg.role !== 'user') continue;
      if (msg.isHidden) continue;
      if (typeof msg.deletedAt === 'number') continue;
      const text = typeof msg.text === 'string' ? msg.text.trim() : '';
      if (text.length === 0) continue;
      userMessages.push(truncateMessage(text));
    }

    if (userMessages.length === 0) return null;

    const trimmed = userMessages.slice(-SESSION_INTENT_MAX_RECENT_MESSAGES);
    let totalChars = sumChars(trimmed);

    while (totalChars > SESSION_INTENT_MAX_TOTAL_CHARS && trimmed.length > 1) {
      const dropped = trimmed.shift();
      if (!dropped) break;
      const before = totalChars;
      totalChars -= dropped.length;
      log.info(
        {
          event: 'safety.session_intent_truncated',
          sessionId,
          originalChars: before,
          truncatedTo: totalChars,
        },
        'Dropped oldest user message to fit session-intent budget',
      );
    }

    if (trimmed.length === 0) return null;

    return {
      recentUserMessages: trimmed,
      totalChars,
    };
  } catch (err) {
    log.warn(
      {
        event: 'safety.session_intent_provider_error',
        err: err instanceof Error ? err.message : String(err),
        sessionId,
      },
      'Failed to build session intent — proceeding without',
    );
    ignoreBestEffortCleanup(err, {
      operation: 'safety.session_intent.build',
      reason: 'Session-store read failed; safety eval continues without recent-user-intent context.',
      severity: 'warn',
    });
    return null;
  }
}
