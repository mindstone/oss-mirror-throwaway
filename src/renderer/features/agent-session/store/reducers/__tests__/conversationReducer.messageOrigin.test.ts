import { describe, it, expect } from 'vitest';
import { addUserMessage, assignTurnIdToMessage } from '../conversationReducer';
import type { ConversationStateShape } from '../conversationReducer';

const makeBaseState = (): ConversationStateShape => ({
  messages: [],
  eventsByTurn: {},
  activeTurnId: null,
  focusedTurnId: null,
  isBusy: false,
  lastError: null,
  lastErrorSource: null,
  terminatedTurnIds: new Set(),
});

describe('addUserMessage messageOrigin', () => {
  it('sets messageOrigin on the created message when provided', () => {
    const state = makeBaseState();
    const { message } = addUserMessage(state, 'hello', undefined, {
      messageOrigin: 'queue-drain',
    });

    expect(message.messageOrigin).toBe('queue-drain');
    expect(message.role).toBe('user');
    expect(message.text).toBe('hello');
  });

  it('leaves messageOrigin undefined when not provided', () => {
    const state = makeBaseState();
    const { message } = addUserMessage(state, 'hello');

    expect(message.messageOrigin).toBeUndefined();
  });

  it('preserves messageOrigin in the returned state messages', () => {
    const state = makeBaseState();
    const { state: nextState } = addUserMessage(state, 'test', undefined, {
      messageOrigin: 'voice',
    });

    expect(nextState.messages).toHaveLength(1);
    expect(nextState.messages[0].messageOrigin).toBe('voice');
  });

  it('preserves other options alongside messageOrigin', () => {
    const state = makeBaseState();
    const { message } = addUserMessage(state, 'test', undefined, {
      isHidden: true,
      attachmentTexts: { 'doc.pdf': 'extracted text' },
      messageOrigin: 'system-continuation',
    });

    expect(message.messageOrigin).toBe('system-continuation');
    expect(message.isHidden).toBe(true);
    expect(message.attachmentTexts).toEqual({ 'doc.pdf': 'extracted text' });
  });

  it('assignTurnIdToMessage sets both activeTurnId and focusedTurnId', () => {
    const state = makeBaseState();
    const { state: stateWithMessage, message } = addUserMessage(state, 'test');
    const turnId = 'turn-123';

    const nextState = assignTurnIdToMessage(stateWithMessage, message.id, turnId);

    expect(nextState.activeTurnId).toBe(turnId);
    expect(nextState.focusedTurnId).toBe(turnId);
    expect(nextState.eventsByTurn[turnId]).toEqual([]);
  });
});
