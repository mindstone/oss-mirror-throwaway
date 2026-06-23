/**
 * useTopicContent — Plugin hook for loading a single memory topic file.
 *
 * Fetches topic content (frontmatter stripped) when relativePath changes.
 */

import { useEffect, useState } from 'react';
import type { UseTopicContentResult } from './types';
import { usePluginId } from './PluginContext';

export function useTopicContent(relativePath: string): UseTopicContentResult {
  const pluginId = usePluginId();
  const [content, setContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = relativePath.trim();
    if (!trimmed) {
      setContent(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        if (typeof window === 'undefined' || !window.pluginsApi?.readTopic) {
          throw new Error('Topic read API not available');
        }

        const response = await window.pluginsApi.readTopic({ pluginId, relativePath: trimmed });

        if (!cancelled) {
          setContent(response.content);
          setIsLoading(false);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load topic');
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pluginId, relativePath]);

  return { content, isLoading, error };
}
