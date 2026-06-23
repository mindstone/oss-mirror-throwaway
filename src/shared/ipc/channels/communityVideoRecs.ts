import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

/**
 * Community Video Recommendations IPC Channels
 *
 * Desktop-only channels for fetching video recommendation card data
 * and managing user suppression preference.
 *
 * @see src/core/services/communityVideoRecsService.ts
 * @see docs/plans/260404_spark_community_video_recommendations.md
 */

const VideoRecommendationSchema = z.object({
  id: z.string(),
  headline: z.string(),
  speakerName: z.string(),
  eventName: z.string(),
  eventCity: z.string(),
  eventDate: z.string(),
  url: z.string(),
  eventUrl: z.string(),
  relevanceHint: z.string(),
});

const VideoRecsCardDataSchema = z.object({
  type: z.enum(['recommendations', 'empty', 'suppressed']),
  recommendations: z.array(VideoRecommendationSchema),
});

export const communityVideoRecsChannels = {
  'communityVideoRecs:get-card-data': defineInvokeChannel({
    channel: 'communityVideoRecs:get-card-data',
    request: z.object({}),
    response: VideoRecsCardDataSchema,
    description: 'Get community video recommendations card data for the Spark',
  }),

  'communityVideoRecs:suppress': defineInvokeChannel({
    channel: 'communityVideoRecs:suppress',
    request: z.object({
      suppress: z.boolean(),
    }),
    response: z.void(),
    description: 'Toggle community video recommendations suppression (opt-out/opt-in)',
  }),
} as const;
