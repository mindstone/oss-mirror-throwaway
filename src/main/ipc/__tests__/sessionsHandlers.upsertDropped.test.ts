/**
 * Stage 2 (260612 recs-round5, item 4b): the `sessions:upsert` handler must
 * surface a dropped store write — `{success:false}` with the drop reason — and
 * must NOT fire the embedding/cloud hooks for a write that never landed.
 * Previously a read-only or corrupt-index abort still returned `{success:true}`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@shared/types';
import type { SessionsSyncUpsertOutcome } from '@core/services/incrementalSessionStore';

const {
  registeredHandlers,
  upsertAgentSessionMock,
  onSessionsSavedMock,
  loggerErrorMock,
} = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  upsertAgentSessionMock: vi.fn<(session: AgentSession) => Promise<unknown>>(),
  onSessionsSavedMock: vi.fn((_sessions: unknown) => Promise.resolve()),
  loggerErrorMock: vi.fn(),
}));

vi.mock('@core/services/lockedSessionPersistence', () => ({
  updateSessionWithReload: vi.fn(),
}));

vi.mock('../utils/registerHandler', () => ({
  registerHandler: (channel: string, handler: (...args: unknown[]) => unknown) => {
    registeredHandlers.set(channel, handler);
  },
}));

vi.mock('../../services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({
    listSessions: vi.fn(() => []),
    getSession: vi.fn(async () => null),
    deleteSession: vi.fn(async () => undefined),
    updateSession: vi.fn(),
  }),
}));

vi.mock('../../services/conversationIndexService', () => ({
  onSessionsSaved: (sessions: AgentSession[]) => onSessionsSavedMock(sessions),
}));

vi.mock('../../services/toolSafetyService', () => ({
  clearSessionApprovals: vi.fn(),
}));

vi.mock('../../services/mcpAppModelContextStore', () => ({
  mcpAppModelContextStore: { cleanupConversation: vi.fn() },
}));

vi.mock('../../services/mcpAppsTrust', () => ({
  cleanupConversation: vi.fn(),
  invalidateForConversation: vi.fn(),
  invalidateForSession: vi.fn(),
}));

vi.mock('../../services/diagnosticContextService', () => ({
  getDiagnosticSummary: vi.fn(async () => null),
}));

vi.mock('../../services/conversationSummaryService', () => ({
  generateConversationSummary: vi.fn(async () => null),
}));

vi.mock('@core/services/narrativeAnalysisService', () => ({
  generateNarrativeAnalysis: vi.fn(async () => null),
}));

vi.mock('../../services/conversationLogExportService', () => ({
  exportConversationLogs: vi.fn(async () => ({ success: true })),
}));

vi.mock('../../settingsStore', () => ({
  getSettings: vi.fn(() => ({ coreDirectory: '/workspace' })),
}));

vi.mock('@core/logger', () => ({
  logger: {
    warn: vi.fn(),
    error: (...args: unknown[]) => loggerErrorMock(...args),
    info: vi.fn(),
    debug: vi.fn(),
  },
  createScopedLogger: vi.fn(() => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  })),
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({ addBreadcrumb: vi.fn() }),
  setErrorReporter: vi.fn(),
}));

import { registerSessionsHandlers } from '../sessionsHandlers';

function makeSession(id: string): AgentSession {
  return {
    id,
    title: 'Session',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    origin: 'manual',
  };
}

describe('sessions:upsert dropped-write surfacing', () => {
  const onSessionsSavedLocally = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();
    registerSessionsHandlers({
      loadAgentSessions: vi.fn(() => []),
      saveAgentSessions: vi.fn(),
      upsertAgentSession: upsertAgentSessionMock as unknown as (
        session: AgentSession,
      ) => Promise<SessionsSyncUpsertOutcome>,
      sessionLockManager: {
        acquirePerSession: vi.fn(),
        acquireGlobalIndex: vi.fn(),
        acquirePerSessionSync: vi.fn(),
        acquireGlobalIndexSync: vi.fn(),
      } as never,
      sessionLockOwnerKind: 'desktop',
      onSessionsSavedLocally,
      onSessionDeletedLocally: vi.fn(),
    });
  });

  it.each([
    ['read-only'],
    ['corrupt-index-unrecoverable'],
    ['version-forward-index'],
  ] as const)('returns success:false and fires NO hooks when the store drops the write (%s)', async (reason) => {
    upsertAgentSessionMock.mockResolvedValue({ outcome: 'dropped', reason });
    const handler = registeredHandlers.get('sessions:upsert');
    expect(handler).toBeDefined();

    const response = await handler?.({}, makeSession('sess-dropped'));

    expect(response).toEqual({
      success: false,
      error: { message: `Session write was not persisted (${reason})` },
    });
    expect(onSessionsSavedMock).not.toHaveBeenCalled();
    expect(onSessionsSavedLocally).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-dropped', reason }),
      expect.stringContaining('sessions:upsert dropped'),
    );
  });

  // Stage 3: a hard-delete tombstoned id is a per-session drop (delete-wins) —
  // surfaced as failure, with NO embedding/cloud hooks for the dead write.
  it('returns success:false and fires NO hooks when the session id is tombstoned (all-dropped-tombstoned)', async () => {
    upsertAgentSessionMock.mockResolvedValue({
      outcome: 'all-dropped-tombstoned',
      droppedTombstonedSessionIds: ['sess-tombstoned'],
    });
    const handler = registeredHandlers.get('sessions:upsert');

    const response = await handler?.({}, makeSession('sess-tombstoned'));

    expect(response).toEqual({
      success: false,
      error: { message: 'Session write was not persisted (hard-deleted session)' },
    });
    expect(onSessionsSavedMock).not.toHaveBeenCalled();
    expect(onSessionsSavedLocally).not.toHaveBeenCalled();
  });

  it('returns success:true and fires hooks when the write persisted', async () => {
    upsertAgentSessionMock.mockResolvedValue({ outcome: 'persisted', persistedSessionIds: [], droppedTombstonedSessionIds: [] });
    const handler = registeredHandlers.get('sessions:upsert');

    const response = await handler?.({}, makeSession('sess-ok'));

    expect(response).toEqual({ success: true });
    expect(onSessionsSavedMock).toHaveBeenCalledTimes(1);
    expect(onSessionsSavedLocally).toHaveBeenCalledTimes(1);
  });
});
