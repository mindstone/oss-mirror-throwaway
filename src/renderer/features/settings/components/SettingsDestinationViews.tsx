import { useState } from 'react';
import type { AppSettings } from '@shared/types';
import styles from './SettingsSurface.module.css';
import type { UpdateRoot } from './tabs/types';
import { AccountTab, CloudTab, DiagnosticsTab, DeveloperTab, MeetingsTab, PluginsTab, SafetyTab, SpacesTab } from './tabs';
import { RenameWorkspaceDialog } from './RenameWorkspaceDialog';
import { SystemAccountPreferencesSections } from './sections/SystemAccountPreferencesSections';
import { SystemAdvancedOperationsSection } from './sections/SystemAdvancedOperationsSection';
import {
  MeetingNotetakerUnlockSection,
  LocalInferenceToggleSection,
  ContextCompactionSection,
  AdaptiveRoutingToggleSection,
  PowerSaveToggleSection,
} from './sections/SystemExperimentalFeaturesSection';
import { FocusToggleSection } from './sections/FocusToggleSection';
import { SystemWorkspaceSections } from './sections/SystemWorkspaceSections';
import { MigrationTransferSection } from './MigrationTransferSection';
import { SettingsPageAnchors } from './SettingsPageAnchors';
import type { SettingsOnPageAnchorConfig } from './settingsOnPageAnchorConfig';

type AnchorableDestinationProps = {
  anchors: readonly SettingsOnPageAnchorConfig[];
  activeAnchorId?: string;
  onSelectAnchor: (anchorId: string) => void;
};

type SharedDestinationProps = {
  draftSettings: AppSettings;
  updateDraft: UpdateRoot;
};

type WorkspaceDestinationProps = SharedDestinationProps &
  AnchorableDestinationProps & {
    chooseDirectory: () => Promise<void> | void;
  };

type AccountPreferencesDestinationProps = SharedDestinationProps & AnchorableDestinationProps;

type PrivacySafetyDestinationProps = SharedDestinationProps &
  AnchorableDestinationProps & {
    onChatAboutSafety?: () => void;
  };

type AdvancedDestinationProps = SharedDestinationProps &
  AnchorableDestinationProps & {
    developerModeEnabled: boolean;
    onRelaunchOnboarding: () => void;
    onResetOnboardingChecklist: () => void;
  };

const DestinationHeader = ({
  title,
  description,
}: {
  title: string;
  description: string;
}) => (
  <header className={styles.pageHeader}>
    <h2 className={styles.pageTitle}>{title}</h2>
    <p className={styles.pageDescription}>{description}</p>
  </header>
);

export const SettingsWorkspaceDestination = ({
  draftSettings,
  updateDraft,
  chooseDirectory,
  anchors,
  activeAnchorId,
  onSelectAnchor,
}: WorkspaceDestinationProps) => (
  <>
    <div className={styles.pageChrome}>
      <DestinationHeader
        title="Workspace"
        description="Where Rebel stores context, spaces, continuity, and messaging settings."
      />
    </div>
    <SettingsPageAnchors
      anchors={anchors}
      activeAnchorId={activeAnchorId}
      onSelectAnchor={onSelectAnchor}
    />
    <SystemWorkspaceSections
      draftSettings={draftSettings}
      updateDraft={updateDraft}
      chooseDirectory={chooseDirectory}
    />
    <SpacesTab draftSettings={draftSettings} />
    <CloudTab draftSettings={draftSettings} updateDraft={updateDraft} embedded />
    {/* Bottom of the Workspace tab, beneath messaging (see PLAN Stage 4). */}
    <MigrationTransferSection />
  </>
);

export const SettingsAccountPreferencesDestination = ({
  draftSettings,
  updateDraft,
  anchors,
  activeAnchorId,
  onSelectAnchor,
}: AccountPreferencesDestinationProps) => (
  <>
    <div className={styles.pageChrome}>
      <DestinationHeader
        title="Account & Preferences"
        description="Profile, appearance, notifications, and the small details that make Rebel feel like yours."
      />
    </div>
    <SettingsPageAnchors
      anchors={anchors}
      activeAnchorId={activeAnchorId}
      onSelectAnchor={onSelectAnchor}
    />
    <AccountTab draftSettings={draftSettings} updateDraft={updateDraft} />
    <SystemAccountPreferencesSections
      draftSettings={draftSettings}
      updateDraft={updateDraft}
    />
  </>
);

export const SettingsPrivacySafetyDestination = ({
  draftSettings,
  updateDraft,
  anchors,
  activeAnchorId,
  onSelectAnchor,
  onChatAboutSafety,
}: PrivacySafetyDestinationProps) => (
  <>
    <div className={styles.pageChrome}>
      <DestinationHeader
        title="Privacy & Safety"
        description="Control what Rebel can do, remember, and share."
      />
    </div>
    <SettingsPageAnchors
      anchors={anchors}
      activeAnchorId={activeAnchorId}
      onSelectAnchor={onSelectAnchor}
    />
    <SafetyTab
      draftSettings={draftSettings}
      updateDraft={updateDraft}
      onChatAboutSafety={onChatAboutSafety}
    />
  </>
);

export const SettingsMeetingsDestination = ({
  draftSettings,
  updateDraft,
}: SharedDestinationProps) => (
  <>
    <div className={styles.pageChrome}>
      <DestinationHeader
        title="Meetings"
        description="Control how Rebel joins, records, and organizes meeting notes."
      />
    </div>
    <MeetingNotetakerUnlockSection
      draftSettings={draftSettings}
      updateDraft={updateDraft}
    />
    <MeetingsTab draftSettings={draftSettings} updateDraft={updateDraft} />
  </>
);

export const SettingsAdvancedDestination = ({
  draftSettings,
  updateDraft,
  developerModeEnabled,
  anchors,
  activeAnchorId,
  onSelectAnchor,
  onRelaunchOnboarding,
  onResetOnboardingChecklist,
}: AdvancedDestinationProps) => {
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);

  return (
    <>
      <div className={styles.pageChrome}>
        <DestinationHeader
          title="Advanced"
          description="Diagnostics, plugins, developer tools, and a few sharp edges for people who asked for them."
        />
      </div>
      <SettingsPageAnchors
        anchors={anchors}
        activeAnchorId={activeAnchorId}
        onSelectAnchor={onSelectAnchor}
      />
      <DiagnosticsTab
        draftSettings={draftSettings}
        updateDraft={updateDraft}
        onRelaunchOnboarding={onRelaunchOnboarding}
        onResetOnboardingChecklist={onResetOnboardingChecklist}
      />
      <PluginsTab />
      {developerModeEnabled ? (
        <DeveloperTab
          draftSettings={draftSettings}
          updateDraft={updateDraft}
        />
      ) : null}
      <SystemAdvancedOperationsSection
        draftSettings={draftSettings}
        onOpenRenameDialog={() => setRenameDialogOpen(true)}
      />
      <LocalInferenceToggleSection
        draftSettings={draftSettings}
        updateDraft={updateDraft}
      />
      <ContextCompactionSection
        draftSettings={draftSettings}
        updateDraft={updateDraft}
      />
      <AdaptiveRoutingToggleSection
        draftSettings={draftSettings}
        updateDraft={updateDraft}
      />
      <FocusToggleSection
        draftSettings={draftSettings}
        updateDraft={updateDraft}
      />
      <PowerSaveToggleSection
        draftSettings={draftSettings}
        updateDraft={updateDraft}
      />
      {draftSettings.coreDirectory ? (
        <RenameWorkspaceDialog
          isOpen={renameDialogOpen}
          onClose={() => setRenameDialogOpen(false)}
          currentPath={draftSettings.coreDirectory}
        />
      ) : null}
    </>
  );
};
