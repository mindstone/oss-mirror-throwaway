import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Input, Label, Select, Button, Textarea, Tooltip } from '@renderer/components/ui';
import {
  ChevronRight,
  KeyRound,
  Loader2,
  Lock,
  Check,
  Zap,
  X,
  CircleCheck,
} from 'lucide-react';
import type { ThinkingEffort } from '@shared/types';
import {
  PROVIDER_PRESETS,
  type ModelOption,
  getModelCapabilityDefaults,
  getKnownContextWindowForModel,
} from '@shared/data/modelProviderPresets';
import { formatTokenCount } from '@shared/utils/usageFormatters';
import { THINKING_LEVELS, deriveProfileName } from '../profileHelpers';
import type {
  ConfigureStepState,
  WizardActions,
} from '../useProfileWizard';
import {
  MAX_TOKEN_FIELD_VALUE,
  MIN_TOKEN_FIELD_VALUE,
  isValidTokenFieldValue,
} from '../useProfileWizard';
import type { TestResult, TestStateEntry } from '../useProfileTester';
import styles from '../ProfileWizardDialog.module.css';

export interface ConfigureStepProps {
  state: ConfigureStepState;
  actions: WizardActions;
  canSave: boolean;
  /** The key used to address this wizard's inline-test state via useProfileTester. */
  testKey: string;
  testState?: TestStateEntry;
  runTest: (key: string, params: {
    serverUrl: string;
    model?: string;
    apiKey?: string;
    providerType?: string;
    customProviderId?: string;
  }) => Promise<TestResult>;
}

const MANUAL_SENTINEL = '__manual__';

function sanitizeApiKey(value: string): string {
  return value.replace(/\s/g, '');
}

export const ConfigureStep = ({
  state,
  actions,
  canSave,
  testKey,
  testState,
  runTest,
}: ConfigureStepProps) => {
  const {
    providerType,
    customProvider,
    presetKey,
    form,
    key,
    validation,
    mode,
    originalProfile,
  } = state;
  const nameRef = useRef<HTMLInputElement | null>(null);
  // Advanced disclosure default-expanded when the profile already has any
  // learned-limit context to surface; otherwise collapsed.
  const [advancedExpanded, setAdvancedExpanded] = useState(() =>
    Boolean(
      originalProfile?.contextWindow != null
      || originalProfile?.maxOutputTokens != null
      || originalProfile?.lastLearnedContextWindow != null
      || (originalProfile?.id?.startsWith('auto:') ?? false),
    ),
  );

  // Focus the name input on mount (step-transition focus management).
  useEffect(() => {
    nameRef.current?.focus();
    // Select existing text so edit-mode renames are a single keystroke away.
    nameRef.current?.select?.();
  }, []);

  // Keep a live ref to the wizard state so async validation callbacks can
  // detect step/epoch changes and drop stale results without needing hook deps
  // that would reset the closure on every keystroke.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const preset =
    providerType !== 'other' && !customProvider
      ? PROVIDER_PRESETS[providerType]
      : undefined;
  const supportsReasoning = form.selectedModel
    ? form.selectedModel.reasoning !== false
    : true;
  const requiresApiKey =
    !customProvider && providerType !== 'other' && preset?.requiresApiKey !== false;
  const isLocalPresetProfile = presetKey?.startsWith('local:') ?? false;
  const modelIdForTest =
    form.selectedModel?.value ?? form.customModelName?.trim() ?? '';

  const providerDisplayLabel = customProvider
    ? customProvider.name
    : providerType === 'other'
      ? 'Other (OpenAI-compatible)'
      : preset?.label ?? providerType;

  const serverUrlForTest = customProvider
    ? customProvider.serverUrl
    : providerType === 'other'
      ? (form.serverUrl ?? '').trim()
      : preset?.serverUrl ?? '';

  // --- Name auto-fill ---------------------------------------------------

  const updateForm = actions.updateForm;

  const handleModelSelectChange = useCallback(
    (next: string) => {
      if (!preset) return;
      if (next === MANUAL_SENTINEL) {
        updateForm({
          selectedModel: undefined,
          customModelName: form.customModelName ?? '',
        });
        return;
      }
      const nextModel = preset.models.find((m) => m.value === next);
      if (!nextModel) return;
      const nextSupportsReasoning = nextModel.reasoning !== false;
      const nextReasoning: ThinkingEffort | undefined = nextSupportsReasoning
        ? form.reasoningEffort ?? 'medium'
        : undefined;
      const autoName = deriveProfileName(providerType, nextModel, undefined, {
        reasoningEffort: nextReasoning,
      });
      updateForm({
        selectedModel: nextModel,
        customModelName: undefined,
        reasoningEffort: nextReasoning,
        // Only auto-overwrite the name when it already looks auto-derived for
        // the previously-selected model — preserves user customizations.
        name: isAutoDerivedName(form.name, form.selectedModel, form.customModelName)
          ? autoName
          : form.name,
      });
    },
    [preset, updateForm, providerType, form.customModelName, form.name, form.reasoningEffort, form.selectedModel],
  );

  const handleCustomModelChange = useCallback(
    (nextValue: string) => {
      const autoName = deriveProfileName(providerType, undefined, nextValue, {
        providerLabel: customProvider?.name,
        reasoningEffort: form.reasoningEffort,
      });
      updateForm({
        customModelName: nextValue,
        name: isAutoDerivedName(form.name, undefined, form.customModelName)
          ? autoName
          : form.name,
      });
    },
    [providerType, customProvider, updateForm, form.name, form.customModelName, form.reasoningEffort],
  );

  const handleReasoningChange = useCallback(
    (next: ThinkingEffort) => {
      const autoName = deriveProfileName(
        providerType,
        form.selectedModel,
        form.customModelName,
        {
          providerLabel: customProvider?.name,
          reasoningEffort: next,
        },
      );
      updateForm({
        reasoningEffort: next,
        name: isAutoDerivedName(form.name, form.selectedModel, form.customModelName)
          ? autoName
          : form.name,
      });
    },
    [providerType, customProvider, updateForm, form.name, form.selectedModel, form.customModelName],
  );

  // --- OpenAI key validation --------------------------------------------

  const validateOpenAiKey = useCallback(
    async (apiKey: string, modelId: string) => {
      const cleaned = sanitizeApiKey(apiKey);
      if (!cleaned) return;

      const startEpoch = stateRef.current.validationEpoch;
      actions.updateValidation({
        validating: true,
        validationOk: null,
        modelAccessible: null,
        validationMessage: 'Validating...',
      });

      try {
        const result = await window.settingsApi.validateOpenaiKey({
          apiKey: cleaned,
          modelId,
          deepValidate: true,
        });
        if (
          stateRef.current.step !== 'configure' ||
          stateRef.current.validationEpoch !== startEpoch
        ) {
          return;
        }
        actions.updateValidation({
          validating: false,
          validationOk: result.ok,
          modelAccessible: result.modelAccessible ?? null,
          validationMessage: result.ok
            ? result.modelAccessible === false
              ? `Key is valid but ${modelId} is not accessible on this account.`
              : result.reason === 'quota_exceeded'
                ? result.message || 'Key is valid but has no credits.'
                : `Key valid for ${modelId}.`
            : result.message || 'Validation failed.',
        });
      } catch {
        if (
          stateRef.current.step !== 'configure' ||
          stateRef.current.validationEpoch !== startEpoch
        ) {
          return;
        }
        actions.updateValidation({
          validating: false,
          validationOk: false,
          validationMessage: 'Validation failed.',
        });
      }
    },
    [actions],
  );

  const handleKeyBlur = useCallback(() => {
    if (providerType !== 'openai') return;
    if (!modelIdForTest) return;
    if (key.usingSavedKey && !key.showCustomKeyInput) return;
    if (!key.apiKey.trim()) return;
    void validateOpenAiKey(key.apiKey, modelIdForTest);
  }, [providerType, modelIdForTest, key.apiKey, key.usingSavedKey, key.showCustomKeyInput, validateOpenAiKey]);

  // Auto-trigger validation for OpenAI + saved-key. `canSave` gates on
  // validationOk for OpenAI regardless of key source, so without this the
  // user would have to manually poke the key field before the Save button
  // could ever enable. This runs once per relevant state-shape change.
  useEffect(() => {
    if (providerType !== 'openai') return;
    if (!modelIdForTest) return;
    if (!key.usingSavedKey || key.showCustomKeyInput) return;
    if (!key.apiKey.trim()) return;
    if (validation.validating) return;
    if (validation.validationOk !== null) return;
    void validateOpenAiKey(key.apiKey, modelIdForTest);
    // Intentionally scoped: only auto-trigger when the user has not yet made
    // a validation attempt for the current (providerType, modelId, key-source)
    // tuple. Key changes (updateKey) reset validation via the hook; model
    // changes (updateForm) now also reset it, so this effect naturally
    // re-fires after either kind of change.
  }, [
    providerType,
    modelIdForTest,
    key.usingSavedKey,
    key.showCustomKeyInput,
    key.apiKey,
    validation.validating,
    validation.validationOk,
    validateOpenAiKey,
  ]);

  // --- Inline test ------------------------------------------------------

  const canTest = !!modelIdForTest && (
    customProvider !== undefined ||
    providerType === 'other' ||
    preset?.requiresApiKey === false ||
    key.apiKey.trim().length > 0 ||
    (key.usingSavedKey && !key.showCustomKeyInput)
  );

  const handleTestClick = useCallback(() => {
    if (!canTest) return;
    const skipKey =
      customProvider !== undefined ||
      (providerType !== 'other' && preset?.requiresApiKey === false) ||
      (key.usingSavedKey && !key.showCustomKeyInput);
    void runTest(testKey, {
      serverUrl: serverUrlForTest,
      model: modelIdForTest || undefined,
      apiKey: skipKey ? undefined : key.apiKey || undefined,
      providerType: customProvider ? 'other' : providerType,
      customProviderId: customProvider?.id,
    });
  }, [canTest, customProvider, providerType, preset, key.usingSavedKey, key.showCustomKeyInput, key.apiKey, runTest, testKey, serverUrlForTest, modelIdForTest]);

  // --- Render -----------------------------------------------------------

  return (
    <div className={styles.stepRoot} data-testid="settings-models-wizard-step-configure">
      {state.saveError && (
        <div className={styles.saveError} role="alert">
          Couldn&rsquo;t save. {state.saveError}
        </div>
      )}

      <div className={styles.providerReadOnly}>
        <span className={styles.providerReadOnlyLabel}>Provider</span>
        <span className={styles.providerReadOnlyValue}>{providerDisplayLabel}</span>
      </div>

      <div className={styles.formGrid}>
        {/* Name ---------------------------------------------------------- */}
        <div className={styles.fieldGroup}>
          <Label htmlFor="wizard-name" className={styles.fieldLabel}>
            Name
          </Label>
          <Input
            id="wizard-name"
            ref={nameRef}
            value={form.name}
            onChange={(e) => updateForm({ name: e.target.value })}
            placeholder={providerDisplayLabel}
          />
        </div>

        {/* Model (edit mode) or Manual text input (add mode / manual) ------ */}
        {mode === 'edit' && preset ? (
          <>
            <div className={styles.fieldGroup}>
              <Label htmlFor="wizard-model-select" className={styles.fieldLabel}>
                Model
              </Label>
              <Select
                id="wizard-model-select"
                value={form.selectedModel?.value ?? MANUAL_SENTINEL}
                onChange={(e) => handleModelSelectChange(e.target.value)}
              >
                {preset.models.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                    {m.description ? ` — ${m.description}` : ''}
                  </option>
                ))}
                <option value={MANUAL_SENTINEL}>Type it manually</option>
              </Select>
            </div>
            {!form.selectedModel && (
              <div className={styles.fieldGroup}>
                <Label htmlFor="wizard-model-input" className={styles.fieldLabel}>
                  Model ID
                </Label>
                <Input
                  id="wizard-model-input"
                  value={form.customModelName ?? ''}
                  onChange={(e) => handleCustomModelChange(e.target.value)}
                  placeholder="e.g., gpt-5.4-mini"
                  data-testid="settings-models-wizard-model-input"
                />
              </div>
            )}
          </>
        ) : mode === 'add' && form.selectedModel ? (
          <div className={styles.providerReadOnly}>
            <span className={styles.providerReadOnlyLabel}>Model</span>
            <span className={styles.providerReadOnlyValue}>{form.selectedModel.label}</span>
          </div>
        ) : (
          <div className={styles.fieldGroup}>
            <Label htmlFor="wizard-model-input" className={styles.fieldLabel}>
              Model ID
            </Label>
            <Input
              id="wizard-model-input"
              value={form.customModelName ?? ''}
              onChange={(e) => handleCustomModelChange(e.target.value)}
              placeholder={placeholderForManualModel(providerType)}
              data-testid="settings-models-wizard-model-input"
            />
          </div>
        )}

        {/* Server URL (only for providerType === 'other', no custom provider) */}
        {providerType === 'other' && !customProvider && (
          <div className={styles.fieldGroup}>
            <Label htmlFor="wizard-server-url" className={styles.fieldLabel}>
              Server URL
            </Label>
            <Input
              id="wizard-server-url"
              value={form.serverUrl ?? ''}
              onChange={(e) => updateForm({ serverUrl: e.target.value })}
              placeholder="http://localhost:1234"
              data-testid="settings-models-wizard-server-url-input"
            />
            {isLocalPresetProfile && (
              <span className={styles.fieldHint}>
                No API key needed — this connects to a server on your machine.
              </span>
            )}
          </div>
        )}

        {/* Thinking level -------------------------------------------------- */}
        {supportsReasoning && (
          <div className={styles.fieldGroup}>
            <Tooltip content="How hard this model thinks before it answers. More thinking handles tougher requests but is slower and costs more. If a model is reached through a company gateway that can't handle thinking, run Test — Rebel detects it and stops sending the setting.">
              <span className={styles.fieldLabel} style={{ cursor: 'help' }}>Thinking level</span>
            </Tooltip>
            <div className={styles.segmented} role="group" aria-label="Thinking level">
              {THINKING_LEVELS.map((level) => (
                <button
                  key={level.value}
                  type="button"
                  aria-pressed={form.reasoningEffort === level.value}
                  className={
                    form.reasoningEffort === level.value
                      ? styles.segmentedButtonActive
                      : styles.segmentedButton
                  }
                  onClick={() => handleReasoningChange(level.value)}
                >
                  {level.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Council membership toggle ------------------------------------- */}
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={form.councilEnabled}
            onChange={(e) => updateForm({ councilEnabled: e.target.checked })}
          />
          <span>In Council</span>
        </label>

        {/* Smart picking inclusion toggle -------------------------------- */}
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            data-testid="settings-models-routing-eligible"
            checked={form.routingEligible}
            onChange={(e) => updateForm({ routingEligible: e.target.checked })}
          />
          <span>Included in Smart picking</span>
        </label>

        {/* Capability hints (visible when routing is enabled) ------------- */}
        {form.routingEligible && (() => {
          const capDefaults = getModelCapabilityDefaults(modelIdForTest);
          return (
            <div className={styles.fieldGroup}>
              <Label htmlFor="modelNotes">Model notes</Label>
              <Textarea
                id="modelNotes"
                data-testid="settings-models-notes"
                rows={3}
                placeholder={capDefaults?.modelNotes ?? 'What this model is good at, what to avoid, any quirks...'}
                value={form.modelNotes}
                onChange={(e) => updateForm({ modelNotes: e.target.value })}
              />
              {capDefaults && !form.modelNotes && (
                <span className={styles.fieldHint}>
                  Defaults shown as placeholders. Edit to customise what the planner knows about this model.
                </span>
              )}
            </div>
          );
        })()}

        {/* Advanced disclosure (learned context-window + max output) ------ */}
        <ContextWindowAdvancedSection
          form={form}
          modelIdForTest={modelIdForTest}
          originalProfile={originalProfile}
          expanded={advancedExpanded}
          onToggleExpanded={() => setAdvancedExpanded((prev) => !prev)}
          onUpdateForm={updateForm}
          onUseLearnedContextWindow={actions.useLearnedContextWindow}
        />

        {/* API key section ------------------------------------------------ */}
        {requiresApiKey && preset && (
          <div className={styles.fieldGroup}>
            {key.usingSavedKey && !key.showCustomKeyInput ? (
              <div className={styles.savedKeyRow}>
                <Lock size={12} className={styles.savedKeyIcon} />
                <span className={styles.savedKeyText}>
                  Using your saved {preset.label} key
                </span>
                <button
                  type="button"
                  className={styles.savedKeyLink}
                  onClick={() =>
                    actions.updateKey({
                      usingSavedKey: false,
                      showCustomKeyInput: true,
                      apiKey: '',
                    })
                  }
                >
                  Use different key
                </button>
              </div>
            ) : (
              <>
                <Label htmlFor="wizard-apikey" className={styles.fieldLabel}>
                  <KeyRound size={11} aria-hidden="true" style={{ marginRight: 4, verticalAlign: -1 }} />
                  {preset.label} API key
                </Label>
                <Input
                  id="wizard-apikey"
                  type="password"
                  value={key.apiKey}
                  onChange={(e) =>
                    actions.updateKey({ apiKey: sanitizeApiKey(e.target.value) })
                  }
                  onBlur={handleKeyBlur}
                  placeholder={preset.apiKeyPlaceholder}
                  data-testid="settings-models-wizard-apikey-input"
                />
                {validation.validationMessage && (
                  <p
                    className={
                      validation.validating
                        ? styles.validationPending
                        : validation.validationOk
                          ? validation.modelAccessible === false
                            ? styles.validationWarning
                            : styles.validationSuccess
                          : styles.validationError
                    }
                  >
                    {validation.validating ? (
                      <Loader2 size={12} className={styles.spinner} aria-hidden="true" />
                    ) : validation.validationOk ? (
                      <Check size={12} aria-hidden="true" />
                    ) : null}
                    {validation.validationMessage}
                  </p>
                )}
                <p className={styles.fieldHint}>
                  Get your API key from{' '}
                  <a
                    href={preset.apiKeyHelpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.fieldHintLink}
                  >
                    {safeHost(preset.apiKeyHelpUrl)}
                  </a>
                </p>
              </>
            )}
          </div>
        )}

        {/* Inline test --------------------------------------------------- */}
        <div>
          {testState?.testing ? (
            <span className={styles.inlineTestResultTesting}>
              <Loader2 size={12} className={styles.spinner} aria-hidden="true" />
              Testing…
            </span>
          ) : testState?.result ? (
            <span
              className={
                testState.result.success
                  ? styles.inlineTestResultSuccess
                  : styles.inlineTestResultError
              }
              title={
                testState.result.success
                  ? `${testState.result.latencyMs ?? '?'}ms — ${testState.result.modelResponse ?? ''}`
                  : testState.result.error ?? 'Test failed'
              }
            >
              {testState.result.success ? (
                <CircleCheck size={12} aria-hidden="true" />
              ) : (
                <X size={12} aria-hidden="true" />
              )}
              {testState.result.success
                ? `Works — ${testState.result.latencyMs ?? '?'}ms`
                : testState.result.error ?? 'Failed'}
            </span>
          ) : (
            <Tooltip content="Sends a quick request to check this model works — and whether it handles JSON, thinking, and tools. If something isn't supported (e.g. a gateway that can't take Rebel's thinking setting), Rebel notes it and stops sending that part automatically.">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleTestClick}
                disabled={!canTest || !canSave}
                data-testid="settings-models-wizard-test-button"
              >
                <Zap size={12} aria-hidden="true" />
                Test now
              </Button>
            </Tooltip>
          )}
        </div>
      </div>

      {mode === 'edit' && (
        <p className={styles.footerHint}>
          To change provider, delete this profile and add a new one.
        </p>
      )}
    </div>
  );
};

/** Reasonable placeholder for the manual model-ID input per provider. */
function placeholderForManualModel(providerType: string): string {
  switch (providerType) {
    case 'openai':
      return 'e.g., gpt-5.4-mini';
    case 'openrouter':
      return 'e.g., anthropic/claude-sonnet-4.6';
    case 'together':
      return 'e.g., meta-llama/Llama-3.3-70B-Instruct-Turbo';
    case 'cerebras':
      return 'e.g., llama-3.3-70b';
    case 'google':
      return 'e.g., gemini-2.5-flash';
    default:
      return 'e.g., your-model-id';
  }
}

/** Guarded URL hostname for display. */
function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

interface ContextWindowAdvancedSectionProps {
  form: import('../useProfileWizard').ConfigureForm;
  modelIdForTest: string;
  originalProfile: import('@shared/types').ModelProfile | undefined;
  expanded: boolean;
  onToggleExpanded: () => void;
  onUpdateForm: (partial: Partial<import('../useProfileWizard').ConfigureForm>) => void;
  onUseLearnedContextWindow: () => void;
}

function parseTokenInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return Number.NaN;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value)) return Number.NaN;
  return value;
}

function ContextWindowAdvancedSection({
  form,
  modelIdForTest,
  originalProfile,
  expanded,
  onToggleExpanded,
  onUpdateForm,
  onUseLearnedContextWindow,
}: ContextWindowAdvancedSectionProps) {
  const learnedWindow = originalProfile?.lastLearnedContextWindow;
  const overflowCount = originalProfile?.contextWindowOverflowCount ?? 0;
  const learnedAt = originalProfile?.contextWindowLearnedAt;
  const sourceIsAuto = form.useLearnedRequested
    || (!form.contextWindowTouched && originalProfile?.contextWindowSource === 'auto');
  const showUseLearnedLink = !sourceIsAuto
    && learnedWindow != null
    && form.contextWindow !== learnedWindow;
  const inlineLearnedHint = !sourceIsAuto
    && learnedWindow != null
    && form.contextWindow !== learnedWindow
    ? `Learned value: ${formatTokenCount(learnedWindow)} tokens`
    : null;

  const registryCeiling = getKnownContextWindowForModel(modelIdForTest) ?? null;
  const contextWindowError = validateTokenField(form.contextWindow);
  const contextWindowWarning =
    contextWindowError == null
      && form.contextWindow != null
      && registryCeiling != null
      && form.contextWindow > registryCeiling
      ? `That's above this model's known limit of ${formatTokenCount(registryCeiling)} tokens. Save it if you've confirmed your account has higher access.`
      : null;
  const maxOutputError = validateTokenField(form.maxOutputTokens);

  return (
    <div
      className={styles.advancedSection}
      data-testid="settings-models-wizard-advanced-section"
    >
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        data-testid="settings-models-wizard-advanced-toggle"
        className={styles.advancedToggle}
      >
        <span
          className={`${styles.advancedChevron} ${expanded ? styles.advancedChevronExpanded : ''}`}
        >
          <ChevronRight size={12} aria-hidden="true" />
        </span>
        Advanced
      </button>
      {expanded && (
        <div className={styles.advancedContent}>
          {/* Conversation memory (contextWindow) */}
          <div className={styles.fieldGroup}>
            <div className={styles.contextWindowLabelRow}>
              <Label htmlFor="wizard-context-window" className={styles.fieldLabel}>
                Conversation memory
              </Label>
              {sourceIsAuto && (
                <Tooltip
                  content={formatLearnedTooltip(overflowCount, learnedAt)}
                  placement="top"
                >
                  <span data-testid="settings-models-wizard-learned-badge">
                    <Badge variant="info" size="sm">
                      Learned
                    </Badge>
                  </span>
                </Tooltip>
              )}
            </div>
            <Input
              id="wizard-context-window"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={formatTokenInput(form.contextWindow)}
              onChange={(e) => {
                const parsed = parseTokenInput(e.target.value);
                if (Number.isNaN(parsed)) return;
                onUpdateForm({ contextWindow: parsed });
              }}
              placeholder="tokens"
              data-testid="settings-models-wizard-context-window-input"
            />
            <span className={styles.fieldHint}>
              How much text Rebel can send to this model at once.
            </span>
            {inlineLearnedHint && (
              <span
                className={styles.learnedValueHint}
                data-testid="settings-models-wizard-learned-value-hint"
              >
                {inlineLearnedHint}
              </span>
            )}
            {showUseLearnedLink && (
              <Button
                variant="ghost"
                size="xs"
                type="button"
                onClick={onUseLearnedContextWindow}
                className={styles.useLearnedLink}
                data-testid="settings-models-wizard-use-learned-button"
              >
                Use learned value
              </Button>
            )}
            {contextWindowError && (
              <span
                className={styles.validationError}
                data-testid="settings-models-wizard-context-window-error"
              >
                {contextWindowError}
              </span>
            )}
            {contextWindowWarning && (
              <span
                className={styles.validationWarning}
                data-testid="settings-models-wizard-context-window-warning"
              >
                {contextWindowWarning}
              </span>
            )}
          </div>

          {/* Longest reply (maxOutputTokens) */}
          <div className={styles.fieldGroup}>
            <Label htmlFor="wizard-max-output-tokens" className={styles.fieldLabel}>
              Longest reply
            </Label>
            <Input
              id="wizard-max-output-tokens"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={formatTokenInput(form.maxOutputTokens)}
              onChange={(e) => {
                const parsed = parseTokenInput(e.target.value);
                if (Number.isNaN(parsed)) return;
                onUpdateForm({ maxOutputTokens: parsed });
              }}
              placeholder="tokens"
              data-testid="settings-models-wizard-max-output-tokens-input"
            />
            <span className={styles.fieldHint}>
              The most this model can write in one response.
            </span>
            {maxOutputError && (
              <span
                className={styles.validationError}
                data-testid="settings-models-wizard-max-output-tokens-error"
              >
                {maxOutputError}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatTokenInput(value: number | null | undefined): string {
  if (value == null) return '';
  return String(value);
}

function validateTokenField(value: number | null | undefined): string | null {
  if (value == null) return null;
  if (!isValidTokenFieldValue(value)) {
    return `Enter a whole number between ${formatTokenCount(MIN_TOKEN_FIELD_VALUE)} and ${formatTokenCount(MAX_TOKEN_FIELD_VALUE)} tokens.`;
  }
  return null;
}

function formatLearnedTooltip(overflowCount: number, learnedAt: number | undefined): string {
  const count = Math.max(overflowCount, 1);
  const timesLabel = count === 1 ? 'time' : 'times';
  const relative = learnedAt ? formatRelativeTimeFromNow(learnedAt) : 'recently';
  // Verbatim per chief-designer ruling C, 2026-05-04. Don't drift this copy
  // without a fresh design pass — Phase 6 reviewers compared against an
  // earlier draft and flagged it; the active ruling is what's encoded here.
  return `Learned after this model ran out of room ${count} ${timesLabel}. Updated ${relative}.`;
}

function formatRelativeTimeFromNow(timestamp: number): string {
  if (typeof Intl?.RelativeTimeFormat === 'undefined') {
    return new Date(timestamp).toLocaleString();
  }
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const diffMs = timestamp - Date.now();
  const absSec = Math.abs(diffMs) / 1000;
  const units: Array<{ unit: Intl.RelativeTimeFormatUnit; seconds: number }> = [
    { unit: 'year', seconds: 365 * 24 * 60 * 60 },
    { unit: 'month', seconds: 30 * 24 * 60 * 60 },
    { unit: 'week', seconds: 7 * 24 * 60 * 60 },
    { unit: 'day', seconds: 24 * 60 * 60 },
    { unit: 'hour', seconds: 60 * 60 },
    { unit: 'minute', seconds: 60 },
    { unit: 'second', seconds: 1 },
  ];
  for (const { unit, seconds } of units) {
    if (absSec >= seconds || unit === 'second') {
      return formatter.format(Math.round(diffMs / 1000 / seconds), unit);
    }
  }
  return formatter.format(0, 'second');
}

/**
 * Heuristic: was `name` auto-derived from the current selection? If so, we
 * should update it when the user changes model or reasoning. If the user has
 * typed something custom, leave it alone.
 */
function isAutoDerivedName(
  currentName: string,
  selectedModel: ModelOption | undefined,
  customModelName: string | undefined,
): boolean {
  const trimmed = currentName.trim();
  if (!trimmed) return true;
  const tokens: string[] = [];
  if (selectedModel) tokens.push(selectedModel.label);
  if (customModelName) tokens.push(customModelName.trim());
  // If the existing name contains the model's label/id and starts with a
  // provider-ish prefix, treat it as auto-derived.
  if (tokens.length === 0) return true;
  for (const token of tokens) {
    if (token && trimmed.includes(token)) return true;
  }
  return false;
}
