import { useMemo } from 'react';
import type { LibraryFilter } from '../types/lens';

type SkillSourceGroup = 'built-in' | 'user' | 'community';

export interface FilterGroupableEntry {
  id: string;
  source?: SkillSourceGroup;
  createdAt?: number;
}

export interface FilterGrouping<TEntry extends FilterGroupableEntry> {
  key: string;
  label: string;
  entries: TEntry[];
  collapsible: boolean;
  defaultExpanded: boolean;
}

const SKILL_SOURCE_ORDER: readonly SkillSourceGroup[] = ['user', 'built-in', 'community'];

const SKILL_SOURCE_LABELS: Record<SkillSourceGroup, string> = {
  'built-in': 'Built-in',
  user: 'Your skills',
  community: 'Community',
};

function startOfToday(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function startOfWeek(now: Date): number {
  const midnightToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(midnightToday);
  weekStart.setDate(midnightToday.getDate() - midnightToday.getDay());
  return weekStart.getTime();
}

function groupSkillsBySource<TEntry extends FilterGroupableEntry>(
  entries: readonly TEntry[],
): FilterGrouping<TEntry>[] {
  const bySource = new Map<SkillSourceGroup, TEntry[]>();
  for (const source of SKILL_SOURCE_ORDER) {
    bySource.set(source, []);
  }

  for (const entry of entries) {
    const source: SkillSourceGroup = entry.source ?? 'user';
    const bucket = bySource.get(source);
    if (bucket) {
      bucket.push(entry);
    }
  }

  return SKILL_SOURCE_ORDER
    .map((source) => ({
      key: `skills-${source}`,
      label: SKILL_SOURCE_LABELS[source],
      entries: bySource.get(source) ?? [],
      collapsible: true,
      defaultExpanded: true,
    }))
    .filter((group) => group.entries.length > 0);
}

function groupMemoryByTime<TEntry extends FilterGroupableEntry>(
  entries: readonly TEntry[],
): FilterGrouping<TEntry>[] {
  const now = new Date();
  const todayStart = startOfToday(now);
  const weekStart = startOfWeek(now);
  const buckets = {
    today: [] as TEntry[],
    thisWeek: [] as TEntry[],
    earlier: [] as TEntry[],
  };

  for (const entry of entries) {
    const createdAt = entry.createdAt ?? 0;
    if (createdAt >= todayStart) {
      buckets.today.push(entry);
      continue;
    }
    if (createdAt >= weekStart) {
      buckets.thisWeek.push(entry);
      continue;
    }
    buckets.earlier.push(entry);
  }

  const grouped: Array<FilterGrouping<TEntry>> = [
    {
      key: 'memory-today',
      label: 'Today',
      entries: buckets.today,
      collapsible: true,
      defaultExpanded: true,
    },
    {
      key: 'memory-this-week',
      label: 'This week',
      entries: buckets.thisWeek,
      collapsible: true,
      defaultExpanded: true,
    },
    {
      key: 'memory-earlier',
      label: 'Earlier',
      entries: buckets.earlier,
      collapsible: true,
      defaultExpanded: true,
    },
  ];

  return grouped.filter((group) => group.entries.length > 0);
}

export function getFilterGrouping<TEntry extends FilterGroupableEntry>(
  filter: LibraryFilter,
  entries: readonly TEntry[],
): FilterGrouping<TEntry>[] {
  switch (filter) {
    case 'skills':
      return groupSkillsBySource(entries);
    case 'memory':
      return groupMemoryByTime(entries);
    case 'spaces':
    case 'everything':
      return [
        {
          key: `${filter}-all`,
          label: 'All items',
          entries: [...entries],
          collapsible: false,
          defaultExpanded: true,
        },
      ];
    default:
      return [
        {
          key: 'all',
          label: 'All items',
          entries: [...entries],
          collapsible: false,
          defaultExpanded: true,
        },
      ];
  }
}

export function useFilterGrouping<TEntry extends FilterGroupableEntry>(
  filter: LibraryFilter,
  entries: readonly TEntry[],
): FilterGrouping<TEntry>[] {
  return useMemo(() => getFilterGrouping(filter, entries), [entries, filter]);
}
