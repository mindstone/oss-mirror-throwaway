import type http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession } from '@shared/types';
import type { CloudServiceDeps } from '../bootstrap';
import { handleSessions, _resetSessionsRouteTombstoneStateForTests } from '../routes/sessions';
import { handleContinuity } from '../routes/continuity';
import { _resetContinuityCatchUpHistoryForTests } from '@core/services/cloudContinuityStateService';
import { resetSessionTombstoneStoreForTests } from '@core/services/continuity/sessionTombstoneStore';

function req(method: string, url: string): http.IncomingMessage {
  return { method, url, headers: { host: 'localhost' } } as http.IncomingMessage;
}

function res(): { res: http.ServerResponse; statusCode: () => number; body: <T = unknown>() => T } {
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

function makeEvent(seq: number): AgentEvent {
  return { type: 'status', message: `event-${seq}`, timestamp: seq * 100, seq };
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-1',
    title: 'Session',
    createdAt: 1,
    updatedAt: 1,
    cloudUpdatedAt: 1_000,
    messages: [],
    eventsByTurn: { 'turn-1': [makeEvent(1), makeEvent(2), makeEvent(3)] },
    maxSeq: 3,
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
  _resetContinuityCatchUpHistoryForTests();
});

describe('catch-up auxiliary message/delete/destructive payloads', () => {
  it('omits auxiliary fields on non-final GET events pages', async () => {
    const session = makeSession({
      messages: [{ id: 'm1', turnId: 'turn-1', role: 'user', text: 'hello', createdAt: 500 }],
      _deletedMessages: { old: 600 },
      _destructiveOpsLedger: [{ op: 'truncateTurn', target: 'old-turn', appliedAt: 700 }],
    });
    const deps = { getSession: vi.fn(async () => session) } as unknown as CloudServiceDeps;
    const response = res();

    await handleSessions(req('GET', '/api/sessions/session-1/events?sinceSeq=0&limit=1'), response.res, ['api', 'sessions', 'session-1', 'events'], deps);

    expect(response.statusCode()).toBe(200);
    const body = response.body<Record<string, unknown>>();
    expect(body.hasMore).toBe(true);
    expect(body).not.toHaveProperty('messageDelta');
    expect(body).not.toHaveProperty('messageDeletes');
    expect(body).not.toHaveProperty('destructiveOpsApplied');
  });

  it('returns auxiliary fields on final GET events pages', async () => {
    const session = makeSession({
      messages: [{ id: 'm1', turnId: 'turn-1', role: 'user', text: 'hello', createdAt: 500 }],
      _deletedMessages: { old: 600 },
      _destructiveOpsLedger: [
        { op: 'truncateTurn', target: 'old-turn', appliedAt: 700 },
        { op: 'deleteEventIdentity', target: 'turn-1:seq:1', appliedAt: 800 },
      ],
    });
    const deps = { getSession: vi.fn(async () => session) } as unknown as CloudServiceDeps;
    const response = res();

    await handleSessions(req('GET', '/api/sessions/session-1/events?sinceSeq=3&limit=10'), response.res, ['api', 'sessions', 'session-1', 'events'], deps);

    expect(response.statusCode()).toBe(200);
    expect(response.body()).toMatchObject({
      hasMore: false,
      events: [],
      messageDelta: [],
      messageDeletes: ['old'],
      destructiveOpsApplied: {
        truncatedTurns: ['old-turn'],
        deletedEventIdentities: ['turn-1:seq:1'],
      },
    });
  });

  it('filters final-page messageDelta by the sinceSeq event timestamp', async () => {
    const session = makeSession({
      messages: [
        { id: 'before', turnId: 'turn-1', role: 'user', text: 'old', createdAt: 100 },
        { id: 'after', turnId: 'turn-1', role: 'user', text: 'new', createdAt: 250 },
      ],
    });
    const deps = { getSession: vi.fn(async () => session) } as unknown as CloudServiceDeps;
    const response = res();

    await handleSessions(req('GET', '/api/sessions/session-1/events?sinceSeq=2&limit=10'), response.res, ['api', 'sessions', 'session-1', 'events'], deps);

    expect(response.statusCode()).toBe(200);
    expect(response.body<{ messageDelta: Array<{ id: string }> }>().messageDelta.map((message) => message.id)).toEqual(['after']);
  });

  it('adds auxiliary fields to the final continuity catch-up response only', async () => {
    const sessions = new Map<string, AgentSession>([
      ['session-1', makeSession({
        messages: [{ id: 'm1', turnId: 'turn-1', role: 'user', text: 'hello', createdAt: 500 }],
        _deletedMessages: { gone: 600 },
      })],
    ]);
    const deps = {
      listSessions: () => [{ id: 'session-1' }],
      getSession: async (id: string) => sessions.get(id) ?? null,
      deleteSession: async () => {},
    } as unknown as CloudServiceDeps;

    const first = res();
    await handleContinuity(req('GET', '/api/continuity/catch-up?sessionIds=session-1&sinceSeq=0&limit=1'), first.res, ['api', 'continuity', 'catch-up'], deps);
    expect(first.statusCode()).toBe(200);
    const firstBody = first.body<{ continuationToken?: string; sessions: Record<string, Record<string, unknown>> }>();
    expect(firstBody.continuationToken).toEqual(expect.any(String));
    expect(firstBody.sessions['session-1']).not.toHaveProperty('messageDelta');

    const second = res();
    await handleContinuity(req('GET', `/api/continuity/catch-up?continuationToken=${firstBody.continuationToken!}`), second.res, ['api', 'continuity', 'catch-up'], deps);
    expect(second.statusCode()).toBe(200);
    expect(second.body()).toMatchObject({
      sessions: {
        'session-1': {
          messageDelta: [{ id: 'm1', turnId: 'turn-1', role: 'user', text: 'hello', createdAt: 500 }],
          messageDeletes: ['gone'],
        },
      },
    });
  });
});
