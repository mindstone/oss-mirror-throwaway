import { useEffect, useCallback, useRef } from 'react';
import { useAppContext } from '@renderer/contexts/AppContext';
import { useSessionStore } from '@renderer/features/agent-session/store/sessionStore';
import { shouldHandleMilestoneTimeSavedStatus } from '@renderer/utils/timeSavedStatusRouting';

const MILESTONE_LABELS: Record<number, string> = {
  60: '1 hour',
  600: '10 hours',
  1440: '1 day',
  3000: '50 hours',
  6000: '100 hours',
  10080: '1 week',
  43200: '1 month',
  525600: '1 year',
  5256000: '10 years'
};

const MILESTONE_QUIPS: Record<number, readonly string[]> = {
  60: [
    "An hour reclaimed. Your calendar thanks you.",
    "Sixty minutes. That's a whole meeting you didn't have.",
    "One hour down. Many more where that came from."
  ],
  600: [
    "Ten hours. That's practically a sabbatical.",
    "A full workday, plus interest.",
    "The productivity dividend is paying off."
  ],
  1440: [
    "A full day saved. Use it wisely.",
    "Twenty-four hours. Time is real again.",
    "One day. The math is starting to look impressive."
  ],
  3000: [
    "Fifty hours. That's a work week, returned.",
    "A week's worth of work. Delegated.",
    "Fifty hours you spent doing other things."
  ],
  6000: [
    "One hundred hours. We've been busy.",
    "Two work weeks. Not bad for a computer.",
    "A hundred hours. The compound interest of automation."
  ],
  10080: [
    "A full week saved. 168 hours of your life, back.",
    "One week. That's a vacation you earned.",
    "Seven days. Time moves differently now."
  ],
  43200: [
    "A month of your life, reclaimed.",
    "Thirty days. That's a chapter, not a footnote.",
    "One month. The future arrived early."
  ],
  525600: [
    "One year. 8,760 hours. Let that sink in.",
    "A full year saved. You lived it twice.",
    "365 days. This is what leverage looks like."
  ],
  5256000: [
    "A decade. Ten years of your life, returned.",
    "Ten years. We've been through a lot together.",
    "A decade saved. The singularity was you."
  ]
};

const getRandomQuip = (milestone: number): string => {
  const quips = MILESTONE_QUIPS[milestone] ?? ["Milestone reached."];
  return quips[Math.floor(Math.random() * quips.length)];
};

const FIRST_HIGH_IMPACT_QUIPS = [
  "That was a real one. Noted.",
  "Now we're talking.",
  "Filed under: actually useful.",
];

const getFirstHighImpactQuip = (): string => {
  return FIRST_HIGH_IMPACT_QUIPS[Math.floor(Math.random() * FIRST_HIGH_IMPACT_QUIPS.length)];
};

export const TimeSavedMilestoneChecker = () => {
  const { showToast } = useAppContext();
  const firstHighImpactShownRef = useRef(false);

  const checkAndShowMilestone = useCallback(async () => {
    try {
      const milestone = await window.api.getNextTimeSavedMilestone();
      if (milestone) {
        const label = MILESTONE_LABELS[milestone] ?? `${milestone} minutes`;
        const quip = getRandomQuip(milestone);
        
        showToast({ title: `${label} saved: ${quip}` });

        await window.api.acknowledgeTimeSavedMilestone(milestone);
      }
    } catch (error) {
      console.error('Failed to check time saved milestone:', error);
    }
  }, [showToast]);

  const checkFirstHighImpact = useCallback(async (impact: string | undefined) => {
    if (impact !== 'critical' && impact !== 'high') return;
    // Local guard to prevent race condition and skip IPC after shown
    if (firstHighImpactShownRef.current) return;
    
    try {
      const shouldShow = await window.api.shouldShowFirstHighImpact();
      if (shouldShow) {
        firstHighImpactShownRef.current = true; // Guard before async toast
        showToast({ title: `⚡ ${getFirstHighImpactQuip()}` });
        await window.api.markFirstHighImpactShown();
      } else {
        // Already shown in store, sync local ref
        firstHighImpactShownRef.current = true;
      }
    } catch (error) {
      console.error('Failed to check first high-impact:', error);
    }
  }, [showToast]);

  useEffect(() => {
    // Check on mount in case there's an unacknowledged milestone
    checkAndShowMilestone();

    // Check when a new estimate comes in
    const cleanup = window.api.onTimeSavedStatus((status) => {
      const activeSessionId = useSessionStore.getState().currentSessionId;
      if (!shouldHandleMilestoneTimeSavedStatus(status, activeSessionId)) {
        return;
      }

      checkAndShowMilestone();
      // Check for first high-impact toast
      checkFirstHighImpact(status.estimate?.impact);
    });

    return cleanup;
  }, [checkAndShowMilestone, checkFirstHighImpact]);

  return null;
};
