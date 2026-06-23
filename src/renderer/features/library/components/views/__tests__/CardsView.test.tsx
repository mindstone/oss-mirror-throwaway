// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import type { SkillsScanResult } from '../../../hooks/useSkillsIndex';
import { CardsView } from '../CardsView';
import {
  SAMPLE_ENTRIES,
  SAMPLE_SPACES,
  SAMPLE_SPACES_STATES,
  SAMPLE_SPACE_STATES_TREE,
  SAMPLE_TREE,
} from '../viewFixtures';
import type { FileNode, MemoryHistoryEntry } from '@shared/types';
import type { LibraryViewEntry } from '../viewShared';

const resolveMemoryEntryPathMock = vi.hoisted(() => vi.fn());

const SAMPLE_SKILLS_DATA: SkillsScanResult = {
  totalCount: 1,
  groups: [
    {
      source: 'Chief-of-Staff',
      label: 'Chief-of-Staff',
      type: 'space',
      categories: {
        planning: [
          {
            name: 'meeting-prep',
            relativePath: 'Chief-of-Staff/skills/meeting-prep/SKILL.md',
            absolutePath: '/workspace/Chief-of-Staff/skills/meeting-prep/SKILL.md',
            category: 'planning',
            hasFrontmatter: true,
            frontmatter: { description: 'Meeting prep skill' },
          },
        ],
      },
      count: 1,
    },
  ],
};

vi.mock('../../SkillCard', () => ({
  SkillCard: ({
    fileName,
    onUseSkill,
  }: {
    fileName: string;
    onUseSkill?: () => void;
  }) => (
    <article data-testid="mock-skill-card">
      <span>{fileName}</span>
      <button type="button" data-testid="mock-use-skill" onClick={() => onUseSkill?.()}>
        Use This Skill
      </button>
    </article>
  ),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({
    count,
    estimateSize,
    gap = 0,
  }: {
    count: number;
    estimateSize: () => number;
    gap?: number;
  }) => {
    const rowHeight = estimateSize();
    return {
      getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
        index,
        key: `virtual-row-${index}`,
        start: index * (rowHeight + gap),
      })),
      getTotalSize: () => (count > 0 ? (count * rowHeight) + ((count - 1) * gap) : 0),
      measureElement: () => undefined,
    };
  },
}));

vi.mock('../../../utils/resolveMemoryEntryPath', () => ({
  resolveMemoryEntryPath: (...args: unknown[]) => resolveMemoryEntryPathMock(...args),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  rerender: (next: React.ReactElement) => void;
  unmount: () => void;
};

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  container.style.height = '320px';
  container.style.overflow = 'auto';
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    root,
    rerender: (next) => {
      act(() => {
        root.render(next);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function makeEverythingEntries(count: number): LibraryViewEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `/workspace/file-${index}.md`,
    name: `file-${index}.md`,
    path: `/workspace/file-${index}.md`,
    relativePath: `file-${index}.md`,
    kind: 'file',
    mtime: 1_716_441_000_000 + index,
    summary: `Summary ${index}`,
  }));
}

function getRenderedCardPaths(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-library-card-path]'))
    .map((element) => element.dataset.libraryCardPath)
    .filter((path): path is string => typeof path === 'string');
}

describe('CardsView', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    resolveMemoryEntryPathMock.mockReset();
    resolveMemoryEntryPathMock.mockResolvedValue(null);
    (window as unknown as {
      libraryApi: {
        statFile: ReturnType<typeof vi.fn>;
      };
    }).libraryApi = {
      statFile: vi.fn().mockResolvedValue({ exists: false, mtimeMs: null, size: null }),
    };
    (window as unknown as {
      memoryApi: { repairEntryPath: ReturnType<typeof vi.fn> };
    }).memoryApi = {
      repairEntryPath: vi.fn().mockResolvedValue({ success: true }),
    };
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
  });

  it('groups Skills cards by source when skills index data is provided', () => {
    const skillsData: SkillsScanResult = {
      totalCount: 2,
      groups: [
        {
          source: 'rebel-system',
          label: 'Rebel system',
          type: 'platform',
          categories: {
            writing: [
              {
                name: 'summarize-notes',
                relativePath: 'rebel-system/skills/writing/summarize-notes/SKILL.md',
                absolutePath: '/workspace/rebel-system/skills/writing/summarize-notes/SKILL.md',
                category: 'writing',
                hasFrontmatter: true,
                frontmatter: { description: 'Summaries' },
              },
            ],
          },
          count: 1,
        },
        {
          source: 'Chief-of-Staff',
          label: 'Chief-of-Staff',
          type: 'space',
          categories: {
            planning: [
              {
                name: 'weekly-plan',
                relativePath: 'Chief-of-Staff/skills/planning/weekly-plan/SKILL.md',
                absolutePath: '/workspace/Chief-of-Staff/skills/planning/weekly-plan/SKILL.md',
                category: 'planning',
                hasFrontmatter: true,
                frontmatter: { description: 'Planning' },
              },
            ],
          },
          count: 1,
        },
      ],
    };

    mounted = mount(
      <CardsView
        filter="skills"
        searchQuery=""
        sortBy="skill-most-used"
        skillsData={skillsData}
        libraryRootAbsolute="/workspace"
      />,
    );

    expect(mounted.container.textContent).toContain('Built-in');
    expect(mounted.container.textContent).toContain('Your skills');
    expect(mounted.container.querySelectorAll('[data-testid="mock-skill-card"]')).toHaveLength(2);
  });

  it('renders memory cards grouped by time buckets', () => {
    const now = Date.now();
    const memoryEntries: MemoryHistoryEntry[] = [
      {
        id: 'mem-today',
        timestamp: now - 60_000,
        sessionId: 'session-1',
        turnId: 'turn-1',
        entity: 'Chief-of-Staff',
        visibility: 'private',
        action: 'created',
        summary: 'Today memory',
        filePath: 'Chief-of-Staff/memory/today.md',
      },
      {
        id: 'mem-week',
        timestamp: now - (2 * 24 * 60 * 60 * 1000),
        sessionId: 'session-2',
        turnId: 'turn-2',
        entity: 'Chief-of-Staff',
        visibility: 'private',
        action: 'updated',
        summary: 'This week memory',
        filePath: 'Chief-of-Staff/memory/week.md',
      },
    ];

    mounted = mount(
      <CardsView
        filter="memory"
        searchQuery=""
        sortBy="recent"
        memoryEntries={memoryEntries}
        libraryRootAbsolute="/workspace"
        pendingMemoryRequests={[
          {
            toolUseId: 'tool-1',
            originalSessionId: 'session-123',
            filePath: '/workspace/Chief-of-Staff/memory/weekly-summary.md',
            spaceName: 'Chief-of-Staff',
            summary: 'Save weekly summary',
            content: '# weekly summary',
            timestamp: Date.now(),
          },
        ]}
      />,
    );

    expect(mounted.container.textContent).toContain('Today');
    expect(mounted.container.textContent).toContain('This week');
  });

  it('shows a memory-cap hint chip when 5,000 memories are loaded', () => {
    const memoryEntries: MemoryHistoryEntry[] = Array.from({ length: 5000 }, (_, index) => ({
      id: `mem-cap-${index}`,
      timestamp: Date.now() - index,
      sessionId: `session-${index}`,
      turnId: `turn-${index}`,
      entity: 'Chief-of-Staff',
      visibility: 'private',
      action: 'created',
      summary: `Memory ${index}`,
      filePath: `Chief-of-Staff/memory/memory-${index}.md`,
    }));

    mounted = mount(
      <CardsView
        filter="memory"
        searchQuery=""
        sortBy="recent"
        memoryEntries={memoryEntries}
        libraryRootAbsolute="/workspace"
      />,
    );

    expect(mounted.container.querySelector('[data-testid="cards-memory-cap-hint"]')).toBeTruthy();
    expect(mounted.container.textContent).toContain(
      'Showing the most recent 5,000 memories. Search reaches across all of them.',
    );
  });

  it('renders Spaces cards from spacesData (not generic file cards)', () => {
    mounted = mount(
      <CardsView
        filter="spaces"
        searchQuery=""
        sortBy="space-last-active"
        spacesData={SAMPLE_SPACES}
        tree={SAMPLE_TREE}
        libraryRootAbsolute="/workspace"
      />,
    );

    expect(mounted.container.querySelectorAll('[data-testid="cards-entry-space"]')).toHaveLength(2);
    expect(mounted.container.textContent).toContain('Open space');
    expect(mounted.container.textContent).not.toContain('weekly-summary.md');
  });

  it('uses setActiveSpace for the Space card Open space action', () => {
    const onSetActiveSpace = vi.fn();
    const onOpenPath = vi.fn();
    mounted = mount(
      <CardsView
        filter="spaces"
        searchQuery=""
        sortBy="space-last-active"
        spacesData={SAMPLE_SPACES}
        tree={SAMPLE_TREE}
        libraryRootAbsolute="/workspace"
        onSetActiveSpace={onSetActiveSpace}
        onOpenPath={onOpenPath}
      />,
    );

    const openSpaceButton = Array.from(mounted.container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Open space',
    );
    if (!(openSpaceButton instanceof HTMLButtonElement)) {
      throw new Error('Open space button not found');
    }

    act(() => {
      openSpaceButton.click();
    });

    expect(onSetActiveSpace).toHaveBeenCalledTimes(1);
    expect(['Chief-of-Staff', 'work/Mindstone/General']).toContain(onSetActiveSpace.mock.calls[0]?.[0]);
    expect(onOpenPath).not.toHaveBeenCalled();
    expect(mounted.container.textContent).not.toContain('Set active');
  });

  it('uses setActiveSpace for Space context-menu Open space and keeps manage actions', () => {
    const onSetActiveSpace = vi.fn();
    const onOpenPath = vi.fn();
    const onRenameSpace = vi.fn();
    const onDeleteSpace = vi.fn();
    mounted = mount(
      <CardsView
        filter="spaces"
        searchQuery=""
        sortBy="space-last-active"
        spacesData={SAMPLE_SPACES}
        tree={SAMPLE_TREE}
        libraryRootAbsolute="/workspace"
        onSetActiveSpace={onSetActiveSpace}
        onOpenPath={onOpenPath}
        onRenameSpace={onRenameSpace}
        onDeleteSpace={onDeleteSpace}
      />,
    );

    const spaceCardWrapper = mounted.container.querySelector('[data-testid="cards-entry-space"]');
    if (!(spaceCardWrapper instanceof HTMLElement)) {
      throw new Error('Space card wrapper not found');
    }

    act(() => {
      spaceCardWrapper.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        clientX: 16,
        clientY: 20,
      }));
    });

    const contextActions = Array.from(
      mounted.container.querySelectorAll('[data-testid="cards-context-menu"] button'),
    ).map((button) => button.textContent?.trim());

    expect(contextActions).toContain('Open space');
    expect(contextActions).not.toContain('Set active');
    expect(contextActions).toContain('Rename');
    expect(contextActions.some((label) => label === 'Remove space…' || label === 'Delete space…')).toBe(true);

    const openSpaceAction = Array.from(
      mounted.container.querySelectorAll('[data-testid="cards-context-menu"] button'),
    ).find((button) => button.textContent?.trim() === 'Open space');
    if (!(openSpaceAction instanceof HTMLButtonElement)) {
      throw new Error('Open space context action not found');
    }

    act(() => {
      openSpaceAction.click();
    });

    expect(onSetActiveSpace).toHaveBeenCalledTimes(1);
    expect(['Chief-of-Staff', 'work/Mindstone/General']).toContain(onSetActiveSpace.mock.calls[0]?.[0]);
    expect(onOpenPath).not.toHaveBeenCalled();
  });

  it('opens the Space when clicking the card body', () => {
    const onSetActiveSpace = vi.fn();
    mounted = mount(
      <CardsView
        filter="spaces"
        searchQuery=""
        sortBy="space-last-active"
        spacesData={SAMPLE_SPACES}
        tree={SAMPLE_TREE}
        libraryRootAbsolute="/workspace"
        onSetActiveSpace={onSetActiveSpace}
      />,
    );

    const firstSpaceCard = mounted.container.querySelector('[data-testid="cards-entry-space"] article');
    if (!(firstSpaceCard instanceof HTMLElement)) {
      throw new Error('Space card not found');
    }

    act(() => {
      firstSpaceCard.click();
    });

    expect(onSetActiveSpace).toHaveBeenCalledTimes(1);
    expect(['Chief-of-Staff', 'work/Mindstone/General']).toContain(onSetActiveSpace.mock.calls[0]?.[0]);
  });

  it('opens memory cards from card-body clicks and avoids double-fire on nested buttons', async () => {
    const onOpenPath = vi.fn();
    const memoryEntries: MemoryHistoryEntry[] = [
      {
        id: 'mem-card-open',
        timestamp: Date.now(),
        sessionId: 'session-1',
        turnId: 'turn-1',
        entity: 'Chief-of-Staff',
        visibility: 'private',
        action: 'created',
        summary: 'Memory card click behavior',
        filePath: 'Chief-of-Staff/memory/card-open.md',
      },
    ];

    mounted = mount(
      <CardsView
        filter="memory"
        searchQuery=""
        sortBy="recent"
        memoryEntries={memoryEntries}
        libraryRootAbsolute="/workspace"
        onOpenPath={onOpenPath}
      />,
    );

    const memoryCard = mounted.container.querySelector('[data-testid="cards-entry-memory"] article');
    if (!(memoryCard instanceof HTMLElement)) {
      throw new Error('Memory card not found');
    }
    await act(async () => {
      memoryCard.click();
    });
    expect(onOpenPath).toHaveBeenCalledTimes(1);

    const openMemoryButton = Array.from(mounted.container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Open memory',
    );
    if (!(openMemoryButton instanceof HTMLButtonElement)) {
      throw new Error('Open memory button not found');
    }
    await act(async () => {
      openMemoryButton.click();
    });
    expect(onOpenPath).toHaveBeenCalledTimes(2);
  });

  it('opens repaired memory paths when resolver finds a matching file', async () => {
    const onOpenPath = vi.fn();
    const repairEntryPath = vi.fn().mockResolvedValue({ success: true });
    (window as unknown as {
      memoryApi: { repairEntryPath: ReturnType<typeof vi.fn> };
    }).memoryApi = { repairEntryPath };
    resolveMemoryEntryPathMock.mockResolvedValue({
      absolutePath: '/workspace/chief-of-staff/memory/topics/card-open.md',
      workspaceRelative: 'chief-of-staff/memory/topics/card-open.md',
      repaired: true,
      effectiveRelativePath: 'chief-of-staff/memory/topics/card-open.md',
    });

    const memoryEntries: MemoryHistoryEntry[] = [
      {
        id: 'mem-card-open',
        timestamp: Date.now(),
        sessionId: 'session-1',
        turnId: 'turn-1',
        entity: 'Chief of Staff',
        visibility: 'private',
        action: 'created',
        summary: 'Memory card click behavior',
        filePath: 'memory/topics/card-open.md',
      },
    ];

    mounted = mount(
      <CardsView
        filter="memory"
        searchQuery=""
        sortBy="recent"
        memoryEntries={memoryEntries}
        spacesData={SAMPLE_SPACES}
        libraryRootAbsolute="/workspace"
        onOpenPath={onOpenPath}
      />,
    );

    const memoryCard = mounted.container.querySelector('[data-testid="cards-entry-memory"] article');
    if (!(memoryCard instanceof HTMLElement)) {
      throw new Error('Memory card not found');
    }

    await act(async () => {
      memoryCard.click();
    });

    expect(resolveMemoryEntryPathMock).toHaveBeenCalledWith(expect.objectContaining({
      recordedFilePath: 'memory/topics/card-open.md',
      entity: 'Chief of Staff',
      libraryRootAbsolute: '/workspace',
    }));
    expect(onOpenPath).toHaveBeenCalledWith('/workspace/chief-of-staff/memory/topics/card-open.md');
    expect(repairEntryPath).toHaveBeenCalledWith({
      entryId: 'mem-card-open',
      repairedFilePath: 'chief-of-staff/memory/topics/card-open.md',
    });
  });

  it('does not open cards when a text selection is active at click time', () => {
    const onOpenPath = vi.fn();
    const selectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      toString: () => 'selected memory text',
    } as Selection);
    const memoryEntries: MemoryHistoryEntry[] = [
      {
        id: 'mem-selection-guard',
        timestamp: Date.now(),
        sessionId: 'session-1',
        turnId: 'turn-1',
        entity: 'Chief-of-Staff',
        visibility: 'private',
        action: 'created',
        summary: 'Selection guard check',
        filePath: 'Chief-of-Staff/memory/selection-guard.md',
      },
    ];

    try {
      mounted = mount(
        <CardsView
          filter="memory"
          searchQuery=""
          sortBy="recent"
          memoryEntries={memoryEntries}
          libraryRootAbsolute="/workspace"
          onOpenPath={onOpenPath}
        />,
      );

      const memoryCard = mounted.container.querySelector('[data-testid="cards-entry-memory"] article');
      if (!(memoryCard instanceof HTMLElement)) {
        throw new Error('Memory card not found');
      }

      act(() => {
        memoryCard.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
      });

      expect(onOpenPath).not.toHaveBeenCalled();
    } finally {
      selectionSpy.mockRestore();
    }
  });

  it('opens file cards from card-body clicks and avoids double-fire on nested buttons', () => {
    const onOpenPath = vi.fn();
    mounted = mount(
      <CardsView
        filter="everything"
        searchQuery=""
        sortBy="recent"
        entries={SAMPLE_ENTRIES}
        libraryRootAbsolute="/workspace"
        onOpenPath={onOpenPath}
      />,
    );

    const fileCard = mounted.container.querySelector('[data-testid="cards-entry-file"] article');
    if (!(fileCard instanceof HTMLElement)) {
      throw new Error('File card not found');
    }

    act(() => {
      fileCard.click();
    });
    expect(onOpenPath).toHaveBeenCalledTimes(1);

    const openFileButton = Array.from(
      mounted.container.querySelectorAll('[data-testid="cards-entry-file"] button'),
    ).find((button) => button.textContent?.trim() === 'Open');
    if (!(openFileButton instanceof HTMLButtonElement)) {
      throw new Error('Open button not found');
    }
    act(() => {
      openFileButton.click();
    });
    expect(onOpenPath).toHaveBeenCalledTimes(2);
  });

  it('shows "Files unavailable" only once per unavailable Space card', () => {
    mounted = mount(
      <CardsView
        filter="spaces"
        searchQuery=""
        sortBy="space-last-active"
        spacesData={[
          {
            name: 'Detached Space',
            path: 'Detached Space',
            absolutePath: '/workspace/Detached Space',
            type: 'project',
            isSymlink: true,
            hasReadme: false,
            status: 'ok',
          },
        ]}
        tree={SAMPLE_TREE}
        libraryRootAbsolute="/workspace"
      />,
    );

    const textContent = mounted.container.textContent ?? '';
    const occurrences = textContent.match(/Files unavailable/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('renders skill, memory, and file cards in everything mode without space cards', () => {
    mounted = mount(
      <CardsView
        filter="everything"
        searchQuery=""
        sortBy="recent"
        entries={SAMPLE_ENTRIES}
        spacesData={SAMPLE_SPACES}
        libraryRootAbsolute="/workspace"
      />,
    );

    expect(mounted.container.querySelector('[data-testid="mock-skill-card"]')).toBeTruthy();
    expect(mounted.container.textContent).toContain('weekly-summary.md');
    expect(mounted.container.textContent).toContain('roadmap.md');
    expect(mounted.container.querySelector('[data-testid="cards-entry-space"]')).toBeNull();
  });

  it('keeps Everything lens results stable for representative queries', () => {
    const renderPathsForQuery = (query: string): string[] => {
      mounted?.unmount();
      mounted = mount(
        <CardsView
          filter="everything"
          searchQuery={query}
          sortBy="recent"
          entries={SAMPLE_ENTRIES}
          libraryRootAbsolute="/workspace"
        />,
      );
      return getRenderedCardPaths(mounted.container);
    };

    expect(renderPathsForQuery('ROADMAP')).toMatchInlineSnapshot(`
      [
        "/workspace/work/Mindstone/General/roadmap.md",
      ]
    `);
    expect(renderPathsForQuery('mindstone/general')).toMatchInlineSnapshot(`
      [
        "/workspace/work/Mindstone/General/roadmap.md",
      ]
    `);
    expect(renderPathsForQuery('highlights')).toMatchInlineSnapshot(`
      [
        "/workspace/Chief-of-Staff/memory/weekly-summary.md",
      ]
    `);
  });

  it('filters skills cards by facet category', () => {
    const skillsData: SkillsScanResult = {
      totalCount: 2,
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
          count: 2,
        },
      ],
    };

    mounted = mount(
      <CardsView
        filter="skills"
        facet="communication"
        searchQuery=""
        sortBy="name"
        skillsData={skillsData}
        libraryRootAbsolute="/workspace"
      />,
    );

    expect(mounted.container.textContent).toContain('reply-fast');
    expect(mounted.container.textContent).not.toContain('fact-check');
  });

  it('filters memory cards by facet entity', () => {
    const memoryEntries: MemoryHistoryEntry[] = [
      {
        id: 'mem-chief',
        timestamp: Date.now() - 1_000,
        sessionId: 'session-chief',
        turnId: 'turn-chief',
        entity: 'Chief of Staff',
        visibility: 'private',
        action: 'created',
        summary: 'Chief memory',
        filePath: 'Chief-of-Staff/memory/chief.md',
      },
      {
        id: 'mem-mindstone',
        timestamp: Date.now() - 2_000,
        sessionId: 'session-work',
        turnId: 'turn-work',
        entity: 'Mindstone',
        visibility: 'shared',
        action: 'updated',
        summary: 'Work memory',
        filePath: 'work/Mindstone/memory/work.md',
      },
    ];

    mounted = mount(
      <CardsView
        filter="memory"
        facet="Chief of Staff"
        searchQuery=""
        sortBy="recent"
        memoryEntries={memoryEntries}
        libraryRootAbsolute="/workspace"
      />,
    );

    expect(mounted.container.textContent).toContain('chief.md');
    expect(mounted.container.textContent).not.toContain('work.md');
  });

  it('filters spaces cards by facet bucket', () => {
    const spacesData: SpaceInfo[] = [
      {
        name: 'Private',
        path: 'Chief-of-Staff',
        absolutePath: '/workspace/Chief-of-Staff',
        type: 'chief-of-staff',
        isSymlink: false,
        hasReadme: true,
        status: 'ok',
      },
      {
        name: 'Company',
        path: 'work/Mindstone',
        absolutePath: '/workspace/work/Mindstone',
        type: 'company',
        isSymlink: false,
        hasReadme: true,
        status: 'ok',
      },
      {
        name: 'Launch',
        path: 'work/Mindstone/Launch',
        absolutePath: '/workspace/work/Mindstone/Launch',
        type: 'project',
        isSymlink: false,
        hasReadme: true,
        status: 'ok',
      },
    ];

    const tree: FileNode[] = [
      { name: 'Chief-of-Staff', path: '/workspace/Chief-of-Staff', kind: 'directory', children: [] },
      { name: 'Mindstone', path: '/workspace/work/Mindstone', kind: 'directory', children: [] },
      { name: 'Launch', path: '/workspace/work/Mindstone/Launch', kind: 'directory', children: [] },
    ];

    mounted = mount(
      <CardsView
        filter="spaces"
        facet="work"
        searchQuery=""
        sortBy="space-last-active"
        spacesData={spacesData}
        tree={tree}
        libraryRootAbsolute="/workspace"
      />,
    );

    expect(mounted.container.textContent).toContain('Company');
    expect(mounted.container.textContent).not.toContain('Private');
    expect(mounted.container.textContent).not.toContain('Launch');
  });

  it('filters everything cards by facet kind', () => {
    mounted = mount(
      <CardsView
        filter="everything"
        facet="documents"
        searchQuery=""
        sortBy="recent"
        entries={SAMPLE_ENTRIES}
        libraryRootAbsolute="/workspace"
      />,
    );

    expect(mounted.container.querySelector('[data-testid="mock-skill-card"]')).toBeNull();
    expect(mounted.container.textContent).toContain('roadmap.md');
    expect(mounted.container.textContent).toContain('notes.md');
    expect(mounted.container.textContent).not.toContain('weekly-summary.md');
  });

  it('shows storage and sharing badges for spaces cards', () => {
    mounted = mount(
      <CardsView
        filter="spaces"
        searchQuery=""
        sortBy="space-last-active"
        spacesData={SAMPLE_SPACES_STATES}
        tree={SAMPLE_SPACE_STATES_TREE}
        libraryRootAbsolute="/workspace"
      />,
    );

    expect(mounted.container.textContent).toContain('OneDrive');
    expect(mounted.container.textContent).toContain('Company');
    expect(mounted.container.textContent).toContain('Shared');
  });

  it('shows per-filter empty states with matching CTAs', () => {
    const onCreateSkill = vi.fn();
    const onCreateMemory = vi.fn();
    const onAddSpace = vi.fn();
    const onCreateFile = vi.fn();

    mounted = mount(
      <CardsView
        filter="skills"
        searchQuery=""
        sortBy="name"
        skillsData={{ groups: [], totalCount: 0 }}
        libraryRootAbsolute="/workspace"
        onCreateSkill={onCreateSkill}
      />,
    );
    const createSkillButton = mounted.container.querySelector('[data-testid="cards-empty-state-skills"] button');
    if (!(createSkillButton instanceof HTMLButtonElement)) {
      throw new Error('Create skill CTA not found');
    }
    act(() => createSkillButton.click());
    expect(onCreateSkill).toHaveBeenCalledTimes(1);

    mounted.unmount();
    mounted = mount(
      <CardsView
        filter="memory"
        searchQuery=""
        sortBy="recent"
        memoryEntries={[]}
        libraryRootAbsolute="/workspace"
        onCreateMemory={onCreateMemory}
      />,
    );
    const addMemoryButton = mounted.container.querySelector('[data-testid="cards-empty-state-memory"] button');
    if (!(addMemoryButton instanceof HTMLButtonElement)) {
      throw new Error('Add memory CTA not found');
    }
    act(() => addMemoryButton.click());
    expect(onCreateMemory).toHaveBeenCalledTimes(1);

    mounted.unmount();
    mounted = mount(
      <CardsView
        filter="spaces"
        searchQuery=""
        sortBy="name"
        spacesData={[]}
        libraryRootAbsolute="/workspace"
        onAddSpace={onAddSpace}
      />,
    );
    const addSpaceButton = mounted.container.querySelector('[data-testid="cards-empty-state-spaces"] button');
    if (!(addSpaceButton instanceof HTMLButtonElement)) {
      throw new Error('Add space CTA not found');
    }
    act(() => addSpaceButton.click());
    expect(onAddSpace).toHaveBeenCalledTimes(1);

    mounted.unmount();
    mounted = mount(
      <CardsView
        filter="everything"
        searchQuery=""
        sortBy="name"
        entries={[]}
        libraryRootAbsolute="/workspace"
        onCreateFile={onCreateFile}
      />,
    );
    expect(mounted.container.textContent).toContain('No files in your library yet.');
    const createFileButton = mounted.container.querySelector(
      '[data-testid="cards-empty-state-everything"] button',
    );
    if (!(createFileButton instanceof HTMLButtonElement)) {
      throw new Error('Create file CTA not found');
    }
    act(() => createFileButton.click());
    expect(onCreateFile).toHaveBeenCalledTimes(1);
  });

  it('shows the incomplete-Library hint on the tree-derived everything empty state when partial', () => {
    mounted = mount(
      <CardsView
        filter="everything"
        searchQuery=""
        sortBy="name"
        entries={[]}
        isPartialTree
        libraryRootAbsolute="/workspace"
      />,
    );

    expect(mounted.container.textContent).toContain('No files in your library yet.');
    expect(
      mounted.container.querySelector('[data-testid="library-incomplete-hint"]'),
    ).not.toBeNull();
  });

  it('shows the incomplete-Library hint on a tree-derived everything search-no-results when partial', () => {
    mounted = mount(
      <CardsView
        filter="everything"
        searchQuery="no-such-file"
        sortBy="name"
        entries={[]}
        isPartialTree
        libraryRootAbsolute="/workspace"
      />,
    );

    expect(
      mounted.container.querySelector('[data-testid="library-incomplete-hint"]'),
    ).not.toBeNull();
  });

  it('does NOT show the incomplete-Library hint on non-tree filters (skills) even when partial', () => {
    mounted = mount(
      <CardsView
        filter="skills"
        searchQuery=""
        sortBy="name"
        skillsData={{ groups: [], totalCount: 0 }}
        isPartialTree
        libraryRootAbsolute="/workspace"
      />,
    );

    expect(mounted.container.querySelector('[data-testid="cards-empty-state-skills"]')).not.toBeNull();
    expect(
      mounted.container.querySelector('[data-testid="library-incomplete-hint"]'),
    ).toBeNull();
  });

  it('does NOT show the incomplete-Library hint on the everything empty state when the tree is complete', () => {
    mounted = mount(
      <CardsView
        filter="everything"
        searchQuery=""
        sortBy="name"
        entries={[]}
        libraryRootAbsolute="/workspace"
      />,
    );

    expect(mounted.container.textContent).toContain('No files in your library yet.');
    expect(
      mounted.container.querySelector('[data-testid="library-incomplete-hint"]'),
    ).toBeNull();
  });

  it('uses platform-neutral Quick Open copy in search empty states', () => {
    mounted = mount(
      <CardsView
        filter="skills"
        searchQuery="missing-skill"
        sortBy="name"
        skillsData={{ groups: [], totalCount: 0 }}
        libraryRootAbsolute="/workspace"
      />,
    );

    expect(mounted.container.textContent).toContain('Quick Open');
    expect(mounted.container.textContent).not.toContain('Cmd+P');
  });

  it('invokes onUseSkillPath with the expected skill relative path', () => {
    const onUseSkillPath = vi.fn();
    mounted = mount(
      <CardsView
        filter="skills"
        searchQuery=""
        sortBy="name"
        skillsData={SAMPLE_SKILLS_DATA}
        libraryRootAbsolute="/workspace"
        onUseSkillPath={onUseSkillPath}
      />,
    );

    const useButton = mounted.container.querySelector('[data-testid="mock-use-skill"]');
    if (!(useButton instanceof HTMLButtonElement)) {
      throw new Error('Use This Skill button not found');
    }

    act(() => {
      useButton.click();
    });

    expect(onUseSkillPath).toHaveBeenCalledWith('Chief-of-Staff/skills/meeting-prep/SKILL.md');
    expect(onUseSkillPath).toHaveBeenCalledTimes(1);
  });

  it('does not render PendingMemorySection inside cards view', () => {
    for (const filter of ['memory', 'skills', 'spaces', 'everything'] as const) {
      mounted = mount(
        <CardsView
          filter={filter}
          searchQuery=""
          sortBy="name"
          entries={SAMPLE_ENTRIES}
          libraryRootAbsolute="/workspace"
          pendingMemoryRequests={[
            {
              toolUseId: 'tool-1',
              originalSessionId: 'session-123',
              filePath: '/workspace/Chief-of-Staff/memory/weekly-summary.md',
              spaceName: 'Chief-of-Staff',
              summary: 'Save weekly summary',
              content: '# weekly summary',
              timestamp: Date.now(),
            },
          ]}
        />,
      );

      expect(mounted.container.querySelector('[data-testid="pending-memory-section"]')).toBeNull();

      mounted.unmount();
      mounted = null;
    }
  });

  it('pins only entries that match the active filter', () => {
    const memoryEntries: MemoryHistoryEntry[] = [
      {
        id: 'mem-weekly',
        timestamp: Date.now() - 1_000,
        sessionId: 'session-1',
        turnId: 'turn-1',
        entity: 'Chief-of-Staff',
        visibility: 'private',
        action: 'created',
        summary: 'Weekly summary',
        filePath: 'Chief-of-Staff/memory/weekly-summary.md',
      },
      {
        id: 'mem-retro',
        timestamp: Date.now() - 2_000,
        sessionId: 'session-2',
        turnId: 'turn-2',
        entity: 'Chief-of-Staff',
        visibility: 'private',
        action: 'updated',
        summary: 'Retro summary and follow-ups.',
        filePath: 'Chief-of-Staff/memory/retro-notes.md',
      },
    ];

    mounted = mount(
      <CardsView
        filter="memory"
        searchQuery=""
        sortBy="name"
        memoryEntries={memoryEntries}
        libraryRootAbsolute="/workspace"
        favoriteFilePaths={[
          '/workspace/Chief-of-Staff/skills/meeting-prep/SKILL.md',
          '/workspace/Chief-of-Staff/memory/weekly-summary.md',
        ]}
      />,
    );

    const pinnedSection = mounted.container.querySelector('[data-testid="cards-view-pinned-section"]');
    expect(pinnedSection).toBeTruthy();
    expect(pinnedSection?.textContent).toContain('weekly-summary.md');
    expect(pinnedSection?.textContent).not.toContain('SKILL.md');
    expect(mounted.container.textContent).toContain('Pinned');
  });

  it('shows a classification-aware reveal action in card context menu', () => {
    const onRevealInClassifiedView = vi.fn();
    mounted = mount(
      <CardsView
        filter="skills"
        searchQuery=""
        sortBy="name"
        skillsData={SAMPLE_SKILLS_DATA}
        libraryRootAbsolute="/workspace"
        onRevealInClassifiedView={onRevealInClassifiedView}
      />,
    );

    const skillCardWrapper = mounted.container.querySelector('[data-testid="cards-entry-skill"]');
    if (!(skillCardWrapper instanceof HTMLElement)) {
      throw new Error('Skill card wrapper not found');
    }

    act(() => {
      skillCardWrapper.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 24 }));
    });

    const revealButton = Array.from(
      mounted.container.querySelectorAll('[data-testid="cards-context-menu"] button'),
    ).find((button) => button.textContent?.includes('Show in Skills'));
    if (!(revealButton instanceof HTMLButtonElement)) {
      throw new Error('Show in Skills action not found');
    }
    act(() => {
      revealButton.click();
    });
    expect(onRevealInClassifiedView).toHaveBeenCalledWith('/workspace/Chief-of-Staff/skills/meeting-prep/SKILL.md');
  });

  it('renders loading states for skills/memory/spaces filters instead of degraded cards', () => {
    mounted = mount(
      <CardsView
        filter="skills"
        searchQuery=""
        sortBy="skill-most-used"
        entries={SAMPLE_ENTRIES}
        skillsData={null}
        skillsLoading
        libraryRootAbsolute="/workspace"
      />,
    );
    expect(mounted.container.querySelector('[data-testid="library-lens-empty-state"]')).toBeTruthy();
    expect(mounted.container.textContent).toContain('Reading skills…');
    expect(mounted.container.querySelector('[data-testid="mock-skill-card"]')).toBeNull();

    mounted.unmount();
    mounted = mount(
      <CardsView
        filter="memory"
        searchQuery=""
        sortBy="recent"
        entries={SAMPLE_ENTRIES}
        memoryEntries={[]}
        memoryLoading
        libraryRootAbsolute="/workspace"
      />,
    );
    expect(mounted.container.querySelector('[data-testid="library-lens-empty-state"]')).toBeTruthy();
    expect(mounted.container.textContent).toContain('Loading memories…');
    expect(mounted.container.querySelector('[data-testid="cards-empty-state-memory"]')).toBeNull();
    expect(mounted.container.textContent).not.toContain('weekly-summary.md');

    mounted.unmount();
    mounted = mount(
      <CardsView
        filter="spaces"
        searchQuery=""
        sortBy="name"
        spacesData={[]}
        spacesLoading
        libraryRootAbsolute="/workspace"
      />,
    );
    expect(mounted.container.querySelector('[data-testid="library-lens-empty-state"]')).toBeTruthy();
    expect(mounted.container.textContent).toContain('Checking Spaces…');
    expect(mounted.container.querySelector('[data-testid="cards-empty-state-spaces"]')).toBeNull();
  });

  it('renders skills error state with retry CTA instead of degraded cards', () => {
    const onRetry = vi.fn();
    mounted = mount(
      <CardsView
        filter="skills"
        searchQuery=""
        sortBy="name"
        entries={SAMPLE_ENTRIES}
        skillsData={null}
        skillsError="Skills index unavailable"
        onRetry={onRetry}
        libraryRootAbsolute="/workspace"
      />,
    );

    expect(mounted.container.querySelector('[data-testid="library-lens-empty-state"]')).toBeTruthy();
    expect(mounted.container.textContent).toContain('Skills index unavailable');
    expect(mounted.container.querySelector('[data-testid="mock-skill-card"]')).toBeNull();
    const retryButton = Array.from(mounted.container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Try again',
    );
    if (!(retryButton instanceof HTMLButtonElement)) {
      throw new Error('Retry CTA not found');
    }
    act(() => retryButton.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders memory error state with retry CTA instead of empty state', () => {
    const onRetry = vi.fn();
    mounted = mount(
      <CardsView
        filter="memory"
        searchQuery=""
        sortBy="recent"
        entries={SAMPLE_ENTRIES}
        memoryEntries={[]}
        memoryError="Memory history unavailable"
        onRetry={onRetry}
        libraryRootAbsolute="/workspace"
      />,
    );

    expect(mounted.container.querySelector('[data-testid="library-lens-empty-state"]')).toBeTruthy();
    expect(mounted.container.textContent).toContain('Memory history unavailable');
    const retryButton = Array.from(mounted.container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Try again',
    );
    if (!(retryButton instanceof HTMLButtonElement)) {
      throw new Error('Retry CTA not found');
    }
    act(() => retryButton.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(mounted.container.querySelector('[data-testid="cards-empty-state-memory"]')).toBeNull();
    expect(mounted.container.textContent).not.toContain('weekly-summary.md');
  });

  it('renders spaces error state with retry CTA instead of empty state', () => {
    const onRetry = vi.fn();
    mounted = mount(
      <CardsView
        filter="spaces"
        searchQuery=""
        sortBy="name"
        spacesData={[]}
        error="Spaces unavailable"
        onRetry={onRetry}
        libraryRootAbsolute="/workspace"
      />,
    );

    expect(mounted.container.querySelector('[data-testid="library-lens-empty-state"]')).toBeTruthy();
    expect(mounted.container.textContent).toContain('Spaces unavailable');
    const retryButton = Array.from(mounted.container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Try again',
    );
    if (!(retryButton instanceof HTMLButtonElement)) {
      throw new Error('Retry CTA not found');
    }
    act(() => retryButton.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(mounted.container.querySelector('[data-testid="cards-empty-state-spaces"]')).toBeNull();
  });

  it('exposes list semantics per card when virtualization is active', () => {
    const entries = makeEverythingEntries(240);
    mounted = mount(
      <CardsView
        filter="everything"
        searchQuery=""
        sortBy="name"
        entries={entries}
        libraryRootAbsolute="/workspace"
      />,
    );

    const virtualizedGrid = mounted.container.querySelector('[data-testid="cards-grid-virtualized"]');
    expect(virtualizedGrid?.getAttribute('role')).toBe('list');

    const firstVirtualRow = mounted.container.querySelector('[data-testid="cards-grid-virtualized"] [data-index="0"]');
    expect(firstVirtualRow?.getAttribute('role')).toBe('presentation');

    const firstListItem = mounted.container.querySelector('[data-testid="cards-grid-virtualized"] [data-library-card-path]');
    expect(firstListItem?.getAttribute('role')).toBe('listitem');
    expect(firstListItem?.getAttribute('aria-posinset')).toBe('1');
    expect(firstListItem?.getAttribute('aria-setsize')).toBe(String(entries.length));
  });

  it('restores focused card when toggling between virtualized and non-virtualized grids', () => {
    const initialEntries = makeEverythingEntries(240);
    const reducedEntries = initialEntries.slice(0, 120);
    const focusedPath = initialEntries[0]?.path;
    if (!focusedPath) {
      throw new Error('Expected fixture entries');
    }

    mounted = mount(
      <CardsView
        filter="everything"
        searchQuery=""
        sortBy="name"
        entries={initialEntries}
        libraryRootAbsolute="/workspace"
      />,
    );

    const initialFocusedCard = Array.from(
      mounted.container.querySelectorAll<HTMLElement>('[data-library-card-path]'),
    ).find((element) => element.dataset.libraryCardPath === focusedPath);
    if (!(initialFocusedCard instanceof HTMLElement)) {
      throw new Error('Expected focused card candidate');
    }

    act(() => {
      initialFocusedCard.focus();
    });
    expect(document.activeElement).toBe(initialFocusedCard);

    mounted.rerender(
      <CardsView
        filter="everything"
        searchQuery=""
        sortBy="name"
        entries={reducedEntries}
        libraryRootAbsolute="/workspace"
      />,
    );

    const restoredFocusedCard = Array.from(
      mounted.container.querySelectorAll<HTMLElement>('[data-library-card-path]'),
    ).find((element) => element.dataset.libraryCardPath === focusedPath);
    expect(restoredFocusedCard).toBeTruthy();
    expect(document.activeElement).toBe(restoredFocusedCard);
  });

  it('resets scroll to top when switching to a filter with no saved offset', () => {
    const everythingEntries = makeEverythingEntries(240);
    const memoryEntries: MemoryHistoryEntry[] = Array.from({ length: 240 }, (_, index) => ({
      id: `memory-${index}`,
      timestamp: 1_716_440_000_000 - index,
      sessionId: `session-${index}`,
      turnId: `turn-${index}`,
      entity: 'Chief-of-Staff',
      visibility: 'private',
      action: 'created',
      summary: `Memory summary ${index}`,
      filePath: `Chief-of-Staff/memory/memory-${index}.md`,
    }));

    mounted = mount(
      <CardsView
        filter="everything"
        searchQuery=""
        sortBy="name"
        entries={everythingEntries}
        memoryEntries={memoryEntries}
        libraryRootAbsolute="/workspace"
      />,
    );
    const mountedView = mounted;
    if (!mountedView) {
      throw new Error('Expected mounted CardsView');
    }
    const documentScrollElement = document.scrollingElement instanceof HTMLElement
      ? document.scrollingElement
      : null;
    const observedScrollTops = () => [
      mountedView.container.scrollTop,
      documentScrollElement?.scrollTop ?? Number.NaN,
    ];

    mountedView.container.scrollTop = 260;
    if (documentScrollElement) {
      documentScrollElement.scrollTop = 260;
    }
    act(() => {
      mountedView.container.dispatchEvent(new Event('scroll'));
      documentScrollElement?.dispatchEvent(new Event('scroll'));
    });

    mountedView.rerender(
      <CardsView
        filter="memory"
        searchQuery=""
        sortBy="recent"
        entries={everythingEntries}
        memoryEntries={memoryEntries}
        libraryRootAbsolute="/workspace"
      />,
    );
    expect(observedScrollTops()).toContain(0);
  });
});
