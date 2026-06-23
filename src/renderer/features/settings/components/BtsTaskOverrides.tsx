import { useCallback, useMemo } from 'react';
import { Notice } from '@renderer/components/ui';
import { BTS_TASK_GROUPS, BTS_TASK_GROUP_KEYS, type BtsTaskGroup } from '@shared/utils/btsModelResolver';
import type { ActiveProvider, AppSettings, ModelProfile } from '@shared/types';
import { isCodexAutoProfile, resolveStaleModelHintText } from '@shared/utils/codexDefaults';
import {
  isAutoProfileShadowedBySibling,
  isProfileSelectable,
} from '@shared/utils/profileHelpers';
import type { ModelChoice } from '@shared/types/modelChoice';
import { useManagedDefaults } from '@renderer/hooks/useManagedDefaults';
import { getApiKey } from '../utils/modelAuthAccessors';
import { buildModelChoiceOptions, type ModelChoiceOptions } from '../utils/buildModelChoiceOptions';
import {
  choiceToPickerValue,
  ModelChoicePicker,
  pickerValueToChoice,
} from './models/ModelChoicePicker';
import styles from './SettingsSurface.module.css';

interface BtsTaskOverridesProps {
  settings: AppSettings;
  overrides: Partial<Record<BtsTaskGroup, string>> | undefined;
  onOverrideChange: (group: BtsTaskGroup, value: string | undefined) => void;
  localModelProfiles: ModelProfile[];
  activeProvider?: ActiveProvider;
  codexConnected: boolean;
  additionalAuxGroups?: Array<{ label: string; options: { value: string; label: string; auxiliaryHint?: string }[] }>;
}

function BtsTaskOverrideRow({
  group,
  currentValue,
  onOverrideChange,
  modelChoiceOptions,
  settings,
  codexConnected,
  activeProvider,
  effectiveProfiles,
  profileHealthProfiles,
}: {
  group: BtsTaskGroup;
  currentValue: string;
  onOverrideChange: (group: BtsTaskGroup, value: string | undefined) => void;
  modelChoiceOptions: ModelChoiceOptions;
  settings: AppSettings;
  codexConnected: boolean;
  activeProvider?: ActiveProvider;
  effectiveProfiles: ModelProfile[];
  profileHealthProfiles: readonly ModelProfile[];
}) {
  const config = BTS_TASK_GROUPS[group];
  const currentChoice = useMemo<ModelChoice>(() => pickerValueToChoice(currentValue), [currentValue]);
  const pickerValue = choiceToPickerValue(currentChoice);
  const shouldShowMissingProfileNotice = useMemo(() => {
    if (currentChoice.kind !== 'profile') return false;
    const profile = profileHealthProfiles.find((candidate) => candidate.id === currentChoice.profileId);
    if (!profile) return true;
    if (profile.enabled === false) return true;
    if (!profile.model?.trim()) return true;
    if (!isProfileSelectable(profile)) return true;
    return false;
  }, [currentChoice, profileHealthProfiles]);
  const handlePickAnotherModel = useCallback(() => {
    document.getElementById(`bts-override-${group}`)?.focus();
  }, [group]);
  const hiddenJsonIncompatibleProfile = useMemo(() => {
    if (!config.requiresJson || currentChoice.kind !== 'profile') return null;
    const currentProfileId = currentChoice.profileId;
    const currentProfile = effectiveProfiles.find(profile => profile.id === currentProfileId);
    return currentProfile?.jsonCompatibility === 'incompatible' ? currentProfile : null;
  }, [config.requiresJson, currentChoice, effectiveProfiles]);
  const missingProfileLabelResolver = useCallback((profileId: string) => {
    if (hiddenJsonIncompatibleProfile?.id !== profileId) return undefined;
    return `${profileDisplayName(hiddenJsonIncompatibleProfile)} — not available for this task`;
  }, [hiddenJsonIncompatibleProfile]);
  const visiblePickerValues = useMemo(() => {
    const values = new Set<string>(['']);
    for (const option of modelChoiceOptions.catalogModels) {
      values.add(option.value);
    }
    for (const group of modelChoiceOptions.additionalModelGroups ?? []) {
      for (const option of group.options) {
        values.add(option.value);
      }
    }
    for (const profile of modelChoiceOptions.profiles) {
      values.add(`profile:${profile.id}`);
    }
    return values;
  }, [modelChoiceOptions]);
  const valueIsVisible = pickerValue === '' || visiblePickerValues.has(pickerValue);
  const hiddenModelHint = hiddenJsonIncompatibleProfile
    ? `${hiddenJsonIncompatibleProfile.name} is marked No JSON and cannot be used for this task. Pick another model.`
    : resolveStaleModelHintText(currentValue);

  return (
    <div style={{ maxWidth: '360px', marginBottom: '6px' }}>
      <div className={styles.compactSelect}>
        <label htmlFor={`bts-override-${group}`}>{config.label}</label>
        <ModelChoicePicker
          role="background"
          value={currentChoice}
          onChange={(nextChoice) => {
            const encodedValue = choiceToPickerValue(nextChoice);
            onOverrideChange(group, encodedValue === '' ? undefined : encodedValue);
          }}
          profiles={modelChoiceOptions.profiles}
          catalogModels={modelChoiceOptions.catalogModels}
          additionalModelGroups={modelChoiceOptions.additionalModelGroups}
          settings={settings}
          codexConnected={codexConnected}
          activeProvider={activeProvider}
          htmlFor={`bts-override-${group}`}
          includeOffOption
          offLabel={config.defaultLabel ?? 'Same as Behind the Scenes'}
          missingProfileLabelResolver={missingProfileLabelResolver}
        />
      </div>
      {!valueIsVisible && !shouldShowMissingProfileNotice && (
        <span className={styles.modelConfigHint} style={{ display: 'block', marginTop: '4px', paddingLeft: 0 }}>
          {hiddenModelHint}
        </span>
      )}
      {shouldShowMissingProfileNotice && (
        <Notice
          tone="warning"
          density="compact"
          placement="inline"
          actions={[{
            label: 'Pick another model',
            onClick: handlePickAnotherModel,
            'data-testid': `bts-task-override-${group}-missing-profile-cta`,
          }]}
          data-testid={`bts-task-override-${group}-missing-profile-notice`}
        >
          This profile is no longer available. Using default model for this task for now.
        </Notice>
      )}
    </div>
  );
}

function profileDisplayName(profile: ModelProfile): string {
  return profile.name || profile.model || profile.id;
}

function modelChoiceSettingsWithProfiles(settings: AppSettings, profiles: ModelProfile[]): AppSettings {
  return {
    ...settings,
    localModel: {
      ...(settings.localModel ?? {}),
      profiles,
    },
  } as AppSettings;
}

function hasOpenRouterCredentials(settings: AppSettings): boolean {
  return !!settings.openRouter?.oauthToken;
}

function buildBtsModelChoiceOptions({
  group,
  settings,
  activeProvider,
  hasAnthropicCredentials,
  hasOpenRouterCredentials: hasOpenRouter,
  managedAllowedModels,
}: {
  group: BtsTaskGroup;
  settings: AppSettings;
  activeProvider?: ActiveProvider;
  hasAnthropicCredentials: boolean;
  hasOpenRouterCredentials: boolean;
  managedAllowedModels?: string[];
}): ModelChoiceOptions {
  const config = BTS_TASK_GROUPS[group];
  return buildModelChoiceOptions({
    role: 'background',
    taskGroup: group,
    settings,
    activeProvider,
    hasAnthropicCredentials,
    hasOpenRouterCredentials: hasOpenRouter,
    managedAllowedModels,
    profileFilter: (profile) => {
      if (!config.requiresJson) return true;
      return profile.jsonCompatibility !== 'incompatible';
    },
  });
}

function BtsTaskOverrideRows({
  settings,
  overrides,
  onOverrideChange,
  activeProvider,
  codexConnected,
  effectiveProfiles,
}: {
  settings: AppSettings;
  overrides: Partial<Record<BtsTaskGroup, string>> | undefined;
  onOverrideChange: (group: BtsTaskGroup, value: string | undefined) => void;
  activeProvider?: ActiveProvider;
  codexConnected: boolean;
  effectiveProfiles: ModelProfile[];
}) {
  const modelChoiceSettings = useMemo(
    () => modelChoiceSettingsWithProfiles(settings, effectiveProfiles),
    [effectiveProfiles, settings],
  );
  const hasAnthropicCredentials = !!getApiKey(settings);
  const canUseOpenRouter = hasOpenRouterCredentials(settings);
  const { managedAllowedModels } = useManagedDefaults();
  const profileHealthProfiles = settings.localModel?.profiles ?? effectiveProfiles;
  const optionsByGroup = useMemo(
    () =>
      BTS_TASK_GROUP_KEYS.reduce<Record<BtsTaskGroup, ModelChoiceOptions>>((acc, group) => {
        acc[group] = buildBtsModelChoiceOptions({
          group,
          settings: modelChoiceSettings,
          activeProvider,
          hasAnthropicCredentials,
          hasOpenRouterCredentials: canUseOpenRouter,
          managedAllowedModels,
        });
        return acc;
      }, {} as Record<BtsTaskGroup, ModelChoiceOptions>),
    [activeProvider, canUseOpenRouter, hasAnthropicCredentials, managedAllowedModels, modelChoiceSettings],
  );

  return (
    <>
      {BTS_TASK_GROUP_KEYS.map((group) => (
        <BtsTaskOverrideRow
          key={group}
          group={group}
          currentValue={overrides?.[group] ?? ''}
          onOverrideChange={onOverrideChange}
          modelChoiceOptions={optionsByGroup[group]}
          settings={modelChoiceSettings}
          codexConnected={codexConnected}
          activeProvider={activeProvider}
          effectiveProfiles={effectiveProfiles}
          profileHealthProfiles={profileHealthProfiles}
        />
      ))}
    </>
  );
}

export function BtsTaskOverrides(props: BtsTaskOverridesProps) {
  const {
    settings,
    overrides,
    onOverrideChange,
    localModelProfiles,
    activeProvider,
    codexConnected,
  } = props;
  const effectiveProfiles = useMemo(
    () => localModelProfiles.filter((profile) => {
      if (!isCodexAutoProfile(profile)) return true;
      if (isAutoProfileShadowedBySibling(profile, localModelProfiles)) return false;
      return activeProvider === 'codex';
    }),
    [activeProvider, localModelProfiles]
  );

  return (
    <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--color-border-soft, rgba(148, 163, 184, 0.15))' }}>
      <label style={{ display: 'block', marginBottom: '8px', fontWeight: 600, fontSize: '13px' }}>
        Per-task models
      </label>
      <BtsTaskOverrideRows
        settings={settings}
        overrides={overrides}
        onOverrideChange={onOverrideChange}
        activeProvider={activeProvider}
        codexConnected={codexConnected}
        effectiveProfiles={effectiveProfiles}
      />
      <p className={styles.modelConfigHint} style={{ marginTop: '6px' }}>
        Override specific background tasks. Everything else uses your Behind the Scenes model.
      </p>
    </div>
  );
}
