/**
 * Reusable in-app survey system types.
 *
 * See docs/plans/260402_in_app_survey_system.md for design rationale.
 */

export type SurveyQuestionType = 'scale' | 'open-ended';

export interface SurveyScaleQuestion {
  type: 'scale';
  text: string;
  /** Minimum value (inclusive). Default: 1 */
  min?: number;
  /** Maximum value (inclusive). Default: 5 */
  max?: number;
  /** Label for the low end of the scale */
  minLabel?: string;
  /** Label for the high end of the scale */
  maxLabel?: string;
}

export interface SurveyOpenEndedQuestion {
  type: 'open-ended';
  text: string;
  /** Placeholder text for the textarea */
  placeholder?: string;
}

export type SurveyQuestion = SurveyScaleQuestion | SurveyOpenEndedQuestion;

export interface SurveySnoozePolicy {
  /** How many times the survey can be dismissed before it stops appearing. */
  maxDismissals: number;
  /** Days to snooze after each dismissal. */
  snoozeDays: number;
}

export interface SurveyConfig {
  id: string;
  title: string;
  subtitle?: string;
  questions: SurveyQuestion[];
  snoozePolicy: SurveySnoozePolicy;
  /** Epoch ms — survey stops showing after this date, even for users who haven't seen it. */
  expiresAt?: number;
  /** Minimum days after onboarding before the survey becomes eligible. */
  minDaysAfterOnboarding?: number;
}

/**
 * Persisted state for a single survey instance.
 * Stored in AppSettings.surveys keyed by survey ID.
 */
export interface SurveyState {
  showCount: number;
  dismissCount: number;
  completed: boolean;
  /** Epoch ms — don't show before this time. */
  snoozeUntil: number | null;
  /** Epoch ms — last time the survey was shown. */
  lastShownAt: number | null;
  /** Epoch ms — when the survey was completed. */
  completedAt: number | null;
}

export const DEFAULT_SURVEY_STATE: SurveyState = {
  showCount: 0,
  dismissCount: 0,
  completed: false,
  snoozeUntil: null,
  lastShownAt: null,
  completedAt: null,
};
