import { describe, expect, it } from 'vitest';
import { TurnIdempotencyIndex } from '../turnIdempotencyIndex';

function withIndex(
  run: (ctx: { index: TurnIdempotencyIndex; setNow: (value: number) => void }) => void,
): void {
  let now = 0;
  const index = new TurnIdempotencyIndex({
    ttlMs: 1_000,
    cleanupIntervalMs: 60_000,
    now: () => now,
  });
  const setNow = (value: number) => {
    now = value;
  };
  try {
    run({ index, setNow });
  } finally {
    index.dispose();
  }
}

describe('TurnIdempotencyIndex', () => {
  it('evicts entries after TTL expiry', () => {
    withIndex(({ index, setNow }) => {
      index.markInFlight('client-1', { sessionId: 'session-1' });
      expect(index.get('client-1')?.status).toBe('in_flight');

      setNow(999);
      expect(index.get('client-1')?.status).toBe('in_flight');

      setNow(1_001);
      expect(index.get('client-1')).toBeUndefined();
      expect(index.size()).toBe(0);
    });
  });

  it('supports in-flight to persisted transition with outcome', () => {
    withIndex(({ index }) => {
      index.markInFlight('client-2', { sessionId: 'session-2' });
      index.setTurnInfo('client-2', { turnId: 'turn-2', sessionId: 'session-2' });
      const persisted = index.markPersisted('client-2', {
        turnId: 'turn-2',
        sessionId: 'session-2',
        outcome: 'result',
      });

      expect(persisted).toMatchObject({
        clientTurnId: 'client-2',
        turnId: 'turn-2',
        sessionId: 'session-2',
        status: 'persisted',
        outcome: 'result',
      });
      expect(typeof persisted.persistedAt).toBe('number');
      expect(index.get('client-2')).toMatchObject({
        status: 'persisted',
        outcome: 'result',
      });
    });
  });

  it('tracks errored transitions and allows retrying back to in_flight', () => {
    withIndex(({ index }) => {
      index.markInFlight('client-3', { turnId: 'turn-3', sessionId: 'session-3' });
      const errored = index.markErrored('client-3', { outcome: 'error' });
      expect(errored).toMatchObject({
        status: 'errored',
        turnId: 'turn-3',
        sessionId: 'session-3',
        outcome: 'error',
      });

      const retried = index.markInFlight('client-3');
      expect(retried).toMatchObject({
        status: 'in_flight',
        turnId: 'turn-3',
        sessionId: 'session-3',
      });
      expect(retried.outcome).toBeUndefined();
    });
  });

  it('returns stable repeat lookups without exposing mutable internals', () => {
    withIndex(({ index }) => {
      index.markPersisted('client-4', {
        turnId: 'turn-4',
        sessionId: 'session-4',
        outcome: 'error',
      });

      const first = index.get('client-4');
      expect(first?.status).toBe('persisted');
      if (!first) throw new Error('Expected entry');

      first.status = 'errored';
      first.turnId = 'mutated';

      const second = index.get('client-4');
      expect(second).toMatchObject({
        status: 'persisted',
        turnId: 'turn-4',
        sessionId: 'session-4',
        outcome: 'error',
      });
    });
  });

  it('guards lookups by session ownership', () => {
    withIndex(({ index }) => {
      index.markInFlight('client-5', { sessionId: 'session-5' });

      const sameSession = index.getForSession('client-5', 'session-5');
      expect(sameSession).toMatchObject({
        ownership: 'owned',
        entry: expect.objectContaining({
          clientTurnId: 'client-5',
          sessionId: 'session-5',
        }),
      });

      const crossSession = index.getForSession('client-5', 'session-other');
      expect(crossSession).toMatchObject({
        ownership: 'collision',
        entry: expect.objectContaining({
          clientTurnId: 'client-5',
          sessionId: 'session-5',
        }),
      });

      expect(index.getForSession('missing-client', 'session-5')).toEqual({
        ownership: 'available',
      });
    });
  });
});
