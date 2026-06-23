import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PluginConflict, SpacePluginInfo } from '@shared/ipc/schemas/plugins';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import type { PluginManifest } from '../manifest/pluginManifest';
import {
  getAllCatalogPlugins,
  getAllRegisteredPlugins,
  registerPlugin,
  setCatalogPlugins,
  unregisterPlugin,
  type CatalogPlugin,
  type RegisteredPlugin,
} from '../manifest/pluginRegistry';

interface SpacePluginsState {
  spacePlugins: CatalogPlugin[];
  conflicts: PluginConflict[];
  isLoading: boolean;
  error: string | null;
}

export interface UseSpacePluginsResult extends SpacePluginsState {
  refresh: () => void;
}

interface SpacePluginScanResult {
  plugins: SpacePluginInfo[];
  conflicts?: PluginConflict[];
}

export interface SpacePluginsControllerDeps {
  scanSpaces: () => Promise<SpacePluginScanResult>;
  onSpacePluginsChanged: (callback: () => void) => (() => void) | void;
  getActivatedPluginIds: () => Promise<string[]>;
  getDeactivatedPluginIds: () => Promise<string[]>;
  getPendingReviewPluginIds: () => Promise<string[]>;
  indexReadme: (pluginId: string, spacePath: string) => Promise<void>;
  deindexReadme: (pluginId: string, spacePath: string) => Promise<void>;
  getRegisteredPlugins: () => RegisteredPlugin[];
  registerPlugin: (manifest: PluginManifest, source: string) => { ok: true } | { ok: false; error: string };
  unregisterPlugin: (pluginId: string) => boolean;
  getCatalogPlugins: () => CatalogPlugin[];
  setCatalogPlugins: (entries: CatalogPlugin[]) => void;
  compileSource: (source: string) => Promise<boolean>;
}

export interface SpacePluginsController {
  start: () => void;
  stop: () => void;
  refresh: () => Promise<void>;
  getState: () => SpacePluginsState;
  subscribe: (listener: () => void) => () => void;
}

const DEFAULT_STATE: SpacePluginsState = {
  spacePlugins: [],
  conflicts: [],
  isLoading: false,
  error: null,
};

/**
 * Check if a space name refers to the Chief-of-Staff space (case-insensitive).
 * Chief-of-Staff plugins auto-activate without requiring explicit user opt-in.
 */
export function isChiefOfStaffSpace(spaceName: string): boolean {
  return spaceName.toLowerCase() === 'chief-of-staff';
}

// TODO(W4-4): When same plugin ID exists in multiple Spaces, the plan says
// user should pick which one to activate. Currently last-one-wins dedup.
// Surfacing duplicates requires additional UI design work.
function toCatalogEntries(
  plugins: SpacePluginInfo[],
  activePluginIds: Set<string>,
  pendingReviewPluginIds: Set<string>,
): CatalogPlugin[] {
  const deduped = new Map<string, CatalogPlugin>();

  for (const plugin of plugins) {
    const pluginId = plugin.manifest.id || plugin.pluginId;
    if (!pluginId) {
      continue;
    }

    const isActive = activePluginIds.has(pluginId);
    deduped.set(pluginId, {
      manifest: plugin.manifest as PluginManifest,
      source: plugin.source,
      spacePath: plugin.spacePath,
      isActive,
      // Only inactive plugins can be "pending review"; once active the review
      // is resolved (the store clears the flag on activation).
      isPendingReview: !isActive && pendingReviewPluginIds.has(pluginId),
    });
  }

  return Array.from(deduped.values()).sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

export async function syncSpacePluginsCatalog(
  deps: SpacePluginsControllerDeps,
): Promise<{ catalogEntries: CatalogPlugin[]; conflicts: PluginConflict[] }> {
  // Capture previously-known Space plugin IDs (and their spacePaths) before the
  // new scan replaces the catalog. This lets us detect deleted plugins later.
  const previousSpacePlugins = new Map<string, string>();
  for (const entry of deps.getCatalogPlugins()) {
    if (entry.spacePath) {
      previousSpacePlugins.set(entry.manifest.id, entry.spacePath);
    }
  }

  const scanResult = await deps.scanSpaces();
  const discoveredPlugins = scanResult.plugins ?? [];
  const discoveredConflicts = scanResult.conflicts ?? [];
  const activatedPluginIds = new Set(await deps.getActivatedPluginIds());
  const deactivatedPluginIds = new Set(await deps.getDeactivatedPluginIds());
  const pendingReviewPluginIds = new Set(await deps.getPendingReviewPluginIds());
  const activePluginIds = new Set(deps.getRegisteredPlugins().map((plugin) => plugin.manifest.id));
  const newDiscoveredIds = new Set(discoveredPlugins.map((p) => p.pluginId));

  for (const plugin of discoveredPlugins) {
    const isFromChiefOfStaff = isChiefOfStaffSpace(plugin.spaceName);

    // Skip plugins the user has explicitly disabled.
    if (deactivatedPluginIds.has(plugin.pluginId)) {
      continue;
    }

    // Chief-of-Staff plugins auto-activate (user's own plugins, no opt-in needed).
    // Team Space plugins require explicit activation via the activation store.
    if (!isFromChiefOfStaff && !activatedPluginIds.has(plugin.pluginId)) {
      continue;
    }

    // Always re-compile and re-register — even if already active — so that
    // source changes on disk are picked up on the next watcher-triggered scan.
    const isCompilable = await deps.compileSource(plugin.source);
    if (!isCompilable) {
      continue;
    }

    const wasAlreadyActive = activePluginIds.has(plugin.pluginId);
    const registration = deps.registerPlugin(plugin.manifest as PluginManifest, plugin.source);
    if (registration.ok) {
      activePluginIds.add(plugin.pluginId);
      // Only index README on first activation, not on hot-reload re-register
      if (!wasAlreadyActive) {
        try {
          await deps.indexReadme(plugin.pluginId, plugin.spacePath);
        } catch (error) {
          ignoreBestEffortCleanup(error, {
            operation: 'useSpacePlugins.syncSpacePluginsCatalog.indexReadme',
            reason: 'README indexing is best-effort; the plugin stays usable but unsearchable until the next scan',
            severity: 'warn',
          });
        }
      }
    }
  }

  // Clean up: unregister Space-origin plugins that were in the previous catalog
  // but are no longer discovered (e.g. deleted from disk). Only targets plugins
  // that came from Spaces — locally-created editor plugins are never in the catalog.
  for (const [pluginId, spacePath] of previousSpacePlugins) {
    if (!newDiscoveredIds.has(pluginId)) {
      deps.unregisterPlugin(pluginId);
      activePluginIds.delete(pluginId);
      try {
        await deps.deindexReadme(pluginId, spacePath);
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'useSpacePlugins.syncSpacePluginsCatalog.deindexReadme',
          reason: 'De-indexing the README of a deleted plugin is best-effort cleanup; a stale search entry is tolerable',
          severity: 'warn',
        });
      }
    }
  }

  const catalogEntries = toCatalogEntries(discoveredPlugins, activePluginIds, pendingReviewPluginIds);
  deps.setCatalogPlugins(catalogEntries);

  return {
    catalogEntries,
    conflicts: discoveredConflicts,
  };
}

export function createSpacePluginsController(deps: SpacePluginsControllerDeps): SpacePluginsController {
  let state: SpacePluginsState = DEFAULT_STATE;
  let unsubscribeWatcher: (() => void) | null = null;
  let started = false;
  let requestVersion = 0;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const patchState = (next: Partial<SpacePluginsState>) => {
    state = { ...state, ...next };
    notify();
  };

  const refresh = async (): Promise<void> => {
    const currentRequest = ++requestVersion;
    patchState({ isLoading: true, error: null });

    try {
      const { catalogEntries, conflicts } = await syncSpacePluginsCatalog(deps);
      if (currentRequest !== requestVersion) {
        return;
      }
      patchState({
        spacePlugins: catalogEntries,
        conflicts,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      if (currentRequest !== requestVersion) {
        ignoreBestEffortCleanup(error, {
          operation: 'useSpacePlugins.refresh',
          reason: 'A newer refresh superseded this request; its error is intentionally dropped to avoid clobbering fresher state',
        });
        return;
      }

      const message = error instanceof Error ? error.message : 'Failed to scan Spaces for plugins.';
      patchState({
        isLoading: false,
        error: message,
      });
    }
  };

  return {
    start: () => {
      if (started) {
        return;
      }

      started = true;
      const watcherUnsubscribe = deps.onSpacePluginsChanged(() => {
        void refresh();
      });
      unsubscribeWatcher = typeof watcherUnsubscribe === 'function' ? watcherUnsubscribe : null;
      void refresh();
    },

    stop: () => {
      if (!started) {
        return;
      }

      started = false;
      requestVersion += 1;
      if (unsubscribeWatcher) {
        unsubscribeWatcher();
        unsubscribeWatcher = null;
      }
    },

    refresh,

    getState: () => state,

    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function createDefaultControllerDeps(): SpacePluginsControllerDeps {
  return {
    scanSpaces: async () => {
      if (!window.pluginsApi?.scanSpaces) {
        return { plugins: [], conflicts: [] };
      }
      return window.pluginsApi.scanSpaces();
    },

    onSpacePluginsChanged: (callback: () => void) => {
      if (!window.pluginsApi?.onSpacePluginsChanged) {
        return undefined;
      }
      return window.pluginsApi.onSpacePluginsChanged(callback);
    },

    getActivatedPluginIds: async () => {
      if (!window.pluginsApi?.getActivated) {
        return [];
      }
      const response = await window.pluginsApi.getActivated();
      return response.pluginIds;
    },

    getDeactivatedPluginIds: async () => {
      if (!window.pluginsApi?.getDeactivated) {
        return [];
      }
      const response = await window.pluginsApi.getDeactivated();
      return response.pluginIds;
    },

    getPendingReviewPluginIds: async () => {
      if (!window.pluginsApi?.getPendingReview) {
        return [];
      }
      const response = await window.pluginsApi.getPendingReview();
      return response.pluginIds;
    },

    indexReadme: async (pluginId: string, spacePath: string) => {
      if (!window.pluginsApi?.indexReadme) {
        return;
      }
      const response = await window.pluginsApi.indexReadme({ pluginId, spacePath });
      if (!response.success) {
        throw new Error(`Failed to index plugin README for "${pluginId}"`);
      }
    },

    deindexReadme: async (pluginId: string, spacePath: string) => {
      if (!window.pluginsApi?.deindexReadme) {
        return;
      }
      const response = await window.pluginsApi.deindexReadme({ pluginId, spacePath });
      if (!response.success) {
        throw new Error(`Failed to de-index plugin README for "${pluginId}"`);
      }
    },

    getRegisteredPlugins: () => getAllRegisteredPlugins(),

    registerPlugin: (manifest: PluginManifest, source: string) => registerPlugin(manifest, source),

    unregisterPlugin: (pluginId: string) => unregisterPlugin(pluginId),

    getCatalogPlugins: () => getAllCatalogPlugins(),

    setCatalogPlugins: (entries: CatalogPlugin[]) => setCatalogPlugins(entries),

    compileSource: async (source: string) => {
      const { compilePluginSource } = await import('../compiler/pluginCompiler');
      return compilePluginSource(source).ok;
    },
  };
}

export function createDefaultSpacePluginsController(): SpacePluginsController {
  return createSpacePluginsController(createDefaultControllerDeps());
}

export function useSpacePlugins(): UseSpacePluginsResult {
  const [controller] = useState<SpacePluginsController>(() => createDefaultSpacePluginsController());
  const [state, setState] = useState<SpacePluginsState>(() => controller.getState());

  useEffect(() => {
    const unsubscribe = controller.subscribe(() => {
      setState(controller.getState());
    });
    controller.start();

    return () => {
      unsubscribe();
      controller.stop();
    };
  }, [controller]);

  const refresh = useCallback(() => {
    void controller.refresh();
  }, [controller]);

  return useMemo(
    () => ({
      ...state,
      refresh,
    }),
    [refresh, state],
  );
}
