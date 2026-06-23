import { describe, expect, it } from 'vitest';
import type { MemoryHistoryEntry } from '@shared/types';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import { getFilterFacets } from '../useFilterFacets';
import type { SkillsScanResult } from '../useSkillsIndex';

function makeSkill(relativePath: string, category: string) {
  return {
    name: relativePath.split('/').slice(-2, -1)[0] || relativePath,
    relativePath,
    absolutePath: `/workspace/${relativePath}`,
    category,
    hasFrontmatter: true,
    frontmatter: { description: `${category} skill` },
  };
}

describe('getFilterFacets', () => {
  it('builds ordered skills facets and caps to 12 visible values', () => {
    const skillsData: SkillsScanResult = {
      totalCount: 18,
      groups: [
        {
          source: 'Chief-of-Staff',
          label: 'Chief-of-Staff',
          type: 'space',
          categories: {
            communication: [
              makeSkill('Chief-of-Staff/skills/communication/email-1/SKILL.md', 'communication'),
              makeSkill('Chief-of-Staff/skills/communication/email-2/SKILL.md', 'communication'),
            ],
            research: [makeSkill('Chief-of-Staff/skills/research/market/SKILL.md', 'research')],
            thinking: [makeSkill('Chief-of-Staff/skills/thinking/decision/SKILL.md', 'thinking')],
            meetings: [makeSkill('Chief-of-Staff/skills/meetings/prep/SKILL.md', 'meetings')],
            writing: [makeSkill('Chief-of-Staff/skills/writing/brief/SKILL.md', 'writing')],
            planning: [makeSkill('Chief-of-Staff/skills/planning/week/SKILL.md', 'planning')],
            sales: [makeSkill('Chief-of-Staff/skills/sales/follow-up/SKILL.md', 'sales')],
            'custom-alpha': [
              makeSkill('Chief-of-Staff/skills/custom-alpha/a/SKILL.md', 'custom-alpha'),
              makeSkill('Chief-of-Staff/skills/custom-alpha/b/SKILL.md', 'custom-alpha'),
              makeSkill('Chief-of-Staff/skills/custom-alpha/c/SKILL.md', 'custom-alpha'),
            ],
            'custom-beta': [
              makeSkill('Chief-of-Staff/skills/custom-beta/a/SKILL.md', 'custom-beta'),
              makeSkill('Chief-of-Staff/skills/custom-beta/b/SKILL.md', 'custom-beta'),
            ],
            coding: [makeSkill('Chief-of-Staff/skills/coding/fix/SKILL.md', 'coding')],
            analysis: [makeSkill('Chief-of-Staff/skills/analysis/run/SKILL.md', 'analysis')],
            documentation: [makeSkill('Chief-of-Staff/skills/documentation/doc/SKILL.md', 'documentation')],
            productivity: [makeSkill('Chief-of-Staff/skills/productivity/focus/SKILL.md', 'productivity')],
          },
          count: 18,
        },
      ],
    };

    const result = getFilterFacets({
      filter: 'skills',
      skillsData,
    });

    expect(result.hasFacets).toBe(true);
    expect(result.facets).toHaveLength(13); // All + top 12
    expect(result.facets[0]).toMatchObject({ id: 'all', label: 'All', count: 17 });
    expect(result.facets.slice(1, 8).map((facet) => facet.id)).toEqual([
      'communication',
      'research',
      'thinking',
      'meetings',
      'writing',
      'planning',
      'sales',
    ]);
    expect(result.facets.slice(8).map((facet) => facet.id)).toEqual([
      'custom-alpha',
      'custom-beta',
      'analysis',
      'coding',
      'documentation',
    ]);
    expect(result.facets.map((facet) => facet.id)).not.toContain('productivity');
    expect(result.facets.find((facet) => facet.id === 'custom-alpha')?.label).toBe('Custom Alpha');
  });

  it('builds memory facets by entity and excludes non-memory assets (source captures + skills)', () => {
    const memoryEntries: MemoryHistoryEntry[] = [
      {
        id: 'm-1',
        timestamp: Date.now(),
        sessionId: 's-1',
        turnId: 't-1',
        entity: 'Chief of Staff',
        visibility: 'private',
        action: 'created',
        summary: 'One',
        filePath: 'Chief-of-Staff/memory/one.md',
      },
      {
        id: 'm-2',
        timestamp: Date.now(),
        sessionId: 's-2',
        turnId: 't-2',
        entity: 'Chief of Staff',
        visibility: 'private',
        action: 'updated',
        summary: 'Two',
        filePath: 'Chief-of-Staff/memory/two.md',
      },
      {
        id: 'm-3',
        timestamp: Date.now(),
        sessionId: 's-3',
        turnId: 't-3',
        entity: 'Mindstone',
        visibility: 'shared',
        action: 'created',
        summary: 'Three',
        filePath: 'work/Mindstone/memory/three.md',
      },
      {
        id: 'm-source',
        timestamp: Date.now(),
        sessionId: 's-4',
        turnId: 't-4',
        entity: 'Chief of Staff',
        visibility: 'private',
        action: 'created',
        summary: 'Capture',
        filePath: 'Chief-of-Staff/memory/sources/2026/05/capture.md',
      },
      {
        id: 'm-skill',
        timestamp: Date.now(),
        sessionId: 's-5',
        turnId: 't-5',
        entity: 'Chief of Staff',
        visibility: 'private',
        action: 'created',
        summary: 'Skill leaked into memory store',
        filePath: 'chief-of-staff/skills/use-case-finder/trade-off-finder/SKILL.md',
      },
    ];

    const result = getFilterFacets({
      filter: 'memory',
      memoryEntries,
    });

    expect(result.hasFacets).toBe(true);
    expect(result.facets.map((facet) => facet.id)).toEqual(['all', 'Chief of Staff', 'Mindstone']);
    expect(result.facets[0]?.count).toBe(3);
    expect(result.facets[1]?.count).toBe(2);
  });

  it('skips legacy malformed memory entries without throwing while building entity facets', () => {
    const memoryEntries = [
      {
        id: 'missing-entity',
        timestamp: Date.now(),
        sessionId: 's-1',
        turnId: 't-1',
        visibility: 'private',
        action: 'created',
        summary: 'Missing entity should not crash facet generation.',
        filePath: 'memory/missing-entity.md',
      },
      {
        id: 'blank-entity',
        timestamp: Date.now(),
        sessionId: 's-2',
        turnId: 't-2',
        entity: '',
        visibility: 'shared',
        action: 'updated',
        summary: 'Blank entity should not create an empty facet.',
        filePath: 'memory/blank-entity.md',
      },
      {
        id: 'missing-summary',
        timestamp: Date.now(),
        sessionId: 's-3',
        turnId: 't-3',
        entity: 'Mindstone',
        visibility: 'shared',
        action: 'created',
        filePath: 'memory/missing-summary.md',
      },
      {
        id: 'valid',
        timestamp: Date.now(),
        sessionId: 's-4',
        turnId: 't-4',
        entity: 'Chief of Staff',
        visibility: 'private',
        action: 'created',
        summary: 'Valid entity keeps the memory facet visible.',
        filePath: 'memory/valid.md',
      },
    ] as unknown as MemoryHistoryEntry[];

    expect(() => getFilterFacets({ filter: 'memory', memoryEntries })).not.toThrow();

    const result = getFilterFacets({ filter: 'memory', memoryEntries });
    expect(result.hasFacets).toBe(true);
    expect(result.facets.map((facet) => facet.id)).toEqual(['all', 'Chief of Staff', 'Mindstone']);
    expect(result.facets[0]?.count).toBe(2);
  });

  it('builds spaces facets from type buckets in fixed order', () => {
    const spacesData: SpaceInfo[] = [
      {
        name: 'Chief-of-Staff',
        path: 'Chief-of-Staff',
        absolutePath: '/workspace/Chief-of-Staff',
        type: 'chief-of-staff',
        isSymlink: false,
        hasReadme: true,
        status: 'ok',
      },
      {
        name: 'Personal',
        path: 'Personal',
        absolutePath: '/workspace/Personal',
        type: 'personal',
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
        name: 'Project',
        path: 'work/Mindstone/Launch',
        absolutePath: '/workspace/work/Mindstone/Launch',
        type: 'project',
        isSymlink: false,
        hasReadme: true,
        status: 'ok',
      },
      {
        name: 'Team',
        path: 'work/Mindstone/Team',
        absolutePath: '/workspace/work/Mindstone/Team',
        type: 'team',
        isSymlink: false,
        hasReadme: true,
        status: 'ok',
      },
    ];

    const result = getFilterFacets({
      filter: 'spaces',
      spacesData,
    });

    expect(result.hasFacets).toBe(true);
    expect(result.facets.map((facet) => facet.id)).toEqual(['all', 'personal', 'work', 'project']);
    expect(result.facets.map((facet) => facet.count)).toEqual([5, 2, 2, 1]);
  });

  it('builds everything facets by classifying file kinds and ignoring directories', () => {
    const result = getFilterFacets({
      filter: 'everything',
      treeEntries: [
        {
          path: '/workspace/Chief-of-Staff/skills/meeting-prep/SKILL.md',
          relativePath: 'Chief-of-Staff/skills/meeting-prep/SKILL.md',
          kind: 'file',
        },
        {
          path: '/workspace/Chief-of-Staff/memory/weekly-summary.md',
          relativePath: 'Chief-of-Staff/memory/weekly-summary.md',
          kind: 'file',
        },
        {
          path: '/workspace/work/Mindstone/roadmap.md',
          relativePath: 'work/Mindstone/roadmap.md',
          kind: 'file',
        },
        {
          path: '/workspace/work',
          relativePath: 'work',
          kind: 'directory',
        },
      ],
    });

    expect(result.hasFacets).toBe(true);
    expect(result.facets.map((facet) => facet.id)).toEqual(['all', 'skills', 'memory', 'documents']);
    expect(result.facets.map((facet) => facet.count)).toEqual([3, 1, 1, 1]);
  });

  it('qualifies the everything All-count when the tree is a partial view', () => {
    const treeEntries = [
      { path: '/workspace/Chief-of-Staff/skills/x/SKILL.md', relativePath: 'Chief-of-Staff/skills/x/SKILL.md', kind: 'file' as const },
      { path: '/workspace/Chief-of-Staff/memory/y.md', relativePath: 'Chief-of-Staff/memory/y.md', kind: 'file' as const },
    ];

    const complete = getFilterFacets({ filter: 'everything', treeEntries, isPartialTree: false });
    const partial = getFilterFacets({ filter: 'everything', treeEntries, isPartialTree: true });

    const completeAll = complete.facets.find((f) => f.id === 'all');
    const partialAll = partial.facets.find((f) => f.id === 'all');
    // Numeric count stays the loaded count; only the user-facing tooltip is qualified.
    expect(completeAll?.count).toBe(2);
    expect(partialAll?.count).toBe(2);
    expect(completeAll?.tooltip).not.toContain('partial view');
    expect(partialAll?.tooltip).toContain('2+');
    expect(partialAll?.tooltip).toContain('partial view');
  });

  it('does not qualify skills/memory/spaces counts when the tree is partial (those are not tree-derived)', () => {
    const memoryEntries: MemoryHistoryEntry[] = [
      { id: 'a', operation: 'add', filePath: 'Chief-of-Staff/memory/MEMORY.md', timestamp: 1 } as unknown as MemoryHistoryEntry,
      { id: 'b', operation: 'add', filePath: 'work/Mindstone/MEMORY.md', timestamp: 2 } as unknown as MemoryHistoryEntry,
    ];
    const partial = getFilterFacets({ filter: 'memory', memoryEntries, isPartialTree: true });
    const allFacet = partial.facets.find((f) => f.id === 'all');
    expect(allFacet?.tooltip ?? '').not.toContain('partial view');
  });

  it('hides facets when only one distinct value exists', () => {
    const result = getFilterFacets({
      filter: 'spaces',
      spacesData: [
        {
          name: 'Chief-of-Staff',
          path: 'Chief-of-Staff',
          absolutePath: '/workspace/Chief-of-Staff',
          type: 'chief-of-staff',
          isSymlink: false,
          hasReadme: true,
          status: 'ok',
        },
      ],
    });

    expect(result.hasFacets).toBe(false);
    expect(result.facets).toEqual([]);
  });
});
