import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _resetDriveSettleDeferralsForTesting } from '../driveSettleDeferral';
import { DriveSim, type DriveMount } from '../../../../test-utils/cloudHarness/driveSim';
import {
  startLocalCloudService,
  type LocalCloudService,
} from '../../../../test-utils/cloudHarness/localCloudServiceFixture';
import { createSyncMachine, type SyncMachine } from '../../../../test-utils/cloudHarness/syncMachine';
import { __resetWorkspaceFsExecutorForTesting } from '@core/services/boundedWorkspaceFs';
import {
  DRIVE_SETTLE_FORCE_CYCLES,
  MANIFEST_REL_PATH,
  fetchCloudManifest,
  forceSyncUntil,
  readTextIfExists,
} from '../../../../test-utils/cloudHarness/harnessHelpers';

const TEST_TIMEOUT_MS = 120_000;

interface DriveHarness {
  drive: DriveSim;
  mountA: DriveMount;
  mountB: DriveMount;
  a: SyncMachine;
  b: SyncMachine;
}

let cloud: LocalCloudService | null = null;

async function withDriveHarness(run: (harness: DriveHarness) => Promise<void>): Promise<void> {
  if (!cloud) throw new Error('Local cloud service was not started');

  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rebel-drive-sim-'));
  const machines: SyncMachine[] = [];

  try {
    const drive = await DriveSim.create({ rootDir });
    const mountA = await drive.mount('A');
    const mountB = await drive.mount('B');
    const a = await createSyncMachine({ name: 'A', cloud, workspaceDir: mountA.dir });
    const b = await createSyncMachine({ name: 'B', cloud, workspaceDir: mountB.dir });
    machines.push(a, b);

    await run({ drive, mountA, mountB, a, b });
  } finally {
    for (const machine of machines) {
      machine.sync.flush();
      machine.sync._resetForTesting();
      await fsp.rm(machine.dataDir, { recursive: true, force: true });
    }
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
}

async function establishSyncedBaseline(
  harness: DriveHarness,
  rel: string,
  content: string,
): Promise<void> {
  await harness.drive.seedFile(rel, content);
  await harness.drive.settle({ to: ['A', 'B'] });

  await harness.a.sync.forceSync(harness.a.client, harness.a.workspaceDir);
  await harness.b.sync.forceSync(harness.b.client, harness.b.workspaceDir);
}

describe('CloudWorkspaceSync local cloud Drive conflict integration', () => {
  beforeAll(async () => {
    cloud = await startLocalCloudService({ healthTimeoutMs: TEST_TIMEOUT_MS });
  }, TEST_TIMEOUT_MS);

  beforeEach(async () => {
    if (!cloud) throw new Error('Local cloud service was not started');
    _resetDriveSettleDeferralsForTesting();
    await fsp.rm(cloud.workspaceDir, { recursive: true, force: true });
    await fsp.mkdir(cloud.workspaceDir, { recursive: true });
  });

  afterEach(() => {
    _resetDriveSettleDeferralsForTesting();
  });

  afterAll(async () => {
    try {
      await cloud?.cleanup();
      cloud = null;
    } finally {
      // createSyncMachine wires the healthy-mount realFsExecutor (process-global);
      // restore the fail-closed unwired default so it can't leak into sibling suites.
      // In `finally` so a throwing cleanup() can't skip the reset.
      __resetWorkspaceFsExecutorForTesting();
    }
  }, TEST_TIMEOUT_MS);

  it('keeps generated file conflict copies out of cloud and peer pulls', async () => {
    await withDriveHarness(async (harness) => {
      const originalRel = 'memory/topics/foo.md';
      const conflictRel = 'memory/topics/foo (1).md';

      await establishSyncedBaseline(harness, originalRel, 'baseline');

      harness.drive.concurrent([
        { mount: 'A', rel: originalRel, content: 'from A' },
        { mount: 'B', rel: originalRel, content: 'from B' },
      ]);
      await harness.drive.settle({ to: ['A'] });

      await expect(harness.mountA.snapshot()).resolves.toEqual([conflictRel, originalRel]);
      await expect(readTextIfExists(path.join(harness.a.workspaceDir, conflictRel))).resolves.toBe('from B');

      await harness.a.sync.forceSync(harness.a.client, harness.a.workspaceDir);

      const cloudManifest = await fetchCloudManifest(harness.a);
      expect(Object.keys(cloudManifest.entries)).toContain(originalRel);
      expect(Object.keys(cloudManifest.entries)).not.toContain(conflictRel);

      for (let cycle = 1; cycle <= DRIVE_SETTLE_FORCE_CYCLES; cycle += 1) {
        await harness.b.sync.forceSync(harness.b.client, harness.b.workspaceDir);
        await expect(readTextIfExists(path.join(harness.b.workspaceDir, conflictRel))).resolves.toBeNull();
      }

      await expect(harness.mountB.snapshot()).resolves.not.toContain(conflictRel);
    });
  }, TEST_TIMEOUT_MS);

  it('suppresses generated folder conflict copies through the real cloud service', async () => {
    await withDriveHarness(async (harness) => {
      const originalRel = 'Projects/Client/notes.md';
      const conflictRel = 'Projects/Client (1)/notes.md';
      const bFolderContent = 'folder conflict content from B';

      await establishSyncedBaseline(harness, originalRel, 'baseline');
      await harness.mountB.writeFile(originalRel, bFolderContent);
      await harness.drive.mintFolderConflict('Projects/Client', 'B');
      await harness.drive.settle({ to: ['A'] });

      await expect(harness.mountA.snapshot()).resolves.toEqual([conflictRel, originalRel]);
      await expect(readTextIfExists(path.join(harness.a.workspaceDir, conflictRel))).resolves.toBe(bFolderContent);

      await harness.a.sync.forceSync(harness.a.client, harness.a.workspaceDir);

      const cloudManifest = await fetchCloudManifest(harness.a);
      // REBEL-5QS: folder-level conflict copies are suppressed (fixed).
      expect(Object.keys(cloudManifest.entries)).toContain(originalRel);
      expect(Object.keys(cloudManifest.entries)).not.toContain(conflictRel);

      for (let cycle = 1; cycle <= DRIVE_SETTLE_FORCE_CYCLES; cycle += 1) {
        await harness.b.sync.forceSync(harness.b.client, harness.b.workspaceDir);
        await expect(readTextIfExists(path.join(harness.b.workspaceDir, conflictRel))).resolves.toBeNull();
      }

      await expect(harness.mountB.snapshot()).resolves.not.toContain(conflictRel);
    });
  }, TEST_TIMEOUT_MS);

  it('retains a standalone numbered folder when no original sibling exists', async () => {
    await withDriveHarness(async (harness) => {
      const standaloneRel = 'Standalone (1)/x.md';
      const standaloneContent = 'legitimate standalone numbered folder';

      await harness.drive.seedFile(standaloneRel, standaloneContent);
      await fsp.rm(path.join(harness.b.workspaceDir, standaloneRel), { force: true });

      await harness.a.sync.forceSync(harness.a.client, harness.a.workspaceDir);

      const cloudManifest = await fetchCloudManifest(harness.a);
      expect(Object.keys(cloudManifest.entries)).toContain(standaloneRel);

      const pulled = await forceSyncUntil(
        harness.b,
        async () => (await readTextIfExists(path.join(harness.b.workspaceDir, standaloneRel))) === standaloneContent,
      );

      expect(pulled).toBe(true);
    });
  }, TEST_TIMEOUT_MS);

  it('suppresses nested numbered folder conflicts when an ancestor original exists', async () => {
    await withDriveHarness(async (harness) => {
      const originalRel = 'A/original.md';
      const conflictRel = 'A (1)/B (1)/c.md';
      const conflictContent = 'nested folder conflict content';

      await establishSyncedBaseline(harness, originalRel, 'original');
      await harness.mountA.writeFile(conflictRel, conflictContent);

      await expect(readTextIfExists(path.join(harness.a.workspaceDir, conflictRel))).resolves.toBe(conflictContent);

      await harness.a.sync.forceSync(harness.a.client, harness.a.workspaceDir);

      const cloudManifest = await fetchCloudManifest(harness.a);
      expect(Object.keys(cloudManifest.entries)).toContain(originalRel);
      expect(Object.keys(cloudManifest.entries)).not.toContain(conflictRel);

      for (let cycle = 1; cycle <= DRIVE_SETTLE_FORCE_CYCLES; cycle += 1) {
        await harness.b.sync.forceSync(harness.b.client, harness.b.workspaceDir);
        await expect(readTextIfExists(path.join(harness.b.workspaceDir, conflictRel))).resolves.toBeNull();
      }
    });
  }, TEST_TIMEOUT_MS);

  it('persists per-machine workspace manifests in isolated data directories', async () => {
    await withDriveHarness(async (harness) => {
      const rel = 'memory/topics/manifest-isolation.md';

      await establishSyncedBaseline(harness, rel, 'isolation');
      harness.a.sync.flush();
      harness.b.sync.flush();

      const aManifestPath = path.join(harness.a.dataDir, MANIFEST_REL_PATH);
      const bManifestPath = path.join(harness.b.dataDir, MANIFEST_REL_PATH);

      expect(aManifestPath).not.toBe(bManifestPath);
      await expect(fsp.access(aManifestPath)).resolves.toBeUndefined();
      await expect(fsp.access(bManifestPath)).resolves.toBeUndefined();
    });
  }, TEST_TIMEOUT_MS);
});
