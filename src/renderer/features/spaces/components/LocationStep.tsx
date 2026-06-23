/**
 * LocationStep Component
 *
 * Step 1 of the Add Space Wizard. Allows user to select a folder path
 * and optionally configure subfolder creation for symlinked folders.
 */

import { useCallback, useState } from 'react';
import { FolderOpen, Link, Link2, Info, AlertCircle, AlertTriangle, Copy, Check, CloudOff } from 'lucide-react';
import { Button, Badge } from '@renderer/components/ui';
import type { PathValidationIssue } from '@shared/ipc/schemas/library';
import { DEFAULT_SUBFOLDERS } from '../hooks/useSpaceWizardState';
import styles from './AddSpaceWizard.module.css';

export interface LocationStepProps {
  /** Selected folder path */
  path: string | null;
  /** Error message for path selection */
  pathError: string | null;
  /** Structured validation issues from path analysis */
  validationIssues: PathValidationIssue[];
  /** Whether the selected path is a symlink */
  isSymlink: boolean;
  /** Target of the symlink if applicable */
  symlinkTarget: string | null;
  /** Whether the selected path is inside the workspace */
  isInsideWorkspace: boolean;
  /** Whether to create default subfolders */
  createSubfolders: boolean;
  /** List of selected subfolders to create */
  selectedSubfolders: string[];
  /** Handler to open native folder picker and select a path */
  onPathSelect: () => Promise<void>;
  /** Handler for create subfolders toggle change */
  onCreateSubfoldersChange: (value: boolean) => void;
  /** Handler for individual subfolder selection changes */
  onSubfoldersChange: (subfolders: string[]) => void;
  /** Whether path analysis is in progress */
  isAnalyzing?: boolean;
}

/**
 * LocationStep - First step of the Add Space Wizard
 *
 * @example
 * <LocationStep
 *   path="/Users/name/GoogleDrive/Shared Drives/Projects"
 *   pathError={null}
 *   validationIssues={[]}
 *   isSymlink={true}
 *   symlinkTarget="/Library/CloudStorage/[external-email]/Shared Drives/Projects"
 *   isInsideWorkspace={false}
 *   createSubfolders={false}
 *   selectedSubfolders={['memory', 'skills', 'scripts']}
 *   onPathSelect={handlePathSelect}
 *   onCreateSubfoldersChange={handleCreateSubfoldersChange}
 *   onSubfoldersChange={handleSubfoldersChange}
 * />
 */
export const LocationStep = ({
  path,
  pathError,
  validationIssues,
  isSymlink,
  symlinkTarget,
  isInsideWorkspace,
  createSubfolders,
  selectedSubfolders,
  onPathSelect,
  onCreateSubfoldersChange,
  onSubfoldersChange,
  isAnalyzing = false,
}: LocationStepProps) => {
  const [copied, setCopied] = useState(false);

  const handleCopyPath = useCallback(async () => {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access failed - ignore silently
    }
  }, [path]);

  const handleSubfolderToggle = useCallback(
    (subfolder: string, checked: boolean) => {
      if (checked) {
        onSubfoldersChange([...selectedSubfolders, subfolder]);
      } else {
        onSubfoldersChange(selectedSubfolders.filter((s) => s !== subfolder));
      }
    },
    [selectedSubfolders, onSubfoldersChange]
  );

  const handleSelectAll = useCallback(() => {
    onSubfoldersChange([...DEFAULT_SUBFOLDERS]);
  }, [onSubfoldersChange]);

  const handleSelectNone = useCallback(() => {
    onSubfoldersChange([]);
  }, [onSubfoldersChange]);

  return (
    <div className={styles.stepContent}>
      <p className={styles.stepDescription}>
        Select a folder to add as a space. This can be a local folder or a synced cloud storage
        folder.
      </p>

      {/* What's a space? guidance box - shown before folder selection */}
      {!path && (
        <div className={styles.guidanceBox}>
          <div className={styles.guidanceHeader}>
            <Info size={14} className={styles.guidanceIcon} />
            <span className={styles.guidanceTitle}>What&apos;s a space?</span>
          </div>
          <p className={styles.guidanceText}>
            A space is a folder that contains skills, memories, and scripts, with its own sharing
            settings. Add your project folders, team shared drives, or personal areas.
          </p>
        </div>
      )}

      {/* Folder selection */}
      <div className={styles.locationSelector}>
        <Button
          onClick={() => void onPathSelect()}
          disabled={isAnalyzing}
          className={styles.selectFolderButton}
        >
          <FolderOpen size={16} />
          {isAnalyzing ? 'Analyzing...' : 'Choose Folder...'}
        </Button>

        {/* Selected path display - multi-line with copy button */}
        {path && (
          <div className={styles.pathDisplay}>
            <span className={styles.pathLabel}>Selected path</span>
            <div className={styles.pathDisplayBox}>
              <div className={styles.pathText}>{path}</div>
              <div className={styles.pathActions}>
                <button
                  type="button"
                  onClick={() => void handleCopyPath()}
                  className={`${styles.copyButton} ${copied ? styles.copyButtonCopied : ''}`}
                  aria-label={copied ? 'Copied' : 'Copy path'}
                >
                  {copied ? (
                    <>
                      <Check size={12} />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy size={12} />
                      Copy
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Simple error message (legacy/fallback) */}
        {pathError && <div className={styles.pathError}>{pathError}</div>}

        {/* Validation issues (errors and warnings) - exclude cloud warning if we'll show combined box */}
        {(() => {
          const cloudWarning = validationIssues.find(i => i.type === 'cloud_storage_offline_recommended');
          const otherIssues = validationIssues.filter(i => i.type !== 'cloud_storage_offline_recommended');
          const showCombinedCloudBox = cloudWarning && !isInsideWorkspace;

          return (
            <>
              {/* Regular validation issues (non-cloud) */}
              {otherIssues.length > 0 && (
                <div className={styles.validationIssues}>
                  {otherIssues.map((issue, index) => (
                    <div
                      key={`${issue.type}-${index}`}
                      className={`${styles.validationIssue} ${
                        issue.severity === 'error' ? styles.validationError : styles.validationWarning
                      }`}
                    >
                      <div className={styles.validationIssueHeader}>
                        {issue.severity === 'error' ? (
                          <AlertCircle size={16} className={styles.validationIconError} />
                        ) : (
                          <AlertTriangle size={16} className={styles.validationIconWarning} />
                        )}
                        <span className={styles.validationMessage}>{issue.message}</span>
                      </div>
                      {issue.suggestion && (
                        <span className={styles.validationSuggestion}>{issue.suggestion}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Combined cloud storage info box - replaces separate warning + info notes */}
              {showCombinedCloudBox && (
                <div className={styles.cloudStorageInfoBox}>
                  <div className={styles.cloudStorageHeader}>
                    <CloudOff size={18} className={styles.cloudStorageIcon} />
                    <span className={styles.cloudStorageTitle}>Cloud Storage Folder</span>
                  </div>
                  <ul className={styles.cloudStorageList}>
                    <li>{cloudWarning.message}</li>
                    <li>Rebel will create a link to this folder, so your original files stay where they are.</li>
                    <li>Changes Rebel makes (like adding memory files) will appear in the original folder location.</li>
                  </ul>
                </div>
              )}

              {/* Cloud warning only (inside workspace) - show standalone */}
              {cloudWarning && isInsideWorkspace && (
                <div className={styles.validationIssues}>
                  <div className={`${styles.validationIssue} ${styles.validationCloudWarning}`}>
                    <div className={styles.validationIssueHeader}>
                      <CloudOff size={16} className={styles.validationIconCloud} />
                      <span className={styles.validationMessage}>{cloudWarning.message}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* External folder info notes - only show if NOT cloud storage (cloud has combined box) */}
              {path && !isInsideWorkspace && !cloudWarning && (
                <div className={styles.externalFolderNotes}>
                  <div className={styles.infoNote}>
                    <Link2 size={14} className={styles.infoNoteIcon} />
                    <span className={styles.infoNoteText}>
                      This folder lives outside your workspace. Rebel will create a link to it, so your
                      original files stay where they are.
                    </span>
                  </div>
                  <div className={styles.warningNote}>
                    <AlertTriangle size={14} className={styles.warningNoteIcon} />
                    <span className={styles.warningNoteText}>
                      Changes Rebel makes (like adding memory files) will appear in the original folder
                      location.
                    </span>
                  </div>
                </div>
              )}
            </>
          );
        })()}
      </div>

      {/* Symlink info and subfolder options */}
      {path && isSymlink && (
        <div className={styles.symlinkSection}>
          {/* Symlink info badge */}
          <div className={styles.symlinkInfo}>
            <Badge variant="secondary" className={styles.symlinkBadge}>
              <Link size={12} />
              Linked folder
            </Badge>
            {symlinkTarget && (
              <span className={styles.symlinkTarget}>
                Points to: <code>{symlinkTarget}</code>
              </span>
            )}
          </div>

          {/* Subfolder creation option */}
          <div className={styles.subfolderSection}>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={createSubfolders}
                onChange={(e) => onCreateSubfoldersChange(e.target.checked)}
                className={styles.checkbox}
              />
              <span className={styles.checkboxText}>
                Create default subfolders in this location
              </span>
            </label>

            <div className={styles.subfolderHint}>
              <Info size={14} />
              <span>
                Rebel uses these folders for memory, skills, and scripts. You can create them later
                if needed.
              </span>
            </div>

            {/* Individual subfolder checkboxes */}
            {createSubfolders && (
              <div className={styles.subfolderList}>
                <div className={styles.subfolderHeader}>
                  <span>Select folders to create:</span>
                  <div className={styles.subfolderActions}>
                    <button
                      type="button"
                      onClick={handleSelectAll}
                      className={styles.selectLink}
                    >
                      All
                    </button>
                    <span className={styles.selectDivider}>|</span>
                    <button
                      type="button"
                      onClick={handleSelectNone}
                      className={styles.selectLink}
                    >
                      None
                    </button>
                  </div>
                </div>

                {DEFAULT_SUBFOLDERS.map((subfolder) => (
                  <label key={subfolder} className={styles.subfolderCheckbox}>
                    <input
                      type="checkbox"
                      checked={selectedSubfolders.includes(subfolder)}
                      onChange={(e) => handleSubfolderToggle(subfolder, e.target.checked)}
                      className={styles.checkbox}
                    />
                    <code className={styles.subfolderName}>{subfolder}/</code>
                    <span className={styles.subfolderDescription}>
                      {getSubfolderDescription(subfolder)}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Get a brief description for each default subfolder
 */
function getSubfolderDescription(subfolder: string): string {
  switch (subfolder) {
    case 'memory':
      return 'Store context and notes Rebel can reference';
    case 'skills':
      return 'Custom instructions for how Rebel should work';
    case 'scripts':
      return 'Executable scripts Rebel can run';
    default:
      return '';
  }
}
