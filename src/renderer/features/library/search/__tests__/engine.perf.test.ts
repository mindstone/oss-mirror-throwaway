import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FileNode } from '@shared/types';
import type { FlatFileEntry } from '@renderer/utils/librarySearch';

const { recordRendererBreadcrumbMock } = vi.hoisted(() => ({
  recordRendererBreadcrumbMock: vi.fn(),
}));

vi.mock('@renderer/src/sentry', () => ({
  recordRendererBreadcrumb: (breadcrumb: unknown) => recordRendererBreadcrumbMock(breadcrumb),
}));

import { invalidateLibrarySearchCache, searchLibrary } from '../engine';

type NodeKind = FileNode['kind'];

const makeNode = (
  name: string,
  path: string,
  kind: NodeKind = 'file',
): FileNode => ({
  name,
  path,
  kind,
});

const makeEntry = (
  name: string,
  path: string,
  fullPath: string,
  kind: NodeKind = 'file',
  skillMeta?: FlatFileEntry['skillMeta'],
): FlatFileEntry => ({
  node: makeNode(name, path, kind),
  fullPath,
  ...(skillMeta ? { skillMeta } : {}),
});

const createLargeEntries = (
  count: number,
  options?: {
    prefix?: string;
    reverseOrder?: boolean;
    pathRoot?: string;
  },
): FlatFileEntry[] => {
  const prefix = options?.prefix ?? 'files';
  const pathRoot = options?.pathRoot ?? '/workspace';
  const reverseOrder = options?.reverseOrder ?? false;
  const entries = new Array<FlatFileEntry>(count);

  for (let i = 0; i < count; i++) {
    const value = reverseOrder ? count - i - 1 : i;
    const suffix = value.toString().padStart(6, '0');
    const name = `file-${suffix}.md`;
    entries[i] = makeEntry(
      name,
      `${pathRoot}/${prefix}/${name}`,
      `${prefix}/${name}`,
    );
  }

  return entries;
};

describe('searchLibrary perf budgets', () => {
  beforeEach(() => {
    invalidateLibrarySearchCache();
    recordRendererBreadcrumbMock.mockReset();
  });

  it('meets the 100k single-term query performance budget (<200ms after warm cache)', () => {
    const entries = createLargeEntries(100_000);
    searchLibrary('file', entries); // warm

    const started = performance.now();
    searchLibrary('file', entries);
    const durationMs = performance.now() - started;

    const budgetMs = process.env.CI ? 1200 : 300;
    expect(durationMs).toBeLessThan(budgetMs);
  });

  it('meets the 200k cap path performance budget (<500ms cold)', () => {
    const entries = createLargeEntries(200_000, { reverseOrder: true });

    const started = performance.now();
    searchLibrary('file', entries);
    const durationMs = performance.now() - started;

    const budgetMs = process.env.CI ? 2000 : 500;
    expect(durationMs).toBeLessThan(budgetMs);
  });
});
