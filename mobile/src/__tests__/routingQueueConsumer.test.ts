/**
 * Routing queue consumer tests — verifies that queue items are dispatched
 * to the correct consumer based on item.type.
 */

const mockUploadAsync = jest.fn();

// Mock expo-file-system/legacy before any imports that use it
jest.mock('expo-file-system/legacy', () => ({
  uploadAsync: (...args: unknown[]) => mockUploadAsync(...args),
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
}));

const mockClose = jest.fn();
let capturedOnEvent: ((event: unknown) => void) | undefined;

const mockCreateSocket = jest.fn<{ close: typeof mockClose }, unknown[]>(
  (_req: unknown, onEvent: unknown, _onError: unknown, _onClose: unknown) => {
    capturedOnEvent = onEvent as (event: unknown) => void;
    return { close: mockClose };
  },
);

// Mock useOfflineQueueStore before it's imported by the consumer modules
jest.mock('../../../cloud-client/src/offlineQueue/offlineQueueStore', () => {
  const actual = jest.requireActual('../../../cloud-client/src/offlineQueue/offlineQueueStore');
  return {
    ...actual,
    useOfflineQueueStore: Object.assign(
      jest.fn(),
      {
        getState: () => ({
          loadJsonPayload: jest.fn().mockResolvedValue(null),
        }),
        setState: jest.fn(),
        subscribe: jest.fn(() => jest.fn()),
      },
    ),
  };
});

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

const { useSessionStore, initAuthStore, useAuthStore } = require('@rebel/cloud-client');

// Initialise auth store with mock storage
const mockStorage = {
  getToken: jest.fn().mockResolvedValue(null),
  setToken: jest.fn().mockResolvedValue(undefined),
  clearToken: jest.fn().mockResolvedValue(undefined),
};
initAuthStore(mockStorage);

import { createRoutingConsumer } from '../hooks/useRoutingQueueConsumer';
import type { QueueItem } from '@rebel/cloud-client';

// Mock global fetch for meeting recording status polling
const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeQueueItem(type: QueueItem['type'], overrides: Partial<QueueItem> = {}): QueueItem {
  const baseMetadata: Record<string, unknown> = {
    'voice-transcription': {
      sessionId: 'session-1',
      mimeType: 'audio/mp4',
      durationMs: 3000,
    },
    'text-message': {
      sessionId: 'session-1',
      prompt: 'Hello from queue',
    },
    'text-with-attachments': {
      sessionId: 'session-1',
      prompt: 'See attached',
      attachmentCount: 1,
    },
    'meeting-recording': {
      meetingTitle: 'Q1 Planning',
      meetingStartTime: Date.now() - 3600000,
      mimeType: 'audio/mp4',
      durationMs: 3600000,
    },
    'meeting-chunk': {
      meetingSessionId: 'meeting-1',
      chunkIndex: 0,
      totalChunks: 5,
      mimeType: 'audio/mp4',
      durationMs: 60000,
    },
  };

  return {
    id: `item-${type}`,
    type,
    status: 'processing',
    enqueuedAt: Date.now(),
    attempts: 0,
    nextRetryAt: 0,
    isPermanentFailure: false,
    payloadUri: type !== 'text-message' ? `/path/to/${type}.m4a` : undefined,
    payloadExt: type !== 'text-message' ? 'm4a' : undefined,
    metadata: baseMetadata[type] as Record<string, unknown>,
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
  });
  mockUploadAsync.mockReset();
  mockCreateSocket.mockClear();
  mockClose.mockClear();
  mockFetch.mockReset();
  capturedOnEvent = undefined;
}

beforeEach(() => {
  resetState();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('createRoutingConsumer', () => {
  it('returns a consumer function', () => {
    const consumer = createRoutingConsumer();
    expect(typeof consumer).toBe('function');
  });

  describe('voice-transcription routing', () => {
    it('routes voice-transcription items to voice consumer', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ transcript: 'Hello world' }),
      });
      const consumer = createRoutingConsumer();
      const item = makeQueueItem('voice-transcription');

      const resultPromise = consumer(item, '/path/to/voice.m4a');

      // Wait for upload + socket creation
      await Promise.resolve();
      await Promise.resolve();

      // Voice consumer should have uploaded to voice/transcribe endpoint
      expect(mockUploadAsync).toHaveBeenCalledWith(
        expect.stringContaining('/api/voice/transcribe'),
        '/path/to/voice.m4a',
        expect.any(Object),
      );

      // Simulate turn_started
      capturedOnEvent?.({ type: 'turn_started' });
      jest.runAllTimers();

      const result = await resultPromise;
      expect(result.success).toBe(true);
    });
  });

  describe('meeting-recording routing', () => {
    it('routes meeting-recording items to meeting consumer', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 202,
        headers: {},
        body: JSON.stringify({ recordingId: 'rec-123', status: 'processing' }),
      });
      const consumer = createRoutingConsumer();
      const item = makeQueueItem('meeting-recording');

      const result = await consumer(item, '/path/to/meeting.m4a');

      // Meeting consumer should have uploaded to meeting/recording-upload endpoint
      expect(mockUploadAsync).toHaveBeenCalledWith(
        expect.stringContaining('/api/meeting/recording-upload'),
        '/path/to/meeting.m4a',
        expect.any(Object),
      );

      // Should return defer since processing is async
      expect(result).toEqual({
        success: false,
        errorCategory: 'defer',
      });
    });
  });

  describe('text-message routing', () => {
    it('routes text-message items to text consumer', async () => {
      const consumer = createRoutingConsumer();
      const item = makeQueueItem('text-message');

      const resultPromise = consumer(item, null);

      await Promise.resolve();

      // Text consumer submits via WebSocket
      expect(mockCreateSocket).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          prompt: 'Hello from queue',
        }),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
      );

      capturedOnEvent?.({ type: 'turn_started' });
      jest.runAllTimers();

      const result = await resultPromise;
      expect(result.success).toBe(true);
    });
  });

  describe('text-with-attachments routing', () => {
    it('dispatches text-with-attachments to textAttachmentsConsumer', async () => {
      const consumer = createRoutingConsumer();
      const item = makeQueueItem('text-with-attachments', {
        id: 'item-text-with-attachments',
        metadata: {
          sessionId: 'session-1',
          prompt: 'See the attached image',
          attachmentCount: 1,
        },
      });

      // The consumer will try to load the JSON payload — without it, returns permanent error
      const result = await consumer(item, null);

      // Without JSON payload loaded (no mock wired for loadJsonPayload),
      // the consumer returns permanent error for missing payload.
      // This verifies the routing dispatched to the correct consumer.
      expect(result.success).toBe(false);
      expect(result.errorCategory).toBe('permanent');
      expect(result.error).toContain('Attachment payload missing');
    });
  });

  describe('feedback routing', () => {
    it('dispatches feedback items to the feedback consumer (not unhandled)', async () => {
      const consumer = createRoutingConsumer();
      const item = makeQueueItem('feedback', {
        id: 'item-feedback',
        type: 'feedback',
        payloadUri: undefined,
        payloadExt: undefined,
        metadata: { feedbackType: 'bug', urgency: 'medium' },
      });

      // loadJsonPayload is mocked to resolve null, so the feedback consumer
      // returns a permanent "payload missing" — which proves routing reached the
      // feedback consumer (NOT the unhandled-type default branch).
      const result = await consumer(item, null);
      expect(result.success).toBe(false);
      expect(result.errorCategory).toBe('permanent');
      expect(result.error).toContain('Feedback payload missing');
      expect(result.error).not.toContain('Unhandled queue item type');
    });
  });

  describe('meeting-chunk routing', () => {
    it('dispatches meeting-chunk items to chunk consumer (not unhandled)', async () => {
      const consumer = createRoutingConsumer();
      const item = makeQueueItem('meeting-chunk', {
        id: 'item-meeting-chunk',
        type: 'meeting-chunk',
        metadata: {
          meetingSessionId: 'meeting-1',
          chunkIndex: 0,
          totalChunks: 5,
          mimeType: 'audio/mp4',
          durationMs: 60000,
        },
      });

      // Meeting chunk consumer requires manifest + upload endpoint.
      // The key assertion: it doesn't return "Unhandled queue item type"
      // which would indicate the routing switch statement missed it.
      const result = await consumer(item, '/path/to/chunk.m4a');
      expect(result.success).toBe(false);
      // Verify it was NOT treated as unhandled
      expect(result.error).not.toContain('Unhandled queue item type');
    });
  });
});
