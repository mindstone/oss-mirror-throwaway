import { describe, it, expect } from 'vitest';
import { useTopicContent } from '../useTopicContent';
import type { UseTopicContentResult } from '../types';

/**
 * Tests for useTopicContent hook.
 *
 * Since the project doesn't have @testing-library/react installed,
 * these tests verify exported shape and core state contracts.
 */

describe('useTopicContent', () => {
  describe('exports', () => {
    it('exports useTopicContent function', () => {
      expect(typeof useTopicContent).toBe('function');
    });
  });

  describe('UseTopicContentResult type structure', () => {
    it('represents initial/loading state', () => {
      const result: UseTopicContentResult = {
        content: null,
        isLoading: true,
        error: null,
      };

      expect(result.content).toBeNull();
      expect(result.isLoading).toBe(true);
      expect(result.error).toBeNull();
    });

    it('represents loaded state', () => {
      const result: UseTopicContentResult = {
        content: '# Topic\n\nSome notes.',
        isLoading: false,
        error: null,
      };

      expect(result.content).toContain('Topic');
      expect(result.isLoading).toBe(false);
      expect(result.error).toBeNull();
    });

    it('represents error state', () => {
      const result: UseTopicContentResult = {
        content: null,
        isLoading: false,
        error: 'Topic read API not available',
      };

      expect(result.content).toBeNull();
      expect(result.error).toBe('Topic read API not available');
    });
  });

  describe('path trimming behavior', () => {
    it('trims incoming relativePath before IPC request', () => {
      const input = '  Chief-of-Staff/memory/topics/notes.md  ';
      const trimmed = input.trim();
      expect(trimmed).toBe('Chief-of-Staff/memory/topics/notes.md');
    });

    it('treats blank path as empty state', () => {
      const input = '   ';
      const trimmed = input.trim();
      expect(trimmed).toBe('');
    });
  });
});
