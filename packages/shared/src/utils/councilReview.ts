/**
 * Council Review — shared constants and helpers for post-turn council review.
 * Used by desktop (Electron), web companion, and mobile.
 */

export const COUNCIL_REVIEW_PROMPT =
  'Review your last response for correctness, completeness, and quality. Be specific. If it\'s solid, say so briefly — don\'t manufacture issues.';

type CouncilProfile = {
  id?: string;
  councilEnabled?: boolean;
  model?: string;
  enabled?: boolean;
};

type CouncilConnectivity = {
  isProfileLive(profile: CouncilProfile): boolean;
};

/**
 * Checks whether council review is available given the current settings.
 * Matches runtime validation in councilService.getCouncilProfiles which
 * requires both councilEnabled AND a model name to be routable.
 * Accepts a minimal settings shape so callers don't need the full AppSettings type.
 */
export function isCouncilReviewAvailable(settings: {
  localModel?: { profiles?: CouncilProfile[] };
} | null | undefined, connectivity?: CouncilConnectivity): boolean {
  return (settings?.localModel?.profiles ?? []).some((p) =>
    p.councilEnabled &&
    p.model &&
    p.enabled !== false &&
    (connectivity ? connectivity.isProfileLive(p) : true),
  );
}
