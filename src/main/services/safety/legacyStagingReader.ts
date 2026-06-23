/**
 * Legacy Staging Reader
 *
 * @deprecated This file is for MIGRATION PURPOSES ONLY.
 * It provides minimal read-only access to the legacy Electron userData staging area
 * (memory-staging directory) to support migrating files to CoS pending.
 *
 * TODO: Safe to remove after v1.5 when all beta users have migrated.
 *
 * This file intentionally duplicates minimal code from the original stagingService.ts
 * to allow clean removal of that file while keeping migration functional.
 */

import { getPlatformConfig } from '@core/platform';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'legacyStagingReader' });

const STAGING_DIR_NAME = 'memory-staging';
const MANIFEST_FILE = 'manifest.json';
const STAGED_DIR = 'staged';

/**
 * @deprecated For migration only.
 */
export interface StagedFile {
  id: string;
  realPath: string;
  spaceName: string;
  spacePath: string;
  sessionId: string;
  baseHash: string;
  summary: string;
  stagedAt: number;
  sensitivity: 'high';
  sharing?: string;
}

interface StagingManifest {
  version: 1;
  files: StagedFile[];
}

let stagingDir: string | null = null;

function getStagingDir(): string {
  if (!stagingDir) {
    stagingDir = path.join(getPlatformConfig().userDataPath, STAGING_DIR_NAME);
  }
  return stagingDir;
}

function getManifestPath(): string {
  return path.join(getStagingDir(), MANIFEST_FILE);
}

function getStagedFilePath(id: string): string {
  return path.join(getStagingDir(), STAGED_DIR, `${id}.content`);
}

function getMetadataPath(id: string): string {
  return path.join(getStagingDir(), STAGED_DIR, `${id}.meta.json`);
}

async function readManifest(): Promise<StagingManifest> {
  try {
    const content = await fs.readFile(getManifestPath(), 'utf-8');
    return JSON.parse(content) as StagingManifest;
  } catch {
    return { version: 1, files: [] };
  }
}

async function writeManifest(manifest: StagingManifest): Promise<void> {
  const manifestPath = getManifestPath();
  const tempPath = `${manifestPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(manifest, null, 2), 'utf-8');
  await fs.rename(tempPath, manifestPath);
}

/**
 * Get all staged files from the legacy staging area.
 *
 * @deprecated For migration only. Use CoS pending instead.
 * TODO: Safe to remove after v1.5 when all beta users have migrated.
 */
export async function getAllStagedFiles(): Promise<StagedFile[]> {
  const manifest = await readManifest();
  return manifest.files;
}

/**
 * Get the content of a staged file by ID.
 *
 * @deprecated For migration only. Use CoS pending instead.
 * TODO: Safe to remove after v1.5 when all beta users have migrated.
 */
export async function getStagedContent(id: string): Promise<string | null> {
  try {
    return await fs.readFile(getStagedFilePath(id), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Discard a staged file from the legacy staging area.
 *
 * @deprecated For migration only. Use CoS pending instead.
 * TODO: Safe to remove after v1.5 when all beta users have migrated.
 */
export async function discardStagedFile(id: string): Promise<{ status: 'success' | 'not-found' | 'error'; error?: string }> {
  try {
    const manifest = await readManifest();
    const fileIndex = manifest.files.findIndex(f => f.id === id);

    if (fileIndex < 0) {
      return { status: 'not-found', error: 'Staged file not found' };
    }

    await fs.unlink(getStagedFilePath(id)).catch(() => {});
    await fs.unlink(getMetadataPath(id)).catch(() => {});

    manifest.files.splice(fileIndex, 1);
    await writeManifest(manifest);

    log.info({ id }, 'Discarded legacy staged file');

    return { status: 'success' };
  } catch (error) {
    log.error({ err: error, id }, 'Failed to discard legacy staged file');
    return { status: 'error', error: String(error) };
  }
}
