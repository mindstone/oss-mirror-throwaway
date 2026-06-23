/**
 * indexRemovalCoordinator — Stage 4c hardening (F2/R4 + R5).
 *
 * Runtime red→green coverage for the by-construction absence-proof authority and
 * the watcher-unlink freshness + unlink-storm circuit breaker. The COMPILE-time
 * proof that a no-proof cloud purge is unrepresentable lives in the sibling
 * `.type-test.ts` (compiled by lint:ts).
 *
 * Uses the REAL containment map (built from real temp symlinks) + a stub liveness
 * probe supplying verdicts AND freshness, so the end-to-end
 * containment → verdict/freshness → gate path is exercised without a real Drive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpaceConfig } from '@shared/types/settings';
import {
  configureIndexRemovalCoordinator,
  configureIndexRemovalReprobeHook,
  __resetIndexRemovalCoordinatorForTests,
  removeMetadataStoresEntry,
  removeVectorIndexEntry,
  removeIndexedEntry,
  type CoordinatorRemovalReason,
  type IndexRemovalRemovers,
} from '../indexRemovalCoordinator';
import {
  type CloudHealthVerdict,
  type CloudHealthVerdictDetail,
  type CloudLivenessProbe,
  __resetCloudLivenessProbeForTesting,
  setCloudLivenessProbe,
} from '@core/services/cloudLivenessProbe';
import {
  __resetCloudSpaceContainmentForTests,
  __resetCloudUnlinkStormsForTests,
  configureCloudSpaceContainment,
} from '@core/services/cloudSpaceContainment';
import { tryBuildAbsenceProof, toNonNullRealPath } from '@core/services/cloudLivenessProbe.types';

const WATCHER_UNLINK: CoordinatorRemovalReason = { kind: 'watcher-unlink' };

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

/** Stub probe supplying both verdict and freshness (ageMs) per target. */
function installStubProbe(detail: Record<string, CloudHealthVerdictDetail>): void {
  const probe: CloudLivenessProbe = {
    probeHealth: async (t) => detail[t]?.verdict ?? 'unknown',
    getCachedVerdict: (t) => detail[t]?.verdict ?? 'unknown',
    getCachedVerdictDetail: (t): CloudHealthVerdictDetail =>
      detail[t] ?? { verdict: 'unknown' as CloudHealthVerdict, ageMs: Number.POSITIVE_INFINITY },
  };
  setCloudLivenessProbe(probe);
}

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
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-4c-'));
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

describe('Stage 4c — R4 absence-authorized proof scope', () => {
  it('PURGES a cloud entry when the proof is scoped to its space (proof.spaceRoot covers it)', async () => {
    const { cloudTarget } = makeCloudSpace('General');
    installStubProbe({ [cloudTarget]: { verdict: 'healthy', ageMs: 0 } });
    configureCloudSpaceContainment(workspaceRoot, [space('General')]);

    // A proof minted from a complete + healthy walk rooted at this space's cloud root.
    const proof = tryBuildAbsenceProof({
      spaceRoot: cloudTarget,
      walkRootRealPath: cloudTarget,
      isComplete: true,
      verdict: 'healthy',
      healthGeneration: 1,
    });
    expect(proof).not.toBeNull();
    const authorized: CoordinatorRemovalReason = { kind: 'absence-authorized', proof: proof! };

    const canonicalEntry = path.join(cloudTarget, 'doc.md');
    removeMetadataStoresEntry(canonicalEntry, authorized, { workspacePath: workspaceRoot });
    await removeVectorIndexEntry(canonicalEntry, authorized);

    expect(spies.removeEntity).toHaveBeenCalledWith(canonicalEntry);
    expect(spies.removeFileFromIndex).toHaveBeenCalledWith(canonicalEntry, expect.anything());
  });

  it('RETAINS a cloud entry when the proof is for a DIFFERENT space (scope mismatch)', async () => {
    const general = makeCloudSpace('General');
    const exec = makeCloudSpace('Exec');
    installStubProbe({
      [general.cloudTarget]: { verdict: 'healthy', ageMs: 0 },
      [exec.cloudTarget]: { verdict: 'healthy', ageMs: 0 },
    });
    configureCloudSpaceContainment(workspaceRoot, [space('General'), space('Exec')]);

    // Proof authorizes purging the EXEC space only.
    const execProof = tryBuildAbsenceProof({
      spaceRoot: exec.cloudTarget,
      walkRootRealPath: exec.cloudTarget,
      isComplete: true,
      verdict: 'healthy',
      healthGeneration: 1,
    })!;
    const authorizedForExec: CoordinatorRemovalReason = { kind: 'absence-authorized', proof: execProof };

    // But we try to purge a GENERAL entry → scope mismatch → retain.
    const generalEntry = path.join(general.cloudTarget, 'doc.md');
    removeMetadataStoresEntry(generalEntry, authorizedForExec, { workspacePath: workspaceRoot });
    await removeVectorIndexEntry(generalEntry, authorizedForExec);

    expect(spies.removeEntity).not.toHaveBeenCalled();
    expect(spies.removeFileFromIndex).not.toHaveBeenCalled();
  });

  it('tryBuildAbsenceProof refuses to mint a proof for a degraded walk (no authorized removal possible)', () => {
    expect(
      tryBuildAbsenceProof({
        spaceRoot: '/cloud/General',
        walkRootRealPath: '/cloud/General',
        isComplete: true,
        verdict: 'degraded',
        healthGeneration: 1,
      }),
    ).toBeNull();
    // And a non-null root is required.
    expect(toNonNullRealPath(null)).toBeNull();
  });
});

describe('Stage 4c — R5 watcher-unlink freshness', () => {
  it('does NOT purge a cloud entry on a STALE healthy verdict (predates a possible mount death)', async () => {
    const { linkPath, cloudTarget } = makeCloudSpace('General');
    // Healthy verdict but 40s old → too stale for a destructive watcher-unlink.
    installStubProbe({ [cloudTarget]: { verdict: 'healthy', ageMs: 40_000 } });
    configureCloudSpaceContainment(workspaceRoot, [space('General')]);

    const entry = path.join(linkPath, 'doc.md');
    removeMetadataStoresEntry(entry, WATCHER_UNLINK, { workspacePath: workspaceRoot });
    await removeVectorIndexEntry(entry, WATCHER_UNLINK);

    expect(spies.removeEntity).not.toHaveBeenCalled();
    expect(spies.removeFileFromIndex).not.toHaveBeenCalled();
  });

  it('PURGES a cloud entry on a FRESH healthy verdict (single unlink, no storm)', async () => {
    const { linkPath, cloudTarget } = makeCloudSpace('General');
    installStubProbe({ [cloudTarget]: { verdict: 'healthy', ageMs: 1_000 } });
    configureCloudSpaceContainment(workspaceRoot, [space('General')]);

    const entry = path.join(linkPath, 'doc.md');
    removeMetadataStoresEntry(entry, WATCHER_UNLINK, { workspacePath: workspaceRoot });
    await removeVectorIndexEntry(entry, WATCHER_UNLINK);

    expect(spies.removeEntity).toHaveBeenCalledWith(entry);
    expect(spies.removeFileFromIndex).toHaveBeenCalledWith(entry, expect.anything());
  });

  it('a stale-healthy retain kicks a re-probe (invalidateVerdict hook fires)', async () => {
    const { linkPath, cloudTarget } = makeCloudSpace('General');
    installStubProbe({ [cloudTarget]: { verdict: 'healthy', ageMs: 40_000 } });
    configureCloudSpaceContainment(workspaceRoot, [space('General')]);
    const reprobe = vi.fn();
    configureIndexRemovalReprobeHook(reprobe);

    const entry = path.join(linkPath, 'doc.md');
    removeMetadataStoresEntry(entry, WATCHER_UNLINK, { workspacePath: workspaceRoot });

    expect(reprobe).toHaveBeenCalledWith(cloudTarget);
  });
});

describe('Stage 4c — R5 unlink-storm circuit breaker', () => {
  it('an unlink STORM freezes cloud removals for the space + re-probes (keep index)', async () => {
    const { linkPath, cloudTarget } = makeCloudSpace('General');
    // FRESH healthy → individual unlinks would otherwise purge; the storm must
    // override that and freeze.
    installStubProbe({ [cloudTarget]: { verdict: 'healthy', ageMs: 0 } });
    configureCloudSpaceContainment(workspaceRoot, [space('General')]);
    const reprobe = vi.fn();
    configureIndexRemovalReprobeHook(reprobe);

    // Fire a burst of unlinks for the SAME cloud space (metadata phase records each).
    for (let i = 0; i < 10; i += 1) {
      removeMetadataStoresEntry(path.join(linkPath, `f${i}.md`), WATCHER_UNLINK, {
        workspacePath: workspaceRoot,
      });
    }

    // The breaker tripped: well under 10 entity removals went through (threshold is
    // 5), and the re-probe fired. Crucially, the index is NOT wiped.
    expect(spies.removeEntity.mock.calls.length).toBeLessThan(10);
    expect(reprobe).toHaveBeenCalledWith(cloudTarget);

    // Once frozen, a subsequent vector removal for the space is also retained.
    spies.removeFileFromIndex.mockClear();
    await removeVectorIndexEntry(path.join(linkPath, 'later.md'), WATCHER_UNLINK);
    expect(spies.removeFileFromIndex).not.toHaveBeenCalled();
  });

  it('a few ISOLATED cloud unlinks (below threshold) on a fresh healthy verdict do NOT trip the breaker', async () => {
    const { linkPath, cloudTarget } = makeCloudSpace('General');
    installStubProbe({ [cloudTarget]: { verdict: 'healthy', ageMs: 0 } });
    configureCloudSpaceContainment(workspaceRoot, [space('General')]);

    // 3 unlinks (< threshold 5) → all purge (fresh healthy, no storm).
    for (let i = 0; i < 3; i += 1) {
      removeMetadataStoresEntry(path.join(linkPath, `f${i}.md`), WATCHER_UNLINK, {
        workspacePath: workspaceRoot,
      });
    }
    expect(spies.removeEntity).toHaveBeenCalledTimes(3);
  });

  it('a LOCAL unlink storm is COMPLETELY unaffected (no freeze, no tracking)', async () => {
    installStubProbe({});
    configureCloudSpaceContainment(workspaceRoot, []); // no cloud spaces

    for (let i = 0; i < 20; i += 1) {
      removeMetadataStoresEntry(path.join(workspaceRoot, 'Local', `f${i}.md`), WATCHER_UNLINK, {
        workspacePath: workspaceRoot,
      });
    }
    // Every local removal proceeds — no circuit breaker for local paths.
    expect(spies.removeEntity).toHaveBeenCalledTimes(20);
  });
});

describe('Stage 4c — combined entrypoint gates ONCE (no split store under a storm)', () => {
  it('removeIndexedEntry on a frozen space removes NEITHER metadata NOR vectors (atomic retain)', async () => {
    const { linkPath, cloudTarget } = makeCloudSpace('General');
    installStubProbe({ [cloudTarget]: { verdict: 'healthy', ageMs: 0 } });
    configureCloudSpaceContainment(workspaceRoot, [space('General')]);

    // Trip the breaker with a metadata-phase storm first.
    for (let i = 0; i < 10; i += 1) {
      removeMetadataStoresEntry(path.join(linkPath, `f${i}.md`), WATCHER_UNLINK, {
        workspacePath: workspaceRoot,
      });
    }
    spies.removeEntity.mockClear();
    spies.removeFileFromIndex.mockClear();

    // Now a combined removal for the SAME (frozen) space: it must touch NEITHER store
    // (gate once → retain whole; no metadata-removed-but-vectors-retained split).
    await removeIndexedEntry(path.join(linkPath, 'combined.md'), WATCHER_UNLINK, {
      workspacePath: workspaceRoot,
    });
    expect(spies.removeEntity).not.toHaveBeenCalled();
    expect(spies.removeFileFromIndex).not.toHaveBeenCalled();
  });
});
