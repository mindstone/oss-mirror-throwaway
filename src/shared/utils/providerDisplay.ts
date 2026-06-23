import type { ModelProfile, ModelProviderType } from '../types';
import { isCodexAutoProfile } from './codexDefaults';
import { isConnectionManagedProfile } from './profileHelpers';

const PROVIDER_DISPLAY_NAMES: Record<ModelProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Gemini',
  together: 'Together',
  cerebras: 'Cerebras',
  openrouter: 'OpenRouter',
  other: 'Custom',
  local: 'Local',
};

export function getProviderDisplayName(providerType: ModelProviderType | undefined): string {
  return (providerType && PROVIDER_DISPLAY_NAMES[providerType]) ?? 'Custom';
}

export function getProfileProviderDisplayName(
  profile: Pick<ModelProfile, 'authSource' | 'providerType' | 'routeSurface'>,
): string {
  if (profile.authSource === 'codex-subscription' || profile.routeSurface === 'subscription') {
    return 'ChatGPT Pro';
  }
  return getProviderDisplayName(profile.providerType);
}

export function getProfileProviderSubtitle(
  profile: ModelProfile,
): string {
  if (!isConnectionManagedProfile(profile) && profile.profileSource !== 'auto') {
    return '';
  }
  if (
    isCodexAutoProfile(profile) ||
    profile.authSource === 'codex-subscription' ||
    profile.routeSurface === 'subscription'
  ) {
    return 'From ChatGPT Pro';
  }
  const displayName = getProviderDisplayName(profile.providerType);
  return `From your ${displayName} connection`;
}
