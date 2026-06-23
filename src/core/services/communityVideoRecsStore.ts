/**
 * Community Video Recommendations Store
 *
 * Persists LLM-ranked video recommendations and user suppress preference.
 * Uses lazy getStore() pattern following communityEventsStore and heroChoiceStore.
 *
 * Minimal v1 shape — no allVideos cache, no per-video dismissals.
 *
 * @see docs/plans/260404_spark_community_video_recommendations.md
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import { COMMUNITY_VIDEO_RECS_STORE_VERSION } from '@core/constants';
import type { VideoRecommendation } from './communityVideoRecsTypes';

const log = createScopedLogger({ service: 'communityVideoRecsStore' });

export type VideoRecsStoreState = {
  version: number;
  /** Top 3 LLM-ranked video recommendations. */
  recommendations: VideoRecommendation[];
  /** Epoch ms when recommendations were last generated. */
  generatedAt: number | null;
  /** User opted out of video recommendations. */
  suppressVideoRecs: boolean;
};

const createDefaultState = (): VideoRecsStoreState => ({
  version: COMMUNITY_VIDEO_RECS_STORE_VERSION,
  recommendations: [],
  generatedAt: null,
  suppressVideoRecs: false,
});

let _store: KeyValueStore<VideoRecsStoreState> | null = null;

function getStore(): KeyValueStore<VideoRecsStoreState> {
  if (!_store) {
    _store = createStore<VideoRecsStoreState>({
      name: 'community-video-recs',
      defaults: createDefaultState(),
    });
  }
  return _store;
}

// ─── Recommendations ────────────────────────────────────────────────

export function getRecommendations(): VideoRecommendation[] {
  return getStore().get('recommendations') ?? [];
}

/**
 * Persist recommendations after a successful pipeline run.
 * Only call this after full pipeline success (atomic persistence).
 */
export function setRecommendations(recs: VideoRecommendation[], timestamp: number): void {
  const store = getStore();
  store.set('recommendations', recs);
  store.set('generatedAt', timestamp);
  log.info({ recCount: recs.length }, 'Persisted video recommendations');
}

/**
 * Check if recommendations are stale (older than maxAgeMs).
 * Returns true if no recommendations have been generated yet.
 */
export function isStale(maxAgeMs: number): boolean {
  const generatedAt = getStore().get('generatedAt') ?? 0;
  if (generatedAt === 0) return true;
  return Date.now() - generatedAt > maxAgeMs;
}

// ─── User Preferences ───────────────────────────────────────────────

export function isSuppressed(): boolean {
  return getStore().get('suppressVideoRecs') ?? false;
}

export function setSuppressed(suppress: boolean): void {
  getStore().set('suppressVideoRecs', suppress);
  log.info({ suppressed: suppress }, 'Video recommendations suppression toggled');
}

// ─── Testing ────────────────────────────────────────────────────────

/** Reset store for testing. */
export function _resetStore(): void {
  _store = null;
}
