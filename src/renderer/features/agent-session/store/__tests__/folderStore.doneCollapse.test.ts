// @vitest-environment happy-dom
/**
 * Tests for the independent "done subsection" collapse map in folderStore:
 * - toggleFolderDoneCollapse defaults to collapsed (absent === collapsed), so
 *   the first toggle expands it.
 * - It persists to its OWN localStorage key, never touching collapseState.
 * - State loads back from localStorage on loadFolders.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useFolderStore } from '../folderStore';

const DONE_KEY = 'rebel:folder-done-collapse-state';
const COLLAPSE_KEY = 'rebel:folder-collapse-state';

beforeEach(() => {
  localStorage.clear();
  // Reset store to a clean baseline.
  useFolderStore.setState({
    folders: [],
    membership: {},
    collapseState: {},
    doneCollapseState: {},
    loaded: false,
  });
});

describe('folderStore — done subsection collapse', () => {
  it('first toggle expands (default is collapsed) and persists to the done key', () => {
    useFolderStore.getState().toggleFolderDoneCollapse('f1');

    expect(useFolderStore.getState().doneCollapseState).toEqual({ f1: false });

    const persisted = JSON.parse(localStorage.getItem(DONE_KEY) ?? '{}');
    expect(persisted).toEqual({ f1: false });
  });

  it('second toggle re-collapses', () => {
    const { toggleFolderDoneCollapse } = useFolderStore.getState();
    toggleFolderDoneCollapse('f1'); // expand
    toggleFolderDoneCollapse('f1'); // collapse

    expect(useFolderStore.getState().doneCollapseState).toEqual({ f1: true });
    expect(JSON.parse(localStorage.getItem(DONE_KEY) ?? '{}')).toEqual({ f1: true });
  });

  it('does NOT touch the folder collapseState or its localStorage key', () => {
    useFolderStore.getState().toggleFolderDoneCollapse('f1');

    expect(useFolderStore.getState().collapseState).toEqual({});
    expect(localStorage.getItem(COLLAPSE_KEY)).toBeNull();
  });

  it('loads doneCollapseState back from localStorage on loadFolders', async () => {
    localStorage.setItem(DONE_KEY, JSON.stringify({ f1: false, f2: true }));

    // Stub the IPC bridge used by loadFolders.
    (globalThis as any).window = (globalThis as any).window ?? {};
    (window as any).foldersApi = {
      load: vi.fn().mockResolvedValue({ version: 1, folders: [], membership: {} }),
    };

    await useFolderStore.getState().loadFolders();

    expect(useFolderStore.getState().doneCollapseState).toEqual({ f1: false, f2: true });
  });
});
