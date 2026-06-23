import type { Meta, StoryObj } from '@storybook/react';
import type { ReactNode } from 'react';
import { AtlasView } from './AtlasView';
import { SAMPLE_ATLAS_NODES, SAMPLE_SPACES } from './viewFixtures';

const meta = {
  title: 'Library/Views/Atlas View',
  component: AtlasView,
  parameters: {
    layout: 'padded',
    controls: { disable: true },
  },
} satisfies Meta<typeof AtlasView>;

export default meta;
type Story = StoryObj<typeof meta>;

function ensureLibraryApiMock(indexedFileCount = SAMPLE_ATLAS_NODES.length) {
  const win = window as Window & {
    libraryApi?: {
      scanSpaces?: () => Promise<{
        success: boolean;
        spaces: typeof SAMPLE_SPACES;
      }>;
    };
    searchApi?: {
      indexStatus?: () => Promise<{
        totalFiles: number;
        indexedFiles: number;
        pendingFiles: number;
        lastIndexedAt: number | null;
        isWatching: boolean;
        workspacePath: string | null;
        indexState: 'not_started' | 'watching' | 'paused';
        totalChunks: number;
        enhancedChunks: number;
        enhancementRunning: boolean;
        enhancementPaused: boolean;
      }>;
    };
  };

  if (!win.libraryApi) {
    win.libraryApi = {};
  }
  if (!win.searchApi) {
    win.searchApi = {};
  }
  win.libraryApi.scanSpaces = async () => ({
    success: true,
    spaces: SAMPLE_SPACES,
  });
  win.searchApi.indexStatus = async () => ({
    totalFiles: indexedFileCount,
    indexedFiles: indexedFileCount,
    pendingFiles: 0,
    lastIndexedAt: Date.now(),
    isWatching: true,
    workspacePath: '/workspace',
    indexState: 'watching',
    totalChunks: indexedFileCount * 3,
    enhancedChunks: indexedFileCount * 3,
    enhancementRunning: false,
    enhancementPaused: false,
  });
}

function ThemePair({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', width: 980, maxWidth: '100%' }}>
      <div className="light">{children}</div>
      <div className="dark">{children}</div>
    </div>
  );
}

const baseProjection = {
  nodes: [...SAMPLE_ATLAS_NODES],
  clusters: [],
  totalFileCount: SAMPLE_ATLAS_NODES.length,
  isLoading: false,
  isComputing: false,
  error: null,
  cached: true,
  computedAt: Date.now(),
  hasEmbeddings: false,
  refetch: () => undefined,
} as const;

export const Default: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Semantic Atlas rendered as a 3D draggable map.',
      },
    },
  },
  render: () => {
    ensureLibraryApiMock();
    return (
      <ThemePair>
        <AtlasView
          filter="everything"
          searchQuery=""
          coreDirectory="/workspace"
          projectionOverride={baseProjection}
        />
      </ThemePair>
    );
  },
};

export const Sparse: Story = {
  render: () => {
    ensureLibraryApiMock();
    return (
      <ThemePair>
        <AtlasView
          filter="skills"
          searchQuery=""
          coreDirectory="/workspace"
          projectionOverride={baseProjection}
        />
      </ThemePair>
    );
  },
};

export const EmptyLibrary: Story = {
  render: () => {
    ensureLibraryApiMock(0);
    return (
      <ThemePair>
        <AtlasView
          filter="everything"
          searchQuery=""
          coreDirectory="/workspace"
          projectionOverride={{
            ...baseProjection,
            nodes: [],
            totalFileCount: 0,
          }}
        />
      </ThemePair>
    );
  },
};

export const DrawingFirstMap: Story = {
  render: () => {
    ensureLibraryApiMock(12);
    return (
      <ThemePair>
        <AtlasView
          filter="everything"
          searchQuery=""
          coreDirectory="/workspace"
          projectionOverride={{
            ...baseProjection,
            nodes: [],
            totalFileCount: 0,
          }}
        />
      </ThemePair>
    );
  },
};

export const SearchNoResults: Story = {
  render: () => {
    ensureLibraryApiMock();
    return (
      <ThemePair>
        <AtlasView
          filter="everything"
          searchQuery="query-that-is-not-here"
          coreDirectory="/workspace"
          projectionOverride={baseProjection}
        />
      </ThemePair>
    );
  },
};

export const ErrorAndLoading: Story = {
  render: () => {
    ensureLibraryApiMock(0);
    return (
      <ThemePair>
        <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <AtlasView
            filter="everything"
            searchQuery=""
            coreDirectory="/workspace"
            projectionOverride={{
              ...baseProjection,
              nodes: [],
              totalFileCount: 0,
              isLoading: true,
            }}
          />
          <AtlasView
            filter="everything"
            searchQuery=""
            coreDirectory="/workspace"
            projectionOverride={{
              ...baseProjection,
              nodes: [],
              totalFileCount: 0,
              error: 'Atlas backend unavailable.',
            }}
          />
        </div>
      </ThemePair>
    );
  },
};
