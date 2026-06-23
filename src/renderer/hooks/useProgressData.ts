/**
 * Progress Data Hooks
 * 
 * Data fetching hooks for streak and time saved indicators.
 * Extracted to avoid CSS side-effect imports when only hooks are needed.
 */

import { useState, useEffect, useCallback } from 'react';
import type { WeeklyTrend } from '@shared/types';
import { useSessionStore } from '@renderer/features/agent-session/store/sessionStore';
import { shouldRefreshProgressTimeSavedStatus } from '@renderer/utils/timeSavedStatusRouting';

// ─────────────────────────────────────────────────────────────────────────────
// Streak Data
// ─────────────────────────────────────────────────────────────────────────────

export type StreakData = {
  current: number;
  longest: number;
  lastActiveDate: string;
};

export const useStreakData = (): StreakData | null => {
  const [data, setData] = useState<StreakData | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const result = await window.api.getStreakData();
      if (result.current > 0) {
        setData({
          current: result.current,
          longest: result.longest,
          lastActiveDate: result.lastActiveDate
        });
      } else {
        setData(null);
      }
    } catch (error) {
      console.error('Failed to fetch streak data:', error);
      setData(null);
    }
  }, []);

  useEffect(() => {
    fetchData();

    const cleanupUpdated = window.api.onStreakUpdated?.((newData) => {
      if (newData.current > 0) {
        setData({
          current: newData.current,
          longest: newData.longest,
          lastActiveDate: newData.lastActiveDate
        });
      } else {
        setData(null);
      }
    });

    return cleanupUpdated;
  }, [fetchData]);

  return data;
};

// ─────────────────────────────────────────────────────────────────────────────
// Time Saved Data
// ─────────────────────────────────────────────────────────────────────────────

export type TimeSavedData = {
  totalMinutes: number;
  sessionCount: number;
  trend: WeeklyTrend;
  weekStartDate: string;
};

export const shouldDisplayTimeSavedData = (totalMinutes: number, sessionCount: number): boolean => (
  totalMinutes > 0 || sessionCount > 0
);

type TimeSavedAggregateSubset = {
  currentWeek: {
    totalMinutes: number;
    sessionCount: number;
    weekStartDate: string;
  };
};

export const selectTimeSavedData = (
  aggregates: TimeSavedAggregateSubset,
  trend: WeeklyTrend,
): TimeSavedData | null => {
  const totalMinutes = aggregates.currentWeek.totalMinutes;
  const sessionCount = aggregates.currentWeek.sessionCount;
  const weekStartDate = aggregates.currentWeek.weekStartDate;

  if (!shouldDisplayTimeSavedData(totalMinutes, sessionCount)) {
    return null;
  }

  return {
    totalMinutes,
    sessionCount,
    trend,
    weekStartDate,
  };
};

export const useTimeSavedData = (): TimeSavedData | null => {
  const [data, setData] = useState<TimeSavedData | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const result = await window.api.getTimeSavedAggregates();
      const { aggregates, trend } = result;
      setData(selectTimeSavedData(aggregates, trend));
    } catch (error) {
      console.error('Failed to fetch time saved aggregates:', error);
      setData(null);
    }
  }, []);

  useEffect(() => {
    fetchData();

    const cleanup = window.api.onTimeSavedStatus((status) => {
      const activeSessionId = useSessionStore.getState().currentSessionId;
      if (!shouldRefreshProgressTimeSavedStatus(status, activeSessionId)) {
        return;
      }
      fetchData();
    });

    return cleanup;
  }, [fetchData]);

  return data;
};

// ─────────────────────────────────────────────────────────────────────────────
// Formatting Utilities
// ─────────────────────────────────────────────────────────────────────────────

export const formatTimeSavedCompact = (minutes: number): string => {
  if (minutes <= 0) return '0m';
  const hours = minutes / 60;
  if (hours < 1) return `${Math.max(1, Math.round(minutes))}m`;
  if (hours < 10) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours)}h`;
};
