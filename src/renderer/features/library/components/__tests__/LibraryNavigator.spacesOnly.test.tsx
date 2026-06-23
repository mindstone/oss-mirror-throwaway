// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileNode } from '@shared/types';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import type { LibraryTreeViewProps } from '../LibraryTreeView';
import { LibraryNavigator } from '../LibraryNavigator';
import type { LibrarySearchOutcome } from '../../search/engine';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigatorState = vi.hoisted(() => ({
  value: undefined as unknown,
}));

const treeViewState = vi.hoisted(() => ({
  latestProps: null as LibraryTreeViewProps | null,
}));

const TRUNCATION_HINT_COPY = 'Searched first 100,000 files. Some matches may be missing.';

vi.mock('../LibraryCommandShelf', () => ({
  LibraryCommandShelf: () => <div data-testid="command-shelf" />,
}));

vi.mock('../LibraryRecentDrawer', () => ({
  LibraryRecentDrawer: () => <div data-testid="recent-drawer" />,
}));

vi.mock('../ProfileEditor', () => ({
  ProfileEditor: () => <div data-testid="profile-editor" />,
}));

vi.mock('../LibraryTreeView', () => ({
  LibraryTreeView: (props: LibraryTreeViewProps & { density?: 'default' | 'compact' }) => {
    treeViewState.latestProps = props;
    return (
      <div data-testid="library-tree-view" data-density={props.density ?? 'default'}>
        {String(props.nodes?.length ?? 0)}
        <div data-testid="library-tree" tabIndex={0}>
          {props.activePath ? <div data-testid="library-tree-active-row" data-path={props.activePath} /> : null}
        </div>
      </div>
    );
  },
}));

vi.mock('../PendingMemorySection', () => ({
  PendingMemorySection: ({ requests }: { requests: Array<{ toolUseId: string }> }) => (
    <div data-testid="pending-memory-section">{String(requests.length)}</div>
  ),
}));

vi.mock('../views/LibraryViewDispatcher', () => ({
  LibraryViewDispatcher: ({
    view,
    foldersProps,
    cardsProps,
  }: {
    view: string;
    foldersProps: { filter: string; spacesData?: SpaceInfo[]; spacesError?: boolean; tree?: FileNode[] | null };
    cardsProps?: { onUseSkillPath?: (relativePath: string) => void };
  }) => (
    <div data-testid="library-view-dispatcher">
      <span data-testid="dispatcher-lens">{`${foldersProps.filter}:${view}`}</span>
      <span data-testid="dispatcher-spaces-count">{String(foldersProps.spacesData?.length ?? 0)}</span>
      <span data-testid="dispatcher-spaces-error">{String(Boolean(foldersProps.spacesError))}</span>
      <span data-testid="dispatcher-node-count">{String(foldersProps.tree?.length ?? 0)}</span>
      <button
        type="button"
        data-testid="dispatcher-use-skill"
        onClick={() => cardsProps?.onUseSkillPath?.('Chief-of-Staff/skills/meeting-prep/SKILL.md')}
      >
        Use skill
      </button>
    </div>
  ),
}));

vi.mock('../../providers/LibraryNavigatorProvider', () => ({
  useLibraryNavigator: () => navigatorState.value,
}));

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

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

function makeTreeViewProps(
  nodes: FileNode[] = [],
  overrides: Partial<LibraryTreeViewProps> = {},
): LibraryTreeViewProps {
  return {
    nodes,
    expandedDirectories: {},
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
    onExpandDirectories: vi.fn(),
    ...overrides,
  };
}

function makeSpace(name: string): SpaceInfo {
  return {
    name,
    path: name,
    absolutePath: `/workspace/${name}`,
    type: 'project',
    isSymlink: true,
    sourcePath: `/Users/example/Google Drive/${name}`,
    hasReadme: true,
    description: `${name} notes`,
    status: 'ok',
  };
}

function setNavigatorState(overrides: {
  libraryTree?: FileNode[];
  spacesData?: SpaceInfo[];
  spacesError?: boolean;
  libraryRootAbsolute?: string;
  lens?: { filter: 'spaces' | 'skills' | 'memory' | 'everything'; view: 'folders' | 'cards' | 'atlas' };
  pendingMemoryRequests?: Array<{
    toolUseId: string;
    originalSessionId: string;
    filePath: string;
    spaceName: string;
    summary: string;
    content: string;
    timestamp: number;
  }>;
  onUseSkill?: (skillRelativePath: string) => void;
  activePath?: string | null;
  expandedDirectories?: Record<string, boolean>;
  onToggleExpand?: LibraryTreeViewProps['onToggleExpand'];
  onExpandDirectories?: LibraryTreeViewProps['onExpandDirectories'];
  librarySearchQuery?: string;
  workspaceSearchTruncated?: boolean;
  libraryStats?: { totalFiles: number; totalDirs: number; truncated: boolean } | null | 'pending' | 'failed';
  librarySearchOutcome?: LibrarySearchOutcome | null;
  isPartialTree?: boolean;
}) {
  const libraryTree = overrides.libraryTree ?? [];
  const libraryRootAbsolute = overrides.libraryRootAbsolute ?? '/workspace';
  const treeViewProps = makeTreeViewProps(libraryTree, {
    activePath: overrides.activePath ?? null,
    expandedDirectories: overrides.expandedDirectories ?? {},
    onToggleExpand: overrides.onToggleExpand ?? vi.fn(),
    onExpandDirectories: overrides.onExpandDirectories ?? vi.fn(),
  });
  navigatorState.value = {
    isOpen: true,
    workspaceDrawerClassName: 'drawer',
    commandShelfProps: {
      lens: overrides.lens ?? { filter: 'spaces', view: 'folders' },
      onRefresh: vi.fn(),
      onCreateFile: vi.fn(),
      onCreateFolder: vi.fn(),
    },
    bodyState: {
      libraryLoading: false,
      libraryError: null,
      librarySearchQuery: overrides.librarySearchQuery ?? '',
      librarySearchOutcome: overrides.librarySearchOutcome ?? null,
      libraryStats: overrides.libraryStats ?? null,
      treePartialState: {
        isPartialTree: overrides.isPartialTree ?? false,
        reasons: [],
        unavailableNodes: 0,
      },
      libraryTree,
      libraryTreeEmptyMessage: 'No files or folders found',
      skillsLoading: false,
      skillsError: null,
      pendingMemoryRequests: overrides.pendingMemoryRequests ?? [],
      pendingMemoryLoading: false,
      savePendingMemoryRequest: vi.fn().mockResolvedValue(undefined),
      skipPendingMemoryRequest: vi.fn().mockResolvedValue(undefined),
      saveAllPendingMemoryRequests: vi.fn().mockResolvedValue(undefined),
      skipAllPendingMemoryRequests: vi.fn().mockResolvedValue(undefined),
      spacesData: overrides.spacesData ?? [],
      spacesError: overrides.spacesError ?? false,
      spacesErrorMessage: null,
      searchResultsProps: {
        results: [],
        truncated: overrides.workspaceSearchTruncated ?? false,
      },
      treeViewProps,
      fileSortOrder: 'name',
      libraryRootAbsolute,
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
    onUseSkill: overrides.onUseSkill,
    onOpenSession: vi.fn(),
    onStartConversation: undefined,
    favoriteFilePaths: [],
    loadWorkspaceFile: vi.fn().mockResolvedValue(undefined),
    emitLog: vi.fn(),
  };
}

describe('LibraryNavigator Spaces-only rendering gate', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders Spaces groups when tree is empty but Spaces data exists', () => {
    setNavigatorState({
      libraryTree: [],
      spacesData: [makeSpace('Alpha'), makeSpace('Beta')],
    });

    mounted = mount(<LibraryNavigator />);

    expect(mounted.container.querySelector('[data-testid="library-view-dispatcher"]')).toBeTruthy();
    expect(mounted.container.querySelector('[data-testid="dispatcher-lens"]')?.textContent).toBe('spaces:folders');
    expect(mounted.container.querySelector('[data-testid="dispatcher-spaces-count"]')?.textContent).toBe('2');
    expect(mounted.container.querySelector('[data-testid="dispatcher-spaces-error"]')?.textContent).toBe('false');
    expect(mounted.container.querySelector('[data-testid="dispatcher-node-count"]')?.textContent).toBe('0');
  });

  it('keeps the generic empty Library state when both tree and Spaces are empty', () => {
    setNavigatorState({
      libraryTree: [],
      spacesData: [],
      spacesError: false,
      libraryRootAbsolute: '',
    });

    mounted = mount(<LibraryNavigator />);

    expect(mounted.container.textContent).toContain('Your Library is Empty');
    expect(mounted.container.textContent).not.toContain('Your Spaces');
  });

  it('threads onUseSkill through cards view dispatch', () => {
    const onUseSkill = vi.fn();
    setNavigatorState({
      libraryTree: [],
      spacesData: [makeSpace('Alpha')],
      lens: { filter: 'skills', view: 'cards' },
      onUseSkill,
    });

    mounted = mount(<LibraryNavigator />);

    const button = mounted.container.querySelector('[data-testid="dispatcher-use-skill"]');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Dispatcher use skill button not found');
    }

    act(() => {
      button.click();
    });

    expect(onUseSkill).toHaveBeenCalledWith('Chief-of-Staff/skills/meeting-prep/SKILL.md');
    expect(onUseSkill).toHaveBeenCalledTimes(1);
  });

  it('renders the shelf truncation hint in the production navigator path when search is capped', () => {
    setNavigatorState({
      libraryTree: [
        { name: 'alpha.md', path: '/workspace/alpha.md', kind: 'file' },
      ],
      spacesData: [makeSpace('Alpha')],
      librarySearchQuery: 'chat',
      workspaceSearchTruncated: true,
    });

    mounted = mount(<LibraryNavigator />);

    expect(
      mounted.container.querySelector('[data-testid="library-shelf-truncation-hint"]')?.textContent,
    ).toBe(TRUNCATION_HINT_COPY);
  });

  it('renders the main truncation notice when the file tree is a partial view', () => {
    // Re-pointed in Stage 3: the tree notice fires on buildFileTree completeness
    // (treePartialState), NOT on the separate stats walk's `truncated` flag.
    setNavigatorState({
      libraryTree: [
        { name: 'alpha.md', path: '/workspace/alpha.md', kind: 'file' },
      ],
      spacesData: [makeSpace('Alpha')],
      isPartialTree: true,
    });

    mounted = mount(<LibraryNavigator />);

    expect(
      mounted.container.querySelector('[data-testid="library-search-truncation-notice"]')?.textContent,
    ).toContain('Showing part of this very large Library. Some files may not appear here.');
  });

  it('does NOT render the tree notice from the stats walk alone (re-point regression guard)', () => {
    // Stats truncated but tree complete → no tree notice. Proves the old
    // libraryStats.truncated source is no longer what drives the tree signal.
    setNavigatorState({
      libraryTree: [
        { name: 'alpha.md', path: '/workspace/alpha.md', kind: 'file' },
      ],
      spacesData: [makeSpace('Alpha')],
      libraryStats: { totalFiles: 1_000_000, totalDirs: 8_000, truncated: true },
      isPartialTree: false,
    });

    mounted = mount(<LibraryNavigator />);

    expect(
      mounted.container.querySelector('[data-testid="library-main-truncation-notice"]'),
    ).toBeNull();
  });

  it.each(['folders', 'cards', 'atlas'] as const)(
    'renders PendingMemorySection for Memory × %s',
    (view) => {
      setNavigatorState({
        libraryTree: [],
        spacesData: [makeSpace('Alpha')],
        lens: { filter: 'memory', view },
        pendingMemoryRequests: [
          {
            toolUseId: 'tool-1',
            originalSessionId: 'session-123',
            filePath: '/workspace/Chief-of-Staff/memory/weekly-summary.md',
            spaceName: 'Chief-of-Staff',
            summary: 'Save weekly summary',
            content: '# weekly summary',
            timestamp: Date.now(),
          },
        ],
      });

      mounted = mount(<LibraryNavigator />);

      const pendingSection = mounted.container.querySelector('[data-testid="pending-memory-section"]');
      expect(pendingSection).toBeTruthy();
      expect(pendingSection?.textContent).toBe('1');
    },
  );

  it('does not render PendingMemorySection outside Memory filter', () => {
    setNavigatorState({
      libraryTree: [],
      spacesData: [makeSpace('Alpha')],
      lens: { filter: 'skills', view: 'cards' },
      pendingMemoryRequests: [
        {
          toolUseId: 'tool-1',
          originalSessionId: 'session-123',
          filePath: '/workspace/Chief-of-Staff/memory/weekly-summary.md',
          spaceName: 'Chief-of-Staff',
          summary: 'Save weekly summary',
          content: '# weekly summary',
          timestamp: Date.now(),
        },
      ],
    });

    mounted = mount(<LibraryNavigator />);

    expect(mounted.container.querySelector('[data-testid="pending-memory-section"]')).toBeNull();
  });

  it('does not render PendingMemorySection when there are no pending requests', () => {
    setNavigatorState({
      libraryTree: [],
      spacesData: [makeSpace('Alpha')],
      lens: { filter: 'memory', view: 'folders' },
      pendingMemoryRequests: [],
    });

    mounted = mount(<LibraryNavigator />);

    expect(mounted.container.querySelector('[data-testid="pending-memory-section"]')).toBeNull();
  });

  it.each([
    ['spaces', 'folders'],
    ['spaces', 'cards'],
    ['spaces', 'atlas'],
    ['skills', 'folders'],
    ['skills', 'cards'],
    ['skills', 'atlas'],
    ['memory', 'folders'],
    ['memory', 'cards'],
    ['memory', 'atlas'],
    ['everything', 'folders'],
    ['everything', 'cards'],
    ['everything', 'atlas'],
  ] as const)(
    'keeps body scrollable in constrained height for %s × %s',
    (filter, view) => {
      setNavigatorState({
        libraryTree: Array.from({ length: 50 }, (_, index) => ({
          name: `file-${index}.md`,
          path: `/workspace/file-${index}.md`,
          kind: 'file',
        })),
        spacesData: [makeSpace('Alpha')],
        lens: { filter, view },
      });

      mounted = mount(
        <div style={{ height: '180px', overflow: 'hidden' }}>
          <LibraryNavigator />
        </div>,
      );

      const bodyContent = mounted.container.querySelector(
        '[data-testid="library-body-content"]',
      ) as HTMLDivElement | null;

      expect(bodyContent).toBeTruthy();
      const computed = bodyContent ? window.getComputedStyle(bodyContent) : null;
      expect(computed?.overflow).toBe('auto');

      if (bodyContent) {
        bodyContent.scrollTop = 48;
        expect(bodyContent.scrollTop).toBe(48);
      }
    },
  );

  it('renders a tree-only rail in wide kiosk mode and hides command shelf', () => {
    setNavigatorState({
      libraryTree: [
        { name: 'alpha.md', path: '/workspace/alpha.md', kind: 'file' },
        { name: 'beta.md', path: '/workspace/beta.md', kind: 'file' },
      ],
      spacesData: [makeSpace('Alpha')],
      lens: { filter: 'skills', view: 'cards' },
    });

    mounted = mount(<LibraryNavigator kioskLevel="wide" />);

    expect(mounted.container.querySelector('[data-testid="command-shelf"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="library-kiosk-rail"]')).toBeTruthy();
    expect(mounted.container.querySelector('[data-testid="library-tree-view"]')?.textContent).toBe('2');
  });

  it('auto-expands active-file ancestors and scrolls active row in wide kiosk mode', () => {
    const onExpandDirectories = vi.fn();
    const requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    const scrollIntoViewSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});

    setNavigatorState({
      libraryTree: [
        {
          name: 'docs',
          path: '/workspace/docs',
          kind: 'directory',
          children: [
            {
              name: 'plans',
              path: '/workspace/docs/plans',
              kind: 'directory',
              children: [
                { name: 'focus.md', path: '/workspace/docs/plans/focus.md', kind: 'file' },
              ],
            },
          ],
        },
      ],
      activePath: '/workspace/docs/plans/focus.md',
      expandedDirectories: {},
      onExpandDirectories,
    });

    mounted = mount(<LibraryNavigator kioskLevel="wide" />);

    expect(onExpandDirectories).toHaveBeenCalledTimes(1);
    expect(onExpandDirectories).toHaveBeenCalledWith([
      '/workspace/docs',
      '/workspace/docs/plans',
    ]);
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);

    requestAnimationFrameSpy.mockRestore();
    scrollIntoViewSpy.mockRestore();
  });

  it('does not auto-expand again when activePath is unchanged after manual collapse', () => {
    const onExpandDirectories = vi.fn();
    const requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });

    const tree = [
      {
        name: 'docs',
        path: '/workspace/docs',
        kind: 'directory' as const,
        children: [
          {
            name: 'plans',
            path: '/workspace/docs/plans',
            kind: 'directory' as const,
            children: [{ name: 'focus.md', path: '/workspace/docs/plans/focus.md', kind: 'file' as const }],
          },
        ],
      },
    ];

    setNavigatorState({
      libraryTree: tree,
      activePath: '/workspace/docs/plans/focus.md',
      expandedDirectories: {},
      onExpandDirectories,
    });

    mounted = mount(<LibraryNavigator kioskLevel="wide" />);
    expect(onExpandDirectories).toHaveBeenCalledTimes(1);

    // Simulate user manually collapsing after auto-expand. Re-render with same activePath.
    setNavigatorState({
      libraryTree: tree,
      activePath: '/workspace/docs/plans/focus.md',
      expandedDirectories: {},
      onExpandDirectories,
    });
    act(() => {
      mounted?.root.render(<LibraryNavigator kioskLevel="wide" />);
    });

    expect(onExpandDirectories).toHaveBeenCalledTimes(1);

    requestAnimationFrameSpy.mockRestore();
  });
});
