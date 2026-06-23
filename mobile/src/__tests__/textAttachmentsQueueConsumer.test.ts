/**
 * Text-with-attachments queue consumer tests — covers auth checks,
 * busy-session guards, missing payload handling, abort signals,
 * and WebSocket turn submission with attachments.
 */

const mockClose = jest.fn();
let capturedOnEvent: ((event: unknown) => void) | undefined;
let capturedOnError: ((err: Error) => void) | undefined;
let capturedOnClose: ((code: number, reason: string) => void) | undefined;
let capturedRequest: Record<string, unknown> | undefined;

const mockCreateSocket = jest.fn<{ close: typeof mockClose }, unknown[]>(
  (req: unknown, onEvent: unknown, onError: unknown, onClose: unknown) => {
    capturedRequest = req as Record<string, unknown>;
    capturedOnEvent = onEvent as (event: unknown) => void;
    capturedOnError = onError as (err: Error) => void;
    capturedOnClose = onClose as (code: number, reason: string) => void;
    return { close: mockClose };
  },
);

// Mock the queue store's loadJsonPayload
let mockJsonPayload: unknown = null;
const mockLoadJsonPayload = jest.fn().mockImplementation(async () => mockJsonPayload);

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

// Must mock useOfflineQueueStore BEFORE it's imported by the consumer module
jest.mock('../../../cloud-client/src/offlineQueue/offlineQueueStore', () => {
  const actual = jest.requireActual('../../../cloud-client/src/offlineQueue/offlineQueueStore');
  return {
    ...actual,
    useOfflineQueueStore: Object.assign(
      jest.fn(),
      {
        getState: () => ({
          loadJsonPayload: mockLoadJsonPayload,
        }),
        setState: jest.fn(),
        subscribe: jest.fn(() => jest.fn()),
      },
    ),
  };
});

const { useSessionStore, initAuthStore, useAuthStore } = require('@rebel/cloud-client');

const mockStorage = {
  getToken: jest.fn().mockResolvedValue(null),
  setToken: jest.fn().mockResolvedValue(undefined),
  clearToken: jest.fn().mockResolvedValue(undefined),
};
initAuthStore(mockStorage);

import {
  createTextAttachmentsQueueConsumer,
  setTextAttachmentsQueueCompletionListener,
  clearTextAttachmentsQueueCompletionListener,
} from '../hooks/useTextAttachmentsQueueConsumer';
import type { QueueItem } from '@rebel/cloud-client';

function makeQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'item-1',
    type: 'text-with-attachments',
    status: 'processing',
    enqueuedAt: Date.now(),
    attempts: 0,
    nextRetryAt: 0,
    isPermanentFailure: false,
    metadata: {
      sessionId: 'session-1',
      prompt: 'Hello with attachment',
      attachmentCount: 1,
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
  capturedRequest = undefined;
  clearTextAttachmentsQueueCompletionListener();
  mockLoadJsonPayload.mockClear();
  mockJsonPayload = {
    prompt: 'Hello with attachment',
    attachments: [{ type: 'image', mimeType: 'image/png', data: 'base64data', name: 'photo.png' }],
  };
}

async function flushAsyncWork(ticks = 3): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  resetState();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('createTextAttachmentsQueueConsumer', () => {
  it('returns a consumer function', () => {
    const consumer = createTextAttachmentsQueueConsumer();
    expect(typeof consumer).toBe('function');
  });

  it('returns permanent error when JSON payload is missing', async () => {
    mockJsonPayload = null;
    const consumer = createTextAttachmentsQueueConsumer();

    const result = await consumer(makeQueueItem(), null);

    expect(result).toEqual({
      success: false,
      error: 'Attachment payload missing',
      errorCategory: 'permanent',
    });
    expect(mockCreateSocket).not.toHaveBeenCalled();
  });

  it('returns auth error when not authenticated', async () => {
    useAuthStore.setState({ cloudUrl: null, token: null });
    const consumer = createTextAttachmentsQueueConsumer();

    const result = await consumer(makeQueueItem(), null);

    expect(result).toEqual({
      success: false,
      error: 'Not connected to cloud',
      errorCategory: 'auth',
    });
    expect(mockCreateSocket).not.toHaveBeenCalled();
  });

  it('returns timeout error when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const consumer = createTextAttachmentsQueueConsumer();

    const result = await consumer(makeQueueItem(), null, controller.signal);

    expect(result).toEqual({
      success: false,
      error: 'Aborted',
      errorCategory: 'timeout',
    });
    expect(mockCreateSocket).not.toHaveBeenCalled();
  });

  it('returns permanent error for empty prompt', async () => {
    mockJsonPayload = { prompt: '   ', attachments: [{ type: 'image' }] };
    const consumer = createTextAttachmentsQueueConsumer();

    const result = await consumer(makeQueueItem(), null);

    expect(result).toEqual({
      success: false,
      error: 'Prompt is empty',
      errorCategory: 'permanent',
    });
    expect(mockCreateSocket).not.toHaveBeenCalled();
  });

  it('returns session-state error when target session is busy', async () => {
    useSessionStore.setState({
      currentSession: { id: 'session-1', isBusy: true, title: 'Test', messages: [], activeTurnId: null, lastError: null },
    });
    const consumer = createTextAttachmentsQueueConsumer();

    const result = await consumer(makeQueueItem(), null);

    expect(result).toEqual({
      success: false,
      error: 'Session is busy',
      errorCategory: 'session-state',
    });
    expect(mockCreateSocket).not.toHaveBeenCalled();
  });

  it('submits turn with attachments via WebSocket and succeeds on turn_persisted', async () => {
    const consumer = createTextAttachmentsQueueConsumer();
    const resultPromise = consumer(makeQueueItem(), null);

    await flushAsyncWork();

    expect(mockCreateSocket).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        prompt: 'Hello with attachment',
        attachments: expect.arrayContaining([
          expect.objectContaining({ type: 'image', data: 'base64data' }),
        ]),
      }),
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
    const consumer = createTextAttachmentsQueueConsumer();
    const resultPromise = consumer(makeQueueItem({
      metadata: {
        sessionId: 'session-1',
        prompt: 'Hello with attachment',
        attachmentCount: 1,
        meetingSessionId: 'meeting-cloud-1',
        recordingActive: true,
      },
    }), null);

    await flushAsyncWork();

    expect(capturedRequest).toMatchObject({
      sessionId: 'session-1',
      prompt: 'Hello with attachment',
      clientTurnId: 'turn-item-1',
      attachments: expect.arrayContaining([
        expect.objectContaining({ type: 'image', data: 'base64data' }),
      ]),
      meetingSessionId: 'meeting-cloud-1',
      recordingActive: true,
    });

    capturedOnEvent?.({ type: 'turn_started' });
    capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-1' });
    jest.runAllTimers();
    await expect(resultPromise).resolves.toEqual({ success: true });
  });

  it('fires completion listener on successful delivery', async () => {
    const listener = jest.fn();
    setTextAttachmentsQueueCompletionListener(listener);
    const consumer = createTextAttachmentsQueueConsumer();

    const resultPromise = consumer(makeQueueItem(), null);

    await flushAsyncWork();
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

  it('creates a new session when original session was positively tombstoned (deleted)', async () => {
    useSessionStore.setState({
      sessions: [{ id: 'different-session', title: 'Other' }],
      tombstonedSessionIds: new Set<string>(['deleted-session']),
    });
    const listener = jest.fn();
    setTextAttachmentsQueueCompletionListener(listener);
    const consumer = createTextAttachmentsQueueConsumer();
    const item = makeQueueItem({
      metadata: {
        sessionId: 'deleted-session',
        prompt: 'Recover this with attachments',
        attachmentCount: 1,
      },
    });

    const resultPromise = consumer(item, null);
    await flushAsyncWork();

    expect(mockCreateSocket).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: expect.stringMatching(/^mobile-/),
        prompt: 'Hello with attachment',
        clientTurnId: 'turn-item-1',
        attachments: expect.any(Array),
      }),
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
    useSessionStore.setState({
      sessions: [{ id: 'different-session', title: 'Other' }],
      tombstonedSessionIds: new Set<string>(),
    });
    const listener = jest.fn();
    setTextAttachmentsQueueCompletionListener(listener);
    const consumer = createTextAttachmentsQueueConsumer();
    const item = makeQueueItem({
      metadata: {
        sessionId: 'mobile-fresh-id',
        prompt: 'New conversation with attachments',
        attachmentCount: 1,
      },
    });

    const resultPromise = consumer(item, null);
    await flushAsyncWork();

    expect(mockCreateSocket).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'mobile-fresh-id',
        prompt: 'Hello with attachment',
        clientTurnId: 'turn-item-1',
        attachments: expect.any(Array),
      }),
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
        originalSessionId: 'mobile-fresh-id',
        recreatedSession: false,
        sessionId: 'mobile-fresh-id',
      }),
    );
  });

  it('generates a new session ID when metadata.sessionId is null', async () => {
    const consumer = createTextAttachmentsQueueConsumer();
    const item = makeQueueItem({
      metadata: {
        sessionId: null,
        prompt: 'New session with attachments',
        attachmentCount: 1,
      },
    });

    const resultPromise = consumer(item, null);
    await flushAsyncWork();

    expect(mockCreateSocket).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: expect.stringMatching(/^mobile-/),
        clientTurnId: 'turn-item-1',
      }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );

    capturedOnEvent?.({ type: 'turn_started' });
    capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-1' });
    jest.runAllTimers();
    await expect(resultPromise).resolves.toEqual({ success: true });
  });

  it('returns temporary error when socket reports an error', async () => {
    const consumer = createTextAttachmentsQueueConsumer();
    const resultPromise = consumer(makeQueueItem(), null);

    await flushAsyncWork();
    capturedOnError?.(new Error('WebSocket failed'));
    jest.runAllTimers();

    await expect(resultPromise).resolves.toEqual({
      success: false,
      error: 'Turn submission failed: WebSocket failed',
      errorCategory: 'temporary',
    });
  });

  it('returns temporary error when socket closes before turn_started', async () => {
    const consumer = createTextAttachmentsQueueConsumer();
    const resultPromise = consumer(makeQueueItem(), null);

    await flushAsyncWork();
    capturedOnClose?.(1006, 'abnormal closure');
    jest.runAllTimers();

    await expect(resultPromise).resolves.toEqual({
      success: false,
      error: expect.stringContaining('WebSocket closed before turn_started'),
      errorCategory: 'temporary',
    });
  });

  it('returns temporary error from socket rejection', async () => {
    const consumer = createTextAttachmentsQueueConsumer();
    const resultPromise = consumer(makeQueueItem(), null);

    await flushAsyncWork();
    capturedOnError?.(new Error('401 Unauthorized'));
    jest.runAllTimers();

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe('temporary');
  });

  it('returns temporary error for network-shaped socket rejection', async () => {
    const consumer = createTextAttachmentsQueueConsumer();
    const resultPromise = consumer(makeQueueItem(), null);

    await flushAsyncWork();
    capturedOnError?.(new Error('ECONNREFUSED'));
    jest.runAllTimers();

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe('temporary');
  });

  it('uses shared close-before-start error message when WebSocket closes', async () => {
    const consumer = createTextAttachmentsQueueConsumer();
    const resultPromise = consumer(makeQueueItem(), null);

    await flushAsyncWork();
    capturedOnClose?.(1006, 'abnormal closure');
    jest.runAllTimers();

    const result = await resultPromise;
    expect(result.error).toContain('WebSocket closed before turn_started');
  });
});
