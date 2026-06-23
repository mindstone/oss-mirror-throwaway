import { decodePrefixed } from './modelChoiceCodec';
import { getDefaultModelForProvider } from './getDefaultModelForProvider';
import { PROFILE_PREFIX } from './modelChoiceCodec';
import { resolveModelSettings } from './modelSettingsResolver';
import { getWorkingModelProfile, type AppSettings } from '@shared/types';

export type AuxiliaryTurnConfig =
  | { mode: 'single_model'; model: string }
  | { mode: 'explicit_planning'; planningModel: string; reason: string }
  | { mode: 'inherit_user_session'; reason: string };

export interface SingleModelAuxiliaryTurnModelOverrides {
  modelOverride?: string;
  workingProfileOverrideId?: string;
  thinkingModelOverride: string;
}

export interface InheritedUserSessionAuxiliaryTurnModelOverrides {
  modelOverride?: undefined;
  workingProfileOverrideId?: undefined;
  thinkingModelOverride: undefined;
}

export type AuxiliaryTurnModelOverrides =
  | SingleModelAuxiliaryTurnModelOverrides
  | InheritedUserSessionAuxiliaryTurnModelOverrides;

export type SingleModelAuxiliaryTurnConfig = Extract<AuxiliaryTurnConfig, { mode: 'single_model' }>;
type ExplicitPlanningAuxiliaryTurnConfig = Extract<AuxiliaryTurnConfig, { mode: 'explicit_planning' }>;
type InheritUserSessionAuxiliaryTurnConfig = Extract<AuxiliaryTurnConfig, { mode: 'inherit_user_session' }>;

export function createActiveWorkingSingleModelAuxiliaryTurnConfig(
  settings: AppSettings,
): SingleModelAuxiliaryTurnConfig {
  const activeProfile = getWorkingModelProfile(settings);
  if (activeProfile?.id) {
    return { mode: 'single_model', model: `${PROFILE_PREFIX}${activeProfile.id}` };
  }

  const resolvedModelSettings = resolveModelSettings(settings);
  const configuredWorkingModel = typeof resolvedModelSettings.model === 'string'
    ? resolvedModelSettings.model.trim()
    : '';
  return {
    mode: 'single_model',
    model: configuredWorkingModel || getDefaultModelForProvider(settings, 'working'),
  };
}

export function resolveActiveWorkingSingleModelAuxiliaryTurnOverrides(
  settings: AppSettings,
): SingleModelAuxiliaryTurnModelOverrides {
  return resolveAuxiliaryTurnModelOverrides(createActiveWorkingSingleModelAuxiliaryTurnConfig(settings));
}

export function resolveAuxiliaryTurnModelOverrides(
  config: SingleModelAuxiliaryTurnConfig,
): SingleModelAuxiliaryTurnModelOverrides;
export function resolveAuxiliaryTurnModelOverrides(
  config: ExplicitPlanningAuxiliaryTurnConfig,
): SingleModelAuxiliaryTurnModelOverrides;
export function resolveAuxiliaryTurnModelOverrides(
  config: InheritUserSessionAuxiliaryTurnConfig,
): InheritedUserSessionAuxiliaryTurnModelOverrides;
export function resolveAuxiliaryTurnModelOverrides(
  config: AuxiliaryTurnConfig,
): AuxiliaryTurnModelOverrides {
  if (config.mode === 'inherit_user_session') {
    return {
      modelOverride: undefined,
      workingProfileOverrideId: undefined,
      thinkingModelOverride: undefined,
    };
  }

  if (config.mode === 'explicit_planning') {
    return {
      thinkingModelOverride: config.planningModel,
    };
  }

  const decoded = decodePrefixed(config.model);
  if (decoded?.kind === 'profile' && decoded.profileId) {
    return {
      modelOverride: undefined,
      workingProfileOverrideId: decoded.profileId,
      thinkingModelOverride: '',
    };
  }

  return {
    modelOverride: config.model,
    workingProfileOverrideId: '',
    thinkingModelOverride: '',
  };
}
