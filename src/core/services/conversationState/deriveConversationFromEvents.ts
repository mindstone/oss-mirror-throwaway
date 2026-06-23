import type { AgentEvent, AgentTurnMessage, MessageOrigin } from '@shared/types';

export type TurnId = string;
export type SequencedAgentEvent = AgentEvent & { seq: number; turnId: string };

export interface ConversationMessageCandidate {
  id: string;
  turnId: TurnId;
  role: 'user' | 'assistant' | 'result';
  text: string;
  isHidden?: boolean;
  messageOrigin?: MessageOrigin;
  deletedAt?: number;
}

export interface ConversationState {
  messagesByTurn: ReadonlyMap<TurnId, ReadonlyArray<AgentTurnMessage>>;
  visibleMessages: ReadonlyArray<AgentTurnMessage>;
  activeTurnId: TurnId | null;
  isBusy: boolean;
  lastError: { turnId: TurnId; message: string } | null;
}

export interface ConversationDerivationInput {
  events: SequencedAgentEvent[];
  prior: ConversationState;
}

export type ConversationEventsToMessagesAdapter = (
  events: readonly SequencedAgentEvent[],
  prior: ConversationState,
) => readonly AgentTurnMessage[] | null | undefined;

/**
 * Canonical conversation-state derivation (Stage 0.A):
 *
 * 1) `deriveConversationFromMessages` is the source of truth for visibility and
 *    message-group derivation across renderer, cloud-client, and mobile.
 * 2) `deriveConversationFromEvents` is currently a thin wrapper around an
 *    injectable `events -> messages` adapter.
 *
 * TODO(Stage 2.F): Inline the canonical events->messages reducer here once
 * agentTurnExecutor/turn reduction logic moves to core.
 *
 * Shared-package strategy (Stage 0.A option a):
 * `packages/shared/src/utils/selectVisibleMessages.ts` intentionally keeps a
 * self-contained copy of visibility logic to avoid introducing a `shared -> core`
 * dependency cycle. `scripts/check-conversation-state-parity.ts` enforces parity.
 */

const HIDDEN_PROMPT_PREFIXES = [
  '[ONBOARDING CONTEXT]',
  '[ONBOARDING STEP',
  "[WHAT'S NEW",
  '[ASK REBEL',
] as const;

const EMPTY_MESSAGES_BY_TURN: ReadonlyMap<TurnId, ReadonlyArray<AgentTurnMessage>> = new Map();
const EMPTY_VISIBLE_MESSAGES: ReadonlyArray<AgentTurnMessage> = [];

const flattenMessagesByTurn = (
  messagesByTurn: ReadonlyMap<TurnId, ReadonlyArray<AgentTurnMessage>>,
): AgentTurnMessage[] => {
  const flattened: AgentTurnMessage[] = [];
  for (const turnMessages of messagesByTurn.values()) {
    flattened.push(...turnMessages);
  }
  return flattened;
};

let eventsToMessagesAdapter: ConversationEventsToMessagesAdapter | null = null;

export function setConversationEventsToMessagesAdapter(
  adapter: ConversationEventsToMessagesAdapter,
): void {
  eventsToMessagesAdapter = adapter;
}

export function resetConversationEventsToMessagesAdapterForTests(): void {
  eventsToMessagesAdapter = null;
}

export function isMessageHidden(message: ConversationMessageCandidate): boolean {
  if (message.isHidden) return true;
  if (message.role !== 'user') return false;
  if (message.messageOrigin === 'system-continuation') return true;
  if (message.text.startsWith('<conversation_history>')) return true;
  return HIDDEN_PROMPT_PREFIXES.some(prefix => message.text.startsWith(prefix));
}

const isLiveMessage = (message: AgentTurnMessage): boolean =>
  typeof message.deletedAt !== 'number';

const buildMessagesByTurn = (
  messages: readonly AgentTurnMessage[],
): ReadonlyMap<TurnId, ReadonlyArray<AgentTurnMessage>> => {
  if (messages.length === 0) return EMPTY_MESSAGES_BY_TURN;

  const mutableByTurn = new Map<TurnId, AgentTurnMessage[]>();
  for (const message of messages) {
    const existing = mutableByTurn.get(message.turnId);
    if (existing) {
      existing.push(message);
      continue;
    }
    mutableByTurn.set(message.turnId, [message]);
  }

  return mutableByTurn;
};

const buildVisibleMessages = (
  messages: readonly AgentTurnMessage[],
): ReadonlyArray<AgentTurnMessage> => {
  if (messages.length === 0) return EMPTY_VISIBLE_MESSAGES;

  const turnsWithResult = new Set<TurnId>();
  const lastAssistantByTurn = new Map<TurnId, AgentTurnMessage>();

  for (const message of messages) {
    if (message.role === 'result') {
      turnsWithResult.add(message.turnId);
      continue;
    }
    if (message.role === 'assistant') {
      lastAssistantByTurn.set(message.turnId, message);
    }
  }

  return messages.filter((message) => {
    if (isMessageHidden(message)) return false;
    if (message.role !== 'assistant') return true;
    if (turnsWithResult.has(message.turnId)) return false;
    const lastAssistant = lastAssistantByTurn.get(message.turnId);
    return lastAssistant?.id === message.id;
  });
};

const findActiveTurnId = (
  messages: readonly AgentTurnMessage[],
): TurnId | null => {
  if (messages.length === 0) return null;

  const turnsWithResult = new Set<TurnId>();
  for (const message of messages) {
    if (message.role === 'result') {
      turnsWithResult.add(message.turnId);
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (turnsWithResult.has(message.turnId)) continue;
    return message.turnId;
  }

  return null;
};

export function deriveConversationFromMessages(
  messages: readonly AgentTurnMessage[] | null | undefined,
  prior?: ConversationState,
): ConversationState {
  const nextMessages = (messages ?? []).filter(isLiveMessage);
  const activeTurnId = findActiveTurnId(nextMessages);

  return {
    messagesByTurn: buildMessagesByTurn(nextMessages),
    visibleMessages: buildVisibleMessages(nextMessages),
    activeTurnId,
    isBusy: activeTurnId !== null,
    lastError: prior?.lastError ?? null,
  };
}

export class ConversationEventsAdapterMissingError extends Error {
  constructor(eventCount: number) {
    super(
      `deriveConversationFromEvents was called with ${eventCount} event(s) but no ` +
        'ConversationEventsToMessagesAdapter is registered. Until Stage 2.F inlines ' +
        'the events->messages reducer into core, callers MUST install an adapter via ' +
        'setConversationEventsToMessagesAdapter() OR call deriveConversationFromMessages() ' +
        'directly with the already-reduced AgentTurnMessage[].',
    );
    this.name = 'ConversationEventsAdapterMissingError';
  }
}

export function deriveConversationFromEvents(
  input: ConversationDerivationInput,
): ConversationState {
  if (eventsToMessagesAdapter === null) {
    if (input.events.length > 0) {
      throw new ConversationEventsAdapterMissingError(input.events.length);
    }
    return deriveConversationFromMessages(
      flattenMessagesByTurn(input.prior.messagesByTurn),
      input.prior,
    );
  }
  const nextMessages = eventsToMessagesAdapter(input.events, input.prior) ?? [];
  return deriveConversationFromMessages(nextMessages, input.prior);
}
