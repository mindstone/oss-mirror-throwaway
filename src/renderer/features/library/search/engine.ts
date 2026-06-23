import type Fuse from 'fuse.js';
import { recordRendererBreadcrumb } from '@renderer/src/sentry';
import {
  createLibrarySearchFuse,
  searchFilesWithFuse,
} from '@renderer/utils/librarySearch';
import type { FlatLibraryEntry, LibrarySearchResult } from './types';

const LIBRARY_SEARCH_ENGINE_MAX_ENTRIES = 100_000;
const ENGINE_CAP_TRUNCATION_REASON = 'engine-cap' as const;

export interface LibrarySearchOptions {
  limit?: number;
  surface?: string;
}

export interface LibrarySearchOutcome {
  results: LibrarySearchResult[];
  truncated: boolean;
  truncationReason: 'engine-cap' | null;
  entriesTotal: number;
  entriesIndexed: number;
}

type FuseCache = {
  entries: ReadonlyArray<FlatLibraryEntry>;
  instance: Fuse<FlatLibraryEntry>;
};

type PreparedEntries = {
  entries: ReadonlyArray<FlatLibraryEntry>;
  entriesTotal: number;
  entriesIndexed: number;
  truncated: boolean;
};

const FUSE_CACHE_CAPACITY = 4;

const isDevelopmentMode = Boolean(
  import.meta.env.DEV
  || (typeof process !== 'undefined' && (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'))
);

let fuseCacheByEntries = new Map<ReadonlyArray<FlatLibraryEntry>, FuseCache>();
let cappedEntriesCache = new WeakMap<ReadonlyArray<FlatLibraryEntry>, ReadonlyArray<FlatLibraryEntry>>();
let capBreadcrumbState = new WeakMap<ReadonlyArray<FlatLibraryEntry>, number | null>();
let frozenEntries = new WeakSet<ReadonlyArray<FlatLibraryEntry>>();

const compareCaseSensitive = (left: string, right: string): number => {
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

const normalizeForOrdering = (entry: FlatLibraryEntry): string =>
  (entry.fullPath ?? entry.node?.path ?? entry.node?.name ?? '')
    .toLowerCase()
    .replace(/\\/g, '/');

const compareNodeKind = (left: FlatLibraryEntry['node']['kind'], right: FlatLibraryEntry['node']['kind']): number => {
  if (left === right) return 0;
  if (left === 'directory') return -1;
  return 1;
};

const freezeEntriesInDevelopment = (entries: ReadonlyArray<FlatLibraryEntry>): void => {
  if (!isDevelopmentMode || frozenEntries.has(entries)) {
    return;
  }
  Object.freeze(entries);
  frozenEntries.add(entries);
};

const getDeterministicCappedSlice = (
  entries: ReadonlyArray<FlatLibraryEntry>
): ReadonlyArray<FlatLibraryEntry> => {
  const cached = cappedEntriesCache.get(entries);
  if (cached) {
    return cached;
  }

  const sortableEntries = entries.map((entry, index) => ({
    entry,
    index,
    normalizedPath: normalizeForOrdering(entry),
    nodePath: entry.node.path ?? '',
    nodeKind: entry.node.kind,
  }));

  sortableEntries.sort((left, right) => {
    const normalizedOrder = left.normalizedPath.localeCompare(right.normalizedPath);
    if (normalizedOrder !== 0) {
      return normalizedOrder;
    }

    const nodePathOrder = compareCaseSensitive(left.nodePath, right.nodePath);
    if (nodePathOrder !== 0) {
      return nodePathOrder;
    }

    const nodeKindOrder = compareNodeKind(left.nodeKind, right.nodeKind);
    if (nodeKindOrder !== 0) {
      return nodeKindOrder;
    }

    return left.index - right.index;
  });

  const sorted = new Array<FlatLibraryEntry>(
    Math.min(sortableEntries.length, LIBRARY_SEARCH_ENGINE_MAX_ENTRIES),
  );
  for (let index = 0; index < sorted.length; index += 1) {
    sorted[index] = sortableEntries[index].entry;
  }

  if (isDevelopmentMode) {
    Object.freeze(sorted);
  }

  cappedEntriesCache.set(entries, sorted);
  return sorted;
};

const prepareEntries = (
  entries: ReadonlyArray<FlatLibraryEntry>
): PreparedEntries => {
  const entriesTotal = entries.length;
  if (entriesTotal > LIBRARY_SEARCH_ENGINE_MAX_ENTRIES) {
    const cappedEntries = getDeterministicCappedSlice(entries);
    return {
      entries: cappedEntries,
      entriesTotal,
      entriesIndexed: cappedEntries.length,
      truncated: true,
    };
  }

  return {
    entries,
    entriesTotal,
    entriesIndexed: entriesTotal,
    truncated: false,
  };
};

const getFuseInstance = (entries: ReadonlyArray<FlatLibraryEntry>): Fuse<FlatLibraryEntry> => {
  const cachedEntry = fuseCacheByEntries.get(entries);
  if (cachedEntry) {
    // LRU refresh: move hit to most-recent position.
    fuseCacheByEntries.delete(entries);
    fuseCacheByEntries.set(entries, cachedEntry);
    return cachedEntry.instance;
  }

  const instance = createLibrarySearchFuse(entries);
  if (fuseCacheByEntries.size >= FUSE_CACHE_CAPACITY) {
    const leastRecentEntries = fuseCacheByEntries.keys().next().value as
      | ReadonlyArray<FlatLibraryEntry>
      | undefined;
    if (leastRecentEntries) {
      fuseCacheByEntries.delete(leastRecentEntries);
    }
  }
  fuseCacheByEntries.set(entries, { entries, instance });
  return instance;
};

const emitCapBreadcrumbOncePerTransition = (
  sourceEntries: ReadonlyArray<FlatLibraryEntry>,
  entriesTotal: number,
  entriesIndexed: number,
  surface?: string
): void => {
  const previousEntriesTotal = capBreadcrumbState.get(sourceEntries) ?? null;
  if (previousEntriesTotal === entriesTotal) {
    return;
  }

  capBreadcrumbState.set(sourceEntries, entriesTotal);
  recordRendererBreadcrumb({
    category: 'library_search',
    message: 'library_search.engine_cap_fired',
    level: 'info',
    data: {
      entriesTotal,
      entriesIndexed,
      ...(surface ? { surface } : {}),
    },
  });
};

const updateCapBreadcrumbState = (
  sourceEntries: ReadonlyArray<FlatLibraryEntry>,
  preparedEntries: PreparedEntries,
  surface?: string
): void => {
  if (!preparedEntries.truncated) {
    capBreadcrumbState.set(sourceEntries, null);
    return;
  }

  emitCapBreadcrumbOncePerTransition(
    sourceEntries,
    preparedEntries.entriesTotal,
    preparedEntries.entriesIndexed,
    surface,
  );
};

export function searchLibrary(
  query: string,
  entries: ReadonlyArray<FlatLibraryEntry>,
  options?: LibrarySearchOptions
): LibrarySearchOutcome {
  // Unsupported: query must be a string and entries must be a concrete array (not null/undefined).
  freezeEntriesInDevelopment(entries);

  const trimmedQuery = query.trim();
  if (!trimmedQuery || entries.length === 0) {
    return {
      results: [],
      truncated: false,
      truncationReason: null,
      entriesTotal: entries.length,
      entriesIndexed: 0,
    };
  }

  const preparedEntries = prepareEntries(entries);
  updateCapBreadcrumbState(entries, preparedEntries, options?.surface);

  const results = searchFilesWithFuse(
    trimmedQuery,
    preparedEntries.entries,
    getFuseInstance(preparedEntries.entries),
    { limit: options?.limit },
  );

  return {
    results,
    truncated: preparedEntries.truncated,
    truncationReason: preparedEntries.truncated ? ENGINE_CAP_TRUNCATION_REASON : null,
    entriesTotal: preparedEntries.entriesTotal,
    entriesIndexed: preparedEntries.entriesIndexed,
  };
}

/**
 * Clears engine-owned caches (Fuse instance, capped slice, breadcrumb state, freeze set).
 */
export function invalidateLibrarySearchCache(): void {
  fuseCacheByEntries = new Map();
  cappedEntriesCache = new WeakMap();
  capBreadcrumbState = new WeakMap();
  frozenEntries = new WeakSet();
}
