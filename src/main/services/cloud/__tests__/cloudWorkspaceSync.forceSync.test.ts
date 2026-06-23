import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-ws-force',
}));

import { CloudWorkspaceSync } from '../cloudWorkspaceSync';
import type { SyncClient } from '../cloudWorkspaceSync';

const WORKSPACE_DIR = '/tmp/test-cloud-ws-force/workspace';

function makeClient(opts?: { postFails?: boolean }): SyncClient & { post: ReturnType<typeof vi.fn> } {
  return {
    post: vi.fn().mockImplementation((endpoint: string) => {
      if (opts?.postFails) return Promise.reject(new Error('network error'));
      // Return empty manifest for pull-phase calls
      if (endpoint === '/api/library/manifest') return Promise.resolve({});
      return Promise.resolve({ path: 'test', updatedAt: Date.now() });
    }),
  };
}

function createWorkspaceFile(relativePath: string, content: string): void {
  const fullPath = path.join(WORKSPACE_DIR, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
}

describe('CloudWorkspaceSync - forceSync, syncSoon, recordPulledFile', () => {
  let sync: CloudWorkspaceSync;

  beforeEach(() => {
    sync = new CloudWorkspaceSync();
    cleanupDir('/tmp/test-cloud-ws-force');
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  });

  afterEach(() => {
    sync._resetForTesting();
    cleanupDir('/tmp/test-cloud-ws-force');
  });

  // ---------------------------------------------------------------------------
  // forceSync
  // ---------------------------------------------------------------------------

  describe('forceSync', () => {
    it('bypasses the 5-minute throttle (syncs right after syncIfNeeded)', async () => {
      createWorkspaceFile('file.txt', 'content v1');

      const client = makeClient();
      // syncIfNeeded sets lastSyncAt (1 push + 1 manifest = 2 calls)
      await sync.syncIfNeeded(client, WORKSPACE_DIR);
      expect(client.post).toHaveBeenCalledTimes(2);

      // Modify the file so there's something to push
      createWorkspaceFile('file.txt', 'content v2');
      const futureTime = new Date(Date.now() + 2000);
      fs.utimesSync(path.join(WORKSPACE_DIR, 'file.txt'), futureTime, futureTime);

      // syncIfNeeded would be throttled (< 5 min since last sync)
      await sync.syncIfNeeded(client, WORKSPACE_DIR);
      // Still only 2 calls — throttled
      expect(client.post).toHaveBeenCalledTimes(2);

      // forceSync bypasses the throttle (1 push + 1 manifest = 2 more calls)
      const result = await sync.forceSync(client, WORKSPACE_DIR);
      expect(result.pushed).toBe(1);
      expect(client.post).toHaveBeenCalledTimes(4);
    });

    it('respects syncInProgress mutex (returns early if sync already running)', async () => {
      createWorkspaceFile('file.txt', 'content');

      const resolvers: Array<() => void> = [];
      const client = {
        post: vi.fn().mockImplementation((endpoint: string) => {
          if (endpoint === '/api/library/manifest') return Promise.resolve({});
          return new Promise<void>((r) => { resolvers.push(r); });
        }),
      };

      // Start first forceSync (blocks on the pending post)
      const first = sync.forceSync(client, WORKSPACE_DIR);

      // Wait until first sync reaches the blocking push call (manifest + push = 2 calls)
      await vi.waitFor(() => expect(client.post.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });

      // Second forceSync should return early with zeros
      const second = await sync.forceSync(client, WORKSPACE_DIR);
      expect(second).toEqual({ pushed: 0, skipped: 0, failed: 0 });

      // Let first complete
      resolvers.forEach((r) => r());
      await first;
    });

    it('returns PushResult with pushed/skipped/failed counts', async () => {
      createWorkspaceFile('a.txt', 'aaa');
      createWorkspaceFile('b.txt', 'bbb');

      const client = makeClient();
      const result = await sync.forceSync(client, WORKSPACE_DIR);

      expect(result.pushed).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('handles deleted files (same as syncIfNeeded)', async () => {
      createWorkspaceFile('to-delete.txt', 'will be deleted');
      const client = makeClient();
      // First push so the file is in the manifest
      await sync.forceSync(client, WORKSPACE_DIR);
      expect(sync._getLastPushedManifest().has('to-delete.txt')).toBe(true);

      // Delete the file locally
      fs.rmSync(path.join(WORKSPACE_DIR, 'to-delete.txt'));

      // Force sync again — should issue a cloud delete
      await sync.forceSync(client, WORKSPACE_DIR);
      expect(client.post).toHaveBeenCalledWith('/api/library/delete-file', { path: 'to-delete.txt' });
      expect(sync._getLastPushedManifest().has('to-delete.txt')).toBe(false);
    });

    it('re-pushes files that cloud lost (cloud-missing repair)', async () => {
      createWorkspaceFile('skill.md', '# My Skill');
      createWorkspaceFile('other.md', '# Other');

      const client = makeClient();

      // First push: both files land on cloud
      const result1 = await sync.forceSync(client, WORKSPACE_DIR);
      expect(result1.pushed).toBe(2);

      // Simulate cloud losing 'skill.md' — manifest returns only 'other.md'
      const otherEntry = sync._getLastPushedManifest().get('other.md')!;
      client.post.mockImplementation((endpoint: string) => {
        if (endpoint === '/api/library/manifest') {
          return Promise.resolve({
            entries: {
              'other.md': { hash: otherEntry.hash, size: otherEntry.size },
            },
            complete: true,
            reasons: [],
          });
        }
        return Promise.resolve({ path: 'test', updatedAt: Date.now() });
      });
      client.post.mockClear();

      // Force sync: skill.md hasn't changed locally, but cloud lost it → re-push
      const result2 = await sync.forceSync(client, WORKSPACE_DIR);
      expect(result2.pushed).toBe(1);

      // Verify the upload was for 'skill.md'
      const uploadCalls = client.post.mock.calls.filter(
        (args) => args[0] === '/api/library/upload-file',
      );
      expect(uploadCalls).toHaveLength(1);
      expect(uploadCalls[0][1].path).toBe('skill.md');
    });

    it('returns zeros when no changes exist', async () => {
      // Empty workspace — still calls manifest for pull phase
      const client = makeClient();
      const result = await sync.forceSync(client, WORKSPACE_DIR);

      expect(result).toEqual({ pushed: 0, skipped: 0, failed: 0 });
      // 1 manifest call for pull phase (no push calls)
      expect(client.post).toHaveBeenCalledTimes(1);
      expect(client.post).toHaveBeenCalledWith('/api/library/manifest', {});
    });
  });

  // ---------------------------------------------------------------------------
  // syncSoon
  // ---------------------------------------------------------------------------

  describe('syncSoon', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('debounces rapid calls (5 calls, only 1 sync after 15s quiet)', async () => {
      // flushSyncSoon now calls syncIfNeeded (throttled) instead of forceSync
      const syncIfNeededSpy = vi.spyOn(sync, 'syncIfNeeded').mockResolvedValue('synced');
      const client = makeClient();

      // Call syncSoon 5 times rapidly
      for (let i = 0; i < 5; i++) {
        sync.syncSoon(client, WORKSPACE_DIR);
      }

      // Before debounce window: no sync
      expect(syncIfNeededSpy).not.toHaveBeenCalled();

      // Advance past the 15s trailing debounce
      await vi.advanceTimersByTimeAsync(15_000);

      expect(syncIfNeededSpy).toHaveBeenCalledTimes(1);
      expect(syncIfNeededSpy).toHaveBeenCalledWith(client, WORKSPACE_DIR);
    });

    it('respects 2-minute max-wait (syncs even with continuous calls)', async () => {
      // flushSyncSoon now calls syncIfNeeded (throttled) instead of forceSync
      const syncIfNeededSpy = vi.spyOn(sync, 'syncIfNeeded').mockResolvedValue('synced');
      const client = makeClient();

      // Call syncSoon every 10s for 2.5 minutes. The 15s debounce resets
      // each time, but the 2-minute max-wait should fire a sync.
      for (let elapsed = 0; elapsed < 150_000; elapsed += 10_000) {
        sync.syncSoon(client, WORKSPACE_DIR);
        await vi.advanceTimersByTimeAsync(10_000);
      }

      // Should have been called at least once due to the 2-minute cap
      expect(syncIfNeededSpy).toHaveBeenCalled();
    });

    it('clears timers on clearSyncSoonTimers()', async () => {
      const syncIfNeededSpy = vi.spyOn(sync, 'syncIfNeeded').mockResolvedValue('synced');
      const client = makeClient();

      sync.syncSoon(client, WORKSPACE_DIR);

      // Clear before debounce fires
      sync.clearSyncSoonTimers();

      // Advance well past both debounce and max-wait
      await vi.advanceTimersByTimeAsync(200_000);

      expect(syncIfNeededSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // recordPulledFile
  // ---------------------------------------------------------------------------

  describe('recordPulledFile', () => {
    it('updates the manifest (prevents re-upload on next sync)', () => {
      const entry = { mtime: Date.now(), size: 100, hash: 'abc1234567890123' };
      sync.recordPulledFile('pulled/file.txt', entry);

      const manifest = sync._getLastPushedManifest();
      expect(manifest.has('pulled/file.txt')).toBe(true);
      expect(manifest.get('pulled/file.txt')).toEqual(entry);
    });

    it('schedules a disk write', () => {
      const entry = { mtime: Date.now(), size: 100, hash: 'abc1234567890123' };
      sync.recordPulledFile('pulled/file.txt', entry);

      // Flush the scheduled write timer
      sync.flush();

      const manifestPath = path.join('/tmp/test-cloud-ws-force', 'sessions', 'cloud-workspace-manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      expect(data['pulled/file.txt']).toEqual(entry);
    });
  });
});
