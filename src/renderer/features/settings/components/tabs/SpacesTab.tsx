import { Button, Tooltip } from '@renderer/components/ui';
import { useFeatureGate } from '@renderer/hooks/useFeatureGate';
import { useSettingsSafe } from '@renderer/features/settings/SettingsProvider';
import { Plus } from 'lucide-react';
import { SpacesManager } from '../SpacesManager';
import type { AppSettings } from '@shared/types';
import { SettingRow } from '../SettingRow';
import { SettingSection } from '../SettingSection';

export type SpacesTabProps = {
  draftSettings: AppSettings;
};

/**
 * Spaces settings tab - manage workspace spaces for project context.
 */
export const SpacesTab = ({ draftSettings }: SpacesTabProps) => {
  const { isFeatureEnabled } = useFeatureGate();
  const settingsContext = useSettingsSafe();
  const canCreateAdditionalSpaces = isFeatureEnabled('spaces:create-additional');

  const handleAddSpace = () => {
    settingsContext?.requestPendingSpacesAction?.('add');
  };

  return (
    <SettingSection
      title="Spaces"
      description="Spaces help Rebel understand your context. Each space is a folder that holds files, notes, and instructions relevant to a project, team, or area of your life. When you ask Rebel a question, it searches your spaces to give you better answers."
      data-section="spaces"
      data-testid="settings-section-spaces"
    >
      <SettingRow
        label="Create a space"
        description="Add a space for a project, team, or area of your life."
        variant="stacked"
      >
        <Tooltip content={canCreateAdditionalSpaces ? undefined : 'Teams license required to add spaces. To get Rebel for your team, contact us at hello@mindstone.com'}>
          <span style={{ display: 'inline-flex' }}>
            <Button
              variant="outline"
              onClick={handleAddSpace}
              disabled={!canCreateAdditionalSpaces}
            >
              <Plus size={16} /> Add space
            </Button>
          </span>
        </Tooltip>
      </SettingRow>
      <SpacesManager
        companyName={draftSettings?.companyName}
        pendingSpacesAction={settingsContext?.pendingSpacesAction ?? null}
        consumePendingSpacesAction={settingsContext?.consumePendingSpacesAction}
      />
    </SettingSection>
  );
};
