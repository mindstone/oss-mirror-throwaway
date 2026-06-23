// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileNode } from '@shared/types';
import type { LibraryListFilesResponse, FileTreeMetadata } from '@shared/ipc/contracts';
import type { EmitLogFn } from '@renderer/contexts';
import drawerStyles from '../LibraryDrawer.module.css';
import {
  WorkspaceFileNavigator,
  type WorkspaceFileNavigatorProps,
} from '../WorkspaceFileNavigator';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type LibraryChangedEvent = {
  timestamp: number;
  affectsTree: boolean;
  writerKind?: 'editor' | 'agent' | 'file-watcher' | 'cloud-sync';
  changedPath?: string;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const NESTED_TREE: FileNode[] = [
  {
    kind: 'directory',
    name: 'docs',
    path: '/tmp/ws/docs',
    children: [{ kind: 'file', name: 'note.md', path: '/tmp/ws/docs/note.md' }],
  },
];

const FLAT_TREE: FileNode[] = [{ kind: 'file', name: 'readme.md', path: '/tmp/ws/readme.md' }];
const TWO_FILE_TREE: FileNode[] = [
  { kind: 'file', name: 'readme.md', path: '/tmp/ws/readme.md' },
  { kind: 'file', name: 'plan.md', path: '/tmp/ws/plan.md' },
];

const COMPLETE_METADATA: FileTreeMetadata = {
  complete: true,
  truncated: false,
  reasons: [],
  returnedNodes: 0,
  nodeLimit: 100_000,
  estimatedBytes: 0,
  byteLimit: 128 * 1024 * 1024,
  unavailableNodes: 0,
};

const PARTIAL_METADATA: FileTreeMetadata = {
  complete: false,
  truncated: true,
  reasons: ['global-node-cap'],
  returnedNodes: 100_000,
  nodeLimit: 100_000,
  estimatedBytes: 0,
  byteLimit: 128 * 1024 * 1024,
  unavailableNodes: 0,
};

/** Wrap a bare node array in the `library:list-files` `{ nodes, metadata }` contract. */
function wrap(nodes: FileNode[], metadata: FileTreeMetadata = COMPLETE_METADATA): LibraryListFilesResponse {
  return { nodes, metadata: { ...metadata, returnedNodes: nodes.length } };
}

describe('WorkspaceFileNavigator', () => {
  let container: HTMLDivElement;
  let root: Root;
  let listFilesMock: ReturnType<typeof vi.fn>;
  let libraryChangedListeners: Set<(event: LibraryChangedEvent) => void>;

  const defaultEmitLog = vi.fn<EmitLogFn>();
  const defaultOnSelectFile = vi.fn();

  const defaultProps: WorkspaceFileNavigatorProps = {
    activePath: null,
    coreDirectory: '/tmp/ws',
    onSelectFile: defaultOnSelectFile,
    emitLog: defaultEmitLog,
  };

  function renderNavigator(overrides: Partial<WorkspaceFileNavigatorProps> = {}): void {
    act(() => {
      root.render(<WorkspaceFileNavigator {...defaultProps} {...overrides} />);
    });
  }

  async function flushAsyncWork(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function emitLibraryChanged(event: LibraryChangedEvent): void {
    act(() => {
      for (const listener of [...libraryChangedListeners]) {
        listener(event);
      }
    });
  }

  beforeEach(() => {
    listFilesMock = vi.fn().mockResolvedValue(wrap(NESTED_TREE));
    libraryChangedListeners = new Set();
    defaultEmitLog.mockReset();
    defaultOnSelectFile.mockReset();

    Object.defineProperty(window, 'libraryApi', {
      configurable: true,
      value: {
        listFiles: listFilesMock,
      },
    });

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        onLibraryChanged: vi.fn((callback: (event: LibraryChangedEvent) => void) => {
          libraryChangedListeners.add(callback);
          return () => {
            libraryChangedListeners.delete(callback);
          };
        }),
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
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('renders a workspace-empty state and does not load tree data when coreDirectory is null', async () => {
    renderNavigator({ coreDirectory: null });
    await flushAsyncWork();

    expect(container.textContent).toContain('No workspace folder set.');
    expect(listFilesMock).not.toHaveBeenCalled();
  });

  it('loads the workspace tree when coreDirectory is set and renders file nodes', async () => {
    renderNavigator({ coreDirectory: '/tmp/ws' });
    await flushAsyncWork();

    expect(listFilesMock).toHaveBeenCalledTimes(1);
    expect(listFilesMock).toHaveBeenCalledWith({ includeHidden: false });
    expect(container.querySelector('[data-path="/tmp/ws/docs"]')).toBeTruthy();
  });

  it('shows the partial-tree notice when this surface receives truncated metadata', async () => {
    listFilesMock.mockResolvedValueOnce(wrap(NESTED_TREE, PARTIAL_METADATA));
    renderNavigator({ coreDirectory: '/tmp/ws' });
    await flushAsyncWork();

    expect(
      container.querySelector('[data-testid="library-search-truncation-notice"]'),
    ).toBeTruthy();
  });

  it('does not show the partial-tree notice when metadata is complete', async () => {
    renderNavigator({ coreDirectory: '/tmp/ws' });
    await flushAsyncWork();

    expect(
      container.querySelector('[data-testid="library-search-truncation-notice"]'),
    ).toBeNull();
  });

  it('expands ancestors and marks the active file row as active', async () => {
    renderNavigator({
      coreDirectory: '/tmp/ws',
      activePath: '/tmp/ws/docs/note.md',
    });
    await flushAsyncWork();
    await flushAsyncWork();

    const activeRow = container.querySelector('[data-path="/tmp/ws/docs/note.md"]');
    expect(activeRow).toBeTruthy();
    expect(activeRow?.className).toContain(drawerStyles.treeItemActive);
  });

  it('calls onSelectFile with the absolute path when a file row is clicked', async () => {
    listFilesMock.mockResolvedValueOnce(wrap(FLAT_TREE));
    const onSelectFile = vi.fn();

    renderNavigator({
      coreDirectory: '/tmp/ws',
      onSelectFile,
    });
    await flushAsyncWork();

    const row = container.querySelector('[data-path="/tmp/ws/readme.md"]');
    expect(row).toBeTruthy();

    act(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSelectFile).toHaveBeenCalledTimes(1);
    expect(onSelectFile).toHaveBeenCalledWith('/tmp/ws/readme.md');
  });

  it('renders an explicit empty-tree state when the workspace has no files', async () => {
    listFilesMock.mockResolvedValueOnce(wrap([]));

    renderNavigator({ coreDirectory: '/tmp/ws' });
    await flushAsyncWork();

    expect(container.textContent).toContain('No files in this workspace yet.');
  });

  it('shows the partial-tree notice in the empty branch when the tree is empty AND truncated', async () => {
    listFilesMock.mockResolvedValueOnce(wrap([], PARTIAL_METADATA));

    renderNavigator({ coreDirectory: '/tmp/ws' });
    await flushAsyncWork();

    expect(container.textContent).toContain('No files in this workspace yet.');
    expect(
      container.querySelector('[data-testid="library-search-truncation-notice"]'),
    ).toBeTruthy();
  });

  it('moves the active marker when activePath changes after mount', async () => {
    listFilesMock.mockResolvedValueOnce(wrap(TWO_FILE_TREE));

    renderNavigator({
      coreDirectory: '/tmp/ws',
      activePath: '/tmp/ws/readme.md',
    });
    await flushAsyncWork();

    const initialActiveRow = container.querySelector('[data-path="/tmp/ws/readme.md"]');
    const initiallyInactiveRow = container.querySelector('[data-path="/tmp/ws/plan.md"]');
    expect(initialActiveRow).toBeTruthy();
    expect(initiallyInactiveRow).toBeTruthy();
    expect(initialActiveRow?.className).toContain(drawerStyles.treeItemActive);
    expect(initiallyInactiveRow?.className).not.toContain(drawerStyles.treeItemActive);

    renderNavigator({
      coreDirectory: '/tmp/ws',
      activePath: '/tmp/ws/plan.md',
    });
    await flushAsyncWork();

    const previouslyActiveRow = container.querySelector('[data-path="/tmp/ws/readme.md"]');
    const nextActiveRow = container.querySelector('[data-path="/tmp/ws/plan.md"]');
    expect(previouslyActiveRow?.className).not.toContain(drawerStyles.treeItemActive);
    expect(nextActiveRow?.className).toContain(drawerStyles.treeItemActive);
  });

  it('does not emit post-load tree updates after unmount during an in-flight load', async () => {
    const deferred = createDeferred<LibraryListFilesResponse>();
    listFilesMock.mockImplementationOnce(() => deferred.promise);
    const emitLog = vi.fn<EmitLogFn>();

    renderNavigator({ coreDirectory: '/tmp/ws', emitLog });
    expect(listFilesMock).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(<></>);
    });

    await act(async () => {
      deferred.resolve(wrap(NESTED_TREE));
      await Promise.resolve();
    });

    expect(emitLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Workspace tree loaded' }),
    );
  });

  it('warns once per invalid activePath value in dev mode', async () => {
    renderNavigator({
      coreDirectory: '/tmp/ws',
      activePath: 'docs/note.md',
    });
    await flushAsyncWork();

    const initialWarnCalls = defaultEmitLog.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload.level === 'warn');
    expect(initialWarnCalls).toHaveLength(1);
    expect(initialWarnCalls[0].message).toBe(
      "WorkspaceFileNavigator: activePath 'docs/note.md' does not match any tree node. Ensure it's an absolute path under coreDirectory '/tmp/ws'.",
    );

    emitLibraryChanged({ timestamp: Date.now(), affectsTree: true });
    await flushAsyncWork();

    const warnCallsAfterReload = defaultEmitLog.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload.level === 'warn');
    expect(warnCallsAfterReload).toHaveLength(1);

    renderNavigator({
      coreDirectory: '/tmp/ws',
      activePath: 'docs/plan.md',
    });
    await flushAsyncWork();

    const warnCallsAfterPathChange = defaultEmitLog.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload.level === 'warn');
    expect(warnCallsAfterPathChange).toHaveLength(2);
  });

  it('reloads the tree when library:changed affectsTree is true', async () => {
    renderNavigator({ coreDirectory: '/tmp/ws' });
    await flushAsyncWork();
    expect(listFilesMock).toHaveBeenCalledTimes(1);

    emitLibraryChanged({ timestamp: Date.now(), affectsTree: true });
    await flushAsyncWork();

    expect(listFilesMock).toHaveBeenCalledTimes(2);
  });

  it('does not reload the tree when library:changed affectsTree is false', async () => {
    renderNavigator({ coreDirectory: '/tmp/ws' });
    await flushAsyncWork();
    expect(listFilesMock).toHaveBeenCalledTimes(1);

    emitLibraryChanged({ timestamp: Date.now(), affectsTree: false });
    await flushAsyncWork();

    expect(listFilesMock).toHaveBeenCalledTimes(1);
  });
});
