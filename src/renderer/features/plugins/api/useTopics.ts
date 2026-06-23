/**
 * useTopics — Plugin hook for listing and searching memory topic files.
 *
 * Debounces IPC calls (300ms) when params change.
 * With no params, returns recent topics across configured spaces.
 */

import { useEffect, useRef, useState } from 'react';
import type { TopicEntry, UseTopicsParams, UseTopicsResult } from './types';
import { usePluginId } from './PluginContext';

export function useTopics(params?: UseTopicsParams): UseTopicsResult {
  const pluginId = usePluginId();
  const [topics, setTopics] = useState<TopicEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef(0);

  const paramsKey = JSON.stringify(params ?? {});

  useEffect(() => {
    setIsLoading(true);
    const requestId = ++abortRef.current;

    const timer = setTimeout(async () => {
      try {
        if (typeof window === 'undefined' || !window.pluginsApi?.listTopics) {
          throw new Error('Topics API not available');
        }

        const request: Record<string, unknown> = { pluginId };
        if (params?.query) request.query = params.query;
        if (params?.spacePath) request.spacePath = params.spacePath;
        if (params?.limit != null) request.limit = params.limit;

        const response = await window.pluginsApi.listTopics(
          request as Parameters<typeof window.pluginsApi.listTopics>[0],
        );

        if (requestId === abortRef.current) {
          setTopics(response.topics);
          setIsLoading(false);
          setError(null);
        }
      } catch (err) {
        if (requestId === abortRef.current) {
          setError(err instanceof Error ? err.message : 'Topic search failed');
          setIsLoading(false);
        }
      }
    }, 300);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting pluginId/params object because plugin context is stable per mount and paramsKey is the debounced topic-search trigger
  }, [paramsKey]);

  return { topics, isLoading, error };
}
