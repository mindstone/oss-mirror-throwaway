/**
 * useSpaceActivity - Fetches activity across all spaces
 *
 * Returns memory and skill changes from the last N days for each space.
 * Used by The Spark's Spaces tab.
 */

import { useState, useEffect, useCallback } from 'react';
import type { SpaceActivity } from '@shared/ipc/channels/dashboard';

export interface SpaceActivityResult {
  spaces: SpaceActivity[];
  totalMemoryCount: number;
  totalSkillCount: number;
}

export function useSpaceActivity(dayWindow = 7): {
  data: SpaceActivityResult | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [data, setData] = useState<SpaceActivityResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchActivity = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await window.dashboardApi.getSpaceActivity({ dayWindow });
      setData(result);
    } catch (err) {
      console.error('Failed to fetch space activity:', err);
      setError(err instanceof Error ? err.message : "Couldn't load space activity");
    } finally {
      setIsLoading(false);
    }
  }, [dayWindow]);

  useEffect(() => {
    void fetchActivity();
  }, [fetchActivity]);

  return { data, isLoading, error, refresh: fetchActivity };
}
