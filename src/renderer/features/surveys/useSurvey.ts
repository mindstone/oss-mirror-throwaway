import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings } from '@shared/types';
import type { SurveyConfig, SurveyState } from '@shared/types/survey';
import { DEFAULT_SURVEY_STATE } from '@shared/types/survey';
import { tracking } from '@/src/tracking';

type SaveSettingsWith = (updater: (current: AppSettings) => AppSettings) => Promise<void>;

export interface UseSurveyOptions {
  surveyId: string;
  config: SurveyConfig;
  settings: AppSettings | null;
  saveSettingsWith: SaveSettingsWith;
  blocked?: boolean;
}

export interface UseSurveyResult {
  showSurvey: boolean;
  surveyConfig: SurveyConfig;
  handleDismiss: (questionReached: number) => Promise<void>;
  handleComplete: (answers: Array<{ questionIndex: number; questionType: string; answer: string | number | null; comment?: string }>) => Promise<void>;
}

const days = (n: number) => n * 24 * 60 * 60 * 1000;

export const useSurvey = ({
  surveyId,
  config,
  settings,
  saveSettingsWith,
  blocked,
}: UseSurveyOptions): UseSurveyResult => {
  const [open, setOpen] = useState(false);
  const hasTrackedShownRef = useRef(false);
  const isSubmittingRef = useRef(false);
  const mountTimeRef = useRef(Date.now());
  const openedAtRef = useRef<number | null>(null);

  const state: SurveyState = useMemo(() => {
    return settings?.surveys?.[surveyId] ?? DEFAULT_SURVEY_STATE;
  }, [settings, surveyId]);

  const onboardingFirstCompletedAt = settings?.onboardingFirstCompletedAt;

  const isEligible = useMemo(() => {
    const now = mountTimeRef.current;

    if (!settings) return false;
    if (!settings.onboardingCompleted || !onboardingFirstCompletedAt) return false;
    if (state.completed) return false;
    if (typeof config.expiresAt === 'number' && now >= config.expiresAt) return false;
    if (state.dismissCount > config.snoozePolicy.maxDismissals) return false;
    if (typeof state.snoozeUntil === 'number' && now < state.snoozeUntil) return false;
    if (typeof config.minDaysAfterOnboarding === 'number' &&
        now - onboardingFirstCompletedAt < days(config.minDaysAfterOnboarding)) return false;

    return true;
  }, [settings, onboardingFirstCompletedAt, state, config.snoozePolicy.maxDismissals, config.minDaysAfterOnboarding, config.expiresAt]);

  const shouldShow = isEligible && !blocked;

  useEffect(() => {
    if (shouldShow && !open) {
      setOpen(true);
      openedAtRef.current = Date.now();
    }
  }, [shouldShow, open]);

  useEffect(() => {
    if (!open || !isEligible || hasTrackedShownRef.current) return;
    hasTrackedShownRef.current = true;
    const now = mountTimeRef.current;
    void (async () => {
      await saveSettingsWith((current) => {
        const currentState = current.surveys?.[surveyId] ?? DEFAULT_SURVEY_STATE;
        return {
          ...current,
          surveys: {
            ...current.surveys,
            [surveyId]: {
              ...currentState,
              showCount: currentState.showCount + 1,
              lastShownAt: Date.now(),
            },
          },
        };
      });
      tracking.survey.shown(
        surveyId,
        state.showCount + 1,
        Math.round((now - (onboardingFirstCompletedAt ?? now)) / days(1))
      );
    })();
  }, [open, isEligible, state, surveyId, onboardingFirstCompletedAt, saveSettingsWith]);

  const handleDismiss = useCallback(async (questionReached: number) => {
    const newDismissCount = state.dismissCount + 1;
    const canShowAgain = newDismissCount <= config.snoozePolicy.maxDismissals;
    const snoozeDays = canShowAgain ? config.snoozePolicy.snoozeDays : null;
    const newSnooze = snoozeDays ? Date.now() + days(snoozeDays) : null;

    await saveSettingsWith((current) => {
      const currentState = current.surveys?.[surveyId] ?? DEFAULT_SURVEY_STATE;
      return {
        ...current,
        surveys: {
          ...current.surveys,
          [surveyId]: {
            ...currentState,
            dismissCount: newDismissCount,
            snoozeUntil: newSnooze,
          },
        },
      };
    });
    tracking.survey.dismissed(surveyId, newDismissCount, questionReached, snoozeDays);
    setOpen(false);
    hasTrackedShownRef.current = false;
  }, [state, config, surveyId, saveSettingsWith]);

  const handleComplete = useCallback(async (
    answers: Array<{ questionIndex: number; questionType: string; answer: string | number | null; comment?: string }>
  ) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    try {
      const totalDurationMs = openedAtRef.current ? Date.now() - openedAtRef.current : 0;
      const answersGiven = answers.filter(a => a.answer !== null && a.answer !== '').length;

      await saveSettingsWith((current) => {
        const currentState = current.surveys?.[surveyId] ?? DEFAULT_SURVEY_STATE;
        return {
          ...current,
          surveys: {
            ...current.surveys,
            [surveyId]: {
              ...currentState,
              completed: true,
              completedAt: Date.now(),
            },
          },
        };
      });
      tracking.survey.completed(
        surveyId,
        config.questions.length,
        answersGiven,
        totalDurationMs,
        answers,
      );
      setOpen(false);
      hasTrackedShownRef.current = false;
    } finally {
      isSubmittingRef.current = false;
    }
  }, [surveyId, config.questions.length, saveSettingsWith]);

  return {
    showSurvey: Boolean(open && shouldShow),
    surveyConfig: config,
    handleDismiss,
    handleComplete,
  };
};
