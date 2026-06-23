import type { AppSettings, ModelProfile, RouteSurface } from '../types/settings';
import { isCodexSubscriptionProfile } from './providerKeys';

export function deriveRouteSurfaceForProfile(profile: ModelProfile): RouteSurface {
  if (profile.providerType === 'local') {
    return 'local';
  }
  if (profile.providerType === 'openrouter') {
    return 'pool';
  }
  if (isCodexSubscriptionProfile(profile)) {
    return 'subscription';
  }
  return 'api-key';
}

export function migrateProfileRouteSurfaces(
  settings: AppSettings,
): { profiles: ModelProfile[]; changed: boolean } {
  const profiles = settings.localModel?.profiles;
  if (!Array.isArray(profiles) || profiles.length === 0) {
    return { profiles: [], changed: false };
  }

  let changed = false;
  const migratedProfiles = profiles.map((profile) => {
    if (profile.routeSurface) {
      return profile;
    }
    changed = true;
    return {
      ...profile,
      routeSurface: deriveRouteSurfaceForProfile(profile),
    };
  });

  return {
    profiles: changed ? migratedProfiles : profiles,
    changed,
  };
}
