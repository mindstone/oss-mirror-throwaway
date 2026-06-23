// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@renderer/test-utils';
import type { AppSettings } from '@shared/types';
import {
  hasCoachCompletionSignal,
} from '@renderer/features/onboarding/utils/coachCompletionState';
import { usePermissionsOrchestrator } from '../usePermissionsOrchestrator';

type OrchestratorOptions = Parameters<typeof usePermissionsOrchestrator>[0];
type SaveSettingsWith = OrchestratorOptions['saveSettingsWith'];

const coreDirectory = '/Users/test/Library/Mindstone Rebel';

function makeCompletedSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    coreDirectory,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: 1_747_000_000_000,
    voice: {},
    models: {},
    diagnostics: {},
    ...overrides,
  } as AppSettings;
}

/**
 * Representative coach-completed states a relaunching user can be in
 * (PLAN.md Stage 2 red→green case): modern full handleCoachComplete output,
 * plus the two legacy single-signal variants.
 */
const completedVariants: Array<[name: string, settings: AppSettings]> = [
  [
    'modern: full handleCoachComplete output shape',
    makeCompletedSettings({
      onboardingDay: 1,
      onboardingCompletedAt: 1_747_000_123_456,
      onboardingSessionIds: { coach: 'coach-session-1', memory: null, useCases: null },
      onboardingChecklist: {
        step: 1,
        completedSteps: { 0: true, 2: true },
        sessionIds: { 0: 'coach-session-1', 2: 'tut-2' },
        isExpanded: false,
      },
    }),
  ],
  [
    'legacy: only completedSteps[0] (migrated-import shape)',
    makeCompletedSettings({
      onboardingChecklist: { step: 'complete', completedSteps: { 0: true } },
    }),
  ],
  [
    'legacy: only onboardingDay = 1',
    makeCompletedSettings({ onboardingDay: 1 }),
  ],
];

describe('usePermissionsOrchestrator relaunch reset contract', () => {
  let saveSettingsWith: ReturnType<typeof vi.fn<SaveSettingsWith>>;
  let showToast: ReturnType<typeof vi.fn<OrchestratorOptions['showToast']>>;
  let emitLog: ReturnType<typeof vi.fn<OrchestratorOptions['emitLog']>>;
  let currentSettings: AppSettings;
  let savedSettings: AppSettings[];

  beforeEach(() => {
    localStorage.clear();
    savedSettings = [];
    saveSettingsWith = vi.fn<SaveSettingsWith>(async (override) => {
      if (override) {
        // Round-trip through the same updater seam App.tsx persistence uses
        // (DA-F7): the orchestrator hands us a pure updater over the draft.
        currentSettings = override(currentSettings);
        savedSettings.push(currentSettings);
      }
    });
    showToast = vi.fn<OrchestratorOptions['showToast']>();
    emitLog = vi.fn<OrchestratorOptions['emitLog']>();

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        resetOnboardingJourney: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  async function relaunchFrom(settings: AppSettings): Promise<AppSettings> {
    currentSettings = settings;
    const rendered = renderHook(() =>
      usePermissionsOrchestrator({
        settings,
        saveSettingsWith,
        emitLog,
        showToast,
      }),
    );
    await act(async () => {
      await rendered.result.current.handleRelaunchOnboarding();
    });
    rendered.unmount();
    expect(savedSettings.length).toBeGreaterThanOrEqual(1);
    return savedSettings[savedSettings.length - 1];
  }

  // NOTE: must run FIRST in this file. The hook's wizard override is backed by
  // a module-level snapshot (`onboardingWizardOverrideSnapshot` in
  // usePermissionsOrchestrator.ts) that survives across tests in the same
  // module instance — any earlier relaunch in this file leaves it `true`,
  // which would break the "wizard hidden before relaunch" sanity assertion.
  it('reopens the wizard and fires the non-settings relaunch side effects (review F1)', async () => {
    const [, modern] = completedVariants[0];
    currentSettings = modern;
    localStorage.setItem('permission-onboarding-shown', 'true');

    const rendered = renderHook(() =>
      usePermissionsOrchestrator({
        settings: modern,
        saveSettingsWith,
        emitLog,
        showToast,
      }),
    );
    // Sanity: completed settings, no override → wizard hidden before relaunch.
    expect(rendered.result.current.showOnboardingWizard).toBe(false);

    await act(async () => {
      await rendered.result.current.handleRelaunchOnboarding();
    });

    // Wizard reopens via the override (the settings prop still says completed).
    expect(rendered.result.current.showOnboardingWizard).toBe(true);
    // 14-day journey state reset requested in the achievements store.
    expect(window.api.resetOnboardingJourney).toHaveBeenCalledTimes(1);
    // Permission-onboarding gate cleared so the dialog can re-run post-wizard.
    expect(localStorage.getItem('permission-onboarding-shown')).toBeNull();
    // User-visible confirmation fired.
    expect(showToast).toHaveBeenCalledWith({ title: 'Onboarding relaunched' });

    rendered.unmount();
  });

  it.each(completedVariants)(
    'leaves no coach completion signal after relaunch: %s',
    async (_name, settings) => {
      const after = await relaunchFrom(settings);

      // The relaunch-specific flip…
      expect(after.onboardingCompleted).toBe(false);
      // …and the class-kill contract: NO surviving completion signal, so the
      // Home activation card shows after the wizard is re-completed. This is
      // the bug: stale onboardingChecklist.completedSteps[0] / onboardingDay
      // suppressed the card, leaving no path to the coach at all.
      expect(hasCoachCompletionSignal(after)).toBe(false);
      // No stale resume pointer either — otherwise the card reads "Continue
      // your intro" and reopens the finished coach session.
      expect(after.onboardingSessionIds?.coach ?? after.onboardingChecklist?.sessionIds?.[0]).toBeUndefined();
      // Persistence round-trip: signals stay cleared once undefined keys drop.
      expect(hasCoachCompletionSignal(JSON.parse(JSON.stringify(after)))).toBe(false);
    },
  );

  it('preserves non-coach checklist state and first-completion timestamp', async () => {
    const [, modern] = completedVariants[0];
    const after = await relaunchFrom(modern);

    expect(after.onboardingChecklist?.step).toBe(1);
    expect(after.onboardingChecklist?.completedSteps?.[2]).toBe(true);
    expect(after.onboardingChecklist?.sessionIds?.[2]).toBe('tut-2');
    expect(after.onboardingChecklist?.isExpanded).toBe(false);
    expect(after.onboardingFirstCompletedAt).toBe(modern.onboardingFirstCompletedAt);
  });

});
