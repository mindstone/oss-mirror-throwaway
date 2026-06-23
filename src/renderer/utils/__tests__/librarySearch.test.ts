import { describe, it, expect, vi } from 'vitest';
import { flattenFileTree, searchFiles, type FlatFileEntry } from '@renderer/utils/librarySearch';
import type { FileNode } from '@shared/types';

/** Helper to create a minimal FileNode */
const makeFile = (name: string, path: string): FileNode => ({
  name,
  path,
  kind: 'file',
});

const makeDir = (name: string, path: string, children: FileNode[] = []): FileNode => ({
  name,
  path,
  kind: 'directory',
  children,
});

describe('flattenFileTree', () => {
  it('flattens a simple tree with files and directories', () => {
    const tree: FileNode[] = [
      makeDir('docs', '/docs', [
        makeFile('readme.md', '/docs/readme.md'),
        makeDir('guides', '/docs/guides', [
          makeFile('setup.md', '/docs/guides/setup.md'),
        ]),
      ]),
      makeFile('index.ts', '/index.ts'),
    ];

    const result = flattenFileTree(tree);

    const paths = result.map((e) => e.fullPath);
    expect(paths).toContain('docs');
    expect(paths).toContain('docs/readme.md');
    expect(paths).toContain('docs/guides');
    expect(paths).toContain('docs/guides/setup.md');
    expect(paths).toContain('index.ts');
    expect(result).toHaveLength(5);
  });

  it('returns empty array for empty input', () => {
    expect(flattenFileTree([])).toEqual([]);
  });

  it('respects parentPath parameter', () => {
    const tree: FileNode[] = [makeFile('a.txt', '/root/a.txt')];
    const result = flattenFileTree(tree, 'root');
    expect(result[0].fullPath).toBe('root/a.txt');
  });

  it('detects cycles and warns instead of stack-overflowing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const parent = makeDir('parent', '/parent');
    const child = makeDir('child', '/child', [parent]); // child points back to parent path
    // Create cycle: parent → child → parent (same path re-visited)
    parent.children = [child];

    // Manually create the cycle by giving the nested "parent" the same path
    // The child's children array contains a node with path '/parent' which
    // is the same as the top-level parent — this triggers cycle detection
    const tree: FileNode[] = [parent];
    const result = flattenFileTree(tree);

    // Should not throw or hang — cycle is broken by visited set
    expect(result.length).toBeGreaterThan(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[flattenFileTree] Cycle detected')
    );

    warnSpy.mockRestore();
  });

  it('handles a wide tree without argument-limit errors', () => {
    // Spread syntax on large arrays can hit engine argument limits (~65K).
    // The iterative implementation avoids this.
    const wideChildren: FileNode[] = Array.from({ length: 10_000 }, (_, i) => (
      makeFile(`file-${i}.txt`, `/wide/file-${i}.txt`)
    ));
    const tree: FileNode[] = [makeDir('wide', '/wide', wideChildren)];

    const result = flattenFileTree(tree);
    // 1 directory + 10,000 files
    expect(result).toHaveLength(10_001);
  });
});

describe('searchFiles', () => {
  it('matches and preserves metadata-backed skill folders', () => {
    const files: FlatFileEntry[] = [
      {
        node: makeDir('daily-prep', '/space/custom/daily-prep'),
        fullPath: 'space/custom/daily-prep',
        skillMeta: {
          name: 'waterloo-meeting-prep',
          description: 'Prepare for the Waterloo account review',
        },
      },
      {
        node: makeFile('waterloo-notes.md', '/space/docs/waterloo-notes.md'),
        fullPath: 'space/docs/waterloo-notes.md',
      },
    ];

    const results = searchFiles('waterloo meeting', files);

    expect(results[0]).toMatchObject({
      fullPath: 'space/custom/daily-prep',
      skillMeta: {
        name: 'waterloo-meeting-prep',
      },
    });
  });
});
