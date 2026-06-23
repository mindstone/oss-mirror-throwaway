/**
 * Feedback queue consumer tests — verifies the bespoke `feedback` consumer
 * loads the persisted FeedbackRequest, submits once (no inner retry), and maps
 * the outcome to the correct queue error category so the QUEUE owns retry vs
 * terminal. This is the durability contract for the mobile offline feedback
 * queue: a transient failure must retry (never lost), a permanent one must
 * terminalize but retain the payload, and idempotency keys must survive on disk.
 */

const mockLoadJsonPayload = jest.fn();
const mockSubmitFeedbackOnce = jest.fn();

jest.mock('../../../cloud-client/src/offlineQueue/offlineQueueStore', () => {
  const actual = jest.requireActual('../../../cloud-client/src/offlineQueue/offlineQueueStore');
  return {
    ...actual,
    useOfflineQueueStore: Object.assign(jest.fn(), {
      getState: () => ({ loadJsonPayload: mockLoadJsonPayload }),
      setState: jest.fn(),
      subscribe: jest.fn(() => jest.fn()),
    }),
  };
});

jest.mock('../../../cloud-client/src/cloudClient', () => {
  const actual = jest.requireActual('../../../cloud-client/src/cloudClient');
  return {
    ...actual,
    submitFeedbackOnce: (...args: unknown[]) => mockSubmitFeedbackOnce(...args),
  };
});

import { createFeedbackQueueConsumer } from '../hooks/useFeedbackQueueConsumer';
import { CloudClientError } from '@rebel/cloud-client';
import type { QueueItem, FeedbackRequest } from '@rebel/cloud-client';

function makeFeedbackItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'feedback-item-1',
    type: 'feedback',
    status: 'processing',
    enqueuedAt: Date.now(),
    attempts: 0,
    nextRetryAt: 0,
    isPermanentFailure: false,
    metadata: { feedbackType: 'bug', urgency: 'medium' },
    ...overrides,
  };
}

const validPayload = (overrides: Partial<FeedbackRequest> = {}): FeedbackRequest => ({
  feedbackType: 'bug',
  urgency: 'medium',
  message: 'Something broke',
  platform: 'ios',
  clientReportId: 'report-1',
  eventId: 'abcdef0123456789abcdef0123456789',
  ...overrides,
});

beforeEach(() => {
  mockLoadJsonPayload.mockReset();
  mockSubmitFeedbackOnce.mockReset();
});

describe('createFeedbackQueueConsumer', () => {
  it('delivers successfully (200) → success, queue removes the item', async () => {
    mockLoadJsonPayload.mockResolvedValue(validPayload());
    mockSubmitFeedbackOnce.mockResolvedValue({ success: true });

    const result = await createFeedbackQueueConsumer()(makeFeedbackItem(), null);

    expect(mockSubmitFeedbackOnce).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true });
  });

  it('reuses the SAME persisted eventId on submit (idempotency across retries)', async () => {
    const payload = validPayload();
    mockLoadJsonPayload.mockResolvedValue(payload);
    mockSubmitFeedbackOnce.mockResolvedValue({ success: true });

    await createFeedbackQueueConsumer()(makeFeedbackItem({ attempts: 3 }), null);

    expect(mockSubmitFeedbackOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'abcdef0123456789abcdef0123456789',
        clientReportId: 'report-1',
      }),
      undefined, // no AbortSignal supplied to the consumer in this test
    );
  });

  it('422 (Sentry unconfigured) → permanent (terminalize; payload retained by queue)', async () => {
    mockLoadJsonPayload.mockResolvedValue(validPayload());
    mockSubmitFeedbackOnce.mockRejectedValue(new CloudClientError('HTTP 422', 422));

    const result = await createFeedbackQueueConsumer()(makeFeedbackItem(), null);

    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe('permanent');
  });

  it('503 (flush timeout) → temporary (retry with backoff)', async () => {
    mockLoadJsonPayload.mockResolvedValue(validPayload());
    mockSubmitFeedbackOnce.mockRejectedValue(new CloudClientError('HTTP 503', 503));

    const result = await createFeedbackQueueConsumer()(makeFeedbackItem(), null);

    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe('temporary');
  });

  it('429 (rate limited) → temporary (retry)', async () => {
    mockLoadJsonPayload.mockResolvedValue(validPayload());
    mockSubmitFeedbackOnce.mockRejectedValue(new CloudClientError('HTTP 429', 429));

    const result = await createFeedbackQueueConsumer()(makeFeedbackItem(), null);

    expect(result.errorCategory).toBe('temporary');
  });

  it('401 (token expired) → auth (retained; delivers after re-pair)', async () => {
    mockLoadJsonPayload.mockResolvedValue(validPayload());
    mockSubmitFeedbackOnce.mockRejectedValue(new CloudClientError('Unauthorized', 401));

    const result = await createFeedbackQueueConsumer()(makeFeedbackItem(), null);

    expect(result.errorCategory).toBe('auth');
  });

  it('network/transport error (no HTTP status) → network (retry + connectivity UI)', async () => {
    mockLoadJsonPayload.mockResolvedValue(validPayload());
    mockSubmitFeedbackOnce.mockRejectedValue(new Error('Network request failed'));

    const result = await createFeedbackQueueConsumer()(makeFeedbackItem(), null);

    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe('network');
  });

  it('missing persisted payload → permanent (nothing to deliver, do not spin)', async () => {
    mockLoadJsonPayload.mockResolvedValue(null);

    const result = await createFeedbackQueueConsumer()(makeFeedbackItem(), null);

    expect(mockSubmitFeedbackOnce).not.toHaveBeenCalled();
    expect(result.errorCategory).toBe('permanent');
    expect(result.error).toContain('Feedback payload missing');
  });

  it('empty message payload → permanent (do not submit an empty report)', async () => {
    mockLoadJsonPayload.mockResolvedValue(validPayload({ message: '   ' }));

    const result = await createFeedbackQueueConsumer()(makeFeedbackItem(), null);

    expect(mockSubmitFeedbackOnce).not.toHaveBeenCalled();
    expect(result.errorCategory).toBe('permanent');
  });
});
