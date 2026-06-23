import fs from 'node:fs/promises';
import path from 'node:path';
import {
  WORKSPACE_NOT_CONFIGURED_MESSAGE,
  WORKSPACE_PATH_TRAVERSAL_MESSAGE,
  WorkspaceFileTooLargeError,
  type WorkspaceDirectoryEntry,
  type WorkspaceFileSystem,
  type WorkspacePathStat,
} from '@core/workspaceFileSystem';

export const MAX_READ_BYTES = 25 * 1024 * 1024;

function isPathInside(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function ensureWorkspaceRoot(workspaceRoot: string): string {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
    throw new Error(WORKSPACE_NOT_CONFIGURED_MESSAGE);
  }
  return path.resolve(workspaceRoot);
}

function normalizeTargetPath(targetPath: string): string {
  if (typeof targetPath !== 'string') {
    throw new Error(WORKSPACE_PATH_TRAVERSAL_MESSAGE);
  }
  const trimmed = targetPath.trim();
  return trimmed.length > 0 ? trimmed : '.';
}

async function findClosestExistingPath(candidatePath: string, workspaceRoot: string): Promise<string> {
  let current = candidatePath;
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'ENOENT') {
        throw error;
      }
    }

    if (current === workspaceRoot) {
      return workspaceRoot;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return workspaceRoot;
    }
    current = parent;
  }
}

async function resolveGuardedPath(
  workspaceRoot: string,
  targetPath: string,
  options: { allowMissingLeaf?: boolean } = {},
): Promise<string> {
  const resolvedRoot = ensureWorkspaceRoot(workspaceRoot);
  const normalizedTarget = normalizeTargetPath(targetPath);
  if (path.isAbsolute(normalizedTarget)) {
    throw new Error(WORKSPACE_PATH_TRAVERSAL_MESSAGE);
  }

  const candidatePath = path.resolve(resolvedRoot, normalizedTarget);
  if (!isPathInside(resolvedRoot, candidatePath)) {
    throw new Error(WORKSPACE_PATH_TRAVERSAL_MESSAGE);
  }

  const realRoot = await fs.realpath(resolvedRoot).catch(() => resolvedRoot);
  const pathToCheck = options.allowMissingLeaf
    ? await findClosestExistingPath(candidatePath, resolvedRoot)
    : candidatePath;
  const realPathToCheck = await fs.realpath(pathToCheck);
  if (!isPathInside(realRoot, realPathToCheck)) {
    throw new Error(WORKSPACE_PATH_TRAVERSAL_MESSAGE);
  }

  return candidatePath;
}

export class CloudWorkspaceFileSystem implements WorkspaceFileSystem {
  async listDirectory(workspaceRoot: string, targetPath: string): Promise<WorkspaceDirectoryEntry[]> {
    const resolvedPath = await resolveGuardedPath(workspaceRoot, targetPath);
    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  }

  async realPath(workspaceRoot: string, targetPath: string): Promise<string> {
    const resolvedPath = await resolveGuardedPath(workspaceRoot, targetPath);
    return fs.realpath(resolvedPath);
  }

  async stat(workspaceRoot: string, targetPath: string): Promise<WorkspacePathStat> {
    const resolvedPath = await resolveGuardedPath(workspaceRoot, targetPath);
    const stat = await fs.stat(resolvedPath);
    return { isDirectory: stat.isDirectory(), mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
  }

  async readFile(workspaceRoot: string, targetPath: string): Promise<string> {
    const resolvedPath = await resolveGuardedPath(workspaceRoot, targetPath);
    const stat = await fs.stat(resolvedPath);
    if (stat.size > MAX_READ_BYTES) {
      throw new WorkspaceFileTooLargeError(resolvedPath, stat.size, MAX_READ_BYTES);
    }
    return fs.readFile(resolvedPath, 'utf-8');
  }

  async writeFile(workspaceRoot: string, targetPath: string, content: string | Uint8Array): Promise<void> {
    const resolvedPath = await resolveGuardedPath(workspaceRoot, targetPath, { allowMissingLeaf: true });
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    const verifiedPath = await resolveGuardedPath(workspaceRoot, targetPath, { allowMissingLeaf: true });
    if (typeof content === 'string') {
      await fs.writeFile(verifiedPath, content, 'utf-8');
      return;
    }
    await fs.writeFile(verifiedPath, content);
  }

  async appendFile(workspaceRoot: string, targetPath: string, content: string | Uint8Array): Promise<void> {
    const resolvedPath = await resolveGuardedPath(workspaceRoot, targetPath, { allowMissingLeaf: true });
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    const verifiedPath = await resolveGuardedPath(workspaceRoot, targetPath, { allowMissingLeaf: true });
    if (typeof content === 'string') {
      await fs.appendFile(verifiedPath, content, 'utf-8');
      return;
    }
    await fs.appendFile(verifiedPath, content);
  }

  async renameFile(workspaceRoot: string, sourcePath: string, targetPath: string): Promise<void> {
    const resolvedSourcePath = await resolveGuardedPath(workspaceRoot, sourcePath);
    const resolvedTargetPath = await resolveGuardedPath(workspaceRoot, targetPath, { allowMissingLeaf: true });
    await fs.mkdir(path.dirname(resolvedTargetPath), { recursive: true });
    const verifiedTargetPath = await resolveGuardedPath(workspaceRoot, targetPath, { allowMissingLeaf: true });
    await fs.rename(resolvedSourcePath, verifiedTargetPath);
  }

  async deleteFile(workspaceRoot: string, targetPath: string): Promise<void> {
    const resolvedRoot = ensureWorkspaceRoot(workspaceRoot);
    // allowMissingLeaf: deleting an already-absent file must be idempotent.
    // Without it, resolveGuardedPath runs fs.realpath on the missing leaf and
    // throws `ENOENT … realpath` BEFORE the idempotent fs.rm({ force: true })
    // below — the ~420-failures/cycle loop in REBEL-62A. The in-root candidate
    // check (resolveGuardedPath) still runs on the full path and the closest
    // existing ancestor is realpath-checked, so traversal/symlink-escape
    // protection is fully preserved; only a genuinely-missing target is
    // tolerated (and resolves to a no-op fs.rm).
    const resolvedPath = await resolveGuardedPath(workspaceRoot, targetPath, { allowMissingLeaf: true });
    if (resolvedPath === resolvedRoot) {
      throw new Error(WORKSPACE_PATH_TRAVERSAL_MESSAGE);
    }
    await fs.rm(resolvedPath, { force: true });
  }

  async exists(workspaceRoot: string, targetPath: string): Promise<boolean> {
    try {
      const resolvedPath = await resolveGuardedPath(workspaceRoot, targetPath);
      await fs.access(resolvedPath);
      return true;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }
}
