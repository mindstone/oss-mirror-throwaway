import { PROVIDER_PRESETS } from '@shared/data/modelProviderPresets';
import type { ModelProfile, ModelProviderType } from '@shared/types';
import { shortModelName } from '@shared/utils/modelDisplayUtils';
import { formatSubAgentName } from './subAgentTimeline';

const COUNCIL_PREFIX = 'council-';
const MODEL_PREFIX = 'model-';
const PROFILE_COLLISION_SUFFIX_PATTERN = /-(profile-[a-z0-9]*)$/;

type ProviderPresetType = Exclude<ModelProviderType, 'anthropic' | 'other' | 'local'>;

type PresetModelInfo = {
  label: string;
  provider: string;
  providerType: ProviderPresetType;
};

export type ModelAgentInfo = {
  label: string;
  provider?: string;
  providerType?: ModelProviderType;
  isModelAgent: boolean;
  isCouncil: boolean;
};

export { shortModelName };

const slugifyProfileName = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

let presetModelLookup: Map<string, PresetModelInfo> | null = null;

const buildPresetDisplayLookup = (): Map<string, PresetModelInfo> => {
  const lookup = new Map<string, PresetModelInfo>();

  for (const preset of Object.values(PROVIDER_PRESETS)) {
    for (const model of preset.models) {
      const info: PresetModelInfo = {
        label: model.label,
        provider: preset.label,
        providerType: preset.type as ProviderPresetType
      };

      const keys = new Set<string>([
        model.value.toLowerCase(),
        slugifyProfileName(model.value),
        slugifyProfileName(model.label)
      ]);

      for (const key of keys) {
        if (key) {
          lookup.set(key, info);
        }
      }
    }
  }

  return lookup;
};

const getPresetDisplayLookup = (): Map<string, PresetModelInfo> => {
  if (!presetModelLookup) {
    presetModelLookup = buildPresetDisplayLookup();
  }

  return presetModelLookup;
};

const getProviderLabel = (providerType?: ModelProviderType): string | undefined => {
  if (!providerType || providerType === 'other' || providerType === 'local') {
    return providerType === 'local' ? 'Local (Ollama)' : undefined;
  }
  if (providerType === 'anthropic') {
    return 'Anthropic';
  }

  return PROVIDER_PRESETS[providerType]?.label;
};

const stripCollisionSuffix = (slug: string): string =>
  slug.replace(PROFILE_COLLISION_SUFFIX_PATTERN, '');

const coerceType = (subagentType: unknown): string =>
  (typeof subagentType === 'string' ? subagentType.trim() : '');

const normalizeType = (subagentType: unknown): string =>
  coerceType(subagentType).toLowerCase();

const prettifyModelSlug = (slug: string, fallback: string): string => {
  const value = slug.trim() || fallback.trim();
  return formatSubAgentName(value);
};

type ParsedModelAgentType = {
  isCouncil: boolean;
  slug: string;
};

const parseModelAgentType = (subagentType: unknown): ParsedModelAgentType | null => {
  const normalized = normalizeType(subagentType);
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith(COUNCIL_PREFIX)) {
    return {
      isCouncil: true,
      slug: normalized.slice(COUNCIL_PREFIX.length)
    };
  }

  if (normalized.startsWith(MODEL_PREFIX)) {
    return {
      isCouncil: false,
      slug: normalized.slice(MODEL_PREFIX.length)
    };
  }

  return null;
};

const resolveFromProfile = (
  slug: string,
  profiles?: ModelProfile[]
): { profile: ModelProfile; presetModel?: PresetModelInfo } | null => {
  if (!profiles?.length) {
    return null;
  }

  const matchedProfile = profiles.find((profile) => slugifyProfileName(profile.name) === slug);
  if (!matchedProfile) {
    return null;
  }

  const lookup = getPresetDisplayLookup();
  const normalizedModel = matchedProfile.model?.trim();
  const presetModel = normalizedModel
    ? lookup.get(normalizedModel.toLowerCase()) || lookup.get(slugifyProfileName(normalizedModel))
    : undefined;

  return {
    profile: matchedProfile,
    presetModel
  };
};

const resolveFromPreset = (slug: string): PresetModelInfo | undefined =>
  getPresetDisplayLookup().get(slug);

export const resolveModelAgentInfo = (
  subagentType: string | undefined,
  profiles?: ModelProfile[]
): ModelAgentInfo => {
  const rawType = coerceType(subagentType);
  const parsed = parseModelAgentType(rawType);
  if (!parsed) {
    return {
      label: formatSubAgentName(rawType),
      isModelAgent: false,
      isCouncil: false
    };
  }

  // Try original slug first, then with collision suffix stripped.
  // This avoids over-stripping slugs that legitimately end with profile-like text.
  const strippedSlug = stripCollisionSuffix(parsed.slug);
  const fallbackLabel = prettifyModelSlug(strippedSlug, rawType);

  const profileMatch =
    resolveFromProfile(parsed.slug, profiles) ??
    (parsed.slug !== strippedSlug ? resolveFromProfile(strippedSlug, profiles) : null);
  if (profileMatch) {
    const providerType = profileMatch.profile.providerType ?? profileMatch.presetModel?.providerType;
    const provider = getProviderLabel(providerType) ?? profileMatch.presetModel?.provider;

    return {
      label: profileMatch.presetModel?.label || profileMatch.profile.name.trim() || fallbackLabel,
      provider,
      providerType,
      isModelAgent: true,
      isCouncil: parsed.isCouncil
    };
  }

  const presetMatch =
    resolveFromPreset(parsed.slug) ??
    (parsed.slug !== strippedSlug ? resolveFromPreset(strippedSlug) : undefined);
  if (presetMatch) {
    return {
      label: presetMatch.label,
      provider: presetMatch.provider,
      providerType: presetMatch.providerType,
      isModelAgent: true,
      isCouncil: parsed.isCouncil
    };
  }

  return {
    label: fallbackLabel,
    isModelAgent: true,
    isCouncil: parsed.isCouncil
  };
};
