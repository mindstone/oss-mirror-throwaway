import { z } from 'zod';

export const ConversationVoteRatingSchema = z.number().int().min(1).max(5);
export type ConversationVoteRating = z.infer<typeof ConversationVoteRatingSchema>;

export const ConversationVoteChipSchema = z.string().min(1).max(80);
export type ConversationVoteChip = z.infer<typeof ConversationVoteChipSchema>;

export const ConversationVoteSchema = z.object({
  voteId: z.string(),
  sessionId: z.string(),
  rating: ConversationVoteRatingSchema,
  comment: z.string().min(1).max(1500),
  chips: z.array(ConversationVoteChipSchema).max(20).default([]),
  ratedAt: z.number(),
  anchorMessageId: z.string().optional(),
  anchorTurnId: z.string().optional(),
  anchorMessageIndex: z.number().int().nonnegative().optional(),
  sentryEventId: z.string().optional(),
  includeDiagnostics: z.boolean().default(false),
});
export type ConversationVote = z.infer<typeof ConversationVoteSchema>;

export const ConversationFeedbackGetResponseSchema = z.object({
  votes: z.array(ConversationVoteSchema),
  dismissedAt: z.number().nullable(),
});
export type ConversationFeedbackGetResponse = z.infer<typeof ConversationFeedbackGetResponseSchema>;

