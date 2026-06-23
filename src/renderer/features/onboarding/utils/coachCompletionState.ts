import type { AppSettings } from '@shared/types';

/**
 * Single source of truth for "coach activation completion".
 *
 * The onboarding coach intro (Home activation card → coach conversation) is
 * considered complete when ANY of three redundant settings signals is set.
 * The redundancy is deliberate and load-bearing — do not "simplify" to one
 * canonical field:
 * - `onboardingCompletedAt` — the modern signal, written by
 *   `handleCoachComplete` (OnboardingCoachOrchestrator.tsx).
 * - `onboardingChecklist.completedSteps[0]` — written alongside it; the ONLY
 *   signal that survives machine-migration imports (the migration sanitizer
 *   transfers `onboardingChecklist` but drops `onboardingCompletedAt` /
 *   `onboardingDay` / `onboardingSessionIds`).
 * - `onboardingDay >= 1` — legacy signal from before `onboardingCompletedAt`
 *   existed.
 *
 * These two functions MUST stay in lockstep: every signal the predicate reads,
 * the reset must clear (May 2026 drift between the App.tsx suppression memo
 * and `handleRelaunchOnboarding`'s hand-rolled field list left relaunching
 * users with no activation card and no coach — see
 * docs/plans/260611_coach-chat-missing-after-onboarding/PLAN.md). The
 * composition contract `hasCoachCompletionSignal(clearCoachCompletionState(s))
 * === false` is enforced by tests in `__tests__/coachCompletionState.test.ts`.
 * NOTE the limits of that guard: it pins today's signal set via fixtures — it
 * does not auto-discover future signals. If you add a NEW signal to the
 * predicate, you MUST also add a completed fixture that carries it (and
 * clear it in the reset), or the drift test will pass vacuously.
 *
 * Notes:
 * - These settings keys dual-write to cloud settings (`settings:update` in
 *   `src/shared/cloudChannelPolicies.ts`; not stripped by
 *   `cloudSettingsPolicy.ts`), though no cloud/mobile consumer interprets
 *   them today — the reset syncs harmlessly.
 * - Relaunching onboarding deliberately does NOT reset tutorial-checklist
 *   progress (`step`, `completedSteps[1-4]`, `isExpanded`); the separate
 *   Settings "Reset checklist" action (`handleResetOnboardingChecklist` in
 *   App.tsx) owns that.
 */

/**
 * True iff the user has completed the onboarding coach intro, per any of the
 * three redundant completion signals (the May 2026 behavioural contract from
 * docs/plans/260505_home_onboarding_activation.md). Does NOT consider
 * `onboardingCompleted` (wizard completion) — callers gate on that separately.
 */
export function hasCoachCompletionSignal(
  settings:
    | Pick<AppSettings, 'onboardingCompletedAt' | 'onboardingDay' | 'onboardingChecklist'>
    | null
    | undefined,
): boolean {
  if (!settings) return false;
  if (settings.onboardingCompletedAt) return true;
  if (settings.onboardingChecklist?.completedSteps?.[0] === true) return true;
  if (settings.onboardingDay != null && settings.onboardingDay >= 1) return true;
  return false;
}

/**
 * Pure reset companion to {@link hasCoachCompletionSignal}: returns settings
 * with every coach completion signal AND stale coach resume pointer cleared,
 * so the Home activation card shows again and offers a FRESH intro.
 *
 * Clears exactly: `onboardingCompletedAt`, `onboardingDay`,
 * `onboardingSessionIds`, `onboardingChecklist.completedSteps[0]`,
 * `onboardingChecklist.sessionIds[0]` (stale pointer — left in place, the card
 * would read "Continue your intro" and reopen the finished session).
 *
 * Preserves all other state, including the rest of `onboardingChecklist`
 * (`step`, `completedSteps[1-4]`, `isExpanded`, `sessionIds[1+]`) and
 * `onboardingFirstCompletedAt`.
 */
export function clearCoachCompletionState(settings: AppSettings): AppSettings {
  const checklist = settings.onboardingChecklist;
  let nextChecklist = checklist;
  if (checklist) {
    const completedSteps = checklist.completedSteps ? { ...checklist.completedSteps } : undefined;
    if (completedSteps) delete completedSteps[0];
    const sessionIds = checklist.sessionIds ? { ...checklist.sessionIds } : undefined;
    if (sessionIds) delete sessionIds[0];
    nextChecklist = { ...checklist, completedSteps, sessionIds };
  }
  return {
    ...settings,
    onboardingCompletedAt: undefined,
    onboardingDay: undefined,
    onboardingSessionIds: undefined,
    onboardingChecklist: nextChecklist,
  };
}
