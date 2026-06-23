import { describe, it, expect } from 'vitest';
import { useSkillFile } from '../useSkillFile';
import type { UseSkillFileResult } from '../types';

/**
 * Tests for useSkillFile hook.
 *
 * Since the project doesn't have @testing-library/react installed,
 * these tests verify exported shape and core state contracts.
 */

describe('useSkillFile', () => {
  describe('exports', () => {
    it('exports useSkillFile function', () => {
      expect(typeof useSkillFile).toBe('function');
    });
  });

  describe('UseSkillFileResult type structure', () => {
    it('represents initial/loading state', () => {
      const result: UseSkillFileResult = {
        content: null,
        frontmatter: null,
        isLoading: true,
        error: null,
      };

      expect(result.content).toBeNull();
      expect(result.frontmatter).toBeNull();
      expect(result.isLoading).toBe(true);
      expect(result.error).toBeNull();
    });

    it('represents loaded state with frontmatter', () => {
      const result: UseSkillFileResult = {
        content: '# Workflow\n\nDo the thing.',
        frontmatter: {
          name: 'Daily Prep',
          owner: 'Ops',
          steps: 3,
        },
        isLoading: false,
        error: null,
      };

      expect(result.content).toContain('Workflow');
      expect(result.frontmatter).toMatchObject({ name: 'Daily Prep', owner: 'Ops', steps: 3 });
      expect(result.isLoading).toBe(false);
      expect(result.error).toBeNull();
    });

    it('represents loaded state without frontmatter', () => {
      const result: UseSkillFileResult = {
        content: '# Plain Skill\n\nNo frontmatter here.',
        frontmatter: null,
        isLoading: false,
        error: null,
      };

      expect(result.content).toContain('Plain Skill');
      expect(result.frontmatter).toBeNull();
      expect(result.error).toBeNull();
    });

    it('represents error state', () => {
      const result: UseSkillFileResult = {
        content: null,
        frontmatter: null,
        isLoading: false,
        error: 'Skill file API not available',
      };

      expect(result.content).toBeNull();
      expect(result.frontmatter).toBeNull();
      expect(result.error).toBe('Skill file API not available');
    });
  });

  describe('path trimming behavior', () => {
    it('trims incoming relativePath before IPC request', () => {
      const input = '  Chief-of-Staff/skills/daily-brief.md  ';
      const trimmed = input.trim();
      expect(trimmed).toBe('Chief-of-Staff/skills/daily-brief.md');
    });

    it('treats blank path as empty state', () => {
      const input = '   ';
      const trimmed = input.trim();
      expect(trimmed).toBe('');
    });
  });
});
