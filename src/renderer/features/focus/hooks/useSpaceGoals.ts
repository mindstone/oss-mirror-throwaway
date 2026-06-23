/**
 * useSpaceGoals — Renderer hook for space-aggregated goals from frontmatter.
 *
 * Calls `window.focusApi.getAllSpaceGoals()` on mount + when Focus is active.
 * Provides dismiss/restore functions for per-user space filtering.
 *
 * This replaces `useGoals` for the GoalsSidebar (which used the goalsStore
 * CRUD model). Goals are now read-only — editing happens via conversations.
 *
 * @see src/core/services/spaceGoalsReader.ts — core extraction logic
 * @see docs/plans/260407_focus_goals_redesign.md — Stage 3
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { SpaceGoals } from '../../../../core/services/spaceGoalsTypes';

export interface UseSpaceGoalsResult {
  /** All space goals (personal first, then alphabetical). Not filtered by dismissals. */
  spaceGoals: SpaceGoals[];
  /** Paths of spaces the user has dismissed. */
  dismissedSpaces: string[];
  /** Spaces that exist but have no goals in their frontmatter. */
  spacesWithoutGoals: Array<{ spaceName: string; spacePath: string }>;
  /** True while the initial fetch is in progress. */
  isLoading: boolean;
  /** Dismiss goals for a specific space. */
  dismissSpace: (spacePath: string) => Promise<void>;
  /** Restore all dismissed spaces. */
  restoreAllSpaces: () => Promise<void>;
}

/**
 * Hook for fetching space-aggregated goals from frontmatter.
 *
 * @param enabled - When false, skips fetching (e.g. Focus surface not visible).
 */
export function useSpaceGoals(enabled = true): UseSpaceGoalsResult {
  const [spaceGoals, setSpaceGoals] = useState<SpaceGoals[]>([]);
  const [dismissedSpaces, setDismissedSpaces] = useState<string[]>([]);
  const [spacesWithoutGoals, setSpacesWithoutGoals] = useState<Array<{ spaceName: string; spacePath: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const fetchIdRef = useRef(0);

  const fetchGoals = useCallback(async () => {
    const currentFetchId = ++fetchIdRef.current;
    try {
      const result = await window.focusApi.getAllSpaceGoals();
      if (currentFetchId !== fetchIdRef.current) return;

      setSpaceGoals(result.spaces);
      setSpacesWithoutGoals(result.spacesWithoutGoals ?? []);
      if (result.dismissedPaths?.length) {
        setDismissedSpaces(result.dismissedPaths);
      }
    } catch (err) {
      console.error('Failed to fetch space goals:', err);
    } finally {
      if (currentFetchId === fetchIdRef.current) setIsLoading(false);
    }
  }, []);

  // Fetch on mount + when enabled changes to true
  useEffect(() => {
    if (!enabled) return;
    void fetchGoals();
  }, [enabled, fetchGoals]);

  // Listen for automation state changes to refresh goals
  // (conversations that update frontmatter trigger automation state broadcasts)
  useEffect(() => {
    if (!enabled) return;

    const unsubscribe = window.api?.onAutomationState?.(() => {
      void fetchGoals();
    });

    return () => {
      unsubscribe?.();
    };
  }, [enabled, fetchGoals]);

  const dismissSpace = useCallback(async (spacePath: string) => {
    try {
      await window.focusApi.dismissSpaceGoals({ spacePath });
      // Optimistic update: track locally
      setDismissedSpaces(prev => [...prev, spacePath]);
      // Refetch to get server-filtered list
      void fetchGoals();
    } catch (err) {
      console.error('Failed to dismiss space goals:', err);
    }
  }, [fetchGoals]);

  const restoreAllSpaces = useCallback(async () => {
    // Restore each dismissed space
    try {
      for (const spacePath of dismissedSpaces) {
        await window.focusApi.restoreSpaceGoals({ spacePath });
      }
      setDismissedSpaces([]);
      void fetchGoals();
    } catch (err) {
      console.error('Failed to restore space goals:', err);
    }
  }, [dismissedSpaces, fetchGoals]);

  return {
    spaceGoals,
    dismissedSpaces,
    spacesWithoutGoals,
    isLoading,
    dismissSpace,
    restoreAllSpaces,
  };
}
