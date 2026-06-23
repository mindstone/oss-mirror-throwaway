---
last_updated: "2026-01-22"
description: "How the NPS (Net Promoter Score) survey works in Mindstone Rebel: eligibility criteria, timing, snooze logic, analytics events, and Week 10 Pilot window."
---

### Introduction

This document explains when and how the NPS survey is shown to users in Mindstone Rebel. It covers the eligibility logic, timing constants, snooze behavior, the special Week 10 Pilot window, and analytics tracking.

### See also

- `src/renderer/features/nps/useNpsSurvey.ts` – Core eligibility logic, state management, and event handlers.
- `src/renderer/features/nps/NpsSurveyDialog.tsx` – Dialog UI component (0-10 scale, optional feedback).
- `src/shared/types.ts` – `NpsSurveyState` interface and timing constants.
- `src/renderer/App.tsx` – Where the NPS dialog is rendered and wired up.
- [ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md](./ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md) – How NPS events are tracked.

### Principles, key decisions

- **Onboarding-gated**: NPS only appears after onboarding is completed AND a completion timestamp exists (avoids immediate popup for legacy users without timestamps).
- **Gentle first-time experience**: Initial delay of 10 days after onboarding before first NPS prompt.
- **Progressive snooze**: Dismissing early snoozes for 14 days; after 2+ shows, snooze increases to 30 days.
- **Completion snooze**: After submitting, user won't see NPS again for 180 days (~6 months).
- **Week 10 Pilot window**: Special logic to re-prompt users around days 63-77 post-onboarding (for Pilot feedback collection).
- **Opt-out**: Users can set `neverShowAgain` to permanently disable NPS.

### Timing constants

| Constant | Value | Description |
|----------|-------|-------------|
| `NPS_INITIAL_DELAY_DAYS` | 10 | Days after onboarding before first eligibility |
| `NPS_DISMISS_SNOOZE_DAYS_SHORT` | 14 | Snooze after dismiss (first 1-2 times shown) |
| `NPS_DISMISS_SNOOZE_DAYS_LONG` | 30 | Snooze after dismiss (3+ times shown) |
| `NPS_COMPLETION_SNOOZE_DAYS` | 180 | Snooze after completing/submitting survey |
| `NPS_WEEK_10_START_DAYS` | 63 | Start of Week 10 Pilot window (day 63) |
| `NPS_WEEK_10_END_DAYS` | 77 | End of Week 10 Pilot window (day 77) |

### Eligibility logic

The survey shows when ALL of the following are true:

1. **Onboarding complete**: `settings.onboardingCompleted === true`
2. **Has completion timestamp**: `settings.onboardingFirstCompletedAt` exists (filters out legacy users)
3. **Minimum time passed**: At least 10 days since onboarding completion
4. **Not permanently disabled**: `nps.neverShowAgain !== true`
5. **Not currently snoozed**: `now >= nps.snoozeUntil` (or no snooze set)
6. **Not recently completed**: Last completion was more than 1 day ago

**Week 10 window special case**: If user is between days 63-77 post-onboarding AND has completed NPS at least once before AND hasn't been shown during this window yet, they become eligible again (to gather Pilot feedback).

### NPS state (`NpsSurveyState`)

```typescript
interface NpsSurveyState {
  firstEligibleAt: number | null;    // When user first became eligible
  lastShownAt: number | null;        // Last time dialog was displayed
  lastDismissedAt: number | null;    // Last explicit dismiss
  lastCompletedAt: number | null;    // Last submission
  lastScore: number | null;          // Most recent 0-10 score
  lastFeedback: string | null;       // Most recent feedback text
  showCount: number;                 // Total times shown
  completedCount: number;            // Total submissions
  snoozeUntil: number | null;        // Don't show until this timestamp
  neverShowAgain: boolean;           // Permanent opt-out
}
```

### Analytics events

| Event | When | Properties |
|-------|------|------------|
| `NPS Survey Shown` | Dialog opens | `showCount`, `daysSinceOnboarding` |
| `NPS Survey Dismissed` | User clicks "Not now" | `showCount`, `snoozeDays` |
| `NPS Survey Submitted` | User submits | `score`, `promoterType`, `feedbackLength` |

**Promoter classification**:
- Score 9-10: `promoter`
- Score 7-8: `passive`
- Score 0-6: `detractor`

### User flow

1. User completes onboarding → `onboardingFirstCompletedAt` is set
2. After 10 days, user becomes eligible
3. On next app session (when not blocked by other modals), NPS dialog auto-opens
4. User can:
   - **Submit**: Score and optional feedback saved, snoozed for 180 days
   - **Dismiss**: Snoozed for 14-30 days depending on show count
   - **Press Escape**: Same as dismiss

### Blocking

The `blocked` prop on `useNpsSurvey` prevents auto-opening when other modals/dialogs are active (e.g., onboarding tutorial, settings panel). The dialog won't appear until `blocked === false`.

### Troubleshooting

- **NPS not showing after 10 days**: Check if `onboardingFirstCompletedAt` is set (legacy users may lack this).
- **NPS showing too frequently**: Verify `snoozeUntil` is being persisted correctly.
- **NPS never shows**: Check `nps.neverShowAgain` isn't `true`.

### Maintenance

When changing NPS timing or behavior:
1. Update constants in `src/shared/types.ts`
2. Update eligibility logic in `useNpsSurvey.ts`
3. Update this doc with new timing values
