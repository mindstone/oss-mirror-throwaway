import * as fs from 'node:fs';
import * as path from 'node:path';
import { setErrorReporter } from '@core/errorReporter';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';
import type { AgentSession } from '@shared/types';

 
vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-outbox-tombstone-a2',
}));

const mockGetSession = vi.fn();
const mockUpsertSession = vi.fn();
 
vi.mock('../../incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({
    getSession: mockGetSession,
    upsertSession: mockUpsertSession,
  }),
}));

import { CloudOutbox, describeTombstoneProof, isConfirmedTombstoneError } from '../cloudOutbox';

const TEST_DATA_PATH = '/tmp/test-cloud-outbox-tombstone-a2';
const OUTBOX_DIR = path.join(TEST_DATA_PATH, 'sessions');
const QUARANTINE_PATH = path.join(OUTBOX_DIR, 'cloud-tombstone-quarantine.json');

function buildSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-tombstone',
    title: 'Tombstone fixture',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    eventsByTurn: {
      t1: [{ type: 'status', message: 'x', timestamp: 1, seq: 1 } as unknown as AgentSession['eventsByTurn']['t1'][number]],
    },
    maxSeq: 1,
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  } as AgentSession;
}

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getServerCapabilities: vi.fn().mockResolvedValue({
      supportsDeltaPush: true,
      supportsMetadataPatch: true,
      raw: ['session-event-delta-push', 'session-metadata-patch'],
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

// Locally-defined class that mirrors cloud-client's SessionTombstonedError.
// The class name itself MUST be 'SessionTombstonedError' so constructor.name
// matches the helper's check.
class SessionTombstonedError extends Error {
  public readonly tombstone = {
    sessionId: 'session-tombstone',
    deletedAt: 1,
    deletedBy: 'cloud' as const,
    ttlExpiresAt: 2,
  };
  constructor() {
    super('Session "session-tombstone" was tombstoned');
    this.name = 'SessionTombstonedError';
  }
}

describe('isConfirmedTombstoneError', () => {
  it('returns true for an instance whose constructor.name is SessionTombstonedError', () => {
    expect(isConfirmedTombstoneError(new SessionTombstonedError())).toBe(true);
  });

  it('returns true for { code: "session-tombstoned" }', () => {
    expect(isConfirmedTombstoneError({ code: 'session-tombstoned' })).toBe(true);
    expect(isConfirmedTombstoneError(Object.assign(new Error('gone'), { code: 'session-tombstoned' }))).toBe(true);
  });

  it('returns true for { response: { body: { kind: "tombstoned" } } }', () => {
    expect(isConfirmedTombstoneError({ response: { body: { kind: 'tombstoned' } } })).toBe(true);
  });

  it('returns FALSE for status-only 410 (no structured proof)', () => {
    expect(isConfirmedTombstoneError({ status: 410 })).toBe(false);
    expect(isConfirmedTombstoneError({ statusCode: 410 })).toBe(false);
  });

  it('returns FALSE for new Error("410 Gone")', () => {
    expect(isConfirmedTombstoneError(new Error('410 Gone'))).toBe(false);
  });

  it('returns FALSE for null / undefined / primitives', () => {
    expect(isConfirmedTombstoneError(null)).toBe(false);
    expect(isConfirmedTombstoneError(undefined)).toBe(false);
    expect(isConfirmedTombstoneError('tombstoned')).toBe(false);
    expect(isConfirmedTombstoneError(410)).toBe(false);
  });

  it('returns true for top-level responseBody { error: "session-tombstoned" } (CloudClientError convention)', () => {
    expect(
      isConfirmedTombstoneError({ responseBody: { error: 'session-tombstoned' } }),
    ).toBe(true);
    expect(
      isConfirmedTombstoneError(
        Object.assign(new Error('gone'), {
          statusCode: 410,
          responseBody: { error: 'session-tombstoned' },
        }),
      ),
    ).toBe(true);
  });

  it('returns true for top-level responseBody { kind: "tombstoned" }', () => {
    expect(
      isConfirmedTombstoneError({ responseBody: { kind: 'tombstoned' } }),
    ).toBe(true);
  });

  it('returns true for top-level responseBody carrying a normalized tombstone object', () => {
    expect(
      isConfirmedTombstoneError({
        responseBody: {
          tombstone: { sessionId: 's', deletedAt: 1, deletedBy: 'cloud', ttlExpiresAt: 2 },
        },
      }),
    ).toBe(true);
  });

  it('returns FALSE for responseBody without tombstone proof', () => {
    expect(isConfirmedTombstoneError({ responseBody: { error: 'something-else' } })).toBe(false);
    expect(isConfirmedTombstoneError({ responseBody: 'string-body' })).toBe(false);
    expect(isConfirmedTombstoneError({ responseBody: null })).toBe(false);
  });
});

describe('describeTombstoneProof', () => {
  it('reports "SessionTombstonedError" for the typed cloud-client error', () => {
    expect(describeTombstoneProof(new SessionTombstonedError())).toBe('SessionTombstonedError');
  });

  it('reports "code" for { code: "session-tombstoned" }', () => {
    expect(describeTombstoneProof({ code: 'session-tombstoned' })).toBe('code');
  });

  it('reports "response.body" for nested response.body.kind', () => {
    expect(
      describeTombstoneProof({ response: { body: { kind: 'tombstoned' } } }),
    ).toBe('response.body');
  });

  it('reports "responseBody" for top-level responseBody shapes', () => {
    expect(
      describeTombstoneProof({ responseBody: { error: 'session-tombstoned' } }),
    ).toBe('responseBody');
    expect(
      describeTombstoneProof({ responseBody: { kind: 'tombstoned' } }),
    ).toBe('responseBody');
  });

  it('reports "unknown" for unrecognized shapes / primitives', () => {
    expect(describeTombstoneProof(null)).toBe('unknown');
    expect(describeTombstoneProof(undefined)).toBe('unknown');
    expect(describeTombstoneProof('tombstoned')).toBe('unknown');
    expect(describeTombstoneProof({})).toBe('unknown');
  });
});

describe('CloudOutbox Stage A2 — terminalReason on markPermanentlyFailed', () => {
  let outbox: CloudOutbox;

  beforeEach(() => {
    outbox = new CloudOutbox();
    mockGetSession.mockReset();
    mockUpsertSession.mockReset();
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {},
      addBreadcrumb: () => {},
    });
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    outbox._resetForTesting();
    resetSessionMutexForTests();
    setErrorReporter({ captureException: () => {}, captureMessage: () => {}, addBreadcrumb: () => {} });
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
  });

  it('records terminalReason="body-too-large" when explicitly passed', () => {
    outbox.enqueue('session-tr-1', 'upsert');
    outbox.markPermanentlyFailed('session-tr-1', 'HTTP 413 BODY_TOO_LARGE', 'body-too-large');
    const entry = outbox.getAll()[0];
    expect(entry.status).toBe('permanent_failure');
    expect(entry.terminalReason).toBe('body-too-large');
    expect(entry.lastError).toContain('BODY_TOO_LARGE');
  });

  it('records terminalReason="session-tombstoned" when explicitly passed', () => {
    outbox.enqueue('session-tr-2', 'upsert');
    outbox.markPermanentlyFailed('session-tr-2', 'tombstoned cloud-side', 'session-tombstoned');
    const entry = outbox.getAll()[0];
    expect(entry.terminalReason).toBe('session-tombstoned');
  });

  it('defaults terminalReason to "unknown-permanent" when no reason passed', () => {
    outbox.enqueue('session-tr-3', 'upsert');
    outbox.markPermanentlyFailed('session-tr-3', 'INVALID_SEQ');
    const entry = outbox.getAll()[0];
    expect(entry.terminalReason).toBe('unknown-permanent');
  });

  it('persists terminalReason across reload', () => {
    // Stage A3 boot rehab clears body-too-large entries on load; use
    // unknown-permanent (which A3 skips) to assert the persistence contract
    // without triggering rehab.
    outbox.onConnectionChanged('https://test.example.com');
    outbox.enqueue('session-tr-4', 'upsert');
    outbox.markPermanentlyFailed('session-tr-4', 'INVALID_SEQ', 'unknown-permanent');
    outbox.flush();

    const fresh = new CloudOutbox();
    fresh.load();
    const entry = fresh.getAll()[0];
    expect(entry).toBeDefined();
    expect(entry.terminalReason).toBe('unknown-permanent');
    expect(entry.status).toBe('permanent_failure');
    fresh._resetForTesting();
  });

  it('strips invalid terminalReason values during load (defensive)', () => {
    outbox.onConnectionChanged('https://test.example.com');
    outbox.enqueue('session-tr-5', 'upsert');
    outbox.markPermanentlyFailed('session-tr-5', 'oops', 'unknown-permanent');
    outbox.flush();

    // Corrupt the on-disk terminalReason for this entry.
    const filePath = path.join(OUTBOX_DIR, 'cloud-outbox.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const sessionKey = Object.keys(parsed).find((k) => !k.startsWith('_'));
    expect(sessionKey).toBeDefined();
    (parsed[sessionKey as string] as Record<string, unknown>).terminalReason = 'bogus-value';
    fs.writeFileSync(filePath, JSON.stringify(parsed));

    const fresh = new CloudOutbox();
    fresh.load();
    const entry = fresh.getAll()[0];
    expect(entry.terminalReason).toBeUndefined();
    fresh._resetForTesting();
  });
});

describe('CloudOutbox Stage A2 — drain tombstone path', () => {
  let outbox: CloudOutbox;

  beforeEach(() => {
    outbox = new CloudOutbox();
    mockGetSession.mockReset();
    mockUpsertSession.mockReset();
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {},
      addBreadcrumb: () => {},
    });
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    outbox._resetForTesting();
    resetSessionMutexForTests();
    setErrorReporter({ captureException: () => {}, captureMessage: () => {}, addBreadcrumb: () => {} });
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
  });

  it('confirmed tombstone (SessionTombstonedError) → markSucceeded + clearSessionTrackers + quarantine snapshot', async () => {
    const session = buildSession();
    mockGetSession.mockResolvedValue(session);

    outbox.recordLastPushedSeq(session.id, 0);
    outbox.recordCloudUpdatedAt(session.id, 1_700_000_000_000);
    outbox.recordLastPushedMetadataDigest(session.id, 'digest-fingerprint');
    outbox.enqueue(session.id, 'upsert');

    const markSucceededSpy = vi.spyOn(outbox, 'markSucceeded');
    const markPermSpy = vi.spyOn(outbox, 'markPermanentlyFailed');

    const post = vi.fn().mockRejectedValue(new SessionTombstonedError());
    const client = makeClient({ post });

    await outbox.drain(client);

    expect(markSucceededSpy).toHaveBeenCalledWith(session.id, expect.any(Number));
    expect(markPermSpy).not.toHaveBeenCalled();
    // Trackers cleared after success.
    expect(outbox.getLastPushedSeq(session.id)).toBeUndefined();
    expect(outbox.getLastPushedMetadataDigest(session.id)).toBeUndefined();
    // Entry removed.
    expect(outbox.getAll()).toHaveLength(0);
    // Quarantine snapshot written.
    expect(fs.existsSync(QUARANTINE_PATH)).toBe(true);
    const quarantine = JSON.parse(fs.readFileSync(QUARANTINE_PATH, 'utf-8')) as Array<{
      sessionId: string;
      lastPushedSeq?: number;
      cloudUpdatedAt?: number;
      metadataDigest?: string;
      tombstonedAt: number;
    }>;
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0].sessionId).toBe(session.id);
    expect(quarantine[0].lastPushedSeq).toBe(0);
    expect(quarantine[0].cloudUpdatedAt).toBe(1_700_000_000_000);
    expect(quarantine[0].metadataDigest).toBe('digest-fingerprint');
    expect(typeof quarantine[0].tombstonedAt).toBe('number');
  });

  it('confirmed tombstone via { code: "session-tombstoned" } also clears + quarantines', async () => {
    const session = buildSession({ id: 'session-code-tomb' });
    mockGetSession.mockResolvedValue(session);
    outbox.recordLastPushedSeq(session.id, 0);
    outbox.enqueue(session.id, 'upsert');

    const err = Object.assign(new Error('Session is gone'), {
      statusCode: 410,
      code: 'session-tombstoned',
    });
    const post = vi.fn().mockRejectedValue(err);
    const client = makeClient({ post });

    await outbox.drain(client);

    expect(outbox.getAll()).toHaveLength(0);
    expect(fs.existsSync(QUARANTINE_PATH)).toBe(true);
  });

  it('quarantine LRU caps at 30 entries', async () => {
    fs.mkdirSync(OUTBOX_DIR, { recursive: true });
    // Pre-populate quarantine with 30 entries.
    const seeded = Array.from({ length: 30 }, (_, i) => ({
      sessionId: `seeded-${i}`,
      lastPushedSeq: i,
      cloudUpdatedAt: i,
      metadataDigest: `digest-${i}`,
      tombstonedAt: i,
    }));
    fs.writeFileSync(QUARANTINE_PATH, JSON.stringify(seeded));

    const session = buildSession({ id: 'session-lru-cap' });
    mockGetSession.mockResolvedValue(session);
    outbox.recordLastPushedSeq(session.id, 5);
    outbox.enqueue(session.id, 'upsert');

    const post = vi.fn().mockRejectedValue(new SessionTombstonedError());
    const client = makeClient({ post });

    await outbox.drain(client);

    const quarantine = JSON.parse(fs.readFileSync(QUARANTINE_PATH, 'utf-8')) as Array<{
      sessionId: string;
    }>;
    expect(quarantine).toHaveLength(30);
    // Newest entry is at index 0 (unshift).
    expect(quarantine[0].sessionId).toBe(session.id);
    // Oldest seeded entry (seeded-29) was evicted.
    expect(quarantine.some((q) => q.sessionId === 'seeded-29')).toBe(false);
  });

  it('status-only 410 (no structured proof) → markAttemptFailed (transient), NOT terminal', async () => {
    const session = buildSession({ id: 'session-flap-410' });
    mockGetSession.mockResolvedValue(session);
    outbox.recordLastPushedSeq(session.id, 0);
    outbox.enqueue(session.id, 'upsert');

    const markSucceededSpy = vi.spyOn(outbox, 'markSucceeded');
    const markPermSpy = vi.spyOn(outbox, 'markPermanentlyFailed');
    const markAttemptSpy = vi.spyOn(outbox, 'markAttemptFailed');

    const err = Object.assign(new Error('HTTP 410: gone'), { statusCode: 410 });
    const post = vi.fn().mockRejectedValue(err);
    const client = makeClient({ post });

    await outbox.drain(client);

    // Outer drain catches 410 as transient (no structured tombstone proof).
    expect(markPermSpy).not.toHaveBeenCalled();
    expect(markAttemptSpy).toHaveBeenCalledWith(session.id, expect.stringContaining('410'));
    // Entry stays pending with backoff.
    const all = outbox.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('pending');
    expect(all[0].attempts).toBeGreaterThanOrEqual(1);
    // No quarantine file written for transient errors.
    expect(fs.existsSync(QUARANTINE_PATH)).toBe(false);
    // markSucceeded called once at most for the drain accounting; it must NOT
    // have deleted the entry (status is still 'pending', not gone).
    if (markSucceededSpy.mock.calls.length > 0) {
      expect(outbox.getAll()).toHaveLength(1);
    }
  });

  it('413 BODY_TOO_LARGE → markPermanentlyFailed with terminalReason="body-too-large"', async () => {
    const session = buildSession({ id: 'session-too-large' });
    mockGetSession.mockResolvedValue(session);
    outbox.recordLastPushedSeq(session.id, 0);
    outbox.enqueue(session.id, 'upsert');

    const err = Object.assign(new Error('HTTP 413: BODY_TOO_LARGE'), {
      statusCode: 413,
      code: 'BODY_TOO_LARGE',
    });
    const post = vi.fn().mockRejectedValue(err);
    const client = makeClient({ post });

    await outbox.drain(client);

    const all = outbox.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('permanent_failure');
    expect(all[0].terminalReason).toBe('body-too-large');
  });
});

describe('CloudOutbox Stage A2 refinement — applyConfirmedTombstone centralization', () => {
  let outbox: CloudOutbox;

  beforeEach(() => {
    outbox = new CloudOutbox();
    mockGetSession.mockReset();
    mockUpsertSession.mockReset();
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {},
      addBreadcrumb: () => {},
    });
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    outbox._resetForTesting();
    resetSessionMutexForTests();
    setErrorReporter({ captureException: () => {}, captureMessage: () => {}, addBreadcrumb: () => {} });
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
  });

  it('happy path via drain catch: delivered=1, entry deleted, trackers cleared, quarantine + audit fire with proof shape', async () => {
    const session = buildSession({ id: 'session-happy' });
    mockGetSession.mockResolvedValue(session);
    outbox.recordLastPushedSeq(session.id, 0);
    outbox.recordCloudUpdatedAt(session.id, 1_700_000_000_000);
    outbox.recordLastPushedMetadataDigest(session.id, 'happy-digest');
    outbox.enqueue(session.id, 'upsert');

    const captureMessageSpy = vi.fn();
    // Stage 5 of 260610 improve-sentry-noise: tombstone-applied is a
    // ledger-only known condition - the per-call observable is the skip
    // breadcrumb (no Sentry capture goes out).
    const breadcrumbSpy = vi.fn();
    setErrorReporter({
      captureException: () => {},
      captureMessage: captureMessageSpy,
      addBreadcrumb: breadcrumbSpy,
    });

    const post = vi.fn().mockRejectedValue(new SessionTombstonedError());
    const client = makeClient({ post });

    const result = await outbox.drain(client);

    expect(result.ok).toBe(1);
    expect(result.failed).toBe(0);
    expect(outbox.getAll()).toHaveLength(0);
    expect(outbox.getLastPushedSeq(session.id)).toBeUndefined();
    expect(outbox.getLastPushedMetadataDigest(session.id)).toBeUndefined();
    expect(fs.existsSync(QUARANTINE_PATH)).toBe(true);

    expect(captureMessageSpy).not.toHaveBeenCalled();
    expect(breadcrumbSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'known_condition',
        message: 'cloud_sync_tombstone_applied',
        level: 'info',
        data: expect.objectContaining({
          proof: 'SessionTombstonedError',
          sessionIdHash: expect.any(String),
          cloudUpdatedAt: 1_700_000_000_000,
          lastPushedSeq: 0,
          sink: 'ledger-only',
        }),
      }),
    );
  });

  it('generation bump: entry preserved (pending), trackers preserved, NOT delivered, quarantine still snapshotted', async () => {
    const session = buildSession({ id: 'session-gen-bump' });
    mockGetSession.mockResolvedValue(session);
    outbox.recordLastPushedSeq(session.id, 0);
    outbox.recordCloudUpdatedAt(session.id, 1_700_000_000_000);
    outbox.recordLastPushedMetadataDigest(session.id, 'gen-bump-digest');
    outbox.enqueue(session.id, 'upsert');

    const entryBefore = outbox.getAll()[0];
    expect(entryBefore).toBeDefined();

    const post = vi.fn().mockImplementation(async () => {
      // Simulate concurrent in-process enqueue bumping generation mid-flight:
      // the drain captured drainExpectedGeneration pre-await, so
      // applyConfirmedTombstone sees the mismatch and preserves trackers.
      outbox.bumpEntryGeneration(entryBefore.id);
      throw new SessionTombstonedError();
    });
    const client = makeClient({ post });

    const result = await outbox.drain(client);

    expect(result.ok).toBe(0);
    expect(result.failed).toBe(0);

    const all = outbox.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('pending');
    expect(outbox.getLastPushedSeq(session.id)).toBe(0);
    expect(outbox.getLastPushedMetadataDigest(session.id)).toBe('gen-bump-digest');
    expect(fs.existsSync(QUARANTINE_PATH)).toBe(true);
  });

  it('quarantine write failure does not perturb drain: entry deleted, trackers cleared, delivered++', async () => {
    const session = buildSession({ id: 'session-quarantine-fail' });
    mockGetSession.mockResolvedValue(session);
    outbox.recordLastPushedSeq(session.id, 0);
    outbox.recordCloudUpdatedAt(session.id, 1_700_000_000_000);
    outbox.recordLastPushedMetadataDigest(session.id, 'quarantine-fail-digest');
    outbox.enqueue(session.id, 'upsert');

    const writeFileSpy = vi
      .spyOn(fs.promises, 'writeFile')
      .mockImplementation(async () => {
        throw new Error('ENOSPC: no space left on device');
      });

    try {
      const post = vi.fn().mockRejectedValue(new SessionTombstonedError());
      const client = makeClient({ post });

      const result = await outbox.drain(client);

      expect(result.ok).toBe(1);
      expect(result.failed).toBe(0);
      expect(outbox.getAll()).toHaveLength(0);
      expect(outbox.getLastPushedSeq(session.id)).toBeUndefined();
      expect(outbox.getLastPushedMetadataDigest(session.id)).toBeUndefined();
    } finally {
      writeFileSpy.mockRestore();
    }
  });

  it('preflight tombstone (seedCursorFromCloudIfPossible) routes through applyConfirmedTombstone', async () => {
    const session = buildSession({ id: 'session-preflight-tomb' });
    mockGetSession.mockResolvedValue(session);
    outbox.recordCloudUpdatedAt(session.id, 1_700_000_000_000);
    outbox.recordLastPushedMetadataDigest(session.id, 'preflight-digest');
    // lastPushedSeq INTENTIONALLY unset → executeDeltaUpsert hits preflight.
    outbox.enqueue(session.id, 'upsert');

    const captureMessageSpy = vi.fn();
    // Stage 5 of 260610 improve-sentry-noise: tombstone-applied is a
    // ledger-only known condition - the per-call observable is the skip
    // breadcrumb (no Sentry capture goes out).
    const breadcrumbSpy = vi.fn();
    setErrorReporter({
      captureException: () => {},
      captureMessage: captureMessageSpy,
      addBreadcrumb: breadcrumbSpy,
    });

    const get = vi.fn().mockRejectedValue(new SessionTombstonedError());
    const post = vi.fn();
    const client = makeClient({ get, post });

    const result = await outbox.drain(client);

    expect(get).toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(result.ok).toBe(1);
    expect(outbox.getAll()).toHaveLength(0);
    expect(outbox.getLastPushedMetadataDigest(session.id)).toBeUndefined();
    expect(fs.existsSync(QUARANTINE_PATH)).toBe(true);
    expect(captureMessageSpy).not.toHaveBeenCalled();
    expect(breadcrumbSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'known_condition',
        message: 'cloud_sync_tombstone_applied',
        level: 'info',
        data: expect.objectContaining({
          proof: 'SessionTombstonedError',
          sink: 'ledger-only',
        }),
      }),
    );
  });

  it('append-result tombstone ({ kind: "tombstoned" }) routes through applyConfirmedTombstone', async () => {
    const session = buildSession({ id: 'session-append-result-tomb' });
    mockGetSession.mockResolvedValue(session);
    outbox.recordLastPushedSeq(session.id, 0);
    outbox.recordCloudUpdatedAt(session.id, 1_700_000_000_000);
    outbox.recordLastPushedMetadataDigest(session.id, 'append-digest');
    outbox.enqueue(session.id, 'upsert');

    const captureMessageSpy = vi.fn();
    // Stage 5 of 260610 improve-sentry-noise: tombstone-applied is a
    // ledger-only known condition - the per-call observable is the skip
    // breadcrumb (no Sentry capture goes out).
    const breadcrumbSpy = vi.fn();
    setErrorReporter({
      captureException: () => {},
      captureMessage: captureMessageSpy,
      addBreadcrumb: breadcrumbSpy,
    });

    const appendSessionEvents = vi.fn().mockResolvedValue({
      kind: 'tombstoned',
      tombstone: {
        sessionId: session.id,
        deletedAt: 1,
        deletedBy: 'cloud',
        ttlExpiresAt: 2,
      },
    });
    const client = makeClient({ appendSessionEvents });

    const result = await outbox.drain(client);

    expect(appendSessionEvents).toHaveBeenCalled();
    expect(result.ok).toBe(1);
    expect(outbox.getAll()).toHaveLength(0);
    expect(outbox.getLastPushedSeq(session.id)).toBeUndefined();
    expect(outbox.getLastPushedMetadataDigest(session.id)).toBeUndefined();
    expect(fs.existsSync(QUARANTINE_PATH)).toBe(true);
    expect(captureMessageSpy).not.toHaveBeenCalled();
    expect(breadcrumbSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'known_condition',
        message: 'cloud_sync_tombstone_applied',
        level: 'info',
        data: expect.objectContaining({
          proof: 'response.body',
          sink: 'ledger-only',
        }),
      }),
    );
  });

  it('confirmed tombstone via responseBody shape (CloudClientError convention) routes through applyConfirmedTombstone', async () => {
    const session = buildSession({ id: 'session-responsebody-tomb' });
    mockGetSession.mockResolvedValue(session);
    outbox.recordLastPushedSeq(session.id, 0);
    outbox.recordCloudUpdatedAt(session.id, 1_700_000_000_000);
    outbox.enqueue(session.id, 'upsert');

    const captureMessageSpy = vi.fn();
    // Stage 5 of 260610 improve-sentry-noise: tombstone-applied is a
    // ledger-only known condition - the per-call observable is the skip
    // breadcrumb (no Sentry capture goes out).
    const breadcrumbSpy = vi.fn();
    setErrorReporter({
      captureException: () => {},
      captureMessage: captureMessageSpy,
      addBreadcrumb: breadcrumbSpy,
    });

    const err = Object.assign(new Error('HTTP 410: session gone'), {
      statusCode: 410,
      responseBody: {
        error: 'session-tombstoned',
        tombstone: { sessionId: session.id, deletedAt: 1, deletedBy: 'cloud', ttlExpiresAt: 2 },
      },
    });
    const post = vi.fn().mockRejectedValue(err);
    const client = makeClient({ post });

    const result = await outbox.drain(client);

    expect(result.ok).toBe(1);
    expect(outbox.getAll()).toHaveLength(0);
    expect(fs.existsSync(QUARANTINE_PATH)).toBe(true);
    expect(captureMessageSpy).not.toHaveBeenCalled();
    expect(breadcrumbSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'known_condition',
        message: 'cloud_sync_tombstone_applied',
        level: 'info',
        data: expect.objectContaining({
          proof: 'responseBody',
          sink: 'ledger-only',
        }),
      }),
    );
  });
});
