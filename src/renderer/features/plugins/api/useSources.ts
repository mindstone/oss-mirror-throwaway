/**
 * useSources — Plugin hook for searching and browsing memory sources
 *
 * Debounces IPC calls (300ms) when params change, similar to useMemorySearch.
 * With no params, returns all sources. Supports filtering by query, source type,
 * participants, and date range.
 *
 * @see src/main/ipc/pluginHandlers.ts — search-sources handler
 * @see src/core/services/sourceMetadataStore.ts — searchSources() implementation
 */

import { useState, useEffect, useRef } from 'react';
import type { UseSourcesParams, UseSourcesResult, SourceEntry } from './types';
import { usePluginId } from './PluginContext';

export function useSources(params?: UseSourcesParams): UseSourcesResult {
  const pluginId = usePluginId();
  const [sources, setSources] = useState<SourceEntry[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef(0);

  // Serialize params for dependency tracking (stable JSON key)
  const paramsKey = JSON.stringify(params ?? {});

  useEffect(() => {
    setIsLoading(true);
    const requestId = ++abortRef.current;

    const timer = setTimeout(async () => {
      try {
        if (typeof window === 'undefined' || !window.pluginsApi?.searchSources) {
          throw new Error('Sources search API not available');
        }

        const request: Record<string, unknown> = { pluginId };
        if (params?.query) request.query = params.query;
        if (params?.sourceTypes?.length) request.sourceTypes = params.sourceTypes;
        if (params?.participants?.length) request.participants = params.participants;
        if (params?.dateRange) request.dateRange = params.dateRange;
        if (params?.limit != null) request.limit = params.limit;

        const response = await window.pluginsApi.searchSources(request as Parameters<typeof window.pluginsApi.searchSources>[0]);

        if (requestId === abortRef.current) {
          setSources(response.sources);
          setTotalCount(response.totalCount);
          setIsLoading(false);
          setError(null);
        }
      } catch (err) {
        if (requestId === abortRef.current) {
          setError(err instanceof Error ? err.message : 'Source search failed');
          setIsLoading(false);
        }
      }
    }, 300); // 300ms debounce

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting pluginId/params object because plugin context is stable per mount and paramsKey is the debounced search trigger
  }, [paramsKey]);

  return { sources, totalCount, isLoading, error };
}
