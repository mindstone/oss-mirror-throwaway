/**
 * Feedback Domain IPC Handlers
 *
 * Conversation-level star rating feedback.
 */

import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import { getErrorReporter } from '@core/errorReporter';
import {
  deriveSentiment,
  getFeedbackReporter,
  type ConversationFeedbackRating,
} from '@core/feedbackReporter';
import { createScopedLogger } from '@core/logger';
import { getPlatformConfig } from '@core/platform';
import { formatNavigationUrl } from '@shared/navigation/urlParser';
import { registerHandler } from './utils/registerHandler';
import { feedbackChannels } from '@shared/ipc/channels/feedback';
import {
  appendConversationVote,
  dismissConversationFeedback,
  getConversationFeedback,
  writeBackSentryEventId,
} from '../services/conversationFeedbackStore';

const log = createScopedLogger({ ipc: 'feedback' });

const normalizeRating = (rating: number): ConversationFeedbackRating => {
  if (rating >= 1 && rating <= 5) {
    return rating as ConversationFeedbackRating;
  }
  throw new Error(`Invalid conversation feedback rating: ${rating}`);
};

const getRuntimeMetadata = (): { appVersion: string; platform: string; arch?: string } => {
  try {
    const platformConfig = getPlatformConfig();
    return {
      appVersion: platformConfig.version,
      platform: platformConfig.platform,
      arch: platformConfig.arch,
    };
  } catch {
    return {
      appVersion: process.env.npm_package_version ?? 'unknown',
      platform: process.platform,
      arch: process.arch,
    };
  }
};

export function registerFeedbackHandlers(): void {
  const getChannel = feedbackChannels['feedback:conversation-get'];
  registerHandler(getChannel.channel, async (_event: HandlerInvokeEvent, request: unknown) => {
    const validated = getChannel.request.parse(request);
    return getConversationFeedback(validated.sessionId);
  });

  const rateChannel = feedbackChannels['feedback:conversation-rate'];
  registerHandler(rateChannel.channel, async (_event: HandlerInvokeEvent, request: unknown) => {
    const validated = rateChannel.request.parse(request);
    const vote = appendConversationVote({
      sessionId: validated.sessionId,
      rating: validated.rating,
      comment: validated.comment,
      chips: validated.chips,
      anchorMessageId: validated.anchorMessageId,
      anchorTurnId: validated.anchorTurnId,
      anchorMessageIndex: validated.anchorMessageIndex,
      includeDiagnostics: validated.includeDiagnostics,
    });

    const voteSequence = getConversationFeedback(validated.sessionId).votes
      .filter((storedVote) => storedVote.sessionId === validated.sessionId)
      .length;
    const rating = normalizeRating(validated.rating);
    const runtimeMetadata = getRuntimeMetadata();
    const sentiment = deriveSentiment(rating);
    const conversationLink = formatNavigationUrl({ type: 'sessions', sessionId: vote.sessionId });
    const diagnosticsMarkdown = (
      validated.includeDiagnostics
      && 'diagnosticsMarkdown' in validated
    )
      ? validated.diagnosticsMarkdown
      : undefined;

    try {
      const submissionResult = await getFeedbackReporter().submitConversationFeedback({
        sessionId: vote.sessionId,
        voteId: vote.voteId,
        rating,
        comment: vote.comment,
        chips: vote.chips,
        voteSequence,
        sentiment,
        conversationLink,
        anchorTurnId: vote.anchorTurnId,
        anchorMessageId: vote.anchorMessageId,
        appVersion: runtimeMetadata.appVersion,
        platform: runtimeMetadata.platform,
        arch: runtimeMetadata.arch,
        diagnosticsMarkdown,
      });

      if (submissionResult.eventId) {
        writeBackSentryEventId(vote.voteId, submissionResult.eventId);
        return { success: true, voteId: vote.voteId, sentryEventId: submissionResult.eventId };
      }

      log.warn(
        { voteId: vote.voteId, reason: 'sentry-submission-no-event-id' },
        'Conversation feedback reporter returned no event ID',
      );
      return { success: true, voteId: vote.voteId };
    } catch (error) {
      getErrorReporter().captureException(error, {
        tags: { source: 'conversation-feedback-reporter' },
      });
      return { success: true, voteId: vote.voteId };
    }
  });

  const dismissChannel = feedbackChannels['feedback:conversation-dismiss'];
  registerHandler(dismissChannel.channel, async (_event: HandlerInvokeEvent, request: unknown) => {
    const validated = dismissChannel.request.parse(request);
    dismissConversationFeedback(validated.sessionId);
    return { success: true };
  });
}

