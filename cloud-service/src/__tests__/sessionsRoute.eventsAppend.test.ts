import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession } from '@shared/types';
import type { CloudServiceDeps } from '../bootstrap';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import { handleSessions, _resetSessionsRouteTombstoneStateForTests } from '../routes/sessions';
import { getSessionMutex } from '@core/services/sessionMutex';
import { resetServerClockForTests, setServerNowForTests } from '@core/services/continuity/serverClock';
import { resetSessionSeqIndexForTests } from '@core/services/continuity/sessionSeqIndex';
import { getSessionTombstoneStore, resetSessionTombstoneStoreForTests } from '@core/services/continuity/sessionTombstoneStore';

function createBodyReq(method: string, url: string, body: unknown, headers?: Record<string, string>): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost', ...headers };
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function createMockRes(): { res: http.ServerResponse; statusCode: () => number; body: <T = unknown>() => T } {
  let capturedStatus = 200;
  let capturedBody = '';
  const res = {
    writeHead: vi.fn((status: number) => { capturedStatus = status; }),
    end: vi.fn((body?: string) => { capturedBody = body ?? ''; }),
  } as unknown as http.ServerResponse;
  return {
    res,
    statusCode: () => capturedStatus,
    body: <T = unknown>() => JSON.parse(capturedBody) as T,
  };
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-1',
    title: 'Title',
    createdAt: 1,
    updatedAt: 1,
    cloudUpdatedAt: 1,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  } as AgentSession;
}

function makeEvent(overrides: Partial<Omit<AgentEvent, 'seq'> & { turnId: string; clientOrdinal: number; seq: null }> = {}) {
  return {
    type: 'status',
    message: 'queued',
    timestamp: 1_000,
    turnId: 'turn-1',
    seq: null,
    clientOrdinal: 0,
    ...overrides,
  };
}

function makeDeps(initial: AgentSession | null): CloudServiceDeps & { current: () => AgentSession | null } {
  let current = initial;
  return {
    getSession: vi.fn(async (id: string) => (current?.id === id ? current : null)),
    upsertSession: vi.fn(async (session: AgentSession) => { current = session; }),
    deleteSession: vi.fn(async () => { current = null; }),
    getActiveTurnController: vi.fn(() => undefined),
    listSessions: vi.fn(() => current ? [current] : []),
    loadSessions: vi.fn(async () => current ? [current] : []),
    current: () => current,
  } as unknown as CloudServiceDeps & { current: () => AgentSession | null };
}

async function postEvents(deps: CloudServiceDeps, sessionId: string, body: unknown) {
  const response = createMockRes();
  await handleSessions(
    createBodyReq('POST', `/api/sessions/${sessionId}/events`, body, { 'x-rebel-surface': 'mobile' }),
    response.res,
    ['api', 'sessions', sessionId, 'events'],
    deps,
  );
  return response;
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

describe('POST /api/sessions/:id/events', () => {
  it('applies events and returns applied seqs', async () => {
    const deps = makeDeps(makeSession());
    const response = await postEvents(deps, 'session-1', { baseSeq: 0, events: [makeEvent()] });

    expect(response.statusCode()).toBe(200);
    expect(response.body()).toMatchObject({ success: true, appliedCount: 1, appliedSeq: [1], serverSeq: 1 });
    expect(deps.current()?.eventsByTurn['turn-1']?.[0]).toMatchObject({ seq: 1, message: 'queued' });
  });

  it('replays an idempotency key without double-applying', async () => {
    const deps = makeDeps(makeSession());
    const body = { baseSeq: 0, events: [makeEvent()], idempotencyKey: 'session-1:1:abc' };

    expect((await postEvents(deps, 'session-1', body)).statusCode()).toBe(200);
    expect((await postEvents(deps, 'session-1', body)).statusCode()).toBe(200);

    expect(deps.current()?.eventsByTurn['turn-1']).toHaveLength(1);
  });

  it('returns NEEDS_RECONCILE when the client baseSeq is ahead', async () => {
    const deps = makeDeps(makeSession());
    const response = await postEvents(deps, 'session-1', { baseSeq: 10, events: [makeEvent()] });

    expect(response.statusCode()).toBe(409);
    expect(response.body()).toMatchObject({ error: 'NEEDS_RECONCILE', serverSeq: 0 });
  });

  it('returns NEEDS_BOOTSTRAP for unknown sessions', async () => {
    const response = await postEvents(makeDeps(null), 'missing-session', { baseSeq: 0, events: [makeEvent()] });

    expect(response.statusCode()).toBe(404);
    expect(response.body()).toEqual({ error: 'NEEDS_BOOTSTRAP', sessionId: 'missing-session' });
  });

  it('maps pre-stamped events to INVALID_SEQ', async () => {
    const deps = makeDeps(makeSession());
    const response = await postEvents(deps, 'session-1', { baseSeq: 0, events: [makeEvent({ seq: 7 as never })] });

    expect(response.statusCode()).toBe(409);
    expect(response.body()).toMatchObject({ error: 'INVALID_SEQ', serverSeq: 0 });
    expect(deps.current()?.eventsByTurn['turn-1']).toBeUndefined();
  });

  it('maps missing clientOrdinal to INVALID_ENVELOPE', async () => {
    const deps = makeDeps(makeSession());
    const { clientOrdinal: _clientOrdinal, ...event } = makeEvent();
    const response = await postEvents(deps, 'session-1', { baseSeq: 0, events: [event] });

    expect(response.statusCode()).toBe(400);
    expect(response.body()).toMatchObject({ error: 'INVALID_ENVELOPE', reason: 'missing-client-ordinal' });
  });

  it('maps duplicate clientOrdinal identities to INVALID_ENVELOPE', async () => {
    const deps = makeDeps(makeSession());
    const response = await postEvents(deps, 'session-1', {
      baseSeq: 0,
      events: [makeEvent({ clientOrdinal: 1 }), makeEvent({ clientOrdinal: 1 })],
    });

    expect(response.statusCode()).toBe(400);
    expect(response.body()).toMatchObject({ error: 'INVALID_ENVELOPE', reason: 'duplicate-client-ordinal' });
  });

  it('merges messageDelta and messageDeletes atomically', async () => {
    setServerNowForTests(() => 12_345);
    const deps = makeDeps(makeSession({
      messages: [
        { id: 'm1', turnId: 'turn-1', role: 'user', text: 'old', createdAt: 1 },
        { id: 'm2', turnId: 'turn-1', role: 'assistant', text: 'keep', createdAt: 2 },
      ],
    }));

    const response = await postEvents(deps, 'session-1', {
      baseSeq: 0,
      events: [],
      messageDeletes: ['m1'],
      messageDelta: [{ id: 'm3', turnId: 'turn-1', role: 'user', text: 'new', createdAt: 3 }],
    });

    expect(response.statusCode()).toBe(200);
    expect(deps.current()?.messages.map((message) => message.id)).toEqual(['m2', 'm3']);
    expect(deps.current()?._deletedMessages).toEqual({ m1: 12_345 });
  });

  it('accepts destructive truncate and delete operations with empty events', async () => {
    const kept: AgentEvent = { type: 'status', message: 'keep', timestamp: 2, seq: 2 };
    const deleted: AgentEvent = { type: 'status', message: 'delete', timestamp: 1, seq: 1 };
    const deps = makeDeps(makeSession({
      maxSeq: 2,
      eventsByTurn: { 'turn-1': [deleted], 'turn-2': [kept] },
    }));

    const response = await postEvents(deps, 'session-1', {
      baseSeq: 2,
      events: [],
      _destructiveOps: {
        truncateTurns: ['turn-2'],
        deleteEventIdentities: ['turn-1:seq:1'],
      },
    });

    expect(response.statusCode()).toBe(200);
    expect(deps.current()?.eventsByTurn['turn-1']).toEqual([]);
    expect(deps.current()?.eventsByTurn['turn-2']).toEqual([]);
    expect(deps.current()?._destructiveOpsLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'truncateTurn', target: 'turn-2' }),
      expect.objectContaining({ op: 'deleteEventIdentity', target: 'turn-1:seq:1' }),
    ]));
  });

  it('returns 400 when the events array is too large', async () => {
    const deps = makeDeps(makeSession());
    const response = await postEvents(deps, 'session-1', { baseSeq: 0, events: new Array(5_001).fill(makeEvent()) });

    expect(response.statusCode()).toBe(400);
  });

  it('returns 410 for tombstoned sessions', async () => {
    getSessionTombstoneStore().addTombstone('session-1', 'desktop');
    const response = await postEvents(makeDeps(makeSession()), 'session-1', { baseSeq: 0, events: [makeEvent()] });

    expect(response.statusCode()).toBe(410);
    expect(response.body()).toMatchObject({ error: 'session-tombstoned' });
  });

  it('broadcasts session changes and events while the session mutex is held', async () => {
    const mutexStates = (getSessionMutex() as unknown as { states: Map<string, { locked: boolean }> }).states;
    const records: Array<{ channel: string; mutexHeld: boolean }> = [];
    broadcastSpy.mockImplementation((channel) => {
      records.push({ channel, mutexHeld: mutexStates.get('session-1')?.locked === true });
    });
    const deps = makeDeps(makeSession());

    const response = await postEvents(deps, 'session-1', {
      baseSeq: 0,
      events: [makeEvent({ clientOrdinal: 0 }), makeEvent({ timestamp: 1_001, clientOrdinal: 1 })],
    });

    expect(response.statusCode()).toBe(200);
    expect(records.map((record) => record.channel)).toEqual([
      'cloud:session-changed',
      'cloud:session-event',
      'cloud:session-event',
    ]);
    expect(records.every((record) => record.mutexHeld)).toBe(true);
  });

  describe('nested contentRef validation (Stage B1a § MEDIUM #7)', () => {
    it('accepts well-formed top-level contentRef', async () => {
      const deps = makeDeps(makeSession());
      const event = makeEvent({
        type: 'tool',
        toolName: 'bash',
        contentRef: [{
          contentId: '0'.repeat(32),
          mimeType: 'text/plain',
          byteSize: 300_000,
        }],
      } as unknown as Parameters<typeof makeEvent>[0]);

      const response = await postEvents(deps, 'session-1', {
        baseSeq: 0,
        events: [event],
      });

      expect(response.statusCode()).toBe(200);
    });

    it('rejects negative byteSize with 400', async () => {
      const deps = makeDeps(makeSession());
      const event = makeEvent({
        type: 'tool',
        toolName: 'bash',
        contentRef: [{
          contentId: '0'.repeat(32),
          mimeType: 'text/plain',
          byteSize: -1,
        }],
      } as unknown as Parameters<typeof makeEvent>[0]);

      const response = await postEvents(deps, 'session-1', {
        baseSeq: 0,
        events: [event],
      });

      expect(response.statusCode()).toBe(400);
    });

    it('rejects missing mimeType inside toolResult content_ref block', async () => {
      const deps = makeDeps(makeSession());
      const event = makeEvent({
        type: 'tool',
        toolName: 'bash',
        toolResult: {
          content: [{
            type: 'content_ref',
            contentRef: {
              contentId: '0'.repeat(32),
              // mimeType missing
              byteSize: 300_000,
            },
          }],
        },
      } as unknown as Parameters<typeof makeEvent>[0]);

      const response = await postEvents(deps, 'session-1', {
        baseSeq: 0,
        events: [event],
      });

      expect(response.statusCode()).toBe(400);
    });

    it('rejects unknown properties on contentRef objects', async () => {
      const deps = makeDeps(makeSession());
      const event = makeEvent({
        type: 'tool',
        toolName: 'bash',
        contentRef: [{
          contentId: '0'.repeat(32),
          mimeType: 'text/plain',
          byteSize: 300_000,
          unexpected: true,
        }],
      } as unknown as Parameters<typeof makeEvent>[0]);

      const response = await postEvents(deps, 'session-1', {
        baseSeq: 0,
        events: [event],
      });

      expect(response.statusCode()).toBe(400);
    });

    it('accepts null entries as failure markers', async () => {
      const deps = makeDeps(makeSession());
      const event = makeEvent({
        type: 'tool',
        toolName: 'bash',
        contentRef: [null],
      } as unknown as Parameters<typeof makeEvent>[0]);

      const response = await postEvents(deps, 'session-1', {
        baseSeq: 0,
        events: [event],
      });

      expect(response.statusCode()).toBe(200);
    });
  });
});
