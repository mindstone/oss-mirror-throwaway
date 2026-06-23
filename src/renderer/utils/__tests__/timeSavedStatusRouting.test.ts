import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimeSavedStatus } from '@shared/types';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';

const { breadcrumbMock } = vi.hoisted(() => ({
  breadcrumbMock: vi.fn(),
}));

vi.mock('@renderer/src/sentry', () => ({
  recordRendererBreadcrumb: (...args: unknown[]) => breadcrumbMock(...args),
}));

import {
  resetTimeSavedStatusRoutingWarningsForTests,
  shouldHandleMilestoneTimeSavedStatus,
  shouldRefreshProgressTimeSavedStatus,
  shouldRefreshTimeSavedBySessionStatus,
  shouldHandleConversationPaneTimeSavedStatus,
} from '../timeSavedStatusRouting';

const subscribers = [
  {
    name: 'TimeSavedMilestoneChecker',
    fn: shouldHandleMilestoneTimeSavedStatus,
    consumer: 'TimeSavedMilestoneChecker',
  },
  {
    name: 'useProgressData',
    fn: shouldRefreshProgressTimeSavedStatus,
    consumer: 'useProgressData',
  },
  {
    name: 'useIpcListeners',
    fn: shouldRefreshTimeSavedBySessionStatus,
    consumer: 'useIpcListeners',
  },
  {
    name: 'ConversationPane',
    fn: shouldHandleConversationPaneTimeSavedStatus,
    consumer: 'ConversationPane',
  },
] as const;

function makeStatus(overrides: Partial<TimeSavedStatus>): TimeSavedStatus {
  return {
    turnId: 'turn-1',
    status: 'success',
    originalSessionId: 'session-active',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('timeSavedStatusRouting subscriber filters', () => {
  beforeEach(() => {
    resetTimeSavedStatusRoutingWarningsForTests();
    vi.clearAllMocks();
  });

  for (const subscriber of subscribers) {
    it(`${subscriber.name}: applies same-session success broadcasts`, () => {
      const shouldHandle = subscriber.fn(
        makeStatus({ originalSessionId: 'session-active', status: 'success' }),
        'session-active',
      );

      expect(shouldHandle).toBe(true);
      expect(breadcrumbMock).not.toHaveBeenCalled();
    });

    it(`${subscriber.name}: routes cross-session broadcasts away from active listeners`, () => {
      const shouldHandle = subscriber.fn(
        makeStatus({ originalSessionId: 'session-origin' }),
        'session-active',
      );

      expect(shouldHandle).toBe(false);
      expect(breadcrumbMock).not.toHaveBeenCalled();
    });

    it(`${subscriber.name}: drops legacy broadcasts and emits hashed breadcrumb`, () => {
      const turnId = `turn-legacy-${subscriber.consumer}`;
      const shouldHandle = subscriber.fn(
        makeStatus({ turnId, originalSessionId: undefined }),
        'session-active',
      );

      expect(shouldHandle).toBe(false);
      expect(breadcrumbMock).toHaveBeenCalledWith(expect.objectContaining({
        category: 'legacy-broadcast-without-originalSessionId',
        data: expect.objectContaining({
          eventType: 'time-saved:status',
          consumer: subscriber.consumer,
          activeSessionIdHash: hashSessionIdForBreadcrumb('session-active'),
          turnIdHash: hashSessionIdForBreadcrumb(turnId),
        }),
      }));
    });
  }
});
