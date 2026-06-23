import { describe, expect, it } from 'vitest';
import { MeetingSessionIdempotencyCache } from '../services/meetingSessionIdempotencyCache';

describe('MeetingSessionIdempotencyCache', () => {
  it('returns miss when no record exists', () => {
    const cache = new MeetingSessionIdempotencyCache();
    expect(cache.evaluateReplay({
      bearerTokenHash: 'token-hash',
      idempotencyKey: 'idem-1',
      companionSessionId: 'companion-1',
    })).toEqual({ kind: 'miss' });
  });

  it('returns hit for same companion id', () => {
    const cache = new MeetingSessionIdempotencyCache();
    cache.upsert({
      bearerTokenHash: 'token-hash',
      idempotencyKey: 'idem-1',
      cloudSessionId: 'cloud-session-1',
      companionSessionId: 'companion-1',
    });

    const resolution = cache.evaluateReplay({
      bearerTokenHash: 'token-hash',
      idempotencyKey: 'idem-1',
      companionSessionId: 'companion-1',
    });
    expect(resolution.kind).toBe('hit');
    if (resolution.kind !== 'hit') return;
    expect(resolution.reason).toBe('same-companion');
    expect(resolution.record.cloudSessionId).toBe('cloud-session-1');
  });

  it('returns conflict for companion id mismatch', () => {
    const cache = new MeetingSessionIdempotencyCache();
    cache.upsert({
      bearerTokenHash: 'token-hash',
      idempotencyKey: 'idem-1',
      cloudSessionId: 'cloud-session-1',
      companionSessionId: 'companion-a',
    });

    const resolution = cache.evaluateReplay({
      bearerTokenHash: 'token-hash',
      idempotencyKey: 'idem-1',
      companionSessionId: 'companion-b',
    });
    expect(resolution.kind).toBe('conflict');
  });

  it('supports null companion-id backfill', () => {
    const cache = new MeetingSessionIdempotencyCache();
    cache.upsert({
      bearerTokenHash: 'token-hash',
      idempotencyKey: 'idem-1',
      cloudSessionId: 'cloud-session-1',
      companionSessionId: null,
    });

    const resolution = cache.evaluateReplay({
      bearerTokenHash: 'token-hash',
      idempotencyKey: 'idem-1',
      companionSessionId: 'companion-1',
    });
    expect(resolution.kind).toBe('backfill');
    const backfilled = cache.backfillCompanionSessionId({
      bearerTokenHash: 'token-hash',
      idempotencyKey: 'idem-1',
      companionSessionId: 'companion-1',
    });
    expect(backfilled?.companionSessionId).toBe('companion-1');

    const after = cache.evaluateReplay({
      bearerTokenHash: 'token-hash',
      idempotencyKey: 'idem-1',
      companionSessionId: 'companion-1',
    });
    expect(after.kind).toBe('hit');
  });

  it('evicts least-recently-used records when maxEntries is exceeded', () => {
    const cache = new MeetingSessionIdempotencyCache({ maxEntries: 2 });
    cache.upsert({
      bearerTokenHash: 'token',
      idempotencyKey: 'idem-1',
      cloudSessionId: 'cloud-1',
      companionSessionId: 'companion-1',
    });
    cache.upsert({
      bearerTokenHash: 'token',
      idempotencyKey: 'idem-2',
      cloudSessionId: 'cloud-2',
      companionSessionId: 'companion-2',
    });
    cache.upsert({
      bearerTokenHash: 'token',
      idempotencyKey: 'idem-3',
      cloudSessionId: 'cloud-3',
      companionSessionId: 'companion-3',
    });

    expect(cache.sizeForTesting()).toBe(2);
    expect(cache.evaluateReplay({
      bearerTokenHash: 'token',
      idempotencyKey: 'idem-1',
      companionSessionId: 'companion-1',
    })).toEqual({ kind: 'miss' });
  });

  it('expires records after the configured ttl', () => {
    let nowMs = 1_000;
    const cache = new MeetingSessionIdempotencyCache({
      ttlMs: 50,
      now: () => nowMs,
    });
    cache.upsert({
      bearerTokenHash: 'token',
      idempotencyKey: 'idem-1',
      cloudSessionId: 'cloud-1',
      companionSessionId: 'companion-1',
    });

    nowMs += 49;
    expect(cache.evaluateReplay({
      bearerTokenHash: 'token',
      idempotencyKey: 'idem-1',
      companionSessionId: 'companion-1',
    }).kind).toBe('hit');

    nowMs += 2;
    expect(cache.evaluateReplay({
      bearerTokenHash: 'token',
      idempotencyKey: 'idem-1',
      companionSessionId: 'companion-1',
    })).toEqual({ kind: 'miss' });
  });

  it('serializes concurrent operations for the same composite key', async () => {
    const cache = new MeetingSessionIdempotencyCache();
    let operationCount = 0;

    const first = cache.withAtomicKey(
      { bearerTokenHash: 'token-hash', idempotencyKey: 'idem-1' },
      async () => {
        operationCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'session-a';
      },
    );
    const second = cache.withAtomicKey(
      { bearerTokenHash: 'token-hash', idempotencyKey: 'idem-1' },
      async () => {
        operationCount += 1;
        return 'session-b';
      },
    );

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe('session-a');
    expect(b).toBe('session-a');
    expect(operationCount).toBe(1);
  });
});
