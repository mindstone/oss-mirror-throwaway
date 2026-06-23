/**
 * Plugin Storage Adapter
 *
 * Defines a storage interface for plugin persistence, decoupling the
 * registry from any particular backend (electron-store, Space files, etc.).
 *
 * W4-0 preparatory refactor — enables W4-3 to add Space-file storage
 * alongside the existing electron-store backend.
 *
 * @see docs/plans/260324_wave4_plugin_sharing_maturity.md
 */

import type { PluginManifest } from './pluginManifest';

// ── Storage Adapter Interface ──────────────────────────────────────────

export interface PersistedPluginEntry {
  manifest: PluginManifest;
  source: string;
}

/**
 * Abstraction for loading/saving plugin data.
 *
 * Implementations:
 * - `ElectronStorePluginAdapter` — uses window.pluginsApi IPC (current default)
 * - Future: `SpaceFilePluginAdapter` — reads/writes plugin folders in Spaces
 */
export interface PluginStorageAdapter {
  loadAll(): Promise<PersistedPluginEntry[]>;
  saveAll(plugins: PersistedPluginEntry[]): Promise<void>;
  clear(): Promise<void>;
}

// ── Electron-Store Adapter ─────────────────────────────────────────────

/**
 * Default adapter that delegates to the existing electron-store IPC bridge
 * (`window.pluginsApi.persistAll` / `loadPersisted` / `clearPersisted`).
 */
export class ElectronStorePluginAdapter implements PluginStorageAdapter {
  async loadAll(): Promise<PersistedPluginEntry[]> {
    if (typeof window === 'undefined' || !window.pluginsApi?.loadPersisted) {
      return [];
    }
    const { plugins } = await window.pluginsApi.loadPersisted();
    return plugins as PersistedPluginEntry[];
  }

  async saveAll(plugins: PersistedPluginEntry[]): Promise<void> {
    if (typeof window === 'undefined' || !window.pluginsApi?.persistAll) {
      return;
    }
    await window.pluginsApi.persistAll({ plugins });
  }

  async clear(): Promise<void> {
    if (typeof window === 'undefined' || !window.pluginsApi?.clearPersisted) {
      return;
    }
    await window.pluginsApi.clearPersisted();
  }
}

// ── Catalog Types ──────────────────────────────────────────────────────

/**
 * A plugin known to the system — may or may not be currently active.
 *
 * Used by the plugin catalog (W4-4) to show "Available from Space" plugins
 * alongside locally-active ones.
 */
export interface CatalogPlugin {
  manifest: PluginManifest;
  source: string;
  /** Filesystem path within a Space (e.g. "/Users/.../SpaceName/plugins/my-plugin") */
  spacePath?: string;
  /** Whether this plugin is currently compiled and registered in the active registry */
  isActive: boolean;
  /**
   * Agent-created plugin that requested elevated permissions and is awaiting the
   * user's security review before it can run (Stage 3A). Distinct from a plain
   * inactive plugin: the row shows a "Needs review" affordance and a
   * "Review & enable" CTA. Cleared once the user enables it.
   */
  isPendingReview?: boolean;
}
