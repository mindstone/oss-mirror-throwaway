import { z } from 'zod';
import type { SlackRecentSenderDto } from '@rebel/shared';

export const SlackRecentSenderSchema = z.object({
  principalKey: z.string(),
  kind: z.enum(['human', 'agent']),
  authorId: z.string(),
  normalizedAuthorId: z.string(),
  displayName: z.string().optional(),
  handle: z.string().optional(),
  teamId: z.string(),
  lastSeenAt: z.number(),
  attemptCount: z.number().int().nonnegative(),
  channelIds: z.array(z.string()),
  lastChannelType: z.enum(['im', 'mpim', 'channel']),
});
export type SlackRecentSender = SlackRecentSenderDto;

export const ListSlackRecentSendersResponseSchema = z.object({
  senders: z.array(SlackRecentSenderSchema),
});

export const RemoveSlackRecentSenderRequestSchema = z.object({
  principalKey: z.string().trim().min(1),
});

export const RemoveSlackRecentSenderResponseSchema = z.object({
  ok: z.literal(true),
});

export const ClearSlackRecentSendersResponseSchema = z.object({
  ok: z.literal(true),
  cleared: z.number().int().nonnegative(),
});
