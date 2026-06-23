import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataPath } from '@main/utils/dataPaths';
import { toPortablePath } from '@core/utils/portablePath';
import { WORKSPACE_CONFLICT_MARKER } from '@shared/conflictPatterns';
import { createScopedLogger } from '@core/logger';
import { writeFileAtomicInTargetDirSync } from './cloudAtomicWrite';

const log = createScopedLogger({ service: 'cloudConflictQuarantine' });

export interface QuarantinedWorkspaceConflict {
  localPath: string;
  cloudCopyPath: string;
  relativePath: string;
  createdAt: number;
}

interface PersistedQuarantinedWorkspaceConflict extends QuarantinedWorkspaceConflict {
  coreDirectory: string;
}

const CASE_INSENSITIVE_PLATFORMS = new Set(['darwin', 'win32']);
const quarantinedConflicts = new Map<string, PersistedQuarantinedWorkspaceConflict>();
let loaded = false;
let persistPathOverride: string | null = null;

function normalizePathForKey(inputPath: string): string {
  const portable = toPortablePath(path.resolve(inputPath)).normalize('NFC');
  return CASE_INSENSITIVE_PLATFORMS.has(process.platform) ? portable.toLowerCase() : portable;
}

function normalizeRelativePath(inputPath: string): string {
  const portable = toPortablePath(inputPath).normalize('NFC').replace(/^\/+/, '');
  return CASE_INSENSITIVE_PLATFORMS.has(process.platform) ? portable.toLowerCase() : portable;
}

function buildKey(coreDirectory: string, relativePath: string): string {
  return `${normalizePathForKey(coreDirectory)}::${normalizeRelativePath(relativePath)}`;
}

function getStorePath(): string {
  return persistPathOverride ?? path.join(getDataPath(), 'cloud-workspace-conflicts', 'index.json');
}

function workspaceQuarantineRoot(coreDirectory: string): string {
  const workspaceHash = crypto.createHash('sha1').update(path.resolve(coreDirectory)).digest('hex').slice(0, 16);
  return path.join(path.dirname(getStorePath()), workspaceHash);
}

/** Root that contains every workspace's quarantine subdir (and the index). */
function quarantineRoot(): string {
  return path.dirname(getStorePath());
}

/**
 * True if `cloudCopyPath` still resolves UNDER the quarantine root
 * (`userData/cloud-workspace-conflicts/...`). The persisted `cloudCopyPath`
 * comes from JSON on disk, so before READING or UNLINKING it we must confirm it
 * hasn't been pointed at an arbitrary path (a corrupt/tampered index could
 * otherwise make a read/unlink escape the quarantine sandbox).
 */
export function isPathWithinQuarantineRoot(cloudCopyPath: string): boolean {
  const root = path.resolve(quarantineRoot());
  const resolved = path.resolve(cloudCopyPath);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function buildConflictFilePath(coreDirectory: string, relativePath: string): string {
  const portable = toPortablePath(relativePath);
  const dir = path.dirname(portable);
  const ext = path.extname(portable);
  const base = path.basename(portable, ext);
  const conflictFileName = ext
    ? `${base}${WORKSPACE_CONFLICT_MARKER}${ext}`
    : `${base}${WORKSPACE_CONFLICT_MARKER}`;
  return path.join(
    workspaceQuarantineRoot(coreDirectory),
    dir === '.' ? '' : dir,
    conflictFileName,
  );
}

function load(): void {
  if (loaded) return;
  loaded = true;

  const storePath = getStorePath();
  try {
    if (!fs.existsSync(storePath)) return;
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) {
      preserveCorruptIndex(storePath, 'index is not a JSON array');
      quarantinedConflicts.clear();
      return;
    }

    quarantinedConflicts.clear();
    for (const entry of parsed) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as PersistedQuarantinedWorkspaceConflict).coreDirectory !== 'string' ||
        typeof (entry as PersistedQuarantinedWorkspaceConflict).localPath !== 'string' ||
        typeof (entry as PersistedQuarantinedWorkspaceConflict).cloudCopyPath !== 'string' ||
        typeof (entry as PersistedQuarantinedWorkspaceConflict).relativePath !== 'string' ||
        typeof (entry as PersistedQuarantinedWorkspaceConflict).createdAt !== 'number'
      ) {
        continue;
      }
      const persisted = entry as PersistedQuarantinedWorkspaceConflict;
      quarantinedConflicts.set(buildKey(persisted.coreDirectory, persisted.relativePath), persisted);
    }
  } catch (err) {
    // This index is the ONLY post-restart recovery affordance for the
    // quarantined `.conflict-cloud` bytes, which live OUTSIDE the workspace.
    // Unlike the pending-update store, we must NOT silently drop recovery on a
    // corrupt index. Preserve it (rename to index.json.corrupt-<ts>) so the
    // metadata mapping bytes -> original workspace path stays recoverable, and
    // log it. We can't reconstruct the index from the quarantine tree alone:
    // the on-disk path encodes only a sha1 of coreDirectory (not reversible to
    // localPath/coreDirectory), so preserving the corrupt index is strictly
    // safer than scanning + guessing.
    preserveCorruptIndex(storePath, err instanceof Error ? err.message : String(err));
    quarantinedConflicts.clear();
  }
}

/**
 * Rename a corrupt quarantine index aside (index.json.corrupt-<ts>) and log it,
 * so the bytes it pointed at remain recoverable. Best-effort: if the rename
 * itself fails we still log, never throw (load() must not crash the pull loop).
 */
function preserveCorruptIndex(storePath: string, reason: string): void {
  const preservedPath = `${storePath}.corrupt-${Date.now()}`;
  try {
    if (fs.existsSync(storePath)) {
      fs.renameSync(storePath, preservedPath);
    }
    log.warn(
      { storePath, preservedPath, reason },
      'Quarantine index corrupt; preserved aside (quarantined cloud bytes remain on disk and recoverable)',
    );
  } catch (renameErr) {
    log.warn(
      {
        storePath,
        reason,
        renameErr: renameErr instanceof Error ? renameErr.message : String(renameErr),
      },
      'Quarantine index corrupt and could not be preserved; quarantined cloud bytes are still on disk under the quarantine root',
    );
  }
}

function persist(): void {
  const storePath = getStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  // Atomic write (temp-then-rename in the same dir): the index is the only
  // recovery affordance for the out-of-workspace quarantined bytes, so a crash
  // mid-write must never tear it. userData is intra-volume.
  writeFileAtomicInTargetDirSync(storePath, JSON.stringify(Array.from(quarantinedConflicts.values()), null, 2));
}

export function quarantineWorkspaceCloudConflict(params: {
  coreDirectory: string;
  relativePath: string;
  localPath: string;
  content: string;
  nowMs?: number;
}): QuarantinedWorkspaceConflict {
  load();
  const cloudCopyPath = buildConflictFilePath(params.coreDirectory, params.relativePath);
  fs.mkdirSync(path.dirname(cloudCopyPath), { recursive: true });
  fs.writeFileSync(cloudCopyPath, params.content, 'utf8');

  const entry: PersistedQuarantinedWorkspaceConflict = {
    coreDirectory: path.resolve(params.coreDirectory),
    localPath: path.resolve(params.localPath),
    cloudCopyPath,
    relativePath: toPortablePath(params.relativePath),
    createdAt: params.nowMs ?? Date.now(),
  };
  quarantinedConflicts.set(buildKey(params.coreDirectory, params.relativePath), entry);
  persist();
  const { coreDirectory: _coreDirectory, ...publicEntry } = entry;
  return publicEntry;
}

export function listQuarantinedWorkspaceConflicts(coreDirectory: string): QuarantinedWorkspaceConflict[] {
  load();
  const workspacePrefix = `${normalizePathForKey(coreDirectory)}::`;
  const staleKeys: string[] = [];
  const entries: QuarantinedWorkspaceConflict[] = [];

  for (const [key, entry] of quarantinedConflicts) {
    if (!key.startsWith(workspacePrefix)) continue;
    // Path-safety: never surface an entry whose cloudCopyPath escaped the
    // quarantine root (corrupt/tampered index). Drop it so a downstream
    // read/unlink can't touch an arbitrary file.
    if (!isPathWithinQuarantineRoot(entry.cloudCopyPath)) {
      log.warn(
        { cloudCopyPath: entry.cloudCopyPath, relativePath: entry.relativePath },
        'Quarantine entry cloudCopyPath is outside the quarantine root; dropping from list',
      );
      staleKeys.push(key);
      continue;
    }
    if (!fs.existsSync(entry.cloudCopyPath)) {
      staleKeys.push(key);
      continue;
    }
    const { coreDirectory: _coreDirectory, ...publicEntry } = entry;
    entries.push(publicEntry);
  }

  if (staleKeys.length > 0) {
    for (const key of staleKeys) quarantinedConflicts.delete(key);
    persist();
  }

  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function removeQuarantinedWorkspaceConflict(coreDirectory: string, relativePath: string): boolean {
  load();
  const key = buildKey(coreDirectory, relativePath);
  const existing = quarantinedConflicts.get(key);
  if (!existing) return false;
  try {
    // Path-safety: only unlink a cloudCopyPath that still lives under the
    // quarantine root. A corrupt/tampered persisted entry pointing elsewhere
    // must not let removal escape the sandbox; we still drop the index entry.
    if (isPathWithinQuarantineRoot(existing.cloudCopyPath)) {
      fs.rmSync(existing.cloudCopyPath, { force: true });
    } else {
      log.warn(
        { cloudCopyPath: existing.cloudCopyPath, relativePath: existing.relativePath },
        'Quarantine entry cloudCopyPath is outside the quarantine root; skipping unlink, dropping index entry',
      );
    }
  } finally {
    quarantinedConflicts.delete(key);
    persist();
  }
  return true;
}

export function _resetQuarantinedWorkspaceConflictsForTesting(testPersistPath?: string | null): void {
  quarantinedConflicts.clear();
  loaded = false;
  persistPathOverride = testPersistPath ?? null;
}
