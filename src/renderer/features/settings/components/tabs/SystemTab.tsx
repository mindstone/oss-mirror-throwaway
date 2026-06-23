import { useState } from 'react';
import styles from '../SettingsSurface.module.css';
import type { SystemTabProps } from './types';
import { RenameWorkspaceDialog } from '../RenameWorkspaceDialog';
import { SystemWorkspaceSections } from '../sections/SystemWorkspaceSections';
import { SystemAccountPreferencesSections } from '../sections/SystemAccountPreferencesSections';
import { SystemPowerPerformanceSection } from '../sections/SystemPowerPerformanceSection';
import { SystemAdvancedOperationsSection } from '../sections/SystemAdvancedOperationsSection';
export const SystemTab = ({ draftSettings, updateDraft, chooseDirectory }: SystemTabProps) => {
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);

  return (
    <>
      <header className={styles.pageHeader}>
        <h2 className={styles.pageTitle}>System</h2>
        <p className={styles.pageDescription}>Configure your workspace location, appearance preferences, and display options.</p>
      </header>

      <SystemWorkspaceSections draftSettings={draftSettings} updateDraft={updateDraft} chooseDirectory={chooseDirectory} />

      <SystemAccountPreferencesSections draftSettings={draftSettings} updateDraft={updateDraft} />

      <SystemPowerPerformanceSection draftSettings={draftSettings} updateDraft={updateDraft} />

      <SystemAdvancedOperationsSection draftSettings={draftSettings} onOpenRenameDialog={() => setRenameDialogOpen(true)} />

      {draftSettings.coreDirectory && (
        <RenameWorkspaceDialog
          isOpen={renameDialogOpen}
          onClose={() => setRenameDialogOpen(false)}
          currentPath={draftSettings.coreDirectory}
        />
      )}
    </>
  );
};
