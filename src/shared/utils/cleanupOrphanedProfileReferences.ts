import type { AppSettings, ModelProfile } from '@shared/types';
import { isProfileSelectable } from './profileHelpers';
import { resolveModelSettings } from './modelSettingsResolver';
import { PROFILE_PREFIX } from './btsModelValueNormalization';

export type CleanupUpdates = Omit<Partial<AppSettings>, 'models'> & { models?: Partial<NonNullable<AppSettings['models']>> };

/** Settings slice the profile-reference enumeration reads. */
export type ProfileReferenceSettings = Pick<
  AppSettings,
  'models' | 'behindTheScenesModel' | 'backgroundFallback' | 'localInferenceCloudFallback'
>;

function isReferencedProfileUsable(profileId: string | null | undefined, profilesById: Map<string, ModelProfile>): boolean {
  if (!profileId) return true;
  const profile = profilesById.get(profileId);
  return !!profile && profile.enabled !== false && isProfileSelectable(profile);
}

function profileIdFromPrefixed(value: string | null | undefined): string | null {
  if (!value?.startsWith(PROFILE_PREFIX)) return null;
  return value.slice(PROFILE_PREFIX.length);
}

function ensureModels(updates: CleanupUpdates): Partial<NonNullable<AppSettings['models']>> {
  if (!updates.models) {
    updates.models = {};
  }
  return updates.models;
}

export const PROFILE_REFERENCE_FIELD_KEYS = [
  'models.workingProfileId',
  'models.thinkingProfileId',
  'models.longContextFallbackProfileId',
  'models.workingFallback',
  'models.thinkingFallback',
  'behindTheScenesModel',
  'backgroundFallback',
  'localInferenceCloudFallback',
] as const;

export type ProfileReferenceFieldKey = (typeof PROFILE_REFERENCE_FIELD_KEYS)[number];

/** One settings field that can hold a model-profile reference. */
export interface ProfileReferenceField {
  key: ProfileReferenceFieldKey;
  /**
   * Profile id(s) currently referenced through this field, prefix already
   * stripped. Empty when the field is unset or holds a non-profile value
   * (e.g. a `model:`-prefixed fallback).
   */
  getReferencedProfileIds(settings: ProfileReferenceSettings): string[];
  /** Stage the cleared value into a cleanup updates partial. */
  clear(updates: CleanupUpdates): void;
}

const asIds = (id: string | null | undefined): string[] => (id ? [id] : []);

/**
 * SINGLE SOURCE OF TRUTH for every settings field that can hold a
 * model-profile reference. Consumed by BOTH:
 *
 * - `cleanupOrphanedProfileReferences()` below — clears references to
 *   missing/unselectable profiles when the profile list changes; and
 * - the RebelSettings cost-escalation gate's role-assignment predicate
 *   (`isProfileReferencedInSettings`, used by
 *   src/core/services/safety/toolSafetyService.ts) — re-pricing a profile
 *   referenced from ANY of these changes what some role/fallback resolves to
 *   without a further gated call, so it must require user approval when the
 *   new model is premium.
 *
 * Add new profile-reference settings fields HERE, never inline in a consumer:
 * both consumers pick the field up automatically, and the drift-lock test in
 * src/main/services/__tests__/toolSafetyService.test.ts fails until a
 * per-field fixture is added (which the derived gate then passes by
 * construction). This enumeration previously drifted from the gate's
 * hand-rolled list — `models.longContextFallbackProfileId` and
 * `localInferenceCloudFallback` were silently un-gated (GPT stage-14 review
 * F1/F2, docs/plans/260611_fable-5-support/PLAN.md Stage 15).
 */
export const PROFILE_REFERENCE_FIELDS: readonly ProfileReferenceField[] = [
  {
    key: 'models.workingProfileId',
    getReferencedProfileIds: (settings) => asIds(resolveModelSettings(settings).workingProfileId),
    clear: (updates) => {
      ensureModels(updates).workingProfileId = undefined;
    },
  },
  {
    key: 'models.thinkingProfileId',
    getReferencedProfileIds: (settings) => asIds(resolveModelSettings(settings).thinkingProfileId),
    clear: (updates) => {
      ensureModels(updates).thinkingProfileId = undefined;
    },
  },
  {
    // Long-context overflow recovery dereferences this profile at runtime
    // (resolveLongContextFallbackTarget → desktopRecoveryAdapter.ts) — it is a
    // paid-execution path, not dead config.
    key: 'models.longContextFallbackProfileId',
    getReferencedProfileIds: (settings) => asIds(resolveModelSettings(settings).longContextFallbackProfileId),
    clear: (updates) => {
      ensureModels(updates).longContextFallbackProfileId = undefined;
    },
  },
  {
    key: 'models.workingFallback',
    getReferencedProfileIds: (settings) => asIds(profileIdFromPrefixed(resolveModelSettings(settings).workingFallback)),
    clear: (updates) => {
      ensureModels(updates).workingFallback = undefined;
    },
  },
  {
    key: 'models.thinkingFallback',
    getReferencedProfileIds: (settings) => asIds(profileIdFromPrefixed(resolveModelSettings(settings).thinkingFallback)),
    clear: (updates) => {
      ensureModels(updates).thinkingFallback = undefined;
    },
  },
  {
    key: 'behindTheScenesModel',
    getReferencedProfileIds: (settings) => asIds(profileIdFromPrefixed(settings.behindTheScenesModel)),
    clear: (updates) => {
      updates.behindTheScenesModel = undefined;
    },
  },
  {
    key: 'backgroundFallback',
    getReferencedProfileIds: (settings) => asIds(profileIdFromPrefixed(settings.backgroundFallback)),
    clear: (updates) => {
      updates.backgroundFallback = undefined;
    },
  },
  {
    // Cross-surface normalization substitutes this profile into the
    // working/thinking roles when local profiles are pruned off-desktop
    // (settingsUtils.ts normalizeSettings) — silently re-pricing it re-prices
    // those roles on cloud/mobile.
    key: 'localInferenceCloudFallback',
    getReferencedProfileIds: (settings) => asIds(profileIdFromPrefixed(settings.localInferenceCloudFallback)),
    clear: (updates) => {
      updates.localInferenceCloudFallback = undefined;
    },
  },
];

/**
 * True when `profileId` is referenced from ANY settings field a model role or
 * fallback can resolve through — the "role-assigned" question the
 * cost-escalation gate asks before allowing an in-place profile re-price.
 *
 * Derived from `PROFILE_REFERENCE_FIELDS` (shared with orphan cleanup) plus
 * two runtime role surfaces that orphan cleanup deliberately leaves to the
 * settings bridge's own lifecycle handling:
 * - `localModel.activeProfileId` — the legacy active-profile fallback for the
 *   working role (cleared by the bridge on deactivate/remove); and
 * - `behindTheScenesOverrides` — per-task BTS `profile:<id>` references.
 */
export function isProfileReferencedInSettings(
  settings: ProfileReferenceSettings & Pick<AppSettings, 'localModel' | 'behindTheScenesOverrides'>,
  profileId: string,
): boolean {
  if (PROFILE_REFERENCE_FIELDS.some((field) => field.getReferencedProfileIds(settings).includes(profileId))) {
    return true;
  }
  const profileRef = `${PROFILE_PREFIX}${profileId}`;
  return (
    settings.localModel?.activeProfileId === profileId ||
    Object.values(settings.behindTheScenesOverrides ?? {}).includes(profileRef)
  );
}

/**
 * Returns a `Partial<AppSettings>` of fields to clear when the profile list
 * changes such that previously-referenced profiles are now missing or
 * unselectable. Caller spreads the partial into their settings update.
 *
 * Walks `PROFILE_REFERENCE_FIELDS` — the shared enumeration above is the
 * single source of truth for which fields are checked.
 */
export function cleanupOrphanedProfileReferences(
  settings: AppSettings,
  nextProfiles: readonly ModelProfile[],
): CleanupUpdates {
  const profilesById = new Map(nextProfiles.map((profile) => [profile.id, profile]));
  const updates: CleanupUpdates = {};

  for (const field of PROFILE_REFERENCE_FIELDS) {
    const referencedIds = field.getReferencedProfileIds(settings);
    if (referencedIds.some((id) => !isReferencedProfileUsable(id, profilesById))) {
      field.clear(updates);
    }
  }

  return updates;
}
