// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileNode } from '@shared/types';
import type { LibraryTreeViewProps } from '../LibraryTreeView';
import { LibraryNavigator } from '../LibraryNavigator';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigatorState = vi.hoisted(() => ({
  value: undefined as unknown,
}));

let latestTreeViewProps: LibraryTreeViewProps | null = null;

function flattenVisibleNodes(
  nodes: FileNode[] | null | undefined,
  expandedDirectories: Record<string, boolean>,
): FileNode[] {
  const visible: FileNode[] = [];
  const walk = (nodeList: FileNode[] | undefined) => {
    if (!nodeList) return;
    for (const node of nodeList) {
      visible.push(node);
      if (node.kind === 'directory' && expandedDirectories[node.path]) {
        walk(node.children);
      }
    }
  };
  walk(nodes ?? undefined);
  return visible;
}

vi.mock('../LibraryCommandShelf', () => ({
  LibraryCommandShelf: () => <div data-testid="command-shelf" />,
}));

vi.mock('../LibraryRecentDrawer', () => ({
  LibraryRecentDrawer: () => <div data-testid="recent-drawer" />,
}));

vi.mock('../ProfileEditor', () => ({
  ProfileEditor: () => <div data-testid="profile-editor" />,
}));

vi.mock('../PendingMemorySection', () => ({
  PendingMemorySection: () => <div data-testid="pending-memory-section" />,
}));

vi.mock('../views/LibraryViewDispatcher', () => ({
  LibraryViewDispatcher: () => <div data-testid="library-view-dispatcher" />,
}));

vi.mock('../LibraryTreeView', () => ({
  LibraryTreeView: (props: LibraryTreeViewProps & { density?: 'default' | 'compact' }) => {
    const visibleNodes = flattenVisibleNodes(props.nodes, props.expandedDirectories);
    return (
      <div data-testid="library-tree-view" data-density={props.density ?? 'default'}>
        <div data-testid="library-tree" tabIndex={0}>
          {visibleNodes.map((node) => (
            <div key={node.path} data-testid="visible-node" data-path={node.path}>
              {node.name}
            </div>
          ))}
        </div>
      </div>
    );
  },
}));

vi.mock('../../providers/LibraryNavigatorProvider', () => ({
  useLibraryNavigator: () => navigatorState.value,
}));

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

const WORKSPACE_TREE: FileNode[] = [
  {
    name: 'docs',
    path: '/workspace/docs',
    kind: 'directory',
    children: [
      {
        name: 'guides',
        path: '/workspace/docs/guides',
        kind: 'directory',
        children: [
          { name: 'AGENTS.md', path: '/workspace/docs/guides/AGENTS.md', kind: 'file' },
        ],
      },
      { name: 'readme.md', path: '/workspace/docs/readme.md', kind: 'file' },
    ],
  },
  {
    name: 'projects',
    path: '/workspace/projects',
    kind: 'directory',
    children: [
      { name: 'plan.md', path: '/workspace/projects/plan.md', kind: 'file' },
    ],
  },
  { name: 'notes.md', path: '/workspace/notes.md', kind: 'file' },
];

function makeTreeViewProps(): LibraryTreeViewProps {
  return {
    nodes: WORKSPACE_TREE,
    expandedDirectories: { '/workspace/projects': true },
    selectedPath: null,
    activePath: null,
    focusedPath: null,
    renamingPath: null,
    draggingNodePath: null,
    dropTarget: null,
    libraryRootAbsolute: '/workspace',
    onSelectNode: vi.fn(),
    onSelectFile: vi.fn(),
    onFocusNode: vi.fn(),
    onToggleExpand: vi.fn(),
    onExpandDirectories: vi.fn(),
    onContextMenu: vi.fn(),
    onConfirmRename: vi.fn().mockResolvedValue(undefined),
    onCancelRename: vi.fn(),
    onDragStart: vi.fn(),
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
    onDragEnd: vi.fn(),
    isFileFavorite: vi.fn(() => false),
    onToggleFileFavorite: vi.fn(),
  };
}

function setNavigatorState(overrides: {
  activePath?: string;
  tree?: FileNode[];
  libraryStats?: { totalFiles: number; totalDirs: number; truncated: boolean } | null;
  isPartialTree?: boolean;
} = {}): void {
  const tree = overrides.tree ?? WORKSPACE_TREE;
  const treeViewProps = makeTreeViewProps();
  treeViewProps.nodes = tree;
  if (overrides.activePath) {
    treeViewProps.activePath = overrides.activePath;
  }
  latestTreeViewProps = treeViewProps;

  navigatorState.value = {
    isOpen: true,
    workspaceDrawerClassName: 'drawer',
    commandShelfProps: {
      lens: { filter: 'spaces', view: 'folders' },
      onRefresh: vi.fn(),
      onCreateFile: vi.fn(),
      onCreateFolder: vi.fn(),
      onCreateSkill: vi.fn(),
    },
    bodyState: {
      libraryLoading: false,
      libraryError: null,
      librarySearchQuery: '',
      libraryTree: tree,
      libraryStats: overrides.libraryStats ?? null,
      treePartialState: {
        isPartialTree: overrides.isPartialTree ?? false,
        reasons: [],
        unavailableNodes: 0,
      },
      libraryTreeEmptyMessage: 'No files or folders found',
      skillsData: null,
      skillsLoading: false,
      skillsError: null,
      memoryEntries: [],
      memoryLoading: false,
      memoryError: null,
      pendingMemoryRequests: [],
      savePendingMemoryRequest: vi.fn().mockResolvedValue(undefined),
      skipPendingMemoryRequest: vi.fn().mockResolvedValue(undefined),
      saveAllPendingMemoryRequests: vi.fn().mockResolvedValue(undefined),
      skipAllPendingMemoryRequests: vi.fn().mockResolvedValue(undefined),
      spacesData: [],
      spacesLoading: false,
      spacesError: false,
      spacesErrorMessage: null,
      revealInClassifiedView: undefined,
      setActiveSpace: undefined,
      renameSpace: undefined,
      deleteSpace: undefined,
      searchResultsProps: { results: [] },
      treeViewProps,
      fileSortOrder: 'name',
      libraryRootAbsolute: '/workspace',
      chiefOfStaff: {
        filePath: null,
        overviewOpen: false,
        openOverview: vi.fn(),
        closeOverview: vi.fn(),
        openFolder: vi.fn(),
        askInChat: vi.fn(),
      },
    },
    recentDrawerProps: {},
    onUseSkill: undefined,
    onOpenSession: vi.fn(),
    onStartConversation: undefined,
    favoriteFilePaths: [],
    loadWorkspaceFile: vi.fn().mockResolvedValue(undefined),
    emitLog: vi.fn(),
  };
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(ui);
  });

  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function getVisibleNodeNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-testid="visible-node"]'))
    .map((element) => element.textContent ?? '');
}

function setSearchInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  if (!valueSetter) {
    throw new Error('Could not find native input value setter');
  }

  act(() => {
    valueSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function flushSearchDebounce(): void {
  act(() => {
    vi.advanceTimersByTime(130);
  });
}

describe('Library focus-mode rail search', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    setNavigatorState();
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('filters to matching files and ancestors, then restores original expansion state on clear', () => {
    mounted = mount(<LibraryNavigator kioskLevel="wide" />);

    const input = mounted.container.querySelector('[data-testid="library-kiosk-rail-search-input"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Rail search input was not rendered');
    }

    setSearchInputValue(input, 'agen');
    flushSearchDebounce();

    const countLabel = mounted.container.querySelector('[data-testid="library-kiosk-rail-search-count"]');
    expect(countLabel?.textContent).toBe('1 file');

    const resultRows = mounted.container.querySelectorAll('[data-testid="library-kiosk-rail-search-result-row"]');
    expect(resultRows).toHaveLength(1);
    expect(resultRows[0].textContent).toContain('AGENTS.md');
    expect(resultRows[0].textContent).toContain('docs/guides');
    expect(mounted.container.querySelector('[data-testid="library-tree-view"]')).toBeNull();

    const clearButton = mounted.container.querySelector('[data-testid="library-kiosk-rail-search-clear"]');
    if (!(clearButton instanceof HTMLButtonElement)) {
      throw new Error('Rail search clear button was not rendered');
    }
    act(() => {
      clearButton.click();
    });

    expect(mounted.container.querySelector('[data-testid="library-kiosk-rail-search-results"]')).toBeNull();
    expect(getVisibleNodeNames(mounted.container)).toEqual(['docs', 'projects', 'plan.md', 'notes.md']);
  });

  it('clears search with Escape and refocuses the tree', () => {
    mounted = mount(<LibraryNavigator kioskLevel="wide" />);

    const input = mounted.container.querySelector('[data-testid="library-kiosk-rail-search-input"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Rail search input was not rendered');
    }
    setSearchInputValue(input, 'agen');
    flushSearchDebounce();
    expect(
      mounted.container.querySelectorAll('[data-testid="library-kiosk-rail-search-result-row"]'),
    ).toHaveLength(1);

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(input.value).toBe('');
    const tree = mounted.container.querySelector('[data-testid="library-tree"]');
    expect(document.activeElement).toBe(tree);
    expect(getVisibleNodeNames(mounted.container)).toEqual(['docs', 'projects', 'plan.md', 'notes.md']);
  });

  it('focuses the search input when "/" is pressed from inside the rail', () => {
    mounted = mount(<LibraryNavigator kioskLevel="wide" />);

    const input = mounted.container.querySelector('[data-testid="library-kiosk-rail-search-input"]');
    const tree = mounted.container.querySelector('[data-testid="library-tree"]');
    if (!(input instanceof HTMLInputElement) || !(tree instanceof HTMLDivElement)) {
      throw new Error('Expected kiosk rail search input and tree');
    }

    act(() => {
      tree.focus();
    });
    expect(document.activeElement).toBe(tree);

    act(() => {
      tree.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    });
    expect(document.activeElement).toBe(input);
  });

  it('shows an empty-state message when no files match the query', () => {
    mounted = mount(<LibraryNavigator kioskLevel="wide" />);

    const input = mounted.container.querySelector('[data-testid="library-kiosk-rail-search-input"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Rail search input was not rendered');
    }

    setSearchInputValue(input, 'zzzz');
    flushSearchDebounce();

    const emptyState = mounted.container.querySelector('[data-testid="library-kiosk-rail-empty-state"]');
    expect(emptyState?.textContent).toBe('No files match "zzzz".');
    expect(
      mounted.container.querySelectorAll('[data-testid="library-kiosk-rail-search-result-row"]'),
    ).toHaveLength(0);
  });

  it('highlights and opens the active file from flat rail search results', () => {
    setNavigatorState({ activePath: '/workspace/docs/guides/AGENTS.md' });
    mounted = mount(<LibraryNavigator kioskLevel="wide" />);

    const input = mounted.container.querySelector('[data-testid="library-kiosk-rail-search-input"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Rail search input was not rendered');
    }

    setSearchInputValue(input, 'agen');
    flushSearchDebounce();

    const row = mounted.container.querySelector('[data-testid="library-kiosk-rail-search-result-row"]');
    if (!(row instanceof HTMLButtonElement)) {
      throw new Error('Expected a rail search result row');
    }

    expect(row.getAttribute('data-active')).toBe('true');

    act(() => {
      row.click();
    });

    expect(latestTreeViewProps?.onSelectNode).toHaveBeenCalledTimes(1);
    expect(latestTreeViewProps?.onSelectNode).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/workspace/docs/guides/AGENTS.md',
        kind: 'file',
      }),
    );
  });
});
