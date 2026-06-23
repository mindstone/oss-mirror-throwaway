import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import type { AgentSession } from '@shared/types';
import type { SessionLockManager } from '@core/utils/sessionFileLock';

describe('CLI session persistence stress', () => {
  let tempDir: string;
  let trackedTurns: Set<string>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-persist-stress-'));
    await initTestPlatformConfig({ userDataPath: tempDir });
    trackedTurns = new Set();
  });

  afterEach(async () => {
    const { agentTurnRegistry } = await import('../services/agentTurnRegistry');
    for (const turnId of trackedTurns) {
      agentTurnRegistry.cleanupTurn(turnId);
    }
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('allows one winner for 50 concurrent writes to the same session without corrupting index.json', async () => {
    const { persistSessionFromCli } = await import('../services/persistSessionFromCli');
    const { getIncrementalSessionStore } = await import('../services/incrementalSessionStore');
    const { createSessionLockManager, defaultIsProcessAlive } = await import('@core/utils/sessionFileLock');
    const store = getIncrementalSessionStore();
    const lockManager = createSessionLockManager({
      locksDirectory: path.join(tempDir, 'sessions-locks'),
      isProcessAlive: defaultIsProcessAlive,
      now: Date.now,
    });
    const sessionId = 'stress-same-session';
    const markers = Array.from({ length: 50 }, (_, index) => `same-marker-${index}`);
    const turnIds = await Promise.all(markers.map((marker) => seedTurn(sessionId, marker)));

    const results = await Promise.all(turnIds.map((turnId) =>
      persistSessionFromCli({
        turnId,
        sessionId,
        store,
        lockManager: withStressRetryBudget(lockManager),
        ownerKind: 'cli',
      })
    ));

    const wins = results.filter((result): result is { persistedSession: AgentSession } => 'persistedSession' in result);
    const conflicts = results.filter((result) => 'kind' in result && result.kind === 'session_modified_externally');
    expect(wins).toHaveLength(1);
    expect(conflicts).toHaveLength(49);

    const winningSnapshot = wins[0].persistedSession;
    const winningSnapshotText = collectSessionText(winningSnapshot);
    const winningSnapshotMarkers = markers.filter((m) => winningSnapshotText.includes(m));
    expect(winningSnapshotMarkers).toHaveLength(1);
    const winningMarker = winningSnapshotMarkers[0];

    const index = await readIndex();
    expect(index.sessions.filter((session: { id: string }) => session.id === sessionId)).toHaveLength(1);
    const persisted = await store.getSession(sessionId);
    expect(persisted).not.toBeNull();
    const text = collectSessionText(persisted as AgentSession);
    const persistedMarkers = markers.filter((marker) => text.includes(marker));
    expect(persistedMarkers).toHaveLength(1);
    expect(persistedMarkers[0]).toBe(winningMarker);
  });

  it('persists 50 concurrent writes to different sessions without losing index entries', async () => {
    const { persistSessionFromCli } = await import('../services/persistSessionFromCli');
    const { getIncrementalSessionStore } = await import('../services/incrementalSessionStore');
    const { createSessionLockManager, defaultIsProcessAlive } = await import('@core/utils/sessionFileLock');
    const store = getIncrementalSessionStore();
    const lockManager = createSessionLockManager({
      locksDirectory: path.join(tempDir, 'sessions-locks'),
      isProcessAlive: defaultIsProcessAlive,
      now: Date.now,
    });
    const cases = await Promise.all(Array.from({ length: 50 }, async (_, index) => {
      const sessionId = `stress-different-${index}`;
      const marker = `different-marker-${index}`;
      const turnId = await seedTurn(sessionId, marker);
      return { sessionId, marker, turnId };
    }));

    const results = await Promise.all(cases.map((entry) =>
      persistSessionFromCli({
        turnId: entry.turnId,
        sessionId: entry.sessionId,
        store,
        lockManager: withStressRetryBudget(lockManager),
        ownerKind: 'cli',
      })
    ));

    expect(results.every((result) => 'persistedSession' in result)).toBe(true);
    const index = await readIndex();
    expect(index.sessions).toHaveLength(50);
    for (const entry of cases) {
      expect(index.sessions.some((session: { id: string }) => session.id === entry.sessionId)).toBe(true);
      const persisted = await store.getSession(entry.sessionId);
      expect(persisted).not.toBeNull();
      expect(collectSessionText(persisted as AgentSession)).toContain(entry.marker);
    }
  });

  it('preserves concurrent CLI, checkpoint, and memory status writes to the same session', async () => {
     
    vi.doMock('../ipc/utils/registerHandler', () => ({ registerHandler: vi.fn() }));

    const { persistSessionFromCli } = await import('../services/persistSessionFromCli');
    const { getIncrementalSessionStore } = await import('../services/incrementalSessionStore');
    const { TurnCheckpointManager } = await import('@core/services/turnCheckpointService');
    const {
      applyMemoryUpdateStatusToSession,
      registerMemoryHandlers,
    } = await import('../ipc/memoryHandlers');
    const { createSessionLockManager, defaultIsProcessAlive } = await import('@core/utils/sessionFileLock');
    const store = getIncrementalSessionStore();
    const baseLockManager = withStressRetryBudget(createSessionLockManager({
      locksDirectory: path.join(tempDir, 'sessions-locks'),
      isProcessAlive: defaultIsProcessAlive,
      now: Date.now,
    }));
    const sessionId = 'stress-three-paths';
    const cliTurnId = await seedTurn(sessionId, 'cli-path-marker');

    let cliPerSessionAcquired!: () => void;
    let allowCliIndexLock!: () => void;
    const cliPerSessionAcquiredPromise = new Promise<void>((resolve) => {
      cliPerSessionAcquired = resolve;
    });
    const allowCliIndexLockPromise = new Promise<void>((resolve) => {
      allowCliIndexLock = resolve;
    });
    const cliLockManager: SessionLockManager = {
      ...baseLockManager,
      acquirePerSession: async (id, opts) => {
        const handle = await baseLockManager.acquirePerSession(id, opts);
        cliPerSessionAcquired();
        return handle;
      },
      acquireGlobalIndex: async (opts) => {
        await allowCliIndexLockPromise;
        return baseLockManager.acquireGlobalIndex(opts);
      },
    };

    const cliWrite = persistSessionFromCli({
      turnId: cliTurnId,
      sessionId,
      store,
      lockManager: cliLockManager,
      ownerKind: 'cli',
    });

    await cliPerSessionAcquiredPromise;

    const checkpointManager = new TurnCheckpointManager({
      store,
      lockManager: baseLockManager,
      ownerKind: 'desktop',
      getAccumulator: () => undefined,
      intervalMs: 60_000,
    });
    const checkpointWrite = checkpointManager.checkpointTerminal(
      'turn-checkpoint',
      sessionId,
      {
        messages: [{
          id: 'msg-checkpoint',
          turnId: 'turn-checkpoint',
          role: 'assistant',
          text: 'checkpoint-path-marker',
          createdAt: Date.now(),
        }],
        eventsByTurn: {
          'turn-checkpoint': [{
            type: 'status',
            message: 'checkpoint-path-marker',
            timestamp: Date.now(),
          }],
        },
        activeTurnId: 'turn-checkpoint',
        focusedTurnId: null,
        isBusy: true,
        lastError: null,
        lastErrorSource: null,
        terminatedTurnIds: new Set(),
      },
    );

    registerMemoryHandlers({
      sessionLockManager: baseLockManager,
      sessionLockOwnerKind: 'desktop',
    });
    const memoryWrite = applyMemoryUpdateStatusToSession({
      sessionId,
      turnId: 'turn-memory',
      status: {
        originalTurnId: 'turn-memory',
        originalSessionId: sessionId,
        status: 'success',
        summary: 'memory-path-marker',
        timestamp: Date.now(),
      },
    });

    allowCliIndexLock();

    const [cliResult, memoryResult] = await Promise.all([
      cliWrite,
      memoryWrite,
      checkpointWrite,
    ]);

    expect('persistedSession' in cliResult).toBe(true);
    expect(memoryResult).toEqual({ ok: true });

    const persisted = await store.getSession(sessionId);
    expect(persisted).not.toBeNull();
    const text = collectSessionText(persisted as AgentSession);
    expect(text).toContain('cli-path-marker');
    expect(text).toContain('checkpoint-path-marker');
    expect((persisted as AgentSession).memoryUpdateStatusByTurn?.['turn-memory']?.summary).toBe(
      'memory-path-marker',
    );
    const index = await readIndex();
    expect(index.sessions.filter((session: { id: string }) => session.id === sessionId)).toHaveLength(1);
  });

  async function seedTurn(sessionId: string, marker: string): Promise<string> {
    const { agentTurnRegistry } = await import('../services/agentTurnRegistry');
    const turnId = `turn-${marker}`;
    trackedTurns.add(turnId);
    agentTurnRegistry.setTurnPrompt(turnId, `Prompt ${marker}`);
    const accumulator = agentTurnRegistry.getOrCreateAccumulator(turnId, sessionId);
    accumulator.appendEvent({ type: 'turn_started', timestamp: Date.now() }, sessionId);
    accumulator.appendEvent({ type: 'result', text: `Result ${marker}`, timestamp: Date.now() + 1 }, sessionId);
    return turnId;
  }

  async function readIndex(): Promise<{ sessions: Array<{ id: string }> }> {
    const raw = await fs.readFile(path.join(tempDir, 'sessions', 'index.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: number; sessions?: unknown };
    expect(typeof parsed.version).toBe('number');
    expect(Array.isArray(parsed.sessions)).toBe(true);
    return parsed as { sessions: Array<{ id: string }> };
  }
});

function withStressRetryBudget(lockManager: SessionLockManager): SessionLockManager {
  const maxRetryMs = 10_000;
  return {
    ...lockManager,
    acquirePerSession: (sessionId, opts) =>
      lockManager.acquirePerSession(sessionId, { ...opts, maxRetryMs }),
    acquireGlobalIndex: (opts) =>
      lockManager.acquireGlobalIndex({ ...opts, maxRetryMs }),
  };
}

function collectSessionText(session: AgentSession): string {
  return [
    ...session.messages.map((message) => message.text),
    ...Object.values(session.eventsByTurn).flat().map((event) => JSON.stringify(event)),
  ].join('\n');
}
