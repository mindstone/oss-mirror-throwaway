import { afterEach, describe, expect, it } from 'vitest';
import {
  ConversationEventsAdapterMissingError,
  deriveConversationFromEvents,
  deriveConversationFromMessages,
  resetConversationEventsToMessagesAdapterForTests,
  setConversationEventsToMessagesAdapter,
  type ConversationState,
  type SequencedAgentEvent,
} from '../index';
import type { AgentTurnMessage } from '@shared/types';

const makeEmptyPrior = (): ConversationState => deriveConversationFromMessages([]);

const makeMessage = (overrides: Partial<AgentTurnMessage> & Pick<AgentTurnMessage, 'id' | 'turnId' | 'role' | 'text'>): AgentTurnMessage =>
  ({ messageOrigin: 'user-typed', ...overrides }) as AgentTurnMessage;

afterEach(() => {
  resetConversationEventsToMessagesAdapterForTests();
});

describe('deriveConversationFromEvents (Stage 0.A)', () => {
  it('throws ConversationEventsAdapterMissingError when called with events and no adapter', () => {
    const events = [
      { seq: 1, turnId: 't1', type: 'user_message' } as unknown as SequencedAgentEvent,
    ];

    expect(() =>
      deriveConversationFromEvents({ events, prior: makeEmptyPrior() }),
    ).toThrowError(ConversationEventsAdapterMissingError);
  });

  it('does not throw when called with an empty event stream and no adapter', () => {
    expect(() =>
      deriveConversationFromEvents({ events: [], prior: makeEmptyPrior() }),
    ).not.toThrow();
  });

  it('delegates to the registered adapter when one is installed', () => {
    const reducedMessage = makeMessage({
      id: 'm1',
      turnId: 't1',
      role: 'user',
      text: 'hello',
    });
    setConversationEventsToMessagesAdapter(() => [reducedMessage]);

    const events = [
      { seq: 1, turnId: 't1', type: 'user_message' } as unknown as SequencedAgentEvent,
    ];

    const next = deriveConversationFromEvents({ events, prior: makeEmptyPrior() });

    expect(next.visibleMessages.map(message => message.id)).toEqual(['m1']);
  });
});
