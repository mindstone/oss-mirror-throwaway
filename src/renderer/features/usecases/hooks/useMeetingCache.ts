/**
 * useMeetingCache - Fetches cached meetings from the 24h calendar cache
 *
 * Used by The Spark and the homepage to display today's meetings with prep status.
 *
 * Freshness:
 *   - Polls every 5 minutes while the component is mounted (pauses when hidden)
 *   - Catches up immediately on hidden→visible transitions (handles overnight / sleep)
 *   - When the cache is stale (>4h, e.g. after overnight sleep), auto-triggers a
 *     calendar sync and re-fetches so the UI updates within seconds
 *   - Race-guarded via fetchIdRef to prevent stale writes from overlapping fetches
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { CachedMeeting, MeetingCacheResponse } from '@shared/ipc/channels/calendar';
import { useVisibilityAwareInterval } from '@renderer/hooks/useVisibilityAwareInterval';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const AUTO_SYNC_REFETCH_DELAY_MS = 5_000;

export interface UseMeetingCacheResult {
  meetings: CachedMeeting[];
  isLoading: boolean;
  isStale: boolean;
  lastSyncError?: string;
  /** Warnings from calendar sources that failed during sync */
  syncWarnings: string[];
  populatedAt: number | null;
  refresh: () => Promise<void>;
}

export function useMeetingCache(todayOnly = true, enabled = true): UseMeetingCacheResult {
  const [meetings, setMeetings] = useState<CachedMeeting[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isStale, setIsStale] = useState(true);
  const [lastSyncError, setLastSyncError] = useState<string | undefined>();
  const [syncWarnings, setSyncWarnings] = useState<string[]>([]);
  const [populatedAt, setPopulatedAt] = useState<number | null>(null);
  const fetchIdRef = useRef(0);
  const autoSyncTriggeredRef = useRef(false);
  const autoSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchMeetingsRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const fetchMeetings = useCallback(async () => {
    const currentFetchId = ++fetchIdRef.current;
    try {
      const result: MeetingCacheResponse = await window.calendarApi.getCachedMeetings({ todayOnly });
      if (currentFetchId !== fetchIdRef.current) return;
      if (result.success) {
        setMeetings(result.meetings);
        setIsStale(result.isStale);
        setLastSyncError(result.lastSyncError);
        setSyncWarnings(result.syncWarnings ?? []);
        setPopulatedAt(result.populatedAt);

        // When cache is stale (e.g. after overnight sleep), trigger a background
        // calendar sync and schedule a follow-up fetch so the UI updates within
        // seconds rather than waiting for the next 5-minute poll cycle.
        if (result.isStale && !autoSyncTriggeredRef.current) {
          autoSyncTriggeredRef.current = true;
          window.calendarApi.triggerSync().catch(() => {
            autoSyncTriggeredRef.current = false;
          });
          if (autoSyncTimerRef.current) clearTimeout(autoSyncTimerRef.current);
          autoSyncTimerRef.current = setTimeout(
            () => fetchMeetingsRef.current(),
            AUTO_SYNC_REFETCH_DELAY_MS,
          );
        }
        if (!result.isStale) {
          autoSyncTriggeredRef.current = false;
          if (autoSyncTimerRef.current) {
            clearTimeout(autoSyncTimerRef.current);
            autoSyncTimerRef.current = null;
          }
        }
      }
    } catch (err) {
      console.error('Failed to fetch meeting cache:', err);
    } finally {
      if (currentFetchId === fetchIdRef.current) setIsLoading(false);
    }
  }, [todayOnly]);

  fetchMeetingsRef.current = fetchMeetings;

  // Clean up the auto-sync re-fetch timer on unmount
  useEffect(() => {
    return () => {
      if (autoSyncTimerRef.current) {
        clearTimeout(autoSyncTimerRef.current);
        autoSyncTimerRef.current = null;
      }
    };
  }, []);

  // Runs on mount, every 5 min when visible, pauses when hidden,
  // catches up immediately on hidden→visible transitions
  useVisibilityAwareInterval(fetchMeetings, REFRESH_INTERVAL_MS, null, [todayOnly], enabled);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      // Trigger a full sync first
      await window.calendarApi.triggerSync();
      // Wait a bit for sync to complete, then refresh
      await new Promise(resolve => setTimeout(resolve, 2000));
      await fetchMeetings();
    } catch (err) {
      console.error('Failed to trigger calendar sync:', err);
      setIsLoading(false);
    }
  }, [fetchMeetings]);

  return {
    meetings,
    isLoading,
    isStale,
    lastSyncError,
    syncWarnings,
    populatedAt,
    refresh,
  };
}
