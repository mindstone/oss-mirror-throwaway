import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WORKSPACE_SYNC_TEMP_MARKER } from '@shared/workspaceConstants';

// --- Mocks ---

// @core/platform is dynamically imported by the bridge for persistence.
// We use _setPersistPathForTesting to bypass it in tests.

vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock();
});

vi.mock('../../safety/cosPendingService', () => ({
  writeToPending: vi.fn(),
  deletePendingFile: vi.fn(),
  listPendingFiles: vi.fn(),
  detectPendingConflict: vi.fn().mockResolvedValue({ hasConflict: false, fileModifiedSinceStaging: false, newFileConflict: false }),
}));

vi.mock('../cloudWorkspaceSync', () => ({
  cloudWorkspaceSync: {
    recordPulledFile: vi.fn(),
  },
}));

vi.mock('@core/utils/cloudStorageUtils', async () => {
  const actual = await vi.importActual<typeof import('@core/utils/cloudStorageUtils')>('@core/utils/cloudStorageUtils');
  return {
    ...actual,
    resolveWorkspaceWriteAuthority: vi.fn(() => 'cloud_authoritative'),
  };
});

vi.mock('../../safety/hashUtils', () => ({
  hashContent: (content: string) => `hash-${content.length}`,
}));

import type { SyncClient } from '../cloudWorkspaceSync';
import {
  syncCloudStagedFiles,
  scheduleStagingSync,
  clearStagingSyncTimers,
  notifyBridgeFileResolved,
  _bridgedCloudIdsForTesting as bridgedCloudIds,
  _resetForTesting,
} from '../cloudStagingBridge';
import { writeToPending, deletePendingFile, listPendingFiles, detectPendingConflict } from '../../safety/cosPendingService';
import { cloudWorkspaceSync } from '../cloudWorkspaceSync';
import { resolveWorkspaceWriteAuthority } from '@core/utils/cloudStorageUtils';

const mockWriteToPending = vi.mocked(writeToPending);
const mockDeletePendingFile = vi.mocked(deletePendingFile);
const mockListPendingFiles = vi.mocked(listPendingFiles);
const mockRecordPulledFile = vi.mocked(cloudWorkspaceSync.recordPulledFile);
const mockDetectPendingConflict = vi.mocked(detectPendingConflict);
const mockResolveWorkspaceWriteAuthority = vi.mocked(resolveWorkspaceWriteAuthority);

const WORKSPACE_DIR = '/tmp/test-staging-bridge/workspace';
const PERSIST_FILE = '/tmp/test-staging-bridge/cloud-staging-bridge.json';

function makeClient(responses?: Record<string, unknown>): SyncClient & { post: ReturnType<typeof vi.fn> } {
  return {
    post: vi.fn().mockImplementation((url: string) => {
      if (responses && url in responses) return Promise.resolve(responses[url]);
      return Promise.resolve({});
    }),
  };
}

function makeCloudFile(dest: string, id = 'cloud-1', content = 'cloud content') {
  return {
    file: {
      id,
      realPath: `/data/workspace/${dest}`,
      pendingDestination: dest,
      spaceName: 'Test Space',
      sessionId: 'cloud-session-1',
      baseHash: 'abc123',
      summary: 'Test summary',
      stagedAt: Date.now(),
    },
    content,
  };
}

function makeLocalFile(dest: string, id = 'local-1') {
  return {
    id,
    filename: `260223_120000_${path.basename(dest)}.pending.md`,
    filePath: `/tmp/pending/${dest}.pending.md`,
    frontmatter: {
      pending_destination: dest,
      staged_at: new Date().toISOString(),
      session_id: 'desktop-session-1',
      summary: 'Test summary',
      original_space: 'Test Space',
      base_hash: 'abc123',
    },
    content: 'local content',
  };
}

function cleanup(): void {
  try { fs.rmSync('/tmp/test-staging-bridge', { recursive: true, force: true }); } catch { /* ok */ }
}

describe('cloudStagingBridge', () => {
  beforeEach(() => {
    cleanup();
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    vi.clearAllMocks();
    mockResolveWorkspaceWriteAuthority.mockReturnValue('cloud_authoritative');
    _resetForTesting(PERSIST_FILE);
  });

  afterEach(() => {
    clearStagingSyncTimers();
    cleanup();
  });

  // ---- Pull new cloud-staged files ----

  describe('pull new cloud-staged files', () => {
    it('pulls a file that exists on cloud but not locally', async () => {
      const cf = makeCloudFile('notes/meeting.md', 'cloud-abc');
      const client = makeClient({
        [`/api/ipc/${encodeURIComponent('memory:staging-get-all')}`]:
          { files: [cf.file] },
        [`/api/ipc/${encodeURIComponent('memory:staging-get-content')}`]:
          { content: cf.content },
      });
      mockListPendingFiles.mockResolvedValue([]);
      mockWriteToPending.mockResolvedValue({ id: 'local-new', filename: 'test.pending.md' } as any);

      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      expect(mockWriteToPending).toHaveBeenCalledTimes(1);
      expect(mockWriteToPending).toHaveBeenCalledWith(expect.objectContaining({
        destinationPath: 'notes/meeting.md',
        content: 'cloud content',
        sessionId: 'cloud-session-1',
        baseHash: 'abc123',
      }));
    });

    it('skips files that already exist locally', async () => {
      const cf = makeCloudFile('notes/existing.md', 'cloud-1');
      const lf = makeLocalFile('notes/existing.md', 'local-1');
      const client = makeClient({
        [`/api/ipc/${encodeURIComponent('memory:staging-get-all')}`]:
          { files: [cf.file] },
      });
      mockListPendingFiles.mockResolvedValue([lf]);

      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      expect(mockWriteToPending).not.toHaveBeenCalled();
      // But still records the cloud ID for zombie prevention
      expect(bridgedCloudIds.get('notes/existing.md')).toBe('cloud-1');
    });

    it('skips cloud files with no content', async () => {
      const cf = makeCloudFile('notes/empty.md', 'cloud-empty');
      const client = makeClient({
        [`/api/ipc/${encodeURIComponent('memory:staging-get-all')}`]:
          { files: [cf.file] },
        [`/api/ipc/${encodeURIComponent('memory:staging-get-content')}`]:
          { content: null },
      });
      mockListPendingFiles.mockResolvedValue([]);

      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      expect(mockWriteToPending).not.toHaveBeenCalled();
    });

    it('continues with other files when one pull fails', async () => {
      const cf1 = makeCloudFile('notes/fail.md', 'cloud-fail');
      const cf2 = makeCloudFile('notes/ok.md', 'cloud-ok');
      const getAllUrl = `/api/ipc/${encodeURIComponent('memory:staging-get-all')}`;
      const getContentUrl = `/api/ipc/${encodeURIComponent('memory:staging-get-content')}`;
      let contentCallCount = 0;
      const client: SyncClient & { post: ReturnType<typeof vi.fn> } = {
        post: vi.fn().mockImplementation((url: string) => {
          if (url === getAllUrl) {
            return Promise.resolve({ files: [cf1.file, cf2.file] });
          }
          if (url === getContentUrl) {
            contentCallCount++;
            if (contentCallCount === 1) return Promise.reject(new Error('network error'));
            return Promise.resolve({ content: 'ok content' });
          }
          return Promise.resolve({});
        }),
      };
      mockListPendingFiles.mockResolvedValue([]);
      mockWriteToPending.mockResolvedValue({ id: 'local-new', filename: 'test.pending.md' } as any);

      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      expect(mockWriteToPending).toHaveBeenCalledTimes(1);
      expect(mockWriteToPending).toHaveBeenCalledWith(expect.objectContaining({
        destinationPath: 'notes/ok.md',
      }));
    });
  });

  // ---- Freshly bridged files must not be discarded in same sync ----

  describe('freshly bridged protection', () => {
    it('does NOT discard a cloud file that was just pulled in the same sync', async () => {
      // Cloud has one file, desktop has none. After pull, the zombie loop
      // must NOT see the freshly bridged file as "locally resolved" and discard it.
      const cf = makeCloudFile('notes/new.md', 'cloud-new');
      const client = makeClient({
        [`/api/ipc/${encodeURIComponent('memory:staging-get-all')}`]:
          { files: [cf.file] },
        [`/api/ipc/${encodeURIComponent('memory:staging-get-content')}`]:
          { content: 'new content' },
      });
      mockListPendingFiles.mockResolvedValue([]);
      mockWriteToPending.mockResolvedValue({ id: 'local-new', filename: 'test.pending.md' } as never);

      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      expect(mockWriteToPending).toHaveBeenCalledTimes(1);
      // Must NOT have called staging-discard for the just-pulled file
      const discardCalls = client.post.mock.calls.filter(
        ([url]: unknown[]) => typeof url === 'string' && url.includes('memory:staging-discard'),
      );
      expect(discardCalls).toHaveLength(0);
    });
  });

  // ---- Resolve cloud originals (zombie prevention) ----

  describe('zombie prevention', () => {
    it('resolves cloud original when local file was resolved by user', async () => {
      // Setup: bridge previously pulled this file
      bridgedCloudIds.set('notes/resolved.md', 'cloud-zombie');

      const client = makeClient({
        [`/api/ipc/${encodeURIComponent('memory:staging-get-all')}`]:
          { files: [makeCloudFile('notes/resolved.md', 'cloud-zombie').file] },
        [`/api/ipc/${encodeURIComponent('memory:staging-discard')}`]: { status: 'success' },
      });
      // Local file no longer exists (user resolved it)
      mockListPendingFiles.mockResolvedValue([]);

      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      // Should have called discard on cloud
      expect(client.post).toHaveBeenCalledWith(
        `/api/ipc/${encodeURIComponent('memory:staging-discard')}`,
        { params: [{ id: 'cloud-zombie' }] },
      );
      expect(bridgedCloudIds.has('notes/resolved.md')).toBe(false);
    });

    it('cleans up tracking when both local and cloud are resolved', async () => {
      bridgedCloudIds.set('notes/both-gone.md', 'cloud-gone');

      const client = makeClient({
        [`/api/ipc/${encodeURIComponent('memory:staging-get-all')}`]:
          { files: [] }, // Gone from cloud too
      });
      mockListPendingFiles.mockResolvedValue([]); // Gone locally

      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      expect(bridgedCloudIds.has('notes/both-gone.md')).toBe(false);
      // Should NOT call discard (already gone from cloud)
      expect(client.post).not.toHaveBeenCalledWith(
        expect.stringContaining('memory:staging-discard'),
        expect.anything(),
      );
    });
  });

  // ---- Handle cloud-resolved files ----

  describe('cloud resolution handling', () => {
    it('deletes local pending file when cloud resolved it (discard)', async () => {
      bridgedCloudIds.set('notes/cloud-discarded.md', 'cloud-disc');
      const lf = makeLocalFile('notes/cloud-discarded.md', 'local-disc');

      const client = makeClient({
        [`/api/ipc/${encodeURIComponent('memory:staging-get-all')}`]:
          { files: [] }, // No longer on cloud
        '/api/library/read': { content: null }, // Was discarded, not published
      });
      mockListPendingFiles.mockResolvedValue([lf]);
      mockDeletePendingFile.mockResolvedValue({ status: 'success' });

      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      expect(mockDeletePendingFile).toHaveBeenCalledWith('local-disc');
      expect(bridgedCloudIds.has('notes/cloud-discarded.md')).toBe(false);
    });

    it('pulls published file and deletes local pending when cloud published', async () => {
      bridgedCloudIds.set('notes/cloud-published.md', 'cloud-pub');
      const lf = makeLocalFile('notes/cloud-published.md', 'local-pub');

      const client = makeClient({
        [`/api/ipc/${encodeURIComponent('memory:staging-get-all')}`]:
          { files: [] },
        '/api/library/read': { content: 'published content' },
      });
      mockListPendingFiles.mockResolvedValue([lf]);
      mockDeletePendingFile.mockResolvedValue({ status: 'success' });

      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      // Should have written the published file
      const expectedPath = path.join(WORKSPACE_DIR, 'notes/cloud-published.md');
      const written = fs.readFileSync(expectedPath, 'utf-8');
      expect(written).toBe('published content');

      expect(mockRecordPulledFile).toHaveBeenCalledWith(
        'notes/cloud-published.md',
        expect.objectContaining({ hash: expect.any(String) }),
      );
      expect(mockDeletePendingFile).toHaveBeenCalledWith('local-pub');
    });

    it('defers Drive-authoritative published-file writes', async () => {
      bridgedCloudIds.set('notes/cloud-published.md', 'cloud-pub');
      const lf = makeLocalFile('notes/cloud-published.md', 'local-pub');
      mockResolveWorkspaceWriteAuthority.mockReturnValueOnce('desktop_fs_authoritative');

      const client = makeClient({
        [`/api/ipc/${encodeURIComponent('memory:staging-get-all')}`]: { files: [] },
      });
      mockListPendingFiles.mockResolvedValue([lf]);
      mockDeletePendingFile.mockResolvedValue({ status: 'success' });

      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      const expectedPath = path.join(WORKSPACE_DIR, 'notes/cloud-published.md');
      expect(fs.existsSync(expectedPath)).toBe(false);
      expect(mockRecordPulledFile).not.toHaveBeenCalled();
      expect(client.post).not.toHaveBeenCalledWith('/api/library/read', expect.anything());
      expect(mockDeletePendingFile).toHaveBeenCalledWith('local-pub');
    });

    it('force-delivers Drive-authoritative published files via atomic rename after settle timeout', async () => {
      const dest = 'notes/cloud-published.md';
      const lf = makeLocalFile(dest, 'local-pub');
      mockResolveWorkspaceWriteAuthority.mockReturnValue('desktop_fs_authoritative');

      const client = makeClient({
        [`/api/ipc/${encodeURIComponent('memory:staging-get-all')}`]: { files: [] },
        '/api/library/read': { content: 'published content' },
      });
      mockListPendingFiles.mockResolvedValue([lf]);
      mockDeletePendingFile.mockResolvedValue({ status: 'success' });

      const seedBridgeId = () => {
        bridgedCloudIds.set(dest, 'cloud-pub');
        fs.mkdirSync(path.dirname(PERSIST_FILE), { recursive: true });
        fs.writeFileSync(PERSIST_FILE, JSON.stringify({ [dest]: 'cloud-pub' }), 'utf8');
      };

      for (let i = 0; i < 5; i += 1) {
        seedBridgeId();
        await syncCloudStagedFiles(client, WORKSPACE_DIR);
        expect(fs.existsSync(path.join(WORKSPACE_DIR, dest))).toBe(false);
      }

      seedBridgeId();
      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      const expectedPath = path.join(WORKSPACE_DIR, dest);
      expect(fs.readFileSync(expectedPath, 'utf-8')).toBe('published content');
      expect(fs.readdirSync(path.dirname(expectedPath)).some((name) => name.includes(WORKSPACE_SYNC_TEMP_MARKER))).toBe(false);
      expect(mockRecordPulledFile).toHaveBeenCalledWith(
        dest,
        expect.objectContaining({ hash: expect.any(String) }),
      );
    });

    it('skips published file write when local file has conflict', async () => {
      bridgedCloudIds.set('notes/conflicted.md', 'cloud-conf');
      const lf = makeLocalFile('notes/conflicted.md', 'local-conf');

      const client = makeClient({
        [`/api/ipc/${encodeURIComponent('memory:staging-get-all')}`]:
          { files: [] },
        '/api/library/read': { content: 'published content' },
      });
      mockListPendingFiles.mockResolvedValue([lf]);
      mockDeletePendingFile.mockResolvedValue({ status: 'success' });
      mockDetectPendingConflict.mockResolvedValueOnce({
        hasConflict: true,
        fileModifiedSinceStaging: true,
        newFileConflict: false,
      });

      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      // Should NOT write the published file (conflict detected)
      const expectedPath = path.join(WORKSPACE_DIR, 'notes/conflicted.md');
      expect(fs.existsSync(expectedPath)).toBe(false);
      // Should NOT record a pulled file
      expect(mockRecordPulledFile).not.toHaveBeenCalled();
      // Should still delete local pending (cloud resolved it)
      expect(mockDeletePendingFile).toHaveBeenCalledWith('local-conf');
    });

    it('still deletes local pending even when pull fails', async () => {
      bridgedCloudIds.set('notes/pull-fail.md', 'cloud-pf');
      const lf = makeLocalFile('notes/pull-fail.md', 'local-pf');

      const client = makeClient({
        [`/api/ipc/${encodeURIComponent('memory:staging-get-all')}`]:
          { files: [] },
      });
      client.post.mockImplementation((url: string) => {
        if (url.includes('memory:staging-get-all')) return Promise.resolve({ files: [] });
        if (url === '/api/library/read') return Promise.reject(new Error('network'));
        return Promise.resolve({});
      });
      mockListPendingFiles.mockResolvedValue([lf]);
      mockDeletePendingFile.mockResolvedValue({ status: 'success' });

      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      // Should still delete local pending even though pull failed
      expect(mockDeletePendingFile).toHaveBeenCalledWith('local-pf');
    });

    it('does NOT delete local-only pending files (not bridge-created)', async () => {
      // No entry in bridgedCloudIds — this file was created by desktop agent
      const lf = makeLocalFile('notes/desktop-only.md', 'local-desktop');

      const client = makeClient({
        [`/api/ipc/${encodeURIComponent('memory:staging-get-all')}`]:
          { files: [] },
      });
      mockListPendingFiles.mockResolvedValue([lf]);

      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      // Should NOT delete desktop-created files
      expect(mockDeletePendingFile).not.toHaveBeenCalled();
    });
  });

  // ---- Path traversal ----

  describe('path traversal protection', () => {
    it('refuses to write published file outside coreDirectory', async () => {
      bridgedCloudIds.set('../../etc/passwd', 'cloud-evil');
      const lf = makeLocalFile('../../etc/passwd', 'local-evil');

      const client = makeClient({
        [`/api/ipc/${encodeURIComponent('memory:staging-get-all')}`]:
          { files: [] },
        '/api/library/read': { content: 'malicious content' },
      });
      mockListPendingFiles.mockResolvedValue([lf]);
      mockDeletePendingFile.mockResolvedValue({ status: 'success' });

      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      // The traversal target resolves to /tmp/etc/passwd — must not exist
      const traversalTarget = path.resolve(WORKSPACE_DIR, '../../etc/passwd');
      expect(fs.existsSync(traversalTarget)).toBe(false);
      // Should still clean up local pending
      expect(mockDeletePendingFile).toHaveBeenCalledWith('local-evil');
    });
  });

  // ---- Debounce & serialization ----

  describe('debounce and serialization', () => {
    it('re-syncs after concurrent request completes', async () => {
      const getAllUrl = `/api/ipc/${encodeURIComponent('memory:staging-get-all')}`;
      const client = makeClient({
        [getAllUrl]: { files: [] },
      });
      mockListPendingFiles.mockResolvedValue([]);

      // Start first sync, then immediately start second (sets syncRequested flag)
      const p1 = syncCloudStagedFiles(client, WORKSPACE_DIR);
      const p2 = syncCloudStagedFiles(client, WORKSPACE_DIR);
      await Promise.all([p1, p2]);

      // Should have run twice: original + re-sync after concurrent request
      const getAllCalls = client.post.mock.calls.filter(
        (c: unknown[]) => (c[0] as string) === getAllUrl,
      );
      expect(getAllCalls.length).toBe(2);
    });

    it('clears timers but preserves bridgedCloudIds on clearStagingSyncTimers', () => {
      bridgedCloudIds.set('test', 'id');
      const client = makeClient();

      scheduleStagingSync(client, WORKSPACE_DIR);
      clearStagingSyncTimers();

      // Timers cleared, but zombie tracking preserved (survives reconnect)
      expect(bridgedCloudIds.size).toBe(1);
      expect(bridgedCloudIds.get('test')).toBe('id');
    });
  });

  // ---- Persistence ----

  describe('persistence', () => {
    // Note: persistence write is tested implicitly via the "loads persisted state"
    // test below. Direct file assertion is unreliable because vitest mocking creates
    // separate module instances, and the bridge's internal `persistPath` may differ
    // from the test's `_resetForTesting` call.

    it('loads persisted state on next sync', async () => {
      // Write persistence file manually
      fs.mkdirSync(path.dirname(PERSIST_FILE), { recursive: true });
      fs.writeFileSync(PERSIST_FILE, JSON.stringify({ 'notes/pre-existing.md': 'cloud-pre' }));
      bridgedCloudIds.clear();

      // Now a local file exists for that dest but cloud doesn't have it
      const lf = makeLocalFile('notes/pre-existing.md', 'local-pre');
      const client = makeClient({
        [`/api/ipc/${encodeURIComponent('memory:staging-get-all')}`]:
          { files: [] },
        '/api/library/read': { content: null },
      });
      mockListPendingFiles.mockResolvedValue([lf]);
      mockDeletePendingFile.mockResolvedValue({ status: 'success' });

      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      // Should recognize as bridge-created from persisted state and delete
      expect(mockDeletePendingFile).toHaveBeenCalledWith('local-pre');
    });
  });

  // ---- Error handling ----

  describe('error handling', () => {
    it('handles cloud fetch failure gracefully', async () => {
      const client = makeClient();
      client.post.mockRejectedValue(new Error('network error'));

      // Should not throw
      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      expect(mockListPendingFiles).not.toHaveBeenCalled();
    });

    it('handles empty/malformed cloud response', async () => {
      const client = makeClient({
        [`/api/ipc/${encodeURIComponent('memory:staging-get-all')}`]:
          { files: undefined },
      });
      mockListPendingFiles.mockResolvedValue([]);

      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      // Should not throw, no files to process
      expect(mockWriteToPending).not.toHaveBeenCalled();
    });
  });

  // ---- FOX-2802: Deny/dismiss should not re-download (infinite loop fix) ----

  describe('FOX-2802: deny/dismiss should not re-download', () => {
    it('should not re-download a previously bridged file after user deny (confirms bug)', async () => {
      // Scenario: bridge pulled file -> user denied -> local deleted -> next sync
      // Bug: pull phase sees "cloud has file, local doesn't" and re-downloads
      // Expected: zombie prevention should discard cloud record, NOT re-download

      // 1. Bridge previously pulled this file (simulated by setting bridgedCloudIds)
      bridgedCloudIds.set('General/spec.md', 'cloud-denied');

      // 2. Cloud still has the file (hasn't been told to discard yet)
      const cf = makeCloudFile('General/spec.md', 'cloud-denied');
      const client = makeClient({
        [`/api/ipc/${encodeURIComponent('memory:staging-get-all')}`]:
          { files: [cf.file] },
        [`/api/ipc/${encodeURIComponent('memory:staging-get-content')}`]:
          { content: cf.content },
        [`/api/ipc/${encodeURIComponent('memory:staging-discard')}`]:
          { status: 'success' },
      });

      // 3. Local file was deleted by user (deny action)
      mockListPendingFiles.mockResolvedValue([]);
      mockWriteToPending.mockResolvedValue({ id: 'local-new', filename: 'test.pending.md' } as never);

      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      // Must NOT re-download the denied file
      expect(mockWriteToPending).not.toHaveBeenCalled();

      // Should discard the cloud record via zombie prevention
      expect(client.post).toHaveBeenCalledWith(
        `/api/ipc/${encodeURIComponent('memory:staging-discard')}`,
        { params: [{ id: 'cloud-denied' }] },
      );

      // bridgedCloudIds should be cleaned up
      expect(bridgedCloudIds.has('General/spec.md')).toBe(false);
    });

    it('should not re-download even after multiple sync cycles (full deny→sync→sync flow)', async () => {
      // Integration-style test: simulates real sequence across TWO sync cycles.
      // Cycle 1: bridge pulls file, user denies (local deleted between syncs)
      // Cycle 2: bridge must NOT re-pull, zombie prevention must discard cloud record

      const cf = makeCloudFile('General/spec.md', 'cloud-denied');
      const discardUrl = `/api/ipc/${encodeURIComponent('memory:staging-discard')}`;

      // --- Cycle 1: Initial pull (file is new) ---
      const client = makeClient({
        [`/api/ipc/${encodeURIComponent('memory:staging-get-all')}`]:
          { files: [cf.file] },
        [`/api/ipc/${encodeURIComponent('memory:staging-get-content')}`]:
          { content: cf.content },
        [discardUrl]: { status: 'success' },
      });
      mockListPendingFiles.mockResolvedValue([]);
      mockWriteToPending.mockResolvedValue({ id: 'local-new', filename: 'test.pending.md' } as never);

      await syncCloudStagedFiles(client, WORKSPACE_DIR);
      expect(mockWriteToPending).toHaveBeenCalledTimes(1); // pulled
      expect(bridgedCloudIds.get('General/spec.md')).toBe('cloud-denied');

      // --- User denies: local pending file is deleted (simulated by empty listPendingFiles) ---
      // Note: IPC handlers do NOT clear bridgedCloudIds — that's the key design.
      vi.clearAllMocks();

      // --- Cycle 2: Next sync - file still on cloud, local gone ---
      mockListPendingFiles.mockResolvedValue([]);
      mockWriteToPending.mockResolvedValue({ id: 'local-re', filename: 'test2.pending.md' } as never);

      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      // Must NOT re-download
      expect(mockWriteToPending).not.toHaveBeenCalled();
      // Must discard cloud record via zombie prevention
      expect(client.post).toHaveBeenCalledWith(discardUrl, { params: [{ id: 'cloud-denied' }] });
      // bridgedCloudIds cleaned up
      expect(bridgedCloudIds.has('General/spec.md')).toBe(false);
    });

    it('should still pull genuinely new files (not previously bridged)', async () => {
      // Ensure the fix doesn't break normal first-time pulls
      const cf = makeCloudFile('General/new-file.md', 'cloud-new');
      const client = makeClient({
        [`/api/ipc/${encodeURIComponent('memory:staging-get-all')}`]:
          { files: [cf.file] },
        [`/api/ipc/${encodeURIComponent('memory:staging-get-content')}`]:
          { content: cf.content },
      });
      mockListPendingFiles.mockResolvedValue([]);
      mockWriteToPending.mockResolvedValue({ id: 'local-new', filename: 'test.pending.md' } as never);

      // No entry in bridgedCloudIds — truly new file
      await syncCloudStagedFiles(client, WORKSPACE_DIR);

      // Should pull the new file
      expect(mockWriteToPending).toHaveBeenCalledTimes(1);
    });
  });

  // ---- FOX-2802: notifyBridgeFileResolved ----

  describe('FOX-2802: notifyBridgeFileResolved', () => {
    it('clears bridgedCloudIds and persists state on resolve', async () => {
      bridgedCloudIds.set('General/resolved.md', 'cloud-res');

      await notifyBridgeFileResolved('General/resolved.md');

      expect(bridgedCloudIds.has('General/resolved.md')).toBe(false);
    });

    it('is a no-op for non-bridged destinations', async () => {
      // Should not throw or affect other entries
      bridgedCloudIds.set('other/file.md', 'cloud-other');

      await notifyBridgeFileResolved('unknown/file.md');

      expect(bridgedCloudIds.get('other/file.md')).toBe('cloud-other');
    });
  });
});
