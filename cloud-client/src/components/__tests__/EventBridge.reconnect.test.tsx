import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { AgentEvent } from '@shared/types';
import type { ContinuityTransitionEvent } from '../../observability/continuityEvents';
import { EventBridge } from '../EventBridge';
import { CloudClientError, SessionTombstonedError } from '../../cloudClient';

type UseEventHandler = (channel: string, args: unknown[]) => void;
type ReconnectHandler = () => void;

let capturedOnEvent: UseEventHandler | null = null;
let capturedOnReconnect: ReconnectHandler | null = null;

const mockCatchUpSession = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockCatchUpContinuity = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockIsNetworkError = vi.fn<(err: unknown) => boolean>((err) => err instanceof TypeError);
const mockSetConnectionState = vi.fn();
const mockSetForceEventReconnect = vi.fn();
const mockHandleSessionChanged = vi.fn();
const mockHandleSessionTombstoned = vi.fn();
const mockApplyCatchUpEvents = vi.fn();
const mockRecordContinuityEvent = vi.fn();
const mockFetchSessions = vi.fn();
const mockMarkSessionConflict = vi.fn();
const mockClearSessionConflict = vi.fn();
const appliedSeqBySession: Record<string, number> = {};
const appliedSeqHistoryBySession: Record<string, number[]> = {};

const mockApprovalStore = {
  handleApprovalEvent: vi.fn(),
  handleMemoryEvent: vi.fn(),
};
const mockInboxStore = { handleInboxEvent: vi.fn() };
const mockStagedFilesStore = { handleStagedFilesChanged: vi.fn() };

function resetSessionState(): void {
  for (const key of Object.keys(appliedSeqBySession)) delete appliedSeqBySession[key];
  for (const key of Object.keys(appliedSeqHistoryBySession)) delete appliedSeqHistoryBySession[key];
  mockCatchUpSession.mockReset();
  mockCatchUpContinuity.mockReset();
  mockIsNetworkError.mockClear();
  mockSetConnectionState.mockClear();
  mockSetForceEventReconnect.mockClear();
  mockHandleSessionChanged.mockClear();
  mockHandleSessionTombstoned.mockClear();
  mockApplyCatchUpEvents.mockClear();
  mockRecordContinuityEvent.mockClear();
  mockFetchSessions.mockClear();
  mockFetchSessions.mockResolvedValue(undefined);
  mockMarkSessionConflict.mockClear();
  mockClearSessionConflict.mockClear();
  mockApprovalStore.handleApprovalEvent.mockClear();
  mockApprovalStore.handleMemoryEvent.mockClear();
  mockInboxStore.handleInboxEvent.mockClear();
  mockStagedFilesStore.handleStagedFilesChanged.mockClear();
}

function makeStatusEvent(seq: number, prefix = 'event'): AgentEvent {
  return {
    type: 'status',
    message: `${prefix}-${seq}`,
    timestamp: seq,
    seq,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

vi.mock('../../hooks/useEventChannel', () => ({
  useEventChannel: (
    onEvent: UseEventHandler,
    _onConnectionStateChange?: (state: 'connected' | 'reconnecting' | 'disconnected') => void,
    onReconnect?: ReconnectHandler,
  ) => {
    capturedOnEvent = onEvent;
    capturedOnReconnect = onReconnect ?? null;
    return { forceReconnect: vi.fn() };
  },
}));

vi.mock('../../auth/createAuthStore', () => ({
  useAuthStore: Object.assign(
    (selector: (state: { isPaired: boolean }) => unknown) => selector({ isPaired: true }),
    {
      getState: () => ({ isPaired: true }),
    },
  ),
}));

vi.mock('../../cloudClient', async () => {
  const actual = await vi.importActual<typeof import('../../cloudClient')>('../../cloudClient');
  return {
    ...actual,
    catchUpSession: (...args: unknown[]) => mockCatchUpSession(...args),
    catchUpContinuity: (...args: unknown[]) => mockCatchUpContinuity(...args),
    isNetworkError: (err: unknown) => mockIsNetworkError(err),
  };
});

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      appliedSeq: appliedSeqBySession,
      handleSessionChanged: mockHandleSessionChanged,
      handleSessionTombstoned: mockHandleSessionTombstoned,
      setConnectionState: mockSetConnectionState,
      setForceEventReconnect: mockSetForceEventReconnect,
      applyCatchUpEvents: mockApplyCatchUpEvents,
      recordContinuityEvent: mockRecordContinuityEvent,
      fetchSessions: mockFetchSessions,
      currentSession: null,
    }),
  },
}));

vi.mock('../../stores/approvalStore', () => ({
  useApprovalStore: {
    getState: () => mockApprovalStore,
  },
}));

vi.mock('../../stores/inboxStore', () => ({
  useInboxStore: {
    getState: () => mockInboxStore,
  },
}));

vi.mock('../../stores/stagedFilesStore', () => ({
  useStagedFilesStore: {
    getState: () => mockStagedFilesStore,
  },
}));

vi.mock('../../stores/sessionConflictStore', () => ({
  useSessionConflictStore: {
    getState: () => ({
      markSessionConflict: mockMarkSessionConflict,
      clearSessionConflict: mockClearSessionConflict,
    }),
  },
}));

describe('EventBridge reconnect catch-up', () => {
  beforeEach(() => {
    resetSessionState();
    capturedOnEvent = null;
    capturedOnReconnect = null;

    mockApplyCatchUpEvents.mockImplementation((sessionId: string, events: AgentEvent[]) => {
      const sorted = [...events].sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER));
      let addedEvents = 0;
      for (const event of sorted) {
        const seq = event.seq;
        if (typeof seq !== 'number') continue;
        const current = appliedSeqBySession[sessionId] ?? 0;
        if (seq <= current) continue;
        appliedSeqBySession[sessionId] = seq;
        (appliedSeqHistoryBySession[sessionId] ??= []).push(seq);
        addedEvents += 1;
      }
      return { addedEvents, highestSeq: appliedSeqBySession[sessionId] ?? 0 };
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('triggers catch-up per session on reconnect', async () => {
    appliedSeqBySession['session-a'] = 10;
    appliedSeqBySession['session-b'] = 20;
    mockCatchUpContinuity.mockResolvedValueOnce({
      sessions: {
        'session-a': { events: [makeStatusEvent(11)], maxSeq: 11 },
        'session-b': { events: [makeStatusEvent(21)], maxSeq: 21 },
      },
      serverNow: 100,
    });

    render(React.createElement(EventBridge));
    expect(capturedOnReconnect).not.toBeNull();

    capturedOnReconnect!();

    await waitFor(() => {
      expect(mockCatchUpContinuity).toHaveBeenCalledTimes(1);
    });
    expect(mockCatchUpContinuity).toHaveBeenCalledWith({
      sinceSeq: { 'session-a': 10, 'session-b': 20 },
      sessionIds: ['session-a', 'session-b'],
    });
    expect(mockFetchSessions).toHaveBeenCalledWith({ forceFullRefresh: true });

    expect(mockRecordContinuityEvent).toHaveBeenCalledWith(expect.objectContaining({
      family: 'catch-up',
      message: 'catch-up-started',
    } satisfies Partial<ContinuityTransitionEvent>));
    expect(mockRecordContinuityEvent).toHaveBeenCalledWith(expect.objectContaining({
      family: 'catch-up',
      message: 'catch-up-success',
    } satisfies Partial<ContinuityTransitionEvent>));
  });

  it('buffers live events during catch-up and applies them after barrier release', async () => {
    appliedSeqBySession['session-a'] = 5;
    const deferred = createDeferred<{
      sessions: Record<string, { events: AgentEvent[]; maxSeq: number }>;
      serverNow: number;
    }>();
    mockCatchUpContinuity.mockReturnValueOnce(deferred.promise);

    render(React.createElement(EventBridge));
    capturedOnReconnect!();

    capturedOnEvent!('cloud:session-changed', [{ sessionId: 'session-a', action: 'upserted' }]);
    expect(mockHandleSessionChanged).not.toHaveBeenCalled();

    deferred.resolve({
      sessions: { 'session-a': { events: [makeStatusEvent(6)], maxSeq: 6 } },
      serverNow: 100,
    });

    await waitFor(() => {
      expect(mockHandleSessionChanged).toHaveBeenCalledWith('session-a', 'upserted');
    });
  });

  it('replays buffered seq-tracked events before buffered session-changed events', async () => {
    appliedSeqBySession['session-a'] = 5;
    const deferred = createDeferred<{
      sessions: Record<string, { events: AgentEvent[]; maxSeq: number }>;
      serverNow: number;
    }>();
    mockCatchUpContinuity.mockReturnValueOnce(deferred.promise);

    render(React.createElement(EventBridge));
    capturedOnReconnect!();

    capturedOnEvent!('cloud:session-changed', [{ sessionId: 'session-a', action: 'upserted' }]);
    capturedOnEvent!('cloud:session-event', [{ sessionId: 'session-a', event: makeStatusEvent(6, 'live') }]);

    deferred.resolve({
      sessions: { 'session-a': { events: [], maxSeq: 5 } },
      serverNow: 100,
    });

    await waitFor(() => {
      expect(mockApplyCatchUpEvents).toHaveBeenCalledWith('session-a', [expect.objectContaining({ seq: 6 })]);
      expect(mockHandleSessionChanged).toHaveBeenCalledWith('session-a', 'upserted');
    });

    const seqEventCallIndex = mockApplyCatchUpEvents.mock.calls.findIndex(
      (call) => Array.isArray(call[1]) && call[1][0] && (call[1][0] as AgentEvent).seq === 6,
    );
    expect(seqEventCallIndex).toBeGreaterThanOrEqual(0);
    const applyOrder = mockApplyCatchUpEvents.mock.invocationCallOrder[seqEventCallIndex];
    const changedOrder = mockHandleSessionChanged.mock.invocationCallOrder[0];
    expect(applyOrder).toBeLessThan(changedOrder);
  });

  it('forwards cloud session-conflict payloads to sessionConflictStore', async () => {
    render(React.createElement(EventBridge));

    capturedOnEvent!('cloud:session-conflict', [{
      sessionId: 'session-a',
      conflictType: 'concurrent-edit',
      fields: ['title', 'doneAt'],
      detectedAt: 1_700_000_000_000,
    }]);

    expect(mockMarkSessionConflict).toHaveBeenCalledWith({
      sessionId: 'session-a',
      conflictType: 'concurrent-edit',
      fields: ['title', 'doneAt'],
      detectedAt: 1_700_000_000_000,
    });
  });

  it('records server-restart-detected when reconnect catch-up sees a large seq gap', async () => {
    appliedSeqBySession['session-a'] = 10;
    mockCatchUpContinuity.mockResolvedValueOnce({
      sessions: {
        'session-a': {
          events: [makeStatusEvent(150)],
          maxSeq: 150,
        },
      },
      serverNow: 100,
    });

    render(React.createElement(EventBridge));
    capturedOnReconnect!();

    await waitFor(() => {
      expect(mockRecordContinuityEvent).toHaveBeenCalledWith(expect.objectContaining({
        family: 'continuity-state',
        message: 'transition',
        level: 'warning',
        data: expect.objectContaining({
          reason: 'server-restart-detected',
          direction: 'event-channel-reconnect',
        }),
      } satisfies Partial<ContinuityTransitionEvent>));
    });
  });

  it('fails open after catch-up retries are exhausted', async () => {
    vi.useFakeTimers();
    appliedSeqBySession['session-a'] = 7;
    mockCatchUpContinuity.mockRejectedValue(new TypeError('network down'));

    render(React.createElement(EventBridge));
    capturedOnReconnect!();
    capturedOnEvent!('cloud:session-changed', [{ sessionId: 'session-a', action: 'upserted' }]);

    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockCatchUpContinuity).toHaveBeenCalledTimes(3);
    expect(mockRecordContinuityEvent).toHaveBeenCalledWith(expect.objectContaining({
      family: 'catch-up',
      message: 'catch-up-failed',
      level: 'error',
    } satisfies Partial<ContinuityTransitionEvent>));
    expect(mockHandleSessionChanged).toHaveBeenCalledWith('session-a', 'upserted');
  });

  it('emits catch-up-unusually-large when catch-up applies more than 1000 events', async () => {
    appliedSeqBySession['session-a'] = 0;
    const events = Array.from({ length: 1001 }, (_, i) => makeStatusEvent(i + 1));
    mockCatchUpContinuity.mockResolvedValueOnce({
      sessions: { 'session-a': { events, maxSeq: 1001 } },
      serverNow: 100,
    });

    render(React.createElement(EventBridge));
    capturedOnReconnect!();

    await waitFor(() => {
      expect(mockRecordContinuityEvent).toHaveBeenCalledWith(expect.objectContaining({
        family: 'catch-up',
        message: 'catch-up-unusually-large',
      } satisfies Partial<ContinuityTransitionEvent>));
    });
  });

  it('replays 500 offline events in seq order with no duplicates after reconnect', async () => {
    appliedSeqBySession['session-a'] = 100;
    const catchUpEvents = Array.from({ length: 500 }, (_, i) => makeStatusEvent(i + 101, 'catchup'));
    const deferred = createDeferred<{
      sessions: Record<string, { events: AgentEvent[]; maxSeq: number }>;
      serverNow: number;
    }>();
    mockCatchUpContinuity.mockReturnValueOnce(deferred.promise);

    render(React.createElement(EventBridge));
    capturedOnReconnect!();

    for (let seq = 550; seq <= 605; seq += 1) {
      capturedOnEvent!('cloud:session-event', [{ sessionId: 'session-a', event: makeStatusEvent(seq, 'live') }]);
    }

    deferred.resolve({
      sessions: { 'session-a': { events: catchUpEvents, maxSeq: 600 } },
      serverNow: 100,
    });

    await waitFor(() => {
      expect(appliedSeqBySession['session-a']).toBe(605);
    });

    const history = appliedSeqHistoryBySession['session-a'] ?? [];
    expect(history.length).toBe(505); // 500 catch-up + 5 new live events (601-605)
    const unique = new Set(history);
    expect(unique.size).toBe(history.length);
    expect(history[0]).toBe(101);
    expect(history[history.length - 1]).toBe(605);
    expect(history).toEqual([...history].sort((a, b) => a - b));
  });

  it('emits catch-up-unavailable for legacy servers returning 404', async () => {
    appliedSeqBySession['session-a'] = 12;
    mockCatchUpContinuity.mockRejectedValue(new CloudClientError('not found', 404));
    mockCatchUpSession.mockRejectedValue(new CloudClientError('not found', 404));

    render(React.createElement(EventBridge));
    capturedOnReconnect!();

    await waitFor(() => {
      expect(mockRecordContinuityEvent).toHaveBeenCalledWith(expect.objectContaining({
        family: 'catch-up',
        message: 'catch-up-unavailable',
      } satisfies Partial<ContinuityTransitionEvent>));
    });
  });

  it('applies tombstones instead of misclassifying them as catch-up-unavailable during legacy fallback', async () => {
    appliedSeqBySession['session-a'] = 12;
    mockCatchUpContinuity.mockRejectedValue(new CloudClientError('not found', 404));
    mockCatchUpSession.mockRejectedValueOnce(new SessionTombstonedError({
      sessionId: 'session-a',
      deletedAt: 1_700_000_000_000,
      deletedBy: 'mobile',
      ttlExpiresAt: 1_700_000_100_000,
    }));

    render(React.createElement(EventBridge));
    capturedOnReconnect!();

    await waitFor(() => {
      expect(mockHandleSessionTombstoned).toHaveBeenCalledWith({
        sessionId: 'session-a',
        deletedAt: 1_700_000_000_000,
        deletedBy: 'mobile',
        ttlExpiresAt: 1_700_000_100_000,
      });
    });

    expect(mockRecordContinuityEvent).toHaveBeenCalledWith(expect.objectContaining({
      family: 'catch-up',
      message: 'catch-up-session-tombstoned',
      data: expect.objectContaining({
        reason: 'session-tombstoned',
        deletedAt: 1_700_000_000_000,
      }),
    } satisfies Partial<ContinuityTransitionEvent>));
    expect(mockRecordContinuityEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      family: 'catch-up',
      message: 'catch-up-unavailable',
    } satisfies Partial<ContinuityTransitionEvent>));
  });
});
