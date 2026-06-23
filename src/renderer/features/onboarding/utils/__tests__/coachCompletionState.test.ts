import { describe, expect, it } from 'vitest';
import type { AppSettings } from '@shared/types';
import { clearCoachCompletionState, hasCoachCompletionSignal } from '../coachCompletionState';

function makeBaseSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    coreDirectory: '/Users/test/Library/Mindstone Rebel',
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
 * Representative fully-completed states, per the drift-killer contract
 * (PLAN.md Stage 2a). Legacy variants are real producers: machine-migration
 * imports transfer only `onboardingChecklist`, and pre-onboardingCompletedAt
 * profiles carry only `onboardingDay`.
 *
 * HONEST-CLAIM NOTE: these fixtures pin today's known signal set; the
 * composition tests below do NOT auto-discover future predicate signals.
 * Adding a new signal to `hasCoachCompletionSignal` requires adding a
 * completed fixture here that carries it — otherwise the drift test passes
 * vacuously against the new field.
 */
const completedFixtures: Array<[name: string, settings: AppSettings]> = [
  [
    'legacy: only completedSteps[0] (migrated-import shape)',
    makeBaseSettings({
      onboardingChecklist: { step: 'complete', completedSteps: { 0: true } },
    }),
  ],
  [
    'legacy: only onboardingDay = 1',
    makeBaseSettings({ onboardingDay: 1 }),
  ],
  [
    'modern: full handleCoachComplete output shape',
    makeBaseSettings({
      onboardingDay: 1,
      onboardingCompletedAt: 1_747_000_123_456,
      onboardingSessionIds: { coach: 'coach-session-1', memory: null, useCases: null },
      onboardingChecklist: {
        step: 1,
        completedSteps: { 0: true },
        sessionIds: { 0: 'coach-session-1' },
      },
    }),
  ],
  [
    'kitchen sink: all signals + tutorial progress + collapsed widget',
    makeBaseSettings({
      onboardingDay: 3,
      onboardingCompletedAt: 1_747_000_123_456,
      onboardingSessionIds: { coach: 'coach-session-1', memory: 'mem-1', useCases: 'uc-1' },
      onboardingChecklist: {
        step: 'complete',
        completedSteps: { 0: true, 1: true, 2: true, 3: true, 4: true },
        sessionIds: { 0: 'coach-session-1', 1: 'tut-1', 2: 'tut-2' },
        isExpanded: false,
      },
    }),
  ],
];

describe('hasCoachCompletionSignal', () => {
  it('is false for a fresh profile (wizard done, coach not started)', () => {
    expect(hasCoachCompletionSignal(makeBaseSettings())).toBe(false);
    expect(
      hasCoachCompletionSignal(makeBaseSettings({ onboardingChecklist: { step: 1 } })),
    ).toBe(false);
  });

  it('is false for null/undefined settings', () => {
    expect(hasCoachCompletionSignal(null)).toBe(false);
    expect(hasCoachCompletionSignal(undefined)).toBe(false);
  });

  it.each(completedFixtures)('is true for %s', (_name, settings) => {
    expect(hasCoachCompletionSignal(settings)).toBe(true);
  });

  it('ignores non-coach completion state', () => {
    expect(
      hasCoachCompletionSignal(
        makeBaseSettings({
          onboardingChecklist: {
            step: 2,
            completedSteps: { 1: true, 2: true },
            sessionIds: { 1: 'tut-1' },
            isExpanded: true,
          },
        }),
      ),
    ).toBe(false);
  });

  it('treats onboardingDay below 1 as no signal (matches App.tsx memo semantics)', () => {
    expect(hasCoachCompletionSignal(makeBaseSettings({ onboardingDay: 0 }))).toBe(false);
  });
});

describe('clearCoachCompletionState ∘ hasCoachCompletionSignal (drift-killer contract)', () => {
  it.each(completedFixtures)('leaves no completion signal after reset: %s', (_name, settings) => {
    const after = clearCoachCompletionState(settings);
    expect(hasCoachCompletionSignal(after)).toBe(false);
  });

  it.each(completedFixtures)(
    'survives a persistence round-trip with no signal: %s',
    (_name, settings) => {
      // JSON.stringify drops `undefined`-valued keys — assert the cleared
      // state still carries no signal once those keys are genuinely absent
      // (guards the silent-failure mode where a clear relies on `undefined`
      // values surviving serialization). DA-F7-adjacent; the orchestrator
      // test additionally round-trips through the saveSettingsWith seam.
      const roundTripped = JSON.parse(JSON.stringify(clearCoachCompletionState(settings)));
      expect(hasCoachCompletionSignal(roundTripped)).toBe(false);
    },
  );

  it('clears the stale coach resume pointers (top-level and checklist fallback)', () => {
    const [, modern] = completedFixtures[2];
    const after = clearCoachCompletionState(modern);
    expect(after.onboardingSessionIds).toBeUndefined();
    expect(after.onboardingChecklist?.sessionIds?.[0]).toBeUndefined();
  });

  it('preserves non-coach checklist state and first-completion timestamp', () => {
    const [, kitchenSink] = completedFixtures[3];
    const after = clearCoachCompletionState(kitchenSink);
    expect(after.onboardingChecklist?.step).toBe('complete');
    expect(after.onboardingChecklist?.completedSteps).toEqual({ 1: true, 2: true, 3: true, 4: true });
    expect(after.onboardingChecklist?.sessionIds).toEqual({ 1: 'tut-1', 2: 'tut-2' });
    expect(after.onboardingChecklist?.isExpanded).toBe(false);
    expect(after.onboardingFirstCompletedAt).toBe(kitchenSink.onboardingFirstCompletedAt);
    expect(after.onboardingCompleted).toBe(true); // relaunch-specific flip is the caller's job
  });

  it('is pure (does not mutate the input) and tolerates an absent checklist', () => {
    const [, kitchenSink] = completedFixtures[3];
    const snapshot = JSON.parse(JSON.stringify(kitchenSink));
    clearCoachCompletionState(kitchenSink);
    expect(kitchenSink).toEqual(snapshot);

    const noChecklist = makeBaseSettings({ onboardingDay: 1 });
    const after = clearCoachCompletionState(noChecklist);
    expect(after.onboardingChecklist).toBeUndefined();
    expect(hasCoachCompletionSignal(after)).toBe(false);
  });
});
