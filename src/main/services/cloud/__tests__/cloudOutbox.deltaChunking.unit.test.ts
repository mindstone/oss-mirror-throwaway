import * as fs from 'node:fs';
import * as path from 'node:path';
import { setErrorReporter } from '@core/errorReporter';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';
import type { AgentSession } from '@shared/types';

 
vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-outbox-chunking-a5',
}));

const mockGetSession = vi.fn();
const mockUpsertSession = vi.fn();
 
vi.mock('../../incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({
    getSession: mockGetSession,
    upsertSession: mockUpsertSession,
  }),
}));

import { CloudOutbox } from '../cloudOutbox';

const OUTBOX_DIR = path.join('/tmp/test-cloud-outbox-chunking-a5', 'sessions');

const CHUNK_BUDGET = 10 * 1024 * 1024;
const CHUNK_HEADROOM = 1024 * 1024;
const CHUNK_EFFECTIVE_BUDGET = CHUNK_BUDGET - CHUNK_HEADROOM;

interface SyntheticEvent {
  type: 'tool_result';
  message: string;
  timestamp: number;
  seq: number;
}

function makeSizedEvent(seq: number, payloadBytes: number): SyntheticEvent {
  return {
    type: 'tool_result',
    message: 'x'.repeat(payloadBytes),
    timestamp: seq,
    seq,
  };
}

function buildChunkableSession(opts: {
  id?: string;
  eventCount: number;
  eventBytes: number;
}): AgentSession {
  const events: SyntheticEvent[] = [];
  for (let i = 1; i <= opts.eventCount; i += 1) {
    events.push(makeSizedEvent(i, opts.eventBytes));
  }
  return {
    id: opts.id ?? 'session-chunk',
    title: 'Chunkable session',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    eventsByTurn: { t1: events as unknown as AgentSession['eventsByTurn']['t1'] },
    maxSeq: opts.eventCount,
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
  } as AgentSession;
}

function buildSmallSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-small',
    title: 'Small session',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    eventsByTurn: {
      t1: [{ type: 'status', message: 'e', timestamp: 1, seq: 1 } as unknown as AgentSession['eventsByTurn']['t1'][number]],
    },
    maxSeq: 1,
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  } as AgentSession;
}

function makeChunkingClient(overrides: Record<string, unknown> = {}) {
  return {
    getServerCapabilities: vi.fn().mockResolvedValue({
      supportsDeltaPush: true,
      supportsMetadataPatch: true,
      raw: ['session-event-delta-push', 'session-metadata-patch', 'session-delta-chunked'],
    }),
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    invalidateCapabilities: vi.fn(),
    ...overrides,
  };
}

describe('CloudOutbox Stage A5 — byte-budgeted delta chunking', () => {
  let outbox: CloudOutbox;
  const breadcrumbs: Array<{ category?: string; message?: string; data?: Record<string, unknown> }> = [];

  beforeEach(() => {
    outbox = new CloudOutbox();
    mockGetSession.mockReset();
    mockUpsertSession.mockReset();
    breadcrumbs.length = 0;
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {},
      addBreadcrumb: (breadcrumb) => {
        breadcrumbs.push({
          category: breadcrumb.category,
          message: breadcrumb.message,
          data: breadcrumb.data,
        });
      },
    });
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    outbox._resetForTesting();
    resetSessionMutexForTests();
    setErrorReporter({ captureException: () => {}, captureMessage: () => {}, addBreadcrumb: () => {} });
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
  });

  it('single-chunk path: applyAppendSuccess called once with expectedGeneration (no chunked breadcrumb)', async () => {
    const now = 1_710_100_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const local = buildSmallSession();
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');
    const entryId = outbox.getAll()[0].id;
    const expectedGeneration = outbox.getEntryGeneration(entryId);

    const markSucceededSpy = vi.spyOn(outbox, 'markSucceeded');
    const post = vi.fn().mockResolvedValue({ appliedSeq: [1], serverSeq: 1, cloudUpdatedAt: now });
    const client = makeChunkingClient({ post });

    await outbox.drain(client);

    expect(post).toHaveBeenCalledTimes(1);
    expect(breadcrumbs.find((b) => b.message === 'chunked')).toBeUndefined();
    expect(breadcrumbs.find((b) => b.message === 'chunk-applied')).toBeUndefined();
    expect(breadcrumbs.find((b) => b.message === 'applied')).toBeDefined();
    const expectedGenCall = markSucceededSpy.mock.calls.find(
      ([sessionId, gen]) => sessionId === local.id && gen === expectedGeneration,
    );
    expect(expectedGenCall).toBeDefined();
  });

  it('multi-chunk path: large payload splits into N chunks, each under the chunk byte budget', async () => {
    const now = 1_710_110_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // ~30 events × 1 MB each = ~30 MB raw → ~4 chunks @ ~9 MB effective budget.
    const local = buildChunkableSession({ id: 'session-multi', eventCount: 30, eventBytes: 1 * 1024 * 1024 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');

    const postBodies: Array<{ bodyBytes: number; baseSeq: number; eventCount: number }> = [];
    let nextServerSeq = 0;
    const post = vi.fn().mockImplementation(async (_path: string, body: unknown) => {
      const bodyObj = body as { events: unknown[]; baseSeq: number };
      const bodyBytes = Buffer.byteLength(JSON.stringify(bodyObj), 'utf8');
      postBodies.push({ bodyBytes, baseSeq: bodyObj.baseSeq, eventCount: bodyObj.events.length });
      const seqs: number[] = [];
      for (let i = 0; i < bodyObj.events.length; i += 1) {
        nextServerSeq += 1;
        seqs.push(nextServerSeq);
      }
      return { appliedSeq: seqs, serverSeq: nextServerSeq, cloudUpdatedAt: now };
    });
    const client = makeChunkingClient({ post });

    await outbox.drain(client);

    expect(postBodies.length).toBeGreaterThanOrEqual(2);
    for (const captured of postBodies) {
      expect(captured.bodyBytes).toBeLessThanOrEqual(CHUNK_BUDGET);
    }

    const chunkedBreadcrumb = breadcrumbs.find((b) => b.message === 'chunked');
    expect(chunkedBreadcrumb).toBeDefined();
    expect(chunkedBreadcrumb?.data?.chunkCount).toBe(postBodies.length);
    expect(chunkedBreadcrumb?.data?.totalEvents).toBe(30);
  });

  it('per-chunk baseSeq advancement: chunk N baseSeq = chunk N-1 serverSeq', async () => {
    const now = 1_710_120_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const local = buildChunkableSession({ id: 'session-baseseq', eventCount: 30, eventBytes: 1 * 1024 * 1024 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');

    const postBodies: Array<{ baseSeq: number; eventCount: number; returnedServerSeq: number }> = [];
    let nextServerSeq = 0;
    const post = vi.fn().mockImplementation(async (_path: string, body: unknown) => {
      const bodyObj = body as { events: unknown[]; baseSeq: number };
      const seqs: number[] = [];
      for (let i = 0; i < bodyObj.events.length; i += 1) {
        nextServerSeq += 1;
        seqs.push(nextServerSeq);
      }
      postBodies.push({
        baseSeq: bodyObj.baseSeq,
        eventCount: bodyObj.events.length,
        returnedServerSeq: nextServerSeq,
      });
      return { appliedSeq: seqs, serverSeq: nextServerSeq, cloudUpdatedAt: now };
    });
    const client = makeChunkingClient({ post });

    await outbox.drain(client);

    expect(postBodies.length).toBeGreaterThanOrEqual(2);
    expect(postBodies[0].baseSeq).toBe(0);
    for (let i = 1; i < postBodies.length; i += 1) {
      expect(postBodies[i].baseSeq).toBe(postBodies[i - 1].returnedServerSeq);
    }
  });

  it('chunk-level idempotency: each chunk has a unique idempotencyKey', async () => {
    const now = 1_710_130_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const local = buildChunkableSession({ id: 'session-ikey', eventCount: 30, eventBytes: 1 * 1024 * 1024 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');

    const idempotencyKeys: string[] = [];
    let nextServerSeq = 0;
    const post = vi.fn().mockImplementation(async (_path: string, body: unknown) => {
      const bodyObj = body as { events: unknown[]; idempotencyKey?: string };
      if (typeof bodyObj.idempotencyKey === 'string') idempotencyKeys.push(bodyObj.idempotencyKey);
      const seqs: number[] = [];
      for (let i = 0; i < bodyObj.events.length; i += 1) {
        nextServerSeq += 1;
        seqs.push(nextServerSeq);
      }
      return { appliedSeq: seqs, serverSeq: nextServerSeq, cloudUpdatedAt: now };
    });
    const client = makeChunkingClient({ post });

    await outbox.drain(client);

    expect(idempotencyKeys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(idempotencyKeys).size).toBe(idempotencyKeys.length);
  });

  it('intermediate chunks do NOT advance messageIds, metadataDigest, deltaCount, or markSucceeded', async () => {
    const now = 1_710_140_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const local = buildChunkableSession({ id: 'session-intermediate', eventCount: 30, eventBytes: 1 * 1024 * 1024 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');

    const recordLastPushedMessageIdsSpy = vi.spyOn(outbox, 'recordLastPushedMessageIds');
    const recordLastPushedMetadataDigestSpy = vi.spyOn(outbox, 'recordLastPushedMetadataDigest');
    const incrementDeltaCountSpy = vi.spyOn(outbox, 'incrementDeltaCount');
    const markSucceededSpy = vi.spyOn(outbox, 'markSucceeded');

    let nextServerSeq = 0;
    const post = vi.fn().mockImplementation(async (_path: string, body: unknown) => {
      const bodyObj = body as { events: unknown[] };
      const seqs: number[] = [];
      for (let i = 0; i < bodyObj.events.length; i += 1) {
        nextServerSeq += 1;
        seqs.push(nextServerSeq);
      }
      return { appliedSeq: seqs, serverSeq: nextServerSeq, cloudUpdatedAt: now };
    });
    const client = makeChunkingClient({ post });

    await outbox.drain(client);

    expect(post.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Each of these is called exactly once (final chunk only), not once per chunk.
    expect(recordLastPushedMessageIdsSpy).toHaveBeenCalledTimes(1);
    expect(incrementDeltaCountSpy).toHaveBeenCalledTimes(1);
    // markSucceeded is called by both applyAppendSuccess (inner) and the outer
    // drain — both for the same session at the same expectedGeneration. So 2
    // calls total, not once per chunk.
    const markSucceededForSession = markSucceededSpy.mock.calls.filter(([s]) => s === local.id);
    expect(markSucceededForSession.length).toBe(2);
    // metadata digest: only called if computeDeltaPayload emitted a digest.
    // computeDeltaPayload always emits `metadataDigest`, so this fires once
    // on the final chunk. Asserting ≤ 1 covers both digest-emitted and
    // digest-skipped variants.
    expect(recordLastPushedMetadataDigestSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('first chunk includes messageDelta + metadataPatch; subsequent chunks do NOT', async () => {
    const now = 1_710_150_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // Session with both messageDelta-relevant messages AND a fresh metadata
    // change (changed title against pre-recorded blank digest) plus a large
    // event ledger to force multi-chunk planning.
    const local: AgentSession = {
      ...buildChunkableSession({ id: 'session-first-chunk', eventCount: 30, eventBytes: 1 * 1024 * 1024 }),
      title: 'Changed Title',
      messages: [{
        id: 'msg-1',
        role: 'user',
        content: 'hello',
        timestamp: 1,
      } as unknown as AgentSession['messages'][number]],
    };
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');

    const postBodies: Array<Record<string, unknown>> = [];
    let nextServerSeq = 0;
    const post = vi.fn().mockImplementation(async (_path: string, body: unknown) => {
      postBodies.push(body as Record<string, unknown>);
      const bodyObj = body as { events: unknown[] };
      const seqs: number[] = [];
      for (let i = 0; i < bodyObj.events.length; i += 1) {
        nextServerSeq += 1;
        seqs.push(nextServerSeq);
      }
      return { appliedSeq: seqs, serverSeq: nextServerSeq, cloudUpdatedAt: now };
    });
    const client = makeChunkingClient({ post });

    await outbox.drain(client);

    expect(postBodies.length).toBeGreaterThanOrEqual(2);
    expect(postBodies[0]).toHaveProperty('messageDelta');
    expect(postBodies[0]).toHaveProperty('metadataPatch');
    for (let i = 1; i < postBodies.length; i += 1) {
      expect(postBodies[i]).not.toHaveProperty('messageDelta');
      expect(postBodies[i]).not.toHaveProperty('messageDeletes');
      expect(postBodies[i]).not.toHaveProperty('metadataPatch');
      expect(postBodies[i]).not.toHaveProperty('_destructiveOps');
    }
  });

  it('tombstone mid-chunking: confirmed-tombstone response halts the chunk loop', async () => {
    const now = 1_710_160_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const local = buildChunkableSession({ id: 'session-tomb', eventCount: 30, eventBytes: 1 * 1024 * 1024 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');

    // Use the typed client.appendSessionEvents so we can return the typed
    // `{ kind: 'tombstoned' }` shape that appendSessionDelta forwards intact.
    // (The raw client.post path hard-codes kind: 'applied'.)
    let callCount = 0;
    let nextServerSeq = 0;
    const appendSessionEvents = vi.fn().mockImplementation(async (_sid: string, body: { events: unknown[] }) => {
      callCount += 1;
      if (callCount >= 2) {
        return {
          kind: 'tombstoned',
          tombstone: {
            sessionId: local.id,
            deletedAt: now,
            deletedBy: 'remote',
            ttlExpiresAt: now + 1_000_000,
          },
        };
      }
      const seqs: number[] = [];
      for (let i = 0; i < body.events.length; i += 1) {
        nextServerSeq += 1;
        seqs.push(nextServerSeq);
      }
      return { kind: 'applied', appliedSeq: seqs, serverSeq: nextServerSeq, cloudUpdatedAt: now };
    });
    const client = makeChunkingClient({ appendSessionEvents });

    await outbox.drain(client);

    // After the tombstone response on chunk 2, the loop must NOT continue
    // sending chunks 3..N. So total chunked POSTs is exactly 2.
    expect(appendSessionEvents).toHaveBeenCalledTimes(2);
    // Entry routed through applyConfirmedTombstone → removed from outbox.
    expect(outbox.getAll().filter((e) => e.sessionId === local.id)).toHaveLength(0);
  });

  it('chunk failure mid-flight: transient error parks entry pending; next drain re-derives', async () => {
    const now = 1_710_170_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const local = buildChunkableSession({ id: 'session-fail', eventCount: 30, eventBytes: 1 * 1024 * 1024 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');

    let callCount = 0;
    let nextServerSeq = 0;
    const post = vi.fn().mockImplementation(async (_path: string, body: unknown) => {
      callCount += 1;
      if (callCount === 3) {
        throw new Error('transient network error');
      }
      const bodyObj = body as { events: unknown[] };
      const seqs: number[] = [];
      for (let i = 0; i < bodyObj.events.length; i += 1) {
        nextServerSeq += 1;
        seqs.push(nextServerSeq);
      }
      return { appliedSeq: seqs, serverSeq: nextServerSeq, cloudUpdatedAt: now };
    });
    const client = makeChunkingClient({ post });

    await outbox.drain(client);

    // Chunk 3 threw a non-permanent error → loop aborts via the outer
    // try/catch's `throw err` branch → markAttemptFailed sets the entry to
    // pending with attempts >= 1. Chunks 0..1 already advanced the cursor.
    const all = outbox.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('pending');
    expect(all[0].attempts).toBeGreaterThanOrEqual(1);
    // Cursor reflects the last successful chunk's serverSeq.
    const cursor = outbox.getLastPushedSeq(local.id);
    expect(cursor).toBeGreaterThan(0);
    expect(cursor).toBeLessThan(local.maxSeq ?? Number.POSITIVE_INFINITY);
  });

  it('oversized single event triggers OversizedChunkError + event sidelining + retry without it', async () => {
    const now = 1_710_180_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // One event whose serialized JSON bytes exceed DELTA_CHUNK_HARD_LIMIT
    // (12 MB) but stays under DELTA_EVENT_GZIP_LIMIT_BYTES (5 MB gzipped).
    // Per-event filter only triggers when raw ≥ 3 MB AND gzip > 5 MB.
    // 'x'.repeat(N) gzips to ~N/100, so 12.5 MB raw → ~125 KB gzipped:
    // safely under the gzip limit. This event lands in its own chunk via
    // the planner's oversized-event safety net; the wire body (~12.5 MB +
    // envelope) then exceeds DELTA_CHUNK_HARD_LIMIT (12 MB), causing
    // appendSessionDelta to throw OversizedChunkError before any network
    // I/O. The catch handler sidelines the event via recordOversizedEvent,
    // bumps generation, and re-throws so the outer drain marks the attempt
    // failed and retries on the next tick — at which point computeDeltaPayload
    // excludes the sidelined event from the new payload and converges.
    const oversized = buildChunkableSession({ id: 'session-oversize', eventCount: 1, eventBytes: 12.5 * 1024 * 1024 });
    mockGetSession.mockResolvedValue(oversized);
    outbox.recordLastPushedSeq(oversized.id, 0);
    outbox.enqueue(oversized.id, 'upsert');

    const post = vi.fn();
    const appendSessionEvents = vi.fn();
    const client = makeChunkingClient({ post, appendSessionEvents });

    await outbox.drain(client);

    // appendSessionDelta throws BEFORE any network I/O, so neither transport
    // hook is ever invoked.
    expect(post).not.toHaveBeenCalled();
    expect(appendSessionEvents).not.toHaveBeenCalled();

    // The event is sidelined in oversizedEventIds. The recorded gzipBytes
    // value is the wire-body bytes (the hook reuses the existing tracker;
    // see recordOversizedEvent contract).
    const sidelined = outbox.getOversizedEvents(oversized.id);
    expect(sidelined).toHaveLength(1);
    expect(sidelined[0].gzipBytes).toBeGreaterThan(CHUNK_BUDGET);

    // Sentry breadcrumb explicitly tagged for the sideline event so operators
    // can correlate to the user-visible recovery path.
    const sidelineBreadcrumb = breadcrumbs.find(
      (b) => b.category === 'cloud-sync' && b.message === 'session-delta-push:event-oversized-sidelined',
    );
    expect(sidelineBreadcrumb).toBeDefined();
    expect(sidelineBreadcrumb?.data?.eventBytes).toBeGreaterThan(CHUNK_EFFECTIVE_BUDGET);
    expect(sidelineBreadcrumb?.data?.wireBytes).toBeGreaterThan(CHUNK_BUDGET);

    // Entry stays pending with attempts >= 1; next drain re-derives a
    // payload that excludes the sidelined event.
    const all = outbox.getAll().filter((e) => e.sessionId === oversized.id);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('pending');
    expect(all[0].attempts).toBeGreaterThanOrEqual(1);
  });

  it('oversized envelope (50 MB messageDelta, 0 events) falls back to pushFullSession', async () => {
    const now = 1_710_200_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // Session has a 50 MB messageDelta and zero new events (cursor at maxSeq).
    // The planner returns zero chunks (no events to chunk); appendSessionDelta-
    // Chunked's `chunks.length <= 1` fast path forwards the original payload to
    // appendSessionDelta, whose JSON.stringify produces a ~50 MB body that
    // exceeds DELTA_CHUNK_HARD_LIMIT (12 MB). The catch handler detects no
    // single event is responsible (events.length === 0) and falls back to
    // pushFullSession — bounded by A4's 100 MB cap.
    const hugeMessage = {
      id: 'msg-huge',
      role: 'user',
      content: 'x'.repeat(50 * 1024 * 1024),
      timestamp: 1,
    } as unknown as AgentSession['messages'][number];

    const local: AgentSession = {
      ...buildSmallSession({ id: 'session-envelope-oversize' }),
      messages: [hugeMessage],
    };
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, local.maxSeq);
    outbox.enqueue(local.id, 'upsert');

    const post = vi.fn();
    const put = vi.fn().mockResolvedValue({ serverSeq: local.maxSeq, cloudUpdatedAt: now });
    const client = makeChunkingClient({ post, put });

    await outbox.drain(client);

    // The delta POST was attempted (or short-circuited by the chunked-path
    // fast-route's appendSessionDelta) — but no body was sent over the wire
    // because the hard-limit check throws before client.post.
    expect(post).not.toHaveBeenCalled();
    // The fallback PUT to pushFullSession DID fire.
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toMatch(/\/api\/sessions\//);

    // Fallback breadcrumb visible for operators.
    const fallbackBreadcrumb = breadcrumbs.find(
      (b) => b.category === 'cloud-sync' && b.message === 'session-delta-push:envelope-oversized-fallback-fullput',
    );
    expect(fallbackBreadcrumb).toBeDefined();
    expect(fallbackBreadcrumb?.data?.wireBytes).toBeGreaterThan(CHUNK_BUDGET);
    expect(fallbackBreadcrumb?.data?.hasMessageDelta).toBe(true);

    // Entry succeeded via pushFullSession → removed from outbox.
    expect(outbox.getAll().filter((e) => e.sessionId === local.id)).toHaveLength(0);
  });

  it('per-chunk wire-body check: first chunk envelope (huge metadataPatch) triggers fallback', async () => {
    const now = 1_710_210_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // 30 × 1 MB events force multi-chunk planning. A 14 MB title field on
    // the session makes the first-chunk envelope (metadataPatch) alone bloat
    // past DELTA_CHUNK_HARD_LIMIT (12 MB). The planner stuffs one event into
    // the first chunk + the 14 MB metadataPatch; appendSessionDelta then
    // throws OversizedChunkError on chunk 0. The handler sees no single event
    // is over-budget (the 1 MB event in chunk 0 is fine on its own) and
    // routes to pushFullSession.
    const local: AgentSession = {
      ...buildChunkableSession({ id: 'session-first-chunk-envelope', eventCount: 30, eventBytes: 1 * 1024 * 1024 }),
      title: 'x'.repeat(14 * 1024 * 1024),
    };
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');

    const post = vi.fn();
    const put = vi.fn().mockResolvedValue({ serverSeq: local.maxSeq, cloudUpdatedAt: now });
    const client = makeChunkingClient({ post, put });

    await outbox.drain(client);

    // No POST went over the wire — the hard-limit check threw before
    // network I/O on chunk 0. (Chunk 0 carried the huge metadataPatch +
    // 1 event = ~15 MB > 12 MB hard limit.)
    expect(post).not.toHaveBeenCalled();
    // Fallback PUT to pushFullSession fired exactly once.
    expect(put).toHaveBeenCalledTimes(1);

    const fallbackBreadcrumb = breadcrumbs.find(
      (b) => b.category === 'cloud-sync' && b.message === 'session-delta-push:envelope-oversized-fallback-fullput',
    );
    expect(fallbackBreadcrumb).toBeDefined();
    expect(fallbackBreadcrumb?.data?.wireBytes).toBeGreaterThan(CHUNK_BUDGET);
    expect(fallbackBreadcrumb?.data?.hasMetadataPatch).toBe(true);

    // Entry succeeded via pushFullSession → removed from outbox.
    expect(outbox.getAll().filter((e) => e.sessionId === local.id)).toHaveLength(0);
  });

  it('non-empty messageDelta with zero events: single chunk with no events, messageDelta on wire', async () => {
    const now = 1_710_190_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // No new events (cursor already at maxSeq) but a new outgoing message.
    const local: AgentSession = {
      ...buildSmallSession({ id: 'session-empty-events' }),
      messages: [{
        id: 'msg-zero',
        role: 'user',
        content: 'just a message',
        timestamp: 1,
      } as unknown as AgentSession['messages'][number]],
    };
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, local.maxSeq);
    outbox.enqueue(local.id, 'upsert');

    let capturedBody: Record<string, unknown> | null = null;
    const post = vi.fn().mockImplementation(async (_path: string, body: unknown) => {
      capturedBody = body as Record<string, unknown>;
      return { appliedSeq: [], serverSeq: local.maxSeq, cloudUpdatedAt: now };
    });
    const client = makeChunkingClient({ post });

    await outbox.drain(client);

    expect(post).toHaveBeenCalledTimes(1);
    expect(capturedBody).not.toBeNull();
    const verifiedBody = capturedBody as unknown as { events: unknown[]; messageDelta?: unknown };
    expect(Array.isArray(verifiedBody.events)).toBe(true);
    expect(verifiedBody.events).toHaveLength(0);
    expect(verifiedBody.messageDelta).toBeDefined();

    // No multi-chunk breadcrumb — this is the single-chunk path.
    expect(breadcrumbs.find((b) => b.message === 'chunked')).toBeUndefined();
  });
});
