import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession } from '@shared/types';
import { getEventIdentity } from '@shared/utils/eventIdentity';
import {
  getCatchUpEvents,
  mergeDesktopPushIntoCloud,
  processSessionEventsAppend,
  resetCloudSessionMergeServiceForTests,
  type CloudSessionEffectSink,
  type CloudSessionMergeDeps,
  type SessionEventsAppendEvent,
} from '../cloudSessionMergeService';
import { resetSessionSeqIndexForTests } from '../sessionSeqIndex';
import { resetServerClockForTests, setServerNowForTests } from '@core/services/continuity/serverClock';
import { resetSessionTombstoneStoreForTests } from '@core/services/continuity/sessionTombstoneStore';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-1',
    title: 'Title',
    createdAt: 1_000,
    updatedAt: 2_000,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    origin: 'manual',
    ...overrides,
  } as AgentSession;
}

function makeStoredEvent(overrides: Partial<AgentEvent & { clientOrdinal?: number }> = {}): AgentEvent {
  return {
    type: 'status',
    message: 'stored',
    timestamp: 1_000,
    seq: 1,
    clientOrdinal: 0,
    ...overrides,
  } as AgentEvent;
}

function makeAppendEvent(overrides: Partial<SessionEventsAppendEvent> = {}): SessionEventsAppendEvent {
  return {
    type: 'status',
    message: 'queued',
    timestamp: 1_000,
    turnId: 'turn-1',
    seq: null,
    clientOrdinal: 0,
    ...overrides,
  } as SessionEventsAppendEvent;
}

function makeMessage(overrides: Partial<AgentSession['messages'][number]> = {}): AgentSession['messages'][number] {
  return {
    id: 'message-1',
    turnId: 'turn-1',
    role: 'user',
    text: 'Hello',
    createdAt: 1_000,
    ...overrides,
  };
}

function makeSink(): CloudSessionEffectSink {
  return {
    emit: vi.fn(),
    breadcrumb: vi.fn(),
  };
}

function makeDeps(initialSession: AgentSession | null): CloudSessionMergeDeps & {
  getCurrentSession: () => AgentSession | null;
  upsertSession: ReturnType<typeof vi.fn<(session: AgentSession) => Promise<void>>>;
} {
  let current = initialSession;
  const upsertSession = vi.fn<(session: AgentSession) => Promise<void>>(async (session) => {
    current = session;
  });
  return {
    getSession: vi.fn(async () => current),
    upsertSession,
    deleteSession: vi.fn(async () => {}),
    getActiveTurnController: vi.fn(() => undefined),
    listSessions: vi.fn(() => []),
    readContinuityStateMap: vi.fn(async () => null),
    getCurrentSession: () => current,
  };
}

function appendArgs(overrides: Partial<Parameters<typeof processSessionEventsAppend>[1]> = {}): Parameters<typeof processSessionEventsAppend>[1] {
  return {
    sessionId: 'session-1',
    baseSeq: 0,
    events: [],
    surface: 'desktop',
    source: 'desktop',
    sink: makeSink(),
    ...overrides,
  };
}

function eventMessage(event: AgentEvent): string | undefined {
  return 'message' in event && typeof event.message === 'string' ? event.message : undefined;
}

function compactEvents(session: AgentSession | null): Array<{ turnId: string; seq: number | null | undefined; message: string | undefined }> {
  return Object.entries(session?.eventsByTurn ?? {})
    .flatMap(([turnId, events]) => events.map((event) => ({
      turnId,
      seq: event.seq,
      message: eventMessage(event),
    })))
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
}

function applyReseedPayload(session: AgentSession, outcome: Extract<Awaited<ReturnType<typeof getCatchUpEvents>>, { kind: 'events' }>): AgentSession {
  const eventsByTurn = { ...(session.eventsByTurn ?? {}) };
  for (const turnId of outcome.destructiveOpsApplied?.truncatedTurns ?? []) {
    eventsByTurn[turnId] = [];
  }
  for (const identity of outcome.destructiveOpsApplied?.deletedEventIdentities ?? []) {
    for (const [turnId, events] of Object.entries(eventsByTurn)) {
      eventsByTurn[turnId] = events.filter((event) => getEventIdentity(turnId, event) !== identity);
    }
  }
  for (const event of outcome.events) {
    const { turnId, ...storedEvent } = event;
    const existing = eventsByTurn[turnId] ?? [];
    const nextEvent = storedEvent as AgentEvent;
    if (!existing.some((candidate) => getEventIdentity(turnId, candidate) === getEventIdentity(turnId, nextEvent))) {
      eventsByTurn[turnId] = [...existing, nextEvent].sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
    }
  }
  const deletedMessages = new Set(outcome.messageDeletes ?? []);
  const existingMessages = (session.messages ?? []).filter((message) => !deletedMessages.has(message.id));
  const byId = new Map(existingMessages.map((message) => [message.id, message]));
  for (const message of outcome.messageDelta ?? []) {
    if (!deletedMessages.has(message.id) && !byId.has(message.id)) {
      byId.set(message.id, message);
    }
  }
  return {
    ...session,
    eventsByTurn,
    messages: Array.from(byId.values()).sort((left, right) => left.createdAt - right.createdAt),
    maxSeq: Math.max(session.maxSeq ?? 0, outcome.serverSeq),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCloudSessionMergeServiceForTests();
  resetSessionSeqIndexForTests();
  resetServerClockForTests();
  resetSessionTombstoneStoreForTests();
});

describe('session delta-merge convergence contract', () => {
  it('orders the same pre-sequenced deltas canonically regardless of arrival order', () => {
    const eventA = makeStoredEvent({ seq: 11, timestamp: 2_000, message: 'A', clientOrdinal: 0 });
    const eventB = makeStoredEvent({ seq: 12, timestamp: 1_000, message: 'B', clientOrdinal: 1 });
    const base = makeSession({
      eventsByTurn: {
        'turn-1': [makeStoredEvent({ seq: 10, timestamp: 500, message: 'base', clientOrdinal: 0 })],
      },
      maxSeq: 10,
    });
    const incomingAB = makeSession({ eventsByTurn: { 'turn-1': [eventA, eventB] }, maxSeq: 12 });
    const incomingBA = makeSession({ eventsByTurn: { 'turn-1': [eventB, eventA] }, maxSeq: 12 });

    const mergedAB = mergeDesktopPushIntoCloud(base, incomingAB);
    const mergedBA = mergeDesktopPushIntoCloud(base, incomingBA);

    expect(compactEvents(mergedAB)).toEqual(compactEvents(mergedBA));
    expect(compactEvents(mergedAB)).toEqual([
      { turnId: 'turn-1', seq: 10, message: 'base' },
      { turnId: 'turn-1', seq: 11, message: 'A' },
      { turnId: 'turn-1', seq: 12, message: 'B' },
    ]);
  });

  it('treats a duplicate stale delta as idempotent after reconnect reconciliation', async () => {
    const deps = makeDeps(makeSession());
    const first = await processSessionEventsAppend(deps, appendArgs({
      events: [makeAppendEvent({ timestamp: 1_111, clientOrdinal: 7, message: 'dedupe-me' })],
    }));
    expect(first).toMatchObject({ kind: 'applied', appliedSeq: [1], serverSeq: 1 });

    const duplicate = await processSessionEventsAppend(deps, appendArgs({
      baseSeq: 0,
      events: [makeAppendEvent({ timestamp: 1_111, clientOrdinal: 7, message: 'dedupe-me' })],
    }));

    expect(duplicate).toEqual({ kind: 'needs-reconcile', serverSeq: 1, cloudUpdatedAt: deps.getCurrentSession()?.cloudUpdatedAt });
    expect(compactEvents(deps.getCurrentSession())).toEqual([
      { turnId: 'turn-1', seq: 1, message: 'dedupe-me' },
    ]);
    expect(deps.upsertSession).toHaveBeenCalledTimes(1);
  });

  it('re-seed plus cursor resume preserves deletes, existing events, and later deltas without duplication', async () => {
    setServerNowForTests(() => 9_000);
    const deletedEvent = makeStoredEvent({ seq: 1, timestamp: 1_000, message: 'delete-me', clientOrdinal: 0 });
    const deletedIdentity = getEventIdentity('turn-1', deletedEvent);
    const deps = makeDeps(makeSession({
      eventsByTurn: {
        'turn-1': [
          deletedEvent,
          makeStoredEvent({ seq: 2, timestamp: 2_000, message: 'keep-me', clientOrdinal: 1 }),
        ],
      },
      messages: [
        makeMessage({ id: 'm1', text: 'remove', createdAt: 1_000 }),
        makeMessage({ id: 'm2', text: 'keep', createdAt: 2_000 }),
      ],
      maxSeq: 2,
    }));

    await processSessionEventsAppend(deps, appendArgs({
      baseSeq: 2,
      _destructiveOps: { deleteEventIdentities: [deletedIdentity] },
      messageDeletes: ['m1'],
      events: [makeAppendEvent({ timestamp: 3_000, message: 'after-delete', clientOrdinal: 2 })],
      messageDelta: [makeMessage({ id: 'm3', text: 'new', createdAt: 3_000 })],
    }));
    const serverSession = deps.getCurrentSession();
    expect(compactEvents(serverSession)).toEqual([
      { turnId: 'turn-1', seq: 2, message: 'keep-me' },
      { turnId: 'turn-1', seq: 3, message: 'after-delete' },
    ]);

    const reseed = await getCatchUpEvents(deps, { sessionId: 'session-1', sinceSeq: 0, limit: 500 });
    expect(reseed.kind).toBe('events');
    if (reseed.kind !== 'events') throw new Error('Expected re-seed events');
    let replica = applyReseedPayload(makeSession(), reseed);

    const resume = await getCatchUpEvents(deps, { sessionId: 'session-1', sinceSeq: reseed.serverSeq, limit: 500 });
    expect(resume.kind).toBe('events');
    if (resume.kind !== 'events') throw new Error('Expected resume events');
    replica = applyReseedPayload(replica, resume);

    expect(compactEvents(replica)).toEqual(compactEvents(serverSession));
    expect(replica.messages.map((message) => [message.id, message.text])).toEqual([
      ['m2', 'keep'],
      ['m3', 'new'],
    ]);
  });
});
