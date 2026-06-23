import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setErrorReporter } from '@core/errorReporter';
import { computeTurnChecksum } from '@core/services/eventCanonicalForm';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';
import type { AgentSession } from '@shared/types';
import { DELTA_PUSH_RECONCILE_AGE_MS } from '../cloudOutboxReconciliation';

 
vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-outbox-reconcile-handshake',
}));

let currentSession: AgentSession | null = null;
const mockGetSession = vi.fn(async () => currentSession);
const mockUpsertSession = vi.fn(async (session: AgentSession) => {
  currentSession = session;
});

 
vi.mock('../../incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({
    getSession: mockGetSession,
    upsertSession: mockUpsertSession,
  }),
}));

import { CloudOutbox } from '../cloudOutbox';

const OUTBOX_DIR = path.join('/tmp/test-cloud-outbox-reconcile-handshake', 'sessions');

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-1',
    title: 'Session',
    createdAt: 1,
    updatedAt: 2,
    cloudUpdatedAt: 10,
    messages: [],
    eventsByTurn: {
      'turn-a': [
        { type: 'status', message: 'a', timestamp: 10, seq: 1 },
      ],
      'turn-b': [
        { type: 'assistant', text: 'b', timestamp: 20, seq: 2 },
      ],
    },
    maxSeq: 2,
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  } as AgentSession;
}

function turnChecksumsFor(session: AgentSession) {
  return Object.entries(session.eventsByTurn ?? {})
    .map(([turnId, events]) => ({
      turnId,
      eventCount: events.length,
      contentChecksum: computeTurnChecksum(events),
    }))
    .sort((a, b) => a.turnId.localeCompare(b.turnId));
}

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getServerCapabilities: vi.fn().mockResolvedValue({
      supportsDeltaPush: true,
      supportsMetadataPatch: true,
      supportsReconcileHandshake: true,
      raw: ['session-event-delta-push', 'session-metadata-patch', 'session-reconcile-handshake'],
    }),
    reconcileSession: vi.fn(),
    catchUpSession: vi.fn().mockResolvedValue({ events: [], serverSeq: 2, hasMore: false }),
    appendSessionEvents: vi.fn().mockResolvedValue({ kind: 'applied', appliedSeq: [], serverSeq: 2, cloudUpdatedAt: 25 }),
    patchSession: vi.fn().mockResolvedValue({ cloudUpdatedAt: 25 }),
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ appliedSeq: [], serverSeq: 2, cloudUpdatedAt: 25 }),
    put: vi.fn().mockResolvedValue({ serverSeq: 2, cloudUpdatedAt: 25 }),
    patch: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    invalidateCapabilities: vi.fn(),
    ...overrides,
  };
}

function prepareAgeReconcile(outbox: CloudOutbox, session: AgentSession, now: number): void {
  currentSession = session;
  outbox.recordLastPushedSeq(session.id, session.maxSeq);
  outbox.recordFullPut(session.id, now - DELTA_PUSH_RECONCILE_AGE_MS - 1);
  outbox.enqueue(session.id, 'upsert');
}

describe('CloudOutbox reconcile handshake', () => {
  let outbox: CloudOutbox;
  const breadcrumbs: Array<{ category?: string; message?: string; data?: Record<string, unknown> }> = [];

  beforeEach(() => {
    outbox = new CloudOutbox();
    currentSession = null;
    mockGetSession.mockClear();
    mockUpsertSession.mockClear();
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

  it('records full-put on checksum match without issuing metadata PATCH', async () => {
    const now = 1_701_500_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const session = makeSession();
    prepareAgeReconcile(outbox, session, now);
    const client = makeClient({
      reconcileSession: vi.fn().mockResolvedValue({
        serverSeq: session.maxSeq,
        turnChecksums: turnChecksumsFor(session),
      }),
    });

    await outbox.drain(client);

    expect(client.reconcileSession).toHaveBeenCalledWith(session.id, session.maxSeq);
    expect(client.patchSession).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
    expect(outbox.getLastFullPutAt(session.id)).toBe(now);
    expect(outbox.getAll()).toHaveLength(0);
    expect(breadcrumbs).toContainEqual(expect.objectContaining({
      category: 'continuity.session-delta-push',
      message: 'reconcile-handshake:matched',
    }));
  });

  it('detects turn drift and catch-ups from the mismatched turn baseSeq only', async () => {
    const now = 1_701_510_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const session = makeSession({
      eventsByTurn: {
        'turn-a': [{ type: 'status', message: 'a', timestamp: 10, seq: 1 }],
        'turn-b': [{ type: 'assistant', text: 'b', timestamp: 20, seq: 5 }],
      },
      maxSeq: 5,
    });
    prepareAgeReconcile(outbox, session, now);

    const serverTurnChecksums = turnChecksumsFor(session).map((turn) => (
      turn.turnId === 'turn-b'
        ? { ...turn, contentChecksum: 'mismatch-checksum' }
        : turn
    ));
    const catchUpSession = vi.fn().mockResolvedValue({ events: [], serverSeq: 5, hasMore: false });
    const client = makeClient({
      reconcileSession: vi.fn().mockResolvedValue({
        serverSeq: 5,
        turnChecksums: serverTurnChecksums,
      }),
      catchUpSession,
    });

    await outbox.drain(client);

    expect(catchUpSession).toHaveBeenCalledTimes(1);
    expect(catchUpSession).toHaveBeenCalledWith(session.id, 4);
    expect(client.patchSession).not.toHaveBeenCalled();
    expect(outbox.getAll()).toHaveLength(0);
    expect(breadcrumbs).toContainEqual(expect.objectContaining({
      category: 'continuity.session-delta-push',
      message: 'reconcile-handshake:drift-detected',
      data: expect.objectContaining({ reconcileSinceSeq: 4 }),
    }));
  });

  it('treats invalid handshake payloads as retryable failures', async () => {
    const now = 1_701_520_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const session = makeSession();
    prepareAgeReconcile(outbox, session, now);
    const previousFullPutAt = outbox.getLastFullPutAt(session.id);
    const client = makeClient({
      reconcileSession: vi.fn().mockResolvedValue({
        serverSeq: 'bad',
        turnChecksums: [],
      }),
    });

    await outbox.drain(client);

    const entries = outbox.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
    expect(client.patchSession).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
    expect(outbox.getLastPushedSeq(session.id)).toBe(session.maxSeq);
    expect(outbox.getLastFullPutAt(session.id)).toBe(previousFullPutAt);
    expect(breadcrumbs).toContainEqual(expect.objectContaining({
      category: 'cloud-sync',
      message: 'session-reconcile-handshake:invalid-response',
    }));
  });

  it('falls back to metadata PATCH when handshake capability is missing', async () => {
    const now = 1_701_530_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const session = makeSession();
    prepareAgeReconcile(outbox, session, now);
    const reconcileSession = vi.fn();
    const patchSession = vi.fn().mockResolvedValue({ cloudUpdatedAt: now });
    const client = makeClient({
      getServerCapabilities: vi.fn().mockResolvedValue({
        supportsDeltaPush: true,
        supportsMetadataPatch: true,
        supportsReconcileHandshake: false,
        raw: ['session-event-delta-push', 'session-metadata-patch'],
      }),
      reconcileSession,
      patchSession,
    });

    await outbox.drain(client);

    expect(reconcileSession).not.toHaveBeenCalled();
    expect(patchSession).toHaveBeenCalledTimes(1);
    expect(outbox.getAll()).toHaveLength(0);
    expect(breadcrumbs).toContainEqual(expect.objectContaining({
      category: 'continuity.session-delta-push',
      message: 'reconcile-handshake:capability-missing-fallback',
    }));
  });
});
