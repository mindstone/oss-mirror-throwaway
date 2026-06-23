// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileNode } from '@shared/types';
import type { LibraryListFilesResponse, FileTreeMetadata } from '@shared/ipc/contracts';
import { useLibraryTree } from '../useLibraryTree';

const COMPLETE_METADATA: FileTreeMetadata = {
  complete: true,
  truncated: false,
  reasons: [],
  returnedNodes: 1,
  nodeLimit: 100_000,
  estimatedBytes: 0,
  byteLimit: 128 * 1024 * 1024,
  unavailableNodes: 0,
};

function wrap(nodes: FileNode[]): LibraryListFilesResponse {
  return { nodes, metadata: { ...COMPLETE_METADATA, returnedNodes: nodes.length } };
}

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

type HookValue = ReturnType<typeof useLibraryTree>;

describe('useLibraryTree', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: HookValue;
  let deferredLoads: Array<Deferred<LibraryListFilesResponse>>;

  function Probe({ coreDirectory }: { coreDirectory: string }) {
    latest = useLibraryTree({ emitLog: vi.fn(), coreDirectory });
    return null;
  }

  beforeEach(() => {
    deferredLoads = [];
    Object.defineProperty(window, 'libraryApi', {
      configurable: true,
      value: {
        listFiles: vi.fn(() => {
          const deferred = createDeferred<LibraryListFilesResponse>();
          deferredLoads.push(deferred);
          return deferred.promise;
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
    vi.clearAllMocks();
  });

  it('ignores a stale tree response after the workspace changes', async () => {
    const treeA: FileNode[] = [
      { name: 'a.md', path: '/A/a.md', kind: 'file' },
    ];
    const treeB: FileNode[] = [
      { name: 'b.md', path: '/B/b.md', kind: 'file' },
    ];

    act(() => {
      root.render(<Probe coreDirectory="/A" />);
    });
    act(() => {
      void latest.loadTree();
    });

    expect(deferredLoads).toHaveLength(1);

    act(() => {
      root.render(<Probe coreDirectory="/B" />);
    });
    act(() => {
      void latest.loadTree();
    });

    expect(deferredLoads).toHaveLength(2);

    await act(async () => {
      deferredLoads[0].resolve(wrap(treeA));
      await Promise.resolve();
    });

    expect(latest.tree).toBeNull();
    expect(latest.error).toBeNull();

    await act(async () => {
      deferredLoads[1].resolve(wrap(treeB));
      await Promise.resolve();
    });

    expect(latest.tree).toEqual(treeB);
    expect(latest.tree).not.toEqual(treeA);
  });
});
