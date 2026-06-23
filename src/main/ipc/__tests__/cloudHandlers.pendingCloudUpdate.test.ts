/**
 * Pending-cloud-update apply through the ACTUAL IPC flow (REBEL-696 Stage 5).
 *
 * A "pending cloud update" is a file edited on another device (phone/web) whose
 * newer version lives only in Rebel's cloud — the desktop deliberately did NOT
 * overwrite it because an OS sync engine (Drive/Dropbox/iCloud) owns the local
 * write. Stage 5 lets the user safely fast-forward (keep-cloud semantics) via a
 * dedicated channel.
 *
 * These tests exercise the user-facing flow end to end:
 *   - list: cloud:workspace-conflict-list ALSO returns pendingUpdates
 *   - apply happy path: cloud bytes are written locally, record cleared
 *   - apply hash-gate: cloud moved on since flagged → stale record cleared, no write
 *   - apply errors: cloud read failure → structured failure (no silent success)
 *   - apply not-pending: unknown path → structured failure, no write
 *   - apply path-safety: a traversal relativePath is refused, no escape write
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppSettings } from '@shared/types';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('@core/handlerRegistry', () => ({
  getHandlerRegistry: () => ({
    register: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  }),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import { registerCloudHandlers } from '../cloudHandlers';
import { cloudWorkspaceSync } from '../../services/cloud/cloudWorkspaceSync';
import { cloudRouter } from '../../services/cloud/cloudRouter';
import {
  recordPendingCloudUpdate,
  getPendingCloudUpdates,
  _resetPendingCloudUpdatesForTesting,
} from '../../services/cloud/cloudPendingUpdateStore';
import {
  listQuarantinedWorkspaceConflicts,
  _resetQuarantinedWorkspaceConflictsForTesting,
} from '../../services/cloud/cloudConflictQuarantine';

let tmpRoot: string;
let workspaceDir: string;
let pendingStorePath: string;
let quarantineIndexPath: string;
let settings: AppSettings;

/** Same hash as the manifest/hashFile path: sha256(content) truncated to 16. */
function hash16(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

function callHandler<T>(channel: string, payload?: unknown): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return Promise.resolve(
    payload === undefined ? handler(null) : handler(null, payload),
  ) as Promise<T>;
}

/** Minimal SyncClient stub: only `/api/library/read` is exercised here. */
function makeReadClient(byPath: Record<string, string | (() => never)>) {
  return {
    post: vi.fn(async (apiPath: string, body: unknown) => {
      if (apiPath === '/api/library/read') {
        const rel = (body as { path: string }).path;
        const entry = byPath[rel];
        if (entry === undefined) throw new Error(`cloud 404: ${rel}`);
        if (typeof entry === 'function') return entry();
        return { content: entry };
      }
      throw new Error(`unexpected cloud POST ${apiPath}`);
    }),
  };
}

beforeEach(() => {
  handlers.clear();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-pending-update-'));
  workspaceDir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  pendingStorePath = path.join(tmpRoot, 'cloud-pending-updates.json');
  _resetPendingCloudUpdatesForTesting(pendingStorePath);

  // Point the quarantine store at a temp index under tmpRoot (its quarantine
  // root is path.dirname(indexPath)) so the local_changed conflict route parks
  // cloud bytes OUTSIDE the synced workspace, not in the real userData dir.
  quarantineIndexPath = path.join(tmpRoot, 'cloud-workspace-conflicts', 'index.json');
  fs.mkdirSync(path.dirname(quarantineIndexPath), { recursive: true });
  _resetQuarantinedWorkspaceConflictsForTesting(quarantineIndexPath);

  cloudWorkspaceSync._resetForTesting();

  settings = { coreDirectory: workspaceDir } as AppSettings;
  cloudRouter.init({ getSettings: () => settings });

  registerCloudHandlers({
    getSettings: () => settings,
    updateSettings: () => {},
  });
});

afterEach(() => {
  cloudRouter._setClientForTests(null);
  _resetPendingCloudUpdatesForTesting(null);
  _resetQuarantinedWorkspaceConflictsForTesting(null);
  cloudWorkspaceSync._resetForTesting();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('cloud workspace pending-update apply through IPC', () => {
  it('list returns pendingUpdates alongside conflicts', async () => {
    const relativePath = 'memory/topics/note.md';
    const cloudContent = 'edited on my phone';
    recordPendingCloudUpdate({
      coreDirectory: workspaceDir,
      relativePath,
      cloudHash: hash16(cloudContent),
      baselineLocalHash: hash16('old desktop version'),
    });

    const listed = await callHandler<{
      conflicts: unknown[];
      pendingUpdates: Array<Record<string, unknown>>;
    }>('cloud:workspace-conflict-list');

    expect(listed.conflicts).toHaveLength(0);
    expect(listed.pendingUpdates).toHaveLength(1);
    expect(listed.pendingUpdates[0].relativePath).toBe(relativePath);
    // PUBLIC SHAPE (REBEL-696 Fix 2): only `relativePath` crosses the boundary —
    // the store-internal fingerprints/timestamps must NOT leak to the renderer.
    expect(Object.keys(listed.pendingUpdates[0])).toEqual(['relativePath']);
    expect(listed.pendingUpdates[0].cloudHash).toBeUndefined();
    expect(listed.pendingUpdates[0].baselineLocalHash).toBeUndefined();
  });

  it('apply happy path: writes cloud bytes locally, records last-synced, clears the record', async () => {
    const relativePath = 'memory/topics/note.md';
    const localPath = path.join(workspaceDir, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'older desktop version', 'utf8');

    const cloudContent = 'newer version from my phone';
    recordPendingCloudUpdate({
      coreDirectory: workspaceDir,
      relativePath,
      cloudHash: hash16(cloudContent),
      baselineLocalHash: hash16('older desktop version'),
    });

    cloudRouter._setClientForTests(
      makeReadClient({ [relativePath]: cloudContent }) as never,
    );

    const result = await callHandler<{ success: boolean; reason?: string }>(
      'cloud:workspace-pending-update-apply',
      { relativePath },
    );

    expect(result).toEqual({ success: true });
    // Local file now holds the cloud bytes.
    expect(fs.readFileSync(localPath, 'utf8')).toBe(cloudContent);
    // The pending record is gone.
    expect(getPendingCloudUpdates(workspaceDir)).toHaveLength(0);
    // And the manifest records the applied version as last-synced (so push/pull
    // don't churn it). The pull loop records relativePath as-given.
    expect(cloudWorkspaceSync._getLastPushedManifest().get(relativePath)?.hash).toBe(hash16(cloudContent));
  });

  it('apply hash-gate: cloud moved on since flagged → stale record cleared, NO write', async () => {
    const relativePath = 'memory/topics/note.md';
    const localPath = path.join(workspaceDir, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'older desktop version', 'utf8');

    // Record was written for one cloud version, but the cloud now serves another.
    recordPendingCloudUpdate({
      coreDirectory: workspaceDir,
      relativePath,
      cloudHash: hash16('the version the user was told about'),
      baselineLocalHash: hash16('older desktop version'),
    });

    cloudRouter._setClientForTests(
      makeReadClient({ [relativePath]: 'a DIFFERENT, even newer version' }) as never,
    );

    const result = await callHandler<{ success: boolean; reason?: string }>(
      'cloud:workspace-pending-update-apply',
      { relativePath },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe('cloud_changed');
    // The local file is untouched (we did not apply a version the user never saw).
    expect(fs.readFileSync(localPath, 'utf8')).toBe('older desktop version');
    // The stale record is cleared so the card leaves the list.
    expect(getPendingCloudUpdates(workspaceDir)).toHaveLength(0);
  });

  it('apply hash-gate: emits a pending-update broadcast after clearing the stale record (resets renderer dedup)', async () => {
    const relativePath = 'memory/topics/note.md';
    const localPath = path.join(workspaceDir, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'older desktop version', 'utf8');

    recordPendingCloudUpdate({
      coreDirectory: workspaceDir,
      relativePath,
      cloudHash: hash16('the version the user was told about'),
      baselineLocalHash: hash16('older desktop version'),
    });

    cloudRouter._setClientForTests(
      makeReadClient({ [relativePath]: 'a DIFFERENT, even newer version' }) as never,
    );

    // The renderer dedups pending-update toasts by path and only resets on an
    // EMPTY broadcast. The stale-apply path clears the record WITHOUT writing, so
    // it must still broadcast — otherwise a later legitimately-new pending update
    // for the same path would be silently suppressed by the dedup set.
    const broadcastSpy = vi.spyOn(cloudWorkspaceSync, 'broadcastPendingCloudUpdates');
    try {
      const result = await callHandler<{ success: boolean; reason?: string }>(
        'cloud:workspace-pending-update-apply',
        { relativePath },
      );
      expect(result.reason).toBe('cloud_changed');
      expect(broadcastSpy).toHaveBeenCalledWith(workspaceDir);
    } finally {
      broadcastSpy.mockRestore();
    }
  });

  it('apply local-changed: user edited the local file after the record → does NOT overwrite, routes to conflict (quarantine + clear pending)', async () => {
    const relativePath = 'memory/topics/note.md';
    const localPath = path.join(workspaceDir, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });

    // The record was created when the local file held the baseline version.
    const baselineContent = 'desktop version when the update was first noticed';
    fs.writeFileSync(localPath, baselineContent, 'utf8');

    const cloudContent = 'newer version from my phone';
    recordPendingCloudUpdate({
      coreDirectory: workspaceDir,
      relativePath,
      cloudHash: hash16(cloudContent),
      baselineLocalHash: hash16(baselineContent),
    });

    // ...but BEFORE the user clicks "Update to newest", they edit it here too.
    const userEditedContent = 'I also edited this on my desktop in the meantime';
    fs.writeFileSync(localPath, userEditedContent, 'utf8');

    cloudRouter._setClientForTests(
      makeReadClient({ [relativePath]: cloudContent }) as never,
    );

    const result = await callHandler<{ success: boolean; reason?: string; error?: string }>(
      'cloud:workspace-pending-update-apply',
      { relativePath },
    );

    // Both sides changed → genuine conflict, NOT a safe fast-forward.
    expect(result.success).toBe(false);
    expect(result.reason).toBe('local_changed');
    expect(result.error).toBeTruthy();
    // The user's local edit is PRESERVED — apply did not clobber it.
    expect(fs.readFileSync(localPath, 'utf8')).toBe(userEditedContent);
    // The cloud bytes were quarantined (outside the workspace) for a 3-way resolve.
    const quarantined = listQuarantinedWorkspaceConflicts(workspaceDir);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].relativePath).toBe(relativePath);
    expect(quarantined[0].cloudCopyPath.startsWith(workspaceDir + path.sep)).toBe(false);
    expect(fs.readFileSync(quarantined[0].cloudCopyPath, 'utf8')).toBe(cloudContent);
    // The pending record is gone — it's now a conflict, not a pending update.
    expect(getPendingCloudUpdates(workspaceDir)).toHaveLength(0);
  });

  it('apply local-read-failed: a non-missing read error on the local file fails CLOSED (no overwrite, pending preserved)', async () => {
    const relativePath = 'memory/topics/note.md';
    const localPath = path.join(workspaceDir, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });

    // Local file exists and holds the baseline the user may have since edited.
    const baselineContent = 'desktop baseline the user cannot currently be read-verified';
    fs.writeFileSync(localPath, baselineContent, 'utf8');

    const cloudContent = 'newer version from my phone';
    recordPendingCloudUpdate({
      coreDirectory: workspaceDir,
      relativePath,
      cloudHash: hash16(cloudContent),
      baselineLocalHash: hash16(baselineContent),
    });

    cloudRouter._setClientForTests(
      makeReadClient({ [relativePath]: cloudContent }) as never,
    );

    // The cloud-side gate passes (cloud still holds exactly the flagged version),
    // but reading the LOCAL file to verify the baseline fails with a NON-missing
    // error (EACCES). We must NOT overwrite a file whose baseline we cannot prove.
    const hashSpy = vi
      .spyOn(
        cloudWorkspaceSync as unknown as { hashFile: (p: string) => Promise<string> },
        'hashFile',
      )
      .mockRejectedValue(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));

    try {
      const result = await callHandler<{ success: boolean; reason?: string; error?: string }>(
        'cloud:workspace-pending-update-apply',
        { relativePath },
      );

      // Fail closed — a structured failure, NOT a silent success and NOT a write.
      expect(result.success).toBe(false);
      expect(result.reason).toBe('local_read_failed');
      expect(result.error).toBeTruthy();
    } finally {
      hashSpy.mockRestore();
    }

    // The local file is UNCHANGED — apply refused to clobber what it couldn't verify.
    expect(fs.readFileSync(localPath, 'utf8')).toBe(baselineContent);
    // The pending record is PRESERVED so the user can retry once the read succeeds.
    expect(getPendingCloudUpdates(workspaceDir)).toHaveLength(1);
    // This is not a both-edited conflict, so nothing is quarantined.
    expect(listQuarantinedWorkspaceConflicts(workspaceDir)).toHaveLength(0);
  });

  it('apply already-current: the OS sync engine already delivered the cloud version locally → clear record, no overwrite', async () => {
    const relativePath = 'memory/topics/note.md';
    const localPath = path.join(workspaceDir, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });

    const cloudContent = 'newer version from my phone';
    // The local file ALREADY holds exactly the cloud version (delivered by Drive
    // between the record being written and the user clicking apply).
    fs.writeFileSync(localPath, cloudContent, 'utf8');

    recordPendingCloudUpdate({
      coreDirectory: workspaceDir,
      relativePath,
      cloudHash: hash16(cloudContent),
      baselineLocalHash: hash16('the older baseline version'),
    });

    cloudRouter._setClientForTests(
      makeReadClient({ [relativePath]: cloudContent }) as never,
    );

    const result = await callHandler<{ success: boolean; reason?: string }>(
      'cloud:workspace-pending-update-apply',
      { relativePath },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe('already_current');
    // Local file unchanged (already correct) and no quarantine created.
    expect(fs.readFileSync(localPath, 'utf8')).toBe(cloudContent);
    expect(listQuarantinedWorkspaceConflicts(workspaceDir)).toHaveLength(0);
    // The stale record is cleared so the card leaves the list.
    expect(getPendingCloudUpdates(workspaceDir)).toHaveLength(0);
  });

  it('apply already-current: emits a pending-update broadcast after clearing the record (resets renderer dedup)', async () => {
    const relativePath = 'memory/topics/note.md';
    const localPath = path.join(workspaceDir, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });

    const cloudContent = 'newer version from my phone';
    fs.writeFileSync(localPath, cloudContent, 'utf8');

    recordPendingCloudUpdate({
      coreDirectory: workspaceDir,
      relativePath,
      cloudHash: hash16(cloudContent),
      baselineLocalHash: hash16('the older baseline version'),
    });

    cloudRouter._setClientForTests(
      makeReadClient({ [relativePath]: cloudContent }) as never,
    );

    // Same dedup-reset requirement as the cloud_changed path: clearing the record
    // without writing must still broadcast so the renderer's dedup set resets.
    const broadcastSpy = vi.spyOn(cloudWorkspaceSync, 'broadcastPendingCloudUpdates');
    try {
      const result = await callHandler<{ success: boolean; reason?: string }>(
        'cloud:workspace-pending-update-apply',
        { relativePath },
      );
      expect(result.reason).toBe('already_current');
      expect(broadcastSpy).toHaveBeenCalledWith(workspaceDir);
    } finally {
      broadcastSpy.mockRestore();
    }
  });

  it('apply error: a cloud read failure returns a structured failure (no silent success), record preserved', async () => {
    const relativePath = 'memory/topics/note.md';
    const localPath = path.join(workspaceDir, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'older desktop version', 'utf8');

    const cloudContent = 'newer version';
    recordPendingCloudUpdate({
      coreDirectory: workspaceDir,
      relativePath,
      cloudHash: hash16(cloudContent),
      baselineLocalHash: hash16('older desktop version'),
    });

    cloudRouter._setClientForTests(
      makeReadClient({
        [relativePath]: () => {
          throw new Error('network down');
        },
      }) as never,
    );

    const result = await callHandler<{ success: boolean; reason?: string; error?: string }>(
      'cloud:workspace-pending-update-apply',
      { relativePath },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe('cloud_read_failed');
    expect(result.error).toBeTruthy();
    // Untouched local + record preserved so the user can retry.
    expect(fs.readFileSync(localPath, 'utf8')).toBe('older desktop version');
    expect(getPendingCloudUpdates(workspaceDir)).toHaveLength(1);
  });

  it('apply not-pending: an unknown path returns a structured failure and writes nothing', async () => {
    cloudRouter._setClientForTests(makeReadClient({}) as never);

    const result = await callHandler<{ success: boolean; reason?: string }>(
      'cloud:workspace-pending-update-apply',
      { relativePath: 'never/flagged.md' },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe('not_pending');
    expect(fs.existsSync(path.join(workspaceDir, 'never/flagged.md'))).toBe(false);
  });

  it('apply path-safety: a traversal relativePath is refused and never escapes the workspace', async () => {
    // A precious sentinel OUTSIDE the workspace.
    const sentinel = path.join(tmpRoot, 'precious.md');
    fs.writeFileSync(sentinel, 'do not touch', 'utf8');

    const traversal = '../precious.md';
    // The store key-normalises but preserves the relativePath; record it so the
    // apply path reaches the preflight guard rather than bailing as not-pending.
    recordPendingCloudUpdate({
      coreDirectory: workspaceDir,
      relativePath: traversal,
      cloudHash: hash16('attacker payload'),
      baselineLocalHash: hash16('x'),
    });

    cloudRouter._setClientForTests(
      makeReadClient({ [traversal]: 'attacker payload' }) as never,
    );

    const result = await callHandler<{ success: boolean; reason?: string }>(
      'cloud:workspace-pending-update-apply',
      { relativePath: traversal },
    );

    expect(result.success).toBe(false);
    // Either refused as not-pending (normalised away) or path_unsafe — never a write.
    expect(['path_unsafe', 'not_pending']).toContain(result.reason);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('do not touch');
  });
});
