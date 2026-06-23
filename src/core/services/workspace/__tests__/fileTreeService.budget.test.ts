import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  setWorkspaceFileSystemFactory,
  type WorkspaceDirectoryEntry,
  type WorkspaceFileSystem,
  type WorkspacePathStat,
} from '@core/workspaceFileSystem';
import { MAX_FILE_TREE_NODES, MAX_CHILDREN_PER_DIRECTORY } from '@core/constants';
import { buildFileTree } from '../fileTreeService';

/**
 * Tests the Bug-2 by-construction producer cap: buildFileTree shares one global
 * node+byte budget across the WHOLE recursive walk, reserved synchronously at
 * admission so RECURSION_CONCURRENCY can't overshoot, and returns
 * `{ nodes, metadata }` so completeness travels with the result.
 */

/**
 * Synthetic in-memory FS describing a directory layout: a map of
 * workspace-relative dir path → child entry names. Files are leaves.
 */
type FsLayout = {
  dirs: Map<string, WorkspaceDirectoryEntry[]>;
};

function makeFs(layout: FsLayout): WorkspaceFileSystem {
  return {
    listDirectory: async (_root: string, targetPath: string): Promise<WorkspaceDirectoryEntry[]> => {
      return layout.dirs.get(targetPath) ?? [];
    },
    realPath: async (_root: string, targetPath: string): Promise<string> =>
      path.join('/workspace', targetPath === '.' ? '' : targetPath),
    stat: async (_root: string, _targetPath: string): Promise<WorkspacePathStat> => ({
      isDirectory: false,
      mtimeMs: 1,
    }),
    readFile: async () => {
      throw new Error('readFile not used');
    },
    writeFile: async () => {
      throw new Error('writeFile not used');
    },
    deleteFile: async () => {
      throw new Error('deleteFile not used');
    },
    exists: async () => {
      throw new Error('exists not used');
    },
  } as WorkspaceFileSystem;
}

/** Build a single flat directory with `count` files named f0..f(count-1). */
function flatDir(count: number): FsLayout {
  const files: WorkspaceDirectoryEntry[] = Array.from({ length: count }, (_v, i) => ({
    name: `f${i}.md`,
    isDirectory: false,
    isSymbolicLink: false,
  }));
  return { dirs: new Map([['.', files]]) };
}

function countNodes(nodes: Array<{ children?: unknown[] }>): number {
  let total = 0;
  for (const node of nodes) {
    total += 1;
    const children = (node as { children?: Array<{ children?: unknown[] }> }).children;
    if (children) total += countNodes(children);
  }
  return total;
}

const workspaceRoot = path.resolve('/workspace');

describe('buildFileTree global budget', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a small tree returns complete=true, truncated=false', async () => {
    setWorkspaceFileSystemFactory(() => makeFs(flatDir(3)));

    const { nodes, metadata } = await buildFileTree(workspaceRoot, workspaceRoot, 0, true);

    expect(nodes).toHaveLength(3);
    expect(metadata.complete).toBe(true);
    expect(metadata.truncated).toBe(false);
    expect(metadata.reasons).toEqual([]);
    expect(metadata.returnedNodes).toBe(3);
  });

  it('EXACTLY at the node cap returns complete=true (nothing omitted)', async () => {
    // Construct a tree whose total node count is EXACTLY MAX_FILE_TREE_NODES so
    // the last admitted node fills the budget without any node being declined.
    // D dirs * (1 dir node + F files) = D*(1+F). With D=100, F: choose so the
    // total equals the cap exactly, staying under the per-dir cap (1000).
    const dirCount = 100;
    const filesPerDir = MAX_FILE_TREE_NODES / dirCount - 1; // 100*(1+999)=100000
    expect(Number.isInteger(filesPerDir)).toBe(true);
    expect(filesPerDir).toBeLessThanOrEqual(MAX_CHILDREN_PER_DIRECTORY);

    const dirs = new Map<string, WorkspaceDirectoryEntry[]>();
    dirs.set(
      '.',
      Array.from({ length: dirCount }, (_v, i) => ({ name: `d${i}`, isDirectory: true, isSymbolicLink: false })),
    );
    for (let i = 0; i < dirCount; i++) {
      dirs.set(
        `d${i}`,
        Array.from({ length: filesPerDir }, (_v, j) => ({ name: `f${j}.md`, isDirectory: false, isSymbolicLink: false })),
      );
    }
    setWorkspaceFileSystemFactory(() => makeFs({ dirs }));

    const { nodes, metadata } = await buildFileTree(workspaceRoot, workspaceRoot, 0, true);
    const total = countNodes(nodes);

    expect(total).toBe(MAX_FILE_TREE_NODES);
    expect(metadata.returnedNodes).toBe(MAX_FILE_TREE_NODES);
    expect(metadata.truncated).toBe(false);
    expect(metadata.complete).toBe(true);
    expect(metadata.reasons).toEqual([]);
    expect(metadata.unavailableNodes).toBe(0);
  });

  it('an empty workspace returns complete=true, returnedNodes=0', async () => {
    setWorkspaceFileSystemFactory(() => makeFs(flatDir(0)));
    const { nodes, metadata } = await buildFileTree(workspaceRoot, workspaceRoot, 0, true);
    expect(nodes).toHaveLength(0);
    expect(metadata.complete).toBe(true);
    expect(metadata.truncated).toBe(false);
    expect(metadata.returnedNodes).toBe(0);
    expect(metadata.unavailableNodes).toBe(0);
  });

  it('a root that cannot be listed reports complete=false, returnedNodes=1, unavailable reason', async () => {
    // listDirectory on the root throws → buildFileTree emits ONE synthetic
    // unavailable root node. Metadata must NOT claim complete=true /
    // returnedNodes=0 (the dangerous "complete-on-partial" direction).
    const fs = makeFs(flatDir(0));
    fs.listDirectory = async () => {
      throw new Error('EACCES: permission denied');
    };
    setWorkspaceFileSystemFactory(() => fs);

    const { nodes, metadata } = await buildFileTree(workspaceRoot, workspaceRoot, 0, true);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: 'directory', unavailable: 'listdir-failed' });
    expect(metadata.complete).toBe(false);
    expect(metadata.truncated).toBe(true);
    expect(metadata.returnedNodes).toBe(1);
    expect(metadata.unavailableNodes).toBe(1);
    expect(metadata.reasons).toContain('unavailable');
  });

  it('an unavailable child subtree forces complete=false even with no budget cap', async () => {
    // Root lists fine and has one child dir; that child dir fails to list.
    // No budget/depth/per-dir cap fires, yet the tree is NOT a complete
    // representation of the workspace, so metadata must report it.
    const dirs = new Map<string, WorkspaceDirectoryEntry[]>([
      ['.', [
        { name: 'good.md', isDirectory: false, isSymbolicLink: false },
        { name: 'badchild', isDirectory: true, isSymbolicLink: false },
      ]],
    ]);
    const fs = makeFs({ dirs });
    const baseListDirectory = fs.listDirectory;
    fs.listDirectory = async (root: string, targetPath: string) => {
      if (targetPath === 'badchild') {
        throw new Error('EACCES: permission denied');
      }
      return baseListDirectory(root, targetPath);
    };
    setWorkspaceFileSystemFactory(() => fs);

    const { nodes, metadata } = await buildFileTree(workspaceRoot, workspaceRoot, 0, true);

    // The child dir node is present but marked unavailable.
    const childDir = nodes.find((n) => n.name === 'badchild');
    expect(childDir).toMatchObject({ kind: 'directory', unavailable: 'listdir-failed' });
    expect(metadata.complete).toBe(false);
    expect(metadata.truncated).toBe(true);
    expect(metadata.unavailableNodes).toBe(1);
    expect(metadata.reasons).toContain('unavailable');
    // No budget cap reason — degradation is purely availability.
    expect(metadata.reasons).not.toContain('global-node-cap');
  });

  it('a flat dir EXCEEDING the node cap returns exactly-capped nodes + truncated with global-node-cap', async () => {
    // One directory with far more files than the global node cap. The per-dir
    // cap (MAX_CHILDREN_PER_DIRECTORY=10000) does NOT bound this because each
    // sibling dir holds only 1000 files (< the per-dir cap); this isolates the
    // GLOBAL node budget. To keep the test fast while still exceeding the global
    // cap, we layer many sibling directories well under the per-dir cap.
    const dirs = new Map<string, WorkspaceDirectoryEntry[]>();
    // root holds N child dirs
    const childDirCount = 150; // 150 * 1000 = 150k eligible files > 100k cap
    const rootEntries: WorkspaceDirectoryEntry[] = Array.from({ length: childDirCount }, (_v, i) => ({
      name: `d${i}`,
      isDirectory: true,
      isSymbolicLink: false,
    }));
    dirs.set('.', rootEntries);
    for (let i = 0; i < childDirCount; i++) {
      const files: WorkspaceDirectoryEntry[] = Array.from({ length: 1000 }, (_v, j) => ({
        name: `f${j}.md`,
        isDirectory: false,
        isSymbolicLink: false,
      }));
      dirs.set(`d${i}`, files);
    }
    setWorkspaceFileSystemFactory(() => makeFs({ dirs }));

    const { nodes, metadata } = await buildFileTree(workspaceRoot, workspaceRoot, 0, true);

    const total = countNodes(nodes);
    expect(total).toBeLessThanOrEqual(MAX_FILE_TREE_NODES);
    expect(metadata.truncated).toBe(true);
    expect(metadata.complete).toBe(false);
    expect(metadata.reasons).toContain('global-node-cap');
    expect(metadata.returnedNodes).toBe(total);
    expect(metadata.returnedNodes).toBeLessThanOrEqual(MAX_FILE_TREE_NODES);
  });

  it('parallel-overshoot guard: a wide tree never exceeds the cap despite RECURSION_CONCURRENCY', async () => {
    // Many wide sibling subtrees recursed concurrently (RECURSION_CONCURRENCY=16).
    // Because each node's slot is reserved synchronously at admission BEFORE
    // children are scheduled, concurrent branches cannot collectively overshoot.
    const dirs = new Map<string, WorkspaceDirectoryEntry[]>();
    const childDirCount = 200; // 200 * 1000 = 200k eligible > 100k cap, 16-way concurrent
    dirs.set(
      '.',
      Array.from({ length: childDirCount }, (_v, i) => ({
        name: `d${i}`,
        isDirectory: true,
        isSymbolicLink: false,
      })),
    );
    for (let i = 0; i < childDirCount; i++) {
      dirs.set(
        `d${i}`,
        Array.from({ length: 1000 }, (_v, j) => ({
          name: `f${j}.md`,
          isDirectory: false,
          isSymbolicLink: false,
        })),
      );
    }
    setWorkspaceFileSystemFactory(() => makeFs({ dirs }));

    const { nodes, metadata } = await buildFileTree(workspaceRoot, workspaceRoot, 0, true);
    const total = countNodes(nodes);

    expect(total).toBeLessThanOrEqual(MAX_FILE_TREE_NODES);
    expect(metadata.returnedNodes).toBeLessThanOrEqual(MAX_FILE_TREE_NODES);
    expect(metadata.truncated).toBe(true);
  });

  it('byte-cap can bind before the node cap on long-path trees', async () => {
    // A modest number of files with very long names so the byte budget binds
    // before the node-count budget. ~128 MiB / (~2 * 60_000 chars) ≈ ~1090
    // nodes, far below the 100k node cap — so global-byte-cap must fire and
    // node count must be far under MAX_FILE_TREE_NODES.
    const longName = `${'x'.repeat(60_000)}.md`;
    const files: WorkspaceDirectoryEntry[] = Array.from({ length: 5000 }, (_v, i) => ({
      name: `${i}-${longName}`,
      isDirectory: false,
      isSymbolicLink: false,
    }));
    // Spread across sibling dirs so the per-dir cap (10000) doesn't pre-empt the
    // byte budget — each dir holds 1000 files (< the per-dir cap). 5 dirs * 1000
    // files = 5000 files of ~120 KB each ≈ 600 MB estimated, well over the
    // 128 MiB byte cap.
    const dirs = new Map<string, WorkspaceDirectoryEntry[]>();
    dirs.set(
      '.',
      Array.from({ length: 5 }, (_v, i) => ({ name: `d${i}`, isDirectory: true, isSymbolicLink: false })),
    );
    for (let i = 0; i < 5; i++) {
      dirs.set(`d${i}`, files.slice(i * 1000, (i + 1) * 1000));
    }
    setWorkspaceFileSystemFactory(() => makeFs({ dirs }));

    const { nodes, metadata } = await buildFileTree(workspaceRoot, workspaceRoot, 0, true);
    const total = countNodes(nodes);

    expect(metadata.truncated).toBe(true);
    expect(metadata.reasons).toContain('global-byte-cap');
    expect(total).toBeLessThan(MAX_FILE_TREE_NODES);
  });
});
