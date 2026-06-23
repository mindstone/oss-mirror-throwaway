// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileNode } from '@shared/types';
import type { FlatFileEntry } from '@renderer/utils/librarySearch';
import { isMemoryPath, isSkillEntry } from '@renderer/utils/skillUtils';
import { QuickOpenDialog } from '../QuickOpenDialog';
import { INCOMPLETE_LIBRARY_COPY } from '../IncompleteLibraryHint';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const searchLibraryMock = vi.fn();
const getRecentFilesMock = vi.fn((): string[] => []);
const addRecentFileMock = vi.fn((_filePath: string): void => {});
const TRUNCATION_HINT_COPY = 'Searched first 100,000 files. Some matches may be missing.';

vi.mock('@renderer/features/library/search/engine', () => ({
  searchLibrary: (...args: unknown[]) => searchLibraryMock(...args),
}));

vi.mock('@renderer/utils/librarySearch', async () => {
  const actual = await vi.importActual<typeof import('@renderer/utils/librarySearch')>('@renderer/utils/librarySearch');
  return {
    ...actual,
    getRecentFiles: () => getRecentFilesMock(),
    addRecentFile: (filePath: string) => addRecentFileMock(filePath),
  };
});

const makeFileNode = (name: string, path: string, kind: FileNode['kind'] = 'file'): FileNode => ({
  name,
  path,
  kind,
});

const makeEntry = (
  node: FileNode,
  fullPath: string,
  skillMeta?: FlatFileEntry['skillMeta'],
): FlatFileEntry => ({
  node,
  fullPath,
  ...(skillMeta ? { skillMeta } : {}),
});

const createSearchOutcome = (results: Array<{
  node: FileNode;
  fullPath: string;
  skillMeta?: FlatFileEntry['skillMeta'];
  score?: number;
  matches?: Array<[number, number]>;
}>, truncated = false) => ({
  results: results.map((result) => ({
    node: result.node,
    fullPath: result.fullPath,
    skillMeta: result.skillMeta,
    score: result.score ?? 0,
    matches: result.matches ?? [],
  })),
  truncated,
  truncationReason: truncated ? ('engine-cap' as const) : null,
  entriesIndexed: truncated ? 100_000 : results.length,
});

const setInputValue = (value: string) => {
  const input = document.querySelector('input[placeholder="Search files by name..."]') as HTMLInputElement | null;
  if (!input) {
    throw new Error('Expected quick open search input');
  }
  act(() => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  return input;
};

const click = (element: Element | null) => {
  if (!element) {
    throw new Error('Expected element to exist');
  }
  act(() => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

const getButtonByText = (text: string): HTMLButtonElement => {
  const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.trim() === text,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button "${text}"`);
  }
  return button;
};

describe('QuickOpenDialog', () => {
  let root: Root;
  let container: HTMLDivElement;
  const onOpenChange = vi.fn();
  const onSelectFile = vi.fn();

  const mountDialog = (files: FlatFileEntry[], open = true) => {
    act(() => {
      root.render(
        <QuickOpenDialog
          open={open}
          onOpenChange={onOpenChange}
          files={files}
          onSelectFile={onSelectFile}
        />,
      );
    });
    act(() => {
      vi.runOnlyPendingTimers();
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    searchLibraryMock.mockReset();
    getRecentFilesMock.mockReset();
    addRecentFileMock.mockReset();
    onOpenChange.mockReset();
    onSelectFile.mockReset();
    getRecentFilesMock.mockReturnValue([]);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('renders engine search result matches for highlighting', () => {
    const node = makeFileNode('chatgpt.png', '/workspace/assets/chatgpt.png');
    const files = [makeEntry(node, 'assets/chatgpt.png')];

    searchLibraryMock.mockReturnValue(
      createSearchOutcome([
        {
          node,
          fullPath: 'assets/chatgpt.png',
          matches: [[0, 4]],
        },
      ]),
    );

    mountDialog(files);
    setInputValue('chat');

    const mark = document.querySelector('mark');
    expect(mark?.textContent).toBe('chat');
    expect(document.body.textContent).toContain('assets/chatgpt.png');
  });

  it('shows recents above the full list when query is empty', () => {
    const recentNode = makeFileNode('recent.md', '/workspace/recent.md');
    const otherNode = makeFileNode('other.md', '/workspace/other.md');
    const files = [
      makeEntry(recentNode, 'recent.md'),
      makeEntry(otherNode, 'other.md'),
    ];

    getRecentFilesMock.mockReturnValue([recentNode.path]);
    mountDialog(files);

    expect(document.body.textContent).toContain('Recent');
    expect(document.body.textContent).toContain('All files');
  });

  it('adds recents with absolute node.path on Enter', () => {
    const node = makeFileNode('chat-file.md', '/workspace/docs/chat-file.md');
    const files = [makeEntry(node, 'docs/chat-file.md')];

    searchLibraryMock.mockReturnValue(
      createSearchOutcome([
        { node, fullPath: 'docs/chat-file.md', matches: [[0, 4]] },
      ]),
    );

    mountDialog(files);
    const input = setInputValue('chat');

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(addRecentFileMock).toHaveBeenCalledWith('/workspace/docs/chat-file.md');
    expect(onSelectFile).toHaveBeenCalledWith(node);
  });

  it('applies filter tabs before calling the engine search', () => {
    const skillEntry = makeEntry(
      makeFileNode('skill.md', '/workspace/skills/skill.md'),
      'skills/skill.md',
      { name: 'skill' },
    );
    const memoryEntry = makeEntry(
      makeFileNode('memory.md', '/workspace/memory/memory.md'),
      'memory/memory.md',
    );
    const spacesEntry = makeEntry(
      makeFileNode('space.md', '/workspace/docs/space.md'),
      'docs/space.md',
    );
    const files = [skillEntry, memoryEntry, spacesEntry];

    searchLibraryMock.mockReturnValue(createSearchOutcome([]));
    mountDialog(files);

    setInputValue('m');

    const getLatestSearchEntries = (): FlatFileEntry[] => {
      const latestCall = searchLibraryMock.mock.calls[searchLibraryMock.mock.calls.length - 1];
      if (!latestCall) {
        throw new Error('Expected searchLibrary to be called');
      }
      return latestCall[1] as FlatFileEntry[];
    };

    // Everything
    expect(getLatestSearchEntries().map((entry) => entry.node.path)).toEqual([
      skillEntry.node.path,
      memoryEntry.node.path,
      spacesEntry.node.path,
    ]);

    click(getButtonByText('Skills'));
    const skillsEntries = getLatestSearchEntries();
    expect(skillsEntries.length).toBeGreaterThan(0);
    expect(skillsEntries.every((entry) => isSkillEntry(entry))).toBe(true);

    click(getButtonByText('Memory'));
    const memoryEntries = getLatestSearchEntries();
    expect(memoryEntries.length).toBeGreaterThan(0);
    expect(memoryEntries.every((entry) => isMemoryPath(entry.fullPath))).toBe(true);

    click(getButtonByText('Spaces'));
    const spacesEntries = getLatestSearchEntries();
    expect(spacesEntries.length).toBeGreaterThan(0);
    expect(spacesEntries.every((entry) => !isSkillEntry(entry) && !isMemoryPath(entry.fullPath))).toBe(true);
  });

  it('renders truncation footer hint when search outcome is truncated', () => {
    const node = makeFileNode('chat.md', '/workspace/chat.md');
    const files = [makeEntry(node, 'chat.md')];

    searchLibraryMock.mockReturnValue(
      createSearchOutcome([{ node, fullPath: 'chat.md' }], true),
    );
    mountDialog(files);
    setInputValue('chat');

    expect(document.querySelector('[data-testid="quick-open-truncation-hint"]')?.textContent)
      .toBe(TRUNCATION_HINT_COPY);
  });

  it('renders truncation footer hint when capped search has zero visible results', () => {
    const node = makeFileNode('alpha.md', '/workspace/alpha.md');
    const files = [makeEntry(node, 'alpha.md')];

    searchLibraryMock.mockReturnValue(createSearchOutcome([], true));
    mountDialog(files);
    setInputValue('chat');

    expect(document.body.textContent).toContain('No matching files');
    expect(document.querySelector('[data-testid="quick-open-truncation-hint"]')?.textContent)
      .toBe(TRUNCATION_HINT_COPY);
  });

  it('shows the incomplete-Library hint on an empty result when isPartialTree is true', () => {
    const node = makeFileNode('alpha.md', '/workspace/alpha.md');
    const files = [makeEntry(node, 'alpha.md')];

    // Engine itself is NOT truncated — the incompleteness is the partial TREE,
    // not the search cap. The hint must still appear so a zero-result search
    // isn't mistaken for "this file definitely doesn't exist".
    searchLibraryMock.mockReturnValue(createSearchOutcome([], false));
    act(() => {
      root.render(
        <QuickOpenDialog
          open
          onOpenChange={onOpenChange}
          files={files}
          onSelectFile={onSelectFile}
          isPartialTree
        />,
      );
    });
    act(() => {
      vi.runOnlyPendingTimers();
    });
    setInputValue('chat');

    const hint = document.querySelector('[data-testid="quick-open-incomplete-hint"]');
    expect(hint?.textContent).toBe(INCOMPLETE_LIBRARY_COPY);
    // Engine-cap hint must NOT appear — engine wasn't truncated.
    expect(document.querySelector('[data-testid="quick-open-truncation-hint"]')).toBeNull();
  });

  it('does not render the incomplete-Library hint when isPartialTree is false', () => {
    const node = makeFileNode('alpha.md', '/workspace/alpha.md');
    const files = [makeEntry(node, 'alpha.md')];

    searchLibraryMock.mockReturnValue(createSearchOutcome([], false));
    mountDialog(files);
    setInputValue('chat');

    expect(document.querySelector('[data-testid="quick-open-incomplete-hint"]')).toBeNull();
  });

  it('does not render truncation footer hint when search outcome is not truncated', () => {
    const node = makeFileNode('chat.md', '/workspace/chat.md');
    const files = [makeEntry(node, 'chat.md')];

    searchLibraryMock.mockReturnValue(
      createSearchOutcome([{ node, fullPath: 'chat.md' }], false),
    );
    mountDialog(files);
    setInputValue('chat');

    expect(document.querySelector('[data-testid="quick-open-truncation-hint"]')).toBeNull();
  });
});
