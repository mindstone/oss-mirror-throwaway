/**
 * useMonthStats — Renderer hook for Focus month stats via IPC
 *
 * Calls `window.focusApi.getMonthStats({})` and manages
 * loading/complete/error states. Only fetches when `enabled` is true
 * (prevents polling when the Month tab is not visible).
 *
 * @see src/shared/ipc/channels/focus.ts — focus:get-month-stats
 * @see src/main/ipc/focusHandlers.ts
 */

import { useState, useCallback, useEffect, useRef } from 'react';

export interface MonthStats {
  totalMeetings: number;
  totalMeetingHoursEstimate: number;
  meetingsByWeek: Array<{
    weekLabel: string;
    meetingCount: number;
    meetingHours: number;
    solo: number;
    internal: number;
    external: number;
  }>;
  transcriptsCaptured: number;
  goalsCreated: number;
  goalsCompleted: number;
  goalsDropped: number;
  activeGoalCount: number;
  lastReviewedAt: number | null;
  dataSpanDays: number;
  oldestEntryAt: number | null;
  soloTotal: number;
  internalTotal: number;
  externalTotal: number;
  deepWorkHoursEstimate: number;
  meetingVolumeTrend: 'increasing' | 'decreasing' | 'stable';
  stalledGoals: string[];
}

export interface UseMonthStatsResult {
  stats: MonthStats | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useMonthStats(enabled: boolean, monthOffset = 0): UseMonthStatsResult {
  const [stats, setStats] = useState<MonthStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchIdRef = useRef(0);
  const hasFetchedRef = useRef(false);
  /** Track which offset the cached data is for. */
  const cachedOffsetRef = useRef<number>(0);

  const fetchStats = useCallback(async (force = false) => {
    if (!force && hasFetchedRef.current && stats && cachedOffsetRef.current === monthOffset) return;

    const currentFetchId = ++fetchIdRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const result = await window.focusApi.getMonthStats({ monthOffset });
      if (currentFetchId !== fetchIdRef.current) return;

      setStats(result);
      hasFetchedRef.current = true;
      cachedOffsetRef.current = monthOffset;
    } catch {
      if (currentFetchId !== fetchIdRef.current) return;
      setError("Couldn't load your month overview — try again.");
    } finally {
      if (currentFetchId === fetchIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [stats, monthOffset]);

  // Invalidate cache when offset changes
  useEffect(() => {
    if (cachedOffsetRef.current !== monthOffset) {
      hasFetchedRef.current = false;
    }
  }, [monthOffset]);

  useEffect(() => {
    if (!enabled) return;
    if (hasFetchedRef.current && stats && cachedOffsetRef.current === monthOffset) return;
    void fetchStats();
  }, [enabled, fetchStats, stats, monthOffset]);

  const refresh = useCallback(() => {
    hasFetchedRef.current = false;
    void fetchStats(true);
  }, [fetchStats]);

  return { stats, isLoading, error, refresh };
}
