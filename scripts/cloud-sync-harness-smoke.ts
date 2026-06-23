#!/usr/bin/env -S node --import tsx
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bootstrapDesktopPlatform } from '../src/test-utils/cloudHarness/bootstrapDesktopPlatform';
import {
  ensureCloudServiceBuilt,
  startLocalCloudService,
  type LocalCloudService,
} from '../src/test-utils/cloudHarness/localCloudServiceFixture';
import { createSyncMachine } from '../src/test-utils/cloudHarness/syncMachine';
import {
  DRIVE_SETTLE_FORCE_CYCLES,
  MANIFEST_REL_PATH,
  isCloudManifest,
  readTextIfExists,
} from '../src/test-utils/cloudHarness/harnessHelpers';

// Standalone (non-Vitest) context: initialize desktop PlatformConfig before core modules load.
bootstrapDesktopPlatform();

const RELATIVE_FILE = 'memory/topics/foo.md';
const CONTENT = 'hello';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<number> {
  let cloud: LocalCloudService | null = null;
  let driveRoot: string | null = null;

  try {
    await ensureCloudServiceBuilt();
    cloud = await startLocalCloudService();
    driveRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'rebel-cloud-sync-drive-'));

    const machineAWorkspace = path.join(driveRoot, 'Google Drive', 'Machine A', 'Rebel');
    const machineBWorkspace = path.join(driveRoot, 'Google Drive', 'Machine B', 'Rebel');
    const a = await createSyncMachine({ name: 'A', cloud, workspaceDir: machineAWorkspace });
    const b = await createSyncMachine({ name: 'B', cloud, workspaceDir: machineBWorkspace });

    const sourceFile = path.join(a.workspaceDir, RELATIVE_FILE);
    await fsp.mkdir(path.dirname(sourceFile), { recursive: true });
    await fsp.writeFile(sourceFile, CONTENT, 'utf8');

    console.log(`[cloud-sync-harness-smoke] cloud=${cloud.baseUrl}`);
    console.log(`[cloud-sync-harness-smoke] A workspace=${a.workspaceDir}`);
    console.log(`[cloud-sync-harness-smoke] B workspace=${b.workspaceDir}`);

    await a.sync.forceSync(a.client, a.workspaceDir);

    const rawManifest = await a.client.post('/api/library/manifest', {});
    assert(isCloudManifest(rawManifest), 'Cloud manifest response did not match CloudManifest envelope');
    assert(Object.hasOwn(rawManifest.entries, RELATIVE_FILE), `Cloud manifest does not contain ${RELATIVE_FILE}`);

    const targetFile = path.join(b.workspaceDir, RELATIVE_FILE);
    let bContent: string | null = null;
    // Google-Drive-looking paths can trigger drive-settle deferral before desktop writes missing files.
    // Keep forcing sync through the shared cycle budget so the harness works on that real seam.
    for (let cycle = 1; cycle <= DRIVE_SETTLE_FORCE_CYCLES; cycle += 1) {
      await b.sync.forceSync(b.client, b.workspaceDir);
      bContent = await readTextIfExists(targetFile);
      console.log(`[cloud-sync-harness-smoke] B forceSync cycle ${cycle}: ${bContent === null ? 'pending' : 'landed'}`);
      if (bContent === CONTENT) break;
    }

    assert(bContent === CONTENT, `B workspace did not receive ${RELATIVE_FILE} with matching content`);

    a.sync.flush();
    b.sync.flush();
    const aManifestPath = path.join(a.dataDir, MANIFEST_REL_PATH);
    const bManifestPath = path.join(b.dataDir, MANIFEST_REL_PATH);
    assert(aManifestPath !== bManifestPath, 'A and B manifest paths are unexpectedly identical');
    await fsp.access(aManifestPath);
    await fsp.access(bManifestPath);

    console.log('[cloud-sync-harness-smoke] PASS real cloud-service push/pull round trip succeeded');
    console.log(`[cloud-sync-harness-smoke] A manifest=${aManifestPath}`);
    console.log(`[cloud-sync-harness-smoke] B manifest=${bManifestPath}`);
    return 0;
  } catch (err) {
    console.error('[cloud-sync-harness-smoke] FAIL');
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    return 1;
  } finally {
    if (cloud) await cloud.cleanup();
    if (driveRoot) await fsp.rm(driveRoot, { recursive: true, force: true });
  }
}

void main().then((code) => process.exit(code));
