/**
 * Hook to detect personal goals status from Chief-of-Staff space.
 * Returns status: 'not_set' | 'current' | 'stale' based on frontmatter presence and date.
 */

import { useMemo } from 'react';
import { useSettingsSafe } from '@renderer/features/settings';
import { useSpacesData } from '@renderer/hooks/useSpacesData';
import { isStale, getDaysSinceReview } from '../utils/dateUtils';

export type GoalsStatus = 'not_set' | 'current' | 'stale' | 'loading';

interface PersonalGoalsState {
  status: GoalsStatus;
  lastReviewed: string | null;
  daysSinceReview: number | null;
}

/**
 * Hook to get personal goals status from Chief-of-Staff space.
 */
export const usePersonalGoalsStatus = (): PersonalGoalsState => {
  const settingsContext = useSettingsSafe();
  const { spaces, loading, error } = useSpacesData(settingsContext?.settings?.coreDirectory);

  return useMemo(() => {
    if (loading) {
      return { status: 'loading', lastReviewed: null, daysSinceReview: null };
    }
    if (error) {
      return { status: 'not_set', lastReviewed: null, daysSinceReview: null };
    }

    const chiefOfStaff = spaces.find(s => s.type === 'chief-of-staff');
    const lastReviewed = chiefOfStaff?.goalsLastReviewed ?? null;

    if (!lastReviewed) {
      return { status: 'not_set', lastReviewed: null, daysSinceReview: null };
    }

    const daysSinceReview = getDaysSinceReview(lastReviewed);
    const status = isStale(lastReviewed) ? 'stale' : 'current';

    return { status, lastReviewed, daysSinceReview };
  }, [error, loading, spaces]);
};
