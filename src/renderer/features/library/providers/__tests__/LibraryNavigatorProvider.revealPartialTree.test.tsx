// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToastProps } from '@renderer/components/ui';
import type { AppSettings, FileNode } from '@shared/types';
import type { FileTreeMetadata } from '@shared/ipc/schemas/library';
import {
  LibraryNavigatorProvider,
  useLibraryNavigator,
} from '../LibraryNavigatorProvider';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A tree containing exactly one known file. Anything else is "absent".
const TREE: FileNode[] = [
  {
    name: 'inbox',
    path: '/workspace/inbox',
    kind: 'directory',
    children: [
      {
        name: 'present.md',
        path: '/workspace/inbox/present.md',
        kind: 'file',
      },
    ],
  },
];

// Partial-tree metadata: truncated === true → treePartialState.isPartialTree === true.
const PARTIAL_METADATA: FileTreeMetadata = {
  truncated: true,
  reasons: ['node-cap'],
  returnedNodes: 2,
  unavailableNodes: 0,
} as unknown as FileTreeMetadata;

const COMPLETE_METADATA: FileTreeMetadata = {
  truncated: false,
  reasons: [],
  returnedNodes: 2,
  unavailableNodes: 0,
} as unknown as FileTreeMetadata;

const treeState = vi.hoisted(() => ({
  metadata: null as FileTreeMetadata | null,
}));

const mocks = vi.hoisted(() => ({
  loadTreeMock: vi.fn().mockResolvedValue(undefined),
  setTreeMock: vi.fn(),
  setShowHiddenFilesMock: vi.fn(),
  setExpandedDirectoriesMock: vi.fn(),
  refreshSkillsMock: vi.fn().mockResolvedValue(undefined),
  refreshSpacesMock: vi.fn().mockResolvedValue(undefined),
  refreshIndexStatusMock: vi.fn(),
}));

vi.mock('../../hooks/useLibraryTree', () => ({
  useLibraryTree: () => ({
    tree: TREE,
    treeMetadata: treeState.metadata,
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
    spaces: [],
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
    pendingLibraryNavigation: null,
    clearPendingLibraryNavigation: vi.fn(),
  }),
}));

let latestNavigator: ReturnType<typeof useLibraryNavigator> | null = null;

function Probe() {
  latestNavigator = useLibraryNavigator();
  return null;
}

async function flushMicrotasks(iterations = 8): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

describe('LibraryNavigatorProvider reveal-by-path honesty (Codex F1)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let showToastMock: ReturnType<typeof vi.fn<(options: Omit<ToastProps, 'id'>) => string>>;

  const renderProvider = async () => {
    showToastMock = vi.fn<(options: Omit<ToastProps, 'id'>) => string>(() => 'toast-id');
    await act(async () => {
      root.render(
        <LibraryNavigatorProvider
          open
          settings={{ coreDirectory: '/workspace' } as AppSettings}
          showToast={showToastMock}
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
    treeState.metadata = null;

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { onLibraryChanged: vi.fn(() => vi.fn()) },
    });
    Object.defineProperty(window, 'libraryApi', {
      configurable: true,
      value: {
        getStats: vi.fn().mockResolvedValue({ totalFiles: 1, totalDirs: 1, truncated: false }),
        readFile: vi.fn().mockResolvedValue({ content: '' }),
      },
    });
    Object.defineProperty(window, 'memoryApi', {
      configurable: true,
      value: { getHistory: vi.fn().mockResolvedValue({ entries: [] }) },
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
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
  });

  it('does NOT synthesize a selection for an absent target in a PARTIAL tree (clears pending nav, toasts)', async () => {
    treeState.metadata = PARTIAL_METADATA;
    await renderProvider();

    expect(latestNavigator?.commandShelfProps.selectedWorkspaceItem).toBeNull();

    await act(async () => {
      // 'absent.md' is not in TREE → existingNode undefined, partial tree → honest bail.
      latestNavigator?.bodyState.revealInClassifiedView('/workspace/absent.md');
      await flushMicrotasks();
    });

    // No synthetic directory selection.
    expect(latestNavigator?.commandShelfProps.selectedWorkspaceItem).toBeNull();
    // Pending nav cleared (revealedFoldersCount reflects pendingFolderNavigation).
    expect(latestNavigator?.commandShelfProps.revealedFoldersCount).toBe(0);
    // User was told, honestly.
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("isn't loaded in this partial Library"),
      }),
    );
  });

  it('still reveals a PRESENT target in a partial tree', async () => {
    treeState.metadata = PARTIAL_METADATA;
    await renderProvider();

    await act(async () => {
      latestNavigator?.bodyState.revealInClassifiedView('/workspace/inbox/present.md');
      await flushMicrotasks();
    });

    expect(latestNavigator?.commandShelfProps.selectedWorkspaceItem?.path).toBe('/workspace/inbox/present.md');
    expect(latestNavigator?.commandShelfProps.selectedWorkspaceItem?.kind).toBe('file');
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('keeps prior behaviour for an absent target in a COMPLETE tree (synthetic directory selection)', async () => {
    treeState.metadata = COMPLETE_METADATA;
    await renderProvider();

    await act(async () => {
      latestNavigator?.bodyState.revealInClassifiedView('/workspace/absent.md');
      await flushMicrotasks();
    });

    // Complete tree: unchanged fallback — still defaults a missing node to directory.
    expect(latestNavigator?.commandShelfProps.selectedWorkspaceItem?.path).toBe('/workspace/absent.md');
    expect(latestNavigator?.commandShelfProps.selectedWorkspaceItem?.kind).toBe('directory');
    expect(showToastMock).not.toHaveBeenCalled();
  });
});
