// CORE-MOVE-EXEMPT: Node filesystem adapter for WorkspaceFileSystem; used by Electron runtime wiring.
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  WORKSPACE_PATH_TRAVERSAL_MESSAGE,
  WorkspaceFileTooLargeError,
  type WorkspaceDirectoryEntry,
  type WorkspaceFileSystem,
  type WorkspacePathStat,
} from '@core/workspaceFileSystem';
import {
  ensureWorkspaceRoot,
  resolveGuardedPath,
  WorkspaceFileSystemError,
} from '@core/services/workspace/guardedPath';
import {
  workspaceFs,
  cloudLaneOptionForPath,
  type WorkspaceFsOutcome,
} from '@core/services/boundedWorkspaceFs';

export const MAX_READ_BYTES = 25 * 1024 * 1024;

/**
 * S4.1b — unwrap a bounded-boundary read outcome back to the throw-based contract the
 * read methods (and their callers) expect. `ok` → value; a real fs error → rethrow it
 * RAW (byte-identical to the prior bare-fs throw, so caller `error.code` handling is
 * unchanged); `reconnecting` (dead cloud mount, reclaimed) → a typed CloudReconnecting
 * so a degraded cloud read can never masquerade as absence.
 */
function unwrapRead<T>(outcome: WorkspaceFsOutcome<T>): T {
  if (outcome.status === 'ok') return outcome.value;
  if (outcome.status === 'reconnecting') {
    throw new WorkspaceFileSystemError('CloudReconnecting', `cloud mount unavailable: ${outcome.path}`);
  }
  throw outcome.error;
}

const getGuardedPath = (
  workspaceRoot: string,
  targetPath: string,
  options: { allowMissingLeaf?: boolean } = {},
): Promise<string> =>
  resolveGuardedPath(targetPath, {
    workspaceRoot,
    // Desktop trusts symlinks the user placed inside their workspace; cloud keeps this false.
    allowOutOfRootSymlinks: true,
    allowMissingLeaf: options.allowMissingLeaf,
    surface: 'electron',
  });

export class ElectronWorkspaceFileSystem implements WorkspaceFileSystem {
  async listDirectory(workspaceRoot: string, targetPath: string): Promise<WorkspaceDirectoryEntry[]> {
    const resolvedPath = await getGuardedPath(workspaceRoot, targetPath);
    // S4.1b: read via the bounded boundary (local lane = bare fs; cloud lane = killable
    // pool). `WorkspaceDirent` already exposes the type predicates as booleans.
    const entries = unwrapRead(
      await workspaceFs.readdirWithFileTypes(resolvedPath, cloudLaneOptionForPath(resolvedPath)),
    );
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory,
      isSymbolicLink: entry.isSymbolicLink,
    }));
  }

  async realPath(workspaceRoot: string, targetPath: string): Promise<string> {
    const resolvedPath = await getGuardedPath(workspaceRoot, targetPath);
    return unwrapRead(await workspaceFs.realpath(resolvedPath, cloudLaneOptionForPath(resolvedPath)));
  }

  async stat(workspaceRoot: string, targetPath: string): Promise<WorkspacePathStat> {
    const resolvedPath = await getGuardedPath(workspaceRoot, targetPath);
    const stat = unwrapRead(await workspaceFs.stat(resolvedPath, cloudLaneOptionForPath(resolvedPath)));
    return { isDirectory: stat.isDirectory, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
  }

  async readFile(workspaceRoot: string, targetPath: string): Promise<string> {
    const resolvedPath = await getGuardedPath(workspaceRoot, targetPath);
    const opt = cloudLaneOptionForPath(resolvedPath);
    const stat = unwrapRead(await workspaceFs.stat(resolvedPath, opt));
    if (stat.size > MAX_READ_BYTES) {
      throw new WorkspaceFileTooLargeError(resolvedPath, stat.size, MAX_READ_BYTES);
    }
    return unwrapRead(await workspaceFs.readFile(resolvedPath, 'utf-8', opt));
  }

  async writeFile(workspaceRoot: string, targetPath: string, content: string | Uint8Array): Promise<void> {
    const resolvedPath = await getGuardedPath(workspaceRoot, targetPath, { allowMissingLeaf: true });
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    const verifiedPath = await getGuardedPath(workspaceRoot, targetPath, { allowMissingLeaf: true });
    if (typeof content === 'string') {
      await fs.writeFile(verifiedPath, content, 'utf-8');
      return;
    }
    await fs.writeFile(verifiedPath, content);
  }

  async appendFile(workspaceRoot: string, targetPath: string, content: string | Uint8Array): Promise<void> {
    const resolvedPath = await getGuardedPath(workspaceRoot, targetPath, { allowMissingLeaf: true });
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    const verifiedPath = await getGuardedPath(workspaceRoot, targetPath, { allowMissingLeaf: true });
    if (typeof content === 'string') {
      await fs.appendFile(verifiedPath, content, 'utf-8');
      return;
    }
    await fs.appendFile(verifiedPath, content);
  }

  async renameFile(workspaceRoot: string, sourcePath: string, targetPath: string): Promise<void> {
    const resolvedSourcePath = await getGuardedPath(workspaceRoot, sourcePath);
    const resolvedTargetPath = await getGuardedPath(workspaceRoot, targetPath, { allowMissingLeaf: true });
    await fs.mkdir(path.dirname(resolvedTargetPath), { recursive: true });
    const verifiedTargetPath = await getGuardedPath(workspaceRoot, targetPath, { allowMissingLeaf: true });
    await fs.rename(resolvedSourcePath, verifiedTargetPath);
  }

  async deleteFile(workspaceRoot: string, targetPath: string): Promise<void> {
    const resolvedRoot = ensureWorkspaceRoot(workspaceRoot);
    const resolvedPath = await getGuardedPath(workspaceRoot, targetPath);
    if (resolvedPath === resolvedRoot) {
      throw new Error(WORKSPACE_PATH_TRAVERSAL_MESSAGE);
    }
    await fs.rm(resolvedPath, { force: true });
  }

  async exists(workspaceRoot: string, targetPath: string): Promise<boolean> {
    try {
      const resolvedPath = await getGuardedPath(workspaceRoot, targetPath);
      // S4.1b: probe via the bounded boundary. `unwrapRead` turns a dead-mount
      // `reconnecting` into a thrown CloudReconnecting (handled below), so it can never
      // be silently swallowed into `false`.
      unwrapRead(await workspaceFs.access(resolvedPath, undefined, cloudLaneOptionForPath(resolvedPath)));
      return true;
    } catch (error) {
      // S4.1b (F2): a dead/unreachable cloud mount is NOT absence — rethrow so callers
      // retain / surface "reconnecting" rather than treating the path as missing.
      if (error instanceof WorkspaceFileSystemError && error.code === 'CloudReconnecting') {
        throw error;
      }
      if (
        error instanceof WorkspaceFileSystemError &&
        (error.code === 'BrokenSymlink' || error.code === 'StatFailed')
      ) {
        return false;
      }
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }
}
