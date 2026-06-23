import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('feedbackReporter boundary', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('deriveSentiment maps all rating buckets', async () => {
    const { deriveSentiment } = await import('@core/feedbackReporter');

    expect(deriveSentiment(1)).toBe('negative');
    expect(deriveSentiment(2)).toBe('negative');
    expect(deriveSentiment(3)).toBe('neutral');
    expect(deriveSentiment(4)).toBe('positive');
    expect(deriveSentiment(5)).toBe('positive');
  });

  it('silent default reporter returns an empty result without throwing', async () => {
    const { getFeedbackReporter } = await import('@core/feedbackReporter');

    await expect(
      getFeedbackReporter().submitConversationFeedback({
        sessionId: 'session-1',
        voteId: 'vote-1',
        rating: 4,
        comment: 'Great',
        chips: [],
        voteSequence: 1,
        sentiment: 'positive',
        appVersion: '1.0.0',
        platform: 'darwin',
      }),
    ).resolves.toEqual({});
  });
});
