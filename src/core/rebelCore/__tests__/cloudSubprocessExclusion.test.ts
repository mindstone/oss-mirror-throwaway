/**
 * Stage 9 — the readlink-only cloud-exclusion derivation for the subprocess
 * search tiers (rg/find/grep). Proves: incidental cloud symlinks are excluded;
 * the explicit named-cloud root + non-cloud symlinks are NOT excluded; admission
 * (flag on + healthy verdict) re-includes a healthy cloud space; and the rg/find/
 * grep arg builders emit the right pruning flags.
 *
 * Uses the established `Dropbox/` path trick (a real local dir under a `Dropbox/`
 * segment is classified cloud by `detectCloudStorage`'s pure string match) so we
 * exercise the real readlink-only classification without a FUSE mount. A DEAD
 * mount is simulated by a symlink to a non-existent `Dropbox/` path: the classifier
 * is readlink-only, so it NEVER touches the (missing) target — no hang.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildFindCloudPruneArgs,
  buildGrepCloudExcludeArgs,
  buildRgCloudExcludeArgs,
  collectIncidentalCloudExclusions,
} from '../tools/cloudSubprocessExclusion';
import {
  setCloudLivenessProbe,
  __resetCloudLivenessProbeForTesting,
  type CloudHealthVerdict,
} from '@core/services/cloudLivenessProbe';
import {
  setCloudSymlinkIndexingEnabled,
  __resetCloudSymlinkIndexingForTests,
} from '@core/services/cloudSymlinkIndexing';
import {
  configureCloudSpaceContainment,
  __resetCloudSpaceContainmentForTests,
} from '@core/services/cloudSpaceContainment';

let tmpRoot: string;

const isCloudPath = (p: string) => p.toLowerCase().includes('/dropbox/');

function installVerdict(verdict: CloudHealthVerdict): void {
  setCloudLivenessProbe({
    probeHealth: async () => verdict,
    getCachedVerdict: (target) => (isCloudPath(target) ? verdict : 'unknown'),
  });
}

/** Create `<tmpRoot>/cloud-store/Dropbox/<name>` with a marker file; return path. */
async function makeCloudDir(name: string): Promise<string> {
  const cloudDir = path.join(tmpRoot, 'cloud-store', 'Dropbox', name);
  await fs.mkdir(cloudDir, { recursive: true });
  await fs.writeFile(path.join(cloudDir, 'in-cloud.md'), '# cloud');
  return cloudDir;
}

describe('cloudSubprocessExclusion', () => {
  beforeEach(async () => {
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
    tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-excl-')));
  });

  afterEach(async () => {
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
    __resetCloudSpaceContainmentForTests();
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('excludes an incidental cloud symlink reached from a non-cloud root', async () => {
    const workspace = path.join(tmpRoot, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, 'local.md'), '# local');
    const cloudDir = await makeCloudDir('General');
    await fs.symlink(cloudDir, path.join(workspace, 'General'));

    const exclusions = collectIncidentalCloudExclusions(workspace);
    expect(exclusions.map((e) => e.relativePath)).toEqual(['General']);
    expect(exclusions[0]!.absolutePath).toBe(path.join(workspace, 'General'));
  });

  it('does NOT exclude a non-cloud outside-workspace symlink (rebel-system pattern)', async () => {
    const workspace = path.join(tmpRoot, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    const localExtern = path.join(tmpRoot, 'Applications', 'rebel-system');
    await fs.mkdir(localExtern, { recursive: true });
    await fs.symlink(localExtern, path.join(workspace, 'rebel-system'));

    const exclusions = collectIncidentalCloudExclusions(workspace);
    expect(exclusions).toEqual([]);
  });

  it('does NOT exclude anything when the ROOT is itself an explicitly-named cloud path (carve-out)', async () => {
    // Search rooted AT a cloud folder the user named → no enumeration, no exclusion.
    const cloudDir = await makeCloudDir('NamedFolder');
    await fs.mkdir(path.join(cloudDir, 'sub'), { recursive: true });
    await fs.symlink(cloudDir, path.join(cloudDir, 'self-link')).catch(() => {});

    const exclusions = collectIncidentalCloudExclusions(cloudDir);
    expect(exclusions).toEqual([]);
  });

  it('does NOT hang on a DEAD cloud symlink (dangling target) — classified readlink-only', async () => {
    const workspace = path.join(tmpRoot, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    // Symlink into a Dropbox path that does NOT exist (a dead mount). The
    // classifier is readlink-only, so it never stats the missing target.
    const deadTarget = path.join(tmpRoot, 'nope', 'Dropbox', 'Dead');
    await fs.symlink(deadTarget, path.join(workspace, 'Dead'));

    const exclusions = collectIncidentalCloudExclusions(workspace);
    expect(exclusions.map((e) => e.relativePath)).toEqual(['Dead']);
  });

  it('does NOT enumerate a CONTAINMENT-cloud root reached by its logical workspace path (S5 carve-out)', async () => {
    // A configured cloud space addressed by its LOGICAL workspace path
    // (`workspace/General`) is pattern-FALSE but containment-cloud. The pre-S5
    // PATTERN-only carve-out would `readdirSync` it — following the symlink into a
    // possibly-dead mount and blocking the MAIN thread. The containment-aware carve-out
    // returns [] WITHOUT enumerating it (the subprocess `timeout` bounds the search of
    // the root itself). Default-ON makes a logical cloud-space root a normal search root.
    const workspace = path.join(tmpRoot, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    const cloudDir = await makeCloudDir('General'); // <tmpRoot>/cloud-store/Dropbox/General
    // A nested cloud symlink INSIDE the space — pre-fix the `readdirSync` would find +
    // exclude it (the discriminator: post-fix never enumerates, so returns []).
    const otherCloud = path.join(tmpRoot, 'cloud-store', 'Dropbox', 'Other');
    await fs.mkdir(otherCloud, { recursive: true });
    await fs.symlink(otherCloud, path.join(cloudDir, 'nested-link'));
    const logicalSpace = path.join(workspace, 'General');
    await fs.symlink(cloudDir, logicalSpace);
    // Configure containment so the LOGICAL space path classifies as cloud.
    configureCloudSpaceContainment(workspace, [
      { name: 'General', path: 'General', type: 'other', isSymlink: true, createdAt: 0 },
    ]);

    // Rooted AT the logical cloud-space path → carve-out → [] (no readdirSync of the mount).
    const exclusions = collectIncidentalCloudExclusions(logicalSpace);
    expect(exclusions).toEqual([]);
  });

  it('admission ON + healthy verdict ⇒ cloud symlink is NOT excluded (re-included)', async () => {
    setCloudSymlinkIndexingEnabled(true);
    installVerdict('healthy');
    const workspace = path.join(tmpRoot, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    const cloudDir = await makeCloudDir('General');
    await fs.symlink(cloudDir, path.join(workspace, 'General'));

    const exclusions = collectIncidentalCloudExclusions(workspace);
    expect(exclusions).toEqual([]);
  });

  it('admission ON + degraded verdict ⇒ cloud symlink IS excluded (requires healthy)', async () => {
    setCloudSymlinkIndexingEnabled(true);
    installVerdict('degraded');
    const workspace = path.join(tmpRoot, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    const cloudDir = await makeCloudDir('General');
    await fs.symlink(cloudDir, path.join(workspace, 'General'));

    const exclusions = collectIncidentalCloudExclusions(workspace);
    expect(exclusions.map((e) => e.relativePath)).toEqual(['General']);
  });

  it('arg builders emit the expected rg/find/grep pruning flags', () => {
    const ex = [{ absolutePath: '/ws/General', relativePath: 'General' }];
    expect(buildRgCloudExcludeArgs(ex)).toEqual(['--glob', '!General', '--glob', '!General/**']);
    // F2: the prune branch is wrapped in `\( … -prune -false \)` so `find`'s
    // implicit `-print` never emits the pruned cloud symlink's own path (which a
    // basename-matching pattern would otherwise realpath downstream — the hang).
    expect(buildFindCloudPruneArgs(ex)).toEqual([
      '(', '-path', '/ws/General', '-prune', '-false', ')', '-o',
    ]);
    expect(buildGrepCloudExcludeArgs(ex)).toEqual(['--exclude-dir=General']);
    expect(buildRgCloudExcludeArgs([])).toEqual([]);
    expect(buildFindCloudPruneArgs([])).toEqual([]);
    expect(buildGrepCloudExcludeArgs([])).toEqual([]);
  });

  it('F2: find-prune args, run against a real tree with a dead cloud symlink, never emit the symlink path', async () => {
    // Drives `find` for real (not mocked) so we prove the `-false` actually keeps
    // the pruned, dangling cloud symlink out of stdout — i.e. it never reaches the
    // downstream realpath/zone-check that hangs on a dead mount.
    if (process.platform === 'win32') return;
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const workspace = path.join(tmpRoot, 'workspace');
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'local.ts'), 'export const local = 1;\n');
    await fs.writeFile(path.join(workspace, 'src', 'a.ts'), 'export const a = 1;\n');
    // A DEAD cloud symlink whose target does not exist (dangling FUSE mount).
    const deadTarget = path.join(tmpRoot, 'nope', 'Dropbox', 'General');
    await fs.symlink(deadTarget, path.join(workspace, 'General'));

    const exclusions = collectIncidentalCloudExclusions(workspace);
    expect(exclusions.map((e) => e.relativePath)).toEqual(['General']);

    const prune = buildFindCloudPruneArgs(exclusions);
    const args = ['-L', workspace, ...prune, '-type', 'f'];
    // 5s timeout: if the symlink were followed/printed this would still return
    // (find -type f on a dangling link yields nothing), but the assertion below
    // is the real guard — the symlink PATH must never appear in stdout.
    const { stdout } = await execFileAsync('find', args, { timeout: 5_000 });
    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
    // Local files still found, in their normal positions.
    expect(lines).toContain(path.join(workspace, 'local.ts'));
    expect(lines).toContain(path.join(workspace, 'src', 'a.ts'));
    // The pruned cloud symlink's own path must NOT be emitted (the F2 fix).
    expect(lines).not.toContain(path.join(workspace, 'General'));
  });
});
