// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileNode } from '@shared/types';
import type { FlatFileEntry, SearchResult } from '@renderer/utils/librarySearch';
import * as librarySearchEngine from '@renderer/features/library/search/engine';
import * as librarySearchModule from '@renderer/utils/librarySearch';
import { isHiddenSkillMd, isMemoryPath, isSkillEntry } from '@renderer/utils/skillUtils';
import { LibrarySearchResults } from '../../components/LibrarySearchResults';
import { useLibrarySearch } from '../useLibrarySearch';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookOptions = Parameters<typeof useLibrarySearch>[0];
type HookValue = ReturnType<typeof useLibrarySearch>;

const makeFileNode = (name: string, path: string): FileNode => ({
  name,
  path,
  kind: 'file',
});

const makeDirectoryNode = (name: string, path: string, children: FileNode[] = []): FileNode => ({
  name,
  path,
  kind: 'directory',
  children,
});

const makeEntry = (node: FileNode, fullPath: string): FlatFileEntry => ({ node, fullPath });

const dedupeByPath = (results: SearchResult[]): SearchResult[] => {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const result of results) {
    if (seen.has(result.node.path)) continue;
    seen.add(result.node.path);
    deduped.push(result);
  }
  return deduped;
};

const getShelfBuckets = (files: FlatFileEntry[]) => ({
  skills: files.filter((entry) => !isHiddenSkillMd(entry) && isSkillEntry(entry)),
  spaces: files.filter(
    (entry) => entry.node.kind === 'directory' && !isSkillEntry(entry) && !isMemoryPath(entry.fullPath),
  ),
  regularFiles: files.filter(
    (entry) => entry.node.kind === 'file' && !isHiddenSkillMd(entry) && !isSkillEntry(entry) && !isMemoryPath(entry.fullPath),
  ),
});

const flushSearchDebounce = (ms = 60): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

const TRUNCATION_HINT_COPY = 'Searched first 100,000 files. Some matches may be missing.';

describe('useLibrarySearch', () => {
  let hookRoot: Root;
  let hookContainer: HTMLDivElement;
  let latest: HookValue;
  let hookOptions: HookOptions;
  const emitLog = vi.fn();
  const onSelect = vi.fn();

  function HookProbe(props: HookOptions) {
    latest = useLibrarySearch(props);
    return null;
  }

  const mountHook = (overrides: Partial<HookOptions> = {}) => {
    hookOptions = {
      files: [],
      emitLog,
      onSelect,
      ...overrides,
    };

    act(() => {
      hookRoot.render(<HookProbe {...hookOptions} />);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    emitLog.mockReset();
    onSelect.mockReset();
    librarySearchEngine.invalidateLibrarySearchCache();

    hookContainer = document.createElement('div');
    document.body.appendChild(hookContainer);
    hookRoot = createRoot(hookContainer);
  });

  afterEach(() => {
    act(() => {
      hookRoot.unmount();
    });
    hookContainer.remove();
    document.body.innerHTML = '';
    librarySearchEngine.invalidateLibrarySearchCache();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('builds skills/spaces/files sections with searchLibrary ordering for representative queries', () => {
    const files: FlatFileEntry[] = [
      makeEntry(
        makeDirectoryNode('chat-skill', '/workspace/skills/chat-skill', [
          makeFileNode('SKILL.md', '/workspace/skills/chat-skill/SKILL.md'),
        ]),
        'skills/chat-skill',
      ),
      makeEntry(makeFileNode('SKILL.md', '/workspace/skills/chat-skill/SKILL.md'), 'skills/chat-skill/SKILL.md'),
      makeEntry(makeFileNode('chat-skill-helper.md', '/workspace/skills/chat-skill-helper.md'), 'skills/chat-skill-helper.md'),
      makeEntry(makeDirectoryNode('chat-space', '/workspace/work/team/alpha/chat-space'), 'work/team/alpha/chat-space'),
      makeEntry(makeDirectoryNode('space-notes', '/workspace/work/team/alpha/space-notes'), 'work/team/alpha/space-notes'),
      makeEntry(makeFileNode('chat-file.md', '/workspace/docs/chat-file.md'), 'docs/chat-file.md'),
      makeEntry(makeFileNode('space-overview.md', '/workspace/docs/space-overview.md'), 'docs/space-overview.md'),
      makeEntry(makeFileNode('memory-chat.md', '/workspace/memory/memory-chat.md'), 'memory/memory-chat.md'),
    ];
    const buckets = getShelfBuckets(files);

    mountHook({ files });

    for (const query of ['chat', 'skill', 'space']) {
      act(() => {
        latest.handleQueryChange(query);
      });
      flushSearchDebounce();

      const expectedSkills = librarySearchEngine.searchLibrary(query, buckets.skills, { surface: 'shelf', limit: 30 }).results;
      const expectedSpaces = librarySearchEngine.searchLibrary(query, buckets.spaces, { surface: 'shelf', limit: 30 }).results;
      const expectedRegularFiles = librarySearchEngine.searchLibrary(query, buckets.regularFiles, { surface: 'shelf', limit: 30 }).results;
      const expectedCombined = dedupeByPath([
        ...expectedSkills,
        ...expectedSpaces,
        ...expectedRegularFiles,
      ]);

      expect(latest.sections.skills.map((result) => result.node.path))
        .toEqual(expectedSkills.map((result) => result.node.path));
      expect(latest.sections.spaces.map((result) => result.node.path))
        .toEqual(expectedSpaces.map((result) => result.node.path));
      expect(latest.sections.files.map((result) => result.node.path))
        .toEqual(expectedRegularFiles.map((result) => result.node.path));
      expect(latest.results.map((result) => result.node.path))
        .toEqual(expectedCombined.map((result) => result.node.path));
    }
  });

  it('keeps empty-query behavior unchanged (no active results/truncation state)', () => {
    const files = [
      makeEntry(makeFileNode('chat-file.md', '/workspace/docs/chat-file.md'), 'docs/chat-file.md'),
      makeEntry(makeFileNode('notes.md', '/workspace/docs/notes.md'), 'docs/notes.md'),
    ];

    mountHook({ files });

    act(() => {
      latest.handleQueryChange('chat');
    });
    flushSearchDebounce();
    expect(latest.results.length).toBeGreaterThan(0);

    act(() => {
      latest.handleQueryChange('');
    });
    flushSearchDebounce();

    expect(latest.query).toBe('');
    expect(latest.results).toEqual([]);
    expect(latest.sections).toEqual({ skills: [], spaces: [], files: [] });
    expect(latest.truncated).toBe(false);
  });

  it('memoizes section filters so repeated typing does not rebuild Fuse per keystroke', () => {
    const searchLibrarySpy = vi.spyOn(librarySearchEngine, 'searchLibrary');
    const files = [
      makeEntry(
        makeDirectoryNode('chat-skill', '/workspace/skills/chat-skill', [
          makeFileNode('SKILL.md', '/workspace/skills/chat-skill/SKILL.md'),
        ]),
        'skills/chat-skill',
      ),
      makeEntry(makeFileNode('chat-file.md', '/workspace/docs/chat-file.md'), 'docs/chat-file.md'),
      makeEntry(makeDirectoryNode('chat-space', '/workspace/work/team/alpha/chat-space'), 'work/team/alpha/chat-space'),
    ];

    mountHook({ files });

    for (const query of ['c', 'ch', 'cha', 'chat']) {
      act(() => {
        latest.handleQueryChange(query);
      });
      flushSearchDebounce();
    }

    const calls = searchLibrarySpy.mock.calls;
    expect(calls.length).toBe(12);

    const skillSectionEntries = [calls[0], calls[3], calls[6], calls[9]].map((call) => call[1] as FlatFileEntry[]);
    const spaceSectionEntries = [calls[1], calls[4], calls[7], calls[10]].map((call) => call[1] as FlatFileEntry[]);
    const fileSectionEntries = [calls[2], calls[5], calls[8], calls[11]].map((call) => call[1] as FlatFileEntry[]);

    expect(skillSectionEntries.every((entries) => entries === skillSectionEntries[0])).toBe(true);
    expect(spaceSectionEntries.every((entries) => entries === spaceSectionEntries[0])).toBe(true);
    expect(fileSectionEntries.every((entries) => entries === fileSectionEntries[0])).toBe(true);

    searchLibrarySpy.mockRestore();
  });

  it('constructs Fuse exactly 3 times for c → ch → cha → chat with stable shelf sections', () => {
    const createFuseSpy = vi.spyOn(librarySearchModule, 'createLibrarySearchFuse');
    const files: FlatFileEntry[] = [
      makeEntry(
        makeDirectoryNode('chat-skill', '/workspace/skills/chat-skill', [
          makeFileNode('SKILL.md', '/workspace/skills/chat-skill/SKILL.md'),
        ]),
        'skills/chat-skill',
      ),
      makeEntry(
        makeDirectoryNode('chat-space', '/workspace/spaces/chat-space'),
        'spaces/chat-space',
      ),
      makeEntry(
        makeFileNode('chat-file.md', '/workspace/docs/chat-file.md'),
        'docs/chat-file.md',
      ),
    ];
    mountHook({ files });

    for (const query of ['c', 'ch', 'cha', 'chat']) {
      act(() => {
        latest.handleQueryChange(query);
      });
      flushSearchDebounce();
    }

    expect(createFuseSpy).toHaveBeenCalledTimes(3);
    const uniqueEntryReferences = new Set(
      createFuseSpy.mock.calls.map((call) => call[0] as ReadonlyArray<FlatFileEntry>),
    );
    expect(uniqueEntryReferences.size).toBe(3);
    createFuseSpy.mockRestore();
  });

  it('keeps healthy section results when one section search throws', () => {
    const files: FlatFileEntry[] = [
      makeEntry(
        makeDirectoryNode('chat-skill', '/workspace/skills/chat-skill', [
          makeFileNode('SKILL.md', '/workspace/skills/chat-skill/SKILL.md'),
        ]),
        'skills/chat-skill',
      ),
      makeEntry(
        makeDirectoryNode('chat-space', '/workspace/spaces/chat-space'),
        'spaces/chat-space',
      ),
      makeEntry(
        makeFileNode('chat-file.md', '/workspace/docs/chat-file.md'),
        'docs/chat-file.md',
      ),
    ];
    const realSearchLibrary = librarySearchEngine.searchLibrary;
    const searchLibrarySpy = vi.spyOn(librarySearchEngine, 'searchLibrary').mockImplementation(
      (query, entries, options) => {
        if (entries.some((entry) => isSkillEntry(entry))) {
          throw new Error('skills section unavailable');
        }
        return realSearchLibrary(query, entries, options);
      },
    );
    mountHook({ files });

    act(() => {
      latest.handleQueryChange('chat');
    });
    flushSearchDebounce();

    expect(latest.sections.skills).toEqual([]);
    expect(latest.sections.spaces.map((result) => result.node.path)).toEqual([
      '/workspace/spaces/chat-space',
    ]);
    expect(latest.sections.files.map((result) => result.node.path)).toEqual([
      '/workspace/docs/chat-file.md',
    ]);
    expect(latest.results.map((result) => result.node.path)).toEqual([
      '/workspace/spaces/chat-space',
      '/workspace/docs/chat-file.md',
    ]);
    expect(latest.truncated).toBe(false);
    expect(emitLog).toHaveBeenCalledWith(expect.objectContaining({
      level: 'error',
      message: 'Library search section failed',
      context: expect.objectContaining({ section: 'skills' }),
    }));

    searchLibrarySpy.mockRestore();
  });

  it('renders shelf truncation hint for empty-result capped searches', () => {
    const largeFiles = Array.from({ length: 100_001 }, (_value, index) => {
      const suffix = index.toString().padStart(6, '0');
      return makeEntry(
        makeFileNode(`alpha-file-${suffix}.md`, `/workspace/docs/alpha-file-${suffix}.md`),
        `docs/alpha-file-${suffix}.md`,
      );
    });
    mountHook({ files: largeFiles });

    act(() => {
      latest.handleQueryChange('zzzz-no-match');
    });
    flushSearchDebounce();

    expect(latest.truncated).toBe(true);
    expect(latest.results).toEqual([]);

    const viewContainer = document.createElement('div');
    document.body.appendChild(viewContainer);
    const viewRoot = createRoot(viewContainer);
    act(() => {
      viewRoot.render(
        <LibrarySearchResults
          results={latest.results}
          truncated={latest.truncated}
          selectedIndex={0}
          editorPath={null}
          workspaceRoot="/workspace"
          query={latest.query}
          onSelectResult={vi.fn()}
          onHoverResult={vi.fn()}
        />,
      );
    });

    expect(document.querySelector('[data-testid="library-search-truncation-hint"]')?.textContent)
      .toBe(TRUNCATION_HINT_COPY);

    act(() => {
      viewRoot.unmount();
    });
    viewContainer.remove();
  });

  it('does not render the shelf footer hint when truncated is false', () => {
    const files = [
      makeEntry(makeFileNode('chat-file.md', '/workspace/docs/chat-file.md'), 'docs/chat-file.md'),
      makeEntry(makeFileNode('chat-notes.md', '/workspace/docs/chat-notes.md'), 'docs/chat-notes.md'),
    ];
    mountHook({ files });

    act(() => {
      latest.handleQueryChange('chat');
    });
    flushSearchDebounce();

    expect(latest.truncated).toBe(false);

    const viewContainer = document.createElement('div');
    document.body.appendChild(viewContainer);
    const viewRoot = createRoot(viewContainer);
    act(() => {
      viewRoot.render(
        <LibrarySearchResults
          results={latest.results}
          truncated={latest.truncated}
          selectedIndex={0}
          editorPath={null}
          workspaceRoot="/workspace"
          query={latest.query}
          onSelectResult={vi.fn()}
          onHoverResult={vi.fn()}
        />,
      );
    });

    expect(document.querySelector('[data-testid="library-search-truncation-hint"]')).toBeNull();

    act(() => {
      viewRoot.unmount();
    });
    viewContainer.remove();
  });
});
