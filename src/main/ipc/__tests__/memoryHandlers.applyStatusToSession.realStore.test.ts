import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import type { AgentSession, MemoryUpdateStatus } from '@shared/types';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock();
});

vi.mock('@core/services/fileLocation', () => ({
  resolveFileLocation: vi.fn(),
  FileLocationResolverError: class FileLocationResolverError extends Error {
    readonly code: string;
    readonly inputPath: string;

    constructor(code: string, inputPath: string, message: string) {
      super(message);
      this.name = 'FileLocationResolverError';
      this.code = code;
      this.inputPath = inputPath;
    }
  },
}));

vi.mock('../../services/memoryHistoryStore', () => ({
  getMemoryHistory: vi.fn().mockReturnValue([]),
  getMemoryStats: vi.fn().mockReturnValue({ total: 0, bySpace: [] }),
  getMemoryHistoryEntry: vi.fn().mockReturnValue(null),
  removeMemoryHistoryEntry: vi.fn(),
  repairStaleFilePathsIfNeeded: vi.fn().mockResolvedValue({ repaired: 0, totalScanned: 0, skipped: true }),
  repairMemoryHistoryEntryPath: vi.fn().mockReturnValue(true),
}));

vi.mock('../../services/safety', () => ({
  getPendingMemoryApprovals: vi.fn().mockReturnValue([]),
  handleMemoryWriteApprovalResponse: vi.fn(),
  removePendingMemoryApproval: vi.fn(),
}));

vi.mock('../../services/spaceService', () => ({
  scanSpaces: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../services/safety/cosPendingService', () => ({
  listPendingFiles: vi.fn().mockResolvedValue([]),
  getPendingFile: vi.fn(),
  getPendingContent: vi.fn(),
  publishPendingFile: vi.fn(),
  deletePendingFile: vi.fn(),
  keepPendingFilePrivate: vi.fn(),
  publishWithConflictResolution: vi.fn(),
  detectPendingConflict: vi.fn().mockResolvedValue({
    hasConflict: false,
    fileModifiedSinceStaging: false,
    newFileConflict: false,
  }),
  canonicalizePath: (value: string) => value,
}));

vi.mock('../../services/meetingBot/transcriptEventBus', () => ({
  emitDeferredTranscriptSaved: vi.fn().mockReturnValue(false),
  emitTranscriptSavedFromMeta: vi.fn(),
  removeDeferredTranscriptSaved: vi.fn(),
}));

vi.mock('../../settingsStore', () => ({
  getSettings: () => ({ coreDirectory: '/workspace' }),
}));

vi.mock('../utils/registerHandler', () => ({
  registerHandler: vi.fn(),
}));

vi.mock('../../services/safety/automationPendingItemsTracker', () => ({
  resolveItem: vi.fn(),
}));

vi.mock('../../services/safety/automationContextLookup', () => ({
  getAutomationContext: vi.fn().mockReturnValue(null),
}));

vi.mock('../../services/sharedSkillMutationService', () => ({
  sharedSkillMutationService: {
    classifySharedSkillPath: vi.fn().mockResolvedValue(null),
    writeManagedSkillFile: vi.fn(),
  },
}));

vi.mock('@core/currentUserProvider', () => ({
  getCurrentUserProvider: () => ({
    getCurrentUser: vi.fn().mockReturnValue({ id: 'user-1' }),
  }),
  setCurrentUserProviderFactory: vi.fn(),
}));


type ApplyMemoryUpdateStatusToSession = typeof import('../memoryHandlers').applyMemoryUpdateStatusToSession;
type GetIncrementalSessionStore = typeof import('../../services/incrementalSessionStore').getIncrementalSessionStore;

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

describe('memoryHandlers applyStatusToSession real-store atomic RMW', () => {
  let testDir: string;
  let applyMemoryUpdateStatusToSession: ApplyMemoryUpdateStatusToSession;
  let getIncrementalSessionStore: GetIncrementalSessionStore;

  beforeEach(async () => {
    vi.resetModules();
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-status-rmw-'));
    await initTestPlatformConfig({ userDataPath: testDir });

    const memoryHandlersMod = await import('../memoryHandlers');
    applyMemoryUpdateStatusToSession = memoryHandlersMod.applyMemoryUpdateStatusToSession;
    ({ getIncrementalSessionStore } = await import('../../services/incrementalSessionStore'));

    const { createSessionLockManager, defaultIsProcessAlive } = await import('@core/utils/sessionFileLock');
    const lockManager = createSessionLockManager({
      locksDirectory: path.join(testDir, 'locks'),
      isProcessAlive: defaultIsProcessAlive,
      now: () => Date.now(),
    });
    memoryHandlersMod.registerMemoryHandlers({
      sessionLockManager: lockManager,
      sessionLockOwnerKind: 'desktop',
    });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function seedSession(session: AgentSession): Promise<void> {
    await getIncrementalSessionStore().upsertSession(session);
  }

  it('handles concurrent cross-session writes for two different sessions', async () => {
    await seedSession(makeSession({ id: 'session-a', updatedAt: 100 }));
    await seedSession(makeSession({ id: 'session-b', updatedAt: 200 }));

    const statusA: MemoryUpdateStatus = {
      originalTurnId: 'turn-a',
      originalSessionId: 'session-a',
      status: 'success',
      summary: 'done-a',
      timestamp: Date.now(),
    };
    const statusB: MemoryUpdateStatus = {
      originalTurnId: 'turn-b',
      originalSessionId: 'session-b',
      status: 'success',
      summary: 'done',
      timestamp: Date.now(),
    };

    const [resultA, resultB] = await Promise.all([
      applyMemoryUpdateStatusToSession({
        sessionId: 'session-a',
        turnId: 'turn-a',
        status: statusA,
      }),
      applyMemoryUpdateStatusToSession({
        sessionId: 'session-b',
        turnId: 'turn-b',
        status: statusB,
      }),
    ]);

    expect(resultA).toEqual({ ok: true });
    expect(resultB).toEqual({ ok: true });

    const store = getIncrementalSessionStore();
    const nextA = await store.getSession('session-a');
    const nextB = await store.getSession('session-b');
    expect(nextA?.memoryUpdateStatusByTurn?.['turn-a']).toEqual(statusA);
    expect(nextB?.memoryUpdateStatusByTurn?.['turn-b']).toEqual(statusB);
    expect(nextA?.updatedAt).toBeGreaterThan(100);
    expect(nextB?.updatedAt).toBeGreaterThan(200);
  });

  it('handles concurrent writes to the same session for different turns', async () => {
    await seedSession(makeSession({ id: 'session-c', updatedAt: 300 }));

    const status1: MemoryUpdateStatus = {
      originalTurnId: 'turn-1',
      originalSessionId: 'session-c',
      status: 'success',
      summary: 'ok-1',
      timestamp: Date.now(),
    };
    const status2: MemoryUpdateStatus = {
      originalTurnId: 'turn-2',
      originalSessionId: 'session-c',
      status: 'success',
      summary: 'ok',
      timestamp: Date.now(),
    };

    await Promise.all([
      applyMemoryUpdateStatusToSession({
        sessionId: 'session-c',
        turnId: 'turn-1',
        status: status1,
      }),
      applyMemoryUpdateStatusToSession({
        sessionId: 'session-c',
        turnId: 'turn-2',
        status: status2,
      }),
    ]);

    const session = await getIncrementalSessionStore().getSession('session-c');
    expect(session?.memoryUpdateStatusByTurn?.['turn-1']).toEqual(status1);
    expect(session?.memoryUpdateStatusByTurn?.['turn-2']).toEqual(status2);
  });

  it('serializes same-session same-turn writes so the last writer wins', async () => {
    await seedSession(makeSession({ id: 'session-d', updatedAt: 400 }));

    const first: MemoryUpdateStatus = {
      originalTurnId: 'turn-shared',
      originalSessionId: 'session-d',
      status: 'success',
      summary: 'first',
      timestamp: 1,
    };
    const second: MemoryUpdateStatus = {
      originalTurnId: 'turn-shared',
      originalSessionId: 'session-d',
      status: 'error',
      error: 'final-error',
      timestamp: 2,
    };

    await Promise.all([
      applyMemoryUpdateStatusToSession({
        sessionId: 'session-d',
        turnId: 'turn-shared',
        status: first,
      }),
      applyMemoryUpdateStatusToSession({
        sessionId: 'session-d',
        turnId: 'turn-shared',
        status: second,
      }),
    ]);

    const session = await getIncrementalSessionStore().getSession('session-d');
    expect(session?.memoryUpdateStatusByTurn?.['turn-shared']).toEqual(second);
  });

  it('preserves status when status RMW runs concurrently with a title upsert', async () => {
    await seedSession(makeSession({ id: 'session-e', title: 'Before', updatedAt: 500 }));
    const store = getIncrementalSessionStore();

    const status: MemoryUpdateStatus = {
      originalTurnId: 'turn-status',
      originalSessionId: 'session-e',
      status: 'success',
      summary: 'persist-me',
      timestamp: Date.now(),
    };

    const statusWrite = applyMemoryUpdateStatusToSession({
      sessionId: 'session-e',
      turnId: 'turn-status',
      status,
    });

    const titleWrite = (async () => {
      const staleSnapshot = await store.getSession('session-e');
      expect(staleSnapshot).not.toBeNull();
      await statusWrite;
      const latest = await store.getSession('session-e');
      expect(latest ?? staleSnapshot).not.toBeNull();
      await store.upsertSession({
        ...(latest ?? staleSnapshot)!,
        title: 'After',
      });
    })();

    await Promise.all([statusWrite, titleWrite]);

    const session = await store.getSession('session-e');
    expect(session?.title).toBe('After');
    expect(session?.memoryUpdateStatusByTurn?.['turn-status']).toEqual(status);
  });

  it('round-trips legacy persisted entries without originalSessionId and preserves them next to new writes', async () => {
    await seedSession(makeSession({
      id: 'session-legacy',
      memoryUpdateStatusByTurn: {
        'legacy-turn': {
          originalTurnId: 'legacy-turn',
          status: 'success',
          summary: 'legacy status',
          timestamp: Date.now(),
        },
      },
    }));

    const store = getIncrementalSessionStore();
    const loadedLegacySession = await store.getSession('session-legacy');
    expect(loadedLegacySession?.memoryUpdateStatusByTurn?.['legacy-turn']).toEqual({
      originalTurnId: 'legacy-turn',
      status: 'success',
      summary: 'legacy status',
      timestamp: expect.any(Number),
    });

    const nextStatus: MemoryUpdateStatus = {
      originalTurnId: 'new-turn',
      originalSessionId: 'session-legacy',
      status: 'success',
      summary: 'new status',
      timestamp: Date.now(),
    };
    const result = await applyMemoryUpdateStatusToSession({
      sessionId: 'session-legacy',
      turnId: 'new-turn',
      status: nextStatus,
    });

    expect(result).toEqual({ ok: true });
    const updatedSession = await store.getSession('session-legacy');
    expect(updatedSession?.memoryUpdateStatusByTurn?.['legacy-turn']).toEqual({
      originalTurnId: 'legacy-turn',
      status: 'success',
      summary: 'legacy status',
      timestamp: expect.any(Number),
    });
    expect(updatedSession?.memoryUpdateStatusByTurn?.['new-turn']).toEqual(nextStatus);
  });
});
