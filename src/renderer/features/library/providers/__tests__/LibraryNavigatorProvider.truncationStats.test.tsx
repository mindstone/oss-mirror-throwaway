// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, FileNode } from '@shared/types';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import {
  LibraryNavigatorProvider,
  useLibraryNavigator,
} from '../LibraryNavigatorProvider';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const TREE: FileNode[] = [
  {
    name: 'inbox',
    path: '/workspace/inbox',
    kind: 'directory',
    children: [
      {
        name: 'source.md',
        path: '/workspace/inbox/source.md',
        kind: 'file',
      },
    ],
  },
  {
    name: 'archive',
    path: '/workspace/archive',
    kind: 'directory',
    children: [],
  },
];

const SPACE_ENTRY: SpaceInfo = {
  name: 'Alpha',
  displayName: 'Alpha',
  path: '/workspace/spaces/alpha',
  absolutePath: '/workspace/spaces/alpha',
  sourcePath: '/workspace/spaces/alpha',
  type: 'project',
  isSymlink: true,
  hasReadme: true,
  description: '',
  status: 'ok',
};

const mocks = vi.hoisted(() => ({
  loadTreeMock: vi.fn().mockResolvedValue(undefined),
  setTreeMock: vi.fn(),
  setShowHiddenFilesMock: vi.fn(),
  setExpandedDirectoriesMock: vi.fn(),
  refreshSkillsMock: vi.fn().mockResolvedValue(undefined),
  refreshSpacesMock: vi.fn().mockResolvedValue(undefined),
  refreshIndexStatusMock: vi.fn(),
  flowPanelsState: {
    pendingLibraryNavigation: null as null,
  },
}));

vi.mock('../../hooks/useLibraryTree', () => ({
  useLibraryTree: () => ({
    tree: TREE,
    setTree: mocks.setTreeMock,
    loading: false,
    error: null,
    showHiddenFiles: false,
    setShowHiddenFiles: mocks.setShowHiddenFilesMock,
    expandedDirectories: {},
    setExpandedDirectories: mocks.setExpandedDirectoriesMock,
    loadTree: mocks.loadTreeMock,
  }),
}));

vi.mock('../../hooks/useLibrarySearch', () => ({
  useLibrarySearch: () => ({
    query: '',
    results: [],
    sections: { skills: [], spaces: [], files: [] },
    truncated: false,
    searchOutcome: null,
    selectedIndex: -1,
    setSelectedIndex: vi.fn(),
    handleQueryChange: vi.fn(),
    clearSearch: vi.fn(),
  }),
}));

vi.mock('../../hooks/useLibraryContentSearch', () => ({
  useLibraryContentSearch: () => ({
    query: '',
    results: [],
    loading: false,
    error: null,
    totalMatches: 0,
    searchedFiles: 0,
    truncated: false,
    selectedResultIndex: -1,
    setSelectedResultIndex: vi.fn(),
    handleQueryChange: vi.fn(),
    handleKeyDown: vi.fn(),
    handleSelectResult: vi.fn(),
    clearSearch: vi.fn(),
  }),
}));

vi.mock('../../hooks/useSkillsIndex', () => ({
  useSkillsIndex: () => ({
    skillsData: { groups: [], totalCount: 0 },
    loading: false,
    error: null,
    refresh: mocks.refreshSkillsMock,
  }),
}));

vi.mock('@renderer/hooks/useSpacesData', () => ({
  useSpacesData: () => ({
    spaces: [SPACE_ENTRY],
    loading: false,
    error: false,
    errorMessage: null,
    refresh: mocks.refreshSpacesMock,
  }),
}));

vi.mock('../../hooks/useSemanticSearch', () => ({
  useSemanticSearch: () => ({
    indexStatus: null,
    refreshIndexStatus: mocks.refreshIndexStatusMock,
    startWatching: vi.fn().mockResolvedValue(undefined),
    pauseWatching: vi.fn().mockResolvedValue(undefined),
    reindex: vi.fn().mockResolvedValue(undefined),
    clearIndex: vi.fn().mockResolvedValue(true),
  }),
}));

vi.mock('../../hooks/usePendingMemoryApprovals', () => ({
  usePendingMemoryApprovals: () => ({
    requests: [],
    isLoading: false,
    save: vi.fn().mockResolvedValue(undefined),
    skip: vi.fn().mockResolvedValue(undefined),
    saveAll: vi.fn().mockResolvedValue(undefined),
    skipAll: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@renderer/features/flow-panels/FlowPanelsProvider', () => ({
  useFlowPanels: () => ({
    pendingLibraryNavigation: mocks.flowPanelsState.pendingLibraryNavigation,
    clearPendingLibraryNavigation: vi.fn(),
  }),
}));

let latestNavigator: ReturnType<typeof useLibraryNavigator> | null = null;

function Probe() {
  latestNavigator = useLibraryNavigator();
  return null;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function flushMicrotasks(iterations = 8): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

function createContextMenuEvent(): React.MouseEvent<HTMLDivElement> {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    clientX: 0,
    clientY: 0,
  } as unknown as React.MouseEvent<HTMLDivElement>;
}

function createDragEvent(): React.DragEvent<HTMLDivElement> {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    currentTarget: document.createElement('div'),
    relatedTarget: null,
    dataTransfer: {
      effectAllowed: 'move',
      dropEffect: 'move',
      setData: vi.fn(),
      getData: vi.fn(),
    },
  } as unknown as React.DragEvent<HTMLDivElement>;
}

describe('LibraryNavigatorProvider truncation stats refresh', () => {
  let container: HTMLDivElement;
  let root: Root;
  let getStatsMock: ReturnType<typeof vi.fn>;
  let createFileMock: ReturnType<typeof vi.fn>;
  let renameItemMock: ReturnType<typeof vi.fn>;
  let deleteItemMock: ReturnType<typeof vi.fn>;
  let moveItemMock: ReturnType<typeof vi.fn>;
  let renameSpaceMock: ReturnType<typeof vi.fn>;
  let removeSpaceMock: ReturnType<typeof vi.fn>;

  const renderProvider = async () => {
    await act(async () => {
      root.render(
        <LibraryNavigatorProvider
          open
          settings={{ coreDirectory: '/workspace' } as AppSettings}
          showToast={vi.fn()}
          emitLog={vi.fn()}
          editorDocument={null}
          loadWorkspaceFile={vi.fn().mockResolvedValue(undefined)}
          closeEditor={vi.fn()}
          recentFiles={[]}
          setRecentFiles={vi.fn()}
        >
          <Probe />
        </LibraryNavigatorProvider>,
      );
      await flushMicrotasks();
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    latestNavigator = null;
    mocks.loadTreeMock.mockResolvedValue(undefined);

    getStatsMock = vi.fn().mockResolvedValue({ totalFiles: 12, totalDirs: 3, truncated: false });
    createFileMock = vi.fn().mockResolvedValue({ path: '' });
    renameItemMock = vi.fn().mockResolvedValue({ path: '/workspace/inbox/source-renamed.md' });
    deleteItemMock = vi.fn().mockResolvedValue({ success: true });
    moveItemMock = vi.fn().mockResolvedValue({ path: '/workspace/archive/source.md', moved: true });
    renameSpaceMock = vi.fn().mockResolvedValue({ success: true });
    removeSpaceMock = vi.fn().mockResolvedValue({ success: true });

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        onLibraryChanged: vi.fn(() => vi.fn()),
      },
    });
    Object.defineProperty(window, 'libraryApi', {
      configurable: true,
      value: {
        getStats: getStatsMock,
        createFile: createFileMock,
        createFolder: vi.fn().mockResolvedValue({ path: '' }),
        renameItem: renameItemMock,
        deleteItem: deleteItemMock,
        moveItem: moveItemMock,
        renameSpace: renameSpaceMock,
        removeSpace: removeSpaceMock,
        readFile: vi.fn().mockResolvedValue({ content: '' }),
      },
    });
    Object.defineProperty(window, 'memoryApi', {
      configurable: true,
      value: {
        getHistory: vi.fn().mockResolvedValue({ entries: [] }),
      },
    });
    Object.defineProperty(window, 'searchApi', {
      configurable: true,
      value: {
        pauseEnhancement: vi.fn().mockResolvedValue(undefined),
        resumeEnhancement: vi.fn().mockResolvedValue(undefined),
        startEnhancement: vi.fn().mockResolvedValue(undefined),
      },
    });

    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('prompt', vi.fn(() => 'Alpha Renamed'));

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
    vi.unstubAllGlobals();
  });

  it('refreshes stats on manual tree refresh', async () => {
    await renderProvider();
    const initialCalls = getStatsMock.mock.calls.length;

    await act(async () => {
      latestNavigator?.commandShelfProps.onRefresh();
      await flushMicrotasks();
    });

    expect(getStatsMock.mock.calls.length).toBe(initialCalls + 1);
  });

  it('refreshes stats on hidden-files toggle', async () => {
    await renderProvider();
    const initialCalls = getStatsMock.mock.calls.length;

    await act(async () => {
      latestNavigator?.commandShelfProps.onToggleHiddenFiles();
      await flushMicrotasks();
    });

    expect(getStatsMock.mock.calls.length).toBe(initialCalls + 1);
    const latestCall = getStatsMock.mock.calls.at(-1)?.[0] as { includeHidden?: boolean } | undefined;
    expect(latestCall?.includeHidden).toBe(true);
  });

  it('refreshes stats on create/delete/rename/move/space-rename/space-remove mutation paths', async () => {
    await renderProvider();

    const expectOneStatsRefresh = async (action: () => Promise<void> | void) => {
      const before = getStatsMock.mock.calls.length;
      await act(async () => {
        await action();
        await flushMicrotasks();
      });
      expect(getStatsMock.mock.calls.length).toBe(before + 1);
    };

    const createBefore = getStatsMock.mock.calls.length;
    await act(async () => {
      latestNavigator?.commandShelfProps.onCreateFile?.();
      await flushMicrotasks();
    });
    await act(async () => {
      latestNavigator?.createDialogState.setCreateDialogValue('created.md');
      await flushMicrotasks();
    });
    await act(async () => {
      latestNavigator?.createDialogState.confirmCreate();
      await flushMicrotasks();
    });
    expect(getStatsMock.mock.calls.length).toBe(createBefore + 1);
    expect(createFileMock).toHaveBeenCalled();

    await expectOneStatsRefresh(async () => {
      await latestNavigator?.bodyState.treeViewProps.onConfirmRename('/workspace/inbox/source.md', 'source-renamed.md');
    });
    expect(renameItemMock).toHaveBeenCalled();

    const moveBefore = getStatsMock.mock.calls.length;
    const sourceNode = TREE[0].children?.[0];
    const destinationNode = TREE[1];
    if (!sourceNode || !destinationNode || destinationNode.kind !== 'directory') {
      throw new Error('Expected source and destination nodes');
    }
    await act(async () => {
      latestNavigator?.bodyState.treeViewProps.onDragStart(createDragEvent(), sourceNode);
      await flushMicrotasks();
    });
    await act(async () => {
      latestNavigator?.bodyState.treeViewProps.onDrop(createDragEvent(), destinationNode);
      await flushMicrotasks();
    });
    expect(getStatsMock.mock.calls.length).toBe(moveBefore + 1);
    expect(moveItemMock).toHaveBeenCalled();

    const deleteBefore = getStatsMock.mock.calls.length;
    await act(async () => {
      latestNavigator?.bodyState.treeViewProps.onContextMenu(createContextMenuEvent(), sourceNode);
      await flushMicrotasks();
    });
    await act(async () => {
      latestNavigator?.contextMenuState.deleteItem();
      await flushMicrotasks();
    });
    expect(getStatsMock.mock.calls.length).toBe(deleteBefore + 1);
    expect(deleteItemMock).toHaveBeenCalled();

    await expectOneStatsRefresh(async () => {
      await latestNavigator?.bodyState.renameSpace?.('/workspace/spaces/alpha', 'Alpha');
    });
    expect(renameSpaceMock).toHaveBeenCalled();

    await expectOneStatsRefresh(async () => {
      await latestNavigator?.bodyState.deleteSpace?.('/workspace/spaces/alpha', 'Alpha Renamed');
    });
    expect(removeSpaceMock).toHaveBeenCalled();
  });

  it('keeps stats tree-generation aligned across a refresh boundary', async () => {
    const gen2TreeLoadDeferred = createDeferred<void>();
    const gen2StatsDeferred = createDeferred<{ totalFiles: number; totalDirs: number; truncated: boolean }>();
    const generationOneStats = { totalFiles: 10, totalDirs: 2, truncated: false };
    const generationTwoStats = { totalFiles: 55, totalDirs: 7, truncated: true };

    mocks.loadTreeMock
      .mockResolvedValueOnce(undefined) // initial mount tree load
      .mockReturnValueOnce(gen2TreeLoadDeferred.promise); // generation 2 tree load

    getStatsMock = vi.fn()
      .mockResolvedValueOnce(generationOneStats)
      .mockReturnValueOnce(gen2StatsDeferred.promise);

    Object.defineProperty(window, 'libraryApi', {
      configurable: true,
      value: {
        getStats: getStatsMock,
        createFile: createFileMock,
        createFolder: vi.fn().mockResolvedValue({ path: '' }),
        renameItem: renameItemMock,
        deleteItem: deleteItemMock,
        moveItem: moveItemMock,
        renameSpace: renameSpaceMock,
        removeSpace: removeSpaceMock,
        readFile: vi.fn().mockResolvedValue({ content: '' }),
      },
    });

    await renderProvider();

    const generationOne = latestNavigator?.bodyState.treeGeneration ?? 0;
    expect(generationOne).toBeGreaterThan(0);
    expect(latestNavigator?.bodyState.libraryStats).toEqual(generationOneStats);

    await act(async () => {
      latestNavigator?.commandShelfProps.onRefresh();
      await flushMicrotasks();
    });

    // While generation 2 tree load is still in flight, generation 1 remains the committed snapshot.
    expect(latestNavigator?.bodyState.treeGeneration).toBe(generationOne);
    expect(latestNavigator?.bodyState.libraryStats).toEqual(generationOneStats);

    await act(async () => {
      gen2TreeLoadDeferred.resolve(undefined);
      await flushMicrotasks();
    });

    // Tree generation 2 committed before stats generation 2 resolved: show pending, not stale gen1 stats.
    expect(latestNavigator?.bodyState.treeGeneration).toBe(generationOne + 1);
    expect(latestNavigator?.bodyState.libraryStats).toBe('pending');

    await act(async () => {
      gen2StatsDeferred.resolve(generationTwoStats);
      await flushMicrotasks();
    });

    expect(latestNavigator?.bodyState.libraryStats).toEqual(generationTwoStats);
  });

  it('drops stale stats responses when a newer tree generation is in flight', async () => {
    const staleStatsDeferred = createDeferred<{ totalFiles: number; totalDirs: number; truncated: boolean }>();
    const freshStatsDeferred = createDeferred<{ totalFiles: number; totalDirs: number; truncated: boolean }>();

    getStatsMock = vi.fn()
      .mockResolvedValueOnce({ totalFiles: 10, totalDirs: 2, truncated: false }) // initial mount
      .mockReturnValueOnce(staleStatsDeferred.promise) // generation N
      .mockReturnValueOnce(freshStatsDeferred.promise); // generation N+1

    Object.defineProperty(window, 'libraryApi', {
      configurable: true,
      value: {
        getStats: getStatsMock,
        createFile: createFileMock,
        createFolder: vi.fn().mockResolvedValue({ path: '' }),
        renameItem: renameItemMock,
        deleteItem: deleteItemMock,
        moveItem: moveItemMock,
        renameSpace: renameSpaceMock,
        removeSpace: removeSpaceMock,
        readFile: vi.fn().mockResolvedValue({ content: '' }),
      },
    });

    await renderProvider();

    await act(async () => {
      latestNavigator?.commandShelfProps.onRefresh();
      latestNavigator?.commandShelfProps.onRefresh();
      await flushMicrotasks();
    });

    await act(async () => {
      freshStatsDeferred.resolve({ totalFiles: 999, totalDirs: 111, truncated: true });
      await flushMicrotasks();
    });
    expect(latestNavigator?.bodyState.libraryStats).toEqual({
      totalFiles: 999,
      totalDirs: 111,
      truncated: true,
    });

    await act(async () => {
      staleStatsDeferred.resolve({ totalFiles: 1, totalDirs: 1, truncated: false });
      await flushMicrotasks();
    });
    expect(latestNavigator?.bodyState.libraryStats).toEqual({
      totalFiles: 999,
      totalDirs: 111,
      truncated: true,
    });
  });
});
