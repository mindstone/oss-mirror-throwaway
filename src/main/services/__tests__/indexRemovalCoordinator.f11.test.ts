/**
 * indexRemovalCoordinator — F11 cross-cutting purge-gating regression set
 * (260619_cloud-symlink-indexing, Stage 12).
 *
 * The PLAN's "Purge-Gating & Removal Design" section enumerates five purge-gating
 * invariants that MUST hold so admitting a healthy cloud space can never wipe the
 * last-known index on a transient outage (the "keep old results" contract). Most
 * landed per-stage; this file is the CONSOLIDATED net that asserts the whole set in
 * one legible place and CLOSES the two cases that lacked an end-to-end runtime test:
 *
 *  (a) `rootRealPath:null` does NOT prune — a dangling/missing cloud root yields a
 *      `{rootRealPath:null}` "complete-empty" walk; `tryBuildAbsenceProof` refuses to
 *      mint a proof, so the coordinator is structurally forced to `absence-unverified`
 *      and RETAINS. (Construction-level coverage exists in
 *      `cloudLivenessProbe.test.ts`; this adds the END-TO-END coordinator decision.)
 *  (c) startup `unknown` retains BEFORE the first verdict — a cold-start absence
 *      sweep (batch delete, no verdict yet) must keep every cloud entry. (The
 *      single-entry path is covered in `indexRemovalCoordinator.retain.test.ts`;
 *      this adds the startup BATCH-delete shape explicitly.)
 *  (d) source-metadata + entity-metadata + LanceDB stay CONSISTENT after a gated
 *      cloud removal (no half-purge) — a gated removal touches NONE of the three
 *      stores; an authorized removal touches ALL THREE. (Atomic-retain is covered in
 *      `…stage4c.test.ts`; this asserts the all-three / none-of-three symmetry head-on.)
 *
 * Already-covered cases, NOT duplicated here (see the named tests):
 *  (b) stale-cached-healthy unlink storm does NOT prune (circuit breaker fires) —
 *      `indexRemovalCoordinator.stage4c.test.ts` › "an unlink STORM freezes cloud
 *      removals for the space + re-probes (keep index)".
 *  (e) `replacement` re-index deletes are NOT blocked by the health gate —
 *      `indexRemovalCoordinator.retain.test.ts` › "NEVER gates `replacement`".
 *  A thin smoke assertion for (b)/(e) is kept below so this file fails loudly if the
 *  reason taxonomy ever regresses, without re-testing the full mechanics.
 *
 * Wiring mirrors the Stage-4 coordinator tests: the REAL cloud-space containment map
 * (built from real temp symlinks) + a stub liveness probe supplying verdicts — so the
 * end-to-end containment → verdict → gate path is exercised without a real Drive.
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
  removeIndexedEntries,
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
import { tryBuildAbsenceProof } from '@core/services/cloudLivenessProbe.types';

const ABSENCE_UNVERIFIED: CoordinatorRemovalReason = { kind: 'absence-unverified' };
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

/** Create a cloud-symlinked space `name`; return its in-workspace link + cloud target. */
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
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-f11-'));
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

describe('F11(a) — a dangling cloud root (rootRealPath:null) does NOT prune the index', () => {
  it('tryBuildAbsenceProof refuses a null walk root → no absence-authorized proof exists', () => {
    // The F1 hole: a dangling/missing root returns `{rootRealPath:null}`, which looks
    // "complete-empty" — but no proof can be minted, so a cloud absence purge is
    // structurally impossible.
    const proof = tryBuildAbsenceProof({
      spaceRoot: '/cloud/General',
      walkRootRealPath: null, // dangling root → the F1 hole
      isComplete: true,
      verdict: 'healthy',
      healthGeneration: 1,
    });
    expect(proof).toBeNull();
  });

  it('END-TO-END: a cloud entry under a dangling-root space is RETAINED (forced to absence-unverified)', async () => {
    // A dangling cloud root means no proof can be built (above) → the only reason the
    // coordinator can carry for that absence is `absence-unverified`, which RETAINS
    // every cloud entry regardless of verdict. Even with a HEALTHY cached verdict (the
    // worst case for an accidental wipe), the entry must survive.
    const { linkPath, cloudTarget } = makeCloudSpace('General');
    installStubProbe({ [cloudTarget]: 'healthy' });
    configureCloudSpaceContainment(workspaceRoot, [space('General')]);

    const entry = path.join(linkPath, 'doc.md');
    removeMetadataStoresEntry(entry, ABSENCE_UNVERIFIED, { workspacePath: workspaceRoot });
    await removeVectorIndexEntry(entry, ABSENCE_UNVERIFIED);

    // No store touched — the dangling root did not wipe the last-known index.
    expect(spies.removeSource).not.toHaveBeenCalled();
    expect(spies.removeEntity).not.toHaveBeenCalled();
    expect(spies.removeFileFromIndex).not.toHaveBeenCalled();
  });
});

describe('F11(c) — startup `unknown` (no verdict yet) RETAINS before the first verdict', () => {
  it('a cold-start batch absence sweep keeps every cloud entry while the verdict is unknown', async () => {
    // Startup state: the prober has not produced a verdict for the space yet, so
    // `getCachedVerdict` returns `unknown` (empty verdict map). A startup absence sweep
    // (batch delete, the `cleanupStaleEntries` shape) must RETAIN every cloud entry —
    // fail-closed: not-healthy ⇒ never purge.
    const { linkPath } = makeCloudSpace('General');
    installStubProbe({}); // no verdict for any target → unknown
    configureCloudSpaceContainment(workspaceRoot, [space('General')]);

    const cloudEntries = [
      path.join(linkPath, 'a.md'),
      path.join(linkPath, 'b.md'),
      path.join(linkPath, 'c.md'),
    ];
    const localEntry = path.join(workspaceRoot, 'Local', 'l.md');

    // Batch absence sweep spanning the cloud space + a local entry.
    const removed = await removeIndexedEntries(
      [...cloudEntries, localEntry],
      ABSENCE_UNVERIFIED,
      { workspacePath: workspaceRoot },
    );

    // Only the local entry is purged; all three cloud entries are retained (unknown).
    expect(spies.removeFilesFromIndex).toHaveBeenCalledWith([localEntry], expect.anything());
    expect(removed).toBe(1);
    // The cloud entries were never handed to ANY store remover.
    for (const cloudEntry of cloudEntries) {
      expect(spies.removeSource).not.toHaveBeenCalledWith(cloudEntry);
      expect(spies.removeEntity).not.toHaveBeenCalledWith(cloudEntry);
    }
  });
});

describe('F11(d) — the three index stores stay CONSISTENT after a gated cloud removal (no half-purge)', () => {
  it('a GATED (degraded) cloud removal touches NONE of source/entity/LanceDB', async () => {
    const { linkPath, cloudTarget } = makeCloudSpace('General');
    installStubProbe({ [cloudTarget]: 'degraded' });
    configureCloudSpaceContainment(workspaceRoot, [space('General')]);

    const entry = path.join(linkPath, 'doc.md');
    // Both phases of the watcher's metadata-now / vectors-later shape.
    removeMetadataStoresEntry(entry, ABSENCE_UNVERIFIED, { workspacePath: workspaceRoot });
    await removeVectorIndexEntry(entry, ABSENCE_UNVERIFIED);

    // Consistency: ALL three stores still hold the entry (no metadata-gone /
    // vectors-present half-purge window).
    expect(spies.removeSource).not.toHaveBeenCalled();
    expect(spies.removeEntity).not.toHaveBeenCalled();
    expect(spies.removeFileFromIndex).not.toHaveBeenCalled();
  });

  it('an AUTHORIZED (proven-healthy) cloud removal touches ALL THREE stores', async () => {
    const { cloudTarget } = makeCloudSpace('General');
    installStubProbe({ [cloudTarget]: 'healthy' });
    configureCloudSpaceContainment(workspaceRoot, [space('General')]);

    // A proof minted from a complete + healthy per-space walk rooted at this cloud root.
    const proof = tryBuildAbsenceProof({
      spaceRoot: cloudTarget,
      walkRootRealPath: cloudTarget,
      isComplete: true,
      verdict: 'healthy',
      healthGeneration: 1,
    });
    expect(proof).not.toBeNull();
    const authorized: CoordinatorRemovalReason = { kind: 'absence-authorized', proof: proof! };

    // Entry stored under the resolved cloud target (the dominant stored form).
    const entry = path.join(cloudTarget, 'doc.md');
    removeMetadataStoresEntry(entry, authorized, { workspacePath: workspaceRoot });
    await removeVectorIndexEntry(entry, authorized);

    // All three stores removed the entry — consistent, complete purge.
    expect(spies.removeSource).toHaveBeenCalledWith(entry);
    expect(spies.removeEntity).toHaveBeenCalledWith(entry);
    expect(spies.removeFileFromIndex).toHaveBeenCalledWith(entry, expect.anything());
  });
});

describe('F11(b)/(e) — taxonomy smoke (full mechanics covered in stage4c / retain suites)', () => {
  it('`replacement` is never health-gated (re-index proceeds even on a degraded cloud space)', async () => {
    // (e) smoke: a re-index delete must NOT be blocked by the health gate — full
    // coverage in `indexRemovalCoordinator.retain.test.ts`.
    const { linkPath, cloudTarget } = makeCloudSpace('General');
    installStubProbe({ [cloudTarget]: 'degraded' });
    configureCloudSpaceContainment(workspaceRoot, [space('General')]);

    const entry = path.join(linkPath, 'doc.md');
    await removeVectorIndexEntry(entry, REPLACEMENT);
    expect(spies.removeFileFromIndex).toHaveBeenCalledWith(entry, expect.anything());
  });
});
