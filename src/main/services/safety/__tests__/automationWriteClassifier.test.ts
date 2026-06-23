import { describe, it, expect } from 'vitest';
import { classifyAutomationSourceKind } from '../automationWriteClassifier';

describe('classifyAutomationSourceKind', () => {
  describe('meeting', () => {
    it('classifies source_type: meeting as meeting', () => {
      const content = [
        '---',
        'source_type: meeting',
        'source_system: recall',
        'title: Weekly 1:1',
        '---',
        '',
        '## Transcript',
        'Body content here.',
      ].join('\n');

      expect(classifyAutomationSourceKind(content)).toBe('meeting');
    });

    it('classifies meeting with only frontmatter, no body', () => {
      const content = '---\nsource_type: meeting\n---';

      expect(classifyAutomationSourceKind(content)).toBe('meeting');
    });

    it('handles source_type with uppercase casing (Meeting → meeting)', () => {
      const content = '---\nsource_type: Meeting\n---\n\nBody';

      expect(classifyAutomationSourceKind(content)).toBe('meeting');
    });

    it('handles source_type with mixed casing (MEETING → meeting)', () => {
      const content = '---\nsource_type: MEETING\n---\n\nBody';

      expect(classifyAutomationSourceKind(content)).toBe('meeting');
    });

    it('handles source_type with surrounding whitespace (quoted value)', () => {
      const content = '---\nsource_type: "  meeting  "\n---\n\nBody';

      expect(classifyAutomationSourceKind(content)).toBe('meeting');
    });
  });

  describe('email', () => {
    it('classifies source_type: email as email', () => {
      const content = [
        '---',
        'source_type: email',
        'source_system: gmail',
        'source_account: [external-email]',
        '---',
        '',
        'Email body',
      ].join('\n');

      expect(classifyAutomationSourceKind(content)).toBe('email');
    });

    it('handles source_type: Email case-insensitively', () => {
      const content = '---\nsource_type: Email\n---\n\nBody';

      expect(classifyAutomationSourceKind(content)).toBe('email');
    });
  });

  describe('messaging_thread', () => {
    it('classifies thread + slack as messaging_thread', () => {
      const content = [
        '---',
        'source_type: thread',
        'source_system: slack',
        'source_account: company-workspace',
        '---',
        '',
        'Thread content',
      ].join('\n');

      expect(classifyAutomationSourceKind(content)).toBe('messaging_thread');
    });

    it('classifies thread + teams as messaging_thread', () => {
      const content = [
        '---',
        'source_type: thread',
        'source_system: teams',
        '---',
        '',
        'Thread content',
      ].join('\n');

      expect(classifyAutomationSourceKind(content)).toBe('messaging_thread');
    });

    it('classifies thread + microsoft-teams as messaging_thread', () => {
      const content = [
        '---',
        'source_type: thread',
        'source_system: microsoft-teams',
        '---',
        '',
        'Thread content',
      ].join('\n');

      expect(classifyAutomationSourceKind(content)).toBe('messaging_thread');
    });

    it('handles thread with uppercase source_system (Slack)', () => {
      const content = '---\nsource_type: thread\nsource_system: Slack\n---\n\nBody';

      expect(classifyAutomationSourceKind(content)).toBe('messaging_thread');
    });

    it('returns other for thread with unknown source_system', () => {
      const content = '---\nsource_type: thread\nsource_system: discord\n---\n\nBody';

      expect(classifyAutomationSourceKind(content)).toBe('other');
    });

    it('returns other for thread with missing source_system', () => {
      const content = '---\nsource_type: thread\n---\n\nBody';

      expect(classifyAutomationSourceKind(content)).toBe('other');
    });

    it('returns other for thread with non-string source_system', () => {
      const content = '---\nsource_type: thread\nsource_system: 42\n---\n\nBody';

      expect(classifyAutomationSourceKind(content)).toBe('other');
    });

    it('classifies source_type: slack directly as messaging_thread', () => {
      const content = '---\nsource_type: slack\nsource_system: slack\nsource_account: company-workspace\n---\n\nSlack thread content';

      expect(classifyAutomationSourceKind(content)).toBe('messaging_thread');
    });

    it('classifies source_type: teams directly as messaging_thread', () => {
      const content = '---\nsource_type: teams\nsource_system: microsoft-teams\n---\n\nTeams thread content';

      expect(classifyAutomationSourceKind(content)).toBe('messaging_thread');
    });

    it('classifies source_type: microsoft-teams directly as messaging_thread', () => {
      const content = '---\nsource_type: microsoft-teams\n---\n\nTeams content';

      expect(classifyAutomationSourceKind(content)).toBe('messaging_thread');
    });

    it('classifies source_type: Slack case-insensitively as messaging_thread', () => {
      const content = '---\nsource_type: Slack\n---\n\nSlack content';

      expect(classifyAutomationSourceKind(content)).toBe('messaging_thread');
    });
  });

  describe('other', () => {
    it('classifies source_type: document as other', () => {
      const content = '---\nsource_type: document\n---\n\nBody';

      expect(classifyAutomationSourceKind(content)).toBe('other');
    });

    it('classifies source_type: ticket as other', () => {
      const content = '---\nsource_type: ticket\nsource_system: linear\n---\n\nBody';

      expect(classifyAutomationSourceKind(content)).toBe('other');
    });

    it('classifies source_type: notion as other', () => {
      const content = '---\nsource_type: notion\nsource_system: notion\n---\n\nBody';

      expect(classifyAutomationSourceKind(content)).toBe('other');
    });

    it('classifies source_type: recording as other', () => {
      const content = '---\nsource_type: recording\n---\n\nBody';

      expect(classifyAutomationSourceKind(content)).toBe('other');
    });
  });

  describe('unknown', () => {
    it('returns unknown for missing frontmatter', () => {
      const content = '# Just a heading\n\nNo frontmatter here.';

      expect(classifyAutomationSourceKind(content)).toBe('unknown');
    });

    it('returns unknown for malformed frontmatter with unclosed quotes', () => {
      const content = '---\nsource_type: "meeting\ntitle: broken\n---\n\nBody';

      expect(classifyAutomationSourceKind(content)).toBe('unknown');
    });

    it('returns unknown for malformed YAML with invalid indentation', () => {
      const content = '---\nsource_type: meeting\n  bad: [unclosed\n---\n\nBody';

      expect(classifyAutomationSourceKind(content)).toBe('unknown');
    });

    it('returns unknown for empty content', () => {
      expect(classifyAutomationSourceKind('')).toBe('unknown');
    });

    it('returns unknown for frontmatter missing source_type field', () => {
      const content = '---\ntitle: Something\nauthor: someone\n---\n\nBody';

      expect(classifyAutomationSourceKind(content)).toBe('unknown');
    });

    it('returns unknown for source_type with empty string value', () => {
      const content = '---\nsource_type: ""\n---\n\nBody';

      expect(classifyAutomationSourceKind(content)).toBe('unknown');
    });

    it('returns unknown for source_type with whitespace-only value', () => {
      const content = '---\nsource_type: "   "\n---\n\nBody';

      expect(classifyAutomationSourceKind(content)).toBe('unknown');
    });

    it('returns unknown for non-string source_type (numeric)', () => {
      const content = '---\nsource_type: 42\n---\n\nBody';

      expect(classifyAutomationSourceKind(content)).toBe('unknown');
    });

    it('returns unknown for non-string source_type (boolean)', () => {
      const content = '---\nsource_type: true\n---\n\nBody';

      expect(classifyAutomationSourceKind(content)).toBe('unknown');
    });

    it('returns unknown for non-string input (null)', () => {
      // Defensive — caller should pass a string, but guard against misuse.
      expect(classifyAutomationSourceKind(null as unknown as string)).toBe('unknown');
    });

    it('returns unknown for non-string input (undefined)', () => {
      expect(classifyAutomationSourceKind(undefined as unknown as string)).toBe('unknown');
    });

    it('returns unknown for content that is only frontmatter markers', () => {
      const content = '---\n---';

      expect(classifyAutomationSourceKind(content)).toBe('unknown');
    });
  });

  describe('content-body presence does not affect classification', () => {
    it('classifies correctly when frontmatter has body', () => {
      const content = '---\nsource_type: meeting\n---\n\n# Long body content here';
      expect(classifyAutomationSourceKind(content)).toBe('meeting');
    });

    it('classifies correctly when frontmatter has no body', () => {
      const content = '---\nsource_type: meeting\n---\n';
      expect(classifyAutomationSourceKind(content)).toBe('meeting');
    });

    it('classifies correctly when frontmatter has no trailing newline', () => {
      const content = '---\nsource_type: meeting\n---';
      expect(classifyAutomationSourceKind(content)).toBe('meeting');
    });
  });
});
