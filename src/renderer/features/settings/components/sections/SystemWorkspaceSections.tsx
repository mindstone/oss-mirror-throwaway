import { useCallback, useMemo } from 'react';
import { Button } from '@renderer/components/ui';
import { FolderOpen, X } from 'lucide-react';
import styles from '../SettingsSurface.module.css';
import { SettingRow } from '../SettingRow';
import { SettingSection } from '../SettingSection';
import type { SystemTabProps } from '../tabs/types';

/**
 * Workspace-oriented blocks from System settings (core directory, scratchpad).
 * Composed later into the Workspace destination; kept free of tab chrome.
 */
export const SystemWorkspaceSections = ({
  draftSettings,
  updateDraft,
  chooseDirectory,
}: Pick<SystemTabProps, 'draftSettings' | 'updateDraft' | 'chooseDirectory'>) => {
  const excludedFolders = useMemo(
    () => draftSettings.scratchpad?.excludedFolders ?? [],
    [draftSettings.scratchpad?.excludedFolders],
  );

  const handleBrowseExcludedFolder = useCallback(async () => {
    if (!draftSettings.coreDirectory) return;

    const cosSpace = draftSettings.spaces?.find(
      (s) => s.type === 'chief-of-staff' || s.path.toLowerCase().replace(/\/$/, '') === 'chief-of-staff',
    );
    const cosDir = cosSpace?.path.replace(/\/$/, '') || 'Chief-of-Staff';
    const baseDir = `${draftSettings.coreDirectory}/${cosDir}/memory`;
    const selected = await window.settingsApi.chooseDirectoryInDirectory({
      baseDir,
      returnRelative: true,
    });

    if (selected && !excludedFolders.includes(selected)) {
      updateDraft('scratchpad', {
        ...draftSettings.scratchpad,
        excludedFolders: [...excludedFolders, selected],
      });
    }
  }, [draftSettings.coreDirectory, draftSettings.scratchpad, draftSettings.spaces, excludedFolders, updateDraft]);

  const handleRemoveExcludedFolder = useCallback(
    (folder: string) => {
      updateDraft('scratchpad', {
        ...draftSettings.scratchpad,
        excludedFolders: excludedFolders.filter((f) => f !== folder),
      });
    },
    [draftSettings.scratchpad, excludedFolders, updateDraft],
  );

  return (
    <>
      <SettingSection
        title="Core Directory"
        description="Your Library root containing spaces, skills, and memory."
        data-section="coreDirectory"
      >
        <SettingRow
          label="Location"
          tooltip="Your core directory is Rebel’s home folder for spaces, skills, and memory."
          variant="stacked"
          htmlFor="core-directory"
        >
          <div className={styles.filePathRow}>
            <input
              id="core-directory"
              data-testid="settings-core-directory-input"
              value={draftSettings.coreDirectory ?? ''}
              placeholder="Select the working directory"
              onChange={(event) => updateDraft('coreDirectory', event.target.value)}
            />
            <Button variant="ghost" className={styles.minWidthAuto} onClick={chooseDirectory} data-testid="settings-core-directory-choose">
              Choose...
            </Button>
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection title="Scratchpad" description="Configure the quick-capture scratchpad feature." data-section="scratchpad">
        <SettingRow
          label="Excluded folders from Recent Files"
          description="Folders in your memory directory to exclude from the recent files list."
          variant="stacked"
        >
          <div className={styles.tagList}>
            {excludedFolders.map((folder) => (
              <span key={folder} className={styles.tag}>
                {folder}
                <button type="button" className={styles.tagRemove} onClick={() => handleRemoveExcludedFolder(folder)} aria-label={`Remove ${folder}`}>
                  <X size={12} />
                </button>
              </span>
            ))}
            <Button variant="ghost" size="sm" onClick={() => void handleBrowseExcludedFolder()} disabled={!draftSettings.coreDirectory}>
              <FolderOpen size={14} />
              Add folder...
            </Button>
          </div>
        </SettingRow>
      </SettingSection>
    </>
  );
};
