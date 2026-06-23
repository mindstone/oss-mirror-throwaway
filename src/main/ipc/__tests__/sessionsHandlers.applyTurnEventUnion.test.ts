import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession } from '@shared/types';

const {
  registeredHandlers,
  updateSessionMock,
  updateSessionWithReloadMock,
  deleteSessionMock,
  onSessionsSavedMock,
  addBreadcrumbMock,
  clearSessionApprovalsMock,
  cleanupPermissionMock,
  cleanupContextMock,
  invalidateConversationNoncesMock,
  invalidateSessionNoncesMock,
} = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  updateSessionMock: vi.fn(),
  updateSessionWithReloadMock: vi.fn(),
  deleteSessionMock: vi.fn(async (_id: string) => undefined),
  onSessionsSavedMock: vi.fn((_sessions: unknown) => Promise.resolve()),
  addBreadcrumbMock: vi.fn(),
  clearSessionApprovalsMock: vi.fn(),
  cleanupPermissionMock: vi.fn(),
  cleanupContextMock: vi.fn(),
  invalidateConversationNoncesMock: vi.fn(),
  invalidateSessionNoncesMock: vi.fn(),
}));

 
vi.mock('@core/services/lockedSessionPersistence', () => ({
  updateSessionWithReload: (...args: unknown[]) => updateSessionWithReloadMock(...args),
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
    upsertSession: vi.fn(async () => undefined),
    deleteSession: (id: string) => deleteSessionMock(id),
    updateSession: (...args: unknown[]) => updateSessionMock(...args),
  }),
}));

vi.mock('../../services/conversationIndexService', () => ({
  onSessionsSaved: (sessions: AgentSession[]) => onSessionsSavedMock(sessions),
}));

vi.mock('../../services/toolSafetyService', () => ({
  clearSessionApprovals: (...args: unknown[]) => clearSessionApprovalsMock(...args),
}));

 
vi.mock('../../services/mcpAppModelContextStore', () => ({
  mcpAppModelContextStore: {
    cleanupConversation: (...args: unknown[]) => cleanupContextMock(...args),
  },
}));

 
vi.mock('../../services/mcpAppsTrust', () => ({
  cleanupConversation: (...args: unknown[]) => cleanupPermissionMock(...args),
  invalidateForConversation: (...args: unknown[]) => invalidateConversationNoncesMock(...args),
  invalidateForSession: (...args: unknown[]) => invalidateSessionNoncesMock(...args),
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
    error: vi.fn(),
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
  getErrorReporter: () => ({
    addBreadcrumb: (...args: unknown[]) => addBreadcrumbMock(...args),
  }),
}));

import { registerSessionsHandlers } from '../sessionsHandlers';

const makeStatusEvent = (seq: number | undefined, timestamp: number): AgentEvent => ({
  type: 'status',
  message: `[status-${seq ?? 'legacy'}]`,
  timestamp,
  ...(seq === undefined ? {} : { seq }),
});

const makeSession = (
  sessionId: string,
  turnId: string,
  events: AgentEvent[],
  overrides: Partial<AgentSession> = {},
): AgentSession => ({
  id: sessionId,
  title: 'Session',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_001,
  messages: [],
  eventsByTurn: { [turnId]: events },
  activeTurnId: turnId,
  isBusy: true,
  lastError: null,
  resolvedAt: null,
  origin: 'manual',
  ...overrides,
});

describe('sessionsHandlers apply-turn-event-union IPC', () => {
  const deps = {
    loadAgentSessions: vi.fn(() => []),
    saveAgentSessions: vi.fn(),
    upsertAgentSession: vi.fn(async () => ({ outcome: 'persisted' as const, persistedSessionIds: [], droppedTombstonedSessionIds: [] })),
    sessionLockManager: {
      acquirePerSession: vi.fn(),
      acquireGlobalIndex: vi.fn(),
      acquirePerSessionSync: vi.fn(),
      acquireGlobalIndexSync: vi.fn(),
    },
    sessionLockOwnerKind: 'desktop' as const,
    onSessionsSavedLocally: vi.fn(),
    onSessionDeletedLocally: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();
    updateSessionWithReloadMock.mockImplementation(async (args: {
      sessionId: string;
      update: (session: AgentSession | null) => AgentSession | null;
    }) => {
      let written: AgentSession | null = null;
      const updated = await updateSessionMock(args.sessionId, (session: AgentSession | null) => {
        written = args.update(session);
        return written;
      });
      return { updated, session: written };
    });
    registerSessionsHandlers(deps);
  });

  it('registers the apply-turn-event-union channel', () => {
    expect(registeredHandlers.has('sessions:apply-turn-event-union')).toBe(true);
  });

  it('applies identity-union via updateSession and preserves existing events', async () => {
    const sessionId = 'session-union';
    const turnId = 'turn-union';
    const existing = makeStatusEvent(1, 1_000);
    const duplicate = makeStatusEvent(1, 1_000);
    const novel = makeStatusEvent(2, 1_100);
    const initialSession = makeSession(sessionId, turnId, [existing]);
    let merged: AgentSession | null = null;

    updateSessionMock.mockImplementation(async (_id: string, mutator: (session: AgentSession | null) => AgentSession | null) => {
      merged = mutator(initialSession);
      return true;
    });

    const handler = registeredHandlers.get('sessions:apply-turn-event-union');
    expect(handler).toBeDefined();

    const response = await handler?.(
      {},
      { sessionId, turnId, events: [duplicate, novel] },
    );

    expect(response).toEqual({ success: true });
    expect(updateSessionWithReloadMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId,
      lockManager: deps.sessionLockManager,
      ownerKind: 'desktop',
    }));
    expect(merged).not.toBeNull();
    const mergedSession = merged as unknown as AgentSession;
    expect(mergedSession.eventsByTurn[turnId]).toHaveLength(2);
    expect(
      mergedSession.eventsByTurn[turnId].map((event: AgentEvent) => event.seq),
    ).toEqual([1, 2]);
    expect(onSessionsSavedMock).toHaveBeenCalledWith([mergedSession]);
    expect(deps.onSessionsSavedLocally).toHaveBeenCalledWith([mergedSession]);
  });

  it('returns a not-found failure when updateSession reports no write', async () => {
    updateSessionMock.mockResolvedValue(false);

    const handler = registeredHandlers.get('sessions:apply-turn-event-union');
    expect(handler).toBeDefined();

    const response = await handler?.(
      {},
      {
        sessionId: 'missing-session',
        turnId: 'turn-missing',
        events: [makeStatusEvent(1, 2_000)],
      },
    );

    expect(response).toEqual({
      success: false,
      error: { message: 'Session not found' },
    });
    expect(deps.onSessionsSavedLocally).not.toHaveBeenCalled();
  });

  it('bumps updatedAt for status-only unions with no new messages', async () => {
    const sessionId = 'session-status-only';
    const turnId = 'turn-status-only';
    const existing = makeStatusEvent(1, 1_000);
    const statusOnly = makeStatusEvent(2, 1_050);
    const initialUpdatedAt = 10_000;
    const initialSession = makeSession(
      sessionId,
      turnId,
      [existing],
      { updatedAt: initialUpdatedAt },
    );
    let merged = initialSession;

    updateSessionMock.mockImplementation(
      async (_id: string, mutator: (session: AgentSession | null) => AgentSession | null) => {
        const next = mutator(initialSession);
        if (next) {
          merged = next;
        }
        return true;
      },
    );

    const handler = registeredHandlers.get('sessions:apply-turn-event-union');
    expect(handler).toBeDefined();

    const response = await handler?.(
      {},
      { sessionId, turnId, events: [statusOnly] },
    );

    expect(response).toEqual({ success: true });
    expect(merged.updatedAt).toBeGreaterThan(initialUpdatedAt);
  });

  it('keeps updatedAt strictly monotonic across successive apply-turn-event-union calls', async () => {
    const sessionId = 'session-monotonic';
    const turnId = 'turn-monotonic';
    const existing = makeStatusEvent(1, 1_000);
    const status2 = makeStatusEvent(2, 1_100);
    const status3 = makeStatusEvent(3, 1_200);
    let storedSession = makeSession(
      sessionId,
      turnId,
      [existing],
      { updatedAt: 20_000 },
    );

    updateSessionMock.mockImplementation(
      async (_id: string, mutator: (session: AgentSession | null) => AgentSession | null) => {
        const next = mutator(storedSession);
        if (!next) return false;
        storedSession = next;
        return true;
      },
    );

    const handler = registeredHandlers.get('sessions:apply-turn-event-union');
    expect(handler).toBeDefined();

    const first = await handler?.({}, { sessionId, turnId, events: [status2] });
    expect(first).toEqual({ success: true });
    const afterFirst = storedSession.updatedAt;

    const second = await handler?.({}, { sessionId, turnId, events: [status3] });
    expect(second).toEqual({ success: true });
    const afterSecond = storedSession.updatedAt;

    expect(afterSecond).toBeGreaterThan(afterFirst);
  });

  it('collapses content-equivalent restamped events when persisting via IPC', async () => {
    const sessionId = 'session-restamp-ipc';
    const turnId = 'turn-restamp-ipc';
    const original: AgentEvent = {
      type: 'assistant',
      seq: 75,
      text: 'duplicated answer',
      timestamp: 1_000,
    };
    const restamped: AgentEvent = {
      type: 'assistant',
      seq: 77,
      text: 'duplicated answer',
      timestamp: 1_000,
    };
    const initialSession = makeSession(sessionId, turnId, [original]);
    let merged: AgentSession | null = null;

    updateSessionMock.mockImplementation(
      async (_id: string, mutator: (session: AgentSession | null) => AgentSession | null) => {
        merged = mutator(initialSession);
        return merged !== null;
      },
    );

    const handler = registeredHandlers.get('sessions:apply-turn-event-union');
    expect(handler).toBeDefined();

    const response = await handler?.(
      {},
      { sessionId, turnId, events: [restamped] },
    );

    expect(response).toEqual({ success: true });
    expect(merged).not.toBeNull();
    const mergedSession = merged as unknown as AgentSession;
    expect(mergedSession.eventsByTurn[turnId]).toHaveLength(1);
    expect(mergedSession.eventsByTurn[turnId][0].seq).toBe(75);
    expect(addBreadcrumbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'event-content-equivalent-restamp-collapsed',
        data: expect.objectContaining({
          turnIdHash: expect.any(String),
          droppedSeq: 77,
          retainedSeq: 75,
        }),
      }),
    );
  });

  it('emits one legacy-fallback breadcrumb per union call when seq is missing', async () => {
    const sessionId = 'session-legacy-breadcrumb';
    const turnId = 'turn-legacy-breadcrumb';
    const initialSession = makeSession(sessionId, turnId, [makeStatusEvent(1, 1_000)]);

    updateSessionMock.mockImplementation(
      async (_id: string, mutator: (session: AgentSession | null) => AgentSession | null) => {
        return Boolean(mutator(initialSession));
      },
    );

    const handler = registeredHandlers.get('sessions:apply-turn-event-union');
    expect(handler).toBeDefined();

    const response = await handler?.(
      {},
      { sessionId, turnId, events: [makeStatusEvent(undefined, 1_050)] },
    );

    expect(response).toEqual({ success: true });
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
    expect(addBreadcrumbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'event-identity-legacy-fallback',
        data: expect.objectContaining({
          turnIdHash: expect.any(String),
          legacyEventCount: 1,
        }),
      }),
    );
  });

  // Stage 19a (260506 Stage 3) — main-process union ingress now validates each
  // event's provenance sessionId against the session being persisted and drops
  // foreign-stamped events (fail-closed + telemetry). Proves BOTH directions.
  it('Stage 19a: drops a foreign-session-stamped event from the union and telemeters it', async () => {
    const sessionId = 'session-union-guard';
    const turnId = 'turn-union-guard';
    const mine: AgentEvent = { type: 'status', message: 'mine', timestamp: 1_100, seq: 2, sessionId } as AgentEvent;
    const foreign: AgentEvent = { type: 'status', message: 'foreign', timestamp: 1_200, seq: 3, sessionId: 'OTHER-session' } as AgentEvent;
    const initialSession = makeSession(sessionId, turnId, [makeStatusEvent(1, 1_000)]);
    let merged: AgentSession | null = null;

    updateSessionMock.mockImplementation(
      async (_id: string, mutator: (session: AgentSession | null) => AgentSession | null) => {
        merged = mutator(initialSession);
        return merged !== null;
      },
    );

    const handler = registeredHandlers.get('sessions:apply-turn-event-union');
    const response = await handler?.({}, { sessionId, turnId, events: [mine, foreign] });

    expect(response).toEqual({ success: true });
    const mergedSession = merged as unknown as AgentSession;
    const messages = mergedSession.eventsByTurn[turnId].map((e: AgentEvent) => (e as { message?: string }).message);
    // The same-session event lands; the foreign one is dropped.
    expect(messages).toContain('mine');
    expect(messages).not.toContain('foreign');
    expect(addBreadcrumbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'cross-session-event-dropped',
        data: expect.objectContaining({ source: 'sessions-handler-union', eventType: 'status' }),
      }),
    );
  });

  it('Stage 19a: keeps same-session-stamped events (no false-positive drop)', async () => {
    const sessionId = 'session-union-keep';
    const turnId = 'turn-union-keep';
    const e2: AgentEvent = { type: 'status', message: 'm2', timestamp: 1_100, seq: 2, sessionId } as AgentEvent;
    const e3: AgentEvent = { type: 'status', message: 'm3', timestamp: 1_200, seq: 3, sessionId } as AgentEvent;
    const initialSession = makeSession(sessionId, turnId, [makeStatusEvent(1, 1_000)]);
    let merged: AgentSession | null = null;

    updateSessionMock.mockImplementation(
      async (_id: string, mutator: (session: AgentSession | null) => AgentSession | null) => {
        merged = mutator(initialSession);
        return merged !== null;
      },
    );

    const handler = registeredHandlers.get('sessions:apply-turn-event-union');
    const response = await handler?.({}, { sessionId, turnId, events: [e2, e3] });

    expect(response).toEqual({ success: true });
    const mergedSession = merged as unknown as AgentSession;
    expect(mergedSession.eventsByTurn[turnId]).toHaveLength(3); // existing + 2 same-session
    expect(addBreadcrumbMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ category: 'cross-session-event-dropped' }),
    );
  });

  it('cleans MCP App trust state when deleting a session conversation', async () => {
    const handler = registeredHandlers.get('sessions:delete');
    expect(handler).toBeDefined();

    const response = await handler?.({}, { id: 'conversation-to-delete' });

    expect(response).toEqual({ success: true });
    expect(deleteSessionMock).toHaveBeenCalledWith('conversation-to-delete');
    expect(clearSessionApprovalsMock).toHaveBeenCalledWith('conversation-to-delete');
    expect(cleanupPermissionMock).toHaveBeenCalledWith('conversation-to-delete');
    expect(cleanupContextMock).toHaveBeenCalledWith('conversation-to-delete');
    expect(invalidateConversationNoncesMock).toHaveBeenCalledWith('conversation-to-delete');
    expect(invalidateSessionNoncesMock).toHaveBeenCalledWith('conversation-to-delete');
    expect(deps.onSessionDeletedLocally).toHaveBeenCalledWith('conversation-to-delete');
  });
});
