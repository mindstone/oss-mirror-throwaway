/**
 * Hook to detect company values status for company/team spaces.
 * Returns a map of space paths to their values status.
 */

import { useMemo } from 'react';
import { useSettingsSafe } from '@renderer/features/settings';
import { useSpacesData } from '@renderer/hooks/useSpacesData';
import { isStale, getDaysSinceReview } from '../utils/dateUtils';

export type ValuesStatus = 'not_set' | 'current' | 'stale';

export interface SpaceValuesInfo {
  spacePath: string;
  spaceName: string;
  status: ValuesStatus;
  lastReviewed: string | null;
  daysSinceReview: number | null;
}

/**
 * Hook to get company values status for all company/team spaces.
 * Returns spaces that need values setup or have stale values.
 */
export const useCompanyValuesStatus = (): {
  spacesNeedingValues: SpaceValuesInfo[];
  isLoading: boolean;
} => {
  const settingsContext = useSettingsSafe();
  const { spaces, loading, error } = useSpacesData(settingsContext?.settings?.coreDirectory);

  const spacesNeedingValues = useMemo(() => {
    if (loading || error) return [];

    const needingValues: SpaceValuesInfo[] = [];

    for (const space of spaces) {
      if (space.type !== 'company' && space.type !== 'team') {
        continue;
      }

      const lastReviewed = space.valuesLastReviewed ?? null;

      if (!lastReviewed) {
        needingValues.push({
          spacePath: space.path,
          spaceName: space.displayName || space.name,
          status: 'not_set',
          lastReviewed: null,
          daysSinceReview: null,
        });
      } else if (isStale(lastReviewed)) {
        needingValues.push({
          spacePath: space.path,
          spaceName: space.displayName || space.name,
          status: 'stale',
          lastReviewed,
          daysSinceReview: getDaysSinceReview(lastReviewed),
        });
      }
    }

    return needingValues;
  }, [error, loading, spaces]);

  return { spacesNeedingValues, isLoading: loading };
};
