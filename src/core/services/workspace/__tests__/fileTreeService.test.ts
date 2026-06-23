import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  setWorkspaceFileSystemFactory,
  type WorkspaceDirectoryEntry,
  type WorkspaceFileSystem,
  type WorkspacePathStat,
} from '@core/workspaceFileSystem';
import { buildFileTree } from '../fileTreeService';
import { WorkspaceFileSystemError } from '../guardedPath';

class MockWorkspaceFileSystem implements WorkspaceFileSystem {
  public listDirectoryMock = vi.fn<
    (workspaceRoot: string, targetPath: string) => Promise<WorkspaceDirectoryEntry[]>
  >();

  public realPathMock = vi.fn<(workspaceRoot: string, targetPath: string) => Promise<string>>();

  public statMock = vi.fn<(workspaceRoot: string, targetPath: string) => Promise<WorkspacePathStat>>();

  listDirectory(workspaceRoot: string, targetPath: string): Promise<WorkspaceDirectoryEntry[]> {
    return this.listDirectoryMock(workspaceRoot, targetPath);
  }

  realPath(workspaceRoot: string, targetPath: string): Promise<string> {
    return this.realPathMock(workspaceRoot, targetPath);
  }

  stat(workspaceRoot: string, targetPath: string): Promise<WorkspacePathStat> {
    return this.statMock(workspaceRoot, targetPath);
  }

  async readFile(): Promise<string> {
    throw new Error('readFile is not used in fileTreeService tests');
  }

  async writeFile(): Promise<void> {
    throw new Error('writeFile is not used in fileTreeService tests');
  }

  async deleteFile(): Promise<void> {
    throw new Error('deleteFile is not used in fileTreeService tests');
  }

  async exists(): Promise<boolean> {
    throw new Error('exists is not used in fileTreeService tests');
  }
}

describe('buildFileTree', () => {
  const workspaceRoot = path.resolve('/workspace');

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops an out-of-root symlink rejected by the strict workspace guard', async () => {
    const workspaceFileSystem = new MockWorkspaceFileSystem();
    workspaceFileSystem.realPathMock.mockResolvedValue(workspaceRoot);
    workspaceFileSystem.listDirectoryMock.mockResolvedValue([
      { name: 'safe.md', isDirectory: false, isSymbolicLink: false },
      { name: 'outside-link', isDirectory: false, isSymbolicLink: true },
    ]);
    workspaceFileSystem.statMock.mockImplementation(async (_root, targetPath) => {
      if (targetPath === 'outside-link') {
        throw new WorkspaceFileSystemError('OutOfRoot', 'Path traversal not allowed');
      }
      return { isDirectory: false, mtimeMs: 1 };
    });
    setWorkspaceFileSystemFactory(() => workspaceFileSystem);

    const { nodes: tree } = await buildFileTree(workspaceRoot, workspaceRoot, 0, true);

    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      name: 'safe.md',
      kind: 'file',
    });
    expect(tree.some((node) => node.name === 'outside-link')).toBe(false);
  });

  it('walks sibling subtrees with isolated cycle-detection (no false positives)', async () => {
    // Both /a and /b resolve to themselves but contain the same nested
    // directory name. Pre-parallel-walk, the shared `visited` set would have
    // briefly contained the realpath of one sibling while the other was
    // running, causing incorrect skip. We verify both subtrees are walked
    // fully even though they're processed concurrently.
    const workspaceFileSystem = new MockWorkspaceFileSystem();
    workspaceFileSystem.realPathMock.mockImplementation(async (_root, targetPath) =>
      path.join(workspaceRoot, targetPath === '.' ? '' : targetPath),
    );
    workspaceFileSystem.listDirectoryMock.mockImplementation(async (_root, targetPath) => {
      if (targetPath === '.') {
        return [
          { name: 'a', isDirectory: true, isSymbolicLink: false },
          { name: 'b', isDirectory: true, isSymbolicLink: false },
        ];
      }
      if (targetPath === 'a' || targetPath === 'b') {
        return [{ name: 'leaf.md', isDirectory: false, isSymbolicLink: false }];
      }
      return [];
    });
    workspaceFileSystem.statMock.mockResolvedValue({ isDirectory: false, mtimeMs: 1 });

    setWorkspaceFileSystemFactory(() => workspaceFileSystem);

    const { nodes: tree } = await buildFileTree(workspaceRoot, workspaceRoot, 0, true);

    expect(tree.map((n) => n.name)).toEqual(['a', 'b']);
    for (const dir of tree) {
      expect(dir.kind).toBe('directory');
      const children = (dir as { children?: { name: string }[] }).children ?? [];
      expect(children.map((c) => c.name)).toEqual(['leaf.md']);
    }
  });

  it('detects a self-referential symlink cycle (visited-set still works)', async () => {
    // Set up a directory that infinitely contains itself: every recursion into
    // 'loop' resolves to the same realpath. The walk should terminate because
    // cycle detection fires the second time the same realpath is seen along
    // a single ancestry chain.
    const workspaceFileSystem = new MockWorkspaceFileSystem();
    workspaceFileSystem.realPathMock.mockImplementation(async (_root, targetPath) => {
      if (targetPath === '.') return workspaceRoot;
      return path.join(workspaceRoot, 'loop');
    });
    workspaceFileSystem.listDirectoryMock.mockResolvedValue([
      { name: 'loop', isDirectory: true, isSymbolicLink: false },
    ]);
    workspaceFileSystem.statMock.mockResolvedValue({ isDirectory: true, mtimeMs: 1 });

    setWorkspaceFileSystemFactory(() => workspaceFileSystem);

    // The walk must terminate (this assertion fails by timing out, not by
    // incorrect length) and produce exactly one nested 'loop' before cutting
    // off — the second visit to the same realpath is caught by cycle detection.
    const { nodes: tree } = await buildFileTree(workspaceRoot, workspaceRoot, 0, true);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('loop');
    // First descent into 'loop' succeeds; second descent (which would resolve
    // to the same realpath) is rejected by cycle detection. So the deepest
    // child node has no children.
    const firstChild = (tree[0] as { children?: { name: string; children?: unknown[] }[] }).children ?? [];
    expect(firstChild).toHaveLength(1);
    expect(firstChild[0].name).toBe('loop');
    expect(firstChild[0].children).toHaveLength(0);
  });

  it('resolves a symlink directory realpath once across the parent probe and child descent', async () => {
    // A symlink-directory entry is realpath-resolved twice without the cache:
    // once in the parent post-stat probe (entry.isSymbolicLink && stat.isDirectory),
    // and once on the child descent first-line (realDirectory resolution). Both
    // call sites key on the same relPath ('linkdir'), so the per-pass cache must
    // collapse them to a single realPath invocation.
    const workspaceFileSystem = new MockWorkspaceFileSystem();
    workspaceFileSystem.realPathMock.mockImplementation(async (_root, targetPath) =>
      path.join(workspaceRoot, targetPath === '.' ? '' : targetPath),
    );
    workspaceFileSystem.listDirectoryMock.mockImplementation(async (_root, targetPath) => {
      if (targetPath === '.') {
        return [{ name: 'linkdir', isDirectory: false, isSymbolicLink: true }];
      }
      return [];
    });
    workspaceFileSystem.statMock.mockResolvedValue({ isDirectory: true, mtimeMs: 1 });
    setWorkspaceFileSystemFactory(() => workspaceFileSystem);

    const { nodes: tree } = await buildFileTree(workspaceRoot, workspaceRoot, 0, true);

    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ name: 'linkdir', kind: 'directory' });
    const linkdirRealpathCalls = workspaceFileSystem.realPathMock.mock.calls.filter(
      ([, targetPath]) => targetPath === 'linkdir',
    );
    expect(linkdirRealpathCalls).toHaveLength(1);
  });

  it('keeps a cloud-mount symlink visible but does NOT recurse into it (RC-1)', async () => {
    // The reported hang: a `Company Memories` symlink whose target resolves into
    // a Google Drive shared drive. We must emit the node so the user still sees
    // it exists, but must NOT call listDirectory on it (descending blocks on
    // FUSE I/O and hangs the scan forever). Red→green: before the fix the symlink
    // is treated like any other directory and listDirectory IS called for it,
    // recursing into the (in real life, unbounded) cloud mount.
    const cloudTargetRealPath =
      '/Users/test/Library/CloudStorage/GoogleDrive-user@example.com/Shared drives/Company Memories';
    const workspaceFileSystem = new MockWorkspaceFileSystem();
    workspaceFileSystem.realPathMock.mockImplementation(async (_root, targetPath) => {
      if (targetPath === '.') return workspaceRoot;
      if (targetPath === 'Company Memories') return cloudTargetRealPath;
      return path.join(workspaceRoot, targetPath);
    });
    workspaceFileSystem.listDirectoryMock.mockImplementation(async (_root, targetPath) => {
      if (targetPath === '.') {
        return [
          { name: 'local.md', isDirectory: false, isSymbolicLink: false },
          { name: 'Company Memories', isDirectory: false, isSymbolicLink: true },
        ];
      }
      // If this fires for 'Company Memories' the fix has regressed — the scan
      // recursed into the cloud mount.
      return [{ name: 'should-not-be-walked.md', isDirectory: false, isSymbolicLink: false }];
    });
    workspaceFileSystem.statMock.mockImplementation(async (_root, targetPath) => {
      if (targetPath === 'Company Memories') return { isDirectory: true, mtimeMs: 1 };
      return { isDirectory: false, mtimeMs: 1 };
    });
    setWorkspaceFileSystemFactory(() => workspaceFileSystem);

    const { nodes: tree, metadata } = await buildFileTree(workspaceRoot, workspaceRoot, 0, true);

    // The cloud symlink is VISIBLE as a directory node...
    const cloudNode = tree.find((n) => n.name === 'Company Memories');
    expect(cloudNode).toBeDefined();
    expect(cloudNode).toMatchObject({ name: 'Company Memories', kind: 'directory' });
    // ...with no children (not walked)...
    expect((cloudNode as { children?: unknown[] }).children).toHaveLength(0);
    // ...and the local file is still present.
    expect(tree.some((n) => n.name === 'local.md')).toBe(true);

    // The KEY assertion: listDirectory is NEVER called for the cloud target.
    const cloudListCalls = workspaceFileSystem.listDirectoryMock.mock.calls.filter(
      ([, targetPath]) => targetPath === 'Company Memories',
    );
    expect(cloudListCalls).toHaveLength(0);

    // Skipping the cloud mount is a deliberate, complete result — not a
    // truncation/unavailable signal.
    expect(metadata.complete).toBe(true);
    expect(metadata.unavailableNodes).toBe(0);
  });

  it('still recurses into a non-cloud outside-workspace symlink such as rebel-system (carve-out)', async () => {
    // The CRITICAL carve-out from the packet: rebel-system is also an
    // outside-workspace symlink, but it is NOT a cloud mount, so it MUST keep
    // being followed (Skills / AGENTS.md depend on it).
    const rebelSystemRealPath =
      '/Applications/Mindstone Rebel.app/Contents/Resources/rebel-system';
    const workspaceFileSystem = new MockWorkspaceFileSystem();
    workspaceFileSystem.realPathMock.mockImplementation(async (_root, targetPath) => {
      if (targetPath === '.') return workspaceRoot;
      if (targetPath === 'rebel-system') return rebelSystemRealPath;
      return path.join(workspaceRoot, targetPath);
    });
    workspaceFileSystem.listDirectoryMock.mockImplementation(async (_root, targetPath) => {
      if (targetPath === '.') {
        return [{ name: 'rebel-system', isDirectory: false, isSymbolicLink: true }];
      }
      if (targetPath === 'rebel-system') {
        return [{ name: 'SKILL.md', isDirectory: false, isSymbolicLink: false }];
      }
      return [];
    });
    workspaceFileSystem.statMock.mockImplementation(async (_root, targetPath) => {
      if (targetPath === 'rebel-system') return { isDirectory: true, mtimeMs: 1 };
      return { isDirectory: false, mtimeMs: 1 };
    });
    setWorkspaceFileSystemFactory(() => workspaceFileSystem);

    const { nodes: tree } = await buildFileTree(workspaceRoot, workspaceRoot, 0, true);

    const rebelNode = tree.find((n) => n.name === 'rebel-system');
    expect(rebelNode).toMatchObject({ name: 'rebel-system', kind: 'directory' });
    const children = (rebelNode as { children?: { name: string }[] }).children ?? [];
    expect(children.map((c) => c.name)).toEqual(['SKILL.md']);
  });

  it('returns a root unavailable node when the root directory cannot be listed', async () => {
    const workspaceFileSystem = new MockWorkspaceFileSystem();
    workspaceFileSystem.realPathMock.mockResolvedValue(workspaceRoot);
    workspaceFileSystem.listDirectoryMock.mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    );
    setWorkspaceFileSystemFactory(() => workspaceFileSystem);

    const { nodes: tree } = await buildFileTree(workspaceRoot, workspaceRoot, 0, true);

    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      name: path.basename(workspaceRoot),
      path: workspaceRoot,
      kind: 'directory',
      children: [],
      unavailable: 'listdir-failed',
    });
  });
});
