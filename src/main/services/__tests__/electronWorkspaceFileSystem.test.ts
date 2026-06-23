import { mkdtempSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceFileTooLargeError } from '@core/workspaceFileSystem';
import { WorkspaceFileSystemError } from '@core/services/workspace/guardedPath';
import {
  ElectronWorkspaceFileSystem,
  MAX_READ_BYTES,
} from '../workspaceFileSystem/electronWorkspaceFileSystem';

const symlinkIt = process.platform === 'win32' ? it.skip : it;

describe('ElectronWorkspaceFileSystem', () => {
  let tempRoot: string;
  let workspacePath: string;
  let workspaceFileSystem: ElectronWorkspaceFileSystem;

  beforeEach(async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'rebel-electron-wfs-'));
    workspacePath = path.join(tempRoot, 'workspace');
    workspaceFileSystem = new ElectronWorkspaceFileSystem();

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, 'inside.txt'), 'inside');
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('rejects reads that are just over the max read cap', async () => {
    const targetFile = path.resolve(workspacePath, 'inside.txt');
    const realStat = fs.stat.bind(fs);
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      const [filePath] = args;
      if (path.resolve(String(filePath)) === targetFile) {
        // S4.1b: readFile now stats via the boundary, which maps a full `Stats` —
        // include the type predicates so `toWorkspaceStat` doesn't choke.
        return {
          size: MAX_READ_BYTES + 1,
          mtimeMs: 0,
          ctimeMs: 0,
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        } as unknown as Awaited<ReturnType<typeof fs.stat>>;
      }
      return realStat(...args);
    });

    await expect(workspaceFileSystem.readFile(workspacePath, 'inside.txt')).rejects.toBeInstanceOf(
      WorkspaceFileTooLargeError,
    );

    statSpy.mockRestore();
  });

  it('allows reads that are just under the max read cap', async () => {
    const targetFile = path.resolve(workspacePath, 'inside.txt');
    const realStat = fs.stat.bind(fs);
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      const [filePath] = args;
      if (path.resolve(String(filePath)) === targetFile) {
        return {
          size: MAX_READ_BYTES - 1,
          mtimeMs: 0,
          ctimeMs: 0,
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        } as unknown as Awaited<ReturnType<typeof fs.stat>>;
      }
      return realStat(...args);
    });

    await expect(workspaceFileSystem.readFile(workspacePath, 'inside.txt')).resolves.toBe('inside');

    statSpy.mockRestore();
  });

  symlinkIt('rejects writeFile through an in-root broken symlink without creating the outside target', async () => {
    const outsideTarget = path.join(tempRoot, 'outside-target.txt');
    const linkPath = path.join(workspacePath, 'link');
    await fs.symlink(outsideTarget, linkPath);

    await expect(workspaceFileSystem.writeFile(workspacePath, 'link', 'evil')).rejects.toMatchObject({
      code: 'BrokenSymlink',
    });
    await expect(fs.access(outsideTarget)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns false from exists for a missing in-workspace path', async () => {
    await expect(workspaceFileSystem.exists(workspacePath, 'does-not-exist.md')).resolves.toBe(false);
  });

  symlinkIt('returns false from exists for an in-root broken symlink', async () => {
    const linkPath = path.join(workspacePath, 'broken-link');
    await fs.symlink(path.join(tempRoot, 'missing-target.txt'), linkPath);

    await expect(workspaceFileSystem.exists(workspacePath, 'broken-link')).resolves.toBe(false);
  });

  it('throws OutOfRoot from exists for paths outside the workspace', async () => {
    const outsideFile = path.join(tempRoot, 'outside.md');
    await fs.writeFile(outsideFile, 'outside');

    await expect(workspaceFileSystem.exists(workspacePath, outsideFile)).rejects.toMatchObject({
      code: 'OutOfRoot',
    });
    await expect(workspaceFileSystem.exists(workspacePath, outsideFile)).rejects.toBeInstanceOf(
      WorkspaceFileSystemError,
    );
  });
});
