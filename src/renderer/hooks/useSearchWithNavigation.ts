import { useCallback, useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTimeoutRef } from './useTimeoutRef';

export interface UseSearchWithNavigationOptions<TResult> {
  searchFn: (query: string) => TResult[];
  onSelect: (result: TResult) => void;
  debounceMs?: number;
}

export interface UseSearchWithNavigationResult<TResult> {
  query: string;
  results: TResult[];
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  handleQueryChange: (value: string) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  clearSearch: () => void;
}

/**
 * Generic hook for search with keyboard navigation.
 * Provides debounced search, arrow key navigation, and Enter/Escape handling.
 */
export function useSearchWithNavigation<TResult>({
  searchFn,
  onSelect,
  debounceMs = 50,
}: UseSearchWithNavigationOptions<TResult>): UseSearchWithNavigationResult<TResult> {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const debounceTimer = useTimeoutRef();

  const performSearch = useCallback(
    (value: string) => {
      if (!value.trim()) {
        setResults([]);
        setSelectedIndex(0);
        return;
      }

      try {
        const searchResults = searchFn(value);
        setResults(searchResults);
        setSelectedIndex(0);
      } catch {
        setResults([]);
        setSelectedIndex(0);
      }
    },
    [searchFn]
  );

  const clearSearch = useCallback(() => {
    setQuery('');
    setResults([]);
    setSelectedIndex(0);
    debounceTimer.clear();
  }, [debounceTimer]);

  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      debounceTimer.set(() => {
        performSearch(value);
      }, debounceMs);
    },
    [debounceMs, debounceTimer, performSearch]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (results.length === 0) {
        if (event.key === 'Escape') {
          clearSearch();
        }
        return;
      }

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
          break;
        case 'ArrowUp':
          event.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter': {
          event.preventDefault();
          const selected = results[selectedIndex];
          if (selected) {
            onSelect(selected);
            clearSearch();
          }
          break;
        }
        case 'Escape':
          event.preventDefault();
          clearSearch();
          break;
        default:
          // eslint-disable-next-line rebel-switch-exhaustiveness/no-bare-default-bypass -- event.key is an unbounded DOM string; non-handled keys are intentionally ignored.
          break;
      }
    },
    [clearSearch, onSelect, results, selectedIndex]
  );

  // Re-run active search when searchFn changes (e.g., recency filter updated).
  // Without this, changing a filter while a query is active leaves stale results.
  useEffect(() => {
    if (query.trim()) {
      // Cancel any pending debounce — it captured the old searchFn and would
      // overwrite our fresh results with stale-filter data.
      debounceTimer.clear();
      performSearch(query);
    }
    // Intentionally omit `query` — query changes are handled by handleQueryChange
    // with debouncing. We only want to re-search when the search function itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting query because handleQueryChange owns debounced query-driven searches
  }, [performSearch]);

  // Bound selectedIndex when results change
  useEffect(() => {
    if (results.length === 0) {
      setSelectedIndex(0);
      return;
    }
    setSelectedIndex((prev) => Math.min(prev, results.length - 1));
  }, [results.length]);

  return {
    query,
    results,
    selectedIndex,
    setSelectedIndex,
    handleQueryChange,
    handleKeyDown,
    clearSearch,
  };
}
