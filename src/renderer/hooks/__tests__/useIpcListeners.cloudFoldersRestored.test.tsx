// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '../../test-utils/hookTestHarness';
import { useIpcListeners } from '../useIpcListeners';
import { useFolderStore } from '@renderer/features/agent-session/store/folderStore';

type FoldersRestoredHandler = () => void;

function emitListenerCleanup() {
  return vi.fn();
}

function installMockApis(): {
  emitFoldersRestored: () => void;
} {
  let foldersRestoredHandler: FoldersRestoredHandler | undefined;
  const unsub: () => void = emitListenerCleanup();
  const noopUnsub = () => {};

  // Auto-stub any onXxx subscription / getXxx fetcher used by useIpcListeners.
  // Returning a noop cleanup keeps unrelated useEffect hooks inside the listener
  // happy without us having to enumerate every channel they touch.
  const makeAutoStubApi = (): Record<string, unknown> =>
    new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop.startsWith('on')) {
          return vi.fn(() => noopUnsub);
        }
        if (prop.startsWith('get')) {
          return vi.fn().mockResolvedValue({});
        }
        return vi.fn();
      },
    });

  (window as unknown as { api: Record<string, unknown> }).api = makeAutoStubApi();

  (window as unknown as { cloudApi: Record<string, unknown> }).cloudApi = {
    onFoldersRestored: vi.fn((cb: FoldersRestoredHandler) => {
      foldersRestoredHandler = cb;
      return unsub;
    }),
    onSessionsSynced: vi.fn(() => noopUnsub),
    onWorkspaceConflicts: vi.fn(() => noopUnsub),
    onSessionConflict: vi.fn(() => noopUnsub),
  };

  return {
    emitFoldersRestored: () => {
      if (!foldersRestoredHandler) throw new Error('onFoldersRestored was not subscribed');
      act(() => foldersRestoredHandler!());
    },
  };
}

function buildHookOptions(overrides: Partial<Parameters<typeof useIpcListeners>[0]> = {}) {
  return {
    emitLog: vi.fn(),
    showToast: vi.fn(),
    refreshLibraryIndex: vi.fn().mockResolvedValue(undefined),
    refreshMcpSummary: vi.fn().mockResolvedValue(undefined),
    refreshSettings: vi.fn().mockResolvedValue(undefined),
    setTimeSavedBySession: vi.fn(),
    setCoachingSessionIds: vi.fn(),
    setUpdateAvailable: vi.fn(),
    setIsInstallingUpdate: vi.fn(),
    setSuperMcpReady: vi.fn(),
    reloadSessionSummaries: vi.fn().mockResolvedValue(undefined),
    refreshActiveCloudSession: vi.fn().mockResolvedValue(undefined),
    onWorkspaceConflictsDetected: vi.fn(),
    openWorkspaceConflictDialog: vi.fn(),
    ...overrides,
  };
}

describe('useIpcListeners — cloud:folders-restored reload of the folder store', () => {
  let loadFoldersSpy: ReturnType<typeof vi.fn>;
  let originalLoadFolders: ReturnType<typeof useFolderStore.getState>['loadFolders'];

  beforeEach(() => {
    // Swap in a spy for the store's loadFolders action so we can assert the
    // listener re-runs it (the part that makes the data-loss fix user-visible:
    // sidebar re-renders after a cloud restore).
    originalLoadFolders = useFolderStore.getState().loadFolders;
    loadFoldersSpy = vi.fn().mockResolvedValue(undefined);
    useFolderStore.setState({ loadFolders: loadFoldersSpy as unknown as typeof originalLoadFolders });
  });

  afterEach(() => {
    useFolderStore.setState({ loadFolders: originalLoadFolders });
    vi.restoreAllMocks();
    delete (window as unknown as { api?: unknown }).api;
    delete (window as unknown as { cloudApi?: unknown }).cloudApi;
  });

  it('re-runs the folder store loadFolders action when folders are restored', () => {
    const { emitFoldersRestored } = installMockApis();
    const options = buildHookOptions();
    renderHook(() => useIpcListeners(options));

    expect(loadFoldersSpy).not.toHaveBeenCalled();

    emitFoldersRestored();

    expect(loadFoldersSpy).toHaveBeenCalledTimes(1);
  });

  it('does not reload the folder store until the restore event fires', () => {
    const { emitFoldersRestored: _emit } = installMockApis();
    const options = buildHookOptions();
    renderHook(() => useIpcListeners(options));

    // No event emitted yet → the sidebar must not be eagerly reloaded.
    expect(loadFoldersSpy).not.toHaveBeenCalled();
    void _emit;
  });
});
