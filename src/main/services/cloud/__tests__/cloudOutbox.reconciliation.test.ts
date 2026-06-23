import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';
import type { AgentSession } from '@shared/types';
import { DELTA_PUSH_RECONCILE_AGE_MS, DELTA_PUSH_RECONCILE_COUNT } from '../cloudOutboxReconciliation';

 
vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-outbox-reconciliation',
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

const OUTBOX_DIR = path.join('/tmp/test-cloud-outbox-reconciliation', 'sessions');

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

function statusEvent(seq: number) {
  return { type: 'status' as const, message: `event-${seq}`, timestamp: seq, seq };
}

function deltaClient(overrides: Record<string, unknown> = {}) {
  return {
    getServerCapabilities: vi.fn().mockResolvedValue({
      supportsDeltaPush: true,
      supportsMetadataPatch: true,
      raw: ['session-event-delta-push', 'session-metadata-patch'],
    }),
    get: vi.fn().mockResolvedValue({ id: 'session-1', maxSeq: 0, messages: [], cloudUpdatedAt: 10 }),
    post: vi.fn().mockResolvedValue({ appliedSeq: [1], serverSeq: 1, cloudUpdatedAt: 20 }),
    put: vi.fn().mockResolvedValue({ serverSeq: 1, cloudUpdatedAt: 21 }),
    patch: vi.fn().mockResolvedValue({ cloudUpdatedAt: 22 }),
    delete: vi.fn().mockResolvedValue(undefined),
    invalidateCapabilities: vi.fn(),
    ...overrides,
  };
}

function incrementDeltaCount(outbox: CloudOutbox, sessionId: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    outbox.incrementDeltaCount(sessionId);
  }
}

describe('CloudOutbox reconciliation policy', () => {
  let outbox: CloudOutbox;

  beforeEach(() => {
    outbox = new CloudOutbox();
    mockGetSession.mockReset();
    mockUpsertSession.mockReset();
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    outbox._resetForTesting();
    resetSessionMutexForTests();
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
  });

  it('routes count-reconcile via patchMetadataOnly + delta-append (Stage A1)', async () => {
    const local = session({ eventsByTurn: { t1: [statusEvent(201)] }, maxSeq: 201 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 200);
    incrementDeltaCount(outbox, local.id, DELTA_PUSH_RECONCILE_COUNT);
    outbox.enqueue(local.id, 'upsert');
    const client = deltaClient({
      post: vi.fn().mockResolvedValue({ appliedSeq: [201], serverSeq: 201, cloudUpdatedAt: 30 }),
    });

    await outbox.drain(client);

    expect(client.put).not.toHaveBeenCalled();
    expect(client.patch).toHaveBeenCalledWith(
      '/api/sessions/session-1',
      expect.objectContaining({ patch: expect.any(Object) }),
    );
    expect(client.post).toHaveBeenCalledWith(
      '/api/sessions/session-1/events',
      expect.objectContaining({ baseSeq: 200 }),
    );
    expect(outbox.getDeltaCount(local.id)).toBe(1);
    expect(outbox.getLastPushedSeq(local.id)).toBe(201);
  });

  it('routes age-reconcile via patchMetadataOnly + delta-append (Stage A1)', async () => {
    const now = 1_700_100_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const local = session({ eventsByTurn: { t1: [statusEvent(1)] }, maxSeq: 1 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.recordFullPut(local.id, now - DELTA_PUSH_RECONCILE_AGE_MS - 1);
    outbox.enqueue(local.id, 'upsert');
    const client = deltaClient();

    await outbox.drain(client);

    expect(client.put).not.toHaveBeenCalled();
    expect(client.patch).toHaveBeenCalled();
    expect(client.post).toHaveBeenCalled();
    expect(outbox.getLastFullPutAt(local.id)).toBe(now);
  });

  it('resets the age threshold and increments delta count after reconcile + delta (Stage A1)', async () => {
    const now = 1_700_200_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const local = session({ eventsByTurn: { t1: [statusEvent(1)] }, maxSeq: 1 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    outbox.recordFullPut(local.id, now - DELTA_PUSH_RECONCILE_AGE_MS - 1);
    incrementDeltaCount(outbox, local.id, DELTA_PUSH_RECONCILE_COUNT);
    outbox.enqueue(local.id, 'upsert');
    const client = deltaClient();

    await outbox.drain(client);

    expect(client.put).not.toHaveBeenCalled();
    expect(client.patch).toHaveBeenCalled();
    // recordFullPut resets deltaCount to 0; applyAppendSuccess then bumps to 1.
    expect(outbox.getDeltaCount(local.id)).toBe(1);
    expect(outbox.getLastFullPutAt(local.id)).toBe(now);
  });

  it('persists reconciliation counters across reload', () => {
    const now = 1_700_300_000_000;
    outbox.onConnectionChanged('https://test.example.com');
    outbox.recordFullPut('session-1', now);
    outbox.incrementDeltaCount('session-1');
    outbox.incrementDeltaCount('session-1');
    outbox.flush();

    const fresh = new CloudOutbox();
    fresh.load();

    expect(fresh.getDeltaCount('session-1')).toBe(2);
    expect(fresh.getLastFullPutAt('session-1')).toBe(now);
    fresh._resetForTesting();
  });

  it('does not invalidate delta idempotency state when reconciling via patch (Stage A1)', async () => {
    const local = session({ eventsByTurn: { t1: [statusEvent(1)] }, maxSeq: 1 });
    mockGetSession.mockResolvedValue(local);
    outbox.recordLastPushedSeq(local.id, 0);
    incrementDeltaCount(outbox, local.id, DELTA_PUSH_RECONCILE_COUNT);
    outbox.enqueue(local.id, 'upsert');
    const entryId = outbox.getAll()[0].id;
    const client = deltaClient();

    await outbox.drain(client);

    expect(client.invalidateCapabilities).not.toHaveBeenCalled();
    expect(client.put).not.toHaveBeenCalled();
    expect(client.patch).toHaveBeenCalled();
    expect(outbox.getEntryGeneration(entryId)).toBe(0);
  });
});
