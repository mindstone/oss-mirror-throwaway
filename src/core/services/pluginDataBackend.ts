/**
 * Plugin Data Backend — platform-agnostic storage interface for per-plugin data.
 *
 * Replaces the single global JSON blob (electron-store) with a backend
 * that stores data per-plugin in individual files. Interface defined here
 * in core; implementations live in surface-specific directories (e.g.
 * `src/main/services/pluginDataFileBackend.ts`).
 *
 * Uses the same lazy singleton pattern as storeFactory.ts, broadcastService.ts, etc.
 *
 * @see docs/plans/260408_plugin_data_storage_robustness.md (Stage 2)
 * @see src/main/services/pluginDataFileBackend.ts — file-based implementation
 */

export interface PluginDataBackend {
  get(pluginId: string, key: string): Promise<unknown>;
  set(pluginId: string, key: string, value: unknown): Promise<{ ok: true } | { ok: false; error: string }>;
  delete(pluginId: string, key: string): Promise<void>;
  clear(pluginId: string): Promise<void>;
  getUsageBytes(pluginId: string): Promise<number>;
  exportAll(pluginId: string): Promise<Record<string, unknown>>;
  /** Copy data.json to data.backup.json. Returns true if backup created, false if no data to back up. */
  backupData(pluginId: string): Promise<boolean>;
  /** Restore data.backup.json back to data.json and reload cache. Returns true if restored, false if no backup exists. */
  restoreBackup(pluginId: string): Promise<boolean>;
  /** Check whether a backup file exists for the given plugin. */
  hasBackup(pluginId: string): Promise<boolean>;
}

let _backend: PluginDataBackend | undefined;

export function setPluginDataBackend(backend: PluginDataBackend): void {
  _backend = backend;
}

export function getPluginDataBackend(): PluginDataBackend {
  if (!_backend) {
    throw new Error(
      'PluginDataBackend not initialized. Call setPluginDataBackend() before accessing plugin data.',
    );
  }
  return _backend;
}
