import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  handlers,
  appendConversationVote,
  getConversationFeedback,
  dismissConversationFeedback,
  writeBackSentryEventId,
  submitConversationFeedback,
  captureException,
} = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, request: unknown) => Promise<unknown> | unknown>(),
  appendConversationVote: vi.fn(),
  getConversationFeedback: vi.fn(),
  dismissConversationFeedback: vi.fn(),
  writeBackSentryEventId: vi.fn(),
  submitConversationFeedback: vi.fn(),
  captureException: vi.fn(),
}));

 
vi.mock('../utils/registerHandler', () => ({
  registerHandler: (channel: string, fn: (event: unknown, request: unknown) => Promise<unknown> | unknown) => {
    handlers.set(channel, fn);
  },
}));

 
vi.mock('../../services/conversationFeedbackStore', () => ({
  appendConversationVote: (...args: unknown[]) => appendConversationVote(...args),
  getConversationFeedback: (...args: unknown[]) => getConversationFeedback(...args),
  dismissConversationFeedback: (...args: unknown[]) => dismissConversationFeedback(...args),
  writeBackSentryEventId: (...args: unknown[]) => writeBackSentryEventId(...args),
}));

 
vi.mock('@core/feedbackReporter', () => ({
  deriveSentiment: (rating: number) => {
    if (rating <= 2) return 'negative';
    if (rating === 3) return 'neutral';
    return 'positive';
  },
  getFeedbackReporter: () => ({
    submitConversationFeedback: (...args: unknown[]) => submitConversationFeedback(...args),
  }),
}));

 
vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    captureException: (...args: unknown[]) => captureException(...args),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  }),
}));

import { registerFeedbackHandlers } from '../feedbackHandlers';

describe('registerFeedbackHandlers', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    appendConversationVote.mockReturnValue({
      voteId: 'vote-1',
      sessionId: 'session-1',
      rating: 4,
      comment: 'Great answer',
      chips: ['Saved me time'],
      ratedAt: 1234,
      includeDiagnostics: false,
    });
    getConversationFeedback.mockReturnValue({
      votes: [{
        voteId: 'vote-1',
        sessionId: 'session-1',
        rating: 4,
        comment: 'Great answer',
        chips: ['Saved me time'],
        ratedAt: 1234,
        includeDiagnostics: false,
      }],
      dismissedAt: null,
    });
    dismissConversationFeedback.mockReturnValue(undefined);
    submitConversationFeedback.mockResolvedValue({});
    registerFeedbackHandlers();
  });

  const getHandler = (channel: string) => {
    const handler = handlers.get(channel);
    if (!handler) {
      throw new Error(`Handler not registered for ${channel}`);
    }
    return handler;
  };

  it('feedback:conversation-rate returns success + voteId for valid payload', async () => {
    const handler = getHandler('feedback:conversation-rate');
    const result = await handler({} as never, {
      sessionId: 'session-1',
      rating: 4,
      comment: 'Great answer',
      chips: ['Saved me time'],
    });

    expect(appendConversationVote).toHaveBeenCalledWith({
      sessionId: 'session-1',
      rating: 4,
      comment: 'Great answer',
      chips: ['Saved me time'],
      anchorMessageId: undefined,
      anchorTurnId: undefined,
      anchorMessageIndex: undefined,
      includeDiagnostics: false,
    });
    expect(submitConversationFeedback).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      voteId: 'vote-1',
      rating: 4,
      voteSequence: 1,
      sentiment: 'positive',
    }));
    expect(result).toEqual({ success: true, voteId: 'vote-1' });
  });

  it('feedback:conversation-rate rejects empty comments via Zod before store call', async () => {
    const handler = getHandler('feedback:conversation-rate');

    await expect(handler({} as never, {
      sessionId: 'session-1',
      rating: 4,
      comment: '',
      chips: [],
    })).rejects.toThrow();

    expect(appendConversationVote).not.toHaveBeenCalled();
  });

  it('feedback:conversation-get returns persisted vote shape', async () => {
    getConversationFeedback.mockReturnValue({
      votes: [{
        voteId: 'vote-1',
        sessionId: 'session-1',
        rating: 5,
        comment: 'Great',
        chips: ['Saved me time'],
        ratedAt: 1234,
        includeDiagnostics: false,
      }],
      dismissedAt: null,
    });

    const handler = getHandler('feedback:conversation-get');
    const result = await handler({} as never, { sessionId: 'session-1' });

    expect(getConversationFeedback).toHaveBeenCalledWith('session-1');
    expect(result).toEqual({
      votes: [{
        voteId: 'vote-1',
        sessionId: 'session-1',
        rating: 5,
        comment: 'Great',
        chips: ['Saved me time'],
        ratedAt: 1234,
        includeDiagnostics: false,
      }],
      dismissedAt: null,
    });
  });

  it('feedback:conversation-dismiss returns success', async () => {
    const handler = getHandler('feedback:conversation-dismiss');
    const result = await handler({} as never, { sessionId: 'session-1' });

    expect(dismissConversationFeedback).toHaveBeenCalledWith('session-1');
    expect(result).toEqual({ success: true });
  });

  it('submits voteSequence as 1 for first vote and 2 for second vote on same session', async () => {
    appendConversationVote
      .mockReturnValueOnce({
        voteId: 'vote-1',
        sessionId: 'session-1',
        rating: 5,
        comment: 'Great',
        chips: [],
        ratedAt: 1000,
        includeDiagnostics: false,
      })
      .mockReturnValueOnce({
        voteId: 'vote-2',
        sessionId: 'session-1',
        rating: 3,
        comment: 'Okay',
        chips: [],
        ratedAt: 2000,
        includeDiagnostics: false,
      });

    getConversationFeedback
      .mockReturnValueOnce({
        votes: [{
          voteId: 'vote-1',
          sessionId: 'session-1',
          rating: 5,
          comment: 'Great',
          chips: [],
          ratedAt: 1000,
          includeDiagnostics: false,
        }],
        dismissedAt: null,
      })
      .mockReturnValueOnce({
        votes: [{
          voteId: 'vote-2',
          sessionId: 'session-1',
          rating: 3,
          comment: 'Okay',
          chips: [],
          ratedAt: 2000,
          includeDiagnostics: false,
        }, {
          voteId: 'vote-1',
          sessionId: 'session-1',
          rating: 5,
          comment: 'Great',
          chips: [],
          ratedAt: 1000,
          includeDiagnostics: false,
        }],
        dismissedAt: null,
      });

    const handler = getHandler('feedback:conversation-rate');
    await handler({} as never, {
      sessionId: 'session-1',
      rating: 5,
      comment: 'Great',
      chips: [],
    });
    await handler({} as never, {
      sessionId: 'session-1',
      rating: 3,
      comment: 'Okay',
      chips: [],
    });

    expect(submitConversationFeedback).toHaveBeenNthCalledWith(1, expect.objectContaining({
      voteId: 'vote-1',
      voteSequence: 1,
    }));
    expect(submitConversationFeedback).toHaveBeenNthCalledWith(2, expect.objectContaining({
      voteId: 'vote-2',
      voteSequence: 2,
    }));
  });

  it('writes back sentryEventId when reporter submission succeeds', async () => {
    submitConversationFeedback.mockResolvedValueOnce({ eventId: 'event-123' });
    appendConversationVote.mockReturnValueOnce({
      voteId: 'vote-42',
      sessionId: 'session-1',
      rating: 4,
      comment: 'Nice',
      chips: [],
      ratedAt: 1234,
      includeDiagnostics: false,
    });
    getConversationFeedback.mockReturnValueOnce({
      votes: [{
        voteId: 'vote-42',
        sessionId: 'session-1',
        rating: 4,
        comment: 'Nice',
        chips: [],
        ratedAt: 1234,
        includeDiagnostics: false,
      }],
      dismissedAt: null,
    });

    const handler = getHandler('feedback:conversation-rate');
    const result = await handler({} as never, {
      sessionId: 'session-1',
      rating: 4,
      comment: 'Nice',
      chips: [],
    });

    expect(writeBackSentryEventId).toHaveBeenCalledWith('vote-42', 'event-123');
    expect(result).toEqual({ success: true, voteId: 'vote-42', sentryEventId: 'event-123' });
  });

  it('persists vote and returns success when reporter submission throws', async () => {
    const sentryError = new Error('Sentry unavailable');
    submitConversationFeedback.mockRejectedValueOnce(sentryError);
    appendConversationVote.mockReturnValueOnce({
      voteId: 'vote-fail',
      sessionId: 'session-1',
      rating: 2,
      comment: 'Bad',
      chips: [],
      ratedAt: 1234,
      includeDiagnostics: false,
    });
    getConversationFeedback.mockReturnValueOnce({
      votes: [{
        voteId: 'vote-fail',
        sessionId: 'session-1',
        rating: 2,
        comment: 'Bad',
        chips: [],
        ratedAt: 1234,
        includeDiagnostics: false,
      }],
      dismissedAt: null,
    });

    const handler = getHandler('feedback:conversation-rate');
    const result = await handler({} as never, {
      sessionId: 'session-1',
      rating: 2,
      comment: 'Bad',
      chips: [],
    });

    expect(appendConversationVote).toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(sentryError, {
      tags: { source: 'conversation-feedback-reporter' },
    });
    expect(writeBackSentryEventId).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, voteId: 'vote-fail' });
  });
});
