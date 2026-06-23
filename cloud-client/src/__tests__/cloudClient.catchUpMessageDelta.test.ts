import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import type { FullSession, SessionMessage } from '../types';
import {
  catchUpContinuity,
  catchUpSession,
  clearConfig,
  configure,
} from '../cloudClient';

const TEST_URL = 'https://test.example.com';
const TEST_TOKEN = 'test-token';

function message(id: string, createdAt: number): SessionMessage {
  return { id, turnId: `turn-${id}`, role: 'user', text: id, createdAt };
}

function statusEvent(seq: number, turnId = 'turn-1'): AgentEvent {
  return { type: 'status', message: `event-${seq}`, timestamp: seq, seq, turnId } as AgentEvent;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('catch-up auxiliary payloads', () => {
  beforeEach(() => {
    clearConfig();
    configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearConfig();
    cleanup();
    vi.doUnmock('../cloudClient');
    vi.doUnmock('../hooks/useEventChannel');
    vi.doUnmock('../auth/createAuthStore');
    vi.doUnmock('../stores/sessionStore');
    vi.doUnmock('../stores/approvalStore');
    vi.doUnmock('../stores/inboxStore');
    vi.doUnmock('../stores/stagedFilesStore');
    vi.doUnmock('../stores/sessionConflictStore');
    vi.resetModules();
  });

  it('returns messageDelta from the final catchUpSession page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      events: [statusEvent(6)],
      serverSeq: 6,
      hasMore: false,
      messageDelta: [message('m1', 1)],
    })));

    await expect(catchUpSession('session-1', 5)).resolves.toMatchObject({
      events: [statusEvent(6)],
      serverSeq: 6,
      hasMore: false,
      messageDelta: [message('m1', 1)],
    });
  });

  it('treats empty final messageDelta as a no-op payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      events: [],
      serverSeq: 5,
      hasMore: false,
      messageDelta: [],
    })));

    await expect(catchUpSession('session-1', 5)).resolves.toMatchObject({
      messageDelta: [],
    });
  });

  it('ignores auxiliary fields on intermediate catchUpSession pages', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        events: [statusEvent(6)],
        serverSeq: 7,
        hasMore: true,
        messageDelta: [message('intermediate', 1)],
        messageDeletes: ['m-old'],
        destructiveOpsApplied: { truncatedTurns: ['turn-old'], deletedEventIdentities: ['turn-x:seq:1'] },
      }))
      .mockResolvedValueOnce(jsonResponse({
        events: [statusEvent(7)],
        serverSeq: 7,
        hasMore: false,
      })));

    const result = await catchUpSession('session-1', 5);

    expect(result.events.map((event) => event.seq)).toEqual([6, 7]);
    expect(result.messageDelta).toBeUndefined();
    expect(result.messageDeletes).toBeUndefined();
    expect(result.destructiveOpsApplied).toBeUndefined();
  });

  it('returns final-page auxiliary fields from catchUpContinuity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      sessions: {
        'session-1': {
          events: [statusEvent(6)],
          maxSeq: 6,
          messageDelta: [message('m1', 1)],
          messageDeletes: ['m0'],
          destructiveOpsApplied: { truncatedTurns: ['turn-old'], deletedEventIdentities: ['turn-x:seq:1'] },
        },
      },
      serverNow: 100,
    })));

    await expect(catchUpContinuity({ sinceSeq: { 'session-1': 5 }, sessionIds: ['session-1'] }))
      .resolves.toMatchObject({
        sessions: {
          'session-1': {
            events: [statusEvent(6)],
            maxSeq: 6,
            messageDelta: [message('m1', 1)],
            messageDeletes: ['m0'],
            destructiveOpsApplied: { truncatedTurns: ['turn-old'], deletedEventIdentities: ['turn-x:seq:1'] },
          },
        },
      });
  });

  it('ignores auxiliary fields on intermediate catchUpContinuity pages', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        sessions: {
          'session-1': {
            events: [statusEvent(6)],
            maxSeq: 6,
            messageDelta: [message('intermediate', 1)],
          },
        },
        serverNow: 100,
        continuationToken: 'next',
      }))
      .mockResolvedValueOnce(jsonResponse({
        sessions: {
          'session-1': {
            events: [statusEvent(7)],
            maxSeq: 7,
          },
        },
        serverNow: 101,
      })));

    const result = await catchUpContinuity({ sinceSeq: { 'session-1': 5 }, sessionIds: ['session-1'] });

    expect(result.sessions['session-1'].events.map((event) => event.seq)).toEqual([6, 7]);
    expect(result.sessions['session-1'].messageDelta).toBeUndefined();
  });

  it('EventBridge applies final auxiliary fields in destructive-events-delta-deletes order', async () => {
    vi.resetModules();
    const appliedSeqBySession: Record<string, number> = { 'session-1': 5 };
    const operationOrder: string[] = [];
    const recordContinuityEvent = vi.fn((event: { message: string }) => operationOrder.push(event.message));
    const fetchSessions = vi.fn().mockResolvedValue(undefined);
    let capturedReconnect: (() => void) | null = null;
    type TestSession = FullSession & { eventsByTurn?: Record<string, AgentEvent[]> };
    const state: { currentSession: TestSession | null } = {
      currentSession: {
        id: 'session-1',
        title: 'Session',
        createdAt: 1,
        updatedAt: 1,
        messages: [message('m1', 1)],
        eventsByTurn: {
          'turn-old': [statusEvent(1, 'turn-old')],
          'turn-delete': [statusEvent(2, 'turn-delete')],
        },
        activeTurnId: null,
        isBusy: false,
        lastError: null,
      } as unknown as TestSession,
    };
    const applyCatchUpEvents = vi.fn((_sessionId: string, events: AgentEvent[]) => {
      operationOrder.push('events');
      expect(state.currentSession?.eventsByTurn?.['turn-old']).toBeUndefined();
      expect(state.currentSession?.eventsByTurn?.['turn-delete']).toEqual([]);
      return { addedEvents: events.length, highestSeq: 6 };
    });

    vi.doMock('../hooks/useEventChannel', () => ({
      useEventChannel: (_onEvent: unknown, _onState: unknown, onReconnect?: () => void) => {
        capturedReconnect = onReconnect ?? null;
        return { forceReconnect: vi.fn() };
      },
    }));
    vi.doMock('../auth/createAuthStore', () => ({
      useAuthStore: Object.assign((selector: (s: { isPaired: boolean }) => unknown) => selector({ isPaired: true }), {
        getState: () => ({ isPaired: true }),
      }),
    }));
    vi.doMock('../cloudClient', async () => {
      const actual = await vi.importActual<typeof import('../cloudClient')>('../cloudClient');
      return {
        ...actual,
        catchUpContinuity: vi.fn().mockResolvedValue({
          sessions: {
            'session-1': {
              events: [statusEvent(6, 'turn-new')],
              maxSeq: 6,
              destructiveOpsApplied: {
                truncatedTurns: ['turn-old'],
                deletedEventIdentities: ['turn-delete:seq:2'],
              },
              messageDelta: [message('m2', 2)],
              messageDeletes: ['m1'],
            },
          },
          serverNow: 100,
        }),
      };
    });
    vi.doMock('../stores/sessionStore', () => ({
      useSessionStore: {
        getState: () => ({
          appliedSeq: appliedSeqBySession,
          currentSession: state.currentSession,
          applyCatchUpEvents,
          recordContinuityEvent,
          fetchSessions,
          handleSessionChanged: vi.fn(),
          handleSessionTombstoned: vi.fn(),
          setConnectionState: vi.fn(),
          setForceEventReconnect: vi.fn(),
        }),
        setState: (updater: unknown) => {
          const partial = typeof updater === 'function'
            ? (updater as (s: typeof state) => Partial<typeof state>)(state)
            : updater as Partial<typeof state>;
          Object.assign(state, partial);
        },
      },
    }));
    vi.doMock('../stores/approvalStore', () => ({ useApprovalStore: { getState: () => ({ handleApprovalEvent: vi.fn(), handleMemoryEvent: vi.fn() }) } }));
    vi.doMock('../stores/inboxStore', () => ({ useInboxStore: { getState: () => ({ handleInboxEvent: vi.fn() }) } }));
    vi.doMock('../stores/stagedFilesStore', () => ({ useStagedFilesStore: { getState: () => ({ handleStagedFilesChanged: vi.fn() }) } }));
    vi.doMock('../stores/sessionConflictStore', () => ({ useSessionConflictStore: { getState: () => ({ clearSessionConflict: vi.fn(), markSessionConflict: vi.fn() }) } }));

    const { EventBridge } = await import('../components/EventBridge');
    render(React.createElement(EventBridge));
    (capturedReconnect as (() => void) | null)?.();

    await waitFor(() => {
      expect(fetchSessions).toHaveBeenCalledWith({ forceFullRefresh: true });
    });

    const auxiliaryOrder = operationOrder.filter((entry) => (
      entry === 'events' || entry.startsWith('session-catch-up:')
    ));
    expect(auxiliaryOrder).toEqual([
      'session-catch-up:destructive-op-applied',
      'events',
      'session-catch-up:message-delta-applied',
      'session-catch-up:message-delete-applied',
    ]);
    expect(state.currentSession?.messages).toEqual([message('m2', 2)]);
  });

  it('EventBridge skips the message reducer when no final messageDelta is present', async () => {
    vi.resetModules();
    const appliedSeqBySession: Record<string, number> = { 'session-1': 5 };
    const recordContinuityEvent = vi.fn();
    let capturedReconnect: (() => void) | null = null;
    const fetchSessions = vi.fn().mockResolvedValue(undefined);
    const state: { currentSession: FullSession | null } = {
      currentSession: {
        id: 'session-1',
        title: 'Session',
        createdAt: 1,
        updatedAt: 1,
        messages: [message('m1', 1)],
        eventsByTurn: {},
        activeTurnId: null,
        isBusy: false,
        lastError: null,
      } as FullSession,
    };

    vi.doMock('../hooks/useEventChannel', () => ({
      useEventChannel: (_onEvent: unknown, _onState: unknown, onReconnect?: () => void) => {
        capturedReconnect = onReconnect ?? null;
        return { forceReconnect: vi.fn() };
      },
    }));
    vi.doMock('../auth/createAuthStore', () => ({
      useAuthStore: Object.assign((selector: (s: { isPaired: boolean }) => unknown) => selector({ isPaired: true }), {
        getState: () => ({ isPaired: true }),
      }),
    }));
    vi.doMock('../cloudClient', async () => {
      const actual = await vi.importActual<typeof import('../cloudClient')>('../cloudClient');
      return {
        ...actual,
        catchUpContinuity: vi.fn().mockResolvedValue({
          sessions: { 'session-1': { events: [statusEvent(6)], maxSeq: 6 } },
          serverNow: 100,
        }),
      };
    });
    vi.doMock('../stores/sessionStore', () => ({
      useSessionStore: {
        getState: () => ({
          appliedSeq: appliedSeqBySession,
          currentSession: state.currentSession,
          applyCatchUpEvents: vi.fn(() => ({ addedEvents: 1, highestSeq: 6 })),
          recordContinuityEvent,
          fetchSessions,
          handleSessionChanged: vi.fn(),
          handleSessionTombstoned: vi.fn(),
          setConnectionState: vi.fn(),
          setForceEventReconnect: vi.fn(),
        }),
        setState: (updater: unknown) => {
          const partial = typeof updater === 'function'
            ? (updater as (s: typeof state) => Partial<typeof state>)(state)
            : updater as Partial<typeof state>;
          Object.assign(state, partial);
        },
      },
    }));
    vi.doMock('../stores/approvalStore', () => ({ useApprovalStore: { getState: () => ({ handleApprovalEvent: vi.fn(), handleMemoryEvent: vi.fn() }) } }));
    vi.doMock('../stores/inboxStore', () => ({ useInboxStore: { getState: () => ({ handleInboxEvent: vi.fn() }) } }));
    vi.doMock('../stores/stagedFilesStore', () => ({ useStagedFilesStore: { getState: () => ({ handleStagedFilesChanged: vi.fn() }) } }));
    vi.doMock('../stores/sessionConflictStore', () => ({ useSessionConflictStore: { getState: () => ({ clearSessionConflict: vi.fn(), markSessionConflict: vi.fn() }) } }));

    const { EventBridge } = await import('../components/EventBridge');
    render(React.createElement(EventBridge));
    (capturedReconnect as (() => void) | null)?.();

    await waitFor(() => {
      expect(fetchSessions).toHaveBeenCalledWith({ forceFullRefresh: true });
    });
    expect(recordContinuityEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      message: 'session-catch-up:message-delta-applied',
    }));
    expect(state.currentSession?.messages).toEqual([message('m1', 1)]);
  });
});
