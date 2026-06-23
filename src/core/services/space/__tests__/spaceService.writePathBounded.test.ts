/**
 * S4.1f Stage 1 — spaceService NON-scan (write/create/rename/move/migrate/reconcile)
 * read-path bounding. The data-safety crux: a write-path existence/CAS pre-read that hits
 * a `reconnecting` cloud mount must NEVER be mistaken for "absent → safe to write / delete /
 * create" (that is silent data corruption / data loss). These tests assert FAIL-CLOSED on
 * reconnecting, and that a genuine ENOENT preserves today's behaviour.
 *
 * Driven with REAL temp-dir fixtures + a wired cloud-lane executor: a cloud-symlink space
 * (containment-configured) makes the space's reads classify cloud, and
 * `realFsExecutorWith({ <op>: timeout })` resolves that op to `reconnecting` (the boundary
 * maps an executor timeout → reconnecting) while other ops use real fs. Mirrors the S4.1e
 * scan-lane test harness.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setWorkspaceFsExecutor,
  __resetWorkspaceFsExecutorForTesting,
  type WorkspaceFsExecutor,
} from '@core/services/boundedWorkspaceFs';
import { realFsExecutor, realFsExecutorWith } from '@core/services/__tests__/workspaceFsExecutorDoubles';
import {
  configureCloudSpaceContainment,
  __resetCloudSpaceContainmentForTests,
} from '@core/services/cloudSpaceContainment';

vi.mock('electron-store', () => ({
  default: class {
    store: Record<string, unknown> = {};
    get = vi.fn((key: string) => this.store[key]);
    set = vi.fn((key: string, value: unknown) => {
      this.store[key] = value;
    });
    delete = vi.fn((key: string) => {
      delete this.store[key];
    });
    has = vi.fn((key: string) => key in this.store);
  },
}));

const spaceService = await import('../spaceService');
const { updateSpaceFrontmatter, reconcileSpacesWithSettings, createSpace, moveSpace, removeSpace, attemptMechanicalFrontmatterRepairOnDisk } = spaceService;

const TIMEOUT = (): Promise<{ ok: false; reason: 'timeout' }> => Promise.resolve({ ok: false, reason: 'timeout' });

let tmpRoot: string;
let homeTmpRoot: string;
let workspace: string;
let cloudTarget: string;

/** Register `name` as a cloud-symlink space so its reads classify cloud (containment).
 *  The symlink TARGET lives under `os.homedir()` (a namespaced, cleaned-up temp dir) so the
 *  write-safety guard (`assertSpaceWriteSafe`: in-workspace OR under-home) passes — this is
 *  the realistic Google-Drive-under-home case. */
async function makeCloudSpace(name: string): Promise<string> {
  const link = path.join(workspace, name);
  await fs.symlink(cloudTarget, link);
  configureCloudSpaceContainment(workspace, [
    { name, path: name, type: 'other', isSymlink: true, sourcePath: cloudTarget, createdAt: 0 } as never,
  ]);
  return link;
}

describe('spaceService — S4.1f write-path read bounding (data-safety: fail-closed on reconnecting)', () => {
  beforeEach(async () => {
    tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-s41f-')));
    workspace = path.join(tmpRoot, 'workspace');
    await fs.mkdir(workspace);
    // Cloud target under HOME (namespaced) + a `Dropbox/` segment → write-safe AND
    // pattern-cloud. Realpath-resolve home so containment's prefix matching agrees.
    homeTmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.homedir(), '.rebel-s41f-test-')));
    cloudTarget = path.join(homeTmpRoot, 'Dropbox', 'Shared', 'Space');
    await fs.mkdir(cloudTarget, { recursive: true });
    setWorkspaceFsExecutor(realFsExecutor);
    __resetCloudSpaceContainmentForTests();
  });

  afterEach(async () => {
    __resetWorkspaceFsExecutorForTesting();
    __resetCloudSpaceContainmentForTests();
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(homeTmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('CAS writer (updateSpaceFrontmatter): a reconnecting pre-read FAILS CLOSED — NO write, original content preserved', async () => {
    // A cloud-symlink space (target under home → write-safe) with an existing README. The
    // CAS pre-read (`readFileBytes`) reconnects. FAIL-CLOSED: updateSpaceFrontmatter must NOT
    // fall into the "file doesn't exist → create" branch (which would overwrite the
    // unreachable existing README with just the updates).
    await makeCloudSpace('Space');
    const readmePath = path.join(cloudTarget, 'README.md');
    const original = '---\nrebel_space_description: Existing\n---\n\n# Real content that must survive\n';
    await fs.writeFile(readmePath, original);

    setWorkspaceFsExecutor(realFsExecutorWith({ readFileBytes: TIMEOUT, readFile: TIMEOUT }));

    const result = await updateSpaceFrontmatter(path.join(workspace, 'Space'), { display_name: 'New Name' });

    expect(result.success).toBe(false); // fail-closed, not a silent create
    // The original README is UNTOUCHED (no overwrite with stale/empty content).
    const after = await fs.readFile(readmePath, 'utf-8');
    expect(after).toBe(original);
  });

  it('reconcileSpacesWithSettings: a reconnecting lstat RETAINS the space (NEVER removed as "missing")', async () => {
    // A space present in settings but NOT in the scan results → reconcile probes disk.
    // A reconnecting lstat must NOT be read as "missing → remove" — the space is retained.
    await makeCloudSpace('Space');
    setWorkspaceFsExecutor(realFsExecutorWith({ lstat: TIMEOUT }));

    const settings = [{ name: 'Space', path: 'Space', isSymlink: true, sourcePath: cloudTarget, createdAt: 0 } as never];
    const reconciled = await reconcileSpacesWithSettings(workspace, [], settings);

    expect(reconciled.some((s) => s.path === 'Space')).toBe(true); // retained, not removed
  });

  it('createSpace: a reconnecting source stat FAILS (does NOT create a dangling symlink)', async () => {
    // `options.sourcePath` is a cloud folder being linked; its stat reconnects → createSpace
    // must throw (NOT proceed to create a symlink into a degraded mount).
    configureCloudSpaceContainment(workspace, [
      { name: 'X', path: 'X', type: 'other', isSymlink: true, sourcePath: cloudTarget, createdAt: 0 } as never,
    ]);
    setWorkspaceFsExecutor(realFsExecutorWith({ stat: TIMEOUT }));

    await expect(
      createSpace(workspace, {
        name: 'Linked',
        type: 'other',
        location: 'symlink',
        sourcePath: cloudTarget,
        targetPath: 'Linked',
      } as never),
    ).rejects.toThrow();
    // No symlink was created.
    await expect(fs.lstat(path.join(workspace, 'Linked'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('error(ENOENT) preserved: createSpace with a genuinely-missing source still throws "does not exist"', async () => {
    // A real ENOENT (not reconnecting) must keep today's behaviour. Use a LOCAL missing
    // source so the bare-fs lane returns a real ENOENT (no executor needed for local).
    setWorkspaceFsExecutor(realFsExecutor);
    const missingSource = path.join(tmpRoot, 'does-not-exist-source');

    await expect(
      createSpace(workspace, {
        name: 'Linked2',
        type: 'other',
        location: 'symlink',
        sourcePath: missingSource,
        targetPath: 'Linked2',
      } as never),
    ).rejects.toThrow(/does not exist/i);
  });

  it('moveSpace: a reconnecting destination-collision probe FAILS (does NOT proceed to move)', async () => {
    // Move a LOCAL space OUT to a cloud destination dir. The dest-collision `access(newPath)`
    // reconnects → moveSpace must throw (NOT read it as "ENOENT → ok to proceed"). The source
    // stays in place.
    const localSpace = path.join(workspace, 'LocalSpace');
    await fs.mkdir(localSpace);
    await fs.writeFile(path.join(localSpace, 'README.md'), '---\nrebel_space_description: L\n---\n');
    // Destination is a cloud-classified external dir; register containment so its reads route cloud.
    const destDir = path.join(tmpRoot, 'Dropbox', 'Dest');
    await fs.mkdir(destDir, { recursive: true });
    configureCloudSpaceContainment(workspace, [
      { name: 'dest', path: '../Dropbox/Dest', type: 'other', isSymlink: true, sourcePath: destDir, createdAt: 0 } as never,
    ]);
    // `access` (the dest-collision newPath probe) reconnects; source stat/lstat stay real.
    const exec: WorkspaceFsExecutor = realFsExecutorWith({ access: TIMEOUT });
    setWorkspaceFsExecutor(exec);

    await expect(moveSpace(workspace, 'LocalSpace', destDir)).rejects.toThrow();
    // The source space is still present (not moved/deleted).
    await expect(fs.stat(localSpace)).resolves.toBeDefined();
  });

  // ── Stage-1 review fixes (F1/F2/F3) ─────────────────────────────────────────────

  it('F1 — createSpace: a reconnecting legacy-AGENTS.md migration probe ABORTS the README write (no create over an unreachable cloud space)', async () => {
    // The space target is a cloud-symlink (target under home → write-safe). The legacy
    // migration probe (`migrateLegacyAgentsMd`'s lstat/access) reconnects → createSpace must
    // throw (NOT log "proceeding with README.md" and write README over the degraded space).
    const link = await makeCloudSpace('Space');
    void link;
    // No README/AGENTS.md on disk yet. lstat (legacy probe) + access reconnect.
    setWorkspaceFsExecutor(realFsExecutorWith({ lstat: TIMEOUT, access: TIMEOUT }));

    await expect(
      createSpace(workspace, {
        name: 'Space',
        type: 'project',
        location: 'workspace',
        targetPath: 'Space',
        description: 'desc',
      } as never),
    ).rejects.toThrow(/reconnect/i);
    // No README was written into the (unreachable) cloud space target.
    await expect(fs.access(path.join(cloudTarget, 'README.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('F2 — removeSpace(removeSymlinkOnly=false): a reconnecting symlink probe ABORTS — NO destructive delete, content retained', async () => {
    // A cloud-symlink space (target under home → write-safe) whose lstat reconnects.
    // removeSpace must abort (its symlink-vs-dir decision comes from the STRICT bounded lstat
    // that re-throws reconnecting — NOT the best-effort isSymlink() that swallowed
    // reconnecting→false and, with removeSymlinkOnly=false, would proceed to a destructive
    // delete). After the fix there is no second best-effort symlink probe on the delete path.
    await makeCloudSpace('Space');
    await fs.writeFile(path.join(cloudTarget, 'keep.md'), 'real content that must survive');
    setWorkspaceFsExecutor(realFsExecutorWith({ lstat: TIMEOUT }));

    await expect(removeSpace(workspace, 'Space', false)).rejects.toThrow();
    // Symlink + its cloud-target content are STILL there (no destructive delete on reconnecting).
    await expect(fs.lstat(path.join(workspace, 'Space'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(cloudTarget, 'keep.md'))).resolves.toBeDefined();
  });

  it('F3 — attemptMechanicalFrontmatterRepairOnDisk: a reconnecting README read returns false with NO write (no AGENTS.md-fallback write)', async () => {
    // The space has a malformed-frontmatter legacy AGENTS.md that WOULD be repaired+written if
    // the README read failure fell through to the legacy fallback. A reconnecting README read
    // must short-circuit → return false → NO write to either file.
    await makeCloudSpace('Space');
    const legacyPath = path.join(cloudTarget, 'AGENTS.md');
    // Duplicate-key frontmatter is mechanically repairable (dedupe) → WOULD be written via
    // atomicWriteWithReValidate if the legacy fallback is reached.
    const repairable = '---\nrebel_space_description: First\nrebel_space_description: Second\n---\n\n# body\n';
    await fs.writeFile(legacyPath, repairable);
    const before = await fs.readFile(legacyPath, 'utf-8');
    // README read reconnects; legacy read would succeed (real fs) if reached.
    setWorkspaceFsExecutor(
      realFsExecutorWith({
        readFileBytes: (p: string) =>
          p.endsWith('README.md') ? TIMEOUT() : (realFsExecutor.readFileBytes(p) as never),
      }),
    );

    const repaired = await attemptMechanicalFrontmatterRepairOnDisk(path.join(workspace, 'Space'));

    expect(repaired).toBe(false); // no repair, fail-closed
    // The legacy file is UNTOUCHED (no AGENTS.md-fallback write on a reconnecting README).
    const after = await fs.readFile(legacyPath, 'utf-8');
    expect(after).toBe(before);
  });
});
