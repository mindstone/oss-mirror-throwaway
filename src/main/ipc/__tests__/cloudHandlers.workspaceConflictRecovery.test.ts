/**
 * Quarantine-recovery through the ACTUAL IPC flow (REBEL-696, Stage-6 refinement).
 *
 * On a Drive-authoritative path, a both-edited cloud conflict is now written to
 * the local quarantine (outside the synced workspace) instead of dropping a
 * `.conflict-cloud` file into the synced tree. This test proves the user-facing
 * conflict flow can still find, resolve, and clean a quarantined copy end to
 * end: list (which merges quarantined entries) -> resolve(keep-cloud) -> the
 * cloud bytes are applied to the local file AND the quarantine entry + its
 * out-of-workspace bytes are removed.
 *
 * It also exercises the F6 path-safety guard: a tampered quarantine entry whose
 * cloudCopyPath escaped the quarantine root must never be surfaced or read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
import {
  _resetQuarantinedWorkspaceConflictsForTesting,
  listQuarantinedWorkspaceConflicts,
  quarantineWorkspaceCloudConflict,
} from '../../services/cloud/cloudConflictQuarantine';
import { cloudWorkspaceSync } from '../../services/cloud/cloudWorkspaceSync';

let tmpRoot: string;
let workspaceDir: string;
let quarantineIndexPath: string;
let settings: AppSettings;

function callHandler<T>(channel: string, payload?: unknown): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  // The contract-parse wrapper (enforced under NODE_ENV=test) calls
  // request.parse(args[0]); for z.void() channels args[0] must be undefined.
  return Promise.resolve(
    payload === undefined ? handler(null) : handler(null, payload),
  ) as Promise<T>;
}

beforeEach(() => {
  handlers.clear();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-conflict-recovery-'));
  workspaceDir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  // Point the quarantine store at a temp index under tmpRoot (its quarantine
  // root is path.dirname(indexPath)). This keeps quarantined bytes OUTSIDE the
  // workspace, exactly as in production (userData), but inside our temp tree.
  quarantineIndexPath = path.join(tmpRoot, 'cloud-workspace-conflicts', 'index.json');
  fs.mkdirSync(path.dirname(quarantineIndexPath), { recursive: true });
  _resetQuarantinedWorkspaceConflictsForTesting(quarantineIndexPath);

  settings = { coreDirectory: workspaceDir } as AppSettings;
  registerCloudHandlers({
    getSettings: () => settings,
    updateSettings: () => {},
  });
});

afterEach(() => {
  _resetQuarantinedWorkspaceConflictsForTesting(null);
  cloudWorkspaceSync._resetForTesting();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('cloud workspace conflict recovery through IPC (quarantined copy)', () => {
  it('lists, then resolves(keep-cloud) a quarantined conflict — applies cloud bytes + cleans quarantine', async () => {
    const relativePath = 'memory/topics/note.md';
    const localPath = path.join(workspaceDir, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'local edit', 'utf8');

    // Simulate the Stage-4 quarantine write (cloud bytes parked outside the tree).
    const quarantined = quarantineWorkspaceCloudConflict({
      coreDirectory: workspaceDir,
      relativePath,
      localPath,
      content: 'cloud edit',
    });
    expect(fs.existsSync(quarantined.cloudCopyPath)).toBe(true);
    // The quarantined bytes are NOT inside the synced workspace.
    expect(quarantined.cloudCopyPath.startsWith(workspaceDir + path.sep)).toBe(false);

    // 1) LIST — the quarantined conflict must surface through the IPC handler.
    const listed = await callHandler<{ conflicts: Array<{ relativePath: string; cloudCopyPath: string }> }>(
      'cloud:workspace-conflict-list',
    );
    expect(listed.conflicts).toHaveLength(1);
    expect(listed.conflicts[0].relativePath).toBe(relativePath);
    expect(listed.conflicts[0].cloudCopyPath).toBe(quarantined.cloudCopyPath);

    // 2) RESOLVE(keep-cloud) — apply the cloud bytes to the local file.
    const resolved = await callHandler<{ success: boolean; error?: string }>(
      'cloud:workspace-conflict-resolve',
      { relativePath, resolution: 'keep-cloud' },
    );
    expect(resolved).toEqual({ success: true });

    // Local file now holds the cloud bytes ...
    expect(fs.readFileSync(localPath, 'utf8')).toBe('cloud edit');
    // ... the out-of-workspace quarantined bytes are gone ...
    expect(fs.existsSync(quarantined.cloudCopyPath)).toBe(false);
    // ... and the quarantine entry is removed.
    expect(listQuarantinedWorkspaceConflicts(workspaceDir)).toHaveLength(0);

    // 3) LIST again — nothing remains.
    const afterList = await callHandler<{ conflicts: unknown[] }>('cloud:workspace-conflict-list');
    expect(afterList.conflicts).toHaveLength(0);
  });

  it('keep-local resolution removes the quarantined copy but preserves the local file', async () => {
    const relativePath = 'notes/keep-local.md';
    const localPath = path.join(workspaceDir, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'my local version', 'utf8');

    const quarantined = quarantineWorkspaceCloudConflict({
      coreDirectory: workspaceDir,
      relativePath,
      localPath,
      content: 'cloud version',
    });

    const resolved = await callHandler<{ success: boolean }>(
      'cloud:workspace-conflict-resolve',
      { relativePath, resolution: 'keep-local' },
    );
    expect(resolved.success).toBe(true);

    expect(fs.readFileSync(localPath, 'utf8')).toBe('my local version');
    expect(fs.existsSync(quarantined.cloudCopyPath)).toBe(false);
    expect(listQuarantinedWorkspaceConflicts(workspaceDir)).toHaveLength(0);
  });

  it('F6: refuses a tampered quarantine entry whose cloudCopyPath escaped the quarantine root', async () => {
    const relativePath = 'notes/tampered.md';
    const localPath = path.join(workspaceDir, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'local', 'utf8');

    // A precious sentinel OUTSIDE both the workspace and quarantine roots.
    const sentinel = path.join(tmpRoot, 'precious.md');
    fs.writeFileSync(sentinel, 'do not touch', 'utf8');

    // Hand-write a tampered index pointing cloudCopyPath at the sentinel.
    fs.writeFileSync(
      quarantineIndexPath,
      JSON.stringify([
        {
          coreDirectory: path.resolve(workspaceDir),
          localPath,
          cloudCopyPath: sentinel,
          relativePath,
          createdAt: Date.now(),
        },
      ]),
      'utf8',
    );
    _resetQuarantinedWorkspaceConflictsForTesting(quarantineIndexPath);

    // LIST must NOT surface the unsafe entry.
    const listed = await callHandler<{ conflicts: unknown[] }>('cloud:workspace-conflict-list');
    expect(listed.conflicts).toHaveLength(0);

    // RESOLVE must also refuse (no conflict found / unsafe), and never touch the sentinel.
    const resolved = await callHandler<{ success: boolean; error?: string }>(
      'cloud:workspace-conflict-resolve',
      { relativePath, resolution: 'keep-cloud' },
    );
    expect(resolved.success).toBe(false);
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('do not touch');
  });

  // Stage 1 (docs/plans/260622_conflict-dialog-false-positives): orphan
  // `.conflict-cloud` files (original missing / already resolved) must stop
  // being re-surfaced in the active dialog forever — but their bytes must be
  // PRESERVED, never time-deleted (GPT F3). The maintenance pipeline + health
  // check own the orphan lifecycle.
  it('de-surfaces an in-tree .conflict-cloud orphan (original missing) but preserves its bytes', async () => {
    const relativePath = 'notes/orphaned.md';
    // NO original file on disk — only the conflict copy remains.
    const conflictCopyPath = path.join(workspaceDir, 'notes', 'orphaned.conflict-cloud.md');
    fs.mkdirSync(path.dirname(conflictCopyPath), { recursive: true });
    fs.writeFileSync(conflictCopyPath, 'stale cloud copy bytes', 'utf8');

    const listed = await callHandler<{ conflicts: Array<{ relativePath: string }> }>(
      'cloud:workspace-conflict-list',
    );
    // The orphan is NOT surfaced as an active conflict…
    expect(listed.conflicts.some((c) => c.relativePath === relativePath)).toBe(false);
    // …but its bytes are still on disk (preserved for maintenance, not deleted).
    expect(fs.existsSync(conflictCopyPath)).toBe(true);
    expect(fs.readFileSync(conflictCopyPath, 'utf8')).toBe('stale cloud copy bytes');
  });

  it('does NOT de-surface a conflict when the original-existence check hits a non-ENOENT fs error (fail safe, keep it live)', async () => {
    const relativePath = 'notes/ambiguous.md';
    const localPath = path.join(workspaceDir, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    // The original genuinely EXISTS on disk — this is a live conflict.
    fs.writeFileSync(localPath, 'local live edit', 'utf8');
    const conflictCopyPath = path.join(workspaceDir, 'notes', 'ambiguous.conflict-cloud.md');
    fs.writeFileSync(conflictCopyPath, 'cloud copy', 'utf8');

    // Simulate a transient/permission fs error (NOT ENOENT) when checking the
    // original. orphan-missing detection is narrowed to ENOENT/ENOTDIR; any other
    // error is AMBIGUOUS and must fail safe by keeping the conflict surfaced
    // rather than silently hiding a live conflict.
    const accessSpy = vi
      .spyOn(fsPromises, 'access')
      .mockImplementation(async (target: Parameters<typeof fsPromises.access>[0]) => {
        if (path.resolve(String(target)) === path.resolve(localPath)) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        // Fall through for any other path (none expected in this test).
        return undefined;
      });

    try {
      const listed = await callHandler<{ conflicts: Array<{ relativePath: string }> }>(
        'cloud:workspace-conflict-list',
      );
      // Fail safe: the conflict is STILL surfaced despite the ambiguous fs error.
      expect(listed.conflicts.some((c) => c.relativePath === relativePath)).toBe(true);
    } finally {
      accessSpy.mockRestore();
    }
  });

  it('still surfaces an in-tree .conflict-cloud conflict while the original exists (live conflict unaffected)', async () => {
    const relativePath = 'notes/live.md';
    const localPath = path.join(workspaceDir, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'local live edit', 'utf8');
    const conflictCopyPath = path.join(workspaceDir, 'notes', 'live.conflict-cloud.md');
    fs.writeFileSync(conflictCopyPath, 'cloud live copy', 'utf8');

    const listed = await callHandler<{ conflicts: Array<{ relativePath: string }> }>(
      'cloud:workspace-conflict-list',
    );
    expect(listed.conflicts.some((c) => c.relativePath === relativePath)).toBe(true);
  });

  it('de-surfaces a quarantined orphan (original missing) but preserves the quarantined bytes', async () => {
    const relativePath = 'notes/quarantine-orphan.md';
    const localPath = path.join(workspaceDir, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'local', 'utf8');

    const quarantined = quarantineWorkspaceCloudConflict({
      coreDirectory: workspaceDir,
      relativePath,
      localPath,
      content: 'cloud bytes worth keeping',
    });
    expect(fs.existsSync(quarantined.cloudCopyPath)).toBe(true);

    // Now the original disappears (resolved/deleted) → the quarantined entry is
    // an orphan.
    fs.rmSync(localPath);

    const listed = await callHandler<{ conflicts: Array<{ relativePath: string }> }>(
      'cloud:workspace-conflict-list',
    );
    // De-surfaced from the active list…
    expect(listed.conflicts.some((c) => c.relativePath === relativePath)).toBe(false);
    // …but the quarantined bytes are preserved (entry + file still present).
    expect(fs.existsSync(quarantined.cloudCopyPath)).toBe(true);
    expect(fs.readFileSync(quarantined.cloudCopyPath, 'utf8')).toBe('cloud bytes worth keeping');
    expect(listQuarantinedWorkspaceConflicts(workspaceDir)).toHaveLength(1);
  });
});
