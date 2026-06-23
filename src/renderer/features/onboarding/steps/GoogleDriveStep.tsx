import { useCallback, useState } from 'react';
import { dirname } from 'pathe';
import { Check, Download, FolderOpen, FolderPlus, Info, Trash2 } from 'lucide-react';
import { Button, Tooltip } from '@renderer/components/ui';
import { AddSpaceWizard } from '@renderer/features/spaces';
import { useFeatureGate } from '@renderer/hooks/useFeatureGate';
import { invalidateSpaces } from '@renderer/hooks/useSpacesData';
import type { CreateSpaceOptions, SpaceInfo } from '@shared/ipc/schemas/library';
import styles from '../OnboardingWizard.module.css';
import type { GoogleDriveStepProps } from './types';
import makeOfflineScreenshot from '@renderer/assets/onboarding/gdrive-make-offline.png';

const GOOGLE_DRIVE_DOWNLOAD_URL = 'https://www.google.com/drive/download/';
const ONEDRIVE_DOWNLOAD_URL = 'https://www.microsoft.com/en-us/microsoft-365/onedrive/download';
const DROPBOX_DOWNLOAD_URL = 'https://www.dropbox.com/install';

/**
 * Installation status for cloud storage apps.
 */
type InstallationStatus = 'not-installed' | 'installed-not-configured' | 'installed';

/**
 * Renders a cloud storage download/status button.
 * Shows:
 * - "Installed" with checkmark when installed and configured
 * - "Installed - Sign in to sync" when installed but not configured
 * - "Download" when not installed
 */
const CloudStorageButton = ({
  name,
  downloadUrl,
  status,
  onBypass,
}: {
  name: string;
  downloadUrl: string;
  status: InstallationStatus;
  onBypass: () => void;
}) => {
  const isInstalled = status === 'installed' || status === 'installed-not-configured';
  const needsSignIn = status === 'installed-not-configured';
  
  // Handle button click based on status
  const handleClick = () => {
    if (status === 'not-installed') {
      // Open download page
      void window.appApi.openUrl(downloadUrl);
    }
    // installed and installed-not-configured: button is disabled, no action
  };
  
  return (
    <div className={styles.cloudStorageItem}>
      <Button
        variant="outline"
        onClick={handleClick}
        disabled={isInstalled}
        style={{
          gap: '0.5rem',
          ...(status === 'installed' ? {
            borderColor: 'var(--color-success)',
            color: 'var(--color-success)',
          } : {}),
          ...(needsSignIn ? {
            borderColor: 'var(--color-warning)',
            color: 'var(--color-warning)',
          } : {}),
        }}
      >
        {isInstalled ? (
          <>
            <Check size={14} />
            {needsSignIn ? `${name} - sign in to sync` : name}
          </>
        ) : (
          <>
            <Download size={14} />
            {name}
          </>
        )}
      </Button>

      {!isInstalled && (
        <button
          type="button"
          onClick={onBypass}
          className={styles.cloudStorageBypassLink}
        >
          Mark as installed
        </button>
      )}
    </div>
  );
};

export const GoogleDriveStep = ({
  state,
  actions,
  draftSettings,
}: GoogleDriveStepProps) => {
  const { isFeatureEnabled } = useFeatureGate();
  const canCreateAdditionalSpaces = isFeatureEnabled('spaces:create-additional');

  const {
    companyName,
    connectedSpaces,
    googleDriveError,
    googleDriveInstalled,
    oneDriveInstalled,
    oneDriveConfigured,
    orgCompanyDisplayName,
    orgHasSpaces,
    orgSharedDriveProvider,
  } = state;

  const {
    setCompanyName,
    setGoogleDriveError,
    addConnectedSpace,
    removeConnectedSpace,
    refreshConnectedSpaces,
  } = actions;

  // State for Add Space wizard
  const [showAddSpaceWizard, setShowAddSpaceWizard] = useState(false);
  const [isCreatingSpace, setIsCreatingSpace] = useState(false);
  const currentUserEmail = draftSettings.userEmail ?? window.electronEnv?.userEmail ?? null;
  
  // Manual bypass state - user can mark apps as "installed" if detection fails
  const [googleDriveBypass, setGoogleDriveBypass] = useState(false);
  const [oneDriveBypass, setOneDriveBypass] = useState(false);
  const [dropboxBypass, setDropboxBypass] = useState(false);
  
  // Compute installation status for each cloud storage app
  const googleDriveStatus: InstallationStatus = 
    googleDriveInstalled || googleDriveBypass ? 'installed' : 'not-installed';
  
  const oneDriveStatus: InstallationStatus = 
    oneDriveBypass ? 'installed' :
    (oneDriveInstalled && oneDriveConfigured) ? 'installed' :
    oneDriveInstalled ? 'installed-not-configured' :
    'not-installed';
  
  // Dropbox detection not implemented yet - only bypass supported
  const dropboxStatus: InstallationStatus = dropboxBypass ? 'installed' : 'not-installed';

  // Hide cloud storage section when org config specifies a provider and it's detected as running
  const hideCloudStorage = (() => {
    if (!orgSharedDriveProvider) return false;
    if (orgSharedDriveProvider === 'google-drive') return googleDriveStatus === 'installed';
    if (orgSharedDriveProvider === 'onedrive') return oneDriveStatus === 'installed';
    if (orgSharedDriveProvider === 'dropbox') return dropboxStatus === 'installed';
    return false;
  })();

  // Hide choose-spaces header/button when org config already defines spaces
  // (auto-created space chips still shown as read-only confirmation)
  const hideChooseSpaces = orgHasSpaces;

  // Handler for when the Add Space wizard completes
  const handleAddSpaceWizardComplete = useCallback(async (spaceConfig: CreateSpaceOptions) => {
    setIsCreatingSpace(true);
    setGoogleDriveError(null);
    
    try {
      const onboardingOrganisation = companyName.trim() || draftSettings?.companyName?.trim();
      const shouldSeedOrganisation =
        Boolean(onboardingOrganisation) &&
        spaceConfig.type !== 'personal' &&
        spaceConfig.type !== 'chief-of-staff';
      const spaceConfigWithOrganisation: CreateSpaceOptions = shouldSeedOrganisation
        ? { ...spaceConfig, organisation: onboardingOrganisation }
        : spaceConfig;

      // Create the space using the workspace API
      const result = await window.libraryApi.createSpace(spaceConfigWithOrganisation);
      
      if (result.success && result.space) {
        // Add the space to the connected spaces list
        addConnectedSpace(result.space);
        // Refresh from workspace to ensure consistency
        await refreshConnectedSpaces();
        setShowAddSpaceWizard(false);
      } else {
        // Close wizard on error so user can see the error message at step level
        setShowAddSpaceWizard(false);
        setGoogleDriveError(result.error ?? "Couldn't create that space");
      }
    } catch (error) {
      setShowAddSpaceWizard(false);
      setGoogleDriveError(error instanceof Error ? error.message : "Couldn't create that space");
    } finally {
      setIsCreatingSpace(false);
    }
  }, [companyName, draftSettings?.companyName, setGoogleDriveError, addConnectedSpace, refreshConnectedSpaces]);

  // Handler to remove a connected space
  const handleRemoveSpace = useCallback(async (space: SpaceInfo) => {
    setGoogleDriveError(null);
    try {
      // Use proper space removal API (removes symlink but keeps original folder)
      const result = await window.libraryApi.removeSpace({ spacePath: space.path, removeSymlinkOnly: true });
      if (!result.success) {
        setGoogleDriveError(result.error ?? "Couldn't remove that space");
        return;
      }

      if (draftSettings?.coreDirectory) {
        invalidateSpaces(draftSettings.coreDirectory);
      }
      // Update local state
      removeConnectedSpace(space.path);
    } catch (error) {
      setGoogleDriveError(error instanceof Error ? error.message : "Couldn't remove that space");
    }
  }, [draftSettings?.coreDirectory, removeConnectedSpace, setGoogleDriveError]);

  type CloudProviderKey = 'googleDrive' | 'oneDrive' | 'dropbox';

  const getCloudProviderForSpace = (space: SpaceInfo): CloudProviderKey | null => {
    if (!space.isSymlink) return null;
    const sourcePathLower = space.sourcePath?.toLowerCase();
    if (!sourcePathLower) return null;

    // Heuristic matching: these are best-effort since paths vary by OS / install.
    if (sourcePathLower.includes('googledrive') || sourcePathLower.includes('google drive')) return 'googleDrive';
    if (sourcePathLower.includes('onedrive')) return 'oneDrive';
    if (sourcePathLower.includes('dropbox')) return 'dropbox';
    return null;
  };

  const getProviderOfflineActionLabel = (provider: CloudProviderKey) => {
    switch (provider) {
      case 'googleDrive':
        return 'Make available offline';
      case 'oneDrive':
        return 'Always keep on this device';
      case 'dropbox':
        return 'Make available offline';
    }
  };

  const cloudSpacesByProvider = connectedSpaces.reduce((acc, space) => {
    const provider = getCloudProviderForSpace(space);
    if (!provider) return acc;
    const existing = acc.get(provider) ?? [];
    existing.push(space);
    acc.set(provider, existing);
    return acc;
  }, new Map<CloudProviderKey, SpaceInfo[]>());

  return (
    <div className={styles.stepBody}>
      <div className={styles.stepTitleGroup}>
        <h2>Spaces</h2>
        <p className={styles.stepDescription}>
          Spaces are your working folders — documents, projects, notes — organized by context. Rebel searches these spaces to find relevant files and saves new content where it belongs.
        </p>
      </div>

      {/* Dynamic badge numbering: only count visible sections */}
      {(() => {
        let badge = 1;
        const showCompanyName = !orgCompanyDisplayName;
        const showCloudStorage = !hideCloudStorage;
        const showChooseSpacesHeader = !hideChooseSpaces;

        const companyNameBadge = showCompanyName ? badge++ : 0;
        const cloudStorageBadge = showCloudStorage ? badge++ : 0;
        const chooseSpacesBadge = showChooseSpacesHeader ? badge++ : 0;
        const offlineBadge = badge; // always shown

        return (
          <>
            {/* Section: Company name — hidden when org config provides it */}
            {showCompanyName && (
              <>
                <div className={styles.stepSectionHeader}>
                  <div className={styles.stepBadge}>{companyNameBadge}</div>
                  <div className={styles.stepHeaderText}>
                    <h3>Company name <span className={styles.optionalLabel}>(optional)</span></h3>
                    <p>We use this to group your work spaces. You can change it later in Settings.</p>
                  </div>
                </div>
                <div className={`${styles.fieldGroup} ${styles.narrowField} ${styles.tightToHeader}`}>
                  <div className={styles.fieldRow}>
                    <input
                      id="onboarding-company-name"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      placeholder="e.g., Acme Corp"
                      aria-label="Company name"
                    />
                  </div>
                </div>
                <div className={styles.stepDivider} />
              </>
            )}

            {/* Section: Cloud storage — hidden when org provider is set and detected running */}
            {showCloudStorage && (
              <>
                <div className={styles.stepSectionHeader}>
                  <div className={styles.stepBadge}>{cloudStorageBadge}</div>
                  <div className={styles.stepHeaderText}>
                    <h3>Cloud storage <span className={styles.optionalLabel}>(optional)</span></h3>
                    <p>Connect your cloud storage to access synced folders. Pick the one you use — you don't need all of them.</p>
                  </div>
                </div>
                <div className={styles.cloudStorageGrid}>
                  <CloudStorageButton
                    name="Google Drive"
                    downloadUrl={GOOGLE_DRIVE_DOWNLOAD_URL}
                    status={googleDriveStatus}
                    onBypass={() => setGoogleDriveBypass(true)}
                  />
                  <CloudStorageButton
                    name="OneDrive"
                    downloadUrl={ONEDRIVE_DOWNLOAD_URL}
                    status={oneDriveStatus}
                    onBypass={() => setOneDriveBypass(true)}
                  />
                  <CloudStorageButton
                    name="Dropbox"
                    downloadUrl={DROPBOX_DOWNLOAD_URL}
                    status={dropboxStatus}
                    onBypass={() => setDropboxBypass(true)}
                  />
                </div>
                <div className={styles.stepDivider} />
              </>
            )}

            {/* Section: Choose spaces — when org config defines spaces, show read-only
                confirmation copy instead of the interactive header/button */}
            {showChooseSpacesHeader ? (
              <div className={styles.stepSectionHeaderWithCta}>
                <div className={styles.stepBadge}>{chooseSpacesBadge}</div>
                <div className={styles.stepHeaderText}>
                  <h3>Choose spaces</h3>
                  <p>Select folders where you do your work — project folders, document libraries, note collections. Rebel will search these for context and save memories here.</p>
                </div>
                <div className={styles.stepCtaRight}>
                  <Tooltip content={canCreateAdditionalSpaces ? undefined : 'Teams license required to add spaces. To get Rebel for your team, contact us at hello@mindstone.com'}>
                    <span style={{ display: 'inline-flex' }}>
                      <Button
                        variant="outline"
                        onClick={() => setShowAddSpaceWizard(true)}
                        disabled={isCreatingSpace || !canCreateAdditionalSpaces}
                      >
                        <FolderPlus size={16} style={{ marginRight: '0.5rem' }} />
                        Add space
                      </Button>
                    </span>
                  </Tooltip>
                </div>
              </div>
            ) : (
              <div className={styles.stepSectionHeader}>
                <div className={styles.stepHeaderText}>
                  <h3>{connectedSpaces.length === 1 ? 'Shared space' : 'Shared spaces'}</h3>
                  <p>Set up by your organisation. Rebel searches {connectedSpaces.length === 1 ? 'this' : 'these'} for relevant files and saves new content where it belongs.</p>
                </div>
              </div>
            )}
            {connectedSpaces.length > 0 && (
              <div className={styles.spaceChipsRow}>
                {connectedSpaces.map((space) => (
                  <Tooltip key={space.path} content={space.sourcePath || space.absolutePath}>
                    <div className={styles.spaceChip}>
                      <span className={styles.spaceChipCheck}>✓</span>
                      <span>{space.name}</span>
                      {!hideChooseSpaces && (
                        <button
                          type="button"
                          onClick={() => void handleRemoveSpace(space)}
                          className={styles.spaceChipRemove}
                          aria-label={`Remove ${space.name}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </Tooltip>
                ))}
              </div>
            )}

            {googleDriveError && <p className={styles.validationText}>{googleDriveError}</p>}

            {/* Section: Offline sync guidance — always shown when cloud-synced spaces exist */}
            {(() => {
              const allCloudSpaces = [...cloudSpacesByProvider.values()].flat();
              if (allCloudSpaces.length === 0) return null;

              const foldersByParent = new Map<string, string[]>();
              for (const space of allCloudSpaces) {
                if (space.sourcePath) {
                  const parentPath = dirname(space.sourcePath);
                  const existing = foldersByParent.get(parentPath) || [];
                  existing.push(space.name);
                  foldersByParent.set(parentPath, existing);
                }
              }

              const folderNamesList = allCloudSpaces.map((s) => s.name);
              const foldersText = folderNamesList.length === 1
                ? <strong>{folderNamesList[0]}</strong>
                : folderNamesList.map((name, i) => (
                  <span key={name}>
                    {i > 0 && (i === folderNamesList.length - 1 ? ' and ' : ', ')}
                    <strong>{name}</strong>
                  </span>
                ));

              const providers = [...cloudSpacesByProvider.keys()];
              const singleProvider = providers.length === 1 ? providers[0] : null;
              const offlineActionLabel = singleProvider
                ? getProviderOfflineActionLabel(singleProvider)
                : 'Make available offline';

              return (
                <>
                  <div className={styles.stepDivider} />
                  <div className={styles.stepSectionHeader}>
                    <div className={styles.stepBadge}>{offlineBadge}</div>
                    <div className={styles.stepHeaderText}>
                      <h3>
                        Make folders available offline
                        {' '}
                        <Tooltip content="If these folders aren't available offline, Rebel will struggle to access them and it may cause performance issues.">
                          <Info size={14} style={{ display: 'inline', verticalAlign: 'middle', opacity: 0.5, cursor: 'help' }} />
                        </Tooltip>
                      </h3>
                      <p>
                        Rebel needs these folders synced to your computer. Do this for {foldersText}:
                      </p>
                    </div>
                  </div>
            <div className={styles.offlineGuidanceLayout}>
              <div className={styles.offlineGuidanceScreenshot}>
                <img
                  src={makeOfflineScreenshot}
                  alt="Right-click context menu showing 'Make available offline' option"
                />
              </div>
              <div className={styles.offlineGuidanceContent}>
                <ol className={styles.offlineSteps}>
                  <li>
                    {[...foldersByParent.entries()].map(([parentPath, folderNames]) => (
                      <Tooltip key={parentPath} content={parentPath}>
                        <Button
                          variant="outline"
                          onClick={() => void window.appApi.openPath(parentPath)}
                          style={{ gap: '0.5rem' }}
                        >
                          <FolderOpen size={16} />
                          <span>
                            Open folder containing{' '}
                            {folderNames.map((name, i) => (
                              <span key={name}>
                                {i > 0 && (i === folderNames.length - 1 ? ' and ' : ', ')}
                                <strong>{name}</strong>
                              </span>
                            ))}
                          </span>
                        </Button>
                      </Tooltip>
                    ))}
                  </li>
                  <li><strong>Find</strong> {foldersText}</li>
                  <li>
                    <strong>Right-click</strong> {allCloudSpaces.length === 1 ? 'it' : 'each one'} and choose{' '}
                    <strong>{offlineActionLabel}</strong>
                  </li>
                </ol>
              </div>
            </div>
          </>
        );
      })()}
          </>
        );
      })()}

      {/* Add Space Wizard dialog */}
      <AddSpaceWizard
        open={showAddSpaceWizard}
        onOpenChange={setShowAddSpaceWizard}
        onComplete={handleAddSpaceWizardComplete}
        onCancel={() => setShowAddSpaceWizard(false)}
        mode="create"
        defaultCompanyName={companyName || draftSettings?.companyName || undefined}
        defaultUserEmail={currentUserEmail}
      />
    </div>
  );
};
