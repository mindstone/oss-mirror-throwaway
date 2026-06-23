import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getPlatformConfig } from '@core/platform';
import { createScopedLogger } from '@core/logger';
import { atomicCredentialWrite } from '@core/utils/atomicCredentialWrite';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { safeWalkDirectory, isSafeWalkComplete } from '@core/utils/safeWalkDirectory';

const log = createScopedLogger({ service: 'userDataBackupService' });

const VAULT_DIR_MODE = 0o700;
const VAULT_FILE_MODE = 0o600;
const DEFAULT_RETENTION_COUNT = 10;
const DEFAULT_RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Hard ceiling on the total size of retained snapshots. The backup is mostly
 * small text/JSON, but a few allowlisted files grow over time (notably the
 * append-only cost ledger), so a count-only cap could creep up. This budget
 * bounds the whole vault regardless of per-file growth: oldest snapshots are
 * pruned until the kept set fits, always keeping at least the newest.
 */
const DEFAULT_RETENTION_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const DEFAULT_THROTTLE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DIRECTORY_BYTES = 25 * 1024 * 1024;
const SNAPSHOT_RE = /^snapshot-(\d{8})-(\d{6})(?:-\d+)?$/;
// A manifest-less snapshot dir younger than this may be a concurrent in-progress
// run; never prune it. Older manifest-less dirs are clearly-stale crash junk.
const STALE_PARTIAL_SNAPSHOT_MS = 10 * 60 * 1000;

// WARNING: this allowlist is for LOCAL on-machine backups and deliberately
// includes keychain-encrypted token stores (`*-oauth-tokens.json`, `auth-tokens.json`)
// and credential-bearing config (`mcp/super-mcp-router.json`, `connector-contributions.json`).
// Do NOT reuse it for a migration/export bundle that leaves the machine — those tokens
// can't decrypt elsewhere and the configs hold plaintext secrets. The migration feature
// uses its own positive allowlist + classification SSOT instead
// (see src/core/services/migration/migrationClassification.ts).
export const USER_DATA_BACKUP_ALLOWLIST = [
  'app-settings.json',
  'auth-tokens.json',
  'openrouter-oauth-tokens.json',
  'codex-oauth-tokens.json',
  'claude-max-oauth-tokens.json',
  'connector-contributions.json',
  'automations.json',
  'cloud-service-client-id.json',
  'mcp/super-mcp-router.json',
  'google-workspace-mcp',
  'mcp/slack',
  'slack-mcp',
  'microsoft-mcp',
  'inbox.json',
  'inbox-index.json',
  'inbox',
  'focus-goals.json',
  'user-tasks.json',
  'memory-history.json',
  'memory-update-captures.jsonl',
  'safety-prompt.json',
  'pending-tool-approvals.json',
  'mcp-apps-trust.json',
  'plugin-activation.json',
  'plugin-storage.json',
  'plugin-data',
  'source-metadata.json',
  'cost-ledger.jsonl',
  'time-saved.json',
] as const;

export type UserDataBackupManifestEntry = {
  relativePath: string;
  sizeBytes: number | null;
  sha256: string | null;
  copied: 'ok' | 'failed';
  error?: string;
};

export type UserDataBackupManifest = {
  createdAt: string;
  appVersion: string;
  entries: UserDataBackupManifestEntry[];
};

export type UserDataBackupResult = {
  skipped: false;
  backupRoot: string;
  snapshotPath: string;
  manifest: UserDataBackupManifest;
} | {
  skipped: true;
  reason: 'recent-snapshot';
  backupRoot: string;
  newestSnapshotPath: string;
};

export type UserDataBackupOptions = {
  userDataPath?: string;
  backupRoot?: string;
  appVersion?: string;
  now?: Date;
  allowlist?: readonly string[];
  retentionCount?: number;
  retentionMaxAgeMs?: number;
  retentionMaxTotalBytes?: number;
  throttleMs?: number;
  maxDirectoryBytes?: number;
};

type CandidateFile = {
  sourcePath: string;
  relativePath: string;
  sizeBytes: number;
};

type SnapshotInfo = {
  name: string;
  path: string;
  createdAtMs: number;
  /** True only if a readable manifest.json exists (the completion marker). */
  hasManifest: boolean;
};

export function resolveUserDataBackupRoot(userDataPath = getPlatformConfig().userDataPath): string {
  const resolvedUserDataPath = path.resolve(userDataPath);
  return path.join(path.dirname(resolvedUserDataPath), `${path.basename(resolvedUserDataPath)}-backups`);
}

function resolveAppVersion(options: UserDataBackupOptions): string {
  if (options.appVersion) return options.appVersion;
  try {
    return getPlatformConfig().version;
  } catch {
    return 'unknown';
  }
}

function toBackupTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    '-',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('');
}

function parseSnapshotName(name: string): number | null {
  const match = name.match(SNAPSHOT_RE);
  if (!match) return null;
  const [, datePart, timePart] = match;
  const year = Number(datePart.slice(0, 4));
  const month = Number(datePart.slice(4, 6)) - 1;
  const day = Number(datePart.slice(6, 8));
  const hour = Number(timePart.slice(0, 2));
  const minute = Number(timePart.slice(2, 4));
  const second = Number(timePart.slice(4, 6));
  return Date.UTC(year, month, day, hour, minute, second);
}

function normalizeAllowlistPath(relativePath: string): string {
  const normalized = path.normalize(relativePath);
  if (
    normalized === '.' ||
    path.isAbsolute(normalized) ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized === '..'
  ) {
    throw new Error(`Invalid userData backup allowlist path: ${relativePath}`);
  }
  return normalized;
}

async function ensureVaultDirectory(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: VAULT_DIR_MODE });
  if (process.platform !== 'win32') {
    await fs.chmod(dirPath, VAULT_DIR_MODE);
  }
}

async function collectFiles(
  userDataPath: string,
  relativePath: string,
  maxDirectoryBytes: number,
): Promise<{ files: CandidateFile[]; failure?: UserDataBackupManifestEntry }> {
  const normalizedRelativePath = normalizeAllowlistPath(relativePath);
  const sourcePath = path.join(userDataPath, normalizedRelativePath);

  let stats;
  try {
    stats = await fs.lstat(sourcePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return { files: [] };
    return {
      files: [],
      failure: {
        relativePath: normalizedRelativePath,
        sizeBytes: null,
        sha256: null,
        copied: 'failed',
        error: code ?? 'stat_failed',
      },
    };
  }

  if (stats.isSymbolicLink()) {
    return {
      files: [],
      failure: {
        relativePath: normalizedRelativePath,
        sizeBytes: null,
        sha256: null,
        copied: 'failed',
        error: 'symlink_not_backed_up',
      },
    };
  }

  if (stats.isFile()) {
    return {
      files: [{
        sourcePath,
        relativePath: normalizedRelativePath,
        sizeBytes: stats.size,
      }],
    };
  }

  if (!stats.isDirectory()) {
    return {
      files: [],
      failure: {
        relativePath: normalizedRelativePath,
        sizeBytes: null,
        sha256: null,
        copied: 'failed',
        error: 'unsupported_file_type',
      },
    };
  }

  // Directory: walk via the canonical bounded, symlink-loop-safe primitive
  // (the bounded-walker gate forbids hand-rolled recursion). We never descend
  // through symlinked dirs, skip symlinked files, enforce the per-directory
  // byte cap (aborting the walk once exceeded), and treat a truncated/partial
  // walk as a failure so the manifest never implies a complete dir backup it
  // did not make.
  const files: CandidateFile[] = [];
  let totalBytes = 0;
  let capExceeded = false;
  const capController = new AbortController();

  const walkResult = await safeWalkDirectory(sourcePath, {
    signal: capController.signal,
    // Opt out of the default-on cloud-symlink skip: this collector already
    // refuses to descend into ANY symlinked directory (`onDirectory` below) and
    // skips symlinked files, AND it treats any non-complete walk as a failure
    // (`isSafeWalkComplete` below). If the cloud-skip fired it would push a
    // `'cloud-symlink-skipped'` truncation reason for a symlink we were already
    // going to exclude, turning a clean skip into a spurious backup failure.
    skipCloudSymlinkTargets: false,
    onDirectory: (info) => !info.isSymbolicLink,
    onFile: async (info) => {
      if (info.viaSymlink) return;
      let size: number;
      try {
        const fileStat = await fs.lstat(info.absolutePath);
        if (!fileStat.isFile()) return;
        size = fileStat.size;
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'userDataBackup.collectFiles.stat',
          reason: 'file vanished/unreadable between walk and stat; skip it',
        });
        return;
      }
      if (totalBytes + size > maxDirectoryBytes) {
        capExceeded = true;
        capController.abort();
        return;
      }
      totalBytes += size;
      files.push({
        sourcePath: info.absolutePath,
        relativePath: path.relative(userDataPath, info.absolutePath),
        sizeBytes: size,
      });
    },
  });

  if (capExceeded) {
    return {
      files: [],
      failure: {
        relativePath: normalizedRelativePath,
        sizeBytes: totalBytes,
        sha256: null,
        copied: 'failed',
        error: 'directory_exceeds_backup_size_cap',
      },
    };
  }

  if (!isSafeWalkComplete(walkResult)) {
    return {
      files,
      failure: {
        relativePath: normalizedRelativePath,
        sizeBytes: null,
        sha256: null,
        copied: 'failed',
        error: `directory_walk_incomplete:${walkResult.truncatedReasons.join(',')}`,
      },
    };
  }

  return { files };
}

async function copyCandidateFile(
  candidate: CandidateFile,
  snapshotPath: string,
): Promise<UserDataBackupManifestEntry> {
  try {
    const data = await fs.readFile(candidate.sourcePath);
    // Hash and write exactly the same raw bytes (binary-safe: a non-UTF8 file
    // must round-trip byte-identical and match its manifest hash).
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const destinationPath = path.join(snapshotPath, candidate.relativePath);
    await atomicCredentialWrite(destinationPath, data, { mode: VAULT_FILE_MODE });
    return {
      relativePath: candidate.relativePath,
      sizeBytes: data.byteLength,
      sha256,
      copied: 'ok',
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return {
      relativePath: candidate.relativePath,
      sizeBytes: candidate.sizeBytes,
      sha256: null,
      copied: 'failed',
      error: code ?? 'copy_failed',
    };
  }
}

async function snapshotHasManifest(snapshotPath: string): Promise<boolean> {
  try {
    const manifestStat = await fs.lstat(path.join(snapshotPath, 'manifest.json'));
    return manifestStat.isFile();
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'userDataBackup.snapshotHasManifest',
      reason: 'manifest missing/unreadable; snapshot treated as incomplete',
    });
    return false;
  }
}

/**
 * Enumerate every directory whose name matches the snapshot pattern, gated to
 * REAL directories (no symlinks, no non-dir entries). Each is annotated with
 * whether it carries a readable `manifest.json` completion marker. Sorted
 * newest-first. ENOENT backupRoot → empty list.
 */
async function listSnapshotDirs(backupRoot: string): Promise<SnapshotInfo[]> {
  let dirents;
  try {
    dirents = await fs.readdir(backupRoot, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return [];
    throw error;
  }

  const result: SnapshotInfo[] = [];
  for (const dirent of dirents) {
    // Skip symlinks and anything that is not a real directory.
    if (dirent.isSymbolicLink() || !dirent.isDirectory()) continue;
    const createdAtMs = parseSnapshotName(dirent.name);
    if (createdAtMs === null) continue;
    const snapshotPath = path.join(backupRoot, dirent.name);
    result.push({
      name: dirent.name,
      path: snapshotPath,
      createdAtMs,
      hasManifest: await snapshotHasManifest(snapshotPath),
    });
  }
  return result.sort((a, b) => b.createdAtMs - a.createdAtMs);
}

/**
 * Snapshots that are VALID for throttle/retention purposes: real dirs that
 * carry a completion-marker manifest. A crashed partial snapshot (dir created,
 * manifest never written) is excluded, so it neither throttles backups nor is
 * treated as a retained snapshot.
 */
async function listSnapshots(backupRoot: string): Promise<SnapshotInfo[]> {
  return (await listSnapshotDirs(backupRoot)).filter((snapshot) => snapshot.hasManifest);
}

/**
 * Total bytes a snapshot occupies, summed from its manifest's successfully-copied
 * entries (cheap — no directory walk). Unreadable manifest → 0 for budgeting.
 */
async function snapshotSizeBytes(snapshotPath: string): Promise<number> {
  try {
    const raw = await fs.readFile(path.join(snapshotPath, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(raw) as UserDataBackupManifest;
    return manifest.entries.reduce(
      (sum, entry) => sum + (entry.copied === 'ok' ? entry.sizeBytes ?? 0 : 0),
      0,
    );
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'userDataBackup.snapshotSizeBytes',
      reason: 'manifest unreadable; treat snapshot size as 0 for budgeting',
    });
    return 0;
  }
}

/**
 * lstat the backupRoot; returns true and logs if it is a symlink (we then
 * refuse to back up / prune through it). Missing root → not a symlink.
 */
async function isSymlinkedBackupRoot(backupRoot: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(backupRoot);
    return stat.isSymbolicLink();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      ignoreBestEffortCleanup(error, {
        operation: 'userDataBackup.isSymlinkedBackupRoot',
        reason: 'backup root does not exist yet; not a symlink',
      });
      return false;
    }
    // Unknown stat failure: fail safe by treating it as unusable.
    log.warn({ err: error, backupRoot }, 'Unable to lstat userData backup root');
    return true;
  }
}

async function resolveSnapshotPath(backupRoot: string, now: Date): Promise<string> {
  const baseName = `snapshot-${toBackupTimestamp(now)}`;
  let candidate = path.join(backupRoot, baseName);
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    try {
      await fs.mkdir(candidate, { mode: VAULT_DIR_MODE });
      if (process.platform !== 'win32') {
        await fs.chmod(candidate, VAULT_DIR_MODE);
      }
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'EEXIST') throw error;
      candidate = path.join(backupRoot, `${baseName}-${suffix}`);
    }
  }
  throw new Error(`Unable to create unique userData backup snapshot directory for ${baseName}`);
}

export async function pruneUserDataBackupSnapshots(
  backupRoot: string,
  options: Pick<UserDataBackupOptions, 'now' | 'retentionCount' | 'retentionMaxAgeMs' | 'retentionMaxTotalBytes'> = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const retentionCount = Math.max(1, options.retentionCount ?? DEFAULT_RETENTION_COUNT);
  const retentionMaxAgeMs = options.retentionMaxAgeMs ?? DEFAULT_RETENTION_MAX_AGE_MS;
  const retentionMaxTotalBytes = options.retentionMaxTotalBytes ?? DEFAULT_RETENTION_MAX_TOTAL_BYTES;

  // Refuse to prune through a symlinked backup root.
  if (await isSymlinkedBackupRoot(backupRoot)) {
    log.warn({ backupRoot }, 'Refusing to prune userData backups: backup root is a symlink');
    return;
  }

  const allDirs = await listSnapshotDirs(backupRoot);
  const validSnapshots = allDirs.filter((snapshot) => snapshot.hasManifest);

  // Retention is computed over the manifest-valid set only, newest-first.
  // A snapshot is deleted if it busts the count cap, the age cap, OR would push
  // the kept set past the total-size budget — whichever hits first. Index 0
  // (newest valid snapshot) is always retained, even if it alone exceeds the
  // budget (never leave the user with zero backups).
  let cumulativeBytes = 0;
  const toDelete: SnapshotInfo[] = [];
  for (let index = 0; index < validSnapshots.length; index += 1) {
    const snapshot = validSnapshots[index];
    const sizeBytes = await snapshotSizeBytes(snapshot.path);
    if (index === 0) {
      cumulativeBytes += sizeBytes;
      continue;
    }
    const tooMany = index >= retentionCount;
    const tooOld = now.getTime() - snapshot.createdAtMs > retentionMaxAgeMs;
    const overBudget = cumulativeBytes + sizeBytes > retentionMaxTotalBytes;
    if (tooMany || tooOld || overBudget) {
      toDelete.push(snapshot);
      continue;
    }
    cumulativeBytes += sizeBytes;
  }
  await Promise.all(
    toDelete.map((snapshot) => fs.rm(snapshot.path, { recursive: true, force: true })),
  );

  // Best-effort cleanup of clearly-stale, manifest-less junk dirs (a crashed
  // run that never wrote a manifest). Only those older than the in-progress
  // window are removed, so a concurrent in-progress snapshot is never deleted.
  const stalePartials = allDirs.filter(
    (snapshot) =>
      !snapshot.hasManifest &&
      now.getTime() - snapshot.createdAtMs > STALE_PARTIAL_SNAPSHOT_MS,
  );
  await Promise.all(stalePartials.map(async (snapshot) => {
    try {
      await fs.rm(snapshot.path, { recursive: true, force: true });
    } catch (error) {
      log.warn({ err: error, snapshotPath: snapshot.path }, 'Failed to clean stale partial snapshot');
    }
  }));
}

export async function runUserDataBackupNow(
  options: UserDataBackupOptions = {},
): Promise<Extract<UserDataBackupResult, { skipped: false }>> {
  const userDataPath = path.resolve(options.userDataPath ?? getPlatformConfig().userDataPath);
  const backupRoot = path.resolve(options.backupRoot ?? resolveUserDataBackupRoot(userDataPath));
  const now = options.now ?? new Date();
  const allowlist = options.allowlist ?? USER_DATA_BACKUP_ALLOWLIST;
  const maxDirectoryBytes = options.maxDirectoryBytes ?? DEFAULT_MAX_DIRECTORY_BYTES;

  // Refuse to operate through a symlinked backup root (vault integrity).
  if (await isSymlinkedBackupRoot(backupRoot)) {
    throw new Error(`Refusing to back up: userData backup root is a symlink (${backupRoot})`);
  }

  await ensureVaultDirectory(backupRoot);
  const snapshotPath = await resolveSnapshotPath(backupRoot, now);

  const entries: UserDataBackupManifestEntry[] = [];
  for (const relativePath of allowlist) {
    const { files, failure } = await collectFiles(userDataPath, relativePath, maxDirectoryBytes);
    for (const file of files) {
      entries.push(await copyCandidateFile(file, snapshotPath));
    }
    if (failure) entries.push(failure);
  }

  const manifest: UserDataBackupManifest = {
    createdAt: now.toISOString(),
    appVersion: resolveAppVersion(options),
    entries,
  };
  await atomicCredentialWrite(
    path.join(snapshotPath, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    { mode: VAULT_FILE_MODE },
  );

  // Prune is best-effort cleanup AFTER the snapshot + manifest already
  // succeeded; a prune failure must not fail the (successful) backup.
  try {
    await pruneUserDataBackupSnapshots(backupRoot, {
      now,
      retentionCount: options.retentionCount,
      retentionMaxAgeMs: options.retentionMaxAgeMs,
      retentionMaxTotalBytes: options.retentionMaxTotalBytes,
    });
  } catch (error) {
    log.warn({ err: error, backupRoot }, 'userData backup snapshot created; pruning failed');
  }

  return {
    skipped: false,
    backupRoot,
    snapshotPath,
    manifest,
  };
}

export async function runUserDataBackupIfDue(
  options: UserDataBackupOptions = {},
): Promise<UserDataBackupResult> {
  const userDataPath = path.resolve(options.userDataPath ?? getPlatformConfig().userDataPath);
  const backupRoot = path.resolve(options.backupRoot ?? resolveUserDataBackupRoot(userDataPath));
  const now = options.now ?? new Date();
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;

  // Refuse to read/back-up through a symlinked backup root.
  if (await isSymlinkedBackupRoot(backupRoot)) {
    throw new Error(`Refusing to back up: userData backup root is a symlink (${backupRoot})`);
  }

  // Throttle is satisfied only by a manifest-VALID newest snapshot, so a
  // crashed partial snapshot does not wrongly suppress backups for 24h.
  const [newest] = await listSnapshots(backupRoot);

  if (newest && now.getTime() - newest.createdAtMs < throttleMs) {
    return {
      skipped: true,
      reason: 'recent-snapshot',
      backupRoot,
      newestSnapshotPath: newest.path,
    };
  }

  return runUserDataBackupNow({ ...options, userDataPath, backupRoot, now });
}

export function scheduleUserDataBackupOnStartup(options: UserDataBackupOptions = {}): void {
  void runUserDataBackupIfDue(options)
    .then((result) => {
      if (result.skipped) {
        log.debug({ backupRoot: result.backupRoot }, 'Skipped userData backup; recent snapshot exists');
        return;
      }
      const failedCount = result.manifest.entries.filter((entry) => entry.copied === 'failed').length;
      log.info(
        {
          backupRoot: result.backupRoot,
          snapshotName: path.basename(result.snapshotPath),
          copiedCount: result.manifest.entries.length - failedCount,
          failedCount,
        },
        'Created userData backup snapshot',
      );
    })
    .catch((err) => {
      log.warn({ err }, 'UserData backup snapshot failed during startup');
    });
}
