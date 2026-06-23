import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { searchChannels } from '@shared/ipc/contracts';

export type SemanticSearchResult = z.infer<typeof searchChannels['search:semantic']['response']>[number];
export type IndexStatus = z.infer<typeof searchChannels['search:index-status']['response']>;

interface UseSemanticSearchOptions {
  debounceMs?: number;
  limit?: number;
  threshold?: number;
  fileTypes?: string[];
}

interface SemanticSearchState {
  results: SemanticSearchResult[];
  loading: boolean;
  error: string | null;
  indexStatus: IndexStatus | null;
}

export interface UseSemanticSearchReturn extends SemanticSearchState {
  search: (query: string) => Promise<SemanticSearchResult[]>;
  clearResults: () => void;
  refreshIndexStatus: () => Promise<void>;
  startWatching: (workspacePath: string) => Promise<boolean>;
  stopWatching: () => Promise<boolean>;
  pauseWatching: () => Promise<boolean>;
  reindex: (force?: boolean) => Promise<boolean>;
  clearIndex: () => Promise<boolean>;
}

/**
 * Workspace-wide semantic file search + index lifecycle controls.
 * Used by Library command surfaces that query embeddings through `searchApi.semantic` (not Atlas-local matching).
 */
export const useSemanticSearch = (options: UseSemanticSearchOptions = {}): UseSemanticSearchReturn => {
  const { debounceMs = 300, limit = 10, threshold = 0.5, fileTypes } = options;

  const [state, setState] = useState<SemanticSearchState>({
    results: [],
    loading: false,
    error: null,
    indexStatus: null
  });

  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const search = useCallback(
    async (query: string): Promise<SemanticSearchResult[]> => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      if (abortRef.current) {
        abortRef.current.abort();
      }

      if (!query.trim()) {
        setState((prev) => ({ ...prev, results: [], loading: false, error: null }));
        return [];
      }

      return new Promise((resolve) => {
        debounceRef.current = setTimeout(async () => {
          abortRef.current = new AbortController();
          setState((prev) => ({ ...prev, loading: true, error: null }));

          try {
            const results = await window.searchApi.semantic({
              query,
              limit,
              threshold,
              fileTypes
            });

            setState((prev) => ({ ...prev, results, loading: false }));
            resolve(results);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Search failed';
            setState((prev) => ({ ...prev, results: [], loading: false, error: message }));
            resolve([]);
          }
        }, debounceMs);
      });
    },
    [debounceMs, limit, threshold, fileTypes]
  );

  const clearResults = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    setState((prev) => ({ ...prev, results: [], error: null }));
  }, []);

  const refreshIndexStatus = useCallback(async () => {
    try {
      const status = await window.searchApi.indexStatus();
      setState((prev) => ({ ...prev, indexStatus: status }));
    } catch (error) {
      console.error('Failed to refresh index status:', error);
    }
  }, []);

  const startWatching = useCallback(async (workspacePath: string): Promise<boolean> => {
    try {
      const result = await window.searchApi.startWatching({ workspacePath });
      if (result.started) {
        await refreshIndexStatus();
      }
      return result.started;
    } catch (error) {
      console.error('Failed to start watching:', error);
      return false;
    }
  }, [refreshIndexStatus]);

  const stopWatching = useCallback(async (): Promise<boolean> => {
    try {
      const result = await window.searchApi.stopWatching();
      if (result.stopped) {
        await refreshIndexStatus();
      }
      return result.stopped;
    } catch (error) {
      console.error('Failed to stop watching:', error);
      return false;
    }
  }, [refreshIndexStatus]);

  const pauseWatching = useCallback(async (): Promise<boolean> => {
    try {
      const result = await window.searchApi.pauseWatching();
      if (result.paused) {
        await refreshIndexStatus();
      }
      return result.paused;
    } catch (error) {
      console.error('Failed to pause watching:', error);
      return false;
    }
  }, [refreshIndexStatus]);

  const reindex = useCallback(async (force: boolean = false): Promise<boolean> => {
    try {
      const result = await window.searchApi.reindex({ force });
      if (result.started) {
        await refreshIndexStatus();
      }
      return result.started;
    } catch (error) {
      console.error('Failed to reindex:', error);
      return false;
    }
  }, [refreshIndexStatus]);

  const clearIndex = useCallback(async (): Promise<boolean> => {
    try {
      const result = await window.searchApi.clearIndex();
      if (result.success) {
        await refreshIndexStatus();
      }
      return result.success;
    } catch (error) {
      console.error('Failed to clear index:', error);
      return false;
    }
  }, [refreshIndexStatus]);

  useEffect(() => {
    void refreshIndexStatus();
  }, [refreshIndexStatus]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  return {
    ...state,
    search,
    clearResults,
    refreshIndexStatus,
    startWatching,
    stopWatching,
    pauseWatching,
    reindex,
    clearIndex
  };
};
