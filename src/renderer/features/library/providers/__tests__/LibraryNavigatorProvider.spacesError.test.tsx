// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, FileNode, MemoryHistoryEntry } from '@shared/types';
import { __resetSpacesCacheForTests } from '@renderer/hooks/useSpacesData';
import {
  LibraryNavigatorProvider,
  useLibraryNavigator,
} from '../LibraryNavigatorProvider';
import { FoldersView } from '../../components/views/FoldersView';
import type { LibraryLens } from '../../types/lens';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const loadTreeMock = vi.hoisted(() => vi.fn());
const refreshSkillsMock = vi.hoisted(() => vi.fn());
const refreshIndexStatusMock = vi.hoisted(() => vi.fn());
const flowPanelsState = vi.hoisted(() => ({
  pendingLibraryNavigation: null as
    | {
        lens: Partial<LibraryLens>;
        folderPath?: string;
        spaceFilter?: string;
        expandIndexingPanel?: boolean;
        revealInTree?: boolean;
      }
    | null,
}));
const clearPendingLibraryNavigationMock = vi.hoisted(() =>
  vi.fn(() => {
    flowPanelsState.pendingLibraryNavigation = null;
  }),
);
const mockTree = vi.hoisted((): FileNode[] => [
  {
    name: 'Documents',
    path: '/workspace/Documents',
    kind: 'directory',
    children: [
      {
        name: 'notes.md',
        path: '/workspace/Documents/notes.md',
        kind: 'file',
      },
    ],
  },
]);

 
vi.mock('../../hooks/useLibraryTree', () => ({
  useLibraryTree: () => ({
    tree: mockTree,
    setTree: vi.fn(),
    loading: false,
    error: null,
    showHiddenFiles: false,
    setShowHiddenFiles: vi.fn(),
    expandedDirectories: new Set<string>(),
    setExpandedDirectories: vi.fn(),
    loadTree: loadTreeMock,
  }),
}));

 
vi.mock('../../hooks/useLibrarySearch', () => ({
  useLibrarySearch: () => ({
    query: '',
    results: [],
    selectedIndex: -1,
    setSelectedIndex: vi.fn(),
    handleQueryChange: vi.fn(),
    handleKeyDown: vi.fn(),
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
    refresh: refreshSkillsMock,
  }),
}));

 
vi.mock('../../hooks/useSemanticSearch', () => ({
  useSemanticSearch: () => ({
    indexStatus: null,
    refreshIndexStatus: refreshIndexStatusMock,
    startWatching: vi.fn().mockResolvedValue(undefined),
    pauseWatching: vi.fn().mockResolvedValue(undefined),
    reindex: vi.fn().mockResolvedValue(undefined),
    clearIndex: vi.fn().mockResolvedValue(undefined),
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
    pendingLibraryNavigation: flowPanelsState.pendingLibraryNavigation,
    clearPendingLibraryNavigation: clearPendingLibraryNavigationMock,
  }),
}));

function SpacesPaneProbe() {
  const { bodyState, commandShelfProps, favoriteFilePaths } = useLibraryNavigator();
  return (
    <FoldersView
      filter="spaces"
      searchQuery={bodyState.librarySearchQuery}
      tree={bodyState.treeViewProps.nodes ?? null}
      treeViewProps={bodyState.treeViewProps}
      spacesData={bodyState.spacesData}
      spacesError={bodyState.spacesError}
      spacesErrorMessage={bodyState.spacesErrorMessage}
      favoriteFilePaths={favoriteFilePaths}
      loading={bodyState.libraryLoading}
      error={bodyState.libraryError}
      onRetry={commandShelfProps.onRefresh}
    />
  );
}

let latestLens: LibraryLens | null = null;
let latestBrowseLens: LibraryLens | null = null;
let latestSetBrowseLens: ((next: LibraryLens | ((prev: LibraryLens) => LibraryLens)) => void) | null = null;
let latestNavigatorHandle: { revealInTree: (path: string) => void } | null = null;
let latestPendingFolderNavigation: string | null = null;
let pendingFolderNavigationHistory: Array<string | null> = [];
let latestMemoryEntries: MemoryHistoryEntry[] = [];
let latestMemoryLoading = false;
let latestMemoryError: string | null = null;

function makeMemoryHistoryEntry(id: string, timestamp: number): MemoryHistoryEntry {
  return {
    id,
    timestamp,
    sessionId: `${id}-session`,
    turnId: `${id}-turn`,
    entity: 'Chief-of-Staff',
    visibility: 'private',
    action: 'created',
    summary: `Summary for ${id}`,
    filePath: `Chief-of-Staff/memory/${id}.md`,
  };
}

async function flushMicrotasks(iterations = 8): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

function LensStateProbe() {
  const { lens, browseLens, setBrowseLens, bodyState } = useLibraryNavigator();
  latestLens = lens;
  latestBrowseLens = browseLens;
  latestSetBrowseLens = setBrowseLens;
  latestPendingFolderNavigation = bodyState.pendingFolderNavigation;
  pendingFolderNavigationHistory.push(bodyState.pendingFolderNavigation);
  latestMemoryEntries = bodyState.memoryEntries;
  latestMemoryLoading = bodyState.memoryLoading;
  latestMemoryError = bodyState.memoryError;
  return null;
}

describe('LibraryNavigatorProvider Spaces errors', () => {
  let container: HTMLDivElement;
  let root: Root;
  let scanSpaces: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetSpacesCacheForTests();
    vi.clearAllMocks();
    localStorage.clear();
    flowPanelsState.pendingLibraryNavigation = null;
    clearPendingLibraryNavigationMock.mockClear();
    latestLens = null;
    latestBrowseLens = null;
    latestSetBrowseLens = null;
    latestNavigatorHandle = null;
    latestPendingFolderNavigation = null;
    pendingFolderNavigationHistory = [];
    latestMemoryEntries = [];
    latestMemoryLoading = false;
    latestMemoryError = null;
    scanSpaces = vi.fn().mockRejectedValue(new Error('scan failed'));

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        onLibraryChanged: vi.fn(() => vi.fn()),
      },
    });
    Object.defineProperty(window, 'libraryApi', {
      configurable: true,
      value: {
        scanSpaces,
        getStats: vi.fn().mockResolvedValue({ totalFiles: 0, totalDirs: 0, truncated: false }),
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

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    __resetSpacesCacheForTests();
  });

  it('surfaces scanSpaces rejection through the Show: Spaces UI instead of a silent empty list', async () => {
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
          <SpacesPaneProbe />
        </LibraryNavigatorProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(scanSpaces).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('scan failed');
    expect(container.textContent).not.toContain("You haven't added any Spaces yet");
  });

  it('requests memory history in paged batches with a larger cap than the old 100-entry limit', async () => {
    const memoryHistoryMock = vi.fn().mockResolvedValue({ entries: [], hasMore: false });
    Object.defineProperty(window, 'memoryApi', {
      configurable: true,
      value: {
        getHistory: memoryHistoryMock,
      },
    });

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
          <SpacesPaneProbe />
        </LibraryNavigatorProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(memoryHistoryMock).toHaveBeenCalledTimes(1);
    expect(memoryHistoryMock).toHaveBeenCalledWith({ limit: 250 });
  });

  it('paginates memory history without dropping entries that share the first post-page boundary timestamp', async () => {
    const firstPageEntries = Array.from({ length: 249 }, (_, index) =>
      makeMemoryHistoryEntry(`memory-top-${index}`, 1_000 - index),
    );
    const boundaryEntry = makeMemoryHistoryEntry('memory-boundary-751', 751);
    const secondPageBoundaryEntries = [
      makeMemoryHistoryEntry('memory-boundary-750-a', 750),
      makeMemoryHistoryEntry('memory-boundary-750-b', 750),
    ];
    const tailEntry = makeMemoryHistoryEntry('memory-tail-749', 749);
    const allEntries = [
      ...firstPageEntries,
      boundaryEntry,
      ...secondPageBoundaryEntries,
      tailEntry,
    ];

    const memoryHistoryMock = vi.fn().mockImplementation(async (options?: {
      limit?: number;
      beforeTimestamp?: number;
    }) => {
      let filtered = allEntries;
      const beforeTimestamp = options?.beforeTimestamp;
      if (beforeTimestamp != null) {
        filtered = filtered.filter((entry) => entry.timestamp < beforeTimestamp);
      }
      const limit = options?.limit ?? 100;
      const entries = filtered.slice(0, limit);
      return {
        entries,
        hasMore: filtered.length > entries.length,
      };
    });

    Object.defineProperty(window, 'memoryApi', {
      configurable: true,
      value: {
        getHistory: memoryHistoryMock,
      },
    });

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
          <LensStateProbe />
        </LibraryNavigatorProvider>,
      );
      await flushMicrotasks();
    });

    expect(memoryHistoryMock).toHaveBeenCalledTimes(2);
    expect(memoryHistoryMock).toHaveBeenNthCalledWith(1, { limit: 250 });
    expect(memoryHistoryMock).toHaveBeenNthCalledWith(2, { limit: 250, beforeTimestamp: 751 });
    expect(latestMemoryEntries.map((entry) => entry.id)).toEqual(allEntries.map((entry) => entry.id));
  });

  it('applies only the latest memory load results when requests overlap', async () => {
    type MemoryHistoryResponse = { entries: MemoryHistoryEntry[]; hasMore: boolean };
    const createDeferred = () => {
      let resolve!: (value: MemoryHistoryResponse) => void;
      const promise = new Promise<MemoryHistoryResponse>((promiseResolve) => {
        resolve = promiseResolve;
      });
      return { promise, resolve };
    };

    const staleDeferred = createDeferred();
    const latestEntries = [makeMemoryHistoryEntry('memory-latest', 900)];
    const staleEntries = [makeMemoryHistoryEntry('memory-stale', 999)];

    const memoryHistoryMock = vi.fn()
      .mockReturnValueOnce(staleDeferred.promise)
      .mockResolvedValueOnce({
        entries: latestEntries,
        hasMore: false,
      });

    Object.defineProperty(window, 'memoryApi', {
      configurable: true,
      value: {
        getHistory: memoryHistoryMock,
      },
    });

    const renderProvider = async (coreDirectory: string) => {
      await act(async () => {
        root.render(
          <LibraryNavigatorProvider
            open
            settings={{ coreDirectory } as AppSettings}
            showToast={vi.fn()}
            emitLog={vi.fn()}
            editorDocument={null}
            loadWorkspaceFile={vi.fn().mockResolvedValue(undefined)}
            closeEditor={vi.fn()}
            recentFiles={[]}
            setRecentFiles={vi.fn()}
          >
            <LensStateProbe />
          </LibraryNavigatorProvider>,
        );
        await flushMicrotasks();
      });
    };

    await renderProvider('/workspace-a');
    expect(memoryHistoryMock).toHaveBeenCalledTimes(1);
    expect(latestMemoryLoading).toBe(true);

    await renderProvider('/workspace-b');
    expect(memoryHistoryMock).toHaveBeenCalledTimes(2);
    expect(latestMemoryEntries.map((entry) => entry.id)).toEqual(latestEntries.map((entry) => entry.id));
    expect(latestMemoryLoading).toBe(false);
    expect(latestMemoryError).toBeNull();

    await act(async () => {
      staleDeferred.resolve({
        entries: staleEntries,
        hasMore: false,
      });
      await flushMicrotasks();
    });

    expect(latestMemoryEntries.map((entry) => entry.id)).toEqual(latestEntries.map((entry) => entry.id));
    expect(latestMemoryError).toBeNull();
  });

  it('clears stale memory entries when the latest load fails', async () => {
    const initialEntries = [makeMemoryHistoryEntry('memory-initial', 950)];
    const memoryHistoryMock = vi.fn()
      .mockResolvedValueOnce({
        entries: initialEntries,
        hasMore: false,
      })
      .mockRejectedValueOnce(new Error('memory history failed'));

    Object.defineProperty(window, 'memoryApi', {
      configurable: true,
      value: {
        getHistory: memoryHistoryMock,
      },
    });

    const renderProvider = async (coreDirectory: string) => {
      await act(async () => {
        root.render(
          <LibraryNavigatorProvider
            open
            settings={{ coreDirectory } as AppSettings}
            showToast={vi.fn()}
            emitLog={vi.fn()}
            editorDocument={null}
            loadWorkspaceFile={vi.fn().mockResolvedValue(undefined)}
            closeEditor={vi.fn()}
            recentFiles={[]}
            setRecentFiles={vi.fn()}
          >
            <LensStateProbe />
          </LibraryNavigatorProvider>,
        );
        await flushMicrotasks();
      });
    };

    await renderProvider('/workspace-a');
    expect(latestMemoryEntries.map((entry) => entry.id)).toEqual(initialEntries.map((entry) => entry.id));

    await renderProvider('/workspace-b');
    expect(latestMemoryEntries).toEqual([]);
    expect(latestMemoryError).toContain('memory history failed');
    expect(latestMemoryLoading).toBe(false);
  });

  it('cancels in-flight memory loads when the drawer closes', async () => {
    type MemoryHistoryResponse = { entries: MemoryHistoryEntry[]; hasMore: boolean };
    const createDeferred = () => {
      let resolve!: (value: MemoryHistoryResponse) => void;
      const promise = new Promise<MemoryHistoryResponse>((promiseResolve) => {
        resolve = promiseResolve;
      });
      return { promise, resolve };
    };

    const inFlightDeferred = createDeferred();
    const canceledEntries = [makeMemoryHistoryEntry('memory-canceled', 888)];
    const memoryHistoryMock = vi.fn().mockReturnValueOnce(inFlightDeferred.promise);

    Object.defineProperty(window, 'memoryApi', {
      configurable: true,
      value: {
        getHistory: memoryHistoryMock,
      },
    });

    const renderProvider = async (isOpen: boolean) => {
      await act(async () => {
        root.render(
          <LibraryNavigatorProvider
            open={isOpen}
            settings={{ coreDirectory: '/workspace' } as AppSettings}
            showToast={vi.fn()}
            emitLog={vi.fn()}
            editorDocument={null}
            loadWorkspaceFile={vi.fn().mockResolvedValue(undefined)}
            closeEditor={vi.fn()}
            recentFiles={[]}
            setRecentFiles={vi.fn()}
          >
            <LensStateProbe />
          </LibraryNavigatorProvider>,
        );
        await flushMicrotasks();
      });
    };

    await renderProvider(true);
    expect(memoryHistoryMock).toHaveBeenCalledTimes(1);
    expect(latestMemoryLoading).toBe(true);

    await renderProvider(false);
    expect(latestMemoryLoading).toBe(false);

    await act(async () => {
      inFlightDeferred.resolve({
        entries: canceledEntries,
        hasMore: false,
      });
      await flushMicrotasks();
    });

    expect(latestMemoryEntries).toEqual([]);
    expect(latestMemoryError).toBeNull();
    expect(latestMemoryLoading).toBe(false);
  });

  it('restores browse lens after reveal-in-tree override clears on editor close', async () => {
    const renderProvider = async (editorDocument: { path: string; name: string; relativePath: string; content: string; originalContent: string; isDirty: boolean; saving: boolean; error: string | null } | null) => {
      await act(async () => {
        root.render(
          <LibraryNavigatorProvider
            open
            settings={{ coreDirectory: '/workspace' } as AppSettings}
            showToast={vi.fn()}
            emitLog={vi.fn()}
            editorDocument={editorDocument}
            loadWorkspaceFile={vi.fn().mockResolvedValue(undefined)}
            closeEditor={vi.fn()}
            recentFiles={[]}
            setRecentFiles={vi.fn()}
            onNavigatorReady={(handle) => {
              latestNavigatorHandle = handle;
            }}
          >
            <>
              <SpacesPaneProbe />
              <LensStateProbe />
            </>
          </LibraryNavigatorProvider>,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    await renderProvider({
      path: '/workspace/Documents/notes.md',
      name: 'notes.md',
      relativePath: 'Documents/notes.md',
      content: '',
      originalContent: '',
      isDirty: false,
      saving: false,
      error: null,
    });

    await act(async () => {
      latestSetBrowseLens?.({ filter: 'skills', view: 'cards' });
      await Promise.resolve();
    });

    expect(latestBrowseLens).toEqual({ filter: 'skills', view: 'cards' });
    expect(latestLens).toEqual({ filter: 'skills', view: 'cards' });

    await act(async () => {
      latestNavigatorHandle?.revealInTree('/workspace/Documents/notes.md');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestBrowseLens).toEqual({ filter: 'skills', view: 'cards' });
    expect(latestLens).toEqual({ filter: 'everything', view: 'folders' });

    await renderProvider(null);

    expect(latestBrowseLens).toEqual({ filter: 'skills', view: 'cards' });
    expect(latestLens).toEqual({ filter: 'skills', view: 'cards' });
  });

  it('routes reveal-in-classified-view to the expected filter for skill/memory/space/plain files', async () => {
    scanSpaces.mockResolvedValue({
      success: true,
      spaces: [
        {
          name: 'General',
          path: 'work/Acme/General',
          absolutePath: '/workspace/work/Acme/General',
          type: 'project',
          isSymlink: true,
          hasReadme: true,
          description: '',
          sharing: 'restricted',
          status: 'ok',
        },
      ],
    });

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
          onNavigatorReady={(handle) => {
            latestNavigatorHandle = handle;
          }}
        >
          <LensStateProbe />
        </LibraryNavigatorProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      latestSetBrowseLens?.({ filter: 'skills', view: 'cards' });
      await Promise.resolve();
    });

    await act(async () => {
      latestNavigatorHandle?.revealInTree('/workspace/Chief-of-Staff/skills/meeting-prep/SKILL.md');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latestLens?.filter).toBe('skills');

    await act(async () => {
      latestNavigatorHandle?.revealInTree('/workspace/Chief-of-Staff/memory/weekly.md');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latestLens?.filter).toBe('memory');

    await act(async () => {
      latestNavigatorHandle?.revealInTree('/workspace/work/Acme/General/roadmap.md');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latestLens?.filter).toBe('spaces');

    await act(async () => {
      latestNavigatorHandle?.revealInTree('/workspace/Documents/notes.md');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latestLens?.filter).toBe('everything');
  });

  it('opening a file (without explicit reveal) does NOT mutate browseLens or editorLensOverride', async () => {
    // Per Lens Transition State Machine: opening a file from a card/list/tree
    // row keeps the user in their current browseLens. Only an explicit
    // reveal-in-tree action (DocumentHeader path click) sets editorLensOverride.
    const renderProvider = async (
      editorDocument:
        | {
            path: string;
            name: string;
            relativePath: string;
            content: string;
            originalContent: string;
            isDirty: boolean;
            saving: boolean;
            error: string | null;
          }
        | null,
    ) => {
      await act(async () => {
        root.render(
          <LibraryNavigatorProvider
            open
            settings={{ coreDirectory: '/workspace' } as AppSettings}
            showToast={vi.fn()}
            emitLog={vi.fn()}
            editorDocument={editorDocument}
            loadWorkspaceFile={vi.fn().mockResolvedValue(undefined)}
            closeEditor={vi.fn()}
            recentFiles={[]}
            setRecentFiles={vi.fn()}
          >
            <>
              <SpacesPaneProbe />
              <LensStateProbe />
            </>
          </LibraryNavigatorProvider>,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    await renderProvider(null);

    await act(async () => {
      latestSetBrowseLens?.({ filter: 'skills', view: 'cards' });
      await Promise.resolve();
    });

    expect(latestBrowseLens).toEqual({ filter: 'skills', view: 'cards' });
    expect(latestLens).toEqual({ filter: 'skills', view: 'cards' });

    // Simulate opening a file: the parent provides a valid editorDocument.
    await renderProvider({
      path: '/workspace/Personal/skills/draft-note/SKILL.md',
      name: 'SKILL.md',
      relativePath: 'Personal/skills/draft-note/SKILL.md',
      content: '',
      originalContent: '',
      isDirty: false,
      saving: false,
      error: null,
    });

    // Browse lens unchanged; no override set.
    expect(latestBrowseLens).toEqual({ filter: 'skills', view: 'cards' });
    expect(latestLens).toEqual({ filter: 'skills', view: 'cards' });

    // Switching to a different file (still no explicit reveal) also keeps lens.
    await renderProvider({
      path: '/workspace/Documents/notes.md',
      name: 'notes.md',
      relativePath: 'Documents/notes.md',
      content: '',
      originalContent: '',
      isDirty: false,
      saving: false,
      error: null,
    });

    expect(latestBrowseLens).toEqual({ filter: 'skills', view: 'cards' });
    expect(latestLens).toEqual({ filter: 'skills', view: 'cards' });
  });

  it('ignores reveal-in-tree paths outside the workspace root', async () => {
    const showToast = vi.fn();
    const emitLog = vi.fn();

    await act(async () => {
      root.render(
        <LibraryNavigatorProvider
          open
          settings={{ coreDirectory: '/workspace' } as AppSettings}
          showToast={showToast}
          emitLog={emitLog}
          editorDocument={{
            path: '/workspace/Documents/notes.md',
            name: 'notes.md',
            relativePath: 'Documents/notes.md',
            content: '',
            originalContent: '',
            isDirty: false,
            saving: false,
            error: null,
          }}
          loadWorkspaceFile={vi.fn().mockResolvedValue(undefined)}
          closeEditor={vi.fn()}
          recentFiles={[]}
          setRecentFiles={vi.fn()}
          onNavigatorReady={(handle) => {
            latestNavigatorHandle = handle;
          }}
        >
          <>
            <SpacesPaneProbe />
            <LensStateProbe />
          </>
        </LibraryNavigatorProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      latestSetBrowseLens?.({ filter: 'skills', view: 'cards' });
      await Promise.resolve();
    });

    await act(async () => {
      latestNavigatorHandle?.revealInTree('/outside-workspace/notes.md');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestBrowseLens).toEqual({ filter: 'skills', view: 'cards' });
    expect(latestLens).toEqual({ filter: 'skills', view: 'cards' });
    expect(latestPendingFolderNavigation).toBeNull();
    expect(pendingFolderNavigationHistory).not.toContain('outside-workspace/notes.md');
    expect(emitLog).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn',
      message: '[library] Reveal target is outside workspace; ignoring',
      context: expect.objectContaining({
        path: '/outside-workspace/notes.md',
        workspaceRoot: '/workspace',
        source: 'direct',
      }),
    }));
    expect(showToast).toHaveBeenCalledWith({ title: "Can't reveal files outside your Library." });
  });

  it('ignores pending reveal-in-tree navigation outside the workspace root', async () => {
    const showToast = vi.fn();
    const emitLog = vi.fn();

    const renderProvider = async () => {
      await act(async () => {
        root.render(
          <LibraryNavigatorProvider
            open
            settings={{ coreDirectory: '/workspace' } as AppSettings}
            showToast={showToast}
            emitLog={emitLog}
            editorDocument={null}
            loadWorkspaceFile={vi.fn().mockResolvedValue(undefined)}
            closeEditor={vi.fn()}
            recentFiles={[]}
            setRecentFiles={vi.fn()}
          >
            <LensStateProbe />
          </LibraryNavigatorProvider>,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    await renderProvider();

    pendingFolderNavigationHistory = [];
    flowPanelsState.pendingLibraryNavigation = {
      lens: { filter: 'spaces', view: 'folders' },
      folderPath: '/outside-workspace/notes.md',
      revealInTree: true,
    };

    await renderProvider();

    expect(latestPendingFolderNavigation).toBeNull();
    expect(pendingFolderNavigationHistory).not.toContain('outside-workspace/notes.md');
    expect(emitLog).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn',
      message: '[library] Reveal target is outside workspace; ignoring',
      context: expect.objectContaining({
        path: '/outside-workspace/notes.md',
        workspaceRoot: '/workspace',
        source: 'pending',
      }),
    }));
    expect(showToast).toHaveBeenCalledWith({ title: "Can't reveal files outside your Library." });
  });

  it('normalizes pending folder navigation so absolute and relative inputs resolve to the same target', async () => {
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
            <LensStateProbe />
          </LibraryNavigatorProvider>,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    await renderProvider();

    const targetRelativePath = 'Documents/notes.md';
    const targetAbsolutePath = '/workspace/Documents/notes.md';

    pendingFolderNavigationHistory = [];
    flowPanelsState.pendingLibraryNavigation = {
      lens: { filter: 'spaces', view: 'folders' },
      folderPath: targetAbsolutePath,
      revealInTree: true,
    };
    await renderProvider();
    expect(pendingFolderNavigationHistory).toContain(targetRelativePath);

    pendingFolderNavigationHistory = [];
    flowPanelsState.pendingLibraryNavigation = {
      lens: { filter: 'spaces', view: 'folders' },
      folderPath: targetRelativePath,
      revealInTree: true,
    };
    await renderProvider();
    expect(pendingFolderNavigationHistory).toContain(targetRelativePath);
  });

  it('notifies onBrowseLensInteraction when the browse lens changes', async () => {
    const onBrowseLensInteraction = vi.fn();

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
          onBrowseLensInteraction={onBrowseLensInteraction}
        >
          <LensStateProbe />
        </LibraryNavigatorProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      latestSetBrowseLens?.({ filter: 'skills', view: 'cards' });
      await Promise.resolve();
    });

    expect(onBrowseLensInteraction).toHaveBeenCalledTimes(1);
  });
});
