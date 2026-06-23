/**
 * useMemorySearch — Plugin hook for semantic search over workspace files
 *
 * Debounces the query (300ms) and calls the main process via IPC to perform
 * semantic search using the existing file index. Returns results with
 * file path, title, snippet, and relevance score.
 *
 * @see src/main/ipc/pluginHandlers.ts — memory-search handler
 * @see src/main/services/fileIndexService.ts — semanticSearch() implementation
 */

import { useState, useEffect, useRef } from 'react';
import type { MemorySearchOptions } from './types';
import { usePluginId } from './PluginContext';

export interface PluginSearchResult {
  filePath: string;
  title: string;
  snippet: string;
  score: number;
}

export type MemorySearchStatus = 'ok' | 'index_not_ready' | 'embedding_not_ready' | 'error';

const DEFAULT_LIMIT = 10;

export function useMemorySearch(query: string, options?: MemorySearchOptions): {
  results: PluginSearchResult[];
  isLoading: boolean;
  error: string | null;
  status: MemorySearchStatus;
} {
  const pluginId = usePluginId();
  const [results, setResults] = useState<PluginSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<MemorySearchStatus>('ok');
  const abortRef = useRef(0);

  const limit = options?.limit ?? DEFAULT_LIMIT;
  const pathPrefix = options?.pathPrefix;

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setIsLoading(false);
      setError(null);
      setStatus('ok');
      return;
    }

    setIsLoading(true);
    const requestId = ++abortRef.current;

    const timer = setTimeout(async () => {
      try {
        if (typeof window === 'undefined' || !window.pluginsApi?.memorySearch) {
          throw new Error('Memory search API not available');
        }
        const searchResponse = await window.pluginsApi.memorySearch({
          pluginId,
          query: trimmed,
          limit,
          ...(pathPrefix ? { pathPrefix } : {}),
        });
        if (requestId === abortRef.current) {
          setResults(searchResponse.results);
          setStatus(searchResponse.status ?? 'ok');
          setIsLoading(false);
          setError(null);
        }
      } catch (err) {
        if (requestId === abortRef.current) {
          setError(err instanceof Error ? err.message : 'Search failed');
          setStatus('error');
          setIsLoading(false);
        }
      }
    }, 300); // 300ms debounce

    return () => clearTimeout(timer);
  }, [pluginId, query, limit, pathPrefix]);

  return { results, isLoading, error, status };
}
