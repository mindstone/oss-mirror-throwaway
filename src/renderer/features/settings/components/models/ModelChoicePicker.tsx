import { useMemo } from 'react';
import { Button } from '@renderer/components/ui';
import { getCatalogEntryById, type ModelProvider } from '@shared/data/modelCatalog';
import type { ActiveProvider, AppSettings, ModelProfile } from '@shared/types';
import type { ModelChoice, RoleId } from '@shared/types/modelChoice';
import { roleSupports } from '@shared/types/modelChoice';
import { PROFILE_PREFIX, stripStoredModelPrefix } from '@shared/utils/modelChoiceCodec';
import {
  billingSourceLabelSuffix,
  resolveBillingSourceForOption,
} from '@shared/utils/billingSource';

export interface ModelChoicePickerProps {
  role: RoleId;
  value: ModelChoice;
  onChange: (next: ModelChoice) => void;
  profiles: readonly ModelProfile[];
  catalogModels: ReadonlyArray<{ value: string; label: string; group?: string }>;
  additionalModelGroups?: ReadonlyArray<{ label: string; options: ReadonlyArray<{ value: string; label: string }> }>;
  settings: AppSettings;
  codexConnected: boolean;
  activeProvider: ActiveProvider | string | undefined;
  htmlFor: string;
  className?: string;
  tabIndex?: number;
  disabled?: boolean;
  /** Show "+ Add availability fallback" affordance and emit through onAddFallback. Optional. */
  onAddFallback?: () => void;
  /** When true, render the special-values options (Off / Inherit / Auto) per role. */
  includeSpecialValues?: boolean;
  /** Fallback pickers need an Off option even for roles whose primary choice cannot be off. */
  includeOffOption?: boolean;
  /** Override the Off option label for contexts where empty means "Global". */
  offLabel?: string;
  /** Override the selected label when a persisted profile is known to the consumer but filtered out of this picker. */
  missingProfileLabelResolver?: (profileId: string) => string | undefined;
}

function activeProviderGroupLabel(activeProvider: ActiveProvider | string | undefined): string {
  switch (activeProvider) {
    case 'codex':
      return 'ChatGPT Pro';
    case 'mindstone':
      return 'Mindstone';
    case 'openrouter':
      return 'OpenRouter';
    case 'anthropic':
      return 'Claude';
    default:
      return 'Models';
  }
}

function catalogProviderGroupLabel(provider: ModelProvider): string {
  switch (provider) {
    case 'anthropic':
      return 'Claude';
    case 'openai':
      return 'OpenAI';
    case 'google':
      return 'Gemini';
    case 'openrouter':
      return 'OpenRouter';
    case 'deepseek':
      return 'DeepSeek';
    case 'xai':
      return 'xAI';
    case 'cerebras':
      return 'Cerebras';
    case 'together':
      return 'Together';
    case 'cohere':
      return 'Cohere';
    case 'local':
      return 'Local';
  }
}

export function choiceToPickerValue(choice: ModelChoice): string {
  switch (choice.kind) {
    case 'profile':
      return `${PROFILE_PREFIX}${choice.profileId}`;
    case 'model':
      return choice.modelId;
    case 'auto':
      return 'auto';
    case 'inherit':
      return 'inherit';
    case 'off':
      return '';
  }
}

export function pickerValueToChoice(value: string): ModelChoice {
  if (value === 'auto') return { kind: 'auto' };
  if (value === 'inherit') return { kind: 'inherit' };
  if (value === '') return { kind: 'off' };
  if (value.startsWith(PROFILE_PREFIX)) {
    return { kind: 'profile', profileId: value.slice(PROFILE_PREFIX.length) };
  }
  const decodedModelId = stripStoredModelPrefix(value);
  return { kind: 'model', modelId: decodedModelId ?? '' };
}

function specialOptionLabel(role: RoleId, kind: Extract<ModelChoice['kind'], 'auto' | 'inherit' | 'off'>): string {
  switch (kind) {
    case 'auto':
      return role === 'recovery' ? 'Automatic, recommended' : 'Automatic';
    case 'inherit':
      return 'Same as Working';
    case 'off':
      return role === 'thinking' ? 'Off (no plan mode)' : 'Off';
  }
}

function withBillingSuffix(
  option: { value: string; label: string },
  settings: AppSettings,
  codexConnected: boolean,
): { value: string; label: string } {
  return {
    value: option.value,
    label: `${option.label}${billingSourceLabelSuffix(
      resolveBillingSourceForOption(option.value, settings, codexConnected),
    )}`,
  };
}

export function ModelChoicePicker({
  role,
  value,
  onChange,
  profiles,
  catalogModels,
  additionalModelGroups,
  settings,
  codexConnected,
  activeProvider,
  htmlFor,
  className,
  tabIndex,
  disabled = false,
  onAddFallback,
  includeSpecialValues = false,
  includeOffOption = false,
  offLabel,
  missingProfileLabelResolver,
}: ModelChoicePickerProps) {
  const encodedValue = choiceToPickerValue(value);

  const catalogGroups = useMemo(() => {
    const groups = new Map<string, Array<{ value: string; label: string }>>();
    const defaultGroup = activeProviderGroupLabel(activeProvider);

    for (const option of catalogModels) {
      const label = option.group ?? defaultGroup;
      const existing = groups.get(label) ?? [];
      existing.push(withBillingSuffix(option, settings, codexConnected));
      groups.set(label, existing);
    }

    return Array.from(groups.entries()).map(([label, options]) => ({ label, options }));
  }, [activeProvider, catalogModels, codexConnected, settings]);

  const additionalGroupsWithBilling = useMemo(
    () =>
      additionalModelGroups?.map((group) => ({
        label: group.label,
        options: group.options.map((option) => withBillingSuffix(option, settings, codexConnected)),
      })) ?? [],
    [additionalModelGroups, codexConnected, settings],
  );

  const profileOptions = useMemo(
    () =>
      profiles.map((profile) => withBillingSuffix({
        value: `${PROFILE_PREFIX}${profile.id}`,
        label: profile.name || profile.model || profile.id,
      }, settings, codexConnected)),
    [codexConnected, profiles, settings],
  );

  const missingProfileOption = useMemo(() => {
    if (value.kind !== 'profile') return null;
    if (profiles.some((profile) => profile.id === value.profileId)) return null;
    return {
      value: `${PROFILE_PREFIX}${value.profileId}`,
      label: missingProfileLabelResolver?.(value.profileId) ?? 'Profile no longer available',
    };
  }, [missingProfileLabelResolver, profiles, value]);

  const missingModelOption = useMemo(() => {
    if (value.kind !== 'model') return null;
    const existsInCatalog = catalogModels.some((option) => option.value === value.modelId)
      || additionalModelGroups?.some((group) => group.options.some((option) => option.value === value.modelId));
    if (existsInCatalog) return null;
    const catalogEntry = getCatalogEntryById(value.modelId);
    // Suffix derives from the catalog entry's own provider so cross-provider
    // stale selections (e.g. an Anthropic model id while active provider is
    // Codex) render as "Opus 4.8 — Claude", not "Opus 4.8 — ChatGPT Pro".
    const friendlyLabel = catalogEntry?.displayLabel
      ? `${catalogEntry.displayLabel} — ${catalogProviderGroupLabel(catalogEntry.provider)}`
      : value.modelId;
    return {
      value: value.modelId,
      label: friendlyLabel,
    };
  }, [additionalModelGroups, catalogModels, value]);

  const renderSpecialOptions = includeSpecialValues || includeOffOption;
  const specialOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [];
    if ((includeSpecialValues && roleSupports(role, 'auto')) || value.kind === 'auto') {
      options.push({ value: 'auto', label: specialOptionLabel(role, 'auto') });
    }
    if (includeSpecialValues && roleSupports(role, 'inherit')) {
      options.push({ value: 'inherit', label: specialOptionLabel(role, 'inherit') });
    }
    if (includeOffOption || (includeSpecialValues && roleSupports(role, 'off')) || value.kind === 'off') {
      options.push({ value: '', label: offLabel ?? specialOptionLabel(role, 'off') });
    }
    return options;
  }, [includeOffOption, includeSpecialValues, offLabel, role, value.kind]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
      <select
        id={htmlFor}
        className={className}
        tabIndex={tabIndex}
        disabled={disabled}
        value={encodedValue}
        onChange={(event) => onChange(pickerValueToChoice(event.target.value))}
        style={{ flex: 1, minWidth: 0 }}
      >
        {renderSpecialOptions && specialOptions.length > 0 && (
          <optgroup label="Special">
            {specialOptions.map((option) => (
              <option key={`special-${option.value || 'off'}`} value={option.value}>
                {option.label}
              </option>
            ))}
          </optgroup>
        )}
        {missingProfileOption && (
          <option value={missingProfileOption.value}>{missingProfileOption.label}</option>
        )}
        {missingModelOption && (
          <option value={missingModelOption.value}>{missingModelOption.label}</option>
        )}
        {catalogGroups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.options.map((option) => (
              <option key={`${group.label}-${option.value}`} value={option.value}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ))}
        {additionalGroupsWithBilling.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.options.map((option) => (
              <option key={`${group.label}-${option.value}`} value={option.value}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ))}
        {profileOptions.length > 0 && (
          <optgroup label="Your Models">
            {profileOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {onAddFallback && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onAddFallback}
          aria-label="Add availability fallback"
          style={{ whiteSpace: 'nowrap' }}
        >
          + Add availability fallback
        </Button>
      )}
    </div>
  );
}
