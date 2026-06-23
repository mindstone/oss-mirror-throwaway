/**
 * Plugin Space Service
 *
 * Discovers plugins stored in Space `plugins/` directories and provides
 * export functionality to write plugins into Spaces for team sharing.
 *
 * @see docs/plans/260324_wave4_plugin_sharing_maturity.md — Stage W4-3
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { getSettings } from '@core/services/settingsStore';
import { scanSpaces } from './spaceService';
import { detectPluginConflicts } from './pluginConflictDetector';
import {
  HotPathCounterTracker,
  type HotPathCounters,
  type HotPathWindowedCounters,
} from './perfCounters';
import type { PluginConflict, SpacePluginInfo } from '@shared/ipc/schemas/plugins';
import {
  registerScanSpacePlugins,
  invalidatePluginIdentityCache,
  invalidatePermissionCache,
} from '../ipc/plugins/pluginIdentityRegistry';

const log = createScopedLogger({ service: 'pluginSpaceService' });

// ── Hot-path counter — "true bottom" for scanSpacePlugins ───────────────
// See docs/plans/260420_perf_observability_and_low_risk_wins.md § Stage 1.
// scanSpacePlugins has no cache of its own, so every call is an underlying
// fetch. `maxConcurrentInflight` here is the herd-existence proof for Stage 4.
const scanSpacePluginsCounter = new HotPathCounterTracker();

/** Read-only snapshot of the scanSpacePlugins counter struct. */
export function getScanSpacePluginsCounters(): HotPathCounters {
  return scanSpacePluginsCounter.snapshot();
}

/** Rolling-window + cumulative counters for perf diagnostics. */
export function getScanSpacePluginsWindowedCounters(): HotPathWindowedCounters {
  return scanSpacePluginsCounter.windowedSnapshot();
}

/** Test-only: zero the scanSpacePlugins counter struct. */
export function _resetScanSpacePluginsCountersForTesting(): void {
  scanSpacePluginsCounter._resetForTesting();
}

/**
 * Scan all Spaces for plugins/ directories and read their manifests + source.
 * Returns discovered plugins and cloud-sync conflict metadata.
 *
 * By default, plugins with `archivedAt` set are excluded. Pass
 * `options.includeArchived: true` to include them (e.g. for restore flows).
 */
export async function scanSpacePlugins(
  options?: { includeArchived?: boolean },
): Promise<{ plugins: SpacePluginInfo[]; conflicts: PluginConflict[] }> {
  // Every call is an underlying fetch — there is no cache at this layer.
  // This is the "true bottom" counter for Stage 4 herd proof.
  scanSpacePluginsCounter.recordRequest();
  scanSpacePluginsCounter.recordUnderlyingFetchStart();
  try {
    const settings = getSettings();
    const workspacePath = settings.coreDirectory;
    if (!workspacePath) {
      log.warn('No workspace directory configured');
      return { plugins: [], conflicts: [] };
    }

    // Read-only: plugin-catalog discovery must not mutate frontmatter.
    // See docs/plans/260411_shared_space_maintenance.md Stage 3 Refinement.
    const spaces = await scanSpaces(workspacePath, { skipAutoFix: true });
    const plugins: SpacePluginInfo[] = [];
    const conflicts: PluginConflict[] = [];

    for (const space of spaces) {
      const pluginsDir = path.join(space.absolutePath, 'plugins');

      try {
        const entries = await fs.readdir(pluginsDir, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          const pluginDir = path.join(pluginsDir, entry.name);
          try {
            const plugin = await readPluginFromDirectory(pluginDir, space.name, space.absolutePath);
            if (plugin) {
              // Filter out archived plugins unless explicitly requested
              if (plugin.manifest.archivedAt && !options?.includeArchived) {
                continue;
              }
              plugins.push(plugin);
            }
          } catch (err) {
            log.warn({ pluginDir, err }, 'Failed to read plugin from directory');
          }
        }
      } catch {
        // No plugins/ directory in this space — that's fine
      }

      const detectedConflicts = await detectPluginConflicts(pluginsDir);
      if (detectedConflicts.length > 0) {
        conflicts.push(...detectedConflicts);
      }
    }

    log.info({ pluginCount: plugins.length, conflictCount: conflicts.length }, 'Space plugin scan complete');
    return { plugins, conflicts };
  } catch (err) {
    scanSpacePluginsCounter.recordFetchError();
    throw err;
  } finally {
    scanSpacePluginsCounter.recordUnderlyingFetchEnd();
  }
}

// Register at module load so `ipc/plugins/shared.ts` can call into us through
// the registry without taking a (static or dynamic) import edge back to this
// module — that previously formed a madge-detected cycle.
registerScanSpacePlugins(scanSpacePlugins);

/**
 * Read a single plugin from a directory containing manifest.json and index.tsx.
 */
async function readPluginFromDirectory(
  pluginDir: string,
  spaceName: string,
  spacePath: string,
): Promise<SpacePluginInfo | null> {
  const manifestPath = path.join(pluginDir, 'manifest.json');
  const sourcePath = path.join(pluginDir, 'index.tsx');

  // Both manifest.json and index.tsx must exist
  let manifestRaw: string;
  let source: string;
  try {
    [manifestRaw, source] = await Promise.all([
      fs.readFile(manifestPath, 'utf-8'),
      fs.readFile(sourcePath, 'utf-8'),
    ]);
  } catch {
    return null; // Missing required files
  }

  let manifestData: unknown;
  try {
    manifestData = JSON.parse(manifestRaw);
  } catch {
    log.warn({ manifestPath }, 'Invalid JSON in plugin manifest');
    return null;
  }

  // Validate manifest structure (basic check — full Zod validation happens in renderer)
  if (!manifestData || typeof manifestData !== 'object') return null;
  const manifest = manifestData as Record<string, unknown>;
  if (!manifest.id || !manifest.name || typeof manifest.id !== 'string' || typeof manifest.name !== 'string') {
    log.warn({ manifestPath }, 'Plugin manifest missing required id or name');
    return null;
  }

  // Ensure entryPoint is set (default to 'index.tsx' since that's the convention)
  if (!manifest.entryPoint) {
    manifest.entryPoint = 'index.tsx';
  }

  return {
    pluginId: manifest.id,
    manifest: manifest as SpacePluginInfo['manifest'],
    source,
    spaceName,
    spacePath,
  };
}

/**
 * Build a shared manifest object from a plugin manifest, excluding local-only fields.
 */
function buildSharedManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version ?? '0.1.0',
    icon: manifest.icon,
    entryPoint: manifest.entryPoint ?? 'index.tsx',
    maturity: manifest.maturity ?? 'labs',
    role: manifest.role ?? 'utility',
    ...(manifest.forkedFrom ? { forkedFrom: manifest.forkedFrom } : {}),
    ...(manifest.documentation ? { documentation: manifest.documentation } : {}),
    ...(manifest.changelog ? { changelog: manifest.changelog } : {}),
    ...(manifest.contributors ? { contributors: manifest.contributors } : {}),
    ...(manifest.archivedAt ? { archivedAt: manifest.archivedAt } : {}),
    ...(manifest.storageScope ? { storageScope: manifest.storageScope } : {}),
    ...(manifest.permissions ? { permissions: manifest.permissions } : {}),
    ...(manifest.externalDomains ? { externalDomains: manifest.externalDomains } : {}),
  };
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatChangelogList(changelog: unknown): string[] {
  if (!Array.isArray(changelog)) {
    return [];
  }

  const lines: string[] = [];
  for (const entry of changelog) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const version = asNonEmptyString(record.version);
    // Keep compatibility with either { version, changes } or { version, summary } shapes.
    const changes = asNonEmptyString(record.changes) ?? asNonEmptyString(record.summary);

    if (version && changes) {
      lines.push(`- **v${version}**: ${changes}`);
      continue;
    }
    if (version) {
      lines.push(`- v${version}`);
      continue;
    }
    if (changes) {
      lines.push(`- ${changes}`);
    }
  }

  return lines;
}

export function generatePluginReadme(manifest: Record<string, unknown>): string {
  const name = asNonEmptyString(manifest.name) ?? 'Untitled Plugin';
  const pluginId = asNonEmptyString(manifest.id) ?? 'unknown-plugin';
  const description = asNonEmptyString(manifest.description);
  const documentation = asNonEmptyString(manifest.documentation);
  const version = asNonEmptyString(manifest.version) ?? '0.1.0';
  const changelogLines = formatChangelogList(manifest.changelog);

  const lines: string[] = [`# ${name}`, '', `> Plugin ID: \`${pluginId}\``, ''];

  if (description) {
    lines.push(description, '');
  }

  if (documentation) {
    lines.push('## Documentation', '', documentation, '');
  }

  lines.push('## Version', '', `v${version}`);

  if (changelogLines.length > 0) {
    lines.push('', '', '## Changelog', '', ...changelogLines);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Write a plugin's manifest, source, and generated README to a Space's plugins/ directory.
 * Creates the folder structure: {spacePath}/plugins/{pluginId}/manifest.json + index.tsx + README.md
 *
 * This is the low-level write function used by both `exportPluginToSpace()` (for
 * sharing existing plugins) and the plugin service's `createOrUpdate()` (for
 * persisting newly created/updated plugins to Chief-of-Staff).
 */
export async function writePluginToSpace(
  manifest: Record<string, unknown>,
  source: string,
  spacePath: string,
  options?: { readmeOverride?: string },
): Promise<{ ok: true; exportedPath: string } | { ok: false; error: string }> {
  const pluginId = manifest.id as string;
  if (!pluginId) {
    return { ok: false, error: 'Manifest missing required "id" field.' };
  }

  const pluginDir = path.join(spacePath, 'plugins', pluginId);
  const manifestPath = path.join(pluginDir, 'manifest.json');
  const sourcePath = path.join(pluginDir, 'index.tsx');
  const readmePath = path.join(pluginDir, 'README.md');

  try {
    await fs.mkdir(pluginDir, { recursive: true });

    const sharedManifest = buildSharedManifest(manifest);
    const readmeContent = typeof options?.readmeOverride === 'string'
      ? options.readmeOverride
      : generatePluginReadme(sharedManifest);

    await Promise.all([
      fs.writeFile(manifestPath, JSON.stringify(sharedManifest, null, 2), 'utf-8'),
      fs.writeFile(sourcePath, source, 'utf-8'),
      fs.writeFile(readmePath, readmeContent, 'utf-8'),
    ]);

    // Plugin identity set (Space-scanned IDs) may have changed — invalidate the
    // Stage 4 coalesced cache in `isKnownPlugin` so storage gates see the update.
    invalidatePluginIdentityCache('writePluginToSpace');

    log.info({ pluginId, pluginDir }, 'Plugin written to Space');
    return { ok: true, exportedPath: pluginDir };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ pluginId, spacePath, err }, 'Failed to write plugin to Space');
    return { ok: false, error: `Failed to write plugin: ${message}` };
  }
}

/**
 * Export a local plugin to a Space's plugins/ directory.
 * Creates the folder structure: {spacePath}/plugins/{pluginId}/manifest.json + index.tsx + README.md
 */
export async function exportPluginToSpace(
  pluginId: string,
  spacePath: string,
  role?: 'hero' | 'utility',
): Promise<{ ok: true; exportedPath: string } | { ok: false; error: string }> {
  // Load the plugin — check Space-scanned plugins first, then local file persistence fallback
  let pluginManifest: Record<string, unknown> | undefined;
  let pluginSource: string | undefined;

  try {
    const { plugins } = await scanSpacePlugins();
    const spacePlugin = plugins.find((p) => p.pluginId === pluginId);
    if (spacePlugin) {
      pluginManifest = spacePlugin.manifest as unknown as Record<string, unknown>;
      pluginSource = spacePlugin.source;
    }
  } catch {
    // Space scan failed — fall through to local file persistence
  }

  if (!pluginManifest) {
    const { loadPersistedPluginEntries } = await import('./pluginFilePersistence');
    const allPlugins = await loadPersistedPluginEntries();
    const plugin = allPlugins.find((p) => p.manifest.id === pluginId);
    if (plugin) {
      pluginManifest = plugin.manifest as unknown as Record<string, unknown>;
      pluginSource = plugin.source;
    }
  }

  if (!pluginManifest || !pluginSource) {
    return { ok: false, error: `Plugin "${pluginId}" not found in local storage.` };
  }

  const manifestForExport = role !== undefined
    ? { ...pluginManifest, role }
    : pluginManifest;

  return writePluginToSpace(manifestForExport, pluginSource, spacePath);
}

/**
 * Get the absolute path to the Chief-of-Staff space.
 * Returns null if the workspace isn't configured or Chief-of-Staff doesn't exist.
 */
export async function getChiefOfStaffPath(): Promise<string | null> {
  const settings = getSettings();
  const workspacePath = settings.coreDirectory;
  if (!workspacePath) {
    return null;
  }

  try {
    const entries = await fs.readdir(workspacePath, { withFileTypes: true });
    for (const entry of entries) {
      if ((entry.isDirectory() || entry.isSymbolicLink()) && entry.name.toLowerCase() === 'chief-of-staff') {
        return path.join(workspacePath, entry.name);
      }
    }
  } catch (err) {
    log.debug({ workspacePath, err }, 'Could not scan workspace for Chief-of-Staff');
  }

  return null;
}

/**
 * Migrate plugins from local file persistence to Chief-of-Staff/plugins/ on disk.
 *
 * Runs once on startup before the Space plugin scan. For each plugin in
 * local file persistence, checks if it already exists in Chief-of-Staff/plugins/.
 * If not, writes it via writePluginToSpace(). Only successfully-migrated
 * entries are cleared from local persistence (per-plugin accounting).
 *
 * If Chief-of-Staff doesn't exist but a workspace is configured, creates it.
 * If no workspace is configured, returns early (no-op).
 */
export async function migratePluginsToSpace(): Promise<{
  migrated: number;
  skipped: number;
  failed: number;
}> {
  const stats = { migrated: 0, skipped: 0, failed: 0 };

  // Load entries from local file persistence
  const { loadPersistedPluginEntries, persistPluginEntries } = await import(
    './pluginFilePersistence'
  );
  const entries = await loadPersistedPluginEntries();

  if (entries.length === 0) {
    log.debug('No plugins in local file persistence to migrate');
    return stats;
  }

  // Find or create Chief-of-Staff path
  let cosPath = await getChiefOfStaffPath();

  if (!cosPath) {
    const settings = getSettings();
    const workspacePath = settings.coreDirectory;
    if (!workspacePath) {
      log.debug('No workspace configured — skipping plugin migration');
      return stats;
    }

    // Create Chief-of-Staff/plugins/ directory
    cosPath = path.join(workspacePath, 'Chief-of-Staff');
    try {
      await fs.mkdir(path.join(cosPath, 'plugins'), { recursive: true });
      log.info({ cosPath }, 'Created Chief-of-Staff/plugins/ for migration');
    } catch (err) {
      log.error({ err, cosPath }, 'Failed to create Chief-of-Staff directory');
      stats.failed = entries.length;
      return stats;
    }
  }

  const migratedIds = new Set<string>();

  for (const entry of entries) {
    const pluginId = entry.manifest.id;
    const manifestPath = path.join(cosPath, 'plugins', pluginId, 'manifest.json');

    // Check if plugin already exists in Chief-of-Staff — CoS wins, clear from local persistence
    try {
      await fs.access(manifestPath);
      log.debug({ pluginId }, 'Plugin already in Chief-of-Staff — skipping migration');
      migratedIds.add(pluginId);
      stats.skipped++;
      continue;
    } catch {
      // File doesn't exist — proceed with migration
    }

    // Write plugin to Chief-of-Staff
    const result = await writePluginToSpace(
      entry.manifest as unknown as Record<string, unknown>,
      entry.source,
      cosPath,
    );

    if (result.ok) {
      log.info({ pluginId }, 'Migrated plugin from local persistence to Chief-of-Staff');
      stats.migrated++;
      migratedIds.add(pluginId);
    } else {
      log.error({ pluginId, error: result.error }, 'Failed to migrate plugin — keeping in local persistence');
      stats.failed++;
    }
  }

  // Clear migrated entries from local persistence (keep failed ones)
  if (migratedIds.size > 0) {
    const remaining = entries.filter((e) => !migratedIds.has(e.manifest.id));
    await persistPluginEntries(remaining);
    invalidatePermissionCache();
    invalidatePluginIdentityCache('migratePluginsToSpace');
    log.info(
      { migrated: stats.migrated, skipped: stats.skipped, failed: stats.failed, remaining: remaining.length },
      'Plugin migration complete',
    );
  }

  return stats;
}

/**
 * Delete a plugin folder from a Space's plugins/ directory.
 * Returns true if the folder was found and deleted, false otherwise.
 */
export async function deletePluginFromSpace(pluginId: string, spacePath: string): Promise<boolean> {
  const pluginDir = path.join(spacePath, 'plugins', pluginId);
  try {
    await fs.rm(pluginDir, { recursive: true, force: true });
    // Plugin identity set (Space-scanned IDs) may have changed — invalidate the
    // Stage 4 coalesced cache in `isKnownPlugin` so stale positives do not
    // survive a deletion.
    invalidatePluginIdentityCache('deletePluginFromSpace');
    log.info({ pluginId, pluginDir }, 'Plugin folder deleted from Space');
    return true;
  } catch {
    return false;
  }
}

// ── Atomic manifest helpers ─────────────────────────────────────────────

/**
 * Read and parse a plugin's manifest.json from its Space directory.
 */
async function readManifestFromSpace(
  pluginId: string,
  spacePath: string,
): Promise<{ ok: true; manifest: Record<string, unknown> } | { ok: false; error: string }> {
  const manifestPath = path.join(spacePath, 'plugins', pluginId, 'manifest.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') {
      return { ok: false, error: `Invalid manifest for plugin "${pluginId}".` };
    }
    return { ok: true, manifest: data as Record<string, unknown> };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, error: `Plugin "${pluginId}" not found in space.` };
    }
    return { ok: false, error: `Failed to read manifest for "${pluginId}": ${(err as Error).message}` };
  }
}

/**
 * Write a manifest object atomically: write to temp file, then rename over original.
 * Handles Windows EPERM by unlinking target first (matches safeWriteFile in pluginFilePersistence.ts).
 */
async function writeManifestAtomic(
  pluginId: string,
  spacePath: string,
  manifest: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const manifestPath = path.join(spacePath, 'plugins', pluginId, 'manifest.json');
  const tmpPath = `${manifestPath}.tmp-${Date.now()}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2), 'utf-8');
    try {
      await fs.rename(tmpPath, manifestPath);
    } catch (renameErr) {
      const code = (renameErr as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        try { await fs.unlink(manifestPath); } catch { /* target may not exist */ }
        await fs.rename(tmpPath, manifestPath);
      } else {
        throw renameErr;
      }
    }
    return { ok: true };
  } catch (err) {
    // Clean up temp file on failure
    try { await fs.unlink(tmpPath); } catch { /* best effort */ }
    return { ok: false, error: `Failed to write manifest for "${pluginId}": ${(err as Error).message}` };
  }
}

// ── Archive / Restore ───────────────────────────────────────────────────

/**
 * Archive a plugin by setting `archivedAt` in its manifest.
 * The plugin remains on disk but is hidden from active lists.
 */
export async function archivePluginInSpace(
  pluginId: string,
  spacePath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const readResult = await readManifestFromSpace(pluginId, spacePath);
  if (!readResult.ok) return readResult;

  const manifest = readResult.manifest;
  if (manifest.archivedAt) {
    return { ok: true }; // Already archived — idempotent
  }

  manifest.archivedAt = new Date().toISOString();

  const writeResult = await writeManifestAtomic(pluginId, spacePath, manifest);
  if (!writeResult.ok) return writeResult;

  // `scanSpacePlugins()` filters out archived plugins by default, so archiving
  // flips membership in the Space-scanned identity set — invalidate Stage 4.
  invalidatePluginIdentityCache('archivePluginInSpace');

  log.info({ pluginId, spacePath }, 'Plugin archived');
  return { ok: true };
}

/**
 * Restore an archived plugin by removing `archivedAt` from its manifest.
 */
export async function restorePluginInSpace(
  pluginId: string,
  spacePath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const readResult = await readManifestFromSpace(pluginId, spacePath);
  if (!readResult.ok) return readResult;

  const manifest = readResult.manifest;
  if (!manifest.archivedAt) {
    return { ok: true }; // Not archived — idempotent
  }

  delete manifest.archivedAt;

  const writeResult = await writeManifestAtomic(pluginId, spacePath, manifest);
  if (!writeResult.ok) return writeResult;

  // Inverse of archive — restoring flips membership back into the default
  // Space-scanned identity set, so invalidate the Stage 4 coalesced cache.
  invalidatePluginIdentityCache('restorePluginInSpace');

  log.info({ pluginId, spacePath }, 'Plugin restored from archive');
  return { ok: true };
}

// ── Fork ────────────────────────────────────────────────────────────────

/**
 * Fork a plugin: create an editable copy with lineage tracking.
 * Generates a unique ID (`{sourceId}-fork`, then `-fork-2` … `-fork-10`).
 * Optionally writes the fork to a different space via `targetSpacePath`.
 */
export async function forkPluginInSpace(
  sourcePluginId: string,
  spacePath: string,
  options?: { targetId?: string; targetSpacePath?: string },
): Promise<{ ok: true; forkedId: string; exportedPath: string } | { ok: false; error: string }> {
  // Read source plugin (manifest + source file)
  const pluginDir = path.join(spacePath, 'plugins', sourcePluginId);
  const manifestPath = path.join(pluginDir, 'manifest.json');
  const sourcePath = path.join(pluginDir, 'index.tsx');

  let manifestRaw: string;
  let source: string;
  try {
    [manifestRaw, source] = await Promise.all([
      fs.readFile(manifestPath, 'utf-8'),
      fs.readFile(sourcePath, 'utf-8'),
    ]);
  } catch {
    return { ok: false, error: `Plugin "${sourcePluginId}" not found in space.` };
  }

  let manifestData: Record<string, unknown>;
  try {
    manifestData = JSON.parse(manifestRaw) as Record<string, unknown>;
  } catch {
    return { ok: false, error: `Invalid manifest JSON for plugin "${sourcePluginId}".` };
  }

  const destSpacePath = options?.targetSpacePath ?? spacePath;

  // Determine fork ID
  let forkId: string;
  if (options?.targetId) {
    forkId = options.targetId;
    // Check destination doesn't already have this ID
    const destDir = path.join(destSpacePath, 'plugins', forkId);
    try {
      await fs.access(destDir);
      return { ok: false, error: `Plugin "${forkId}" already exists in destination space.` };
    } catch {
      // Doesn't exist — good
    }
  } else {
    // Generate unique fork ID with retry
    const candidates = [`${sourcePluginId}-fork`];
    for (let i = 2; i <= 10; i++) {
      candidates.push(`${sourcePluginId}-fork-${i}`);
    }

    forkId = '';
    for (const candidate of candidates) {
      const destDir = path.join(destSpacePath, 'plugins', candidate);
      try {
        await fs.access(destDir);
        // Exists — try next candidate
      } catch {
        forkId = candidate;
        break;
      }
    }

    if (!forkId) {
      return { ok: false, error: `Could not generate unique fork ID for "${sourcePluginId}" — all candidates taken (tried up to -fork-10).` };
    }
  }

  // Build fork manifest
  const forkManifest: Record<string, unknown> = {
    ...manifestData,
    id: forkId,
    version: '0.1.0',
    forkedFrom: sourcePluginId,
  };
  delete forkManifest.archivedAt;
  delete forkManifest.createdBy;

  const result = await writePluginToSpace(forkManifest, source, destSpacePath);
  if (!result.ok) return result;

  log.info({ sourcePluginId, forkId, destSpacePath }, 'Plugin forked');
  return { ok: true, forkedId: forkId, exportedPath: result.exportedPath };
}

// ── Copy / Move ─────────────────────────────────────────────────────────

/**
 * Copy a plugin from one Space to another.
 * Returns an error if the destination already contains a plugin with the same ID.
 */
export async function copyPluginToSpace(
  pluginId: string,
  sourceSpacePath: string,
  targetSpacePath: string,
): Promise<{ ok: true; exportedPath: string } | { ok: false; error: string }> {
  // Check destination doesn't already have this plugin
  const destDir = path.join(targetSpacePath, 'plugins', pluginId);
  try {
    await fs.access(destDir);
    return { ok: false, error: `Plugin "${pluginId}" already exists in destination space.` };
  } catch {
    // Doesn't exist — good
  }

  // Read source plugin
  const pluginDir = path.join(sourceSpacePath, 'plugins', pluginId);
  const manifestPath = path.join(pluginDir, 'manifest.json');
  const sourcePath = path.join(pluginDir, 'index.tsx');

  let manifestRaw: string;
  let source: string;
  try {
    [manifestRaw, source] = await Promise.all([
      fs.readFile(manifestPath, 'utf-8'),
      fs.readFile(sourcePath, 'utf-8'),
    ]);
  } catch {
    return { ok: false, error: `Plugin "${pluginId}" not found in source space.` };
  }

  let manifestData: Record<string, unknown>;
  try {
    manifestData = JSON.parse(manifestRaw) as Record<string, unknown>;
  } catch {
    return { ok: false, error: `Invalid manifest JSON for plugin "${pluginId}".` };
  }

  const result = await writePluginToSpace(manifestData, source, targetSpacePath);
  if (!result.ok) return result;

  log.info({ pluginId, sourceSpacePath, targetSpacePath }, 'Plugin copied to space');
  return { ok: true, exportedPath: result.exportedPath };
}

/**
 * Move a plugin from one Space to another.
 * Copies to the target, then deletes from the source on success.
 */
export async function movePluginToSpace(
  pluginId: string,
  sourceSpacePath: string,
  targetSpacePath: string,
): Promise<{ ok: true; exportedPath: string } | { ok: false; error: string }> {
  const copyResult = await copyPluginToSpace(pluginId, sourceSpacePath, targetSpacePath);
  if (!copyResult.ok) return copyResult;

  const deleted = await deletePluginFromSpace(pluginId, sourceSpacePath);
  if (!deleted) {
    log.warn({ pluginId, sourceSpacePath }, 'Plugin copied but source could not be deleted — move degraded to copy');
    return { ok: false, error: 'Plugin copied to target but failed to delete from source space.' };
  }

  log.info({ pluginId, sourceSpacePath, targetSpacePath }, 'Plugin moved to space');
  return { ok: true, exportedPath: copyResult.exportedPath };
}
