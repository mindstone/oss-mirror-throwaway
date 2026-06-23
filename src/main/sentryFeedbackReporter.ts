import * as SentryElectronMain from '@sentry/electron/main';
import { createScopedLogger } from '@core/logger';
import { isMainSentryEnabled } from './sentry';
import { formatNavigationUrl } from '@shared/navigation/urlParser';
import type { ConversationFeedbackSubmission, FeedbackReporter } from '@core/feedbackReporter';
import { slugifyChip } from '@core/feedbackReporter';

const log = createScopedLogger({ service: 'sentryFeedbackReporter' });

function resolveConversationLink(payload: ConversationFeedbackSubmission): string {
  return payload.conversationLink ?? formatNavigationUrl({ type: 'sessions', sessionId: payload.sessionId });
}

function buildMessage(payload: ConversationFeedbackSubmission): string {
  const selectedDimensions = payload.chips.length > 0
    ? payload.chips.join(', ')
    : 'None';
  const conversationLink = resolveConversationLink(payload);
  const platformLine = payload.arch
    ? `${payload.platform} (${payload.arch})`
    : payload.platform;

  return [
    '## Conversation feedback',
    '',
    `**Rating:** ${payload.rating} / 5 (${payload.sentiment})`,
    `**Selected dimensions:** ${selectedDimensions}`,
    '',
    '### Note from user',
    payload.comment,
    '',
    '### Conversation',
    conversationLink,
    '',
    '### System Info',
    `- App Version: ${payload.appVersion}`,
    `- Platform: ${platformLine}`,
  ].join('\n');
}

export function createDesktopFeedbackReporter(): FeedbackReporter {
  return {
    async submitConversationFeedback(
      payload: ConversationFeedbackSubmission,
    ): Promise<{ eventId?: string }> {
      // Gate on the OSS-aware, initialized Sentry state — NOT the env DSN.
      // In OSS-off this is false (Sentry never inits without user opt-in +
      // user creds), so this secondary capture path never reaches
      // withScope/captureMessage and nothing egresses. In OSS-on-with-user-DSN
      // Stage 3a inits Sentry with the user DSN → this is true and feedback
      // submits. Enterprise is unchanged (Sentry inits from env as before).
      if (!isMainSentryEnabled()) {
        log.info(
          { voteId: payload.voteId, sessionId: payload.sessionId },
          'Conversation feedback not submitted to Sentry because telemetry is not enabled',
        );
        return {};
      }

      try {
        let eventId: string | undefined;

        SentryElectronMain.withScope((scope) => {
          const conversationLink = resolveConversationLink(payload);
          scope.setTag('feedback_type', 'conversation');
          scope.setTag('rating', String(payload.rating));
          scope.setTag('sentiment', payload.sentiment);
          scope.setTag('vote_sequence', String(payload.voteSequence));
          scope.setTag('app_version', payload.appVersion);
          scope.setTag('platform', payload.platform);
          scope.setTag('conversation_id', payload.sessionId);
          scope.setTag('conversation_link', conversationLink);
          scope.setTag('has_diagnostics', payload.diagnosticsMarkdown ? 'true' : 'false');
          scope.setTag('chips_count', String(payload.chips.length));

          if (payload.anchorTurnId) {
            scope.setTag('anchor_turn_id', payload.anchorTurnId);
          }

          for (const chip of payload.chips) {
            scope.setTag(`chip:${slugifyChip(chip)}`, 'true');
          }

          if (payload.userEmail) {
            scope.setUser({ email: payload.userEmail });
          }

          if (payload.diagnosticsMarkdown) {
            scope.addAttachment({
              filename: 'diagnostics.md',
              data: new TextEncoder().encode(payload.diagnosticsMarkdown),
              contentType: 'text/markdown',
            });
          }

          eventId = SentryElectronMain.captureMessage(buildMessage(payload));
        });

        return eventId ? { eventId } : {};
      } catch (error) {
        log.error(
          { err: error, voteId: payload.voteId, sessionId: payload.sessionId },
          'Failed to submit conversation feedback to Sentry',
        );
        return {};
      }
    },
  };
}
