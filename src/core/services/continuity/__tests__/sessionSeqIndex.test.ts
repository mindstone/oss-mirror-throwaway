import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentSession } from '@shared/types';
import {
  getMaxSeqFromSession,
  getSessionSeqIndex,
  resetSessionSeqIndexForTests,
  stampEventSeq,
  stampMissingEventSeq,
} from '../sessionSeqIndex';

function statusEvent(message: string, timestamp: number, seq?: number): AgentEvent {
  return { type: 'status', message, timestamp, seq };
}

function baseSession(overrides?: Partial<AgentSession>): AgentSession {
  return {
    id: 'session-1',
    title: 'Test',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  };
}

describe('sessionSeqIndex', () => {
  beforeEach(() => {
    resetSessionSeqIndexForTests();
  });

  it('hydrates current seq from persisted sessions', () => {
    const index = getSessionSeqIndex();
    index.hydrateFromSessions([
      baseSession({
        id: 'session-1',
        maxSeq: 9,
        eventsByTurn: {
          turn1: [statusEvent('a', 10, 4)],
        },
      }),
      baseSession({
        id: 'session-2',
        eventsByTurn: {
          turn2: [statusEvent('b', 10, 12)],
        },
      }),
    ]);

    expect(index.getCurrentSeq('session-1')).toBe(9);
    expect(index.getCurrentSeq('session-2')).toBe(12);
  });

  it('stamps new events with monotonically increasing seq', () => {
    const first = stampEventSeq('session-3', statusEvent('first', 100));
    const second = stampEventSeq('session-3', statusEvent('second', 101));
    const thirdOtherSession = stampEventSeq('session-4', statusEvent('other', 102));

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(thirdOtherSession.seq).toBe(1);
  });

  it('stamps only missing seq values in deterministic timestamp order and updates maxSeq', () => {
    const stamped = stampMissingEventSeq(
      baseSession({
        id: 'session-5',
        maxSeq: 7,
        eventsByTurn: {
          turnA: [
            statusEvent('a-missing', 10),
            statusEvent('a-existing', 15, 7),
          ],
          turnB: [statusEvent('b-missing', 20)],
        },
      }),
    );

    expect(stamped.eventsByTurn.turnA[0].seq).toBe(8);
    expect(stamped.eventsByTurn.turnA[1].seq).toBe(7);
    expect(stamped.eventsByTurn.turnB[0].seq).toBe(9);
    expect(stamped.maxSeq).toBe(9);
    expect(getSessionSeqIndex().getCurrentSeq('session-5')).toBe(9);
  });

  it('derives max seq from existing events when session.maxSeq is absent', () => {
    const session = baseSession({
      id: 'session-6',
      eventsByTurn: {
        turnA: [statusEvent('a', 10, 2), statusEvent('b', 11, 5)],
      },
    });

    expect(getMaxSeqFromSession(session)).toBe(5);

    const stamped = stampMissingEventSeq(session);
    expect(stamped.maxSeq).toBe(5);
    expect(getSessionSeqIndex().getCurrentSeq('session-6')).toBe(5);
  });
});
