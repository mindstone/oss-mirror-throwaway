import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings } from '@shared/types';
import {
  NPS_COMPLETION_SNOOZE_DAYS,
  NPS_DISMISS_SNOOZE_DAYS_LONG,
  NPS_DISMISS_SNOOZE_DAYS_SHORT,
  NPS_INITIAL_DELAY_DAYS
} from '@shared/types';
import { tracking } from '@/src/tracking';

type SaveSettingsWith = (updater: (current: AppSettings) => AppSettings) => Promise<void>;

export type UseNpsSurveyOptions = {
  settings: AppSettings | null;
  saveSettingsWith: SaveSettingsWith;
  blocked?: boolean;
};

export type UseNpsSurveyResult = {
  showNps: boolean;
  openNps: () => void;
  closeNps: () => void;
  handleDismiss: () => Promise<void>;
  handleSubmit: (score: number, feedback: string) => Promise<void>;
};

const days = (n: number) => n * 24 * 60 * 60 * 1000;

// Week 10 survey window for the Pilot (days 63-77, i.e., week 9-11)
const NPS_WEEK_10_START_DAYS = 63;
const NPS_WEEK_10_END_DAYS = 77;
// Minimum grace period after onboarding before showing NPS (even if firstEligibleAt is set)
const NPS_MIN_DAYS_AFTER_ONBOARDING = NPS_INITIAL_DELAY_DAYS;

export const useNpsSurvey = ({
  settings,
  saveSettingsWith,
  blocked
}: UseNpsSurveyOptions): UseNpsSurveyResult => {
  const [open, setOpen] = useState(false);
  const hasTrackedShownRef = useRef(false);
  const isSubmittingRef = useRef(false);
  // Capture timestamp once on mount to avoid re-renders from changing `now`
  const mountTimeRef = useRef(Date.now());

  const nps = settings?.nps;
  const onboardingFirstCompletedAt = settings?.onboardingFirstCompletedAt;

  const isEligible = useMemo(() => {
    const now = mountTimeRef.current;
    
    if (!settings) return false;
    
    // Must have completed onboarding AND have a recorded completion timestamp.
    // Users who onboarded before we started tracking won't see NPS (this avoids
    // immediate popup for team members who lack onboardingFirstCompletedAt).
    if (!settings.onboardingCompleted || !onboardingFirstCompletedAt) return false;
    if (!nps) return false;
    if (nps.neverShowAgain) return false;
    
    const daysSinceOnboarding = (now - onboardingFirstCompletedAt) / days(1);
    
    // Safety: don't show NPS until at least the initial delay has passed
    if (daysSinceOnboarding < NPS_MIN_DAYS_AFTER_ONBOARDING) return false;
    
    // Check if we're in the Week 10 window (for Pilot: show NPS again around week 10)
    const inWeek10Window =
      daysSinceOnboarding >= NPS_WEEK_10_START_DAYS &&
      daysSinceOnboarding <= NPS_WEEK_10_END_DAYS;
    
    // In Week 10 window: show if user has completed at least once before
    // and hasn't been shown during this window yet
    if (inWeek10Window && (nps.completedCount ?? 0) >= 1) {
      const lastShown = nps.lastShownAt;
      // If never shown, show now
      if (!lastShown) return true;
      // If last shown was before the week 10 window started, show again
      const lastShownDaysSinceOnboarding = (lastShown - onboardingFirstCompletedAt) / days(1);
      if (lastShownDaysSinceOnboarding < NPS_WEEK_10_START_DAYS) {
        // Respect dismiss snooze even in week 10 (so dismissing still works)
        if (typeof nps.snoozeUntil === 'number' && now < nps.snoozeUntil) return false;
        return true;
      }
      // Already shown in week 10 window, don't show again
      return false;
    }
    
    // Standard eligibility: first show at day 10 (or firstEligibleAt if set)
    const firstEligibleAt = nps.firstEligibleAt ?? onboardingFirstCompletedAt + days(NPS_MIN_DAYS_AFTER_ONBOARDING);
    if (now < firstEligibleAt) return false;
    if (typeof nps.snoozeUntil === 'number' && now < nps.snoozeUntil) return false;
    // If just completed very recently (guard against race), don't show
    if (typeof nps.lastCompletedAt === 'number' && nps.lastCompletedAt > now - days(1)) return false;
    
    return true;
  }, [settings, nps, onboardingFirstCompletedAt]);

  const shouldShow = isEligible && !blocked;

  const openNps = useCallback(() => setOpen(true), []);
  const closeNps = useCallback(() => setOpen(false), []);

  // Auto-open when eligible and not blocked
  useEffect(() => {
    if (shouldShow && !open) {
      setOpen(true);
    }
  }, [shouldShow, open]);

  // Track 'shown' and increment counters when opened
  useEffect(() => {
    if (!open || !isEligible || !nps || hasTrackedShownRef.current) return;
    hasTrackedShownRef.current = true;
    const now = mountTimeRef.current;
    void (async () => {
      await saveSettingsWith((current) => {
        const currentNps = current.nps;
        if (!currentNps) return current;
        const showCount = (currentNps.showCount ?? 0) + 1;
        return {
          ...current,
          nps: {
            ...currentNps,
            lastShownAt: Date.now(),
            showCount
          }
        };
      });
      tracking.nps.surveyShown(
        (nps.showCount ?? 0) + 1,
        Math.round((now - (onboardingFirstCompletedAt ?? now)) / days(1))
      );
    })();
  }, [open, isEligible, nps, onboardingFirstCompletedAt, saveSettingsWith]);

  const handleDismiss = useCallback(async () => {
    // Use latest nps from params; compute snooze based on updated showCount (+1 already applied on open)
    const count = (nps?.showCount ?? 0);
    const snoozeDays = count < 2 ? NPS_DISMISS_SNOOZE_DAYS_SHORT : NPS_DISMISS_SNOOZE_DAYS_LONG;
    const newSnooze = Date.now() + days(snoozeDays);
    await saveSettingsWith((current) => {
      if (!current.nps) return current;
      return {
        ...current,
        nps: {
          ...current.nps,
          lastDismissedAt: Date.now(),
          snoozeUntil: newSnooze
        }
      };
    });
    tracking.nps.surveyDismissed(nps?.showCount ?? 0, snoozeDays);
    setOpen(false);
    hasTrackedShownRef.current = false;
  }, [nps, saveSettingsWith]);

  const handleSubmit = useCallback(
    async (score: number, feedback: string) => {
      // Prevent duplicate submissions (defense in depth alongside UI lock)
      if (isSubmittingRef.current) return;
      isSubmittingRef.current = true;
      try {
        const promoterType = score >= 9 ? 'promoter' : score >= 7 ? 'passive' : 'detractor';
        const nextSnooze = Date.now() + days(NPS_COMPLETION_SNOOZE_DAYS);
        await saveSettingsWith((current) => {
          if (!current.nps) return current;
          return {
            ...current,
            nps: {
              ...current.nps,
              lastCompletedAt: Date.now(),
              lastScore: score,
              lastFeedback: feedback?.trim() ? feedback.trim() : null,
              completedCount: (current.nps.completedCount ?? 0) + 1,
              snoozeUntil: nextSnooze
            }
          };
        });
        tracking.nps.surveySubmitted(score, promoterType, feedback?.length ?? 0);
        setOpen(false);
        hasTrackedShownRef.current = false;
      } finally {
        isSubmittingRef.current = false;
      }
    },
    [saveSettingsWith]
  );

  return {
    showNps: Boolean(open && shouldShow),
    openNps,
    closeNps,
    handleDismiss,
    handleSubmit
  };
};
