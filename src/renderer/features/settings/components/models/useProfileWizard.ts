import { useCallback, useMemo, useState } from 'react';
import type {
  CustomProvider,
  ModelProfile,
  ModelProviderType,
  ModelRoleTier,
  ProviderKeyId,
  ProviderKeys,
  ThinkingEffort,
} from '@shared/types';
import {
  PROVIDER_PRESETS,
  type LocalInferencePreset,
  type ModelOption,
} from '@shared/data/modelProviderPresets';
import { deriveProfileName } from './profileHelpers';

/**
 * useProfileWizard — state machine for the Add/Edit model-profile wizard.
 *
 * Discriminated union per step. Configure step nests form / key / validation
 * sub-state so reducers touch one slice at a time. `validationEpoch` bumps on
 * step transitions so stale in-flight validations (e.g. OpenAI key check) can
 * be ignored once the user moves on.
 *
 * See: `docs/plans/260424_model_profile_ui_redesign.md` Stage 1.
 */

/** Provider types eligible for the wizard (excludes 'anthropic' virtual profiles and 'local' — handled by LocalInferenceSection). */
export type WizardProviderType = Exclude<ModelProviderType, 'anthropic' | 'local'>;
/** The capability tier a newly-created profile is being set up for. Canonical type: {@link ModelRoleTier}. */
export type WizardRolePreference = ModelRoleTier;

export type WizardMode = 'add' | 'edit';
export type WizardStep = 'choose-path' | 'provider' | 'model' | 'configure';

interface WizardStateBase {
  mode: WizardMode;
  step: WizardStep;
  /** Optional role context used by role-targeted entry points (Thinking/Working/Fast). */
  rolePreference?: WizardRolePreference;
  /** Bumped whenever a transition invalidates an in-flight validation (typing key, step change). */
  validationEpoch: number;
  /** True when an edit-mode wizard opened at Provider step because the custom provider was deleted. */
  orphanedCustomProvider?: boolean;
  /** Populated in edit mode so the target profile id + preserved fields survive step transitions. */
  editingProfileId?: string;
  /** Original profile snapshot in edit mode — used to merge preserved fields on save. */
  originalProfile?: ModelProfile;
  /**
   * Unique per-open key used for the wizard's inline "Test now" action. Minted
   * on open() and carried through all step transitions until close(). Prevents
   * test results from a previous wizard session bleeding into a new one.
   */
  testKey: string;
}

export interface ProviderStepState extends WizardStateBase {
  step: 'provider';
}

export interface ChoosePathStepState extends WizardStateBase {
  step: 'choose-path';
}

export interface ModelStepState extends WizardStateBase {
  step: 'model';
  providerType: WizardProviderType;
  customProvider?: CustomProvider;
}

export interface ConfigureForm {
  name: string;
  reasoningEffort?: ThinkingEffort;
  councilEnabled: boolean;
  routingEligible: boolean;
  modelNotes: string;
  selectedModel?: ModelOption;
  customModelName?: string;
  serverUrl?: string;
  /** User-entered context window override (tokens). `null` clears the override. */
  contextWindow?: number | null;
  /** User-entered max output tokens override. `null` clears the override. */
  maxOutputTokens?: number | null;
  /**
   * Tracks whether the user has interacted with `contextWindow` during this
   * session. Drives provenance stamping in `buildProfile`: untouched fields
   * preserve the original profile's `contextWindowSource` (so editing other
   * fields on an auto-learned profile doesn't accidentally flip its provenance
   * to `'user'`).
   */
  contextWindowTouched?: boolean;
  /** Same semantics as `contextWindowTouched` for `maxOutputTokens`. */
  maxOutputTokensTouched?: boolean;
  /**
   * Set by `useLearnedContextWindow()`. When true, `buildProfile` re-stamps
   * `contextWindow` from `lastLearnedContextWindow` and flips source back to
   * `'auto'`. Cleared whenever the user touches the field after clicking
   * "Use learned value".
   */
  useLearnedRequested?: boolean;
}

export interface ConfigureKeyEntry {
  apiKey: string;
  usingSavedKey: boolean;
  showCustomKeyInput: boolean;
}

export interface ConfigureValidation {
  validating: boolean;
  validationOk: boolean | null;
  validationMessage: string | null;
  modelAccessible: boolean | null;
}

export interface ConfigureStepState extends WizardStateBase {
  step: 'configure';
  providerType: WizardProviderType;
  customProvider?: CustomProvider;
  presetKey?: string;
  draftProfileId?: string;
  form: ConfigureForm;
  key: ConfigureKeyEntry;
  validation: ConfigureValidation;
  /** Populated while the parent's onSave is running. */
  saving: boolean;
  /** Populated when parent's onSave threw — shown inline, state preserved. */
  saveError: string | null;
}

export type WizardState =
  | ChoosePathStepState
  | ProviderStepState
  | ModelStepState
  | ConfigureStepState;

export interface WizardOpenAddParams {
  mode: 'add';
  rolePreference?: WizardRolePreference;
}

export interface WizardOpenEditParams {
  mode: 'edit';
  profile: ModelProfile;
}

export type WizardOpenParams = WizardOpenAddParams | WizardOpenEditParams;

/** Return value from `open()` so callers can surface fail-closed refusals. */
export interface WizardOpenResult {
  opened: boolean;
  /** Populated when `opened === false`. Suitable for logging / error reporter. */
  reason?: string;
}

export interface UseProfileWizardOptions {
  providerKeys?: ProviderKeys;
  customProviders?: CustomProvider[];
}

export interface WizardViewState {
  state: WizardState | null;
  /** True when the current step can advance to the next (provider/model) or save (configure). */
  canProceed: boolean;
  /** True only in the configure step when all validation gates pass. */
  canSave: boolean;
  /** True while any transient state (validating / saving) would cause outside-close to be disruptive. */
  busy: boolean;
}

export interface WizardActions {
  /**
   * Opens the wizard. Returns `{ opened: boolean, reason? }` so callers can
   * observe fail-closed refusals (e.g. attempting to edit a companyManaged
   * profile).
   */
  open: (params: WizardOpenParams) => WizardOpenResult;
  close: () => void;
  selectCustomPath: () => void;
  selectProvider: (
    providerType: WizardProviderType,
    customProvider?: CustomProvider,
    localPreset?: LocalInferencePreset,
  ) => void;
  selectModel: (model: ModelOption) => void;
  selectTypeManually: () => void;
  backToChoosePath: () => void;
  backToProvider: () => void;
  backToModel: () => void;
  updateForm: (partial: Partial<ConfigureForm>) => void;
  updateKey: (partial: Partial<ConfigureKeyEntry>) => void;
  updateValidation: (partial: Partial<ConfigureValidation>) => void;
  resetValidation: () => void;
  setSaving: (saving: boolean) => void;
  setSaveError: (error: string | null) => void;
  /**
   * Reset the wizard's `contextWindow` field to the profile's auto-learned
   * value (if any) and re-stamp provenance back to `'auto'`. No-op when the
   * profile has no `lastLearnedContextWindow` to fall back to.
   */
  useLearnedContextWindow: () => void;
  /** Build the resulting ModelProfile from the current configure state. Returns null when state is not configure-step. */
  buildProfile: () => ModelProfile | null;
}

/** Default apiKey placeholder values for manual-entry mode. */
function buildInitialKeyState(
  providerType: WizardProviderType,
  customProvider: CustomProvider | undefined,
  providerKeys: ProviderKeys | undefined,
  profile?: ModelProfile,
): ConfigureKeyEntry {
  if (customProvider) {
    // Custom providers carry their own key inside the provider record — no
    // per-profile key entry.
    return { apiKey: '', usingSavedKey: false, showCustomKeyInput: false };
  }
  if (providerType === 'other') {
    const seeded = profile?.apiKey ?? '';
    return { apiKey: seeded, usingSavedKey: false, showCustomKeyInput: false };
  }
  const providerKeyId = providerType as ProviderKeyId;
  const savedKey = providerKeys?.[providerKeyId] ?? undefined;

  if (profile) {
    // Edit mode seeding.
    if (profile.apiKey && profile.apiKey.length > 0) {
      return {
        apiKey: profile.apiKey,
        usingSavedKey: false,
        showCustomKeyInput: true,
      };
    }
    if (savedKey) {
      return { apiKey: savedKey, usingSavedKey: true, showCustomKeyInput: false };
    }
    return { apiKey: '', usingSavedKey: false, showCustomKeyInput: false };
  }

  // Add mode default: prefer saved key when one exists.
  if (savedKey) {
    return { apiKey: savedKey, usingSavedKey: true, showCustomKeyInput: false };
  }
  return { apiKey: '', usingSavedKey: false, showCustomKeyInput: false };
}

function createEmptyValidation(): ConfigureValidation {
  return {
    validating: false,
    validationOk: null,
    validationMessage: null,
    modelAccessible: null,
  };
}

/** Mint a unique key for the wizard's inline "Test now" state. */
function mintTestKey(): string {
  return `wizard-draft:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function randomHexSuffix(length: number): string {
  const byteLength = Math.max(1, Math.ceil(length / 2));
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(byteLength);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, length);
  }
  return Math.random().toString(16).slice(2, 2 + length).padEnd(length, '0');
}

function createLocalByoProfileId(preset: LocalInferencePreset): string {
  return `local-byo-${preset.key}-${Date.now()}-${randomHexSuffix(4)}`;
}

/** Fields of ConfigureForm whose changes should invalidate in-flight validation. */
const MODEL_FORM_FIELDS: (keyof ConfigureForm)[] = ['selectedModel', 'customModelName'];

function partialChangesModel(
  prev: ConfigureForm,
  partial: Partial<ConfigureForm>,
): boolean {
  return MODEL_FORM_FIELDS.some(
    (field) => field in partial && partial[field] !== prev[field],
  );
}

/** Resolve the preset ModelOption for `profile.model`, if any. */
function findPresetModel(
  providerType: WizardProviderType,
  model: string | undefined,
): ModelOption | undefined {
  if (!model) return undefined;
  if (providerType === 'other') return undefined;
  const preset = PROVIDER_PRESETS[providerType];
  if (!preset) return undefined;
  return preset.models.find((m) => m.value === model);
}

function defaultNameForSelection(
  providerType: WizardProviderType,
  selectedModel: ModelOption | undefined,
  customModelName: string | undefined,
  reasoningEffort: ThinkingEffort | undefined,
  customProvider: CustomProvider | undefined,
): string {
  if (customProvider) {
    return deriveProfileName(undefined, selectedModel, customModelName, {
      providerLabel: customProvider.name,
      reasoningEffort,
    });
  }
  return deriveProfileName(providerType, selectedModel, customModelName, {
    reasoningEffort,
  });
}

function mergeLegacyModelNotes(
  profile: Pick<ModelProfile, 'modelNotes' | 'strengths' | 'weaknesses'>,
): string {
  const explicitNotes = profile.modelNotes?.trim();
  if (explicitNotes) return explicitNotes;
  return [profile.strengths, profile.weaknesses]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join('. ');
}

/**
 * Pulls the user-visible learned-limit fields off an original profile for
 * seeding into a fresh ConfigureForm. Used when the orphaned-provider recovery
 * flow lands the user on the configure step with a different provider type —
 * the learned context window is still useful information to display.
 */
function preservedLearnedFields(
  profile: ModelProfile | undefined,
): Pick<
  ConfigureForm,
  'contextWindow' | 'maxOutputTokens' | 'contextWindowTouched' | 'maxOutputTokensTouched'
> {
  return {
    contextWindow: profile?.contextWindow ?? null,
    maxOutputTokens: profile?.maxOutputTokens ?? null,
    contextWindowTouched: false,
    maxOutputTokensTouched: false,
  };
}

function seedConfigureForEdit(
  profile: ModelProfile,
  customProvider: CustomProvider | undefined,
  providerKeys: ProviderKeys | undefined,
  testKey: string,
): ConfigureStepState {
  const rawProviderType = profile.providerType ?? 'other';
  const providerType =
    rawProviderType === 'local'
      ? 'other'
      : (rawProviderType as WizardProviderType);
  const selectedModel = findPresetModel(providerType, profile.model);
  const customModelName = selectedModel ? undefined : profile.model ?? '';

  return {
    mode: 'edit',
    step: 'configure',
    validationEpoch: 0,
    providerType,
    customProvider,
    presetKey: profile.presetKey,
    editingProfileId: profile.id,
    originalProfile: profile,
    testKey,
    form: {
      name: profile.name,
      reasoningEffort: profile.reasoningEffort,
      councilEnabled: Boolean(profile.councilEnabled),
      routingEligible: Boolean(profile.routingEligible),
      modelNotes: mergeLegacyModelNotes(profile),
      selectedModel,
      customModelName,
      serverUrl: providerType === 'other' ? profile.serverUrl : undefined,
      contextWindow: profile.contextWindow ?? null,
      maxOutputTokens: profile.maxOutputTokens ?? null,
      contextWindowTouched: false,
      maxOutputTokensTouched: false,
    },
    key: buildInitialKeyState(providerType, customProvider, providerKeys, profile),
    validation: createEmptyValidation(),
    saving: false,
    saveError: null,
  };
}

function initialReasoningEffort(model: ModelOption | undefined): ThinkingEffort | undefined {
  if (!model) return 'medium';
  if (model.reasoning === false) return undefined;
  return 'medium';
}

function providerSupportsReasoning(model: ModelOption | undefined): boolean {
  if (!model) return true;
  return model.reasoning !== false;
}

/** Inclusive token range accepted by the wizard's contextWindow + maxOutputTokens inputs. */
export const MIN_TOKEN_FIELD_VALUE = 1_000;
export const MAX_TOKEN_FIELD_VALUE = 10_000_000;

/**
 * Returns true when `value` is unset (null/undefined) or a finite integer
 * inside `[MIN_TOKEN_FIELD_VALUE, MAX_TOKEN_FIELD_VALUE]`. Single source of
 * truth for context-window / max-output validation; both the form gate
 * (`computeCanSaveFromConfigure`) and the inline UI helper consume it.
 */
export function isValidTokenFieldValue(value: number | null | undefined): boolean {
  if (value == null) return true;
  if (!Number.isInteger(value)) return false;
  return value >= MIN_TOKEN_FIELD_VALUE && value <= MAX_TOKEN_FIELD_VALUE;
}

function computeCanSaveFromConfigure(state: ConfigureStepState): boolean {
  const { providerType, customProvider, form, key, validation, editingProfileId, originalProfile } = state;

  // Name required.
  if (!form.name.trim()) return false;

  // Model required.
  const hasPresetModel = !!form.selectedModel;
  const hasCustomModel = !!form.customModelName?.trim();
  if (!hasPresetModel && !hasCustomModel) return false;

  // Advanced disclosure: contextWindow / maxOutputTokens must be either unset
  // or in [MIN_TOKEN_FIELD_VALUE, MAX_TOKEN_FIELD_VALUE]. Out-of-range values
  // would otherwise persist via buildProfile() and break runtime resolution.
  if (!isValidTokenFieldValue(form.contextWindow)) return false;
  if (!isValidTokenFieldValue(form.maxOutputTokens)) return false;

  // Auto-learned profiles (id `auto:<model>`) without `serverUrl` are saveable
  // in their incomplete "Needs setup" state — the user can adjust the learned
  // context window and other diagnostic fields without filling in a serverUrl.
  // Once the user enters any connection detail (serverUrl or apiKey), normal
  // validation gates the save.
  const isAutoOnlyProfile =
    state.mode === 'edit'
    && (editingProfileId?.startsWith('auto:') ?? false)
    && (originalProfile?.serverUrl ?? '').trim() === ''
    && (form.serverUrl ?? '').trim() === ''
    && (key.apiKey ?? '').trim() === '';

  // Server URL required for providerType === 'other' (not custom-provider).
  if (providerType === 'other' && !customProvider) {
    if (!form.serverUrl?.trim() && !isAutoOnlyProfile) return false;
  }

  // Custom providers carry their own key — no profile-level key required.
  if (customProvider) return true;

  // 'other' provider has an optional per-profile key — no gating beyond presence.
  if (providerType === 'other') return true;

  const preset = PROVIDER_PRESETS[providerType];
  if (!preset) return false;
  if (!preset.requiresApiKey) return true;

  // OpenAI always requires a successful validation before save, even when
  // using a saved key. The Configure step auto-triggers validation on mount
  // for the saved-key path so the user doesn't have to click anything.
  if (providerType === 'openai') {
    const hasKeyMaterial = (key.usingSavedKey && !key.showCustomKeyInput) || key.apiKey.trim().length > 0;
    if (!hasKeyMaterial) return false;
    return validation.validationOk === true && validation.modelAccessible !== false;
  }

  // Using a saved key: no need to enter anything.
  if (key.usingSavedKey && !key.showCustomKeyInput) return true;

  // Otherwise a key is required.
  if (key.apiKey.trim().length === 0) return false;

  return true;
}

export function useProfileWizard(
  options: UseProfileWizardOptions,
): [WizardViewState, WizardActions] {
  const { providerKeys, customProviders } = options;
  const [state, setState] = useState<WizardState | null>(null);

  const open = useCallback(
    (params: WizardOpenParams): WizardOpenResult => {
      const testKey = mintTestKey();

      if (params.mode === 'add') {
        setState({
          mode: 'add',
          step: 'choose-path',
          rolePreference: params.rolePreference,
          validationEpoch: 0,
          testKey,
        });
        return { opened: true };
      }

      const { profile } = params;
      if (profile.companyManaged) {
        // Fail-closed: the row UI should already hide Edit, but this catches
        // programmatic misuse. Include profile ID so debuggers can correlate.
        const reason = `Profile '${profile.id}' is company-managed and cannot be edited.`;
        console.warn('[useProfileWizard] Refusing to open wizard for companyManaged profile.', {
          profileId: profile.id,
        });
        return { opened: false, reason };
      }

      // Orphaned customProviderId — force the user to pick a new provider.
      if (profile.customProviderId) {
        const cp = customProviders?.find((c) => c.id === profile.customProviderId);
        if (!cp) {
          setState({
            mode: 'edit',
            step: 'provider',
            validationEpoch: 0,
            orphanedCustomProvider: true,
            editingProfileId: profile.id,
            originalProfile: profile,
            testKey,
          });
          return { opened: true };
        }
        setState(seedConfigureForEdit(profile, cp, providerKeys, testKey));
        return { opened: true };
      }

      setState(seedConfigureForEdit(profile, undefined, providerKeys, testKey));
      return { opened: true };
    },
    [providerKeys, customProviders],
  );

  const close = useCallback(() => {
    setState(null);
  }, []);

  const selectCustomPath = useCallback(() => {
    setState((prev) => {
      if (!prev || prev.mode !== 'add' || prev.step !== 'choose-path') return prev;
      return {
        mode: 'add',
        step: 'provider',
        rolePreference: prev.rolePreference,
        validationEpoch: prev.validationEpoch + 1,
        testKey: prev.testKey,
      };
    });
  }, []);

  const selectProvider = useCallback(
    (
      providerType: WizardProviderType,
      customProvider?: CustomProvider,
      localPreset?: LocalInferencePreset,
    ) => {
      setState((prev) => {
        if (!prev) return prev;
        const nextEpoch = prev.validationEpoch + 1;
        const { editingProfileId, originalProfile, rolePreference, testKey } = prev;

        const learnedDefaults = preservedLearnedFields(originalProfile);

        if (localPreset) {
          const seededModel = localPreset.defaultModel.trim();
          const reasoningEffort = localPreset.supportsThinking ? 'medium' : undefined;
          return {
            mode: prev.mode,
            step: 'configure',
            rolePreference,
            validationEpoch: nextEpoch,
            providerType: 'other',
            customProvider: undefined,
            presetKey: localPreset.presetKey,
            draftProfileId: createLocalByoProfileId(localPreset),
            editingProfileId,
            originalProfile,
            testKey,
            form: {
              name: deriveProfileName('other', undefined, seededModel, {
                providerLabel: localPreset.label,
                reasoningEffort,
              }),
              reasoningEffort,
              councilEnabled: false,
              routingEligible: false,
              modelNotes: '',
              selectedModel: undefined,
              customModelName: seededModel,
              serverUrl: localPreset.serverUrl,
              ...learnedDefaults,
            },
            key: buildInitialKeyState('other', undefined, providerKeys),
            validation: createEmptyValidation(),
            saving: false,
            saveError: null,
          };
        }

        // Custom providers always go straight to configure (manual model name).
        if (customProvider) {
          return {
            mode: prev.mode,
            step: 'configure',
            rolePreference,
            validationEpoch: nextEpoch,
            providerType,
            customProvider,
            presetKey: undefined,
            draftProfileId: undefined,
            editingProfileId,
            originalProfile,
            testKey,
            form: {
              name: '',
              reasoningEffort: 'medium',
              councilEnabled: false,
              routingEligible: false,
              modelNotes: '',
              selectedModel: undefined,
              customModelName: '',
              serverUrl: undefined,
              ...learnedDefaults,
            },
            key: buildInitialKeyState(providerType, customProvider, providerKeys),
            validation: createEmptyValidation(),
            saving: false,
            saveError: null,
          };
        }

        // 'other' goes straight to configure with a server URL input.
        if (providerType === 'other') {
          return {
            mode: prev.mode,
            step: 'configure',
            rolePreference,
            validationEpoch: nextEpoch,
            providerType,
            customProvider: undefined,
            presetKey: undefined,
            draftProfileId: undefined,
            editingProfileId,
            originalProfile,
            testKey,
            form: {
              name: '',
              reasoningEffort: 'medium',
              councilEnabled: false,
              routingEligible: false,
              modelNotes: '',
              selectedModel: undefined,
              customModelName: '',
              serverUrl: 'http://localhost:1234',
              ...learnedDefaults,
            },
            key: buildInitialKeyState(providerType, undefined, providerKeys),
            validation: createEmptyValidation(),
            saving: false,
            saveError: null,
          };
        }

        // Providers with no preset models skip the model step entirely.
        const preset = PROVIDER_PRESETS[providerType];
        const hasPresets = !!preset && preset.models.length > 0;
        if (!hasPresets) {
          return {
            mode: prev.mode,
            step: 'configure',
            rolePreference,
            validationEpoch: nextEpoch,
            providerType,
            customProvider: undefined,
            presetKey: undefined,
            draftProfileId: undefined,
            editingProfileId,
            originalProfile,
            testKey,
            form: {
              name: '',
              reasoningEffort: 'medium',
              councilEnabled: false,
              routingEligible: false,
              modelNotes: '',
              selectedModel: undefined,
              customModelName: '',
              ...learnedDefaults,
            },
            key: buildInitialKeyState(providerType, undefined, providerKeys),
            validation: createEmptyValidation(),
            saving: false,
            saveError: null,
          };
        }

        // Providers with presets go to the model step.
        return {
          mode: prev.mode,
          step: 'model',
          rolePreference,
          validationEpoch: nextEpoch,
          providerType,
          customProvider: undefined,
          editingProfileId,
          originalProfile,
          testKey,
        };
      });
    },
    [providerKeys],
  );

  const selectModel = useCallback(
    (model: ModelOption) => {
      setState((prev) => {
        if (!prev || prev.step !== 'model') return prev;
        const {
          providerType,
          customProvider,
          editingProfileId,
          originalProfile,
          rolePreference,
          testKey,
        } = prev;
        const reasoningEffort = initialReasoningEffort(model);
        const name = defaultNameForSelection(
          providerType,
          model,
          undefined,
          reasoningEffort,
          customProvider,
        );

        return {
          mode: prev.mode,
          step: 'configure',
          rolePreference,
          validationEpoch: prev.validationEpoch + 1,
          providerType,
          customProvider,
          presetKey: undefined,
          draftProfileId: undefined,
          editingProfileId,
          originalProfile,
          testKey,
          form: {
            name,
            reasoningEffort,
            councilEnabled: false,
            routingEligible: false,
            modelNotes: '',
            selectedModel: model,
            customModelName: undefined,
            ...preservedLearnedFields(originalProfile),
          },
          key: buildInitialKeyState(providerType, customProvider, providerKeys),
          validation: createEmptyValidation(),
          saving: false,
          saveError: null,
        };
      });
    },
    [providerKeys],
  );

  const selectTypeManually = useCallback(() => {
    setState((prev) => {
      if (!prev || prev.step !== 'model') return prev;
      const {
        providerType,
        customProvider,
        editingProfileId,
        originalProfile,
        rolePreference,
        testKey,
      } = prev;
      return {
        mode: prev.mode,
        step: 'configure',
        rolePreference,
        validationEpoch: prev.validationEpoch + 1,
        providerType,
        customProvider,
        presetKey: undefined,
        draftProfileId: undefined,
        editingProfileId,
        originalProfile,
        testKey,
        form: {
          name: '',
          reasoningEffort: 'medium',
          councilEnabled: false,
          routingEligible: false,
          modelNotes: '',
          selectedModel: undefined,
          customModelName: '',
          ...preservedLearnedFields(originalProfile),
        },
        key: buildInitialKeyState(providerType, customProvider, providerKeys),
        validation: createEmptyValidation(),
        saving: false,
        saveError: null,
      };
    });
  }, [providerKeys]);

  const backToProvider = useCallback(() => {
    setState((prev) => {
      if (!prev || prev.mode !== 'add') return prev;
      if (prev.step === 'provider' || prev.step === 'choose-path') return prev;
      return {
        mode: 'add',
        step: 'provider',
        rolePreference: prev.rolePreference,
        validationEpoch: prev.validationEpoch + 1,
        testKey: prev.testKey,
      };
    });
  }, []);

  const backToChoosePath = useCallback(() => {
    setState((prev) => {
      if (!prev || prev.mode !== 'add' || prev.step !== 'provider') return prev;
      return {
        mode: 'add',
        step: 'choose-path',
        rolePreference: prev.rolePreference,
        validationEpoch: prev.validationEpoch + 1,
        testKey: prev.testKey,
      };
    });
  }, []);

  const backToModel = useCallback(() => {
    setState((prev) => {
      if (!prev || prev.mode !== 'add') return prev;
      if (prev.step !== 'configure') return prev;
      const { providerType, customProvider, rolePreference, testKey } = prev;
      // Only meaningful when we came from a preset model step.
      if (customProvider) return prev;
      if (providerType === 'other') return prev;
      const preset = PROVIDER_PRESETS[providerType];
      if (!preset || preset.models.length === 0) return prev;
      return {
        mode: 'add',
        step: 'model',
        rolePreference,
        validationEpoch: prev.validationEpoch + 1,
        providerType,
        customProvider: undefined,
        testKey,
      };
    });
  }, []);

  const updateForm = useCallback((partial: Partial<ConfigureForm>) => {
    setState((prev) => {
      if (!prev || prev.step !== 'configure') return prev;
      // Changing the model invalidates any OpenAI key validation — a key
      // validated for model A must not authorize saving model B.
      const modelChanged = partialChangesModel(prev.form, partial);
      const nextForm: ConfigureForm = { ...prev.form, ...partial };
      if (
        'contextWindow' in partial
        && partial.contextWindow !== prev.form.contextWindow
        && partial.contextWindowTouched === undefined
      ) {
        nextForm.contextWindowTouched = true;
        nextForm.useLearnedRequested = false;
      }
      if (
        'maxOutputTokens' in partial
        && partial.maxOutputTokens !== prev.form.maxOutputTokens
        && partial.maxOutputTokensTouched === undefined
      ) {
        nextForm.maxOutputTokensTouched = true;
      }
      return {
        ...prev,
        form: nextForm,
        validation: modelChanged ? createEmptyValidation() : prev.validation,
        validationEpoch: modelChanged ? prev.validationEpoch + 1 : prev.validationEpoch,
        saveError: null,
      };
    });
  }, []);

  const updateKey = useCallback((partial: Partial<ConfigureKeyEntry>) => {
    setState((prev) => {
      if (!prev || prev.step !== 'configure') return prev;
      // Key changes invalidate any in-flight validation.
      const next = {
        ...prev,
        key: { ...prev.key, ...partial },
        validation: createEmptyValidation(),
        validationEpoch: prev.validationEpoch + 1,
        saveError: null,
      };
      return next;
    });
  }, []);

  const updateValidation = useCallback((partial: Partial<ConfigureValidation>) => {
    setState((prev) => {
      if (!prev || prev.step !== 'configure') return prev;
      return { ...prev, validation: { ...prev.validation, ...partial } };
    });
  }, []);

  const resetValidation = useCallback(() => {
    setState((prev) => {
      if (!prev || prev.step !== 'configure') return prev;
      return { ...prev, validation: createEmptyValidation() };
    });
  }, []);

  const setSaving = useCallback((saving: boolean) => {
    setState((prev) => {
      if (!prev || prev.step !== 'configure') return prev;
      return { ...prev, saving };
    });
  }, []);

  const setSaveError = useCallback((error: string | null) => {
    setState((prev) => {
      if (!prev || prev.step !== 'configure') return prev;
      return { ...prev, saveError: error };
    });
  }, []);

  const useLearnedContextWindow = useCallback(() => {
    setState((prev) => {
      if (!prev || prev.step !== 'configure') return prev;
      const learned = prev.originalProfile?.lastLearnedContextWindow;
      if (learned == null) return prev;
      return {
        ...prev,
        form: {
          ...prev.form,
          contextWindow: learned,
          contextWindowTouched: false,
          useLearnedRequested: true,
        },
        saveError: null,
      };
    });
  }, []);

  const buildProfile = useCallback((): ModelProfile | null => {
    if (!state || state.step !== 'configure') return null;
    const {
      providerType,
      customProvider,
      presetKey,
      draftProfileId,
      form,
      key,
      editingProfileId,
      originalProfile,
      mode,
    } = state;

    const modelId = form.selectedModel?.value ?? form.customModelName?.trim() ?? '';
    if (!modelId) return null;
    const localPresetProfile = presetKey?.startsWith('local:') ?? false;
    const effectiveProviderType: WizardProviderType =
      localPresetProfile ? 'other' : providerType;

    const supportsReasoning = providerSupportsReasoning(form.selectedModel);

    let serverUrl: string;
    if (customProvider) {
      serverUrl = customProvider.serverUrl;
    } else if (effectiveProviderType === 'other') {
      serverUrl = (form.serverUrl ?? '').trim();
    } else {
      const preset = PROVIDER_PRESETS[effectiveProviderType];
      serverUrl = preset?.serverUrl ?? '';
    }

    // API key handling:
    // - custom-provider: never stored on the profile (uses provider's own key).
    // - 'other' (non-custom-provider): store the user's entered value verbatim.
    // - preset provider, usingSavedKey: omit (runtime resolves).
    // - preset provider, requiresApiKey === false: omit (OpenRouter OAuth).
    // - preset provider: store sanitized key.
    let apiKey: string | undefined;
    if (customProvider) {
      apiKey = undefined;
    } else if (effectiveProviderType === 'other') {
      const raw = key.apiKey.trim();
      apiKey = raw.length > 0 ? raw : undefined;
    } else {
      const preset = PROVIDER_PRESETS[effectiveProviderType];
      const usingSaved = key.usingSavedKey && !key.showCustomKeyInput;
      const skipKey = usingSaved || !preset?.requiresApiKey;
      apiKey = skipKey ? undefined : key.apiKey.replace(/\s/g, '');
    }

    const id =
      mode === 'edit' && editingProfileId
        ? editingProfileId
        : draftProfileId
          ? draftProfileId
        : `profile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // Edit mode: spread the original profile first so preserved fields
    // (`enabled`, `chatCompatibility`, `chatCompatibilityCheckedAt`,
    // `contextWindow`, `maxOutputTokens`, `authSource`, `createdAt`, etc.)
    // survive. Wizard-controlled fields override on top. The reset guard
    // downstream is responsible for clearing chatCompatibility when the
    // connection-relevant fields actually changed.
    const base: Partial<ModelProfile> =
      mode === 'edit' && originalProfile ? { ...originalProfile } : {};

    const profile: ModelProfile = {
      ...base,
      id,
      name: form.name.trim(),
      providerType: effectiveProviderType,
      serverUrl,
      model: modelId,
      apiKey,
      presetKey: presetKey || undefined,
      routeSurface: localPresetProfile ? 'local' : base.routeSurface,
      // Thinking effort is only meaningful for reasoning-capable models. Suppression
      // for incompatible gateways is handled at egress via `thinkingCompatibility`
      // (auto-detected by the Test button), not a manual flag — see
      // docs/project/CUSTOM_GATEWAY_COMPATIBILITY.md.
      reasoningEffort: supportsReasoning ? form.reasoningEffort : undefined,
      councilEnabled: form.councilEnabled || undefined,
      routingEligible: form.routingEligible || undefined,
      modelNotes: form.modelNotes.trim() || undefined,
      customProviderId: customProvider?.id,
      createdAt: mode === 'edit' && originalProfile ? originalProfile.createdAt : Date.now(),
    };

    // Learned-limit sidecar: only stamp provenance when the user explicitly
    // interacted with the field. Untouched edits preserve the existing
    // provenance (so editing the name on an auto-learned profile doesn't
    // accidentally lock its context window from future auto-learn).
    if (form.useLearnedRequested && originalProfile?.lastLearnedContextWindow != null) {
      profile.contextWindow = originalProfile.lastLearnedContextWindow;
      profile.contextWindowSource = 'auto';
      profile.contextWindowOverflowCount = originalProfile.contextWindowOverflowCount;
      profile.contextWindowLearnedAt = originalProfile.contextWindowLearnedAt;
      profile.lastLearnedContextWindow = originalProfile.lastLearnedContextWindow;
    } else if (form.contextWindowTouched) {
      const next = form.contextWindow ?? null;
      // Preserve the auto-learned sidecars so the wizard can offer
      // "Use learned value" later, and so the writer's tightening allowance
      // continues to track overflow events behind the user override.
      profile.contextWindowOverflowCount = originalProfile?.contextWindowOverflowCount;
      profile.contextWindowLearnedAt = originalProfile?.contextWindowLearnedAt;
      profile.lastLearnedContextWindow = originalProfile?.lastLearnedContextWindow;
      if (next === null) {
        // User cleared the field. Drop both the value AND the source so the
        // resolver and writer treat the profile as unset (resolves from
        // registry/preset/auto-learned cascade) and the writer is free to
        // re-learn on the next overflow.
        profile.contextWindow = undefined;
        profile.contextWindowSource = undefined;
      } else {
        profile.contextWindow = next;
        profile.contextWindowSource = 'user';
      }
    }
    if (form.maxOutputTokensTouched) {
      const next = form.maxOutputTokens ?? null;
      profile.maxOutputTokens = next === null ? undefined : next;
    }

    return profile;
  }, [state]);

  const canSave = useMemo(() => {
    if (!state || state.step !== 'configure') return false;
    return computeCanSaveFromConfigure(state);
  }, [state]);

  const canProceed = useMemo(() => {
    if (!state) return false;
    if (state.step === 'choose-path') return false; // selection triggers transition or add directly
    if (state.step === 'provider') return false; // selection triggers transition directly
    if (state.step === 'model') return true;
    return canSave;
  }, [state, canSave]);

  const busy = useMemo(() => {
    if (!state || state.step !== 'configure') return false;
    return state.saving || state.validation.validating;
  }, [state]);

  const view: WizardViewState = { state, canProceed, canSave, busy };
  const actions: WizardActions = {
    open,
    close,
    selectCustomPath,
    selectProvider,
    selectModel,
    selectTypeManually,
    backToChoosePath,
    backToProvider,
    backToModel,
    updateForm,
    updateKey,
    updateValidation,
    resetValidation,
    setSaving,
    setSaveError,
    useLearnedContextWindow,
    buildProfile,
  };

  return [view, actions];
}
