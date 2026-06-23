/**
 * Filters conversation messages to show only user-relevant ones.
 *
 * NOTE(Stage 0.A): this file intentionally mirrors
 * `src/core/services/conversationState/deriveConversationFromEvents.ts`.
 * We keep a local copy to avoid a dependency inversion (`shared -> core`).
 * Drift is guarded by `scripts/check-conversation-state-parity.ts`.
 *
 * Hides machine-authored system continuations (`messageOrigin` and legacy
 * `<conversation_history>` prefix) and onboarding / What's New / Ask Rebel
 * prompts.
 *
 * Rules:
 * 1. Hide messages with `isHidden === true`
 * 2. Hide user messages starting with `<conversation_history>` (system continuation)
 * 3. Hide user messages that are system-initiated prompts (onboarding, What's New, etc.)
 * 4. For turns that have a `result` message: hide all assistant messages in that turn
 * 5. For turns without a `result`: keep only the LAST assistant message
 */

/** Minimal message shape required for visibility filtering. */
export interface VisibleMessageCandidate {
  id: string;
  turnId: string;
  role: 'user' | 'assistant' | 'result';
  text: string;
  isHidden?: boolean;
  messageOrigin?: 'user-typed' | 'queue-drain' | 'system-continuation' | 'voice' | 'automation';
  deletedAt?: number;
}

const HIDDEN_PROMPT_PREFIXES = [
  '[ONBOARDING CONTEXT]',
  '[ONBOARDING STEP',
  "[WHAT'S NEW",
  '[ASK REBEL',
];

/**
 * Check if a message should be hidden from the conversation view.
 * Checks isHidden flag, `<conversation_history>` prefix (legacy safety net),
 * and onboarding/system bracket prefixes.
 */
function isLiveMessage(message: VisibleMessageCandidate): boolean {
  return typeof message.deletedAt !== 'number';
}

export function isMessageHidden(message: VisibleMessageCandidate): boolean {
  if (message.isHidden) return true;
  if (message.role === 'user') {
    if (message.messageOrigin === 'system-continuation') return true;
    if (message.text.startsWith('<conversation_history>')) return true;
    return HIDDEN_PROMPT_PREFIXES.some(prefix => message.text.startsWith(prefix));
  }
  return false;
}

/**
 * Filters messages to show only relevant ones in the conversation view.
 * - Hides messages with isHidden flag
 * - Hides system-initiated prompts (onboarding, What's New feature intros, etc.)
 * - Shows all other user messages
 * - Shows all result messages
 * - For assistant messages: only shows the last one per turn (if no result exists for that turn)
 *
 * This prevents showing intermediate assistant messages that were later replaced by a result,
 * and hides detailed system instructions from the user view.
 */
export function selectVisibleMessages<T extends VisibleMessageCandidate>(messages: T[]): T[] {
  if (!messages || messages.length === 0) return messages ?? [];
  const liveMessages = messages.filter(isLiveMessage);
  if (liveMessages.length === 0) return [];

  const turnsWithResult = new Set<string>();
  const lastAssistantByTurn = new Map<string, T>();

  for (const message of liveMessages) {
    if (message.role === 'result') {
      turnsWithResult.add(message.turnId);
    } else if (message.role === 'assistant') {
      lastAssistantByTurn.set(message.turnId, message);
    }
  }

  return liveMessages.filter((message) => {
    if (isMessageHidden(message)) return false;

    if (message.role === 'assistant') {
      if (turnsWithResult.has(message.turnId)) return false;
      const lastAssistant = lastAssistantByTurn.get(message.turnId);
      return lastAssistant ? lastAssistant.id === message.id : false;
    }
    return true;
  });
}
