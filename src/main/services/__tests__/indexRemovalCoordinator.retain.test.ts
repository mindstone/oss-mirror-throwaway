/**
 * indexRemovalCoordinator — R1 retain-when-degraded gate (Stage 4b,
 * 260619_cloud-symlink-indexing).
 *
 * What these lock:
 *  - a `degraded`/`unknown` cloud space's entries are RETAINED on an `absence` /
 *    `watcher-unlink` removal (NOT purged);
 *  - a `healthy` cloud space's removal STILL proceeds (4b behaviour: healthy ⇒
 *    allow as today — the stricter NonNullRealPath proof is 4c);
 *  - `replacement` and `hygiene` are NEVER gated (re-index + bookkeeping cleanup
 *    proceed even when the space is degraded);
 *  - a LOCAL entry's removal is unchanged regardless of verdict;
 *  - the batch remover gates PER-PATH (a batch spanning healthy + degraded spaces
 *    removes only the safe ones).
 *
 * Uses the REAL containment map (cloudSpaceContainment) built from real temp
 * symlinks + a stub liveness probe supplying verdicts — so the end-to-end
 * containment → verdict → gate path is exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpaceConfig } from '@shared/types/settings';
import {
  configureIndexRemovalCoordinator,
  __resetIndexRemovalCoordinatorForTests,
  removeMetadataStoresEntry,
  removeVectorIndexEntry,
  removeVectorIndexEntries,
  type CoordinatorRemovalReason,
  type IndexRemovalRemovers,
} from '../indexRemovalCoordinator';
import {
  type CloudHealthVerdict,
  type CloudLivenessProbe,
  __resetCloudLivenessProbeForTesting,
  setCloudLivenessProbe,
} from '@core/services/cloudLivenessProbe';
import {
  __resetCloudSpaceContainmentForTests,
  __resetCloudUnlinkStormsForTests,
  configureCloudSpaceContainment,
} from '@core/services/cloudSpaceContainment';

const ABSENCE: CoordinatorRemovalReason = { kind: 'absence-unverified' };
const WATCHER_UNLINK: CoordinatorRemovalReason = { kind: 'watcher-unlink' };
const HYGIENE: CoordinatorRemovalReason = { kind: 'hygiene' };
const REPLACEMENT: CoordinatorRemovalReason = { kind: 'replacement' };

let scratch: string;
let workspaceRoot: string;
let spies: {
  removeSource: ReturnType<typeof vi.fn>;
  isSourcePath: ReturnType<typeof vi.fn>;
  removeEntity: ReturnType<typeof vi.fn>;
  removeFileFromIndex: ReturnType<typeof vi.fn>;
  removeFilesFromIndex: ReturnType<typeof vi.fn>;
};

function makeMockRemovers(): IndexRemovalRemovers {
  spies = {
    removeSource: vi.fn(),
    isSourcePath: vi.fn(() => true),
    removeEntity: vi.fn(),
    removeFileFromIndex: vi.fn(async () => {}),
    removeFilesFromIndex: vi.fn(async (paths: string[]) => paths.length),
  };
  return {
    removeSource: spies.removeSource as unknown as IndexRemovalRemovers['removeSource'],
    isSourcePath: spies.isSourcePath as unknown as IndexRemovalRemovers['isSourcePath'],
    removeEntity: spies.removeEntity as unknown as IndexRemovalRemovers['removeEntity'],
    removeFileFromIndex: spies.removeFileFromIndex as unknown as IndexRemovalRemovers['removeFileFromIndex'],
    removeFilesFromIndex: spies.removeFilesFromIndex as unknown as IndexRemovalRemovers['removeFilesFromIndex'],
  };
}

function space(p: string): SpaceConfig {
  return { name: p, path: p, type: 'other', isSymlink: true, createdAt: 0 };
}

function installStubProbe(verdicts: Record<string, CloudHealthVerdict>): void {
  const probe: CloudLivenessProbe = {
    probeHealth: async (t) => verdicts[t] ?? 'unknown',
    getCachedVerdict: (t) => verdicts[t] ?? 'unknown',
  };
  setCloudLivenessProbe(probe);
}

// Create a cloud-symlinked space `name` and return its in-workspace link path +
// the cloud target it points at (the verdict-cache key).
function makeCloudSpace(name: string): { linkPath: string; cloudTarget: string } {
  const cloudTarget = path.join(
    scratch,
    'Library',
    'CloudStorage',
    'GoogleDrive-test@example.com',
    'Shared drives',
    name,
  );
  const linkPath = path.join(workspaceRoot, name);
  fs.symlinkSync(cloudTarget, linkPath);
  return { linkPath, cloudTarget };
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-retain-'));
  workspaceRoot = path.join(scratch, 'workspace');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  configureIndexRemovalCoordinator(makeMockRemovers());
});

afterEach(() => {
  __resetIndexRemovalCoordinatorForTests();
  __resetCloudSpaceContainmentForTests();
  __resetCloudUnlinkStormsForTests();
  __resetCloudLivenessProbeForTesting();
  fs.rmSync(scratch, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('indexRemovalCoordinator — R1 retain-when-degraded', () => {
  it.each(['degraded', 'unknown'] as const)(
    'RETAINS a cloud entry on `absence` when verdict is %s (no metadata/vector removal)',
    async (verdict) => {
      const { linkPath, cloudTarget } = makeCloudSpace('General');
      installStubProbe(verdict === 'unknown' ? {} : { [cloudTarget]: 'degraded' });
      configureCloudSpaceContainment(workspaceRoot, [space('General')]);

      const entry = path.join(linkPath, 'doc.md');
      removeMetadataStoresEntry(entry, ABSENCE, { workspacePath: workspaceRoot });
      await removeVectorIndexEntry(entry, ABSENCE);
      const removedCount = await removeVectorIndexEntries([entry], ABSENCE);

      expect(spies.removeSource).not.toHaveBeenCalled();
      expect(spies.removeEntity).not.toHaveBeenCalled();
      expect(spies.removeFileFromIndex).not.toHaveBeenCalled();
      expect(spies.removeFilesFromIndex).not.toHaveBeenCalled();
      expect(removedCount).toBe(0);
    },
  );

  it('RETAINS a cloud entry on `watcher-unlink` when degraded', async () => {
    const { linkPath, cloudTarget } = makeCloudSpace('General');
    installStubProbe({ [cloudTarget]: 'degraded' });
    configureCloudSpaceContainment(workspaceRoot, [space('General')]);

    const entry = path.join(linkPath, 'doc.md');
    removeMetadataStoresEntry(entry, WATCHER_UNLINK, { workspacePath: workspaceRoot });
    await removeVectorIndexEntry(entry, WATCHER_UNLINK);

    expect(spies.removeEntity).not.toHaveBeenCalled();
    expect(spies.removeFileFromIndex).not.toHaveBeenCalled();
  });

  it('RETAINS an `absence-unverified` cloud entry EVEN WHEN HEALTHY (4c: no proof → never purge cloud)', async () => {
    // Stage 4c hardens 4b: a cloud `absence` WITHOUT proof can never purge, even on
    // a healthy verdict. A bare fs-absence is not an authoritative absence claim for
    // a cloud space; only an `absence-authorized` (proof-bearing) removal purges.
    const { linkPath, cloudTarget } = makeCloudSpace('General');
    installStubProbe({ [cloudTarget]: 'healthy' });
    configureCloudSpaceContainment(workspaceRoot, [space('General')]);

    const entry = path.join(linkPath, 'doc.md');
    removeMetadataStoresEntry(entry, ABSENCE, { workspacePath: workspaceRoot });
    await removeVectorIndexEntry(entry, ABSENCE);
    const removed = await removeVectorIndexEntries([entry], ABSENCE);

    expect(spies.removeEntity).not.toHaveBeenCalled();
    expect(spies.removeFileFromIndex).not.toHaveBeenCalled();
    expect(removed).toBe(0);
  });

  it('NEVER gates `replacement` (re-index proceeds even when degraded)', async () => {
    const { linkPath, cloudTarget } = makeCloudSpace('General');
    installStubProbe({ [cloudTarget]: 'degraded' });
    configureCloudSpaceContainment(workspaceRoot, [space('General')]);

    const entry = path.join(linkPath, 'doc.md');
    removeMetadataStoresEntry(entry, REPLACEMENT, { workspacePath: workspaceRoot });
    await removeVectorIndexEntry(entry, REPLACEMENT);

    expect(spies.removeEntity).toHaveBeenCalledWith(entry);
    expect(spies.removeFileFromIndex).toHaveBeenCalledWith(entry, expect.anything());
  });

  it('NEVER gates `hygiene` (bookkeeping cleanup proceeds even when degraded)', async () => {
    const { linkPath, cloudTarget } = makeCloudSpace('General');
    installStubProbe({ [cloudTarget]: 'degraded' });
    configureCloudSpaceContainment(workspaceRoot, [space('General')]);

    const entry = path.join(linkPath, '.rebel', 'bookkeeping.md');
    const removed = await removeVectorIndexEntries([entry], HYGIENE);
    expect(spies.removeFilesFromIndex).toHaveBeenCalledWith([entry], expect.anything());
    expect(removed).toBe(1);
  });

  it('a LOCAL entry removal is UNCHANGED regardless of verdict', async () => {
    installStubProbe({});
    configureCloudSpaceContainment(workspaceRoot, []); // no cloud spaces

    const entry = path.join(workspaceRoot, 'LocalSpace', 'doc.md');
    removeMetadataStoresEntry(entry, ABSENCE, { workspacePath: workspaceRoot });
    await removeVectorIndexEntry(entry, ABSENCE);

    expect(spies.removeEntity).toHaveBeenCalledWith(entry);
    expect(spies.removeFileFromIndex).toHaveBeenCalledWith(entry, expect.anything());
  });

  // --- Canonical-realpath form (the DOMINANT stored form) ---
  // `cleanupStaleEntries` (R1) iterates `getIndexedPaths()`, which are the keys
  // `indexFileInternal` stored via `fs.realpath` — i.e. the RESOLVED cloud target
  // (`cloudTarget/doc.md`), NOT the workspace symlink path. Before the path-form
  // fix these fell through as `'local'` and were purged on a transient blip (the
  // confirmed silent no-op). These assert RETAIN on the canonical form too.
  it.each(['degraded', 'unknown'] as const)(
    'RETAINS a CANONICAL-realpath cloud entry on `absence` when verdict is %s',
    async (verdict) => {
      const { cloudTarget } = makeCloudSpace('General');
      installStubProbe(verdict === 'unknown' ? {} : { [cloudTarget]: 'degraded' });
      configureCloudSpaceContainment(workspaceRoot, [space('General')]);

      // Entry as STORED by indexFileInternal: under the resolved cloud target.
      const canonicalEntry = path.join(cloudTarget, 'doc.md');
      removeMetadataStoresEntry(canonicalEntry, ABSENCE, { workspacePath: workspaceRoot });
      await removeVectorIndexEntry(canonicalEntry, ABSENCE);
      const removedCount = await removeVectorIndexEntries([canonicalEntry], ABSENCE);

      expect(spies.removeSource).not.toHaveBeenCalled();
      expect(spies.removeEntity).not.toHaveBeenCalled();
      expect(spies.removeFileFromIndex).not.toHaveBeenCalled();
      expect(spies.removeFilesFromIndex).not.toHaveBeenCalled();
      expect(removedCount).toBe(0);
    },
  );

  it('RETAINS a CANONICAL-realpath cloud entry on `watcher-unlink` when degraded', async () => {
    const { cloudTarget } = makeCloudSpace('General');
    installStubProbe({ [cloudTarget]: 'degraded' });
    configureCloudSpaceContainment(workspaceRoot, [space('General')]);

    const canonicalEntry = path.join(cloudTarget, 'doc.md');
    removeMetadataStoresEntry(canonicalEntry, WATCHER_UNLINK, { workspacePath: workspaceRoot });
    await removeVectorIndexEntry(canonicalEntry, WATCHER_UNLINK);

    expect(spies.removeEntity).not.toHaveBeenCalled();
    expect(spies.removeFileFromIndex).not.toHaveBeenCalled();
  });

  it('batch `absence-unverified` gates PER-PATH: removes ONLY the LOCAL entry, retains BOTH cloud entries (4c)', async () => {
    // Under 4c, `absence-unverified` retains EVERY cloud entry (no proof), healthy or
    // degraded; only the local entry is removed (per-path gating in the batch).
    const healthy = makeCloudSpace('Healthy');
    const degraded = makeCloudSpace('Degraded');
    installStubProbe({ [healthy.cloudTarget]: 'healthy', [degraded.cloudTarget]: 'degraded' });
    configureCloudSpaceContainment(workspaceRoot, [space('Healthy'), space('Degraded')]);

    const healthyEntry = path.join(healthy.linkPath, 'h.md');
    const degradedEntry = path.join(degraded.linkPath, 'd.md');
    const localEntry = path.join(workspaceRoot, 'Local', 'l.md');

    const removed = await removeVectorIndexEntries(
      [healthyEntry, degradedEntry, localEntry],
      ABSENCE,
    );

    // Both cloud entries are filtered out; only the local one is removed.
    expect(spies.removeFilesFromIndex).toHaveBeenCalledWith([localEntry], expect.anything());
    expect(removed).toBe(1);
  });
});
