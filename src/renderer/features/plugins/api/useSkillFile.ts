/**
 * useSkillFile — Plugin hook for loading a single skill markdown file.
 *
 * Fetches skill content and parsed frontmatter when relativePath changes.
 */

import { useEffect, useState } from 'react';
import type { UseSkillFileResult } from './types';
import { usePluginId } from './PluginContext';

export function useSkillFile(relativePath: string): UseSkillFileResult {
  const pluginId = usePluginId();
  const [content, setContent] = useState<string | null>(null);
  const [frontmatter, setFrontmatter] = useState<Record<string, unknown> | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = relativePath.trim();
    if (!trimmed) {
      setContent(null);
      setFrontmatter(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        if (typeof window === 'undefined' || !window.pluginsApi?.readSkill) {
          throw new Error('Skill file API not available');
        }

        const response = await window.pluginsApi.readSkill({ pluginId, relativePath: trimmed });

        if (!cancelled) {
          setContent(response.content);
          setFrontmatter(response.frontmatter);
          setIsLoading(false);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load skill file');
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pluginId, relativePath]);

  return { content, frontmatter, isLoading, error };
}
