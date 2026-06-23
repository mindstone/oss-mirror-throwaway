import { mkdtempSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildFileTree } from '@core/services/workspace/fileTreeService';
import { resolveGuardedPath } from '@core/services/workspace/guardedPath';
import { setWorkspaceFileSystemFactory } from '@core/workspaceFileSystem';
import { ElectronWorkspaceFileSystem } from '../workspaceFileSystem/electronWorkspaceFileSystem';

type SymlinkKind = 'file' | 'dir';

type FileNodeWithUnavailable = Awaited<ReturnType<typeof buildFileTree>>['nodes'][number] & {
  unavailable?: string;
};

async function createSymlinkOrSkip(
  targetPath: string,
  linkPath: string,
  kind: SymlinkKind,
): Promise<boolean> {
  try {
    await fs.symlink(
      targetPath,
      linkPath,
      process.platform === 'win32' && kind === 'dir' ? 'junction' : kind,
    );
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'EPERM' || nodeError.code === 'EACCES' || nodeError.code === 'ENOTSUP') {
      return false;
    }
    throw error;
  }
}

describe('ElectronWorkspaceFileSystem symlink policy', () => {
  let tempRoot: string;
  let workspacePath: string;
  let outsidePath: string;
  let workspaceFileSystem: ElectronWorkspaceFileSystem;

  beforeEach(async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'rebel-electron-wfs-symlinks-'));
    workspacePath = path.join(tempRoot, 'workspace');
    outsidePath = path.join(tempRoot, 'outside');
    workspaceFileSystem = new ElectronWorkspaceFileSystem();
    setWorkspaceFileSystemFactory(() => workspaceFileSystem);

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(outsidePath, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('T3b.1 allows an in-root symlink to an external directory for reads, listing, and FileTree', async () => {
    const externalDirectory = path.join(outsidePath, 'space-target');
    const externalFile = path.join(externalDirectory, 'note.md');
    const linkPath = path.join(workspacePath, 'space-link');
    await fs.mkdir(externalDirectory, { recursive: true });
    await fs.writeFile(externalFile, '# linked space');
    if (!(await createSymlinkOrSkip(externalDirectory, linkPath, 'dir'))) return;

    await expect(workspaceFileSystem.readFile(workspacePath, 'space-link/note.md')).resolves.toBe(
      '# linked space',
    );
    await expect(workspaceFileSystem.listDirectory(workspacePath, 'space-link')).resolves.toEqual([
      expect.objectContaining({ name: 'note.md', isDirectory: false }),
    ]);

    const { nodes: tree } = await buildFileTree(workspacePath, workspacePath, 0, true);
    const linkedNode = tree.find((node) => node.name === 'space-link') as
      | FileNodeWithUnavailable
      | undefined;

    expect(linkedNode).toMatchObject({
      name: 'space-link',
      kind: 'directory',
      children: [expect.objectContaining({ name: 'note.md', kind: 'file' })],
    });
    expect(linkedNode?.unavailable).toBeUndefined();
  });

  it('T3b.2 allows an in-root symlink to an external file for readFile and stat', async () => {
    const externalFile = path.join(outsidePath, 'external.txt');
    const linkPath = path.join(workspacePath, 'external-link.txt');
    await fs.writeFile(externalFile, 'external content');
    if (!(await createSymlinkOrSkip(externalFile, linkPath, 'file'))) return;

    await expect(workspaceFileSystem.readFile(workspacePath, 'external-link.txt')).resolves.toBe(
      'external content',
    );
    await expect(workspaceFileSystem.stat(workspacePath, 'external-link.txt')).resolves.toEqual({
      isDirectory: false,
      mtimeMs: expect.any(Number),
      sizeBytes: expect.any(Number),
    });
  });

  it('T3b.3 reports a broken in-root symlink as BrokenSymlink and drops it from FileTree', async () => {
    const linkPath = path.join(workspacePath, 'broken-link');
    if (!(await createSymlinkOrSkip(path.join(outsidePath, 'missing-target.txt'), linkPath, 'file'))) {
      return;
    }

    await expect(workspaceFileSystem.readFile(workspacePath, 'broken-link')).rejects.toMatchObject({
      code: 'BrokenSymlink',
    });

    const { nodes: tree } = await buildFileTree(workspacePath, workspacePath, 0, true);
    expect(tree.find((node) => node.name === 'broken-link')).toBeUndefined();
  });

  it('T3b.4 still rejects a direct absolute out-of-root path', async () => {
    const outsideFile = path.join(outsidePath, 'absolute-secret.txt');
    await fs.writeFile(outsideFile, 'secret');

    await expect(workspaceFileSystem.readFile(workspacePath, outsideFile)).rejects.toMatchObject({
      code: 'OutOfRoot',
    });
  });

  it('T3b.5 allows an in-root symlink chain whose final realpath is out of root', async () => {
    const outsideFile = path.join(outsidePath, 'chain-target.txt');
    const linkB = path.join(workspacePath, 'link-b.txt');
    const linkA = path.join(workspacePath, 'link-a.txt');
    await fs.writeFile(outsideFile, 'chain content');
    if (!(await createSymlinkOrSkip(outsideFile, linkB, 'file'))) return;
    if (!(await createSymlinkOrSkip(linkB, linkA, 'file'))) return;

    await expect(workspaceFileSystem.readFile(workspacePath, 'link-a.txt')).resolves.toBe(
      'chain content',
    );
  });

  it('T3b.6 writes through an in-root symlink to an existing external file', async () => {
    const externalFile = path.join(outsidePath, 'write-target.txt');
    const linkPath = path.join(workspacePath, 'write-link.txt');
    await fs.writeFile(externalFile, 'before');
    if (!(await createSymlinkOrSkip(externalFile, linkPath, 'file'))) return;

    await workspaceFileSystem.writeFile(workspacePath, 'write-link.txt', 'after');

    await expect(fs.readFile(externalFile, 'utf-8')).resolves.toBe('after');
  });

  it('T3b.7 refuses to write through a broken in-root symlink to a missing out-of-root target', async () => {
    const missingExternalFile = path.join(outsidePath, 'missing-write-target.txt');
    const linkPath = path.join(workspacePath, 'broken-write-link.txt');
    if (!(await createSymlinkOrSkip(missingExternalFile, linkPath, 'file'))) return;

    await expect(
      workspaceFileSystem.writeFile(workspacePath, 'broken-write-link.txt', 'must not escape'),
    ).rejects.toMatchObject({
      code: 'BrokenSymlink',
    });
    await expect(fs.access(missingExternalFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('T3b.8 keeps cloud-style strict config rejecting out-of-root symlinks', async () => {
    const outsideFile = path.join(outsidePath, 'cloud-secret.txt');
    const linkPath = path.join(workspacePath, 'cloud-link.txt');
    await fs.writeFile(outsideFile, 'cloud secret');
    if (!(await createSymlinkOrSkip(outsideFile, linkPath, 'file'))) return;

    await expect(
      resolveGuardedPath('cloud-link.txt', {
        workspaceRoot: workspacePath,
        allowOutOfRootSymlinks: false,
        surface: 'cloud',
      }),
    ).rejects.toMatchObject({
      code: 'OutOfRoot',
    });
  });
});
