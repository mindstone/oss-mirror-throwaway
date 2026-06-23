// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryFilter } from '../../../types/lens';
import type { IndexStatus } from '../../../hooks/useSemanticSearch';
import { AtlasView } from '../AtlasView';

const baseNodes = [
  {
    id: '/workspace/Chief-of-Staff/memory/weekly-summary.md',
    path: '/workspace/Chief-of-Staff/memory/weekly-summary.md',
    relativePath: 'Chief-of-Staff/memory/weekly-summary.md',
    name: 'weekly-summary.md',
    x: 0.1,
    y: 0.2,
    z: 0.3,
    extension: 'md',
    chunkCount: 3,
    mtime: 1716441000000,
  },
  {
    id: '/workspace/work/Mindstone/General/roadmap.md',
    path: '/workspace/work/Mindstone/General/roadmap.md',
    relativePath: 'work/Mindstone/General/roadmap.md',
    name: 'roadmap.md',
    x: 0.2,
    y: 0.3,
    z: 0.4,
    extension: 'md',
    chunkCount: 5,
    mtime: 1716443000000,
  },
  {
    id: '/workspace/Chief-of-Staff/skills/meeting-prep/SKILL.md',
    path: '/workspace/Chief-of-Staff/skills/meeting-prep/SKILL.md',
    relativePath: 'Chief-of-Staff/skills/meeting-prep/SKILL.md',
    name: 'SKILL.md',
    x: 0.4,
    y: 0.1,
    z: 0.2,
    extension: 'md',
    chunkCount: 4,
    mtime: 1716442000000,
  },
];

const PERSONAL_SKILL_PATH = '/workspace/Personal/skills/foo/SKILL.md';
const ATLAS_INDEXING_DESCRIPTION =
  'Rebel is plotting your files so Atlas can show how they relate. The first map usually takes a few minutes for a moderate library; future Atlas opens are instant.';

function makeIndexStatus(overrides: Partial<IndexStatus> = {}): IndexStatus {
  return {
    totalFiles: baseNodes.length,
    indexedFiles: baseNodes.length,
    pendingFiles: 0,
    lastIndexedAt: Date.now(),
    isWatching: true,
    workspacePath: '/workspace',
    indexState: 'watching',
    totalChunks: 12,
    enhancedChunks: 12,
    enhancementRunning: false,
    enhancementPaused: false,
    ...overrides,
  };
}

let canvasProps: Record<string, unknown> | null = null;
let projectionState = {
  nodes: [...baseNodes],
  clusters: [],
  totalFileCount: baseNodes.length,
  isLoading: false,
  isComputing: false,
  error: null as string | null,
  cached: true,
  computedAt: Date.now(),
  hasEmbeddings: false,
  neighborsLoading: false,
  refetch: vi.fn(),
};
let indexStatusState: IndexStatus | null = makeIndexStatus();

vi.mock('../../../../atlas/components/AtlasCanvas', () => ({
  AtlasCanvas: (props: Record<string, unknown>) => {
    canvasProps = props;
    return <div data-testid="atlas-canvas-mock">atlas-canvas</div>;
  },
}));

vi.mock('../../../../atlas/hooks/useAtlasProjection', () => ({
  useAtlasProjection: () => projectionState,
}));

vi.mock('../../../../atlas/hooks/useAtlasSemanticSearch', () => ({
  useAtlasSemanticSearch: () => ({
    matches: [],
    matchPaths: new Set<string>(),
    neighborPaths: new Set<string>(),
    isSearching: false,
    queryEmbedding: null,
    hasSemanticResults: false,
  }),
}));

vi.mock('../../../../atlas/hooks/useAtlasSpaces', () => ({
  useAtlasSpaces: () => ({
    spaceColorMap: new Map<string, string>(),
    spaceNameMap: new Map<string, string>([
      ['/workspace/Chief-of-Staff/memory/weekly-summary.md', 'Private'],
      ['/workspace/work/Mindstone/General/roadmap.md', 'Mindstone — General'],
      ['/workspace/Chief-of-Staff/skills/meeting-prep/SKILL.md', 'Private'],
    ]),
    legend: [],
    systemPaths: new Set<string>(),
    isLoading: false,
  }),
}));

vi.mock('../../../hooks/useSemanticSearch', () => ({
  useSemanticSearch: () => ({
    indexStatus: indexStatusState,
  }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('AtlasView', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    canvasProps = null;
    projectionState = {
      nodes: [...baseNodes],
      clusters: [],
      totalFileCount: baseNodes.length,
      isLoading: false,
      isComputing: false,
      error: null,
      cached: true,
      computedAt: Date.now(),
      hasEmbeddings: false,
      neighborsLoading: false,
      refetch: vi.fn(),
    };
    indexStatusState = makeIndexStatus();
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders atlas canvas in everything mode', () => {
    mounted = mount(
      <AtlasView
        filter="everything"
        searchQuery=""
        coreDirectory="/workspace"
      />,
    );

    expect(mounted.container.querySelector('[data-testid="atlas-canvas-mock"]')).toBeTruthy();
    expect(canvasProps?.is3D).toBe(true);
    expect(canvasProps?.hiddenPaths).toBeInstanceOf(Set);
  });

  it('shows an unobtrusive relationship-loading indicator while neighbors hydrate', () => {
    projectionState = {
      ...projectionState,
      neighborsLoading: true,
    };

    mounted = mount(
      <AtlasView
        filter="everything"
        searchQuery=""
        coreDirectory="/workspace"
      />,
    );

    expect(mounted.container.querySelector('[data-testid="atlas-canvas-mock"]')).toBeTruthy();
    expect(mounted.container.textContent).toContain('Computing relationships…');
  });

  it('shows first-map copy when Atlas has no nodes but indexed files exist', () => {
    projectionState = {
      ...projectionState,
      nodes: [],
      totalFileCount: 0,
    };
    indexStatusState = makeIndexStatus({
      totalFiles: 8,
      indexedFiles: 8,
    });

    mounted = mount(
      <AtlasView
        filter="everything"
        searchQuery=""
        coreDirectory="/workspace"
      />,
    );

    expect(mounted.container.querySelector('[data-testid="atlas-canvas-mock"]')).toBeNull();
    expect(mounted.container.textContent).toContain('Drawing the first map');
    expect(mounted.container.querySelector('.empty-state__sub')?.textContent)
      .toBe(ATLAS_INDEXING_DESCRIPTION);
    expect(mounted.container.textContent).not.toContain('Your Library is empty.');
  });

  it('shows first-map copy while Atlas index status is still loading', () => {
    projectionState = {
      ...projectionState,
      nodes: [],
      totalFileCount: 0,
    };
    indexStatusState = null;

    mounted = mount(
      <AtlasView
        filter="everything"
        searchQuery=""
        coreDirectory="/workspace"
      />,
    );

    expect(mounted.container.querySelector('[data-testid="atlas-canvas-mock"]')).toBeNull();
    expect(mounted.container.textContent).toContain('Drawing the first map');
    expect(mounted.container.querySelector('.empty-state__sub')?.textContent)
      .toBe(ATLAS_INDEXING_DESCRIPTION);
    expect(mounted.container.textContent).not.toContain('Your Library is empty.');
  });

  it('keeps empty-library copy when Atlas has no nodes and no indexed files', () => {
    projectionState = {
      ...projectionState,
      nodes: [],
      totalFileCount: 0,
    };
    indexStatusState = makeIndexStatus({
      totalFiles: 0,
      indexedFiles: 0,
    });

    mounted = mount(
      <AtlasView
        filter="everything"
        searchQuery=""
        coreDirectory="/workspace"
      />,
    );

    expect(mounted.container.querySelector('[data-testid="atlas-canvas-mock"]')).toBeNull();
    expect(mounted.container.textContent).toContain('Your Library is empty.');
    expect(mounted.container.textContent).not.toContain('Drawing the first map');
  });

  it('shows sparse state when filtered graph has fewer than two nodes', () => {
    mounted = mount(
      <AtlasView
        filter="memory"
        searchQuery=""
        coreDirectory="/workspace"
      />,
    );

    expect(mounted.container.querySelector('[data-testid="atlas-canvas-mock"]')).toBeNull();
    expect(mounted.container.textContent).toContain('Not enough to map yet.');
  });

  it('keeps Personal/skills files visible under the skills filter', () => {
    projectionState = {
      ...projectionState,
      nodes: [
        {
          id: PERSONAL_SKILL_PATH,
          path: PERSONAL_SKILL_PATH,
          relativePath: 'Personal/skills/foo/SKILL.md',
          name: 'SKILL.md',
          x: 0.1,
          y: 0.2,
          z: 0.3,
          extension: 'md',
          chunkCount: 2,
          mtime: 1716441000000,
        },
        {
          id: '/workspace/skills/global/SKILL.md',
          path: '/workspace/skills/global/SKILL.md',
          relativePath: 'skills/global/SKILL.md',
          name: 'SKILL.md',
          x: 0.2,
          y: 0.1,
          z: 0.4,
          extension: 'md',
          chunkCount: 2,
          mtime: 1716442000000,
        },
        {
          id: '/workspace/Personal/memory/weekly.md',
          path: '/workspace/Personal/memory/weekly.md',
          relativePath: 'Personal/memory/weekly.md',
          name: 'weekly.md',
          x: 0.4,
          y: 0.3,
          z: 0.2,
          extension: 'md',
          chunkCount: 2,
          mtime: 1716443000000,
        },
        {
          id: '/workspace/work/Acme/Ops/memory/notes.md',
          path: '/workspace/work/Acme/Ops/memory/notes.md',
          relativePath: 'work/Acme/Ops/memory/notes.md',
          name: 'notes.md',
          x: 0.5,
          y: 0.4,
          z: 0.1,
          extension: 'md',
          chunkCount: 2,
          mtime: 1716444000000,
        },
      ],
      totalFileCount: 4,
    };

    mounted = mount(
      <AtlasView
        filter="skills"
        searchQuery=""
        coreDirectory="/workspace"
      />,
    );

    const hiddenPaths = canvasProps?.hiddenPaths as Set<string>;
    expect(mounted.container.querySelector('[data-testid="atlas-canvas-mock"]')).toBeTruthy();
    expect(hiddenPaths.has(PERSONAL_SKILL_PATH)).toBe(false);
  });

  it('filters Personal/skills files out under the memory filter', () => {
    projectionState = {
      ...projectionState,
      nodes: [
        {
          id: PERSONAL_SKILL_PATH,
          path: PERSONAL_SKILL_PATH,
          relativePath: 'Personal/skills/foo/SKILL.md',
          name: 'SKILL.md',
          x: 0.1,
          y: 0.2,
          z: 0.3,
          extension: 'md',
          chunkCount: 2,
          mtime: 1716441000000,
        },
        {
          id: '/workspace/skills/global/SKILL.md',
          path: '/workspace/skills/global/SKILL.md',
          relativePath: 'skills/global/SKILL.md',
          name: 'SKILL.md',
          x: 0.2,
          y: 0.1,
          z: 0.4,
          extension: 'md',
          chunkCount: 2,
          mtime: 1716442000000,
        },
        {
          id: '/workspace/Personal/memory/weekly.md',
          path: '/workspace/Personal/memory/weekly.md',
          relativePath: 'Personal/memory/weekly.md',
          name: 'weekly.md',
          x: 0.4,
          y: 0.3,
          z: 0.2,
          extension: 'md',
          chunkCount: 2,
          mtime: 1716443000000,
        },
        {
          id: '/workspace/work/Acme/Ops/memory/notes.md',
          path: '/workspace/work/Acme/Ops/memory/notes.md',
          relativePath: 'work/Acme/Ops/memory/notes.md',
          name: 'notes.md',
          x: 0.5,
          y: 0.4,
          z: 0.1,
          extension: 'md',
          chunkCount: 2,
          mtime: 1716444000000,
        },
      ],
      totalFileCount: 4,
    };

    mounted = mount(
      <AtlasView
        filter="memory"
        searchQuery=""
        coreDirectory="/workspace"
      />,
    );

    const hiddenPaths = canvasProps?.hiddenPaths as Set<string>;
    expect(mounted.container.querySelector('[data-testid="atlas-canvas-mock"]')).toBeTruthy();
    expect(hiddenPaths.has(PERSONAL_SKILL_PATH)).toBe(true);
  });

  it.each<LibraryFilter>(['spaces', 'skills', 'memory', 'everything'])(
    'renders without crashing for filter=%s (matrix coverage: atlas view)',
    (filter) => {
      mounted = mount(
        <AtlasView
          filter={filter}
          searchQuery=""
          coreDirectory="/workspace"
        />,
      );
      expect(
        mounted.container.querySelector('[data-testid="atlas-canvas-mock"]')
        || mounted.container.querySelector('[data-testid="library-lens-empty-state"]'),
      ).toBeTruthy();
      mounted.unmount();
      mounted = null;
    },
  );
});
