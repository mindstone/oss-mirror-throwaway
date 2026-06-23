import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { setErrorReporter } from '@core/errorReporter';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';
import type { AgentSession, AgentSessionMetadataPatch } from '@shared/types';
import { AGENT_SESSION_METADATA_PATCH_KEYS } from '@shared/types';
import { DELTA_PUSH_RECONCILE_AGE_MS } from '../cloudOutboxReconciliation';

 
vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-outbox-reconcile-a1',
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

const OUTBOX_DIR = path.join('/tmp/test-cloud-outbox-reconcile-a1', 'sessions');

interface SyntheticEvent {
  type: 'tool_result';
  message: string;
  timestamp: number;
  seq: number;
}

function makeBigEvent(seq: number, sizeBytes: number): SyntheticEvent {
  return {
    type: 'tool_result',
    message: 'x'.repeat(sizeBytes),
    timestamp: seq,
    seq,
  };
}

function buildBigSession(targetBytes: number, eventSize: number): AgentSession {
  const eventCount = Math.max(1, Math.ceil(targetBytes / eventSize));
  const events: SyntheticEvent[] = [];
  for (let i = 1; i <= eventCount; i += 1) {
    events.push(makeBigEvent(i, eventSize));
  }
  return {
    id: 'session-big',
    title: 'Big stuck session',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    eventsByTurn: { t1: events as unknown as AgentSession['eventsByTurn']['t1'] },
    maxSeq: eventCount,
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

function digestForSnapshot(session: AgentSession): string {
  const patch: AgentSessionMetadataPatch = {};
  for (const key of AGENT_SESSION_METADATA_PATCH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(session, key)) {
      (patch as Record<string, unknown>)[key] = (session as unknown as Record<string, unknown>)[key];
    }
  }
  return createHash('sha256').update(JSON.stringify(patch)).digest('hex');
}

function makeReconcileClient(overrides: Record<string, unknown> = {}) {
  return {
    getServerCapabilities: vi.fn().mockResolvedValue({
      supportsDeltaPush: true,
      supportsMetadataPatch: true,
      raw: ['session-event-delta-push', 'session-metadata-patch'],
    }),
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ appliedSeq: [], serverSeq: 0, cloudUpdatedAt: 0 }),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    invalidateCapabilities: vi.fn(),
    ...overrides,
  };
}

describe('CloudOutbox Stage A1 — reconcile via patchMetadataOnly', () => {
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

  it('reconcile via patchMetadataOnly stays under 100KB body on age trigger', async () => {
    const now = 1_700_900_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // ~100 MB of synthetic events. Each ~1 MB so per-event 5 MB cap doesn't sideline them.
    const local = buildBigSession(100 * 1024 * 1024, 1 * 1024 * 1024);
    mockGetSession.mockResolvedValue(local);

    // Cursor at max so there's no delta — proves the reconcile branch alone sends the bytes.
    outbox.recordLastPushedSeq(local.id, local.maxSeq);
    outbox.recordFullPut(local.id, now - DELTA_PUSH_RECONCILE_AGE_MS - 1);
    for (let i = 0; i < 50; i += 1) outbox.incrementDeltaCount(local.id);
    outbox.enqueue(local.id, 'upsert');

    let capturedPatchBody: unknown = null;
    const patchSession = vi.fn().mockImplementation(async (_sid: string, body: unknown) => {
      capturedPatchBody = body;
      return { cloudUpdatedAt: now };
    });
    const client = makeReconcileClient({ patchSession });

    await outbox.drain(client);

    expect(patchSession).toHaveBeenCalledTimes(1);
    expect(client.put).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
    expect(capturedPatchBody).not.toBeNull();

    const bodyBytes = Buffer.byteLength(JSON.stringify(capturedPatchBody), 'utf8');
    expect(bodyBytes).toBeLessThan(100_000);

    // recordFullPut advanced lastFullPutAt to "now".
    expect(outbox.getLastFullPutAt(local.id)).toBe(now);

    // Structured breadcrumb fired with the new tag.
    expect(breadcrumbs).toContainEqual(expect.objectContaining({
      category: 'continuity.session-delta-push',
      message: 'reconcile-via-patch',
      data: expect.objectContaining({ hasMetadataPatch: true, hasDelta: false }),
    }));
  });

  it('defers entry when generation bumps during patchMetadataOnly round-trip', async () => {
    const now = 1_700_800_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const local = buildBigSession(2 * 1024, 256);
    mockGetSession.mockResolvedValue(local);

    // Cursor at max → no delta. Reconcile branch will mark via metadata-only.
    outbox.recordLastPushedSeq(local.id, local.maxSeq);
    outbox.recordFullPut(local.id, now - DELTA_PUSH_RECONCILE_AGE_MS - 1);
    outbox.enqueue(local.id, 'upsert');
    const entryId = outbox.getAll()[0].id;
    const expectedGeneration = outbox.getEntryGeneration(entryId);

    const markSucceededSpy = vi.spyOn(outbox, 'markSucceeded');

    const patchSession = vi.fn().mockImplementation(async () => {
      // Simulate a concurrent enqueue bumping the generation mid-flight.
      outbox.bumpEntryGeneration(entryId);
      return { cloudUpdatedAt: now };
    });
    const client = makeReconcileClient({ patchSession });

    await outbox.drain(client);

    expect(patchSession).toHaveBeenCalledTimes(1);
    expect(client.put).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();

    // Inner reconcile branch and outer drain both call markSucceeded with
    // the captured `expectedGeneration`. Both calls hit the generation
    // guard inside markSucceeded (live generation has bumped) and skip the
    // entry deletion. The structural invariant the test enforces: the
    // outbox entry survives, with the bumped generation, ready for the
    // next drain to push the new state.
    expect(outbox.getAll()).toHaveLength(1);
    expect(outbox.getEntryGeneration(entryId)).toBe(expectedGeneration + 1);

    // Spy still captures that markSucceeded was attempted with the
    // captured (stale) generation — this is what makes the guard fire.
    const guardedCall = markSucceededSpy.mock.calls.find(
      ([sessionId, gen]) => sessionId === local.id && gen === expectedGeneration,
    );
    expect(guardedCall).toBeDefined();

    // recordFullPut still ran (the metadata patch IS the reconciliation work).
    expect(outbox.getLastFullPutAt(local.id)).toBe(now);

    // Defer breadcrumb fired with both generations recorded.
    expect(breadcrumbs).toContainEqual(expect.objectContaining({
      category: 'continuity.session-delta-push',
      message: 'reconcile-patch:generation-bumped-defer',
      data: expect.objectContaining({
        expectedGeneration,
        actualGeneration: expectedGeneration + 1,
      }),
    }));
  });

  it('outer drain preserves entry when generation bumps mid-executeDeltaUpsert (HIGH #1)', async () => {
    const now = 1_700_950_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const local = buildSmallSession();
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');
    const entryId = outbox.getAll()[0].id;
    const expectedGeneration = outbox.getEntryGeneration(entryId);

    const post = vi.fn().mockImplementation(async () => {
      // Concurrent enqueue bumps generation mid-flight (after computeDeltaPayload,
      // before the outer drain's markSucceeded call).
      outbox.bumpEntryGeneration(entryId);
      return { appliedSeq: [1], serverSeq: 1, cloudUpdatedAt: now };
    });
    const client = makeReconcileClient({ post });

    await outbox.drain(client);

    // The outer drain captures expectedGeneration BEFORE executeDeltaUpsert
    // and passes it to markSucceeded. Because the live generation bumped to
    // expectedGeneration + 1, the guard preserves the entry.
    expect(post).toHaveBeenCalledTimes(1);
    expect(outbox.getAll()).toHaveLength(1);
    expect(outbox.getEntryGeneration(entryId)).toBe(expectedGeneration + 1);
  });

  it('strips metadataPatch from POST body after reconcile PATCH (HIGH #2)', async () => {
    const now = 1_700_960_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // Session with a brand-new event so hasDelta = true, AND a fresh
    // metadata change so payload.metadataPatch is set up-front.
    const local = buildSmallSession({ title: 'changed-title' });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.recordFullPut(local.id, now - DELTA_PUSH_RECONCILE_AGE_MS - 1);
    outbox.enqueue(local.id, 'upsert');

    let capturedPostBody: Record<string, unknown> | null = null;
    const post = vi.fn().mockImplementation(async (_path: string, body: unknown) => {
      capturedPostBody = body as Record<string, unknown>;
      return { appliedSeq: [1], serverSeq: 1, cloudUpdatedAt: now };
    });
    const patchSession = vi.fn().mockResolvedValue({ cloudUpdatedAt: now });
    const client = makeReconcileClient({ post, patchSession });

    await outbox.drain(client);

    // PATCH sent the metadataPatch; subsequent POST must NOT resend it.
    expect(patchSession).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(capturedPostBody).not.toBeNull();
    expect(capturedPostBody).not.toHaveProperty('metadataPatch');
  });

  it('PATCH 404 NEEDS_BOOTSTRAP → bootstrap recovery + recurse (HIGH #3)', async () => {
    const now = 1_700_970_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const local = buildSmallSession();
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.recordFullPut(local.id, now - DELTA_PUSH_RECONCILE_AGE_MS - 1);
    outbox.enqueue(local.id, 'upsert');

    const lostError = Object.assign(new Error('Session needs bootstrap'), {
      statusCode: 404,
      code: 'NEEDS_BOOTSTRAP',
    });
    const patchSession = vi.fn().mockRejectedValue(lostError);
    const put = vi.fn().mockResolvedValue({ serverSeq: 0, cloudUpdatedAt: now });
    const post = vi.fn().mockResolvedValue({ appliedSeq: [1], serverSeq: 1, cloudUpdatedAt: now });
    const client = makeReconcileClient({ patchSession, put, post });

    await outbox.drain(client);

    // Bootstrap shell PUT was issued, then the recurse re-ran the upsert
    // (which appends events via POST against the freshly bootstrapped baseline).
    expect(patchSession).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalled();
    expect(post).toHaveBeenCalled();
    expect(breadcrumbs).toContainEqual(expect.objectContaining({
      category: 'continuity.session-delta-push',
      message: 'reconcile-patch:needs-bootstrap',
    }));
  });

  it('PATCH 405 CAPABILITY_MISSING_FALLBACK → pushFullSession fallback (HIGH #4)', async () => {
    const now = 1_700_980_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const local = buildSmallSession();
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.recordFullPut(local.id, now - DELTA_PUSH_RECONCILE_AGE_MS - 1);
    outbox.enqueue(local.id, 'upsert');

    const legacyError = Object.assign(new Error('CAPABILITY_MISSING_FALLBACK'), {
      statusCode: 405,
      code: 'CAPABILITY_MISSING_FALLBACK',
    });
    const patchSession = vi.fn().mockRejectedValue(legacyError);
    const put = vi.fn().mockResolvedValue({ serverSeq: 1, cloudUpdatedAt: now });
    const client = makeReconcileClient({ patchSession, put });

    await outbox.drain(client);

    expect(patchSession).toHaveBeenCalledTimes(1);
    expect(client.invalidateCapabilities).toHaveBeenCalled();
    expect(put).toHaveBeenCalled(); // pushFullSession
    expect(breadcrumbs).toContainEqual(expect.objectContaining({
      category: 'continuity.session-delta-push',
      message: 'reconcile-patch:capability-missing-fallback',
    }));
  });

  it('empty metadataPatch still round-trips a synthetic full-snapshot patch (HIGH #5, Option A)', async () => {
    const now = 1_700_990_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const local = buildSmallSession();
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, local.maxSeq);
    // Pre-record the digest so computeDeltaPayload returns metadataPatch=undefined.
    outbox.recordLastPushedMetadataDigest(local.id, digestForSnapshot(local));
    outbox.recordFullPut(local.id, now - DELTA_PUSH_RECONCILE_AGE_MS - 1);
    outbox.enqueue(local.id, 'upsert');

    let capturedPatchBody: Record<string, unknown> | null = null;
    const patchSession = vi.fn().mockImplementation(async (_sid: string, body: unknown) => {
      capturedPatchBody = body as Record<string, unknown>;
      return { cloudUpdatedAt: now };
    });
    const client = makeReconcileClient({ patchSession });

    await outbox.drain(client);

    // PATCH was sent even though the digest was unchanged (drift-detection
    // requires a real round-trip). The synthetic patch contains the full
    // metadata snapshot.
    expect(patchSession).toHaveBeenCalledTimes(1);
    expect(capturedPatchBody).not.toBeNull();
    const verifiedBody = capturedPatchBody as unknown as { patch?: unknown };
    expect(verifiedBody.patch).toBeDefined();
    expect(typeof verifiedBody.patch).toBe('object');
    expect(outbox.getLastFullPutAt(local.id)).toBe(now);
    expect(breadcrumbs).toContainEqual(expect.objectContaining({
      category: 'continuity.session-delta-push',
      message: 'reconcile-via-patch',
      data: expect.objectContaining({ hasMetadataPatch: true }),
    }));
  });

  it('PATCH NEEDS_RECONCILE → catchUp + recurse (HIGH #7)', async () => {
    const now = 1_701_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const local = buildSmallSession();
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.recordFullPut(local.id, now - DELTA_PUSH_RECONCILE_AGE_MS - 1);
    outbox.enqueue(local.id, 'upsert');

    const reconcileError = Object.assign(new Error('Session needs reconcile'), {
      statusCode: 409,
      code: 'NEEDS_RECONCILE',
    });
    // Fail the first patch (NEEDS_RECONCILE), succeed on the recursive retry
    // (simulating that catchUp resolved the divergence).
    const patchSession = vi.fn()
      .mockRejectedValueOnce(reconcileError)
      .mockResolvedValue({ cloudUpdatedAt: now });
    const catchUpSession = vi.fn().mockResolvedValue({
      events: [],
      serverSeq: 5,
      hasMore: false,
    });
    const post = vi.fn().mockResolvedValue({ appliedSeq: [1], serverSeq: 5, cloudUpdatedAt: now });
    const client = makeReconcileClient({ patchSession, catchUpSession, post });

    await outbox.drain(client);

    // Reconcile branch caught the NEEDS_RECONCILE, ran catch-up, bumped
    // generation, and recursed through executeDeltaUpsert. The retry
    // succeeded (catchUp resolved the divergence).
    expect(catchUpSession).toHaveBeenCalledTimes(1);
    expect(patchSession.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(breadcrumbs).toContainEqual(expect.objectContaining({
      category: 'continuity.session-delta-push',
      message: 'reconcile-patch:needs-reconcile',
    }));
  });

  it('drain captures expectedGeneration before getSession await (Fix #1, cycle 2)', async () => {
    const now = 1_701_020_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const local = buildSmallSession();
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');
    const entryId = outbox.getAll()[0].id;
    const expectedGeneration = outbox.getEntryGeneration(entryId);

    // One concurrent enqueue bumps generation DURING the FIRST
    // store.getSession await (the one in executeDrain). Without Fix #1 the
    // capture lived inside executeDeltaUpsert AFTER this await — so the
    // captured-after-bump value would equal the live value, defeating the
    // generation guard and causing markSucceeded to delete the entry.
    let bumpedOnce = false;
    mockGetSession.mockImplementation(async () => {
      if (!bumpedOnce) {
        outbox.bumpEntryGeneration(entryId);
        bumpedOnce = true;
      }
      return local;
    });

    const markSucceededSpy = vi.spyOn(outbox, 'markSucceeded');

    const post = vi.fn().mockResolvedValue({ appliedSeq: [1], serverSeq: 1, cloudUpdatedAt: now });
    const client = makeReconcileClient({ post });

    await outbox.drain(client);

    // The append POST succeeded but the outer drain's captured
    // drainExpectedGeneration is now stale relative to the live (bumped)
    // generation. markSucceeded sees the mismatch and preserves the entry.
    expect(post).toHaveBeenCalledTimes(1);
    expect(outbox.getAll()).toHaveLength(1);
    expect(outbox.getEntryGeneration(entryId)).toBe(expectedGeneration + 1);

    // The outer drain MUST attempt markSucceeded with the captured
    // expectedGeneration (not the live, bumped one). The guard inside
    // markSucceeded is what preserves the entry.
    const guardedCall = markSucceededSpy.mock.calls.find(
      ([sessionId, gen]) => sessionId === local.id && gen === expectedGeneration,
    );
    expect(guardedCall).toBeDefined();
  });

  it('PATCH NEEDS_BOOTSTRAP at depth >= 1 keeps entry pending (Fix #2, cycle 2)', async () => {
    const now = 1_701_030_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const local = buildSmallSession();
    mockGetSession.mockResolvedValue(local);
    // Cursor at max → no delta. Reconcile branch alone exercises PATCH.
    outbox.recordLastPushedSeq(local.id, local.maxSeq);
    outbox.recordFullPut(local.id, now - DELTA_PUSH_RECONCILE_AGE_MS - 1);
    outbox.enqueue(local.id, 'upsert');

    const reconcileError = Object.assign(new Error('Session needs reconcile'), {
      statusCode: 409,
      code: 'NEEDS_RECONCILE',
    });
    const bootstrapError = Object.assign(new Error('Session needs bootstrap'), {
      statusCode: 404,
      code: 'NEEDS_BOOTSTRAP',
    });
    // depth=0: NEEDS_RECONCILE → catchUp + bumpEntryGeneration + recurse to depth=1.
    // depth=1: NEEDS_BOOTSTRAP → shell PUT runs, then helper returns false.
    const patchSession = vi.fn()
      .mockRejectedValueOnce(reconcileError)
      .mockRejectedValueOnce(bootstrapError);
    const catchUpSession = vi.fn().mockResolvedValue({
      events: [],
      serverSeq: local.maxSeq,
      hasMore: false,
    });
    const put = vi.fn().mockResolvedValue({ serverSeq: 0, cloudUpdatedAt: now });
    const client = makeReconcileClient({ patchSession, catchUpSession, put });

    await outbox.drain(client);

    // PATCH attempted twice (depth=0 + depth=1). catchUp ran during depth=0
    // NEEDS_RECONCILE recovery. Shell PUT ran during depth=1 bootstrap.
    expect(patchSession).toHaveBeenCalledTimes(2);
    expect(catchUpSession).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalled();
    expect(breadcrumbs).toContainEqual(expect.objectContaining({
      category: 'continuity.session-delta-push',
      message: 'reconcile-patch:needs-bootstrap',
    }));

    // CRITICAL: helper returned false at depth >= 1, so the outer drain
    // catches the original NEEDS_BOOTSTRAP and calls markAttemptFailed
    // instead of markSucceeded. Returning true at depth >= 1 would have
    // marked the entry succeeded → deleted → lost the events that the
    // shell-only bootstrap did NOT push.
    const all = outbox.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('pending');
    expect(all[0].attempts).toBeGreaterThanOrEqual(1);
    expect(all[0].lastError).toMatch(/bootstrap/i);
  });

  it('applyAppendSuccess uses captured expectedGeneration (HIGH #6)', async () => {
    const now = 1_701_010_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const local = buildSmallSession();
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.enqueue(local.id, 'upsert');
    const entryId = outbox.getAll()[0].id;
    const expectedGeneration = outbox.getEntryGeneration(entryId);

    const markSucceededSpy = vi.spyOn(outbox, 'markSucceeded');

    // Concurrent enqueue bumps generation between appendSessionDelta resolving
    // and applyAppendSuccess calling markSucceeded.
    const post = vi.fn().mockImplementation(async () => {
      outbox.bumpEntryGeneration(entryId);
      return { appliedSeq: [1], serverSeq: 1, cloudUpdatedAt: now };
    });
    const client = makeReconcileClient({ post });

    await outbox.drain(client);

    // The success path called markSucceeded(sessionId, expectedGeneration) —
    // the *captured* value at the start of the tick, not the live one. The
    // guard inside markSucceeded preserves the entry on mismatch.
    const succCallWithExpected = markSucceededSpy.mock.calls.find(
      ([sessionId, gen]) => sessionId === local.id && gen === expectedGeneration,
    );
    expect(succCallWithExpected).toBeDefined();
    expect(outbox.getAll()).toHaveLength(1);
    expect(outbox.getEntryGeneration(entryId)).toBe(expectedGeneration + 1);
  });
});
