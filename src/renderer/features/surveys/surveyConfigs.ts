import type { SurveyConfig } from '@shared/types/survey';

export const ACTIONS_FEEDBACK_SURVEY: SurveyConfig = {
  id: 'actions-feedback-v1',
  title: 'Got a minute?',
  subtitle: 'Help us make Actions better — five quick questions.',
  questions: [
    {
      type: 'scale',
      text: 'How clear is the purpose of the Actions tab?',
      min: 1,
      max: 5,
      minLabel: 'Not at all clear',
      maxLabel: 'Very clear',
    },
    {
      type: 'open-ended',
      text: 'Anything unclear about Actions?',
      placeholder: 'Tell us what trips you up…',
    },
    {
      type: 'scale',
      text: 'Have Actions suggestions been useful in your day-to-day?',
      min: 1,
      max: 5,
      minLabel: 'Not at all',
      maxLabel: 'Very much',
    },
    {
      type: 'open-ended',
      text: 'What do you expect "Auto mark as done" to do?',
      placeholder: 'Describe what you expect…',
    },
    {
      type: 'open-ended',
      text: 'What one thing would you change about Actions?',
      placeholder: 'One thing that would make it better…',
    },
  ],
  snoozePolicy: {
    maxDismissals: 1,
    snoozeDays: 4,
  },
  expiresAt: new Date('2026-04-19T23:59:59Z').getTime(),
  minDaysAfterOnboarding: 5,
};
