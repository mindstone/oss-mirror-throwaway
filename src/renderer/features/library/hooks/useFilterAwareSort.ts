import { useMemo } from 'react';
import type { LibraryFilter, LibrarySortOption, LibraryView } from '../types/lens';

export interface FilterAwareSortOption {
  value: LibrarySortOption;
  label: string;
}

const NO_SORT_OPTIONS: readonly FilterAwareSortOption[] = [];

const FOLDER_SORT_OPTIONS: readonly FilterAwareSortOption[] = [
  { value: 'name', label: 'Name' },
  { value: 'modified', label: 'Modified' },
];

const SKILLS_SORT_OPTIONS: readonly FilterAwareSortOption[] = [
  { value: 'skill-suggested', label: 'Suggested' },
  { value: 'skill-most-used', label: 'Most used' },
  { value: 'skill-most-polished', label: 'Most polished' },
  { value: 'name', label: 'A-Z' },
];

const MEMORY_SORT_OPTIONS: readonly FilterAwareSortOption[] = [
  { value: 'recent', label: 'Most recent' },
  { value: 'created', label: 'Date created' },
  { value: 'name', label: 'Alphabetical' },
];

const SPACES_SORT_OPTIONS: readonly FilterAwareSortOption[] = [
  { value: 'name', label: 'Name' },
  { value: 'space-last-active', label: 'Last active' },
];

// Plugins lens default sort: hero-first then recent. See 260521 plan v3.1, Stage A1.
const PLUGINS_SORT_OPTIONS: readonly FilterAwareSortOption[] = [
  { value: 'plugin-hero-first', label: 'Hero first' },
  { value: 'recent', label: 'Most recent' },
  { value: 'modified', label: 'Last updated' },
  { value: 'name', label: 'Name' },
];

const EVERYTHING_SORT_OPTIONS: readonly FilterAwareSortOption[] = [
  { value: 'recent', label: 'Most recent' },
  { value: 'modified', label: 'Modified' },
  { value: 'name', label: 'Name' },
];

function getCardsSortOptionsForFilter(
  filter: LibraryFilter,
  searchQuery?: string,
): readonly FilterAwareSortOption[] {
  switch (filter) {
    case 'skills':
      return SKILLS_SORT_OPTIONS;
    case 'memory': {
      const hasSearchQuery = (searchQuery ?? '').trim().length > 0;
      return hasSearchQuery
        ? [{ value: 'memory-relevance', label: 'Most relevant' }, ...MEMORY_SORT_OPTIONS]
        : MEMORY_SORT_OPTIONS;
    }
    case 'spaces':
      return SPACES_SORT_OPTIONS;
    case 'plugins':
      return PLUGINS_SORT_OPTIONS;
    case 'everything':
      return EVERYTHING_SORT_OPTIONS;
    default:
      return NO_SORT_OPTIONS;
  }
}

export function getSortOptionsForFilter(
  filter: LibraryFilter,
  view: LibraryView,
  searchQuery?: string,
): readonly FilterAwareSortOption[] {
  if (view === 'atlas') {
    return NO_SORT_OPTIONS;
  }
  if (view === 'folders') {
    return FOLDER_SORT_OPTIONS;
  }
  return getCardsSortOptionsForFilter(filter, searchQuery);
}

export function getDefaultSortForFilter(
  filter: LibraryFilter,
  view: LibraryView,
  searchQuery?: string,
): LibrarySortOption | null {
  const first = getSortOptionsForFilter(filter, view, searchQuery)[0];
  return first?.value ?? null;
}

export function normalizeSortForFilter(
  sortBy: LibrarySortOption,
  filter: LibraryFilter,
  view: LibraryView,
  searchQuery?: string,
): LibrarySortOption | null {
  const sortOptions = getSortOptionsForFilter(filter, view, searchQuery);
  if (sortOptions.length === 0) {
    return null;
  }
  return sortOptions.some((option) => option.value === sortBy)
    ? sortBy
    : sortOptions[0].value;
}

export function useFilterAwareSort(
  filter: LibraryFilter,
  view: LibraryView,
  searchQuery?: string,
): {
  sortOptions: readonly FilterAwareSortOption[];
  defaultSort: LibrarySortOption | null;
} {
  const normalizedQuery = searchQuery?.trim() ?? '';
  const sortOptions = useMemo(
    () => getSortOptionsForFilter(filter, view, normalizedQuery),
    [filter, normalizedQuery, view],
  );
  const defaultSort = sortOptions[0]?.value ?? null;
  return {
    sortOptions,
    defaultSort,
  };
}
