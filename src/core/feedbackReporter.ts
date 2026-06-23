import { slugifyChip as sharedSlugifyChip } from '@shared/data/conversationFeedbackChips';
import type { ConversationVoteChip } from '@shared/ipc/schemas';

export type ConversationFeedbackRating = 1 | 2 | 3 | 4 | 5;
export type ConversationFeedbackSentiment = 'positive' | 'neutral' | 'negative';

export interface ConversationFeedbackSubmission {
  sessionId: string;
  voteId: string;
  rating: ConversationFeedbackRating;
  comment: string;
  chips: ConversationVoteChip[];
  voteSequence: number;
  sentiment: ConversationFeedbackSentiment;
  conversationLink?: string;
  anchorTurnId?: string;
  anchorMessageId?: string;
  appVersion: string;
  platform: string;
  arch?: string;
  userEmail?: string;
  diagnosticsMarkdown?: string;
}

export interface FeedbackReporter {
  submitConversationFeedback(
    payload: ConversationFeedbackSubmission,
  ): Promise<{ eventId?: string }>;
}

const _silent: FeedbackReporter = {
  submitConversationFeedback: async () => ({}),
};

let _reporter: FeedbackReporter = _silent;

export function setFeedbackReporter(reporter: FeedbackReporter): void {
  _reporter = reporter;
}

export function getFeedbackReporter(): FeedbackReporter {
  return _reporter;
}

export function deriveSentiment(
  rating: ConversationFeedbackRating,
): ConversationFeedbackSentiment {
  if (rating <= 2) return 'negative';
  if (rating === 3) return 'neutral';
  return 'positive';
}

export const slugifyChip = sharedSlugifyChip;
