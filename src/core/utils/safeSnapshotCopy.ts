import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicCredentialWrite } from '@core/utils/atomicCredentialWrite';
import { isSafeWalkComplete, safeWalkDirectory } from '@core/utils/safeWalkDirectory';
import { relativePortablePath, toPortablePath } from '@core/utils/portablePath';

const SNAPSHOT_FILE_MODE = 0o600;

export interface SafeSnapshotFileCandidate {
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly sizeBytes: number;
}

export interface SafeSnapshotEntry {
  readonly relPath: string;
  readonly sha256: string;
  readonly bytes: number;
}

export type SafeSnapshotFailure = {
  readonly relativePath: string;
  readonly error: string;
  readonly sizeBytes: number | null;
};

export interface CollectSafeSnapshotFilesOptions {
  readonly maxDirectoryBytes?: number;
  readonly shouldIncludeRelativePath?: (relativePath: string) => boolean;
}

export interface CollectSafeSnapshotFilesResult {
  readonly files: SafeSnapshotFileCandidate[];
  readonly failure?: SafeSnapshotFailure;
}

export interface CopyStableSnapshotFileOptions {
  readonly afterCopyBeforeVerify?: (candidate: SafeSnapshotFileCandidate) => Promise<void> | void;
}

export class SafeSnapshotCopyError extends Error {
  readonly code: string;
  readonly relativePath?: string;

  constructor(code: string, message: string, relativePath?: string) {
    super(message);
    this.name = 'SafeSnapshotCopyError';
    this.code = code;
    this.relativePath = relativePath;
  }
}

export function sha256Buffer(data: Buffer | Uint8Array | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function normalizeSnapshotRelativePath(relativePath: string): string {
  const slashPath = relativePath.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(slashPath) || slashPath.startsWith('/')) {
    throw new SafeSnapshotCopyError(
      'invalid-relative-path',
      `Snapshot path must be relative: ${relativePath}`,
      relativePath,
    );
  }
  const normalized = path.posix.normalize(slashPath);
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.split('/').includes('..')
  ) {
    throw new SafeSnapshotCopyError(
      'invalid-relative-path',
      `Snapshot path must not traverse outside the root: ${relativePath}`,
      relativePath,
    );
  }
  return normalized;
}

export function resolveSnapshotChildPath(rootPath: string, relativePath: string): string {
  const root = path.resolve(rootPath);
  const normalized = normalizeSnapshotRelativePath(relativePath);
  const resolved = path.resolve(root, ...normalized.split('/'));
  const relative = path.relative(root, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new SafeSnapshotCopyError(
    'path-containment-failed',
    `Snapshot path resolved outside the root: ${relativePath}`,
    relativePath,
  );
}

export function snapshotRelativePathFromRoot(rootPath: string, absolutePath: string): string {
  return normalizeSnapshotRelativePath(relativePortablePath(path.resolve(rootPath), path.resolve(absolutePath)));
}

export async function collectSafeSnapshotFiles(
  rootPath: string,
  relativePath: string,
  options: CollectSafeSnapshotFilesOptions = {},
): Promise<CollectSafeSnapshotFilesResult> {
  const normalizedRelativePath = normalizeSnapshotRelativePath(relativePath);
  const sourcePath = resolveSnapshotChildPath(rootPath, normalizedRelativePath);

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
        error: 'symlink_not_copied',
      },
    };
  }

  if (stats.isFile()) {
    if (options.shouldIncludeRelativePath?.(normalizedRelativePath) === false) return { files: [] };
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
        error: 'unsupported_file_type',
      },
    };
  }

  const files: SafeSnapshotFileCandidate[] = [];
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
    // going to exclude, turning a clean skip into a spurious snapshot failure.
    skipCloudSymlinkTargets: false,
    onDirectory: (info) => !info.isSymbolicLink,
    onFile: async (info) => {
      if (info.viaSymlink) return;
      const candidateRelativePath = snapshotRelativePathFromRoot(rootPath, info.absolutePath);
      if (options.shouldIncludeRelativePath?.(candidateRelativePath) === false) return;

      let fileStat;
      try {
        fileStat = await fs.lstat(info.absolutePath);
      } catch {
        return;
      }
      if (!fileStat.isFile()) return;

      if (
        options.maxDirectoryBytes !== undefined &&
        totalBytes + fileStat.size > options.maxDirectoryBytes
      ) {
        capExceeded = true;
        capController.abort();
        return;
      }

      totalBytes += fileStat.size;
      files.push({
        sourcePath: info.absolutePath,
        relativePath: candidateRelativePath,
        sizeBytes: fileStat.size,
      });
    },
  });

  if (capExceeded) {
    return {
      files: [],
      failure: {
        relativePath: normalizedRelativePath,
        sizeBytes: totalBytes,
        error: 'directory_exceeds_snapshot_size_cap',
      },
    };
  }

  if (!isSafeWalkComplete(walkResult)) {
    return {
      files,
      failure: {
        relativePath: normalizedRelativePath,
        sizeBytes: null,
        error: `directory_walk_incomplete:${walkResult.truncatedReasons.join(',')}`,
      },
    };
  }

  return { files };
}

export async function writeSnapshotBuffer(
  destinationRoot: string,
  relativePath: string,
  data: Buffer | Uint8Array | string,
): Promise<SafeSnapshotEntry> {
  const normalizedRelativePath = normalizeSnapshotRelativePath(relativePath);
  const destinationPath = resolveSnapshotChildPath(destinationRoot, normalizedRelativePath);
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  await atomicCredentialWrite(destinationPath, bytes, { mode: SNAPSHOT_FILE_MODE });
  return {
    relPath: toPortablePath(normalizedRelativePath),
    sha256: sha256Buffer(bytes),
    bytes: bytes.byteLength,
  };
}

export async function copyStableSnapshotFile(
  candidate: SafeSnapshotFileCandidate,
  destinationRoot: string,
  destinationRelativePath = candidate.relativePath,
  options: CopyStableSnapshotFileOptions = {},
): Promise<SafeSnapshotEntry> {
  const before = await fs.lstat(candidate.sourcePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new SafeSnapshotCopyError(
      'unsupported_file_type',
      `Refusing to copy non-regular file: ${candidate.relativePath}`,
      candidate.relativePath,
    );
  }

  const firstRead = await fs.readFile(candidate.sourcePath);
  const firstSha = sha256Buffer(firstRead);
  await writeSnapshotBuffer(destinationRoot, destinationRelativePath, firstRead);
  await options.afterCopyBeforeVerify?.(candidate);

  const after = await fs.lstat(candidate.sourcePath);
  if (!after.isFile() || after.isSymbolicLink()) {
    throw new SafeSnapshotCopyError(
      'source_changed_during_copy',
      `Source file changed type while copying: ${candidate.relativePath}`,
      candidate.relativePath,
    );
  }

  const secondRead = await fs.readFile(candidate.sourcePath);
  const secondSha = sha256Buffer(secondRead);
  if (secondRead.byteLength !== firstRead.byteLength || secondSha !== firstSha) {
    throw new SafeSnapshotCopyError(
      'source_changed_during_copy',
      `Source file changed while copying: ${candidate.relativePath}`,
      candidate.relativePath,
    );
  }

  return {
    relPath: toPortablePath(normalizeSnapshotRelativePath(destinationRelativePath)),
    sha256: firstSha,
    bytes: firstRead.byteLength,
  };
}
