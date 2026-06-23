/**
 * cloudSpaceContainment — the cached, readlink-only "is this path under a cloud
 * space, and is it healthy" map (Stage 4b R6, 260619_cloud-symlink-indexing).
 *
 * What these lock:
 *  - correct space classification (a path under a cloud space → its verdict; a
 *    sibling whose name merely shares the prefix → `'local'`);
 *  - a CHAINED symlink (link → localAlias → CloudStorage/…) is classified cloud
 *    via the shared first-cloud-hop walker (F1 topology);
 *  - the build is FS-FREE for candidate enumeration — ZERO readdir/realpath/stat
 *    on the (possibly-dead) cloud root, even when coreDirectory is cloud-classified;
 *  - the query path is pure string work (no fs touch on classify);
 *  - verdict comes from the synchronous cached probe (`unknown`/`degraded`/
 *    `healthy`), defaulting to `unknown` (fail-closed);
 *  - invalidation: reconfiguring with new spaces changes the classification.
 *
 * Uses real temp dirs + symlinks (no real Drive). A stub probe supplies verdicts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpaceConfig } from '@shared/types/settings';
import {
  type CloudHealthVerdict,
  type CloudLivenessProbe,
  __resetCloudLivenessProbeForTesting,
  setCloudLivenessProbe,
} from '@core/services/cloudLivenessProbe';
import {
  __resetCloudSpaceContainmentForTests,
  classifyPathForRemoval,
  configureCloudSpaceContainment,
  isUnderCloudSpace,
} from '@core/services/cloudSpaceContainment';

let scratch: string;
let workspaceRoot: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-containment-'));
  workspaceRoot = path.join(scratch, 'workspace');
  fs.mkdirSync(workspaceRoot, { recursive: true });
});

afterEach(() => {
  __resetCloudSpaceContainmentForTests();
  __resetCloudLivenessProbeForTesting();
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

/**
 * Install a stub probe whose cached verdict is looked up per-target. Targets are
 * the cloud-mount paths the symlinks point at (the verdict-cache keys).
 */
function installStubProbe(verdicts: Record<string, CloudHealthVerdict>): void {
  const probe: CloudLivenessProbe = {
    probeHealth: async (t) => verdicts[t] ?? 'unknown',
    getCachedVerdict: (t) => verdicts[t] ?? 'unknown',
  };
  setCloudLivenessProbe(probe);
}

describe('cloudSpaceContainment — classification', () => {
  it('classifies an entry under a cloud space with the space verdict', () => {
    const cloudTarget = path.join(
      scratch,
      'Library',
      'CloudStorage',
      'GoogleDrive-test@example.com',
      'Shared drives',
      'General',
    );
    const linkPath = path.join(workspaceRoot, 'General');
    fs.symlinkSync(cloudTarget, linkPath);
    installStubProbe({ [cloudTarget]: 'healthy' });

    configureCloudSpaceContainment(workspaceRoot, [space({ path: 'General', isSymlink: true })]);

    const entry = path.join(linkPath, 'meeting.md');
    const result = classifyPathForRemoval(entry);
    expect(result).not.toBe('local');
    if (result !== 'local') {
      expect(result.verdict).toBe('healthy');
    }
    expect(isUnderCloudSpace(entry)).toBe(true);
  });

  it('returns `local` for a path NOT under any cloud space', () => {
    const cloudTarget = path.join(scratch, 'Library', 'CloudStorage', '[external-email]', 'General');
    fs.symlinkSync(cloudTarget, path.join(workspaceRoot, 'General'));
    installStubProbe({ [cloudTarget]: 'degraded' });
    configureCloudSpaceContainment(workspaceRoot, [space({ path: 'General', isSymlink: true })]);

    const localEntry = path.join(workspaceRoot, 'LocalFolder', 'notes.md');
    expect(classifyPathForRemoval(localEntry)).toBe('local');
    expect(isUnderCloudSpace(localEntry)).toBe(false);
  });

  it('does NOT match a sibling whose name shares the prefix (trailing-slash boundary)', () => {
    const cloudTarget = path.join(scratch, 'Library', 'CloudStorage', '[external-email]', 'General');
    fs.symlinkSync(cloudTarget, path.join(workspaceRoot, 'General'));
    installStubProbe({ [cloudTarget]: 'degraded' });
    configureCloudSpaceContainment(workspaceRoot, [space({ path: 'General', isSymlink: true })]);

    // `General-archive` shares the `General` prefix but is a DIFFERENT space.
    const sibling = path.join(workspaceRoot, 'General-archive', 'old.md');
    expect(classifyPathForRemoval(sibling)).toBe('local');
  });

  it('reports the cached verdict (degraded / unknown / healthy)', () => {
    const general = path.join(scratch, 'Library', 'CloudStorage', '[external-email]', 'General');
    const exec = path.join(scratch, 'Library', 'CloudStorage', '[external-email]', 'Exec');
    fs.symlinkSync(general, path.join(workspaceRoot, 'General'));
    fs.symlinkSync(exec, path.join(workspaceRoot, 'Exec'));
    // `general` healthy, `exec` not in the map → unknown.
    installStubProbe({ [general]: 'healthy' });
    configureCloudSpaceContainment(workspaceRoot, [
      space({ path: 'General', isSymlink: true }),
      space({ path: 'Exec', isSymlink: true }),
    ]);

    const generalResult = classifyPathForRemoval(path.join(workspaceRoot, 'General', 'a.md'));
    const execResult = classifyPathForRemoval(path.join(workspaceRoot, 'Exec', 'b.md'));
    expect(generalResult !== 'local' && generalResult.verdict).toBe('healthy');
    expect(execResult !== 'local' && execResult.verdict).toBe('unknown');
  });

  it('classifies a CHAINED symlink (link → localAlias → CloudStorage/…) as cloud (F1)', () => {
    const cloudTarget = path.join(
      scratch,
      'Library',
      'CloudStorage',
      'GoogleDrive-x@example.com',
      'Shared drives',
      'Exec',
    );
    const localAlias = path.join(scratch, 'DriveAlias');
    fs.symlinkSync(cloudTarget, localAlias); // alias → cloud
    const linkPath = path.join(workspaceRoot, 'Exec');
    fs.symlinkSync(localAlias, linkPath); // link → alias
    installStubProbe({ [cloudTarget]: 'degraded' });

    configureCloudSpaceContainment(workspaceRoot, [space({ path: 'Exec', isSymlink: true })]);

    const result = classifyPathForRemoval(path.join(linkPath, 'doc.md'));
    expect(result !== 'local' && result.verdict).toBe('degraded');
  });

  it('does NOT classify a non-cloud symlink space as cloud (rebel-system → /Applications/…)', () => {
    const nonCloudTarget = path.join(scratch, 'Applications', 'RebelSystem');
    fs.mkdirSync(nonCloudTarget, { recursive: true });
    fs.symlinkSync(nonCloudTarget, path.join(workspaceRoot, 'rebel-system'));
    installStubProbe({});
    configureCloudSpaceContainment(workspaceRoot, [space({ path: 'rebel-system', isSymlink: true })]);

    expect(classifyPathForRemoval(path.join(workspaceRoot, 'rebel-system', 'skill.md'))).toBe('local');
  });
});

describe('cloudSpaceContainment — resolved-cloud-realpath form (the dominant stored form)', () => {
  // These reproduce the Stage-4b silent no-op: `fileIndexService.indexFileInternal`
  // stores entries under `fs.realpath(filePath)` — the RESOLVED cloud target
  // (`~/Library/CloudStorage/…`), NOT the workspace symlink path. The original map
  // matched only the workspace-symlink prefix, so those canonical-form entries fell
  // through as `'local'` and R1/R2 never fired for them. The fix matches BOTH forms.
  it('classifies a CANONICAL-realpath entry (fs.realpath form) as cloud with the space verdict', () => {
    const cloudTarget = path.join(
      scratch,
      'Library',
      'CloudStorage',
      'GoogleDrive-test@example.com',
      'Shared drives',
      'General',
    );
    const linkPath = path.join(workspaceRoot, 'General');
    fs.symlinkSync(cloudTarget, linkPath);
    installStubProbe({ [cloudTarget]: 'degraded' });

    configureCloudSpaceContainment(workspaceRoot, [space({ path: 'General', isSymlink: true })]);

    // The entry as STORED by indexFileInternal: under the resolved cloud target,
    // NOT under the workspace symlink path.
    const canonicalEntry = path.join(cloudTarget, 'meeting.md');
    // Sanity: this is NOT the workspace-symlink form.
    expect(canonicalEntry.startsWith(linkPath)).toBe(false);

    const result = classifyPathForRemoval(canonicalEntry);
    expect(result).not.toBe('local');
    if (result !== 'local') {
      expect(result.verdict).toBe('degraded');
    }
    expect(isUnderCloudSpace(canonicalEntry)).toBe(true);
  });

  it('BOTH forms map to the SAME space → SAME verdict (verdict-key alignment)', () => {
    const cloudTarget = path.join(
      scratch,
      'Library',
      'CloudStorage',
      'GoogleDrive-test@example.com',
      'Shared drives',
      'Exec',
    );
    const linkPath = path.join(workspaceRoot, 'Exec');
    fs.symlinkSync(cloudTarget, linkPath);
    installStubProbe({ [cloudTarget]: 'healthy' });

    configureCloudSpaceContainment(workspaceRoot, [space({ path: 'Exec', isSymlink: true })]);

    const symlinkFormResult = classifyPathForRemoval(path.join(linkPath, 'doc.md'));
    const canonicalFormResult = classifyPathForRemoval(path.join(cloudTarget, 'doc.md'));
    expect(symlinkFormResult !== 'local' && symlinkFormResult.verdict).toBe('healthy');
    expect(canonicalFormResult !== 'local' && canonicalFormResult.verdict).toBe('healthy');
  });

  it('matches a CANONICAL entry via the settings sourcePath even with a chained alias', () => {
    // Chained: link → localAlias → CloudStorage/…. `fs.realpath` would resolve all
    // the way to the cloud target; `sourcePath` (the configured resolved folder)
    // also pins it. Either canonical prefix must match the realpath-form entry.
    const cloudTarget = path.join(
      scratch,
      'Library',
      'CloudStorage',
      'GoogleDrive-x@example.com',
      'Shared drives',
      'Exec',
    );
    const localAlias = path.join(scratch, 'DriveAlias');
    fs.symlinkSync(cloudTarget, localAlias); // alias → cloud
    const linkPath = path.join(workspaceRoot, 'Exec');
    fs.symlinkSync(localAlias, linkPath); // link → alias
    installStubProbe({ [cloudTarget]: 'degraded' });

    configureCloudSpaceContainment(workspaceRoot, [
      space({ path: 'Exec', isSymlink: true, sourcePath: cloudTarget }),
    ]);

    const canonicalEntry = path.join(cloudTarget, 'doc.md');
    const result = classifyPathForRemoval(canonicalEntry);
    expect(result !== 'local' && result.verdict).toBe('degraded');
    expect(isUnderCloudSpace(canonicalEntry)).toBe(true);
  });

  it('does NOT match a canonical-form sibling whose name shares the cloud-target prefix', () => {
    const cloudTarget = path.join(
      scratch,
      'Library',
      'CloudStorage',
      '[external-email]',
      'General',
    );
    fs.symlinkSync(cloudTarget, path.join(workspaceRoot, 'General'));
    installStubProbe({ [cloudTarget]: 'degraded' });
    configureCloudSpaceContainment(workspaceRoot, [space({ path: 'General', isSymlink: true })]);

    // `General-archive` shares the `General` prefix under the SAME CloudStorage root
    // but is a different folder → must NOT match (trailing-slash boundary).
    const sibling = path.join(
      scratch,
      'Library',
      'CloudStorage',
      '[external-email]',
      'General-archive',
      'old.md',
    );
    expect(classifyPathForRemoval(sibling)).toBe('local');
    expect(isUnderCloudSpace(sibling)).toBe(false);
  });

  it('canonical-form classify does no filesystem I/O (pure cached string match)', () => {
    const cloudTarget = path.join(scratch, 'Library', 'CloudStorage', '[external-email]', 'General');
    fs.symlinkSync(cloudTarget, path.join(workspaceRoot, 'General'));
    installStubProbe({ [cloudTarget]: 'healthy' });
    configureCloudSpaceContainment(workspaceRoot, [space({ path: 'General', isSymlink: true })]);

    const readdirSpy = vi.spyOn(fs, 'readdirSync');
    const realpathSpy = vi.spyOn(fs, 'realpathSync');
    const statSpy = vi.spyOn(fs, 'statSync');
    const lstatSpy = vi.spyOn(fs, 'lstatSync');
    const readlinkSpy = vi.spyOn(fs, 'readlinkSync');

    const canonicalEntry = path.join(cloudTarget, 'doc.md');
    classifyPathForRemoval(canonicalEntry);
    isUnderCloudSpace(canonicalEntry);

    expect(readdirSpy).not.toHaveBeenCalled();
    expect(realpathSpy).not.toHaveBeenCalled();
    expect(statSpy).not.toHaveBeenCalled();
    expect(lstatSpy).not.toHaveBeenCalled();
    expect(readlinkSpy).not.toHaveBeenCalled();
  });
});

describe('cloudSpaceContainment — FS-free build + pure query', () => {
  it('build does ZERO readdir/realpath/stat on the cloud root, even when coreDirectory is cloud-classified', () => {
    const cloudCoreDirectory = path.join(
      os.homedir(),
      'Library',
      'CloudStorage',
      'Dropbox-Team',
      'workspace',
    );
    const readdirSpy = vi.spyOn(fs, 'readdirSync');
    const realpathSpy = vi.spyOn(fs, 'realpathSync');
    const statSpy = vi.spyOn(fs, 'statSync');
    const lstatSpy = vi.spyOn(fs, 'lstatSync');

    const spaces = [
      space({ path: 'General', isSymlink: true }),
      space({ path: 'LocalDoc', isSymlink: false }),
    ];
    expect(() =>
      configureCloudSpaceContainment(cloudCoreDirectory, spaces),
    ).not.toThrow();

    expect(readdirSpy).not.toHaveBeenCalled();
    expect(realpathSpy).not.toHaveBeenCalled();
    expect(statSpy).not.toHaveBeenCalled();
    expect(lstatSpy).not.toHaveBeenCalled();
  });

  it('classify does no filesystem I/O (pure cached string match)', () => {
    const cloudTarget = path.join(scratch, 'Library', 'CloudStorage', '[external-email]', 'General');
    fs.symlinkSync(cloudTarget, path.join(workspaceRoot, 'General'));
    installStubProbe({ [cloudTarget]: 'healthy' });
    configureCloudSpaceContainment(workspaceRoot, [space({ path: 'General', isSymlink: true })]);

    const readdirSpy = vi.spyOn(fs, 'readdirSync');
    const realpathSpy = vi.spyOn(fs, 'realpathSync');
    const statSpy = vi.spyOn(fs, 'statSync');
    const lstatSpy = vi.spyOn(fs, 'lstatSync');
    const readlinkSpy = vi.spyOn(fs, 'readlinkSync');

    classifyPathForRemoval(path.join(workspaceRoot, 'General', 'doc.md'));
    isUnderCloudSpace(path.join(workspaceRoot, 'General', 'doc.md'));

    expect(readdirSpy).not.toHaveBeenCalled();
    expect(realpathSpy).not.toHaveBeenCalled();
    expect(statSpy).not.toHaveBeenCalled();
    expect(lstatSpy).not.toHaveBeenCalled();
    expect(readlinkSpy).not.toHaveBeenCalled();
  });
});

describe('cloudSpaceContainment — cloud-root-safe build (readlink hardening)', () => {
  it('under a cloud-classified root, build does ZERO readlinkSync on the link inode (derives the verdict key from cached sourcePath)', () => {
    // The hardening: when the workspace root is itself a (possibly-dead) cloud FUSE
    // mount, a readlinkSync on a symlinked space's link inode (which lives IN that
    // root) could block the main thread. So under a cloud root we derive the verdict
    // key zero-I/O from the cached `sourcePath` and NEVER readlink the link inode.
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
    installStubProbe({ [generalSource]: 'healthy' });

    const readlinkSpy = vi.spyOn(fs, 'readlinkSync');
    configureCloudSpaceContainment(cloudCoreDirectory, [
      space({ path: 'General', isSymlink: true, sourcePath: generalSource }),
      space({ path: 'NoSource', isSymlink: true }), // no usable sourcePath → skipped, no readlink
    ]);
    expect(readlinkSpy).not.toHaveBeenCalled();

    // The map was still built from the cached sourcePath: an entry under the resolved
    // cloud realpath classifies to the space's healthy verdict.
    const entry = path.join(generalSource, 'doc.md');
    const classification = classifyPathForRemoval(entry);
    expect(classification).not.toBe('local');
    if (classification !== 'local') expect(classification.verdict).toBe('healthy');
  });

  it('under a cloud root, a space whose sourcePath is missing / relative / non-cloud is skipped (classifies local), no readlink', () => {
    const cloudCoreDirectory = path.join(
      os.homedir(),
      'Library',
      'CloudStorage',
      'GoogleDrive-dead@example.com',
      'workspace',
    );
    const readlinkSpy = vi.spyOn(fs, 'readlinkSync');
    configureCloudSpaceContainment(cloudCoreDirectory, [
      space({ path: 'NoSource', isSymlink: true }),
      space({ path: 'Rel', isSymlink: true, sourcePath: '../somewhere/General' }),
      space({
        path: 'LocalLink',
        isSymlink: true,
        sourcePath: path.join(os.homedir(), 'Documents', 'NotCloud'),
      }),
    ]);
    expect(readlinkSpy).not.toHaveBeenCalled();
    // None became a cloud space → an entry under the cloud root classifies local.
    expect(classifyPathForRemoval(path.join(cloudCoreDirectory, 'NoSource', 'doc.md'))).toBe('local');
  });
});

describe('cloudSpaceContainment — invalidation', () => {
  it('reconfiguring rebuilds the map (space removed → path becomes local)', () => {
    const cloudTarget = path.join(scratch, 'Library', 'CloudStorage', '[external-email]', 'General');
    fs.symlinkSync(cloudTarget, path.join(workspaceRoot, 'General'));
    installStubProbe({ [cloudTarget]: 'healthy' });

    const entry = path.join(workspaceRoot, 'General', 'doc.md');
    configureCloudSpaceContainment(workspaceRoot, [space({ path: 'General', isSymlink: true })]);
    expect(isUnderCloudSpace(entry)).toBe(true);

    // Spaces config now has NO symlinked spaces → map clears → entry is local.
    configureCloudSpaceContainment(workspaceRoot, []);
    expect(isUnderCloudSpace(entry)).toBe(false);
    expect(classifyPathForRemoval(entry)).toBe('local');
  });

  it('empty map (unconfigured / no spaces) classifies everything local', () => {
    expect(classifyPathForRemoval('/anywhere/at/all.md')).toBe('local');
    expect(isUnderCloudSpace('/anywhere/at/all.md')).toBe(false);
    configureCloudSpaceContainment(null, undefined);
    expect(classifyPathForRemoval('/anywhere/at/all.md')).toBe('local');
  });
});
