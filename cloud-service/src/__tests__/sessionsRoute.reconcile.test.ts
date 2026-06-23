import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@shared/types';
import { computeTurnChecksum } from '@core/services/eventCanonicalForm';
import type { CloudServiceDeps } from '../bootstrap';
import { handleSessions, _resetSessionsRouteTombstoneStateForTests } from '../routes/sessions';
import { resetSessionTombstoneStoreForTests } from '@core/services/continuity/sessionTombstoneStore';

function createReq(url: string): http.IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: { host: 'localhost', 'x-rebel-surface': 'desktop' },
  } as unknown as http.IncomingMessage;
}

function createRes(): { res: http.ServerResponse; statusCode: () => number; body: <T = unknown>() => T } {
  let status = 200;
  let text = '';
  return {
    res: {
      writeHead: vi.fn((nextStatus: number) => { status = nextStatus; }),
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
    cloudUpdatedAt: 1_000,
    messages: [],
    eventsByTurn: {
      'turn-2': [
        { type: 'assistant', text: 'hello', timestamp: 20, seq: 2 },
      ],
      'turn-1': [
        { type: 'status', message: 'queued', timestamp: 10, seq: 1 },
      ],
    },
    maxSeq: 2,
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  } as AgentSession;
}

function makeDeps(session: AgentSession | null): CloudServiceDeps {
  return {
    getSession: vi.fn(async () => session),
  } as unknown as CloudServiceDeps;
}

describe('GET /api/sessions/:id/reconcile', () => {
  beforeEach(() => {
    resetSessionTombstoneStoreForTests();
    _resetSessionsRouteTombstoneStateForTests();
  });

  afterEach(() => {
    resetSessionTombstoneStoreForTests();
    _resetSessionsRouteTombstoneStateForTests();
  });

  it('returns per-turn checksums and serverSeq', async () => {
    const session = makeSession();
    const response = createRes();
    await handleSessions(
      createReq('/api/sessions/session-1/reconcile?clientSeq=1'),
      response.res,
      ['api', 'sessions', 'session-1', 'reconcile'],
      makeDeps(session),
    );

    expect(response.statusCode()).toBe(200);
    expect(response.body()).toEqual({
      serverSeq: 2,
      turnChecksums: [
        {
          turnId: 'turn-1',
          eventCount: 1,
          contentChecksum: computeTurnChecksum(session.eventsByTurn['turn-1']),
        },
        {
          turnId: 'turn-2',
          eventCount: 1,
          contentChecksum: computeTurnChecksum(session.eventsByTurn['turn-2']),
        },
      ],
    });
  });

  it('rejects invalid clientSeq query values', async () => {
    const response = createRes();
    await handleSessions(
      createReq('/api/sessions/session-1/reconcile?clientSeq=bad'),
      response.res,
      ['api', 'sessions', 'session-1', 'reconcile'],
      makeDeps(makeSession()),
    );

    expect(response.statusCode()).toBe(400);
    expect(response.body()).toMatchObject({
      error: { code: 'INVALID_PARAM' },
    });
  });
});
