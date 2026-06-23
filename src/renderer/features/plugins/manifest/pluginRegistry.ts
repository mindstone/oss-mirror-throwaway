/**
 * Plugin Registry
 *
 * In-memory store of registered plugins with three separated concerns:
 *
 * 1. **Runtime active registry** — tracks compiled/active plugins that render
 *    as main-pane tabs. Read via `useRegisteredPlugins()`.
 * 2. **Plugin catalog** — list of all known plugins (active + available-but-
 *    not-active). Populated by W4-4 with Space-discovered plugins.
 * 3. **Storage adapter** — pluggable persistence backend; defaults to
 *    `ElectronStorePluginAdapter` (electron-store IPC).
 *
 * @see docs/plans/260324_wave4_plugin_sharing_maturity.md
 * @see docs/plans/260322_plugin_extension_system.md
 */

import type { PluginManifest } from './pluginManifest';
import { validateManifest } from './pluginManifest';
import type { PluginStorageAdapter, CatalogPlugin, PersistedPluginEntry } from './pluginStorageAdapter';
import { ElectronStorePluginAdapter } from './pluginStorageAdapter';
import { clearPluginCrashes } from '../runtime/pluginDiagnostics';

// ── Types ──────────────────────────────────────────────────────────────

export type { CatalogPlugin } from './pluginStorageAdapter';

export interface RegisteredPlugin {
  manifest: PluginManifest;
  source: string;
  registeredAt: number;
}

type Listener = () => void;

// ── Constants ──────────────────────────────────────────────────────────

const PLUGIN_PERSIST_DEBOUNCE_MS = 300;

// ── Runtime Active Registry ────────────────────────────────────────────

const plugins = new Map<string, RegisteredPlugin>();
const listeners = new Set<Listener>();
let cachedSnapshot: RegisteredPlugin[] = [];

function notify() {
  cachedSnapshot = Array.from(plugins.values());
  for (const listener of listeners) {
    listener();
  }
}

export function registerPlugin(manifest: PluginManifest, source: string): { ok: true } | { ok: false; error: string } {
  const validation = validateManifest(manifest);
  if (!validation.ok) return validation;

  plugins.set(manifest.id, {
    manifest: validation.manifest,
    source,
    registeredAt: Date.now(),
  });
  notify();
  return { ok: true };
}

export function unregisterPlugin(pluginId: string): boolean {
  const removed = plugins.delete(pluginId);
  if (removed) {
    clearPluginCrashes(pluginId);
    notify();
  }
  return removed;
}

export function getRegisteredPlugin(pluginId: string): RegisteredPlugin | undefined {
  return plugins.get(pluginId);
}

export function getPluginSource(pluginId: string): string | undefined {
  return plugins.get(pluginId)?.source;
}

export function getAllRegisteredPlugins(): RegisteredPlugin[] {
  return cachedSnapshot;
}

export function subscribeToPluginRegistry(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearPluginRegistry(): void {
  plugins.clear();
  notify();
}

// ── Plugin Catalog ─────────────────────────────────────────────────────

const catalogPlugins = new Map<string, CatalogPlugin>();
const catalogListeners = new Set<Listener>();
let cachedCatalogSnapshot: CatalogPlugin[] = [];

function notifyCatalog() {
  cachedCatalogSnapshot = Array.from(catalogPlugins.values());
  for (const listener of catalogListeners) {
    listener();
  }
}

export function setCatalogPlugins(entries: CatalogPlugin[]): void {
  catalogPlugins.clear();
  for (const entry of entries) {
    catalogPlugins.set(entry.manifest.id, entry);
  }
  notifyCatalog();
}

export function getCatalogPlugin(pluginId: string): CatalogPlugin | undefined {
  return catalogPlugins.get(pluginId);
}

export function getAllCatalogPlugins(): CatalogPlugin[] {
  return cachedCatalogSnapshot;
}

export function subscribeToCatalog(listener: Listener): () => void {
  catalogListeners.add(listener);
  return () => catalogListeners.delete(listener);
}

export function clearCatalog(): void {
  catalogPlugins.clear();
  notifyCatalog();
}

// ── Storage / Persistence Adapter ──────────────────────────────────────

let activeAdapter: PluginStorageAdapter = new ElectronStorePluginAdapter();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistenceCleanup: (() => void) | null = null;

/**
 * Replace the default storage adapter. Useful for testing or for
 * injecting a Space-file adapter in W4-3.
 */
export function setStorageAdapter(adapter: PluginStorageAdapter): void {
  activeAdapter = adapter;
}

/** Reset adapter to the default ElectronStorePluginAdapter. */
export function resetStorageAdapter(): void {
  activeAdapter = new ElectronStorePluginAdapter();
}

function getPersistablePlugins(): PersistedPluginEntry[] {
  return cachedSnapshot
    .filter((plugin) => !plugin.manifest.id.startsWith('__'))
    .map(({ manifest, source }) => ({ manifest, source }));
}

export async function persistRegisteredPlugins(): Promise<void> {
  try {
    await activeAdapter.saveAll(getPersistablePlugins());
  } catch (error) {
    console.warn('[pluginRegistry] Failed to persist plugins:', error);
  }
}

function schedulePersistRegisteredPlugins(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }

  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistRegisteredPlugins();
  }, PLUGIN_PERSIST_DEBOUNCE_MS);
}

export function initializePluginPersistence(): () => void {
  if (persistenceCleanup) {
    return persistenceCleanup;
  }

  const unsubscribe = subscribeToPluginRegistry(() => {
    schedulePersistRegisteredPlugins();
  });

  persistenceCleanup = () => {
    unsubscribe();
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    persistenceCleanup = null;
  };

  return persistenceCleanup;
}

export async function loadPersistedPlugins(): Promise<void> {
  try {
    const persistedPlugins = await activeAdapter.loadAll();
    const { compilePluginSource } = await import('../compiler/pluginCompiler');

    for (const persisted of persistedPlugins) {
      if (persisted.manifest.id.startsWith('__')) {
        continue;
      }

      const compiled = compilePluginSource(persisted.source);
      if (!compiled.ok) {
        console.warn(
          `[pluginRegistry] Skipping persisted plugin "${persisted.manifest.id}" due to compile errors.`,
          compiled.errors,
        );
        continue;
      }

      const result = registerPlugin(persisted.manifest, persisted.source);
      if (!result.ok) {
        console.warn(
          `[pluginRegistry] Skipping persisted plugin "${persisted.manifest.id}" due to manifest validation error: ${result.error}`,
        );
      }
    }
  } catch (error) {
    console.warn('[pluginRegistry] Failed to load persisted plugins:', error);
  }
}
