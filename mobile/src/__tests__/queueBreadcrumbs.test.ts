/**
 * queueBreadcrumbs tests.
 *
 * Verifies:
 *   1. Breadcrumb emission for every QueueTransitionEvent.
 *   2. Sanitizer drops unknown fields and keeps known ones (including
 *      `batchCount`, previously missing from SAFE_KEYS).
 *   3. Escalation policy per Operational lens review:
 *      - stuck-drain       -> captureMessage(warning), throttled 1/hour
 *      - item-permanent-failure (permanent) -> error
 *      - item-permanent-failure (timeout/retry-exhausted) -> warning
 *      - item-permanent-failure cooldown is per errorCategory
 *      - other events -> breadcrumb only
 *   4. Enqueue batching flushes into one breadcrumb.
 */

jest.mock('@sentry/react-native', () => {
  const addBreadcrumb = jest.fn();
  const captureMessage = jest.fn();
  const setTag = jest.fn();
  const setLevel = jest.fn();
  const setContext = jest.fn();
  return {
    __esModule: true,
    addBreadcrumb,
    captureMessage,
    withScope: (cb: (scope: { setTag: typeof setTag; setLevel: typeof setLevel; setContext: typeof setContext }) => void) => {
      cb({ setTag, setLevel, setContext });
    },
    // Expose internals for tests:
    __mocks: { addBreadcrumb, captureMessage, setTag, setLevel, setContext },
  };
});

// Pull mocks from the mocked module after jest.mock hoist.
import * as Sentry from '@sentry/react-native';
const {
  addBreadcrumb: addBreadcrumbMock,
  captureMessage: captureMessageMock,
  setTag: setTagMock,
  setLevel: setLevelMock,
  setContext: setContextMock,
} = (Sentry as unknown as {
  __mocks: {
    addBreadcrumb: jest.Mock;
    captureMessage: jest.Mock;
    setTag: jest.Mock;
    setLevel: jest.Mock;
    setContext: jest.Mock;
  };
}).__mocks;

import { __resetEscalationCooldownForTests, recordQueueBreadcrumb } from '../utils/queueBreadcrumbs';
import type { QueueTransitionEvent } from '@rebel/cloud-client';

beforeEach(() => {
  jest.useFakeTimers();
  addBreadcrumbMock.mockClear();
  captureMessageMock.mockClear();
  setTagMock.mockClear();
  setLevelMock.mockClear();
  setContextMock.mockClear();
  __resetEscalationCooldownForTests();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('recordQueueBreadcrumb', () => {
  describe('sanitizer', () => {
    it('keeps batchCount (regression guard)', () => {
      // Trigger the enqueue path twice in quick succession; the flush
      // emits a breadcrumb with `batchCount` attached.
      recordQueueBreadcrumb({
        message: 'enqueue',
        data: { itemId: 'a', type: 'text-message', totalSize: 1 },
      } as QueueTransitionEvent);
      recordQueueBreadcrumb({
        message: 'enqueue',
        data: { itemId: 'b', type: 'text-message', totalSize: 2 },
      } as QueueTransitionEvent);

      // Let the batch window elapse.
      jest.advanceTimersByTime(600);

      expect(addBreadcrumbMock).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'queue',
          message: 'enqueue',
          data: { batchCount: 2 },
        }),
      );
    });

    it('drops unknown keys from event.data', () => {
      recordQueueBreadcrumb({
        message: 'stuck-drain',
        level: 'warning',
        // @ts-expect-error — intentionally add an unknown field for test
        data: { errorCategories: ['network'], pendingCount: 3, oldestEnqueuedAt: 1, secret: 'leak-me' },
      });

      const crumb = addBreadcrumbMock.mock.calls[0][0];
      expect(crumb.data).toEqual({
        errorCategories: ['network'],
        pendingCount: 3,
        oldestEnqueuedAt: 1,
      });
      expect(crumb.data).not.toHaveProperty('secret');
    });
  });

  describe('escalation policy', () => {
    it('escalates stuck-drain to a warning Sentry message', () => {
      recordQueueBreadcrumb({
        message: 'stuck-drain',
        level: 'warning',
        data: { errorCategories: ['network'], pendingCount: 3, oldestEnqueuedAt: 1 },
      });

      expect(captureMessageMock).toHaveBeenCalledTimes(1);
      expect(captureMessageMock).toHaveBeenCalledWith('Offline queue drain is stuck', 'warning');
    });

    it('escalates item-permanent-failure (permanent) at error level', () => {
      recordQueueBreadcrumb({
        message: 'item-permanent-failure',
        level: 'warning',
        data: { itemId: 'x', type: 'text-message', errorCategory: 'permanent', attempts: 5 },
      });
      expect(captureMessageMock).toHaveBeenCalledWith(expect.stringContaining('permanent'), 'error');
    });

    it('escalates item-permanent-failure (timeout) at warning level', () => {
      recordQueueBreadcrumb({
        message: 'item-permanent-failure',
        level: 'warning',
        data: { itemId: 'x', type: 'text-message', errorCategory: 'timeout', attempts: 5 },
      });
      expect(captureMessageMock).toHaveBeenCalledWith(expect.stringContaining('timeout'), 'warning');
    });

    it('throttles repeated stuck-drain within 1 hour', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      recordQueueBreadcrumb({
        message: 'stuck-drain',
        level: 'warning',
        data: { errorCategories: ['network'], pendingCount: 1, oldestEnqueuedAt: 1 },
      });
      recordQueueBreadcrumb({
        message: 'stuck-drain',
        level: 'warning',
        data: { errorCategories: ['network'], pendingCount: 2, oldestEnqueuedAt: 2 },
      });
      expect(captureMessageMock).toHaveBeenCalledTimes(1);

      // Advance past 1 hour
      jest.setSystemTime(now + 60 * 60 * 1000 + 1);
      recordQueueBreadcrumb({
        message: 'stuck-drain',
        level: 'warning',
        data: { errorCategories: ['network'], pendingCount: 3, oldestEnqueuedAt: 3 },
      });
      expect(captureMessageMock).toHaveBeenCalledTimes(2);
    });

    it('throttles item-permanent-failure per errorCategory (distinct categories both escalate)', () => {
      recordQueueBreadcrumb({
        message: 'item-permanent-failure',
        level: 'warning',
        data: { itemId: 'x', type: 'text-message', errorCategory: 'permanent', attempts: 5 },
      });
      recordQueueBreadcrumb({
        message: 'item-permanent-failure',
        level: 'warning',
        data: { itemId: 'y', type: 'meeting-chunk', errorCategory: 'timeout', attempts: 5 },
      });
      expect(captureMessageMock).toHaveBeenCalledTimes(2);
    });

    it('does NOT escalate queue-full, auth-expired, identity-mismatch, drain-complete, clock-jump-guard', () => {
      const nonEscalating: QueueTransitionEvent[] = [
        { message: 'queue-full', level: 'warning', data: { totalSize: 100, rejectedItemType: 'text-message' } },
        { message: 'auth-expired', level: 'warning', data: { pendingCount: 3 } },
        { message: 'identity-mismatch', level: 'warning', data: { itemCount: 1 } },
        { message: 'drain-complete', data: { drainedCount: 1, failedCount: 0, skippedCount: 0 } },
        { message: 'drain-start', data: { pendingCount: 1, onlineStatus: true } },
        { message: 'clock-jump-guard', data: { itemId: 'x', oldNextRetryAt: 1, newNextRetryAt: 2 } },
      ];

      for (const ev of nonEscalating) {
        recordQueueBreadcrumb(ev);
      }

      // All should have emitted breadcrumbs
      expect(addBreadcrumbMock).toHaveBeenCalledTimes(nonEscalating.length);
      // None should have escalated
      expect(captureMessageMock).not.toHaveBeenCalled();
    });
  });
});
