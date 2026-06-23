/**
 * useGoals — Plugin hook for accessing Focus goals (read-only)
 *
 * Reads goals from space README frontmatter via `window.focusApi.getAllSpaceGoals()`,
 * then flattens to PluginGoal[] for backward compatibility with plugins.
 *
 * Auto-fetches on mount. The `refresh()` function triggers a re-fetch.
 *
 * @see src/core/services/spaceGoalsReader.ts — frontmatter-first goal extraction
 * @see docs/plans/260407_focus_goals_redesign.md
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { PluginGoal, UseGoalsResult } from './types';

export function useGoals(): UseGoalsResult {
  const [goals, setGoals] = useState<PluginGoal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchIdRef = useRef(0);

  const fetchGoals = useCallback(async () => {
    const requestId = ++fetchIdRef.current;
    setIsLoading(true);
    setError(null);

    try {
      if (typeof window === 'undefined' || !window.focusApi?.getAllSpaceGoals) {
        throw new Error('Goals API not available');
      }
      const response = await window.focusApi.getAllSpaceGoals();

      if (requestId === fetchIdRef.current) {
        // Flatten SpaceGoals[] to PluginGoal[] for backward compatibility
        const now = Date.now();
        const flattened: PluginGoal[] = (response.spaces ?? []).flatMap((space) =>
          space.goals.map((g) => ({
            id: `${space.spacePath}/${g.goal}`.slice(0, 36), // Deterministic pseudo-ID
            text: g.goal,
            status: 'active' as const,
            createdAt: now,
            updatedAt: now,
          })),
        );
        setGoals(flattened);
        setIsLoading(false);
      }
    } catch (err) {
      if (requestId === fetchIdRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load goals');
        setIsLoading(false);
      }
    }
  }, []);

  // Auto-fetch on mount
  useEffect(() => {
    void fetchGoals();
  }, [fetchGoals]);

  return { goals, isLoading, error, refresh: fetchGoals };
}
