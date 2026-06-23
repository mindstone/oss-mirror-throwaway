/**
 * Text queue consumer tests — covers auth checks, busy-session guards,
 * and WebSocket turn submission for queued text messages.
 */

const mockClose = jest.fn();
let capturedOnEvent: ((event: unknown) => void) | undefined;
let capturedOnError: ((err: Error) => void) | undefined;
let capturedOnClose: ((code: number, reason: string) => void) | undefined;

const mockCreateSocket = jest.fn<{ close: typeof mockClose }, unknown[]>(
  (_req: unknown, onEvent: unknown, onError: unknown, onClose: unknown) => {
    capturedOnEvent = onEvent as (event: unknown) => void;
    capturedOnError = onError as (err: Error) => void;
    capturedOnClose = onClose as (code: number, reason: string) => void;
    return { close: mockClose };
  },
);

jest.mock('../../../cloud-client/src/cloudClient', () => ({
  createAgentTurnSocket: (...args: unknown[]) => mockCreateSocket(...args),
  configure: jest.fn(),
  clearConfig: jest.fn(),
  checkHealth: jest.fn().mockResolvedValue({ status: 'ok' }),
  getSessions: jest.fn().mockResolvedValue({ sessions: [], totalCount: 0 }),
  getSession: jest.fn(),
  getSettings: jest.fn().mockResolvedValue({}),
  transcribe: jest.fn(),
  textToSpeech: jest.fn(),
  ipcCall: jest.fn(),
  stopTurn: jest.fn(),
}));

jest.mock('../utils/continuityBreadcrumbs', () => ({
  recordContinuityBreadcrumb: jest.fn(),
}));

const { useSessionStore, initAuthStore, useAuthStore } = require('@rebel/cloud-client');

const mockStorage = {
  getToken: jest.fn().mockResolvedValue(null),
  setToken: jest.fn().mockResolvedValue(undefined),
  clearToken: jest.fn().mockResolvedValue(undefined),
};
initAuthStore(mockStorage);

import {
  createTextQueueConsumer,
  setTextQueueCompletionListener,
  clearTextQueueCompletionListener,
} from '../hooks/useTextQueueConsumer';
import type { QueueItem } from '@rebel/cloud-client';

function makeQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'item-1',
    type: 'text-message',
    status: 'processing',
    enqueuedAt: Date.now(),
    attempts: 0,
    nextRetryAt: 0,
    isPermanentFailure: false,
    metadata: {
      sessionId: 'session-1',
      prompt: 'Hello from queue',
    },
    ...overrides,
  };
}

function resetState() {
  useAuthStore.setState({
    cloudUrl: 'https://mock-cloud.test',
    token: 'mock-token',
    isPaired: true,
  });
  useSessionStore.setState({
    sessions: [{ id: 'session-1', title: 'Session 1' }],
    currentSession: null,
    isLoading: false,
    error: null,
    isLoadingSession: false,
    tombstonedSessionIds: new Set<string>(),
  });
  mockCreateSocket.mockClear();
  mockClose.mockClear();
  capturedOnEvent = undefined;
  capturedOnError = undefined;
  capturedOnClose = undefined;
  clearTextQueueCompletionListener();
}

beforeEach(() => {
  resetState();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('createTextQueueConsumer', () => {
  it('returns a consumer function', () => {
    const consumer = createTextQueueConsumer();
    expect(typeof consumer).toBe('function');
  });

  it('returns auth error when not authenticated', async () => {
    useAuthStore.setState({ cloudUrl: null, token: null });
    const consumer = createTextQueueConsumer();

    const result = await consumer(makeQueueItem(), null);

    expect(result).toEqual({
      success: false,
      error: 'Not connected to cloud',
      errorCategory: 'auth',
    });
  });

  it('returns session-state error when target current session is busy', async () => {
    useSessionStore.setState({
      currentSession: { id: 'session-1', isBusy: true, title: 'Test', messages: [], activeTurnId: null, lastError: null },
    });
    const consumer = createTextQueueConsumer();

    const result = await consumer(makeQueueItem(), null);

    expect(result).toEqual({
      success: false,
      error: 'Session is busy',
      errorCategory: 'session-state',
    });
    expect(mockCreateSocket).not.toHaveBeenCalled();
  });

  it('returns session-state error when sessions list target is busy', async () => {
    useSessionStore.setState({
      sessions: [{ id: 'session-1', title: 'Busy', isBusy: true }],
    });
    const consumer = createTextQueueConsumer();

    const result = await consumer(makeQueueItem(), null);

    expect(result).toEqual({
      success: false,
      error: 'Session is busy',
      errorCategory: 'session-state',
    });
    expect(mockCreateSocket).not.toHaveBeenCalled();
  });

  it('submits queued text via WebSocket and succeeds on turn_persisted', async () => {
    const consumer = createTextQueueConsumer();
    const resultPromise = consumer(makeQueueItem(), null);

    await Promise.resolve();

    expect(mockCreateSocket).toHaveBeenCalledWith(
      { sessionId: 'session-1', prompt: 'Hello from queue', clientTurnId: 'turn-item-1' },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );

    capturedOnEvent?.({ type: 'turn_started' });
    capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-1' });
    jest.runAllTimers();

    await expect(resultPromise).resolves.toEqual({ success: true });
    expect(mockClose).toHaveBeenCalled();
  });

  it('forwards meetingSessionId and recordingActive metadata to socket request', async () => {
    const consumer = createTextQueueConsumer();
    const resultPromise = consumer(makeQueueItem({
      metadata: {
        sessionId: 'session-1',
        prompt: 'Hello from queue',
        meetingSessionId: 'meeting-cloud-1',
        recordingActive: true,
      },
    }), null);

    await Promise.resolve();

    expect(mockCreateSocket).toHaveBeenCalledWith(
      {
        sessionId: 'session-1',
        prompt: 'Hello from queue',
        clientTurnId: 'turn-item-1',
        meetingSessionId: 'meeting-cloud-1',
        recordingActive: true,
      },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );

    capturedOnEvent?.({ type: 'turn_started' });
    capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-1' });
    jest.runAllTimers();
    await expect(resultPromise).resolves.toEqual({ success: true });
  });

  it('fires completion listener on successful queue delivery', async () => {
    const listener = jest.fn();
    setTextQueueCompletionListener(listener);
    const consumer = createTextQueueConsumer();

    const resultPromise = consumer(makeQueueItem(), null);

    await Promise.resolve();
    capturedOnEvent?.({ type: 'turn_started' });
    capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-1' });
    jest.runAllTimers();

    await expect(resultPromise).resolves.toEqual({ success: true });
    expect(listener).toHaveBeenCalledWith({
      itemId: 'item-1',
      sessionId: 'session-1',
      originalSessionId: 'session-1',
      recreatedSession: false,
    });
  });

  it('generates a new session ID when metadata.sessionId is null', async () => {
    const consumer = createTextQueueConsumer();
    const item = makeQueueItem({
      metadata: {
        sessionId: null,
        prompt: 'Start a new task',
      },
    });

    const resultPromise = consumer(item, null);
    await Promise.resolve();

    expect(mockCreateSocket).toHaveBeenCalledWith(
      {
        sessionId: expect.stringMatching(/^mobile-/),
        prompt: 'Start a new task',
        clientTurnId: 'turn-item-1',
      },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );

    capturedOnEvent?.({ type: 'turn_started' });
    capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-1' });
    jest.runAllTimers();

    await expect(resultPromise).resolves.toEqual({ success: true });
  });

  it('creates a new session when original session was positively tombstoned (deleted)', async () => {
    useSessionStore.setState({
      sessions: [{ id: 'different-session', title: 'Other' }],
      tombstonedSessionIds: new Set<string>(['deleted-session']),
    });
    const listener = jest.fn();
    setTextQueueCompletionListener(listener);
    const consumer = createTextQueueConsumer();
    const item = makeQueueItem({
      metadata: {
        sessionId: 'deleted-session',
        prompt: 'Recover this',
      },
    });

    const resultPromise = consumer(item, null);
    await Promise.resolve();

    expect(mockCreateSocket).toHaveBeenCalledWith(
      {
        sessionId: expect.stringMatching(/^mobile-/),
        prompt: 'Recover this',
        clientTurnId: 'turn-item-1',
      },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );

    capturedOnEvent?.({ type: 'turn_started' });
    capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-1' });
    jest.runAllTimers();
    await expect(resultPromise).resolves.toEqual({ success: true });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'item-1',
        originalSessionId: 'deleted-session',
        recreatedSession: true,
        sessionId: expect.stringMatching(/^mobile-/),
      }),
    );
  });

  it('submits to the requested id (no recreate) for a not-yet-synced new session absent from the store', async () => {
    // Brand-new mobile conversation: client-minted id not in sessions[] yet and
    // NOT tombstoned. Must submit to the requested id, recreatedSession:false.
    useSessionStore.setState({
      sessions: [{ id: 'different-session', title: 'Other' }],
      tombstonedSessionIds: new Set<string>(),
    });
    const listener = jest.fn();
    setTextQueueCompletionListener(listener);
    const consumer = createTextQueueConsumer();
    const item = makeQueueItem({
      metadata: {
        sessionId: 'mobile-newly-minted-id',
        prompt: 'First send of a new conversation',
      },
    });

    const resultPromise = consumer(item, null);
    await Promise.resolve();

    expect(mockCreateSocket).toHaveBeenCalledWith(
      {
        sessionId: 'mobile-newly-minted-id',
        prompt: 'First send of a new conversation',
        clientTurnId: 'turn-item-1',
      },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );

    capturedOnEvent?.({ type: 'turn_started' });
    capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-1' });
    jest.runAllTimers();
    await expect(resultPromise).resolves.toEqual({ success: true });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'item-1',
        originalSessionId: 'mobile-newly-minted-id',
        recreatedSession: false,
        sessionId: 'mobile-newly-minted-id',
      }),
    );
  });

  it('recreates under a new session when the server signals session_tombstoned (no silent drain)', async () => {
    // The local store has NO tombstone for this id (e.g. tombstone not yet
    // hydrated after restart), so resolveTargetSessionId submits to the
    // requested id. The server then reports the session is deleted. The
    // consumer must NOT silently drain — it recreates under a fresh id and
    // resubmits, so the user's turn lands on a visible conversation.
    useSessionStore.setState({
      sessions: [{ id: 'different-session', title: 'Other' }],
      tombstonedSessionIds: new Set<string>(),
    });
    const listener = jest.fn();
    setTextQueueCompletionListener(listener);
    const consumer = createTextQueueConsumer();
    const item = makeQueueItem({
      metadata: {
        sessionId: 'server-deleted-session',
        prompt: 'Recover this',
      },
    });

    const resultPromise = consumer(item, null);
    await Promise.resolve();

    // First socket: submitted to the requested (server-tombstoned) id.
    expect(mockCreateSocket).toHaveBeenNthCalledWith(
      1,
      {
        sessionId: 'server-deleted-session',
        prompt: 'Recover this',
        clientTurnId: 'turn-item-1',
      },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );

    // Server reports the session is deleted.
    capturedOnEvent?.({ type: 'session_tombstoned', sessionId: 'server-deleted-session' });
    await Promise.resolve();
    await Promise.resolve();

    // Second socket: resubmitted to a fresh recreated id with a distinct
    // clientTurnId (avoids colliding with the tombstoned-id idempotency entry).
    expect(mockCreateSocket).toHaveBeenNthCalledWith(
      2,
      {
        sessionId: expect.stringMatching(/^mobile-/),
        prompt: 'Recover this',
        clientTurnId: 'turn-item-1-recreated',
      },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );

    capturedOnEvent?.({ type: 'turn_started' });
    capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-1' });
    jest.runAllTimers();
    await expect(resultPromise).resolves.toEqual({ success: true });

    // Completion reports the recreation so the UI surfaces "started a new one".
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'item-1',
        originalSessionId: 'server-deleted-session',
        recreatedSession: true,
        sessionId: expect.stringMatching(/^mobile-/),
      }),
    );
    // The recreated id is different from the deleted one.
    const completionArg = listener.mock.calls[0][0];
    expect(completionArg.sessionId).not.toBe('server-deleted-session');
  });

  it('returns permanent error for empty prompt', async () => {
    const consumer = createTextQueueConsumer();
    const item = makeQueueItem({
      metadata: {
        sessionId: 'session-1',
        prompt: '   ',
      },
    });

    const result = await consumer(item, null);
    expect(result).toEqual({
      success: false,
      error: 'Prompt is empty',
      errorCategory: 'permanent',
    });
    expect(mockCreateSocket).not.toHaveBeenCalled();
  });

  it('returns temporary error when socket reports an error', async () => {
    const listener = jest.fn();
    setTextQueueCompletionListener(listener);
    const consumer = createTextQueueConsumer();
    const resultPromise = consumer(makeQueueItem(), null);

    await Promise.resolve();
    capturedOnError?.(new Error('WebSocket failed'));
    jest.runAllTimers();

    await expect(resultPromise).resolves.toEqual({
      success: false,
      error: 'Turn submission failed: WebSocket failed',
      errorCategory: 'temporary',
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it('surfaces a recoverable permanent failure (NOT silent success) when the turn is persisted as an error', async () => {
    // Thread A safety net: a terminal provider-route decision (e.g. the Mindstone
    // managed subscription is unreachable from cloud) persists the turn with
    // outcome:"error". Mobile must surface this honestly, not drain as success.
    const listener = jest.fn();
    setTextQueueCompletionListener(listener);
    const consumer = createTextQueueConsumer();
    const resultPromise = consumer(makeQueueItem(), null);

    await Promise.resolve();
    capturedOnEvent?.({ type: 'turn_started', turnId: 'turn-err', supportsPersistedAck: true });
    capturedOnEvent?.({
      type: 'error',
      error: "Your Mindstone subscription isn't ready yet. Open subscription settings, then try again.",
      errorKind: 'connection-not-configured',
      provider: 'Mindstone',
    });
    capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-err', outcome: 'error' });
    jest.runAllTimers();

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe('permanent');
    // Honest, mobile-appropriate copy — not the misleading "subscription isn't ready".
    expect(result.error).toContain('runs on your computer for now');
    expect(result.error).not.toContain("isn't ready yet");
    // Must NOT report a successful completion (no silent drain to a "sent" state).
    expect(listener).not.toHaveBeenCalled();
  });

  it('does NOT drain queue item on TurnInFlightError (turn_in_flight)', async () => {
    const consumer = createTextQueueConsumer();
    const resultPromise = consumer(makeQueueItem(), null);

    await Promise.resolve();
    capturedOnEvent?.({ type: 'turn_in_flight', turnId: 'turn-1' });
    jest.runAllTimers();

    await expect(resultPromise).resolves.toEqual({
      success: false,
      error: 'Turn is already in flight on the server',
      errorCategory: 'defer',
    });
  });

  it('does NOT drain queue item on PersistedAckMissingError for ack-capable servers', async () => {
    const consumer = createTextQueueConsumer();
    const resultPromise = consumer(makeQueueItem(), null);

    await Promise.resolve();
    capturedOnEvent?.({ type: 'turn_started', turnId: 'turn-1', supportsPersistedAck: true });
    jest.advanceTimersByTime(60_000);

    await expect(resultPromise).resolves.toEqual({
      success: false,
      error: 'Persistence acknowledgement missing',
      errorCategory: 'temporary',
    });
  });

  it('DOES drain queue item on degraded:true fallback (legacy server path)', async () => {
    const consumer = createTextQueueConsumer();
    const resultPromise = consumer(makeQueueItem(), null);

    await Promise.resolve();
    capturedOnEvent?.({ type: 'turn_started', turnId: 'turn-1', supportsPersistedAck: false });
    jest.advanceTimersByTime(60_000);

    await expect(resultPromise).resolves.toEqual({ success: true });
  });
});
