// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAtlasProjection, type AtlasNode } from '../useAtlasProjection';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ProjectionState = ReturnType<typeof useAtlasProjection>;
type FileNeighborsProgress = { filled: number; total: number };
type FileNeighborsComplete = { filled: number; total: number; failed?: number; aborted?: boolean };

function makeProjectionResponse(neighbors: AtlasNode['neighbors'] | undefined = undefined) {
  return makeProjectionResponseForPaths(['/workspace/a.md', '/workspace/b.md'], neighbors);
}

function makeProjectionResponseForPaths(
  paths: string[],
  neighbors: AtlasNode['neighbors'] | undefined = undefined,
) {
  return {
    nodes: paths.map((path, index) => ({
      path,
      relativePath: path.replace('/workspace/', ''),
      x: index,
      y: index,
      z: index,
      extension: 'md',
      chunkCount: 1,
      embedding: index === 0 ? [1, 0, 0] : [0, 1, 0],
      neighbors,
    })),
    clusters: [],
    totalFileCount: paths.length,
    cached: false,
    computedAt: Date.now(),
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('useAtlasProjection neighborhood hydration', () => {
  let container: HTMLDivElement;
  let root: Root;
  let progressListeners: Array<(event: FileNeighborsProgress) => void>;
  let completeListeners: Array<(event: FileNeighborsComplete) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    progressListeners = [];
    completeListeners = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        onFileNeighborsProgress: (callback: (event: FileNeighborsProgress) => void) => {
          progressListeners.push(callback);
          return () => {
            progressListeners = progressListeners.filter(listener => listener !== callback);
          };
        },
        onFileNeighborsComplete: (callback: (event: FileNeighborsComplete) => void) => {
          completeListeners.push(callback);
          return () => {
            completeListeners = completeListeners.filter(listener => listener !== callback);
          };
        },
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('paints projection nodes first, then hydrates neighbors after the debounce', async () => {
    const atlasProjection = vi.fn().mockResolvedValue(makeProjectionResponse());
    const atlasNeighborhood = vi.fn(async (request: { generation: number }) => ({
      generation: request.generation,
      neighbors: {
        '/workspace/a.md': [{ path: '/workspace/b.md', relativePath: 'b.md', score: 0.91 }],
        '/workspace/b.md': [{ path: '/workspace/a.md', relativePath: 'a.md', score: 0.91 }],
      },
      neighborsCoverage: { requested: 2, covered: 2, missing: 0 },
    }));

    Object.defineProperty(window, 'searchApi', {
      configurable: true,
      value: { atlasProjection, atlasNeighborhood },
    });

    const observed: ProjectionState[] = [];
    const Probe = () => {
      observed.push(useAtlasProjection({ includeEmbeddings: true }));
      return null;
    };

    await act(async () => {
      root.render(<Probe />);
      await flushPromises();
    });

    expect(observed.at(-1)?.nodes).toHaveLength(2);
    expect(observed.at(-1)?.nodes[0].embedding).toEqual([1, 0, 0]);
    expect(observed.at(-1)?.nodes[0].neighbors).toBeUndefined();
    expect(atlasNeighborhood).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(50);
      await flushPromises();
    });

    expect(atlasNeighborhood).toHaveBeenCalledWith({
      paths: ['/workspace/a.md', '/workspace/b.md'],
      limit: 5,
      generation: expect.any(Number),
    });
    expect(observed.at(-1)?.nodes[0].neighbors).toEqual([
      { path: '/workspace/b.md', similarity: 0.91 },
    ]);
    expect(observed.at(-1)?.neighborsLoading).toBe(false);
  });

  it('updates neighborsLoading from file_neighbors progress events', async () => {
    const atlasProjection = vi.fn().mockResolvedValue(makeProjectionResponse([]));
    const atlasNeighborhood = vi.fn();

    Object.defineProperty(window, 'searchApi', {
      configurable: true,
      value: { atlasProjection, atlasNeighborhood },
    });

    const observed: ProjectionState[] = [];
    const Probe = () => {
      observed.push(useAtlasProjection({ includeEmbeddings: true }));
      return null;
    };

    await act(async () => {
      root.render(<Probe />);
      await flushPromises();
    });

    expect(observed.at(-1)?.neighborsLoading).toBe(false);

    act(() => {
      progressListeners[0]({ filled: 1, total: 5 });
    });

    expect(observed.at(-1)?.neighborsLoading).toBe(true);

    act(() => {
      progressListeners[0]({ filled: 5, total: 5 });
    });

    expect(observed.at(-1)?.neighborsLoading).toBe(false);
  });

  it('re-fetches the neighborhood when file_neighbors complete broadcasts', async () => {
    const atlasProjection = vi.fn().mockResolvedValue(makeProjectionResponse([]));
    const atlasNeighborhood = vi.fn(async (request: { generation: number }) => ({
      generation: request.generation,
      neighbors: {
        '/workspace/a.md': [{ path: '/workspace/b.md', relativePath: 'b.md', score: 0.88 }],
      },
      neighborsCoverage: { requested: 2, covered: 1, missing: 1 },
    }));

    Object.defineProperty(window, 'searchApi', {
      configurable: true,
      value: { atlasProjection, atlasNeighborhood },
    });

    const observed: ProjectionState[] = [];
    const Probe = () => {
      observed.push(useAtlasProjection({ includeEmbeddings: true }));
      return null;
    };

    await act(async () => {
      root.render(<Probe />);
      await flushPromises();
    });

    expect(atlasNeighborhood).not.toHaveBeenCalled();

    act(() => {
      completeListeners[0]({ filled: 2, total: 2, failed: 0, aborted: false });
    });

    await act(async () => {
      vi.advanceTimersByTime(50);
      await flushPromises();
    });

    expect(atlasNeighborhood).toHaveBeenCalledTimes(1);
    expect(observed.at(-1)?.nodes[0].neighbors).toEqual([
      { path: '/workspace/b.md', similarity: 0.88 },
    ]);
  });

  it('preserves undefined neighbors for missing partial-coverage rows until the complete broadcast refetches them', async () => {
    const paths = Array.from({ length: 5 }, (_, index) => `/workspace/${index}.md`);
    const atlasProjection = vi.fn().mockResolvedValue(makeProjectionResponseForPaths(paths));
    const atlasNeighborhood = vi
      .fn()
      .mockImplementationOnce(async (request: { generation: number }) => ({
        generation: request.generation,
        neighbors: Object.fromEntries(paths.slice(0, 3).map((sourcePath, index) => [
          sourcePath,
          [{ path: paths[(index + 1) % paths.length], relativePath: `${(index + 1) % paths.length}.md`, score: 0.9 }],
        ])),
        neighborsCoverage: { requested: 5, covered: 3, missing: 2 },
      }))
      .mockImplementationOnce(async (request: { generation: number }) => ({
        generation: request.generation,
        neighbors: Object.fromEntries(paths.map((sourcePath, index) => [
          sourcePath,
          [{ path: paths[(index + 1) % paths.length], relativePath: `${(index + 1) % paths.length}.md`, score: 0.8 }],
        ])),
        neighborsCoverage: { requested: 5, covered: 5, missing: 0 },
      }));

    Object.defineProperty(window, 'searchApi', {
      configurable: true,
      value: { atlasProjection, atlasNeighborhood },
    });

    const observed: ProjectionState[] = [];
    const Probe = () => {
      observed.push(useAtlasProjection({ includeEmbeddings: true }));
      return null;
    };

    await act(async () => {
      root.render(<Probe />);
      await flushPromises();
    });

    await act(async () => {
      vi.advanceTimersByTime(50);
      await flushPromises();
    });

    expect(atlasNeighborhood).toHaveBeenCalledTimes(1);
    expect(observed.at(-1)?.nodes.filter(node => node.neighbors === undefined)).toHaveLength(2);
    expect(observed.at(-1)?.neighborsLoading).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(500);
      await flushPromises();
    });

    expect(atlasNeighborhood).toHaveBeenCalledTimes(1);

    act(() => {
      completeListeners[0]({ filled: 5, total: 5, failed: 0, aborted: false });
    });

    await act(async () => {
      vi.advanceTimersByTime(50);
      await flushPromises();
    });

    expect(atlasNeighborhood).toHaveBeenCalledTimes(2);
    expect(observed.at(-1)?.nodes.filter(node => node.neighbors === undefined)).toHaveLength(0);
    expect(observed.at(-1)?.neighborsLoading).toBe(false);
  });

  it('clears neighborsLoading when the server cancels a neighborhood request', async () => {
    const atlasProjection = vi.fn().mockResolvedValue(makeProjectionResponse());
    const atlasNeighborhood = vi.fn().mockResolvedValue(null);

    Object.defineProperty(window, 'searchApi', {
      configurable: true,
      value: { atlasProjection, atlasNeighborhood },
    });

    const observed: ProjectionState[] = [];
    const Probe = () => {
      observed.push(useAtlasProjection({ includeEmbeddings: true }));
      return null;
    };

    await act(async () => {
      root.render(<Probe />);
      await flushPromises();
    });

    expect(observed.at(-1)?.neighborsLoading).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(50);
      await flushPromises();
    });

    expect(atlasNeighborhood).toHaveBeenCalledTimes(1);
    expect(observed.at(-1)?.neighborsLoading).toBe(false);
  });
});
