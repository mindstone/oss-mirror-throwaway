import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationFeedbackSubmission } from '@core/feedbackReporter';

const {
  captureMessageMock,
  withScopeMock,
  setTagMock,
  addAttachmentMock,
  setUserMock,
  isMainSentryEnabledMock,
} = vi.hoisted(() => ({
  captureMessageMock: vi.fn(() => 'event-123'),
  withScopeMock: vi.fn(),
  setTagMock: vi.fn(),
  addAttachmentMock: vi.fn(),
  setUserMock: vi.fn(),
  isMainSentryEnabledMock: vi.fn(() => true),
}));


vi.mock('@sentry/electron/main', () => ({
  withScope: (callback: (scope: {
    setTag: (key: string, value: string) => void;
    addAttachment: (attachment: { filename: string; data: Uint8Array; contentType: string }) => void;
    setUser: (user: { email?: string }) => void;
  }) => void) => {
    withScopeMock(callback);
    callback({
      setTag: setTagMock,
      addAttachment: addAttachmentMock,
      setUser: setUserMock,
    });
  },
  captureMessage: captureMessageMock,
}));

// The feedback reporter gates on the OSS-aware initialized Sentry state, NOT
// the env DSN. Mock it so we can drive both the enabled (enterprise / OSS-on
// with user DSN) and disabled (OSS-off) cases deterministically.
vi.mock('../sentry', () => ({
  isMainSentryEnabled: isMainSentryEnabledMock,
}));

import { createDesktopFeedbackReporter } from '../sentryFeedbackReporter';

const createPayload = (
  overrides: Partial<ConversationFeedbackSubmission> = {},
): ConversationFeedbackSubmission => ({
  sessionId: 'session-1',
  voteId: 'vote-1',
  rating: 4,
  comment: 'Great structure and useful detail.',
  chips: ['Saved me time'],
  voteSequence: 1,
  sentiment: 'positive',
  conversationLink: 'rebel://conversation/session-1',
  anchorTurnId: 'turn-1',
  anchorMessageId: 'msg-1',
  appVersion: '1.2.3',
  platform: 'darwin',
  arch: 'arm64',
  userEmail: 'person@example.com',
  ...overrides,
});

describe('createDesktopFeedbackReporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('SENTRY_DSN', 'https://example.invalid/1');
    captureMessageMock.mockReturnValue('event-123');
    isMainSentryEnabledMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does NOT submit when Sentry is not enabled (OSS-off), even with SENTRY_DSN env present', async () => {
    // OSS-off: Sentry never inits (no user opt-in) → isMainSentryEnabled() false.
    // The Mindstone SENTRY_DSN env is present but must NOT drive the decision.
    isMainSentryEnabledMock.mockReturnValue(false);
    const reporter = createDesktopFeedbackReporter();

    const result = await reporter.submitConversationFeedback(createPayload());

    expect(result).toEqual({});
    expect(withScopeMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('submits when Sentry is enabled (enterprise / OSS-on with user DSN)', async () => {
    isMainSentryEnabledMock.mockReturnValue(true);
    const reporter = createDesktopFeedbackReporter();

    const result = await reporter.submitConversationFeedback(createPayload());

    expect(result).toEqual({ eventId: 'event-123' });
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { rating: 1 as const, sentiment: 'negative' as const },
    { rating: 3 as const, sentiment: 'neutral' as const },
    { rating: 5 as const, sentiment: 'positive' as const },
  ])('builds markdown message for rating $rating', async ({ rating, sentiment }) => {
    const reporter = createDesktopFeedbackReporter();
    const result = await reporter.submitConversationFeedback(
      createPayload({ rating, sentiment }),
    );

    expect(result).toEqual({ eventId: 'event-123' });
    expect(captureMessageMock).toHaveBeenCalledWith(
      expect.stringContaining(`**Rating:** ${rating} / 5 (${sentiment})`),
    );
    expect(captureMessageMock).toHaveBeenCalledWith(
      expect.stringContaining('### Note from user'),
    );
  });

  it('sets expected tags and emits chip:<slug> tags', async () => {
    const reporter = createDesktopFeedbackReporter();
    await reporter.submitConversationFeedback(
      createPayload({
        rating: 5,
        sentiment: 'positive',
        chips: ['Saved me time', 'Used the right sources'],
        voteSequence: 2,
      }),
    );

    expect(setTagMock).toHaveBeenCalledWith('feedback_type', 'conversation');
    expect(setTagMock).toHaveBeenCalledWith('rating', '5');
    expect(setTagMock).toHaveBeenCalledWith('sentiment', 'positive');
    expect(setTagMock).toHaveBeenCalledWith('vote_sequence', '2');
    expect(setTagMock).toHaveBeenCalledWith('app_version', '1.2.3');
    expect(setTagMock).toHaveBeenCalledWith('platform', 'darwin');
    expect(setTagMock).toHaveBeenCalledWith('conversation_id', 'session-1');
    expect(setTagMock).toHaveBeenCalledWith('conversation_link', 'rebel://conversation/session-1');
    expect(setTagMock).toHaveBeenCalledWith('anchor_turn_id', 'turn-1');
    expect(setTagMock).toHaveBeenCalledWith('has_diagnostics', 'false');
    expect(setTagMock).toHaveBeenCalledWith('chips_count', '2');
    expect(setTagMock).toHaveBeenCalledWith('chip:saved-me-time', 'true');
    expect(setTagMock).toHaveBeenCalledWith('chip:used-the-right-sources', 'true');
    expect(setUserMock).toHaveBeenCalledWith({ email: 'person@example.com' });
  });

  it('attaches diagnostics only when diagnosticsMarkdown is provided', async () => {
    const reporter = createDesktopFeedbackReporter();

    await reporter.submitConversationFeedback(createPayload({ diagnosticsMarkdown: undefined }));
    expect(addAttachmentMock).not.toHaveBeenCalled();

    await reporter.submitConversationFeedback(
      createPayload({ diagnosticsMarkdown: '# Diagnostics\nline 1' }),
    );
    expect(addAttachmentMock).toHaveBeenCalledTimes(1);
    expect(addAttachmentMock).toHaveBeenCalledWith(expect.objectContaining({
      filename: 'diagnostics.md',
      contentType: 'text/markdown',
    }));
    const attachment = addAttachmentMock.mock.calls[0]?.[0] as { data: Uint8Array };
    expect(new TextDecoder().decode(attachment.data)).toContain('# Diagnostics');
  });

  it('swallows Sentry errors and returns an empty result', async () => {
    captureMessageMock.mockImplementationOnce(() => {
      throw new Error('Sentry down');
    });
    const reporter = createDesktopFeedbackReporter();

    await expect(
      reporter.submitConversationFeedback(createPayload()),
    ).resolves.toEqual({});
  });
});
