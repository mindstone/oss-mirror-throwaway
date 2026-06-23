// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileNode, MemoryHistoryEntry } from '@shared/types';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import type { SkillsScanResult } from '../../../hooks/useSkillsIndex';
import { CardsView, type CardsViewProps } from '../CardsView';

vi.mock('../../SkillCard', () => ({
  SkillCard: ({ fileName }: { fileName: string }) => (
    <article data-testid="mock-skill-card">
      <span>{fileName}</span>
    </article>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

type PerfFixtures = {
  tree: FileNode[];
  spacesData: SpaceInfo[];
  skillsData: SkillsScanResult;
  memoryEntries: MemoryHistoryEntry[];
  favoriteFilePaths: string[];
};

const PERF_ENABLED = process.env.RUN_LIBRARY_PERF === '1';
const perfIt = PERF_ENABLED ? it : it.skip;

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

function measureRender(root: Root, ui: React.ReactElement): number {
  const start = performance.now();
  act(() => {
    root.render(ui);
  });
  return performance.now() - start;
}

function makeLibraryPerfFixtures(): PerfFixtures {
  const tree: FileNode[] = [];
  const spacesData: SpaceInfo[] = [];
  const filesPerSpace = 1_000;

  for (let spaceIndex = 0; spaceIndex < 5; spaceIndex += 1) {
    const spaceName = `Space-${spaceIndex}`;
    const spacePath = `/workspace/${spaceName}`;
    const children: FileNode[] = [];

    for (let fileIndex = 0; fileIndex < filesPerSpace; fileIndex += 1) {
      children.push({
        name: `note-${spaceIndex}-${fileIndex}.md`,
        path: `${spacePath}/note-${spaceIndex}-${fileIndex}.md`,
        kind: 'file',
        mtime: 1_716_440_000_000 + (spaceIndex * filesPerSpace) + fileIndex,
      });
    }

    tree.push({
      name: spaceName,
      path: spacePath,
      kind: 'directory',
      mtime: 1_716_440_000_000 + spaceIndex,
      children,
    });

    spacesData.push({
      name: spaceName,
      path: spaceName,
      absolutePath: spacePath,
      type: 'project',
      isSymlink: false,
      hasReadme: true,
      status: 'ok',
      displayName: `Project ${spaceIndex}`,
      organisationName: 'Mindstone',
      description: `Workspace for project ${spaceIndex}.`,
    });
  }

  const skillsData: SkillsScanResult = {
    totalCount: 50,
    groups: [
      {
        source: 'Chief-of-Staff',
        label: 'Chief-of-Staff',
        type: 'space',
        categories: {
          planning: Array.from({ length: 50 }, (_, index) => ({
            name: `skill-${index}`,
            relativePath: `Chief-of-Staff/skills/skill-${index}/SKILL.md`,
            absolutePath: `/workspace/Chief-of-Staff/skills/skill-${index}/SKILL.md`,
            category: 'planning',
            hasFrontmatter: true,
            frontmatter: {
              description: `Skill ${index} helps with recurring work.`,
              use_cases: ['planning', 'research', 'follow-up'],
            },
            qualityScore: index % 100,
            usageCount: 50 - index,
            lastUsedAt: 1_716_440_000_000 - index,
          })),
        },
        count: 50,
      },
    ],
  };

  const memoryEntries: MemoryHistoryEntry[] = Array.from({ length: 1_000 }, (_, index) => ({
    id: `memory-${index}`,
    timestamp: 1_716_440_000_000 - index,
    sessionId: `session-${index}`,
    turnId: `turn-${index}`,
    entity: 'Chief-of-Staff',
    visibility: 'private',
    action: 'created',
    summary: `Memory ${index} with useful context for the Library perf test.`,
    filePath: `Chief-of-Staff/memory/memory-${index}.md`,
  }));

  return {
    tree,
    spacesData,
    skillsData,
    memoryEntries,
    favoriteFilePaths: [
      '/workspace/Space-0/note-0-1.md',
      '/workspace/Chief-of-Staff/memory/memory-1.md',
    ],
  };
}

function renderCardsView(
  fixtures: PerfFixtures,
  props: Partial<CardsViewProps>,
): React.ReactElement {
  return (
    <CardsView
      filter="skills"
      searchQuery=""
      sortBy="skill-most-used"
      tree={fixtures.tree}
      libraryRootAbsolute="/workspace"
      skillsData={fixtures.skillsData}
      memoryEntries={fixtures.memoryEntries}
      spacesData={fixtures.spacesData}
      favoriteFilePaths={fixtures.favoriteFilePaths}
      {...props}
    />
  );
}

describe('CardsView performance diagnostics', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
  });

  perfIt('keeps filter changes responsive with a 5000-file tree and typed filter data', () => {
    const fixtures = makeLibraryPerfFixtures();

    const initialRenderStart = performance.now();
    mounted = mount(renderCardsView(fixtures, {
      filter: 'skills',
      sortBy: 'skill-most-used',
    }));
    const initialRenderMs = performance.now() - initialRenderStart;

    const skillsToMemoryMs = measureRender(mounted.root, renderCardsView(fixtures, {
      filter: 'memory',
      sortBy: 'recent',
    }));
    const memoryToSpacesMs = measureRender(mounted.root, renderCardsView(fixtures, {
      filter: 'spaces',
      sortBy: 'space-last-active',
    }));
    const spacesToEverythingMs = measureRender(mounted.root, renderCardsView(fixtures, {
      filter: 'everything',
      sortBy: 'recent',
    }));

    const renderedEverythingCards = mounted.container.querySelectorAll(
      '[data-testid="cards-entry-file"], [data-testid="cards-entry-skill-file"], [data-testid="cards-entry-memory-file"]',
    );
    const virtualizedGrid = mounted.container.querySelector('[data-testid="cards-grid-virtualized"]');

    process.stdout.write(`${JSON.stringify({
      label: 'CardsView perf diagnostic',
      initialRenderMs,
      skillsToMemoryMs,
      memoryToSpacesMs,
      spacesToEverythingMs,
      renderedEverythingCards: renderedEverythingCards.length,
    })}\n`);

    // Baseline (2026-05-23, RUN_LIBRARY_PERF=1 on dev laptop, 1000 memory entries):
    // - skillsToMemoryMs: 59.20ms
    // - memoryToSpacesMs: 7.45ms
    // - spacesToEverythingMs: 35.20ms
    expect(virtualizedGrid).toBeTruthy();
    expect(renderedEverythingCards.length).toBeGreaterThan(0);
    expect(renderedEverythingCards.length).toBeLessThan(5_000);
    expect(skillsToMemoryMs).toBeLessThan(200);
    expect(memoryToSpacesMs).toBeLessThan(200);
    expect(spacesToEverythingMs).toBeLessThan(200);
  });
});
