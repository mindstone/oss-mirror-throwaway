/**
 * useSparkContent - Content prioritization for The Spark
 *
 * Implements the "launchpad, not dashboard" principle:
 * - Coaching always wins for hero position
 * - Community section always shows at bottom as page ending
 */

import { useMemo } from 'react';
import type { CoachingInsightWithContext } from './useCoachingInsights';
import type { CommunityHighlight } from '@shared/types';

export interface SparkContent {
  /** Primary coaching insight for hero (if any) */
  heroCoaching: CoachingInsightWithContext | null;
  /** Primary community highlight for hero (only if no coaching) */
  heroCommunity: CommunityHighlight | null;
  /** Additional coaching insights (after hero) */
  collapsedCoaching: CoachingInsightWithContext[];
  /** Community card to show at bottom of page */
  communityCard: CommunityHighlight | null;
}

/** @deprecated Scheduled for removal — no longer used after Spark simplification */
export function useSparkContent(
  coachingInsights: CoachingInsightWithContext[],
  communityHighlights: CommunityHighlight[]
): SparkContent {
  return useMemo(() => {
    // Hero: coaching always wins
    const heroCoaching = coachingInsights[0] ?? null;
    const heroCommunity = !heroCoaching ? (communityHighlights[0] ?? null) : null;

    // Collapsed coaching: everything after the hero
    const collapsedCoaching = coachingInsights.length > 1
      ? coachingInsights.slice(1)
      : [];

    // Community card always shows at bottom (use next highlight if first is in hero)
    const communityCard = heroCommunity
      ? (communityHighlights[1] ?? null)
      : (communityHighlights[0] ?? null);

    return {
      heroCoaching,
      heroCommunity,
      collapsedCoaching,
      communityCard,
    };
  }, [coachingInsights, communityHighlights]);
}
