/**
 * Plugin lifecycle and space management IPC handlers.
 *
 * Covers: compile-and-register, persist-all, load-persisted, clear-persisted,
 * storage-*, export-plugin, import-plugin, scan-spaces, export-to-space,
 * resolve-conflict, rebel-merge, accept-merge, activation, deactivation,
 * index/deindex, delete-from-space, migrate-to-space
 */

import { dialog, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { registerHandler } from '../utils/registerHandler';
import { pluginsChannels } from '@shared/ipc/channels/plugins';
import {
  persistPluginEntries,
  loadPersistedPluginEntries,
  clearPersistedPluginEntries,
} from '../../services/pluginFilePersistence';
import {
  getPluginStorageValue,
  setPluginStorageValue,
  deletePluginStorageValue,
  clearPluginStorage,
  getPluginStorageUsage,
  restorePluginDataBackup,
  hasPluginDataBackup,
} from '@core/services/pluginStorageStore';
import { getPluginDataBackend } from '@core/services/pluginDataBackend';
import {
  getActivatedPluginIds,
  addActivatedPluginId,
  removeActivatedPluginId,
  getDeactivatedPluginIds,
  addDeactivatedPluginId,
  removeDeactivatedPluginId,
  getPendingReviewPluginIds,
} from '@core/services/pluginActivationStore';
import { getSettings } from '@core/services/settingsStore';
import { requestPluginCompileAndRegister } from '../../services/pluginCompileBridge';
import { createScopedLogger } from '@core/logger';
import { isKnownPlugin, invalidatePermissionCache, populatePermissionCache } from './shared';

const log = createScopedLogger({ service: 'pluginLifecycleHandlers' });

export function registerPluginLifecycleHandlers(): void {
  // ── Compile & Register ────────────────────────────────────────────────

  const compileChannel = pluginsChannels['plugins:compile-and-register'];
  registerHandler(compileChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = compileChannel.request.parse(request);
    return requestPluginCompileAndRegister(validated);
  });

  // ── Persist / Load / Clear ────────────────────────────────────────────

  const persistChannel = pluginsChannels['plugins:persist-all'];
  registerHandler(persistChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = persistChannel.request.parse(request);
    const userPlugins = validated.plugins.filter((plugin) => !plugin.manifest.id.startsWith('__'));
    await persistPluginEntries(userPlugins);
    invalidatePermissionCache();
    return { success: true };
  });

  const loadChannel = pluginsChannels['plugins:load-persisted'];
  registerHandler(loadChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    loadChannel.request.parse(request);
    const plugins = await loadPersistedPluginEntries();
    populatePermissionCache(plugins);
    return { plugins };
  });

  const clearChannel = pluginsChannels['plugins:clear-persisted'];
  registerHandler(clearChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    clearChannel.request.parse(request);
    await clearPersistedPluginEntries();
    invalidatePermissionCache();
    return { success: true };
  });

  // ── Plugin Storage (per-plugin key-value persistence) ─────────────────

  const storageGetChannel = pluginsChannels['plugins:storage-get'];
  registerHandler(storageGetChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = storageGetChannel.request.parse(request);
    if (!(await isKnownPlugin(validated.pluginId))) {
      log.warn({ pluginId: validated.pluginId }, 'Storage get rejected: unknown pluginId');
      return { value: undefined };
    }
    const value = await getPluginStorageValue(validated.pluginId, validated.key);
    return { value };
  });

  const storageSetChannel = pluginsChannels['plugins:storage-set'];
  registerHandler(storageSetChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = storageSetChannel.request.parse(request);
    if (!(await isKnownPlugin(validated.pluginId))) {
      log.warn({ pluginId: validated.pluginId }, 'Storage set rejected: unknown pluginId');
      return { ok: false, error: 'Unknown plugin.' };
    }
    return setPluginStorageValue(validated.pluginId, validated.key, validated.value);
  });

  const storageDeleteChannel = pluginsChannels['plugins:storage-delete'];
  registerHandler(storageDeleteChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = storageDeleteChannel.request.parse(request);
    if (!(await isKnownPlugin(validated.pluginId))) {
      log.warn({ pluginId: validated.pluginId }, 'Storage delete rejected: unknown pluginId');
      return { success: false };
    }
    await deletePluginStorageValue(validated.pluginId, validated.key);
    return { success: true };
  });

  const storageClearChannel = pluginsChannels['plugins:storage-clear'];
  registerHandler(storageClearChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = storageClearChannel.request.parse(request);
    if (!(await isKnownPlugin(validated.pluginId))) {
      log.warn({ pluginId: validated.pluginId }, 'Storage clear rejected: unknown pluginId');
      return { success: false };
    }
    await clearPluginStorage(validated.pluginId);
    return { success: true };
  });

  const storageUsageChannel = pluginsChannels['plugins:storage-usage'];
  registerHandler(storageUsageChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = storageUsageChannel.request.parse(request);
    if (!(await isKnownPlugin(validated.pluginId))) {
      log.warn({ pluginId: validated.pluginId }, 'Storage usage rejected: unknown pluginId');
      return { usedBytes: 0, quotaBytes: 0, percentUsed: 0 };
    }
    return getPluginStorageUsage(validated.pluginId);
  });

  // ── Plugin Data Export/Import ──────────────────────────────────────────

  const exportDataChannel = pluginsChannels['plugins:export-data'];
  registerHandler(exportDataChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = exportDataChannel.request.parse(request);
    const { pluginId } = validated;

    if (!(await isKnownPlugin(pluginId))) {
      log.warn({ pluginId }, 'Export data rejected: unknown pluginId');
      return { ok: false, error: 'Unknown plugin.' };
    }

    let data: Record<string, unknown>;
    try {
      data = await getPluginDataBackend().exportAll(pluginId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ pluginId, error: message }, 'Failed to export plugin data');
      return { ok: false, error: `Failed to read plugin data: ${message}` };
    }

    const envelope = {
      version: 1,
      pluginId,
      exportedAt: new Date().toISOString(),
      data,
    };

    const suggestedName = `${pluginId}-data.json`;
    const saveResult = await dialog.showSaveDialog({
      title: 'Export Plugin Data',
      defaultPath: suggestedName,
      filters: [
        { name: 'JSON', extensions: ['json'] },
      ],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return { ok: false, error: 'Export cancelled.' };
    }

    try {
      await fs.writeFile(saveResult.filePath, JSON.stringify(envelope, null, 2), 'utf-8');
      log.info({ pluginId, filePath: saveResult.filePath }, 'Plugin data exported successfully');
      return { ok: true, filePath: saveResult.filePath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ pluginId, error: message }, 'Failed to write plugin data export file');
      return { ok: false, error: `Failed to write file: ${message}` };
    }
  });

  const importDataChannel = pluginsChannels['plugins:import-data'];
  registerHandler(importDataChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = importDataChannel.request.parse(request);
    const { pluginId } = validated;

    if (!(await isKnownPlugin(pluginId))) {
      log.warn({ pluginId }, 'Import data rejected: unknown pluginId');
      return { ok: false, error: 'Unknown plugin.' };
    }

    const openResult = await dialog.showOpenDialog({
      title: 'Import Plugin Data',
      properties: ['openFile'],
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (openResult.canceled || openResult.filePaths.length === 0) {
      return { ok: false, error: 'Import cancelled.' };
    }

    const filePath = openResult.filePaths[0];

    let rawContent: string;
    try {
      rawContent = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Failed to read file: ${message}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      return { ok: false, error: 'Invalid JSON: the file does not contain valid JSON.' };
    }

    // Validate structure
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('version' in parsed) ||
      !('pluginId' in parsed) ||
      !('data' in parsed)
    ) {
      return { ok: false, error: 'Invalid data file: missing "version", "pluginId", or "data" fields.' };
    }

    const envelope = parsed as Record<string, unknown>;

    if (typeof envelope.version !== 'number') {
      return { ok: false, error: 'Invalid data file: "version" must be a number.' };
    }

    if (typeof envelope.pluginId !== 'string') {
      return { ok: false, error: 'Invalid data file: "pluginId" must be a string.' };
    }

    if (!envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) {
      return { ok: false, error: 'Invalid data file: "data" must be a JSON object.' };
    }

    // Verify pluginId matches
    if (envelope.pluginId !== pluginId) {
      return {
        ok: false,
        error: `Plugin ID mismatch: file contains data for "${envelope.pluginId}" but you are importing into "${pluginId}".`,
      };
    }

    // Proto-pollution protection: reject dangerous keys
    const dataObj = envelope.data as Record<string, unknown>;
    const dangerousKeys = ['__proto__', 'constructor', 'prototype'];
    for (const key of Object.keys(dataObj)) {
      if (dangerousKeys.includes(key)) {
        return { ok: false, error: `Import rejected: data contains a forbidden key "${key}".` };
      }
    }

    // Check import size against quota (10MB)
    const PLUGIN_QUOTA_BYTES = 10 * 1024 * 1024;
    const importSize = new TextEncoder().encode(JSON.stringify(dataObj)).byteLength;
    if (importSize > PLUGIN_QUOTA_BYTES) {
      return { ok: false, error: `Import rejected: data size (${importSize} bytes) exceeds the 10 MB storage quota.` };
    }

    // Confirm with user before overwriting
    const confirmResult = await dialog.showMessageBox({
      type: 'warning',
      title: 'Import Plugin Data',
      message: `This will replace all data for "${pluginId}". Continue?`,
      detail: `${Object.keys(dataObj).length} key(s) will be imported from the file.`,
      buttons: ['Cancel', 'Replace Data'],
      defaultId: 0,
      cancelId: 0,
    });

    if (confirmResult.response === 0) {
      return { ok: false, error: 'Import cancelled by user.' };
    }

    // Clear existing data and import new data
    try {
      const backend = getPluginDataBackend();
      await backend.clear(pluginId);
      for (const [key, value] of Object.entries(dataObj)) {
        const setResult = await backend.set(pluginId, key, value);
        if (!setResult.ok) {
          log.warn({ pluginId, key, error: setResult.error }, 'Plugin data import: set failed for key');
        }
      }
      log.info({ pluginId, filePath, keyCount: Object.keys(dataObj).length }, 'Plugin data imported successfully');
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ pluginId, error: message }, 'Failed to import plugin data');
      return { ok: false, error: `Failed to import data: ${message}` };
    }
  });

  // ── Plugin Data Backup/Restore ────────────────────────────────────────

  const restoreBackupChannel = pluginsChannels['plugins:restore-data-backup'];
  registerHandler(restoreBackupChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = restoreBackupChannel.request.parse(request);
    const { pluginId } = validated;

    if (!(await isKnownPlugin(pluginId))) {
      log.warn({ pluginId }, 'Restore data backup rejected: unknown pluginId');
      return { ok: false, error: 'Unknown plugin.' };
    }

    try {
      const restored = await restorePluginDataBackup(pluginId);
      if (!restored) {
        return { ok: false, error: 'No backup found for this plugin.' };
      }
      log.info({ pluginId }, 'Plugin data restored from backup via IPC');
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ pluginId, error: message }, 'Failed to restore plugin data from backup');
      return { ok: false, error: `Failed to restore data: ${message}` };
    }
  });

  const hasBackupChannel = pluginsChannels['plugins:has-data-backup'];
  registerHandler(hasBackupChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = hasBackupChannel.request.parse(request);
    const { pluginId } = validated;

    if (!(await isKnownPlugin(pluginId))) {
      return { hasBackup: false };
    }

    try {
      const exists = await hasPluginDataBackup(pluginId);
      return { hasBackup: exists };
    } catch {
      return { hasBackup: false };
    }
  });

  // ── Plugin Export/Import ──────────────────────────────────────────────

  const exportChannel = pluginsChannels['plugins:export-plugin'];
  registerHandler(exportChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = exportChannel.request.parse(request);
    const { pluginId } = validated;

    const allPlugins = await loadPersistedPluginEntries();
    const plugin = allPlugins.find((p) => p.manifest.id === pluginId);
    if (!plugin) {
      return { ok: false, error: `Plugin "${pluginId}" not found in persisted storage.` };
    }

    const suggestedName = `${pluginId}.rebel-plugin.json`;
    const saveResult = await dialog.showSaveDialog({
      title: 'Export Plugin',
      defaultPath: suggestedName,
      filters: [
        { name: 'Rebel Plugin', extensions: ['rebel-plugin.json'] },
        { name: 'JSON', extensions: ['json'] },
      ],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return { ok: false, error: 'Export cancelled.' };
    }

    const exportData = {
      version: 1,
      plugin: {
        manifest: {
          id: plugin.manifest.id,
          name: plugin.manifest.name,
          description: plugin.manifest.description,
          version: plugin.manifest.version,
          ...(plugin.manifest.forkedFrom ? { forkedFrom: plugin.manifest.forkedFrom } : {}),
          ...(plugin.manifest.documentation ? { documentation: plugin.manifest.documentation } : {}),
        },
        source: plugin.source,
      },
    };

    try {
      await fs.writeFile(saveResult.filePath, JSON.stringify(exportData, null, 2), 'utf-8');
      log.info({ pluginId, filePath: saveResult.filePath }, 'Plugin exported successfully');
      return { ok: true, filePath: saveResult.filePath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ pluginId, error: message }, 'Failed to write plugin export file');
      return { ok: false, error: `Failed to write file: ${message}` };
    }
  });

  const importChannel = pluginsChannels['plugins:import-plugin'];
  registerHandler(importChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    importChannel.request.parse(request);

    const openResult = await dialog.showOpenDialog({
      title: 'Import Plugin',
      properties: ['openFile'],
      filters: [
        { name: 'Rebel Plugin', extensions: ['rebel-plugin.json', 'json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (openResult.canceled || openResult.filePaths.length === 0) {
      return { ok: false, error: 'Import cancelled.' };
    }

    const filePath = openResult.filePaths[0];

    let rawContent: string;
    try {
      rawContent = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Failed to read file: ${message}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      return { ok: false, error: 'Invalid JSON: the file does not contain valid JSON.' };
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('version' in parsed) ||
      !('plugin' in parsed)
    ) {
      return { ok: false, error: 'Invalid plugin file: missing "version" or "plugin" fields.' };
    }

    const data = parsed as Record<string, unknown>;
    const pluginData = data.plugin as Record<string, unknown> | undefined;

    if (
      !pluginData ||
      typeof pluginData !== 'object' ||
      !('manifest' in pluginData) ||
      !('source' in pluginData)
    ) {
      return { ok: false, error: 'Invalid plugin file: missing "plugin.manifest" or "plugin.source" fields.' };
    }

    const manifest = pluginData.manifest as Record<string, unknown> | undefined;
    const source = pluginData.source;

    if (!manifest || typeof manifest !== 'object' || !manifest.id || !manifest.name) {
      return { ok: false, error: 'Invalid plugin manifest: "id" and "name" are required.' };
    }

    if (typeof source !== 'string' || source.trim().length === 0) {
      return { ok: false, error: 'Invalid plugin source: must be a non-empty string.' };
    }

    log.info({ pluginId: manifest.id, filePath }, 'Plugin imported successfully');
    return {
      ok: true,
      manifest: {
        id: String(manifest.id),
        name: String(manifest.name),
        description: manifest.description ? String(manifest.description) : undefined,
        version: manifest.version ? String(manifest.version) : undefined,
        forkedFrom: manifest.forkedFrom ? String(manifest.forkedFrom) : undefined,
        documentation: manifest.documentation ? String(manifest.documentation) : undefined,
      },
      source: source as string,
    };
  });

  // ── Space Plugin Discovery & Management ───────────────────────────────

  const scanSpacesChannel = pluginsChannels['plugins:scan-spaces'];
  registerHandler(scanSpacesChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    scanSpacesChannel.request.parse(request);
    const { scanSpacePlugins } = await import('../../services/pluginSpaceService');
    return scanSpacePlugins();
  });

  const exportToSpaceChannel = pluginsChannels['plugins:export-to-space'];
  registerHandler(exportToSpaceChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = exportToSpaceChannel.request.parse(request);
    const { exportPluginToSpace } = await import('../../services/pluginSpaceService');
    return exportPluginToSpace(validated.pluginId, validated.spacePath, validated.role);
  });

  const resolveConflictChannel = pluginsChannels['plugins:resolve-conflict'];
  registerHandler(resolveConflictChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = resolveConflictChannel.request.parse(request);
    const { resolvePluginConflict } = await import('../../services/pluginConflictService');
    return resolvePluginConflict(validated.pluginId, validated.spacePath, validated.resolution);
  });

  const rebelMergeChannel = pluginsChannels['plugins:rebel-merge'];
  registerHandler(rebelMergeChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = rebelMergeChannel.request.parse(request);
    const { proposeMerge } = await import('../../services/pluginConflictService');
    return proposeMerge(validated.pluginId, validated.spacePath);
  });

  const acceptMergeChannel = pluginsChannels['plugins:accept-merge'];
  registerHandler(acceptMergeChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = acceptMergeChannel.request.parse(request);
    const { acceptMerge } = await import('../../services/pluginConflictService');
    return acceptMerge(
      validated.pluginId,
      validated.spacePath,
      validated.mergedManifest,
      validated.mergedSource,
    );
  });

  // ── Activation / Deactivation ─────────────────────────────────────────

  const getActivatedChannel = pluginsChannels['plugins:get-activated'];
  registerHandler(getActivatedChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    getActivatedChannel.request.parse(request);
    return { pluginIds: getActivatedPluginIds() };
  });

  const addActivatedChannel = pluginsChannels['plugins:add-activated'];
  registerHandler(addActivatedChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = addActivatedChannel.request.parse(request);
    addActivatedPluginId(validated.pluginId);
    return { success: true };
  });

  const removeActivatedChannel = pluginsChannels['plugins:remove-activated'];
  registerHandler(removeActivatedChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = removeActivatedChannel.request.parse(request);
    removeActivatedPluginId(validated.pluginId);
    return { success: true };
  });

  const getDeactivatedChannel = pluginsChannels['plugins:get-deactivated'];
  registerHandler(getDeactivatedChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    getDeactivatedChannel.request.parse(request);
    return { pluginIds: getDeactivatedPluginIds() };
  });

  const getPendingReviewChannel = pluginsChannels['plugins:get-pending-review'];
  registerHandler(getPendingReviewChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    getPendingReviewChannel.request.parse(request);
    return { pluginIds: getPendingReviewPluginIds() };
  });

  const addDeactivatedChannel = pluginsChannels['plugins:add-deactivated'];
  registerHandler(addDeactivatedChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = addDeactivatedChannel.request.parse(request);
    addDeactivatedPluginId(validated.pluginId);
    return { success: true };
  });

  const removeDeactivatedChannel = pluginsChannels['plugins:remove-deactivated'];
  registerHandler(removeDeactivatedChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = removeDeactivatedChannel.request.parse(request);
    removeDeactivatedPluginId(validated.pluginId);
    return { success: true };
  });

  // ── Plugin Indexing ───────────────────────────────────────────────────

  const indexReadmeChannel = pluginsChannels['plugins:index-readme'];
  registerHandler(indexReadmeChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = indexReadmeChannel.request.parse(request);
    const workspacePath = getSettings().coreDirectory;
    if (!workspacePath) {
      return { success: false };
    }

    const pluginDir = path.join(validated.spacePath, 'plugins', validated.pluginId);
    const { indexPluginReadme } = await import('../../services/pluginIndexService');
    await indexPluginReadme(pluginDir, workspacePath);

    return { success: true };
  });

  const deindexReadmeChannel = pluginsChannels['plugins:deindex-readme'];
  registerHandler(deindexReadmeChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = deindexReadmeChannel.request.parse(request);
    const pluginDir = path.join(validated.spacePath, 'plugins', validated.pluginId);
    const { deindexPluginReadme } = await import('../../services/pluginIndexService');
    await deindexPluginReadme(pluginDir);
    return { success: true };
  });

  // ── Plugin Deletion (Space plugin file removal) ──────────────────────

  const deleteFromSpaceChannel = pluginsChannels['plugins:delete-from-space'];
  registerHandler(deleteFromSpaceChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = deleteFromSpaceChannel.request.parse(request);
    const { deletePluginFromSpace } = await import('../../services/pluginSpaceService');
    const deleted = await deletePluginFromSpace(validated.pluginId, validated.spacePath);
    return { success: deleted };
  });

  // ── Plugin Migration (electron-store → Chief-of-Staff) ───────────────

  const migrateChannel = pluginsChannels['plugins:migrate-to-space'];
  registerHandler(migrateChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    migrateChannel.request.parse(request);
    const { migratePluginsToSpace } = await import('../../services/pluginSpaceService');
    return migratePluginsToSpace();
  });

  const seedChannel = pluginsChannels['plugins:seed-bundled'];
  registerHandler(seedChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = seedChannel.request.parse(request);
    const { seedBundledPluginsToSpace } = await import('../../services/bundledPluginsService');
    return seedBundledPluginsToSpace({ alreadySeededIds: validated.alreadySeededIds });
  });
}
