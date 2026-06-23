/**
 * Plugin Data File Backend
 *
 * File-based implementation of PluginDataBackend. Stores each plugin's
 * key-value data as a single `data.json` file:
 *   {userData}/plugin-data/{pluginId}/data.json
 *
 * Keys are JSON object keys (arbitrary strings — no sanitization needed).
 * Uses an in-memory cache loaded lazily on first access and flushed to
 * disk atomically on write with a 500ms debounce.
 *
 * Legacy migration: On first access for any plugin, checks the old
 * `plugin-storage` electron-store blob. If data exists for that pluginId,
 * it's written as a per-plugin `data.json` file.
 *
 * @see docs/plans/260408_plugin_data_storage_robustness.md (Stage 2)
 * @see src/core/services/pluginDataBackend.ts — interface definition
 * @see src/main/services/pluginFilePersistence.ts — atomic write pattern
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';
import { createStore } from '@core/storeFactory';
import { fireAndForget } from '@shared/utils/fireAndForget';
import type { KeyValueStore } from '@core/store';
import type { PluginDataBackend } from '@core/services/pluginDataBackend';
import { atomicWriteFile } from '@core/utils/atomicFileWrite';

const log = createScopedLogger({ service: 'pluginDataFileBackend' });

// ── Atomic file writes ──────────────────────────────────────────────────

/**
 * Thin throwing adapter around `atomicWriteFile` so existing call sites that
 * relied on rejection-on-failure semantics continue to work unchanged.
 *
 * @see src/core/utils/atomicFileWrite.ts — canonical atomic write
 */
async function safeWriteFile(filePath: string, content: string): Promise<void> {
  const result = await atomicWriteFile(filePath, content);
  if (!result.durable) {
    const err = new Error(result.error || `Atomic write failed for ${filePath}`) as NodeJS.ErrnoException;
    if (result.errorCode && result.errorCode !== 'UNKNOWN') {
      err.code = result.errorCode;
    }
    throw err;
  }
}

// ── Legacy store types ──────────────────────────────────────────────────

type LegacyPluginStorageState = {
  version: number;
  data: Record<string, Record<string, unknown>>;
};

// ── Scope resolver type ─────────────────────────────────────────────────

/**
 * Resolves where a plugin's data should be stored based on its manifest `storageScope`.
 *
 * - `'local'`  → `{userData}/plugin-data/{pluginId}` (default, per-user)
 * - `'shared'` → `{spacePath}/plugins/{pluginId}` (colocated with plugin code in Space)
 */
export type ScopeResolver = (pluginId: string) => Promise<{ scope: 'local' | 'shared'; dataDir: string }>;

// ── Implementation ──────────────────────────────────────────────────────

export class PluginDataFileBackend implements PluginDataBackend {
  /** In-memory cache: pluginId → { key: value, ... } */
  private cache = new Map<string, Record<string, unknown>>();

  /** Tracks which plugins have been checked for legacy migration */
  private migratedPlugins = new Set<string>();

  /** Debounce timers per plugin for flushing to disk */
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Pending flush promises for awaiting in tests / shutdown */
  private flushPromises = new Map<string, Promise<void>>();

  /** Base directory for plugin data files */
  private baseDir: string | null = null;

  /** Lazy reference to the legacy electron-store (for one-time migration) */
  private legacyStore: KeyValueStore<LegacyPluginStorageState> | null = null;
  private legacyStoreLoaded = false;

  /** Optional scope resolver — when set, routes data to local or shared dirs */
  private scopeResolver: ScopeResolver | null = null;

  /** Cached resolved data directories per plugin (scope doesn't change at runtime) */
  private resolvedDirs = new Map<string, string>();

  /** Cached resolved scopes per plugin */
  private resolvedScopes = new Map<string, 'local' | 'shared'>();

  // ── Scope resolver ────────────────────────────────────────────────────

  /**
   * Set a scope resolver that determines where each plugin's data.json lives.
   * Must be called after construction, before first data access.
   */
  setScopeResolver(resolver: ScopeResolver): void {
    this.scopeResolver = resolver;
  }

  // ── Path helpers ────────────────────────────────────────────────────

  private getBaseDir(): string {
    if (!this.baseDir) {
      this.baseDir = path.join(getDataPath(), 'plugin-data');
    }
    return this.baseDir;
  }

  private getLocalPluginDir(pluginId: string): string {
    return path.join(this.getBaseDir(), pluginId);
  }

  /**
   * Resolve the data directory for a plugin, using the scope resolver if set.
   * Result is cached — a plugin's scope doesn't change at runtime.
   */
  private async getPluginDir(pluginId: string): Promise<string> {
    const cached = this.resolvedDirs.get(pluginId);
    if (cached) return cached;

    if (this.scopeResolver) {
      try {
        const { scope, dataDir } = await this.scopeResolver(pluginId);
        this.resolvedDirs.set(pluginId, dataDir);
        this.resolvedScopes.set(pluginId, scope);
        return dataDir;
      } catch (err) {
        log.warn({ pluginId, err }, 'Scope resolver failed — falling back to local storage');
      }
    }

    // No resolver or resolver failed — use local path
    const localDir = this.getLocalPluginDir(pluginId);
    this.resolvedDirs.set(pluginId, localDir);
    return localDir;
  }

  private async getDataFilePath(pluginId: string): Promise<string> {
    const dir = await this.getPluginDir(pluginId);
    return path.join(dir, 'data.json');
  }

  // ── Legacy migration ───────────────────────────────────────────────

  /**
   * Lazily load the legacy `plugin-storage` electron-store.
   * Returns null if the store doesn't exist or has no data.
   */
  private getLegacyStore(): KeyValueStore<LegacyPluginStorageState> | null {
    if (this.legacyStoreLoaded) return this.legacyStore;
    this.legacyStoreLoaded = true;

    try {
      this.legacyStore = createStore<LegacyPluginStorageState>({
        name: 'plugin-storage',
        defaults: { version: 1, data: {} },
      });
    } catch (err) {
      log.warn({ err }, 'Failed to load legacy plugin-storage store for migration');
      this.legacyStore = null;
    }
    return this.legacyStore;
  }

  /**
   * On first access for a plugin, check if legacy data exists and migrate it.
   * This is a one-time operation per plugin per app session.
   */
  private async ensureMigrated(pluginId: string): Promise<void> {
    if (this.migratedPlugins.has(pluginId)) return;
    this.migratedPlugins.add(pluginId);

    // If cache already has data for this plugin (loaded from disk), skip migration
    if (this.cache.has(pluginId)) return;

    // Check if data.json already exists on disk (already migrated in a previous session)
    const dataPath = await this.getDataFilePath(pluginId);
    try {
      await fs.access(dataPath);
      // File exists — load it into cache and skip migration
      await this.loadFromDisk(pluginId);
      return;
    } catch {
      // File doesn't exist — check legacy store
    }

    const legacy = this.getLegacyStore();
    if (!legacy) return;

    const allData = legacy.get('data');
    if (!allData || typeof allData !== 'object') return;

    const pluginData = allData[pluginId];
    if (!pluginData || typeof pluginData !== 'object' || Object.keys(pluginData).length === 0) return;

    // Migrate: write legacy data to per-plugin data.json
    log.info({ pluginId, keyCount: Object.keys(pluginData).length }, 'Migrating plugin data from legacy store');
    this.cache.set(pluginId, { ...pluginData });
    await this.flushToDiskImmediate(pluginId);
  }

  // ── Disk I/O ──────────────────────────────────────────────────────────

  /**
   * Load plugin data from disk into cache.
   * Returns empty object if file doesn't exist or is corrupt.
   */
  private async loadFromDisk(pluginId: string): Promise<Record<string, unknown>> {
    const dataPath = await this.getDataFilePath(pluginId);
    try {
      const raw = await fs.readFile(dataPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.cache.set(pluginId, parsed as Record<string, unknown>);
        return parsed as Record<string, unknown>;
      }
      log.warn({ pluginId, dataPath }, 'Plugin data.json is not a valid object — treating as empty');
      this.cache.set(pluginId, {});
      return {};
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        log.warn({ pluginId, err }, 'Failed to read plugin data.json — treating as empty');
      }
      this.cache.set(pluginId, {});
      return {};
    }
  }

  /**
   * Flush plugin data from cache to disk immediately (no debounce).
   * Used for migration and explicit flush scenarios.
   */
  private async flushToDiskImmediate(pluginId: string): Promise<void> {
    const data = this.cache.get(pluginId);
    if (!data) return;

    const pluginDir = await this.getPluginDir(pluginId);
    await fs.mkdir(pluginDir, { recursive: true });

    const content = JSON.stringify(data, null, 2);
    await safeWriteFile(await this.getDataFilePath(pluginId), content);
  }

  /**
   * Schedule a debounced flush of plugin data to disk.
   * Coalesces multiple writes within 500ms into a single disk write.
   */
  private scheduleDebouncedFlush(pluginId: string): void {
    // Clear any existing timer for this plugin
    const existingTimer = this.flushTimers.get(pluginId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const promise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        fireAndForget((async () => {
        this.flushTimers.delete(pluginId);
        try {
          await this.flushToDiskImmediate(pluginId);
        } catch (err) {
          log.error({ pluginId, err }, 'Failed to flush plugin data to disk');
        }
        this.flushPromises.delete(pluginId);
        resolve();
        })(), 'pluginData.debouncedFlush');
      }, 500);
      this.flushTimers.set(pluginId, timer);
    });
    this.flushPromises.set(pluginId, promise);
  }

  // ── Ensure cache loaded ───────────────────────────────────────────────

  /**
   * Ensure data for this plugin is in cache (from disk or empty).
   *
   * Shared-scope plugins always read from disk (another user may have changed
   * the file via cloud sync). Local-scope plugins use the in-memory cache.
   */
  private async ensureCached(pluginId: string): Promise<Record<string, unknown>> {
    await this.ensureMigrated(pluginId);

    // Shared-scope: always read from disk (another user may have changed the file)
    const isShared = this.resolvedScopes.get(pluginId) === 'shared';
    if (isShared) {
      return this.loadFromDisk(pluginId);
    }

    // Local-scope: use cache
    const cached = this.cache.get(pluginId);
    if (cached !== undefined) return cached;
    return this.loadFromDisk(pluginId);
  }

  // ── Public API (PluginDataBackend interface) ──────────────────────────

  async get(pluginId: string, key: string): Promise<unknown> {
    const data = await this.ensureCached(pluginId);
    return data[key];
  }

  async set(
    pluginId: string,
    key: string,
    value: unknown,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const data = await this.ensureCached(pluginId);
    data[key] = value;
    this.cache.set(pluginId, data);
    this.scheduleDebouncedFlush(pluginId);
    return { ok: true };
  }

  async delete(pluginId: string, key: string): Promise<void> {
    const data = await this.ensureCached(pluginId);
    delete data[key];
    this.cache.set(pluginId, data);
    this.scheduleDebouncedFlush(pluginId);
  }

  async clear(pluginId: string): Promise<void> {
    // Clear from cache
    this.cache.delete(pluginId);
    this.migratedPlugins.delete(pluginId);

    // Cancel any pending flush
    const timer = this.flushTimers.get(pluginId);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(pluginId);
      this.flushPromises.delete(pluginId);
    }

    // Remove the data file from disk.
    // For shared scope, only delete data.json (not the plugin directory which
    // also contains manifest.json and source files). For local scope, remove
    // the entire plugin data directory since it only contains our data.
    const pluginDir = await this.getPluginDir(pluginId);
    const isShared = this.resolvedScopes.get(pluginId) === 'shared';

    try {
      if (isShared) {
        // Shared scope: only delete data.json, preserve plugin code files
        const dataFile = path.join(pluginDir, 'data.json');
        await fs.unlink(dataFile);
      } else {
        // Local scope: safe to delete entire directory (only contains our data)
        await fs.rm(pluginDir, { recursive: true, force: true });
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        log.warn({ pluginId, err }, 'Failed to remove plugin data');
      }
    }
    log.info({ pluginId }, 'Cleared plugin data');
  }

  async getUsageBytes(pluginId: string): Promise<number> {
    const data = await this.ensureCached(pluginId);
    return new TextEncoder().encode(JSON.stringify(data)).byteLength;
  }

  async exportAll(pluginId: string): Promise<Record<string, unknown>> {
    const data = await this.ensureCached(pluginId);
    return { ...data };
  }

  async backupData(pluginId: string): Promise<boolean> {
    // Ensure any pending writes are flushed before backing up
    await this._waitForPendingFlushes();

    const dataPath = await this.getDataFilePath(pluginId);
    const backupPath = dataPath.replace(/data\.json$/, 'data.backup.json');

    try {
      await fs.access(dataPath);
    } catch {
      // No data.json to back up
      return false;
    }

    try {
      await fs.copyFile(dataPath, backupPath);
      log.info({ pluginId }, 'Plugin data backed up before update');
      return true;
    } catch (err) {
      log.warn({ pluginId, err }, 'Failed to create plugin data backup');
      return false;
    }
  }

  async restoreBackup(pluginId: string): Promise<boolean> {
    const dataPath = await this.getDataFilePath(pluginId);
    const backupPath = dataPath.replace(/data\.json$/, 'data.backup.json');

    try {
      await fs.access(backupPath);
    } catch {
      return false;
    }

    try {
      // Validate backup content before restoring — reject corrupt/non-object JSON
      const raw = await fs.readFile(backupPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        log.warn({ pluginId }, 'Backup file contains invalid data (not a JSON object) — refusing to restore');
        return false;
      }

      await fs.copyFile(backupPath, dataPath);

      // Reload cache from the restored file
      this.cache.delete(pluginId);
      this.migratedPlugins.delete(pluginId);
      await this.loadFromDisk(pluginId);

      // Remove backup file after successful restore
      await fs.unlink(backupPath);
      log.info({ pluginId }, 'Plugin data restored from backup');
      return true;
    } catch (err) {
      log.warn({ pluginId, err }, 'Failed to restore plugin data from backup');
      return false;
    }
  }

  async hasBackup(pluginId: string): Promise<boolean> {
    const dataPath = await this.getDataFilePath(pluginId);
    const backupPath = dataPath.replace(/data\.json$/, 'data.backup.json');

    try {
      await fs.access(backupPath);
      return true;
    } catch {
      return false;
    }
  }

  // ── Test utilities ────────────────────────────────────────────────────

  /**
   * Wait for all pending debounced flushes to complete.
   * Useful in tests to ensure data is written to disk.
   */
  async _waitForPendingFlushes(): Promise<void> {
    const promises = Array.from(this.flushPromises.values());
    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  /**
   * Reset all internal state — for test use only.
   */
  _resetForTests(): void {
    // Clear all flush timers
    for (const timer of this.flushTimers.values()) {
      clearTimeout(timer);
    }
    this.flushTimers.clear();
    this.flushPromises.clear();
    this.cache.clear();
    this.migratedPlugins.clear();
    this.resolvedDirs.clear();
    this.resolvedScopes.clear();
    this.baseDir = null;
    this.legacyStore = null;
    this.legacyStoreLoaded = false;
    this.scopeResolver = null;
  }
}
