/**
 * Shared profile helpers — used by both core (auto-learn writer, migration)
 * and renderer (settings UI, conversation model selector).
 *
 * See docs/plans/260503_unify_learned_limits_into_profiles.md.
 */
import type { ModelProfile, RouteSurface } from '../types';
import {
  getRegistryContextWindowForModel,
  getRegistryMaxOutputForModel,
} from '../data/modelProviderPresets';
import { normalizeCatalogModelId } from '../data/providerCatalogs';
import { isLocalhostUrl } from './urlHelpers';
import { isCodexAutoProfile } from './codexDefaults';

type LoopbackRoutableProfile = Pick<ModelProfile, 'providerType' | 'routeSurface'> & {
  serverUrl?: string;
};

export function classifyProfile(profile: ModelProfile): 'user' | 'connection' | 'auto' {
  return profile.profileSource ?? 'user';
}

export function isConnectionManagedProfile(profile: ModelProfile): boolean {
  return profile.profileSource === 'connection';
}

export function isUserAddedProfile(profile: ModelProfile): boolean {
  return classifyProfile(profile) === 'user';
}

/**
 * True when the profile's `contextWindow` represents a user-set value (and
 * therefore must NOT be overwritten by the runtime auto-learn).
 *
 * `'user'` source is dispositive. `'auto'` is dispositive in the other
 * direction. For legacy data (source absent) we fall back to the heuristic
 * "value differs from the registry default" — which is safe because, before
 * Stage 2, the only way `contextWindow` could differ from the registry was
 * a manual entry (auto-learn never wrote to `contextWindow`).
 *
 * See Finding Y in the planning doc.
 */
export function isUserSetContextWindow(profile: ModelProfile): boolean {
  if (profile.contextWindowSource === 'user') return true;
  if (profile.contextWindowSource === 'auto') return false;
  if (profile.contextWindow === undefined) return false;
  const registry = getRegistryContextWindowForModel(profile.model);
  return profile.contextWindow !== registry;
}

/**
 * True when the profile's `maxOutputTokens` represents a user-set value (and
 * therefore must NOT be overwritten by runtime auto-learn).
 *
 * Mirrors `isUserSetContextWindow`: explicit source flags win; for legacy data
 * (source absent) we compare against the registry seed value.
 */
export function isUserSetMaxOutputTokens(profile: ModelProfile): boolean {
  if (profile.outputTokensSource === 'user') return true;
  if (profile.outputTokensSource === 'auto') return false;
  if (profile.maxOutputTokens === undefined) return false;
  const registry = getRegistryMaxOutputForModel(profile.model);
  return profile.maxOutputTokens !== registry;
}

/**
 * True when the profile is selectable in working/thinking dropdowns and
 * routing pools. Auto-created profiles without `serverUrl` are NOT selectable
 * — they live in the AgentsTab "Needs setup" subsection until the user fills
 * in credentials. Anthropic profiles are always selectable (the working set
 * doesn't need a serverUrl for Claude direct).
 */
export function isProfileSelectable(profile: ModelProfile): boolean {
  if (profile.providerType === 'anthropic') return true;
  return Boolean(profile.serverUrl?.trim());
}

export function isLoopbackRoutableProfile(profile: LoopbackRoutableProfile | null | undefined): boolean {
  if (!profile) return false;
  if (profile.routeSurface === 'local') return true;
  if (profile.providerType === 'local') return true;
  if (profile.serverUrl && isLocalhostUrl(profile.serverUrl)) return true;
  return false;
}

export function isBundledOllamaProfile(
  profile: Pick<ModelProfile, 'providerType'> | null | undefined,
): boolean {
  return profile?.providerType === 'local';
}

function inferProfileRouteSurface(profile: ModelProfile): RouteSurface {
  if (profile.routeSurface) return profile.routeSurface;
  if (profile.providerType === 'local') return 'local';
  if (profile.providerType === 'openrouter') return 'pool';
  if (profile.authSource === 'codex-subscription') return 'subscription';
  return 'api-key';
}

function profileRouteIdentityKey(profile: ModelProfile): string {
  return `${profile.providerType ?? 'other'}:${inferProfileRouteSurface(profile)}:${normalizeCatalogModelId(profile.model ?? '')}`;
}

/**
 * Find a connection-managed profile that shadows the given (auto) profile —
 * i.e. shares the canonical `(providerType, routeSurface, normalisedModel)`
 * route identity AND is currently selectable (enabled, not flagged
 * incompatible).
 *
 * Used by picker dedup (A1) and the resolver migration (A3) for the 260521
 * BTS Haiku-fallback fix. Returns null when no qualifying sibling exists, so
 * callers can fall back gracefully (DA finding: "leave settings untouched"
 * when migration conditions don't hold).
 */
export function findShadowingConnectionManagedSibling(
  profile: ModelProfile,
  candidates: readonly ModelProfile[],
): ModelProfile | null {
  const targetKey = profileRouteIdentityKey(profile);
  for (const candidate of candidates) {
    if (candidate.id === profile.id) continue;
    if (!isConnectionManagedProfile(candidate)) continue;
    if (candidate.enabled === false) continue;
    if (candidate.jsonCompatibility === 'incompatible') continue;
    if (candidate.chatCompatibility === 'incompatible') continue;
    if (!isProfileSelectable(candidate)) continue;
    if (profileRouteIdentityKey(candidate) === targetKey) return candidate;
  }
  return null;
}

/**
 * True when this profile is an auto-managed Codex profile that has a usable
 * connection-managed sibling. Pickers should hide such profiles to avoid the
 * "three same-model entries" picker confusion described in the 260521 BTS
 * Haiku-fallback investigation.
 */
export function isAutoProfileShadowedBySibling(
  profile: ModelProfile,
  allProfiles: readonly ModelProfile[],
): boolean {
  if (!isCodexAutoProfile(profile)) return false;
  return findShadowingConnectionManagedSibling(profile, allProfiles) !== null;
}
