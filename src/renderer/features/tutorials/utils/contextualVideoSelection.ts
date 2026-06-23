/**
 * Contextual tutorial video selection.
 *
 * Pure function that recommends the next tutorial video based on the user's
 * feature profile and which videos they've already watched. Used by the empty
 * conversation state's tutorial whisper to surface videos that teach features
 * the user hasn't discovered yet.
 *
 * Complements `getNextUnwatched()` in `useTutorialProgress`, which walks the
 * catalog in order. This function prioritizes undiscovered features first,
 * then falls back to catalog order.
 */

import {
  TUTORIAL_VIDEOS,
  getVideoById,
  getVideosByPath,
  type TutorialVideo,
} from '@shared/config/tutorialVideos';

/**
 * Lightweight profile shape consumed by `getContextualNextVideo`.
 *
 * This is a narrower, UI-agnostic slice of `UserFeatureProfile` from
 * `useUserFeatureProfile`. The caller flattens the profile into these flags
 * so this function stays decoupled from the hook's async plumbing.
 */
export interface ContextualVideoProfile {
  /** Voice is configured (provider keys present). */
  voiceConfigured: boolean;
  /** User has at least one MCP connection. */
  hasConnections: boolean;
  /** User has created automations. */
  hasAutomations: boolean;
  /** User has custom memory spaces. */
  hasSpaces: boolean;
  /** Meeting bot is configured with routing spaces. */
  meetingBotConfigured: boolean;
  /** User has used privacy mode at least once. */
  privacyModeUsed: boolean;
  /** Profile is still loading — fall back to catalog-order selection. */
  loading: boolean;
}

/**
 * Priority order for undiscovered-feature videos.
 *
 * Each entry is `[featureNotConfigured, videoId]`: if the predicate is true
 * (i.e. the feature is not yet discovered), the video is a candidate.
 * Earlier entries win — so connections are surfaced before voice, etc.
 */
const CONTEXTUAL_PRIORITY: Array<{
  predicate: (profile: ContextualVideoProfile) => boolean;
  videoId: string;
}> = [
  { predicate: (p) => !p.hasConnections, videoId: 'connected-tools' },
  { predicate: (p) => !p.voiceConfigured, videoId: 'voice' },
  { predicate: (p) => !p.hasAutomations, videoId: 'automations' },
  { predicate: (p) => !p.hasSpaces, videoId: 'spaces' },
  { predicate: (p) => !p.meetingBotConfigured, videoId: 'meeting-prep' },
  { predicate: (p) => !p.privacyModeUsed, videoId: 'privacy-local-first' },
];

/**
 * Fall back to catalog-order selection: "new-here" path first, then any
 * remaining unwatched video. Mirrors the behaviour of `getNextUnwatched()`
 * in `useTutorialProgress`.
 */
function getCatalogOrderNextUnwatched(watchedVideoIds: Set<string>): TutorialVideo | null {
  for (const video of getVideosByPath('new-here')) {
    if (!watchedVideoIds.has(video.id)) return video;
  }
  return TUTORIAL_VIDEOS.find((v) => !watchedVideoIds.has(v.id)) ?? null;
}

/**
 * Recommend the next tutorial video for a user based on which features they
 * haven't discovered yet.
 *
 * - When `profile.loading` is true, falls back to catalog-order selection so
 *   the UI never renders a stale "generic" recommendation while waiting for
 *   the profile to hydrate.
 * - Walks the priority list in order, returning the first video whose
 *   feature is not yet configured AND has not been watched.
 * - If every contextual candidate is already watched (or none apply), falls
 *   back to catalog-order selection.
 * - Returns `null` when all videos have been watched.
 */
export function getContextualNextVideo(
  profile: ContextualVideoProfile,
  watchedVideoIds: Set<string>,
): TutorialVideo | null {
  if (profile.loading) {
    return getCatalogOrderNextUnwatched(watchedVideoIds);
  }

  for (const { predicate, videoId } of CONTEXTUAL_PRIORITY) {
    if (!predicate(profile)) continue;
    if (watchedVideoIds.has(videoId)) continue;
    const video = getVideoById(videoId);
    if (video) return video;
  }

  return getCatalogOrderNextUnwatched(watchedVideoIds);
}
