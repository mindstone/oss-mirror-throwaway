/**
 * Conversation History Service
 *
 * Reconstructs conversation history from persisted session data for injection
 * into agent turns when the session is lost (auth switch, app restart, etc.).
 *
 * @see docs/plans/260330_strengthen_de_electronification.md — migrated from src/main/services/ (Stage 2c)
 */

import type { AgentSession, AgentTurnMessage, AppSettings } from '@shared/types';
import type { TurnSessionLogger } from '@core/logger';
import { getIncrementalSessionStore } from './incrementalSessionStore';
import { generateIntelligentSummary } from './compactionService';
import { getSettings } from './settingsStore';
import { sanitizeTaskContext } from '../utils/compactionUtils';

/**
 * Maximum character budget for injected conversation history.
 * Roughly ~25k tokens, leaving ample room for the system prompt, user message,
 * and attachments within a 200k context window.
 */
export const MAX_CONVERSATION_HISTORY_CHARS = 100_000;

/**
 * Extract eligible messages from a session, applying compaction boundary
 * slicing and filtering. Pure function shared between basic and intelligent paths.
 */
export function prepareEligibleMessages(session: AgentSession): AgentTurnMessage[] {
  if (!session.messages?.length || session.messages.length <= 1) return [];

  let messagesToInclude = session.messages;
  const boundaries = session.compactionBoundaries;
  if (boundaries?.length) {
    const lastBoundaryIndex = Math.max(...boundaries.map((b) => b.afterMessageIndex));
    if (lastBoundaryIndex >= 0 && lastBoundaryIndex < session.messages.length) {
      messagesToInclude = session.messages.slice(lastBoundaryIndex + 1);
    }
  }

  // Hidden messages with 'system-continuation' origin carry legitimate LLM context
  // (AskUserQuestion answers, approval receipts, memory/staged-tool receipts) and
  // must stay visible to the model during disk-based history recovery. Other hidden
  // messages (legacy, no origin stamp) remain excluded.
  return messagesToInclude.filter(
    (m) => (m.role === 'user' || m.role === 'assistant' || m.role === 'result') &&
      m.text?.trim() &&
      !m.isWarning &&
      (!m.isHidden || m.messageOrigin === 'system-continuation')
  );
}

/**
 * Build a conversation history string from a persisted session's messages.
 * Uses `prepareEligibleMessages` for filtering, then formats and truncates.
 */
export function buildConversationHistoryContext(session: AgentSession): string {
  const eligible = prepareEligibleMessages(session);
  if (eligible.length === 0) return '';

  const contextMessages = eligible
    .map((m) => {
      const role = m.role === 'result' ? 'assistant' : m.role;
      let content = m.text;

      if (m.attachmentTexts && m.role === 'user') {
        const attachmentBlocks = Object.entries(m.attachmentTexts)
          .map(([name, text]) => `[Attached document: ${name}]\n${text}`)
          .join('\n\n');
        content = `${content}\n\n${attachmentBlocks}`;
      }

      return `[${role}]: ${content}`;
    })
    .join('\n\n');

  if (!contextMessages) return '';

  let body = contextMessages;
  if (body.length > MAX_CONVERSATION_HISTORY_CHARS) {
    body = body.slice(-MAX_CONVERSATION_HISTORY_CHARS);
    // Snap to the next message boundary so we don't start with a partial message
    const firstBoundary = body.indexOf('\n\n[');
    if (firstBoundary > 0 && firstBoundary < 500) {
      body = body.slice(firstBoundary + 2);
    }
    body = '...(earlier messages truncated)...\n\n' + body;
  }

  return `<conversation_history>\nThe following is the conversation history from this session. Continue from where we left off.\n\n${body}\n</conversation_history>\n\n`;
}

/**
 * Load conversation history context from the renderer's persisted session store.
 * Returns the formatted history string, or empty string if unavailable.
 *
 * When `resetConversation` is true (e.g. user edited a message), history injection
 * is skipped because the renderer already truncated the conversation and embedded
 * any necessary prior context directly in the prompt.
 *
 * KNOWN LIMITATION: This reads from disk, but the renderer's session persistence is
 * debounced (~300ms via requestIdleCallback). If a fallback path calls this shortly
 * after the renderer mutated state, the disk snapshot may be slightly stale (missing
 * the most recent message). This is acceptable because:
 * - The current user prompt is always included regardless of history context.
 * - The primary context path uses session resume, not this function.
 * - This only runs when the session is lost or auth context switches.
 * If this ever becomes a real problem, the clean fix is to pass conversation messages
 * in the IPC turn request payload so the main process never needs to read from disk.
 */
export async function loadConversationHistory(
  rendererSessionId: string | null,
  turnLogger: TurnSessionLogger | undefined,
  label: string,
  resetConversation?: boolean
): Promise<string> {
  if (!rendererSessionId) return '';
  if (resetConversation) {
    turnLogger?.debug(`Skipping conversation history for ${label} (resetConversation=true)`);
    return '';
  }
  try {
    const store = getIncrementalSessionStore();
    const session = await store.getSession(rendererSessionId);
    if (!session) return '';
    const historyContext = buildConversationHistoryContext(session);
    if (historyContext) {
      const userCount = session.messages.filter((m) => m.role === 'user' && !m.isHidden).length;
      const resultCount = session.messages.filter((m) => m.role === 'result').length;
      const boundaryCount = session.compactionBoundaries?.length ?? 0;
      turnLogger?.info(
        { messageCount: session.messages.length, userCount, resultCount, boundaryCount, contextLength: historyContext.length },
        `Rebuilt conversation context for ${label}${boundaryCount > 0 ? ' (compaction-aware: post-boundary messages only)' : ''}`
      );
    }
    return historyContext;
  } catch (err) {
    turnLogger?.warn({ err }, `Failed to load session for ${label} context`);
    return '';
  }
}

/** Timeout for the entire intelligent history injection path (ms). */
const INTELLIGENT_INJECTION_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// DI for loadIntelligentConversationHistory
// ---------------------------------------------------------------------------

export interface LoadIntelligentConversationHistoryDeps {
  getIncrementalSessionStore: typeof getIncrementalSessionStore;
  generateIntelligentSummary: typeof generateIntelligentSummary;
  getSettings: typeof getSettings;
}

const defaultLoadIntelligentConversationHistoryDeps: LoadIntelligentConversationHistoryDeps = {
  getIncrementalSessionStore,
  generateIntelligentSummary,
  getSettings,
};

/**
 * Load conversation history using intelligent compaction (BTS summarization).
 * Used for risky resume where basic front-truncation would lose critical context.
 *
 * Falls back to basic `buildConversationHistoryContext()` on any failure.
 */
export async function loadIntelligentConversationHistory(
  rendererSessionId: string,
  turnLogger: TurnSessionLogger | undefined,
  resetConversation?: boolean,
  deps: LoadIntelligentConversationHistoryDeps = defaultLoadIntelligentConversationHistoryDeps,
): Promise<string> {
  if (resetConversation) {
    turnLogger?.debug('Skipping intelligent history injection (resetConversation=true)');
    return '';
  }

  let session: AgentSession | null = null;
  try {
    session = await deps.getIncrementalSessionStore().getSession(rendererSessionId);
    if (!session) return '';

    const eligible = prepareEligibleMessages(session);
    if (eligible.length === 0) return '';

    // Extract task context from the first user message (for BTS compression guidance)
    const firstUserMessage = eligible.find((m) => m.role === 'user');
    const taskContext = sanitizeTaskContext(
      firstUserMessage?.text ?? 'conversation continuation'
    ).slice(0, 500);

    // Wrap the entire intelligent path in a timeout
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Intelligent history injection timed out')), INTELLIGENT_INJECTION_TIMEOUT_MS)
    );

    const settings: AppSettings = deps.getSettings();

    const result = await Promise.race([
      deps.generateIntelligentSummary(eligible, { settings, taskContext, depth: 1 }),
      timeoutPromise,
    ]);

    // Format the result
    const parts: string[] = [];
    if (result.olderSummary) {
      parts.push('--- Earlier context (summarized) ---\n' + result.olderSummary);
    }
    if (result.recentMessages.length > 0) {
      const recentFormatted = result.recentMessages
        .map((m) => {
          const role = m.role === 'result' ? 'assistant' : m.role;
          let content = m.text;
          if (m.attachmentTexts && m.role === 'user') {
            const attachmentBlocks = Object.entries(m.attachmentTexts)
              .map(([name, text]) => `[Attached document: ${name}]\n${text}`)
              .join('\n\n');
            content = `${content}\n\n${attachmentBlocks}`;
          }
          return `[${role}]: ${content}`;
        })
        .join('\n\n');
      parts.push('--- Recent turns ---\n' + recentFormatted);
    }

    if (parts.length === 0) {
      turnLogger?.warn('Intelligent summary returned empty — falling back to basic history');
      return buildConversationHistoryContext(session);
    }

    const body = parts.join('\n\n');
    const boundaryCount = session.compactionBoundaries?.length ?? 0;
    turnLogger?.info(
      {
        eligibleCount: eligible.length,
        olderSummaryLength: result.olderSummary.length,
        recentCount: result.recentMessages.length,
        bodyLength: body.length,
        boundaryCount,
      },
      'Intelligent history injection succeeded'
    );

    return `<conversation_history>\nThe following is the conversation history from this session, with older context intelligently summarized. Continue from where we left off.\n\n${body}\n</conversation_history>\n\n`;
  } catch (err) {
    turnLogger?.warn(
      { err },
      'Intelligent history injection failed — falling back to basic history'
    );
    // Fallback to basic history (already loaded session if available)
    if (session) {
      return buildConversationHistoryContext(session);
    }
    return loadConversationHistory(rendererSessionId, turnLogger, 'intelligent-fallback', resetConversation);
  }
}
