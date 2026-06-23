import { useMemo } from 'react';
import type { MemoryHistoryEntry } from '@shared/types';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import { classifyLibraryItem } from '../utils/classifyLibraryItem';
import {
  isNonMemoryAssetPath,
  mapLibraryKindToEverythingFacet,
  mapSpaceTypeToFacet,
  normalizeFacetValue,
} from '../utils/facets';
import type { LibraryFilter } from '../types/lens';
import type { SkillsScanResult } from './useSkillsIndex';

export interface FacetOption {
  id: string;
  label: string;
  count: number;
  ariaLabel: string;
  tooltip: string;
}

export interface FacetTreeEntry {
  path: string;
  relativePath: string;
  kind?: 'file' | 'directory';
  skillMeta?: unknown;
}

const MAX_VISIBLE_FACETS = 12;
const SKILL_CATEGORY_ORDER = [
  'communication',
  'research',
  'thinking',
  'meetings',
  'writing',
  'planning',
  'sales',
] as const;

const SKILL_CATEGORY_LABELS: Record<string, string> = {
  communication: 'Communication',
  research: 'Research',
  thinking: 'Thinking',
  meetings: 'Meetings',
  writing: 'Writing',
  planning: 'Planning',
  sales: 'Sales',
  coding: 'Coding',
  documentation: 'Documentation',
  analysis: 'Analysis',
  system: 'System',
  productivity: 'Productivity',
  'chief-of-staff': 'Your profile',
};

const SPACE_TYPE_FACETS = [
  { id: 'personal', label: 'Personal' },
  { id: 'work', label: 'Work' },
  { id: 'project', label: 'Project' },
] as const;

const EVERYTHING_KIND_FACETS = [
  { id: 'skills', label: 'Skills' },
  { id: 'memory', label: 'Memory' },
  { id: 'documents', label: 'Documents' },
] as const;

function toTitleCase(rawValue: string): string {
  return rawValue
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((segment) => (
      segment.length === 0
        ? segment
        : `${segment[0].toUpperCase()}${segment.slice(1).toLowerCase()}`
    ))
    .join(' ');
}

function buildSkillsFacets(skillsData: SkillsScanResult | null | undefined): FacetOption[] {
  if (!skillsData?.groups || skillsData.groups.length === 0) {
    return [];
  }

  const counts = new Map<string, { count: number; label: string }>();

  for (const group of skillsData.groups) {
    for (const [groupCategory, skills] of Object.entries(group.categories)) {
      for (const skill of skills) {
        const rawCategory = skill.category || groupCategory;
        const categoryId = normalizeFacetValue(rawCategory);
        if (!categoryId) {
          continue;
        }

        const existing = counts.get(categoryId);
        if (existing) {
          existing.count += 1;
          continue;
        }

        counts.set(categoryId, {
          count: 1,
          label: SKILL_CATEGORY_LABELS[categoryId] ?? toTitleCase(rawCategory),
        });
      }
    }
  }

  const knownOrder = new Map<string, number>(
    SKILL_CATEGORY_ORDER.map((id, index) => [id, index]),
  );

  return Array.from(counts.entries())
    .map(([id, data]) => ({
      id,
      label: data.label,
      count: data.count,
      ariaLabel: `Show ${data.label} skills`,
      tooltip: `${data.label} · ${data.count} skill${data.count === 1 ? '' : 's'}`,
    }))
    .sort((left, right) => {
      const leftOrder = knownOrder.get(left.id);
      const rightOrder = knownOrder.get(right.id);
      const leftKnown = leftOrder != null;
      const rightKnown = rightOrder != null;

      if (leftKnown && rightKnown) {
        return (leftOrder ?? 0) - (rightOrder ?? 0);
      }
      if (leftKnown) return -1;
      if (rightKnown) return 1;

      const byCount = right.count - left.count;
      if (byCount !== 0) return byCount;
      return left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
    });
}

function buildMemoryFacets(memoryEntries: readonly MemoryHistoryEntry[]): FacetOption[] {
  if (memoryEntries.length === 0) {
    return [];
  }

  const counts = new Map<string, { count: number; label: string }>();

  for (const entry of memoryEntries) {
    if (isNonMemoryAssetPath(entry.filePath)) {
      continue;
    }

    const label = entry.entity?.trim() ?? '';
    if (label.length === 0) {
      continue;
    }

    const entityKey = normalizeFacetValue(label);
    if (!entityKey) {
      continue;
    }

    const existing = counts.get(entityKey);
    if (existing) {
      existing.count += 1;
      continue;
    }
    counts.set(entityKey, {
      count: 1,
      label,
    });
  }

  return Array.from(counts.values())
    .sort((left, right) => {
      const byCount = right.count - left.count;
      if (byCount !== 0) return byCount;
      return left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
    })
    .map((entity) => ({
      id: entity.label,
      label: entity.label,
      count: entity.count,
      ariaLabel: `Show ${entity.label} memories`,
      tooltip: `${entity.label} · ${entity.count} ${entity.count === 1 ? 'memory' : 'memories'}`,
    }));
}

function buildSpacesFacets(spacesData: readonly SpaceInfo[] | undefined): FacetOption[] {
  if (!spacesData || spacesData.length === 0) {
    return [];
  }

  const counts = new Map<string, number>();
  for (const space of spacesData) {
    const facetId = mapSpaceTypeToFacet(space.type);
    if (!facetId) {
      continue;
    }
    counts.set(facetId, (counts.get(facetId) ?? 0) + 1);
  }

  return SPACE_TYPE_FACETS.flatMap((facet) => {
    const count = counts.get(facet.id) ?? 0;
    if (count <= 0) return [];
    return [{
      id: facet.id,
      label: facet.label,
      count,
      ariaLabel: `Show ${facet.label} spaces`,
      tooltip: `${facet.label} · ${count} space${count === 1 ? '' : 's'}`,
    }];
  });
}

function buildEverythingFacets(treeEntries: readonly FacetTreeEntry[]): FacetOption[] {
  if (treeEntries.length === 0) {
    return [];
  }

  const counts = new Map<string, number>();

  for (const entry of treeEntries) {
    if (entry.kind && entry.kind !== 'file') {
      continue;
    }
    const kind = classifyLibraryItem({
      path: entry.path,
      relativePath: entry.relativePath,
      skillMeta: entry.skillMeta,
    });
    const facetId = mapLibraryKindToEverythingFacet(kind);
    counts.set(facetId, (counts.get(facetId) ?? 0) + 1);
  }

  return EVERYTHING_KIND_FACETS.flatMap((facet) => {
    const count = counts.get(facet.id) ?? 0;
    if (count <= 0) return [];
    return [{
      id: facet.id,
      label: facet.label,
      count,
      ariaLabel: `Show ${facet.label.toLowerCase()}`,
      tooltip: `${facet.label} · ${count}`,
    }];
  });
}

function buildAllFacetLabel(filter: LibraryFilter): string {
  switch (filter) {
    case 'skills':
      return 'skills';
    case 'memory':
      return 'memories';
    case 'spaces':
      return 'spaces';
    case 'everything':
    default:
      return 'items';
  }
}

export function getFilterFacets(opts: {
  filter: LibraryFilter;
  skillsData?: SkillsScanResult | null;
  memoryEntries?: readonly MemoryHistoryEntry[];
  spacesData?: readonly SpaceInfo[];
  treeEntries?: readonly FacetTreeEntry[];
  /** True when the file tree is a partial view (Bug-2). Only the tree-derived ('everything') counts are affected. */
  isPartialTree?: boolean;
}): { facets: FacetOption[]; hasFacets: boolean } {
  let raw: FacetOption[] = [];
  switch (opts.filter) {
    case 'skills':
      raw = buildSkillsFacets(opts.skillsData);
      break;
    case 'memory':
      raw = buildMemoryFacets(opts.memoryEntries ?? []);
      break;
    case 'spaces':
      raw = buildSpacesFacets(opts.spacesData);
      break;
    case 'everything':
      raw = buildEverythingFacets(opts.treeEntries ?? []);
      break;
    default:
      raw = [];
      break;
  }

  if (raw.length <= 1) {
    return { facets: [], hasFacets: false };
  }

  const visible = raw.slice(0, MAX_VISIBLE_FACETS);
  const total = raw.reduce((sum, facet) => sum + facet.count, 0);
  const allTargetLabel = buildAllFacetLabel(opts.filter);
  // Only the 'everything' facet count is derived from the (capped) file tree, so
  // qualify just that total when partial — skills/memory/spaces counts are unaffected.
  const totalIsPartial = opts.filter === 'everything' && opts.isPartialTree === true;
  const countDisplay = totalIsPartial ? `${total}+` : `${total}`;
  const allFacet: FacetOption = {
    id: 'all',
    label: 'All',
    count: total,
    ariaLabel: 'Show all',
    tooltip: totalIsPartial
      ? `All · ${countDisplay} ${allTargetLabel} (partial view — some files may not appear)`
      : `All · ${countDisplay} ${allTargetLabel}`,
  };
  return {
    facets: [allFacet, ...visible],
    hasFacets: visible.length > 1,
  };
}

export function useFilterFacets(opts: {
  filter: LibraryFilter;
  skillsData?: SkillsScanResult | null;
  memoryEntries?: readonly MemoryHistoryEntry[];
  spacesData?: readonly SpaceInfo[];
  treeEntries?: readonly FacetTreeEntry[];
  isPartialTree?: boolean;
}): { facets: FacetOption[]; hasFacets: boolean } {
  const {
    filter,
    skillsData,
    memoryEntries,
    spacesData,
    treeEntries,
    isPartialTree,
  } = opts;

  return useMemo(
    () => getFilterFacets({ filter, skillsData, memoryEntries, spacesData, treeEntries, isPartialTree }),
    [filter, memoryEntries, skillsData, spacesData, treeEntries, isPartialTree],
  );
}
