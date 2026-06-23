import type { PluginManifest } from '@renderer/features/plugins/manifest/pluginManifest';
import type { PluginLensEntry } from '@renderer/features/plugins/hooks/usePluginsLensData';

export interface PluginCardEntry {
  id: string;
  kind: 'plugin';
  name: string;
  pluginId: string;
  manifest: PluginManifest;
  /** Plugin source code (compiled at activation time). */
  pluginSource: string;
  origin: 'space' | 'local';
  spacePath?: string;
  isActive: boolean;
  isBuiltIn: boolean;
  conflictFiles?: string[];
  /** Lower-cased blob used for plain-text search. */
  searchHaystack: string;
  /** Last-changelog timestamp (epoch ms) when available — drives 'recently updated' sort. */
  lastUpdatedAt: number;
}

function parseChangelogTimestamp(date?: string): number {
  if (!date) return 0;
  const parsed = Date.parse(date);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function pluginsToCardEntries(
  entries: readonly PluginLensEntry[] | null | undefined,
): PluginCardEntry[] {
  if (!entries || entries.length === 0) return [];

  return entries.map((entry) => {
    const manifest = entry.manifest;
    const description = manifest.description ?? '';
    const haystack = `${manifest.name} ${description} ${manifest.id}`.toLowerCase();
    const lastUpdatedAt = parseChangelogTimestamp(manifest.changelog?.[0]?.date);

    return {
      id: entry.spacePath ? `${manifest.id}:${entry.spacePath}` : `${manifest.id}:local`,
      kind: 'plugin' as const,
      name: manifest.name,
      pluginId: entry.pluginId,
      manifest,
      pluginSource: entry.source,
      origin: entry.origin,
      ...(entry.spacePath ? { spacePath: entry.spacePath } : {}),
      isActive: entry.isActive,
      isBuiltIn: entry.isBuiltIn,
      ...(entry.conflictFiles ? { conflictFiles: entry.conflictFiles } : {}),
      searchHaystack: haystack,
      lastUpdatedAt,
    };
  });
}
