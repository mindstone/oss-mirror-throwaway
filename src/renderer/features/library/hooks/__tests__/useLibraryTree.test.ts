// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@renderer/test-utils';
import type { FileNode } from '@shared/types';
import type { FileTreeMetadata } from '@shared/ipc/contracts';
import { useLibraryTree } from '../useLibraryTree';

function makeMetadata(overrides: Partial<FileTreeMetadata> = {}): FileTreeMetadata {
  return {
    complete: true,
    truncated: false,
    reasons: [],
    returnedNodes: 0,
    nodeLimit: 100_000,
    estimatedBytes: 0,
    byteLimit: 128 * 1024 * 1024,
    unavailableNodes: 0,
    ...overrides,
  };
}

function makeFile(name: string): FileNode {
  return { name, path: `/ws/${name}`, kind: 'file', mtime: 1 };
}

const listFilesMock = vi.fn();

beforeEach(() => {
  listFilesMock.mockReset();
  (window as unknown as { libraryApi: { listFiles: typeof listFilesMock } }).libraryApi = {
    listFiles: listFilesMock,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useLibraryTree — RC-1 Stage 2: never wipe a populated tree with an empty/incomplete scan', () => {
  const coreDirectory = '/ws';

  it('preserves a previously-loaded tree when a later scan returns empty+incomplete', async () => {
    const emitLog = vi.fn();
    const { result } = renderHook(() =>
      useLibraryTree({ emitLog, coreDirectory })
    );

    // First load: a healthy, complete, populated tree.
    listFilesMock.mockResolvedValueOnce({
      nodes: [makeFile('a.md'), makeFile('b.md')],
      metadata: makeMetadata({ returnedNodes: 2 }),
    });
    await act(async () => {
      await result.current.loadTree();
    });
    expect(result.current.tree?.map((n) => n.name)).toEqual(['a.md', 'b.md']);

    // Second load (e.g. a slow/degraded re-scan): empty AND incomplete.
    listFilesMock.mockResolvedValueOnce({
      nodes: [],
      metadata: makeMetadata({ complete: false, truncated: true, reasons: ['unavailable'], unavailableNodes: 1 }),
    });
    await act(async () => {
      await result.current.loadTree();
    });

    // The tree must NOT be blanked — the user still sees their files.
    expect(result.current.tree?.map((n) => n.name)).toEqual(['a.md', 'b.md']);
    // ...but the degraded metadata is surfaced for observability.
    expect(result.current.treeMetadata?.complete).toBe(false);
    expect(emitLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        message: 'Library scan returned empty+incomplete; preserving previously-loaded tree',
      }),
    );
  });

  it('DOES replace with an empty tree when the scan is empty but COMPLETE (genuinely empty workspace)', async () => {
    const emitLog = vi.fn();
    const { result } = renderHook(() => useLibraryTree({ emitLog, coreDirectory }));

    listFilesMock.mockResolvedValueOnce({
      nodes: [makeFile('a.md')],
      metadata: makeMetadata({ returnedNodes: 1 }),
    });
    await act(async () => {
      await result.current.loadTree();
    });
    expect(result.current.tree).toHaveLength(1);

    // A complete, empty result is the legitimate "workspace is now empty" case.
    listFilesMock.mockResolvedValueOnce({
      nodes: [],
      metadata: makeMetadata({ complete: true, returnedNodes: 0 }),
    });
    await act(async () => {
      await result.current.loadTree();
    });
    expect(result.current.tree).toEqual([]);
  });

  it('still updates to a non-empty partial result (newer data wins when it is not empty)', async () => {
    const emitLog = vi.fn();
    const { result } = renderHook(() => useLibraryTree({ emitLog, coreDirectory }));

    listFilesMock.mockResolvedValueOnce({
      nodes: [makeFile('a.md')],
      metadata: makeMetadata(),
    });
    await act(async () => {
      await result.current.loadTree();
    });

    // Partial but NON-empty: this is fresher data, so it should replace.
    listFilesMock.mockResolvedValueOnce({
      nodes: [makeFile('a.md'), makeFile('c.md')],
      metadata: makeMetadata({ complete: false, truncated: true, reasons: ['global-node-cap'], returnedNodes: 2 }),
    });
    await act(async () => {
      await result.current.loadTree();
    });
    expect(result.current.tree?.map((n) => n.name)).toEqual(['a.md', 'c.md']);
  });

  it('keeps the prior tree on a failed scan and still clears loading (spinner always exits)', async () => {
    const emitLog = vi.fn();
    const { result } = renderHook(() => useLibraryTree({ emitLog, coreDirectory }));

    listFilesMock.mockResolvedValueOnce({
      nodes: [makeFile('a.md')],
      metadata: makeMetadata(),
    });
    await act(async () => {
      await result.current.loadTree();
    });

    listFilesMock.mockRejectedValueOnce(new Error('scan blew up'));
    await act(async () => {
      await result.current.loadTree();
    });

    expect(result.current.tree?.map((n) => n.name)).toEqual(['a.md']);
    expect(result.current.error).toBe('scan blew up');
    expect(result.current.loading).toBe(false);
  });
});
