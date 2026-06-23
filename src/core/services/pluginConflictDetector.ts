/**
 * Plugin Conflict Detector — pure conflict-detection logic extracted from
 * pluginConflictService to break the pluginSpaceService↔pluginConflictService
 * circular dependency.
 *
 * Functions here are pure (no service *state*); imports are limited to node:fs/path
 * plus a stateless `@core/logger` scoped logger (no plugin-service imports — the
 * cycle being broken is about service state, not logging; see the inline note at
 * the logger declaration below).
 * Both pluginSpaceService and pluginConflictService import from this file.
 *
 * @see docs/plans/260330_strengthen_de_electronification.md — migrated from src/main/services/ (Stage 2a)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import type { PluginConflict } from '@shared/ipc/schemas/plugins';
import { createScopedLogger } from '@core/logger';

// Stateless scoped logger only — this module stays free of service *state* (the
// reason it was extracted; see file header) but a read failure silently
// becoming "no conflicts" is dangerous and must be observable.
const log = createScopedLogger({ service: 'pluginConflictDetector' });

const CONFLICT_FILE_NAME_REGEX = /^(manifest|index) \(([^)]+)\)\.(json|tsx)$/i;

type ConflictTargetFile = 'manifest.json' | 'index.tsx';

export interface ParsedConflictFile {
  fileName: string;
  absolutePath: string;
  targetFile: ConflictTargetFile;
}

export function parseConflictFileName(fileName: string): { targetFile: ConflictTargetFile } | null {
  const match = fileName.match(CONFLICT_FILE_NAME_REGEX);
  if (!match) {
    return null;
  }

  const baseName = match[1].toLowerCase();
  const conflictMarker = match[2];
  const extension = match[3].toLowerCase();
  const markerLooksLikeConflict = /^\d+$/.test(conflictMarker) || /conflict/i.test(conflictMarker);

  if (!markerLooksLikeConflict) {
    return null;
  }

  if (baseName === 'manifest' && extension === 'json') {
    return { targetFile: 'manifest.json' };
  }

  if (baseName === 'index' && extension === 'tsx') {
    return { targetFile: 'index.tsx' };
  }

  return null;
}

export async function listConflictFiles(pluginDir: string): Promise<ParsedConflictFile[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(pluginDir, { withFileTypes: true });
  } catch (err) {
    // Plugin dir absent (ENOENT) is normal — recover silently. Any other read
    // failure silently reporting "no conflict files" is the dangerous case, so
    // make it observable before falling back to an empty list (behavior preserved).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err, pluginDir }, 'Failed to list plugin conflict files — treating as none');
    }
    return [];
  }

  const conflictFiles: ParsedConflictFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const parsed = parseConflictFileName(entry.name);
    if (!parsed) {
      continue;
    }

    conflictFiles.push({
      fileName: entry.name,
      absolutePath: path.join(pluginDir, entry.name),
      targetFile: parsed.targetFile,
    });
  }

  return conflictFiles.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

/**
 * Scans a Space's plugins directory for cloud sync conflict files.
 */
export async function detectPluginConflicts(pluginsDir: string): Promise<PluginConflict[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(pluginsDir, { withFileTypes: true });
  } catch (err) {
    // Plugins dir absent (ENOENT) is normal — recover silently. Any other read
    // failure silently reporting "no conflicts" is safety-adjacent dangerous, so
    // make it observable before falling back to an empty list (behavior preserved).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err, pluginsDir }, 'Failed to scan plugins directory for conflicts — treating as none (conflicts may be hidden)');
    }
    return [];
  }

  const spacePath = path.dirname(pluginsDir);
  const conflicts: PluginConflict[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const pluginId = entry.name;
    const pluginDir = path.join(pluginsDir, pluginId);
    const pluginConflictFiles = await listConflictFiles(pluginDir);
    if (pluginConflictFiles.length === 0) {
      continue;
    }

    conflicts.push({
      pluginId,
      conflictFiles: pluginConflictFiles.map((file) => file.fileName),
      spacePath,
    });
  }

  return conflicts.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}
