import { Button, Notice } from '@renderer/components/ui';
import styles from '../SettingsSurface.module.css';
import { SettingSection } from '../SettingSection';
import type { SystemTabProps } from '../tabs/types';

type Props = Pick<SystemTabProps, 'draftSettings'> & {
  onOpenRenameDialog: () => void;
};

/**
 * Rename workspace + danger-zone style operations (Advanced composition).
 */
export const SystemAdvancedOperationsSection = ({ draftSettings, onOpenRenameDialog }: Props) => (
  <SettingSection title="Advanced Operations" data-section="advancedOperations" advanced data-testid="settings-section-advanced-operations">
    <Notice tone="warning" placement="inline">
      These operations can affect your data. Make sure cloud sync is complete before proceeding.
    </Notice>

    <div className={`${styles.modelConfigCard} ${styles.systemRenameCard}`}>
      <div className={styles.clusterHeader}>
        <h3 className={`${styles.clusterTitle} ${styles.systemRenameTitle}`}>Rename Workspace Folder</h3>
        <p className={styles.clusterDescription}>
          Current: <code className={styles.systemRenamePathCode}>{draftSettings.coreDirectory ?? 'Not set'}</code>
        </p>
      </div>
      <p className={`${styles.groupDescription} ${styles.systemRenameDescription}`}>
        Changes the folder name on disk. The app will restart to apply changes. Your workspace contents will not be affected.
      </p>
      <Button variant="outline" size="sm" onClick={onOpenRenameDialog} disabled={!draftSettings.coreDirectory} className={styles.actionButton}>
        Rename...
      </Button>
    </div>
  </SettingSection>
);
