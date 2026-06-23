 
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryUpdateStatus, TimeSavedStatus } from '@shared/types';

const {
  registeredHandlers,
  updateSessionMock,
  updateSessionWithReloadMock,
  addBreadcrumbMock,
} = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  updateSessionMock: vi.fn(),
  updateSessionWithReloadMock: vi.fn(),
  addBreadcrumbMock: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: (...args: unknown[]) => addBreadcrumbMock(...args),
  }),
}));

vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock();
});

vi.mock('@core/services/lockedSessionPersistence', () => ({
  updateSessionWithReload: (...args: unknown[]) => updateSessionWithReloadMock(...args),
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
  registerHandler: (channel: string, handler: (...args: unknown[]) => unknown) => {
    registeredHandlers.set(channel, handler);
  },
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

vi.mock('../../services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({
    updateSession: (...args: unknown[]) => updateSessionMock(...args),
  }),
}));

import {
  applyMemoryUpdateStatusToSession,
  applyTimeSavedStatusToSession,
  registerMemoryHandlers,
} from '../memoryHandlers';

describe('memoryHandlers cross-session status routing', () => {
  const lockDeps = {
    sessionLockManager: {
      acquirePerSession: vi.fn(),
      acquireGlobalIndex: vi.fn(),
      acquirePerSessionSync: vi.fn(),
      acquireGlobalIndexSync: vi.fn(),
    },
    sessionLockOwnerKind: 'desktop' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();
    updateSessionWithReloadMock.mockImplementation(async (args: {
      sessionId: string;
      update: (session: any) => any;
    }) => {
      let written: unknown = null;
      const updated = await updateSessionMock(args.sessionId, (session: unknown) => {
        written = args.update(session);
        return written;
      });
      return { updated, session: written };
    });
    registerMemoryHandlers(lockDeps);
  });

  it('applies memory status via locked session update mutator', async () => {
    const incomingStatus: MemoryUpdateStatus = {
      originalTurnId: 'turn-new',
      originalSessionId: 'session-a',
      status: 'success',
      summary: 'Updated memory',
      timestamp: Date.now(),
    };
    const existingStatus: MemoryUpdateStatus = {
      originalTurnId: 'turn-existing',
      originalSessionId: 'session-a',
      status: 'running',
      timestamp: Date.now(),
    };

    updateSessionMock.mockImplementation(async (_sessionId: string, mutator: (session: unknown) => unknown) => {
      const existingSession = {
        id: 'session-a',
        updatedAt: 100,
        memoryUpdateStatusByTurn: {
          'turn-existing': existingStatus,
        },
      };
      const next = mutator(existingSession) as {
        updatedAt: number;
        memoryUpdateStatusByTurn: Record<string, MemoryUpdateStatus>;
      };
      expect(next.memoryUpdateStatusByTurn['turn-existing']).toEqual(existingStatus);
      expect(next.memoryUpdateStatusByTurn['turn-new']).toEqual(incomingStatus);
      expect(next.updatedAt).toBeGreaterThan(existingSession.updatedAt);
      return true;
    });

    const result = await applyMemoryUpdateStatusToSession({
      sessionId: 'session-a',
      turnId: 'turn-new',
      status: incomingStatus,
    });

    expect(result).toEqual({ ok: true });
    expect(updateSessionWithReloadMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-a',
      lockManager: lockDeps.sessionLockManager,
      ownerKind: 'desktop',
    }));
  });

  it('applies time-saved status via locked session update mutator', async () => {
    const incomingStatus: TimeSavedStatus = {
      turnId: 'turn-ts',
      originalSessionId: 'session-a',
      status: 'success',
      estimate: {
        lowMinutes: 4,
        highMinutes: 7,
        confidence: 'medium',
        taskType: 'analysis',
      },
      timestamp: Date.now(),
    };

    updateSessionMock.mockImplementation(async (_sessionId: string, mutator: (session: unknown) => unknown) => {
      const existingSession = {
        id: 'session-a',
        updatedAt: 500,
        timeSavedStatusByTurn: {},
      };
      const next = mutator(existingSession) as {
        updatedAt: number;
        timeSavedStatusByTurn: Record<string, TimeSavedStatus>;
      };
      expect(next.timeSavedStatusByTurn['turn-ts']).toEqual(incomingStatus);
      expect(next.updatedAt).toBeGreaterThan(existingSession.updatedAt);
      return true;
    });

    const result = await applyTimeSavedStatusToSession({
      sessionId: 'session-a',
      turnId: 'turn-ts',
      status: incomingStatus,
    });

    expect(result).toEqual({ ok: true });
    expect(updateSessionWithReloadMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-a',
      lockManager: lockDeps.sessionLockManager,
      ownerKind: 'desktop',
    }));
  });

  it('returns session-not-found when updateSession reports no update', async () => {
    updateSessionMock.mockResolvedValue(false);

    const result = await applyMemoryUpdateStatusToSession({
      sessionId: 'missing-session',
      turnId: 'turn-404',
      status: {
        originalTurnId: 'turn-404',
        originalSessionId: 'missing-session',
        status: 'error',
        error: 'not found',
        timestamp: Date.now(),
      },
    });

    expect(result).toEqual({ ok: false, error: 'session-not-found' });
  });

  it('rejects empty request IDs before touching the store', async () => {
    const result = await applyMemoryUpdateStatusToSession({
      sessionId: '',
      turnId: 'turn-404',
      status: {
        originalTurnId: 'turn-404',
        originalSessionId: 'session-a',
        status: 'error',
        error: 'bad-request',
        timestamp: Date.now(),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid-session-id');
    expect(result.context).toEqual(expect.objectContaining({
      reason: 'sessionId must be a non-empty string',
    }));
    expect(updateSessionMock).not.toHaveBeenCalled();
    expect(addBreadcrumbMock).toHaveBeenCalledWith(expect.objectContaining({
      category: 'status-apply-validation-failed',
    }));
  });

  it('rejects cross-field mismatch payloads with hashed context', async () => {
    const result = await applyMemoryUpdateStatusToSession({
      sessionId: 'session-a',
      turnId: 'turn-1',
      status: {
        originalTurnId: 'turn-other',
        originalSessionId: 'session-b',
        status: 'running',
        timestamp: Date.now(),
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: 'cross-field-mismatch',
      context: expect.objectContaining({
        kind: 'memory-update',
        sessionIdMatches: false,
        turnIdMatches: false,
      }),
    }));
    expect(updateSessionMock).not.toHaveBeenCalled();
    expect(addBreadcrumbMock).toHaveBeenCalledWith(expect.objectContaining({
      category: 'status-apply-validation-failed',
      data: expect.objectContaining({
        sessionIdHash: expect.any(String),
        turnIdHash: expect.any(String),
        statusSessionIdHash: expect.any(String),
        statusTurnIdHash: expect.any(String),
      }),
    }));
  });

  it('rejects time-saved payloads when status.turnId mismatches request turnId', async () => {
    const result = await applyTimeSavedStatusToSession({
      sessionId: 'session-a',
      turnId: 'turn-request',
      status: {
        turnId: 'turn-status',
        originalSessionId: 'session-a',
        status: 'running',
        timestamp: Date.now(),
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: 'cross-field-mismatch',
      context: expect.objectContaining({
        kind: 'time-saved',
        sessionIdMatches: true,
        turnIdMatches: false,
      }),
    }));
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  it('registers IPC channels for both memory-update and time-saved status routing', () => {
    registerMemoryHandlers(lockDeps);

    expect(registeredHandlers.has('memoryUpdate:applyStatusToSession')).toBe(true);
    expect(registeredHandlers.has('timeSaved:applyTimeSavedStatusToSession')).toBe(true);
  });
});
