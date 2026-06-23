/**
 * useGoalAlignment — Renderer hook for Focus goal-calendar alignment data.
 *
 * Calls `window.focusApi.getGoalAlignment({ granularity })` and manages
 * loading/complete/error states. Only fetches when `enabled` is true
 * (prevents polling when the tab is not visible). Listens for
 * `onAutomationState` broadcasts to refresh (matching `useSpaceGoals` pattern).
 *
 * @see src/shared/ipc/channels/focus.ts — focus:get-goal-alignment
 * @see src/core/services/goalAlignmentService.ts — computation logic
 * @see docs/plans/260409_focus_time_vs_goals_visualization.md
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { GoalAlignmentResult } from '../../../../core/services/goalAlignmentService';

export interface UseGoalAlignmentResult {
  data: GoalAlignmentResult | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Hook for fetching goal-calendar alignment data.
 *
 * @param enabled - When false, skips fetching (e.g. tab not visible).
 * @param granularity - 'week' or 'month' — determines time window.
 * @param refreshKey - Optional counter/key that triggers a refetch when it changes
 *   (e.g. increment when goals are dismissed/restored to keep alignment in sync).
 * @param weekOffset - Optional week offset relative to current week (0 = this week).
 * @param monthOffset - Optional month offset relative to current month (0 = this month).
 */
export function useGoalAlignment(
  enabled: boolean,
  granularity: 'week' | 'month',
  refreshKey?: number,
  weekOffset?: number,
  monthOffset?: number,
): UseGoalAlignmentResult {
  const [data, setData] = useState<GoalAlignmentResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchIdRef = useRef(0);
  const hasFetchedRef = useRef(false);
  /** Track which granularity the cached data is for. */
  const cachedGranularityRef = useRef<'week' | 'month' | null>(null);
  /** Track which offsets the cached data is for. */
  const cachedWeekOffsetRef = useRef<number | undefined>(undefined);
  const cachedMonthOffsetRef = useRef<number | undefined>(undefined);

  /** Check whether cached data matches current params. */
  const isCacheValid = useCallback(() => {
    return hasFetchedRef.current
      && data
      && cachedGranularityRef.current === granularity
      && cachedWeekOffsetRef.current === weekOffset
      && cachedMonthOffsetRef.current === monthOffset;
  }, [data, granularity, weekOffset, monthOffset]);

  const fetchAlignment = useCallback(async (force = false) => {
    // Skip if we already have data for this granularity+offsets and not forcing
    if (!force && isCacheValid()) return;

    const currentFetchId = ++fetchIdRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const result = await window.focusApi.getGoalAlignment({ granularity, weekOffset, monthOffset });
      // Race guard: ignore stale responses
      if (currentFetchId !== fetchIdRef.current) return;

      setData(result);
      hasFetchedRef.current = true;
      cachedGranularityRef.current = granularity;
      cachedWeekOffsetRef.current = weekOffset;
      cachedMonthOffsetRef.current = monthOffset;
    } catch (_err) {
      if (currentFetchId !== fetchIdRef.current) return;
      setError("Couldn't load goal alignment — try again.");
    } finally {
      if (currentFetchId === fetchIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [granularity, weekOffset, monthOffset, isCacheValid]);

  // Fetch when enabled + granularity/offsets change
  useEffect(() => {
    if (!enabled) return;
    if (isCacheValid()) return;
    void fetchAlignment();
  }, [enabled, fetchAlignment, isCacheValid]);

  // Invalidate cache when granularity or offsets change
  useEffect(() => {
    if (cachedGranularityRef.current !== null && (
      cachedGranularityRef.current !== granularity
      || cachedWeekOffsetRef.current !== weekOffset
      || cachedMonthOffsetRef.current !== monthOffset
    )) {
      hasFetchedRef.current = false;
    }
  }, [granularity, weekOffset, monthOffset]);

  // Listen for automation state changes to refresh
  // (goal edits via conversation trigger automation state broadcasts)
  useEffect(() => {
    if (!enabled) return;

    const unsubscribe = window.api?.onAutomationState?.(() => {
      hasFetchedRef.current = false;
      void fetchAlignment(true);
    });

    return () => {
      unsubscribe?.();
    };
  }, [enabled, fetchAlignment]);

  // Refetch when refreshKey changes (e.g. goals dismissed/restored)
  const prevRefreshKeyRef = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey !== undefined && refreshKey !== prevRefreshKeyRef.current) {
      prevRefreshKeyRef.current = refreshKey;
      if (enabled) {
        hasFetchedRef.current = false;
        void fetchAlignment(true);
      }
    }
  }, [refreshKey, enabled, fetchAlignment]);

  const refresh = useCallback(() => {
    hasFetchedRef.current = false;
    void fetchAlignment(true);
  }, [fetchAlignment]);

  return { data, isLoading, error, refresh };
}
