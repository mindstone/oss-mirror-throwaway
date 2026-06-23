/**
 * Voice queue consumer tests — covers upload, transcription, turn submission,
 * session-busy guard, error classification, and transcript listener.
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

const mockUploadAsync = jest.fn();

// Mock expo-file-system/legacy before any imports that use it
jest.mock('expo-file-system/legacy', () => ({
  uploadAsync: (...args: unknown[]) => mockUploadAsync(...args),
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
}));

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

// Initialise auth store with mock storage
const mockStorage = {
  getToken: jest.fn().mockResolvedValue(null),
  setToken: jest.fn().mockResolvedValue(undefined),
  clearToken: jest.fn().mockResolvedValue(undefined),
};
initAuthStore(mockStorage);

import {
  createVoiceQueueConsumer,
  setVoiceTranscriptListener,
  clearVoiceTranscriptListener,
  setVoiceQueueCompletionListener,
  clearVoiceQueueCompletionListener,
} from '../hooks/useVoiceQueueConsumer';
import type { QueueItem } from '@rebel/cloud-client';

function makeQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'item-1',
    type: 'voice-transcription',
    status: 'processing',
    enqueuedAt: Date.now(),
    attempts: 0,
    nextRetryAt: 0,
    isPermanentFailure: false,
    payloadUri: '/path/to/audio.m4a',
    payloadExt: 'm4a',
    metadata: {
      sessionId: 'session-1',
      mimeType: 'audio/mp4',
      durationMs: 3000,
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
  mockUploadAsync.mockReset();
  mockCreateSocket.mockClear();
  mockClose.mockClear();
  capturedOnEvent = undefined;
  capturedOnError = undefined;
  capturedOnClose = undefined;
  clearVoiceTranscriptListener();
  clearVoiceQueueCompletionListener();
}

beforeEach(() => {
  resetState();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('createVoiceQueueConsumer', () => {
  it('returns a consumer function', () => {
    const consumer = createVoiceQueueConsumer();
    expect(typeof consumer).toBe('function');
  });

  describe('payload validation', () => {
    it('returns permanent error when payloadUri is null', async () => {
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, null);

      expect(result).toEqual({
        success: false,
        error: 'Audio file not found',
        errorCategory: 'permanent',
      });
    });
  });

  describe('auth validation', () => {
    it('returns auth error when not authenticated', async () => {
      useAuthStore.setState({ cloudUrl: null, token: null });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/audio.m4a');

      expect(result).toEqual({
        success: false,
        error: 'Not connected to cloud',
        errorCategory: 'auth',
      });
    });

    it('returns auth error when token is missing', async () => {
      useAuthStore.setState({ cloudUrl: 'https://mock.test', token: null });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/audio.m4a');

      expect(result).toEqual({
        success: false,
        error: 'Not connected to cloud',
        errorCategory: 'auth',
      });
    });
  });

  describe('session-busy guard', () => {
    it('defers when current session is busy', async () => {
      useSessionStore.setState({
        currentSession: { id: 'session-1', isBusy: true, title: 'Test', messages: [], activeTurnId: null, lastError: null },
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/audio.m4a');

      expect(result).toEqual({
        success: false,
        error: 'Session is busy',
        errorCategory: 'session-state',
      });
      expect(mockUploadAsync).not.toHaveBeenCalled();
    });

    it('allows processing when a different session is busy', async () => {
      useSessionStore.setState({
        currentSession: { id: 'other-session', isBusy: true, title: 'Other', messages: [], activeTurnId: null, lastError: null },
      });
      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: 'hello' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();

      // Will proceed to upload since target session (session-1) is not busy
      const resultPromise = consumer(item, '/path/to/audio.m4a');

      // Resolve the WebSocket turn lifecycle
      await Promise.resolve();
      await Promise.resolve();
      capturedOnEvent?.({ type: 'turn_started' });
      capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-1' });
      jest.runAllTimers();

      const result = await resultPromise;
      expect(mockUploadAsync).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('upload and transcription', () => {
    it('uploads audio and parses transcript', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: 'Hello world' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();

      const resultPromise = consumer(item, '/path/to/audio.m4a');

      // Wait for upload to complete and socket to be created
      await Promise.resolve();
      await Promise.resolve();

      expect(mockUploadAsync).toHaveBeenCalledWith(
        'https://mock-cloud.test/api/voice/transcribe?sessionId=session-1&durationMs=3000',
        '/path/to/audio.m4a',
        expect.objectContaining({
          httpMethod: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer mock-token',
            'Content-Type': 'audio/mp4',
          }),
        }),
      );

      // Simulate turn lifecycle
      capturedOnEvent?.({ type: 'turn_started' });
      capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-1' });
      jest.runAllTimers();

      const result = await resultPromise;
      expect(result.success).toBe(true);
    });

    it('returns auth error on 401 response', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 401,
        headers: {},
        body: JSON.stringify({ error: 'Unauthorized' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/audio.m4a');

      expect(result).toEqual({
        success: false,
        error: 'Authentication expired',
        errorCategory: 'auth',
      });
    });

    it('returns temporary error on 500 response', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 500,
        headers: {},
        body: 'Internal server error',
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/audio.m4a');

      expect(result).toEqual({
        success: false,
        error: 'Server error (500)',
        errorCategory: 'temporary',
      });
    });

    it('uses structured cloud voice error category for retryable transcription failures', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 503,
        headers: {},
        body: JSON.stringify({
          error: {
            code: 'TRANSCRIPTION_FAILED',
            message: 'The transcription service is temporarily unavailable.',
          },
          voiceErrorCategory: 'temporary',
        }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/audio.m4a');

      expect(result).toEqual({
        success: false,
        error: 'The transcription service is temporarily unavailable.',
        errorCategory: 'temporary',
      });
    });

    it('uses structured cloud voice error category for network transcription failures', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 503,
        headers: {},
        body: JSON.stringify({
          error: {
            code: 'TRANSCRIPTION_FAILED',
            message: "Couldn't reach your voice provider.",
          },
          voiceErrorCategory: 'network',
        }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/audio.m4a');

      expect(result).toEqual({
        success: false,
        error: "Couldn't reach your voice provider.",
        errorCategory: 'network',
      });
    });

    it('does not treat provider auth transcription failures as cloud auth expiry', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 424,
        headers: {},
        body: JSON.stringify({
          error: {
            code: 'TRANSCRIPTION_FAILED',
            message: "Your voice API key isn't working. Check it in Settings.",
          },
          voiceErrorCategory: 'auth',
        }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/audio.m4a');

      expect(result).toEqual({
        success: false,
        error: "Your voice API key isn't working. Check it in Settings.",
        errorCategory: 'provider-auth',
      });
    });

    it.each([
      ['billing', 'Your voice provider account has run out of credits.', 'billing', 424],
      ['provider-error', 'Unexpected transcription response.', 'provider-error', 503],
    ])('preserves structured %s transcription category', async (
      voiceErrorCategory,
      message,
      expectedQueueCategory,
      status,
    ) => {
      mockUploadAsync.mockResolvedValueOnce({
        status,
        headers: {},
        body: JSON.stringify({
          error: {
            code: 'TRANSCRIPTION_FAILED',
            message,
          },
          voiceErrorCategory,
        }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/audio.m4a');

      expect(result).toEqual({
        success: false,
        error: message,
        errorCategory: expectedQueueCategory,
      });
    });

    it('falls back to status-code handling for unrecognized structured voice categories', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 503,
        headers: {},
        body: JSON.stringify({
          error: {
            code: 'TRANSCRIPTION_FAILED',
            message: 'Unknown voice failure.',
          },
          voiceErrorCategory: 'new-category',
        }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/audio.m4a');

      expect(result).toEqual({
        success: false,
        error: 'Server error (503)',
        errorCategory: 'temporary',
      });
    });

    it('returns permanent error on 400 response', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 400,
        headers: {},
        body: JSON.stringify({ error: 'Bad request' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/audio.m4a');

      expect(result).toEqual({
        success: false,
        error: 'Upload failed (400)',
        errorCategory: 'permanent',
      });
    });

    // REBEL-6BJ / FOX-3516: transient 4xx (route-not-found during a deploy
    // window / version skew, timeout, too-early, rate-limited) must be
    // retryable, NOT permanent — otherwise the recording is destroyed on the
    // first failure with no retry.
    it.each([
      [404],
      [408],
      [425],
      [429],
    ])('returns retryable temporary error on transient %i response', async (status) => {
      mockUploadAsync.mockResolvedValueOnce({
        status,
        headers: {},
        body: JSON.stringify({ error: 'transient' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/audio.m4a');

      expect(result).toEqual({
        success: false,
        error: `Upload failed (${status})`,
        errorCategory: 'temporary',
      });
    });

    // Genuinely-permanent 4xx (malformed / too-large / unsupported /
    // unprocessable) must stay permanent — re-sending the same bytes won't help.
    it.each([
      [400],
      [413],
      [415],
      [422],
    ])('keeps permanent error on genuinely-permanent %i response', async (status) => {
      mockUploadAsync.mockResolvedValueOnce({
        status,
        headers: {},
        body: JSON.stringify({ error: 'permanent' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/audio.m4a');

      expect(result).toEqual({
        success: false,
        error: `Upload failed (${status})`,
        errorCategory: 'permanent',
      });
    });

    it('returns network error on upload failure', async () => {
      mockUploadAsync.mockRejectedValueOnce(new Error('Network timeout'));
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/audio.m4a');

      expect(result).toEqual({
        success: false,
        error: 'Network timeout',
        errorCategory: 'network',
      });
    });

    it('succeeds silently on empty transcript', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: '   ' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/audio.m4a');

      expect(result).toEqual({ success: true });
      expect(mockCreateSocket).not.toHaveBeenCalled();
    });
  });

  describe('new session creation', () => {
    it('generates session ID when metadata.sessionId is null', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: 'New task' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem({
        metadata: { sessionId: null, mimeType: 'audio/mp4', durationMs: 2000 },
      });

      const resultPromise = consumer(item, '/path/to/audio.m4a');

      await Promise.resolve();
      await Promise.resolve();

      // Should have generated a mobile-* session ID
      expect(mockCreateSocket).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: expect.stringMatching(/^mobile-/),
          prompt: 'New task',
          clientTurnId: 'turn-item-1',
        }),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
      );

      capturedOnEvent?.({ type: 'turn_started' });
      capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-1' });
      jest.runAllTimers();

      const result = await resultPromise;
      expect(result.success).toBe(true);
    });

    it('creates a new session when the original session was positively tombstoned (deleted)', async () => {
      useSessionStore.setState({
        sessions: [{ id: 'different-session', title: 'Other' }],
        tombstonedSessionIds: new Set<string>(['deleted-session']),
      });
      const listener = jest.fn();
      setVoiceQueueCompletionListener(listener);
      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: 'Recovered transcript' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem({
        metadata: { sessionId: 'deleted-session', mimeType: 'audio/mp4', durationMs: 2000 },
      });

      const resultPromise = consumer(item, '/path/to/audio.m4a');

      await Promise.resolve();
      await Promise.resolve();

      expect(mockCreateSocket).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: expect.stringMatching(/^mobile-/),
          prompt: 'Recovered transcript',
          clientTurnId: 'turn-item-1',
        }),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
      );

      capturedOnEvent?.({ type: 'turn_started' });
      capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-1' });
      jest.runAllTimers();

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'item-1',
          originalSessionId: 'deleted-session',
          recreatedSession: true,
          sessionId: expect.stringMatching(/^mobile-/),
        }),
      );
    });

    it('submits to the requested id (no recreate) for a not-yet-synced new conversation absent from the store', async () => {
      // The reported bug: recording into a brand-new conversation. The minted id is
      // absent from sessions[]/currentSession and NOT tombstoned -> must submit to the
      // requested id (server mints it on first turn), recreatedSession:false. No false
      // "Original conversation was deleted" toast.
      useSessionStore.setState({
        sessions: [{ id: 'different-session', title: 'Other' }],
        tombstonedSessionIds: new Set<string>(),
      });
      const listener = jest.fn();
      setVoiceQueueCompletionListener(listener);
      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: 'Hello from a new conversation' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem({
        metadata: { sessionId: 'mobile-brand-new-id', mimeType: 'audio/mp4', durationMs: 2000 },
      });

      const resultPromise = consumer(item, '/path/to/audio.m4a');

      await Promise.resolve();
      await Promise.resolve();

      expect(mockCreateSocket).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'mobile-brand-new-id',
          prompt: 'Hello from a new conversation',
          clientTurnId: 'turn-item-1',
        }),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
      );

      capturedOnEvent?.({ type: 'turn_started' });
      capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-1' });
      jest.runAllTimers();

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'item-1',
          originalSessionId: 'mobile-brand-new-id',
          recreatedSession: false,
          sessionId: 'mobile-brand-new-id',
        }),
      );
    });
  });

  describe('turn submission', () => {
    it('submits turn via WebSocket after transcription', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: 'Hello world' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();

      const resultPromise = consumer(item, '/path/to/audio.m4a');

      await Promise.resolve();
      await Promise.resolve();

      expect(mockCreateSocket).toHaveBeenCalledWith(
        { sessionId: 'session-1', prompt: 'Hello world', clientTurnId: 'turn-item-1' },
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
      );

      capturedOnEvent?.({ type: 'turn_started' });
      capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-1' });
      jest.runAllTimers();

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(mockClose).toHaveBeenCalled();
    });

    it('forwards meetingSessionId and recordingActive metadata to socket request', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: 'Hello world' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem({
        metadata: {
          sessionId: 'session-1',
          mimeType: 'audio/mp4',
          durationMs: 3000,
          meetingSessionId: 'meeting-cloud-1',
          recordingActive: true,
        },
      });

      const resultPromise = consumer(item, '/path/to/audio.m4a');

      await Promise.resolve();
      await Promise.resolve();

      expect(mockCreateSocket).toHaveBeenCalledWith(
        {
          sessionId: 'session-1',
          prompt: 'Hello world',
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

    it('fires completion listener after successful delivery', async () => {
      const listener = jest.fn();
      setVoiceQueueCompletionListener(listener);
      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: 'Hello world' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();

      const resultPromise = consumer(item, '/path/to/audio.m4a');

      await Promise.resolve();
      await Promise.resolve();

      capturedOnEvent?.({ type: 'turn_started' });
      capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-1' });
      jest.runAllTimers();

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(listener).toHaveBeenCalledWith({
        itemId: 'item-1',
        sessionId: 'session-1',
        originalSessionId: 'session-1',
        recreatedSession: false,
      });
    });

    it('returns temporary error on socket error', async () => {
      const listener = jest.fn();
      setVoiceQueueCompletionListener(listener);
      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: 'Hello' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();

      const resultPromise = consumer(item, '/path/to/audio.m4a');

      await Promise.resolve();
      await Promise.resolve();

      capturedOnError?.(new Error('WebSocket error'));
      jest.runAllTimers();

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.errorCategory).toBe('temporary');
      expect(result.error).toContain('Turn submission failed');
      expect(listener).not.toHaveBeenCalled();
    });

    it('returns temporary error on socket timeout', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: 'Hello' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();

      const resultPromise = consumer(item, '/path/to/audio.m4a');

      await Promise.resolve();
      await Promise.resolve();

      // Advance past the 30s timeout
      jest.advanceTimersByTime(30_000);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Turn submission timed out');
      expect(result.errorCategory).toBe('temporary');
    });

    it('returns temporary error when socket closes before turn_started', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: 'Hello' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();

      const resultPromise = consumer(item, '/path/to/audio.m4a');

      await Promise.resolve();
      await Promise.resolve();

      capturedOnClose?.(1006, 'Abnormal closure');
      jest.runAllTimers();

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('WebSocket closed before turn_started');
    });

    it('does NOT drain queue item on TurnInFlightError (turn_in_flight)', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: 'Hello' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();

      const resultPromise = consumer(item, '/path/to/audio.m4a');

      await Promise.resolve();
      await Promise.resolve();

      capturedOnEvent?.({ type: 'turn_in_flight', turnId: 'turn-1' });
      jest.runAllTimers();

      const result = await resultPromise;
      expect(result).toEqual({
        success: false,
        error: 'Turn is already in flight on the server',
        errorCategory: 'defer',
      });
    });

    it('does NOT drain queue item on PersistedAckMissingError for ack-capable servers', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: 'Hello' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();

      const resultPromise = consumer(item, '/path/to/audio.m4a');

      await Promise.resolve();
      await Promise.resolve();

      capturedOnEvent?.({ type: 'turn_started', turnId: 'turn-1', supportsPersistedAck: true });
      jest.advanceTimersByTime(60_000);

      const result = await resultPromise;
      expect(result).toEqual({
        success: false,
        error: 'Persistence acknowledgement missing',
        errorCategory: 'temporary',
      });
    });

    it('DOES drain queue item on degraded:true fallback (legacy server path)', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: 'Hello' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();

      const resultPromise = consumer(item, '/path/to/audio.m4a');

      await Promise.resolve();
      await Promise.resolve();

      capturedOnEvent?.({ type: 'turn_started', turnId: 'turn-1', supportsPersistedAck: false });
      jest.advanceTimersByTime(60_000);

      const result = await resultPromise;
      expect(result).toEqual({ success: true });
    });
  });

  describe('transcript listener', () => {
    it('fires transcript listener on successful transcription', async () => {
      const listener = jest.fn();
      setVoiceTranscriptListener(listener);

      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: 'Hello world' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();

      const resultPromise = consumer(item, '/path/to/audio.m4a');

      await Promise.resolve();
      await Promise.resolve();

      // Listener should have been called with sessionId and transcript
      expect(listener).toHaveBeenCalledWith('session-1', 'Hello world');

      capturedOnEvent?.({ type: 'turn_started' });
      capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-1' });
      jest.runAllTimers();
      await resultPromise;
    });

    it('does not fire listener on empty transcript', async () => {
      const listener = jest.fn();
      setVoiceTranscriptListener(listener);

      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: '' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();

      await consumer(item, '/path/to/audio.m4a');

      expect(listener).not.toHaveBeenCalled();
    });

    it('does not fire listener on upload error', async () => {
      const listener = jest.fn();
      setVoiceTranscriptListener(listener);

      mockUploadAsync.mockRejectedValueOnce(new Error('Network error'));
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();

      await consumer(item, '/path/to/audio.m4a');

      expect(listener).not.toHaveBeenCalled();
    });

    it('continues processing even if listener throws', async () => {
      setVoiceTranscriptListener(() => {
        throw new Error('Listener error');
      });

      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: 'Hello' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();

      const resultPromise = consumer(item, '/path/to/audio.m4a');

      await Promise.resolve();
      await Promise.resolve();

      capturedOnEvent?.({ type: 'turn_started' });
      capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-1' });
      jest.runAllTimers();

      const result = await resultPromise;
      expect(result.success).toBe(true);
    });

    it('clears listener via clearVoiceTranscriptListener', async () => {
      const listener = jest.fn();
      setVoiceTranscriptListener(listener);
      clearVoiceTranscriptListener();

      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: 'Hello' }),
      });
      const consumer = createVoiceQueueConsumer();
      const item = makeQueueItem();

      const resultPromise = consumer(item, '/path/to/audio.m4a');

      await Promise.resolve();
      await Promise.resolve();

      expect(listener).not.toHaveBeenCalled();

      capturedOnEvent?.({ type: 'turn_started' });
      capturedOnEvent?.({ type: 'turn_persisted', turnId: 'turn-1' });
      jest.runAllTimers();
      await resultPromise;
    });
  });
});
