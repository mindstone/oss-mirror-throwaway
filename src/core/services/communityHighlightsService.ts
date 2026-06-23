/**
 * CommunityHighlightsService
 *
 * Fetches trending topics from the Rebels community via direct Discourse API.
 * Caches results in store for offline resilience.
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import type { CommunityHighlight, CommunityHighlightsState } from '@shared/types';

const log = createScopedLogger({ service: 'communityHighlights' });

const DISCOURSE_BASE_URL = 'https://rebels.mindstone.com';
const STORE_KEY = 'communityHighlights';
const MAX_HIGHLIGHTS = 5;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 15000;

export interface CommunityHighlightsServiceDeps {
  notifyRenderer?: (state: CommunityHighlightsState) => void;
}

interface DiscourseTopicResponse {
  topic_list?: {
    topics?: Array<{
      id: number;
      title: string;
      slug: string;
      posts_count: number;
      like_count: number;
      views: number;
      created_at: string;
      posters?: Array<{ user_id: number }>;
    }>;
  };
  users?: Array<{
    id: number;
    username: string;
    avatar_template: string;
  }>;
}

type CommunityHighlightsStoreShape = {
  communityHighlights: CommunityHighlightsState;
};

export class CommunityHighlightsService {
  private store: KeyValueStore<CommunityHighlightsStoreShape>;
  private deps: CommunityHighlightsServiceDeps;

  constructor(deps: CommunityHighlightsServiceDeps = {}) {
    this.deps = deps;
    this.store = createStore<CommunityHighlightsStoreShape>({ name: 'community-highlights', defaults: { communityHighlights: { highlights: [], lastFetchedAt: null, lastError: null } } });
    log.info('Community highlights service initialized');
  }

  getState(): CommunityHighlightsState {
    return this.store.get(STORE_KEY, {
      highlights: [],
      lastFetchedAt: null,
      lastError: null,
    });
  }

  async refresh(): Promise<{ success: boolean; error?: string }> {
    log.info('Refreshing community highlights from Discourse API');

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const response = await fetch(
        `${DISCOURSE_BASE_URL}/latest.json?order=activity&per_page=${MAX_HIGHLIGHTS}`,
        {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        }
      );
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Discourse API returned ${response.status}`);
      }

      const data = (await response.json()) as DiscourseTopicResponse;
      const highlights = this.parseDiscourseResponse(data);

      const state: CommunityHighlightsState = {
        highlights: highlights.slice(0, MAX_HIGHLIGHTS),
        lastFetchedAt: Date.now(),
        lastError: null,
      };

      this.store.set(STORE_KEY, state);
      this.deps.notifyRenderer?.(state);

      log.info({ count: highlights.length }, 'Community highlights refreshed');
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      log.error({ error: errorMsg }, 'Failed to refresh community highlights');

      // Update state with error but keep old highlights (stale cache fallback)
      const currentState = this.getState();
      const state: CommunityHighlightsState = {
        ...currentState,
        lastError: errorMsg,
      };
      this.store.set(STORE_KEY, state);
      this.deps.notifyRenderer?.(state);

      return { success: false, error: errorMsg };
    }
  }

  private parseDiscourseResponse(data: DiscourseTopicResponse): CommunityHighlight[] {
    const topics = data.topic_list?.topics ?? [];
    const users = data.users ?? [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    return topics.map((topic) => {
      const authorId = topic.posters?.[0]?.user_id;
      const author = authorId ? userMap.get(authorId) : null;

      return {
        id: String(topic.id),
        title: topic.title,
        author: author?.username ?? 'Unknown',
        authorAvatar: author?.avatar_template
          ? author.avatar_template.startsWith('http')
            ? author.avatar_template.replace('{size}', '45')
            : `${DISCOURSE_BASE_URL}${author.avatar_template.replace('{size}', '45')}`
          : undefined,
        url: `${DISCOURSE_BASE_URL}/t/${topic.slug}/${topic.id}`,
        replyCount: Math.max(0, topic.posts_count - 1), // posts_count includes OP
        likeCount: topic.like_count,
        views: topic.views,
        createdAt: new Date(topic.created_at).getTime(),
        fetchedAt: Date.now(),
        isHot: topic.like_count >= 5 || topic.posts_count >= 10,
      };
    });
  }

  isCacheStale(): boolean {
    const state = this.getState();
    if (!state.lastFetchedAt) return true;
    return Date.now() - state.lastFetchedAt > CACHE_TTL_MS;
  }
}
