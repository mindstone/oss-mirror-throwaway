import type { Meta, StoryObj } from '@storybook/react';
import type { ReactNode } from 'react';
import type { FileNode, MemoryHistoryEntry } from '@shared/types';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import type { SkillsScanResult } from '../../hooks/useSkillsIndex';
import { CardsView } from './CardsView';
import {
  SAMPLE_ENTRIES,
  SAMPLE_SPACES,
  SAMPLE_SPACES_STATES,
  SAMPLE_SPACE_STATES_TREE,
} from './viewFixtures';

const meta = {
  title: 'Library/Views/Cards View',
  component: CardsView,
  parameters: {
    layout: 'padded',
    controls: { disable: true },
  },
} satisfies Meta<typeof CardsView>;

export default meta;
type Story = StoryObj<typeof meta>;

function ensureAuthMocks() {
  const win = window as Window & {
    api?: { onAuthStateChange?: (handler: (...args: unknown[]) => void) => (() => void) };
    authApi?: {
      getState: () => Promise<{ isAuthenticated: boolean; user: null; isLoading: boolean }>;
      login: () => Promise<void>;
      logout: () => Promise<void>;
    };
  };

  if (!win.api) {
    win.api = {
      onAuthStateChange: undefined,
    };
  }

  if (!win.authApi) {
    win.authApi = {
      getState: async () => ({ isAuthenticated: false, user: null, isLoading: false }),
      login: async () => undefined,
      logout: async () => undefined,
    };
  }
}

function ThemePair({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', width: 980, maxWidth: '100%' }}>
      <div className="light">{children}</div>
      <div className="dark">{children}</div>
    </div>
  );
}

const baseProps = {
  entries: SAMPLE_ENTRIES,
  spacesData: SAMPLE_SPACES,
  libraryRootAbsolute: '/workspace',
  onOpenPath: () => undefined,
  onUseSkillPath: () => undefined,
} as const;

const DENSE_MEMORY_ENTRIES: MemoryHistoryEntry[] = [
  {
    id: 'memory-dense-1',
    timestamp: 1_716_441_500_000,
    sessionId: 'session-memory-dense-1',
    turnId: 'turn-memory-dense-1',
    entity: 'Chief-of-Staff',
    visibility: 'private',
    action: 'created',
    summary:
      'A long memory summary that keeps going on purpose so we can verify card snippets clamp cleanly instead of spilling into action rows. This story intentionally includes enough detail to exercise four-line truncation and preserve a tidy card baseline.',
    filePath: 'Chief-of-Staff/memory/long-summary.md',
    sessionTitle: 'Quarterly planning sync',
    tags: [
      'strategy',
      'roadmap',
      'milestones',
      'dependencies',
      'budget',
      'staffing',
      'risks',
      'assumptions',
      'timeline',
      'comms',
      'handoff',
      'analytics',
      'research',
      'rollout',
      'review',
      'follow-up',
      'stakeholders',
      'launch',
      'metrics',
      'retro',
    ],
  } as MemoryHistoryEntry,
];

const FACET_SKILLS_DATA: SkillsScanResult = {
  totalCount: 3,
  groups: [
    {
      source: 'Chief-of-Staff',
      label: 'Chief-of-Staff',
      type: 'space',
      categories: {
        communication: [
          {
            name: 'reply-fast',
            relativePath: 'Chief-of-Staff/skills/reply-fast/SKILL.md',
            absolutePath: '/workspace/Chief-of-Staff/skills/reply-fast/SKILL.md',
            category: 'communication',
            hasFrontmatter: true,
          },
          {
            name: 'status-update',
            relativePath: 'Chief-of-Staff/skills/status-update/SKILL.md',
            absolutePath: '/workspace/Chief-of-Staff/skills/status-update/SKILL.md',
            category: 'communication',
            hasFrontmatter: true,
          },
        ],
        research: [
          {
            name: 'fact-check',
            relativePath: 'Chief-of-Staff/skills/fact-check/SKILL.md',
            absolutePath: '/workspace/Chief-of-Staff/skills/fact-check/SKILL.md',
            category: 'research',
            hasFrontmatter: true,
          },
        ],
      },
      count: 3,
    },
  ],
};

const FACET_MEMORY_ENTRIES: MemoryHistoryEntry[] = [
  {
    id: 'facet-memory-1',
    timestamp: 1_716_441_600_000,
    sessionId: 'session-facet-1',
    turnId: 'turn-facet-1',
    entity: 'Chief of Staff',
    visibility: 'private',
    action: 'created',
    summary: 'Chief memory note',
    filePath: 'Chief-of-Staff/memory/chief-memory.md',
  },
  {
    id: 'facet-memory-2',
    timestamp: 1_716_441_700_000,
    sessionId: 'session-facet-2',
    turnId: 'turn-facet-2',
    entity: 'Mindstone',
    visibility: 'shared',
    action: 'updated',
    summary: 'Mindstone memory note',
    filePath: 'work/Mindstone/memory/mindstone-memory.md',
  },
];

const FACET_SPACE_DATA: SpaceInfo[] = [
  {
    name: 'Private',
    path: 'Chief-of-Staff',
    absolutePath: '/workspace/Chief-of-Staff',
    type: 'chief-of-staff',
    isSymlink: false,
    hasReadme: true,
    status: 'ok',
    displayName: 'Private',
  },
  {
    name: 'Mindstone',
    path: 'work/Mindstone',
    absolutePath: '/workspace/work/Mindstone',
    type: 'company',
    isSymlink: false,
    hasReadme: true,
    status: 'ok',
    displayName: 'Mindstone',
  },
  {
    name: 'Launch',
    path: 'work/Mindstone/Launch',
    absolutePath: '/workspace/work/Mindstone/Launch',
    type: 'project',
    isSymlink: false,
    hasReadme: true,
    status: 'ok',
    displayName: 'Launch',
  },
];

const FACET_SPACE_TREE: FileNode[] = [
  {
    name: 'Chief-of-Staff',
    path: '/workspace/Chief-of-Staff',
    kind: 'directory',
    children: [],
  },
  {
    name: 'Mindstone',
    path: '/workspace/work/Mindstone',
    kind: 'directory',
    children: [],
  },
  {
    name: 'Launch',
    path: '/workspace/work/Mindstone/Launch',
    kind: 'directory',
    children: [],
  },
];

export const Default: Story = {
  render: () => {
    ensureAuthMocks();
    return (
      <ThemePair>
        <CardsView
          filter="everything"
          searchQuery=""
          sortBy="recent"
          {...baseProps}
        />
      </ThemePair>
    );
  },
};

export const Sparse: Story = {
  render: () => {
    ensureAuthMocks();
    return (
      <ThemePair>
        <CardsView
          filter="memory"
          searchQuery=""
          sortBy="modified"
          {...baseProps}
        />
      </ThemePair>
    );
  },
};

export const EmptyLibrary: Story = {
  render: () => (
    <ThemePair>
      <CardsView
        filter="everything"
        searchQuery=""
        sortBy="name"
        entries={[]}
        libraryRootAbsolute="/workspace"
      />
    </ThemePair>
  ),
};

export const SearchNoResults: Story = {
  render: () => {
    ensureAuthMocks();
    return (
      <ThemePair>
        <CardsView
          filter="skills"
          searchQuery="does-not-exist"
          sortBy="name"
          {...baseProps}
        />
      </ThemePair>
    );
  },
};

export const ErrorAndLoading: Story = {
  render: () => (
    <ThemePair>
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <CardsView
          filter="everything"
          searchQuery=""
          sortBy="name"
          entries={[]}
          libraryRootAbsolute="/workspace"
          loading
        />
        <CardsView
          filter="everything"
          searchQuery=""
          sortBy="name"
          entries={[]}
          libraryRootAbsolute="/workspace"
          error="Card index unavailable."
        />
      </div>
    </ThemePair>
  ),
};

export const MemoryDenseContent: Story = {
  render: () => (
    <ThemePair>
      <CardsView
        filter="memory"
        searchQuery=""
        sortBy="recent"
        memoryEntries={DENSE_MEMORY_ENTRIES}
        libraryRootAbsolute="/workspace"
      />
    </ThemePair>
  ),
};

export const LoadingSkills: Story = {
  render: () => (
    <ThemePair>
      <CardsView
        filter="skills"
        searchQuery=""
        sortBy="skill-most-used"
        skillsData={null}
        skillsLoading
        libraryRootAbsolute="/workspace"
      />
    </ThemePair>
  ),
};

export const LoadingMemory: Story = {
  render: () => (
    <ThemePair>
      <CardsView
        filter="memory"
        searchQuery=""
        sortBy="recent"
        memoryEntries={[]}
        memoryLoading
        libraryRootAbsolute="/workspace"
      />
    </ThemePair>
  ),
};

export const LoadingSpaces: Story = {
  render: () => (
    <ThemePair>
      <CardsView
        filter="spaces"
        searchQuery=""
        sortBy="space-last-active"
        spacesData={[]}
        spacesLoading
        libraryRootAbsolute="/workspace"
      />
    </ThemePair>
  ),
};

export const SpacesStates: Story = {
  render: () => (
    <ThemePair>
      <CardsView
        filter="spaces"
        searchQuery=""
        sortBy="space-last-active"
        spacesData={SAMPLE_SPACES_STATES}
        tree={SAMPLE_SPACE_STATES_TREE}
        libraryRootAbsolute="/workspace"
        onSetActiveSpace={() => undefined}
      />
    </ThemePair>
  ),
};

export const SkillsCommunicationFacet: Story = {
  render: () => (
    <ThemePair>
      <CardsView
        filter="skills"
        facet="communication"
        searchQuery=""
        sortBy="name"
        skillsData={FACET_SKILLS_DATA}
        libraryRootAbsolute="/workspace"
      />
    </ThemePair>
  ),
};

export const MemoryEntityFacet: Story = {
  render: () => (
    <ThemePair>
      <CardsView
        filter="memory"
        facet="Chief of Staff"
        searchQuery=""
        sortBy="recent"
        memoryEntries={FACET_MEMORY_ENTRIES}
        libraryRootAbsolute="/workspace"
      />
    </ThemePair>
  ),
};

export const SpacesTypeFacet: Story = {
  render: () => (
    <ThemePair>
      <CardsView
        filter="spaces"
        facet="work"
        searchQuery=""
        sortBy="space-last-active"
        spacesData={FACET_SPACE_DATA}
        tree={FACET_SPACE_TREE}
        libraryRootAbsolute="/workspace"
      />
    </ThemePair>
  ),
};
