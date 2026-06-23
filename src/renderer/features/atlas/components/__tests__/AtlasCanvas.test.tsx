// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasCanvas } from '../AtlasCanvas';
import type { AtlasNode } from '../../hooks/useAtlasProjection';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const forceGraphState = vi.hoisted(() => ({
  latestProps: null as null | { graphData?: { nodes: Array<Record<string, unknown>>; links: unknown[] } },
  d3ReheatSimulation: vi.fn(),
  zoomToFit: vi.fn(),
}));

vi.mock('react-force-graph-3d', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  return {
    default: ReactActual.forwardRef((props: { graphData?: unknown }, ref) => {
      forceGraphState.latestProps = props as typeof forceGraphState.latestProps;
      ReactActual.useImperativeHandle(ref, () => ({
        graphData: () => props.graphData,
        d3ReheatSimulation: forceGraphState.d3ReheatSimulation,
        zoomToFit: forceGraphState.zoomToFit,
        d3Force: () => ({
          distance: () => undefined,
          strength: () => undefined,
          distanceMax: () => undefined,
        }),
        renderer: () => ({
          dispose: () => undefined,
          forceContextLoss: () => undefined,
        }),
      }));
      return ReactActual.createElement('div', { 'data-testid': 'force-graph-3d' });
    }),
  };
});

vi.mock('react-force-graph-2d', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  return {
    default: ReactActual.forwardRef((props: { graphData?: unknown }, ref) => {
      forceGraphState.latestProps = props as typeof forceGraphState.latestProps;
      ReactActual.useImperativeHandle(ref, () => ({
        graphData: () => props.graphData,
        d3ReheatSimulation: forceGraphState.d3ReheatSimulation,
        zoomToFit: forceGraphState.zoomToFit,
        d3Force: () => ({
          distance: () => undefined,
          strength: () => undefined,
          distanceMax: () => undefined,
        }),
      }));
      return ReactActual.createElement('div', { 'data-testid': 'force-graph-2d' });
    }),
  };
});

class ResizeObserverMock {
  observe(): void {}
  disconnect(): void {}
}

function makeNodes(neighbors: AtlasNode['neighbors'] | undefined): AtlasNode[] {
  return [
    {
      id: '/workspace/a.md',
      path: '/workspace/a.md',
      relativePath: 'a.md',
      name: 'a.md',
      x: 0,
      y: 0,
      z: 0,
      extension: 'md',
      chunkCount: 1,
      neighbors,
    },
    {
      id: '/workspace/b.md',
      path: '/workspace/b.md',
      relativePath: 'b.md',
      name: 'b.md',
      x: 1,
      y: 1,
      z: 1,
      extension: 'md',
      chunkCount: 1,
      neighbors,
    },
  ];
}

describe('AtlasCanvas neighborhood hydration physics', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock;
    forceGraphState.latestProps = null;
    forceGraphState.d3ReheatSimulation.mockClear();
    forceGraphState.zoomToFit.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('pins nodes until all neighborhood edges are hydrated, then unpins and reheats', async () => {
    await act(async () => {
      root.render(<AtlasCanvas nodes={makeNodes(undefined)} is3D />);
      await Promise.resolve();
    });

    const pinnedNodes = forceGraphState.latestProps?.graphData?.nodes ?? [];
    expect(pinnedNodes).toHaveLength(2);
    expect(pinnedNodes[0]).toMatchObject({ fx: 0, fy: 0, fz: 0 });
    expect(pinnedNodes[1]).toMatchObject({ fx: 100, fy: 100, fz: 100 });

    await act(async () => {
      root.render(
        <AtlasCanvas
          nodes={makeNodes([{ path: '/workspace/b.md', similarity: 0.91 }])}
          is3D
        />,
      );
      await Promise.resolve();
    });

    const unpinnedNodes = forceGraphState.latestProps?.graphData?.nodes ?? [];
    expect(unpinnedNodes[0]).not.toHaveProperty('fx');
    expect(unpinnedNodes[0]).not.toHaveProperty('fy');
    expect(unpinnedNodes[0]).not.toHaveProperty('fz');
    expect(forceGraphState.d3ReheatSimulation).toHaveBeenCalled();
  });
});
