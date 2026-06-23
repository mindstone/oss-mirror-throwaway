import { MaturityBadge, Toggle } from '@renderer/components/ui';
import { SettingRow } from '../SettingRow';
import { SettingSection } from '../SettingSection';
import type { SystemTabProps } from '../tabs/types';

/** Focus strategic planning toggle — composed into Advanced destination. */
export const FocusToggleSection = ({
  draftSettings,
  updateDraft,
}: Pick<SystemTabProps, 'draftSettings' | 'updateDraft'>) => (
  <SettingSection
    title="Focus"
    description="Strategic weekly planning — calendar analysis, goal tracking, and meeting audit."
    badge={<MaturityBadge level="early" featureName="Experimental Features" />}
    data-section="focus"
    data-testid="settings-section-focus"
  >
    <SettingRow
      label="Enable Focus"
      tooltip="Strategic weekly planning — calendar analysis, goal tracking, and meeting audit."
      htmlFor="focus-toggle"
    >
      <Toggle
        id="focus-toggle"
        data-testid="settings-focus-toggle"
        checked={draftSettings.experimental?.focusEnabled === true}
        onCheckedChange={() => {
          updateDraft('experimental', {
            ...draftSettings.experimental,
            focusEnabled: !draftSettings.experimental?.focusEnabled,
          });
        }}
      />
    </SettingRow>
  </SettingSection>
);
