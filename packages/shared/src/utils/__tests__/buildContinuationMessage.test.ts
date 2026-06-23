import { describe, expect, it } from 'vitest';
import { buildContinuationMessage, buildDiscardMessage } from '../buildContinuationMessage';
import type { ApprovalInfo, DiscardInfo } from '../buildContinuationMessage';

describe('buildContinuationMessage', () => {
  it('returns empty string for empty approvals array', () => {
    expect(buildContinuationMessage([])).toBe('');
  });

  describe('single approval', () => {
    it('includes space name, file path, and content', () => {
      const approval: ApprovalInfo = {
        spaceName: 'Work Notes',
        filePath: '/notes/meeting.md',
        content: '# Meeting Notes\nDiscussed project timeline.',
      };
      const result = buildContinuationMessage([approval]);
      expect(result).toContain('Work Notes');
      expect(result).toContain('/notes/meeting.md');
      expect(result).toContain('# Meeting Notes\nDiscussed project timeline.');
    });

    it('instructs agent that operation has NOT been executed', () => {
      const approval: ApprovalInfo = {
        spaceName: 'Research',
        filePath: '/research/findings.md',
        content: 'Some findings',
      };
      const result = buildContinuationMessage([approval]);
      expect(result).toContain('IMPORTANT: The operation has NOT been executed yet');
      expect(result).toContain('Re-execute this operation now');
    });

    it('mentions user approval', () => {
      const approval: ApprovalInfo = {
        spaceName: 'Notes',
        filePath: '/notes/test.md',
        content: 'test',
      };
      const result = buildContinuationMessage([approval]);
      expect(result).toContain('User approved');
    });
  });

  describe('multiple approvals', () => {
    const approvals: ApprovalInfo[] = [
      { spaceName: 'Notes', filePath: '/notes/a.md', content: 'Content A' },
      { spaceName: 'Research', filePath: '/research/b.md', content: 'Content B' },
    ];

    it('includes count of approvals', () => {
      const result = buildContinuationMessage(approvals);
      expect(result).toContain('2 writes');
    });

    it('includes all space names and file paths', () => {
      const result = buildContinuationMessage(approvals);
      expect(result).toContain('Notes');
      expect(result).toContain('/notes/a.md');
      expect(result).toContain('Research');
      expect(result).toContain('/research/b.md');
    });

    it('includes all content blocks', () => {
      const result = buildContinuationMessage(approvals);
      expect(result).toContain('Content A');
      expect(result).toContain('Content B');
    });

    it('instructs agent that operations have NOT been executed', () => {
      const result = buildContinuationMessage(approvals);
      expect(result).toContain('IMPORTANT: These operations have NOT been executed yet');
      expect(result).toContain('Re-execute these operations now');
    });

    it('numbers the entries', () => {
      const result = buildContinuationMessage(approvals);
      expect(result).toContain('1. Notes: /notes/a.md');
      expect(result).toContain('2. Research: /research/b.md');
    });
  });

  describe('shared_skill_checkpoint approval', () => {
    it('uses checkpoint-specific message', () => {
      const approval: ApprovalInfo = {
        spaceName: 'Skills',
        filePath: '/skills/test.md',
        content: 'Skill content',
        approvalKind: 'shared_skill_checkpoint',
      };
      const result = buildContinuationMessage([approval]);
      expect(result).toContain('shared-skill checkpoint');
      expect(result).toContain('The write has NOT happened yet');
      expect(result).toContain('Skills');
      expect(result).toContain('/skills/test.md');
      expect(result).toContain('Skill content');
    });
  });

  describe('edge cases', () => {
    it('handles approval with empty content', () => {
      const approval: ApprovalInfo = {
        spaceName: 'Empty',
        filePath: '/empty.md',
        content: '',
      };
      const result = buildContinuationMessage([approval]);
      expect(result).toContain('Empty');
      expect(result).toContain('/empty.md');
    });

    it('handles approval with multiline content', () => {
      const approval: ApprovalInfo = {
        spaceName: 'Docs',
        filePath: '/docs/guide.md',
        content: 'Line 1\nLine 2\nLine 3',
      };
      const result = buildContinuationMessage([approval]);
      expect(result).toContain('Line 1\nLine 2\nLine 3');
    });
  });
});

describe('buildDiscardMessage', () => {
  it('returns empty string for empty discards array', () => {
    expect(buildDiscardMessage([])).toBe('');
  });

  it('builds single discard message', () => {
    const discards: DiscardInfo[] = [
      { spaceName: 'Notes', filePath: '/notes/test.md' },
    ];
    const result = buildDiscardMessage(discards);
    expect(result).toContain('Notes');
    expect(result).toContain('/notes/test.md');
    expect(result).toContain("Don't retry");
  });

  it('builds multiple discard message with listing', () => {
    const discards: DiscardInfo[] = [
      { spaceName: 'Notes', filePath: '/notes/a.md' },
      { spaceName: 'Research', filePath: '/research/b.md' },
    ];
    const result = buildDiscardMessage(discards);
    expect(result).toContain('declined the following memory writes');
    expect(result).toContain('- Notes (/notes/a.md)');
    expect(result).toContain('- Research (/research/b.md)');
  });
});
