import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { setupPromptService, teardownPromptService } from './helpers/promptTestSetup';

const mockCallWithModelAuthAware = vi.fn();
vi.mock('@core/services/behindTheScenesClient', () => ({
  callWithModelAuthAware: (...args: unknown[]) => mockCallWithModelAuthAware(...args),
}));

const { extractMergedContent, proposeMerge } = await import('../workspaceConflictResolver');

describe('workspaceConflictResolver', () => {
  const settings = {
    modelRoles: { auxiliary: 'claude-sonnet-4-5' },
  } as unknown as AppSettings;

  beforeEach(() => {
    setupPromptService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    teardownPromptService();
  });

  describe('extractMergedContent', () => {
    it('extracts merged content when delimiters are present', () => {
      const responseText = [
        'Some preamble',
        '<MERGED_FILE>',
        'line 1',
        'line 2',
        '</MERGED_FILE>',
      ].join('\n');

      expect(extractMergedContent(responseText)).toBe('line 1\nline 2');
    });

    it('returns null when delimiters are missing', () => {
      expect(extractMergedContent('No merge tags here')).toBeNull();
    });

    it('returns empty string when merged content is empty', () => {
      expect(extractMergedContent('<MERGED_FILE></MERGED_FILE>')).toBe('');
    });
  });

  describe('proposeMerge', () => {
    it('returns merged content on successful BTS response', async () => {
      mockCallWithModelAuthAware.mockResolvedValue({
        content: [
          {
            type: 'text',
            text: '<MERGED_FILE>\nmerged document\n</MERGED_FILE>',
          },
        ],
        model: 'claude-sonnet-4-5',
      });

      const result = await proposeMerge(settings, 'local version', 'cloud version', 'notes.md');

      expect(result).toEqual({ success: true, mergedContent: 'merged document' });
      expect(mockCallWithModelAuthAware).toHaveBeenCalledTimes(1);

      const [callSettings, callModel, options, tracking] = mockCallWithModelAuthAware.mock.calls[0] as [
        AppSettings,
        string,
        {
          system: string;
          maxTokens: number;
          timeout: number;
          messages: Array<{ role: string; content: string }>;
        },
        { category: string },
      ];

      expect(callSettings).toBe(settings);
      expect(callModel).toBe('claude-sonnet-4-5');
      expect(options.system).toContain('You are merging two versions of a file');
      expect(options.maxTokens).toBe(8192);
      expect(options.timeout).toBe(60_000);
      expect(options.messages[0].content).toContain('File path: notes.md');
      expect(options.messages[0].content).toContain('<LOCAL_VERSION>');
      expect(options.messages[0].content).toContain('<CLOUD_VERSION>');
      expect(tracking).toEqual({ category: 'system' });
    });

    it('returns an error when BTS call fails', async () => {
      mockCallWithModelAuthAware.mockRejectedValue(new Error('network timeout'));

      const result = await proposeMerge(settings, 'local version', 'cloud version', 'notes.md');

      expect(result).toEqual({ success: false, error: 'Failed to propose merge: network timeout' });
    });

    it('returns an error for files larger than 100KB and skips BTS call', async () => {
      const oversizedLocal = 'a'.repeat((100 * 1024) + 1);

      const result = await proposeMerge(settings, oversizedLocal, 'cloud version', 'large.md');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('File too large to merge with Rebel (max 100KB)');
      }
      expect(mockCallWithModelAuthAware).not.toHaveBeenCalled();
    });
  });
});
