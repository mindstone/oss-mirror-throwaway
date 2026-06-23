import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@shared/types';
import type { CloudServiceDeps } from '../bootstrap';
import { handleSessions, _resetSessionsRouteTombstoneStateForTests } from '../routes/sessions';
import { resetSessionTombstoneStoreForTests } from '@core/services/continuity/sessionTombstoneStore';

function bodyReq(body: unknown): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = 'PUT';
  req.url = '/api/sessions/session-1';
  req.headers = { host: 'localhost' };
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function mockRes(): { res: http.ServerResponse; statusCode: () => number; body: <T = unknown>() => T } {
  let status = 200;
  let text = '';
  return {
    res: {
      writeHead: vi.fn((next: number) => { status = next; }),
      end: vi.fn((body?: string) => { text = body ?? ''; }),
    } as unknown as http.ServerResponse,
    statusCode: () => status,
    body: <T = unknown>() => JSON.parse(text) as T,
  };
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-1',
    title: 'Session',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    eventsByTurn: { 'turn-1': [{ type: 'status', message: 'ok', timestamp: 1, seq: 4 }] },
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  } as AgentSession;
}

afterEach(() => {
  resetSessionTombstoneStoreForTests();
  _resetSessionsRouteTombstoneStateForTests();
});

describe('PUT /api/sessions/:id serverSeq response', () => {
  it('includes serverSeq in successful responses', async () => {
    const deps = {
      getSession: vi.fn(async () => null),
      upsertSession: vi.fn(async () => {}),
      getActiveTurnController: vi.fn(() => undefined),
      listSessions: vi.fn(() => []),
    } as unknown as CloudServiceDeps;
    const response = mockRes();

    await handleSessions(bodyReq(makeSession()), response.res, ['api', 'sessions', 'session-1'], deps);

    expect(response.statusCode()).toBe(200);
    expect(response.body()).toMatchObject({ success: true, tombstoned: false, serverSeq: 4 });
  });

  it('computes serverSeq from persisted max sequence', async () => {
    const deps = {
      getSession: vi.fn(async () => null),
      upsertSession: vi.fn(async () => {}),
      getActiveTurnController: vi.fn(() => undefined),
      listSessions: vi.fn(() => []),
    } as unknown as CloudServiceDeps;
    const response = mockRes();

    await handleSessions(bodyReq(makeSession({
      eventsByTurn: {
        a: [{ type: 'status', message: 'a', timestamp: 1, seq: 2 }],
        b: [{ type: 'status', message: 'b', timestamp: 2, seq: 9 }],
      },
    })), response.res, ['api', 'sessions', 'session-1'], deps);

    expect(response.statusCode()).toBe(200);
    expect(response.body<{ serverSeq: number }>().serverSeq).toBe(9);
  });

  it('keeps legacy response fields unchanged', async () => {
    const deps = {
      getSession: vi.fn(async () => null),
      upsertSession: vi.fn(async () => {}),
      getActiveTurnController: vi.fn(() => undefined),
      listSessions: vi.fn(() => []),
    } as unknown as CloudServiceDeps;
    const response = mockRes();

    await handleSessions(bodyReq(makeSession()), response.res, ['api', 'sessions', 'session-1'], deps);

    expect(response.body()).toEqual(expect.objectContaining({
      success: true,
      tombstoned: false,
      cloudUpdatedAt: expect.any(Number),
      serverSeq: expect.any(Number),
    }));
  });
});
