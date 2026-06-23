import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { WORKSPACE_SYNC_TEMP_MARKER } from '@shared/workspaceConstants';

vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-ws-drive-aware',
}));

// Hoisted so the compression tests can assert which broadcast channels fired
// (and how often) within a sync cycle. Existing tests don't read it.
const sendToAllWindowsSpy = vi.hoisted(() => vi.fn());
vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock({ sendToAllWindows: sendToAllWindowsSpy });
});

vi.mock('@core/utils/cloudStorageUtils', async () => {
  const actual = await vi.importActual<typeof import('@core/utils/cloudStorageUtils')>('@core/utils/cloudStorageUtils');
  return {
    ...actual,
    resolveWorkspaceWriteAuthority: vi.fn(() => 'desktop_fs_authoritative'),
  };
});

vi.mock('../driveAwareSyncNoticeStore', () => ({
  buildDriveAwareWorkspaceFingerprint: vi.fn(() => 'workspace-fp'),
  hasDriveAwareSyncNoticeBeenShown: vi.fn(() => false),
  markDriveAwareSyncNoticeShown: vi.fn(() => ({ workspaceFingerprint: 'workspace-fp', timestamp: 1 })),
}));

import { CloudWorkspaceSync } from '../cloudWorkspaceSync';
import type { CloudManifest, SyncClient } from '../cloudWorkspaceSync';
import {
  _resetDriveSettleDeferralsForTesting,
  evaluateDriveSettleDeferral,
  getActiveDriveSettleDeferrals,
} from '../driveSettleDeferral';
import { getPendingCloudUpdate, getPendingCloudUpdates } from '../cloudPendingUpdateStore';
import { listQuarantinedWorkspaceConflicts } from '../cloudConflictQuarantine';
import { resolveWorkspaceWriteAuthority } from '@core/utils/cloudStorageUtils';

const WORKSPACE_DIR = '/tmp/test-cloud-ws-drive-aware/workspace';
const REL_PATH = 'sources/2026/05-May/18/new-note.md';

function cleanup(): void {
  try {
    fs.rmSync('/tmp/test-cloud-ws-drive-aware', { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

function makeCloudManifest(entries: CloudManifest['entries']): CloudManifest {
  return { entries, complete: true, reasons: [] };
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function createWorkspaceFile(relativePath: string, content: string): void {
  const fullPath = path.join(WORKSPACE_DIR, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function makeClient(
  cloudEntries: CloudManifest['entries'],
  contents: Record<string, string>,
): SyncClient & { post: ReturnType<typeof vi.fn> } {
  const cloudManifest = makeCloudManifest(cloudEntries);
  return {
    post: vi.fn().mockImplementation((endpoint: string, body?: { path?: string }) => {
      if (endpoint === '/api/library/manifest') return Promise.resolve(cloudManifest);
      if (endpoint === '/api/library/read' && body?.path) {
        return Promise.resolve({ content: contents[body.path] });
      }
      return Promise.resolve({});
    }),
  };
}

describe('CloudWorkspaceSync drive-aware pull deferral', () => {
  let syncA: CloudWorkspaceSync;
  let syncB: CloudWorkspaceSync;

  beforeEach(() => {
    cleanup();
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    syncA = new CloudWorkspaceSync();
    syncB = new CloudWorkspaceSync();
    _resetDriveSettleDeferralsForTesting();
    vi.mocked(resolveWorkspaceWriteAuthority).mockReturnValue('desktop_fs_authoritative');
  });

  afterEach(() => {
    syncA._resetForTesting();
    syncB._resetForTesting();
    _resetDriveSettleDeferralsForTesting();
    cleanup();
  });

  it('defers edited files on provider-authoritative paths and records pending cloud update', async () => {
    const originalContent = 'original content';
    const cloudContent = 'cloud edited content';
    const originalHash = hashContent(originalContent);
    const cloudHash = hashContent(cloudContent);
    const relativePath = 'notes/edited.md';
    createWorkspaceFile(relativePath, originalContent);

    syncA.load();
    syncA.recordPulledFile(relativePath, {
      mtime: Math.floor(fs.statSync(path.join(WORKSPACE_DIR, relativePath)).mtimeMs),
      size: Buffer.byteLength(originalContent),
      hash: originalHash,
    });

    const client = makeClient(
      { [relativePath]: { hash: cloudHash, size: Buffer.byteLength(cloudContent) } },
      { [relativePath]: cloudContent },
    );

    const result = await syncA.pullChangedFiles(client, WORKSPACE_DIR);

    expect(result.pulled).toBe(0);
    expect(result.deferredEditedCloud).toBe(1);
    expect(result.deferredDriveSettle).toBe(0);
    expect(result.forcedAfterSettle).toBe(0);
    expect(fs.readFileSync(path.join(WORKSPACE_DIR, relativePath), 'utf8')).toBe(originalContent);
    expect(client.post).not.toHaveBeenCalledWith('/api/library/read', expect.anything());
    expect(getPendingCloudUpdates(WORKSPACE_DIR)).toEqual([
      expect.objectContaining({
        relativePath,
        cloudHash,
        baselineLocalHash: originalHash,
      }),
    ]);
  });

  it('TOCTOU guard: a local edit between classification and the deferral record does NOT poison the pending baseline', async () => {
    // The candidate is classified `edited` because the local file still equals the
    // last-synced baseline. If the user edits the file in the window before the
    // deferral branch records the pending update, recording that edited hash as the
    // "safe baseline" would later let one-click apply overwrite the edit (data loss).
    const originalContent = 'original content';
    const cloudContent = 'cloud edited content';
    const userEditContent = 'user just edited this locally, in-cycle';
    const originalHash = hashContent(originalContent);
    const cloudHash = hashContent(cloudContent);
    const userEditHash = hashContent(userEditContent);
    const relativePath = 'notes/edited.md';
    createWorkspaceFile(relativePath, originalContent);

    syncA.load();
    syncA.recordPulledFile(relativePath, {
      mtime: Math.floor(fs.statSync(path.join(WORKSPACE_DIR, relativePath)).mtimeMs),
      size: Buffer.byteLength(originalContent),
      hash: originalHash,
    });

    // Classification sees the safe-to-fast-forward baseline (→ edited); the
    // deferral-branch re-read sees the user's in-cycle edit.
    const hashSpy = vi
      .spyOn(syncA as unknown as { hashFile: (p: string) => Promise<string> }, 'hashFile')
      .mockResolvedValueOnce(originalHash)
      .mockResolvedValue(userEditHash);

    const client = makeClient(
      { [relativePath]: { hash: cloudHash, size: Buffer.byteLength(cloudContent) } },
      { [relativePath]: cloudContent },
    );

    const result = await syncA.pullChangedFiles(client, WORKSPACE_DIR);
    hashSpy.mockRestore();

    // No in-place write and no cloud read.
    expect(fs.readFileSync(path.join(WORKSPACE_DIR, relativePath), 'utf8')).toBe(originalContent);
    expect(client.post).not.toHaveBeenCalledWith('/api/library/read', expect.anything());
    // CRITICAL: NO pending update recorded with the user's edit as the baseline —
    // it is skipped and reclassified as a conflict on the next cycle.
    expect(getPendingCloudUpdates(WORKSPACE_DIR)).toEqual([]);
    expect(result.deferredEditedCloud).toBe(0);
  });

  it('clears pending edited update when the local hash reaches the cloud hash', async () => {
    const originalContent = 'original content';
    const cloudContent = 'cloud edited content';
    const originalHash = hashContent(originalContent);
    const cloudHash = hashContent(cloudContent);
    const relativePath = 'notes/converges.md';
    const localPath = path.join(WORKSPACE_DIR, relativePath);
    createWorkspaceFile(relativePath, originalContent);

    syncA.load();
    syncA.recordPulledFile(relativePath, {
      mtime: Math.floor(fs.statSync(localPath).mtimeMs),
      size: Buffer.byteLength(originalContent),
      hash: originalHash,
    });

    const client = makeClient(
      { [relativePath]: { hash: cloudHash, size: Buffer.byteLength(cloudContent) } },
      { [relativePath]: cloudContent },
    );

    const deferred = await syncA.pullChangedFiles(client, WORKSPACE_DIR);
    expect(deferred.deferredEditedCloud).toBe(1);
    expect(getPendingCloudUpdates(WORKSPACE_DIR)).toHaveLength(1);

    fs.writeFileSync(localPath, cloudContent, 'utf8');
    const converged = await syncA.pullChangedFiles(client, WORKSPACE_DIR);

    expect(converged.pulled).toBe(0);
    expect(converged.deferredEditedCloud).toBe(0);
    expect(getPendingCloudUpdates(WORKSPACE_DIR)).toHaveLength(0);
  });

  it('defers on both instances and force-pulls after bounded settle timeout', async () => {
    const client = makeClient(
      {
        [REL_PATH]: {
          hash: 'abc1234567890def',
          size: 19,
        },
      },
      {
        [REL_PATH]: 'cloud delivered text',
      },
    );

    const targetDir = path.join(WORKSPACE_DIR, path.dirname(REL_PATH));

    const first = await syncA.pullChangedFiles(client, WORKSPACE_DIR);
    const second = await syncB.pullChangedFiles(client, WORKSPACE_DIR);

    expect(first.pulled).toBe(0);
    expect(second.pulled).toBe(0);
    expect(first.deferredDriveSettle).toBe(1);
    expect(second.deferredDriveSettle).toBe(1);
    expect(first.forcedAfterSettle).toBe(0);
    expect(second.forcedAfterSettle).toBe(0);
    expect(fs.existsSync(targetDir)).toBe(false);

    for (let i = 0; i < 3; i += 1) {
      const deferred = await syncA.pullChangedFiles(client, WORKSPACE_DIR);
      expect(deferred.deferredDriveSettle).toBe(1);
      expect(deferred.forcedAfterSettle).toBe(0);
      expect(deferred.pulled).toBe(0);
      expect(fs.existsSync(targetDir)).toBe(false);
    }

    const forced = await syncB.pullChangedFiles(client, WORKSPACE_DIR);
    expect(forced.forcedAfterSettle).toBe(1);
    expect(forced.pulled).toBe(1);
    expect(fs.existsSync(targetDir)).toBe(true);

    const localPath = path.join(WORKSPACE_DIR, REL_PATH);
    expect(fs.readFileSync(localPath, 'utf8')).toBe('cloud delivered text');
    expect(fs.readdirSync(path.dirname(localPath)).some((name) => name.includes(WORKSPACE_SYNC_TEMP_MARKER))).toBe(false);
  });

  it('excludes cloud-pull temp files from the push manifest walk', async () => {
    fs.mkdirSync(path.join(WORKSPACE_DIR, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, 'notes', 'real.md'), 'real', 'utf8');
    fs.writeFileSync(
      path.join(WORKSPACE_DIR, 'notes', `.real.md.test${WORKSPACE_SYNC_TEMP_MARKER}`),
      'temp',
      'utf8',
    );

    const { manifest } = await syncA.buildLocalManifest(WORKSPACE_DIR);

    expect(manifest.has('notes/real.md')).toBe(true);
    expect(Array.from(manifest.keys()).some((key) => key.includes(WORKSPACE_SYNC_TEMP_MARKER))).toBe(false);
  });

  it('quarantines cloud conflict copies outside provider-authoritative workspaces', async () => {
    const originalContent = 'original';
    const localEdited = 'local edited';
    const cloudEdited = 'cloud edited';
    const originalHash = hashContent(originalContent);
    const cloudHash = hashContent(cloudEdited);
    const relativePath = 'notes/shared.md';
    createWorkspaceFile(relativePath, localEdited);

    syncA.load();
    syncA.recordPulledFile(relativePath, {
      mtime: 1000,
      size: Buffer.byteLength(originalContent),
      hash: originalHash,
    });

    const client = makeClient(
      { [relativePath]: { hash: cloudHash, size: Buffer.byteLength(cloudEdited) } },
      { [relativePath]: cloudEdited },
    );

    const result = await syncA.pullChangedFiles(client, WORKSPACE_DIR);

    expect(result.conflicts).toBe(1);
    expect(fs.existsSync(path.join(WORKSPACE_DIR, 'notes', 'shared.conflict-cloud.md'))).toBe(false);
    const quarantined = listQuarantinedWorkspaceConflicts(WORKSPACE_DIR);
    expect(quarantined).toEqual([
      expect.objectContaining({
        relativePath,
        localPath: path.join(WORKSPACE_DIR, relativePath),
      }),
    ]);
    expect(quarantined[0].cloudCopyPath.startsWith(WORKSPACE_DIR)).toBe(false);
    expect(fs.readFileSync(quarantined[0].cloudCopyPath, 'utf8')).toBe(cloudEdited);
  });

  it('placeholder regression: a present (dataless) macOS File-Provider stub takes the edited/defer path, NOT new-force-write', async () => {
    // Spike finding (verified live via `brctl evict` on iCloud, 2026-06-19, and
    // confirmed for Google Drive CloudStorage): a dataless File-Provider
    // placeholder keeps its REAL NAME — `fs.existsSync` returns TRUE and
    // `fs.statSync` returns the logical size without blocking. So such a file is
    // classified `reason:'edited'` (exists + baseline hash matches), NOT
    // `reason:'new'`. The F5 misclassification (force-write racing hydration)
    // is therefore confined to LEGACY `.icloud` stubs / OneDrive-on-Windows,
    // out of scope for the Drive-on-macOS case this fix targets.
    //
    // We can't synthesise a real dataless stub in a unit test, but we CAN pin
    // the consequence: a file that exists locally with the baseline hash takes
    // the edited deferral (records a pending update; no in-place write), which
    // is exactly the path a present placeholder follows.
    const baselineContent = 'placeholder logical content';
    const cloudContent = 'cloud newer content';
    const baselineHash = hashContent(baselineContent);
    const cloudHash = hashContent(cloudContent);
    const relativePath = 'memory/topics/placeholder-stub.md';
    const localPath = path.join(WORKSPACE_DIR, relativePath);
    // Present-but-stub stand-in: the file EXISTS (existsSync true) with the
    // baseline content, mirroring a hydrated-name placeholder.
    createWorkspaceFile(relativePath, baselineContent);
    expect(fs.existsSync(localPath)).toBe(true);

    syncA.load();
    syncA.recordPulledFile(relativePath, {
      mtime: Math.floor(fs.statSync(localPath).mtimeMs),
      size: Buffer.byteLength(baselineContent),
      hash: baselineHash,
    });

    const client = makeClient(
      { [relativePath]: { hash: cloudHash, size: Buffer.byteLength(cloudContent) } },
      { [relativePath]: cloudContent },
    );

    const result = await syncA.pullChangedFiles(client, WORKSPACE_DIR);

    // Edited/defer path — NOT force-write. The local placeholder is untouched.
    expect(result.deferredEditedCloud).toBe(1);
    expect(result.forcedAfterSettle).toBe(0);
    expect(result.pulled).toBe(0);
    expect(fs.readFileSync(localPath, 'utf8')).toBe(baselineContent);
    expect(getPendingCloudUpdates(WORKSPACE_DIR)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath, cloudHash, baselineLocalHash: baselineHash }),
      ]),
    );
  });

  it('clears stale deferral state when Drive delivers before candidate construction', async () => {
    const client = makeClient(
      {
        [REL_PATH]: {
          hash: 'abc1234567890def',
          size: 19,
        },
      },
      {
        [REL_PATH]: 'cloud delivered text',
      },
    );
    const localPath = path.join(WORKSPACE_DIR, REL_PATH);

    const first = await syncA.pullChangedFiles(client, WORKSPACE_DIR);
    expect(first.deferredDriveSettle).toBe(1);
    expect(getActiveDriveSettleDeferrals(WORKSPACE_DIR)).toHaveLength(1);

    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'delivered by Drive', 'utf8');

    await syncA.pullChangedFiles(client, WORKSPACE_DIR);
    expect(getActiveDriveSettleDeferrals(WORKSPACE_DIR)).toHaveLength(0);

    fs.rmSync(localPath, { force: true });
    const restarted = await syncA.pullChangedFiles(client, WORKSPACE_DIR);
    expect(restarted.deferredDriveSettle).toBe(1);
    expect(restarted.forcedAfterSettle).toBe(0);
  });

  it('continues staged-write deferral counters through workspace pull fallback', async () => {
    const client = makeClient(
      {
        [REL_PATH]: {
          hash: 'abc1234567890def',
          size: 19,
        },
      },
      {
        [REL_PATH]: 'cloud delivered text',
      },
    );
    const localPath = path.join(WORKSPACE_DIR, REL_PATH);

    // Simulate a prior deferral from cloudStagingBridge for the same path.
    const seededNow = Date.now();
    const seeded = evaluateDriveSettleDeferral({
      coreDirectory: WORKSPACE_DIR,
      relativePath: REL_PATH,
      localPath,
      nowMs: seededNow,
    });
    expect(seeded.action).toBe('defer');

    for (let i = 0; i < 4; i += 1) {
      const deferred = await syncA.pullChangedFiles(client, WORKSPACE_DIR);
      expect(deferred.pulled).toBe(0);
      expect(deferred.deferredDriveSettle).toBe(1);
      expect(deferred.forcedAfterSettle).toBe(0);
      expect(fs.existsSync(localPath)).toBe(false);
    }

    const forced = await syncA.pullChangedFiles(client, WORKSPACE_DIR);
    expect(forced.forcedAfterSettle).toBe(1);
    expect(forced.pulled).toBe(1);
    expect(fs.readFileSync(localPath, 'utf8')).toBe('cloud delivered text');
  });

  it('clears drive-settle deferral after a failed force-pull so the failure memo owns the next cycle', async () => {
    const client = makeClient(
      {
        [REL_PATH]: {
          hash: 'abc1234567890def',
          size: 19,
        },
      },
      {},
    );
    client.post.mockImplementation((endpoint: string) => {
      if (endpoint === '/api/library/manifest') {
        return Promise.resolve(makeCloudManifest({
          [REL_PATH]: {
            hash: 'abc1234567890def',
            size: 19,
          },
        }));
      }
      if (endpoint === '/api/library/read') {
        return Promise.reject(new Error('cloud read failed'));
      }
      return Promise.resolve({});
    });

    const localPath = path.join(WORKSPACE_DIR, REL_PATH);
    const seededNow = Date.now();
    for (let i = 0; i < 5; i += 1) {
      evaluateDriveSettleDeferral({
        coreDirectory: WORKSPACE_DIR,
        relativePath: REL_PATH,
        localPath,
        nowMs: seededNow + i,
      });
    }
    expect(getActiveDriveSettleDeferrals(WORKSPACE_DIR)).toHaveLength(1);

    const failedForcePull = await syncA.pullChangedFiles(client, WORKSPACE_DIR);
    expect(failedForcePull.forcedAfterSettle).toBe(1);
    expect(failedForcePull.deferredDriveSettle).toBe(0);
    expect(failedForcePull.pulled).toBe(0);
    expect(getActiveDriveSettleDeferrals(WORKSPACE_DIR)).toHaveLength(0);

    const readCallsAfterFailure = client.post.mock.calls.filter((call) => call[0] === '/api/library/read').length;
    const memoOwned = await syncA.pullChangedFiles(client, WORKSPACE_DIR);
    const readCallsAfterMemo = client.post.mock.calls.filter((call) => call[0] === '/api/library/read').length;

    expect(memoOwned.deferredDriveSettle).toBe(0);
    expect(memoOwned.forcedAfterSettle).toBe(0);
    expect(memoOwned.pulled).toBe(0);
    expect(readCallsAfterMemo).toBe(readCallsAfterFailure);
    expect(getActiveDriveSettleDeferrals(WORKSPACE_DIR)).toHaveLength(0);
  });

  // REBEL-62A two-instance regression — the highest-value coverage both
  // fix reviewers demanded. Instance A (machine A) holds `foo.md` + a Drive
  // conflict copy `foo (1).md`. Across a full A-push → B-pull cycle we assert:
  //   (a) `foo (1).md` is NOT in A's pushed manifest / never uploaded,
  //   (b) B never pulls or writes `foo (1).md`,
  //   (c) B's local copy is never deleted and NO /api/library/delete-file is
  //       POSTed for it (the only scary failure mode: peer data loss).
  it('never fans a Drive conflict copy from A to B, and never deletes B\'s local copy', async () => {
    const ORIGINAL_REL = 'memory/topics/foo.md';
    const CONFLICT_REL = 'memory/topics/foo (1).md';

    // Two machines on one shared Drive — model as two workspace dirs.
    const WORKSPACE_A = path.join('/tmp/test-cloud-ws-drive-aware', 'machine-a');
    const WORKSPACE_B = path.join('/tmp/test-cloud-ws-drive-aware', 'machine-b');

    // Both machines already hold both files on disk (Drive replicated them).
    for (const root of [WORKSPACE_A, WORKSPACE_B]) {
      fs.mkdirSync(path.join(root, 'memory', 'topics'), { recursive: true });
      fs.writeFileSync(path.join(root, ORIGINAL_REL), 'original fact', 'utf8');
      fs.writeFileSync(path.join(root, CONFLICT_REL), 'drive conflict copy', 'utf8');
    }

    // Shared cloud (Fly) state: what's been uploaded. Records every endpoint hit.
    const cloudEntries: Record<string, { hash: string; size: number }> = {};
    const cloudContents: Record<string, string> = {};
    const calls: Array<{ endpoint: string; path?: string }> = [];

    const client: SyncClient & { post: ReturnType<typeof vi.fn> } = {
      post: vi.fn().mockImplementation((endpoint: string, body?: { path?: string; content?: string; encoding?: string }) => {
        calls.push({ endpoint, path: body?.path });
        if (endpoint === '/api/library/manifest') {
          return Promise.resolve({ entries: { ...cloudEntries }, complete: true, reasons: [] });
        }
        if (endpoint === '/api/library/upload-file' && body?.path) {
          const decoded = body.encoding === 'base64' && typeof body.content === 'string'
            ? Buffer.from(body.content, 'base64').toString('utf8')
            : (body.content ?? '');
          cloudContents[body.path] = decoded;
          cloudEntries[body.path] = { hash: `hash-${body.path}`, size: Buffer.byteLength(decoded) };
          return Promise.resolve({ path: body.path, updatedAt: Date.now() });
        }
        if (endpoint === '/api/library/read' && body?.path) {
          return Promise.resolve({ content: cloudContents[body.path] });
        }
        return Promise.resolve({});
      }),
    };

    // --- A pushes ---
    const { manifest: manifestA } = await syncA.buildLocalManifest(WORKSPACE_A);
    // (a) the conflict copy must be excluded from A's local manifest.
    expect(manifestA.has(ORIGINAL_REL)).toBe(true);
    expect(manifestA.has(CONFLICT_REL)).toBe(false);

    const changedA = syncA.getChangedFiles(manifestA);
    expect(changedA).toContain(ORIGINAL_REL);
    expect(changedA).not.toContain(CONFLICT_REL);

    await syncA.pushChangedFiles(client, changedA, WORKSPACE_A, manifestA);

    // Cloud (Fly) holds only the original — never the conflict copy.
    expect(Object.keys(cloudEntries)).toContain(ORIGINAL_REL);
    expect(Object.keys(cloudEntries)).not.toContain(CONFLICT_REL);
    expect(calls.some((c) => c.endpoint === '/api/library/upload-file' && c.path === CONFLICT_REL)).toBe(false);

    // --- B pulls ---
    const callsBefore = calls.length;
    const pullB = await syncB.pullChangedFiles(client, WORKSPACE_B);
    const callsDuringPull = calls.slice(callsBefore);

    // (b) B never reads/pulls/writes the conflict copy.
    expect(callsDuringPull.some((c) => c.endpoint === '/api/library/read' && c.path === CONFLICT_REL)).toBe(false);
    expect(pullB.pulled).toBe(0); // original already on disk; conflict copy skipped

    // (c) B's local conflict copy is untouched and never deleted; no delete-file POST.
    expect(fs.existsSync(path.join(WORKSPACE_B, CONFLICT_REL))).toBe(true);
    expect(fs.readFileSync(path.join(WORKSPACE_B, CONFLICT_REL), 'utf8')).toBe('drive conflict copy');
    expect(calls.some((c) => c.endpoint === '/api/library/delete-file' && c.path === CONFLICT_REL)).toBe(false);
    expect(calls.some((c) => c.endpoint === '/api/library/delete-file')).toBe(false);
  });
});

// Stage 1 (docs/plans/260622_conflict-dialog-false-positives): pending-state
// COMPRESSION (not conflict suppression). These pin the data-safety invariants
// from the GPT critique (F1/F2/F9): an already-surfaced pending update whose
// cloud copy keeps changing must update in place WITHOUT re-broadcasting, the
// baseline must never advance, and a genuine local divergence must still
// escalate to the both-edited conflict/quarantine path.
describe('CloudWorkspaceSync pending-state compression (Stage 1)', () => {
  let sync: CloudWorkspaceSync;

  const PENDING_REL = 'memory/topics/note.md';
  const localBaseline = 'original local content';
  const localBaselineHash = hashContent(localBaseline);

  beforeEach(() => {
    cleanup();
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    sync = new CloudWorkspaceSync();
    _resetDriveSettleDeferralsForTesting();
    vi.mocked(resolveWorkspaceWriteAuthority).mockReturnValue('desktop_fs_authoritative');
    sendToAllWindowsSpy.mockClear();
  });

  afterEach(() => {
    sync._resetForTesting();
    _resetDriveSettleDeferralsForTesting();
    cleanup();
    sendToAllWindowsSpy.mockClear();
  });

  function seedDeferredPending(cloudContent: string): { cloudHash: string; client: ReturnType<typeof makeClient> } {
    const cloudHash = hashContent(cloudContent);
    createWorkspaceFile(PENDING_REL, localBaseline);
    sync.load();
    sync.recordPulledFile(PENDING_REL, {
      mtime: Math.floor(fs.statSync(path.join(WORKSPACE_DIR, PENDING_REL)).mtimeMs),
      size: Buffer.byteLength(localBaseline),
      hash: localBaselineHash,
    });
    const client = makeClient(
      { [PENDING_REL]: { hash: cloudHash, size: Buffer.byteLength(cloudContent) } },
      { [PENDING_REL]: cloudContent },
    );
    return { cloudHash, client };
  }

  function pendingUpdatesBroadcastCount(): number {
    return sendToAllWindowsSpy.mock.calls.filter(([channel]) => channel === 'cloud:workspace-pending-updates').length;
  }

  it('refreshes the pending cloud hash IN PLACE when cloud changes while local stays at baseline — no repeat broadcast, firstSeenAt stable', async () => {
    // Cycle 1: cloud is newer than baseline → defer + record pending + broadcast.
    const { client: client1 } = seedDeferredPending('cloud v1');
    const first = await sync.pullChangedFiles(client1, WORKSPACE_DIR);
    expect(first.deferredEditedCloud).toBe(1);
    const recordedAfterCycle1 = getPendingCloudUpdate(WORKSPACE_DIR, PENDING_REL);
    expect(recordedAfterCycle1).not.toBeNull();
    const firstSeenAt = recordedAfterCycle1!.firstSeenAt;
    const broadcastsAfterCycle1 = pendingUpdatesBroadcastCount();
    expect(broadcastsAfterCycle1).toBeGreaterThanOrEqual(1);

    // Cycle 2: cloud moved to a NEW hash, local STILL equals baseline (local
    // never touched). Must compress in place — NO new pending-updates broadcast.
    sendToAllWindowsSpy.mockClear();
    const cloudV2 = 'cloud v2 (newer still)';
    const cloudV2Hash = hashContent(cloudV2);
    const client2 = makeClient(
      { [PENDING_REL]: { hash: cloudV2Hash, size: Buffer.byteLength(cloudV2) } },
      { [PENDING_REL]: cloudV2 },
    );
    await sync.pullChangedFiles(client2, WORKSPACE_DIR);

    const recordedAfterCycle2 = getPendingCloudUpdate(WORKSPACE_DIR, PENDING_REL);
    expect(recordedAfterCycle2).not.toBeNull();
    // Cloud hash refreshed to the latest…
    expect(recordedAfterCycle2!.cloudHash).toBe(cloudV2Hash);
    // …but the data-safety invariants are untouched.
    expect(recordedAfterCycle2!.firstSeenAt).toBe(firstSeenAt);
    expect(recordedAfterCycle2!.baselineLocalHash).toBe(localBaselineHash);
    // NO repeat pending-updates broadcast for the same already-surfaced path.
    expect(pendingUpdatesBroadcastCount()).toBe(0);
    // Local bytes were never overwritten by the deferral.
    expect(fs.readFileSync(path.join(WORKSPACE_DIR, PENDING_REL), 'utf8')).toBe(localBaseline);
  });

  it('does NOT advance lastPushedManifest while a pending update is deferred (data-loss guard)', async () => {
    const { client } = seedDeferredPending('cloud v1');
    const before = sync._getLastPushedManifest().get(PENDING_REL);
    expect(before?.hash).toBe(localBaselineHash);

    await sync.pullChangedFiles(client, WORKSPACE_DIR);

    // The baseline manifest entry must still reflect the LOCAL bytes, never the
    // deferred cloud hash — advancing it would let the push phase upload stale
    // local content and erase the cloud update.
    const after = sync._getLastPushedManifest().get(PENDING_REL);
    expect(after?.hash).toBe(localBaselineHash);
    expect(getPendingCloudUpdate(WORKSPACE_DIR, PENDING_REL)?.cloudHash).not.toBe(localBaselineHash);
  });

  it('escalates to the both-edited conflict/quarantine path when local diverges after a pending update (real conflict still fires)', async () => {
    // Cycle 1: defer + record pending.
    const { client: client1 } = seedDeferredPending('cloud v1');
    await sync.pullChangedFiles(client1, WORKSPACE_DIR);
    expect(getPendingCloudUpdate(WORKSPACE_DIR, PENDING_REL)).not.toBeNull();

    // Local now genuinely diverges (≠ baseline) AND cloud moved to a new hash
    // (≠ local). This is a real both-edited conflict.
    const localEdit = 'desktop just edited this locally';
    fs.writeFileSync(path.join(WORKSPACE_DIR, PENDING_REL), localEdit, 'utf8');
    const cloudV2 = 'cloud also moved on';
    const cloudV2Hash = hashContent(cloudV2);
    const client2 = makeClient(
      { [PENDING_REL]: { hash: cloudV2Hash, size: Buffer.byteLength(cloudV2) } },
      { [PENDING_REL]: cloudV2 },
    );

    const result = await sync.pullChangedFiles(client2, WORKSPACE_DIR);

    // The stale pending record is cleared and the path routes to conflict.
    expect(result.conflictPaths).toContain(PENDING_REL);
    expect(getPendingCloudUpdate(WORKSPACE_DIR, PENDING_REL)).toBeNull();
    // Local edit is preserved (never overwritten), and a quarantined cloud copy exists.
    expect(fs.readFileSync(path.join(WORKSPACE_DIR, PENDING_REL), 'utf8')).toBe(localEdit);
    expect(listQuarantinedWorkspaceConflicts(WORKSPACE_DIR).length).toBeGreaterThanOrEqual(1);
  });
});
