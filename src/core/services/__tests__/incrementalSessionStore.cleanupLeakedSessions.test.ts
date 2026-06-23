import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import { unionEventsByIdentity } from '@shared/utils/eventIdentity';
import type { AgentEvent, AgentSession, MemoryUpdateStatus, TimeSavedStatus } from '@shared/types';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-default',
    title: 'Test Session',
    createdAt: 1_000,
    updatedAt: 2_000,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  };
}

function makeMemoryStatus(overrides: Partial<MemoryUpdateStatus> = {}): MemoryUpdateStatus {
  return {
    originalTurnId: 'turn-default',
    originalSessionId: 'session-default',
    status: 'success',
    timestamp: 1_000,
    ...overrides,
  };
}

function makeTimeSavedStatus(overrides: Partial<TimeSavedStatus> = {}): TimeSavedStatus {
  return {
    turnId: 'turn-default',
    originalSessionId: 'session-default',
    status: 'success',
    timestamp: 1_000,
    ...overrides,
  };
}

let testDir = '';

function clearLoggerMocks(): void {
  Object.values(stubLogger).forEach((fn) => fn.mockClear());
}

async function createStore() {
  const { IncrementalSessionStore } = await import('../incrementalSessionStore');
  return new IncrementalSessionStore();
}

describe('IncrementalSessionStore Stage 2 cleanup', () => {
  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-cleanup-stage2-'));
    vi.resetModules();
     
    vi.doMock('@core/logger', () => ({
      createScopedLogger: () => stubLogger,
      logger: stubLogger,
    }));
    await initTestPlatformConfig({ userDataPath: testDir });
    clearLoggerMocks();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('hides 81 leaked sessions by default and removes them with cleanupLeakedSessions() across capped passes', async () => {
    const store = await createStore();
    const leakedSessions = Array.from({ length: 81 }, (_, index) =>
      makeSession({
        id: `memory-update-${String(index).padStart(3, '0')}`,
        title: `Leaked ${index}`,
        updatedAt: 10_000 + index,
      }),
    );

    store.saveSync(leakedSessions);

    expect(store.listSessions()).toHaveLength(0);
    expect(store.listSessions({ includeInternal: true })).toHaveLength(81);

    // Stage 2 (260612 recs-round5) cap-and-continue: each pass deletes at most
    // the bulk-removal bound (max(25, 1% of scanned) = 25 here) and converges
    // across startups instead of bulk-deleting an unbounded backlog in one go.
    const firstPass = await store.cleanupLeakedSessions();
    expect(firstPass.scanned).toBe(81);
    expect(firstPass.deleted).toBe(25);
    expect(firstPass.deferredBeyondCap).toBe(56);
    expect(firstPass.errors).toBe(0);
    expect(firstPass.sampleDeletedIds).toHaveLength(5);
    expect(store.isReadOnly()).toBe(false);

    let totalDeleted = firstPass.deleted;
    for (let pass = 0; pass < 3; pass++) {
      const summary = await store.cleanupLeakedSessions();
      expect(summary.deleted).toBeLessThanOrEqual(25);
      totalDeleted += summary.deleted;
    }
    expect(totalDeleted).toBe(81);
    expect(store.listSessions({ includeInternal: true })).toHaveLength(0);

    const sessionDirFiles = fs.readdirSync(path.join(testDir, 'sessions'));
    expect(sessionDirFiles.some((file) => file.startsWith('memory-update-'))).toBe(false);
  });

  it('prunes stale index entries when cleanup runs before any index load', async () => {
    const leakedId = 'memory-update-preload-index';
    const seedStore = await createStore();
    seedStore.saveSync([makeSession({ id: leakedId })]);

    // Fresh store instance: index is not loaded yet.
    const store = await createStore();
    const summary = await store.cleanupLeakedSessions();

    expect(summary.deleted).toBe(1);
    const ids = store.listSessions({ includeInternal: true }).map((session) => session.id);
    expect(ids).not.toContain(leakedId);

    const indexPath = path.join(testDir, 'sessions', 'index.json');
    const persistedIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
      sessions?: Array<{ id?: string }>;
    };
    expect(persistedIndex.sessions?.some((session) => session.id === leakedId)).toBe(false);
  });

  it('preserves compacted-session memory status entries when provenance matches the session', async () => {
    const sessionId = 'session-compacted';
    const seedStore = await createStore();
    seedStore.saveSync([
      makeSession({
        id: sessionId,
        eventsByTurn: {},
        memoryUpdateStatusByTurn: {
          'turn-kept': makeMemoryStatus({
            originalTurnId: 'turn-kept',
            originalSessionId: sessionId,
          }),
        },
      }),
    ]);

    clearLoggerMocks();
    const loadStore = await createStore();
    const [loaded] = loadStore.loadSync();

    expect(loaded.memoryUpdateStatusByTurn?.['turn-kept']).toBeDefined();
  });

  it('removes mismatched-provenance memory status entries', async () => {
    const sessionId = 'session-mismatch';
    const seedStore = await createStore();
    seedStore.saveSync([
      makeSession({
        id: sessionId,
        memoryUpdateStatusByTurn: {
          'turn-orphan': makeMemoryStatus({
            originalTurnId: 'turn-orphan',
            originalSessionId: 'other-session',
          }),
        },
      }),
    ]);

    clearLoggerMocks();
    const loadStore = await createStore();
    const [loaded] = loadStore.loadSync();

    expect(loaded.memoryUpdateStatusByTurn?.['turn-orphan']).toBeUndefined();
    const cleanupLog = stubLogger.info.mock.calls.find((call) =>
      call[1] === 'Removed orphan status entries with mismatched session provenance on hydration',
    );
    expect(cleanupLog?.[0]).toMatchObject({ sessionId, removedCount: 1 });
  });

  it('preserves legacy memory status entries with deduped debug logging', async () => {
    const sessionId = 'session-legacy-memory';
    const seedStore = await createStore();
    seedStore.saveSync([
      makeSession({
        id: sessionId,
        memoryUpdateStatusByTurn: {
          'turn-legacy': makeMemoryStatus({
            originalTurnId: 'turn-legacy',
            originalSessionId: undefined,
          }),
        },
      }),
    ]);

    clearLoggerMocks();
    const loadStore = await createStore();
    const [loaded] = loadStore.loadSync();

    expect(loaded.memoryUpdateStatusByTurn?.['turn-legacy']).toBeDefined();
    // First classification (initial createStore) already logged this session; the
    // per-session-per-process dedupe (Stage 6, perf-idle-churn) suppresses re-emission
    // on reload. Positive single-emit contract is pinned in incrementalSessionStore.test.ts.
    expect(stubLogger.debug).not.toHaveBeenCalledWith(
      expect.anything(),
      'Preserving legacy memory-update status entries missing originalSessionId',
    );
    expect(stubLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'Preserving legacy memory-update status entries missing originalSessionId',
    );
  });

  it('does not delete live-coach companion sessions without delete-eligible prefixes', async () => {
    const companionSessionId = 'companion-session-123';
    const store = await createStore();
    store.saveSync([makeSession({ id: companionSessionId })]);

    expect(store.listSessions()).toHaveLength(1);
    const summary = await store.cleanupLeakedSessions();

    expect(summary.deleted).toBe(0);
    expect(store.listSessions()).toHaveLength(1);
    expect(await store.sessionFileExists(companionSessionId)).toBe(true);
  });

  it('enqueues cloud tombstones via cleanup callback when leaked sessions are deleted', async () => {
    const leakedId = 'memory-update-tombstone';
    const outbox: string[] = [];
    const callbackSources: string[] = [];
    const store = await createStore();
    store.saveSync([makeSession({ id: leakedId })]);

    const summary = await store.cleanupLeakedSessions({
      onSessionDeletedLocally: (sessionId, metadata) => {
        outbox.push(sessionId);
        callbackSources.push(metadata.source);
      },
    });

    expect(summary.deleted).toBe(1);
    expect(outbox).toEqual([leakedId]);
    expect(callbackSources).toEqual(['cleanupLeakedSessions']);
  });

  it('keeps leaked session on disk when durable enqueue fails, then deletes on retry', async () => {
    const leakedId = 'memory-update-durable-retry';
    const callback = vi.fn(async () => {});
    let failOnce = true;
    const store = await createStore();
    store.saveSync([makeSession({ id: leakedId })]);

    callback.mockImplementation(async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error('Cloud outbox write not durable: disk full (code: ENOSPC)');
      }
    });

    const firstRun = await store.cleanupLeakedSessions({
      onSessionDeletedLocally: callback,
    });

    expect(firstRun.deleted).toBe(0);
    expect(firstRun.errors).toBe(1);
    expect(await store.sessionFileExists(leakedId)).toBe(true);

    const secondRun = await store.cleanupLeakedSessions({
      onSessionDeletedLocally: callback,
    });

    expect(secondRun.deleted).toBe(1);
    expect(secondRun.errors).toBe(0);
    expect(await store.sessionFileExists(leakedId)).toBe(false);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('deletes leaked error-eval sessions during cleanup', async () => {
    const leakedId = 'error-eval-123';
    const store = await createStore();
    store.saveSync([makeSession({ id: leakedId })]);

    const summary = await store.cleanupLeakedSessions();

    expect(summary.deleted).toBe(1);
    expect(await store.sessionFileExists(leakedId)).toBe(false);
  });

  it('is crash-consistent and idempotent across interrupted cleanup runs', async () => {
    const leakedIds = ['memory-update-a', 'memory-update-b', 'memory-update-c'];
    const outbox: string[] = [];
    const store = await createStore();
    store.saveSync(leakedIds.map((id) => makeSession({ id })));

    const originalDeleteSession = store.deleteSession.bind(store);
    let injectedFailure = false;
    const deleteSpy = vi.spyOn(store, 'deleteSession').mockImplementation(async (id: string) => {
      if (id === 'memory-update-b' && !injectedFailure) {
        injectedFailure = true;
        throw new Error('simulated cleanup interruption');
      }
      return originalDeleteSession(id, { intent: 'hygiene' });
    });

    const firstRun = await store.cleanupLeakedSessions({
      onSessionDeletedLocally: (sessionId) => {
        outbox.push(sessionId);
      },
    });
    deleteSpy.mockRestore();

    expect(firstRun.deleted).toBe(2);
    expect(firstRun.errors).toBe(1);

    const secondRun = await store.cleanupLeakedSessions({
      onSessionDeletedLocally: (sessionId) => {
        outbox.push(sessionId);
      },
    });

    expect(secondRun.deleted).toBe(1);
    expect(secondRun.errors).toBe(0);
    expect(store.listSessions({ includeInternal: true })).toHaveLength(0);
    expect(new Set(outbox)).toEqual(new Set(leakedIds));
    expect(outbox.filter((id) => id === 'memory-update-b')).toHaveLength(2);
  });

  it('prevents resurrection when cloud pull races with cleanup and tombstones are respected', async () => {
    const firstLeakedId = 'memory-update-a';
    const secondLeakedId = 'memory-update-b';
    const tombstones = new Set<string>();
    const store = await createStore();
    store.saveSync([
      makeSession({ id: firstLeakedId }),
      makeSession({ id: secondLeakedId }),
    ]);

    const originalDeleteSession = store.deleteSession.bind(store);
    let releaseSecondDelete: () => void = () => {};
    const secondDeleteGate = new Promise<void>((resolve) => {
      releaseSecondDelete = resolve;
    });
    let secondDeleteStarted: () => void = () => {};
    const secondDeleteStartedPromise = new Promise<void>((resolve) => {
      secondDeleteStarted = resolve;
    });

    const deleteSpy = vi.spyOn(store, 'deleteSession').mockImplementation(async (id: string) => {
      if (id === secondLeakedId) {
        secondDeleteStarted();
        await secondDeleteGate;
      }
      return originalDeleteSession(id, { intent: 'hygiene' });
    });

    const cleanupPromise = store.cleanupLeakedSessions({
      onSessionDeletedLocally: (sessionId) => {
        tombstones.add(sessionId);
      },
    });

    await secondDeleteStartedPromise;
    const cloudPullResult = await (async () => {
      if (tombstones.has(firstLeakedId)) {
        return 'skipped';
      }
      await store.upsertSession(makeSession({ id: firstLeakedId, title: 'resurrected' }));
      return 'upserted';
    })();

    releaseSecondDelete();
    await cleanupPromise;
    deleteSpy.mockRestore();

    expect(cloudPullResult).toBe('skipped');
    expect(await store.sessionFileExists(firstLeakedId)).toBe(false);
    expect(store.listSessions({ includeInternal: true })).toHaveLength(0);
  });

  it('handles in-flight upgrade behavior when buffered events exist but disk state is gone', async () => {
    const leakedId = 'memory-update-upgrade';
    const store = await createStore();
    store.saveSync([makeSession({ id: leakedId })]);

    await store.cleanupLeakedSessions();
    const diskSession = await store.getSession(leakedId);
    expect(diskSession).toBeNull();

    const bufferedEvents = [
      { type: 'assistant', timestamp: 1_234 } as unknown as AgentEvent,
    ];
    expect(() => unionEventsByIdentity('turn-upgrade', [], bufferedEvents)).not.toThrow();
    expect(unionEventsByIdentity('turn-upgrade', [], bufferedEvents)).toHaveLength(1);
  });

  it('surfaces non-ENOENT fs.access failures as cleanup errors', async () => {
    const leakedId = 'memory-update-access-error';
    const store = await createStore();
    store.saveSync([makeSession({ id: leakedId })]);

    const accessSpy = vi.spyOn(fs.promises, 'access').mockImplementationOnce(async () => {
      const err = new Error('permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });

    const summary = await store.cleanupLeakedSessions();
    accessSpy.mockRestore();

    expect(summary.deleted).toBe(0);
    expect(summary.errors).toBe(1);
    expect(await store.sessionFileExists(leakedId)).toBe(true);
  });

  it('reuses the same in-flight promise for concurrent cleanup calls', async () => {
    const leakedId = 'memory-update-concurrent';
    const callbackCalls: string[] = [];
    const store = await createStore();
    store.saveSync([makeSession({ id: leakedId })]);

    const originalDeleteSession = store.deleteSession.bind(store);
    let releaseDelete: () => void = () => {};
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });

    const deleteSpy = vi.spyOn(store, 'deleteSession').mockImplementation(async (sessionId: string) => {
      await deleteGate;
      return originalDeleteSession(sessionId, { intent: 'hygiene' });
    });

    const firstPromise = store.cleanupLeakedSessions({
      onSessionDeletedLocally: (sessionId) => {
        callbackCalls.push(`first:${sessionId}`);
      },
    });
    const secondPromise = store.cleanupLeakedSessions({
      onSessionDeletedLocally: (sessionId) => {
        callbackCalls.push(`second:${sessionId}`);
      },
    });

    releaseDelete();
    const [firstSummary, secondSummary] = await Promise.all([firstPromise, secondPromise]);
    deleteSpy.mockRestore();

    expect(firstSummary).toEqual(secondSummary);
    expect(callbackCalls).toEqual([`first:${leakedId}`]);
  });

  it('applies orphan cleanup rules to timeSavedStatusByTurn (orphan removed, legacy preserved, matching kept)', async () => {
    const sessionId = 'session-time-saved';
    const seedStore = await createStore();
    seedStore.saveSync([
      makeSession({
        id: sessionId,
        timeSavedStatusByTurn: {
          'turn-orphan': makeTimeSavedStatus({
            turnId: 'turn-orphan',
            originalSessionId: 'other-session',
          }),
          'turn-legacy': makeTimeSavedStatus({
            turnId: 'turn-legacy',
            originalSessionId: undefined,
          }),
          'turn-matching': makeTimeSavedStatus({
            turnId: 'turn-matching',
            originalSessionId: sessionId,
          }),
        },
      }),
    ]);

    clearLoggerMocks();
    const loadStore = await createStore();
    const [loaded] = loadStore.loadSync();

    expect(loaded.timeSavedStatusByTurn?.['turn-orphan']).toBeUndefined();
    expect(loaded.timeSavedStatusByTurn?.['turn-legacy']).toBeDefined();
    expect(loaded.timeSavedStatusByTurn?.['turn-matching']).toBeDefined();
    // Deduped on reload — see Stage 6 (perf-idle-churn); positive emit pinned elsewhere.
    expect(stubLogger.debug).not.toHaveBeenCalledWith(
      expect.anything(),
      'Preserving legacy time-saved status entries missing originalSessionId',
    );
    expect(stubLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'Preserving legacy time-saved status entries missing originalSessionId',
    );
  });
});
