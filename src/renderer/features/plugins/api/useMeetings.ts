/**
 * useMeetings — Plugin hook for accessing cached calendar meetings
 *
 * Provides read-only access to the meeting cache via IPC. Returns a
 * plugin-safe meeting shape that omits sensitive fields (emails,
 * filesystem paths, calendar source).
 *
 * Auto-fetches on mount. The `refresh()` function triggers a re-fetch.
 *
 * @see src/main/ipc/pluginHandlers.ts — get-meetings handler
 * @see src/core/services/meetingCacheStore.ts — meeting cache store
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { PluginMeeting, UseMeetingsResult } from './types';
import { usePluginId } from './PluginContext';

export function useMeetings(params?: { todayOnly?: boolean }): UseMeetingsResult {
  const pluginId = usePluginId();
  const [meetings, setMeetings] = useState<PluginMeeting[]>([]);
  const [isStale, setIsStale] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchIdRef = useRef(0);

  const todayOnly = params?.todayOnly;

  const fetchMeetings = useCallback(async () => {
    const requestId = ++fetchIdRef.current;
    setIsLoading(true);
    setError(null);

    try {
      if (typeof window === 'undefined' || !window.pluginsApi?.getMeetings) {
        throw new Error('Meetings API not available');
      }
      const response = await window.pluginsApi.getMeetings({
        pluginId,
        ...(todayOnly != null ? { todayOnly } : {}),
      });

      if (requestId === fetchIdRef.current) {
        setMeetings(response.meetings);
        setIsStale(response.isStale);
        setIsLoading(false);
      }
    } catch (err) {
      if (requestId === fetchIdRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load meetings');
        setIsLoading(false);
      }
    }
  }, [pluginId, todayOnly]);

  // Auto-fetch on mount and when todayOnly changes
  useEffect(() => {
    void fetchMeetings();
  }, [fetchMeetings]);

  return { meetings, isStale, isLoading, error, refresh: fetchMeetings };
}
