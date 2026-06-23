import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@shared/types';
import type { CloudServiceDeps } from '../bootstrap';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import { handleSessions, _resetSessionsRouteTombstoneStateForTests } from '../routes/sessions';
import { getSessionMutex } from '@core/services/sessionMutex';
import { resetServerClockForTests } from '@core/services/continuity/serverClock';
import { resetSessionSeqIndexForTests } from '@core/services/continuity/sessionSeqIndex';
import { getSessionTombstoneStore, resetSessionTombstoneStoreForTests } from '@core/services/continuity/sessionTombstoneStore';

function bodyReq(method: 'POST' | 'PATCH', path: string, body: unknown): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = { host: 'localhost', 'x-rebel-surface': 'mobile' };
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function response(): { res: http.ServerResponse; statusCode: () => number } {
  let status = 200;
  return {
    res: {
      writeHead: vi.fn((next: number) => { status = next; }),
      end: vi.fn(),
    } as unknown as http.ServerResponse,
    statusCode: () => status,
  };
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-1',
    title: 'Title',
    createdAt: 1,
    updatedAt: 1,
    cloudUpdatedAt: 1_000,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  } as AgentSession;
}

function deps(initial: AgentSession): CloudServiceDeps {
  let current = initial;
  return {
    getSession: vi.fn(async () => current),
    upsertSession: vi.fn(async (session: AgentSession) => { current = session; }),
    deleteSession: vi.fn(async () => {}),
    getActiveTurnController: vi.fn(() => undefined),
    listSessions: vi.fn(() => [current]),
    loadSessions: vi.fn(async () => [current]),
  } as unknown as CloudServiceDeps;
}

const broadcastSpy = vi.spyOn(cloudEventBroadcaster, 'broadcast');

beforeEach(() => {
  broadcastSpy.mockClear();
  resetServerClockForTests();
  resetSessionSeqIndexForTests();
  resetSessionTombstoneStoreForTests();
  _resetSessionsRouteTombstoneStateForTests();
});

afterEach(() => {
  resetServerClockForTests();
  resetSessionSeqIndexForTests();
  resetSessionTombstoneStoreForTests();
  _resetSessionsRouteTombstoneStateForTests();
});

describe('session broadcast effects', () => {
  it('POST applied broadcasts session-changed and one session-event per appended event', async () => {
    const res = response();
    await handleSessions(bodyReq('POST', '/api/sessions/session-1/events', {
      baseSeq: 0,
      events: [
        { type: 'status', message: 'a', timestamp: 1, turnId: 'turn-1', seq: null, clientOrdinal: 0 },
        { type: 'status', message: 'b', timestamp: 2, turnId: 'turn-1', seq: null, clientOrdinal: 1 },
      ],
    }), res.res, ['api', 'sessions', 'session-1', 'events'], deps(makeSession()));

    expect(res.statusCode()).toBe(200);
    expect(broadcastSpy).toHaveBeenCalledWith('cloud:session-changed', { sessionId: 'session-1', action: 'upserted' });
    expect(broadcastSpy.mock.calls.filter(([channel]) => channel === 'cloud:session-event')).toHaveLength(2);
  });

  it('PATCH applied broadcasts only session-changed', async () => {
    const res = response();
    await handleSessions(bodyReq('PATCH', '/api/sessions/session-1', {
      baseSeq: 0,
      clientCloudUpdatedAt: 1_000,
      patch: { title: 'Renamed' },
    }), res.res, ['api', 'sessions', 'session-1'], deps(makeSession()));

    expect(res.statusCode()).toBe(200);
    expect(broadcastSpy).toHaveBeenCalledWith('cloud:session-changed', { sessionId: 'session-1', action: 'upserted' });
    expect(broadcastSpy.mock.calls.some(([channel]) => channel === 'cloud:session-event')).toBe(false);
  });

  it('needs-reconcile does not broadcast', async () => {
    const res = response();
    await handleSessions(bodyReq('POST', '/api/sessions/session-1/events', {
      baseSeq: 99,
      events: [{ type: 'status', message: 'a', timestamp: 1, turnId: 'turn-1', seq: null, clientOrdinal: 0 }],
    }), res.res, ['api', 'sessions', 'session-1', 'events'], deps(makeSession()));

    expect(res.statusCode()).toBe(409);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('tombstoned writes do not broadcast', async () => {
    getSessionTombstoneStore().addTombstone('session-1', 'desktop');
    const res = response();
    await handleSessions(bodyReq('PATCH', '/api/sessions/session-1', {
      baseSeq: 0,
      clientCloudUpdatedAt: 1_000,
      patch: { title: 'Nope' },
    }), res.res, ['api', 'sessions', 'session-1'], deps(makeSession()));

    expect(res.statusCode()).toBe(410);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('POST broadcasts while the session mutex is held', async () => {
    const mutexStates = (getSessionMutex() as unknown as { states: Map<string, { locked: boolean }> }).states;
    const records: boolean[] = [];
    broadcastSpy.mockImplementation(() => {
      records.push(mutexStates.get('session-1')?.locked === true);
    });
    const res = response();

    await handleSessions(bodyReq('POST', '/api/sessions/session-1/events', {
      baseSeq: 0,
      events: [{ type: 'status', message: 'a', timestamp: 1, turnId: 'turn-1', seq: null, clientOrdinal: 0 }],
    }), res.res, ['api', 'sessions', 'session-1', 'events'], deps(makeSession()));

    expect(records.length).toBeGreaterThan(0);
    expect(records.every(Boolean)).toBe(true);
  });

  it('PATCH broadcasts while the session mutex is held', async () => {
    const mutexStates = (getSessionMutex() as unknown as { states: Map<string, { locked: boolean }> }).states;
    const records: boolean[] = [];
    broadcastSpy.mockImplementation(() => {
      records.push(mutexStates.get('session-1')?.locked === true);
    });
    const res = response();

    await handleSessions(bodyReq('PATCH', '/api/sessions/session-1', {
      baseSeq: 0,
      clientCloudUpdatedAt: 1_000,
      patch: { title: 'Renamed' },
    }), res.res, ['api', 'sessions', 'session-1'], deps(makeSession()));

    expect(records).toEqual([true]);
  });
});
