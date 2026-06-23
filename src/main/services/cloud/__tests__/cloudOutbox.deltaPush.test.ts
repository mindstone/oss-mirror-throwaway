import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setErrorReporter } from '@core/errorReporter';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';
import type { AgentSession } from '@shared/types';

 
vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-outbox-delta',
}));

const mockGetSession = vi.fn();
const mockUpsertSession = vi.fn();
const mockUpsertSessionWithOutcome = vi.fn();
let mockUseUpsertSessionWithOutcome = false;
 
vi.mock('../../incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => {
    const store = {
      getSession: mockGetSession,
      upsertSession: mockUpsertSession,
    } as {
      getSession: typeof mockGetSession;
      upsertSession: typeof mockUpsertSession;
      upsertSessionWithOutcome?: typeof mockUpsertSessionWithOutcome;
    };
    if (mockUseUpsertSessionWithOutcome) {
      store.upsertSessionWithOutcome = mockUpsertSessionWithOutcome;
    }
    return store;
  },
}));

import { CloudOutbox } from '../cloudOutbox';

const OUTBOX_DIR = path.join('/tmp/test-cloud-outbox-delta', 'sessions');

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-1',
    title: 'Test',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    eventsByTurn: {},
    maxSeq: 0,
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  };
}

function statusEvent(seq: number, message = `event-${seq}`, timestamp = seq) {
  return { type: 'status' as const, message, timestamp, seq };
}

function deltaClient(overrides: Record<string, unknown> = {}) {
  return {
    getServerCapabilities: vi.fn().mockResolvedValue({ supportsDeltaPush: true, supportsMetadataPatch: true, raw: ['session-event-delta-push', 'session-metadata-patch'] }),
    get: vi.fn().mockResolvedValue({ id: 'session-1', maxSeq: 0, messages: [], cloudUpdatedAt: 10 }),
    post: vi.fn().mockResolvedValue({ appliedSeq: [101], serverSeq: 101, cloudUpdatedAt: 20 }),
    put: vi.fn().mockResolvedValue({ serverSeq: 0, cloudUpdatedAt: 11 }),
    patch: vi.fn().mockResolvedValue({ cloudUpdatedAt: 21 }),
    delete: vi.fn().mockResolvedValue(undefined),
    invalidateCapabilities: vi.fn(),
    ...overrides,
  };
}

describe('CloudOutbox delta push', () => {
  let outbox: CloudOutbox;
  const breadcrumbs: Array<{ category?: string; message?: string; data?: Record<string, unknown> }> = [];
  const messages: string[] = [];

  beforeEach(() => {
    outbox = new CloudOutbox();
    mockGetSession.mockReset();
    mockUpsertSession.mockReset();
    mockUpsertSessionWithOutcome.mockReset();
    mockUpsertSessionWithOutcome.mockImplementation(async () => 'persisted' as const);
    mockUseUpsertSessionWithOutcome = false;
    breadcrumbs.length = 0;
    messages.length = 0;
    setErrorReporter({
      captureException: () => {},
      captureMessage: (message) => { messages.push(message); },
      addBreadcrumb: (breadcrumb) => { breadcrumbs.push({ category: breadcrumb.category, message: breadcrumb.message, data: breadcrumb.data }); },
    });
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    outbox._resetForTesting();
    resetSessionMutexForTests();
    setErrorReporter({ captureException: () => {}, captureMessage: () => {}, addBreadcrumb: () => {} });
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
  });

  it('falls back to full PUT when delta capability is missing', async () => {
    const local = session({ eventsByTurn: { t1: [statusEvent(1)] }, maxSeq: 1 });
    mockGetSession.mockResolvedValue(local);
    outbox.enqueue(local.id, 'upsert');
    const client = deltaClient({
      getServerCapabilities: vi.fn().mockResolvedValue({ supportsDeltaPush: false, supportsMetadataPatch: false, raw: [] }),
      put: vi.fn().mockResolvedValue({ serverSeq: 1, cloudUpdatedAt: 11 }),
    });

    await outbox.drain(client);

    expect(client.put).toHaveBeenCalledWith('/api/sessions/session-1', expect.objectContaining({ id: 'session-1' }));
    expect(client.post).not.toHaveBeenCalled();
    expect(outbox.getLastPushedSeq(local.id)).toBe(1);
    expect(breadcrumbs).toContainEqual(expect.objectContaining({
      category: 'continuity.session-delta-push',
      message: 'capability-missing-fallback',
      data: expect.objectContaining({ baseSeq: 0 }),
    }));
  });

  it('seeds a missing cursor with a lean pull and excludes already-pushed messages', async () => {
    const local = session({
      messages: [
        { id: 'm1', turnId: 't1', role: 'user', text: 'old', createdAt: 1 },
        { id: 'm2', turnId: 't1', role: 'assistant', text: 'new', createdAt: 2 },
      ],
      eventsByTurn: { t1: [statusEvent(43)] },
      maxSeq: 43,
    });
    mockGetSession.mockResolvedValue(local);
    outbox.enqueue(local.id, 'upsert');
    const client = deltaClient({
      get: vi.fn().mockResolvedValue({ id: local.id, maxSeq: 42, messages: [local.messages[0]], cloudUpdatedAt: 10 }),
      post: vi.fn().mockResolvedValue({ appliedSeq: [43], serverSeq: 43, cloudUpdatedAt: 20 }),
    });

    await outbox.drain(client);

    expect(client.get).toHaveBeenCalledWith('/api/sessions/session-1?lean=true');
    const body = client.post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.baseSeq).toBe(42);
    expect((body.messageDelta as Array<{ id: string }>).map((message) => message.id)).toEqual(['m2']);
    expect(outbox.getLastPushedMessageIds(local.id)).toEqual(['m1', 'm2']);
  });

  it('sends delta events with seq null and per-turn clientOrdinal', async () => {
    const local = session({
      eventsByTurn: {
        t1: [statusEvent(1, 'a', 100), statusEvent(2, 'b', 100)],
        t2: [statusEvent(3, 'c', 100)],
      },
      maxSeq: 3,
    });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.recordLastPushedMetadataDigest(local.id, 'stale');
    outbox.enqueue(local.id, 'upsert');
    const client = deltaClient({ post: vi.fn().mockResolvedValue({ appliedSeq: [11, 12, 13], serverSeq: 13, cloudUpdatedAt: 30 }) });

    await outbox.drain(client);

    const events = (client.post.mock.calls[0][1] as { events: Array<{ seq: null; clientOrdinal: number; turnId: string }> }).events;
    expect(events.map((event) => [event.turnId, event.seq, event.clientOrdinal])).toEqual([
      ['t1', null, 0],
      ['t1', null, 1],
      ['t2', null, 0],
    ]);
    expect(mockUpsertSession).toHaveBeenCalledWith(expect.objectContaining({ maxSeq: 13 }));
    expect(outbox.getLastPushedSeq(local.id)).toBe(13);
    expect(breadcrumbs).toContainEqual(expect.objectContaining({
      category: 'continuity.session-delta-push',
      message: 'applied',
      data: expect.objectContaining({
        appliedCount: 3,
        serverSeq: 13,
        cloudUpdatedAt: 30,
        baseSeq: 0,
        payloadBytes: expect.any(Number),
      }),
    }));
  });

  it('PATCHes metadata-only changes without advancing the seq cursor', async () => {
    const local = session({ title: 'Renamed', maxSeq: 5 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 5);
    outbox.enqueue(local.id, 'upsert');
    const client = deltaClient();

    await outbox.drain(client);

    expect(client.patch).toHaveBeenCalledWith('/api/sessions/session-1', expect.objectContaining({
      baseSeq: 5,
      patch: expect.objectContaining({ title: 'Renamed' }),
    }));
    expect(client.post).not.toHaveBeenCalled();
    expect(outbox.getLastPushedSeq(local.id)).toBe(5);
    expect(breadcrumbs).toContainEqual(expect.objectContaining({
      category: 'continuity.session-delta-push',
      message: 'metadata-patch-applied',
      data: expect.objectContaining({ baseSeq: 5, cloudUpdatedAt: 21 }),
    }));
  });

  it('skips a no-op when metadata digest and content cursor are current', async () => {
    const local = session({ maxSeq: 5 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 5);
    outbox.recordLastPushedMetadataDigest(local.id, 'placeholder');
    outbox.recordLastPushedMetadataDigest(local.id, outbox.getLastPushedMetadataDigest(local.id) ?? 'placeholder');
    // Compute the digest by allowing one metadata drain, then re-enqueue with same state.
    outbox.enqueue(local.id, 'upsert');
    const client = deltaClient();
    await outbox.drain(client);
    mockGetSession.mockResolvedValue(local);
    outbox.enqueue(local.id, 'upsert');
    client.patch.mockClear();

    await outbox.drain(client);

    expect(client.patch).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });

  it('computes messageDeletes from the pushed-message snapshot', async () => {
    const local = session({
      messages: [{ id: 'm2', turnId: 't1', role: 'assistant', text: 'kept', createdAt: 2 }],
      maxSeq: 5,
    });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 5);
    outbox.recordLastPushedMessageIds(local.id, ['m1', 'm2']);
    outbox.enqueue(local.id, 'upsert');
    const client = deltaClient({ post: vi.fn().mockResolvedValue({ appliedSeq: [], serverSeq: 5, cloudUpdatedAt: 30 }) });

    await outbox.drain(client);

    expect((client.post.mock.calls[0][1] as { messageDeletes: string[] }).messageDeletes).toEqual(['m1']);
    expect(outbox.getLastPushedMessageIds(local.id)).toEqual(['m2']);
  });

  it('detects and recovers from a lying cursor before delta push', async () => {
    const local = session({ eventsByTurn: { t1: [statusEvent(50)] }, maxSeq: 50 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 100);
    outbox.enqueue(local.id, 'upsert');
    const client = deltaClient({
      get: vi.fn().mockResolvedValue({ id: local.id, maxSeq: 40, messages: [], cloudUpdatedAt: 10 }),
      post: vi.fn().mockResolvedValue({ appliedSeq: [50], serverSeq: 50, cloudUpdatedAt: 20 }),
    });

    await outbox.drain(client);

    expect(breadcrumbs.some((breadcrumb) => breadcrumb.message === 'session-delta-push:lying-cursor-detected')).toBe(true);
    expect(client.get).toHaveBeenCalledWith('/api/sessions/session-1?lean=true');
    expect(outbox.getLastPushedSeq(local.id)).toBe(50);
  });

  it('falls back to full PUT and invalidates capabilities when delta route is missing', async () => {
    const local = session({ eventsByTurn: { t1: [statusEvent(1)] }, maxSeq: 1 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');
    const missingRoute = Object.assign(new Error('missing'), { code: 'CAPABILITY_MISSING_FALLBACK', statusCode: 404 });
    const client = deltaClient({ post: vi.fn().mockRejectedValue(missingRoute) });

    await outbox.drain(client);

    expect(client.invalidateCapabilities).toHaveBeenCalled();
    expect(client.put).toHaveBeenCalledWith('/api/sessions/session-1', expect.any(Object));
    expect(breadcrumbs).toContainEqual(expect.objectContaining({
      category: 'continuity.session-delta-push',
      message: 'capability-missing-fallback',
      data: expect.objectContaining({ baseSeq: 0 }),
    }));
  });

  it('parks invalid-envelope batches as permanent failures', async () => {
    const local = session({ eventsByTurn: { t1: [statusEvent(1)] }, maxSeq: 1 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');
    const invalid = Object.assign(new Error('INVALID_ENVELOPE'), { code: 'INVALID_ENVELOPE', statusCode: 400 });
    const client = deltaClient({ post: vi.fn().mockRejectedValue(invalid) });

    await outbox.drain(client);

    expect(outbox.getAll()[0]).toMatchObject({ status: 'permanent_failure' });
    expect(messages).toContain('session-delta-push:invalid-envelope');
  });

  it('parks invalid-seq batches as permanent failures', async () => {
    const local = session({ eventsByTurn: { t1: [statusEvent(1)] }, maxSeq: 1 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');
    const invalid = Object.assign(new Error('INVALID_SEQ'), { code: 'INVALID_SEQ', statusCode: 409 });
    const client = deltaClient({ post: vi.fn().mockRejectedValue(invalid) });

    await outbox.drain(client);

    expect(outbox.getAll()[0]).toMatchObject({ status: 'permanent_failure' });
    expect(messages).toContain('session-delta-push:invalid-seq');
  });

  it('runs bootstrap create-then-append when POST reports NEEDS_BOOTSTRAP', async () => {
    const local = session({ eventsByTurn: { t1: [statusEvent(1)] }, maxSeq: 1 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');
    const needsBootstrap = Object.assign(new Error('NEEDS_BOOTSTRAP'), { code: 'NEEDS_BOOTSTRAP', statusCode: 404 });
    const client = deltaClient({
      post: vi.fn()
        .mockRejectedValueOnce(needsBootstrap)
        .mockResolvedValueOnce({ appliedSeq: [1], serverSeq: 1, cloudUpdatedAt: 30 }),
    });

    await outbox.drain(client);

    expect(client.put).toHaveBeenCalledWith('/api/sessions/session-1', expect.objectContaining({
      messages: [],
      eventsByTurn: {},
      maxSeq: 0,
    }));
    expect(client.post).toHaveBeenCalledTimes(2);
    expect(outbox.getLastPushedSeq(local.id)).toBe(1);
    expect(breadcrumbs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'continuity.session-delta-push',
        message: 'needs-bootstrap',
        data: expect.objectContaining({ baseSeq: 0 }),
      }),
      expect.objectContaining({
        category: 'continuity.session-delta-push',
        message: 'bootstrap-fallback',
        data: expect.objectContaining({ baseSeq: 0 }),
      }),
    ]));
  });

  it('emits a session-delta-push needs-reconcile breadcrumb before recovery catch-up', async () => {
    const local = session({ eventsByTurn: { t1: [statusEvent(1), statusEvent(2)] }, maxSeq: 2 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');
    const needsReconcile = Object.assign(new Error('NEEDS_RECONCILE'), { code: 'NEEDS_RECONCILE', statusCode: 409 });
    const client = deltaClient({
      get: vi.fn().mockResolvedValue({ events: [], serverSeq: 1, hasMore: false }),
      post: vi.fn()
        .mockRejectedValueOnce(needsReconcile)
        .mockResolvedValueOnce({ appliedSeq: [2], serverSeq: 2, cloudUpdatedAt: 30 }),
    });

    await outbox.drain(client);

    expect(breadcrumbs).toContainEqual(expect.objectContaining({
      category: 'continuity.session-delta-push',
      message: 'needs-reconcile',
      data: expect.objectContaining({ baseSeq: 0 }),
    }));
    expect(client.get).toHaveBeenCalledWith('/api/sessions/session-1/events?sinceSeq=0&limit=500');
  });

  it('keeps the entry pending when append succeeds after tombstoned local restamp refusal', async () => {
    const local = session({ eventsByTurn: { t1: [statusEvent(1), statusEvent(2)] }, maxSeq: 2 });
    mockUseUpsertSessionWithOutcome = true;
    mockGetSession.mockResolvedValue(local);
    mockUpsertSessionWithOutcome
      .mockResolvedValueOnce('persisted' as const)
      .mockResolvedValueOnce('dropped-tombstoned' as const)
      .mockResolvedValueOnce('dropped-tombstoned' as const);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');
    const needsReconcile = Object.assign(new Error('NEEDS_RECONCILE'), { code: 'NEEDS_RECONCILE', statusCode: 409 });
    const client = deltaClient({
      get: vi.fn().mockResolvedValue({ events: [], serverSeq: 1, hasMore: false }),
      post: vi.fn()
        .mockRejectedValueOnce(needsReconcile)
        .mockResolvedValueOnce({ appliedSeq: [2], serverSeq: 2, cloudUpdatedAt: 30 }),
    });

    const result = await outbox.drain(client);

    expect(result.failed).toBe(0);
    expect(client.post).toHaveBeenCalledTimes(2);
    expect(mockUpsertSessionWithOutcome).toHaveBeenCalledTimes(3);
    expect(outbox.getLastPushedSeq(local.id)).toBe(1);
    expect(outbox.getLastPushedSeq(local.id)).not.toBe(2);
    expect((outbox as unknown as { cloudUpdatedAtTracker: Map<string, number> }).cloudUpdatedAtTracker.get(local.id)).toBeUndefined();
    expect(outbox.getStatus()).toEqual({ pending: 1, failed: 0 });
    expect(outbox.getAll()[0]).toMatchObject({ sessionId: local.id, op: 'upsert', status: 'pending' });
  });

  it('marks tombstoned append outcomes succeeded and evicts trackers', async () => {
    const local = session({ eventsByTurn: { t1: [statusEvent(1)] }, maxSeq: 1 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.recordLastPushedMessageIds(local.id, ['m1']);
    outbox.enqueue(local.id, 'upsert');
    const client = deltaClient({
      appendSessionEvents: vi.fn().mockResolvedValue({ kind: 'tombstoned', tombstone: { sessionId: local.id } }),
    });

    await outbox.drain(client);

    expect(outbox.getAll()).toHaveLength(0);
    expect(outbox.getLastPushedSeq(local.id)).toBeUndefined();
    expect(outbox.getLastPushedMessageIds(local.id)).toEqual([]);
  });

  it('uses patchSession SDK method when available for metadata-only pushes', async () => {
    const local = session({ title: 'SDK patch', maxSeq: 5, cloudUpdatedAt: 9 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 5);
    outbox.enqueue(local.id, 'upsert');
    const client = {
      ...deltaClient(),
      patchSession: vi.fn().mockResolvedValue({ cloudUpdatedAt: 55 }),
    };

    await outbox.drain(client);

    expect(client.patchSession).toHaveBeenCalledWith(local.id, expect.objectContaining({
      baseSeq: 5,
      clientCloudUpdatedAt: 9,
      patch: expect.objectContaining({ title: 'SDK patch' }),
    }));
    expect(outbox.getLastPushedSeq(local.id)).toBe(5);
  });

  it('cleans oversized skipset entries for destructive truncates', () => {
    outbox.recordOversizedEvent('session-1', 't1:type:tool_call:ts:1:ord:0', 'hash-a', 5_100_000);
    outbox.recordOversizedEvent('session-1', 't2:type:tool_call:ts:2:ord:0', 'hash-b', 5_200_000);

    const removed = outbox.clearOversizedEventsByDestructiveOps('session-1', { truncateTurns: ['t1'] });

    expect(removed).toBe(1);
    expect(outbox.getOversizedEvents('session-1')).toEqual([
      { eventIdentity: 't2:type:tool_call:ts:2:ord:0', contentHash: 'hash-b', gzipBytes: 5_200_000 },
    ]);
  });

  it('cleans oversized skipset entries for destructive event deletes', () => {
    outbox.recordOversizedEvent('session-1', 't3:seq:42', 'hash-a', 5_100_000);
    outbox.recordOversizedEvent('session-1', 't4:seq:43', 'hash-b', 5_200_000);

    const removed = outbox.clearOversizedEventsByDestructiveOps('session-1', { deleteEventIdentities: ['t3:seq:42'] });

    expect(removed).toBe(1);
    expect(outbox.getOversizedEvents('session-1')).toEqual([
      { eventIdentity: 't4:seq:43', contentHash: 'hash-b', gzipBytes: 5_200_000 },
    ]);
  });

  it('falls back to /api/health capability probing when no SDK capability method exists', async () => {
    const local = session({ eventsByTurn: { t1: [statusEvent(1)] }, maxSeq: 1 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');
    const client = deltaClient();
    delete (client as { getServerCapabilities?: unknown }).getServerCapabilities;
    client.get.mockResolvedValue({ capabilities: ['session-event-delta-push', 'session-metadata-patch'] });

    await outbox.drain(client);

    expect(client.get).toHaveBeenCalledWith('/api/health');
    expect(client.post).toHaveBeenCalled();
  });

  it('keeps a transient delta failure pending for retry', async () => {
    const local = session({ eventsByTurn: { t1: [statusEvent(1)] }, maxSeq: 1 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');
    const client = deltaClient({ post: vi.fn().mockRejectedValue(new Error('network')) });

    const result = await outbox.drain(client);

    expect(result.failed).toBe(1);
    expect(outbox.getAll()[0]).toMatchObject({ status: 'pending', attempts: 1 });
  });

  // REBEL-68C regression: the server hashes the full append body (incl. baseSeq +
  // metadataPatch) for idempotency dedup, but the outbox recomputes the payload live
  // on every drain. A transient failure does NOT bump the entry generation, so a
  // retry whose session metadata drifted in between (e.g. auto-title) must NOT reuse
  // the same idempotency key with a different body — that triggered a 500
  // IDEMPOTENCY_PAYLOAD_MISMATCH server-side. The key must vary when metadataPatch does.
  it('REBEL-68C: a metadata-drifted retry of the same entry yields a fresh idempotency key', async () => {
    vi.useFakeTimers();
    const t0 = 1_710_200_000_000;
    vi.setSystemTime(t0);
    try {
      const sharedEvents = { t1: [statusEvent(1)] };
      mockGetSession.mockResolvedValue(session({ title: 'Title A', eventsByTurn: sharedEvents, maxSeq: 1 }));
      outbox.recordLastPushedSeq('session-1', 0);
      outbox.enqueue('session-1', 'upsert');
      const generationBefore = outbox.getEntryGeneration(outbox.getAll()[0].id);

      const capturedKeys: string[] = [];
      let shouldFail = true;
      const post = vi.fn().mockImplementation(async (_p: string, body: unknown) => {
        const b = body as { idempotencyKey?: string };
        if (typeof b.idempotencyKey === 'string') capturedKeys.push(b.idempotencyKey);
        if (shouldFail) {
          shouldFail = false;
          throw new Error('network'); // transient → entry stays pending, generation unchanged
        }
        return { appliedSeq: [101], serverSeq: 101, cloudUpdatedAt: 20 };
      });
      const client = deltaClient({ post });

      // First attempt fails transiently; entry stays pending with the same generation.
      await outbox.drain(client);
      expect(outbox.getAll()[0]).toMatchObject({ status: 'pending' });
      expect(outbox.getEntryGeneration(outbox.getAll()[0].id)).toBe(generationBefore);

      // Session title (a metadata-patch field) changes before the retry.
      mockGetSession.mockResolvedValue(session({ title: 'Title B', eventsByTurn: sharedEvents, maxSeq: 1 }));
      // Advance past the exponential backoff so the entry is due for retry.
      vi.setSystemTime(t0 + 60 * 60_000);
      await outbox.drain(client);

      // Same session + same events + same generation, but drifted metadataPatch →
      // the two requests must carry DIFFERENT idempotency keys (the fix). Before the
      // fix these collided, reproducing the server-side 500.
      expect(capturedKeys).toHaveLength(2);
      expect(capturedKeys[0]).not.toBe(capturedKeys[1]);
    } finally {
      vi.useRealTimers();
    }
  });

  // REBEL-68C (event-body drift): a tool event's body can mutate in place AFTER it is
  // first queued — e.g. the content/asset upload outbox flips a contentRef.uploadStatus
  // from pending → uploaded. The event identity (turnId/type/ts/ordinal) is unchanged,
  // but the full body the server hashes is not. A fingerprint over event *identity* only
  // would collide; the fix hashes full event bodies.
  it('REBEL-68C: a retry after a tool event body mutates (uploadStatus) yields a fresh idempotency key', async () => {
    vi.useFakeTimers();
    const t0 = 1_710_300_000_000;
    vi.setSystemTime(t0);
    try {
      const toolEvent = (uploadStatus: 'pending' | 'uploaded') => ({
        type: 'tool', timestamp: 1, seq: 1, contentRef: [{ contentId: 'c1', uploadStatus }],
      }) as unknown as AgentSession['eventsByTurn'][string][number];

      mockGetSession.mockResolvedValue(session({ eventsByTurn: { t1: [toolEvent('pending')] }, maxSeq: 1 }));
      outbox.recordLastPushedSeq('session-1', 0);
      outbox.enqueue('session-1', 'upsert');

      const capturedKeys: string[] = [];
      let shouldFail = true;
      const post = vi.fn().mockImplementation(async (_p: string, body: unknown) => {
        const b = body as { idempotencyKey?: string };
        if (typeof b.idempotencyKey === 'string') capturedKeys.push(b.idempotencyKey);
        if (shouldFail) {
          shouldFail = false;
          throw new Error('network');
        }
        return { appliedSeq: [101], serverSeq: 101, cloudUpdatedAt: 20 };
      });
      const client = deltaClient({ post });

      await outbox.drain(client);
      expect(outbox.getAll()[0]).toMatchObject({ status: 'pending' });

      // Upload outbox flips uploadStatus in place; same event identity, different body.
      mockGetSession.mockResolvedValue(session({ eventsByTurn: { t1: [toolEvent('uploaded')] }, maxSeq: 1 }));
      vi.setSystemTime(t0 + 60 * 60_000);
      await outbox.drain(client);

      expect(capturedKeys).toHaveLength(2);
      expect(capturedKeys[0]).not.toBe(capturedKeys[1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('delete operations evict delta trackers', async () => {
    outbox.recordLastPushedSeq('session-delete', 12);
    outbox.recordLastPushedMessageIds('session-delete', ['m1']);
    outbox.enqueue('session-delete', 'delete');
    const client = deltaClient();

    await outbox.drain(client);

    expect(client.delete).toHaveBeenCalledWith('/api/sessions/session-delete');
    expect(outbox.getLastPushedSeq('session-delete')).toBeUndefined();
    expect(outbox.getLastPushedMessageIds('session-delete')).toEqual([]);
  });

  it('clears oversized records when event content changes or disappears', () => {
    outbox.recordOversizedEvent('session-1', 't1:seq:1', 'hash-old', 5_100_000);
    outbox.recordOversizedEvent('session-1', 't1:seq:2', 'hash-gone', 5_200_000);

    outbox.clearOversizedEventsByContentChange('session-1', [
      { eventIdentity: 't1:seq:1', contentHash: 'hash-new' },
    ]);

    expect(outbox.getOversizedEvents('session-1')).toEqual([]);
  });
});
