import { describe, expect, it } from 'vitest';
import type { AgentTurnMessage } from '@shared/types';
import { selectVisibleMessages, isMessageHidden } from '../selectors';

function msg(
  overrides: Partial<AgentTurnMessage> & Pick<AgentTurnMessage, 'id' | 'turnId' | 'role'>,
): AgentTurnMessage {
  return { text: '', createdAt: Date.now(), ...overrides };
}

describe('shouldHideMessage (via selectVisibleMessages)', () => {
  describe('isHidden flag', () => {
    it('hides messages with isHidden: true', () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: 'hello', isHidden: true }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'hi' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['2']);
    });
  });

  describe('messageOrigin-based hiding', () => {
    it('hides user-role message with messageOrigin: system-continuation regardless of text', () => {
      const messages = [
        msg({
          id: '1',
          turnId: 't1',
          role: 'user',
          text: 'Totally normal user text',
          messageOrigin: 'system-continuation',
        }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'response' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['2']);
    });

    it('does NOT hide assistant-role message with messageOrigin: system-continuation', () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: 'hello' }),
        msg({
          id: '2',
          turnId: 't1',
          role: 'assistant',
          text: 'response',
          messageOrigin: 'system-continuation',
        }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['1', '2']);
    });

    it('does NOT hide user-role with a different origin and no matching prefix', () => {
      const messages = [
        msg({
          id: '1',
          turnId: 't1',
          role: 'user',
          text: 'A regular typed message',
          messageOrigin: 'user-typed',
        }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'ok' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['1', '2']);
    });
  });

  describe('<conversation_history> prefix hiding (legacy safety net)', () => {
    it('hides user-role message starting with <conversation_history>', () => {
      const messages = [
        msg({
          id: '1',
          turnId: 't1',
          role: 'user',
          text: '<conversation_history>\n...context...\n</conversation_history>\n\nThe user answered your questions: ...',
        }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'continuing' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['2']);
    });

    it('does NOT hide assistant-role message with <conversation_history> text', () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: 'hello' }),
        msg({
          id: '2',
          turnId: 't1',
          role: 'assistant',
          text: '<conversation_history>some text</conversation_history>',
        }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['1', '2']);
    });
  });

  describe('false-positive safety net', () => {
    it('does NOT hide "The user answered your question yesterday" (no prose prefix matching)', () => {
      const messages = [
        msg({
          id: '1',
          turnId: 't1',
          role: 'user',
          text: 'The user answered your question yesterday and wants follow-up',
        }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'ok' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['1', '2']);
    });

    it('does NOT hide "The user chose to skip" as a legitimate user message', () => {
      const messages = [
        msg({
          id: '1',
          turnId: 't1',
          role: 'user',
          text: 'The user chose to skip your questions because they were irrelevant',
        }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'ok' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['1', '2']);
    });
  });

  describe('onboarding prefix hiding (preserved)', () => {
    it('hides user messages with [ONBOARDING CONTEXT] prefix', () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: '[ONBOARDING CONTEXT] setup' }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'welcome' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['2']);
    });

    it('hides user messages with [ASK REBEL prefix', () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: '[ASK REBEL help me' }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'sure' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['2']);
    });
  });
});

describe('isMessageHidden', () => {
  it('returns true for isHidden flag', () => {
    expect(isMessageHidden(msg({ id: '1', turnId: 't1', role: 'user', text: 'hi', isHidden: true }))).toBe(true);
  });

  it('returns true for system-continuation origin', () => {
    expect(isMessageHidden(msg({
      id: '1', turnId: 't1', role: 'user', text: 'normal text', messageOrigin: 'system-continuation',
    }))).toBe(true);
  });

  it('returns true for <conversation_history> prefix', () => {
    expect(isMessageHidden(msg({
      id: '1', turnId: 't1', role: 'user', text: '<conversation_history>\ncontext\n</conversation_history>',
    }))).toBe(true);
  });

  it('returns true for onboarding prefix', () => {
    expect(isMessageHidden(msg({
      id: '1', turnId: 't1', role: 'user', text: '[ONBOARDING CONTEXT] hello',
    }))).toBe(true);
  });

  it('returns false for a regular user message', () => {
    expect(isMessageHidden(msg({
      id: '1', turnId: 't1', role: 'user', text: 'Just a normal question',
    }))).toBe(false);
  });

  it('returns false for assistant messages regardless of content', () => {
    expect(isMessageHidden(msg({
      id: '1', turnId: 't1', role: 'assistant', text: '<conversation_history>echo</conversation_history>',
    }))).toBe(false);
  });
});
