/**
 * Efficiency Mode — pure write-through with baseline backup.
 *
 * `applyEfficiencyMode(current, enabled)` returns a new settings object with
 * the Efficiency Mode preset applied (when `enabled === true`) or restored
 * from the baseline snapshot (when `enabled === false`). The returned object
 * contains only the keys this helper owns; callers must merge it into the
 * full settings.
 *
 * Design:
 *   - Enable: snapshot the current values of the four sub-settings into
 *     `efficiencyModeBaseline`, then set them to their Efficiency presets.
 *   - Disable: restore the sub-settings from `efficiencyModeBaseline`, then
 *     clear the baseline. A missing key in the baseline means "restore to
 *     undefined" (the user originally hadn't set it).
 *   - Idempotent: enabling when already on is a no-op; ditto for disabling.
 *   - Pure: never mutates the input.
 *
 * See `docs/plans/260524_performance_mode.md`.
 */
import type { AppSettings } from '../types/settings';

export type EfficiencyModeSlice = Pick<
  AppSettings,
  | 'efficiencyMode'
  | 'efficiencyModeBaseline'
  | 'dailySparkMode'
  | 'heroChoiceRunMode'
  | 'timeSavedEstimation'
  | 'personaQuipsEnabled'
  | 'cpuEmbeddingIdleDisposalEnabled'
>;

const EFFICIENCY_PRESET = {
  dailySparkMode: 'off' as const,
  heroChoiceRunMode: 'off' as const,
  timeSavedEstimationEnabled: false,
  personaQuipsEnabled: false,
  cpuEmbeddingIdleDisposalEnabled: true,
};

export function isEfficiencyModeOn(settings: AppSettings | null | undefined): boolean {
  return settings?.efficiencyMode === 'on';
}

export function applyEfficiencyMode(
  current: AppSettings,
  enabled: boolean,
): EfficiencyModeSlice {
  if (enabled) {
    // Idempotent enable: preserve the existing baseline rather than overwriting
    // it with the (now-Efficiency) preset values.
    if (current.efficiencyMode === 'on' && current.efficiencyModeBaseline) {
      return {
        efficiencyMode: 'on',
        efficiencyModeBaseline: current.efficiencyModeBaseline,
        dailySparkMode: EFFICIENCY_PRESET.dailySparkMode,
        heroChoiceRunMode: EFFICIENCY_PRESET.heroChoiceRunMode,
        timeSavedEstimation: {
          ...(current.timeSavedEstimation ?? {}),
          enabled: EFFICIENCY_PRESET.timeSavedEstimationEnabled,
        },
        personaQuipsEnabled: EFFICIENCY_PRESET.personaQuipsEnabled,
        cpuEmbeddingIdleDisposalEnabled: EFFICIENCY_PRESET.cpuEmbeddingIdleDisposalEnabled,
      };
    }
    return {
      efficiencyMode: 'on',
      efficiencyModeBaseline: {
        dailySparkMode: current.dailySparkMode,
        heroChoiceRunMode: current.heroChoiceRunMode,
        timeSavedEstimationEnabled: current.timeSavedEstimation?.enabled,
        personaQuipsEnabled: current.personaQuipsEnabled,
        cpuEmbeddingIdleDisposalEnabled: current.cpuEmbeddingIdleDisposalEnabled,
      },
      dailySparkMode: EFFICIENCY_PRESET.dailySparkMode,
      heroChoiceRunMode: EFFICIENCY_PRESET.heroChoiceRunMode,
      timeSavedEstimation: {
        ...(current.timeSavedEstimation ?? {}),
        enabled: EFFICIENCY_PRESET.timeSavedEstimationEnabled,
      },
      personaQuipsEnabled: EFFICIENCY_PRESET.personaQuipsEnabled,
      cpuEmbeddingIdleDisposalEnabled: EFFICIENCY_PRESET.cpuEmbeddingIdleDisposalEnabled,
    };
  }

  // Disabling. If no baseline exists then we're either already-off (in which
  // case the sub-settings are the user's true values and we must NOT touch
  // them) or we're in an orphaned state (mode was 'on' but the baseline was
  // lost — e.g. a corrupted settings import). The two cases are distinguishable
  // by `current.efficiencyMode`. For the orphaned case the safe restore is to
  // clear the sub-settings to undefined so they fall back to app defaults
  // rather than leave the user permanently stuck with the Efficiency preset.
  const baseline = current.efficiencyModeBaseline;
  if (!baseline) {
    const wasOrphaned = current.efficiencyMode === 'on';
    return {
      efficiencyMode: 'off',
      efficiencyModeBaseline: undefined,
      dailySparkMode: wasOrphaned ? undefined : current.dailySparkMode,
      heroChoiceRunMode: wasOrphaned ? undefined : current.heroChoiceRunMode,
      timeSavedEstimation: wasOrphaned
        ? { ...(current.timeSavedEstimation ?? {}), enabled: undefined }
        : current.timeSavedEstimation,
      personaQuipsEnabled: wasOrphaned ? undefined : current.personaQuipsEnabled,
      cpuEmbeddingIdleDisposalEnabled: wasOrphaned ? undefined : current.cpuEmbeddingIdleDisposalEnabled,
    };
  }

  return {
    efficiencyMode: 'off',
    efficiencyModeBaseline: undefined,
    dailySparkMode: baseline.dailySparkMode,
    heroChoiceRunMode: baseline.heroChoiceRunMode,
    timeSavedEstimation: {
      ...(current.timeSavedEstimation ?? {}),
      enabled: baseline.timeSavedEstimationEnabled,
    },
    personaQuipsEnabled: baseline.personaQuipsEnabled,
    cpuEmbeddingIdleDisposalEnabled: baseline.cpuEmbeddingIdleDisposalEnabled,
  };
}
