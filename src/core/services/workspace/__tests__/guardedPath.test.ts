import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createScopedLogger } from '@core/logger';
import {
  setWorkspaceFileSystemFactory,
  type WorkspaceDirectoryEntry,
  type WorkspaceFileSystem,
  type WorkspacePathStat,
} from '@core/workspaceFileSystem';
import {
  getRealPathStrict,
  resetWorkspaceGuardLogDedupForTesting,
  resolveGuardedPath,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemConfig,
} from '../guardedPath';
import { buildFileTree } from '../fileTreeService';

class RealFsWorkspaceFileSystem implements WorkspaceFileSystem {
  async listDirectory(workspaceRoot: string, targetPath: string): Promise<WorkspaceDirectoryEntry[]> {
    const resolvedPath = await resolveGuardedPath(targetPath, {
      workspaceRoot,
      allowOutOfRootSymlinks: false,
      surface: 'core',
    });
    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  }

  async realPath(workspaceRoot: string, targetPath: string): Promise<string> {
    const resolvedPath = await resolveGuardedPath(targetPath, {
      workspaceRoot,
      allowOutOfRootSymlinks: false,
      surface: 'core',
    });
    return fs.realpath(resolvedPath);
  }

  async stat(workspaceRoot: string, targetPath: string): Promise<WorkspacePathStat> {
    const resolvedPath = await resolveGuardedPath(targetPath, {
      workspaceRoot,
      allowOutOfRootSymlinks: false,
      surface: 'core',
    });
    const stat = await fs.stat(resolvedPath);
    return { isDirectory: stat.isDirectory(), mtimeMs: stat.mtimeMs };
  }

  async readFile(): Promise<string> {
    throw new Error('readFile is not used in guardedPath tests');
  }

  async writeFile(): Promise<void> {
    throw new Error('writeFile is not used in guardedPath tests');
  }

  async deleteFile(): Promise<void> {
    throw new Error('deleteFile is not used in guardedPath tests');
  }

  async exists(): Promise<boolean> {
    throw new Error('exists is not used in guardedPath tests');
  }
}

const symlinkIt = process.platform === 'win32' ? it.skip : it;
const permissionIt =
  process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)
    ? it.skip
    : it;

function getWorkspaceGuardDebugMock(): ReturnType<typeof vi.fn> {
  const mockedCreateScopedLogger = vi.mocked(createScopedLogger);
  const loggerIndex = mockedCreateScopedLogger.mock.calls.findIndex(
    ([context]) => (context as { service?: string } | undefined)?.service === 'workspace-guard',
  );
  if (loggerIndex < 0) {
    throw new Error('workspace-guard logger was not created');
  }
  const logger = mockedCreateScopedLogger.mock.results[loggerIndex]?.value as {
    debug: ReturnType<typeof vi.fn>;
  };
  return logger.debug;
}

describe('guardedPath', () => {
  let tempRoot: string;
  let workspaceRoot: string;
  let outsideRoot: string;
  let restrictedDirectory: string | undefined;

  const config = (allowOutOfRootSymlinks: boolean): WorkspaceFileSystemConfig => ({
    workspaceRoot,
    allowOutOfRootSymlinks,
  });

  beforeEach(async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'rebel-guarded-path-'));
    workspaceRoot = path.join(tempRoot, 'workspace');
    outsideRoot = path.join(tempRoot, 'outside');
    restrictedDirectory = undefined;

    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'inside.txt'), 'inside');
    await fs.writeFile(path.join(outsideRoot, 'secret.txt'), 'secret');
    resetWorkspaceGuardLogDedupForTesting();
    getWorkspaceGuardDebugMock().mockClear();
  });

  afterEach(async () => {
    if (restrictedDirectory) {
      await fs.chmod(restrictedDirectory, 0o700).catch(() => {});
    }
    vi.restoreAllMocks();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  symlinkIt('T3a.1 rejects an out-of-root symlink when out-of-root symlinks are disallowed', async () => {
    const linkPath = path.join(workspaceRoot, 'outside-link.txt');
    await fs.symlink(path.join(outsideRoot, 'secret.txt'), linkPath);

    await expect(getRealPathStrict(linkPath, config(false))).rejects.toMatchObject({
      code: 'OutOfRoot',
    });
  });

  symlinkIt('T3a.2 returns realpath for an out-of-root symlink when explicitly allowed', async () => {
    const outsideFile = path.join(outsideRoot, 'secret.txt');
    const linkPath = path.join(workspaceRoot, 'outside-link.txt');
    await fs.symlink(outsideFile, linkPath);

    await expect(getRealPathStrict(linkPath, config(true))).resolves.toBe(await fs.realpath(outsideFile));
  });

  symlinkIt('T3b.R1 logs only redacted metadata when allowing an out-of-root symlink', async () => {
    const outsideFile = path.join(outsideRoot, 'secret.txt');
    const linkPath = path.join(workspaceRoot, 'outside-link.txt');
    const realOutsideFile = await fs.realpath(outsideFile);
    await fs.symlink(outsideFile, linkPath);

    await expect(
      getRealPathStrict(linkPath, {
        ...config(true),
        surface: 'electron',
      }),
    ).resolves.toBe(realOutsideFile);

    const debugMock = getWorkspaceGuardDebugMock();
    expect(debugMock).toHaveBeenCalledWith(
      {
        surface: 'electron',
        wasOutOfRoot: true,
        candidateRelative: 'outside-link.txt',
        realPathFingerprint: createHash('sha256').update(realOutsideFile).digest('hex').slice(0, 8),
      },
      'workspace-guard: allowing in-root symlink with realpath outside workspace root',
    );

    const [metadata] = debugMock.mock.calls[debugMock.mock.calls.length - 1] as [
      Record<string, unknown>,
      string,
    ];
    const serializedMetadata = JSON.stringify(metadata);

    expect(metadata).not.toHaveProperty('candidatePath');
    expect(metadata).not.toHaveProperty('realPath');
    expect(metadata).not.toHaveProperty('workspaceRoot');
    expect(serializedMetadata).not.toContain(linkPath);
    expect(serializedMetadata).not.toContain(realOutsideFile);
    expect(serializedMetadata).not.toContain(workspaceRoot);
  });

  symlinkIt('T3b.R2 emits the out-of-root guard log once across repeated calls for the same symlink', async () => {
    const outsideFile = path.join(outsideRoot, 'secret.txt');
    const linkPath = path.join(workspaceRoot, 'outside-link.txt');
    await fs.symlink(outsideFile, linkPath);
    const realOutsideFile = await fs.realpath(outsideFile);

    const debugMock = getWorkspaceGuardDebugMock();
    for (let i = 0; i < 5; i += 1) {
      await expect(
        getRealPathStrict(linkPath, { ...config(true), surface: 'electron' }),
      ).resolves.toBe(realOutsideFile);
    }

    expect(debugMock).toHaveBeenCalledTimes(1);
  });

  symlinkIt('T3a.3 returns realpath for an in-root symlink with either policy flag', async () => {
    const targetPath = path.join(workspaceRoot, 'inside.txt');
    const linkPath = path.join(workspaceRoot, 'inside-link.txt');
    await fs.symlink(targetPath, linkPath);

    await expect(getRealPathStrict(linkPath, config(false))).resolves.toBe(await fs.realpath(targetPath));
    await expect(getRealPathStrict(linkPath, config(true))).resolves.toBe(await fs.realpath(targetPath));
  });

  symlinkIt('T3a.4 reports broken symlinks as BrokenSymlink, not OutOfRoot', async () => {
    const linkPath = path.join(workspaceRoot, 'broken-link.txt');
    await fs.symlink(path.join(outsideRoot, 'missing.txt'), linkPath);

    await expect(getRealPathStrict(linkPath, config(false))).rejects.toMatchObject({
      code: 'BrokenSymlink',
    });
  });

  symlinkIt('T3a.4b rejects allowMissingLeaf writes through an in-root broken symlink', async () => {
    const linkPath = path.join(workspaceRoot, 'broken-write-link.txt');
    await fs.symlink(path.join(outsideRoot, 'missing-write-target.txt'), linkPath);

    await expect(
      resolveGuardedPath('broken-write-link.txt', {
        workspaceRoot,
        allowMissingLeaf: true,
        allowOutOfRootSymlinks: false,
        surface: 'core',
      }),
    ).rejects.toMatchObject({
      code: 'BrokenSymlink',
    });
  });

  it('T3a.5 rejects regular non-symlink out-of-root paths independent of symlink policy', async () => {
    const outsideFile = path.join(outsideRoot, 'secret.txt');

    await expect(getRealPathStrict(outsideFile, config(false))).rejects.toMatchObject({
      code: 'OutOfRoot',
    });
    await expect(getRealPathStrict(outsideFile, config(true))).rejects.toMatchObject({
      code: 'OutOfRoot',
    });
  });

  it('T3a.6 resolves a relative path that stays in the workspace root', async () => {
    const insideFile = path.join(workspaceRoot, 'inside.txt');

    await expect(getRealPathStrict('inside.txt', config(false))).resolves.toBe(await fs.realpath(insideFile));
  });

  it('T3a.7 rejects a path containing traversal that escapes the workspace root', async () => {
    await expect(getRealPathStrict('../outside/secret.txt', config(true))).rejects.toMatchObject({
      code: 'OutOfRoot',
    });
  });

  symlinkIt('T3a.8 applies policy to a symlink chain whose final target is out of root', async () => {
    const outsideFile = path.join(outsideRoot, 'secret.txt');
    const linkB = path.join(workspaceRoot, 'link-b.txt');
    const linkA = path.join(workspaceRoot, 'link-a.txt');
    await fs.symlink(outsideFile, linkB);
    await fs.symlink(linkB, linkA);

    await expect(getRealPathStrict(linkA, config(false))).rejects.toMatchObject({
      code: 'OutOfRoot',
    });
    await expect(getRealPathStrict(linkA, config(true))).resolves.toBe(await fs.realpath(outsideFile));
  });

  permissionIt('T3a.U1 marks a directory unavailable when listDirectory fails after stat succeeds', async () => {
    const restrictedName = 'restricted';
    restrictedDirectory = path.join(workspaceRoot, restrictedName);
    await fs.mkdir(restrictedDirectory);
    await fs.writeFile(path.join(restrictedDirectory, 'hidden.txt'), 'hidden');
    await fs.chmod(restrictedDirectory, 0);

    setWorkspaceFileSystemFactory(() => new RealFsWorkspaceFileSystem());

    const { nodes: tree } = await buildFileTree(workspaceRoot, workspaceRoot, 0, true);
    const restrictedNode = tree.find((node) => node.name === restrictedName);

    expect(restrictedNode).toMatchObject({
      kind: 'directory',
      children: [],
      unavailable: 'listdir-failed',
    });
  });

  symlinkIt('T3a.U2 marks a symlink as a file when realpath fails after stat succeeds', async () => {
    const targetDirectory = path.join(workspaceRoot, 'target-dir');
    const linkPath = path.join(workspaceRoot, 'linked-dir');
    await fs.mkdir(targetDirectory);
    await fs.symlink(targetDirectory, linkPath, 'dir');

    const workspaceFileSystem = new RealFsWorkspaceFileSystem();
    vi.spyOn(workspaceFileSystem, 'realPath').mockImplementation(async (root, target) => {
      if (target === 'linked-dir') {
        throw new WorkspaceFileSystemError('RealpathFailed', 'forced realpath failure');
      }
      return RealFsWorkspaceFileSystem.prototype.realPath.call(workspaceFileSystem, root, target);
    });
    setWorkspaceFileSystemFactory(() => workspaceFileSystem);

    const { nodes: tree } = await buildFileTree(workspaceRoot, workspaceRoot, 0, true);
    const linkedNode = tree.find((node) => node.name === 'linked-dir');

    expect(linkedNode).toMatchObject({
      kind: 'file',
      unavailable: 'realpath-failed',
    });
  });
});
