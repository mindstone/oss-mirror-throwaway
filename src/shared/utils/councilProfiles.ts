import { getApiKey } from '@core/rebelCore/settingsAccessorsPure';
import type { AppSettings, ModelProfile } from '@shared/types';

export const COUNCIL_BLOCKED_AUTH_COPY = 'Council mode needs at least one model you can run. Add a personal API key in Settings → AI → Model Team, or remove non-default models from your council.';
export const COUNCIL_MANAGED_NO_BYOK_TOOLTIP = 'Add a personal API key in Settings → AI → Model Team to include this model in your council.';
export const COUNCIL_MANAGED_ZERO_SURVIVOR_NOTICE = 'Council mode requires at least one model included in your Mindstone plan or backed by a personal API key.';

export type ManagedAllowListState =
  | { kind: 'ready'; allowed: readonly string[] }
  | { kind: 'unavailable' }
  | { kind: 'empty' };

export type CouncilSkipReason = 'not-in-managed-allowlist' | 'no-byok-credential';

export interface CouncilProfile extends ModelProfile {
  model: string;
}

export interface SkippedCouncilProfile {
  profile: CouncilProfile;
  reason: CouncilSkipReason;
}

export type CouncilEligibilityResult =
  | { kind: 'ready'; kept: readonly CouncilProfile[]; skipped: readonly SkippedCouncilProfile[] }
  | {
      kind: 'blocked';
      reason: 'no-eligible-members';
      candidateCount: number;
      hadAnthropicKey: boolean;
    };

type CouncilSettingsLike = Partial<Pick<AppSettings, 'activeProvider' | 'models' | 'claude' | 'localModel'>>;
type CouncilEligibilitySettings = Partial<Pick<AppSettings, 'activeProvider' | 'models' | 'claude'>>;

const UNAVAILABLE_ALLOW_LIST: ManagedAllowListState = { kind: 'unavailable' };

function normalizeModel(model: string | undefined): string {
  return model?.trim() ?? '';
}

function hasAnthropicByok(settings: CouncilEligibilitySettings): boolean {
  const apiKey = getApiKey(settings);
  return typeof apiKey === 'string' && apiKey.trim().length > 0;
}

function isAnthropicProfile(profile: CouncilProfile): boolean {
  return profile.providerType === 'anthropic';
}

function normalizeAllowedSet(allowed: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const model of allowed) {
    const normalized = normalizeModel(model);
    if (normalized) out.add(normalized);
  }
  return out;
}

function toCouncilProfile(profile: ModelProfile): CouncilProfile | null {
  if (profile.councilEnabled !== true || profile.enabled === false) return null;
  const model = normalizeModel(profile.model);
  if (!model) return null;
  return { ...profile, model };
}

/**
 * Get council-enabled profiles from settings.
 * Profiles must have a `model` field to be routable.
 */
export function getCouncilProfiles(settings: CouncilSettingsLike | null | undefined): CouncilProfile[] {
  const profiles = settings?.localModel?.profiles ?? [];
  const out: CouncilProfile[] = [];
  for (const profile of profiles) {
    const candidate = toCouncilProfile(profile);
    if (candidate) out.push(candidate);
  }
  return out;
}

export function filterCouncilProfilesForManagedMode(
  profiles: readonly CouncilProfile[],
  settings: CouncilEligibilitySettings,
  managedAllowList: ManagedAllowListState,
): {
  kept: readonly CouncilProfile[];
  skipped: readonly SkippedCouncilProfile[];
  hadAnthropicKey: boolean;
} {
  const hadAnthropicKey = hasAnthropicByok(settings);
  if (managedAllowList.kind === 'unavailable') {
    return { kept: [...profiles], skipped: [], hadAnthropicKey };
  }

  const allowedModels = managedAllowList.kind === 'ready'
    ? normalizeAllowedSet(managedAllowList.allowed)
    : new Set<string>();
  const kept: CouncilProfile[] = [];
  const skipped: SkippedCouncilProfile[] = [];

  for (const profile of profiles) {
    if (allowedModels.has(profile.model)) {
      kept.push(profile);
      continue;
    }
    if (hadAnthropicKey && isAnthropicProfile(profile)) {
      kept.push(profile);
      continue;
    }
    skipped.push({
      profile,
      reason: isAnthropicProfile(profile) ? 'no-byok-credential' : 'not-in-managed-allowlist',
    });
  }

  return { kept, skipped, hadAnthropicKey };
}

export function assessCouncilEligibility(
  profiles: readonly CouncilProfile[],
  settings: CouncilEligibilitySettings,
  managedAllowList: ManagedAllowListState,
): CouncilEligibilityResult {
  if (settings.activeProvider !== 'mindstone') {
    return { kind: 'ready', kept: [...profiles], skipped: [] };
  }
  if (profiles.length === 0 || managedAllowList.kind === 'unavailable') {
    return { kind: 'ready', kept: [...profiles], skipped: [] };
  }

  const filtered = filterCouncilProfilesForManagedMode(profiles, settings, managedAllowList);
  if (filtered.kept.length === 0) {
    return {
      kind: 'blocked',
      reason: 'no-eligible-members',
      candidateCount: profiles.length,
      hadAnthropicKey: filtered.hadAnthropicKey,
    };
  }
  return {
    kind: 'ready',
    kept: filtered.kept,
    skipped: filtered.skipped,
  };
}

export function isCouncilReviewAvailable(
  settings: CouncilSettingsLike | null | undefined,
  managedAllowList: ManagedAllowListState = UNAVAILABLE_ALLOW_LIST,
): boolean {
  const profiles = getCouncilProfiles(settings);
  if (profiles.length === 0) return false;
  const eligibility = assessCouncilEligibility(profiles, settings ?? {}, managedAllowList);
  return eligibility.kind === 'ready' && eligibility.kept.length > 0;
}
