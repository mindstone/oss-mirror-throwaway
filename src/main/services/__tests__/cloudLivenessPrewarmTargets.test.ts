/**
 * deriveCloudPrewarmTargets — FS-free + readlink-only cold-start prewarm target
 * derivation (Stage 3 + Phase-6 refinement, 260619_cloud-symlink-indexing).
 *
 * The refinement (F1 + F2) changed the shape of this helper:
 *  - F2: the candidate enumeration is now FS-FREE — it comes from settings
 *    `spaces`, NOT a `readdirSync` of the workspace root (which could itself be a
 *    cloud-classified FUSE mount whose readdir blocks the main thread unbounded).
 *  - F1: target resolution walks the symlink chain readlink-only and STOPS at the
 *    first cloud hop (so a `link → localAlias → CloudStorage/…` chain is picked up,
 *    not silently dropped), and never `readlinkSync`s past a cloud hop.
 *
 * Uses real temp dirs + symlinks (no real Drive) so the readlink walk +
 * `detectCloudStorage` classification are exercised faithfully. Spaces come from a
 * synthetic `SpaceConfig[]` (the FS-free source of truth).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpaceConfig } from '@shared/types/settings';
import { computeCloudIndexingCoverage, deriveCloudPrewarmTargets } from '../cloudLivenessProbeService';
import type { CloudHealthVerdict, ReadlinkResolvedTarget } from '@core/services/cloudLivenessProbe';
import {
  mintCloudHopTargetCloudRootSafe,
  mintCloudHopTargetFromKnownCloudPath,
  mintFirstCloudHopTargetSync,
} from '@core/services/cloudLivenessProbe.types';

let workspaceRoot: string;
let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-prewarm-'));
  workspaceRoot = path.join(scratch, 'workspace');
  fs.mkdirSync(workspaceRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Minimal SpaceConfig factory — only the fields the helper reads matter. */
function space(partial: Partial<SpaceConfig> & Pick<SpaceConfig, 'path'>): SpaceConfig {
  return {
    name: partial.name ?? partial.path,
    type: partial.type ?? 'other',
    isSymlink: partial.isSymlink ?? false,
    createdAt: partial.createdAt ?? 0,
    ...partial,
  };
}

describe('deriveCloudPrewarmTargets', () => {
  it('returns cloud-symlinked targets and skips local dirs + non-cloud symlinks', () => {
    // A plain local dir under the workspace — NOT a symlink, ignored.
    fs.mkdirSync(path.join(workspaceRoot, 'LocalSpace'));

    // A symlink to a cloud-storage path (the target need not exist on disk — the
    // derivation is readlink-only and never stats/realpaths the target).
    const cloudTarget = path.join(
      scratch,
      'Library',
      'CloudStorage',
      'GoogleDrive-test@example.com',
      'Shared drives',
      'General',
    );
    fs.symlinkSync(cloudTarget, path.join(workspaceRoot, 'General'));

    // A symlink to a NON-cloud outside-workspace location (e.g. rebel-system) —
    // detectCloudStorage returns isCloud:false → must NOT be a prewarm target.
    const nonCloudTarget = path.join(scratch, 'Applications', 'RebelSystem');
    fs.mkdirSync(nonCloudTarget, { recursive: true });
    fs.symlinkSync(nonCloudTarget, path.join(workspaceRoot, 'rebel-system'));

    const spaces = [
      space({ path: 'LocalSpace', isSymlink: false }),
      space({ path: 'General', isSymlink: true }),
      space({ path: 'rebel-system', isSymlink: true }),
    ];
    const targets = deriveCloudPrewarmTargets(workspaceRoot, spaces);
    expect(targets).toEqual([cloudTarget]);
  });

  it('picks up a CHAINED symlink: link → localAlias → CloudStorage/… (F1 topology)', () => {
    // The first-hop-only minter would classify the local alias as non-cloud and
    // silently DROP this space; the refined stop-at-first-cloud-hop walker follows
    // the alias and returns the Drive target.
    const cloudTarget = path.join(
      scratch,
      'Library',
      'CloudStorage',
      'GoogleDrive-x@example.com',
      'Shared drives',
      'Exec',
    );
    const localAlias = path.join(scratch, 'DriveAlias'); // a LOCAL path
    fs.symlinkSync(cloudTarget, localAlias); // alias → cloud (target need not exist)
    fs.symlinkSync(localAlias, path.join(workspaceRoot, 'Exec')); // link → alias

    const spaces = [space({ path: 'Exec', isSymlink: true })];
    const targets = deriveCloudPrewarmTargets(workspaceRoot, spaces);
    expect(targets).toEqual([cloudTarget]);
  });

  it('handles multiple cloud spaces (de-duped by target)', () => {
    const driveBase = path.join(scratch, 'Library', 'CloudStorage', 'GoogleDrive-x@example.com');
    const general = path.join(driveBase, 'General');
    const exec = path.join(driveBase, 'Exec');
    fs.symlinkSync(general, path.join(workspaceRoot, 'General'));
    fs.symlinkSync(exec, path.join(workspaceRoot, 'Exec'));
    // A second space pointing at the SAME Drive root → de-duped to one target.
    fs.symlinkSync(general, path.join(workspaceRoot, 'GeneralDup'));

    const spaces = [
      space({ path: 'General', isSymlink: true }),
      space({ path: 'Exec', isSymlink: true }),
      space({ path: 'GeneralDup', isSymlink: true }),
    ];
    const targets = deriveCloudPrewarmTargets(workspaceRoot, spaces);
    expect(targets.sort()).toEqual([exec, general].sort());
  });

  it('returns [] when spaces is undefined or empty', () => {
    expect(deriveCloudPrewarmTargets(workspaceRoot, undefined)).toEqual([]);
    expect(deriveCloudPrewarmTargets(workspaceRoot, [])).toEqual([]);
  });

  it('returns [] when there are no cloud-symlinked spaces', () => {
    fs.mkdirSync(path.join(workspaceRoot, 'JustALocalFolder'));
    const spaces = [space({ path: 'JustALocalFolder', isSymlink: false })];
    expect(deriveCloudPrewarmTargets(workspaceRoot, spaces)).toEqual([]);
  });

  it('F2: never does a main-thread blocking FS call on the workspace root, even when coreDirectory is cloud-classified', () => {
    // Simulate the real-user hazard: coreDirectory is itself a cloud-classified
    // FUSE mount. The OLD implementation `readdirSync`'d this root → unbounded
    // main-thread block. The refined helper enumerates FS-FREE from settings, so
    // it must NEVER readdir/stat the cloud root.
    const cloudCoreDirectory = path.join(
      os.homedir(),
      'Library',
      'CloudStorage',
      'Dropbox-Team',
      'workspace',
    );

    const readdirSpy = vi.spyOn(fs, 'readdirSync');
    const statSpy = vi.spyOn(fs, 'statSync');
    const lstatSpy = vi.spyOn(fs, 'lstatSync');
    // Stage 2 contract: under a cloud-classified root we NEVER readlink the link
    // inode (it lives in the possibly-dead mount). A symlinked space with no usable
    // cached cloud `sourcePath` is simply SKIPPED — no readdir/stat/lstat against
    // the cloud root either.
    const spaces = [
      space({ path: 'General', isSymlink: true }),
      space({ path: 'LocalDoc', isSymlink: false }),
    ];

    expect(() => deriveCloudPrewarmTargets(cloudCoreDirectory, spaces)).not.toThrow();

    // No bare readdir/stat/lstat on the cloud root (or anything under it) happened.
    expect(readdirSpy).not.toHaveBeenCalled();
    expect(statSpy).not.toHaveBeenCalled();
    expect(lstatSpy).not.toHaveBeenCalled();
  });

  it('Stage 2 (NEW CONTRACT): under a cloud-classified coreDirectory, derives targets from cached absolute-cloud sourcePath with ZERO filesystem I/O (no readlinkSync on the link inode under the cloud root)', () => {
    // The fix: when coreDirectory is itself a (possibly dead) cloud FUSE root, the
    // link inode lives IN that root, so even a readlinkSync could block. Instead we
    // mint the probe target from the cached `space.sourcePath` — a PURE STRING read
    // of in-memory settings. So a symlinked space WITH an absolute cloud sourcePath
    // yields that sourcePath as a derived target, and NOTHING touches the FS.
    const cloudCoreDirectory = path.join(
      os.homedir(),
      'Library',
      'CloudStorage',
      'GoogleDrive-dead@example.com',
      'workspace',
    );
    const generalSource = path.join(
      os.homedir(),
      'Library',
      'CloudStorage',
      'GoogleDrive-x@example.com',
      'Shared drives',
      'General',
    );
    const execSource = path.join(
      os.homedir(),
      'Library',
      'CloudStorage',
      'GoogleDrive-x@example.com',
      'Shared drives',
      'Exec',
    );

    const readlinkSpy = vi.spyOn(fs, 'readlinkSync');
    const readdirSpy = vi.spyOn(fs, 'readdirSync');
    const statSpy = vi.spyOn(fs, 'statSync');
    const lstatSpy = vi.spyOn(fs, 'lstatSync');
    const realpathSpy = vi.spyOn(fs, 'realpathSync');
    const accessSpy = vi.spyOn(fs, 'accessSync');

    const spaces = [
      space({ path: 'General', isSymlink: true, sourcePath: generalSource }),
      space({ path: 'Exec', isSymlink: true, sourcePath: execSource }),
    ];

    const targets = deriveCloudPrewarmTargets(cloudCoreDirectory, spaces);

    expect(targets.sort()).toEqual([execSource, generalSource].sort());
    // ZERO filesystem I/O on the fast path — not even a readlink on the link inode.
    expect(readlinkSpy).not.toHaveBeenCalled();
    expect(readdirSpy).not.toHaveBeenCalled();
    expect(statSpy).not.toHaveBeenCalled();
    expect(lstatSpy).not.toHaveBeenCalled();
    expect(realpathSpy).not.toHaveBeenCalled();
    expect(accessSpy).not.toHaveBeenCalled();
  });

  it('Stage 2: under a cloud root, SKIPS a space with no / relative / non-cloud sourcePath (no readlink fallback)', () => {
    const cloudCoreDirectory = path.join(
      os.homedir(),
      'Library',
      'CloudStorage',
      'GoogleDrive-dead@example.com',
      'workspace',
    );
    const goodSource = path.join(
      os.homedir(),
      'Library',
      'CloudStorage',
      'GoogleDrive-x@example.com',
      'Shared drives',
      'General',
    );

    const readlinkSpy = vi.spyOn(fs, 'readlinkSync');

    const spaces = [
      // Eligible — absolute cloud sourcePath → derived.
      space({ path: 'General', isSymlink: true, sourcePath: goodSource }),
      // Missing sourcePath → skipped.
      space({ path: 'NoSource', isSymlink: true }),
      // Relative sourcePath (key would not match the walker's parent-resolved key) → skipped.
      space({ path: 'RelSource', isSymlink: true, sourcePath: '../somewhere/General' }),
      // Absolute but NON-cloud sourcePath (a genuinely local outside-workspace space) → skipped.
      space({
        path: 'LocalLink',
        isSymlink: true,
        sourcePath: path.join(os.homedir(), 'Documents', 'NotCloud'),
      }),
    ];

    const targets = deriveCloudPrewarmTargets(cloudCoreDirectory, spaces);

    expect(targets).toEqual([goodSource]);
    // Still no readlink anywhere under the cloud root.
    expect(readlinkSpy).not.toHaveBeenCalled();
  });

  it('Stage 2 KEY-EQUIVALENCE: the sourcePath-derived target equals mintFirstCloudHopTargetSync(<linkPath>) for a direct cloud symlink', () => {
    // Build a REAL direct cloud symlink (link → absolute cloud target). The raw
    // readlink target IS what scanSpaces persists as `sourcePath`. Prove the
    // cloud-root fast path (sourcePath) and the local-root live-link walker mint the
    // IDENTICAL branded key — otherwise the seeded `healthy` verdict would be read
    // back under a different key at admission and the fix would silently no-op.
    const cloudTarget = path.join(
      scratch,
      'Library',
      'CloudStorage',
      'GoogleDrive-x@example.com',
      'Shared drives',
      'General',
    );
    const linkPath = path.join(workspaceRoot, 'General');
    fs.symlinkSync(cloudTarget, linkPath);

    // `sourcePath` is the raw readlink target (absolute here = the cloud target).
    const sourcePath = fs.readlinkSync(linkPath);
    expect(sourcePath).toBe(cloudTarget); // direct symlink → raw target is absolute

    // Local-root derivation (live-link readlink walker).
    const liveLinkKey = mintFirstCloudHopTargetSync(linkPath);
    // Cloud-root derivation (zero-I/O, from cached sourcePath string).
    const sourcePathKey = mintCloudHopTargetFromKnownCloudPath(sourcePath);

    expect(liveLinkKey).not.toBeNull();
    expect(sourcePathKey).not.toBeNull();
    expect(sourcePathKey).toBe(liveLinkKey); // byte-identical cache key
    expect(sourcePathKey).toBe(cloudTarget);
  });

  it('Stage 2 DANGEROUS-DIRECTION SAFETY: a STALE/wrong cached sourcePath does NOT cause a false-healthy admission for the live link', () => {
    // The hazard the zero-I/O fast path must NOT introduce: if `space.sourcePath`
    // has gone stale (points at cloud target A) while the live link on disk now
    // resolves to a DIFFERENT cloud target B, the prewarm derives a verdict keyed on
    // A. Admission for the LIVE link mints its key readlink-only from the link itself
    // (→ B). The two keys MUST differ, so a `healthy` verdict seeded under A is NEVER
    // read back for B — i.e. a stale sourcePath can only ever FAIL CLOSED (skip), it
    // can never wrongly admit a target it doesn't actually point at.
    const cloudTargetA = path.join(
      scratch,
      'Library',
      'CloudStorage',
      'GoogleDrive-x@example.com',
      'Shared drives',
      'OldDrive',
    );
    const cloudTargetB = path.join(
      scratch,
      'Library',
      'CloudStorage',
      'GoogleDrive-x@example.com',
      'Shared drives',
      'NewDrive',
    );
    expect(cloudTargetA).not.toBe(cloudTargetB);

    // The LIVE link on disk now resolves to B (the truth).
    const linkPath = path.join(workspaceRoot, 'Drive');
    fs.symlinkSync(cloudTargetB, linkPath);

    // The space config's cached sourcePath is STALE — still pointing at A.
    const spaces = [space({ path: 'Drive', isSymlink: true, sourcePath: cloudTargetA })];

    // Under a cloud-classified root the prewarm derives the target from the (stale)
    // sourcePath = A.
    const cloudCoreDirectory = path.join(
      os.homedir(),
      'Library',
      'CloudStorage',
      'GoogleDrive-dead@example.com',
      'workspace',
    );
    const prewarmTargets = deriveCloudPrewarmTargets(cloudCoreDirectory, spaces);
    expect(prewarmTargets).toEqual([cloudTargetA]); // verdict would be seeded under A

    // KEY INEQUALITY (the load-bearing invariant): the live-link admission key (B)
    // ≠ the stale-sourcePath prewarm key (A), so a `healthy` cached under A is unread
    // for B.
    const liveLinkKey = mintFirstCloudHopTargetSync(linkPath); // resolves to B
    const stalePrewarmKey = mintCloudHopTargetFromKnownCloudPath(cloudTargetA); // A
    expect(liveLinkKey).toBe(cloudTargetB);
    expect(stalePrewarmKey).toBe(cloudTargetA);
    expect(liveLinkKey).not.toBe(stalePrewarmKey);

    // Concrete admission demonstration with a verdict cache seeded ONLY under A:
    // looking up the LIVE link's key (B) misses → `unknown` → admission would SKIP,
    // never a false-healthy. (A plain Map stands in for the prober's verdict cache —
    // no fs mocking / global singleton, keeping this deterministic and FS-free.)
    const verdictCache = new Map<string, 'healthy' | 'degraded' | 'unknown'>();
    verdictCache.set(cloudTargetA, 'healthy'); // seeded under the STALE key
    const verdictForLiveLink = verdictCache.get(liveLinkKey as string) ?? 'unknown';
    expect(verdictForLiveLink).toBe('unknown'); // miss → fail closed → skip
  });
});

describe('mintCloudHopTargetCloudRootSafe (the shared cloud-root-safe key source)', () => {
  it('cloud root: derives from cached absolute-cloud sourcePath with ZERO filesystem I/O', () => {
    const sourcePath = path.join(
      os.homedir(),
      'Library',
      'CloudStorage',
      'GoogleDrive-x@example.com',
      'Shared drives',
      'General',
    );
    const readlinkSpy = vi.spyOn(fs, 'readlinkSync');
    const key = mintCloudHopTargetCloudRootSafe({
      linkPath: path.join('/dead-mount/workspace', 'General'),
      sourcePath,
      rootIsCloud: true,
    });
    expect(key).toBe(sourcePath);
    expect(readlinkSpy).not.toHaveBeenCalled(); // never touched the (dead) link inode
  });

  it('cloud root: missing / relative / non-cloud sourcePath → null (no readlink fallback)', () => {
    const readlinkSpy = vi.spyOn(fs, 'readlinkSync');
    const linkPath = path.join('/dead-mount/workspace', 'X');
    expect(
      mintCloudHopTargetCloudRootSafe({ linkPath, sourcePath: undefined, rootIsCloud: true }),
    ).toBeNull();
    expect(
      mintCloudHopTargetCloudRootSafe({ linkPath, sourcePath: '../rel/General', rootIsCloud: true }),
    ).toBeNull();
    expect(
      mintCloudHopTargetCloudRootSafe({
        linkPath,
        sourcePath: path.join(os.homedir(), 'Documents', 'NotCloud'),
        rootIsCloud: true,
      }),
    ).toBeNull();
    expect(readlinkSpy).not.toHaveBeenCalled();
  });

  it('local root: uses the live-link readlink walker (full fidelity)', () => {
    const cloudTarget = path.join(
      scratch,
      'Library',
      'CloudStorage',
      'GoogleDrive-x@example.com',
      'Shared drives',
      'General',
    );
    const linkPath = path.join(workspaceRoot, 'General');
    fs.symlinkSync(cloudTarget, linkPath);
    const key = mintCloudHopTargetCloudRootSafe({
      linkPath,
      sourcePath: undefined, // ignored on the local path
      rootIsCloud: false,
    });
    expect(key).toBe(cloudTarget);
  });

  it('KEY-EQUIVALENCE: cloud-root (sourcePath) and local-root (live link) mint the SAME key for a direct cloud symlink', () => {
    const cloudTarget = path.join(
      scratch,
      'Library',
      'CloudStorage',
      'GoogleDrive-x@example.com',
      'Shared drives',
      'General',
    );
    const linkPath = path.join(workspaceRoot, 'General');
    fs.symlinkSync(cloudTarget, linkPath);
    const sourcePath = fs.readlinkSync(linkPath); // what scanSpaces persists

    const cloudRootKey = mintCloudHopTargetCloudRootSafe({ linkPath, sourcePath, rootIsCloud: true });
    const localRootKey = mintCloudHopTargetCloudRootSafe({ linkPath, sourcePath, rootIsCloud: false });
    expect(cloudRootKey).toBe(cloudTarget);
    expect(localRootKey).toBe(cloudTarget);
    expect(cloudRootKey).toBe(localRootKey);
  });
});

describe('computeCloudIndexingCoverage (discovered-vs-admitted observability)', () => {
  const cloudSource = (name: string) =>
    path.join(
      os.homedir(),
      'Library',
      'CloudStorage',
      'GoogleDrive-x@example.com',
      'Shared drives',
      name,
    );

  /** Build a verdict reader from a {target → verdict} map (default unknown). */
  const verdictReader =
    (map: Record<string, CloudHealthVerdict>) =>
    (target: ReadlinkResolvedTarget): CloudHealthVerdict =>
      map[target as string] ?? 'unknown';

  it('ALERTS when cloud spaces are configured but NONE are healthy (the original silent failure)', () => {
    const cloudCoreDirectory = path.join(os.homedir(), 'Library', 'CloudStorage', 'Dropbox-Team', 'workspace');
    const general = cloudSource('General');
    const exec = cloudSource('Exec');
    const spaces = [
      space({ path: 'General', isSymlink: true, sourcePath: general }),
      space({ path: 'Exec', isSymlink: true, sourcePath: exec }),
    ];
    const snap = computeCloudIndexingCoverage(cloudCoreDirectory, spaces, verdictReader({}));
    expect(snap.cloudSpacesConfigured).toBe(2);
    expect(snap.probeTargetsDerived).toBe(2);
    expect(snap.healthyTargets).toBe(0);
    expect(snap.shouldAlert).toBe(true);
  });

  it('does NOT alert when at least one derived target is healthy', () => {
    const cloudCoreDirectory = path.join(os.homedir(), 'Library', 'CloudStorage', 'Dropbox-Team', 'workspace');
    const general = cloudSource('General');
    const exec = cloudSource('Exec');
    const spaces = [
      space({ path: 'General', isSymlink: true, sourcePath: general }),
      space({ path: 'Exec', isSymlink: true, sourcePath: exec }),
    ];
    const snap = computeCloudIndexingCoverage(
      cloudCoreDirectory,
      spaces,
      verdictReader({ [general]: 'healthy' }),
    );
    expect(snap.healthyTargets).toBe(1);
    expect(snap.shouldAlert).toBe(false);
  });

  it('does NOT alert when there are no cloud spaces at all', () => {
    fs.mkdirSync(path.join(workspaceRoot, 'LocalOnly'));
    const spaces = [space({ path: 'LocalOnly', isSymlink: false })];
    const snap = computeCloudIndexingCoverage(workspaceRoot, spaces, verdictReader({}));
    expect(snap.cloudSpacesConfigured).toBe(0);
    expect(snap.probeTargetsDerived).toBe(0);
    expect(snap.shouldAlert).toBe(false);
  });

  it('ALERTS on the M-arm: a derivable target exists but is unhealthy, even when N==0 (chained local-alias whose sourcePath is local)', () => {
    // link → localAlias → cloud: under a LOCAL root the readlink walker FOLLOWS the
    // alias and derives the cloud target (M=1), but `sourcePath` is the LOCAL alias so
    // it is NOT counted as a configured cloud space (N=0). With K==0 this is still the
    // discovered-but-not-indexable gap → the `M>0` arm of `shouldAlert` must fire.
    const cloudTarget = path.join(
      scratch,
      'Library',
      'CloudStorage',
      'GoogleDrive-x@example.com',
      'Shared drives',
      'Exec',
    );
    const localAlias = path.join(scratch, 'DriveAlias'); // a LOCAL path
    fs.symlinkSync(cloudTarget, localAlias);
    fs.symlinkSync(localAlias, path.join(workspaceRoot, 'Exec'));

    const spaces = [space({ path: 'Exec', isSymlink: true, sourcePath: localAlias })];
    const snap = computeCloudIndexingCoverage(workspaceRoot, spaces, verdictReader({}));
    expect(snap.cloudSpacesConfigured).toBe(0); // sourcePath is local → not counted as N
    expect(snap.probeTargetsDerived).toBe(1); // walker followed the alias → M=1
    expect(snap.healthyTargets).toBe(0);
    expect(snap.shouldAlert).toBe(true); // (N>0 || M>0) && K===0
  });

  it('no false positive: empty / undefined spaces under a cloud root never alert', () => {
    const cloudCoreDirectory = path.join(os.homedir(), 'Library', 'CloudStorage', 'Dropbox-Team', 'workspace');
    for (const s of [undefined, []] as const) {
      const snap = computeCloudIndexingCoverage(cloudCoreDirectory, s, verdictReader({}));
      expect(snap.cloudSpacesConfigured).toBe(0);
      expect(snap.probeTargetsDerived).toBe(0);
      expect(snap.shouldAlert).toBe(false);
    }
  });

  it('local root: derives via live link and reports healthy coverage (no alert)', () => {
    const cloudTarget = path.join(
      scratch,
      'Library',
      'CloudStorage',
      'GoogleDrive-x@example.com',
      'Shared drives',
      'General',
    );
    const linkPath = path.join(workspaceRoot, 'General');
    fs.symlinkSync(cloudTarget, linkPath);
    const spaces = [space({ path: 'General', isSymlink: true, sourcePath: cloudTarget })];
    const snap = computeCloudIndexingCoverage(
      workspaceRoot,
      spaces,
      verdictReader({ [cloudTarget]: 'healthy' }),
    );
    expect(snap.cloudSpacesConfigured).toBe(1);
    expect(snap.probeTargetsDerived).toBe(1);
    expect(snap.healthyTargets).toBe(1);
    expect(snap.shouldAlert).toBe(false);
  });
});
