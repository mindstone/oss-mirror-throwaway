import { z } from 'zod';
import { ImpactLevelSchema } from './agent';

export const CommunityHighlightSchema = z.object({
  id: z.string(),
  title: z.string(),
  author: z.string(),
  authorAvatar: z.string().optional(),
  url: z.string(),
  replyCount: z.number(),
  likeCount: z.number(),
  views: z.number(),
  createdAt: z.number(),
  fetchedAt: z.number(),
  isHot: z.boolean(),
});

export const CommunityHighlightsStateSchema = z.object({
  highlights: z.array(CommunityHighlightSchema),
  lastFetchedAt: z.number().nullable(),
  lastError: z.string().nullable(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Community Share Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const CommunityShareEligibilitySchema = z.object({
  sessionId: z.string(),
  timeSavedMinutes: z.number(),
  timeSavedFormatted: z.string(),
  impact: ImpactLevelSchema,
  quip: z.string(),
  evaluatedAt: z.number(),
});

export const CommunitySharePreviewSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  body: z.string(),
  timeSavedMinutes: z.number(),
  timeSavedFormatted: z.string(),
  impact: ImpactLevelSchema,
  quip: z.string(),
  composedAt: z.number(),
});
