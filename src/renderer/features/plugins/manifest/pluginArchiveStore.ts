/**
 * @deprecated This localStorage-based archive store is superseded by disk-backed
 * archiving via `archivedAt` field in plugin manifest.json (stored in Spaces).
 *
 * The MCP tools (rebel_plugins_archive / rebel_plugins_restore) and shared service
 * functions in pluginSpaceService.ts (archivePluginInSpace / restorePluginInSpace)
 * are the canonical archive/restore path.
 *
 * TODO: Migrate PluginsTab.tsx to call shared services via IPC instead of these
 * localStorage functions, then remove this file.
 * See: docs/plans/260327_plugin_infrastructure_improvements.md
 */
import type { PluginManifest } from './pluginManifest';

const ARCHIVE_KEY = 'rebel-plugin-archive';

export interface ArchivedPlugin {
  manifest: PluginManifest;
  source: string;
  archivedAt: number;
}

export function loadArchivedPlugins(): ArchivedPlugin[] {
  try {
    const raw = localStorage.getItem(ARCHIVE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function archivePlugin(manifest: PluginManifest, source: string): void {
  const archived = loadArchivedPlugins().filter((a) => a.manifest.id !== manifest.id);
  archived.push({ manifest, source, archivedAt: Date.now() });
  localStorage.setItem(ARCHIVE_KEY, JSON.stringify(archived));
}

export function restoreArchivedPlugin(pluginId: string): ArchivedPlugin | null {
  const archived = loadArchivedPlugins();
  const idx = archived.findIndex((a) => a.manifest.id === pluginId);
  if (idx < 0) return null;
  const [plugin] = archived.splice(idx, 1);
  localStorage.setItem(ARCHIVE_KEY, JSON.stringify(archived));
  return plugin;
}

export function deleteArchivedPlugin(pluginId: string): void {
  const archived = loadArchivedPlugins().filter((a) => a.manifest.id !== pluginId);
  localStorage.setItem(ARCHIVE_KEY, JSON.stringify(archived));
}
