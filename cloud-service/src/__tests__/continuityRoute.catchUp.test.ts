import { afterEach, describe, expect, it } from 'vitest';
import type http from 'node:http';
import type { AgentEvent, AgentSession } from '@shared/types';
import type { CloudServiceDeps } from '../bootstrap';
import { handleSessions, _resetSessionsRouteTombstoneStateForTests } from '../routes/sessions';
import {
  getCatchUpHistoryForDevice,
  _resetContinuityCatchUpHistoryForTests,
} from '@core/services/cloudContinuityStateService';
import { resetSessionTombstoneStoreForTests } from '@core/services/continuity/sessionTombstoneStore';

function createMockReq(method: string, url: string): http.IncomingMessage {
  return {
    method,
    url,
    headers: { host: 'localhost' },
  } as http.IncomingMessage;
}

function createMockRes(): {
  res: http.ServerResponse;
  statusCode: () => number;
  body: () => unknown;
} {
  let capturedStatus = 200;
  let capturedBody = '';

  const res = {
    writeHead: ((status: number) => {
      capturedStatus = status;
    }) as http.ServerResponse['writeHead'],
    end: ((body?: string) => {
      capturedBody = body ?? '';
    }) as http.ServerResponse['end'],
  } as unknown as http.ServerResponse;

  return {
    res,
    statusCode: () => capturedStatus,
    body: () => (capturedBody ? JSON.parse(capturedBody) : null),
  };
}

function makeStatusEvent(seq: number): AgentEvent {
  return {
    type: 'status',
    message: `event-${seq}`,
    timestamp: seq * 10,
    seq,
  };
}

function makeRoutedStatusEvent(seq: number, turnId: string): AgentEvent & { turnId: string } {
  return {
    ...makeStatusEvent(seq),
    turnId,
  };
}

function makeSession(id: string, turnEvents: Record<string, number[]>): AgentSession {
  const eventsByTurn: Record<string, AgentEvent[]> = {};
  let maxSeq = 0;

  for (const [turnId, seqs] of Object.entries(turnEvents)) {
    eventsByTurn[turnId] = seqs.map(makeStatusEvent);
    const turnMax = Math.max(...seqs, 0);
    maxSeq = Math.max(maxSeq, turnMax);
  }

  return {
    id,
    title: `Session ${id}`,
    createdAt: 1,
    updatedAt: 1,
    cloudUpdatedAt: 1,
    messages: [],
    eventsByTurn,
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    maxSeq,
  } as unknown as AgentSession;
}

afterEach(() => {
  resetSessionTombstoneStoreForTests();
  _resetSessionsRouteTombstoneStateForTests();
  _resetContinuityCatchUpHistoryForTests();
});

describe('Stage 1.5 catch-up routes', () => {
  it('GET /api/sessions/:id/events returns ordered deltas with hasMore paging', async () => {
    const session = makeSession('session-a', {
      'turn-2': [2, 4, 6],
      'turn-1': [1, 3, 5],
    });

    const deps = {
      getSession: async (id: string) => (id === session.id ? session : null),
    } as unknown as CloudServiceDeps;

    const first = createMockRes();
    await handleSessions(
      createMockReq('GET', `/api/sessions/${session.id}/events?sinceSeq=2&limit=2`),
      first.res,
      ['api', 'sessions', session.id, 'events'],
      deps,
    );

    expect(first.statusCode()).toBe(200);
    expect(first.body()).toEqual({
      events: [makeRoutedStatusEvent(3, 'turn-1'), makeRoutedStatusEvent(4, 'turn-2')],
      serverSeq: 6,
      hasMore: true,
    });

    const second = createMockRes();
    await handleSessions(
      createMockReq('GET', `/api/sessions/${session.id}/events?sinceSeq=4&limit=10`),
      second.res,
      ['api', 'sessions', session.id, 'events'],
      deps,
    );

    expect(second.statusCode()).toBe(200);
    expect(second.body()).toEqual({
      events: [makeRoutedStatusEvent(5, 'turn-1'), makeRoutedStatusEvent(6, 'turn-2')],
      serverSeq: 6,
      hasMore: false,
      messageDelta: [],
      messageDeletes: [],
      destructiveOpsApplied: {
        truncatedTurns: [],
        deletedEventIdentities: [],
      },
    });
  });

  it('GET /api/continuity/catch-up paginates across sessions with continuationToken', async () => {
    const { handleContinuity } = await import('../routes/continuity');
    const sessions = new Map<string, AgentSession>([
      ['session-a', makeSession('session-a', { 'turn-a': [1, 2, 3] })],
      ['session-b', makeSession('session-b', { 'turn-b': [1, 2, 3, 4] })],
    ]);

    const deps = {
      listSessions: () => Array.from(sessions.values()).map((session) => ({ id: session.id })),
      deleteSession: async () => {},
      getSession: async (id: string) => sessions.get(id) ?? null,
    } as unknown as CloudServiceDeps;

    const first = createMockRes();
    const sinceSeqParam = encodeURIComponent(JSON.stringify({ 'session-a': 1, 'session-b': 1 }));
    await handleContinuity(
      createMockReq('GET', `/api/continuity/catch-up?sinceSeq=${sinceSeqParam}&sessionIds=session-a,session-b&limit=3`),
      first.res,
      ['api', 'continuity', 'catch-up'],
      deps,
    );

    expect(first.statusCode()).toBe(200);
    const firstBody = first.body() as {
      sessions: Record<string, { events: AgentEvent[]; maxSeq: number }>;
      continuationToken?: string;
      serverNow: number;
    };
    expect(firstBody.sessions['session-a']).toEqual({
      events: [makeRoutedStatusEvent(2, 'turn-a'), makeRoutedStatusEvent(3, 'turn-a')],
      maxSeq: 3,
    });
    expect(firstBody.sessions['session-b']).toEqual({
      events: [makeRoutedStatusEvent(2, 'turn-b')],
      maxSeq: 4,
    });
    expect(firstBody.continuationToken).toEqual(expect.any(String));
    expect(typeof firstBody.serverNow).toBe('number');

    const second = createMockRes();
    await handleContinuity(
      createMockReq('GET', `/api/continuity/catch-up?continuationToken=${firstBody.continuationToken!}&limit=3`),
      second.res,
      ['api', 'continuity', 'catch-up'],
      deps,
    );

    expect(second.statusCode()).toBe(200);
    const secondBody = second.body() as {
      sessions: Record<string, { events: AgentEvent[]; maxSeq: number }>;
      continuationToken?: string;
      serverNow: number;
    };
    expect(secondBody.sessions['session-a']).toEqual({
      events: [],
      maxSeq: 3,
      messageDelta: [],
      messageDeletes: [],
      destructiveOpsApplied: {
        truncatedTurns: [],
        deletedEventIdentities: [],
      },
    });
    expect(secondBody.sessions['session-b']).toEqual({
      events: [makeRoutedStatusEvent(3, 'turn-b'), makeRoutedStatusEvent(4, 'turn-b')],
      maxSeq: 4,
      messageDelta: [],
      messageDeletes: [],
      destructiveOpsApplied: {
        truncatedTurns: [],
        deletedEventIdentities: [],
      },
    });
    expect(secondBody.continuationToken).toBeUndefined();
    expect(typeof secondBody.serverNow).toBe('number');

    const history = getCatchUpHistoryForDevice('anonymous:cloud:unknown-client');
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0]).toEqual(
      expect.objectContaining({
        sessionCount: 2,
        usedContinuationToken: false,
      }),
    );
  });
});
