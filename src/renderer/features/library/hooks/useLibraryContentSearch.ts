import { useState, useCallback, useRef, useEffect } from 'react';
import type { EmitLogFn } from '@renderer/contexts';

export type ContentSearchMatch = {
  lineNumber: number;
  lineContent: string;
  matchStart: number;
  matchEnd: number;
};

export type ContentSearchResult = {
  filePath: string;
  relativePath: string;
  matches: ContentSearchMatch[];
};

export type ContentSearchResponse = {
  results: ContentSearchResult[];
  totalMatches: number;
  searchedFiles: number;
  truncated: boolean;
};

type UseLibraryContentSearchOptions = {
  emitLog: EmitLogFn;
  onSelectFile: (filePath: string, lineNumber?: number) => void;
  debounceMs?: number;
};

/**
 * Full-text content search for Library files via IPC (`libraryApi.searchContent`).
 * Keeps match metadata (line numbers/highlights) for result rendering and keyboard navigation.
 */
export const useLibraryContentSearch = ({
  emitLog,
  onSelectFile,
  debounceMs = 300,
}: UseLibraryContentSearchOptions) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ContentSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalMatches, setTotalMatches] = useState(0);
  const [searchedFiles, setSearchedFiles] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [selectedResultIndex, setSelectedResultIndex] = useState(0);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const performSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      setResults([]);
      setTotalMatches(0);
      setSearchedFiles(0);
      setTruncated(false);
      setError(null);
      return;
    }

    // Cancel previous search
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setLoading(true);
    setError(null);

    try {
      const response = await window.libraryApi.searchContent({
        query: searchQuery,
        maxResults: 100,
        caseSensitive: false,
      });

      // Check if aborted
      if (abortControllerRef.current?.signal.aborted) return;

      setResults(response.results);
      setTotalMatches(response.totalMatches);
      setSearchedFiles(response.searchedFiles);
      setTruncated(response.truncated);
      setSelectedResultIndex(0);

      emitLog({
        level: 'debug',
        message: 'Content search completed',
        context: { query: searchQuery, totalMatches: response.totalMatches, searchedFiles: response.searchedFiles },
        timestamp: Date.now(),
      });
    } catch (err) {
      if (abortControllerRef.current?.signal.aborted) return;

      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      emitLog({
        level: 'error',
        message: 'Content search failed',
        context: { query: searchQuery, error: message },
        timestamp: Date.now(),
      });
    } finally {
      setLoading(false);
    }
  }, [emitLog]);

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value);

    // Clear previous debounce
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    // Debounce the search
    debounceRef.current = setTimeout(() => {
      performSearch(value);
    }, debounceMs);
  }, [performSearch, debounceMs]);

  const clearSearch = useCallback(() => {
    setQuery('');
    setResults([]);
    setTotalMatches(0);
    setSearchedFiles(0);
    setTruncated(false);
    setError(null);
    setSelectedResultIndex(0);

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  const handleSelectResult = useCallback((filePath: string, lineNumber?: number) => {
    onSelectFile(filePath, lineNumber);
  }, [onSelectFile]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (results.length === 0) return;

    // Flatten results for keyboard navigation
    const flatResults: { filePath: string; lineNumber: number }[] = [];
    for (const result of results) {
      for (const match of result.matches) {
        flatResults.push({ filePath: result.filePath, lineNumber: match.lineNumber });
      }
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedResultIndex((prev) => Math.min(prev + 1, flatResults.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedResultIndex((prev) => Math.max(prev - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const selected = flatResults[selectedResultIndex];
      if (selected) {
        handleSelectResult(selected.filePath, selected.lineNumber);
      }
    }
  }, [results, selectedResultIndex, handleSelectResult]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  return {
    query,
    results,
    loading,
    error,
    totalMatches,
    searchedFiles,
    truncated,
    selectedResultIndex,
    setSelectedResultIndex,
    handleQueryChange,
    handleKeyDown,
    handleSelectResult,
    clearSearch,
  };
};
