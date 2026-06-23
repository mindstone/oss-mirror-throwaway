import { useCallback, useMemo, useRef, useState } from 'react';
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
import { ChevronLeft } from 'lucide-react';
import type { CustomProvider, ModelProfile, ProviderKeys } from '@shared/types';
import {
  findExistingManagedProfile,
  materializeCatalogProfile,
  type ConnectorCatalogEntry,
} from '@shared/utils/catalogMaterialization';
import type { WizardActions, WizardState, WizardViewState } from './useProfileWizard';
import {
  catalogEntryKey,
  ChoosePathStep,
  type CatalogProviderConnections,
} from './steps/ChoosePathStep';
import { ProviderStep } from './steps/ProviderStep';
import { ModelStep } from './steps/ModelStep';
import { ConfigureStep } from './steps/ConfigureStep';
import type { TestResult, TestStateEntry } from './useProfileTester';
import styles from './ProfileWizardDialog.module.css';

export interface ProfileWizardDialogProps {
  view: WizardViewState;
  actions: WizardActions;
  customProviders?: CustomProvider[];
  providerKeys?: ProviderKeys;
  openRouterConnected: boolean;
  connectorCatalogEntries: readonly ConnectorCatalogEntry[];
  existingProfiles: readonly ModelProfile[];
  getLatestProfilesSnapshot: () => readonly ModelProfile[] | Promise<readonly ModelProfile[]>;
  providerConnections?: CatalogProviderConnections;
  /** Managed allowed model IDs for the "Included with your Mindstone plan" group. */
  managedAllowedModels?: readonly string[];
  /** Whether the active provider is Mindstone. */
  isMindstoneActive?: boolean;
  /**
   * Keyed map of all in-flight test state. The wizard reads its own entry via
   * `view.state.testKey` (a unique per-open key to avoid cross-session bleed).
   */
  testState?: Record<string, TestStateEntry>;
  runTest: (
    key: string,
    params: {
      serverUrl: string;
      model?: string;
      apiKey?: string;
      providerType?: string;
      customProviderId?: string;
    },
  ) => Promise<TestResult>;
  /** Called with the fully-built profile on Save. Parent applies reset-guard + persists. */
  onSave: (profile: ModelProfile, mode: 'add' | 'edit') => Promise<void> | void;
  /** Called when an add attempt discovers the catalog profile already exists. */
  onCatalogEntryAlreadyOnTeam: (existingId: string) => void;
  /** Called when a connection-managed profile should be removed from the team. */
  onDelete: (profile: ModelProfile) => Promise<void> | void;
}

function dialogTitleFor(state: WizardState | null): string {
  if (!state) return 'Add a model';
  if (state.mode === 'edit') return 'Edit model profile';
  switch (state.step) {
    case 'choose-path':
      return 'Add a model';
    case 'provider':
      return 'Pick a provider';
    case 'model':
      return 'Pick a model';
    case 'configure':
      return 'Configure model';
    default:
      return 'Add a model';
  }
}

function dialogDescriptionFor(state: WizardState | null): string | null {
  if (!state || state.mode === 'edit') return null;
  if (state.step !== 'choose-path') return null;
  return 'Choose a model from a connected provider, or add one manually if it is not listed.';
}

export const ProfileWizardDialog = ({
  view,
  actions,
  customProviders,
  openRouterConnected,
  connectorCatalogEntries,
  existingProfiles,
  getLatestProfilesSnapshot,
  providerConnections,
  managedAllowedModels,
  isMindstoneActive,
  testState,
  runTest,
  onSave,
  onCatalogEntryAlreadyOnTeam,
  onDelete,
}: ProfileWizardDialogProps) => {
  const { state, canSave, busy: hookBusy } = view;
  const [busyEntryKey, setBusyEntryKey] = useState<string | null>(null);
  const busyEntryKeyRef = useRef<string | null>(null);
  const isOpen = state !== null;
  const dialogDescription = dialogDescriptionFor(state);
  const testKey = state?.testKey ?? '';
  const wizardTestEntry = testState && testKey ? testState[testKey] : undefined;
  // Expand `busy` to also cover the inline "Test now" action so Escape /
  // outside-click don't dismiss the wizard mid-test.
  const busy = busyEntryKey !== null || hookBusy || Boolean(wizardTestEntry?.testing);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && !busy) actions.close();
    },
    [actions, busy],
  );

  const handleSave = useCallback(async () => {
    if (!state || state.step !== 'configure') return;
    if (!canSave) return;
    const profile = actions.buildProfile();
    if (!profile) return;
    actions.setSaving(true);
    actions.setSaveError(null);
    try {
      await onSave(profile, state.mode);
      actions.close();
    } catch (error) {
      actions.setSaving(false);
      const message = error instanceof Error ? error.message : 'Unknown error.';
      actions.setSaveError(message);
    }
  }, [state, canSave, actions, onSave]);

  const handleAddCatalogEntry = useCallback(
    async (entry: ConnectorCatalogEntry) => {
      const entryKey = catalogEntryKey(entry);
      if (busyEntryKeyRef.current) return;
      busyEntryKeyRef.current = entryKey;
      setBusyEntryKey(entryKey);
      try {
        const latestProfiles = await getLatestProfilesSnapshot();
        const existing = findExistingManagedProfile(latestProfiles, entry);
        if (existing) {
          onCatalogEntryAlreadyOnTeam(existing.id);
          actions.close();
          return;
        }
        const profile = materializeCatalogProfile(entry, undefined, latestProfiles);
        await onSave(profile, 'add');
        actions.close();
      } finally {
        busyEntryKeyRef.current = null;
        setBusyEntryKey(null);
      }
    },
    [actions, getLatestProfilesSnapshot, onCatalogEntryAlreadyOnTeam, onSave],
  );

  const handleRemoveFromTeam = useCallback(
    async (profile: ModelProfile) => {
      await onDelete(profile);
    },
    [onDelete],
  );

  // `useMemo` narrows to the step for clean conditional rendering.
  const body = useMemo(() => {
    if (!state) return null;

    switch (state.step) {
      case 'choose-path':
        return (
          <ChoosePathStep
            onAddCatalogEntry={handleAddCatalogEntry}
            onSelectCustom={actions.selectCustomPath}
            connectorCatalogEntries={connectorCatalogEntries}
            existingProfiles={existingProfiles}
            onRemoveFromTeam={handleRemoveFromTeam}
            providerConnections={providerConnections}
            busyEntryKey={busyEntryKey}
            managedAllowedModels={managedAllowedModels}
            isMindstoneActive={isMindstoneActive}
          />
        );
      case 'provider':
        return (
          <ProviderStep
            customProviders={customProviders}
            openRouterConnected={openRouterConnected}
            orphanedCustomProvider={state.orphanedCustomProvider}
            onSelect={actions.selectProvider}
          />
        );
      case 'model':
        return (
          <ModelStep
            providerType={state.providerType}
            customProvider={state.customProvider}
            rolePreference={state.rolePreference}
            onSelectModel={actions.selectModel}
            onSelectTypeManually={actions.selectTypeManually}
          />
        );
      case 'configure':
        return (
          <ConfigureStep
            state={state}
            actions={actions}
            canSave={canSave}
            testKey={testKey}
            testState={wizardTestEntry}
            runTest={runTest}
          />
        );
      default:
        return null;
    }
  }, [
    state,
    handleAddCatalogEntry,
    actions,
    connectorCatalogEntries,
    existingProfiles,
    handleRemoveFromTeam,
    providerConnections,
    busyEntryKey,
    managedAllowedModels,
    isMindstoneActive,
    customProviders,
    openRouterConnected,
    canSave,
    testKey,
    wizardTestEntry,
    runTest,
  ]);

  // Footer is step-dependent.
  const footer = useMemo(() => {
    if (!state) return null;

    if (state.step === 'choose-path') {
      return (
        <Button
          variant="ghost"
          size="sm"
          onClick={actions.close}
          disabled={busy}
          data-testid="settings-models-wizard-cancel-button"
        >
          Cancel
        </Button>
      );
    }

    if (state.step === 'provider') {
      return (
        <>
          {state.mode === 'add' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={actions.backToChoosePath}
              data-testid="settings-models-wizard-back-button"
            >
              <ChevronLeft size={14} aria-hidden="true" />
              Back
            </Button>
          )}
          <div style={{ flex: 1 }} />
          <Button
            variant="ghost"
            size="sm"
            onClick={actions.close}
            disabled={busy}
            data-testid="settings-models-wizard-cancel-button"
          >
            Cancel
          </Button>
        </>
      );
    }

    if (state.step === 'model') {
      return (
        <>
          {state.mode === 'add' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={actions.backToProvider}
              data-testid="settings-models-wizard-back-button"
            >
              <ChevronLeft size={14} aria-hidden="true" />
              Back
            </Button>
          )}
          <div style={{ flex: 1 }} />
          <Button
            variant="ghost"
            size="sm"
            onClick={actions.close}
            disabled={busy}
            data-testid="settings-models-wizard-cancel-button"
          >
            Cancel
          </Button>
        </>
      );
    }

    // configure step
    return (
      <>
        {state.mode === 'add' && canGoBackFromConfigure(state) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={actions.backToModel}
            data-testid="settings-models-wizard-back-button"
          >
            <ChevronLeft size={14} aria-hidden="true" />
            Back
          </Button>
        )}
        <div style={{ flex: 1 }} />
        <Button
          variant="ghost"
          size="sm"
          onClick={actions.close}
          disabled={busy || state.saving}
          data-testid="settings-models-wizard-cancel-button"
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => void handleSave()}
          disabled={!canSave || state.saving}
          data-testid="settings-models-wizard-save-button"
        >
          {state.saving ? 'Saving…' : state.mode === 'add' ? 'Add' : 'Save'}
        </Button>
      </>
    );
  }, [state, actions, canSave, handleSave, busy]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={handleOpenChange}
      disableOutsideClose={busy}
      disableEscapeClose={busy}
    >
      <DialogContent size="lg" className={styles.dialogContent} data-testid="settings-models-wizard-dialog">
        <DialogHeader onClose={actions.close} closeDisabled={busy}>
          <DialogTitle>{dialogTitleFor(state)}</DialogTitle>
          {dialogDescription && (
            <DialogDescription>{dialogDescription}</DialogDescription>
          )}
        </DialogHeader>
        <DialogBody>{body}</DialogBody>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
};

function canGoBackFromConfigure(state: WizardState & { step: 'configure' }): boolean {
  // Only offer "Back to model" when we actually came from a preset model step.
  if (state.customProvider) return false;
  if (state.providerType === 'other') return false;
  // Can't test here without pulling presets in — the hook's own `backToModel`
  // guards against no-preset providers, so a UX-level mis-press just no-ops.
  return true;
}
