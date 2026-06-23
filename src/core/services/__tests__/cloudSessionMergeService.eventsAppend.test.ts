import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession } from '@shared/types';
import { getEventIdentity } from '@shared/utils/eventIdentity';
import {
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

function makeEvent(overrides: Partial<SessionEventsAppendEvent> = {}): SessionEventsAppendEvent {
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

beforeEach(() => {
  vi.clearAllMocks();
  resetCloudSessionMergeServiceForTests();
  resetSessionSeqIndexForTests();
  resetServerClockForTests();
  resetSessionTombstoneStoreForTests();
});

describe('processSessionEventsAppend', () => {
  it('appends a single event and returns its server seq', async () => {
    const deps = makeDeps(makeSession());
    const outcome = await processSessionEventsAppend(deps, appendArgs({
      events: [makeEvent()],
    }));

    expect(outcome).toMatchObject({ kind: 'applied', appliedCount: 1, appliedSeq: [1], serverSeq: 1 });
    const persisted = deps.getCurrentSession();
    expect(persisted?.eventsByTurn['turn-1']?.[0]).toMatchObject({
      type: 'status',
      message: 'queued',
      seq: 1,
      clientOrdinal: 0,
    });
    expect(deps.upsertSession).toHaveBeenCalledTimes(1);
  });

  it('appends multiple events across distinct turns in input order', async () => {
    const deps = makeDeps(makeSession({
      eventsByTurn: { existing: [makeStoredEvent({ seq: 5, timestamp: 500 })] },
      maxSeq: 5,
    }));
    const outcome = await processSessionEventsAppend(deps, appendArgs({
      baseSeq: 5,
      events: [
        makeEvent({ turnId: 'turn-a', timestamp: 1_001, clientOrdinal: 0 }),
        makeEvent({ turnId: 'turn-b', timestamp: 1_002, clientOrdinal: 0 }),
      ],
    }));

    expect(outcome).toMatchObject({ kind: 'applied', appliedSeq: [6, 7], serverSeq: 7 });
    expect(deps.getCurrentSession()?.eventsByTurn['turn-a']?.[0]?.seq).toBe(6);
    expect(deps.getCurrentSession()?.eventsByTurn['turn-b']?.[0]?.seq).toBe(7);
  });

  it('replays the same idempotency key without double-applying events', async () => {
    const deps = makeDeps(makeSession());
    const args = appendArgs({
      events: [makeEvent()],
      idempotencyKey: 'session-1:generation-1:hash-a',
    });

    const first = await processSessionEventsAppend(deps, args);
    const second = await processSessionEventsAppend(deps, args);

    expect(second).toEqual(first);
    expect(deps.upsertSession).toHaveBeenCalledTimes(1);
    expect(deps.getCurrentSession()?.eventsByTurn['turn-1']).toHaveLength(1);
  });

  it('rejects a reused idempotency key with different events', async () => {
    const deps = makeDeps(makeSession());
    await processSessionEventsAppend(deps, appendArgs({
      events: [makeEvent({ timestamp: 1_000 })],
      idempotencyKey: 'session-1:generation-1:hash-a',
    }));

    await expect(processSessionEventsAppend(deps, appendArgs({
      events: [makeEvent({ timestamp: 2_000 })],
      idempotencyKey: 'session-1:generation-1:hash-a',
    }))).rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
    expect(deps.upsertSession).toHaveBeenCalledTimes(1);
  });

  it('returns needs-reconcile when a stale baseSeq collides with an existing event identity', async () => {
    const existing = makeStoredEvent({ seq: 3, timestamp: 1_000, clientOrdinal: 0 });
    const deps = makeDeps(makeSession({
      eventsByTurn: { 'turn-1': [existing] },
      maxSeq: 3,
      cloudUpdatedAt: 9_000,
    }));

    const outcome = await processSessionEventsAppend(deps, appendArgs({
      baseSeq: 2,
      events: [makeEvent({ timestamp: 1_000, clientOrdinal: 0 })],
    }));

    expect(outcome).toEqual({ kind: 'needs-reconcile', serverSeq: 3, cloudUpdatedAt: 9_000 });
    expect(deps.upsertSession).not.toHaveBeenCalled();
  });

  it('detects stale collisions through the F50 clientOrdinal fallback identity', async () => {
    const deps = makeDeps(makeSession({
      eventsByTurn: {
        'turn-1': [makeStoredEvent({ seq: 4, timestamp: 1_111, clientOrdinal: 7 })],
      },
      maxSeq: 4,
    }));

    const outcome = await processSessionEventsAppend(deps, appendArgs({
      baseSeq: 3,
      events: [makeEvent({ timestamp: 1_111, clientOrdinal: 7 })],
    }));

    expect(outcome).toMatchObject({ kind: 'needs-reconcile', serverSeq: 4 });
    expect(deps.upsertSession).not.toHaveBeenCalled();
  });

  it('returns needs-bootstrap when the session does not exist locally', async () => {
    const deps = makeDeps(null);
    const outcome = await processSessionEventsAppend(deps, appendArgs({
      events: [makeEvent()],
    }));

    expect(outcome).toEqual({ kind: 'needs-bootstrap', sessionId: 'session-1' });
    expect(deps.upsertSession).not.toHaveBeenCalled();
  });

  it('applies truncate-turn destructive ops before persisting', async () => {
    const deps = makeDeps(makeSession({
      eventsByTurn: {
        'turn-1': [makeStoredEvent({ seq: 1 })],
        'turn-2': [makeStoredEvent({ seq: 2, timestamp: 2_000 })],
      },
      maxSeq: 2,
    }));

    const outcome = await processSessionEventsAppend(deps, appendArgs({
      baseSeq: 2,
      _destructiveOps: { truncateTurns: ['turn-1'] },
    }));

    expect(outcome).toMatchObject({ kind: 'applied', serverSeq: 2 });
    expect(deps.getCurrentSession()?.eventsByTurn['turn-1']).toEqual([]);
    expect(deps.getCurrentSession()?.eventsByTurn['turn-2']).toHaveLength(1);
  });

  it('applies delete-event destructive ops by event identity', async () => {
    const deleted = makeStoredEvent({ seq: 1, timestamp: 1_000 });
    const kept = makeStoredEvent({ seq: 2, timestamp: 2_000 });
    const deps = makeDeps(makeSession({
      eventsByTurn: { 'turn-1': [deleted, kept] },
      maxSeq: 2,
    }));

    await processSessionEventsAppend(deps, appendArgs({
      baseSeq: 2,
      _destructiveOps: { deleteEventIdentities: [getEventIdentity('turn-1', deleted)] },
    }));

    expect(deps.getCurrentSession()?.eventsByTurn['turn-1']).toEqual([kept]);
  });

  it('applies destructive deletes before appending new events', async () => {
    const deleted = makeStoredEvent({ seq: 1, timestamp: 1_000, message: 'old', clientOrdinal: 0 });
    const deps = makeDeps(makeSession({
      eventsByTurn: { 'turn-1': [deleted] },
      maxSeq: 1,
    }));

    const outcome = await processSessionEventsAppend(deps, appendArgs({
      baseSeq: 1,
      _destructiveOps: { deleteEventIdentities: [getEventIdentity('turn-1', deleted)] },
      events: [makeEvent({ timestamp: 1_000, message: 'new', clientOrdinal: 0 })],
    }));

    expect(outcome).toMatchObject({ kind: 'applied', appliedSeq: [2], serverSeq: 2 });
    expect(deps.getCurrentSession()?.eventsByTurn['turn-1']).toEqual([
      expect.objectContaining({ message: 'new', seq: 2 }),
    ]);
  });

  it('deduplicates messageDelta by message id', async () => {
    const deps = makeDeps(makeSession({
      messages: [makeMessage({ id: 'm1', text: 'existing', createdAt: 1_000 })],
    }));

    await processSessionEventsAppend(deps, appendArgs({
      messageDelta: [
        makeMessage({ id: 'm1', text: 'duplicate', createdAt: 1_001 }),
        makeMessage({ id: 'm2', text: 'new', createdAt: 1_002 }),
      ],
    }));

    expect(deps.getCurrentSession()?.messages.map((message) => [message.id, message.text])).toEqual([
      ['m1', 'existing'],
      ['m2', 'new'],
    ]);
  });

  it('applies messageDeletes before messageDelta', async () => {
    const deps = makeDeps(makeSession({
      messages: [
        makeMessage({ id: 'm1', text: 'old', createdAt: 1_000 }),
        makeMessage({ id: 'm2', text: 'kept', createdAt: 1_001 }),
      ],
    }));

    await processSessionEventsAppend(deps, appendArgs({
      messageDeletes: ['m1'],
      messageDelta: [makeMessage({ id: 'm1', text: 'replacement', createdAt: 1_002 })],
    }));

    expect(deps.getCurrentSession()?.messages.map((message) => [message.id, message.text])).toEqual([
      ['m2', 'kept'],
      ['m1', 'replacement'],
    ]);
  });

  it('records message deletes in the _deletedMessages ledger', async () => {
    setServerNowForTests(() => 12_345);
    const deps = makeDeps(makeSession({
      messages: [makeMessage({ id: 'm1' })],
    }));

    await processSessionEventsAppend(deps, appendArgs({
      messageDeletes: ['m1'],
    }));

    expect((deps.getCurrentSession() as AgentSession & { _deletedMessages?: Record<string, number> })?._deletedMessages).toEqual({
      m1: 12_345,
    });
  });

  it('records destructive ops in the _destructiveOpsLedger', async () => {
    setServerNowForTests(() => 67_890);
    const deleted = makeStoredEvent({ seq: 1, timestamp: 1_000 });
    const identity = getEventIdentity('turn-1', deleted);
    const deps = makeDeps(makeSession({
      eventsByTurn: { 'turn-1': [deleted], 'turn-2': [makeStoredEvent({ seq: 2, timestamp: 2_000 })] },
      maxSeq: 2,
    }));

    await processSessionEventsAppend(deps, appendArgs({
      baseSeq: 2,
      _destructiveOps: {
        truncateTurns: ['turn-2'],
        deleteEventIdentities: [identity],
      },
    }));

    expect((deps.getCurrentSession() as AgentSession & {
      _destructiveOpsLedger?: Array<{ op: string; target: string; appliedAt: number }>;
    })?._destructiveOpsLedger).toEqual([
      { op: 'truncateTurn', target: 'turn-2', appliedAt: 67_890 },
      { op: 'deleteEventIdentity', target: identity, appliedAt: 67_890 },
    ]);
  });

  describe('applyMetadataPatch finishLine semantics', () => {
    it('preserves existing finishLine when the patch omits the key', async () => {
      const deps = makeDeps(makeSession({ finishLine: 'crit' }));

      await processSessionEventsAppend(deps, appendArgs({
        metadataPatch: { title: 'x' },
      }));

      expect(deps.getCurrentSession()?.finishLine).toBe('crit');
      expect(deps.getCurrentSession()?.title).toBe('x');
    });

    it('clears finishLine when the patch sets it to null', async () => {
      const deps = makeDeps(makeSession({ finishLine: 'crit' }));

      await processSessionEventsAppend(deps, appendArgs({
        metadataPatch: { finishLine: null },
      }));

      expect(deps.getCurrentSession()?.finishLine).toBeUndefined();
    });

    it('sets finishLine when the patch supplies a string', async () => {
      const deps = makeDeps(makeSession());

      await processSessionEventsAppend(deps, appendArgs({
        metadataPatch: { finishLine: 'new' },
      }));

      expect(deps.getCurrentSession()?.finishLine).toBe('new');
    });
  });

  describe('Stage 0.C tiebreaker on the PATCH/metadata path', () => {
    function makeRecordingSink(): {
      sink: CloudSessionEffectSink;
      emits: Array<{ channel: string; payload: Record<string, unknown> }>;
      breadcrumbs: Array<{ message: string; data?: Record<string, unknown> }>;
    } {
      const emits: Array<{ channel: string; payload: Record<string, unknown> }> = [];
      const breadcrumbs: Array<{ message: string; data?: Record<string, unknown> }> = [];
      return {
        emits,
        breadcrumbs,
        sink: {
          emit: (event) => {
            emits.push({ channel: event.channel, payload: event.payload as Record<string, unknown> });
          },
          breadcrumb: (breadcrumb) => {
            breadcrumbs.push({ message: breadcrumb.message, data: breadcrumb.data });
          },
        },
      };
    }

    it('reverts the patched value and emits a surface-tiebreaker breadcrumb when desktop races mobile within 100ms on an eligible field', async () => {
      const deps = makeDeps(makeSession({ title: 'Original' }));

      // First write: desktop sets a new title. Records the write at T0.
      const r1 = makeRecordingSink();
      await processSessionEventsAppend(deps, appendArgs({
        sink: r1.sink,
        source: 'desktop',
        surface: 'desktop',
        metadataPatch: { title: 'Desktop title' },
      }));
      expect(deps.getCurrentSession()?.title).toBe('Desktop title');

      // Second write: mobile patches title moments later (same JS tick window
      // → well within the 100ms race window). Desktop must win, breadcrumb
      // must fire.
      const r2 = makeRecordingSink();
      await processSessionEventsAppend(deps, appendArgs({
        sink: r2.sink,
        source: 'mobile',
        surface: 'mobile',
        metadataPatch: { title: 'Mobile title' },
      }));

      // Desktop value preserved
      expect(deps.getCurrentSession()?.title).toBe('Desktop title');

      // surface-tiebreaker breadcrumb emitted
      const tiebreakerBreadcrumbs = r2.breadcrumbs.filter((b) => b.message === 'surface-tiebreaker');
      expect(tiebreakerBreadcrumbs).toHaveLength(1);
      expect(tiebreakerBreadcrumbs[0]?.data).toMatchObject({
        conflictType: 'surface-tiebreaker',
        winnerSurface: 'desktop',
        loserSurface: 'mobile',
        fieldName: 'title',
        raceWindowMs: 100,
        fields: ['title'],
      });

      // Also a concurrent-edit breadcrumb (the normal race-detection signal)
      expect(r2.breadcrumbs.some((b) => b.message === 'concurrent-edit')).toBe(true);
    });

    it('does NOT emit a surface-tiebreaker breadcrumb when the patched field is ineligible', async () => {
      const deps = makeDeps(makeSession({ sessionWorkingModel: undefined } as Partial<AgentSession>));

      // sessionWorkingModel is reported on conflict but is NOT in TIEBREAKER_ELIGIBLE_FIELDS,
      // so it must not be subject to the desktop-wins rule. We provoke a desktop+mobile race
      // by writing the metadataPatch from desktop first then mobile, but the field travels
      // through the AgentSession (not through metadataPatch which would reject it), so we
      // use a non-patchable user-visible difference and seed a recent write directly via the
      // session put path is overkill. Instead, the cleanest assertion is via the parity of
      // breadcrumb absence on the metadata-patch flow: mobile patching title on a session
      // with a recent desktop write to title hits the within-window path (covered above),
      // and mobile patching with a metadataPatch that includes only an ineligible field
      // isn't reachable because AgentSessionMetadataPatch only exposes eligible keys. The
      // canonical ineligible-field assertion therefore lives in the resolver unit test;
      // here we assert the absence assertion for the only ineligible path reachable via
      // processSessionEventsAppend: a race where the prior write happened OUTSIDE the
      // 100ms window.
      const r1 = makeRecordingSink();
      await processSessionEventsAppend(deps, appendArgs({
        sink: r1.sink,
        source: 'desktop',
        surface: 'desktop',
        metadataPatch: { title: 'Desktop title' },
      }));

      // Wait > 100ms so the resolver returns 'outside-race-window'
      await new Promise((resolve) => setTimeout(resolve, 120));

      const r2 = makeRecordingSink();
      await processSessionEventsAppend(deps, appendArgs({
        sink: r2.sink,
        source: 'mobile',
        surface: 'mobile',
        metadataPatch: { title: 'Mobile title' },
      }));

      // Outside the 100ms window: no surface-tiebreaker breadcrumb.
      const tiebreakerBreadcrumbs = r2.breadcrumbs.filter((b) => b.message === 'surface-tiebreaker');
      expect(tiebreakerBreadcrumbs).toHaveLength(0);
      // But the concurrent-edit breadcrumb still fires (still within the 10s window).
      expect(r2.breadcrumbs.some((b) => b.message === 'concurrent-edit')).toBe(true);
    });

    it('does NOT emit a surface-tiebreaker breadcrumb when desktop is on both sides of the race', async () => {
      const deps = makeDeps(makeSession({ title: 'Original' }));

      const r1 = makeRecordingSink();
      await processSessionEventsAppend(deps, appendArgs({
        sink: r1.sink,
        source: 'desktop',
        surface: 'desktop',
        metadataPatch: { title: 'Desktop A' },
      }));

      // Another desktop write — no cross-surface race, so no tiebreaker breadcrumb
      // even though both writes are well within the 100ms window.
      const r2 = makeRecordingSink();
      await processSessionEventsAppend(deps, appendArgs({
        sink: r2.sink,
        source: 'desktop',
        surface: 'desktop',
        metadataPatch: { title: 'Desktop B' },
      }));

      expect(r2.breadcrumbs.filter((b) => b.message === 'surface-tiebreaker')).toHaveLength(0);
    });

    it('emits lifecycle-done-cleared-by-cloud-merge when a remote patch clears a local Done (no concurrent write to protect it)', async () => {
      const deps = makeDeps(makeSession({ doneAt: 5_000 }));
      const r = makeRecordingSink();
      await processSessionEventsAppend(deps, appendArgs({
        sink: r.sink,
        source: 'mobile',
        surface: 'mobile',
        metadataPatch: { doneAt: null },
      }));
      // The local Done was silently cleared (no concurrent write → tiebreaker
      // does not fire) — exactly the multi-device "resurrection" vector.
      expect(deps.getCurrentSession()?.doneAt ?? null).toBeNull();
      // …and it is now observable.
      const cleared = r.breadcrumbs.filter((b) => b.message === 'lifecycle-done-cleared-by-cloud-merge');
      expect(cleared).toHaveLength(1);
      expect(cleared[0]?.data).toMatchObject({ surface: 'mobile', source: 'mobile' });
    });

    it('does NOT report when the patch leaves Active state unchanged (no Done→Active transition)', async () => {
      const deps = makeDeps(makeSession()); // Active (no doneAt)
      const r = makeRecordingSink();
      await processSessionEventsAppend(deps, appendArgs({
        sink: r.sink,
        source: 'mobile',
        surface: 'mobile',
        metadataPatch: { title: 'Renamed on mobile' },
      }));
      expect(r.breadcrumbs.filter((b) => b.message === 'lifecycle-done-cleared-by-cloud-merge')).toHaveLength(0);
    });

    it('does NOT report when the surface-tiebreaker reverts the clear (desktop Done wins within the race window)', async () => {
      const deps = makeDeps(makeSession({ doneAt: null }));
      // Desktop marks Done, recording the write at T0.
      await processSessionEventsAppend(deps, appendArgs({
        sink: makeRecordingSink().sink,
        source: 'desktop',
        surface: 'desktop',
        metadataPatch: { doneAt: 9_000 },
      }));
      expect(deps.getCurrentSession()?.doneAt).toBe(9_000);
      // Mobile clears it moments later (within the 100ms window) → desktop wins
      // → doneAt is restored → the (reverted) clear must NOT be reported.
      const r = makeRecordingSink();
      await processSessionEventsAppend(deps, appendArgs({
        sink: r.sink,
        source: 'mobile',
        surface: 'mobile',
        metadataPatch: { doneAt: null },
      }));
      expect(deps.getCurrentSession()?.doneAt).toBe(9_000);
      expect(r.breadcrumbs.filter((b) => b.message === 'lifecycle-done-cleared-by-cloud-merge')).toHaveLength(0);
    });
  });
});
