/**
 * Graduation Checker
 * 
 * Invisible component that listens for Day 14 journey completion
 * and triggers the GraduationModal.
 * 
 * Handles:
 * - Live completion (listens for journey day 14 event)
 * - Missed completion (checks on mount if day 14 already completed but modal not shown)
 * - Race condition mitigation (small delay before fetching stats)
 * - Graceful error handling (degrades to defaults if API calls fail)
 */

import { useEffect, useCallback, useRef } from 'react';
import { tracking } from '@renderer/src/tracking';

export interface GraduationData {
  badges: string[];
  stats: {
    daysCompleted: number;
    totalMinutesSaved: number;
  };
}

interface GraduationCheckerProps {
  onTrigger: (data: GraduationData) => void;
}

// Small delay to let turn-completion side effects settle before fetching stats
const SETTLE_DELAY_MS = 150;

export function GraduationChecker({ onTrigger }: GraduationCheckerProps) {
  const hasTriggeredRef = useRef(false);

  const loadStatsAndTrigger = useCallback(async () => {
    // Prevent double-trigger
    if (hasTriggeredRef.current) return;
    hasTriggeredRef.current = true;

    // Mark as shown immediately to prevent re-triggering
    try {
      await window.api.markGraduationShown?.();
    } catch {
      // Non-critical
    }

    // Graceful degradation for each API call
    let badges: string[] = [];
    let daysCompleted = 14;
    let totalMinutesSaved = 0;

    try {
      const badgesData = await window.api.getBadges?.();
      badges = badgesData ? Object.keys(badgesData) : [];
    } catch {
      // Gracefully degrade - show modal with 0 badges
    }

    try {
      const journey = await window.api.getOnboardingJourney?.();
      daysCompleted = journey?.completedDays.length ?? 14;
    } catch {
      // Gracefully degrade
    }

    try {
      const timeSaved = await window.api.getTimeSavedAggregates?.();
      totalMinutesSaved = timeSaved?.aggregates?.allTime?.totalMinutes ?? 
                         (timeSaved as { allTime?: { totalMinutes?: number } })?.allTime?.totalMinutes ?? 0;
    } catch {
      // Gracefully degrade
    }

    // Track graduation shown
    tracking.journey.graduationShown(badges.length, totalMinutesSaved);

    onTrigger({
      badges,
      stats: { daysCompleted, totalMinutesSaved }
    });
  }, [onTrigger]);

  // Check on mount if day 14 was already completed but modal hasn't been shown
  useEffect(() => {
    let mounted = true;

    const checkExistingCompletion = async () => {
      try {
        const shouldShow = await window.api.shouldShowGraduation?.();
        if (shouldShow && mounted) {
          void loadStatsAndTrigger();
        }
      } catch {
        // Non-critical, ignore errors
      }
    };

    void checkExistingCompletion();
    return () => { mounted = false; };
  }, [loadStatsAndTrigger]);

  // Listen for live Day 14 completion
  useEffect(() => {
    let mounted = true;

    const cleanup = window.api.onJourneyDayCompleted?.((day: number) => {
      if (day !== 14 || !mounted) return;
      
      // Small delay to let badge evaluation and other side effects settle
      setTimeout(() => {
        if (mounted) {
          void loadStatsAndTrigger();
        }
      }, SETTLE_DELAY_MS);
    });

    return () => {
      mounted = false;
      cleanup?.();
    };
  }, [loadStatsAndTrigger]);

  return null;
}
