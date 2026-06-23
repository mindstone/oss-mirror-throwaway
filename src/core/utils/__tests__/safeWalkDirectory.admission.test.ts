/**
 * Stage 6b — descent ADMISSION in safeWalkDirectory (site a).
 *
 * With the admission flag OFF (default), a cloud symlink is SKIPPED exactly as
 * today (`cloud-symlink-skipped`, no descent) — byte-identical to 6a. With the
 * flag ON and the space's verdict `healthy`, the cloud symlink is ADMITTED: the
 * walk descends into it via the boundary's CLOUD lane (killable-pool reclaim), so a
 * mount that dies between the verdict read and the descent degrades to a
 * `cloud-timeout` skip rather than hanging. A `degraded`/`unknown` verdict ⇒ skip
 * even with the flag on.
 *
 * S4.1a: the walker no longer issues raw `fs.stat`/`fs.realpath` — every cloud-capable
 * op routes through `boundedWorkspaceFs`. We therefore drive these tests with REAL
 * temp-dir fixtures (a `Dropbox/`-segment dir is the pattern-classified cloud
 * stand-in) plus a wired executor: a HEALTHY (real-fs) executor for the admitted
 * cases, and a stat-wedging executor for the "mount dies after the verdict" case.
 * Assertions are on observable BEHAVIOUR (files seen, truncation reasons), not on
 * which fs primitive was called.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  setWorkspaceFsExecutor,
  __resetWorkspaceFsExecutorForTesting,
} from '@core/services/boundedWorkspaceFs';
import { realFsExecutor, realFsExecutorWith } from '@core/services/__tests__/workspaceFsExecutorDoubles';
import {
  configureCloudSpaceContainment,
  __resetCloudSpaceContainmentForTests,
} from '@core/services/cloudSpaceContainment';
import { safeWalkDirectory } from '../safeWalkDirectory';

let tmpRoot: string;
let workspace: string;
let cloudSymlink: string;

/** Install a stub probe that returns `verdict` for the admitted cloud target. */
function installVerdict(verdict: CloudHealthVerdict): void {
  setCloudLivenessProbe({
    probeHealth: async () => verdict,
    // The admission key is the first cloud-hop target (a `Dropbox/` path here);
    // return the verdict for it. Non-cloud keys never reach admission.
    getCachedVerdict: () => verdict,
  });
}

describe('safeWalkDirectory — Stage 6b admission (site a)', () => {
  beforeEach(async () => {
    tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-admission-')));
    // A real `Dropbox/`-segment dir stands in for a cloud mount (pattern-classified).
    const cloudTarget = path.join(tmpRoot, 'Dropbox', 'Shared', 'Company Memories');
    await fs.mkdir(cloudTarget, { recursive: true });
    await fs.writeFile(path.join(cloudTarget, 'drive-doc.md'), '# drive');
    workspace = path.join(tmpRoot, 'workspace');
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'local.md'), '# local');
    cloudSymlink = path.join(workspace, 'Company Memories');
    await fs.symlink(cloudTarget, cloudSymlink);
    // Configure the space as a cloud space (containment). This is what makes the
    // descendant reads of the admitted symlink route the BOUNDED cloud lane in
    // production — without it the subtree would silently take the bare-fs LOCAL lane
    // and the "admitted descent is bounded" property would be unverified (S4.1a Opus
    // review SHOULD-1). Resolves the symlink to its cloud realpath internally.
    configureCloudSpaceContainment(workspace, [
      { name: 'Company Memories', path: 'Company Memories', type: 'other', isSymlink: true, createdAt: 0 },
    ]);
    // Healthy cloud mount by default; specific tests override.
    setWorkspaceFsExecutor(realFsExecutor);
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
  });
  afterEach(async () => {
    __resetWorkspaceFsExecutorForTesting();
    __resetCloudSpaceContainmentForTests();
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('flag OFF ⇒ cloud symlink SKIPPED (byte-identical to today), even with a healthy verdict', async () => {
    installVerdict('healthy'); // healthy verdict but flag off → still skip
    const seen: string[] = [];
    const result = await safeWalkDirectory(workspace, {
      onFile: ({ name }) => {
        seen.push(name);
      },
    });

    expect(seen).toContain('local.md');
    expect(seen).not.toContain('drive-doc.md'); // cloud NOT descended
    expect(result.truncatedReasons).toContain('cloud-symlink-skipped');
    // The readlink-first skip fires BEFORE any boundary op on the mount, so the
    // skip — not a cloud-timeout — is what's recorded.
    expect(result.truncatedReasons).not.toContain('cloud-timeout');
  });

  it('flag ON + healthy verdict ⇒ cloud symlink ADMITTED (descended + file indexed)', async () => {
    setCloudSymlinkIndexingEnabled(true);
    installVerdict('healthy');
    const seen: string[] = [];
    const result = await safeWalkDirectory(workspace, {
      onFile: ({ name }) => {
        seen.push(name);
      },
    });

    expect(seen).toContain('local.md');
    expect(seen).toContain('drive-doc.md'); // cloud subtree WALKED
    expect(result.truncatedReasons).not.toContain('cloud-symlink-skipped');
  });

  it('flag ON + DEGRADED verdict ⇒ cloud symlink SKIPPED (admission requires healthy)', async () => {
    setCloudSymlinkIndexingEnabled(true);
    installVerdict('degraded');
    const seen: string[] = [];
    const result = await safeWalkDirectory(workspace, {
      onFile: ({ name }) => {
        seen.push(name);
      },
    });

    expect(seen).not.toContain('drive-doc.md');
    expect(result.truncatedReasons).toContain('cloud-symlink-skipped');
  });

  it('flag ON + healthy verdict, but mount DIES after the verdict read ⇒ bounded skip, no hang', async () => {
    setCloudSymlinkIndexingEnabled(true);
    installVerdict('healthy');
    // The admitted symlink's stat goes through the CLOUD lane; a mount that died
    // since the verdict read wedges → the executor times out → `reconnecting`.
    setWorkspaceFsExecutor(
      realFsExecutorWith({
        stat: () => Promise.resolve({ ok: false, reason: 'timeout' }),
      }),
    );
    const seen: string[] = [];
    const result = await safeWalkDirectory(workspace, {
      onFile: ({ name }) => {
        seen.push(name);
      },
    });

    expect(seen).toContain('local.md'); // walk did not hang
    expect(seen).not.toContain('drive-doc.md');
    expect(result.truncatedReasons).toContain('cloud-timeout'); // bounded → truncated
  });

  it('flag ON + healthy, admitted, but the SUBTREE readdir wedges ⇒ bounded descent (cloud-timeout), no hang', async () => {
    // SHOULD-1 (S4.1a Opus review): the admitted symlink itself stats/realpaths fine, the walk
    // DESCENDS, and only then the subtree enumeration wedges. Because the space is
    // containment-classified, that descendant readdir routes the BOUNDED cloud lane (NOT bare-fs
    // LOCAL), so a mount that dies under an admitted space degrades to a cloud-timeout truncation
    // instead of hanging. This is the property the prior admitted-descent test left unverified.
    setCloudSymlinkIndexingEnabled(true);
    installVerdict('healthy');
    setWorkspaceFsExecutor(
      // Healthy stat/realpath (the symlink admits + descends), but every cloud-lane readdir wedges.
      realFsExecutorWith({
        readdirWithFileTypes: () => Promise.resolve({ ok: false, reason: 'timeout' }),
      }),
    );
    const seen: string[] = [];
    const result = await safeWalkDirectory(workspace, {
      onFile: ({ name }) => {
        seen.push(name);
      },
    });

    expect(seen).toContain('local.md'); // root (LOCAL lane) walked — no hang
    expect(seen).not.toContain('drive-doc.md'); // subtree enumeration bounded, not hung
    expect(result.truncatedReasons).toContain('cloud-timeout');
  });
});
