import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';
import type { AgentSession } from '@shared/types';

 
vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-outbox-bootstrap',
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

const OUTBOX_DIR = path.join('/tmp/test-cloud-outbox-bootstrap', 'sessions');

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'bootstrap-session',
    title: 'Bootstrap',
    createdAt: 1,
    updatedAt: 2,
    messages: [{ id: 'm1', turnId: 't1', role: 'user', text: 'hello', createdAt: 1 }],
    eventsByTurn: { t1: [{ type: 'status', message: 'local', timestamp: 1, seq: 1 }] },
    maxSeq: 1,
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  };
}

describe('CloudOutbox bootstrap create-then-append', () => {
  let outbox: CloudOutbox;

  beforeEach(() => {
    outbox = new CloudOutbox();
    mockGetSession.mockReset();
    mockUpsertSession.mockReset();
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    outbox._resetForTesting();
    resetSessionMutexForTests();
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
  });

  it('creates a small shell session after lean 404, then appends local deltas', async () => {
    const local = makeSession();
    mockGetSession.mockResolvedValue(local);
    outbox.enqueue(local.id, 'upsert');
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    const client = {
      getServerCapabilities: vi.fn().mockResolvedValue({ supportsDeltaPush: true, supportsMetadataPatch: true, raw: [] }),
      get: vi.fn().mockRejectedValue(notFound),
      put: vi.fn().mockResolvedValue({ serverSeq: 0, cloudUpdatedAt: 3 }),
      post: vi.fn().mockResolvedValue({ appliedSeq: [1], serverSeq: 1, cloudUpdatedAt: 4 }),
      patch: vi.fn(),
      delete: vi.fn(),
    };

    await outbox.drain(client);

    const shellBody = client.put.mock.calls[0][1] as AgentSession;
    expect(shellBody.messages).toEqual([]);
    expect(shellBody.eventsByTurn).toEqual({});
    expect(Buffer.byteLength(JSON.stringify(shellBody), 'utf8')).toBeLessThan(1_000_000);
    expect(client.post).toHaveBeenCalledWith('/api/sessions/bootstrap-session/events', expect.objectContaining({
      baseSeq: 0,
      messageDelta: local.messages,
    }));
  });

  it('records bootstrap cursor state before the append', async () => {
    const local = makeSession();
    mockGetSession.mockResolvedValue(local);
    outbox.enqueue(local.id, 'upsert');
    const client = {
      getServerCapabilities: vi.fn().mockResolvedValue({ supportsDeltaPush: true, supportsMetadataPatch: true, raw: [] }),
      get: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 })),
      put: vi.fn().mockResolvedValue({ serverSeq: 0, cloudUpdatedAt: 3 }),
      post: vi.fn().mockResolvedValue({ appliedSeq: [1], serverSeq: 1, cloudUpdatedAt: 4 }),
      patch: vi.fn(),
      delete: vi.fn(),
    };

    await outbox.drain(client);

    expect(outbox.getLastFullPutAt(local.id)).toEqual(expect.any(Number));
    expect(outbox.getLastPushedSeq(local.id)).toBe(1);
    expect(outbox.getLastPushedMessageIds(local.id)).toEqual(['m1']);
  });

  it('treats lean 410 with structured tombstone proof as tombstone suppression without bootstrap PUT', async () => {
    const local = makeSession();
    mockGetSession.mockResolvedValue(local);
    outbox.enqueue(local.id, 'upsert');
    // Stage A2: tombstone suppression requires structured proof (the cloud
    // route at cloud-service/src/routes/sessions.ts always sends this body
    // shape on 410).
    const tombstoneErr = Object.assign(new Error('gone'), {
      statusCode: 410,
      code: 'session-tombstoned',
    });
    const client = {
      getServerCapabilities: vi.fn().mockResolvedValue({ supportsDeltaPush: true, supportsMetadataPatch: true, raw: [] }),
      get: vi.fn().mockRejectedValue(tombstoneErr),
      put: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };

    await outbox.drain(client);

    expect(client.put).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
    expect(outbox.getAll()).toHaveLength(0);
  });

  it('Stage A2: status-only lean 410 (no structured proof) is treated as transient, NOT terminal', async () => {
    const local = makeSession();
    mockGetSession.mockResolvedValue(local);
    outbox.enqueue(local.id, 'upsert');
    // Bare 410 with no code / responseBody — could be a server flap or a
    // misrouted request. Stage A2 requires structured proof before
    // converging locally; this falls through to backoff retry.
    const client = {
      getServerCapabilities: vi.fn().mockResolvedValue({ supportsDeltaPush: true, supportsMetadataPatch: true, raw: [] }),
      get: vi.fn().mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 })),
      put: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };

    await outbox.drain(client);

    // Entry stays pending with backoff.
    const all = outbox.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('pending');
    expect(all[0].attempts).toBeGreaterThanOrEqual(1);
  });
});
