// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAtlasProjection } from '../useAtlasProjection';
import { useAtlasSemanticSearch } from '../useAtlasSemanticSearch';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeProjectionResponse() {
  return {
    nodes: [
      {
        path: '/workspace/first.md',
        relativePath: 'first.md',
        x: 0,
        y: 0,
        z: 0,
        extension: 'md',
        chunkCount: 1,
      },
      {
        path: '/workspace/second.md',
        relativePath: 'second.md',
        x: 1,
        y: 1,
        z: 1,
        extension: 'md',
        chunkCount: 2,
        embedding: [0.1, 0.2, 0.3],
      },
    ],
    clusters: [],
    totalFileCount: 2,
    cached: false,
    computedAt: Date.now(),
  };
}

describe('Atlas semantic availability checks', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('treats projection embeddings as available when any node contains an embedding', async () => {
    const atlasProjection = vi.fn().mockResolvedValue(makeProjectionResponse());

    Object.defineProperty(window, 'searchApi', {
      configurable: true,
      value: {
        atlasProjection,
      },
    });

    const observed: Array<{ hasEmbeddings: boolean }> = [];
    const Probe = () => {
      observed.push(useAtlasProjection({ includeEmbeddings: true }));
      return null;
    };

    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(atlasProjection).toHaveBeenCalledTimes(1);
    expect(observed.at(-1)?.hasEmbeddings).toBe(true);
  });

  it('runs semantic query embedding when later nodes have embeddings', async () => {
    vi.useFakeTimers();
    const atlasEmbedQuery = vi.fn().mockResolvedValue({ embedding: [0.5, 0.5, 0] });

    Object.defineProperty(window, 'searchApi', {
      configurable: true,
      value: {
        atlasEmbedQuery,
      },
    });

    const nodes = [
      {
        id: '/workspace/first.md',
        path: '/workspace/first.md',
        relativePath: 'first.md',
        name: 'first.md',
        x: 0,
        y: 0,
        z: 0,
        extension: 'md',
        chunkCount: 1,
      },
      {
        id: '/workspace/second.md',
        path: '/workspace/second.md',
        relativePath: 'second.md',
        name: 'second.md',
        x: 1,
        y: 1,
        z: 1,
        extension: 'md',
        chunkCount: 1,
        embedding: [0.1, 0.2, 0.3],
      },
    ];

    const observed: Array<{ hasSemanticResults: boolean }> = [];
    const Probe = () => {
      observed.push(useAtlasSemanticSearch({ nodes, searchQuery: 'second', debounceMs: 25 }));
      return null;
    };

    await act(async () => {
      root.render(<Probe />);
    });

    await act(async () => {
      vi.advanceTimersByTime(30);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(atlasEmbedQuery).toHaveBeenCalledTimes(1);
    expect(observed.at(-1)?.hasSemanticResults).toBe(true);
  });
});
