/**
 * Streak Milestone Checker
 * 
 * Invisible component that listens for streak milestone events
 * and shows celebratory toasts. Pattern follows TimeSavedMilestoneChecker.
 */

import { useEffect, useCallback, useRef } from 'react';
import { useAppContext } from '@renderer/contexts/AppContext';
import { tracking } from '@renderer/src/tracking';

const STREAK_MILESTONE_QUIPS: Record<number, readonly string[]> = {
  3: [
    "A habit starts to form. The neuroscience is on your side.",
    "Three days. Pattern recognition is kicking in.",
    "Day three. Your brain is paying attention now."
  ],
  7: [
    "One week. Duolingo would be proud.",
    "Seven days. The owl can rest easy.",
    "A full week. Momentum is real."
  ],
  14: [
    "Two weeks. This is becoming a thing.",
    "Fourteen days. You're in habit territory now.",
    "Two weeks straight. Impressive commitment."
  ],
  30: [
    "A month of augmented productivity. You're in the 5% now.",
    "Thirty days. This isn't a phase anymore.",
    "One month. The compound interest begins."
  ],
  60: [
    "Two months. Compound returns are compounding.",
    "Sixty days. This is who you are now.",
    "Two months straight. Respect."
  ],
  100: [
    "Triple digits. You're not using AI - you're leveraging it.",
    "One hundred days. Centurion status achieved.",
    "A hundred days. The future arrived early for you."
  ],
  365: [
    "A full year. The singularity was you.",
    "365 days. You've lived this year differently.",
    "One year. This isn't just a tool anymore."
  ]
};

const getRandomQuip = (milestone: number): string => {
  const quips = STREAK_MILESTONE_QUIPS[milestone] ?? ["Milestone reached."];
  return quips[Math.floor(Math.random() * quips.length)];
};

export const StreakMilestoneChecker = () => {
  const { showToast } = useAppContext();
  const previousLongestRef = useRef<number | null>(null);

  const handleStreakMilestone = useCallback((milestone: number, longest: number) => {
    const isPersonalBest = previousLongestRef.current !== null && milestone > previousLongestRef.current;
    previousLongestRef.current = longest;

    // Track the milestone
    tracking.gamification.streakMilestoneReached(milestone, isPersonalBest);

    const quip = getRandomQuip(milestone);
    showToast({ title: `${milestone}-day streak`, description: quip });
  }, [showToast]);

  useEffect(() => {
    const cleanup = window.api.onStreakMilestone?.((milestone: number, longest?: number) => {
      handleStreakMilestone(milestone, longest ?? milestone);
    });
    return cleanup;
  }, [handleStreakMilestone]);

  return null;
};
