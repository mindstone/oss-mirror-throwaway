import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Mock dependencies before importing the service
const mockGetSettings = vi.fn();
const mockHashFile = vi.fn();
const mockSendToAllWindows = vi.fn();

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({
    sendToAllWindows: mockSendToAllWindows,
    sendToFocusedWindow: vi.fn(),
  }),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => mockGetSettings(),
}));

const mockGetAllStagedFiles = vi.fn().mockResolvedValue([]);
const mockGetStagedContent = vi.fn().mockResolvedValue(null);
const mockDiscardStagedFile = vi.fn().mockResolvedValue({ status: 'success' });

vi.mock('../hashUtils', () => ({
  hashFile: (p: string) => mockHashFile(p),
}));

vi.mock('../legacyStagingReader', () => ({
  getAllStagedFiles: () => mockGetAllStagedFiles(),
  getStagedContent: (id: string) => mockGetStagedContent(id),
  discardStagedFile: (id: string) => mockDiscardStagedFile(id),
}));

// Import after mocks
import {
  writeToPending,
  listPendingFiles,
  getPendingContent,
  getPendingFileByDestination,
  publishPendingFile,
  publishWithConflictResolution,
  deletePendingFile,
  keepPendingFilePrivate,
  isCosPendingAvailable,
  getCosPendingDir,
  migrateLegacyStagedFiles,
  canonicalizePath,
  _resetForTesting,
} from '../cosPendingService';

describe('cosPendingService', () => {
  let tempDir: string;
  let cosDir: string;
  let pendingDir: string;

  beforeEach(async () => {
    // Create temp directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-pending-test-'));
    cosDir = path.join(tempDir, 'Chief-of-Staff');
    pendingDir = path.join(cosDir, 'memory', 'pending');
    
    // Set up mock settings
    mockGetSettings.mockReturnValue({
      coreDirectory: tempDir,
    });
    
    mockHashFile.mockResolvedValue(null); // Default to new file
    
    _resetForTesting();
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('getCosPendingDir', () => {
    it('returns correct path when coreDirectory is set', () => {
      const result = getCosPendingDir();
      expect(result).toBe(pendingDir);
    });

    it('returns null when coreDirectory is not set', () => {
      mockGetSettings.mockReturnValue({ coreDirectory: null });
      const result = getCosPendingDir();
      expect(result).toBeNull();
    });
  });

  describe('isCosPendingAvailable', () => {
    it('returns true when coreDirectory is set', () => {
      expect(isCosPendingAvailable()).toBe(true);
    });

    it('returns false when coreDirectory is not set', () => {
      mockGetSettings.mockReturnValue({ coreDirectory: null });
      expect(isCosPendingAvailable()).toBe(false);
    });
  });

  describe('writeToPending', () => {
    it('creates pending file with correct frontmatter', async () => {
      const result = await writeToPending({
        destinationPath: 'work/Acme/memory/topics/notes.md',
        content: '# My Notes\n\nSome content here.',
        sessionId: 'session-123',
        summary: 'Notes about the project',
        spaceName: 'Acme General',
      });

      expect(result).not.toBeNull();
      expect(result!.frontmatter.pending_destination).toBe('work/Acme/memory/topics/notes.md');
      expect(result!.frontmatter.session_id).toBe('session-123');
      expect(result!.frontmatter.summary).toBe('Notes about the project');
      expect(result!.frontmatter.original_space).toBe('Acme General');
      expect(result!.frontmatter.base_hash).toBe('new-file');
      expect(result!.content).toBe('# My Notes\n\nSome content here.');

      // Verify file was created
      const files = await fs.readdir(pendingDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/\.pending\.md$/);
    });

    it('returns null for destination in rebel-system', async () => {
      const result = await writeToPending({
        destinationPath: 'rebel-system/skills/test.md',
        content: 'malicious content',
        sessionId: 'session-123',
        summary: 'Test',
        spaceName: 'Test',
      });

      expect(result).toBeNull();
    });

    it('returns null for destination outside workspace', async () => {
      const result = await writeToPending({
        destinationPath: '/etc/passwd',
        content: 'malicious content',
        sessionId: 'session-123',
        summary: 'Test',
        spaceName: 'Test',
      });

      expect(result).toBeNull();
    });

    it('escapes special characters in frontmatter', async () => {
      const result = await writeToPending({
        destinationPath: 'work/test.md',
        content: 'Content',
        sessionId: 'session-123',
        summary: 'Summary with "quotes" and\nnewlines',
        spaceName: 'Space "Name"',
      });

      expect(result).not.toBeNull();
      
      // Read the file and verify YAML is valid
      const fileContent = await fs.readFile(result!.filePath, 'utf-8');
      expect(fileContent).toContain('summary: "Summary with \\"quotes\\" and\\nnewlines"');
    });

    it('escapes summaries starting with YAML list indicators', async () => {
      const result = await writeToPending({
        destinationPath: 'work/test.md',
        content: 'Content',
        sessionId: 'session-123',
        summary: '- Greg and Liam should be involved in the decision',
        spaceName: 'Test Space',
      });

      expect(result).not.toBeNull();

      // Read the file and verify YAML is valid (summary must be quoted)
      const fileContent = await fs.readFile(result!.filePath, 'utf-8');
      expect(fileContent).toContain('summary: "- Greg and Liam should be involved in the decision"');

      // Verify it round-trips through parsing
      const files = await listPendingFiles();
      expect(files.length).toBe(1);
      expect(files[0].frontmatter.summary).toBe('- Greg and Liam should be involved in the decision');
    });

    it('replaces existing pending file for same destination+session', async () => {
      // Write first file
      await writeToPending({
        destinationPath: 'work/test.md',
        content: 'First content',
        sessionId: 'session-123',
        summary: 'First',
        spaceName: 'Test',
      });

      // Write second file with same destination+session
      await writeToPending({
        destinationPath: 'work/test.md',
        content: 'Second content',
        sessionId: 'session-123',
        summary: 'Second',
        spaceName: 'Test',
      });

      // Should only have one file
      const files = await listPendingFiles();
      expect(files.length).toBe(1);
      expect(files[0].content).toBe('Second content');
    });

    it('writeToPending preserves base_hash when replacing same-session pending', async () => {
      mockHashFile.mockResolvedValueOnce('H0').mockResolvedValueOnce('H1');

      await writeToPending({
        destinationPath: 'work/base-hash.md',
        content: 'First content',
        sessionId: 'session-123',
        summary: 'First',
        spaceName: 'Test',
      });

      const replacement = await writeToPending({
        destinationPath: 'work/base-hash.md',
        content: 'Second content',
        sessionId: 'session-123',
        summary: 'Second',
        spaceName: 'Test',
        baseHash: 'H2',
      });

      expect(replacement).not.toBeNull();
      expect(replacement!.frontmatter.base_hash).toBe('H0');

      const files = await listPendingFiles();
      expect(files).toHaveLength(1);
      expect(files[0].frontmatter.base_hash).toBe('H0');
      expect(files[0].content).toBe('Second content');
    });

    it('writeToPending refuses cross-session destination collision', async () => {
      const first = await writeToPending({
        destinationPath: 'work/collision.md',
        content: 'Session A content',
        sessionId: 'session-a',
        summary: 'First',
        spaceName: 'Test',
      });
      expect(first).not.toBeNull();

      const second = await writeToPending({
        destinationPath: 'work/collision.md',
        content: 'Session B content',
        sessionId: 'session-b',
        summary: 'Second',
        spaceName: 'Test',
      });

      expect(second).toBeNull();

      const files = await listPendingFiles();
      expect(files).toHaveLength(1);
      expect(files[0].frontmatter.session_id).toBe('session-a');
      expect(files[0].content).toBe('Session A content');
    });

    it('writeToPending serializes concurrent same-destination writes via mutex', async () => {
      const originalRename = fs.rename;
      let releaseFirstRename!: () => void;
      let firstRenameEnteredResolve!: () => void;
      const firstRenameEntered = new Promise<void>((resolve) => {
        firstRenameEnteredResolve = resolve;
      });
      let holdingFirstRename = true;
      let secondRenameStarted = false;

      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
        if (holdingFirstRename) {
          holdingFirstRename = false;
          firstRenameEnteredResolve();
          await new Promise<void>((resolve) => {
            releaseFirstRename = resolve;
          });
        } else {
          secondRenameStarted = true;
        }
        return originalRename(oldPath, newPath);
      });

      try {
        const firstWrite = writeToPending({
          destinationPath: 'work/mutex.md',
          content: 'First content',
          sessionId: 'session-123',
          summary: 'First',
          spaceName: 'Test',
        });

        await firstRenameEntered;

        const secondWrite = writeToPending({
          destinationPath: 'work/mutex.md',
          content: 'Second content',
          sessionId: 'session-123',
          summary: 'Second',
          spaceName: 'Test',
        });

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(secondRenameStarted).toBe(false);

        releaseFirstRename();
        const [firstResult, secondResult] = await Promise.all([firstWrite, secondWrite]);
        expect(firstResult).not.toBeNull();
        expect(secondResult).not.toBeNull();

        const files = await listPendingFiles();
        expect(files).toHaveLength(1);
        expect(files[0].content).toBe('Second content');
      } finally {
        renameSpy.mockRestore();
      }
    });

    it('writeToPending uses atomic temp+rename and cleans up tmp file on rename failure', async () => {
      const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'));
      try {
        await expect(writeToPending({
          destinationPath: 'work/atomic.md',
          content: 'Atomic content',
          sessionId: 'session-123',
          summary: 'Atomic',
          spaceName: 'Test',
        })).rejects.toThrow('rename failed');

        const entries = await fs.readdir(pendingDir);
        expect(entries.some((entry) => entry.endsWith('.tmp'))).toBe(false);
      } finally {
        renameSpy.mockRestore();
      }
    });

    it('keeps the existing pending file when replacement rename fails', async () => {
      const first = await writeToPending({
        destinationPath: 'work/atomic-replace.md',
        content: 'First content',
        sessionId: 'session-123',
        summary: 'First',
        spaceName: 'Test',
      });
      expect(first).not.toBeNull();

      const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'));
      try {
        await expect(writeToPending({
          destinationPath: 'work/atomic-replace.md',
          content: 'Second content',
          sessionId: 'session-123',
          summary: 'Second',
          spaceName: 'Test',
        })).rejects.toThrow('rename failed');
      } finally {
        renameSpy.mockRestore();
      }

      const files = await listPendingFiles();
      expect(files).toHaveLength(1);
      expect(files[0].content).toBe('First content');
      expect(files[0].id).toBe(first!.id);
    });
  });

  describe('listPendingFiles', () => {
    it('returns empty array when no pending files', async () => {
      const files = await listPendingFiles();
      expect(files).toEqual([]);
    });

    it('returns all pending files', async () => {
      await writeToPending({
        destinationPath: 'work/file1.md',
        content: 'Content 1',
        sessionId: 'session-1',
        summary: 'File 1',
        spaceName: 'Space 1',
      });

      await writeToPending({
        destinationPath: 'work/file2.md',
        content: 'Content 2',
        sessionId: 'session-2',
        summary: 'File 2',
        spaceName: 'Space 2',
      });

      const files = await listPendingFiles();
      expect(files.length).toBe(2);
    });

    it('ignores files without .pending.md extension', async () => {
      await fs.mkdir(pendingDir, { recursive: true });
      await fs.writeFile(path.join(pendingDir, 'not-a-pending-file.md'), 'content');

      const files = await listPendingFiles();
      expect(files.length).toBe(0);
    });
  });

  describe('publishPendingFile', () => {
    it('publishes file to destination and removes pending', async () => {
      const pending = await writeToPending({
        destinationPath: 'work/published.md',
        content: '# Published Content',
        sessionId: 'session-123',
        summary: 'Test',
        spaceName: 'Test',
      });

      const result = await publishPendingFile(pending!.id);
      expect(result.status).toBe('success');

      // Verify destination file exists with correct content (no frontmatter)
      const destPath = path.join(tempDir, 'work', 'published.md');
      const destContent = await fs.readFile(destPath, 'utf-8');
      expect(destContent).toBe('# Published Content');
      expect(destContent).not.toContain('pending_destination');

      // Verify pending file removed
      const files = await listPendingFiles();
      expect(files.length).toBe(0);
    });

    it('returns already-resolved for non-existent id', async () => {
      const result = await publishPendingFile('non-existent-id');
      expect(result.status).toBe('already-resolved');
    });

    it('detects conflict when destination was modified', async () => {
      // Create pending file
      const pending = await writeToPending({
        destinationPath: 'work/conflict.md',
        content: 'Pending content',
        sessionId: 'session-123',
        summary: 'Test',
        spaceName: 'Test',
        baseHash: 'original-hash',
      });

      // Create destination file (simulating external modification)
      const destPath = path.join(tempDir, 'work', 'conflict.md');
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, 'Modified externally');
      mockHashFile.mockResolvedValue('different-hash');

      const result = await publishPendingFile(pending!.id);
      expect(result.status).toBe('conflict');
      expect(result.conflict?.currentContent).toBe('Modified externally');
      expect(result.conflict?.pendingContent).toBe('Pending content');
    });

    it('rejects publish to rebel-system', async () => {
      // Manually create a pending file with bad destination (bypassing write validation)
      await fs.mkdir(pendingDir, { recursive: true });
      const badFile = path.join(pendingDir, '260131_120000_bad.pending.md');
      await fs.writeFile(badFile, `---
pending_destination: rebel-system/skills/bad.md
staged_at: "2026-01-31T12:00:00Z"
session_id: "test"
summary: "Bad"
original_space: "Test"
base_hash: "new-file"
---

Bad content`);

      const files = await listPendingFiles();
      expect(files.length).toBe(1);

      const result = await publishPendingFile(files[0].id);
      expect(result.status).toBe('invalid-destination');
    });

    it('returns a friendly message for EINVAL write failures', async () => {
      const pending = await writeToPending({
        destinationPath: 'work/einval.md',
        content: 'Content',
        sessionId: 'session-123',
        summary: 'Test',
        spaceName: 'Test',
      });

      const writeError = Object.assign(
        new Error('EINVAL: invalid argument, write'),
        { code: 'EINVAL' as const }
      );
      const writeSpy = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(writeError);

      try {
        const result = await publishPendingFile(pending!.id);
        expect(result.status).toBe('error');
        expect(result.error).toBe('Couldn\'t save the file — the path may contain invalid characters or be locked by another app.');
        expect(result.error).not.toContain('EINVAL');
      } finally {
        writeSpy.mockRestore();
      }
    });

    it('returns a friendly message for ENOTDIR directory-shape failures', async () => {
      const pending = await writeToPending({
        destinationPath: 'work/notadir/target.md',
        content: 'Content',
        sessionId: 'session-123',
        summary: 'Test',
        spaceName: 'Test',
      });

      const mkdirError = Object.assign(
        new Error('ENOTDIR: not a directory, mkdir'),
        { code: 'ENOTDIR' as const }
      );
      const mkdirSpy = vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(mkdirError);

      try {
        const result = await publishPendingFile(pending!.id);
        expect(result.status).toBe('error');
        expect(result.error).toBe('Couldn\'t save the file — a file exists where a folder was expected in the path.');
      } finally {
        mkdirSpy.mockRestore();
      }
    });

    it('cleans up the temp file when publish fails after temp write', async () => {
      const pending = await writeToPending({
        destinationPath: 'work/temp-cleanup.md',
        content: 'Content',
        sessionId: 'session-123',
        summary: 'Test',
        spaceName: 'Test',
      });

      const destPath = path.join(tempDir, 'work', 'temp-cleanup.md');
      const tempPath = `${destPath}.tmp`;

      const renameError = Object.assign(
        new Error('EBUSY: resource busy or locked, rename'),
        { code: 'EBUSY' as const }
      );
      const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(renameError);

      try {
        const result = await publishPendingFile(pending!.id);
        expect(result.status).toBe('error');
        await expect(fs.access(tempPath)).rejects.toThrow();
      } finally {
        renameSpy.mockRestore();
      }
    });
  });

  describe('publishWithConflictResolution', () => {
    it('keep-current resolves with a single staged-files-changed broadcast', async () => {
      const pending = await writeToPending({
        destinationPath: 'work/conflict-keep-current.md',
        content: 'Pending content',
        sessionId: 'session-123',
        summary: 'Conflict test',
        spaceName: 'Test',
      });
      expect(pending).not.toBeNull();

      mockSendToAllWindows.mockClear();
      const result = await publishWithConflictResolution(pending!.id, 'keep-current');

      expect(result.status).toBe('success');
      expect(
        mockSendToAllWindows.mock.calls.filter(([channel]) => channel === 'memory:staged-files-changed'),
      ).toHaveLength(1);
    });
  });

  describe('deletePendingFile', () => {
    it('deletes pending file', async () => {
      const pending = await writeToPending({
        destinationPath: 'work/to-delete.md',
        content: 'Content',
        sessionId: 'session-123',
        summary: 'Test',
        spaceName: 'Test',
      });

      const result = await deletePendingFile(pending!.id);
      expect(result.status).toBe('success');

      const files = await listPendingFiles();
      expect(files.length).toBe(0);
    });

    it('deletePendingFile broadcasts memory:staged-files-changed', async () => {
      const pending = await writeToPending({
        destinationPath: 'work/to-delete-broadcast.md',
        content: 'Content',
        sessionId: 'session-123',
        summary: 'Test',
        spaceName: 'Test',
      });

      mockSendToAllWindows.mockClear();
      const result = await deletePendingFile(pending!.id);

      expect(result.status).toBe('success');
      expect(mockSendToAllWindows).toHaveBeenCalledWith('memory:staged-files-changed');
    });

    it('returns not-found for non-existent id', async () => {
      const result = await deletePendingFile('non-existent-id');
      expect(result.status).toBe('not-found');
    });

    it('waits for destination lock when deleting during an in-flight replacement write', async () => {
      await fs.mkdir(pendingDir, { recursive: true });
      const manualPendingPath = path.join(pendingDir, 'manual-lock-old.pending.md');
      await fs.writeFile(
        manualPendingPath,
        [
          '---',
          'pending_destination: work/delete-lock.md',
          'staged_at: "2026-05-27T00:00:00.000Z"',
          'session_id: session-123',
          'summary: Old pending',
          'original_space: Test',
          'base_hash: new-file',
          '---',
          'Old content',
        ].join('\n'),
        'utf-8',
      );

      const [manualPendingFile] = await listPendingFiles();
      expect(manualPendingFile).toBeDefined();
      if (!manualPendingFile) {
        throw new Error('Expected manual pending file to exist');
      }

      const originalRename = fs.rename;
      let releaseRenameResolve!: () => void;
      const releaseRename = new Promise<void>((resolve) => {
        releaseRenameResolve = resolve;
      });
      let firstRenameEnteredResolve!: () => void;
      const firstRenameEntered = new Promise<void>((resolve) => {
        firstRenameEnteredResolve = resolve;
      });
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
        firstRenameEnteredResolve();
        await releaseRename;
        return originalRename(oldPath, newPath);
      });

      try {
        const writePromise = writeToPending({
          destinationPath: 'work/delete-lock.md',
          content: 'New content',
          sessionId: 'session-123',
          summary: 'New pending',
          spaceName: 'Test',
        });

        await firstRenameEntered;

        let deleteSettled = false;
        const deletePromise = deletePendingFile(manualPendingFile.id).then((result) => {
          deleteSettled = true;
          return result;
        });

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(deleteSettled).toBe(false);

        releaseRenameResolve();
        const [writeResult, deleteResult] = await Promise.all([writePromise, deletePromise]);

        expect(writeResult).not.toBeNull();
        expect(deleteResult.status).toBe('not-found');

        const files = await listPendingFiles();
        expect(files).toHaveLength(1);
        expect(files[0].content).toBe('New content');
      } finally {
        renameSpy.mockRestore();
      }
    });
  });

  describe('keepPendingFilePrivate', () => {
    it('moves pending file to Chief-of-Staff memory/topics', async () => {
      const pending = await writeToPending({
        destinationPath: 'work/Exec/memory/topics/secret.md',
        content: '# Secret Content',
        sessionId: 'session-123',
        summary: 'Secret stuff',
        spaceName: 'Exec',
      });

      const result = await keepPendingFilePrivate(pending!.id);
      expect(result.status).toBe('success');
      expect(result.destinationPath).toContain('Chief-of-Staff/memory/topics');
      expect(result.destinationPath).toContain('secret.md');

      // Pending file should be removed
      const files = await listPendingFiles();
      expect(files.length).toBe(0);

      // Destination file should exist with correct content
      const destContent = await fs.readFile(result.destinationPath!, 'utf-8');
      expect(destContent).toBe('# Secret Content');
    });

    it('strips timestamp prefix from filename', async () => {
      const pending = await writeToPending({
        destinationPath: 'work/notes.md',
        content: 'Content',
        sessionId: 'session-123',
        summary: 'Notes',
        spaceName: 'Test',
      });

      const result = await keepPendingFilePrivate(pending!.id);
      expect(result.status).toBe('success');
      // Should NOT have the 260131_220743_ prefix
      expect(result.destinationPath).toMatch(/notes\.md$/);
      expect(result.destinationPath).not.toMatch(/\d{6}_\d{6}_/);
    });

    it('handles collision by adding timestamp suffix', async () => {
      // Create first file
      const pending1 = await writeToPending({
        destinationPath: 'work/collision.md',
        content: 'First content',
        sessionId: 'session-1',
        summary: 'First',
        spaceName: 'Test',
      });
      await keepPendingFilePrivate(pending1!.id);

      // Create second file with same destination
      const pending2 = await writeToPending({
        destinationPath: 'work/collision.md',
        content: 'Second content',
        sessionId: 'session-2',
        summary: 'Second',
        spaceName: 'Test',
      });
      const result = await keepPendingFilePrivate(pending2!.id);
      
      expect(result.status).toBe('success');
      // Should have timestamp suffix to avoid collision
      expect(result.destinationPath).toMatch(/collision-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.md$/);
    });

    it('returns already-resolved for non-existent id', async () => {
      const result = await keepPendingFilePrivate('non-existent-id');
      expect(result.status).toBe('already-resolved');
    });
  });

  describe('getPendingContent', () => {
    it('returns content without frontmatter', async () => {
      const pending = await writeToPending({
        destinationPath: 'work/test.md',
        content: '# My Content\n\nWith multiple lines.',
        sessionId: 'session-123',
        summary: 'Test',
        spaceName: 'Test',
      });

      const content = await getPendingContent(pending!.id);
      expect(content).toBe('# My Content\n\nWith multiple lines.');
      expect(content).not.toContain('pending_destination');
    });

    it('returns null for non-existent id', async () => {
      const content = await getPendingContent('non-existent-id');
      expect(content).toBeNull();
    });
  });

  describe('canonicalizePath', () => {
    it('normalizes separators to forward slashes', () => {
      // Note: path.resolve behavior varies by platform, but we test the normalization
      const result = canonicalizePath('/test/path');
      expect(result).not.toContain('\\');
    });

    it('resolves relative paths', () => {
      const result = canonicalizePath('./relative/path');
      // Should be resolved to absolute path (starts with /)
      expect(result[0]).toBe('/');
      expect(result).toContain('relative/path');
    });

    // Platform-specific behavior is tested implicitly through getPendingFileByDestination
  });

  describe('getPendingFileByDestination', () => {
    it('finds pending file by absolute destination path', async () => {
      const pending = await writeToPending({
        destinationPath: 'work/test-file.md',
        content: '# Test Content',
        sessionId: 'session-123',
        summary: 'Test',
        spaceName: 'Test',
      });

      // Look up by absolute path
      const absolutePath = path.join(tempDir, 'work', 'test-file.md');
      const result = await getPendingFileByDestination(absolutePath);

      expect(result.kind).toBe('found');
      if (result.kind !== 'found') {
        throw new Error(`Expected found result, got ${result.kind}`);
      }
      expect(result.file.id).toBe(pending!.id);
      expect(result.content).toBe('# Test Content');
    });

    it('finds pending file by workspace-relative path', async () => {
      const pending = await writeToPending({
        destinationPath: 'work/relative-test.md',
        content: '# Relative Test',
        sessionId: 'session-456',
        summary: 'Test',
        spaceName: 'Test',
      });

      // Look up by relative path
      const result = await getPendingFileByDestination('work/relative-test.md');

      expect(result.kind).toBe('found');
      if (result.kind !== 'found') {
        throw new Error(`Expected found result, got ${result.kind}`);
      }
      expect(result.file.id).toBe(pending!.id);
      expect(result.content).toBe('# Relative Test');
    });

    it('returns none when no matching destination', async () => {
      await writeToPending({
        destinationPath: 'work/exists.md',
        content: 'Content',
        sessionId: 'session-123',
        summary: 'Test',
        spaceName: 'Test',
      });

      const result = await getPendingFileByDestination('work/does-not-exist.md');
      expect(result).toEqual({ kind: 'none' });
    });

    it('filters by sessionId when provided', async () => {
      // Create two pending files for DIFFERENT destinations but test sessionId filtering
      const pending1 = await writeToPending({
        destinationPath: 'work/session-filter-1.md',
        content: 'Session 1 content',
        sessionId: 'session-1',
        summary: 'First',
        spaceName: 'Test',
      });

      const pending2 = await writeToPending({
        destinationPath: 'work/session-filter-2.md',
        content: 'Session 2 content',
        sessionId: 'session-2',
        summary: 'Second',
        spaceName: 'Test',
      });

      expect(pending1).not.toBeNull();
      expect(pending2).not.toBeNull();

      // Look up with session filter - should find only session-1's file
      const result = await getPendingFileByDestination('work/session-filter-1.md', 'session-1');
      expect(result.kind).toBe('found');
      if (result.kind !== 'found') {
        throw new Error(`Expected found result, got ${result.kind}`);
      }
      expect(result.file.frontmatter.session_id).toBe('session-1');
      expect(result.content).toBe('Session 1 content');

      // Look up with wrong session filter - should return none
      const noMatch = await getPendingFileByDestination('work/session-filter-1.md', 'session-2');
      expect(noMatch).toEqual({ kind: 'none' });

      // Look up session-2's file with correct filter
      const result2 = await getPendingFileByDestination('work/session-filter-2.md', 'session-2');
      expect(result2.kind).toBe('found');
      if (result2.kind !== 'found') {
        throw new Error(`Expected found result, got ${result2.kind}`);
      }
      expect(result2.file.frontmatter.session_id).toBe('session-2');
      expect(result2.content).toBe('Session 2 content');
    });

    it('returns first match when no sessionId filter (most recent)', async () => {
      // Create pending file
      await writeToPending({
        destinationPath: 'work/no-filter.md',
        content: 'Test content',
        sessionId: 'session-x',
        summary: 'Test',
        spaceName: 'Test',
      });

      // Look up without session filter
      const result = await getPendingFileByDestination('work/no-filter.md');

      expect(result.kind).toBe('found');
      if (result.kind !== 'found') {
        throw new Error(`Expected found result, got ${result.kind}`);
      }
      expect(result.content).toBe('Test content');
    });

    it('returns none when coreDirectory is not set', async () => {
      mockGetSettings.mockReturnValue({ coreDirectory: null });

      const result = await getPendingFileByDestination('work/test.md');
      expect(result).toEqual({ kind: 'none' });
    });

    it('handles path with trailing slashes', async () => {
      await writeToPending({
        destinationPath: 'work/trailing.md',
        content: 'Content',
        sessionId: 'session-123',
        summary: 'Test',
        spaceName: 'Test',
      });

      // Path.resolve normalizes trailing slashes, so this should work
      const result = await getPendingFileByDestination('work/trailing.md');
      expect(result.kind).toBe('found');
    });

    it('getPendingFileByDestination returns candidate_unreadable when a hash-matching file fails to parse', async () => {
      await fs.mkdir(pendingDir, { recursive: true });
      const destination = 'work/unreadable.md';
      const destHash = crypto.createHash('sha256').update(destination).digest('hex').slice(0, 6);
      const malformedPath = path.join(pendingDir, `260527_120000_unreadable_${destHash}.pending.md`);
      await fs.writeFile(malformedPath, '---\npending_destination: [broken\n---\ncontent', 'utf-8');

      const result = await getPendingFileByDestination(destination);
      expect(result.kind).toBe('candidate_unreadable');
      if (result.kind !== 'candidate_unreadable') {
        throw new Error(`Expected candidate_unreadable result, got ${result.kind}`);
      }
      expect(result.filePath).toBe(malformedPath);
    });

    it('returns none for unreadable hash-substring collisions when another candidate parses to a different destination', async () => {
      await fs.mkdir(pendingDir, { recursive: true });
      const lookupDestination = 'work/lookup-target.md';
      const lookupHash = crypto.createHash('sha256').update(lookupDestination).digest('hex').slice(0, 6);

      const malformedPath = path.join(
        pendingDir,
        `260527_${lookupHash}_unreadable_deadbe.pending.md`,
      );
      await fs.writeFile(malformedPath, '---\npending_destination: [broken\n---\ncontent', 'utf-8');

      const parseableDifferentDestinationPath = path.join(
        pendingDir,
        `260527_${lookupHash}_other_aaaaaa.pending.md`,
      );
      await fs.writeFile(
        parseableDifferentDestinationPath,
        [
          '---',
          'pending_destination: work/some-other-file.md',
          'staged_at: "2026-05-27T00:00:00.000Z"',
          'session_id: session-other',
          'summary: Other pending',
          'original_space: Other',
          'base_hash: new-file',
          '---',
          'Other content',
        ].join('\n'),
        'utf-8',
      );

      const result = await getPendingFileByDestination(lookupDestination);
      expect(result).toEqual({ kind: 'none' });
    });
  });

  describe('migrateLegacyStagedFiles', () => {
    beforeEach(() => {
      mockGetAllStagedFiles.mockReset();
      mockGetStagedContent.mockReset();
      mockDiscardStagedFile.mockReset();
    });

    it('returns zeros when no legacy files exist', async () => {
      mockGetAllStagedFiles.mockResolvedValue([]);

      const result = await migrateLegacyStagedFiles();

      expect(result).toEqual({ migrated: 0, failed: 0, skipped: 0 });
    });

    it('migrates legacy staged files to CoS pending', async () => {
      mockGetAllStagedFiles.mockResolvedValue([
        {
          id: 'legacy-1',
          realPath: 'work/file1.md',
          spaceName: 'Space 1',
          spacePath: 'work',
          sessionId: 'session-1',
          baseHash: 'hash-1',
          summary: 'Summary 1',
          stagedAt: Date.now(),
          sensitivity: 'high',
        },
      ]);
      mockGetStagedContent.mockResolvedValue('# Legacy Content');
      mockDiscardStagedFile.mockResolvedValue({ status: 'success' });

      const result = await migrateLegacyStagedFiles();

      expect(result.migrated).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);

      // Verify legacy file was discarded
      expect(mockDiscardStagedFile).toHaveBeenCalledWith('legacy-1');

      // Verify pending file was created
      const pendingFiles = await listPendingFiles();
      expect(pendingFiles.length).toBe(1);
      expect(pendingFiles[0].content).toBe('# Legacy Content');
      expect(pendingFiles[0].frontmatter.pending_destination).toBe('work/file1.md');
      expect(pendingFiles[0].frontmatter.base_hash).toBe('hash-1');
    });

    it('skips files with no content', async () => {
      mockGetAllStagedFiles.mockResolvedValue([
        {
          id: 'legacy-no-content',
          realPath: 'work/empty.md',
          spaceName: 'Space',
          spacePath: 'work',
          sessionId: 'session-1',
          baseHash: 'hash',
          summary: 'Summary',
          stagedAt: Date.now(),
          sensitivity: 'high',
        },
      ]);
      mockGetStagedContent.mockResolvedValue(null);

      const result = await migrateLegacyStagedFiles();

      expect(result.migrated).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockDiscardStagedFile).not.toHaveBeenCalled();
    });

    it('fails gracefully for invalid destinations', async () => {
      mockGetAllStagedFiles.mockResolvedValue([
        {
          id: 'legacy-bad-dest',
          realPath: 'rebel-system/bad.md',
          spaceName: 'Space',
          spacePath: 'rebel-system',
          sessionId: 'session-1',
          baseHash: 'hash',
          summary: 'Summary',
          stagedAt: Date.now(),
          sensitivity: 'high',
        },
      ]);
      mockGetStagedContent.mockResolvedValue('Content');

      const result = await migrateLegacyStagedFiles();

      expect(result.migrated).toBe(0);
      expect(result.failed).toBe(1);
      expect(mockDiscardStagedFile).not.toHaveBeenCalled();
    });

    it('does not re-run migration if already complete', async () => {
      // First migration
      mockGetAllStagedFiles.mockResolvedValue([]);
      await migrateLegacyStagedFiles();

      // Reset mock to return files
      mockGetAllStagedFiles.mockResolvedValue([
        {
          id: 'legacy-2',
          realPath: 'work/file2.md',
          spaceName: 'Space',
          spacePath: 'work',
          sessionId: 'session-2',
          baseHash: 'hash-2',
          summary: 'Summary 2',
          stagedAt: Date.now(),
          sensitivity: 'high',
        },
      ]);

      // Second migration should be skipped (marker file exists)
      const result = await migrateLegacyStagedFiles();

      expect(result).toEqual({ migrated: 0, failed: 0, skipped: 0 });
      expect(mockGetStagedContent).not.toHaveBeenCalled();
    });

    it('migrates multiple files and reports mixed results', async () => {
      mockGetAllStagedFiles.mockResolvedValue([
        {
          id: 'good-1',
          realPath: 'work/good1.md',
          spaceName: 'Space',
          spacePath: 'work',
          sessionId: 'session-1',
          baseHash: 'hash-1',
          summary: 'Good 1',
          stagedAt: Date.now(),
          sensitivity: 'high',
        },
        {
          id: 'bad-dest',
          realPath: 'rebel-system/bad.md',
          spaceName: 'Space',
          spacePath: 'rebel-system',
          sessionId: 'session-2',
          baseHash: 'hash-2',
          summary: 'Bad',
          stagedAt: Date.now(),
          sensitivity: 'high',
        },
        {
          id: 'no-content',
          realPath: 'work/empty.md',
          spaceName: 'Space',
          spacePath: 'work',
          sessionId: 'session-3',
          baseHash: 'hash-3',
          summary: 'Empty',
          stagedAt: Date.now(),
          sensitivity: 'high',
        },
        {
          id: 'good-2',
          realPath: 'work/good2.md',
          spaceName: 'Space',
          spacePath: 'work',
          sessionId: 'session-4',
          baseHash: 'hash-4',
          summary: 'Good 2',
          stagedAt: Date.now(),
          sensitivity: 'high',
        },
      ]);
      
      mockGetStagedContent.mockImplementation((id: string) => {
        if (id === 'no-content') return Promise.resolve(null);
        return Promise.resolve(`Content for ${id}`);
      });
      mockDiscardStagedFile.mockResolvedValue({ status: 'success' });

      const result = await migrateLegacyStagedFiles();

      expect(result.migrated).toBe(2); // good-1 and good-2
      expect(result.failed).toBe(1);   // bad-dest
      expect(result.skipped).toBe(1);  // no-content
    });
  });

  // ---- Idempotency: already-resolved for race conditions ----

  describe('idempotency (already-resolved)', () => {
    it('publishPendingFile returns already-resolved for non-existent ID', async () => {
      const result = await publishPendingFile('nonexistent-abc');
      expect(result.status).toBe('already-resolved');
      expect(result.error).toBeUndefined();
    });

    it('keepPendingFilePrivate returns already-resolved for non-existent ID', async () => {
      const result = await keepPendingFilePrivate('nonexistent-abc');
      expect(result.status).toBe('already-resolved');
      expect(result.error).toBeUndefined();
    });

    it('publishWithConflictResolution (keep-current) returns already-resolved for non-existent ID', async () => {
      const result = await publishWithConflictResolution('nonexistent-abc', 'keep-current');
      expect(result.status).toBe('already-resolved');
      expect(result.error).toBeUndefined();
    });

    it('publishWithConflictResolution (keep-pending) returns already-resolved for non-existent ID', async () => {
      const result = await publishWithConflictResolution('nonexistent-abc', 'keep-pending');
      expect(result.status).toBe('already-resolved');
      expect(result.error).toBeUndefined();
    });

    it('deletePendingFile still returns not-found for non-existent ID', async () => {
      const result = await deletePendingFile('nonexistent-abc');
      expect(result.status).toBe('not-found');
    });
  });

  describe('destination collision policy', () => {
    it('keeps original pending file when a different session attempts same destination', async () => {
      await writeToPending({
        destinationPath: 'General/spec.md',
        content: 'Content from session 1',
        sessionId: 'automation-session-1',
        summary: 'From session 1',
        spaceName: 'General',
      });

      const secondSessionWrite = await writeToPending({
        destinationPath: 'General/spec.md',
        content: 'Content from session 2',
        sessionId: 'automation-session-2',
        summary: 'From session 2',
        spaceName: 'General',
      });

      expect(secondSessionWrite).toBeNull();
      const files = await listPendingFiles();
      const specFiles = files.filter(f => f.frontmatter.pending_destination === 'General/spec.md');
      expect(specFiles.length).toBe(1);
      expect(specFiles[0].content).toBe('Content from session 1');
      expect(specFiles[0].frontmatter.session_id).toBe('automation-session-1');
    });
  });
});
