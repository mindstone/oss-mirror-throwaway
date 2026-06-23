// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { LibraryFilter } from '../../../types/lens';
import type { FileNode, MemoryHistoryEntry } from '@shared/types';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import type { SkillsScanResult } from '../../../hooks/useSkillsIndex';
import { FoldersView } from '../FoldersView';
import { SAMPLE_SPACES, SAMPLE_TREE, makeTreeViewProps } from '../viewFixtures';

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

const PERSONAL_SKILL_TREE: FileNode[] = [
  {
    name: 'Personal',
    path: '/workspace/Personal',
    kind: 'directory',
    children: [
      {
        name: 'skills',
        path: '/workspace/Personal/skills',
        kind: 'directory',
        children: [
          {
            name: 'foo',
            path: '/workspace/Personal/skills/foo',
            kind: 'directory',
            children: [
              {
                name: 'SKILL.md',
                path: '/workspace/Personal/skills/foo/SKILL.md',
                kind: 'file',
              },
            ],
          },
        ],
      },
    ],
  },
];

const SKILLS_FACET_DATA: SkillsScanResult = {
  totalCount: 2,
  groups: [
    {
      source: 'Chief-of-Staff',
      label: 'Chief-of-Staff',
      type: 'space',
      categories: {
        communication: [
          {
            name: 'respond-fast',
            relativePath: 'Personal/skills/foo/SKILL.md',
            absolutePath: '/workspace/Personal/skills/foo/SKILL.md',
            category: 'communication',
            hasFrontmatter: true,
          },
        ],
        research: [
          {
            name: 'investigate',
            relativePath: 'Chief-of-Staff/skills/meeting-prep/SKILL.md',
            absolutePath: '/workspace/Chief-of-Staff/skills/meeting-prep/SKILL.md',
            category: 'research',
            hasFrontmatter: true,
          },
        ],
      },
      count: 2,
    },
  ],
};

const MEMORY_FACET_ENTRIES: MemoryHistoryEntry[] = [
  {
    id: 'memory-chief',
    timestamp: Date.now() - 1_000,
    sessionId: 'session-chief',
    turnId: 'turn-chief',
    entity: 'Chief of Staff',
    visibility: 'private',
    action: 'created',
    summary: 'Chief memory',
    filePath: 'Chief-of-Staff/memory/weekly-summary.md',
  },
  {
    id: 'memory-work',
    timestamp: Date.now() - 2_000,
    sessionId: 'session-work',
    turnId: 'turn-work',
    entity: 'Mindstone',
    visibility: 'shared',
    action: 'updated',
    summary: 'Work memory',
    filePath: 'work/Mindstone/General/roadmap.md',
  },
];

describe('FoldersView', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
  });

  it('renders folder tree in everything mode', () => {
    mounted = mount(
      <FoldersView
        filter="everything"
        searchQuery=""
        tree={SAMPLE_TREE}
        treeViewProps={makeTreeViewProps()}
        spacesData={SAMPLE_SPACES}
      />,
    );

    expect(mounted.container.textContent).toContain('Folders');
    expect(mounted.container.querySelector('[data-testid="library-tree"]')).toBeTruthy();
  });

  it('keeps pinned section filter-aware (memory pin hidden under skills filter)', () => {
    mounted = mount(
      <FoldersView
        filter="skills"
        searchQuery=""
        tree={SAMPLE_TREE}
        treeViewProps={makeTreeViewProps()}
        spacesData={SAMPLE_SPACES}
        favoriteFilePaths={['/workspace/Chief-of-Staff/memory/weekly-summary.md']}
      />,
    );

    expect(mounted.container.textContent).not.toContain('Pinned');
    expect(mounted.container.textContent).not.toContain('weekly-summary.md');
  });

  it('renders pinned memory under memory filter', () => {
    mounted = mount(
      <FoldersView
        filter="memory"
        searchQuery=""
        tree={SAMPLE_TREE}
        treeViewProps={makeTreeViewProps()}
        spacesData={SAMPLE_SPACES}
        favoriteFilePaths={['/workspace/Chief-of-Staff/memory/weekly-summary.md']}
      />,
    );

    expect(mounted.container.textContent).toContain('Pinned');
    expect(mounted.container.textContent).toContain('weekly-summary.md');
  });

  it('keeps Personal/skills entries visible under the skills filter', () => {
    mounted = mount(
      <FoldersView
        filter="skills"
        searchQuery=""
        tree={PERSONAL_SKILL_TREE}
        treeViewProps={makeTreeViewProps({
          expandedDirectories: {
            '/workspace/Personal': true,
            '/workspace/Personal/skills': true,
            '/workspace/Personal/skills/foo': true,
          },
        })}
        spacesData={SAMPLE_SPACES}
      />,
    );

    expect(mounted.container.textContent).toContain('SKILL.md');
  });

  it('filters Personal/skills entries out under the memory filter', () => {
    mounted = mount(
      <FoldersView
        filter="memory"
        searchQuery=""
        tree={PERSONAL_SKILL_TREE}
        treeViewProps={makeTreeViewProps({
          expandedDirectories: {
            '/workspace/Personal': true,
            '/workspace/Personal/skills': true,
            '/workspace/Personal/skills/foo': true,
          },
        })}
        spacesData={SAMPLE_SPACES}
      />,
    );

    expect(mounted.container.textContent).not.toContain('SKILL.md');
    expect(mounted.container.querySelector('[data-testid="library-lens-empty-state"]')).toBeTruthy();
  });

  it('filters skills folders by category facet', () => {
    const mixedSkillsTree: FileNode[] = [
      ...PERSONAL_SKILL_TREE,
      {
        name: 'Chief-of-Staff',
        path: '/workspace/Chief-of-Staff',
        kind: 'directory',
        children: [
          {
            name: 'skills',
            path: '/workspace/Chief-of-Staff/skills',
            kind: 'directory',
            children: [
              {
                name: 'meeting-prep',
                path: '/workspace/Chief-of-Staff/skills/meeting-prep',
                kind: 'directory',
                children: [
                  {
                    name: 'SKILL.md',
                    path: '/workspace/Chief-of-Staff/skills/meeting-prep/SKILL.md',
                    kind: 'file',
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    mounted = mount(
      <FoldersView
        filter="skills"
        facet="communication"
        searchQuery=""
        tree={mixedSkillsTree}
        treeViewProps={makeTreeViewProps({
          expandedDirectories: {
            '/workspace/Personal': true,
            '/workspace/Personal/skills': true,
            '/workspace/Personal/skills/foo': true,
            '/workspace/Chief-of-Staff': true,
            '/workspace/Chief-of-Staff/skills': true,
            '/workspace/Chief-of-Staff/skills/meeting-prep': true,
          },
        })}
        spacesData={SAMPLE_SPACES}
        skillsData={SKILLS_FACET_DATA}
      />,
    );

    expect(mounted.container.textContent).toContain('foo');
    expect(mounted.container.textContent).not.toContain('meeting-prep');
  });

  it('filters memory folders by entity facet', () => {
    const memoryTree: FileNode[] = [
      {
        name: 'Chief-of-Staff',
        path: '/workspace/Chief-of-Staff',
        kind: 'directory',
        children: [
          {
            name: 'memory',
            path: '/workspace/Chief-of-Staff/memory',
            kind: 'directory',
            children: [
              {
                name: 'weekly-summary.md',
                path: '/workspace/Chief-of-Staff/memory/weekly-summary.md',
                kind: 'file',
              },
            ],
          },
        ],
      },
      {
        name: 'work',
        path: '/workspace/work',
        kind: 'directory',
        children: [
          {
            name: 'Mindstone',
            path: '/workspace/work/Mindstone',
            kind: 'directory',
            children: [
              {
                name: 'memory',
                path: '/workspace/work/Mindstone/memory',
                kind: 'directory',
                children: [
                  {
                    name: 'work.md',
                    path: '/workspace/work/Mindstone/memory/work.md',
                    kind: 'file',
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    mounted = mount(
      <FoldersView
        filter="memory"
        facet="Chief of Staff"
        searchQuery=""
        tree={memoryTree}
        treeViewProps={makeTreeViewProps({
          expandedDirectories: {
            '/workspace/Chief-of-Staff': true,
            '/workspace/Chief-of-Staff/memory': true,
            '/workspace/work': true,
            '/workspace/work/Mindstone': true,
            '/workspace/work/Mindstone/memory': true,
          },
        })}
        spacesData={SAMPLE_SPACES}
        memoryEntries={[
          ...MEMORY_FACET_ENTRIES,
          {
            id: 'memory-work-path',
            timestamp: Date.now() - 3_000,
            sessionId: 'session-work-path',
            turnId: 'turn-work-path',
            entity: 'Mindstone',
            visibility: 'shared',
            action: 'created',
            summary: 'Work memory file',
            filePath: 'work/Mindstone/memory/work.md',
          },
        ]}
      />,
    );

    expect(mounted.container.textContent).toContain('weekly-summary.md');
    expect(mounted.container.textContent).not.toContain('work.md');
  });

  it('filters spaces groups by type facet', () => {
    const spacesData: SpaceInfo[] = [
      {
        name: 'Chief-of-Staff',
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

    const spacesTree: FileNode[] = [
      { name: 'Chief-of-Staff', path: '/workspace/Chief-of-Staff', kind: 'directory', children: [] },
      { name: 'Mindstone', path: '/workspace/work/Mindstone', kind: 'directory', children: [] },
      { name: 'Launch', path: '/workspace/work/Mindstone/Launch', kind: 'directory', children: [] },
    ];

    mounted = mount(
      <FoldersView
        filter="spaces"
        facet="work"
        searchQuery=""
        tree={spacesTree}
        treeViewProps={makeTreeViewProps()}
        spacesData={spacesData}
      />,
    );

    expect(mounted.container.textContent).toContain('Mindstone');
    expect(mounted.container.textContent).not.toContain('Private');
    expect(mounted.container.textContent).not.toContain('Launch');
  });

  it('filters everything folders by kind facet', () => {
    mounted = mount(
      <FoldersView
        filter="everything"
        facet="documents"
        searchQuery=""
        tree={SAMPLE_TREE}
        treeViewProps={makeTreeViewProps({
          expandedDirectories: {
            '/workspace/Chief-of-Staff': true,
            '/workspace/Chief-of-Staff/memory': true,
            '/workspace/Chief-of-Staff/skills': true,
            '/workspace/Chief-of-Staff/skills/meeting-prep': true,
            '/workspace/work': true,
            '/workspace/work/Mindstone': true,
            '/workspace/work/Mindstone/General': true,
          },
        })}
        spacesData={SAMPLE_SPACES}
      />,
    );

    expect(mounted.container.textContent).toContain('roadmap.md');
    expect(mounted.container.textContent).not.toContain('weekly-summary.md');
    expect(mounted.container.textContent).not.toContain('SKILL.md');
  });

  it('renders unavailable configured Spaces instead of short-circuiting to empty state', () => {
    const unavailableSpace: SpaceInfo = {
      name: 'Research',
      path: 'work/Acme/Research',
      absolutePath: '/workspace/work/Acme/Research',
      type: 'project',
      isSymlink: false,
      hasReadme: false,
      status: 'ok',
      displayName: 'Acme — Research',
    };

    mounted = mount(
      <FoldersView
        filter="spaces"
        searchQuery=""
        tree={[]}
        treeViewProps={makeTreeViewProps()}
        spacesData={[unavailableSpace]}
      />,
    );

    expect(mounted.container.textContent).toContain('Acme — Research');
    expect(mounted.container.textContent).toContain('Unavailable');
    expect(mounted.container.querySelector('[data-testid="library-lens-empty-state"]')).toBeNull();
  });

  it('filters unavailable Spaces by title when query is non-empty', () => {
    const unavailableSpace: SpaceInfo = {
      name: 'Research',
      path: 'work/Acme/Research',
      absolutePath: '/workspace/work/Acme/Research',
      type: 'project',
      isSymlink: false,
      hasReadme: false,
      status: 'ok',
      displayName: 'Acme — Research',
    };

    mounted = mount(
      <FoldersView
        filter="spaces"
        searchQuery="research"
        tree={[]}
        treeViewProps={makeTreeViewProps()}
        spacesData={[unavailableSpace]}
      />,
    );

    expect(mounted.container.textContent).toContain('Acme — Research');
    expect(mounted.container.querySelector('[data-testid="library-lens-empty-state"]')).toBeNull();

    mounted.unmount();
    mounted = mount(
      <FoldersView
        filter="spaces"
        searchQuery="finance"
        tree={[]}
        treeViewProps={makeTreeViewProps()}
        spacesData={[unavailableSpace]}
      />,
    );

    expect(mounted.container.textContent).not.toContain('Acme — Research');
    expect(mounted.container.querySelector('[data-testid="library-lens-empty-state"]')).toBeTruthy();
  });

  it('keeps unavailable Spaces visible when query is empty', () => {
    const unavailableSpace: SpaceInfo = {
      name: 'Research',
      path: 'work/Acme/Research',
      absolutePath: '/workspace/work/Acme/Research',
      type: 'project',
      isSymlink: false,
      hasReadme: false,
      status: 'ok',
      displayName: 'Acme — Research',
    };

    mounted = mount(
      <FoldersView
        filter="spaces"
        searchQuery=""
        tree={[]}
        treeViewProps={makeTreeViewProps()}
        spacesData={[unavailableSpace]}
      />,
    );

    expect(mounted.container.textContent).toContain('Acme — Research');
    expect(mounted.container.querySelector('[data-testid="library-lens-empty-state"]')).toBeNull();
  });

  it('renders space group trees from space children (without repeating the space root node)', () => {
    const spacesData: SpaceInfo[] = [
      {
        name: 'Chief-of-Staff',
        path: 'Chief-of-Staff',
        absolutePath: '/workspace/Chief-of-Staff',
        type: 'chief-of-staff',
        isSymlink: false,
        hasReadme: true,
        status: 'ok',
        displayName: 'Private',
      },
    ];
    const spacesTree: FileNode[] = [
      {
        name: 'Chief-of-Staff',
        path: '/workspace/Chief-of-Staff',
        kind: 'directory',
        children: [
          {
            name: 'notes.md',
            path: '/workspace/Chief-of-Staff/notes.md',
            kind: 'file',
          },
        ],
      },
    ];

    mounted = mount(
      <FoldersView
        filter="spaces"
        searchQuery=""
        tree={spacesTree}
        treeViewProps={makeTreeViewProps()}
        spacesData={spacesData}
      />,
    );

    expect(mounted.container.querySelector('[data-path="/workspace/Chief-of-Staff"]')).toBeNull();
    expect(mounted.container.querySelector('[data-path="/workspace/Chief-of-Staff/notes.md"]')).toBeTruthy();
  });

  it.each<LibraryFilter>(['spaces', 'skills', 'memory', 'everything'])(
    'renders without crashing for filter=%s (matrix coverage: folders view)',
    (filter) => {
      mounted = mount(
        <FoldersView
          filter={filter}
          searchQuery=""
          tree={SAMPLE_TREE}
          treeViewProps={makeTreeViewProps()}
          spacesData={SAMPLE_SPACES}
          favoriteFilePaths={['/workspace/Chief-of-Staff/memory/weekly-summary.md']}
        />,
      );
      expect(mounted.container.querySelector('[data-testid="library-lens-empty-state"]') || mounted.container.textContent).toBeTruthy();
      mounted.unmount();
      mounted = null;
    },
  );
});
