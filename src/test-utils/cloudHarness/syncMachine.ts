import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CloudServiceClient } from '@main/services/cloud/cloudServiceClient';
import { CloudWorkspaceSync } from '@main/services/cloud/cloudWorkspaceSync';
import { setWorkspaceFsExecutor } from '@core/services/boundedWorkspaceFs';
import { realFsExecutor } from '@core/services/__tests__/workspaceFsExecutorDoubles';
import type { LocalCloudService } from './localCloudServiceFixture';

export interface SyncMachine {
  name: string;
  dataDir: string;
  workspaceDir: string;
  sync: CloudWorkspaceSync;
  client: CloudServiceClient;
}

export interface CreateSyncMachineOpts {
  name: string;
  cloud: LocalCloudService;
  workspaceDir: string;
  dataDir?: string;
}

export async function createSyncMachine(opts: CreateSyncMachineOpts): Promise<SyncMachine> {
  // The harness models machine workspaces under DriveSim's literal `Google Drive/…`
  // paths, which `detectCloudStorage` classifies as cloud → `safeWalkDirectory`
  // (used by `buildLocalManifest`) routes their realpath/readdir through the
  // boundedWorkspaceFs CLOUD lane. Those paths are REAL local temp dirs here, so we
  // wire the healthy-mount `realFsExecutor` (delegates to real `fs`) — the in-process
  // analogue of the desktop killable child pool. Without it the unwired fail-closed
  // default resolves every cloud op to `reconnecting`, and the manifest walk aborts
  // with `cloud-timeout` and zero entries (S4.1a regression — the boundary routing
  // landed, but this harness never grew a cloud-lane executor). Process-global +
  // idempotent; the integration suite restores the unwired default in afterAll.
  setWorkspaceFsExecutor(realFsExecutor);

  const dataDir = opts.dataDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), `rebel-sync-machine-${opts.name}-`)));
  const workspaceDir = path.resolve(opts.workspaceDir);

  await fsp.mkdir(path.join(dataDir, 'sessions'), { recursive: true });
  await fsp.mkdir(workspaceDir, { recursive: true });

  return {
    name: opts.name,
    dataDir,
    workspaceDir,
    sync: new CloudWorkspaceSync({ dataPath: dataDir }),
    client: new CloudServiceClient(opts.cloud.baseUrl, opts.cloud.token),
  };
}
