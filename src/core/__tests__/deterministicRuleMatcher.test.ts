import { describe, expect, it } from 'vitest';
import { deterministicRuleMatcher } from '@core/safetyPromptLogic';
import type { ActionContext } from '@core/safetyPromptTypes';

function makeContext(toolName: string, toolInput: Record<string, unknown> = {}): ActionContext {
  return { toolName, toolInput };
}

describe('deterministicRuleMatcher (block-only, two-word match)', () => {
  describe('matches block rules with two+ tool name parts in the rule', () => {
    it('matches when rule mentions "send" and "email" for send_workspace_email', () => {
      const prompt = '- You must not send email to external domains';
      const result = deterministicRuleMatcher(prompt, makeContext('send_workspace_email', { to: '[external-email]' }));
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
      expect(result!.confidence).toBe('high');
    });

    it('matches when rule mentions "post" and "discourse" for post_discourse_topic', () => {
      const prompt = '- Posting to external Discourse is not permitted';
      const result = deterministicRuleMatcher(prompt, makeContext('post_discourse_topic', { title: 'test' }));
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
    });

    it('matches when rule mentions "delete" and "calendar" for delete_calendar_event', () => {
      const prompt = '- Deleting calendar events is prohibited';
      const result = deterministicRuleMatcher(prompt, makeContext('delete_calendar_event', { eventId: 'abc' }));
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
    });

    it('matches when rule mentions "post" and "slack" and "message"', () => {
      const prompt = '- Do not post Slack messages to external channels';
      const result = deterministicRuleMatcher(prompt, makeContext('post_slack_message', { channel: '#ext' }));
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
    });

    it('matches when rule mentions "send" and "sms"', () => {
      const prompt = '- Never send SMS to customers';
      const result = deterministicRuleMatcher(prompt, makeContext('send_sms_message', { to: '+1234567890' }));
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
    });
  });

  describe('does NOT match with only one word overlap (too loose)', () => {
    it('does not match "External messages require..." against post_slack_message (only "message" overlaps)', () => {
      const prompt = '- External messages require clear business context and must avoid sensitive content';
      const result = deterministicRuleMatcher(prompt, makeContext('post_slack_message', { channel: '#ops' }));
      expect(result).toBeNull();
    });

    it('does not match "Destructive changes (delete/overwrite)" against write_meeting_notes (only "write" overlaps)', () => {
      const prompt = '- Destructive changes (delete/overwrite) require explicit confirmation';
      const result = deterministicRuleMatcher(prompt, makeContext('write_meeting_notes', { content: 'notes' }));
      expect(result).toBeNull();
    });

    it('does not match generic block rule against unrelated tool', () => {
      const prompt = '- You must not send email to external domains';
      const result = deterministicRuleMatcher(prompt, makeContext('read_drive_file', { fileId: '123' }));
      expect(result).toBeNull();
    });
  });

  describe('never allows — always fails closed for allow rules', () => {
    it('returns null for explicit allow rules', () => {
      const prompt = '- Sending email via send_workspace_email is allowed';
      const result = deterministicRuleMatcher(prompt, makeContext('send_workspace_email', { to: 'user@example.com' }));
      expect(result).toBeNull();
    });

    it('returns null for "is permitted" rules', () => {
      const prompt = '- Posting to Slack via post_slack_message is permitted';
      const result = deterministicRuleMatcher(prompt, makeContext('post_slack_message', { channel: '#general' }));
      expect(result).toBeNull();
    });
  });

  describe('no match — returns null (fail-closed)', () => {
    it('returns null for empty prompt', () => {
      const result = deterministicRuleMatcher('', makeContext('send_workspace_email', {}));
      expect(result).toBeNull();
    });

    it('returns null for prompt with only comments', () => {
      const prompt = '# Safety Prompt\n# No rules here';
      const result = deterministicRuleMatcher(prompt, makeContext('send_workspace_email', {}));
      expect(result).toBeNull();
    });

    it('returns null when rules have no signal words', () => {
      const prompt = '- Email functionality uses the workspace email system';
      const result = deterministicRuleMatcher(prompt, makeContext('send_workspace_email', {}));
      expect(result).toBeNull();
    });

    it('returns null when only allow rules exist (no block rules)', () => {
      const prompt = [
        '- Sending email is allowed',
        '- Posting to Slack is permitted',
      ].join('\n');
      const result = deterministicRuleMatcher(prompt, makeContext('send_workspace_email', {}));
      expect(result).toBeNull();
    });
  });

  describe('rule parsing', () => {
    it('handles bullet-point block rules', () => {
      const prompt = '- You must not send email externally\n* Posting to Discourse is prohibited';
      const emailBlock = deterministicRuleMatcher(prompt, makeContext('send_workspace_email', {}));
      const discourseBlock = deterministicRuleMatcher(prompt, makeContext('post_discourse_topic', {}));
      expect(emailBlock!.decision).toBe('block');
      expect(discourseBlock!.decision).toBe('block');
    });

    it('handles plain-text block rules', () => {
      const prompt = 'You must not send email externally';
      const result = deterministicRuleMatcher(prompt, makeContext('send_workspace_email', {}));
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
    });

    it('skips header lines', () => {
      const prompt = '# Blocked Tools\n- You must not send email externally';
      const result = deterministicRuleMatcher(prompt, makeContext('send_workspace_email', {}));
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
    });
  });

  describe('MCP router tool handling', () => {
    it('matches namespaced tool when two+ parts appear in rule', () => {
      const prompt = '- You must not send workspace email externally';
      const result = deterministicRuleMatcher(
        prompt,
        makeContext('GoogleWorkspace-liam__send_workspace_email', {}),
      );
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
    });
  });

  describe('mixed allow and block rules', () => {
    it('only matches the block rule when it has two-word overlap', () => {
      const prompt = [
        '- Sending email via send_workspace_email is allowed',
        '- You must not send email to external recipients',
      ].join('\n');
      const result = deterministicRuleMatcher(prompt, makeContext('send_workspace_email', { to: '[external-email]' }));
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
    });

    it('returns null when block rule has only one-word overlap', () => {
      const prompt = [
        '- Sending email via send_workspace_email is allowed',
        '- You must not delete calendar events',
      ].join('\n');
      const result = deterministicRuleMatcher(prompt, makeContext('send_workspace_email', {}));
      expect(result).toBeNull();
    });
  });
});
