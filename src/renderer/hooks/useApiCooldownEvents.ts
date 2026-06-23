import { useEffect, useRef } from 'react';

interface CooldownStatusChangedPayload {
  scope: 'api' | 'safety-eval' | 'safety-eval-degraded';
  state: 'entered' | 'exited';
  untilMs?: number;
  durationMs?: number;
  /** Cause of the cooldown — populated on safety-eval-degraded scope only. */
  reasonKind?: 'billing' | 'rate_limit' | 'auth' | 'model_unavailable' | 'other';
  /** Absolute epoch-ms reset time — populated on safety-eval-degraded / billing when provider returned one. */
  resetAtMs?: number;
}

type CooldownToast = {
  title: string;
  description: string;
  variant: 'warning';
  action?: {
    label: string;
    onClick: () => void;
  };
};

/**
 * Per-source signals that make the cooldown impact-moment user-relevant.
 * The hook OR-aggregates these into a single "blocks user work" decision
 * and, when no source is active, emits per-source suppression telemetry so
 * "I expected a toast and didn't get one" is debuggable.
 */
export interface UserWorkSignals {
  activeTurn: boolean;
  recentSubmit: boolean;
  voiceActive: boolean;
  composerHasText: boolean;
}

interface UseApiCooldownEventsOptions {
  getUserWorkSignals: () => UserWorkSignals;
  showToast: (toast: CooldownToast) => void;
  navigateToDiagnostics: () => void;
  navigateToAgentsSettings: () => void;
  hasBackgroundFallbackConfigured: () => boolean;
}

type SuppressedReason =
  | 'not_api_scope'
  | 'no_active_turn'
  | 'no_recent_submit'
  | 'voice_inactive'
  | 'composer_empty'
  | 'dedup_60s'
  | 'exited';

const DEDUP_WINDOW_MS = 60_000;

function formatResetTime(untilMs: number): string {
  return new Date(untilMs).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Format a reset timestamp for user display, aware that usage-cap resets can
 * be many hours (or ~2 days) out.  A bare time-of-day ("around 2:00 PM") is
 * misleading when the reset is not today — include the day in that case.
 *
 * Uses `formatResetTime` for the time portion (single source of formatting
 * truth per the DA invariant).
 */
function formatResetTimeWithDay(resetAtMs: number): string {
  const now = new Date();
  const resetDate = new Date(resetAtMs);

  // Compare calendar dates in local time (getDate / getMonth / getFullYear are local)
  const isToday =
    resetDate.getFullYear() === now.getFullYear() &&
    resetDate.getMonth() === now.getMonth() &&
    resetDate.getDate() === now.getDate();

  const timePart = formatResetTime(resetAtMs);

  if (isToday) {
    return `around ${timePart}`;
  }

  const isTomorrow = (() => {
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    return (
      resetDate.getFullYear() === tomorrow.getFullYear() &&
      resetDate.getMonth() === tomorrow.getMonth() &&
      resetDate.getDate() === tomorrow.getDate()
    );
  })();

  if (isTomorrow) {
    return `tomorrow around ${timePart}`;
  }

  // Further out (neither today nor tomorrow): provider reset estimates drift,
  // so a precise time-of-day would be falsely precise. Show the DAY ONLY
  // (e.g. "Jun 24"), dropping the "around {time}" suffix.
  return resetDate.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function buildDescription(untilMs: number | undefined): string {
  if (typeof untilMs !== 'number' || !Number.isFinite(untilMs)) {
    return 'A service asked us to wait.';
  }

  return `A service asked us to wait. Resuming around ${formatResetTime(untilMs)}.`;
}

function buildSafetyEvalDegradedToast(
  hasBackgroundFallbackConfigured: boolean,
  navigateToAgentsSettings: () => void,
  reasonKind?: CooldownStatusChangedPayload['reasonKind'],
  resetAtMs?: number,
): CooldownToast {
  // Billing / usage-cap case: the AI plan in use hit its usage limit. Copy is
  // provider-agnostic and ownership-neutral — true whether the user is on a
  // Rebel-managed pool, their own ChatGPT/Codex subscription, or BYOK. Show the
  // approximate reset day (if known); drop the unactionable "Add Fallback Model"
  // action — the user can't fix a usage cap from Settings.
  if (reasonKind === 'billing') {
    const resetSentence =
      typeof resetAtMs === 'number' && Number.isFinite(resetAtMs) && resetAtMs > Date.now()
        ? ` The limit is expected to reset ${formatResetTimeWithDay(resetAtMs)}.`
        : '';
    return {
      title: "Rebel's safety check is paused",
      description: `The AI plan Rebel is using has hit its usage limit, so the safety check can't run right now.${resetSentence} It should resume once the limit resets.`,
      variant: 'warning',
    };
  }

  if (hasBackgroundFallbackConfigured) {
    return {
      title: "Rebel's safety check is having trouble",
      description: 'This looks temporary. Rebel will keep trying.',
      variant: 'warning',
    };
  }

  return {
    title: "Rebel's safety check is having trouble",
    description: 'You can add a fallback model in Settings → Agents & Voice.',
    variant: 'warning',
    action: {
      label: 'Add Fallback Model',
      onClick: () => navigateToAgentsSettings(),
    },
  };
}

function logSuppressedCooldownToast(
  suppressedReasons: SuppressedReason[],
  payload: CooldownStatusChangedPayload,
  signals?: UserWorkSignals,
): void {
  try {
    window.api.logEvent({
      level: 'debug',
      message: 'API cooldown toast suppressed',
      timestamp: Date.now(),
      source: 'renderer',
      context: {
        suppressedReasons,
        suppressedReason: suppressedReasons[0],
        payload,
        ...(signals ? { signals } : {}),
      },
    });
  } catch {
    // Logging is best-effort; cooldown surfacing must not depend on it.
  }
}

function diffUserWorkSignals(signals: UserWorkSignals): SuppressedReason[] {
  const reasons: SuppressedReason[] = [];
  if (!signals.activeTurn) reasons.push('no_active_turn');
  if (!signals.recentSubmit) reasons.push('no_recent_submit');
  if (!signals.voiceActive) reasons.push('voice_inactive');
  if (!signals.composerHasText) reasons.push('composer_empty');
  return reasons;
}

export function useApiCooldownEvents({
  getUserWorkSignals,
  showToast,
  navigateToDiagnostics,
  navigateToAgentsSettings,
  hasBackgroundFallbackConfigured,
}: UseApiCooldownEventsOptions): void {
  const getUserWorkSignalsRef = useRef(getUserWorkSignals);
  const showToastRef = useRef(showToast);
  const navigateToDiagnosticsRef = useRef(navigateToDiagnostics);
  const navigateToAgentsSettingsRef = useRef(navigateToAgentsSettings);
  const hasBackgroundFallbackConfiguredRef = useRef(hasBackgroundFallbackConfigured);
  const lastEnteredToastAtRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    getUserWorkSignalsRef.current = getUserWorkSignals;
  }, [getUserWorkSignals]);

  useEffect(() => {
    showToastRef.current = showToast;
  }, [showToast]);

  useEffect(() => {
    navigateToDiagnosticsRef.current = navigateToDiagnostics;
  }, [navigateToDiagnostics]);

  useEffect(() => {
    navigateToAgentsSettingsRef.current = navigateToAgentsSettings;
  }, [navigateToAgentsSettings]);

  useEffect(() => {
    hasBackgroundFallbackConfiguredRef.current = hasBackgroundFallbackConfigured;
  }, [hasBackgroundFallbackConfigured]);

  useEffect(() => {
    const unsubscribe = window.api.onCooldownStatusChanged((payload) => {
      const isSupportedScope = payload.scope === 'api' || payload.scope === 'safety-eval-degraded';
      if (!isSupportedScope) {
        logSuppressedCooldownToast(['not_api_scope'], payload);
        return;
      }

      if (payload.state === 'exited') {
        // Clear the dedup window so a subsequent fresh enter can fire its toast.
        lastEnteredToastAtRef.current.delete(payload.scope);
        logSuppressedCooldownToast(['exited'], payload);
        return;
      }

      if (payload.state !== 'entered') {
        return;
      }

      const signals = getUserWorkSignalsRef.current();
      const blocks =
        signals.activeTurn || signals.recentSubmit || signals.voiceActive || signals.composerHasText;
      if (!blocks) {
        logSuppressedCooldownToast(diffUserWorkSignals(signals), payload, signals);
        return;
      }

      const now = Date.now();
      const lastToastAt = lastEnteredToastAtRef.current.get(payload.scope) ?? 0;
      if (now - lastToastAt < DEDUP_WINDOW_MS) {
        logSuppressedCooldownToast(['dedup_60s'], payload);
        return;
      }

      lastEnteredToastAtRef.current.set(payload.scope, now);
      if (payload.scope === 'api') {
        showToastRef.current({
          title: 'Rebel needs a short pause',
          description: buildDescription(payload.untilMs),
          variant: 'warning',
          action: {
            label: 'View Details',
            onClick: () => navigateToDiagnosticsRef.current(),
          },
        });
        return;
      }

      showToastRef.current(
        buildSafetyEvalDegradedToast(
          hasBackgroundFallbackConfiguredRef.current(),
          navigateToAgentsSettingsRef.current,
          payload.reasonKind,
          payload.resetAtMs,
        ),
      );
    });

    return () => unsubscribe();
  }, []);
}
