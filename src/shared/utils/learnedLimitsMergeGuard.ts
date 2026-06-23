/**
 * Inbound stale-sync merge guard for the auto-learn provenance fields.
 *
 * Stage 2 (260503_unify_learned_limits_into_profiles.md) folded the
 * dedicated learned-limits store onto `ModelProfile`, which means the
 * `contextWindow` value travels through cloud sync. If desktop A has just
 * recorded a tighter learned ceiling and desktop B (with stale data)
 * pushes its older settings document, the unified field would be
 * overwritten and the user's progress lost.
 *
 * The merge guard preserves the locally-stored auto-learned value when
 * the incoming profile carries an OLDER `*LearnedAt` (or
 * lacks it entirely) and the local profile's source is `'auto'`.
 *
 * It does NOT block user-set values — when the incoming profile sets a
 * source to `'user'` the user's intent always wins, and when the local
 * source is `'user'` the local value also wins (since user intent should
 * not be silently overwritten by cloud roundtrips).
 *
 * The guard also preserves recently-auto-learned LOCAL-ONLY profiles
 * (id absent from the incoming payload) within `RECENT_LEARN_WINDOW_MS`.
 * The renderer can dispatch a stale `settings:update` shortly after the
 * writer creates a brand new `auto:<modelId>` profile; iterating only
 * over incoming would silently drop the just-learned profile. Older
 * local-only profiles (and any local-only profile whose source is not
 * `'auto'`) are dropped — set membership is otherwise inbound-authoritative.
 */
import type { AppSettings, ModelProfile } from '@shared/types';
import {
  isUserSetContextWindow,
  isUserSetMaxOutputTokens,
} from './profileHelpers';

const RECENT_LEARN_WINDOW_MS = 5 * 60 * 1000;

function isRecentAutoLearn(profile: ModelProfile, now: number): boolean {
  const contextRecent =
    profile.contextWindowSource === 'auto'
    && typeof profile.contextWindowLearnedAt === 'number'
    && now - profile.contextWindowLearnedAt < RECENT_LEARN_WINDOW_MS;
  if (contextRecent) return true;
  return profile.outputTokensSource === 'auto'
    && typeof profile.outputTokensLearnedAt === 'number'
    && now - profile.outputTokensLearnedAt < RECENT_LEARN_WINDOW_MS;
}

type LearnedValueKey = 'contextWindow' | 'maxOutputTokens';
type LearnedSourceKey = 'contextWindowSource' | 'outputTokensSource';
type LearnedAtKey = 'contextWindowLearnedAt' | 'outputTokensLearnedAt';
type OverflowCountKey = 'contextWindowOverflowCount' | 'outputTokensOverflowCount';

function preserveAutoLearnedField(
  local: ModelProfile,
  incoming: ModelProfile,
  valueKey: LearnedValueKey,
  sourceKey: LearnedSourceKey,
  learnedAtKey: LearnedAtKey,
  overflowCountKey: OverflowCountKey,
  isLocalUserSet: (profile: ModelProfile) => boolean,
): ModelProfile {
  const incomingIsAuto = incoming[sourceKey] === 'auto';
  const localIsUser = isLocalUserSet(local);

  const shouldPreserve =
    (localIsUser && incomingIsAuto)
    || (
      local[sourceKey] === 'auto'
      && incomingIsAuto
      && (local[learnedAtKey] ?? 0) > (incoming[learnedAtKey] ?? 0)
    );

  if (!shouldPreserve) return incoming;

  if (valueKey === 'contextWindow') {
    return {
      ...incoming,
      contextWindow: local.contextWindow,
      contextWindowSource: local.contextWindowSource,
      contextWindowOverflowCount: local.contextWindowOverflowCount,
      contextWindowLearnedAt: local.contextWindowLearnedAt,
      lastLearnedContextWindow: local.lastLearnedContextWindow,
    };
  }

  return {
    ...incoming,
    maxOutputTokens: local.maxOutputTokens,
    outputTokensSource: local.outputTokensSource,
    outputTokensOverflowCount: local.outputTokensOverflowCount,
    outputTokensLearnedAt: local.outputTokensLearnedAt,
    lastLearnedOutputTokens: local.lastLearnedOutputTokens,
  };
}

function mergeProfile(local: ModelProfile, incoming: ModelProfile): ModelProfile {
  if (local.model !== incoming.model) return incoming;
  const withContextPreserved = preserveAutoLearnedField(
    local,
    incoming,
    'contextWindow',
    'contextWindowSource',
    'contextWindowLearnedAt',
    'contextWindowOverflowCount',
    isUserSetContextWindow,
  );
  const withOutputPreserved = preserveAutoLearnedField(
    local,
    withContextPreserved,
    'maxOutputTokens',
    'outputTokensSource',
    'outputTokensLearnedAt',
    'outputTokensOverflowCount',
    isUserSetMaxOutputTokens,
  );
  if (local.profileSource !== undefined && withOutputPreserved.profileSource == null) {
    return {
      ...withOutputPreserved,
      profileSource: local.profileSource,
    };
  }
  return withOutputPreserved;
}

/**
 * Merge an incoming `AppSettings` document with the local one, preserving
 * any locally-stored auto-learned context-window provenance fields when
 * the incoming side is older or missing them.
 *
 * Operates only on the `localModel.profiles` array. Recently auto-learned
 * profiles only present locally are preserved (set-membership is otherwise
 * inbound-authoritative — older auto-learned and user-managed local-only
 * entries are dropped). Profiles only present in the incoming document are
 * added as-is.
 */
export function mergeIncomingProfilesPreservingLearned(
  local: AppSettings,
  incoming: AppSettings,
): AppSettings {
  const incomingProfiles = incoming.localModel?.profiles ?? [];
  const localProfiles = local.localModel?.profiles ?? [];

  if (localProfiles.length === 0) return incoming;
  // NOTE: Do NOT early-return when incomingProfiles.length === 0. A stale
  // sync payload with empty profiles would silently drop a freshly
  // auto-learned local-only profile that the writer just created
  // (canonical first-overflow scenario). Fall through so the
  // preservedLocalOnly pass below recovers recently-auto-learned entries.

  const incomingById = new Map(incomingProfiles.map((p) => [p.id, p]));
  const localById = new Map(localProfiles.map((p) => [p.id, p]));
  const now = Date.now();

  const mergedFromIncoming = incomingProfiles.map((incomingProfile) => {
    const localProfile = localById.get(incomingProfile.id);
    return localProfile ? mergeProfile(localProfile, incomingProfile) : incomingProfile;
  });

  const preservedLocalOnly: ModelProfile[] = [];
  for (const localProfile of localProfiles) {
    if (incomingById.has(localProfile.id)) continue;
    if (isRecentAutoLearn(localProfile, now)) {
      preservedLocalOnly.push(localProfile);
    }
  }

  const incomingUnchanged =
    preservedLocalOnly.length === 0 &&
    mergedFromIncoming.every((profile, idx) => profile === incomingProfiles[idx]);
  if (incomingUnchanged) return incoming;

  const localModel = incoming.localModel ?? { profiles: [], activeProfileId: null };
  return {
    ...incoming,
    localModel: {
      ...localModel,
      profiles: [...mergedFromIncoming, ...preservedLocalOnly],
    },
  };
}
