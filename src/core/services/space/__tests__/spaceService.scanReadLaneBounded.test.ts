/**
 * S4.1e Stage 1 — scanSpacesReadOnly read-lane bounding.
 *
 * Routing `_scanSpacesImpl`'s reads through the bounded `workspaceFs` boundary means a
 * dead/slow cloud mount degrades to `reconnecting` (killable, never an unbounded hang)
 * instead of wedging the app-wide-coalesced `scanSpacesReadOnly` promise. These tests
 * assert the load-bearing invariants from
 * docs/plans/260622_libraryhandlers-read-lane/PLAN.md:
 *
 *  - Inv 3 (headline): a configured cloud-symlink space whose reads resolve
 *    `reconnecting` is RETAINED in `SpaceInfo[]` + marked degraded, never dropped,
 *    and the scan does NOT hang. Negative: a healthy cloud space (`ok`) is populated.
 *  - Inv 4: a `reconnecting` workspace ROOT surfaces a typed scan-unavailable error
 *    (distinguishable), NOT a spurious empty `[]`.
 *  - Inv 1/2: read-only (no writes on the read-only lane); a real `error` (ENOENT)
 *    candidate is dropped exactly as today.
 *
 * Driven with REAL temp-dir fixtures + a wired cloud-lane executor (the cloud lane
 * never touches `fs`, so a cloud-classified path can only be exercised by wiring an
 * executor) — mirrors src/core/utils/__tests__/safeWalkDirectory.admission.test.ts.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setWorkspaceFsExecutor,
  __resetWorkspaceFsExecutorForTesting,
} from '@core/services/boundedWorkspaceFs';
import {
  realFsExecutor,
  realFsExecutorWith,
  deadMountExecutor,
} from '@core/services/__tests__/workspaceFsExecutorDoubles';
import {
  configureCloudSpaceContainment,
  __resetCloudSpaceContainmentForTests,
} from '@core/services/cloudSpaceContainment';

// electron-store is pulled in transitively by some space-service siblings on certain
// build configs; mock it defensively so the dynamic import never touches a real store.
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
const { scanSpacesReadOnly, isSpaceScanAccessError, _resetScanSpacesCountersForTesting } = spaceService;

// Disable the coalesced cache so each test sees a fresh scan (deterministic).
process.env.REBEL_DISABLE_SPACES_COALESCE = '1';

let tmpRoot: string;
let workspace: string;
let cloudTarget: string;

/** Write a valid space README so the candidate is unambiguously a space. */
async function writeSpaceReadme(dir: string, description: string): Promise<void> {
  await fs.writeFile(
    path.join(dir, 'README.md'),
    `---\nrebel_space_description: ${description}\n---\n\n# Space\n`,
  );
}

describe('scanSpacesReadOnly — S4.1e bounded read lane', () => {
  beforeEach(async () => {
    tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-scan-bounded-')));
    workspace = path.join(tmpRoot, 'workspace');
    await fs.mkdir(workspace);
    // A real `Dropbox/`-segment dir stands in for a cloud mount (pattern-classified).
    cloudTarget = path.join(tmpRoot, 'Dropbox', 'Shared', 'Company Memories');
    await fs.mkdir(cloudTarget, { recursive: true });
    await writeSpaceReadme(cloudTarget, 'Cloud-backed company space');
    _resetScanSpacesCountersForTesting();
    setWorkspaceFsExecutor(realFsExecutor);
    __resetCloudSpaceContainmentForTests();
  });

  afterEach(async () => {
    __resetWorkspaceFsExecutorForTesting();
    __resetCloudSpaceContainmentForTests();
    _resetScanSpacesCountersForTesting();
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  /** Create a workspace-root cloud-symlink space + register it as a containment space. */
  async function makeCloudSymlinkSpace(name: string): Promise<string> {
    const link = path.join(workspace, name);
    await fs.symlink(cloudTarget, link);
    configureCloudSpaceContainment(workspace, [
      { name, path: name, type: 'other', isSymlink: true, createdAt: 0 } as never,
    ]);
    return link;
  }

  it('Inv 3 (headline): a reconnecting cloud space is RETAINED + degraded, not dropped, and does not hang', async () => {
    await makeCloudSymlinkSpace('Company Memories');
    // Mount dies: every cloud op resolves reconnecting.
    setWorkspaceFsExecutor(deadMountExecutor);

    const spaces = await scanSpacesReadOnly(workspace);

    const space = spaces.find((s) => s.name === 'Company Memories');
    expect(space, 'reconnecting cloud space must be retained in SpaceInfo[]').toBeDefined();
    expect(space?.syncStatus).toBe('reconnecting');
    expect(space?.status).toBe('needs_attention');
  });

  it('Inv 3 negative: a HEALTHY cloud space is fully populated', async () => {
    await makeCloudSymlinkSpace('Company Memories');
    setWorkspaceFsExecutor(realFsExecutor); // healthy mount

    const spaces = await scanSpacesReadOnly(workspace);

    const space = spaces.find((s) => s.name === 'Company Memories');
    expect(space, 'healthy cloud space must appear').toBeDefined();
    expect(space?.status).toBe('ok');
    expect(space?.description).toBe('Cloud-backed company space');
    expect(space?.isSymlink).toBe(true);
  });

  it('Inv 4: a reconnecting workspace ROOT surfaces scan-unavailable, NOT empty []', async () => {
    // Configure the WORKSPACE ROOT ITSELF as a cloud space (containment exact-root
    // match), then kill the mount so the root access/readdir reconnect.
    configureCloudSpaceContainment(path.dirname(workspace), [
      { name: 'workspace', path: 'workspace', type: 'other', isSymlink: true, createdAt: 0 } as never,
    ]);
    // The containment map needs the workspace path to classify cloud; register the
    // workspace dir as a symlinked space whose first cloud hop is the cloud target.
    const linkedWorkspace = path.join(tmpRoot, 'linked-workspace');
    await fs.symlink(cloudTarget, linkedWorkspace);
    configureCloudSpaceContainment(tmpRoot, [
      { name: 'linked-workspace', path: 'linked-workspace', type: 'other', isSymlink: true, createdAt: 0 } as never,
    ]);
    setWorkspaceFsExecutor(deadMountExecutor);

    await expect(scanSpacesReadOnly(linkedWorkspace)).rejects.toMatchObject({
      reconnecting: true,
    });

    // And it is the typed scan-access error, not a generic throw.
    await scanSpacesReadOnly(linkedWorkspace).catch((err) => {
      expect(isSpaceScanAccessError(err)).toBe(true);
    });
  });

  it('Inv 1/2: read-only scan writes nothing and a missing-config candidate is skipped', async () => {
    // A local (non-cloud) folder with a README but the description present → included.
    const localSpace = path.join(workspace, 'Local Space');
    await fs.mkdir(localSpace);
    await writeSpaceReadme(localSpace, 'Local space');

    // A plain folder with NO config file → skipped (dropped) exactly as today.
    const plainFolder = path.join(workspace, 'NotASpace');
    await fs.mkdir(plainFolder);

    setWorkspaceFsExecutor(realFsExecutor);
    const before = await fs.readdir(localSpace);

    const spaces = await scanSpacesReadOnly(workspace);

    expect(spaces.some((s) => s.name === 'Local Space')).toBe(true);
    expect(spaces.some((s) => s.name === 'NotASpace')).toBe(false);

    // Read-only lane wrote nothing to the space dir (no auto-fix files appeared).
    const after = await fs.readdir(localSpace);
    expect(after.sort()).toEqual(before.sort());
  });

  it('F1: a PATTERN-cloud workspace root (UNconfigured containment) routes descendant reads to the cloud lane → reconnecting space RETAINED, not dropped/hung', async () => {
    // A workspace living UNDER a pattern-cloud segment (`Dropbox/`), with NO containment
    // configured — this is the F1 gap: `classifyWorkspacePath` is containment-only, so
    // descendant candidate reads would fall back to bare fs and HANG unless every scan
    // read derives `cloudLaneOptionForPath` from its OWN path. We assert the descendant
    // `stat` actually routes the cloud lane by making ONLY the executor's `stat` wedge
    // (root readdir/access stay real): if the descendant stat had taken the bare-fs LOCAL
    // lane, the override would NOT apply and the space would be `ok`, not degraded.
    const patternCloudWorkspace = path.join(tmpRoot, 'Dropbox', 'My Workspace');
    await fs.mkdir(patternCloudWorkspace, { recursive: true });
    const space = path.join(patternCloudWorkspace, 'General');
    await fs.mkdir(space);
    await writeSpaceReadme(space, 'Pattern-cloud space');
    // Containment deliberately NOT configured (empty map) — pattern-forcing must carry it.
    __resetCloudSpaceContainmentForTests();

    // Healthy first: with the real executor the space is fully populated.
    setWorkspaceFsExecutor(realFsExecutor);
    const healthy = await scanSpacesReadOnly(patternCloudWorkspace);
    expect(healthy.find((s) => s.name === 'General')?.status).toBe('ok');

    // Now wedge ONLY the descendant `stat`. Root readdir/access stay real (so the root is
    // enumerable and the candidate is discovered), but the final-loop candidate `stat`
    // reconnects — provable ONLY if that stat routed the cloud lane (it did, via per-path
    // pattern-forcing). Reset the coalesced cache between scans via the counter reset.
    _resetScanSpacesCountersForTesting();
    const statWedged = realFsExecutorWith({
      stat: () => Promise.resolve({ ok: false, reason: 'timeout' }),
    });
    setWorkspaceFsExecutor(statWedged);

    const degraded = await scanSpacesReadOnly(patternCloudWorkspace);
    const generalSpace = degraded.find((s) => s.name === 'General');
    expect(generalSpace, 'pattern-cloud descendant must be RETAINED, not dropped').toBeDefined();
    expect(generalSpace?.syncStatus).toBe('reconnecting');
    expect(generalSpace?.status).toBe('needs_attention');
  });
});
