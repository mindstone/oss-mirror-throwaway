/**
 * Meeting recording queue consumer tests — covers upload, status polling,
 * defer pattern, idempotency, auth errors, and orphaned job detection.
 */

const mockUploadAsync = jest.fn();

// Mock expo-file-system/legacy before any imports that use it
jest.mock('expo-file-system/legacy', () => ({
  uploadAsync: (...args: unknown[]) => mockUploadAsync(...args),
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
}));

jest.mock('../../../cloud-client/src/cloudClient', () => ({
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

const { initAuthStore, useAuthStore } = require('@rebel/cloud-client');

// Initialise auth store with mock storage
const mockStorage = {
  getToken: jest.fn().mockResolvedValue(null),
  setToken: jest.fn().mockResolvedValue(undefined),
  clearToken: jest.fn().mockResolvedValue(undefined),
};
initAuthStore(mockStorage);

import { createMeetingRecordingConsumer } from '../hooks/useMeetingRecordingConsumer';
import type { QueueItem } from '@rebel/cloud-client';

function makeQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'meeting-item-1',
    type: 'meeting-recording',
    status: 'processing',
    enqueuedAt: Date.now(),
    attempts: 0,
    nextRetryAt: 0,
    isPermanentFailure: false,
    payloadUri: '/path/to/meeting.m4a',
    payloadExt: 'm4a',
    metadata: {
      meetingTitle: 'Q1 Planning',
      meetingStartTime: Date.now() - 3600000,
      mimeType: 'audio/mp4',
      durationMs: 3600000,
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
  mockUploadAsync.mockReset();
  // Reset global fetch mock
  (global.fetch as jest.Mock)?.mockReset?.();
}

// Mock global fetch for status polling
const mockFetch = jest.fn();
global.fetch = mockFetch;

beforeEach(() => {
  resetState();
});

describe('createMeetingRecordingConsumer', () => {
  it('returns a consumer function', () => {
    const consumer = createMeetingRecordingConsumer();
    expect(typeof consumer).toBe('function');
  });

  describe('payload validation', () => {
    it('returns permanent error when payloadUri is null', async () => {
      const consumer = createMeetingRecordingConsumer();
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
      const consumer = createMeetingRecordingConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/meeting.m4a');

      expect(result).toEqual({
        success: false,
        error: 'Not connected to cloud',
        errorCategory: 'auth',
      });
    });

    it('returns auth error on 401 upload response', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 401,
        headers: {},
        body: JSON.stringify({ error: 'Unauthorized' }),
      });
      const consumer = createMeetingRecordingConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/meeting.m4a');

      expect(result).toEqual({
        success: false,
        error: 'Authentication expired',
        errorCategory: 'auth',
      });
    });
  });

  describe('successful upload + poll → complete', () => {
    it('returns success when upload returns 200 with status complete (idempotent)', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ recordingId: 'rec-123', status: 'complete' }),
      });
      const consumer = createMeetingRecordingConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/meeting.m4a');

      expect(result).toEqual({ success: true });
    });
  });

  describe('upload returns 202, poll returns processing → defer', () => {
    it('returns defer when upload returns 202 (processing)', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 202,
        headers: {},
        body: JSON.stringify({ recordingId: 'rec-123', status: 'processing' }),
      });
      const consumer = createMeetingRecordingConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/meeting.m4a');

      expect(result).toEqual({
        success: false,
        errorCategory: 'defer',
      });
    });
  });

  describe('idempotency key', () => {
    it('sets X-Idempotency-Key header to item ID', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 202,
        headers: {},
        body: JSON.stringify({ recordingId: 'rec-123', status: 'processing' }),
      });
      const consumer = createMeetingRecordingConsumer();
      const item = makeQueueItem({ id: 'my-unique-item-id' });
      await consumer(item, '/path/to/meeting.m4a');

      expect(mockUploadAsync).toHaveBeenCalledWith(
        'https://mock-cloud.test/api/meeting/recording-upload',
        '/path/to/meeting.m4a',
        expect.objectContaining({
          httpMethod: 'POST',
          headers: expect.objectContaining({
            'X-Idempotency-Key': 'my-unique-item-id',
            'X-Meeting-Title': expect.any(String),
            'X-Meeting-Start-Time': expect.any(String),
            Authorization: 'Bearer mock-token',
          }),
        }),
      );
    });
  });

  describe('error classification', () => {
    it('returns permanent error on 413 (file too large)', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 413,
        headers: {},
        body: 'Payload too large',
      });
      const consumer = createMeetingRecordingConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/meeting.m4a');

      expect(result).toEqual({
        success: false,
        error: 'Recording file too large',
        errorCategory: 'permanent',
      });
    });

    it('returns temporary error on 500 response', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 500,
        headers: {},
        body: 'Internal server error',
      });
      const consumer = createMeetingRecordingConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/meeting.m4a');

      expect(result).toEqual({
        success: false,
        error: 'Server error (500)',
        errorCategory: 'temporary',
      });
    });

    it('returns permanent error on 400 response', async () => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 400,
        headers: {},
        body: JSON.stringify({ error: 'Bad request' }),
      });
      const consumer = createMeetingRecordingConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/meeting.m4a');

      expect(result).toEqual({
        success: false,
        error: 'Upload failed (400)',
        errorCategory: 'permanent',
      });
    });

    // Genuinely-permanent 4xx (unsupported / unprocessable media) must stay
    // permanent — re-sending the same bytes won't help. (413 and 400 keep their
    // dedicated special-case messages above; this covers the remaining set.)
    it.each([
      [415],
      [422],
    ])('keeps permanent error on genuinely-permanent %i upload response', async (status) => {
      mockUploadAsync.mockResolvedValueOnce({
        status,
        headers: {},
        body: JSON.stringify({ error: 'permanent' }),
      });
      const consumer = createMeetingRecordingConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/meeting.m4a');

      expect(result).toEqual({
        success: false,
        error: `Upload failed (${status})`,
        errorCategory: 'permanent',
      });
    });

    // REBEL-6BJ / FOX-3516: a transient 404 (route-not-found during a deploy
    // window / version skew) on the upload endpoint must be retryable, not
    // permanent — otherwise the recording is destroyed on the first failure.
    it.each([
      [404],
      [408],
      [425],
      [429],
    ])('returns retryable temporary error on transient %i upload response', async (status) => {
      mockUploadAsync.mockResolvedValueOnce({
        status,
        headers: {},
        body: JSON.stringify({ error: 'transient' }),
      });
      const consumer = createMeetingRecordingConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/meeting.m4a');

      expect(result).toEqual({
        success: false,
        error: `Upload failed (${status})`,
        errorCategory: 'temporary',
      });
    });

    it('returns network error on upload failure', async () => {
      mockUploadAsync.mockRejectedValueOnce(new Error('Network timeout'));
      const consumer = createMeetingRecordingConsumer();
      const item = makeQueueItem();
      const result = await consumer(item, '/path/to/meeting.m4a');

      expect(result).toEqual({
        success: false,
        error: 'Network timeout',
        errorCategory: 'network',
      });
    });
  });
});
