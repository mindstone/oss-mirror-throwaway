import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../../types/settings';
import { applyEfficiencyMode, isEfficiencyModeOn } from '../efficiencyMode';

const baseSettings: AppSettings = {} as AppSettings;

function settingsWith(overrides: Partial<AppSettings>): AppSettings {
  return { ...baseSettings, ...overrides } as AppSettings;
}

describe('isEfficiencyModeOn', () => {
  it('returns false for null / undefined / off', () => {
    expect(isEfficiencyModeOn(null)).toBe(false);
    expect(isEfficiencyModeOn(undefined)).toBe(false);
    expect(isEfficiencyModeOn(settingsWith({ efficiencyMode: 'off' }))).toBe(false);
  });

  it('returns true only when explicitly on', () => {
    expect(isEfficiencyModeOn(settingsWith({ efficiencyMode: 'on' }))).toBe(true);
  });
});

describe('applyEfficiencyMode — enable', () => {
  it('snapshots all five sub-settings into baseline', () => {
    const current = settingsWith({
      dailySparkMode: 'on',
      heroChoiceRunMode: 'ask',
      timeSavedEstimation: { enabled: true },
      personaQuipsEnabled: true,
      cpuEmbeddingIdleDisposalEnabled: false,
    });
    const result = applyEfficiencyMode(current, true);
    expect(result.efficiencyMode).toBe('on');
    expect(result.efficiencyModeBaseline).toEqual({
      dailySparkMode: 'on',
      heroChoiceRunMode: 'ask',
      timeSavedEstimationEnabled: true,
      personaQuipsEnabled: true,
      cpuEmbeddingIdleDisposalEnabled: false,
    });
  });

  it('applies the Efficiency preset to all five sub-settings', () => {
    const result = applyEfficiencyMode(
      settingsWith({ dailySparkMode: 'on', heroChoiceRunMode: 'ask' }),
      true,
    );
    expect(result.dailySparkMode).toBe('off');
    expect(result.heroChoiceRunMode).toBe('off');
    expect(result.timeSavedEstimation?.enabled).toBe(false);
    expect(result.personaQuipsEnabled).toBe(false);
    expect(result.cpuEmbeddingIdleDisposalEnabled).toBe(true);
  });

  it('preserves undefined originals in baseline (round-trip safety)', () => {
    const result = applyEfficiencyMode(settingsWith({}), true);
    expect(result.efficiencyModeBaseline).toEqual({
      dailySparkMode: undefined,
      heroChoiceRunMode: undefined,
      timeSavedEstimationEnabled: undefined,
      personaQuipsEnabled: undefined,
      cpuEmbeddingIdleDisposalEnabled: undefined,
    });
  });

  it('preserves other timeSavedEstimation keys when enabling', () => {
    const current = settingsWith({
      timeSavedEstimation: { enabled: true, sampleRate: 0.5 } as AppSettings['timeSavedEstimation'],
    });
    const result = applyEfficiencyMode(current, true);
    expect(result.timeSavedEstimation).toEqual({ enabled: false, sampleRate: 0.5 });
  });

  it('is idempotent: enabling when already on preserves the original baseline', () => {
    const originalBaseline = {
      dailySparkMode: 'on' as const,
      heroChoiceRunMode: 'ask' as const,
      timeSavedEstimationEnabled: true,
      personaQuipsEnabled: true,
      cpuEmbeddingIdleDisposalEnabled: false,
    };
    const current = settingsWith({
      efficiencyMode: 'on',
      efficiencyModeBaseline: originalBaseline,
      dailySparkMode: 'off',
      heroChoiceRunMode: 'off',
      timeSavedEstimation: { enabled: false },
      personaQuipsEnabled: false,
      cpuEmbeddingIdleDisposalEnabled: true,
    });
    const result = applyEfficiencyMode(current, true);
    expect(result.efficiencyModeBaseline).toEqual(originalBaseline);
  });

  it('is pure (does not mutate the input)', () => {
    const current = settingsWith({
      dailySparkMode: 'on',
      heroChoiceRunMode: 'ask',
      timeSavedEstimation: { enabled: true },
    });
    const snapshot = JSON.parse(JSON.stringify(current));
    applyEfficiencyMode(current, true);
    expect(current).toEqual(snapshot);
  });
});

describe('applyEfficiencyMode — disable', () => {
  it('restores sub-settings from baseline and clears the baseline', () => {
    const current = settingsWith({
      efficiencyMode: 'on',
      efficiencyModeBaseline: {
        dailySparkMode: 'on',
        heroChoiceRunMode: 'ask',
        timeSavedEstimationEnabled: true,
        personaQuipsEnabled: true,
        cpuEmbeddingIdleDisposalEnabled: false,
      },
      dailySparkMode: 'off',
      heroChoiceRunMode: 'off',
      timeSavedEstimation: { enabled: false },
      personaQuipsEnabled: false,
      cpuEmbeddingIdleDisposalEnabled: true,
    });
    const result = applyEfficiencyMode(current, false);
    expect(result.efficiencyMode).toBe('off');
    expect(result.efficiencyModeBaseline).toBeUndefined();
    expect(result.dailySparkMode).toBe('on');
    expect(result.heroChoiceRunMode).toBe('ask');
    expect(result.timeSavedEstimation?.enabled).toBe(true);
    expect(result.personaQuipsEnabled).toBe(true);
    expect(result.cpuEmbeddingIdleDisposalEnabled).toBe(false);
  });

  it('restores undefined originals to undefined (round-trip)', () => {
    const current = settingsWith({
      efficiencyMode: 'on',
      efficiencyModeBaseline: {},
      dailySparkMode: 'off',
      heroChoiceRunMode: 'off',
      timeSavedEstimation: { enabled: false },
      personaQuipsEnabled: false,
      cpuEmbeddingIdleDisposalEnabled: true,
    });
    const result = applyEfficiencyMode(current, false);
    expect(result.dailySparkMode).toBeUndefined();
    expect(result.heroChoiceRunMode).toBeUndefined();
    expect(result.personaQuipsEnabled).toBeUndefined();
    expect(result.cpuEmbeddingIdleDisposalEnabled).toBeUndefined();
  });

  it('orphaned baseline (mode was on, baseline lost): clears sub-settings to defaults to escape the stuck-off state', () => {
    const current = settingsWith({
      efficiencyMode: 'on',
      // Sub-settings still pinned to the Efficiency preset (off). Without baseline-aware
      // recovery the user would be permanently stuck with these forced off after disabling.
      dailySparkMode: 'off',
      heroChoiceRunMode: 'off',
      timeSavedEstimation: { enabled: false },
      personaQuipsEnabled: false,
      cpuEmbeddingIdleDisposalEnabled: true,
    });
    const result = applyEfficiencyMode(current, false);
    expect(result.efficiencyMode).toBe('off');
    expect(result.efficiencyModeBaseline).toBeUndefined();
    expect(result.dailySparkMode).toBeUndefined();
    expect(result.heroChoiceRunMode).toBeUndefined();
    expect(result.timeSavedEstimation?.enabled).toBeUndefined();
    expect(result.personaQuipsEnabled).toBeUndefined();
    expect(result.cpuEmbeddingIdleDisposalEnabled).toBeUndefined();
  });

  it('is idempotent when already off (no baseline, no changes)', () => {
    const current = settingsWith({
      efficiencyMode: 'off',
      dailySparkMode: 'on',
    });
    const result = applyEfficiencyMode(current, false);
    expect(result.efficiencyMode).toBe('off');
    expect(result.efficiencyModeBaseline).toBeUndefined();
    expect(result.dailySparkMode).toBe('on');
  });

  it('round-trip: enable → disable returns the original values', () => {
    const original = settingsWith({
      dailySparkMode: 'on',
      heroChoiceRunMode: 'ask',
      timeSavedEstimation: { enabled: true },
      personaQuipsEnabled: undefined,
      cpuEmbeddingIdleDisposalEnabled: false,
    });
    const enabled = applyEfficiencyMode(original, true);
    const merged: AppSettings = {
      ...original,
      ...enabled,
    } as AppSettings;
    const disabled = applyEfficiencyMode(merged, false);
    expect(disabled.dailySparkMode).toBe('on');
    expect(disabled.heroChoiceRunMode).toBe('ask');
    expect(disabled.timeSavedEstimation?.enabled).toBe(true);
    expect(disabled.personaQuipsEnabled).toBeUndefined();
    expect(disabled.cpuEmbeddingIdleDisposalEnabled).toBe(false);
  });
});
