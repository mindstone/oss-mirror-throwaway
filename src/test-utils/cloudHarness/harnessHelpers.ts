import fsp from 'node:fs/promises';
import path from 'node:path';
import { DRIVE_SETTLE_MAX_DEFERRALS } from '@main/services/cloud/driveSettleDeferral';
import type { CloudManifest } from '@main/services/cloud/cloudWorkspaceSync';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import type { SyncMachine } from './syncMachine';

/**
 * Shared assertions/helpers for the cloud-sync harness, consumed by the integration test,
 * the operator CLI, and the smoke script (deduped from copy-paste — see DA review 260606).
 */

/** Per-machine workspace-manifest path, relative to a machine's `dataDir`. */
export const MANIFEST_REL_PATH = path.join('sessions', 'cloud-workspace-manifest.json');

/**
 * How many `forceSync` cycles to drive before concluding a peer did/did-not receive a file.
 * A new file on a Google-Drive-looking path is deferred up to `DRIVE_SETTLE_MAX_DEFERRALS`
 * times, so it lands on cycle `MAX + 1`. We add a small buffer (+2) so the loop isn't
 * exactly tight against the deferral budget (flake margin; faithfulness review 260606).
 */
export const DRIVE_SETTLE_FORCE_CYCLES = DRIVE_SETTLE_MAX_DEFERRALS + 2;

export function isCloudManifest(value: unknown): value is CloudManifest {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'entries' in value &&
    typeof (value as { entries?: unknown }).entries === 'object' &&
    (value as { entries?: unknown }).entries !== null &&
    'complete' in value &&
    typeof (value as { complete?: unknown }).complete === 'boolean',
  );
}

export async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT') {
      ignoreBestEffortCleanup(err, {
        operation: 'cloudHarness.readTextIfExists',
        reason: 'file-absent-returns-null',
        severity: 'debug',
        owner: 'test-utils.cloudHarness',
      });
      return null;
    }
    throw err;
  }
}

/** Fetch the live cloud manifest from the real spawned cloud-service (real HTTP, not cached). */
export async function fetchCloudManifest(machine: SyncMachine): Promise<CloudManifest> {
  const raw = await machine.client.post('/api/library/manifest', {});
  if (!isCloudManifest(raw)) {
    throw new Error('Cloud manifest response did not match CloudManifest envelope');
  }
  return raw;
}

/**
 * Force-sync a machine repeatedly until `predicate` is true or `maxCycles` is reached.
 * Returns whether the predicate became true. Exists because new-file pulls on
 * Drive-looking paths are deferred (drive-settle); a single sync is not enough.
 */
export async function forceSyncUntil(
  machine: SyncMachine,
  predicate: () => Promise<boolean>,
  maxCycles: number = DRIVE_SETTLE_FORCE_CYCLES,
): Promise<boolean> {
  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    await machine.sync.forceSync(machine.client, machine.workspaceDir);
    if (await predicate()) return true;
  }
  return false;
}
