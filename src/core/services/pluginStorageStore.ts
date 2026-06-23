/**
 * Plugin Storage Store
 *
 * Persistent key-value storage for plugins, namespaced per plugin ID.
 * Each plugin gets up to 10MB of storage. Data persists across plugin
 * unmount/remount and app restart. Storage is cleaned up ONLY on explicit
 * plugin deletion — disabling a plugin preserves its data.
 *
 * Delegates to PluginDataBackend (set at bootstrap) for actual persistence.
 * The backend stores each plugin's data in a separate `data.json` file,
 * isolating plugins from each other.
 *
 * @see docs/plans/260408_plugin_data_storage_robustness.md (Stages 2-3)
 * @see src/core/services/pluginDataBackend.ts — backend interface
 * @see src/main/services/pluginDataFileBackend.ts — file-based implementation
 * @see src/main/services/pluginFilePersistence.ts — plugin manifest/source persistence (file-based)
 */

import { createScopedLogger } from '@core/logger';
import { getPluginDataBackend } from '@core/services/pluginDataBackend';

const log = createScopedLogger({ service: 'pluginStorageStore' });

const PLUGIN_QUOTA_BYTES = 10 * 1024 * 1024; // 10MB per plugin

export async function getPluginStorageValue(pluginId: string, key: string): Promise<unknown> {
  return getPluginDataBackend().get(pluginId, key);
}

export async function setPluginStorageValue(
  pluginId: string,
  key: string,
  value: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const backend = getPluginDataBackend();

  // Check quota before writing: simulate adding the key to get projected size
  const currentData = await backend.exportAll(pluginId);
  const projectedData = { ...currentData, [key]: value };
  const size = new TextEncoder().encode(JSON.stringify(projectedData)).byteLength;

  if (size > PLUGIN_QUOTA_BYTES) {
    log.warn({ pluginId, key, size, quota: PLUGIN_QUOTA_BYTES }, 'Plugin storage quota exceeded');
    return { ok: false, error: `Storage quota exceeded (${size} bytes > ${PLUGIN_QUOTA_BYTES} bytes)` };
  }

  return backend.set(pluginId, key, value);
}

export async function deletePluginStorageValue(pluginId: string, key: string): Promise<void> {
  return getPluginDataBackend().delete(pluginId, key);
}

export async function clearPluginStorage(pluginId: string): Promise<void> {
  await getPluginDataBackend().clear(pluginId);
  log.info({ pluginId }, 'Cleared plugin storage');
}

export async function getPluginStorageUsage(
  pluginId: string,
): Promise<{ usedBytes: number; quotaBytes: number; percentUsed: number }> {
  const backend = getPluginDataBackend();
  const usedBytes = await backend.getUsageBytes(pluginId);
  return {
    usedBytes,
    quotaBytes: PLUGIN_QUOTA_BYTES,
    percentUsed: Math.round((usedBytes / PLUGIN_QUOTA_BYTES) * 100),
  };
}

/** Snapshot plugin data before an update. Returns true if backup was created. */
export async function backupPluginData(pluginId: string): Promise<boolean> {
  return getPluginDataBackend().backupData(pluginId);
}

/** Restore plugin data from the most recent backup. Returns true if restored. */
export async function restorePluginDataBackup(pluginId: string): Promise<boolean> {
  return getPluginDataBackend().restoreBackup(pluginId);
}

/** Check whether a data backup exists for the given plugin. */
export async function hasPluginDataBackup(pluginId: string): Promise<boolean> {
  return getPluginDataBackend().hasBackup(pluginId);
}
