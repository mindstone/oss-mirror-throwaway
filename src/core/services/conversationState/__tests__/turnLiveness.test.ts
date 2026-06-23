import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { STALE_TURN_THRESHOLD_MS } from '@core/services/agentTurnReducer/runtime';
import { assertNoStuckBusy } from '@shared/utils/assertNoStuckBusy';
import type { AgentEvent } from '@shared/types';
import {
  __getDeriveTurnLivenessPerfStats,
  __resetDeriveTurnLivenessPerfStats,
  deriveTurnLiveness,
} from '../turnLiveness';

const NOW = 1_700_000_000_000;

const withSeq = <T extends AgentEvent>(event: T, seq?: number): AgentEvent =>
  (typeof seq === 'number' ? { ...event, seq } : event);

const turnStarted = (timestamp: number, seq?: number): AgentEvent =>
  withSeq({ type: 'turn_started', timestamp }, seq);

const statusEvent = (timestamp: number, seq?: number): AgentEvent =>
  withSeq({ type: 'status', message: 'working', timestamp }, seq);

const assistantEvent = (timestamp: number, seq?: number): AgentEvent =>
  withSeq({ type: 'assistant', text: 'hi', timestamp }, seq);

const toolEvent = (timestamp: number, stage: 'start' | 'end', seq?: number): AgentEvent =>
  withSeq({
    type: 'tool',
    toolName: 'Bash',
    detail: '',
    stage,
    timestamp,
  }, seq);

const userMessageEvent = (timestamp: number, seq?: number): AgentEvent =>
  withSeq({ type: 'user_message', text: 'hello', timestamp }, seq);

const resultEvent = (timestamp: number, seq?: number): AgentEvent =>
  withSeq({ type: 'result', text: 'done', timestamp }, seq);

const assertProjectionKeepsBusyInvariant = (
  eventsByTurn: Record<string, AgentEvent[]>,
  liveness: ReturnType<typeof deriveTurnLiveness>,
): void => {
  assertNoStuckBusy({
    isBusy: liveness.status === 'running',
    activeTurnId: liveness.activeTurnId,
    eventsByTurn,
  });
};

type IncrementalAppendOp = {
  turnId: string;
  event: AgentEvent;
};

const pickProjectionFields = (
  liveness: ReturnType<typeof deriveTurnLiveness>,
) => ({
  status: liveness.status,
  activeTurnId: liveness.activeTurnId,
  startedAt: liveness.startedAt,
  lastActivityAt: liveness.lastActivityAt,
});

const cloneEventsByTurn = (
  eventsByTurn: Record<string, AgentEvent[]>,
): Record<string, AgentEvent[]> => Object.fromEntries(
  Object.entries(eventsByTurn).map(([turnId, events]) => [
    turnId,
    events.map((event) => ({ ...event })),
  ]),
);

const runIncrementalThenForcedFullFold = (
  appendOps: IncrementalAppendOp[],
  now: number,
  options?: Parameters<typeof deriveTurnLiveness>[2],
) => {
  __resetDeriveTurnLivenessPerfStats();
  const eventsByTurn: Record<string, AgentEvent[]> = {};
  for (const op of appendOps) {
    if (!eventsByTurn[op.turnId]) {
      eventsByTurn[op.turnId] = [];
    }
    eventsByTurn[op.turnId].push(op.event);
    deriveTurnLiveness(eventsByTurn, now, options);
  }

  const incremental = pickProjectionFields(deriveTurnLiveness(eventsByTurn, now, options));
  const fullRebuildsBeforeComparison = __getDeriveTurnLivenessPerfStats().fullRebuilds;

  // Force from-scratch fold by passing a deep-cloned map (new array refs).
  const fullFold = pickProjectionFields(
    deriveTurnLiveness(cloneEventsByTurn(eventsByTurn), now, options),
  );
  const fullRebuildsAfterComparison = __getDeriveTurnLivenessPerfStats().fullRebuilds;
  return {
    incremental,
    fullFold,
    fullRebuildsBeforeComparison,
    fullRebuildsAfterComparison,
  };
};

describe('deriveTurnLiveness', () => {
  it('is table-driven for core state transitions', () => {
    const cases: Array<{
      name: string;
      eventsByTurn: Record<string, AgentEvent[]>;
      now: number;
      expected: {
        status: 'idle' | 'running' | 'terminal' | 'interrupted';
        activeTurnId: string | null;
      };
    }> = [
      {
        name: 'empty events map projects idle',
        eventsByTurn: {},
        now: NOW,
        expected: { status: 'idle', activeTurnId: null },
      },
      {
        name: 'user_message alone does not prime running (D1)',
        eventsByTurn: {
          'turn-1': [userMessageEvent(NOW - 1_000, 1)],
        },
        now: NOW,
        expected: { status: 'idle', activeTurnId: null },
      },
      {
        name: 'turn_started projects running',
        eventsByTurn: {
          'turn-1': [turnStarted(NOW - 1_000, 1)],
        },
        now: NOW,
        expected: { status: 'running', activeTurnId: 'turn-1' },
      },
      {
        name: 'status self-heal primes running on same turn (D2 preserve)',
        eventsByTurn: {
          'turn-1': [statusEvent(NOW - 1_000, 1)],
        },
        now: NOW,
        expected: { status: 'running', activeTurnId: 'turn-1' },
      },
      {
        name: 'assistant event primes running (D6 preserve)',
        eventsByTurn: {
          'turn-1': [assistantEvent(NOW - 1_000, 1)],
        },
        now: NOW,
        expected: { status: 'running', activeTurnId: 'turn-1' },
      },
      {
        name: 'terminal event projects terminal (D4 liveness-equivalent)',
        eventsByTurn: {
          'turn-1': [resultEvent(NOW - 1_000, 1)],
        },
        now: NOW,
        expected: { status: 'terminal', activeTurnId: null },
      },
      {
        name: 'stale in-flight turn projects interrupted',
        eventsByTurn: {
          'turn-1': [turnStarted(NOW - STALE_TURN_THRESHOLD_MS - 1, 1)],
        },
        now: NOW,
        expected: { status: 'interrupted', activeTurnId: 'turn-1' },
      },
      {
        name: 'tool@end bumps activity but does not terminalize (D7 preserve)',
        eventsByTurn: {
          'turn-1': [
            turnStarted(NOW - 2_000, 1),
            toolEvent(NOW - 1_000, 'end', 2),
          ],
        },
        now: NOW,
        expected: { status: 'running', activeTurnId: 'turn-1' },
      },
      {
        name: 'late old-turn terminal does not clobber newer turn (I-1)',
        eventsByTurn: {
          'turn-old': [
            turnStarted(NOW - 5_000, 1),
            resultEvent(NOW - 3_000, 3),
          ],
          'turn-new': [turnStarted(NOW - 4_000, 2)],
        },
        now: NOW,
        expected: { status: 'running', activeTurnId: 'turn-new' },
      },
    ];

    for (const testCase of cases) {
      const liveness = deriveTurnLiveness(testCase.eventsByTurn, testCase.now);
      expect(liveness.status, testCase.name).toBe(testCase.expected.status);
      expect(liveness.activeTurnId, testCase.name).toBe(testCase.expected.activeTurnId);
      assertProjectionKeepsBusyInvariant(testCase.eventsByTurn, liveness);
    }
  });

  it('drops cross-turn status/tool steal from idle self-heal logic (D2 drop)', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-active': [turnStarted(NOW - 5_000, 1)],
      'turn-late': [statusEvent(NOW - 4_000, 2)],
    };

    const liveness = deriveTurnLiveness(eventsByTurn, NOW);
    expect(liveness.status).toBe('running');
    expect(liveness.activeTurnId).toBe('turn-active');
  });

  it('keeps turn_started unconditional and idempotent (D3 preserve)', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        turnStarted(NOW - 5_000, 1),
        resultEvent(NOW - 4_000, 2),
        turnStarted(NOW - 3_000, 3),
      ],
    };

    const liveness = deriveTurnLiveness(eventsByTurn, NOW);
    expect(liveness.status).toBe('running');
    expect(liveness.activeTurnId).toBe('turn-1');
    expect(liveness.startedAt).toBe(NOW - 3_000);
  });

  it('recovers from stale declared activeTurnId to the live turn (F2 recovery)', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-completed': [
        turnStarted(NOW - 10_000, 1),
        resultEvent(NOW - 9_000, 2),
      ],
      'turn-live': [
        turnStarted(NOW - 2_000, 3),
      ],
    };

    const liveness = deriveTurnLiveness(eventsByTurn, NOW, {
      declaredActiveTurnId: 'turn-completed',
    });

    expect(liveness.status).toBe('running');
    expect(liveness.activeTurnId).toBe('turn-live');
    assertProjectionKeepsBusyInvariant(eventsByTurn, liveness);
  });

  it('uses admission-order tiebreak independently of event ordering (H5 non-circular)', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-A': [turnStarted(10, 10)],
      'turn-B': [turnStarted(20, 10)],
    };

    const withoutAdmissionOrder = deriveTurnLiveness(eventsByTurn, NOW);
    const withAdmissionOrder = deriveTurnLiveness(eventsByTurn, NOW, {
      turnAdmissionOrder: new Map([
        ['turn-B', 1],
        ['turn-A', 2],
      ]),
    });

    expect(withoutAdmissionOrder.activeTurnId).toBe('turn-B');
    expect(withAdmissionOrder.activeTurnId).toBe('turn-A');
  });

  it('deterministically resolves same-timestamp legacy events by stable insertion order', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-first': [turnStarted(500)],
      'turn-second': [turnStarted(500)],
    };

    const firstProjection = deriveTurnLiveness(eventsByTurn, NOW);
    const secondProjection = deriveTurnLiveness(eventsByTurn, NOW);

    expect(firstProjection.activeTurnId).toBe('turn-second');
    expect(secondProjection.activeTurnId).toBe('turn-second');
  });

  it('keeps long-running tool activity fresh before threshold (D7 staleness case)', () => {
    const turnStartedAt = NOW - STALE_TURN_THRESHOLD_MS - 20_000;
    const toolEndedAt = NOW - STALE_TURN_THRESHOLD_MS + 1_000;
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-tool': [
        turnStarted(turnStartedAt, 1),
        toolEvent(toolEndedAt, 'end', 2),
      ],
    };

    const liveness = deriveTurnLiveness(eventsByTurn, NOW);
    expect(liveness.status).toBe('running');
    expect(liveness.lastActivityAt).toBe(toolEndedAt);
  });

  it('matches from-scratch full fold across adversarial append-order fixtures', () => {
    const staleStartedAt = NOW - STALE_TURN_THRESHOLD_MS - 500;
    const cases: Array<{
      name: string;
      appendOps: IncrementalAppendOp[];
    }> = [
      {
        name: 'single turn append progression',
        appendOps: [
          { turnId: 'turn-single', event: turnStarted(NOW - 5, 1) },
          { turnId: 'turn-single', event: statusEvent(NOW - 4, 2) },
          { turnId: 'turn-single', event: assistantEvent(NOW - 3, 3) },
        ],
      },
      {
        name: 'multi-turn interleaved append stream',
        appendOps: [
          { turnId: 'turn-A', event: turnStarted(NOW - 8, 1) },
          { turnId: 'turn-B', event: turnStarted(NOW - 7, 2) },
          { turnId: 'turn-A', event: statusEvent(NOW - 6, 3) },
          { turnId: 'turn-B', event: assistantEvent(NOW - 5, 4) },
        ],
      },
      {
        name: 'late old-turn events inserted after newer turn',
        appendOps: [
          { turnId: 'turn-new', event: turnStarted(NOW - 2, 30) },
          { turnId: 'turn-new', event: statusEvent(NOW - 1, 31) },
          { turnId: 'turn-old', event: turnStarted(NOW - 20, 10) },
          { turnId: 'turn-old', event: assistantEvent(NOW - 19, 11) },
        ],
      },
      {
        name: 'duplicate seq values across and within turns',
        appendOps: [
          { turnId: 'turn-left', event: turnStarted(NOW - 10, 7) },
          { turnId: 'turn-right', event: turnStarted(NOW - 9, 7) },
          { turnId: 'turn-left', event: statusEvent(NOW - 8, 7) },
          { turnId: 'turn-right', event: assistantEvent(NOW - 7, 8) },
        ],
      },
      {
        name: 'same-timestamp legacy seq-less events',
        appendOps: [
          { turnId: 'turn-first', event: turnStarted(NOW) },
          { turnId: 'turn-second', event: statusEvent(NOW) },
          { turnId: 'turn-first', event: assistantEvent(NOW) },
          { turnId: 'turn-second', event: userMessageEvent(NOW) },
        ],
      },
      {
        name: 'terminal event then more events on same turn',
        appendOps: [
          { turnId: 'turn-terminal', event: turnStarted(NOW - 6, 1) },
          { turnId: 'turn-terminal', event: resultEvent(NOW - 5, 2) },
          { turnId: 'turn-terminal', event: statusEvent(NOW - 4, 3) },
        ],
      },
      {
        name: 'stale turn alongside fresh turn',
        appendOps: [
          { turnId: 'turn-stale', event: turnStarted(staleStartedAt, 1) },
          { turnId: 'turn-fresh', event: turnStarted(NOW - 2, 2) },
          { turnId: 'turn-fresh', event: toolEvent(NOW - 1, 'end', 3) },
        ],
      },
    ];

    for (const testCase of cases) {
      const result = runIncrementalThenForcedFullFold(testCase.appendOps, NOW, {
        turnAdmissionOrder: {
          'turn-single': 1,
          'turn-A': 1,
          'turn-B': 2,
          'turn-old': 1,
          'turn-new': 2,
          'turn-left': 1,
          'turn-right': 2,
          'turn-first': 1,
          'turn-second': 2,
          'turn-terminal': 1,
          'turn-stale': 1,
          'turn-fresh': 2,
        },
      });

      expect(
        result.fullRebuildsAfterComparison,
        `${testCase.name}: expected forced full rebuild`,
      ).toBeGreaterThan(result.fullRebuildsBeforeComparison);
      expect(result.incremental, testCase.name).toEqual(result.fullFold);
    }
  });

  it('property: incremental append stream matches forced full fold', () => {
    const turnIdArbitrary = fc.constantFrom('turn-A', 'turn-B', 'turn-old', 'turn-new');
    const timestampArbitrary = fc.oneof(
      fc.integer({
        min: NOW - (STALE_TURN_THRESHOLD_MS * 2),
        max: NOW - STALE_TURN_THRESHOLD_MS - 1,
      }),
      fc.integer({ min: NOW - 6, max: NOW + 6 }),
    );
    const seqArbitrary = fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined });
    const eventArbitrary: fc.Arbitrary<AgentEvent> = fc.record({
      kind: fc.constantFrom(
        'turn_started',
        'status',
        'assistant',
        'tool_start',
        'tool_end',
        'user_message',
        'result',
        'error',
      ),
      timestamp: timestampArbitrary,
      seq: seqArbitrary,
      seed: fc.integer({ min: 0, max: 9 }),
    }).map(({ kind, timestamp, seq, seed }) => {
      const withOptionalSeq = <T extends AgentEvent>(event: T): AgentEvent =>
        (typeof seq === 'number' ? { ...event, seq } : event);
      switch (kind) {
        case 'turn_started':
          return withOptionalSeq({ type: 'turn_started', timestamp });
        case 'status':
          return withOptionalSeq({ type: 'status', message: `status-${seed}`, timestamp });
        case 'assistant':
          return withOptionalSeq({ type: 'assistant', text: `assistant-${seed}`, timestamp });
        case 'tool_start':
          return withOptionalSeq({
            type: 'tool',
            toolName: 'Bash',
            detail: `tool-${seed}`,
            stage: 'start',
            timestamp,
          });
        case 'tool_end':
          return withOptionalSeq({
            type: 'tool',
            toolName: 'Bash',
            detail: `tool-${seed}`,
            stage: 'end',
            timestamp,
          });
        case 'user_message':
          return withOptionalSeq({ type: 'user_message', text: `user-${seed}`, timestamp });
        case 'result':
          return withOptionalSeq({ type: 'result', text: `result-${seed}`, timestamp });
        case 'error':
          return withOptionalSeq({ type: 'error', error: `error-${seed}`, timestamp });
      }
    });

    const appendOpArbitrary: fc.Arbitrary<IncrementalAppendOp> = fc.record({
      turnId: turnIdArbitrary,
      event: eventArbitrary,
    });

    fc.assert(
      fc.property(
        fc.array(appendOpArbitrary, { minLength: 1, maxLength: 70 }),
        fc.boolean(),
        (appendOps, useAdmissionOrder) => {
          const options = useAdmissionOrder
            ? {
              turnAdmissionOrder: new Map<string, number>([
                ['turn-old', 1],
                ['turn-A', 2],
                ['turn-B', 3],
                ['turn-new', 4],
              ]),
            }
            : undefined;
          const result = runIncrementalThenForcedFullFold(appendOps, NOW, options);
          expect(result.fullRebuildsAfterComparison).toBeGreaterThan(
            result.fullRebuildsBeforeComparison,
          );
          expect(result.incremental).toEqual(result.fullFold);
        },
      ),
      {
        numRuns: 200,
        seed: 260531,
      },
    );
  });

  it('bounds fold work to appended events on the hot path', () => {
    __resetDeriveTurnLivenessPerfStats();

    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-hot-path': [turnStarted(NOW - 10_000, 1)],
    };
    deriveTurnLiveness(eventsByTurn, NOW);

    const APPENDS = 120;
    for (let i = 0; i < APPENDS; i += 1) {
      eventsByTurn['turn-hot-path'].push(
        statusEvent(NOW - 9_000 + i, i + 2),
      );
      deriveTurnLiveness(eventsByTurn, NOW + i);
    }

    const stats = __getDeriveTurnLivenessPerfStats();
    expect(stats.fullRebuilds).toBe(1);
    expect(stats.fullRefoldsAfterIncrementalInsert).toBe(0);
    expect(stats.tailOnlyFolds).toBe(APPENDS);
    // 1 initial full fold + 1 appended event folded per subsequent tick.
    expect(stats.foldedEventCount).toBe(APPENDS + 1);
  });
});
