import { useCallback } from 'react';
import { tracking } from '@renderer/src/tracking';
import { SettingRow } from '../SettingRow';
import { SettingSection } from '../SettingSection';
import { applyEfficiencyMode } from '@shared/utils/efficiencyMode';
import type { SystemTabProps } from '../tabs/types';

/**
 * Efficiency Mode — Power & Performance.
 *
 * One toggle, one coordinated preset. When on, sub-settings (Daily Spark,
 * Hero Choice, time-saved estimation, persona quips, CPU embedding idle
 * disposal) are written through to their Efficiency values; baseline is
 * preserved for restore-on-disable. See `applyEfficiencyMode` for the pure
 * transform and `docs/plans/260524_performance_mode.md` for context.
 */
export const SystemPowerPerformanceSection = ({
  draftSettings,
  updateDraft,
}: Pick<SystemTabProps, 'draftSettings' | 'updateDraft'>) => {
  const isOn = draftSettings.efficiencyMode === 'on';

  const handleToggle = useCallback(
    (next: boolean) => {
      const transformed = applyEfficiencyMode(draftSettings, next);
      updateDraft('efficiencyMode', transformed.efficiencyMode);
      updateDraft('efficiencyModeBaseline', transformed.efficiencyModeBaseline);
      updateDraft('dailySparkMode', transformed.dailySparkMode);
      updateDraft('heroChoiceRunMode', transformed.heroChoiceRunMode);
      updateDraft('timeSavedEstimation', transformed.timeSavedEstimation);
      updateDraft('personaQuipsEnabled', transformed.personaQuipsEnabled);
      updateDraft(
        'cpuEmbeddingIdleDisposalEnabled',
        transformed.cpuEmbeddingIdleDisposalEnabled,
      );
      tracking.settings.efficiencyModeToggled(next, 'settings');
    },
    [draftSettings, updateDraft],
  );

  return (
    <SettingSection
      title="Power & Performance"
      description="Quieter mode for older or low-RAM machines. Pauses animations, proactive nudges, and decorative LLM calls. Knowledge work is unchanged."
      data-section="powerPerformance"
    >
      <SettingRow
        label="Efficiency Mode"
        description={
          isOn
            ? 'On — Daily Spark, Hero Choice, time-saved estimates, and persona quips are paused; animations reduced; CPU embeddings released when idle. Your previous settings are restored when you turn this off.'
            : 'Off — all features run as configured.'
        }
        htmlFor="efficiency-mode-toggle"
      >
        <input
          id="efficiency-mode-toggle"
          data-testid="settings-efficiency-mode-toggle"
          type="checkbox"
          checked={isOn}
          onChange={(event) => handleToggle(event.target.checked)}
        />
      </SettingRow>
    </SettingSection>
  );
};
