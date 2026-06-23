/**
 * Unit tests for stagedReadHook.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock cosPendingService before importing
const mockGetPendingFileByDestination = vi.fn();
vi.mock('../cosPendingService', () => ({
  getPendingFileByDestination: (path: string, sessionId?: string) =>
    mockGetPendingFileByDestination(path, sessionId),
}));

// Import after mocks
import { createStagedReadHook } from '../stagedReadHook';

describe('stagedReadHook', () => {
  const mockAbortSignal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createStagedReadHook', () => {
    it('should allow read when no pending file exists', async () => {
      mockGetPendingFileByDestination.mockResolvedValue(null);

      const hook = createStagedReadHook();
      const result = await hook(
        {
          tool_name: 'Read',
          tool_input: { file_path: '/workspace/test.md' },
          tool_use_id: 'test-id',
        },
        'test-id',
        { signal: mockAbortSignal }
      );

      expect(result).toEqual({});
      expect(mockGetPendingFileByDestination).toHaveBeenCalledWith('/workspace/test.md', undefined);
    });

    it('should return pending content when file is staged', async () => {
      const mockPendingFile = {
        file: {
          id: 'pending-123',
          filename: '260131_120000_test.pending.md',
          filePath: '/cos/pending/260131_120000_test.pending.md',
          frontmatter: {
            pending_destination: 'work/test.md',
            staged_at: '2026-01-31T12:00:00Z',
            session_id: 'session-456',
            summary: 'Test memory update',
            original_space: 'My Project',
            base_hash: 'abc123',
          },
        },
        content: '# Test Content\n\nThis is some test content.',
      };
      mockGetPendingFileByDestination.mockResolvedValue(mockPendingFile);

      const hook = createStagedReadHook();
      const result = await hook(
        {
          tool_name: 'Read',
          tool_input: { file_path: '/workspace/work/test.md' },
          tool_use_id: 'test-id',
        },
        'test-id',
        { signal: mockAbortSignal }
      );

      expect(result).toHaveProperty('hookSpecificOutput');
      expect((result as any).hookSpecificOutput).toHaveProperty('hookEventName', 'PreToolUse');
      expect((result as any).hookSpecificOutput).toHaveProperty('permissionDecision', 'deny');

      const reason = (result as any).hookSpecificOutput?.permissionDecisionReason as string;
      expect(reason).toContain('PENDING FILE');
      expect(reason).toContain('Pending approval to "My Project"');
      expect(reason).toContain('PENDING version');
      expect(reason).toContain('---BEGIN STAGED CONTENT---');
      expect(reason).toContain('# Test Content');
      expect(reason).toContain('This is some test content.');
      expect(reason).toContain('---END STAGED CONTENT---');
    });

    it('should fall back to normal read when pending candidate is unreadable', async () => {
      mockGetPendingFileByDestination.mockResolvedValue({
        kind: 'candidate_unreadable',
        filePath: '/cos/pending/bad.pending.md',
        reason: 'failed_to_parse_pending_frontmatter',
      });

      const hook = createStagedReadHook();
      const result = await hook(
        {
          tool_name: 'Read',
          tool_input: { file_path: '/workspace/work/test.md' },
          tool_use_id: 'test-id',
        },
        'test-id',
        { signal: mockAbortSignal }
      );

      expect(result).toEqual({});
    });

    it('should pass through sessionId filter when provided', async () => {
      mockGetPendingFileByDestination.mockResolvedValue(null);

      const hook = createStagedReadHook({ sessionId: 'session-xyz' });
      await hook(
        {
          tool_name: 'Read',
          tool_input: { file_path: '/workspace/test.md' },
          tool_use_id: 'test-id',
        },
        'test-id',
        { signal: mockAbortSignal }
      );

      expect(mockGetPendingFileByDestination).toHaveBeenCalledWith('/workspace/test.md', 'session-xyz');
    });

    it('should skip non-Read tool calls', async () => {
      const hook = createStagedReadHook();
      const result = await hook(
        {
          tool_name: 'Write',
          tool_input: { file_path: '/workspace/test.md', content: 'new content' },
          tool_use_id: 'test-id',
        },
        'test-id',
        { signal: mockAbortSignal }
      );

      expect(result).toEqual({});
      expect(mockGetPendingFileByDestination).not.toHaveBeenCalled();
    });

    it('should skip Read calls without file_path', async () => {
      const hook = createStagedReadHook();
      const result = await hook(
        {
          tool_name: 'Read',
          tool_input: {},
          tool_use_id: 'test-id',
        },
        'test-id',
        { signal: mockAbortSignal }
      );

      expect(result).toEqual({});
      expect(mockGetPendingFileByDestination).not.toHaveBeenCalled();
    });

    it('should skip binary content', async () => {
      const mockPendingFile = {
        file: {
          id: 'pending-123',
          filename: '260131_120000_binary.pending.md',
          filePath: '/cos/pending/260131_120000_binary.pending.md',
          frontmatter: {
            pending_destination: 'work/binary.bin',
            staged_at: '2026-01-31T12:00:00Z',
            session_id: 'session-456',
            summary: 'Binary file',
            original_space: 'My Project',
            base_hash: 'abc123',
          },
        },
        content: 'Binary content with \0 null byte',
      };
      mockGetPendingFileByDestination.mockResolvedValue(mockPendingFile);

      const hook = createStagedReadHook();
      const result = await hook(
        {
          tool_name: 'Read',
          tool_input: { file_path: '/workspace/work/binary.bin' },
          tool_use_id: 'test-id',
        },
        'test-id',
        { signal: mockAbortSignal }
      );

      expect(result).toEqual({});
    });

    it('should truncate large content', async () => {
      const largeContent = 'x'.repeat(150000); // Larger than MAX_CONTENT_SIZE (100000)
      const mockPendingFile = {
        file: {
          id: 'pending-123',
          filename: '260131_120000_large.pending.md',
          filePath: '/cos/pending/260131_120000_large.pending.md',
          frontmatter: {
            pending_destination: 'work/large.md',
            staged_at: '2026-01-31T12:00:00Z',
            session_id: 'session-456',
            summary: 'Large file',
            original_space: 'My Project',
            base_hash: 'abc123',
          },
        },
        content: largeContent,
      };
      mockGetPendingFileByDestination.mockResolvedValue(mockPendingFile);

      const hook = createStagedReadHook();
      const result = await hook(
        {
          tool_name: 'Read',
          tool_input: { file_path: '/workspace/work/large.md' },
          tool_use_id: 'test-id',
        },
        'test-id',
        { signal: mockAbortSignal }
      );

      expect(result).toHaveProperty('hookSpecificOutput');
      const reason = (result as any).hookSpecificOutput?.permissionDecisionReason as string;
      expect(reason).toContain('[...truncated, full content available once approved]');
      // Should be truncated to ~100000 chars
      expect(reason.length).toBeLessThan(150000);
    });

    it('should handle errors gracefully and allow normal read', async () => {
      mockGetPendingFileByDestination.mockRejectedValue(new Error('Database error'));

      const hook = createStagedReadHook();
      const result = await hook(
        {
          tool_name: 'Read',
          tool_input: { file_path: '/workspace/test.md' },
          tool_use_id: 'test-id',
        },
        'test-id',
        { signal: mockAbortSignal }
      );

      // Should return empty object to allow normal read
      expect(result).toEqual({});
    });
  });
});
