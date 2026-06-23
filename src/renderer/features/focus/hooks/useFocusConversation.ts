/**
 * useFocusConversation — Starts a conversation from the Focus surface.
 *
 * Creates a new session with origin='focus', sends the clean user prompt,
 * and navigates to the conversations pane. Context injection (calendar + goals)
 * happens server-side in agentTurnExecutor via the origin hint on the turn request.
 *
 * Supports both weekly and monthly variants — the session title distinguishes
 * them so FocusContextCard can show the appropriate widget.
 *
 * @see src/main/services/agentTurnExecutor.ts — server-side Focus context injection
 * @see src/core/services/focusContextAssembler.ts — context assembly logic
 */

import { useCallback } from 'react';
import { getSessionStoreState } from '../../agent-session/store/sessionStore';
import type { AnyAttachmentPayload } from '@shared/types/agent';
import { fireAndForget } from '@shared/utils/fireAndForget';

type SubmitMessageFn = (
  text: string,
  source?: 'text' | 'voice',
  attachments?: AnyAttachmentPayload[],
  options?: { targetSessionId?: string; existingMessageId?: string },
) => Promise<void> | void;

export type FocusVariant = 'week' | 'month' | 'prep-remaining';

interface UseFocusConversationConfig {
  startFreshSession: () => string;
  submitQueuedMessage: SubmitMessageFn;
}

const VARIANT_TITLES: Record<FocusVariant, string> = {
  week: 'Focus: Week Planning',
  month: 'Focus: Month Review',
  'prep-remaining': 'Focus: Meeting Prep',
};

export function useFocusConversation(config: UseFocusConversationConfig) {
  const { startFreshSession, submitQueuedMessage } = config;

  const startConversation = useCallback(
    (prompt: string, variant: FocusVariant = 'week') => {
      const sessionId = startFreshSession();

      const store = getSessionStoreState();
      store.setCurrentSessionMeta({
        currentSessionTitle: VARIANT_TITLES[variant],
        currentSessionOrigin: 'focus',
      });

      const placeholder = store.addUserMessage(prompt);

      fireAndForget(submitQueuedMessage(prompt, 'text', undefined, {
        targetSessionId: sessionId,
        existingMessageId: placeholder.id,
      }), 'focusStartConversation');
    },
    [startFreshSession, submitQueuedMessage],
  );

  return { startConversation };
}
