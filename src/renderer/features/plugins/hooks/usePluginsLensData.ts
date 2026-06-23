/**
 * usePluginsLensData
 *
 * Aggregates Space-scoped plugins (from `useSpacePlugins`) and locally-installed
 * plugins (from `useRegisteredPlugins`) into a single Library-shaped list for the
 * Plugins lens.
 *
 * Locally-registered plugins that have a Space origin in the catalog show up via
 * the catalog entry (preferred — they carry `spacePath`). Locally-only plugins
 * (e.g. authored in dev mode without ever being saved to a Space) appear with
 * `origin: 'local'` and no `spacePath`.
 *
 * Stage A1.2 of docs/plans/260521_plugin_publishing_org_distribution.md.
 */

import { useMemo } from 'react';
import type { PluginConflict } from '@shared/ipc/schemas/plugins';
import { useSettingsSafe } from '@renderer/features/settings';
import type { PluginManifest } from '../manifest/pluginManifest';
import { useRegisteredPlugins } from './useRegisteredPlugins';
import { useSpacePlugins } from './useSpacePlugins';

export interface PluginLensEntry {
  pluginId: string;
  manifest: PluginManifest;
  source: string;
  /** True when the plugin is currently registered/running. */
  isActive: boolean;
  /** 'space' when the plugin lives in a Space; 'local' when only registered in-process. */
  origin: 'space' | 'local';
  /** Filesystem path of the owning Space, when origin === 'space'. */
  spacePath?: string;
  /** Conflict file paths reported by `scanSpacePlugins`, when applicable. */
  conflictFiles?: string[];
  /** True when this plugin originated from Rebel's bundled seeded set. */
  isBuiltIn: boolean;
}

export interface UsePluginsLensDataResult {
  entries: PluginLensEntry[];
  conflicts: PluginConflict[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Build the Library Plugins lens dataset.
 *
 * Dedup rule (deterministic): a Space-scoped catalog entry takes precedence
 * over a local-only registration sharing the same plugin id. Multi-Space
 * duplicates in the catalog are already deduped upstream by
 * `useSpacePlugins`/`toCatalogEntries` (last-one-wins by `pluginId`); the
 * `alsoInSpaces` enrichment is deferred to a follow-up (see plan §"audit P1
 * gap #7").
 */
export function usePluginsLensData(): UsePluginsLensDataResult {
  const { spacePlugins, conflicts, isLoading, error, refresh } = useSpacePlugins();
  const registeredPlugins = useRegisteredPlugins();
  const settingsContext = useSettingsSafe();
  const seededBundledPluginIds = settingsContext?.settings?.seededBundledPluginIds;

  const seededIds = useMemo(
    () => new Set(seededBundledPluginIds ?? []),
    [seededBundledPluginIds],
  );

  const entries = useMemo<PluginLensEntry[]>(() => {
    const merged = new Map<string, PluginLensEntry>();
    const conflictsByPluginId = new Map<string, string[]>();
    for (const conflict of conflicts) {
      conflictsByPluginId.set(conflict.pluginId, conflict.conflictFiles);
    }

    // The plugin registry is the source of truth for "is this running for me right now?"
    // Catalog `isActive` is a snapshot from the last Space scan and lags the user's
    // toggle action — derive freshly so PluginCard live-updates after activate/deactivate.
    const registeredIds = new Set<string>();
    for (const registered of registeredPlugins) {
      const id = registered.manifest.id;
      if (id) registeredIds.add(id);
    }

    for (const catalog of spacePlugins) {
      const pluginId = catalog.manifest.id;
      if (!pluginId) continue;
      const conflictFiles = conflictsByPluginId.get(pluginId);
      merged.set(pluginId, {
        pluginId,
        manifest: catalog.manifest,
        source: catalog.source,
        isActive: registeredIds.has(pluginId),
        origin: 'space',
        isBuiltIn: seededIds.has(pluginId),
        ...(catalog.spacePath ? { spacePath: catalog.spacePath } : {}),
        ...(conflictFiles ? { conflictFiles } : {}),
      });
    }

    for (const registered of registeredPlugins) {
      const pluginId = registered.manifest.id;
      if (!pluginId) continue;
      if (merged.has(pluginId)) continue;
      merged.set(pluginId, {
        pluginId,
        manifest: registered.manifest,
        source: registered.source,
        isActive: true,
        origin: 'local',
        isBuiltIn: false,
      });
    }

    return Array.from(merged.values());
  }, [conflicts, registeredPlugins, seededIds, spacePlugins]);

  return useMemo(
    () => ({
      entries,
      conflicts,
      isLoading,
      error,
      refresh,
    }),
    [conflicts, entries, error, isLoading, refresh],
  );
}
