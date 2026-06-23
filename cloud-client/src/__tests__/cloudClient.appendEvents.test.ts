import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEventForPush } from '../cloudClient';
import {
  CloudClientError,
  SessionInvalidEnvelopeError,
  SessionInvalidSeqError,
  SessionNeedsBootstrapError,
  SessionNeedsReconcileError,
  appendSessionEvents,
  clearConfig,
  configure,
} from '../cloudClient';

const TEST_URL = 'https://test.example.com';
const TEST_TOKEN = 'test-token';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

function event(overrides: Partial<AgentEventForPush> = {}): AgentEventForPush {
  return {
    type: 'status',
    message: 'working',
    timestamp: 1_700_000_000_000,
    turnId: 'turn-1',
    seq: null,
    clientOrdinal: 0,
    ...overrides,
  } as AgentEventForPush;
}

describe('appendSessionEvents', () => {
  beforeEach(() => {
    clearConfig();
    configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearConfig();
  });

  it('POSTs events and returns the applied result with appliedSeq', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      appliedCount: 2,
      appliedSeq: [11, 12],
      serverSeq: 12,
      cloudUpdatedAt: 1234,
    }));
    vi.stubGlobal('fetch', mockFetch);

    const result = await appendSessionEvents('session-1', {
      baseSeq: 10,
      events: [event({ clientOrdinal: 0 }), event({ clientOrdinal: 1 })],
    });

    expect(result).toEqual({
      kind: 'applied',
      appliedCount: 2,
      appliedSeq: [11, 12],
      serverSeq: 12,
      cloudUpdatedAt: 1234,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      `${TEST_URL}/api/sessions/session-1/events`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('maps 409 NEEDS_RECONCILE to SessionNeedsReconcileError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: 'NEEDS_RECONCILE',
      serverSeq: 22,
      cloudUpdatedAt: 333,
    }, { status: 409 })));

    await expect(appendSessionEvents('session-1', { baseSeq: 10, events: [] }))
      .rejects.toMatchObject({
        name: 'SessionNeedsReconcileError',
        details: { sessionId: 'session-1', serverSeq: 22, cloudUpdatedAt: 333 },
      } satisfies Partial<SessionNeedsReconcileError>);
  });

  it('maps 409 INVALID_SEQ to SessionInvalidSeqError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: 'INVALID_SEQ',
      offendingEventIds: ['turn-1:seq:12'],
      serverSeq: 22,
    }, { status: 409 })));

    await expect(appendSessionEvents('session-1', { baseSeq: 10, events: [] }))
      .rejects.toMatchObject({
        name: 'SessionInvalidSeqError',
        details: { sessionId: 'session-1', offendingEventIds: ['turn-1:seq:12'], serverSeq: 22 },
      } satisfies Partial<SessionInvalidSeqError>);
  });

  it('maps missing-client-ordinal INVALID_ENVELOPE to SessionInvalidEnvelopeError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: 'INVALID_ENVELOPE',
      reason: 'missing-client-ordinal',
      offendingEventCount: 1,
    }, { status: 400 })));

    await expect(appendSessionEvents('session-1', { baseSeq: 10, events: [] }))
      .rejects.toMatchObject({
        name: 'SessionInvalidEnvelopeError',
        details: { sessionId: 'session-1', reason: 'missing-client-ordinal', offendingEventCount: 1 },
      } satisfies Partial<SessionInvalidEnvelopeError>);
  });

  it('maps duplicate-client-ordinal INVALID_ENVELOPE to SessionInvalidEnvelopeError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: 'INVALID_ENVELOPE',
      reason: 'duplicate-client-ordinal',
      offendingPair: ['turn-1:type:status:ts:1:ord:0', 'turn-1:type:status:ts:1:ord:0'],
    }, { status: 400 })));

    await expect(appendSessionEvents('session-1', { baseSeq: 10, events: [] }))
      .rejects.toMatchObject({
        name: 'SessionInvalidEnvelopeError',
        details: {
          sessionId: 'session-1',
          reason: 'duplicate-client-ordinal',
          offendingPair: ['turn-1:type:status:ts:1:ord:0', 'turn-1:type:status:ts:1:ord:0'],
        },
      } satisfies Partial<SessionInvalidEnvelopeError>);
  });

  it('maps 404 NEEDS_BOOTSTRAP to SessionNeedsBootstrapError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'NEEDS_BOOTSTRAP' }, { status: 404 })));

    await expect(appendSessionEvents('session-1', { baseSeq: 10, events: [] }))
      .rejects.toBeInstanceOf(SessionNeedsBootstrapError);
  });

  it('maps generic 404 to capability-missing fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 })));

    await expect(appendSessionEvents('session-1', { baseSeq: 10, events: [] }))
      .rejects.toMatchObject({
        name: 'CloudClientError',
        code: 'CAPABILITY_MISSING_FALLBACK',
      } satisfies Partial<CloudClientError>);
  });

  it('maps 405 to capability-missing fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Method Not Allowed', { status: 405 })));

    await expect(appendSessionEvents('session-1', { baseSeq: 10, events: [] }))
      .rejects.toMatchObject({
        name: 'CloudClientError',
        code: 'CAPABILITY_MISSING_FALLBACK',
      } satisfies Partial<CloudClientError>);
  });

  it('returns tombstoned for 410 tombstone responses', async () => {
    const tombstone = {
      sessionId: 'session-1',
      deletedAt: 1,
      deletedBy: 'mobile',
      ttlExpiresAt: 2,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: 'session-tombstoned',
      tombstone,
    }, { status: 410 })));

    await expect(appendSessionEvents('session-1', { baseSeq: 10, events: [] }))
      .resolves.toEqual({ kind: 'tombstoned', tombstone });
  });

  it('surfaces 503 deadlock responses as caller errors', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({
      error: { code: 'SESSION_MUTEX_DEADLOCK', message: 'deadlock' },
    }, { status: 503 }))));

    const promise = appendSessionEvents('session-1', { baseSeq: 10, events: [] });
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'CloudClientError',
      statusCode: 503,
      code: 'SESSION_MUTEX_DEADLOCK',
    } satisfies Partial<CloudClientError>);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('passes idempotencyKey through verbatim', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      appliedCount: 0,
      appliedSeq: [],
      serverSeq: 10,
      cloudUpdatedAt: 123,
    }));
    vi.stubGlobal('fetch', mockFetch);

    await appendSessionEvents('session-1', { baseSeq: 10, events: [], idempotencyKey: 'session-1:5:fingerprint' });

    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({
      idempotencyKey: 'session-1:5:fingerprint',
    });
  });

  it('passes messageDelta through verbatim', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ success: true, appliedCount: 0, appliedSeq: [], serverSeq: 10, cloudUpdatedAt: 123 }));
    vi.stubGlobal('fetch', mockFetch);
    const messageDelta = [{ id: 'm1', turnId: 't1', role: 'user' as const, text: 'hello', createdAt: 1 }];

    await appendSessionEvents('session-1', { baseSeq: 10, events: [], messageDelta });

    expect(JSON.parse(mockFetch.mock.calls[0][1].body).messageDelta).toEqual(messageDelta);
  });

  it('passes messageDeletes through verbatim', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ success: true, appliedCount: 0, appliedSeq: [], serverSeq: 10, cloudUpdatedAt: 123 }));
    vi.stubGlobal('fetch', mockFetch);

    await appendSessionEvents('session-1', { baseSeq: 10, events: [], messageDeletes: ['m1', 'm2'] });

    expect(JSON.parse(mockFetch.mock.calls[0][1].body).messageDeletes).toEqual(['m1', 'm2']);
  });

  it('passes _destructiveOps through verbatim', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ success: true, appliedCount: 0, appliedSeq: [], serverSeq: 10, cloudUpdatedAt: 123 }));
    vi.stubGlobal('fetch', mockFetch);
    const _destructiveOps = { truncateTurns: ['t1'], deleteEventIdentities: ['t2:seq:3'] };

    await appendSessionEvents('session-1', { baseSeq: 10, events: [], _destructiveOps });

    expect(JSON.parse(mockFetch.mock.calls[0][1].body)._destructiveOps).toEqual(_destructiveOps);
  });
});
