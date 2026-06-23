/**
 * Tests for the push-notification routing + dispatch helpers.
 *
 * Exercises `routePushNotification` (pure router) and
 * `dispatchPushNotificationData` (boundary parse + sanitised log on
 * failure). The full `setupNotificationListeners` is not unit-tested
 * here because it just wires `expo-notifications`'s listener; the parse
 * and routing logic is fully covered via the dispatcher.
 *
 * @see docs/plans/finished/260502_typed_push_notification_payload.md
 */

import {
  buildApprovalPush,
  buildCoachingPush,
  buildConversationPush,
  buildMeetingAnalysisCompletePush,
} from '@shared/schemas/pushNotifications';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: {
    push: (...args: unknown[]) => mockPush(...args),
  },
}));

const mockWarn = jest.fn();
jest.mock('@rebel/cloud-client', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...args: unknown[]) => mockWarn(...args),
    error: jest.fn(),
  }),
}));

// expo-notifications is not exercised in these unit tests, but jest-expo's
// preset auto-mocks it. We don't need an explicit mock here.

import { dispatchPushNotificationData, routePushNotification } from '../pushNotifications';

beforeEach(() => {
  mockPush.mockClear();
  mockWarn.mockClear();
});

describe('routePushNotification', () => {
  it('routes conversation/turn-complete to the conversation screen', () => {
    routePushNotification(buildConversationPush({ kind: 'turn-complete', sessionId: 'sess_1' }));
    expect(mockPush).toHaveBeenCalledWith('/conversation/sess_1');
  });

  it('routes conversation/turn-error to the conversation screen', () => {
    routePushNotification(buildConversationPush({ kind: 'turn-error', sessionId: 'sess_2' }));
    expect(mockPush).toHaveBeenCalledWith('/conversation/sess_2');
  });

  it('routes conversation/question to the conversation screen', () => {
    routePushNotification(buildConversationPush({ kind: 'question', sessionId: 'sess_3' }));
    expect(mockPush).toHaveBeenCalledWith('/conversation/sess_3');
  });

  it('routes approval (with sessionId) to the conversation screen', () => {
    routePushNotification(buildApprovalPush({ kind: 'tool-approval', sessionId: 'sess_4' }));
    expect(mockPush).toHaveBeenCalledWith('/conversation/sess_4');
  });

  it('routes approval (without sessionId) to the inbox tab', () => {
    routePushNotification(buildApprovalPush({ kind: 'staged-file' }));
    expect(mockPush).toHaveBeenCalledWith('/(tabs)/inbox');
  });

  it('routes memory-approval (with sessionId) to the conversation screen', () => {
    routePushNotification(buildApprovalPush({ kind: 'memory-approval', sessionId: 'sess_5' }));
    expect(mockPush).toHaveBeenCalledWith('/conversation/sess_5');
  });

  it('routes coaching (with sessionId) to the conversation screen — previously dropped', () => {
    routePushNotification(buildCoachingPush({ sessionId: 'sess_6' }));
    expect(mockPush).toHaveBeenCalledWith('/conversation/sess_6');
  });

  it('routes coaching (without sessionId) to the inbox tab — previously dropped', () => {
    routePushNotification(buildCoachingPush({}));
    expect(mockPush).toHaveBeenCalledWith('/(tabs)/inbox');
  });

  it('routes meeting-analysis-complete to the conversation screen — previously dropped', () => {
    routePushNotification(
      buildMeetingAnalysisCompletePush({ sessionId: 'sess_7', meetingTitle: 'Demo' }),
    );
    expect(mockPush).toHaveBeenCalledWith('/conversation/sess_7');
  });
});

describe('dispatchPushNotificationData — parse-failure path is sanitised', () => {
  it('routes valid payloads via routePushNotification', () => {
    dispatchPushNotificationData({
      type: 'conversation',
      kind: 'turn-complete',
      sessionId: 'sess_dispatch',
    });
    expect(mockPush).toHaveBeenCalledWith('/conversation/sess_dispatch');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('logs sanitised metadata on unrecognised type — no raw payload values', () => {
    const stalePayload = {
      type: 'shouldnt-leak-into-sentry',
      sessionId: 'sensitive-session-id-xyz',
      meetingTitle: 'Sensitive Meeting Title',
    };
    dispatchPushNotificationData(stalePayload);

    expect(mockPush).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledTimes(1);

    const [msg, meta] = mockWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe('Unrecognised push payload');

    // Critical: the sanitised metadata MUST NOT contain raw payload values.
    const metaJson = JSON.stringify(meta);
    expect(metaJson).not.toContain('shouldnt-leak-into-sentry');
    expect(metaJson).not.toContain('sensitive-session-id-xyz');
    expect(metaJson).not.toContain('Sensitive Meeting Title');

    // What we DO expect to log: shape metadata + key names + zod issues.
    expect(meta).toMatchObject({
      hasType: true,
      typeIsString: true,
      hasSessionId: true,
    });
    expect(meta.keys).toEqual(expect.arrayContaining(['type', 'sessionId', 'meetingTitle']));
    expect(meta.issues).toBeDefined();
  });

  it('logs sanitised metadata on completely missing payload', () => {
    dispatchPushNotificationData(null);

    expect(mockPush).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledTimes(1);

    const [, meta] = mockWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta).toMatchObject({
      hasType: false,
      typeIsString: false,
      hasSessionId: false,
      keys: [],
    });
  });

  it('logs sanitised metadata on payload missing required sessionId', () => {
    dispatchPushNotificationData({
      type: 'conversation',
      kind: 'turn-complete',
      // sessionId missing
    });

    expect(mockPush).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});
