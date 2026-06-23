import type { AppSettings, ModelProfile } from '@shared/types';
import { isProfileSelectable } from './profileHelpers';

/**
 * Get profiles eligible for adaptive model routing.
 * Profiles must have `routingEligible` set, a `model` field, not be disabled,
 * and be selectable (Stage 2: auto-created profiles without `serverUrl` are
 * filtered out — they live in the "Needs setup" subsection until the user
 * fills credentials in).
 */
export function getRoutingEligibleProfiles(settings: AppSettings): ModelProfile[] {
  const profiles = settings.localModel?.profiles ?? [];
  return profiles.filter(
    (p) => p.routingEligible && p.model && p.enabled !== false && isProfileSelectable(p),
  );
}
