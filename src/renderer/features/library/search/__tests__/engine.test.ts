import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FileNode } from '@shared/types';
import type { FlatFileEntry } from '@renderer/utils/librarySearch';

const { recordRendererBreadcrumbMock } = vi.hoisted(() => ({
  recordRendererBreadcrumbMock: vi.fn(),
}));

vi.mock('@renderer/src/sentry', () => ({
  recordRendererBreadcrumb: (breadcrumb: unknown) => recordRendererBreadcrumbMock(breadcrumb),
}));

import * as librarySearchModule from '@renderer/utils/librarySearch';
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

const normalizeForSortCheck = (entry: FlatFileEntry): string =>
  (entry.fullPath ?? entry.node?.path ?? entry.node?.name ?? '')
    .toLowerCase()
    .replace(/\\/g, '/');

const buildRepresentativeEntries = (): FlatFileEntry[] => [
  makeEntry(
    'daily-prep',
    '/workspace/space/custom/daily-prep',
    'space/custom/daily-prep',
    'directory',
    {
      name: 'waterloo-meeting-prep',
      description: 'Prepare for the Waterloo account review',
    },
  ),
  makeEntry(
    'write-skill.md',
    '/workspace/space/skills/write-skill.md',
    'space/skills/write-skill.md',
  ),
  makeEntry('chatgpt.png', '/workspace/assets/chatgpt.png', 'assets/chatgpt.png'),
  makeEntry('setup.md', '/workspace/docs/setup.md', 'docs/setup.md'),
  makeEntry('setup-guide.md', '/workspace/docs/setup-guide.md', 'docs/setup-guide.md'),
  makeEntry('waterloo-notes.md', '/workspace/docs/waterloo-notes.md', 'docs/waterloo-notes.md'),
  makeEntry('meeting-plan.md', '/workspace/notes/meeting-plan.md', 'notes/meeting-plan.md'),
  makeEntry('platform-guide.md', '/workspace/rebel-system/docs/platform-guide.md', 'rebel-system/docs/platform-guide.md'),
  makeEntry('setup-windows.md', 'C:\\workspace\\docs\\setup-windows.md', 'docs/setup-windows.md'),
  makeEntry(
    'personal-daily.md',
    '/workspace/space/personal/skills/personal-daily.md',
    'space/personal/skills/personal-daily.md',
    'directory',
    {
      name: 'personal-daily-routine',
      description: 'Build and review daily routine notes',
    },
  ),
];

describe('searchLibrary', () => {
  beforeEach(() => {
    invalidateLibrarySearchCache();
    recordRendererBreadcrumbMock.mockReset();
  });

  it('preserves search output equivalence against searchFiles for representative queries', () => {
    const entries = buildRepresentativeEntries();
    const queries = [
      'waterloo meeting',
      'skill write',
      'write',
      'chatgpt',
      'docs/setup',
      'docs\\setup',
      'daily prep',
      'rebel-system',
      'platform guide',
      'setup-guide',
      'personal routine',
    ];

    for (const query of queries) {
      const expected = librarySearchModule.searchFiles(query, entries, { limit: 30 });
      const outcome = searchLibrary(query, entries, { limit: 30 });

      expect(outcome.results).toEqual(expected);
      expect(outcome.truncated).toBe(false);
      expect(outcome.truncationReason).toBeNull();
      expect(outcome.entriesTotal).toBe(entries.length);
      expect(outcome.entriesIndexed).toBe(entries.length);
    }
  });

  it('boosts component-prefix matches over longer *-skill-other variants', () => {
    const entries: FlatFileEntry[] = [
      makeEntry('write-skill.md', '/workspace/write-skill.md', 'write-skill.md'),
      makeEntry('alpha-skill-other.md', '/workspace/alpha-skill-other.md', 'alpha-skill-other.md'),
      makeEntry('omega-skill-other.md', '/workspace/omega-skill-other.md', 'omega-skill-other.md'),
    ];

    const outcome = searchLibrary('ski', entries, { limit: 3 });
    expect(outcome.results.map((result) => result.node.name)).toEqual([
      'write-skill.md',
      'alpha-skill-other.md',
      'omega-skill-other.md',
    ]);
  });

  it('does not truncate when entries are below the cap (99,999)', () => {
    const entries = createLargeEntries(99_999);
    const outcome = searchLibrary('file', entries);

    expect(outcome.truncated).toBe(false);
    expect(outcome.truncationReason).toBeNull();
    expect(outcome.entriesTotal).toBe(99_999);
    expect(outcome.entriesIndexed).toBe(99_999);
    expect(recordRendererBreadcrumbMock).not.toHaveBeenCalled();
  });

  it('does not truncate at the cap boundary (100,000)', () => {
    const entries = createLargeEntries(100_000);
    const outcome = searchLibrary('file', entries);

    expect(outcome.truncated).toBe(false);
    expect(outcome.truncationReason).toBeNull();
    expect(outcome.entriesTotal).toBe(100_000);
    expect(outcome.entriesIndexed).toBe(100_000);
    expect(recordRendererBreadcrumbMock).not.toHaveBeenCalled();
  });

  it('truncates deterministically and memoises the capped slice above the cap (100,001)', () => {
    const entries = createLargeEntries(100_001, { reverseOrder: true });
    const createFuseSpy = vi.spyOn(librarySearchModule, 'createLibrarySearchFuse');

    const firstOutcome = searchLibrary('file', entries, { surface: 'rail' });
    const secondOutcome = searchLibrary('file', entries, { surface: 'rail' });

    expect(firstOutcome.truncated).toBe(true);
    expect(firstOutcome.truncationReason).toBe('engine-cap');
    expect(firstOutcome.entriesTotal).toBe(100_001);
    expect(firstOutcome.entriesIndexed).toBe(100_000);
    expect(secondOutcome.results).toEqual(firstOutcome.results);
    expect(createFuseSpy).toHaveBeenCalledTimes(1);

    const indexedEntries = createFuseSpy.mock.calls[0]?.[0] as ReadonlyArray<FlatFileEntry>;
    expect(indexedEntries).toHaveLength(100_000);
    for (let i = 1; i < indexedEntries.length; i++) {
      expect(normalizeForSortCheck(indexedEntries[i - 1]) <= normalizeForSortCheck(indexedEntries[i])).toBe(true);
    }

    expect(recordRendererBreadcrumbMock).toHaveBeenCalledTimes(1);
    expect(recordRendererBreadcrumbMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'library_search.engine_cap_fired',
      data: expect.objectContaining({
        entriesTotal: 100_001,
        entriesIndexed: 100_000,
        surface: 'rail',
      }),
    }));

    createFuseSpy.mockRestore();
  });

  it('reuses one Fuse construction across sequential queries on a 200k source array', () => {
    const entries = createLargeEntries(200_000, { reverseOrder: true });
    const createFuseSpy = vi.spyOn(librarySearchModule, 'createLibrarySearchFuse');
    const queries = ['file', 'file-0', 'file-1', 'file-2', 'file-3', 'file-4', 'file-5', 'file-6', 'file-7', 'file-8'];

    for (const query of queries) {
      searchLibrary(query, entries, { surface: 'command-shelf' });
    }

    expect(createFuseSpy).toHaveBeenCalledTimes(1);
    createFuseSpy.mockRestore();
  });

  it('reuses cached Fuse entries when returning to a source array within LRU capacity', () => {
    const entriesA = createLargeEntries(100_010, { reverseOrder: true, prefix: 'a-files' });
    const entriesB = createLargeEntries(100_011, { reverseOrder: true, prefix: 'b-files' });
    const createFuseSpy = vi.spyOn(librarySearchModule, 'createLibrarySearchFuse');

    searchLibrary('file', entriesA);
    searchLibrary('file', entriesB);
    searchLibrary('file', entriesA);

    expect(createFuseSpy).toHaveBeenCalledTimes(2);
    const firstEntriesArg = createFuseSpy.mock.calls[0]?.[0] as ReadonlyArray<FlatFileEntry>;
    const secondEntriesArg = createFuseSpy.mock.calls[1]?.[0] as ReadonlyArray<FlatFileEntry>;
    expect(secondEntriesArg).not.toBe(firstEntriesArg);
    const reusedOutcome = searchLibrary('file', entriesA);
    expect(reusedOutcome.entriesTotal).toBe(100_010);
    expect(reusedOutcome.entriesIndexed).toBe(100_000);
    expect(createFuseSpy).toHaveBeenCalledTimes(2);
    createFuseSpy.mockRestore();
  });

  it('evicts the least-recent source array when LRU capacity (4) is exceeded', () => {
    const entriesA = createLargeEntries(20, { prefix: 'a-files' });
    const entriesB = createLargeEntries(20, { prefix: 'b-files' });
    const entriesC = createLargeEntries(20, { prefix: 'c-files' });
    const entriesD = createLargeEntries(20, { prefix: 'd-files' });
    const entriesE = createLargeEntries(20, { prefix: 'e-files' });
    const createFuseSpy = vi.spyOn(librarySearchModule, 'createLibrarySearchFuse');

    searchLibrary('file', entriesA);
    searchLibrary('file', entriesB);
    searchLibrary('file', entriesC);
    searchLibrary('file', entriesD);
    searchLibrary('file', entriesA); // refresh A as most-recent
    searchLibrary('file', entriesE); // should evict B (least-recent)
    searchLibrary('file', entriesB); // recreate B after eviction

    expect(createFuseSpy).toHaveBeenCalledTimes(6);
    createFuseSpy.mockRestore();
  });

  it('emits cap breadcrumb once per entries reference/cap-state transition', () => {
    const cappedEntries = createLargeEntries(100_001, { reverseOrder: true });
    const cappedEntriesClone = [...cappedEntries];

    searchLibrary('file', cappedEntries, { surface: 'rail' });
    searchLibrary('file', cappedEntries, { surface: 'rail' });
    searchLibrary('file', cappedEntries, { surface: 'rail' });
    expect(recordRendererBreadcrumbMock).toHaveBeenCalledTimes(1);

    searchLibrary('file', cappedEntriesClone, { surface: 'rail' });
    expect(recordRendererBreadcrumbMock).toHaveBeenCalledTimes(2);
  });

  it('handles comparator edge cases (undefined fullPath, duplicates, Windows separators) deterministically', () => {
    const fillerEntries = createLargeEntries(99_998, { prefix: 'a-sorted' });
    const undefinedFullPathEntry = {
      node: makeNode('setup.md', 'C:\\docs\\setup.md'),
      fullPath: undefined as unknown as string,
    } satisfies FlatFileEntry;
    const duplicateDirectory = makeEntry('shared.md', '/m/shared.md', 'm/shared.md', 'directory');
    const duplicateFile = makeEntry('shared.md', '/m/shared.md', 'm/shared.md', 'file');
    const tailEntry = makeEntry('tail.md', '/z/tail.md', 'z/tail.md', 'file');

    const entries = [
      ...fillerEntries,
      duplicateFile,
      tailEntry,
      undefinedFullPathEntry,
      duplicateDirectory,
    ];
    const reversedEntries = [...entries].reverse();

    const sharedOutcome = searchLibrary('shared', entries, { limit: 5 });
    const sharedOutcomeReversed = searchLibrary('shared', reversedEntries, { limit: 5 });
    expect(sharedOutcome.truncated).toBe(true);
    expect(sharedOutcome.results.map((result) => `${result.node.path}:${result.node.kind}`))
      .toEqual(sharedOutcomeReversed.results.map((result) => `${result.node.path}:${result.node.kind}`));
    expect(sharedOutcome.results.some((result) => result.node.path === '/m/shared.md' && result.node.kind === 'directory')).toBe(true);
    expect(sharedOutcome.results.some((result) => result.node.path === '/m/shared.md' && result.node.kind === 'file')).toBe(false);

    const setupOutcome = searchLibrary('setup', entries, { limit: 5 });
    expect(setupOutcome.results.some((result) => result.node.path === 'C:\\docs\\setup.md')).toBe(true);
  });

  it('preserves defensive nullable guards', () => {
    const entries: FlatFileEntry[] = [
      {
        node: makeNode(undefined as unknown as string, '/workspace/nullable-name.md'),
        fullPath: 'nullable/nullable-name.md',
        skillMeta: {
          name: undefined as unknown as string,
          description: undefined,
        },
      },
      {
        node: makeNode('normal.md', '/workspace/normal.md'),
        fullPath: undefined as unknown as string,
      },
    ];

    expect(() => searchLibrary('nullable', entries)).not.toThrow();
    expect(() => searchLibrary('normal', entries)).not.toThrow();
  });

  it('freezes entries in dev mode to prevent in-place mutation', () => {
    const entries = createLargeEntries(4);
    searchLibrary('file', entries);

    const shouldFreeze =
      import.meta.env.DEV
      || process.env.NODE_ENV === 'development'
      || process.env.NODE_ENV === 'test';
    if (!shouldFreeze) {
      expect(Object.isFrozen(entries)).toBe(false);
      return;
    }

    expect(Object.isFrozen(entries)).toBe(true);
    expect(() => {
      (entries as FlatFileEntry[]).push(
        makeEntry('mutated.md', '/workspace/mutated.md', 'mutated.md'),
      );
    }).toThrow();
  });

  it('freezes entries before empty-query early return', () => {
    const entries = createLargeEntries(4);
    const outcome = searchLibrary('   ', entries);

    const shouldFreeze =
      import.meta.env.DEV
      || process.env.NODE_ENV === 'development'
      || process.env.NODE_ENV === 'test';
    if (!shouldFreeze) {
      expect(Object.isFrozen(entries)).toBe(false);
      return;
    }

    expect(Object.isFrozen(entries)).toBe(true);
    expect(outcome.results).toEqual([]);
  });

  it('throws for unsupported undefined query/null entries inputs', () => {
    const entries = createLargeEntries(3);

    expect(() => searchLibrary(undefined as unknown as string, entries)).toThrow();
    expect(() => searchLibrary('file', null as unknown as ReadonlyArray<FlatFileEntry>)).toThrow();
  });

  it('invalidates internal cache and forces Fuse recreation', () => {
    const entries = createLargeEntries(100_005, { reverseOrder: true });
    const createFuseSpy = vi.spyOn(librarySearchModule, 'createLibrarySearchFuse');

    searchLibrary('file', entries);
    searchLibrary('file', entries);
    expect(createFuseSpy).toHaveBeenCalledTimes(1);

    invalidateLibrarySearchCache();
    searchLibrary('file', entries);
    expect(createFuseSpy).toHaveBeenCalledTimes(2);
    createFuseSpy.mockRestore();
  });

  // The 100k single-term and 200k cap-path perf-budget cases were relocated to the
  // sibling `engine.perf.test.ts` so they run single-threaded in the dedicated `perf`
  // Vitest project, free of parallel-load CPU contention.
});
