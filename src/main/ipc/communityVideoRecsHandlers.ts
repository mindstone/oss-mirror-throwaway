/**
 * Community Video Recommendations Domain IPC Handlers
 *
 * Wires the community video recommendations IPC channels to the core service and store.
 * Desktop-only — not registered in cloudChannelPolicies.
 *
 * The getCardData handler is a pure store read — no bootstrap.
 * Bootstrap runs at app startup via startupScheduler (see main/index.ts)
 * so data is ready before the user opens the Spark, avoiding jank.
 *
 * @see src/core/services/communityVideoRecsService.ts
 * @see docs/plans/260404_spark_community_video_recommendations.md
 */

import { registerHandler } from './utils/registerHandler';
import { communityVideoRecsChannels } from '@shared/ipc/channels/communityVideoRecs';
import { createScopedLogger } from '@core/logger';
import {
  getRecommendations,
  isSuppressed,
  setSuppressed,
} from '@core/services/communityVideoRecsStore';
import { refreshVideoRecommendations } from '@core/services/communityVideoRecsService';
import { fetchCommunityVideos } from '@core/services/communityVideoRecsApiClient';
import { getWeekTopSessions } from '@core/services/timeSavedStore';
import { getFrequentTools } from '@core/services/toolUsageStore';
import { getFrequentSkills } from '@core/services/skillUsageStore';
import { getAllUseCases as getVideoRecsUseCases } from '../services/useCaseLibraryStore';
import type { VideoRecsCardData } from '@core/services/communityVideoRecsTypes';

const log = createScopedLogger({ service: 'communityVideoRecsHandlers' });

export function registerCommunityVideoRecsHandlers(): void {
  // ── Get card data (pure store read — no bootstrap) ──────────────
  const getCardDataChannel = communityVideoRecsChannels['communityVideoRecs:get-card-data'];
  registerHandler(getCardDataChannel.channel, async () => {
    try {
      if (isSuppressed()) {
        return { type: 'suppressed', recommendations: [] } satisfies VideoRecsCardData;
      }

      const recommendations = getRecommendations();
      if (recommendations.length > 0) {
        return { type: 'recommendations', recommendations } satisfies VideoRecsCardData;
      }

      return { type: 'empty', recommendations: [] } satisfies VideoRecsCardData;
    } catch (error) {
      log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to get video recommendations card data',
      );
      return { type: 'empty', recommendations: [] } satisfies VideoRecsCardData;
    }
  });

  // ── Suppress/unsuppress ─────────────────────────────────────────
  const suppressChannel = communityVideoRecsChannels['communityVideoRecs:suppress'];
  registerHandler(suppressChannel.channel, async (_event, ...args) => {
    const validated = suppressChannel.request.parse(args[0]);
    setSuppressed(validated.suppress);
  });
}

// ─── Bootstrap (called from startup scheduler in main/index.ts) ──

/**
 * Assemble real deps and call the core service for a one-time bootstrap generation.
 * Exported for use by the startup scheduler. Only runs if the store is empty
 * and user hasn't suppressed. Follows the same dep wiring as the automation scheduler.
 */
export async function bootstrapVideoRecommendations(): Promise<void> {
  if (isSuppressed()) {
    log.info('Video recommendations suppressed, skipping bootstrap');
    return;
  }

  const existing = getRecommendations();
  const hasCorrectUrls = existing.length > 0
    && existing[0].eventUrl
    && existing[0].eventUrl.includes('/annotate/');
  if (existing.length > 0 && hasCorrectUrls) {
    log.info('Video recommendations already in store, skipping bootstrap');
    return;
  }

  log.info('No video recommendations in store, running startup bootstrap');

  const { callBehindTheScenesWithAuth } = await import('../services/behindTheScenesClient');
  const { getSettings } = await import('@core/services/settingsStore');
  const settings = getSettings();

  await refreshVideoRecommendations({
    fetchVideos: fetchCommunityVideos,
    getSkillNames: () => getFrequentSkills().map((s) => s.skillName),
    getToolNames: () => getFrequentTools().map((t) => t.toolName),
    getTaskTypes: (limit) => getWeekTopSessions(limit).map((s) => s.taskType),
    getUseCaseTitles: () => getVideoRecsUseCases().map((uc) => uc.title),
    callBts: async (params) => {
      const response = await callBehindTheScenesWithAuth(
        settings,
        {
          messages: [{ role: 'user', content: params.userMessage }],
          system: params.systemPrompt,
          ...(params.jsonSchema
            ? { outputFormat: { type: 'json_schema' as const, schema: params.jsonSchema as Record<string, unknown> } }
            : {}),
        },
        { category: 'video-recs' },
      );
      const textBlock = response.content.find((b) => b.type === 'text');
      return { content: textBlock?.text ?? '' };
    },
  });
}
