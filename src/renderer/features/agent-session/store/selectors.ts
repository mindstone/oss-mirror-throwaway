import {
  deriveConversationFromMessages,
  isMessageHidden as isCoreMessageHidden,
} from '@core/services/conversationState';
import type { AgentTurnMessage } from '@shared/types';

export function isMessageHidden(message: AgentTurnMessage): boolean {
  return isCoreMessageHidden(message);
}

export function selectVisibleMessages(messages: AgentTurnMessage[]): AgentTurnMessage[] {
  return [...deriveConversationFromMessages(messages).visibleMessages];
}
