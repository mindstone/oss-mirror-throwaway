import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import type { AgentSession, MemoryUpdateStatus } from '@shared/types';

const {
  mockLogger,
  mockProcessAutoTitle,
  mockIsDefaultOrFallbackTitle,
} = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  },
  mockProcessAutoTitle: vi.fn(),
  mockIsDefaultOrFallbackTitle: vi.fn().mockReturnValue(true),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLogger,
}));

vi.mock('@core/services/turnCheckpointService', () => ({
  getTurnCheckpointManager: () => null,
}));

vi.mock('../conversationTitleService', () => ({
  processAutoTitle: (...args: unknown[]) => mockProcessAutoTitle(...args),
  isDefaultOrFallbackTitle: (...args: unknown[]) => mockIsDefaultOrFallbackTitle(...args),
}));

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({ sendToAllWindows: vi.fn(), sendToFocusedWindow: vi.fn() }),
  setBroadcastService: vi.fn(),
}));

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

vi.mock('../../../main/services/memoryHistoryStore', () => ({
  getMemoryHistory: vi.fn().mockReturnValue([]),
  getMemoryStats: vi.fn().mockReturnValue({ total: 0, bySpace: [] }),
  getMemoryHistoryEntry: vi.fn().mockReturnValue(null),
  removeMemoryHistoryEntry: vi.fn(),
}));

vi.mock('../../../main/services/safety', () => ({
  getPendingMemoryApprovals: vi.fn().mockReturnValue([]),
  handleMemoryWriteApprovalResponse: vi.fn(),
  removePendingMemoryApproval: vi.fn(),
}));

vi.mock('../../../main/services/spaceService', () => ({
  scanSpaces: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../main/services/safety/cosPendingService', () => ({
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

vi.mock('../../../main/services/meetingBot/transcriptEventBus', () => ({
  emitDeferredTranscriptSaved: vi.fn().mockReturnValue(false),
  emitTranscriptSavedFromMeta: vi.fn(),
  removeDeferredTranscriptSaved: vi.fn(),
}));

vi.mock('../../../main/settingsStore', () => ({
  getSettings: () => ({ coreDirectory: '/workspace' }),
}));

vi.mock('../../../main/ipc/utils/registerHandler', () => ({
  registerHandler: vi.fn(),
}));

vi.mock('../../../main/services/safety/automationPendingItemsTracker', () => ({
  resolveItem: vi.fn(),
}));

vi.mock('../../../main/services/safety/automationContextLookup', () => ({
  getAutomationContext: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../main/services/sharedSkillMutationService', () => ({
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


type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-default',
    title: 'Before',
    createdAt: 1_000,
    updatedAt: 10,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  };
}

function makeMemoryStatus(overrides: Partial<MemoryUpdateStatus>): MemoryUpdateStatus {
  return {
    originalTurnId: 'turn-default',
    originalSessionId: 'session-default',
    status: 'success',
    summary: 'saved',
    timestamp: 9_999,
    ...overrides,
  };
}

type DispatchAgentEvent = typeof import('../agentEventDispatcher').dispatchAgentEvent;
type ApplyMemoryUpdateStatusToSession = typeof import('../../../main/ipc/memoryHandlers').applyMemoryUpdateStatusToSession;
type GetIncrementalSessionStore = typeof import('../incrementalSessionStore').getIncrementalSessionStore;
type AgentTurnRegistry = typeof import('../agentTurnRegistry').agentTurnRegistry;

function createWindow() {
  const titleGenerated = createDeferred<void>();
  const send = vi.fn((channel: string) => {
    if (channel === 'session:title-generated') {
      titleGenerated.resolve(undefined);
    }
  });
  return {
    send,
    titleGenerated,
    win: {
      id: 1,
      isDestroyed: () => false,
      webContents: { send },
    },
  };
}

describe('IncrementalSessionStore status interleaving', () => {
  let testDir: string;
  let dispatchAgentEvent: DispatchAgentEvent;
  let applyMemoryUpdateStatusToSession: ApplyMemoryUpdateStatusToSession;
  let getIncrementalSessionStore: GetIncrementalSessionStore;
  let agentTurnRegistry: AgentTurnRegistry;
  const trackedTurnIds = new Set<string>();
  let originalE2EMode: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockProcessAutoTitle.mockReset();
    mockIsDefaultOrFallbackTitle.mockReset();
    mockIsDefaultOrFallbackTitle.mockReturnValue(true);
    originalE2EMode = process.env.REBEL_E2E_TEST_MODE;
    delete process.env.REBEL_E2E_TEST_MODE;

    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-status-interleaving-'));
    await initTestPlatformConfig({ userDataPath: testDir });

    ({ dispatchAgentEvent } = await import('../agentEventDispatcher'));
    const memoryHandlersMod = await import('../../../main/ipc/memoryHandlers');
    applyMemoryUpdateStatusToSession = memoryHandlersMod.applyMemoryUpdateStatusToSession;
    ({ getIncrementalSessionStore } = await import('../incrementalSessionStore'));
    ({ agentTurnRegistry } = await import('../agentTurnRegistry'));

    const { createSessionLockManager, defaultIsProcessAlive } = await import('@core/utils/sessionFileLock');
    memoryHandlersMod.registerMemoryHandlers({
      sessionLockManager: createSessionLockManager({
        locksDirectory: path.join(testDir, 'locks'),
        isProcessAlive: defaultIsProcessAlive,
        now: () => Date.now(),
      }),
      sessionLockOwnerKind: 'desktop',
    });
  });

  afterEach(async () => {
    for (const turnId of trackedTurnIds) {
      agentTurnRegistry.cleanupTurn(turnId);
    }
    trackedTurnIds.clear();
    if (originalE2EMode === undefined) {
      delete process.env.REBEL_E2E_TEST_MODE;
    } else {
      process.env.REBEL_E2E_TEST_MODE = originalE2EMode;
    }
    vi.useRealTimers();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('preserves status when production auto-title persistence races with applyMemoryUpdateStatusToSession', async () => {
    const store = getIncrementalSessionStore();
    const sessionId = 'session-auto-title-race';
    const turnId = 'turn-auto-title-race';
    await store.upsertSession(makeSession({ id: sessionId, title: 'Before' }));

    const upsertSpy = vi.spyOn(store, 'upsertSession');
    const updateSpy = vi.spyOn(store, 'updateSession');
    const upsertSyncSpy = vi.spyOn(store, 'upsertSessionsSyncWithReload');
    upsertSpy.mockClear();
    updateSpy.mockClear();
    upsertSyncSpy.mockClear();

    const processStarted = createDeferred<void>();
    const releaseProcess = createDeferred<void>();
    mockProcessAutoTitle.mockImplementationOnce(async () => {
      processStarted.resolve(undefined);
      await releaseProcess.promise;
      return { title: 'New Title', reason: 'initial', turnCount: 1 };
    });

    const { win, titleGenerated } = createWindow();
    agentTurnRegistry.setRendererSession(turnId, sessionId);
    trackedTurnIds.add(turnId);

    dispatchAgentEvent(win as never, turnId, {
      type: 'result',
      text: 'done',
      timestamp: 1_700_000_000_000,
    });

    await processStarted.promise;
    const status = makeMemoryStatus({
      originalTurnId: 'turn-t1',
      originalSessionId: sessionId,
      summary: 'status-from-memory-update',
    });
    await expect(applyMemoryUpdateStatusToSession({
      sessionId,
      turnId: 'turn-t1',
      status,
    })).resolves.toEqual({ ok: true });

    releaseProcess.resolve(undefined);
    await titleGenerated.promise;

    const persisted = await store.getSession(sessionId);
    expect(persisted?.title).toBe('New Title');
    expect(persisted?.memoryUpdateStatusByTurn?.['turn-t1']).toEqual(status);
    expect(updateSpy.mock.calls.length + upsertSyncSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('preserves status when production debouncedSessionUpsert races with applyMemoryUpdateStatusToSession', async () => {
    vi.useFakeTimers();
    const { AutomationScheduler } = await import('../../../main/services/automationScheduler');
    const store = getIncrementalSessionStore();
    const sessionId = 'automation-daily-summary--status-race';
    const existingAutomationStatus = makeMemoryStatus({
      originalTurnId: 'turn-existing',
      originalSessionId: sessionId,
      summary: 'existing-automation-memory',
    });
    await store.upsertSession(makeSession({
      id: sessionId,
      title: 'Automation run',
      origin: 'automation',
      updatedAt: 10,
      memoryUpdateStatusByTurn: { 'turn-existing': existingAutomationStatus },
    }));

    const upsertSpy = vi.spyOn(store, 'upsertSession');
    const realUpdateSession = store.updateSession.bind(store);
    const queuedUpdates: Array<Promise<boolean>> = [];
    const updateSpy = vi.spyOn(store, 'updateSession').mockImplementation((sessionIdArg, mutator) => {
      const op = realUpdateSession(sessionIdArg, mutator);
      queuedUpdates.push(op);
      return op;
    });
    upsertSpy.mockClear();
    updateSpy.mockClear();

    const schedulerProto = AutomationScheduler.prototype as unknown as {
      persistAutomationSessionSnapshot: (
        sessionId: string,
        next: AgentSession,
        phase: 'terminal' | 'initial' | 'debounced',
      ) => void;
      debouncedSessionUpsert: (
        sessionId: string,
        session: AgentSession,
        isTerminal: boolean,
      ) => void;
    };

    const schedulerLike = {
      _sessionUpsertTimers: new Map<string, ReturnType<typeof setTimeout>>(),
      _pendingSessionUpserts: new Map<string, AgentSession>(),
      persistAutomationSessionSnapshot(sessionIdArg: string, session: AgentSession, phase: 'terminal' | 'initial' | 'debounced') {
        return schedulerProto.persistAutomationSessionSnapshot.call(
          this,
          sessionIdArg,
          session,
          phase,
        );
      },
    };

    vi.setSystemTime(10);
    const staleSnapshot = makeSession({
      id: sessionId,
      title: 'Automation Snapshot',
      origin: 'automation',
      updatedAt: 8,
      memoryUpdateStatusByTurn: { 'turn-existing': existingAutomationStatus },
    });
    schedulerProto.debouncedSessionUpsert.call(
      schedulerLike,
      sessionId,
      staleSnapshot,
      false,
    );

    const incomingStatus = makeMemoryStatus({
      originalTurnId: 'turn-interleaved',
      originalSessionId: sessionId,
      summary: 'interleaved-status',
    });
    await expect(applyMemoryUpdateStatusToSession({
      sessionId,
      turnId: 'turn-interleaved',
      status: incomingStatus,
    })).resolves.toEqual({ ok: true });

    vi.setSystemTime(8);
    await vi.advanceTimersByTimeAsync(2_100);
    await Promise.all(queuedUpdates);

    const persisted = await store.getSession(sessionId);
    expect(persisted?.title).toBe('Automation Snapshot');
    expect(persisted?.memoryUpdateStatusByTurn?.['turn-existing']).toEqual(existingAutomationStatus);
    expect(persisted?.memoryUpdateStatusByTurn?.['turn-interleaved']).toEqual(incomingStatus);
    expect(persisted?.updatedAt).toBeGreaterThanOrEqual(11);
    expect(updateSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(upsertSpy).not.toHaveBeenCalled();

    for (const timer of schedulerLike._sessionUpsertTimers.values()) {
      clearTimeout(timer);
    }
  });

  it('keeps updatedAt monotonic when status lands after auto-title stale read but before queued persist', async () => {
    vi.useFakeTimers();
    const store = getIncrementalSessionStore();
    const sessionId = 'session-auto-title-updatedAt-monotonic';
    const turnId = 'turn-auto-title-monotonic';
    await store.upsertSession(makeSession({ id: sessionId, title: 'Before', updatedAt: 10 }));

    const upsertSpy = vi.spyOn(store, 'upsertSession');
    const realUpdateSession = store.updateSession.bind(store);
    let blockedFirstUpdate = true;
    const autoTitleQueuedPersist = createDeferred<void>();
    const releaseAutoTitlePersist = createDeferred<void>();
    const updateSpy = vi.spyOn(store, 'updateSession').mockImplementation(async (sessionIdArg, mutator) => {
      if (blockedFirstUpdate) {
        blockedFirstUpdate = false;
        autoTitleQueuedPersist.resolve(undefined);
        await releaseAutoTitlePersist.promise;
      }
      return realUpdateSession(sessionIdArg, mutator);
    });
    upsertSpy.mockClear();
    updateSpy.mockClear();

    mockProcessAutoTitle.mockResolvedValueOnce({
      title: 'Monotonic Title',
      reason: 'initial',
      turnCount: 1,
    });

    const { win, titleGenerated } = createWindow();
    agentTurnRegistry.setRendererSession(turnId, sessionId);
    trackedTurnIds.add(turnId);

    vi.setSystemTime(8);
    dispatchAgentEvent(win as never, turnId, {
      type: 'result',
      text: 'done',
      timestamp: 1_700_000_100_000,
    });

    await autoTitleQueuedPersist.promise;
    const status = makeMemoryStatus({
      originalTurnId: 'turn-race',
      originalSessionId: sessionId,
      summary: 'status-between-read-and-write',
    });
    vi.setSystemTime(10);
    await expect(applyMemoryUpdateStatusToSession({
      sessionId,
      turnId: 'turn-race',
      status,
    })).resolves.toEqual({ ok: true });

    vi.setSystemTime(8);
    releaseAutoTitlePersist.resolve(undefined);
    await titleGenerated.promise;

    const persisted = await store.getSession(sessionId);
    expect(persisted?.title).toBe('Monotonic Title');
    expect(persisted?.memoryUpdateStatusByTurn?.['turn-race']).toEqual(status);
    expect(persisted?.updatedAt).toBeGreaterThanOrEqual(11);
    expect(updateSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});
