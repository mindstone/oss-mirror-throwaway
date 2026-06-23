import { describe, expect, it } from 'vitest';
import { detectPendingSideEffect } from '../autoContinueHook';
import type { AgentEvent } from '@shared/types';

/**
 * Helper to create a tool event with a given tool name.
 */
function toolEvent(toolName: string): AgentEvent {
  return {
    type: 'tool',
    toolName,
    detail: '',
    stage: 'end',
    timestamp: Date.now(),
  } as AgentEvent;
}

describe('detectPendingSideEffect', () => {
  // =========================================================================
  // Positive cases — should detect pending side-effect
  // =========================================================================

  describe('detects side-effect confirmation requests', () => {
    it('"Want me to send it?"', () => {
      expect(
        detectPendingSideEffect("Here's the draft. Want me to send it?", [])
      ).toBe(true);
    });

    it('"Shall I post this to Slack?"', () => {
      expect(
        detectPendingSideEffect('Ready. Shall I post this to Slack?', [])
      ).toBe(true);
    });

    it('"Should I publish this article?"', () => {
      expect(
        detectPendingSideEffect('The article looks good. Should I publish this article?', [])
      ).toBe(true);
    });

    it('"Would you like me to delete those files?"', () => {
      expect(
        detectPendingSideEffect('Would you like me to delete those files?', [])
      ).toBe(true);
    });

    it('"Do you want me to forward the email?"', () => {
      expect(
        detectPendingSideEffect('Do you want me to forward the email?', [])
      ).toBe(true);
    });

    it('"Ready to submit?"', () => {
      expect(
        detectPendingSideEffect('Everything looks good. Ready to submit?', [])
      ).toBe(true);
    });

    it('"Can I go ahead and create the ticket?"', () => {
      expect(
        detectPendingSideEffect('Can I go ahead and create the ticket?', [])
      ).toBe(true);
    });

    it('"Can I send the reply?"', () => {
      expect(
        detectPendingSideEffect('Can I send the reply?', [])
      ).toBe(true);
    });

    it('"Let me post this update?"', () => {
      expect(
        detectPendingSideEffect('Let me post this update?', [])
      ).toBe(true);
    });

    it('"I\'ll send the email?"', () => {
      expect(
        detectPendingSideEffect("I'll send the email?", [])
      ).toBe(true);
    });

    it('"I will delete those records?"', () => {
      expect(
        detectPendingSideEffect('I will delete those records?', [])
      ).toBe(true);
    });

    it('"Should I update the document?"', () => {
      expect(
        detectPendingSideEffect('Should I update the document?', [])
      ).toBe(true);
    });

    it('"Want me to remove the old entries?"', () => {
      expect(
        detectPendingSideEffect('Want me to remove the old entries?', [])
      ).toBe(true);
    });
  });

  // =========================================================================
  // Negative cases — should NOT detect pending side-effect
  // =========================================================================

  describe('does not false-positive', () => {
    it('no question mark', () => {
      expect(
        detectPendingSideEffect('I will send the email.', [])
      ).toBe(false);
    });

    it('no intent pattern match — generic question', () => {
      expect(
        detectPendingSideEffect('What do you think about this approach?', [])
      ).toBe(false);
    });

    it('clarifying question without side-effect intent', () => {
      expect(
        detectPendingSideEffect('Which email address should I use?', [])
      ).toBe(false);
    });

    it('empty message', () => {
      expect(detectPendingSideEffect('', [])).toBe(false);
    });

    it('side-effect tool already called this turn', () => {
      expect(
        detectPendingSideEffect('Want me to send it?', [toolEvent('send_email')])
      ).toBe(false);
    });

    it('any side-effect tool already called this turn blocks detection', () => {
      expect(
        detectPendingSideEffect('Want me to post this?', [toolEvent('create_message')])
      ).toBe(false);
    });

    it('message about sending but no confirmation phrasing', () => {
      expect(
        detectPendingSideEffect('I sent the email already. Need anything else?', [])
      ).toBe(false);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('intent + unrelated tool (read_file) — still detects', () => {
      expect(
        detectPendingSideEffect('Want me to post this?', [toolEvent('read_file')])
      ).toBe(true);
    });

    it('camelCase tool names are normalized via normalizeToSnakeCase', () => {
      // "SendEmail" normalizes to "send_email" which matches sideEffectPatterns
      expect(
        detectPendingSideEffect('Want me to send it?', [toolEvent('SendEmail')])
      ).toBe(false);
    });

    it('PascalCase compound tool names are normalized', () => {
      // "CreateDocument" normalizes to "create_document"
      expect(
        detectPendingSideEffect('Shall I create the doc?', [toolEvent('CreateDocument')])
      ).toBe(false);
    });

    it('multiple events — one side-effect tool among read tools', () => {
      expect(
        detectPendingSideEffect('Want me to send the report?', [
          toolEvent('read_file'),
          toolEvent('list_directory'),
          toolEvent('send_message'),
        ])
      ).toBe(false);
    });

    it('multiple events — only read-only tools', () => {
      expect(
        detectPendingSideEffect('Want me to send the report?', [
          toolEvent('read_file'),
          toolEvent('list_directory'),
          toolEvent('search_files'),
        ])
      ).toBe(true);
    });

    it('non-tool events are ignored', () => {
      const events: AgentEvent[] = [
        { type: 'status', message: 'Working...', timestamp: Date.now() },
        { type: 'assistant', text: 'thinking', timestamp: Date.now() },
      ];
      expect(
        detectPendingSideEffect('Want me to send the report?', events)
      ).toBe(true);
    });

    it('question mark in the middle of a long message still matches', () => {
      expect(
        detectPendingSideEffect(
          'I drafted the email. Want me to send it? Let me know if you want any changes.',
          []
        )
      ).toBe(true);
    });
  });
});
