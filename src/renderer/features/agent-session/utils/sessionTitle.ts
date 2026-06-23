import type { AgentTurnMessage } from '@shared/types';

export const createSessionTitle = (
  messages: AgentTurnMessage[],
  fallbackIndex: number
): string => {
  const findFirstMessage = (role: AgentTurnMessage['role']) =>
    messages.find((message) => message.role === role && message.text.trim().length > 0);

  const firstUserMessage = findFirstMessage('user');
  if (firstUserMessage) {
    const trimmed = firstUserMessage.text.trim().replace(/\s+/g, ' ');
    return trimmed.length > 54 ? `${trimmed.slice(0, 54).trim()}…` : trimmed;
  }

  const firstAssistantMessage = messages.find(
    (message) => message.role !== 'user' && message.text.trim().length > 0
  );
  if (firstAssistantMessage) {
    const trimmed = firstAssistantMessage.text.trim().replace(/\s+/g, ' ');
    return trimmed.length > 54 ? `${trimmed.slice(0, 54).trim()}…` : trimmed;
  }

  return `Conversation ${fallbackIndex}`;
};
