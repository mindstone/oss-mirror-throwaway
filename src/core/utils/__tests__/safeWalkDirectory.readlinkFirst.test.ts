/**
 * RS-F1 (Stage 6a) — READLINK-FIRST cloud classification in safeWalkDirectory's
 * descent body.
 *
 * Before RS-F1 the descent body resolved an INCIDENTAL symlink dirent with
 * `stat`/`realpath` (to learn file-vs-dir + for cycle detection) BEFORE the
 * cloud-skip guard could fire — so a symlink into a dead cloud FUSE mount blocked in
 * the kernel (the 0.4.48→0.4.49 hang class). RS-F1 classifies the symlink via
 * `walkToFirstCloudHopViaReadlink` (readlink-only, never touches the target) FIRST; a
 * cloud symlink is recorded `cloud-symlink-skipped` and skipped WITHOUT any stat /
 * realpath / descent. Behaviour-preserving: cloud symlinks are STILL excluded with the
 * SAME truncation reason — only the classification mechanism changed.
 *
 * S4.1a note: the walker now routes every cloud-capable op through `boundedWorkspaceFs`,
 * so these tests use REAL temp-dir fixtures (a `Dropbox/`-segment dir is the
 * pattern-classified cloud stand-in) and assert on observable BEHAVIOUR + on whether
 * the (unchanged) readlink-first classifier was consulted. The dead-mount
 * hang-PROOFING is covered by the executor-driven cloud-root / admission suites; this
 * suite owns the classification-and-skip POLICY. `walkToFirstCloudHopViaReadlink` is
 * wrapped in a spy (calling through to the real implementation on the real symlinks).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import * as readlinkChain from '@core/utils/readlinkChain';
import {
  setWorkspaceFsExecutor,
  __resetWorkspaceFsExecutorForTesting,
} from '@core/services/boundedWorkspaceFs';
import { realFsExecutor } from '@core/services/__tests__/workspaceFsExecutorDoubles';
import {
  setCloudSymlinkIndexingEnabled,
  __resetCloudSymlinkIndexingForTests,
} from '@core/services/cloudSymlinkIndexing';
import {
  setCloudLivenessProbe,
  __resetCloudLivenessProbeForTesting,
} from '@core/services/cloudLivenessProbe';
import {
  configureCloudSpaceContainment,
  __resetCloudSpaceContainmentForTests,
} from '@core/services/cloudSpaceContainment';

// Spy on the (unchanged) readlink-first classifier while calling through to the real
// implementation — lets us assert WHETHER it was consulted for a given dirent.
vi.mock('@core/utils/readlinkChain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/utils/readlinkChain')>();
  return { ...actual, walkToFirstCloudHopViaReadlink: vi.fn(actual.walkToFirstCloudHopViaReadlink) };
});

const classifySpy = (): Mock => readlinkChain.walkToFirstCloudHopViaReadlink as unknown as Mock;

let tmpRoot: string;
let workspace: string;
let cloudSymlink: string; // incidental symlink → Dropbox cloud stand-in
let localSymlink: string; // symlink → local dir (must still be followed)

import { safeWalkDirectory } from '../safeWalkDirectory';

describe('safeWalkDirectory — RS-F1 readlink-first cloud classification (descent)', () => {
  beforeEach(async () => {
    tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-readlinkfirst-')));

    // Cloud stand-in (pattern-classified by the `Dropbox/` segment) + a local target.
    const cloudTarget = path.join(tmpRoot, 'Dropbox', 'Shared', 'Company Memories');
    await fs.mkdir(cloudTarget, { recursive: true });
    await fs.writeFile(path.join(cloudTarget, 'drive-doc.md'), '# drive');
    const localTarget = path.join(tmpRoot, 'Projects', 'shared-notes');
    await fs.mkdir(localTarget, { recursive: true });
    await fs.writeFile(path.join(localTarget, 'note.md'), '# note');

    workspace = path.join(tmpRoot, 'workspace');
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'local.md'), '# local');
    cloudSymlink = path.join(workspace, 'Company Memories');
    await fs.symlink(cloudTarget, cloudSymlink);
    localSymlink = path.join(workspace, 'Shared Notes');
    await fs.symlink(localTarget, localSymlink);

    setWorkspaceFsExecutor(realFsExecutor); // healthy mount
    classifySpy().mockClear();
  });
  afterEach(async () => {
    __resetWorkspaceFsExecutorForTesting();
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
    __resetCloudSpaceContainmentForTests();
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('classifies an incidental cloud symlink via readlink-first and SKIPS it (no descent), recording cloud-symlink-skipped', async () => {
    const seen: string[] = [];
    const result = await safeWalkDirectory(workspace, {
      onFile: ({ name }) => {
        seen.push(name);
      },
    });

    // Local file seen; the cloud subtree was NOT descended.
    expect(seen).toContain('local.md');
    expect(seen).not.toContain('drive-doc.md');
    expect(result.truncatedReasons).toContain('cloud-symlink-skipped');
    // The skip fired via readlink-first classification (the classifier WAS consulted
    // for the cloud symlink) and BEFORE any boundary stat, so it is not a cloud-timeout.
    expect(classifySpy()).toHaveBeenCalledWith(cloudSymlink);
    expect(result.truncatedReasons).not.toContain('cloud-timeout');
  });

  it('a NON-cloud symlink is still FOLLOWED (cycle detection / descent preserved)', async () => {
    const seen: string[] = [];
    await safeWalkDirectory(workspace, {
      onFile: ({ name }) => {
        seen.push(name);
      },
    });

    // The local symlink was classified (local-terminus, not cloud) and followed.
    expect(classifySpy()).toHaveBeenCalledWith(localSymlink);
    expect(seen).toContain('note.md');
  });

  it('inside an EXPLICIT cloud-root walk, a nested symlink is NOT readlink-first-classified (parent is the mount → boundary stat path)', async () => {
    // The caller named a cloud folder AS the root (the carve-out). A nested symlink's
    // OWN inode lives in the cloud mount, so a synchronous readlink there could block
    // the MAIN thread — the F1 gate (`!currentDirIsCloud`) skips the readlink-first
    // block, and the nested symlink takes the boundary's (cloud-lane, bounded) stat.
    const cloudRoot = path.join(tmpRoot, 'Dropbox', 'Named Folder');
    const realSub = path.join(cloudRoot, 'realsub');
    await fs.mkdir(realSub, { recursive: true });
    await fs.writeFile(path.join(realSub, 'inner.md'), '# inner');
    await fs.symlink(realSub, path.join(cloudRoot, 'nested-link'));
    const nestedLink = path.join(cloudRoot, 'nested-link');
    classifySpy().mockClear();

    const seen: string[] = [];
    await safeWalkDirectory(cloudRoot, {
      onFile: ({ name }) => {
        seen.push(name);
      },
    });

    // The nested symlink was NEVER readlink-first-classified (the gate held).
    expect(classifySpy()).not.toHaveBeenCalledWith(nestedLink);
    // The explicit cloud root still walked (healthy executor) — inner file reached.
    expect(seen).toContain('inner.md');
  });

  it('inside an ADMITTED CONTAINMENT-cloud space (pattern-false logical path), a nested symlink is NOT readlink-first-classified (S5 flip-blocker)', async () => {
    // The flip-blocker the containment-aware gate closes. A configured cloud space is
    // reached via a LOCAL-looking workspace symlink (`workspace/Company Memories`), and
    // the walk descends it by its LOGICAL path — pattern-FALSE (no Dropbox segment in
    // `workspace/Company Memories`) but containment-cloud (`isUnderCloudSpace` true).
    // A nested symlink there has its OWN inode ON the cloud mount, so the pre-fix
    // PATTERN-only `!currentDirIsCloud` gate let a synchronous `readlinkSync` run on a
    // possibly-dead mount. The containment-aware gate skips readlink-first; the nested
    // symlink takes the boundary's bounded (cloud-lane) stat instead.
    setCloudSymlinkIndexingEnabled(true);
    setCloudLivenessProbe({ probeHealth: async () => 'healthy', getCachedVerdict: () => 'healthy' });
    // The cloud space is reached via the workspace symlink `Company Memories` → cloudTarget.
    configureCloudSpaceContainment(workspace, [
      { name: 'Company Memories', path: 'Company Memories', type: 'other', isSymlink: true, createdAt: 0 },
    ]);
    // A nested symlink INSIDE the cloud target, pointing to a SEPARATE pattern-cloud
    // dir reachable ONLY via the symlink (not as a regular child of the space, which
    // would be walked directly). Reached via the logical descent path
    // `workspace/Company Memories/nested-link`.
    const cloudTarget = path.join(tmpRoot, 'Dropbox', 'Shared', 'Company Memories');
    const nestedCloudTarget = path.join(tmpRoot, 'Dropbox', 'Hidden', 'secret');
    await fs.mkdir(nestedCloudTarget, { recursive: true });
    await fs.writeFile(path.join(nestedCloudTarget, 'secret.md'), '# secret');
    await fs.symlink(nestedCloudTarget, path.join(cloudTarget, 'nested-link'));
    const nestedLinkLogical = path.join(workspace, 'Company Memories', 'nested-link');
    classifySpy().mockClear();

    const seen: string[] = [];
    await safeWalkDirectory(workspace, {
      onFile: ({ name }) => {
        seen.push(name);
      },
    });

    // The space's TOP symlink WAS classified (to admit it from the LOCAL workspace root)…
    expect(classifySpy()).toHaveBeenCalledWith(cloudSymlink);
    // …but the NESTED symlink, processed with currentDir = the pattern-false
    // containment-cloud logical path, was NOT readlink-first-classified — the
    // containment-aware gate held (no sync readlinkSync on a possibly-dead mount).
    expect(classifySpy()).not.toHaveBeenCalledWith(nestedLinkLogical);
    // The admitted space still walked via the bounded cloud lane (healthy executor).
    expect(seen).toContain('drive-doc.md');
    // The nested symlink resolves into a (different) cloud mount, so the realpath
    // BACKSTOP (a pure pattern check on the already-computed realpath — no fs) still
    // excludes it; exclusion now happens via the bounded path, not a sync readlink.
    expect(seen).not.toContain('secret.md');
  });

  it('with skipCloudSymlinkTargets:false (opt-out) the readlink-first guard is NOT consulted — the cloud symlink is walked', async () => {
    const seen: string[] = [];
    const result = await safeWalkDirectory(workspace, {
      skipCloudSymlinkTargets: false,
      onFile: ({ name }) => {
        seen.push(name);
      },
    });

    // Opt-out bypasses the readlink-first classifier for the cloud symlink entirely,
    // matching pre-RS-F1 opt-out behaviour (cloud-sync semantics: descend).
    expect(classifySpy()).not.toHaveBeenCalledWith(cloudSymlink);
    expect(seen).toContain('drive-doc.md'); // opt-out chose to walk the cloud subtree
    expect(result.truncatedReasons).not.toContain('cloud-symlink-skipped');
  });
});
