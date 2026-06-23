import type { AgentSession } from '@shared/types';
import type { CompanionQAEntry } from './meetingSessionTypes';

export interface CompanionSessionAccessors {
  getSession: (id: string) => Promise<AgentSession | null>;
  upsertSession: (session: AgentSession) => Promise<void>;
}

export interface CompanionQaLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
  debug(data: Record<string, unknown>, message: string): void;
}

export function extractCompanionQAPairs(companionSession: AgentSession | null | undefined): CompanionQAEntry[] | undefined {
  if (!companionSession) return undefined;

  const messages = companionSession.messages ?? [];
  const qaEntries: CompanionQAEntry[] = [];

  // Walk messages in order, pairing user questions with assistant answers.
  // Move-not-improve: consecutive user messages pair with the same next assistant.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;

    const userText = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (!userText) continue;

    // Look for the next assistant message as the answer
    let answerText = '';
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j]?.role === 'assistant') {
        answerText = typeof messages[j]?.text === 'string'
          ? messages[j].text.trim()
          : '';
        break;
      }
    }

    if (answerText) {
      qaEntries.push({ question: userText, answer: answerText });
    }
  }

  if (qaEntries.length === 0) return undefined;
  return qaEntries;
}

/**
 * Extract Q&A history from a companion session (Ask Rebel during meeting).
 * Returns alternating user question / assistant answer pairs.
 * Returns undefined when no companion session exists or it has no Q&A.
 */
export async function extractCompanionQAHistory(
  companionSessionId: string | undefined,
  deps: CompanionSessionAccessors,
  log: CompanionQaLogger,
): Promise<CompanionQAEntry[] | undefined> {
  if (!companionSessionId) return undefined;

  try {
    const companionSession = await deps.getSession(companionSessionId);
    if (!companionSession) {
      log.debug({ companionSessionId }, 'Companion session not found for Q&A extraction');
      return undefined;
    }

    const qaEntries = extractCompanionQAPairs(companionSession);
    if (!qaEntries) return undefined;

    log.info({ companionSessionId, qaCount: qaEntries.length }, 'Extracted companion Q&A history for analysis');
    return qaEntries;
  } catch (err) {
    log.warn({
      companionSessionId,
      error: err instanceof Error ? err.message : String(err),
    }, 'Failed to extract companion Q&A history (non-blocking)');
    return undefined;
  }
}

/**
 * Clean up empty companion sessions — if the companion session has 0 successful
 * assistant messages after the meeting ends, mark it hidden (soft-deleted).
 * This prevents orphan sessions cluttering the conversations list.
 */
export async function cleanupEmptyCompanionSession(
  companionSessionId: string | undefined,
  deps: CompanionSessionAccessors,
  log: CompanionQaLogger,
): Promise<void> {
  if (!companionSessionId) return;

  try {
    const companionSession = await deps.getSession(companionSessionId);
    if (!companionSession) return;

    const messages = companionSession.messages ?? [];
    const hasAssistantMessages = messages.some((message) => message.role === 'assistant');

    if (!hasAssistantMessages) {
      log.info({ companionSessionId }, 'Marking empty companion session as hidden (0 assistant messages)');

      await deps.upsertSession({
        ...companionSession,
        deletedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  } catch (err) {
    log.warn({
      companionSessionId,
      error: err instanceof Error ? err.message : String(err),
    }, 'Failed to clean up empty companion session (non-blocking)');
  }
}
