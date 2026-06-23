import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '@core/utils/atomicFileWrite';
import { isPathInsideLexical } from '@core/utils/systemUtils';
import { createReadmeHash } from './chiefOfStaffHygieneEligibilityService';

export const CHIEF_OF_STAFF_HYGIENE_BACKUP_SCHEMA_VERSION = 1;
export const CHIEF_OF_STAFF_HYGIENE_STATE_DIR = path.join(
  '.rebel',
  'chief-of-staff-hygiene',
);

export interface ChiefOfStaffHygieneManifestFileChange {
  originalPath: string;
  backupPath?: string;
  beforeHash?: string;
  afterHash?: string;
}

export interface ChiefOfStaffHygieneMovedSection {
  heading: string;
  topicPath: string;
  signpost: string;
}

export interface ChiefOfStaffHygieneDistilledSection {
  heading: string;
  topicPath: string;
  promptVersion: string;
  bullets: string[];
}

export interface ChiefOfStaffHygieneSkippedRiskyItem {
  reason: string;
  path?: string;
  heading?: string;
}

export interface ChiefOfStaffHygieneRunManifest {
  schemaVersion: typeof CHIEF_OF_STAFF_HYGIENE_BACKUP_SCHEMA_VERSION;
  runId: string;
  createdAt: string;
  originalReadmePath: string;
  readmeBackupPath: string;
  beforeHash: string;
  beforeBytes: number;
  afterHash?: string;
  afterBytes?: number;
  filesCreated: string[];
  filesRewritten: ChiefOfStaffHygieneManifestFileChange[];
  sectionsMoved: ChiefOfStaffHygieneMovedSection[];
  sectionsDistilled?: ChiefOfStaffHygieneDistilledSection[];
  duplicateBlocksRemoved?: number;
  skippedRiskyItems: ChiefOfStaffHygieneSkippedRiskyItem[];
  failures: string[];
}

export interface ChiefOfStaffHygieneNeededMarker {
  createdAt: string;
  reason: string;
  readmePath?: string;
}

export interface ChiefOfStaffHygieneBackupResult {
  runId: string;
  runDirectory: string;
  backupPath: string;
  manifestPath: string;
  manifest: ChiefOfStaffHygieneRunManifest;
}

export interface CreateChiefOfStaffHygieneBackupOptions {
  runId?: string;
  now?: Date;
  /**
   * Override the manifest `beforeHash`. Callers that have already read the
   * readme content at the start of their work should pass the hash of that
   * captured content so the manifest baseline matches the true pre-rewrite
   * state — not a fresh disk read that may include side effects from
   * intermediate steps (e.g. a distiller that mutated the readme).
   *
   * If omitted, the backup service re-reads the readme from disk and hashes
   * that content (legacy behavior). The on-disk backup file is always the
   * disk content at backup-time; only the manifest hash is overridden.
   */
  beforeHash?: string;
}

export async function createChiefOfStaffHygieneBackup(
  coreDirectory: string,
  readmePath: string,
  options: CreateChiefOfStaffHygieneBackupOptions = {},
): Promise<ChiefOfStaffHygieneBackupResult> {
  assertReadmePathIsSafe(coreDirectory, readmePath);
  await assertNoSymlinkInPath(coreDirectory, readmePath);

  const readmeContent = await fsp.readFile(readmePath, 'utf8');
  const runId = options.runId ?? randomUUID();
  const createdAt = (options.now ?? new Date()).toISOString();
  const safeRunId = sanitizeRunId(runId);
  const runDirectory = path.join(coreDirectory, CHIEF_OF_STAFF_HYGIENE_STATE_DIR, 'runs', safeRunId);
  const backupPath = path.join(runDirectory, 'README.md.before');
  const manifestPath = path.join(runDirectory, 'manifest.json');
  const manifest: ChiefOfStaffHygieneRunManifest = {
    schemaVersion: CHIEF_OF_STAFF_HYGIENE_BACKUP_SCHEMA_VERSION,
    runId,
    createdAt,
    originalReadmePath: toWorkspaceRelative(coreDirectory, readmePath),
    readmeBackupPath: toWorkspaceRelative(coreDirectory, backupPath),
    beforeHash: options.beforeHash ?? createReadmeHash(readmeContent),
    beforeBytes: Buffer.byteLength(readmeContent, 'utf8'),
    filesCreated: [],
    filesRewritten: [],
    sectionsMoved: [],
    skippedRiskyItems: [],
    failures: [],
  };

  await fsp.mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await writeDurable(backupPath, readmeContent);
  await writeDurable(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    runId,
    runDirectory,
    backupPath,
    manifestPath,
    manifest,
  };
}

export async function writeChiefOfStaffHygieneManifest(
  manifestPath: string,
  manifest: ChiefOfStaffHygieneRunManifest,
): Promise<void> {
  await writeDurable(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function markChiefOfStaffHygieneNeeded(
  coreDirectory: string,
  marker: ChiefOfStaffHygieneNeededMarker,
): Promise<void> {
  const markerPath = getChiefOfStaffHygieneNeededMarkerPath(coreDirectory);
  await fsp.mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  await writeDurable(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
}

export async function readChiefOfStaffHygieneNeededMarker(
  coreDirectory: string,
): Promise<ChiefOfStaffHygieneNeededMarker | null> {
  try {
    return JSON.parse(await fsp.readFile(getChiefOfStaffHygieneNeededMarkerPath(coreDirectory), 'utf8')) as ChiefOfStaffHygieneNeededMarker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function clearChiefOfStaffHygieneNeededMarker(coreDirectory: string): Promise<void> {
  await fsp.rm(getChiefOfStaffHygieneNeededMarkerPath(coreDirectory), { force: true });
}

export function getChiefOfStaffHygieneStateDirectory(coreDirectory: string): string {
  return path.join(coreDirectory, CHIEF_OF_STAFF_HYGIENE_STATE_DIR);
}

export function getChiefOfStaffHygieneNeededMarkerPath(coreDirectory: string): string {
  return path.join(getChiefOfStaffHygieneStateDirectory(coreDirectory), 'needs-hygiene.json');
}

function assertReadmePathIsSafe(coreDirectory: string, readmePath: string): void {
  assertPathInsideWorkspace(coreDirectory, readmePath, 'README path');
  if (path.basename(readmePath).toLowerCase() !== 'readme.md') {
    throw new Error('Chief-of-Staff hygiene backup target must be a README.md file.');
  }
}

function assertPathInsideWorkspace(coreDirectory: string, targetPath: string, label: string): void {
  if (!isPathInsideLexical(targetPath, coreDirectory)) {
    throw new Error(`Chief-of-Staff hygiene ${label} must stay inside the workspace.`);
  }
}

async function assertNoSymlinkInPath(coreDirectory: string, targetPath: string): Promise<void> {
  const relativeParts = path.relative(coreDirectory, targetPath).split(path.sep).filter(Boolean);
  let currentPath = coreDirectory;
  for (const part of relativeParts) {
    currentPath = path.join(currentPath, part);
    try {
      const stat = await fsp.lstat(currentPath);
      if (stat.isSymbolicLink()) {
        throw new Error('Chief-of-Staff hygiene backup path must not traverse symlinks.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}

function toWorkspaceRelative(coreDirectory: string, filePath: string): string {
  return path.relative(coreDirectory, filePath).replaceAll(path.sep, '/');
}

function sanitizeRunId(runId: string): string {
  const sanitized = runId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    return `run-${randomUUID()}`;
  }
  return sanitized;
}

async function writeDurable(filePath: string, data: string): Promise<void> {
  const result = await atomicWriteFile(filePath, data);
  if (!result.durable) {
    throw new Error(result.error ?? `Failed to write ${path.basename(filePath)}`);
  }
}
