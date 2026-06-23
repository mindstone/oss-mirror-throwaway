/**
 * useMeetingHistoryStatus - Fetches transcript status for meetings
 *
 * Used by The Spark to show status indicators on meeting cards.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { MeetingTranscriptStatus, MeetingHistoryEntry, CachedMeeting } from '@shared/ipc/channels/calendar';

export interface UseMeetingHistoryStatusResult {
  /** Map of calendarEventId -> transcript status */
  statuses: Record<string, MeetingTranscriptStatus>;
  /** Meetings that were missed (no transcript) in the past 7 days */
  missedMeetings: MeetingHistoryEntry[];
  missedCount: number;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

interface MeetingLookupKey {
  calendarSource: string;
  calendarEventId: string;
}

/**
 * Fetch transcript status for a list of calendar meetings.
 * Also fetches missed meetings from the past 7 days.
 */
export function useMeetingHistoryStatus(meetings: Pick<CachedMeeting, 'calendarSource' | 'calendarEventId'>[], enabled = true): UseMeetingHistoryStatusResult {
  const [statuses, setStatuses] = useState<Record<string, MeetingTranscriptStatus>>({});
  const [missedMeetings, setMissedMeetings] = useState<MeetingHistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Track previous keys to avoid unnecessary fetches (sort copy to avoid mutating prop)
  const prevKeyRef = useRef<string>('');
  const meetingsKey = [...meetings]
    .map(m => `${m.calendarSource}:${m.calendarEventId}`)
    .sort()
    .join(',');

  const fetchData = useCallback(async () => {
    try {
      // Fetch statuses for the provided meetings
      if (meetings.length > 0) {
        const lookupKeys: MeetingLookupKey[] = meetings.map(m => ({
          calendarSource: m.calendarSource,
          calendarEventId: m.calendarEventId,
        }));
        const statusResult = await window.calendarApi.getMeetingHistoryStatus({ meetings: lookupKeys });
        setStatuses(statusResult.statuses);
      } else {
        setStatuses({});
      }

      // Fetch missed meetings from past 7 days
      const missedResult = await window.calendarApi.getMissedMeetings({ days: 7 });
      setMissedMeetings(missedResult.meetings);
    } catch (err) {
      console.error('Failed to fetch meeting history status:', err);
    } finally {
      setIsLoading(false);
    }
  }, [meetings]);

  // Fetch on mount and when meetings change, with polling interval
  useEffect(() => {
    if (!enabled) return;

    // Only fetch if meetings changed
    if (meetingsKey !== prevKeyRef.current) {
      prevKeyRef.current = meetingsKey;
      setIsLoading(true);
    }

    fetchData();

    // Refresh every 2 minutes (transcript status can change)
    const interval = setInterval(fetchData, 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [meetingsKey, fetchData, enabled]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    await fetchData();
  }, [fetchData]);

  return {
    statuses,
    missedMeetings,
    missedCount: missedMeetings.length,
    isLoading,
    refresh,
  };
}
