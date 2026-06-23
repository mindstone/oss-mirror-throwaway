// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '../../test-utils/hookTestHarness';
import { useApiCooldownEvents, type UserWorkSignals } from '../useApiCooldownEvents';

const NO_SIGNALS: UserWorkSignals = {
  activeTurn: false,
  recentSubmit: false,
  voiceActive: false,
  composerHasText: false,
};

const ACTIVE_TURN_SIGNALS: UserWorkSignals = {
  activeTurn: true,
  recentSubmit: false,
  voiceActive: false,
  composerHasText: false,
};

type CooldownStatusChangedPayload = {
  scope: 'api' | 'safety-eval' | 'safety-eval-degraded';
  state: 'entered' | 'exited';
  untilMs?: number;
  durationMs?: number;
  reasonKind?: 'billing' | 'rate_limit' | 'auth' | 'model_unavailable' | 'other';
  resetAtMs?: number;
};

type CooldownListener = (payload: CooldownStatusChangedPayload) => void;

function installApiMock() {
  const listeners = new Set<CooldownListener>();
  const apiMock = {
    onCooldownStatusChanged: vi.fn((callback: CooldownListener) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    }),
    logEvent: vi.fn(),
  };
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: apiMock,
  });

  return {
    apiMock,
    emit: (payload: CooldownStatusChangedPayload) => {
      for (const listener of listeners) {
        listener(payload);
      }
    },
  };
}

function renderCooldownHook(options?: {
  getUserWorkSignals?: () => UserWorkSignals;
  showToast?: ReturnType<typeof vi.fn>;
  navigateToDiagnostics?: ReturnType<typeof vi.fn>;
  navigateToAgentsSettings?: ReturnType<typeof vi.fn>;
  hasBackgroundFallbackConfigured?: () => boolean;
}) {
  const getUserWorkSignals = options?.getUserWorkSignals ?? (() => ACTIVE_TURN_SIGNALS);
  const showToast = options?.showToast ?? vi.fn();
  const navigateToDiagnostics = options?.navigateToDiagnostics ?? vi.fn();
  const navigateToAgentsSettings = options?.navigateToAgentsSettings ?? vi.fn();
  const hasBackgroundFallbackConfigured = options?.hasBackgroundFallbackConfigured ?? (() => false);

  // The mocks are untyped vi.fn() (so callers retain `.mock` access); cast to the
  // hook's own param types at this single boundary rather than typing every caller.
  type CooldownEventsOptions = Parameters<typeof useApiCooldownEvents>[0];
  const hook = renderHook(() => useApiCooldownEvents({
    getUserWorkSignals,
    showToast: showToast as unknown as CooldownEventsOptions['showToast'],
    navigateToDiagnostics: navigateToDiagnostics as unknown as CooldownEventsOptions['navigateToDiagnostics'],
    navigateToAgentsSettings: navigateToAgentsSettings as unknown as CooldownEventsOptions['navigateToAgentsSettings'],
    hasBackgroundFallbackConfigured,
  }));

  return {
    ...hook,
    showToast,
    navigateToDiagnostics,
    navigateToAgentsSettings,
    getUserWorkSignals,
  };
}

describe('useApiCooldownEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { api?: unknown }).api;
  });

  it('toasts for API entered events when cooldown blocks user work', () => {
    const { emit } = installApiMock();
    const { showToast, navigateToDiagnostics } = renderCooldownHook();

    act(() => {
      emit({
        scope: 'api',
        state: 'entered',
        untilMs: Date.now() + 60_000,
        durationMs: 60_000,
      });
    });

    expect(showToast).toHaveBeenCalledOnce();
    const toast = showToast.mock.calls[0][0];
    expect(toast.title).toBe('Rebel needs a short pause');
    expect(toast.description).toContain('A service asked us to wait. Resuming around');
    expect(toast.variant).toBe('warning');
    expect(toast.action?.label).toBe('View Details');

    toast.action?.onClick();
    expect(navigateToDiagnostics).toHaveBeenCalledOnce();
  });

  it('does not toast API entered events when cooldown does not block user work', () => {
    const { emit } = installApiMock();
    const showToast = vi.fn();

    renderCooldownHook({
      getUserWorkSignals: () => NO_SIGNALS,
      showToast,
    });

    act(() => {
      emit({ scope: 'api', state: 'entered', untilMs: Date.now() + 60_000 });
    });

    expect(showToast).not.toHaveBeenCalled();
  });

  it('emits per-source suppression reasons when no user-work signal is active', () => {
    const { emit, apiMock } = installApiMock();
    const showToast = vi.fn();

    renderCooldownHook({
      getUserWorkSignals: () => NO_SIGNALS,
      showToast,
    });

    act(() => {
      emit({ scope: 'api', state: 'entered', untilMs: Date.now() + 60_000 });
    });

    expect(showToast).not.toHaveBeenCalled();
    expect(apiMock.logEvent).toHaveBeenCalled();
    const lastCall = apiMock.logEvent.mock.calls.at(-1)?.[0];
    expect(lastCall?.context?.suppressedReasons).toEqual([
      'no_active_turn',
      'no_recent_submit',
      'voice_inactive',
      'composer_empty',
    ]);
    expect(lastCall?.context?.signals).toEqual(NO_SIGNALS);
  });

  it('ignores safety-eval scope events regardless of user-work state', () => {
    const { emit } = installApiMock();
    const showToast = vi.fn();

    renderCooldownHook({ showToast });

    act(() => {
      emit({ scope: 'safety-eval', state: 'entered', untilMs: Date.now() + 60_000 });
    });

    expect(showToast).not.toHaveBeenCalled();
  });

  it('ignores API exited events', () => {
    const { emit } = installApiMock();
    const showToast = vi.fn();

    renderCooldownHook({ showToast });

    act(() => {
      emit({ scope: 'api', state: 'exited' });
    });

    expect(showToast).not.toHaveBeenCalled();
  });

  it('deduplicates entered toasts for the same scope within 60 seconds', () => {
    const { emit } = installApiMock();
    const showToast = vi.fn();

    renderCooldownHook({ showToast });

    act(() => {
      emit({ scope: 'api', state: 'entered', untilMs: Date.now() + 60_000 });
      vi.setSystemTime(new Date(Date.now() + 59_000));
      emit({ scope: 'api', state: 'entered', untilMs: Date.now() + 60_000 });
    });

    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('allows another entered toast for the same scope after 60 seconds', () => {
    const { emit } = installApiMock();
    const showToast = vi.fn();

    renderCooldownHook({ showToast });

    act(() => {
      emit({ scope: 'api', state: 'entered', untilMs: Date.now() + 60_000 });
      vi.setSystemTime(new Date(Date.now() + 60_001));
      emit({ scope: 'api', state: 'entered', untilMs: Date.now() + 60_000 });
    });

    expect(showToast).toHaveBeenCalledTimes(2);
  });

  it('uses fallback description when untilMs is missing', () => {
    const { emit } = installApiMock();
    const showToast = vi.fn();

    renderCooldownHook({ showToast });

    act(() => {
      emit({ scope: 'api', state: 'entered' });
    });

    expect(showToast).toHaveBeenCalledOnce();
    expect(showToast.mock.calls[0][0].description).toBe('A service asked us to wait.');
  });

  it('cleans up the subscription on unmount', () => {
    const { emit } = installApiMock();
    const showToast = vi.fn();

    const { unmount } = renderCooldownHook({ showToast });
    unmount();

    act(() => {
      emit({ scope: 'api', state: 'entered', untilMs: Date.now() + 60_000 });
    });

    expect(showToast).not.toHaveBeenCalled();
  });

  it('clears the 60 second entered dedup window when API cooldown exits', () => {
    const { emit } = installApiMock();
    const showToast = vi.fn();

    renderCooldownHook({ showToast });

    act(() => {
      emit({ scope: 'api', state: 'entered', untilMs: Date.now() + 60_000 });
      emit({ scope: 'api', state: 'exited' });
      vi.setSystemTime(new Date(Date.now() + 30_000));
      emit({ scope: 'api', state: 'entered', untilMs: Date.now() + 60_000 });
    });

    expect(showToast).toHaveBeenCalledTimes(2);
  });

  it('calls getUserWorkSignals at event time instead of reading a stale value', () => {
    const { emit } = installApiMock();
    const showToast = vi.fn();
    let signals: UserWorkSignals = NO_SIGNALS;
    const getUserWorkSignals = vi.fn(() => signals);

    renderCooldownHook({
      getUserWorkSignals,
      showToast,
    });

    signals = ACTIVE_TURN_SIGNALS;

    act(() => {
      emit({ scope: 'api', state: 'entered', untilMs: Date.now() + 60_000 });
    });

    expect(getUserWorkSignals).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledOnce();
  });

  it('shows fallback-model action for safety-eval-degraded when background fallback is unset', () => {
    const { emit } = installApiMock();
    const showToast = vi.fn();
    const navigateToAgentsSettings = vi.fn();

    renderCooldownHook({
      showToast,
      navigateToAgentsSettings,
      hasBackgroundFallbackConfigured: () => false,
    });

    act(() => {
      emit({ scope: 'safety-eval-degraded', state: 'entered' });
    });

    expect(showToast).toHaveBeenCalledOnce();
    const toast = showToast.mock.calls[0][0];
    expect(toast.title).toBe("Rebel's safety check is having trouble");
    expect(toast.description).toContain('add a fallback model');
    expect(toast.action?.label).toBe('Add Fallback Model');

    toast.action?.onClick();
    expect(navigateToAgentsSettings).toHaveBeenCalledOnce();
  });

  it('suppresses fallback-model action for safety-eval-degraded when background fallback is configured', () => {
    const { emit } = installApiMock();
    const showToast = vi.fn();

    renderCooldownHook({
      showToast,
      hasBackgroundFallbackConfigured: () => true,
    });

    act(() => {
      emit({ scope: 'safety-eval-degraded', state: 'entered' });
    });

    expect(showToast).toHaveBeenCalledOnce();
    const toast = showToast.mock.calls[0][0];
    expect(toast.title).toBe("Rebel's safety check is having trouble");
    expect(toast.action).toBeUndefined();
  });

  // ─── Stage 1 / A2: cause-aware toast tests ───────────────────────────────

  describe('buildSafetyEvalDegradedToast — billing branch', () => {
    it('shows honest billing copy and NO Add Fallback Model action when reasonKind=billing', () => {
      const { emit } = installApiMock();
      const showToast = vi.fn();
      const navigateToAgentsSettings = vi.fn();

      renderCooldownHook({
        showToast,
        navigateToAgentsSettings,
        hasBackgroundFallbackConfigured: () => false,
      });

      act(() => {
        emit({ scope: 'safety-eval-degraded', state: 'entered', reasonKind: 'billing' });
      });

      expect(showToast).toHaveBeenCalledOnce();
      const toast = showToast.mock.calls[0][0];
      expect(toast.title).toBe("Rebel's safety check is paused");
      // Must explain the real cause in plain language — provider-agnostic and
      // ownership-neutral (true for managed-pool / BYO-subscription / BYOK)
      expect(toast.description).toBe(
        "The AI plan Rebel is using has hit its usage limit, so the safety check can't run right now. It should resume once the limit resets.",
      );
      // Must NOT contain "Add Fallback Model" — unactionable for billing
      expect(toast.action).toBeUndefined();
      // Must NOT contain raw jargon, nor misattribute ownership of the plan
      expect(toast.description).not.toContain('429');
      expect(toast.description).not.toContain('billing');
      expect(toast.description).not.toContain('Codex');
      expect(toast.description).not.toContain('provider');
      expect(toast.description).not.toContain('subscription');
    });

    it('includes an approximate same-day reset time when resetAtMs is today', () => {
      const { emit } = installApiMock();
      const showToast = vi.fn();

      // Set time to noon; reset is 2 hours from now (still today)
      vi.setSystemTime(new Date('2026-05-11T12:00:00.000Z'));
      const resetAtMs = new Date('2026-05-11T14:00:00.000Z').getTime();

      renderCooldownHook({ showToast });

      act(() => {
        emit({ scope: 'safety-eval-degraded', state: 'entered', reasonKind: 'billing', resetAtMs });
      });

      const toast = showToast.mock.calls[0][0];
      // Must contain "around" (from the same-day branch of formatResetTimeWithDay)
      expect(toast.description).toContain('around');
      // Must NOT say "tomorrow" (it is today)
      expect(toast.description).not.toContain('tomorrow');
    });

    it('includes "tomorrow" in reset phrasing when resetAtMs is the next calendar day', () => {
      const { emit } = installApiMock();
      const showToast = vi.fn();

      // Use midday UTC for both — guarantees "today" and "tomorrow" regardless of
      // the test runner's timezone offset (UTC±14 means at most 14h of skew from UTC noon)
      vi.setSystemTime(new Date('2026-05-11T12:00:00.000Z'));
      const resetAtMs = new Date('2026-05-12T12:00:00.000Z').getTime(); // exactly 24h later

      renderCooldownHook({ showToast });

      act(() => {
        emit({ scope: 'safety-eval-degraded', state: 'entered', reasonKind: 'billing', resetAtMs });
      });

      const toast = showToast.mock.calls[0][0];
      expect(toast.description).toContain('tomorrow');
    });

    it('shows the DAY ONLY (no time) when resetAtMs is several days out', () => {
      const { emit } = installApiMock();
      const showToast = vi.fn();

      // Reset ~59h out (neither today nor tomorrow). Provider reset estimates
      // drift, so a precise time-of-day would be falsely precise.
      vi.setSystemTime(new Date('2026-05-11T12:00:00.000Z'));
      const resetAtMs = new Date('2026-05-13T23:00:00.000Z').getTime();

      renderCooldownHook({ showToast });

      act(() => {
        emit({ scope: 'safety-eval-degraded', state: 'entered', reasonKind: 'billing', resetAtMs });
      });

      const toast = showToast.mock.calls[0][0];
      // Far-future branch: a month/day reference, but NO "around {time}" suffix.
      expect(toast.description).toContain('The limit is expected to reset');
      expect(toast.description).not.toContain('around');
      expect(toast.description).not.toContain('tomorrow');
      // No clock time leaked into the far-future phrasing
      expect(toast.description).not.toMatch(/\b\d{1,2}:\d{2}\b/);
      expect(toast.description).not.toMatch(/\b(AM|PM)\b/);
    });

    it('omits the reset phrase when resetAtMs is absent', () => {
      const { emit } = installApiMock();
      const showToast = vi.fn();

      renderCooldownHook({ showToast });

      act(() => {
        emit({ scope: 'safety-eval-degraded', state: 'entered', reasonKind: 'billing' });
      });

      const toast = showToast.mock.calls[0][0];
      expect(toast.title).toBe("Rebel's safety check is paused");
      expect(toast.description).not.toContain('around');
      expect(toast.description).not.toContain('tomorrow');
      // Without a known reset, the copy drops the reset sentence cleanly
      expect(toast.description).toBe(
        "The AI plan Rebel is using has hit its usage limit, so the safety check can't run right now. It should resume once the limit resets.",
      );
    });

    it('omits the reset phrase when resetAtMs is in the past', () => {
      const { emit } = installApiMock();
      const showToast = vi.fn();

      vi.setSystemTime(new Date('2026-05-11T12:00:00.000Z'));
      const resetAtMs = new Date('2026-05-11T11:00:00.000Z').getTime(); // 1 hour ago

      renderCooldownHook({ showToast });

      act(() => {
        emit({ scope: 'safety-eval-degraded', state: 'entered', reasonKind: 'billing', resetAtMs });
      });

      const toast = showToast.mock.calls[0][0];
      expect(toast.description).not.toContain('around');
    });
  });

  describe('buildSafetyEvalDegradedToast — non-billing branch unchanged', () => {
    it('shows the existing fallback-model copy when reasonKind is absent', () => {
      const { emit } = installApiMock();
      const showToast = vi.fn();
      const navigateToAgentsSettings = vi.fn();

      renderCooldownHook({
        showToast,
        navigateToAgentsSettings,
        hasBackgroundFallbackConfigured: () => false,
      });

      act(() => {
        emit({ scope: 'safety-eval-degraded', state: 'entered' });
      });

      const toast = showToast.mock.calls[0][0];
      expect(toast.title).toBe("Rebel's safety check is having trouble");
      expect(toast.description).toContain('add a fallback model');
      expect(toast.action?.label).toBe('Add Fallback Model');
    });

    it('shows the existing fallback-model copy when reasonKind is other', () => {
      const { emit } = installApiMock();
      const showToast = vi.fn();

      renderCooldownHook({
        showToast,
        hasBackgroundFallbackConfigured: () => false,
      });

      act(() => {
        emit({ scope: 'safety-eval-degraded', state: 'entered', reasonKind: 'other' });
      });

      const toast = showToast.mock.calls[0][0];
      expect(toast.title).toBe("Rebel's safety check is having trouble");
      expect(toast.action?.label).toBe('Add Fallback Model');
    });

    it('shows the "keep trying" copy when fallback IS configured, regardless of reasonKind', () => {
      const { emit } = installApiMock();
      const showToast = vi.fn();

      renderCooldownHook({
        showToast,
        hasBackgroundFallbackConfigured: () => true,
      });

      act(() => {
        emit({ scope: 'safety-eval-degraded', state: 'entered', reasonKind: 'rate_limit' });
      });

      const toast = showToast.mock.calls[0][0];
      expect(toast.title).toBe("Rebel's safety check is having trouble");
      expect(toast.description).toContain('keep trying');
      expect(toast.action).toBeUndefined();
    });
  });

  describe('api-scope toast — byte-for-byte unchanged by Stage 1 changes', () => {
    it('api-scope toast is unaffected by reasonKind/resetAtMs fields', () => {
      const { emit } = installApiMock();
      const showToast = vi.fn();
      const navigateToDiagnostics = vi.fn();

      renderCooldownHook({ showToast, navigateToDiagnostics });

      act(() => {
        // These fields should be ignored by the api-scope handler
        emit({
          scope: 'api',
          state: 'entered',
          untilMs: Date.now() + 60_000,
          reasonKind: 'billing',
          resetAtMs: Date.now() + 60_000,
        });
      });

      expect(showToast).toHaveBeenCalledOnce();
      const toast = showToast.mock.calls[0][0];
      // api-scope toast title/description must be unchanged
      expect(toast.title).toBe('Rebel needs a short pause');
      expect(toast.description).toContain('A service asked us to wait. Resuming around');
      expect(toast.action?.label).toBe('View Details');
    });
  });
});
