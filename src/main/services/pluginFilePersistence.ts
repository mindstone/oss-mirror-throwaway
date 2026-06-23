/**
 * Plugin File Persistence
 *
 * Stores plugins as individual files on disk:
 *   {userData}/plugins/{pluginId}/manifest.json
 *   {userData}/plugins/{pluginId}/index.tsx
 *
 * Replaces the single-JSON electron-store approach with per-plugin
 * file-based storage for better isolation, incremental saves, and
 * debuggability.
 *
 * @see docs/plans/260327_plugin_file_storage.md
 */

import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';
import { PersistedPluginSchema, type PersistedPlugin } from '@shared/ipc/schemas/plugins';
import { atomicWriteFile } from '@core/utils/atomicFileWrite';

const log = createScopedLogger({ service: 'pluginFilePersistence' });

let _baseDir: string | null = null;

function getBaseDir(): string {
  if (!_baseDir) {
    _baseDir = path.join(getDataPath(), 'plugins');
  }
  return _baseDir;
}

// ── Safe file writes ────────────────────────────────────────────────────

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

// ── Orphan cleanup ──────────────────────────────────────────────────────

/**
 * Remove leftover `.tmp` files inside a plugin directory.
 * These can appear if the app crashes between write and rename.
 */
async function cleanOrphanedTmpFiles(pluginDir: string): Promise<void> {
  try {
    const entries = await fs.readdir(pluginDir);
    for (const entry of entries) {
      if (entry.includes('.tmp-')) {
        try {
          await fs.unlink(path.join(pluginDir, entry));
          log.debug({ pluginDir, file: entry }, 'Removed orphaned tmp file');
        } catch {
          // Best-effort cleanup
        }
      }
    }
  } catch {
    // Directory may not exist or be unreadable — skip
  }
}

// ── Read a single plugin from its directory ─────────────────────────────

async function readPluginDir(pluginDir: string, pluginId: string): Promise<PersistedPlugin | null> {
  const manifestPath = path.join(pluginDir, 'manifest.json');
  const sourcePath = path.join(pluginDir, 'index.tsx');

  // Both files must exist
  let manifestRaw: string;
  let source: string;
  try {
    [manifestRaw, source] = await Promise.all([
      fs.readFile(manifestPath, 'utf-8'),
      fs.readFile(sourcePath, 'utf-8'),
    ]);
  } catch {
    log.warn({ pluginId, pluginDir }, 'Missing manifest.json or index.tsx — skipping plugin');
    return null;
  }

  let manifestData: unknown;
  try {
    manifestData = JSON.parse(manifestRaw);
  } catch {
    log.warn({ pluginId, manifestPath }, 'Invalid JSON in manifest.json — skipping plugin');
    return null;
  }

  const parsed = PersistedPluginSchema.safeParse({ manifest: manifestData, source });
  if (!parsed.success) {
    log.warn({ pluginId, issues: parsed.error.issues }, 'Manifest validation failed — skipping plugin');
    return null;
  }

  return parsed.data;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Load all persisted plugins from disk.
 * Reads each `{baseDir}/{pluginId}/` directory, validates with Zod,
 * skips invalid entries, and cleans up orphaned .tmp files.
 */
export async function loadPersistedPluginEntries(): Promise<PersistedPlugin[]> {
  const baseDir = getBaseDir();

  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch (err) {
    // Directory absent (ENOENT) — no plugins persisted yet, recover silently.
    // Any other read failure silently presenting as "no plugins" could hide
    // the user's persisted plugins, so make it observable before the fallback.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err, baseDir }, 'Failed to read persisted-plugins directory — treating as none (plugins will appear missing)');
    }
    return [];
  }

  const plugins: PersistedPlugin[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginDir = path.join(baseDir, entry.name);

    // Clean up any orphaned .tmp files from interrupted writes
    await cleanOrphanedTmpFiles(pluginDir);

    const plugin = await readPluginDir(pluginDir, entry.name);
    if (plugin) {
      plugins.push(plugin);
    }
  }

  log.info({ count: plugins.length }, 'Loaded persisted plugins from disk');
  return plugins;
}

/**
 * Persist all plugin entries to disk.
 * For each entry, writes manifest.json + index.tsx using safe atomic writes.
 * Removes plugin directories that are no longer in the entries list (reconciliation).
 */
export async function persistPluginEntries(entries: PersistedPlugin[]): Promise<void> {
  const baseDir = getBaseDir();
  await fs.mkdir(baseDir, { recursive: true });

  // Build set of plugin IDs we're persisting
  const activeIds = new Set<string>();

  for (const entry of entries) {
    const parsed = PersistedPluginSchema.safeParse(entry);
    if (!parsed.success) {
      log.warn({ pluginId: entry.manifest?.id, issues: parsed.error.issues }, 'Skipping invalid plugin during persist');
      continue;
    }

    const pluginId = parsed.data.manifest.id;
    activeIds.add(pluginId);

    const pluginDir = path.join(baseDir, pluginId);
    await fs.mkdir(pluginDir, { recursive: true });

    const manifestContent = JSON.stringify(parsed.data.manifest, null, 2);

    await Promise.all([
      safeWriteFile(path.join(pluginDir, 'manifest.json'), manifestContent),
      safeWriteFile(path.join(pluginDir, 'index.tsx'), parsed.data.source),
    ]);
  }

  // Reconciliation: remove directories that are no longer in the active set
  try {
    const existingEntries = await fs.readdir(baseDir, { withFileTypes: true });
    for (const existing of existingEntries) {
      if (!existing.isDirectory()) continue;
      if (!activeIds.has(existing.name)) {
        const staleDir = path.join(baseDir, existing.name);
        await fs.rm(staleDir, { recursive: true, force: true });
        log.info({ pluginId: existing.name }, 'Removed stale plugin directory during reconciliation');
      }
    }
  } catch (err) {
    log.warn({ err }, 'Failed to reconcile stale plugin directories');
  }

  log.info({ count: entries.length }, 'Persisted plugin entries to disk');
}

/**
 * Remove the entire plugins directory.
 */
export async function clearPersistedPluginEntries(): Promise<void> {
  const baseDir = getBaseDir();
  await fs.rm(baseDir, { recursive: true, force: true });
  log.info('Cleared all persisted plugin entries');
}

/**
 * Remove a single plugin directory.
 */
export async function deleteSinglePlugin(pluginId: string): Promise<void> {
  const pluginDir = path.join(getBaseDir(), pluginId);
  await fs.rm(pluginDir, { recursive: true, force: true });
  log.info({ pluginId }, 'Deleted plugin directory');
}

/**
 * Reset internal state — for test use only.
 */
export function _resetPluginFilePersistenceForTests(): void {
  _baseDir = null;
}
