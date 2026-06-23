/**
 * Extended sessionStore tests -- debounce, handleSessionChanged edge cases.
 */

import { __resetSessionStoreSeqTrackingForTests, setSessionContinuityRecorder, useSessionStore } from '../stores/sessionStore';
import type { AgentEvent } from '@shared/types';

vi.mock('../cloudClient', async () => {
  const actual = await vi.importActual<typeof import('../cloudClient')>('../cloudClient');
  return {
    ...actual,
    getSessions: vi.fn(),
    getSession: vi.fn(),
    getTombstones: vi.fn(),
    deleteSession: vi.fn(),
  };
});

vi.mock('../persistence/persistenceHelpers', async () => {
  const actual = await vi.importActual<typeof import('../persistence/persistenceHelpers')>('../persistence/persistenceHelpers');
  return {
    ...actual,
    buildCacheKey: vi.fn((_cloudUrl: string, storeName: string) => `cache:${storeName}`),
    hydrateStore: vi.fn(),
    persistStore: vi.fn(),
  };
});

vi.mock('../persistence/persistenceRegistry', () => ({
  getPersistence: vi.fn(),
}));

import * as cloudClient from '../cloudClient';
import * as persistenceHelpers from '../persistence/persistenceHelpers';
import * as persistenceRegistry from '../persistence/persistenceRegistry';
const mockedGetSessions = vi.mocked(cloudClient.getSessions);
const mockedGetSession = vi.mocked(cloudClient.getSession);
const mockedGetTombstones = vi.mocked(cloudClient.getTombstones);
const mockedDeleteSession = vi.mocked(cloudClient.deleteSession);
const mockedBuildCacheKey = vi.mocked(persistenceHelpers.buildCacheKey);
const mockedHydrateStore = vi.mocked(persistenceHelpers.hydrateStore);
const mockedPersistStore = vi.mocked(persistenceHelpers.persistStore);
const mockedGetPersistence = vi.mocked(persistenceRegistry.getPersistence);
const mockedPersistenceAdapter = {
  removeItem: vi.fn(),
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(iterations = 8) {
  for (let i = 0; i < iterations; i += 1) {
    await Promise.resolve();
  }
}

const mockSummary = (id: string, updatedAt = Date.now()) => ({
  id,
  title: `Session ${id}`,
  createdAt: updatedAt - 1000,
  updatedAt,
  resolvedAt: null,
  preview: 'hello',
  messageCount: 2,
  activeTurnId: null,
  isBusy: false,
  lastError: null,
  doneAt: null,
  starredAt: null,
  deletedAt: null,
  origin: 'manual',
  usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 1 },
});

beforeEach(() => {
  vi.useFakeTimers();
  useSessionStore.getState().resetStore();
  __resetSessionStoreSeqTrackingForTests();
  setSessionContinuityRecorder(null);
  mockedGetSessions.mockClear();
  mockedGetSession.mockClear();
  mockedGetTombstones.mockClear();
  mockedGetTombstones.mockResolvedValue({ tombstones: [] });
  mockedDeleteSession.mockClear();
  mockedDeleteSession.mockResolvedValue({
    success: true,
    tombstone: {
      sessionId: 'session-a',
      deletedAt: 12_345,
      deletedBy: 'mobile',
      ttlExpiresAt: 22_345,
    },
  });
  mockedBuildCacheKey.mockClear();
  mockedBuildCacheKey.mockImplementation((_cloudUrl: string, storeName: string) => `cache:${storeName}`);
  mockedHydrateStore.mockClear();
  mockedHydrateStore.mockResolvedValue(null);
  mockedPersistStore.mockClear();
  mockedGetPersistence.mockClear();
  mockedPersistenceAdapter.removeItem.mockClear();
  mockedPersistenceAdapter.removeItem.mockResolvedValue(undefined);
  mockedGetPersistence.mockReturnValue(mockedPersistenceAdapter as never);
});

afterEach(() => {
  setSessionContinuityRecorder(null);
  vi.useRealTimers();
});

describe('sessionStore persistence', () => {
  it('hydrates sessions from cache and stores the cache key', async () => {
    const cachedSessions = [mockSummary('cached-1', Date.now() - 1000)];
    const cachedConversationOrder = ['conversation-2', 'conversation-1'];
    mockedBuildCacheKey
      .mockReturnValueOnce('cache:sessions')
      .mockReturnValueOnce('cache:conversation:')
      .mockReturnValueOnce('cache:conversationOrder');
    mockedHydrateStore
      .mockResolvedValueOnce(cachedSessions)
      .mockResolvedValueOnce(cachedConversationOrder);

    await useSessionStore.getState().hydrate('https://cloud.example.com');

    expect(mockedBuildCacheKey).toHaveBeenNthCalledWith(1, 'https://cloud.example.com', 'sessions');
    expect(mockedBuildCacheKey).toHaveBeenNthCalledWith(2, 'https://cloud.example.com', 'conversation:');
    expect(mockedBuildCacheKey).toHaveBeenNthCalledWith(3, 'https://cloud.example.com', 'conversationOrder');
    expect(mockedHydrateStore).toHaveBeenCalledWith('cache:sessions', expect.any(Function));
    expect(mockedHydrateStore).toHaveBeenCalledWith('cache:conversationOrder', expect.any(Function));
    expect(useSessionStore.getState()._cacheKey).toBe('cache:sessions');
    expect(useSessionStore.getState()._conversationCacheKeyPrefix).toBe('cache:conversation:');
    expect(useSessionStore.getState()._conversationOrderKey).toBe('cache:conversationOrder');
    expect(useSessionStore.getState()._conversationOrder).toEqual(cachedConversationOrder);
    expect(useSessionStore.getState().sessions).toEqual(cachedSessions);
  });

  it('persists fetched sessions when cache key is available', async () => {
    const fetchedSessions = [mockSummary('session-1', Date.now())];
    useSessionStore.setState({ _cacheKey: 'cache:sessions' });
    mockedGetSessions.mockResolvedValueOnce({ sessions: fetchedSessions, totalCount: 1 });

    await useSessionStore.getState().fetchSessions();

    expect(mockedPersistStore).toHaveBeenCalledWith('cache:sessions', fetchedSessions);
  });

  it('does not persist fetched sessions when cache key is missing', async () => {
    const fetchedSessions = [mockSummary('session-1', Date.now())];
    mockedGetSessions.mockResolvedValueOnce({ sessions: fetchedSessions, totalCount: 1 });

    await useSessionStore.getState().fetchSessions();

    expect(mockedPersistStore).not.toHaveBeenCalled();
  });

  it('persists updated sessions after session deletion when cache key exists', () => {
    useSessionStore.setState({
      _cacheKey: 'cache:sessions',
      sessions: [mockSummary('a'), mockSummary('b')],
    });

    useSessionStore.getState().handleSessionChanged('a', 'deleted');

    expect(mockedPersistStore).toHaveBeenCalledWith(
      'cache:sessions',
      [expect.objectContaining({ id: 'b' })],
    );
  });

  it('resets store state to initial values', () => {
    useSessionStore.setState({
      sessions: [mockSummary('a')],
      error: 'oops',
      currentSession: {
        id: 'a',
        title: 'Session A',
        messages: [],
        activeTurnId: null,
        isBusy: true,
        lastError: 'err',
        },
      _cacheKey: 'cache:sessions',
      _conversationCacheKeyPrefix: 'cache:conversation:',
      _conversationOrderKey: 'cache:conversationOrder',
      _conversationOrder: ['a'],
      _lastFetchOptions: { activeOnly: true },
      lastTombstoneSyncAt: 123,
      _sessionFetchInFlight: true,
      _sessionFetchDirty: true,
      completedStepsByTurnId: { t1: [{ label: 'x', toolName: 'tool', timestamp: 1 }] },
      missionTaskByTurnId: { t1: { mission: { goal: 'g' }, tasks: [{ id: '1', title: 'task', status: 'pending' }] } },
      connectionState: 'connected',
      forceEventReconnect: () => {},
    });

    useSessionStore.getState().resetStore();

    const state = useSessionStore.getState();
    expect(state.sessions).toEqual([]);
    expect(state.error).toBeNull();
    expect(state.currentSession).toBeNull();
    expect(state._cacheKey).toBeNull();
    expect(state._conversationCacheKeyPrefix).toBeNull();
    expect(state._conversationOrderKey).toBeNull();
    expect(state._conversationOrder).toEqual([]);
    expect(state._lastFetchOptions).toBeUndefined();
    expect(state.lastTombstoneSyncAt).toBeNull();
    expect(state.appliedSeq).toEqual({});
    expect(state._sessionFetchInFlight).toBe(false);
    expect(state._sessionFetchDirty).toBe(false);
    expect(state.completedStepsByTurnId).toEqual({});
    expect(state.missionTaskByTurnId).toEqual({});
    expect(state.connectionState).toBe('disconnected');
    expect(state.forceEventReconnect).toBeNull();
  });
});

describe('sessionStore tombstones', () => {
  it('applies tombstones during hydrate and updates cursor/cache', async () => {
    const keep = mockSummary('keep', 1000);
    const drop = mockSummary('drop', 900);
    mockedBuildCacheKey
      .mockReturnValueOnce('cache:sessions')
      .mockReturnValueOnce('cache:conversation:')
      .mockReturnValueOnce('cache:conversationOrder');
    mockedHydrateStore
      .mockResolvedValueOnce([keep, drop])
      .mockResolvedValueOnce(['drop', 'keep']);
    mockedGetTombstones.mockResolvedValueOnce({
      tombstones: [
        { sessionId: 'drop', deletedAt: 12345, deletedBy: 'cloud', ttlExpiresAt: 99999 },
      ],
      serverNow: 12345,
    });

    await useSessionStore.getState().hydrate('https://cloud.example.com');
    await flushMicrotasks();

    const state = useSessionStore.getState();
    expect(state.sessions.map((s) => s.id)).toEqual(['keep']);
    expect(state._conversationOrder).toEqual(['keep']);
    expect(state.lastTombstoneSyncAt).toBe(12345);
    expect(mockedPersistStore).toHaveBeenCalledWith('cache:sessions', [expect.objectContaining({ id: 'keep' })]);
    expect(mockedPersistStore).toHaveBeenCalledWith('cache:conversationOrder', ['keep']);
    expect(mockedPersistenceAdapter.removeItem).toHaveBeenCalledWith('cache:conversation:drop');
  });

  it('handles live tombstone events from EventBridge', async () => {
    useSessionStore.setState({
      sessions: [mockSummary('a'), mockSummary('b')],
      currentSession: { id: 'b', title: 'B', messages: [], activeTurnId: null, isBusy: false, lastError: null },
      _cacheKey: 'cache:sessions',
      _conversationCacheKeyPrefix: 'cache:conversation:',
      _conversationOrderKey: 'cache:conversationOrder',
      _conversationOrder: ['b', 'a'],
    });

    useSessionStore.getState().handleSessionTombstoned({
      sessionId: 'b',
      deletedAt: 777,
      deletedBy: 'mobile',
      ttlExpiresAt: 999999,
    });
    await flushMicrotasks();

    const state = useSessionStore.getState();
    expect(state.sessions.map((s) => s.id)).toEqual(['a']);
    expect(state.currentSession).toBeNull();
    expect(state._conversationOrder).toEqual(['a']);
    expect(state.lastTombstoneSyncAt).toBe(777);
    expect(mockedPersistenceAdapter.removeItem).toHaveBeenCalledWith('cache:conversation:b');
  });

  it('advances tombstone cursor from serverNow on empty hydrate response', async () => {
    mockedBuildCacheKey
      .mockReturnValueOnce('cache:sessions')
      .mockReturnValueOnce('cache:conversation:')
      .mockReturnValueOnce('cache:conversationOrder');
    mockedHydrateStore
      .mockResolvedValueOnce([mockSummary('keep')])
      .mockResolvedValueOnce(['keep']);
    mockedGetTombstones.mockResolvedValueOnce({
      tombstones: [],
      serverNow: 45678,
    });

    await useSessionStore.getState().hydrate('https://cloud.example.com');
    await flushMicrotasks();

    expect(useSessionStore.getState().lastTombstoneSyncAt).toBe(45678);
  });

  it('does not resurrect a tombstoned session when an in-flight fetch resolves late', async () => {
    useSessionStore.setState({
      sessions: [mockSummary('ghost')],
      currentSession: {
        id: 'ghost',
        title: 'Ghost',
        messages: [],
        activeTurnId: null,
        isBusy: false,
        lastError: null,
      },
    });

    const deferred = createDeferred<Record<string, unknown>>();
    mockedGetSession.mockImplementationOnce(() => deferred.promise);

    const fetchPromise = useSessionStore.getState().fetchSession('ghost');
    await flushMicrotasks();
    expect(useSessionStore.getState().isLoadingSession).toBe(true);

    useSessionStore.getState().handleSessionTombstoned({
      sessionId: 'ghost',
      deletedAt: 999,
      deletedBy: 'mobile',
      ttlExpiresAt: 999999,
    });

    deferred.resolve({
      id: 'ghost',
      title: 'Late session payload',
      messages: [{ id: 'm-1', role: 'assistant', content: 'should not reappear' }],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {},
    });

    await fetchPromise;
    await flushMicrotasks();

    expect(useSessionStore.getState().currentSession).toBeNull();
    expect(useSessionStore.getState().isLoadingSession).toBe(false);
  });

  it('deleteSessionOptimistically removes locally and calls cloud delete with surface', async () => {
    mockedDeleteSession.mockResolvedValueOnce({
      success: true,
      tombstone: {
        sessionId: 'a',
        deletedAt: 45_678,
        deletedBy: 'mobile',
        ttlExpiresAt: 55_678,
      },
    });
    useSessionStore.setState({
      sessions: [mockSummary('a'), mockSummary('b')],
      _cacheKey: 'cache:sessions',
      _conversationCacheKeyPrefix: 'cache:conversation:',
      _conversationOrderKey: 'cache:conversationOrder',
      _conversationOrder: ['a', 'b'],
    });

    await useSessionStore.getState().deleteSessionOptimistically('a', 'mobile');
    await flushMicrotasks();

    expect(mockedDeleteSession).toHaveBeenCalledWith('a', 'mobile');
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['b']);
    expect(useSessionStore.getState()._conversationOrder).toEqual(['b']);
    expect(useSessionStore.getState().lastTombstoneSyncAt).toBe(45_678);
    expect(mockedPersistenceAdapter.removeItem).toHaveBeenCalledWith('cache:conversation:a');
  });

  it('deleteSessionOptimistically keeps the prior tombstone cursor and emits a breadcrumb when server time is missing', async () => {
    const continuityEvents: import('../observability/continuityEvents').ContinuityTransitionEvent[] = [];
    setSessionContinuityRecorder((event) => {
      continuityEvents.push(event);
    });
    mockedDeleteSession.mockResolvedValueOnce({ success: true });
    useSessionStore.setState({
      sessions: [mockSummary('a'), mockSummary('b')],
      _cacheKey: 'cache:sessions',
      _conversationOrderKey: 'cache:conversationOrder',
      _conversationOrder: ['a', 'b'],
      lastTombstoneSyncAt: 777,
    });

    await useSessionStore.getState().deleteSessionOptimistically('a', 'mobile');

    expect(useSessionStore.getState().lastTombstoneSyncAt).toBe(777);
    expect(continuityEvents).toContainEqual(expect.objectContaining({
      family: 'continuity-state',
      message: 'transition',
      level: 'warning',
      data: expect.objectContaining({
        reason: 'tombstone-cursor-missing-server-time',
        direction: 'mobile-delete',
        lastTombstoneSyncAt: 777,
      }),
    }));
  });

  it('deleteSessionOptimistically rolls back local state when cloud delete fails', async () => {
    mockedDeleteSession.mockRejectedValueOnce(new Error('delete failed'));
    useSessionStore.setState({
      sessions: [mockSummary('a'), mockSummary('b')],
      _cacheKey: 'cache:sessions',
      _conversationOrderKey: 'cache:conversationOrder',
      _conversationOrder: ['a', 'b'],
    });

    await expect(
      useSessionStore.getState().deleteSessionOptimistically('a', 'mobile'),
    ).rejects.toThrow('delete failed');

    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['a', 'b']);
    expect(useSessionStore.getState()._conversationOrder).toEqual(['a', 'b']);
  });
});

describe('sessionStore tombstone marker set (isSessionTombstoned)', () => {
  // The mobile queue consumer recreates a conversation only on a *positive*
  // tombstone signal — never inferred from store absence. These tests pin that
  // the Set is actually populated at every tombstone-application site, removed
  // on optimistic-delete rollback, and cleared by resetStore. (Stage 1b:
  // GPT F2/F4, Claude R5.)

  it('hydrate populates the tombstone marker set', async () => {
    mockedBuildCacheKey
      .mockReturnValueOnce('cache:sessions')
      .mockReturnValueOnce('cache:conversation:')
      .mockReturnValueOnce('cache:conversationOrder');
    mockedHydrateStore
      .mockResolvedValueOnce([mockSummary('keep', 1000)])
      .mockResolvedValueOnce(['keep']);
    mockedGetTombstones.mockResolvedValueOnce({
      tombstones: [
        { sessionId: 'gone-1', deletedAt: 100, deletedBy: 'cloud', ttlExpiresAt: 99999 },
        { sessionId: 'gone-2', deletedAt: 200, deletedBy: 'desktop', ttlExpiresAt: 99999 },
      ],
      serverNow: 200,
    });

    await useSessionStore.getState().hydrate('https://cloud.example.com');
    await flushMicrotasks();

    const state = useSessionStore.getState();
    expect(state.isSessionTombstoned('gone-1')).toBe(true);
    expect(state.isSessionTombstoned('gone-2')).toBe(true);
    expect(state.isSessionTombstoned('keep')).toBe(false);
  });

  it('deleteSessionOptimistically populates the marker set, and rollback removes it', async () => {
    mockedDeleteSession.mockResolvedValueOnce({
      success: true,
      tombstone: { sessionId: 'a', deletedAt: 1, deletedBy: 'mobile', ttlExpiresAt: 9 },
    });
    useSessionStore.setState({
      sessions: [mockSummary('a'), mockSummary('b')],
      _cacheKey: 'cache:sessions',
      _conversationOrderKey: 'cache:conversationOrder',
      _conversationOrder: ['a', 'b'],
    });

    await useSessionStore.getState().deleteSessionOptimistically('a', 'mobile');
    await flushMicrotasks();
    expect(useSessionStore.getState().isSessionTombstoned('a')).toBe(true);

    // Now a failing delete must roll the marker back off.
    mockedDeleteSession.mockRejectedValueOnce(new Error('delete failed'));
    useSessionStore.setState({
      sessions: [mockSummary('c'), mockSummary('d')],
      _conversationOrder: ['c', 'd'],
    });
    await expect(
      useSessionStore.getState().deleteSessionOptimistically('c', 'mobile'),
    ).rejects.toThrow('delete failed');
    expect(useSessionStore.getState().isSessionTombstoned('c')).toBe(false);
    // The earlier successful tombstone is untouched by the rollback.
    expect(useSessionStore.getState().isSessionTombstoned('a')).toBe(true);
  });

  it("handleSessionChanged('deleted') populates the marker set", () => {
    useSessionStore.setState({ sessions: [mockSummary('x')] });
    useSessionStore.getState().handleSessionChanged('x', 'deleted');
    expect(useSessionStore.getState().isSessionTombstoned('x')).toBe(true);
  });

  it('handleSessionTombstoned populates the marker set', () => {
    useSessionStore.setState({ sessions: [mockSummary('y')] });
    useSessionStore.getState().handleSessionTombstoned({
      sessionId: 'y',
      deletedAt: 5,
      deletedBy: 'mobile',
      ttlExpiresAt: 99999,
    });
    expect(useSessionStore.getState().isSessionTombstoned('y')).toBe(true);
  });

  it('resetStore clears the marker set', () => {
    useSessionStore.getState().handleSessionChanged('z', 'deleted');
    expect(useSessionStore.getState().isSessionTombstoned('z')).toBe(true);
    useSessionStore.getState().resetStore();
    expect(useSessionStore.getState().isSessionTombstoned('z')).toBe(false);
    expect(useSessionStore.getState().tombstonedSessionIds.size).toBe(0);
  });

  it('caps the marker set at 200, evicting oldest-first', () => {
    for (let i = 0; i < 250; i += 1) {
      useSessionStore.getState().handleSessionChanged(`del-${i}`, 'deleted');
    }
    const state = useSessionStore.getState();
    expect(state.tombstonedSessionIds.size).toBe(200);
    // Oldest 50 evicted; newest 200 retained.
    expect(state.isSessionTombstoned('del-0')).toBe(false);
    expect(state.isSessionTombstoned('del-49')).toBe(false);
    expect(state.isSessionTombstoned('del-50')).toBe(true);
    expect(state.isSessionTombstoned('del-249')).toBe(true);
  });
});

describe('sessionStore conversation cache', () => {
  it('shows cached conversation immediately on cache hit before fresh fetch resolves', async () => {
    useSessionStore.setState({
      _conversationCacheKeyPrefix: 'cache:conversation:',
      _conversationOrderKey: 'cache:conversationOrder',
    });
    mockedHydrateStore.mockResolvedValueOnce({
      id: 'session-1',
      title: 'Cached Session',
      messages: [{ id: 'm-1', role: 'assistant', content: 'cached' }],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
    });

    const deferred = createDeferred<Record<string, unknown>>();
    mockedGetSession.mockImplementationOnce(() => deferred.promise);

    const fetchPromise = useSessionStore.getState().fetchSession('session-1');
    await flushMicrotasks();

    expect(useSessionStore.getState().currentSession?.title).toBe('Cached Session');
    expect(mockedGetSession).toHaveBeenCalledWith('session-1');

    deferred.resolve({
      id: 'session-1',
      title: 'Fresh Session',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {},
    });

    await fetchPromise;
    expect(useSessionStore.getState().currentSession?.title).toBe('Fresh Session');
  });

  it('proceeds normally on cache miss', async () => {
    useSessionStore.setState({
      _conversationCacheKeyPrefix: 'cache:conversation:',
      _conversationOrderKey: 'cache:conversationOrder',
    });
    mockedHydrateStore.mockResolvedValueOnce(null);
    mockedGetSession.mockResolvedValueOnce({
      id: 'session-2',
      title: 'Fresh Session',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {},
    });

    await useSessionStore.getState().fetchSession('session-2');

    expect(mockedHydrateStore).toHaveBeenCalledWith('cache:conversation:session-2', expect.any(Function));
    expect(useSessionStore.getState().currentSession?.id).toBe('session-2');
  });

  it('passes session externalContext through to currentSession', async () => {
    mockedGetSession.mockResolvedValueOnce({
      id: 'session-slack',
      title: 'Slack Session',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {},
      externalContext: {
        kind: 'slack-thread',
        identity: { teamId: 'T1', channelId: 'C1', threadTs: '1700000000.123456' },
        metadata: {
          userId: 'U1',
          userName: 'Alice',
          userDisplayName: null,
          channelName: 'planning',
          teamName: 'Acme',
          permalink: 'https://acme.slack.com/archives/C1/p1700000000123456',
        },
      },
    });

    await useSessionStore.getState().fetchSession('session-slack');

    expect(useSessionStore.getState().currentSession?.externalContext).toEqual({
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '1700000000.123456' },
      metadata: {
        userId: 'U1',
        userName: 'Alice',
        userDisplayName: null,
        channelName: 'planning',
        teamName: 'Acme',
        permalink: 'https://acme.slack.com/archives/C1/p1700000000123456',
      },
    });
  });

  it('carries doneAt/starredAt through to currentSession (detail view Reopen toggle)', async () => {
    // B3b regression guard: the detail view reads currentSession.doneAt to drive
    // the Mark-as-done ⇄ Reopen toggle. fetchSession must not strip lifecycle
    // fields when constructing the FullSession. See docs/plans/260614_done-state-rename.
    mockedGetSession.mockResolvedValueOnce({
      id: 'session-done',
      title: 'Done Session',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {},
      doneAt: 1700000000000,
      starredAt: 1700000005000,
    });

    await useSessionStore.getState().fetchSession('session-done');

    const session = useSessionStore.getState().currentSession;
    expect(session?.doneAt).toBe(1700000000000);
    expect(session?.starredAt).toBe(1700000005000);
  });

  it('carries an explicit null doneAt/starredAt through (active, unstarred session)', async () => {
    mockedGetSession.mockResolvedValueOnce({
      id: 'session-active',
      title: 'Active Session',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {},
      doneAt: null,
      starredAt: null,
    });

    await useSessionStore.getState().fetchSession('session-active');

    const session = useSessionStore.getState().currentSession;
    expect(session?.doneAt).toBeNull();
    expect(session?.starredAt).toBeNull();
  });

  it('maps REST-loaded tool events with MCP App UI metadata and toolResult for mobile placeholders', async () => {
    const structuredFallback = {
      kind: 'email-draft' as const,
      payload: {
        to: ['person@example.com'],
        cc: [],
        bcc: [],
        subject: 'Hello',
        body: 'Draft body.',
      },
    };
    const toolResult = {
      content: [{ type: 'text', text: 'Draft ready' }],
      structuredContent: { subject: 'Hello', body: 'Draft body.' },
    };
    mockedGetSession.mockResolvedValueOnce({
      id: 'session-mcp-app',
      title: 'MCP App Session',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {
        'turn-1': [{
          type: 'tool',
          toolName: 'compose_workspace_email',
          detail: 'Draft ready',
          stage: 'end',
          timestamp: 1,
          toolUseId: 'tu-compose',
          mcpAppUiMeta: {
            resourceUri: 'ui://google-workspace/compose-email',
            presentation: 'primary',
            viewSummary: 'Email draft ready.',
            viewRoleLabel: 'Editable email draft',
            structuredFallback,
          },
          toolResult,
        }],
      },
    });

    await useSessionStore.getState().fetchSession('session-mcp-app');

    const event = useSessionStore.getState().currentSession?.toolEventsByTurn?.['turn-1']?.[0];
    expect(event).toMatchObject({
      type: 'tool',
      toolName: 'compose_workspace_email',
      mcpAppUiMeta: {
        presentation: 'primary',
        viewSummary: 'Email draft ready.',
        viewRoleLabel: 'Editable email draft',
        structuredFallback,
      },
      toolResult,
    });
  });

  it('persists successful non-busy fetches to per-conversation cache without toolEventsByTurn', async () => {
    useSessionStore.setState({
      _conversationCacheKeyPrefix: 'cache:conversation:',
      _conversationOrderKey: 'cache:conversationOrder',
    });
    mockedHydrateStore.mockResolvedValueOnce(null);
    mockedGetSession.mockResolvedValueOnce({
      id: 'session-3',
      title: 'Fresh Session',
      messages: [{ id: 'm-1', role: 'assistant', content: 'hello' }],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {
        'turn-1': [{ type: 'tool', toolName: 'search', detail: 'x', stage: 'end', timestamp: 1 }],
      },
    });

    await useSessionStore.getState().fetchSession('session-3');

    expect(mockedPersistStore).toHaveBeenCalledWith(
      'cache:conversation:session-3',
      expect.objectContaining({
        id: 'session-3',
        title: 'Fresh Session',
        isBusy: false,
      }),
    );
    expect(mockedPersistStore).toHaveBeenCalledWith('cache:conversationOrder', ['session-3']);
    const conversationPersistCall = mockedPersistStore.mock.calls.find(([key]) => key === 'cache:conversation:session-3');
    const persistedSession = conversationPersistCall?.[1] as Record<string, unknown>;
    expect(persistedSession).not.toHaveProperty('toolEventsByTurn');
    expect(persistedSession).not.toHaveProperty('userQuestionEventsByTurn');
    expect(useSessionStore.getState()._conversationOrder).toEqual(['session-3']);
  });

  it('caches multiple conversations and keeps MRU order', async () => {
    useSessionStore.setState({
      _conversationCacheKeyPrefix: 'cache:conversation:',
      _conversationOrderKey: 'cache:conversationOrder',
    });
    mockedGetSession.mockImplementation(async (id: string) => ({
      id,
      title: `Session ${id}`,
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {},
    }));

    await useSessionStore.getState().fetchSession('session-a');
    await useSessionStore.getState().fetchSession('session-b');
    await useSessionStore.getState().fetchSession('session-c');

    expect(mockedPersistStore).toHaveBeenCalledWith('cache:conversation:session-a', expect.objectContaining({ id: 'session-a' }));
    expect(mockedPersistStore).toHaveBeenCalledWith('cache:conversation:session-b', expect.objectContaining({ id: 'session-b' }));
    expect(mockedPersistStore).toHaveBeenCalledWith('cache:conversation:session-c', expect.objectContaining({ id: 'session-c' }));
    expect(useSessionStore.getState()._conversationOrder).toEqual(['session-c', 'session-b', 'session-a']);
    expect(mockedPersistStore).toHaveBeenCalledWith('cache:conversationOrder', ['session-c', 'session-b', 'session-a']);
  });

  it('evicts the oldest cached conversation when cache exceeds 10 entries', async () => {
    useSessionStore.setState({
      _conversationCacheKeyPrefix: 'cache:conversation:',
      _conversationOrderKey: 'cache:conversationOrder',
    });
    mockedGetSession.mockImplementation(async (id: string) => ({
      id,
      title: `Session ${id}`,
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {},
    }));

    for (let i = 1; i <= 11; i += 1) {
      await useSessionStore.getState().fetchSession(`session-${i}`);
    }

    const state = useSessionStore.getState();
    expect(state._conversationOrder).toHaveLength(10);
    expect(state._conversationOrder).toEqual([
      'session-11',
      'session-10',
      'session-9',
      'session-8',
      'session-7',
      'session-6',
      'session-5',
      'session-4',
      'session-3',
      'session-2',
    ]);
    expect(mockedPersistenceAdapter.removeItem).toHaveBeenCalledWith('cache:conversation:session-1');
    expect(mockedPersistStore).toHaveBeenCalledWith('cache:conversationOrder', state._conversationOrder);
  });

  it('shows cached content when fetch fails offline for a previously cached conversation id', async () => {
    useSessionStore.setState({
      _conversationCacheKeyPrefix: 'cache:conversation:',
      _conversationOrderKey: 'cache:conversationOrder',
    });
    mockedHydrateStore.mockResolvedValueOnce({
      id: 'session-offline',
      title: 'Cached Offline Session',
      messages: [{ id: 'm-1', role: 'assistant', content: 'cached content' }],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
    });
    mockedGetSession.mockRejectedValueOnce(new Error('Network request failed'));

    await useSessionStore.getState().fetchSession('session-offline');

    expect(useSessionStore.getState().currentSession?.title).toBe('Cached Offline Session');
    expect(useSessionStore.getState().error).toContain('Network request failed');
  });

  it('does not cache busy sessions', async () => {
    useSessionStore.setState({
      _conversationCacheKeyPrefix: 'cache:conversation:',
      _conversationOrderKey: 'cache:conversationOrder',
    });
    mockedHydrateStore.mockResolvedValueOnce(null);
    mockedGetSession.mockResolvedValueOnce({
      id: 'session-busy',
      title: 'Busy Session',
      messages: [],
      activeTurnId: 'turn-1',
      isBusy: true,
      lastError: null,
      eventsByTurn: {},
    });

    await useSessionStore.getState().fetchSession('session-busy');

    expect(mockedPersistStore).not.toHaveBeenCalled();
  });

  it('clears deleted sessions from conversation cache and LRU order', async () => {
    useSessionStore.setState({
      _conversationCacheKeyPrefix: 'cache:conversation:',
      _conversationOrderKey: 'cache:conversationOrder',
      _conversationOrder: ['session-keep', 'session-delete-me'],
      sessions: [mockSummary('session-delete-me')],
    });

    useSessionStore.getState().handleSessionChanged('session-delete-me', 'deleted');
    await flushMicrotasks();

    expect(useSessionStore.getState()._conversationOrder).toEqual(['session-keep']);
    expect(mockedPersistStore).toHaveBeenCalledWith('cache:conversationOrder', ['session-keep']);
    expect(mockedPersistenceAdapter.removeItem).toHaveBeenCalledWith('cache:conversation:session-delete-me');
  });

  it('clears cached currentSession on definitive fetch failure after cache load', async () => {
    useSessionStore.setState({
      _conversationCacheKeyPrefix: 'cache:conversation:',
      _conversationOrderKey: 'cache:conversationOrder',
    });
    mockedHydrateStore.mockResolvedValueOnce({
      id: 'session-404',
      title: 'Cached Session',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
    });
    mockedGetSession.mockRejectedValueOnce(new cloudClient.CloudClientError('HTTP 404: Session not found', 404));

    await useSessionStore.getState().fetchSession('session-404');

    expect(useSessionStore.getState().currentSession).toBeNull();
    expect(useSessionStore.getState().error).toContain('Session not found');
  });
});

describe('sessionStore handleSessionChanged', () => {
  describe('deleted action', () => {
    it('removes session from list immediately', () => {
      useSessionStore.setState({ sessions: [mockSummary('a'), mockSummary('b')] });

      useSessionStore.getState().handleSessionChanged('a', 'deleted');

      expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['b']);
    });

    it('clears currentSession if it matches', () => {
      useSessionStore.setState({
        sessions: [mockSummary('a')],
        currentSession: { id: 'a', title: 'A', messages: [], activeTurnId: null, isBusy: false, lastError: null },
      });

      useSessionStore.getState().handleSessionChanged('a', 'deleted');

      expect(useSessionStore.getState().currentSession).toBeNull();
    });

    it('does not clear currentSession if different', () => {
      useSessionStore.setState({
        sessions: [mockSummary('a'), mockSummary('b')],
        currentSession: { id: 'b', title: 'B', messages: [], activeTurnId: null, isBusy: false, lastError: null },
      });

      useSessionStore.getState().handleSessionChanged('a', 'deleted');

      expect(useSessionStore.getState().currentSession?.id).toBe('b');
    });

    it('invalidates in-flight fetchSession so deleted sessions do not rehydrate', async () => {
      useSessionStore.setState({
        sessions: [mockSummary('ghost')],
        currentSession: { id: 'ghost', title: 'Ghost', messages: [], activeTurnId: null, isBusy: false, lastError: null },
      });

      const deferred = createDeferred<Record<string, unknown>>();
      mockedGetSession.mockImplementationOnce(() => deferred.promise);

      const fetchPromise = useSessionStore.getState().fetchSession('ghost');
      await flushMicrotasks();
      expect(useSessionStore.getState().isLoadingSession).toBe(true);

      useSessionStore.getState().handleSessionChanged('ghost', 'deleted');

      deferred.resolve({
        id: 'ghost',
        title: 'late ghost payload',
        messages: [],
        activeTurnId: null,
        isBusy: false,
        lastError: null,
        eventsByTurn: {},
      });

      await fetchPromise;
      await flushMicrotasks();

      expect(useSessionStore.getState().currentSession).toBeNull();
      expect(useSessionStore.getState().isLoadingSession).toBe(false);
    });
  });

  describe('upserted action (debounce)', () => {
    it('debounces fetchSessions calls', () => {
      mockedGetSessions.mockResolvedValue({ sessions: [], totalCount: 0 });

      // Fire 5 rapid events
      for (let i = 0; i < 5; i++) {
        useSessionStore.getState().handleSessionChanged(`s${i}`, 'upserted');
      }

      // Before debounce fires, no fetch
      expect(mockedGetSessions).not.toHaveBeenCalled();

      // Advance past debounce (1.5s)
      vi.advanceTimersByTime(1500);

      // Should only have fetched once
      expect(mockedGetSessions).toHaveBeenCalledTimes(1);
    });

    it('refreshes current session immediately if it matches', () => {
      mockedGetSession.mockResolvedValue({
        id: 'current',
        title: 'Current',
        messages: [],
        activeTurnId: null,
        isBusy: false,
        lastError: null,
      });
      useSessionStore.setState({
        currentSession: { id: 'current', title: 'Current', messages: [], activeTurnId: null, isBusy: false, lastError: null },
      });

      useSessionStore.getState().handleSessionChanged('current', 'upserted');

      // Should immediately fetch the current session (no debounce for active session)
      expect(mockedGetSession).toHaveBeenCalledWith('current');
    });

    it('does not fetch current session if it does not match', () => {
      useSessionStore.setState({
        currentSession: { id: 'other', title: 'Other', messages: [], activeTurnId: null, isBusy: false, lastError: null },
      });

      useSessionStore.getState().handleSessionChanged('different', 'upserted');

      expect(mockedGetSession).not.toHaveBeenCalled();
    });

    it('resets debounce timer on rapid calls', () => {
      mockedGetSessions.mockResolvedValue({ sessions: [], totalCount: 0 });

      useSessionStore.getState().handleSessionChanged('s1', 'upserted');
      vi.advanceTimersByTime(1000); // 1s into 1.5s debounce
      expect(mockedGetSessions).not.toHaveBeenCalled();

      // New event resets timer
      useSessionStore.getState().handleSessionChanged('s2', 'upserted');
      vi.advanceTimersByTime(1000); // 1s into new 1.5s debounce
      expect(mockedGetSessions).not.toHaveBeenCalled();

      vi.advanceTimersByTime(500); // Now past 1.5s from last event
      expect(mockedGetSessions).toHaveBeenCalledTimes(1);
    });

    it('coalesces current-session fetches and runs trailing fetches until final state is loaded', async () => {
      useSessionStore.setState({
        currentSession: { id: 'current', title: 'Current', messages: [], activeTurnId: null, isBusy: false, lastError: null },
      });

      let inFlightCount = 0;
      let maxInFlightCount = 0;
      const pending: Array<ReturnType<typeof createDeferred<Record<string, unknown>>>> = [];
      mockedGetSession.mockImplementation(() => {
        inFlightCount += 1;
        maxInFlightCount = Math.max(maxInFlightCount, inFlightCount);
        const deferred = createDeferred<Record<string, unknown>>();
        pending.push(deferred);
        return deferred.promise.finally(() => {
          inFlightCount -= 1;
        });
      });

      useSessionStore.getState().handleSessionChanged('current', 'upserted');
      useSessionStore.getState().handleSessionChanged('current', 'upserted');
      useSessionStore.getState().handleSessionChanged('current', 'upserted');

      expect(mockedGetSession).toHaveBeenCalledTimes(1);
      expect(useSessionStore.getState()._sessionFetchInFlight).toBe(true);
      expect(useSessionStore.getState()._sessionFetchDirty).toBe(true);

      pending[0].resolve({
        id: 'current',
        title: 'v1',
        messages: [],
        activeTurnId: null,
        isBusy: true,
        lastError: null,
      });
      await flushMicrotasks();

      // Dirty flag triggers one trailing fetch after first completion.
      expect(mockedGetSession).toHaveBeenCalledTimes(2);
      expect(maxInFlightCount).toBe(1);
      expect(useSessionStore.getState()._sessionFetchInFlight).toBe(true);
      expect(useSessionStore.getState()._sessionFetchDirty).toBe(false);

      // Another event during trailing fetch marks dirty again (no concurrent fetch).
      useSessionStore.getState().handleSessionChanged('current', 'upserted');
      expect(mockedGetSession).toHaveBeenCalledTimes(2);
      expect(useSessionStore.getState()._sessionFetchDirty).toBe(true);

      pending[1].resolve({
        id: 'current',
        title: 'v2',
        messages: [],
        activeTurnId: null,
        isBusy: true,
        lastError: null,
      });
      await flushMicrotasks();

      expect(mockedGetSession).toHaveBeenCalledTimes(3);
      expect(maxInFlightCount).toBe(1);
      expect(useSessionStore.getState()._sessionFetchInFlight).toBe(true);

      pending[2].resolve({
        id: 'current',
        title: 'v3-final',
        messages: [],
        activeTurnId: null,
        isBusy: false,
        lastError: null,
      });
      await flushMicrotasks();

      expect(useSessionStore.getState().currentSession?.title).toBe('v3-final');
      expect(useSessionStore.getState()._sessionFetchInFlight).toBe(false);
      expect(useSessionStore.getState()._sessionFetchDirty).toBe(false);
      expect(maxInFlightCount).toBe(1);
    });

    it('runs trailing fetch even when the in-flight fetch fails', async () => {
      useSessionStore.setState({
        currentSession: { id: 'current', title: 'Current', messages: [], activeTurnId: null, isBusy: false, lastError: null },
      });

      const first = createDeferred<Record<string, unknown>>();
      const second = createDeferred<Record<string, unknown>>();
      mockedGetSession
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise);

      useSessionStore.getState().handleSessionChanged('current', 'upserted');
      useSessionStore.getState().handleSessionChanged('current', 'upserted');

      expect(mockedGetSession).toHaveBeenCalledTimes(1);
      expect(useSessionStore.getState()._sessionFetchDirty).toBe(true);

      first.reject(new Error('temporary failure'));
      await flushMicrotasks();

      // Failure still clears in-flight and consumes dirty to trigger trailing fetch.
      expect(mockedGetSession).toHaveBeenCalledTimes(2);
      expect(useSessionStore.getState()._sessionFetchInFlight).toBe(true);

      second.resolve({
        id: 'current',
        title: 'Recovered',
        messages: [],
        activeTurnId: null,
        isBusy: false,
        lastError: null,
      });
      await flushMicrotasks();

      expect(useSessionStore.getState().currentSession?.title).toBe('Recovered');
      expect(useSessionStore.getState()._sessionFetchInFlight).toBe(false);
      expect(useSessionStore.getState()._sessionFetchDirty).toBe(false);
    });
  });
});

describe('sessionStore fetchSession tool events + completedSteps cache', () => {
  it('maps eventsByTurn into toolEventsByTurn and filters out non-tool events', async () => {
    mockedGetSession.mockResolvedValue({
      id: 'session-1',
      title: 'Session 1',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {
        'turn-1': [
          { type: 'tool', toolName: 'search', detail: '{"query":"hello"}', stage: 'start', timestamp: 1 },
          { type: 'assistant_delta', text: 'ignored', timestamp: 2 },
          { type: 'tool', toolName: 'search', detail: '{"query":"hello"}', stage: 'end', timestamp: 3, toolUseId: 'u1' },
        ],
        'turn-2': [
          { type: 'status', message: 'ignored', timestamp: 4 },
        ],
      },
    });

    await useSessionStore.getState().fetchSession('session-1');

    expect(useSessionStore.getState().currentSession?.toolEventsByTurn).toEqual({
      'turn-1': [
        {
          type: 'tool',
          toolName: 'search',
          detail: '{"query":"hello"}',
          stage: 'start',
          timestamp: 1,
          isError: undefined,
          toolUseId: undefined,
        },
        {
          type: 'tool',
          toolName: 'search',
          detail: '{"query":"hello"}',
          stage: 'end',
          timestamp: 3,
          isError: undefined,
          toolUseId: 'u1',
        },
      ],
    });
  });

  it('preserves valid imageContent on end-stage tool events', async () => {
    mockedGetSession.mockResolvedValue({
      id: 'session-1',
      title: 'Session 1',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {
        'turn-1': [
          { type: 'tool', toolName: 'screenshot', detail: 'starting', stage: 'start', timestamp: 1 },
          {
            type: 'tool',
            toolName: 'screenshot',
            detail: 'done',
            stage: 'end',
            timestamp: 2,
            imageContent: [{ type: 'image', data: 'abc123', mimeType: 'image/png' }],
          },
        ],
      },
    });

    await useSessionStore.getState().fetchSession('session-1');

    const toolEvents = useSessionStore.getState().currentSession?.toolEventsByTurn?.['turn-1'];
    expect(toolEvents).toBeDefined();
    expect(toolEvents?.[0]).not.toHaveProperty('imageContent');
    expect(toolEvents?.[1]).toEqual({
      type: 'tool',
      toolName: 'screenshot',
      detail: 'done',
      stage: 'end',
      timestamp: 2,
      isError: undefined,
      toolUseId: undefined,
      imageContent: [{ type: 'image', data: 'abc123', mimeType: 'image/png' }],
    });
  });

  it('drops invalid imageContent blocks and keeps valid ones', async () => {
    mockedGetSession.mockResolvedValue({
      id: 'session-1',
      title: 'Session 1',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {
        'turn-1': [
          {
            type: 'tool',
            toolName: 'screenshot',
            detail: 'done',
            stage: 'end',
            timestamp: 2,
            imageContent: [
              { type: 'image', data: 'valid-image', mimeType: 'image/png' },
              { type: 'image', data: '', mimeType: 'image/png' },
              { type: 'image', mimeType: 'image/png' },
              { type: 'text', data: 'oops', mimeType: 'image/png' },
              { type: 'image', data: 'bad-mime', mimeType: 123 },
            ],
          },
        ],
      },
    });

    await useSessionStore.getState().fetchSession('session-1');

    const event = useSessionStore.getState().currentSession?.toolEventsByTurn?.['turn-1']?.[0];
    expect(event?.imageContent).toEqual([{ type: 'image', data: 'valid-image', mimeType: 'image/png' }]);
  });

  it('omits imageContent when missing or empty', async () => {
    mockedGetSession.mockResolvedValue({
      id: 'session-1',
      title: 'Session 1',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {
        'turn-1': [
          { type: 'tool', toolName: 'screenshot', detail: 'done', stage: 'end', timestamp: 1 },
          { type: 'tool', toolName: 'screenshot', detail: 'done', stage: 'end', timestamp: 2, imageContent: [] },
        ],
      },
    });

    await useSessionStore.getState().fetchSession('session-1');

    const events = useSessionStore.getState().currentSession?.toolEventsByTurn?.['turn-1'];
    expect(events).toBeDefined();
    expect(events?.[0]).not.toHaveProperty('imageContent');
    expect(events?.[1]).not.toHaveProperty('imageContent');
  });

  it('preserves imageRef alongside imageContent on tool events (Stage 7b lean mapping)', async () => {
    mockedGetSession.mockResolvedValue({
      id: 'session-ref',
      title: 'Session Ref',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {
        'turn-1': [
          {
            type: 'tool',
            toolName: 'screenshot',
            detail: 'done',
            stage: 'end',
            timestamp: 2,
            imageRef: [
              {
                assetId: 'asset-1',
                mimeType: 'image/png',
                byteSize: 4096,
                uploadStatus: 'uploaded',
              },
            ],
          },
        ],
      },
    });

    await useSessionStore.getState().fetchSession('session-ref');

    const events = useSessionStore.getState().currentSession?.toolEventsByTurn?.['turn-1'];
    expect(events?.[0]?.imageRef).toEqual([
      {
        assetId: 'asset-1',
        mimeType: 'image/png',
        byteSize: 4096,
        uploadStatus: 'uploaded',
      },
    ]);
  });

  it('preserves unknown imageRef fields for forward-compat (D3)', async () => {
    mockedGetSession.mockResolvedValue({
      id: 'session-ref-future',
      title: 'Session Ref Future',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {
        'turn-1': [
          {
            type: 'tool',
            toolName: 'screenshot',
            detail: 'done',
            stage: 'end',
            timestamp: 2,
            imageRef: [
              {
                assetId: 'asset-2',
                mimeType: 'image/png',
                byteSize: 8192,
                width: 1200,
                height: 800,
                someFutureField: { provenance: 'agent-run-42' },
              },
            ],
          },
        ],
      },
    });

    await useSessionStore.getState().fetchSession('session-ref-future');

    const event = useSessionStore.getState().currentSession?.toolEventsByTurn?.['turn-1']?.[0];
    expect(event?.imageRef?.[0]).toMatchObject({
      assetId: 'asset-2',
      mimeType: 'image/png',
      byteSize: 8192,
      width: 1200,
      height: 800,
      someFutureField: { provenance: 'agent-run-42' },
    });
  });

  it('drops invalid imageRef entries to null while keeping valid ones (positional)', async () => {
    mockedGetSession.mockResolvedValue({
      id: 'session-ref-mixed',
      title: 'Session Ref Mixed',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {
        'turn-1': [
          {
            type: 'tool',
            toolName: 'screenshot',
            detail: 'done',
            stage: 'end',
            timestamp: 2,
            imageRef: [
              { assetId: 'asset-ok', mimeType: 'image/png', byteSize: 100 },
              { assetId: '', mimeType: 'image/png', byteSize: 100 },
              null,
              { assetId: 'asset-bad-bytesize', mimeType: 'image/png' },
            ],
          },
        ],
      },
    });

    await useSessionStore.getState().fetchSession('session-ref-mixed');

    const refs = useSessionStore.getState().currentSession?.toolEventsByTurn?.['turn-1']?.[0]
      ?.imageRef;
    expect(refs).toEqual([
      { assetId: 'asset-ok', mimeType: 'image/png', byteSize: 100 },
      null,
      null,
      null,
    ]);
  });

  it('omits imageRef when no valid entries are present', async () => {
    mockedGetSession.mockResolvedValue({
      id: 'session-no-ref',
      title: 'Session No Ref',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {
        'turn-1': [
          {
            type: 'tool',
            toolName: 'screenshot',
            detail: 'done',
            stage: 'end',
            timestamp: 2,
            imageRef: [null, { assetId: '', mimeType: 'image/png', byteSize: 0 }],
          },
        ],
      },
    });

    await useSessionStore.getState().fetchSession('session-no-ref');

    const event = useSessionStore.getState().currentSession?.toolEventsByTurn?.['turn-1']?.[0];
    expect(event).not.toHaveProperty('imageRef');
  });

  it('maps user_question + user_question_answered events into userQuestionEventsByTurn', async () => {
    // Stage 7: cross-session rehydration. After force-quit, mobile/cloud-client
    // needs the answered state to reach the card, not just tool events.
    const sampleQuestions = [
      {
        id: 'q0',
        question: 'Which option fits best?',
        header: 'Choose',
        options: [{ id: 'q0-opt0', label: 'A' }, { id: 'q0-opt1', label: 'B' }],
        multiSelect: false,
      },
    ];
    mockedGetSession.mockResolvedValue({
      id: 'session-uq',
      title: 'Session UQ',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {
        'turn-1': [
          { type: 'tool', toolName: 'search', detail: 'x', stage: 'start', timestamp: 1 },
          {
            type: 'user_question',
            batchId: 'batch-1',
            toolUseId: 'tu-1',
            questions: sampleQuestions,
            sessionId: 'session-uq',
            seq: 12,
            timestamp: 2,
          },
          {
            type: 'user_question_answered',
            batchId: 'batch-1',
            answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }],
            sessionId: 'session-uq',
            seq: 13,
            timestamp: 3,
          },
        ],
      },
    });

    await useSessionStore.getState().fetchSession('session-uq');

    expect(useSessionStore.getState().currentSession?.userQuestionEventsByTurn).toEqual({
      'turn-1': [
        {
          type: 'user_question',
          batchId: 'batch-1',
          toolUseId: 'tu-1',
          questions: sampleQuestions,
          sessionId: 'session-uq',
          seq: 12,
          timestamp: 2,
        },
        {
          type: 'user_question_answered',
          batchId: 'batch-1',
          answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }],
          sessionId: 'session-uq',
          seq: 13,
          timestamp: 3,
        },
      ],
    });
  });

  it('drops malformed user_question events (missing batchId / questions / toolUseId)', async () => {
    mockedGetSession.mockResolvedValue({
      id: 'session-uq2',
      title: 'Session UQ2',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {
        'turn-1': [
          { type: 'user_question', batchId: '', toolUseId: 'x', questions: [], timestamp: 1 },
          { type: 'user_question', batchId: 'b', questions: [], timestamp: 1 },
          { type: 'user_question', batchId: 'b', toolUseId: 'x', timestamp: 1 },
          { type: 'user_question_answered', batchId: 'b', timestamp: 2 },
          { type: 'user_question_answered', batchId: 'b', answers: [], timestamp: 'bad' },
        ],
      },
    });

    await useSessionStore.getState().fetchSession('session-uq2');

    // All inputs malformed — mapper returns undefined for the turn.
    expect(useSessionStore.getState().currentSession?.userQuestionEventsByTurn).toBeUndefined();
  });

  it('preserves skipped flag on user_question_answered rehydration', async () => {
    mockedGetSession.mockResolvedValue({
      id: 'session-uq3',
      title: 'Session UQ3',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {
        'turn-1': [
          {
            type: 'user_question_answered',
            batchId: 'batch-1',
            answers: [],
            skipped: true,
            sessionId: 'session-uq3',
            seq: 7,
            timestamp: 5,
          },
        ],
      },
    });

    await useSessionStore.getState().fetchSession('session-uq3');

    const events = useSessionStore.getState().currentSession?.userQuestionEventsByTurn?.['turn-1'];
    expect(events).toEqual([
      {
        type: 'user_question_answered',
        batchId: 'batch-1',
        answers: [],
        skipped: true,
        sessionId: 'session-uq3',
        seq: 7,
        timestamp: 5,
      },
    ]);
  });

  it('preserves approval clarification purpose and cancelled receipts on user question rehydration', async () => {
    const sampleQuestions = [
      {
        id: 'q0',
        question: 'Which calendar should I use?',
        header: 'Calendar',
        context: 'I found two calendars that could fit.',
        options: [{ id: 'q0-opt0', label: 'Work' }, { id: 'q0-opt1', label: 'Personal' }],
        multiSelect: false,
        purpose: 'approval_clarification',
      },
    ];
    mockedGetSession.mockResolvedValue({
      id: 'session-uq4',
      title: 'Session UQ4',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {
        'turn-1': [
          {
            type: 'user_question',
            batchId: 'batch-1',
            toolUseId: 'tu-1',
            questions: sampleQuestions,
            sessionId: 'session-uq4',
            seq: 21,
            timestamp: 2,
          },
          {
            type: 'user_question_answered',
            batchId: 'batch-1',
            answers: [],
            skipped: true,
            sessionId: 'session-uq4',
            seq: 22,
            timestamp: 3,
          },
        ],
      },
    });

    await useSessionStore.getState().fetchSession('session-uq4');

    const events = useSessionStore.getState().currentSession?.userQuestionEventsByTurn?.['turn-1'];
    expect(events).toEqual([
      {
        type: 'user_question',
        batchId: 'batch-1',
        toolUseId: 'tu-1',
        questions: sampleQuestions,
        sessionId: 'session-uq4',
        seq: 21,
        timestamp: 2,
      },
      {
        type: 'user_question_answered',
        batchId: 'batch-1',
        answers: [],
        skipped: true,
        sessionId: 'session-uq4',
        seq: 22,
        timestamp: 3,
      },
    ]);
  });

  it('stores completed steps snapshots by turn id', () => {
    useSessionStore.getState().snapshotCompletedSteps('turn-1', [
      {
        label: 'search',
        toolName: 'search',
        timestamp: 123,
      },
    ]);

    expect(useSessionStore.getState().completedStepsByTurnId['turn-1']).toEqual([
      {
        label: 'search',
        toolName: 'search',
        timestamp: 123,
      },
    ]);
  });

  it('stores mission/task snapshots by turn id', () => {
    useSessionStore.getState().snapshotMissionTask('turn-1', { goal: 'Ship release' }, [
      {
        id: 'task-1',
        title: 'Draft notes',
        status: 'completed',
      },
    ]);

    expect(useSessionStore.getState().missionTaskByTurnId['turn-1']).toEqual({
      mission: { goal: 'Ship release' },
      tasks: [
        {
          id: 'task-1',
          title: 'Draft notes',
          status: 'completed',
        },
      ],
    });
  });

  it('clears cached completed steps for turn ids once tool events are available', async () => {
    useSessionStore.setState({
      completedStepsByTurnId: {
        'turn-1': [{ label: 'search', toolName: 'search', timestamp: 1 }],
        'turn-2': [{ label: 'read_file', toolName: 'read_file', timestamp: 2 }],
      },
      missionTaskByTurnId: {
        'turn-1': {
          mission: { goal: 'Ship release' },
          tasks: [{ id: 'task-1', title: 'Draft notes', status: 'completed' }],
        },
        'turn-2': {
          mission: null,
          tasks: [{ id: 'task-2', title: 'Send recap', status: 'pending' }],
        },
      },
    });

    mockedGetSession.mockResolvedValue({
      id: 'session-1',
      title: 'Session 1',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      eventsByTurn: {
        'turn-1': [
          { type: 'tool', toolName: 'search', detail: '{}', stage: 'end', timestamp: 3 },
        ],
      },
    });

    await useSessionStore.getState().fetchSession('session-1');

    expect(useSessionStore.getState().completedStepsByTurnId).toEqual({
      'turn-2': [{ label: 'read_file', toolName: 'read_file', timestamp: 2 }],
    });
    // Mission/task snapshots are preserved (not evicted) because WS snapshots
    // have full fidelity while REST tool event details may be truncated.
    expect(useSessionStore.getState().missionTaskByTurnId).toEqual({
      'turn-1': {
        mission: { goal: 'Ship release' },
        tasks: [{ id: 'task-1', title: 'Draft notes', status: 'completed' }],
      },
      'turn-2': {
        mission: null,
        tasks: [{ id: 'task-2', title: 'Send recap', status: 'pending' }],
      },
    });
  });
});

describe('sessionStore incremental sync', () => {
  beforeEach(() => {
    useSessionStore.setState({ _lastFetchOptions: undefined });
  });

  it('uses modifiedSince when sessions exist and watermark is fresh', async () => {
    const now = Date.now();
    useSessionStore.setState({
      sessions: [mockSummary('a', now - 1000), mockSummary('b', now - 2000)],
    });
    mockedGetSessions.mockResolvedValueOnce({ sessions: [], totalCount: 2 });

    await useSessionStore.getState().fetchSessions();

    expect(mockedGetSessions).toHaveBeenCalledTimes(1);
    // watermark = max(updatedAt) = now - 1000
    expect(mockedGetSessions).toHaveBeenCalledWith({ modifiedSince: now - 1000 });
  });

  it('uses cloudUpdatedAt watermark for modifiedSince when available', async () => {
    const now = Date.now();
    useSessionStore.setState({
      sessions: [{ ...mockSummary('a', now - 1000), cloudUpdatedAt: 55_000 }],
    });
    mockedGetSessions.mockResolvedValueOnce({ sessions: [], totalCount: 1 });

    await useSessionStore.getState().fetchSessions();

    expect(mockedGetSessions).toHaveBeenCalledWith({ modifiedSince: 55_000 });
  });

  it('merges incremental results into existing sessions by id', async () => {
    const now = Date.now();
    useSessionStore.setState({
      sessions: [mockSummary('a', now - 2000), mockSummary('b', now - 3000)],
    });
    // Incremental returns an updated 'a' and a new session 'c'
    mockedGetSessions.mockResolvedValueOnce({
      sessions: [mockSummary('a', now - 500), mockSummary('c', now)],
      totalCount: 3,
    });

    await useSessionStore.getState().fetchSessions();

    const { sessions } = useSessionStore.getState();
    expect(sessions).toHaveLength(3);
    // Sorted by updatedAt desc
    expect(sessions.map((s) => s.id)).toEqual(['c', 'a', 'b']);
    // Updated 'a' has new updatedAt
    expect(sessions.find((s) => s.id === 'a')?.updatedAt).toBe(now - 500);
    // Existing 'b' is retained unchanged
    expect(sessions.find((s) => s.id === 'b')?.updatedAt).toBe(now - 3000);
  });

  it('triggers full refresh when incremental merge has count mismatch', async () => {
    const now = Date.now();
    useSessionStore.setState({
      sessions: [mockSummary('a', now - 1000), mockSummary('b', now - 2000), mockSummary('stale', now - 3000)],
    });
    // Server says totalCount is 2 but local has 3 after merge — 'stale' was removed server-side
    mockedGetSessions
      .mockResolvedValueOnce({ sessions: [], totalCount: 2 })
      .mockResolvedValueOnce({ sessions: [mockSummary('a', now - 1000), mockSummary('b', now - 2000)], totalCount: 2 });

    await useSessionStore.getState().fetchSessions();

    // Should have done incremental then fallen through to full
    expect(mockedGetSessions).toHaveBeenCalledTimes(2);
    expect(useSessionStore.getState().sessions).toHaveLength(2);
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('does a full fetch when no sessions exist', async () => {
    // sessions is empty (default from beforeEach)
    mockedGetSessions.mockResolvedValueOnce({ sessions: [mockSummary('a')], totalCount: 1 });

    await useSessionStore.getState().fetchSessions();

    expect(mockedGetSessions).toHaveBeenCalledTimes(1);
    expect(mockedGetSessions).toHaveBeenCalledWith(undefined);
  });

  it('does a full fetch when watermark is stale (older than 5 minutes)', async () => {
    const now = Date.now();
    const staleTime = now - 6 * 60 * 1000; // 6 minutes ago
    useSessionStore.setState({
      sessions: [mockSummary('a', staleTime)],
    });
    mockedGetSessions.mockResolvedValueOnce({ sessions: [mockSummary('a', now)], totalCount: 1 });

    await useSessionStore.getState().fetchSessions();

    expect(mockedGetSessions).toHaveBeenCalledTimes(1);
    expect(mockedGetSessions).toHaveBeenCalledWith(undefined);
  });

  it('does a full fetch when forceFullRefresh is true regardless of fresh watermark', async () => {
    const now = Date.now();
    useSessionStore.setState({
      sessions: [mockSummary('a', now - 1000)], // fresh watermark
    });
    mockedGetSessions.mockResolvedValueOnce({ sessions: [mockSummary('a', now)], totalCount: 1 });

    await useSessionStore.getState().fetchSessions({ forceFullRefresh: true });

    expect(mockedGetSessions).toHaveBeenCalledTimes(1);
    // forceFullRefresh is store-level only — not passed to the API
    expect(mockedGetSessions).toHaveBeenCalledWith(undefined);
  });

  it('falls back to full fetch silently when incremental fetch fails', async () => {
    const now = Date.now();
    useSessionStore.setState({
      sessions: [mockSummary('a', now - 1000)],
    });
    // First call (incremental) fails, second call (full) succeeds
    mockedGetSessions
      .mockRejectedValueOnce(new Error('Server error'))
      .mockResolvedValueOnce({ sessions: [mockSummary('a', now), mockSummary('b', now - 500)], totalCount: 2 });

    await useSessionStore.getState().fetchSessions();

    expect(mockedGetSessions).toHaveBeenCalledTimes(2);
    expect(mockedGetSessions).toHaveBeenNthCalledWith(1, { modifiedSince: now - 1000 });
    expect(mockedGetSessions).toHaveBeenNthCalledWith(2, undefined);
    expect(useSessionStore.getState().sessions).toHaveLength(2);
    expect(useSessionStore.getState().error).toBeNull();
    expect(useSessionStore.getState().isLoading).toBe(false);
  });

  it('sets error only when both incremental and full fetch fail', async () => {
    const now = Date.now();
    useSessionStore.setState({
      sessions: [mockSummary('a', now - 1000)],
    });
    mockedGetSessions
      .mockRejectedValueOnce(new Error('Incremental failed'))
      .mockRejectedValueOnce(new Error('Full also failed'));

    await useSessionStore.getState().fetchSessions();

    expect(mockedGetSessions).toHaveBeenCalledTimes(2);
    expect(useSessionStore.getState().error).toBe('Full also failed');
    expect(useSessionStore.getState().isLoading).toBe(false);
  });

  it('passes activeOnly alongside modifiedSince for incremental fetch', async () => {
    const now = Date.now();
    useSessionStore.setState({
      sessions: [mockSummary('a', now - 1000)],
    });
    mockedGetSessions.mockResolvedValueOnce({ sessions: [], totalCount: 1 });

    await useSessionStore.getState().fetchSessions({ activeOnly: true });

    expect(mockedGetSessions).toHaveBeenCalledTimes(1);
    expect(mockedGetSessions).toHaveBeenCalledWith({
      activeOnly: true,
      modifiedSince: now - 1000,
    });
  });

  it('passes activeOnly for full fetch when forceFullRefresh is true', async () => {
    const now = Date.now();
    useSessionStore.setState({
      sessions: [mockSummary('a', now - 1000)],
    });
    mockedGetSessions.mockResolvedValueOnce({ sessions: [mockSummary('a', now)], totalCount: 1 });

    await useSessionStore.getState().fetchSessions({ activeOnly: true, forceFullRefresh: true });

    expect(mockedGetSessions).toHaveBeenCalledTimes(1);
    // activeOnly passed through, forceFullRefresh is NOT passed to API
    expect(mockedGetSessions).toHaveBeenCalledWith({ activeOnly: true });
  });

  it('does not persist forceFullRefresh in _lastFetchOptions', async () => {
    const now = Date.now();
    useSessionStore.setState({
      sessions: [mockSummary('a', now - 1000)],
    });
    mockedGetSessions.mockResolvedValueOnce({ sessions: [mockSummary('a', now)], totalCount: 1 });

    await useSessionStore.getState().fetchSessions({ activeOnly: true, forceFullRefresh: true });

    // forceFullRefresh should be stripped from persisted options
    expect(useSessionStore.getState()._lastFetchOptions).toEqual({ activeOnly: true });
  });
});

describe('sessionStore seq tracking', () => {
  it('records applied seq and emits seq-gap breadcrumbs', () => {
    const continuityEvents: Array<{ family: string; message: string; data: Record<string, unknown> }> = [];
    setSessionContinuityRecorder((event) => {
      continuityEvents.push({
        family: event.family,
        message: event.message,
        data: event.data as Record<string, unknown>,
      });
    });

    const state = useSessionStore.getState();
    state.applyEventIfNew('session-1', { seq: 1 });
    state.applyEventIfNew('session-1', { seq: 4 });

    expect(useSessionStore.getState().appliedSeq['session-1']).toBe(4);
    expect(continuityEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: 'catch-up',
          message: 'seq-gap-detected',
          data: expect.objectContaining({
            reason: 'seq-gap-detected',
            seq: 4,
            appliedSeq: 1,
            missedCount: 2,
          }),
        }),
      ]),
    );
  });

  it('drops already-applied seq events with breadcrumb and applies undefined/new seq events', () => {
    const continuityEvents: Array<{ family: string; message: string; data: Record<string, unknown> }> = [];
    setSessionContinuityRecorder((event) => {
      continuityEvents.push({
        family: event.family,
        message: event.message,
        data: event.data as Record<string, unknown>,
      });
    });

    const state = useSessionStore.getState();

    expect(state.applyEventIfNew('session-late', { seq: 10 })).toBe(true);
    expect(useSessionStore.getState().appliedSeq['session-late']).toBe(10);

    expect(state.applyEventIfNew('session-late', { seq: 5 })).toBe(false);
    expect(useSessionStore.getState().appliedSeq['session-late']).toBe(10);

    const lateSeqEvents = continuityEvents.filter(
      (event) => event.family === 'catch-up' && event.message === 'seq-already-applied',
    );
    expect(lateSeqEvents).toHaveLength(1);
    expect(lateSeqEvents[0].data).toMatchObject({
      reason: 'seq-already-applied',
      incomingSeq: 5,
      appliedSeq: 10,
    });

    expect(state.applyEventIfNew('session-late', { seq: undefined })).toBe(true);
    expect(
      continuityEvents.filter((event) => event.family === 'catch-up' && event.message === 'seq-already-applied'),
    ).toHaveLength(1);

    expect(state.applyEventIfNew('session-late', { seq: 11 })).toBe(true);
    expect(useSessionStore.getState().appliedSeq['session-late']).toBe(11);
  });

  it('throttles seq-unavailable breadcrumbs to once per hour', () => {
    const continuityEvents: Array<{ family: string; message: string; data: Record<string, unknown> }> = [];
    setSessionContinuityRecorder((event) => {
      continuityEvents.push({
        family: event.family,
        message: event.message,
        data: event.data as Record<string, unknown>,
      });
    });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const state = useSessionStore.getState();
    state.applyEventIfNew('session-2', {});
    state.applyEventIfNew('session-2', {});
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    state.applyEventIfNew('session-2', {});

    const seqUnavailableEvents = continuityEvents.filter(
      (event) => event.family === 'continuity-state' && event.data.reason === 'seq-unavailable',
    );
    expect(seqUnavailableEvents).toHaveLength(2);
  });

  it('hydrates applied seq from fetchSession maxSeq', async () => {
    mockedGetSession.mockResolvedValueOnce({
      id: 'session-max-seq',
      title: 'Session Max Seq',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      maxSeq: 42,
      eventsByTurn: {},
    });

    await useSessionStore.getState().fetchSession('session-max-seq');
    expect(useSessionStore.getState().appliedSeq['session-max-seq']).toBe(42);
  });

  it('drops duplicate catch-up events and only applies new seq values', () => {
    const continuityEvents: Array<{ family: string; message: string }> = [];
    setSessionContinuityRecorder((event) => {
      continuityEvents.push({
        family: event.family,
        message: event.message,
      });
    });

    const state = useSessionStore.getState();
    const result = state.applyCatchUpEvents('session-catch-up', [
      { type: 'status', seq: 5 },
      { type: 'status', seq: 5 },
      { type: 'status', seq: 6 },
    ] as unknown as AgentEvent[]);

    expect(result).toEqual({ addedEvents: 2, highestSeq: 6 });
    expect(useSessionStore.getState().appliedSeq['session-catch-up']).toBe(6);
    expect(
      continuityEvents.filter((event) => event.family === 'catch-up' && event.message === 'seq-already-applied'),
    ).toHaveLength(1);
  });

  it('applies catch-up events in seq order even when they arrive out of order', () => {
    const state = useSessionStore.getState();
    const result = state.applyCatchUpEvents('session-seq-order', [
      { type: 'status', seq: 12, timestamp: 12 },
      { type: 'status', seq: 10, timestamp: 10 },
      { type: 'status', seq: 11, timestamp: 11 },
    ] as unknown as AgentEvent[]);

    expect(result).toEqual({ addedEvents: 3, highestSeq: 12 });
    expect(useSessionStore.getState().appliedSeq['session-seq-order']).toBe(12);
  });

  it('treats already-hydrated maxSeq as dedupe baseline for live events', async () => {
    mockedGetSession.mockResolvedValueOnce({
      id: 'session-live-baseline',
      title: 'Session Baseline',
      messages: [],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      maxSeq: 9,
      eventsByTurn: {},
    });

    await useSessionStore.getState().fetchSession('session-live-baseline');
    const state = useSessionStore.getState();

    expect(state.applyEventIfNew('session-live-baseline', { seq: 9 })).toBe(false);
    expect(state.applyEventIfNew('session-live-baseline', { seq: 10 })).toBe(true);
    expect(useSessionStore.getState().appliedSeq['session-live-baseline']).toBe(10);
  });
});

describe('sessionStore fetchSession content-regression guard (REBEL-6C0/6BZ mobile parity)', () => {
  // The 7-step reconnect-catchup × stale-cache race (GPT review F2):
  //   1. A richer live currentSession exists (catch-up messageDelta enriched it),
  //      with appliedSeq[id] ahead of the cache.
  //   2. A coalesced fetchSession fires; its cache-hydrate branch reads a STALER,
  //      content-poorer per-conversation cache.
  //   3. The REST getSession then fails transiently (non-definitive).
  // Without the guard, the poorer cache wholesale-replaces the rich transcript and
  // survives the transient REST failure. With the guard, the rich live transcript
  // is preserved at both replace sites.
  const richLiveSession = () => ({
    id: 'session-race',
    title: 'Live Enriched',
    messages: [
      { id: 'u-1', turnId: 'turn-1', role: 'user', text: 'question', createdAt: 1 },
      { id: 'a-1', turnId: 'turn-1', role: 'assistant', text: 'preamble', createdAt: 2 },
      { id: 'r-1', turnId: 'turn-1', role: 'result', text: 'the full final answer', createdAt: 3 },
    ],
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    maxSeq: 12,
  });

  it('does not let a stale poorer cache clobber a richer live transcript when the REST fetch fails transiently', async () => {
    useSessionStore.setState({
      _conversationCacheKeyPrefix: 'cache:conversation:',
      _conversationOrderKey: 'cache:conversationOrder',
      currentSession: richLiveSession() as never,
      appliedSeq: { 'session-race': 12 },
    });

    // Stale, content-poorer per-conversation cache: same session id, fewer
    // non-user messages, lower (absent) richness than the live transcript.
    mockedHydrateStore.mockResolvedValueOnce({
      id: 'session-race',
      title: 'Stale Cache',
      messages: [
        { id: 'u-1', turnId: 'turn-1', role: 'user', text: 'question', createdAt: 1 },
        { id: 'a-1', turnId: 'turn-1', role: 'assistant', text: 'preamble', createdAt: 2 },
      ],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      maxSeq: 8,
    });
    // REST refetch fails transiently (non-definitive) -> the catch path keeps
    // whatever currentSession is in place.
    mockedGetSession.mockRejectedValueOnce(new Error('Network request failed'));

    await useSessionStore.getState().fetchSession('session-race');

    const current = useSessionStore.getState().currentSession;
    // The rich live transcript must survive — the result message is the load-bearing
    // assertion (the cache lacks it).
    expect(current?.title).toBe('Live Enriched');
    expect(current?.messages.some((m) => m.id === 'r-1')).toBe(true);
    expect(current?.messages).toHaveLength(3);
  });

  it('lets a richer REST snapshot replace the live transcript (server is authoritative — not over-aggressive)', async () => {
    useSessionStore.setState({
      _conversationCacheKeyPrefix: 'cache:conversation:',
      _conversationOrderKey: 'cache:conversationOrder',
      currentSession: richLiveSession() as never,
      appliedSeq: { 'session-race': 12 },
    });
    // No cache hit; the REST snapshot is a superset (more messages, higher maxSeq).
    mockedHydrateStore.mockResolvedValueOnce(null);
    mockedGetSession.mockResolvedValueOnce({
      id: 'session-race',
      title: 'Server Fresh',
      messages: [
        { id: 'u-1', turnId: 'turn-1', role: 'user', text: 'question', createdAt: 1 },
        { id: 'a-1', turnId: 'turn-1', role: 'assistant', text: 'preamble', createdAt: 2 },
        { id: 'r-1', turnId: 'turn-1', role: 'result', text: 'final', createdAt: 3 },
        { id: 'a-2', turnId: 'turn-2', role: 'assistant', text: 'follow-up', createdAt: 4 },
      ],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      maxSeq: 20,
      eventsByTurn: {},
    });

    await useSessionStore.getState().fetchSession('session-race');

    const current = useSessionStore.getState().currentSession;
    expect(current?.title).toBe('Server Fresh');
    expect(current?.messages).toHaveLength(4);
  });

  it('refuses a strict-shrink REST snapshot at the REST site and does not re-poison the cache', async () => {
    useSessionStore.setState({
      _conversationCacheKeyPrefix: 'cache:conversation:',
      _conversationOrderKey: 'cache:conversationOrder',
      currentSession: richLiveSession() as never,
      appliedSeq: { 'session-race': 12 },
    });
    mockedHydrateStore.mockResolvedValueOnce(null);
    // REST returns a same-session snapshot whose maxSeq is below appliedSeq.
    mockedGetSession.mockResolvedValueOnce({
      id: 'session-race',
      title: 'Stale REST',
      messages: [
        { id: 'u-1', turnId: 'turn-1', role: 'user', text: 'question', createdAt: 1 },
        { id: 'a-1', turnId: 'turn-1', role: 'assistant', text: 'preamble', createdAt: 2 },
      ],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      maxSeq: 6,
      eventsByTurn: {},
    });

    await useSessionStore.getState().fetchSession('session-race');

    const current = useSessionStore.getState().currentSession;
    expect(current?.title).toBe('Live Enriched');
    expect(current?.messages).toHaveLength(3);
    // The refused poorer snapshot must NOT be written back to the cache.
    expect(mockedPersistStore).not.toHaveBeenCalledWith('cache:conversation:session-race', expect.anything());
    // appliedSeq is not dragged down by the refusal.
    expect(useSessionStore.getState().appliedSeq['session-race']).toBe(12);
  });

  it('simulates reconnect-catchup enrich then forced refetch with stale cache (F3 intent, store-level)', async () => {
    // The EventBridge catch-up path enriches currentSession.messages directly; we
    // simulate that enrich here, then drive the forced refetch with a stale cache
    // and a transient REST failure — the store-level test is the required one (F3
    // EventBridge integration deferred: the enrich is a plain setState merge and
    // handleSessionChanged is already covered; a full WS-bridge harness adds flake
    // risk for marginal coverage).
    useSessionStore.setState({
      _conversationCacheKeyPrefix: 'cache:conversation:',
      _conversationOrderKey: 'cache:conversationOrder',
      currentSession: {
        id: 'session-race',
        title: 'Pre-enrich',
        messages: [
          { id: 'u-1', turnId: 'turn-1', role: 'user', text: 'question', createdAt: 1 },
          { id: 'a-1', turnId: 'turn-1', role: 'assistant', text: 'preamble', createdAt: 2 },
        ],
        activeTurnId: null,
        isBusy: false,
        lastError: null,
        maxSeq: 6,
      } as never,
      appliedSeq: { 'session-race': 6 },
    });

    // Catch-up enrich: append the final answer + advance appliedSeq (as the live
    // catch-up path does via applyCatchUpEvents -> appliedSeq).
    useSessionStore.setState((state) => ({
      currentSession: {
        ...state.currentSession!,
        messages: [
          ...state.currentSession!.messages,
          { id: 'r-1', turnId: 'turn-1', role: 'result', text: 'the full final answer', createdAt: 3 } as never,
        ],
      },
      appliedSeq: { 'session-race': 12 },
    }));

    // Forced refetch hydrates the STALE pre-enrich cache, then REST fails transiently.
    mockedHydrateStore.mockResolvedValueOnce({
      id: 'session-race',
      title: 'Stale Cache',
      messages: [
        { id: 'u-1', turnId: 'turn-1', role: 'user', text: 'question', createdAt: 1 },
        { id: 'a-1', turnId: 'turn-1', role: 'assistant', text: 'preamble', createdAt: 2 },
      ],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      maxSeq: 6,
    });
    mockedGetSession.mockRejectedValueOnce(new Error('Network request failed'));

    await useSessionStore.getState().fetchSession('session-race');

    const current = useSessionStore.getState().currentSession;
    expect(current?.messages.some((m) => m.id === 'r-1')).toBe(true);
    expect(current?.messages).toHaveLength(3);
  });

  // F1 count-stable: the desktop REBEL-6C0 shape. `mergeResultMessage` promotes
  // an assistant preamble to `result` IN-PLACE (same id, same count), so a stale
  // cache where the turn's final answer is still the preamble has the SAME
  // non-user count as the live `result` transcript. The pre-F1 count signal
  // would PASS this regressing cache; the per-turn role-richness check refuses
  // it. This is the most dangerous shape and was previously unguarded on the
  // cache branch.
  it('does not let a count-stable stale cache (preamble) clobber a live promoted-result transcript when REST fails transiently', async () => {
    useSessionStore.setState({
      _conversationCacheKeyPrefix: 'cache:conversation:',
      _conversationOrderKey: 'cache:conversationOrder',
      // Live transcript: one turn whose final answer is the PROMOTED result.
      currentSession: {
        id: 'session-stable',
        title: 'Live Promoted Result',
        messages: [
          { id: 'u-1', turnId: 'turn-1', role: 'user', text: 'question', createdAt: 1 },
          { id: 'r-1', turnId: 'turn-1', role: 'result', text: 'the full final answer', createdAt: 2 },
        ],
        activeTurnId: null,
        isBusy: false,
        lastError: null,
        maxSeq: 12,
      } as never,
      appliedSeq: { 'session-stable': 12 },
    });

    // Stale cache: SAME non-user count (1), but the turn's answer is still the
    // short assistant preamble, and NO maxSeq (cache snapshots may lack it).
    mockedHydrateStore.mockResolvedValueOnce({
      id: 'session-stable',
      title: 'Stale Preamble Cache',
      messages: [
        { id: 'u-1', turnId: 'turn-1', role: 'user', text: 'question', createdAt: 1 },
        { id: 'a-1', turnId: 'turn-1', role: 'assistant', text: 'preamble', createdAt: 2 },
      ],
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      // No maxSeq → seq signal inert; count is stable → only per-turn richness catches it.
    });
    mockedGetSession.mockRejectedValueOnce(new Error('Network request failed'));

    await useSessionStore.getState().fetchSession('session-stable');

    const current = useSessionStore.getState().currentSession;
    // The live promoted `result` must survive — the cache (preamble only) was refused.
    expect(current?.title).toBe('Live Promoted Result');
    expect(current?.messages.some((m) => m.id === 'r-1' && m.role === 'result')).toBe(true);
    expect(current?.messages.some((m) => m.role === 'assistant')).toBe(false);
  });
});
