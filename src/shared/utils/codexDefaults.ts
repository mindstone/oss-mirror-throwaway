/**
 * Codex (ChatGPT Pro Subscription) Default Settings
 *
 * Provides default model configuration when a user connects via Codex.
 * Creates auto-generated model profiles so that clientFactory.ts routes through
 * the OpenAI client path. The local proxy detects profiles with providerType 'openai'
 * + no API key + Codex connected, and routes through the Codex backend.
 *
 * @see docs/plans/260504_unified_provider_model_presentation.md
 */

import type { AppSettings, ModelProfile, LocalModelSettings } from '../types';
import { materializeModelsFromLegacy } from './modelSettingsResolver';
import { CODEX_DEFAULT_MODEL, CODEX_DEFAULT_BTS_MODEL } from './providerDefaultConstants';

export { CODEX_DEFAULT_MODEL, CODEX_DEFAULT_BTS_MODEL };
const OPENAI_SERVER_URL = 'https://api.openai.com/v1';
const normalizeProviderKey = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Deterministic profile IDs for Codex auto-generated profiles */
export const CODEX_WORKING_PROFILE_ID = 'codex-gpt-5.5';
export const CODEX_BTS_PROFILE_ID = 'codex-gpt-5.4-mini';
/** Legacy profile ID from before the GPT-5.4 -> 5.5 upgrade */
const CODEX_LEGACY_WORKING_PROFILE_ID = 'codex-gpt-5.4';
const CODEX_AUTO_PROFILE_IDS = new Set<string>([
  CODEX_WORKING_PROFILE_ID,
  CODEX_BTS_PROFILE_ID,
  CODEX_LEGACY_WORKING_PROFILE_ID,
]);

export function isCodexAutoProfile(profile: Pick<ModelProfile, 'id'>): boolean {
  return CODEX_AUTO_PROFILE_IDS.has(profile.id);
}

export function isCodexAutoProfileValue(value: string): boolean {
  if (!value.startsWith('profile:')) return false;
  return CODEX_AUTO_PROFILE_IDS.has(value.slice('profile:'.length));
}

export function resolveStaleModelHintText(hiddenValue: string): string {
  return isCodexAutoProfileValue(hiddenValue)
    ? 'Previous model hidden — reconnect ChatGPT Pro or pick another'
    : 'Previous model no longer available for current provider';
}

const CODEX_WORKING_PROFILE: ModelProfile = {
  id: CODEX_WORKING_PROFILE_ID,
  name: 'GPT-5.5 (ChatGPT Pro)',
  authSource: 'codex-subscription',
  model: CODEX_DEFAULT_MODEL,
  providerType: 'openai',
  profileSource: 'auto',
  serverUrl: OPENAI_SERVER_URL,
  reasoningEffort: 'high',
  createdAt: 0,
};

const CODEX_BTS_PROFILE: ModelProfile = {
  id: CODEX_BTS_PROFILE_ID,
  name: 'GPT-5.4 mini (ChatGPT Pro)',
  authSource: 'codex-subscription',
  model: CODEX_DEFAULT_BTS_MODEL,
  providerType: 'openai',
  profileSource: 'auto',
  serverUrl: OPENAI_SERVER_URL,
  createdAt: 0,
};

/**
 * Strip persisted runtime capability flags before re-seeding an auto profile
 * from constants.
 *
 * Auto profiles are filtered out of LocalModelSection (they cannot be edited
 * or re-tested through the UI), so any persisted `*Compatibility` value would
 * silently lock the resolver out of the user's chosen model with no recovery
 * path. The marker guards in `behindTheScenesClient.ts` (A0) prevent fresh
 * writes; this is the defensive heal for legacy state created before those
 * guards landed (260521 BTS Haiku-fallback investigation, A4).
 *
 * Exported so first-boot migrations can heal auto profiles even when
 * `mergeCodexProfiles` does not run (e.g. users past the codex-repair schema
 * version on a non-Codex active provider).
 */
export function stripAutoProfileCapabilityFlags(profile: ModelProfile): ModelProfile {
  if (
    profile.chatCompatibility === undefined &&
    profile.chatCompatibilityCheckedAt === undefined &&
    profile.jsonCompatibility === undefined &&
    profile.jsonCompatibilityCheckedAt === undefined &&
    profile.thinkingCompatibility === undefined &&
    profile.thinkingCompatibilityCheckedAt === undefined &&
    profile.toolUseCompatibility === undefined &&
    profile.toolUseCompatibilityCheckedAt === undefined
  ) {
    return profile;
  }
  const {
    chatCompatibility: _c,
    chatCompatibilityCheckedAt: _cAt,
    jsonCompatibility: _j,
    jsonCompatibilityCheckedAt: _jAt,
    thinkingCompatibility: _t,
    thinkingCompatibilityCheckedAt: _tAt,
    toolUseCompatibility: _tu,
    toolUseCompatibilityCheckedAt: _tuAt,
    ...rest
  } = profile;
  return rest;
}

export function mergeCodexProfiles(existingProfiles: ModelProfile[]): ModelProfile[] {
  const userProfiles = existingProfiles.filter(p => !isCodexAutoProfile(p));
  return [
    ...userProfiles,
    stripAutoProfileCapabilityFlags(CODEX_WORKING_PROFILE),
    stripAutoProfileCapabilityFlags(CODEX_BTS_PROFILE),
  ];
}

export interface CodexRepairResult {
  repaired: boolean;
  before: {
    workingProfileId: string | undefined;
    model: string | undefined;
    btsModel: string | undefined;
    profileIds: string[];
  };
  after: {
    workingProfileId: string;
    model: string;
    btsModel: string;
    profileIds: string[];
  };
}

export function parseBtsProfileId(value: string | null | undefined): string | null {
  if (!value?.startsWith('profile:')) return null;
  const profileId = value.slice('profile:'.length).trim();
  return profileId.length > 0 ? profileId : null;
}

const profileIdsFrom = (profiles: ModelProfile[]): Set<string> =>
  new Set(profiles.map((profile) => profile.id));

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

type ModelSettingsLike = Partial<NonNullable<AppSettings['models']>>;

export function needsWorkingProfileRepair(settings: AppSettings, profiles: ModelProfile[]): boolean {
  const workingProfileId = optionalString(materializeModelsFromLegacy(settings).workingProfileId);
  if (!workingProfileId) return true;
  return !profileIdsFrom(profiles).has(workingProfileId);
}

export function needsModelRepair(settings: AppSettings): boolean {
  const model = optionalString(materializeModelsFromLegacy(settings).model);
  if (!model) return true;

  const normalized = model.toLowerCase();
  return normalized.includes('claude') ||
    normalized === 'gpt-5.4' ||
    normalized === CODEX_LEGACY_WORKING_PROFILE_ID;
}

export function needsBtsRepair(settings: AppSettings, profiles: ModelProfile[]): boolean {
  const btsModel = optionalString(settings.behindTheScenesModel);
  if (!btsModel) return true;

  const btsProfileId = parseBtsProfileId(btsModel);
  if (btsProfileId) {
    return !profileIdsFrom(profiles).has(btsProfileId);
  }

  const normalized = btsModel.toLowerCase();
  return normalized.includes('claude') ||
    normalized === 'gpt-5.4' ||
    normalized === CODEX_LEGACY_WORKING_PROFILE_ID;
}

function shouldClearThinkingFields(
  currentModels: ModelSettingsLike,
  mergedProfiles: ModelProfile[],
): boolean {
  const tpId = optionalString(currentModels.thinkingProfileId);
  const tm = optionalString(currentModels.thinkingModel);
  if (!tpId && !tm) return false;

  // 1. thinkingProfileId references state that won't survive the merge.
  //    Clear if the profile is dropped by mergeCodexProfiles, or if the
  //    surviving profile's model is Claude-typed (a leftover Anthropic
  //    selection from a pre-Codex configuration).
  if (tpId) {
    const profile = mergedProfiles.find((p) => p.id === tpId);
    if (!profile) return true;
    if (profile.model && profile.model.toLowerCase().includes('claude')) return true;
  }

  // 2. thinkingModel still names a Claude or stale-Codex default.
  //    Mirrors needsModelRepair's stale-string detection.
  if (tm) {
    const lower = tm.toLowerCase();
    if (lower.includes('claude')) return true;
    if (lower === 'gpt-5.4' || lower === CODEX_LEGACY_WORKING_PROFILE_ID) return true;
  }

  // Otherwise: the user has intentionally configured a non-Claude thinking
  // model for plan mode + adaptive routing. Preserve it.
  return false;
}

const profilesEqual = (left: ModelProfile[], right: ModelProfile[]): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export function repairCodexProfileState(settings: AppSettings): {
  changes: Partial<AppSettings>;
  result: CodexRepairResult;
} {
  const localModel = settings.localModel;
  let existingProfiles: ModelProfile[];
  if (localModel === undefined) {
    existingProfiles = [];
  } else {
    const rawProfiles: unknown = localModel.profiles;
    if (rawProfiles === undefined) {
      existingProfiles = [];
    } else if (!Array.isArray(rawProfiles)) {
      throw new Error(
        `repairCodexProfileState: localModel.profiles is not an array, got ${
          rawProfiles === null ? 'null' : typeof rawProfiles
        }`
      );
    } else {
      existingProfiles = rawProfiles;
    }
  }

  const modelSettings = materializeModelsFromLegacy(settings);
  const before = {
    workingProfileId: optionalString(modelSettings.workingProfileId),
    model: optionalString(modelSettings.model),
    btsModel: optionalString(settings.behindTheScenesModel),
    profileIds: existingProfiles.map((profile) => profile.id),
  };

  const mergedProfiles = mergeCodexProfiles(existingProfiles);
  const newWorkingProfileId = needsWorkingProfileRepair(settings, mergedProfiles)
    ? CODEX_WORKING_PROFILE_ID
    : optionalString(modelSettings.workingProfileId) ?? CODEX_WORKING_PROFILE_ID;
  const newModel = needsModelRepair(settings)
    ? CODEX_DEFAULT_MODEL
    : optionalString(modelSettings.model) ?? CODEX_DEFAULT_MODEL;
  const newBtsModel = needsBtsRepair(settings, mergedProfiles)
    ? `profile:${CODEX_BTS_PROFILE_ID}`
    : optionalString(settings.behindTheScenesModel) ?? `profile:${CODEX_BTS_PROFILE_ID}`;

  const changes: Partial<AppSettings> = {};
  if (!profilesEqual(existingProfiles, mergedProfiles)) {
    changes.localModel = {
      ...(settings.localModel ?? { profiles: [], activeProfileId: null }),
      profiles: mergedProfiles,
    } as LocalModelSettings;
  }

  const currentModels = materializeModelsFromLegacy(settings);
  const clearThinking = shouldClearThinkingFields(currentModels, mergedProfiles);
  const shouldUpdateModels =
    optionalString(currentModels.workingProfileId) !== newWorkingProfileId ||
    optionalString(currentModels.model) !== newModel ||
    (clearThinking && (
      currentModels.thinkingProfileId !== undefined ||
      currentModels.thinkingModel !== undefined
    ));
  if (shouldUpdateModels) {
    changes.models = {
      ...currentModels,
      workingProfileId: newWorkingProfileId,
      model: newModel,
      ...(clearThinking
        ? { thinkingProfileId: undefined, thinkingModel: undefined }
        : {}),
    } as NonNullable<AppSettings['models']>;
  }

  if (settings.behindTheScenesModel !== newBtsModel) {
    changes.behindTheScenesModel = newBtsModel;
  }

  const after = {
    workingProfileId: newWorkingProfileId,
    model: newModel,
    btsModel: newBtsModel,
    profileIds: mergedProfiles.map((profile) => profile.id),
  };
  const repaired = Object.keys(changes).length > 0;
  return { changes, result: { repaired, before, after } };
}

/**
 * Returns a partial settings object with Codex-specific structural requirements.
 * Tier/default model selection is handled by planProviderSwitch().
 */
export function applyCodexModelDefaults(settings: AppSettings): Partial<AppSettings> {
  const existingProfiles = settings.localModel?.profiles ?? [];
  const normalizedOpenAiKey = normalizeProviderKey(settings.providerKeys?.openai);
  const providerKeys =
    settings.providerKeys && settings.providerKeys.openai !== normalizedOpenAiKey
      ? {
          ...settings.providerKeys,
          openai: normalizedOpenAiKey,
        }
      : undefined;

  return {
    localModel: {
      ...(settings.localModel ?? { profiles: [], activeProfileId: null }),
      profiles: mergeCodexProfiles(existingProfiles),
    } as LocalModelSettings,
    ...(providerKeys ? { providerKeys } : {}),
  };
}
