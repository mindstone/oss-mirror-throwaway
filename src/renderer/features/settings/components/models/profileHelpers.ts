/**
 * Pure helpers shared by the model profile manager UI.
 *
 * These utilities are split out of `LocalModelSection.tsx` so they can be unit
 * tested and reused by the future wizard dialog and table components.
 */
import {
  PROVIDER_PRESETS,
  type ModelOption,
} from '@shared/data/modelProviderPresets';
import type {
  CustomProvider,
  ModelProfile,
  ModelProviderType,
  ThinkingEffort,
} from '@shared/types';

/** Canonical list of thinking levels exposed in the UI. */
export const THINKING_LEVELS: { value: ThinkingEffort; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
];

/**
 * Connection-relevant fields. When any of these change between `incoming` and
 * the previously-persisted profile, the chat-compatibility verdict is stale
 * and must be cleared.
 */
const CONNECTION_RELEVANT_FIELDS: (keyof ModelProfile)[] = [
  'model',
  'serverUrl',
  'apiKey',
  'providerType',
  'customProviderId',
];

/**
 * Returns a copy of `incoming` with compatibility verdicts cleared when any
 * connection-relevant field changed versus the existing persisted profile.
 *
 * - In `add` mode, never resets (new profiles start with undefined verdict).
 * - In `edit` mode, inspects the existing profile and clears the verdict if
 *   any of {model, serverUrl, apiKey, providerType, customProviderId} changed.
 *   If the profile is not found (shouldn't normally happen), returns the
 *   incoming profile unchanged.
 */
export function saveProfileWithResetGuard(
  mode: 'add' | 'edit',
  incoming: ModelProfile,
  existing: ModelProfile[],
): ModelProfile {
  if (mode === 'add') return incoming;

  const original = existing.find((p) => p.id === incoming.id);
  if (!original) return incoming;

  const changed = CONNECTION_RELEVANT_FIELDS.some(
    (field) => original[field] !== incoming[field],
  );
  if (!changed) return incoming;

  return {
    ...incoming,
    chatCompatibility: undefined,
    chatCompatibilityCheckedAt: undefined,
    jsonCompatibility: undefined,
    jsonCompatibilityCheckedAt: undefined,
    thinkingCompatibility: undefined,
    thinkingCompatibilityCheckedAt: undefined,
  };
}

/**
 * Returns the user-facing label for a profile's provider.
 *
 * - Known presets (`openai`, `google`, …) return the preset label.
 * - Custom providers return the provider's name.
 * - Orphaned `customProviderId` (provider deleted) returns "Provider removed".
 * - `providerType === 'local'` returns "Local".
 * - Unknown / missing falls back to the profile's serverUrl.
 */
export function getProviderDisplayLabel(
  profile: ModelProfile,
  customProviders: CustomProvider[] = [],
): string {
  // A custom provider is referenced explicitly when the profile carries a
  // customProviderId. This can happen for either providerType 'other' or no
  // providerType at all on older profiles — be permissive.
  if (profile.customProviderId) {
    const match = customProviders.find((cp) => cp.id === profile.customProviderId);
    if (match) return match.name;
    return 'Provider removed';
  }

  if (profile.providerType === 'local') return 'Local';

  if (profile.providerType === 'anthropic') return 'Anthropic';

  if (profile.providerType && profile.providerType !== 'other') {
    const preset = PROVIDER_PRESETS[profile.providerType];
    if (preset) return preset.label;
  }

  return profile.serverUrl || 'Custom';
}

/**
 * Derive a default user-facing profile name from provider + model selection.
 *
 * Used by the picker to auto-fill the name when no explicit input exists. For
 * preset providers the format is `{Provider} / {Model Label} — {Effort} Thinking`
 * (effort suffix only when the model supports reasoning and an effort is set).
 * For `other` / custom providers the format is `{ProviderName} / {Model}`.
 */
export function deriveProfileName(
  providerType: ModelProviderType | undefined,
  selectedModel?: ModelOption,
  customModelName?: string,
  options?: { providerLabel?: string; reasoningEffort?: ThinkingEffort },
): string {
  const modelId = selectedModel?.value ?? customModelName?.trim() ?? '';
  const modelLabel = selectedModel?.label ?? customModelName?.trim() ?? '';
  if (!modelId) return '';

  const supportsReasoning = selectedModel ? selectedModel.reasoning !== false : true;

  const effortSuffix =
    supportsReasoning && options?.reasoningEffort
      ? ` \u2014 ${thinkingLabel(options.reasoningEffort)} Thinking`
      : '';

  if (
    providerType &&
    providerType !== 'other' &&
    providerType !== 'anthropic' &&
    providerType !== 'local' &&
    PROVIDER_PRESETS[providerType]
  ) {
    const providerLabel =
      options?.providerLabel ?? PROVIDER_PRESETS[providerType].label;
    return `${providerLabel} / ${modelLabel}${effortSuffix}`;
  }

  const providerLabel = options?.providerLabel ?? 'Custom';
  return `${providerLabel} / ${modelLabel}${effortSuffix}`;
}

/** Human-facing label for a thinking-effort value (matches THINKING_LEVELS). */
export function thinkingLabel(effort: ThinkingEffort): string {
  const match = THINKING_LEVELS.find((level) => level.value === effort);
  return match?.label ?? 'Medium';
}
