import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@shared/types';
import type { IncrementalSessionStore } from '@core/services/incrementalSessionStore';
import { LockAcquireTimeout, type SessionLockManager } from '@core/utils/sessionFileLock';
import { agentTurnRegistry } from '../agentTurnRegistry';
import { persistSessionFromCli } from '../persistSessionFromCli';

describe('persistSessionFromCli', () => {
  const trackedTurns = new Set<string>();

  afterEach(() => {
    for (const turnId of trackedTurns) {
      agentTurnRegistry.cleanupTurn(turnId);
    }
    trackedTurns.clear();
    vi.restoreAllMocks();
  });

  it('persists the built snapshot and invokes both callbacks', async () => {
    const { turnId, sessionId } = seedAccumulator('happy marker');
    const persisted: AgentSession[] = [];
    const store = makeStore({
      getSession: vi.fn().mockResolvedValue(undefined),
      upsertSessionsSyncWithReload: vi.fn((sessions: AgentSession[]) => {
        persisted.push(...sessions);
        return {
          outcome: 'persisted',
          persistedSessionIds: sessions.map((session) => session.id),
          droppedTombstonedSessionIds: [],
        };
      }),
    });
    const onSessionsSaved = vi.fn();
    const onSessionsSavedLocally = vi.fn();

    const result = await persistSessionFromCli({
      turnId,
      sessionId,
      store,
      lockManager: makeLockManager(),
      ownerKind: 'cli',
      onSessionsSaved,
      onSessionsSavedLocally,
    });

    expect(result).toHaveProperty('persistedSession');
    expect(persisted).toHaveLength(1);
    expect(persisted[0].messages.some((message) => message.text === 'happy marker')).toBe(true);
    expect(onSessionsSaved).toHaveBeenCalledWith(persisted);
    expect(onSessionsSavedLocally).toHaveBeenCalledWith(persisted);
  });

  it('returns session_modified_externally when updatedAt advances inside the lock', async () => {
    const { turnId, sessionId } = seedAccumulator('race marker');
    const initial = makeSession(sessionId, 100, 1);
    const advanced = makeSession(sessionId, 200, 3);
    const store = makeStore({
      getSession: vi.fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(advanced),
      upsertSessionsSyncWithReload: vi.fn(),
    });

    const result = await persistSessionFromCli({
      turnId,
      sessionId,
      store,
      lockManager: makeLockManager(),
      ownerKind: 'cli',
    });

    expect(result).toEqual({
      kind: 'session_modified_externally',
      sessionId,
      expectedUpdatedAt: 100,
      currentUpdatedAt: 200,
      currentMessageCount: 3,
      deltaMessages: 2,
    });
    expect(store.upsertSessionsSyncWithReload).not.toHaveBeenCalled();
  });

  it('does not roll back the persist when a callback fails', async () => {
    const { turnId, sessionId } = seedAccumulator('callback marker');
    const store = makeStore({
      getSession: vi.fn().mockResolvedValue(undefined),
      upsertSessionsSyncWithReload: vi.fn(() => ({
        outcome: 'persisted',
        persistedSessionIds: [sessionId],
        droppedTombstonedSessionIds: [],
      })),
    });

    await expect(persistSessionFromCli({
      turnId,
      sessionId,
      store,
      lockManager: makeLockManager(),
      ownerKind: 'cli',
      onSessionsSaved: vi.fn(() => {
        throw new Error('index failed');
      }),
      onSessionsSavedLocally: vi.fn(),
    })).resolves.toHaveProperty('persistedSession');

    expect(store.upsertSessionsSyncWithReload).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Final-review fix round (F1): the CLI persist path must consume the
  // discriminated store outcome — a dropped write must NOT fire callbacks or
  // report { persistedSession } (false success).
  // -------------------------------------------------------------------------

  // RED-FIRST: pre-fix, persistSessionFromCli ignored the outcome and returned
  // success + fired both callbacks even when the store dropped the write.
  it('RED-FIRST: returns session_persist_dropped (no callbacks) when the store drops the write as tombstoned', async () => {
    const { turnId, sessionId } = seedAccumulator('tombstoned marker');
    const store = makeStore({
      getSession: vi.fn().mockResolvedValue(undefined), // chokepoint hides the tombstoned id
      upsertSessionsSyncWithReload: vi.fn(() => ({
        outcome: 'all-dropped-tombstoned',
        droppedTombstonedSessionIds: [sessionId],
      })),
    });
    const onSessionsSaved = vi.fn();
    const onSessionsSavedLocally = vi.fn();

    const result = await persistSessionFromCli({
      turnId,
      sessionId,
      store,
      lockManager: makeLockManager(),
      ownerKind: 'cli',
      onSessionsSaved,
      onSessionsSavedLocally,
    });

    expect(result).toEqual({
      kind: 'session_persist_dropped',
      sessionId,
      reason: 'tombstoned',
    });
    expect(result).not.toHaveProperty('persistedSession');
    expect(onSessionsSaved).not.toHaveBeenCalled();
    expect(onSessionsSavedLocally).not.toHaveBeenCalled();
  });

  it.each([
    ['read-only'],
    ['corrupt-index-unrecoverable'],
    ['version-forward-index'],
  ] as const)('RED-FIRST: returns session_persist_dropped (no callbacks) when the store drops the whole batch (%s)', async (reason) => {
    const { turnId, sessionId } = seedAccumulator(`dropped ${reason}`);
    const store = makeStore({
      getSession: vi.fn().mockResolvedValue(undefined),
      upsertSessionsSyncWithReload: vi.fn(() => ({ outcome: 'dropped', reason })),
    });
    const onSessionsSaved = vi.fn();

    const result = await persistSessionFromCli({
      turnId,
      sessionId,
      store,
      lockManager: makeLockManager(),
      ownerKind: 'cli',
      onSessionsSaved,
    });

    expect(result).toEqual({ kind: 'session_persist_dropped', sessionId, reason });
    expect(onSessionsSaved).not.toHaveBeenCalled();
  });

  it('INTEGRATION (real store): persisting a CLI snapshot for a hard-deleted id is dropped — no file, no callbacks, observable result', async () => {
    const fsMod = await import('node:fs');
    const osMod = await import('node:os');
    const pathMod = await import('node:path');
    const testDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'cli-persist-tombstoned-'));
    try {
      const { initTestPlatformConfig } = await import('@core/__tests__/testHelpers');
      await initTestPlatformConfig({ userDataPath: testDir });
      const { IncrementalSessionStore } = await import('@core/services/incrementalSessionStore');
      const realStore = new IncrementalSessionStore();

      const { turnId, sessionId } = seedAccumulator('real tombstone');
      await realStore.upsertSession(makeSession(sessionId, 100, 1));
      await realStore.deleteSession(sessionId, { intent: 'user-delete' });

      const onSessionsSaved = vi.fn();
      const result = await persistSessionFromCli({
        turnId,
        sessionId,
        store: realStore,
        lockManager: makeLockManager(),
        ownerKind: 'cli',
        onSessionsSaved,
      });

      expect(result).toEqual({ kind: 'session_persist_dropped', sessionId, reason: 'tombstoned' });
      expect(onSessionsSaved).not.toHaveBeenCalled();
      expect(await realStore.sessionFileExists(sessionId)).toBe(false);
    } finally {
      fsMod.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('RED-FIRST: returns session_persist_contention when the per-session lock acquire times out', async () => {
    const { turnId, sessionId } = seedAccumulator('per-session contention');
    const store = makeStore({
      getSession: vi.fn().mockResolvedValue(undefined),
      upsertSessionsSyncWithReload: vi.fn(),
    });
    const onSessionsSaved = vi.fn();
    const onSessionsSavedLocally = vi.fn();
    const lockManager = makeLockManager({
      acquirePerSession: vi.fn().mockRejectedValue(new LockAcquireTimeout({
        lockPath: 'session.lock',
        existingPid: 1234,
        ageMs: 5010,
      })),
    });

    const result = await persistSessionFromCli({
      turnId,
      sessionId,
      store,
      lockManager,
      ownerKind: 'cli',
      onSessionsSaved,
      onSessionsSavedLocally,
    });

    expect(result).toEqual({
      kind: 'session_persist_contention',
      sessionId,
      lockPath: 'session.lock',
      existingPid: 1234,
      ageMs: 5010,
    });
    expect(result).not.toHaveProperty('persistedSession');
    expect(store.upsertSessionsSyncWithReload).not.toHaveBeenCalled();
    expect(onSessionsSaved).not.toHaveBeenCalled();
    expect(onSessionsSavedLocally).not.toHaveBeenCalled();
  });

  it('RED-FIRST: returns session_persist_contention and releases the per-session lock when the global-index lock acquire times out', async () => {
    const { turnId, sessionId } = seedAccumulator('global-index contention');
    const store = makeStore({
      getSession: vi.fn().mockResolvedValue(undefined),
      upsertSessionsSyncWithReload: vi.fn(),
    });
    const releasePerSession = vi.fn(async () => undefined);
    const onSessionsSaved = vi.fn();
    const lockManager = makeLockManager({
      acquirePerSession: vi.fn(async () => ({ release: releasePerSession })),
      acquireGlobalIndex: vi.fn().mockRejectedValue(new LockAcquireTimeout({
        lockPath: 'index.lock',
        existingPid: 4321,
        ageMs: 5005,
      })),
    });

    const result = await persistSessionFromCli({
      turnId,
      sessionId,
      store,
      lockManager,
      ownerKind: 'cli',
      onSessionsSaved,
    });

    expect(result).toEqual({
      kind: 'session_persist_contention',
      sessionId,
      lockPath: 'index.lock',
      existingPid: 4321,
      ageMs: 5005,
    });
    expect(releasePerSession).toHaveBeenCalledTimes(1);
    expect(store.upsertSessionsSyncWithReload).not.toHaveBeenCalled();
    expect(onSessionsSaved).not.toHaveBeenCalled();
  });

  it('passes the CLI lock acquire budget to both lock acquire sites', async () => {
    const { turnId, sessionId } = seedAccumulator('budget marker');
    const store = makeStore({
      getSession: vi.fn().mockResolvedValue(undefined),
      upsertSessionsSyncWithReload: vi.fn((sessions: AgentSession[]) => ({
        outcome: 'persisted',
        persistedSessionIds: sessions.map((session) => session.id),
        droppedTombstonedSessionIds: [],
      })),
    });
    const lockManager = makeLockManager();

    await expect(persistSessionFromCli({
      turnId,
      sessionId,
      store,
      lockManager,
      ownerKind: 'cli',
    })).resolves.toHaveProperty('persistedSession');

    expect(lockManager.acquirePerSession).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ maxRetryMs: 5_000 }),
    );
    expect(lockManager.acquireGlobalIndex).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetryMs: 5_000 }),
    );
  });

  it('propagates non-timeout lock acquisition failures', async () => {
    const { turnId, sessionId } = seedAccumulator('lock marker');
    const store = makeStore({
      getSession: vi.fn().mockResolvedValue(undefined),
      upsertSessionsSyncWithReload: vi.fn(),
    });
    const lockManager = makeLockManager({
      acquirePerSession: vi.fn().mockRejectedValue(new Error('lock unavailable')),
    });

    await expect(persistSessionFromCli({
      turnId,
      sessionId,
      store,
      lockManager,
      ownerKind: 'cli',
    })).rejects.toThrow('lock unavailable');
    expect(store.upsertSessionsSyncWithReload).not.toHaveBeenCalled();
  });

  function seedAccumulator(prompt: string): { turnId: string; sessionId: string } {
    const turnId = `turn-${prompt.replace(/\W+/g, '-')}`;
    const sessionId = `session-${prompt.replace(/\W+/g, '-')}`;
    trackedTurns.add(turnId);
    agentTurnRegistry.setTurnPrompt(turnId, prompt);
    const accumulator = agentTurnRegistry.getOrCreateAccumulator(turnId, sessionId);
    accumulator.appendEvent({ type: 'turn_started', timestamp: 1_000 }, sessionId);
    accumulator.appendEvent({ type: 'result', text: `result ${prompt}`, timestamp: 1_100 }, sessionId);
    return { turnId, sessionId };
  }
});

function makeStore(overrides: {
  getSession: ReturnType<typeof vi.fn>;
  upsertSessionsSyncWithReload: ReturnType<typeof vi.fn>;
}): IncrementalSessionStore {
  return overrides as unknown as IncrementalSessionStore;
}

function makeLockManager(overrides: Partial<SessionLockManager> = {}): SessionLockManager {
  const release = vi.fn(async () => undefined);
  const releaseSync = vi.fn(() => undefined);
  return {
    acquirePerSession: vi.fn(async () => ({ release })),
    acquireGlobalIndex: vi.fn(async () => ({ release })),
    acquirePerSessionSync: vi.fn(() => ({ release: releaseSync })),
    acquireGlobalIndexSync: vi.fn(() => ({ release: releaseSync })),
    ...overrides,
  };
}

function makeSession(id: string, updatedAt: number, messageCount: number): AgentSession {
  return {
    id,
    title: 'Session',
    createdAt: 1,
    updatedAt,
    messages: Array.from({ length: messageCount }, (_, index) => ({
      id: `message-${index}`,
      turnId: `turn-${index}`,
      role: 'user' as const,
      text: `message ${index}`,
      createdAt: index + 1,
    })),
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
  };
}
