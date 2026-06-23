import { describe, expect, it } from 'vitest';
import { isMessageHidden, selectVisibleMessages, type VisibleMessageCandidate } from '../selectVisibleMessages';

/** Helper to create a minimal test message. */
function msg(
  overrides: Partial<VisibleMessageCandidate> & Pick<VisibleMessageCandidate, 'id' | 'turnId' | 'role'>,
): VisibleMessageCandidate {
  return { text: '', ...overrides };
}

describe('selectVisibleMessages', () => {
  it('returns empty array for empty input', () => {
    expect(selectVisibleMessages([])).toEqual([]);
  });

  it('returns empty array for null/undefined input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(selectVisibleMessages(null as any)).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(selectVisibleMessages(undefined as any)).toEqual([]);
  });

  describe('isHidden filtering', () => {
    it('hides messages with isHidden: true', () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: 'hello' }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'hi', isHidden: true }),
        msg({ id: '3', turnId: 't2', role: 'user', text: 'bye' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['1', '3']);
    });

    it('keeps messages with isHidden: false', () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: 'hi', isHidden: false }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'hello' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['1', '2']);
    });
  });

  describe('hidden prompt prefix filtering', () => {
    it('hides user messages starting with [ONBOARDING CONTEXT]', () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: '[ONBOARDING CONTEXT] some setup text' }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'Welcome!' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['2']);
    });

    it('hides user messages starting with [ONBOARDING STEP', () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: '[ONBOARDING STEP 3] Do the thing' }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'Done!' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['2']);
    });

    it("hides user messages starting with [WHAT'S NEW", () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: "[WHAT'S NEW v2.5] Check out these features" }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'Cool features!' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['2']);
    });

    it('hides user messages starting with [ASK REBEL', () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: '[ASK REBEL help with something' }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'Sure!' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['2']);
    });

    it('does NOT hide assistant messages with prefix-like text', () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: 'hello' }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: '[ONBOARDING CONTEXT] this is just assistant text' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['1', '2']);
    });

    it('does NOT hide user messages that merely contain the prefix mid-text', () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: 'I saw [ONBOARDING CONTEXT] mentioned somewhere' }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'ok' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['1', '2']);
    });
  });

  describe('<conversation_history> prefix hiding', () => {
    it('hides user-role messages starting with <conversation_history>', () => {
      const messages = [
        msg({
          id: '1',
          turnId: 't1',
          role: 'user',
          text: '<conversation_history>\nsome context\n</conversation_history>\n\nThe user answered your questions: color=blue',
        }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'continuing' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['2']);
    });

    it('does NOT hide assistant-role messages with <conversation_history> text', () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: 'hello' }),
        msg({
          id: '2',
          turnId: 't1',
          role: 'assistant',
          text: '<conversation_history>echo</conversation_history>',
        }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['1', '2']);
    });

    it('does NOT hide "The user answered your question yesterday" (false-positive safety net)', () => {
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
  });

  describe('messageOrigin-based hiding', () => {
    it('hides user-role messages with messageOrigin: system-continuation', () => {
      const messages = [
        msg({
          id: '1',
          turnId: 't1',
          role: 'user',
          text: 'Visible-looking text',
          messageOrigin: 'system-continuation',
        }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'continuing' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['2']);
    });

    it('does NOT hide assistant-role messages with messageOrigin: system-continuation', () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: 'hi' }),
        msg({
          id: '2',
          turnId: 't1',
          role: 'assistant',
          text: 'assistant text',
          messageOrigin: 'system-continuation',
        }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['1', '2']);
    });
  });

  describe('deletedAt tombstones', () => {
    it('excludes deleted messages before visibility filtering', () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: 'to be deleted', deletedAt: Date.now() }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'still here' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['2']);
    });
  });

  describe('assistant message filtering by turn', () => {
    it('hides all assistant messages when a result exists for the same turn', () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: 'do something' }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'thinking...' }),
        msg({ id: '3', turnId: 't1', role: 'assistant', text: 'still thinking...' }),
        msg({ id: '4', turnId: 't1', role: 'result', text: 'Here is the result' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['1', '4']);
    });

    it('keeps only the last assistant message when no result exists for the turn', () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: 'tell me something' }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'first response' }),
        msg({ id: '3', turnId: 't1', role: 'assistant', text: 'second response' }),
        msg({ id: '4', turnId: 't1', role: 'assistant', text: 'final response' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['1', '4']);
    });

    it('handles mixed turns — one with result, one without', () => {
      const messages = [
        // Turn 1 — has result
        msg({ id: '1', turnId: 't1', role: 'user', text: 'task A' }),
        msg({ id: '2', turnId: 't1', role: 'assistant', text: 'working on A...' }),
        msg({ id: '3', turnId: 't1', role: 'result', text: 'A done' }),
        // Turn 2 — no result
        msg({ id: '4', turnId: 't2', role: 'user', text: 'task B' }),
        msg({ id: '5', turnId: 't2', role: 'assistant', text: 'first attempt at B' }),
        msg({ id: '6', turnId: 't2', role: 'assistant', text: 'B answer' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['1', '3', '4', '6']);
    });
  });

  describe('tool-only turns (no assistant or result messages)', () => {
    it('passes through user and result messages even without assistant messages', () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: 'run this' }),
        msg({ id: '2', turnId: 't1', role: 'result', text: 'execution complete' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['1', '2']);
    });

    it('passes through a single user message with no response', () => {
      const messages = [
        msg({ id: '1', turnId: 't1', role: 'user', text: 'hello?' }),
      ];
      const result = selectVisibleMessages(messages);
      expect(result.map(m => m.id)).toEqual(['1']);
    });
  });

  describe('preserves generic type', () => {
    it('returns the same extended type that was passed in', () => {
      interface ExtendedMessage extends VisibleMessageCandidate {
        extra: number;
      }
      const messages: ExtendedMessage[] = [
        { id: '1', turnId: 't1', role: 'user', text: 'hi', extra: 42 },
        { id: '2', turnId: 't1', role: 'assistant', text: 'hello', extra: 99 },
      ];
      const result = selectVisibleMessages(messages);
      expect(result).toHaveLength(2);
      expect(result[0].extra).toBe(42);
      expect(result[1].extra).toBe(99);
    });
  });
});

describe('isMessageHidden', () => {
  it('returns true for system-continuation user messages', () => {
    expect(
      isMessageHidden(
        msg({
          id: '1',
          turnId: 't1',
          role: 'user',
          text: 'normal text',
          messageOrigin: 'system-continuation',
        }),
      ),
    ).toBe(true);
  });

  it('returns false for regular user messages', () => {
    expect(
      isMessageHidden(
        msg({
          id: '1',
          turnId: 't1',
          role: 'user',
          text: 'normal text',
          messageOrigin: 'user-typed',
        }),
      ),
    ).toBe(false);
  });
});
