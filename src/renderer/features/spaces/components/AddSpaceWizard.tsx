/**
 * AddSpaceWizard Component
 *
 * A streamlined dialog for adding new spaces to the workspace.
 * - In create mode: Opens folder picker immediately, then shows configuration
 * - In edit/add-existing modes: Shows configuration form directly
 *
 * Used by both Settings (SpacesManager) and potentially Onboarding in the future.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  Button,
} from '@renderer/components/ui';
import { invalidateSpaces } from '@renderer/hooks/useSpacesData';
import type { SpaceInfo, CreateSpaceOptions, SpaceType, InferredCategory } from '@shared/ipc/schemas/library';
import { useSpaceWizardState } from '../hooks/useSpaceWizardState';
import { AboutStep } from './AboutStep';
import styles from './AddSpaceWizard.module.css';

export interface AddSpaceWizardProps {
  /** Whether the wizard dialog is open */
  open: boolean;
  /** Callback to change open state */
  onOpenChange: (open: boolean) => void;
  /** Called when user completes the wizard with final space configuration */
  onComplete: (spaceConfig: CreateSpaceOptions) => void;
  /** Called when user cancels the wizard */
  onCancel: () => void;
  /** Mode: 'create' for new space, 'edit' for existing, 'add-existing' for adding discovered space */
  mode?: 'create' | 'edit' | 'add-existing';
  /**
   * Existing space data - used by both 'edit' and 'add-existing' modes.
   * - edit mode: Updates frontmatter of existing tracked space
   * - add-existing mode: Pre-populates form for discovered (untracked) space, returns config on complete
   */
  existingSpace?: SpaceInfo;
  /** Pre-populated company name (from settings) */
  defaultCompanyName?: string;
  /** Current user's email for local associated-account defaults */
  defaultUserEmail?: string | null;
}

// Step indicator removed - we now skip directly to folder picker then show config

/**
 * Converts wizard category back to space type for saving.
 * This is the reverse of typeToCategory() in useSpaceWizardState.ts.
 *
 * Note: This mapping is lossy in the reverse direction:
 * - work → company (even if original was team/project)
 * - unknown → other (even if original was something else)
 *
 * This is acceptable as Phase 2 plans simplify to fewer types anyway.
 */
const categoryToType = (category: InferredCategory): SpaceType => {
  if (category === 'personal') return 'personal';
  if (category === 'work') return 'company';
  return 'other';
};

const invalidateCurrentWorkspaceSpaces = async (): Promise<void> => {
  try {
    const settings = await window.settingsApi.get();
    const coreDirectory = settings?.coreDirectory?.trim();
    if (coreDirectory) {
      invalidateSpaces(coreDirectory);
    }
  } catch {
    // Settings lookup failure should not block the already-successful edit flow.
  }
};

const saveLocalAssociatedAccounts = async (
  space: SpaceInfo,
  associatedAccounts: string[]
): Promise<void> => {
  const result = await window.libraryApi.updateSpaceAssociatedAccounts({
    spacePath: space.path,
    associatedAccounts,
  });
  if (!result.success) {
    throw new Error(result.error ?? 'Failed to update associated accounts.');
  }
};

/**
 * AddSpaceWizard - Main wizard dialog component.
 *
 * @example
 * <AddSpaceWizard
 *   open={isOpen}
 *   onOpenChange={setIsOpen}
 *   onComplete={(config) => createSpace(config)}
 *   onCancel={() => setIsOpen(false)}
 * />
 */
export const AddSpaceWizard = ({
  open,
  onOpenChange,
  onComplete,
  onCancel,
  mode = 'create',
  existingSpace,
  defaultCompanyName,
  defaultUserEmail,
}: AddSpaceWizardProps) => {
  const { state, actions, effectiveMode } = useSpaceWizardState(
    existingSpace ? { existingSpace, mode, defaultUserEmail } : { mode, defaultUserEmail }
  );

  // Track whether user has unlocked shared metadata editing in add-existing mode
  const [sharedMetadataUnlocked, setSharedMetadataUnlocked] = useState(false);

  // Track previous open state to detect open transitions
  const wasOpenRef = useRef(false);
  
  // Track if we're waiting for folder picker (to show loading state or hide dialog content)
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Handler for opening native folder picker - defined early so useEffect can reference it
  const handlePathSelect = useCallback(async (): Promise<boolean> => {
    setIsPickingFolder(true);
    try {
      // Default to workspace directory (coreDirectory) so user starts in the right place
      let defaultPath: string | undefined;
      try {
        const settings = await window.settingsApi.get();
        // Only use coreDirectory if it's a non-empty string
        defaultPath = settings?.coreDirectory?.trim() || undefined;
      } catch {
        // Settings fetch failed - proceed without default path
      }
      const path = await window.settingsApi.chooseDirectory({ defaultPath });
      if (path) {
        await actions.setPath(path);
        // Auto-advance to about step after successful selection
        actions.setStep('about');
        setIsPickingFolder(false);
        return true;
      }
      // User cancelled folder picker
      setIsPickingFolder(false);
      return false;
    } catch (error) {
      console.error('Failed to choose directory:', error);
      setIsPickingFolder(false);
      return false;
    }
  }, [actions]);

  // Reset state on dialog open transition (not close) to avoid race condition
  // where delayed close-reset gets cancelled by rapid reopen, leaving stale state.
  // We reset on the false→true transition to guarantee fresh state every time.
  // In create mode, we also auto-trigger the folder picker immediately.
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;

    if (justOpened) {
      setSubmitError(null);
      // Only reset for create mode without existing space (edit/add-existing need their state)
      if (mode === 'create' && !existingSpace) {
        actions.reset();
        setSharedMetadataUnlocked(false);
        // Auto-trigger folder picker immediately in create mode
        // If user cancels, close the dialog
        void handlePathSelect().then((selected) => {
          if (!selected) {
            onCancel();
          }
        });
      }
    }
    // Depend on stable callbacks, not the entire actions object
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting the actions object; individual stable callbacks are listed to avoid reset loops
  }, [open, mode, existingSpace, actions.reset, handlePathSelect, onCancel]);

  // Pre-populate company name from settings
  useEffect(() => {
    if (defaultCompanyName && !state.companyName) {
      actions.updateField('companyName', defaultCompanyName);
    }
  }, [defaultCompanyName, state.companyName, actions]);

  // Auto-generate description when entering About step with a path (one-shot only)
  // We check hasTriedAutoDescription to prevent re-generation if user clears the field
  useEffect(() => {
    if (
      state.step === 'about' &&
      state.path &&
      !state.description &&
      !state.descriptionLoading &&
      !state.hasTriedAutoDescription
    ) {
      void actions.generateDescription();
    }
  }, [state.step, state.path, state.description, state.descriptionLoading, state.hasTriedAutoDescription, actions]);

  const canComplete = useMemo(() => {
    return Boolean(state.name.trim()) && !state.hasEmailErrors;
  }, [state.name, state.hasEmailErrors]);

  // Handler to change folder (in case user wants to pick a different one)
  const handleChangeFolder = useCallback(async () => {
    const selected = await handlePathSelect();
    if (!selected) {
      // User cancelled - stay on current folder
    }
  }, [handlePathSelect]);

  const handleComplete = useCallback(async () => {
    if (!canComplete || !state.path) return;
    setSubmitError(null);

    // Edit mode: update existing space via frontmatter
    if (effectiveMode === 'edit' && existingSpace) {
      try {
        const organisation = state.organisation.trim();
        const result = await window.libraryApi.updateSpaceFrontmatter({
          // IMPORTANT: use workspace-relative path (existingSpace.path), not absolutePath
          // The IPC handler joins coreDirectory + spacePath
          spacePath: existingSpace.path,
          updates: {
            rebel_space_description: state.description.trim() || undefined,
            space_type: categoryToType(state.category),
            sharing: state.sharing,
            organisation_name: organisation || undefined,
          },
        });
        if (!result.success) {
          setSubmitError(result.error ?? "Couldn't update that space");
          return;
        }
        await saveLocalAssociatedAccounts(existingSpace, state.emails);

        await invalidateCurrentWorkspaceSpaces();
        // Build a minimal CreateSpaceOptions-like object for onComplete callback
        // The caller uses this to refresh the spaces list
        onComplete({
          name: state.name,
          type: categoryToType(state.category),
          location: existingSpace.isSymlink ? 'symlink' : 'workspace',
          sourcePath: existingSpace.sourcePath,
          description: state.description.trim() || undefined,
          sharing: state.sharing,
          organisation: organisation || undefined,
          associatedAccounts: state.emails,
        });
        return;
      } catch (error) {
        console.error('Failed to update space:', error);
        setSubmitError(error instanceof Error ? error.message : "Couldn't update that space");
        return;
      }
    }

    // Add-existing mode (detected via frontmatter during folder selection):
    // - Create symlink for external folders (same as create mode)
    // - Track in user's spaces list
    // - Skip frontmatter write UNLESS user explicitly unlocked editing
    if (effectiveMode === 'add-existing') {
      // Only skip frontmatter write if user hasn't unlocked editing
      const shouldSkipFrontmatter = !sharedMetadataUnlocked;

      // For add-existing mode triggered by existingSpace prop (from suggest-spaces)
      if (existingSpace) {
        const organisation = state.organisation.trim();
        onComplete({
          name: state.name.trim(),
          type: categoryToType(state.category),
          location: existingSpace.isSymlink ? 'symlink' : 'workspace',
          targetPath: existingSpace.path, // workspace-relative path of existing folder
          sourcePath: existingSpace.isSymlink ? existingSpace.sourcePath : undefined,
          description: state.description.trim() || undefined,
          organisation: organisation || undefined,
          sharing: state.sharing,
          createSubfolders: false, // Existing space already has its structure
          skipFrontmatterWrite: shouldSkipFrontmatter,
          associatedAccounts: state.emails,
        });
        return;
      }

      // For add-existing mode detected via frontmatter during create flow
      // (user selected a folder that already has README with frontmatter)
      const needsSymlink = !state.isInsideWorkspace;
      const organisation = state.organisation.trim();
      onComplete({
        name: state.name.trim(),
        type: categoryToType(state.category),
        location: needsSymlink ? 'symlink' : 'workspace',
        sourcePath: needsSymlink ? state.path : undefined,
        targetPath: state.isInsideWorkspace ? state.workspaceRelativePath ?? undefined : undefined,
        description: state.description.trim() || undefined,
        organisation: organisation || undefined,
        sharing: state.sharing,
        createSubfolders: false, // Existing space already has its structure
        skipFrontmatterWrite: shouldSkipFrontmatter,
        associatedAccounts: state.emails,
      });
      return;
    }

    // Create mode: existing logic
    // Determine if this needs to be a symlink (external folder) or direct workspace path
    // External folders (outside workspace) must be symlinked to be discoverable by scanSpaces()
    const needsSymlink = !state.isInsideWorkspace;
    const organisation = state.organisation.trim();

    // Build CreateSpaceOptions from state
    const spaceConfig: CreateSpaceOptions = {
      name: state.name.trim(),
      type: categoryToType(state.category),
      // External paths need symlink mode; internal paths use workspace mode
      location: needsSymlink ? 'symlink' : 'workspace',
      // For symlinks: sourcePath is the external folder, targetPath computed by createSpace based on type
      sourcePath: needsSymlink ? state.path : undefined,
      // For internal paths: use the workspace-relative path so we modify the selected folder
      // For external paths: let createSpace compute the target based on type
      targetPath: state.isInsideWorkspace ? state.workspaceRelativePath ?? undefined : undefined,
      companyName: state.category === 'work' ? state.companyName || undefined : undefined,
      organisation: organisation || undefined,
      sharing: state.sharing,
      storageProvider: state.storageProvider,
      description: state.description.trim() || undefined,
      createSubfolders: state.createSubfolders,
      selectedSubfolders: state.createSubfolders ? state.selectedSubfolders : undefined,
      associatedAccounts: state.emails,
    };

    onComplete(spaceConfig);
  }, [canComplete, state, effectiveMode, existingSpace, onComplete, sharedMetadataUnlocked]);

  const handleCancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  // Dialog title and description based on effectiveMode (which may differ from mode prop)
  // effectiveMode becomes 'add-existing' when frontmatter is detected in 'create' mode
  const dialogTitle = useMemo(() => {
    if (effectiveMode === 'edit') return 'Edit Space';
    if (effectiveMode === 'add-existing') return 'Add Existing Space';
    return 'Add Space';
  }, [effectiveMode]);

  const dialogDescription = useMemo(() => {
    if (effectiveMode === 'edit') return 'Update space metadata and settings.';
    if (effectiveMode === 'add-existing') return 'Review and add this space to your workspace.';
    return 'Add a folder so Rebel can use its files as context and save memories there.';
  }, [effectiveMode]);

  // Don't render dialog content while folder picker is open (in create mode)
  // This prevents showing an empty dialog behind the folder picker
  if (isPickingFolder && mode === 'create' && !existingSpace) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent size="md" className={styles.wizardDialog}>
          <DialogHeader onClose={handleCancel}>
            <DialogTitle>Add Space</DialogTitle>
            <DialogDescription>Selecting folder...</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" className={styles.wizardDialog}>
        <DialogHeader onClose={handleCancel}>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>

        <DialogBody className={styles.wizardBody}>
          <AboutStep
            name={state.name}
            path={state.path}
            description={state.description}
            descriptionSource={state.descriptionSource}
            descriptionLoading={state.descriptionLoading}
            storageProvider={state.storageProvider}
            sharing={state.sharing}
            category={state.category}
            organisation={state.organisation}
            onNameChange={(name) => actions.updateField('name', name)}
            onDescriptionChange={(desc) => actions.updateField('description', desc)}
            onRegenerateDescription={actions.generateDescription}
            onSharingChange={(sharing) => actions.updateField('sharing', sharing)}
            onCategoryChange={(category) => actions.updateField('category', category)}
            onOrganisationChange={(organisation) => actions.updateField('organisation', organisation)}
            isEditMode={effectiveMode === 'edit'}
            isAddExistingMode={effectiveMode === 'add-existing'}
            sharedMetadataUnlocked={sharedMetadataUnlocked}
            onUnlockSharedMetadata={() => setSharedMetadataUnlocked(true)}
            absolutePath={existingSpace?.absolutePath ?? state.path ?? undefined}
            emails={state.emails}
            onEmailsChange={(emails) => actions.updateField('emails', emails)}
            onEmailErrorsChange={(hasErrors) => actions.updateField('hasEmailErrors', hasErrors)}
            onChangeFolder={mode === 'create' ? handleChangeFolder : undefined}
          />
          {submitError && (
            <div className={styles.pathError} role="alert" aria-live="polite">
              {submitError}
            </div>
          )}
        </DialogBody>

        <DialogFooter className={styles.wizardFooter}>
          {/* Spacer to push buttons right */}
          <div className={styles.footerSpacer} />

          {/* Cancel button */}
          <Button variant="ghost" onClick={handleCancel}>
            Cancel
          </Button>

          {/* Complete button */}
          <Button onClick={handleComplete} disabled={!canComplete}>
            {effectiveMode === 'edit' ? 'Save Changes' : effectiveMode === 'add-existing' ? 'Add Space' : 'Create Space'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
