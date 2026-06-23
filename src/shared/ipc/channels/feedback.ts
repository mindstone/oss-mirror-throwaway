import { z } from 'zod';
import {
  defineInvokeChannel,
  ConversationVoteRatingSchema,
  ConversationVoteChipSchema,
  ConversationFeedbackGetResponseSchema,
} from '../schemas';

const ConversationRateRequestSchema = z.object({
  sessionId: z.string(),
  rating: ConversationVoteRatingSchema,
  comment: z.string().min(1).max(1500),
  chips: z.array(ConversationVoteChipSchema).max(20).default([]),
  anchorMessageId: z.string().optional(),
  anchorTurnId: z.string().optional(),
  anchorMessageIndex: z.number().int().nonnegative().optional(),
  includeDiagnostics: z.boolean().default(false),
  diagnosticsMarkdown: z.string().optional(),
});

/**
 * Conversation Feedback IPC Channels
 *
 * Per-conversation rating feedback.
 * Persisted locally for UX (don't re-prompt), and emitted as vote history.
 */
export const feedbackChannels = {
  'feedback:conversation-get': defineInvokeChannel({
    channel: 'feedback:conversation-get',
    request: z.object({
      sessionId: z.string(),
    }),
    response: ConversationFeedbackGetResponseSchema,
    description: 'Get feedback state for a conversation',
  }),

  'feedback:conversation-rate': defineInvokeChannel({
    channel: 'feedback:conversation-rate',
    request: ConversationRateRequestSchema,
    response: z.object({
      success: z.boolean(),
      voteId: z.string(),
      sentryEventId: z.string().optional(),
    }),
    description: 'Rate a conversation',
  }),

  'feedback:conversation-dismiss': defineInvokeChannel({
    channel: 'feedback:conversation-dismiss',
    request: z.object({
      sessionId: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Dismiss the conversation feedback prompt for this conversation',
  }),
};

