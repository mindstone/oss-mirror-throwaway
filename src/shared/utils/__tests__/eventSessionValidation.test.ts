import type { AgentEvent } from '@shared/types';

import type { SequencedAgentEvent } from '../eventIdentity';
import {
  __resetEventSessionValidationDiagnosticsForTest,
  classifyEventForSession,
  getEventSessionValidationDiagnostics,
  validateEventForSession,
  type SequencedSessionedAgentEvent,
} from '../eventSessionValidation';

type StatusEvent = Extract<AgentEvent, { type: 'status' }>;

const makeStatusEvent = (
  overrides: Partial<StatusEvent & { sessionId?: string; seq?: number }> = {},
): StatusEvent & { sessionId?: string; seq?: number } => ({
  type: 'status',
  message: 'status',
  timestamp: 1_000,
  seq: 1,
  ...overrides,
});

const stamp = <E extends AgentEvent>(event: E): SequencedAgentEvent<E> =>
  event as SequencedAgentEvent<E>;

beforeEach(() => {
  __resetEventSessionValidationDiagnosticsForTest();
});

describe('classifyEventForSession', () => {
  it('classifies matching event.sessionId as own', () => {
    const event = makeStatusEvent({ sessionId: 'session-A' });

    const result = classifyEventForSession(event, 'session-A');

    expect(result).toEqual({ kind: 'own' });
  });

  it('classifies missing event.sessionId as accepted-legacy', () => {
    const event = makeStatusEvent();

    const result = classifyEventForSession(event, 'session-A');

    expect(result).toEqual({ kind: 'accepted-legacy' });
  });

  it('classifies undefined eventSessionId override as accepted-legacy when event has no sessionId', () => {
    const event = makeStatusEvent();

    const result = classifyEventForSession(event, 'session-A', {
      eventSessionId: undefined,
    });

    expect(result).toEqual({ kind: 'accepted-legacy' });
  });

  it('classifies empty-string sessionId as accepted-legacy', () => {
    const event = makeStatusEvent({ sessionId: '' });

    const result = classifyEventForSession(event, 'session-A');

    expect(result).toEqual({ kind: 'accepted-legacy' });
  });

  it('classifies mismatched event.sessionId as rejected-foreign', () => {
    const event = makeStatusEvent({ sessionId: 'session-B' });

    const result = classifyEventForSession(event, 'session-A');

    expect(result).toEqual({
      kind: 'rejected-foreign',
      eventSessionId: 'session-B',
    });
  });

  it('uses eventSessionId override as authoritative provenance', () => {
    const event = makeStatusEvent({ sessionId: 'stale-on-event' });

    const result = classifyEventForSession(event, 'session-A', {
      eventSessionId: 'session-A',
    });

    expect(result).toEqual({ kind: 'own' });
  });
});

describe('validateEventForSession — accept', () => {
  it('returns ok=true and mints brand when event.sessionId === target', () => {
    const event = stamp(makeStatusEvent({ sessionId: 'session-A', seq: 1 }));

    const result = validateEventForSession(event, 'session-A', {
      turnId: 'turn-1',
      source: 'ipc-agent-event',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const branded: SequencedSessionedAgentEvent<'session-A', StatusEvent> = result.event;
      expect(branded.seq).toBe(1);
    }
  });

  it('does not increment counters on accept', () => {
    const event = stamp(makeStatusEvent({ sessionId: 'session-A' }));

    validateEventForSession(event, 'session-A', {
      turnId: 'turn-1',
      source: 'ipc-agent-event',
    });

    const diag = getEventSessionValidationDiagnostics();
    expect(diag.rejectsByKey).toEqual({});
    expect(diag.legacyByKey).toEqual({});
    expect(diag.firstRejectAt).toBeNull();
    expect(diag.lastRejectAt).toBeNull();
  });
});

describe('validateEventForSession — reject-foreign', () => {
  it('returns ok=false with rejected-foreign when event.sessionId !== target', () => {
    const event = stamp(makeStatusEvent({ sessionId: 'session-B' }));

    const result = validateEventForSession(event, 'session-A', {
      turnId: 'turn-1',
      source: 'cache-hit-backfill',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome.kind).toBe('rejected-foreign');
      if (result.outcome.kind === 'rejected-foreign') {
        expect(result.outcome.eventSessionId).toBe('session-B');
        expect(result.outcome.targetSessionId).toBe('session-A');
      }
    }
  });

  it('increments rejectsByKey keyed by source:outcome:eventType', () => {
    const event = stamp(makeStatusEvent({ sessionId: 'session-B' }));

    validateEventForSession(event, 'session-A', {
      turnId: 'turn-1',
      source: 'ipc-agent-event',
    });

    const diag = getEventSessionValidationDiagnostics();
    expect(diag.rejectsByKey).toEqual({
      'ipc-agent-event:rejected-foreign:status': 1,
    });
    expect(diag.legacyByKey).toEqual({});
  });

  it('separate tuples are counted separately', () => {
    const fromIpc = stamp(makeStatusEvent({ sessionId: 'session-B' }));
    const fromBackfill = stamp(makeStatusEvent({ sessionId: 'session-B' }));

    validateEventForSession(fromIpc, 'session-A', {
      turnId: 't1',
      source: 'ipc-agent-event',
    });
    validateEventForSession(fromBackfill, 'session-A', {
      turnId: 't1',
      source: 'cache-hit-backfill',
    });

    const diag = getEventSessionValidationDiagnostics();
    expect(diag.rejectsByKey['ipc-agent-event:rejected-foreign:status']).toBe(1);
    expect(diag.rejectsByKey['cache-hit-backfill:rejected-foreign:status']).toBe(1);
  });

  it('repeats of the same tuple accumulate', () => {
    const event = stamp(makeStatusEvent({ sessionId: 'session-B' }));

    for (let index = 0; index < 5; index += 1) {
      validateEventForSession(event, 'session-A', {
        turnId: 't1',
        source: 'ipc-agent-event',
      });
    }

    const diag = getEventSessionValidationDiagnostics();
    expect(diag.rejectsByKey['ipc-agent-event:rejected-foreign:status']).toBe(5);
  });

  it('updates firstRejectAt and lastRejectAt', () => {
    const event = stamp(makeStatusEvent({ sessionId: 'session-B' }));
    const before = Date.now();

    validateEventForSession(event, 'session-A', {
      turnId: 't1',
      source: 'ipc-agent-event',
    });

    const diag = getEventSessionValidationDiagnostics();
    expect(diag.firstRejectAt).not.toBeNull();
    expect(diag.lastRejectAt).not.toBeNull();
    expect((diag.firstRejectAt ?? 0) >= before).toBe(true);
    expect((diag.lastRejectAt ?? 0) >= (diag.firstRejectAt ?? 0)).toBe(true);
  });
});

describe('validateEventForSession — accept-legacy', () => {
  it('returns ok=false with accepted-legacy when event has no sessionId', () => {
    const event = stamp(makeStatusEvent());

    const result = validateEventForSession(event, 'session-A', {
      turnId: 't1',
      source: 'history-replay',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome.kind).toBe('accepted-legacy');
    }
  });

  it('treats empty-string sessionId as missing (legacy)', () => {
    const event = stamp(makeStatusEvent({ sessionId: '' }));

    const result = validateEventForSession(event, 'session-A', {
      turnId: 't1',
      source: 'history-replay',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome.kind).toBe('accepted-legacy');
    }
  });

  it('increments legacyByKey but not rejectsByKey or reject timestamps', () => {
    const event = stamp(makeStatusEvent());

    validateEventForSession(event, 'session-A', {
      turnId: 't1',
      source: 'history-replay',
    });

    const diag = getEventSessionValidationDiagnostics();
    expect(diag.legacyByKey).toEqual({
      'history-replay:accepted-legacy:status': 1,
    });
    expect(diag.rejectsByKey).toEqual({});
    expect(diag.firstRejectAt).toBeNull();
    expect(diag.lastRejectAt).toBeNull();
  });
});

describe('validateEventForSession — counter independence', () => {
  it('reject and legacy counters are independent', () => {
    const foreign = stamp(makeStatusEvent({ sessionId: 'session-B' }));
    const legacy = stamp(makeStatusEvent());

    validateEventForSession(foreign, 'session-A', {
      turnId: 't1',
      source: 'ipc-agent-event',
    });
    validateEventForSession(legacy, 'session-A', {
      turnId: 't1',
      source: 'ipc-agent-event',
    });

    const diag = getEventSessionValidationDiagnostics();
    expect(diag.rejectsByKey['ipc-agent-event:rejected-foreign:status']).toBe(1);
    expect(diag.legacyByKey['ipc-agent-event:accepted-legacy:status']).toBe(1);
  });

  it('getDiagnostics returns a copy that does not mutate internal state', () => {
    const event = stamp(makeStatusEvent({ sessionId: 'session-B' }));

    validateEventForSession(event, 'session-A', {
      turnId: 't1',
      source: 'ipc-agent-event',
    });

    const snapshot = getEventSessionValidationDiagnostics();
    snapshot.rejectsByKey['ipc-agent-event:rejected-foreign:status'] = 999;

    const second = getEventSessionValidationDiagnostics();
    expect(second.rejectsByKey['ipc-agent-event:rejected-foreign:status']).toBe(1);
  });
});

describe('validateEventForSession — explicit eventSessionId provenance (Stage 19a contract fix)', () => {
  // THE CONTRACT FIX: the foreground live path carries provenance as a
  // separate envelope field (`eventSessionId`), NOT on the event object. The
  // explicit `opts.eventSessionId` must be the authoritative source so the
  // foreground path can actually reject a foreign event instead of falling to
  // `accepted-legacy` (the phantom-fix failure mode the spike flagged).

  it('rejects when explicit eventSessionId !== target, even if event.sessionId is absent', () => {
    // Event carries NO sessionId (the common foreground-live shape) — the only
    // provenance is the explicit arg. Reading the event alone would mis-classify
    // this as accepted-legacy; the explicit arg makes it a real reject.
    const event = stamp(makeStatusEvent());

    const result = validateEventForSession(event, 'session-A', {
      turnId: 'turn-1',
      source: 'ipc-agent-event',
      eventSessionId: 'session-B',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome.kind).toBe('rejected-foreign');
      if (result.outcome.kind === 'rejected-foreign') {
        expect(result.outcome.eventSessionId).toBe('session-B');
        expect(result.outcome.targetSessionId).toBe('session-A');
      }
    }
  });

  it('accepts when explicit eventSessionId === target, even if event.sessionId is absent', () => {
    const event = stamp(makeStatusEvent());

    const result = validateEventForSession(event, 'session-A', {
      turnId: 'turn-1',
      source: 'ipc-agent-event',
      eventSessionId: 'session-A',
    });

    expect(result.ok).toBe(true);
  });

  it('explicit eventSessionId takes precedence over a conflicting event.sessionId', () => {
    // Event is stamped with the WRONG session, but the explicit (authoritative)
    // provenance matches the target → accept. The explicit arg wins.
    const event = stamp(makeStatusEvent({ sessionId: 'stale-on-event' }));

    const result = validateEventForSession(event, 'session-A', {
      turnId: 'turn-1',
      source: 'ipc-agent-event',
      eventSessionId: 'session-A',
    });

    expect(result.ok).toBe(true);
  });

  it('falls back to event.sessionId when explicit eventSessionId is omitted (backward compat)', () => {
    const event = stamp(makeStatusEvent({ sessionId: 'session-B' }));

    const result = validateEventForSession(event, 'session-A', {
      turnId: 'turn-1',
      source: 'ipc-agent-event',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.outcome.kind).toBe('rejected-foreign');
  });

  it('treats an empty-string explicit eventSessionId as missing → falls back to event.sessionId', () => {
    const event = stamp(makeStatusEvent({ sessionId: 'session-B' }));

    const result = validateEventForSession(event, 'session-A', {
      turnId: 'turn-1',
      source: 'ipc-agent-event',
      eventSessionId: '',
    });

    // Empty explicit arg is ignored; the event's own (foreign) sessionId is used.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.outcome.kind).toBe('rejected-foreign');
  });

  it('legacy when neither explicit eventSessionId nor event.sessionId is present', () => {
    const event = stamp(makeStatusEvent());

    const result = validateEventForSession(event, 'session-A', {
      turnId: 'turn-1',
      source: 'ipc-agent-event',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.outcome.kind).toBe('accepted-legacy');
  });
});

describe('validateEventForSession — reset helper', () => {
  it('clears all counters and timestamps', () => {
    const foreign = stamp(makeStatusEvent({ sessionId: 'session-B' }));
    validateEventForSession(foreign, 'session-A', {
      turnId: 't1',
      source: 'ipc-agent-event',
    });

    __resetEventSessionValidationDiagnosticsForTest();

    const diag = getEventSessionValidationDiagnostics();
    expect(diag.rejectsByKey).toEqual({});
    expect(diag.legacyByKey).toEqual({});
    expect(diag.firstRejectAt).toBeNull();
    expect(diag.lastRejectAt).toBeNull();
  });
});
