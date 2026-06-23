import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { indexFile } from './fileIndexService';
import { removeVectorIndexEntry } from './indexRemovalCoordinator';

const log = createScopedLogger({ service: 'pluginIndexService' });

function getPluginReadmePath(pluginDir: string): string {
  return path.join(pluginDir, 'README.md');
}

async function readmeExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function indexPluginReadme(pluginDir: string, workspacePath: string): Promise<void> {
  const readmePath = getPluginReadmePath(pluginDir);
  if (!await readmeExists(readmePath)) {
    log.debug({ pluginDir }, 'Skipping plugin README indexing because file does not exist');
    return;
  }

  await indexFile(readmePath, workspacePath);
}

/**
 * Remove a plugin's README from the semantic index when the plugin is deactivated.
 *
 * Routed through the Removal Coordinator (the single "only door" for cloud-relevant
 * LanceDB removals; scripts/check-index-removal-coordinator.ts) rather than calling
 * `removeFileFromIndex` directly: a plugin README lives at
 * `<spacePath>/plugins/<id>/README.md` UNDER the workspace `coreDirectory`, and a
 * Space (or `coreDirectory` itself) can be a cloud-backed symlink — so this is a
 * workspace-path removal, NOT a separate local-only index. It is a VECTOR-ONLY
 * removal (no metadata stores), exactly as before.
 *
 * Reason `hygiene`: this is a lifecycle/policy cleanup of an inactive plugin's
 * stored entry, the same shape as the `purgeRebel`/`purgeConflict` vector-only
 * hygiene purges. NOTE for Stage 4b: this is an explicit deactivation-policy
 * removal, NOT a filesystem-absence claim — when 4b adds retain-when-degraded
 * gating it must treat `hygiene` as stored-path policy cleanup (no cloud fs-op,
 * allowed even when degraded), so deactivating a plugin still drops its README from
 * search regardless of cloud-mount health. Do not let 4b retain it on a degraded
 * verdict.
 */
export async function deindexPluginReadme(pluginDir: string): Promise<void> {
  await removeVectorIndexEntry(getPluginReadmePath(pluginDir), { kind: 'hygiene' });
}
