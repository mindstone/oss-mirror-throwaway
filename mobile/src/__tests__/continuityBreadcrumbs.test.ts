/**
 * continuityBreadcrumbs tests.
 *
 * Verifies the generalised recordContinuityBreadcrumb pipeline:
 *   1. Sanitizer drops unknown fields and keeps the allowlisted ones.
 *   2. Escalation policy per family:
 *      - session-merge/dropped-turn    -> warning
 *      - outbox/retry-exhausted         -> error
 *      - catch-up/catch-up-unusually-large -> warning
 *      - continuity-state/invariant-violation -> error
 *      - continuity-state/stuck-outbox  -> warning
 *      - conflict/concurrent-edit       -> warning
 *      - everything else               -> breadcrumb only
 *   3. Escalation throttling is per cooldown key (direction+reason for
 *      merge, errorCategory for outbox, invariant name, etc.) and
 *      resets after 1 hour.
 *   4. Family-qualified breadcrumb category (`continuity.<family>`).
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
    __mocks: { addBreadcrumb, captureMessage, setTag, setLevel, setContext },
  };
});

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

import {
  __resetContinuityEscalationCooldownForTests,
  recordContinuityBreadcrumb,
} from '../utils/continuityBreadcrumbs';
import type { ContinuityTransitionEvent } from '@rebel/cloud-client';

beforeEach(() => {
  jest.useFakeTimers();
  addBreadcrumbMock.mockClear();
  captureMessageMock.mockClear();
  setTagMock.mockClear();
  setLevelMock.mockClear();
  setContextMock.mockClear();
  __resetContinuityEscalationCooldownForTests();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('recordContinuityBreadcrumb — sanitizer', () => {
  it('drops unknown keys from event.data and keeps allowlisted ones', () => {
    recordContinuityBreadcrumb({
      family: 'session-merge',
      message: 'complete',
      data: {
        direction: 'desktop-pull',
        sessionCount: 2,
        addedTurnCount: 5,
        droppedTurnCount: 0,
        conflictCount: 0,
        localOnlyCount: 0,
        durationMs: 10,
        // @ts-expect-error — simulate a developer accidentally leaking a raw ID
        rawSessionId: 'session_leak_me',
      },
    });
    const crumb = addBreadcrumbMock.mock.calls[0][0];
    expect(crumb.category).toBe('continuity.session-merge');
    expect(crumb.data).toEqual({
      direction: 'desktop-pull',
      sessionCount: 2,
      addedTurnCount: 5,
      droppedTurnCount: 0,
      conflictCount: 0,
      localOnlyCount: 0,
      durationMs: 10,
    });
    expect(crumb.data).not.toHaveProperty('rawSessionId');
  });

  it('uses family-qualified breadcrumb category', () => {
    recordContinuityBreadcrumb({
      family: 'catch-up',
      message: 'catch-up-started',
      data: { missedSince: 1700000000, sessionIdCount: 4 },
    });
    expect(addBreadcrumbMock.mock.calls[0][0].category).toBe('continuity.catch-up');
  });

  it('sanitizes session-delta-push data through the family SAFE_KEYS allowlist', () => {
    recordContinuityBreadcrumb({
      family: 'session-delta-push',
      message: 'applied',
      data: {
        sessionIdHash: 'hashed-session',
        appliedCount: 2,
        serverSeq: 20,
        cloudUpdatedAt: 1_700_000_000_000,
        baseSeq: 18,
        payloadBytes: 1024,
        gzipBytes: 512,
        // @ts-expect-error — simulate a developer accidentally leaking raw content
        rawTitle: 'private conversation title',
      },
    });
    const crumb = addBreadcrumbMock.mock.calls[0][0];
    expect(crumb.category).toBe('continuity.session-delta-push');
    expect(crumb.data).toEqual({
      sessionIdHash: 'hashed-session',
      appliedCount: 2,
      serverSeq: 20,
      cloudUpdatedAt: 1_700_000_000_000,
      baseSeq: 18,
      payloadBytes: 1024,
      gzipBytes: 512,
    });
    expect(crumb.data).not.toHaveProperty('rawTitle');
  });
});

describe('recordContinuityBreadcrumb — escalation policy', () => {
  it('escalates session-merge dropped-turn at warning level', () => {
    recordContinuityBreadcrumb({
      family: 'session-merge',
      message: 'dropped-turn',
      level: 'warning',
      data: { direction: 'cloud-push', sessionIdHash: 'abc', reason: 'busy-session' },
    });
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    expect(captureMessageMock).toHaveBeenCalledWith(expect.stringContaining('busy-session'), 'warning');
  });

  it('escalates outbox retry-exhausted at error level', () => {
    recordContinuityBreadcrumb({
      family: 'outbox',
      message: 'retry-exhausted',
      level: 'error',
      data: {
        sessionIdHash: 'a',
        turnIdHash: 'b',
        clientTurnId: 'ULID1',
        attempts: 5,
        errorCategory: 'server-5xx',
      },
    });
    expect(captureMessageMock).toHaveBeenCalledWith(expect.stringContaining('server-5xx'), 'error');
  });

  it('escalates catch-up unusually-large at warning level', () => {
    recordContinuityBreadcrumb({
      family: 'catch-up',
      message: 'catch-up-unusually-large',
      level: 'warning',
      data: { addedEvents: 2000, missedSince: null },
    });
    expect(captureMessageMock).toHaveBeenCalledWith(expect.stringContaining('unusually many'), 'warning');
  });

  it('escalates session-delta-push needs-reconcile at warning level', () => {
    recordContinuityBreadcrumb({
      family: 'session-delta-push',
      message: 'needs-reconcile',
      level: 'warning',
      data: { sessionIdHash: 'a', baseSeq: 10, serverSeq: 12 },
    });
    expect(captureMessageMock).toHaveBeenCalledWith(expect.stringContaining('needs-reconcile'), 'warning');
  });

  it('escalates session-delta-push drift-detected at warning level', () => {
    recordContinuityBreadcrumb({
      family: 'session-delta-push',
      message: 'drift-detected',
      level: 'warning',
      data: { sessionIdHash: 'a', baseSeq: 90, serverSeq: 50 },
    });
    expect(captureMessageMock).toHaveBeenCalledWith(expect.stringContaining('drift-detected'), 'warning');
  });

  it('escalates continuity-state invariant-violation at error level', () => {
    recordContinuityBreadcrumb({
      family: 'continuity-state',
      message: 'invariant-violation',
      level: 'error',
      data: { sessionIdHash: 'a', invariant: 'cloud_active-requires-ack' },
    });
    expect(captureMessageMock).toHaveBeenCalledWith(expect.stringContaining('cloud_active-requires-ack'), 'error');
  });

  it('escalates continuity-state tombstone-race-detected at warning level', () => {
    recordContinuityBreadcrumb({
      family: 'continuity-state',
      message: 'state-transition',
      level: 'warning',
      data: {
        sessionIdHash: 'a',
        from: 'cloud_active',
        to: 'local_only',
        reason: 'tombstone-race-detected',
        direction: 'mobile-pull',
      },
    });
    expect(captureMessageMock).toHaveBeenCalledWith(expect.stringContaining('Tombstone race detected'), 'warning');
  });

  it('escalates continuity-state stuck-outbox at warning level', () => {
    recordContinuityBreadcrumb({
      family: 'continuity-state',
      message: 'stuck-outbox',
      level: 'warning',
      data: {
        reason: 'stuck-outbox',
        deviceIdHash: 'device-1',
        depth: 9,
        lastDrainAt: 1234,
        ageMs: 700_000,
      },
    });
    expect(captureMessageMock).toHaveBeenCalledWith(expect.stringContaining('outbox appears stuck'), 'warning');
  });

  it('escalates conflict concurrent-edit at warning level', () => {
    recordContinuityBreadcrumb({
      family: 'conflict',
      message: 'concurrent-edit',
      level: 'warning',
      data: { sessionIdHash: 'a', conflictType: 'concurrent-edit', fields: ['title'] },
    });
    expect(captureMessageMock).toHaveBeenCalledWith(expect.stringContaining('concurrent-edit'), 'warning');
  });

  it('does NOT escalate breadcrumb-only events', () => {
    const nonEscalating: ContinuityTransitionEvent[] = [
      {
        family: 'session-merge',
        message: 'start',
        data: { direction: 'desktop-pull', sessionCount: 1 },
      },
      {
        family: 'session-merge',
        message: 'complete',
        data: {
          direction: 'desktop-pull',
          sessionCount: 1,
          addedTurnCount: 0,
          droppedTurnCount: 0,
          conflictCount: 0,
          localOnlyCount: 0,
          durationMs: 5,
        },
      },
      {
        family: 'outbox',
        message: 'queued',
        data: { sessionIdHash: 'a', turnIdHash: 'b', clientTurnId: 'u' },
      },
      {
        family: 'outbox',
        message: 'sent',
        data: { sessionIdHash: 'a', turnIdHash: 'b', clientTurnId: 'u', attempt: 1, latencyMs: 5 },
      },
      {
        family: 'catch-up',
        message: 'catch-up-started',
        data: { missedSince: null, sessionIdCount: 1 },
      },
      {
        family: 'session-delta-push',
        message: 'applied',
        data: { sessionIdHash: 'a', appliedCount: 1, serverSeq: 5, cloudUpdatedAt: 123, baseSeq: 4 },
      },
      {
        family: 'session-delta-push',
        message: 'metadata-patch-applied',
        data: { sessionIdHash: 'a', baseSeq: 5, cloudUpdatedAt: 456 },
      },
      {
        family: 'continuity-state',
        message: 'state-transition',
        data: { sessionIdHash: 'a', from: 'local_only', to: 'cloud_active', reason: 'first-cloud-sync' },
      },
      {
        family: 'conflict',
        message: 'stale-metadata',
        level: 'warning',
        data: {
          sessionIdHash: 'a',
          conflictType: 'stale-metadata',
          fields: ['title'],
          serverCloudUpdatedAt: 100,
          clientCloudUpdatedAt: 90,
          staleBy: 'cloudUpdatedAt',
        },
      },
    ];
    for (const ev of nonEscalating) recordContinuityBreadcrumb(ev);
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(nonEscalating.length);
    expect(captureMessageMock).not.toHaveBeenCalled();
  });
});

describe('recordContinuityBreadcrumb — throttling', () => {
  it('throttles repeated outbox retry-exhausted with same errorCategory within 1 hour', () => {
    const now = Date.now();
    jest.setSystemTime(now);

    recordContinuityBreadcrumb({
      family: 'outbox',
      message: 'retry-exhausted',
      level: 'error',
      data: {
        sessionIdHash: 'a',
        turnIdHash: 'b',
        clientTurnId: 'u',
        attempts: 5,
        errorCategory: 'network',
      },
    });
    recordContinuityBreadcrumb({
      family: 'outbox',
      message: 'retry-exhausted',
      level: 'error',
      data: {
        sessionIdHash: 'a2',
        turnIdHash: 'b2',
        clientTurnId: 'u2',
        attempts: 5,
        errorCategory: 'network',
      },
    });
    expect(captureMessageMock).toHaveBeenCalledTimes(1);

    jest.setSystemTime(now + 60 * 60 * 1000 + 1);
    recordContinuityBreadcrumb({
      family: 'outbox',
      message: 'retry-exhausted',
      level: 'error',
      data: {
        sessionIdHash: 'a3',
        turnIdHash: 'b3',
        clientTurnId: 'u3',
        attempts: 5,
        errorCategory: 'network',
      },
    });
    expect(captureMessageMock).toHaveBeenCalledTimes(2);
  });

  it('escalates distinct outbox errorCategories independently (per-category cooldown)', () => {
    recordContinuityBreadcrumb({
      family: 'outbox',
      message: 'retry-exhausted',
      level: 'error',
      data: {
        sessionIdHash: 'a',
        turnIdHash: 'b',
        clientTurnId: 'u',
        attempts: 5,
        errorCategory: 'network',
      },
    });
    recordContinuityBreadcrumb({
      family: 'outbox',
      message: 'retry-exhausted',
      level: 'error',
      data: {
        sessionIdHash: 'a2',
        turnIdHash: 'b2',
        clientTurnId: 'u2',
        attempts: 5,
        errorCategory: 'auth',
      },
    });
    expect(captureMessageMock).toHaveBeenCalledTimes(2);
  });

  it('escalates distinct session-merge reasons independently', () => {
    recordContinuityBreadcrumb({
      family: 'session-merge',
      message: 'dropped-turn',
      level: 'warning',
      data: { direction: 'cloud-push', sessionIdHash: 'a', reason: 'busy-session' },
    });
    recordContinuityBreadcrumb({
      family: 'session-merge',
      message: 'dropped-turn',
      level: 'warning',
      data: { direction: 'cloud-push', sessionIdHash: 'a2', reason: 'seq-gap' },
    });
    expect(captureMessageMock).toHaveBeenCalledTimes(2);
  });

  it('throttles repeated session-delta-push needs-reconcile escalations with the delta-push reason key', () => {
    const now = Date.now();
    jest.setSystemTime(now);

    recordContinuityBreadcrumb({
      family: 'session-delta-push',
      message: 'needs-reconcile',
      level: 'warning',
      data: { sessionIdHash: 'a', baseSeq: 10, serverSeq: 12 },
    });
    recordContinuityBreadcrumb({
      family: 'session-delta-push',
      message: 'needs-reconcile',
      level: 'warning',
      data: { sessionIdHash: 'b', baseSeq: 11, serverSeq: 13 },
    });
    expect(captureMessageMock).toHaveBeenCalledTimes(1);

    jest.setSystemTime(now + 60 * 60 * 1000 + 1);
    recordContinuityBreadcrumb({
      family: 'session-delta-push',
      message: 'needs-reconcile',
      level: 'warning',
      data: { sessionIdHash: 'c', baseSeq: 12, serverSeq: 14 },
    });
    expect(captureMessageMock).toHaveBeenCalledTimes(2);
  });

  it('uses independent cooldown keys for session-delta-push reasons', () => {
    recordContinuityBreadcrumb({
      family: 'session-delta-push',
      message: 'needs-reconcile',
      level: 'warning',
      data: { sessionIdHash: 'a', baseSeq: 10, serverSeq: 12 },
    });
    recordContinuityBreadcrumb({
      family: 'session-delta-push',
      message: 'drift-detected',
      level: 'warning',
      data: { sessionIdHash: 'b', baseSeq: 90, serverSeq: 50 },
    });
    expect(captureMessageMock).toHaveBeenCalledTimes(2);
  });

  it('throttles conflict concurrent-edit using a shared conflict-edit key', () => {
    recordContinuityBreadcrumb({
      family: 'conflict',
      message: 'concurrent-edit',
      level: 'warning',
      data: { sessionIdHash: 'a', conflictType: 'concurrent-edit', fields: ['title'] },
    });
    recordContinuityBreadcrumb({
      family: 'conflict',
      message: 'concurrent-edit',
      level: 'warning',
      data: { sessionIdHash: 'b', conflictType: 'concurrent-edit', fields: ['title'] },
    });
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
  });

  it('does not throttle invariant-violation escalation', () => {
    recordContinuityBreadcrumb({
      family: 'continuity-state',
      message: 'invariant-violation',
      level: 'error',
      data: { sessionIdHash: 'a', invariant: 'cloud-active-requires-acked-turn-id' },
    });
    recordContinuityBreadcrumb({
      family: 'continuity-state',
      message: 'invariant-violation',
      level: 'error',
      data: { sessionIdHash: 'a', invariant: 'cloud-active-requires-acked-turn-id' },
    });
    expect(captureMessageMock).toHaveBeenCalledTimes(2);
  });
});

describe('recordContinuityBreadcrumb — safety', () => {
  it('does not throw when Sentry.captureMessage throws', () => {
    captureMessageMock.mockImplementationOnce(() => {
      throw new Error('sentry offline');
    });
    expect(() =>
      recordContinuityBreadcrumb({
        family: 'conflict',
        message: 'concurrent-edit',
        level: 'warning',
        data: { sessionIdHash: 'a', conflictType: 'concurrent-edit', fields: ['title'] },
      }),
    ).not.toThrow();
    // breadcrumb should still have been recorded
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
  });
});
