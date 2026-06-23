import { mkdtempSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WORKSPACE_PATH_TRAVERSAL_MESSAGE,
  WorkspaceFileTooLargeError,
} from '@core/workspaceFileSystem';
import { CloudWorkspaceFileSystem, MAX_READ_BYTES } from '../cloudWorkspaceFileSystem';

describe('CloudWorkspaceFileSystem', () => {
  let tempRoot: string;
  let workspacePath: string;
  let outsidePath: string;
  let workspaceFileSystem: CloudWorkspaceFileSystem;

  beforeEach(async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'rebel-cloud-wfs-'));
    workspacePath = path.join(tempRoot, 'workspace');
    outsidePath = path.join(tempRoot, 'outside');
    workspaceFileSystem = new CloudWorkspaceFileSystem();

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(outsidePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, 'inside.txt'), 'inside');
    await fs.writeFile(path.join(outsidePath, 'secret.txt'), 'secret');
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('reads and writes files inside the workspace', async () => {
    await workspaceFileSystem.writeFile(workspacePath, 'notes/today.md', '# hello');
    await expect(workspaceFileSystem.readFile(workspacePath, 'notes/today.md')).resolves.toBe('# hello');
  });

  it('rejects ../etc/passwd traversal', async () => {
    await expect(workspaceFileSystem.readFile(workspacePath, '../etc/passwd')).rejects.toThrow(
      WORKSPACE_PATH_TRAVERSAL_MESSAGE,
    );
  });

  it('rejects nested traversal escapes', async () => {
    await expect(workspaceFileSystem.readFile(workspacePath, 'workspace/../../../etc/passwd')).rejects.toThrow(
      WORKSPACE_PATH_TRAVERSAL_MESSAGE,
    );
  });

  it('rejects absolute path injection', async () => {
    const absoluteOutsidePath = path.join(outsidePath, 'secret.txt');
    await expect(workspaceFileSystem.readFile(workspacePath, absoluteOutsidePath)).rejects.toThrow(
      WORKSPACE_PATH_TRAVERSAL_MESSAGE,
    );
  });

  it('rejects symlinks that point outside the workspace', async () => {
    const outsideFile = path.join(outsidePath, 'secret.txt');
    const linkPath = path.join(workspacePath, 'outside-link.txt');

    try {
      await fs.symlink(outsideFile, linkPath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'EPERM' || nodeError.code === 'EACCES' || nodeError.code === 'ENOTSUP') {
        return;
      }
      throw error;
    }

    await expect(workspaceFileSystem.readFile(workspacePath, 'outside-link.txt')).rejects.toThrow(
      WORKSPACE_PATH_TRAVERSAL_MESSAGE,
    );
    await expect(workspaceFileSystem.writeFile(workspacePath, 'outside-link.txt', 'changed')).rejects.toThrow(
      WORKSPACE_PATH_TRAVERSAL_MESSAGE,
    );
    await expect(fs.readFile(outsideFile, 'utf-8')).resolves.toBe('secret');
  });

  it('deletes files inside the workspace', async () => {
    const targetFile = path.join(workspacePath, 'delete-me.txt');
    await fs.writeFile(targetFile, 'bye');

    await workspaceFileSystem.deleteFile(workspacePath, 'delete-me.txt');

    await expect(fs.access(targetFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // REBEL-62A Stage B: deleteFile must be idempotent. Previously it called
  // resolveGuardedPath without allowMissingLeaf, so fs.realpath threw
  // `ENOENT … realpath` on a missing target before the idempotent fs.rm —
  // the ~420-failed-deletes/cycle loop. A missing-but-in-workspace path now
  // resolves to a no-op success.
  it('is idempotent: deleting an absent-but-in-workspace path does not throw', async () => {
    await expect(
      workspaceFileSystem.deleteFile(workspacePath, 'never/existed/here.md'),
    ).resolves.toBeUndefined();
  });

  it('is idempotent: deleting the same file twice does not throw on the second call', async () => {
    const targetFile = path.join(workspacePath, 'twice.txt');
    await fs.writeFile(targetFile, 'bye');

    await workspaceFileSystem.deleteFile(workspacePath, 'twice.txt');
    await expect(workspaceFileSystem.deleteFile(workspacePath, 'twice.txt')).resolves.toBeUndefined();
  });

  it('still rejects a delete that escapes the workspace, even when the leaf is missing (safety preserved)', async () => {
    await expect(
      workspaceFileSystem.deleteFile(workspacePath, '../outside/does-not-exist.txt'),
    ).rejects.toThrow(WORKSPACE_PATH_TRAVERSAL_MESSAGE);
  });

  it('still rejects an absolute-path delete escape (safety preserved)', async () => {
    const absoluteOutsidePath = path.join(outsidePath, 'does-not-exist.txt');
    await expect(
      workspaceFileSystem.deleteFile(workspacePath, absoluteOutsidePath),
    ).rejects.toThrow(WORKSPACE_PATH_TRAVERSAL_MESSAGE);
  });

  it('still rejects a delete via a symlink escaping the workspace, even for a missing leaf', async () => {
    const linkDir = path.join(workspacePath, 'escape-link');
    try {
      await fs.symlink(outsidePath, linkDir);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'EPERM' || nodeError.code === 'EACCES' || nodeError.code === 'ENOTSUP') {
        return;
      }
      throw error;
    }

    // The leaf `missing.txt` does not exist, but the closest existing ancestor
    // (escape-link -> outsidePath) realpaths outside the workspace → rejected.
    await expect(
      workspaceFileSystem.deleteFile(workspacePath, 'escape-link/missing.txt'),
    ).rejects.toThrow(WORKSPACE_PATH_TRAVERSAL_MESSAGE);
  });

  it('rejects reads that are just over the max read cap', async () => {
    const targetFile = path.resolve(workspacePath, 'inside.txt');
    const realStat = fs.stat.bind(fs);
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      const [filePath] = args;
      if (path.resolve(String(filePath)) === targetFile) {
        return { size: MAX_READ_BYTES + 1 } as Awaited<ReturnType<typeof fs.stat>>;
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
        return { size: MAX_READ_BYTES - 1 } as Awaited<ReturnType<typeof fs.stat>>;
      }
      return realStat(...args);
    });

    await expect(workspaceFileSystem.readFile(workspacePath, 'inside.txt')).resolves.toBe('inside');

    statSpy.mockRestore();
  });
});
