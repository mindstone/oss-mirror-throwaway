import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import {
  updateConversationWithEvent as updateConversation,
  cloneAgentTurnMessages,
  type ConversationStateShape
} from '@core/services/agentTurnReducer/conversation';
import { createId } from '@shared/utils/id';
import { TURN_ID_FALLBACK } from '@renderer/constants';

// C-lite (2026-04): state.activeTurnId = processing turn; state.focusedTurnId = UI focus turn (ephemeral, not persisted).
// See docs/tutorials/260430_isbusy_dual_id_state_machine_and_c_lite_fix.html.

export type { ConversationStateShape };

export const createInitialConversationState = (): ConversationStateShape => ({
  messages: [],
  eventsByTurn: {},
  activeTurnId: null,
  focusedTurnId: null,
  isBusy: false,
  lastError: null,
  lastErrorSource: null,
  terminatedTurnIds: new Set()
});

export const processEvent = (
  state: ConversationStateShape,
  turnId: string,
  event: AgentEvent
): ConversationStateShape => updateConversation(state, turnId, event);

export const addUserMessage = (
  state: ConversationStateShape,
  text: string,
  attachments?: { id: string; name: string; path: string; relativePath: string; size: number }[],
  options?: {
    isHidden?: boolean;
    attachmentTexts?: Record<string, string>;
    messageOrigin?: AgentTurnMessage['messageOrigin'];
    displayText?: string;
    triggerMeta?: import('@shared/types').MeetingCompanionTriggerMeta;
  }
): { state: ConversationStateShape; message: AgentTurnMessage } => {
  const message: AgentTurnMessage = {
    id: createId(),
    turnId: TURN_ID_FALLBACK,
    role: 'user',
    text,
    createdAt: Date.now(),
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
    isHidden: options?.isHidden,
    attachmentTexts: options?.attachmentTexts,
    messageOrigin: options?.messageOrigin,
    displayText: options?.displayText,
    triggerSource: options?.triggerMeta?.triggerSource,
    triggerSourceSpeaker: options?.triggerMeta?.triggerSourceSpeaker,
    triggeredAt: options?.triggerMeta?.triggeredAt,
    triggerExtracted: options?.triggerMeta?.triggerExtracted,
  };

  return {
    state: {
      ...state,
      messages: [...state.messages, message],
      isBusy: true,
      lastError: null,
      lastErrorSource: null
    },
    message
  };
};

export const assignTurnIdToMessage = (
  state: ConversationStateShape,
  messageId: string,
  turnId: string
): ConversationStateShape => ({
  ...state,
  messages: state.messages.map((msg) =>
    msg.id === messageId ? { ...msg, turnId } : msg
  ),
  eventsByTurn: { ...state.eventsByTurn, [turnId]: [] },
  activeTurnId: turnId,
  focusedTurnId: turnId
});

export const truncateToMessage = (
  state: ConversationStateShape,
  targetMessageId: string,
  newText: string,
  attachments?: { id: string; name: string; path: string; relativePath: string; size: number }[]
): ConversationStateShape => {
  const targetIndex = state.messages.findIndex((msg) => msg.id === targetMessageId);
  if (targetIndex === -1) return state;

  const truncatedMessages = cloneAgentTurnMessages(state.messages.slice(0, targetIndex + 1));
  const editedMessage = truncatedMessages[targetIndex];
  editedMessage.text = newText.trim();
  delete editedMessage.displayText;

  if (attachments && attachments.length > 0) {
    editedMessage.attachments = attachments;
  }

  const turnIdsToKeep = new Set(
    truncatedMessages
      .map((msg) => msg.turnId)
      .filter((turnId): turnId is string => Boolean(turnId && turnId !== TURN_ID_FALLBACK))
  );

  const truncatedEvents: Record<string, AgentEvent[]> = {};
  for (const [turnId, events] of Object.entries(state.eventsByTurn)) {
    if (turnIdsToKeep.has(turnId)) {
      truncatedEvents[turnId] = [...events];
    }
  }

  return {
    messages: truncatedMessages,
    eventsByTurn: truncatedEvents,
    activeTurnId: null,
    focusedTurnId: null,
    isBusy: true,
    lastError: null,
    lastErrorSource: null,
    terminatedTurnIds: new Set()
  };
};

export const addReceiptMessage = (
  state: ConversationStateShape,
  text: string
): ConversationStateShape => {
  const message: AgentTurnMessage = {
    id: createId(),
    turnId: createId(),
    role: 'assistant',
    text,
    createdAt: Date.now(),
    isApprovalReceipt: true,
  };
  return {
    ...state,
    messages: [...state.messages, message],
  };
};

export const resetConversation = (): ConversationStateShape => createInitialConversationState();

export const setError = (
  state: ConversationStateShape,
  error: string | null
): ConversationStateShape => ({
  ...state,
  lastError: error,
  lastErrorSource: error ? 'renderer' : null,
  isBusy: error ? false : state.isBusy
});

export const clearBusy = (state: ConversationStateShape): ConversationStateShape => ({
  ...state,
  isBusy: false,
  activeTurnId: null
});

export { cloneAgentTurnMessages };
