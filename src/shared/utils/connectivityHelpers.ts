import type {
  AppSettings,
  ModelProfile,
  ModelProviderType,
  RouteSurface,
} from '@shared/types';
import { getCouncilProfiles } from './councilProfiles';
import { isProfileSelectable } from './profileHelpers';
import { getRoutingEligibleProfiles } from './routingProfiles';
import { normalizeApiKey } from './providerKeys';
import { resolveModelSettings } from './modelSettingsResolver';

export interface ProfileConnectivity {
  isProfileLive(profile: ModelProfile): boolean;
}

export interface ProfileConnectivityState {
  codexConnected?: boolean;
  openRouterConnected?: boolean;
  hasAnthropicAuth?: boolean;
  hasGeminiAuth?: boolean;
  hasOpenAiAuth?: boolean;
}

function isConnectionGatedProfile(profile: ModelProfile): boolean {
  return profile.profileSource === 'connection' || profile.profileSource === 'auto';
}

function getRouteSurface(profile: ModelProfile): RouteSurface | undefined {
  if (profile.routeSurface) return profile.routeSurface;
  if (profile.providerType === 'local') return 'local';
  if (profile.providerType === 'openrouter') return 'pool';
  if (profile.authSource === 'codex-subscription') return 'subscription';
  return profile.providerType ? 'api-key' : undefined;
}

export function isProviderConnectionLive(
  providerType: ModelProviderType | undefined,
  routeSurface: RouteSurface | undefined,
  state: ProfileConnectivityState,
): boolean {
  if (providerType === 'openai' && routeSurface === 'subscription') {
    return state.codexConnected === true;
  }

  switch (providerType) {
    case 'openrouter':
      return state.openRouterConnected === true;
    case 'anthropic':
      return state.hasAnthropicAuth === true;
    case 'google':
      return state.hasGeminiAuth === true;
    case 'openai':
      return state.hasOpenAiAuth === true;
    case 'local':
      return true;
    case 'together':
    case 'cerebras':
    case 'other':
    case undefined:
      return false;
  }
}

export function createProfileConnectivity(
  state: ProfileConnectivityState,
): ProfileConnectivity {
  return {
    isProfileLive(profile) {
      return isProviderConnectionLive(profile.providerType, getRouteSurface(profile), state);
    },
  };
}

export function getProfileConnectivityStateFromSettings(
  settings: AppSettings | null | undefined,
  flags: { codexConnected: boolean },
): ProfileConnectivityState {
  return {
    codexConnected: flags.codexConnected,
    openRouterConnected: Boolean(normalizeApiKey(settings?.openRouter?.oauthToken)),
    hasAnthropicAuth: Boolean(normalizeApiKey(resolveModelSettings(settings).apiKey)),
    hasGeminiAuth: Boolean(normalizeApiKey(settings?.providerKeys?.google)),
    hasOpenAiAuth: Boolean(normalizeApiKey(settings?.providerKeys?.openai)),
  };
}

export function isConnectionLive(
  profile: ModelProfile,
  connectivity: ProfileConnectivity | undefined,
): boolean {
  if (!connectivity) return true;
  if (!isConnectionGatedProfile(profile)) return true;
  return connectivity.isProfileLive(profile);
}

export function isProfileFunctional(
  profile: ModelProfile,
  connectivity: ProfileConnectivity | undefined,
): boolean {
  return isProfileSelectable(profile) && isConnectionLive(profile, connectivity);
}

export function getFunctionalRoutingProfiles(
  settings: AppSettings,
  connectivity: ProfileConnectivity | undefined,
): ModelProfile[] {
  return getRoutingEligibleProfiles(settings).filter((profile) =>
    isConnectionLive(profile, connectivity),
  );
}

export function getFunctionalCouncilProfiles(
  settings: AppSettings,
  connectivity: ProfileConnectivity | undefined,
): ModelProfile[] {
  return getCouncilProfiles(settings).filter((profile) =>
    isConnectionLive(profile, connectivity),
  );
}

/**
 * Gate flags for {@link resolveRoutingProfileRef} — the single, parameterised
 * profile-matching chokepoint shared by every planner-model-reference
 * resolution path (default/per-step route, escalation profile-metadata, and the
 * planner-assigned sub-agent route). The flags exist precisely BECAUSE the call
 * sites need intentionally different gate sets (see the routing PLAN's
 * resolver-gate-deltas invariant: `findSelectableProfileForModel` vs
 * `findRoutingProfile` vs escalation-decode). This is a parameterisation of
 * those deltas, NOT a flatten.
 */
export interface RoutingProfileRefGates {
  /** The candidate profile list to match against. */
  pool: ModelProfile[];
  /**
   * Require `profile.routingEligible`. The parent default/per-step/escalation
   * paths pass a pool already pre-filtered to routing-eligible profiles (so this
   * is a safe re-assertion there); the sub-agent path passes the raw profile
   * list and relies on this gate to enforce eligibility it previously ignored.
   */
  requireRoutingEligible: boolean;
  /**
   * When supplied, connection-gated profiles must be live (`isConnectionLive`).
   * The parent path's pool is already connectivity-filtered; the sub-agent path
   * passes the parent-turn connectivity so a dead-connection profile is
   * rejected. Omit to skip the connectivity gate entirely.
   */
  connectivity?: ProfileConnectivity | undefined;
  /**
   * Accept `profile:<id>` references (resolve by profile id). Only the
   * sub-agent / selectable path supports this; the routing-pool path matches by
   * model string only. Defaults to false.
   */
  supportsProfileId?: boolean;
}

/**
 * Match a planner-supplied model reference against a profile list under the
 * given gate flags. Returns the matched `ModelProfile` or `null`.
 *
 * Gate composition (every enabled gate must pass):
 *  - always: `enabled !== false` && `isProfileSelectable`
 *  - `requireRoutingEligible`: `profile.routingEligible`
 *  - `connectivity` set: `isConnectionLive(profile, connectivity)`
 *  - `supportsProfileId`: a `profile:<id>` ref resolves by id (still gated)
 *
 * This is the ONE place profile-gating logic lives; callers layer their own
 * decode / fallback semantics on top (and may treat the matched profile as
 * optional metadata, as the escalation path does).
 */
export function resolveRoutingProfileRef(
  model: string,
  gates: RoutingProfileRefGates,
): ModelProfile | null {
  const { pool, requireRoutingEligible, connectivity, supportsProfileId } = gates;
  if (!pool.length) return null;

  const passesGates = (profile: ModelProfile): boolean =>
    profile.enabled !== false
    && isProfileSelectable(profile)
    && (!requireRoutingEligible || Boolean(profile.routingEligible))
    && isConnectionLive(profile, connectivity);

  if (supportsProfileId && model.startsWith('profile:')) {
    const profileId = model.slice('profile:'.length);
    const byId = pool.find((profile) => profile.id === profileId);
    if (!byId) return null;
    return passesGates(byId) ? byId : null;
  }

  return pool.find((profile) => profile.model === model && passesGates(profile)) ?? null;
}
