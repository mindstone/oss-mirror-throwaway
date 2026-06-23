import type { AppSettings, CustomProvider, ModelProfile, ProviderKeyId, ProviderKeys } from '../types';
import { CODEX_BTS_PROFILE_ID, CODEX_WORKING_PROFILE_ID } from './codexDefaults';

/**
 * Resolve a provider API key from settings.
 * Checks providerKeys first, then falls back to legacy locations.
 * Normalizes: trims whitespace, converts blank to null.
 */
export function getProviderKey(
  settings: Pick<AppSettings, 'providerKeys' | 'voice'>,
  provider: ProviderKeyId
): string | null {
  // Check providerKeys first (canonical source)
  const key = settings.providerKeys?.[provider];
  const normalized = normalizeApiKey(key);
  if (normalized) return normalized;

  // Legacy fallbacks
  if (provider === 'openai') {
    return normalizeApiKey(settings.voice?.openaiApiKey);
  }
  // No legacy fallback for 'google' (previously only in MCP config env vars)
  return null;
}

/** Trim whitespace, convert blank/undefined to null */
export function normalizeApiKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the effective API key for a model profile.
 * Resolution chain:
 * 1. profile.apiKey (explicit per-profile override)
 * 2. customProviders[profile.customProviderId].apiKey (user-defined provider)
 * 3. providerKeys[profile.providerType] (shared built-in provider key)
 * 4. null (no key available)
 */
export function resolveProfileApiKey(
  profile: Pick<ModelProfile, 'apiKey' | 'providerType' | 'customProviderId'> & { id?: string },
  providerKeys: ProviderKeys | undefined,
  customProviders?: CustomProvider[]
): string | null {
  const profileKey = normalizeApiKey(profile.apiKey);
  if (profileKey) return profileKey;

  if (profile.customProviderId && customProviders) {
    const cp = customProviders.find(p => p.id === profile.customProviderId);
    if (cp) return normalizeApiKey(cp.apiKey);
  }

  const providerType = profile.providerType;
  if (
    providerType &&
    providerType !== 'anthropic' &&
    providerType !== 'other' &&
    providerType !== 'local' &&
    providerKeys
  ) {
    // Codex profiles are tied to the user's ChatGPT Pro subscription via OAuth.
    // They must never fall back to the shared OpenAI API key, otherwise turns
    // get routed (and billed) through the user's personal API key instead of
    // subscription coverage. See REBEL-1DZ.
    if (isCodexSubscriptionProfile(profile)) {
      return null;
    }
    return normalizeApiKey(providerKeys[providerType as ProviderKeyId]);
  }

  return null;
}

export function isCodexSubscriptionProfile(
  profile: Pick<ModelProfile, 'authSource' | 'providerType' | 'apiKey' | 'customProviderId'> & { id?: string }
): boolean {
  if (profile.authSource === 'codex-subscription') {
    return true;
  }

  return (
    (profile.id === CODEX_WORKING_PROFILE_ID || profile.id === CODEX_BTS_PROFILE_ID) &&
    profile.providerType === 'openai' &&
    !normalizeApiKey(profile.apiKey) &&
    !profile.customProviderId
  );
}
