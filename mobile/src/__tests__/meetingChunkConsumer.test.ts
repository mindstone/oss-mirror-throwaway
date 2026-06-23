import { createMeetingChunkConsumer } from '../hooks/useMeetingChunkConsumer';
import type { QueueItem } from '@rebel/cloud-client';

const mockUploadAsync = jest.fn();
const mockReadMeetingManifest = jest.fn();
const mockUpdateMeetingManifest = jest.fn();
const mockSetCloudSessionId = jest.fn();
let mockActiveMeetingSessionId: string | null = null;
let mockCompanionSessionId: string | null = null;

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

jest.mock('expo-file-system/legacy', () => ({
  uploadAsync: (...args: unknown[]) => mockUploadAsync(...args),
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
}));

jest.mock('../utils/meetingManifest', () => ({
  createMeetingManifest: jest.fn(),
  deleteMeetingSession: jest.fn(),
  getMeetingChunkPath: jest.fn(),
  listMeetingChunkIndices: jest.fn(),
  listMeetingManifests: jest.fn(),
  readMeetingManifest: (...args: unknown[]) => mockReadMeetingManifest(...args),
  updateMeetingManifest: (...args: unknown[]) => mockUpdateMeetingManifest(...args),
}));

jest.mock('../stores/activeRecordingStore', () => ({
  useActiveRecordingStore: {
    getState: () => ({
      meetingSessionId: mockActiveMeetingSessionId,
      companionSessionId: mockCompanionSessionId,
      setCloudSessionId: mockSetCloudSessionId,
    }),
  },
}));

jest.mock('@rebel/cloud-client', () => ({
  // Pull the real, pure live-meeting id casts (zero-import module — does NOT pull
  // in the heavy barrel) so a future pure cast added there needs no mock edit.
  ...(jest.requireActual('../../../cloud-client/src/types/liveMeetingIds') as typeof import('../../../cloud-client/src/types/liveMeetingIds')),
  useAuthStore: {
    getState: () => ({
      cloudUrl: 'https://mock-cloud.test',
      token: 'mock-token',
    }),
  },
  useOfflineQueueStore: {
    getState: () => ({
      isInitialized: true,
      items: [],
      enqueueOrThrow: jest.fn(),
    }),
  },
  useSessionStore: {
    getState: () => ({
      sessions: [],
      currentSession: null,
    }),
  },
  QueueFullError: class QueueFullError extends Error {
    maxSize: number;

    constructor(maxSize: number) {
      super(`Queue full (${maxSize})`);
      this.maxSize = maxSize;
    }
  },
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  }),
  // Use the REAL SSOT permanent-whitelist classifier rather than a hand-copied
  // duplicate, so this test exercises the actual mapping. The classifier source
  // is a pure function with only a `type` import, so requiring it directly is
  // safe and doesn't pull in the heavy `@rebel/cloud-client` barrel.
  classifyUploadFailureCategory: (
    jest.requireActual('../../../cloud-client/src/offlineQueue/classifyUploadFailureCategory') as {
      classifyUploadFailureCategory: (status: number) => string;
    }
  ).classifyUploadFailureCategory,
}));

function makeChunkQueueItem(meetingSessionId: string): QueueItem {
  return {
    id: `queue-${meetingSessionId}-0`,
    type: 'meeting-chunk',
    status: 'pending',
    enqueuedAt: Date.now(),
    attempts: 0,
    nextRetryAt: 0,
    isPermanentFailure: false,
    metadata: {
      meetingSessionId,
      chunkIndex: 0,
      meetingStartTime: 123,
      mimeType: 'audio/mp4',
    },
  } as QueueItem;
}

// A single-chunk final item: after the chunk uploads (200), the consumer
// proceeds to finalize the cloud session (the `/finalize` fetch call).
function makeFinalChunkQueueItem(meetingSessionId: string): QueueItem {
  return {
    id: `queue-${meetingSessionId}-0`,
    type: 'meeting-chunk',
    status: 'pending',
    enqueuedAt: Date.now(),
    attempts: 0,
    nextRetryAt: 0,
    isPermanentFailure: false,
    metadata: {
      meetingSessionId,
      chunkIndex: 0,
      isFinalChunk: true,
      totalChunks: 1,
      meetingStartTime: 123,
      mimeType: 'audio/mp4',
    },
  } as QueueItem;
}

/**
 * Route `global.fetch` so the session-create call succeeds (returns a
 * sessionId) while the `/finalize` call returns `finalizeStatus`. Used by the
 * finalize-path classification tests.
 */
function mockFetchWithFinalizeStatus(finalizeStatus: number): void {
  mockFetch.mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.endsWith('/finalize')) {
      return {
        status: finalizeStatus,
        ok: finalizeStatus < 400,
        json: async () => ({ error: 'finalize failure' }),
      };
    }
    return {
      status: 200,
      ok: true,
      json: async () => ({ sessionId: 'cloud-session-1' }),
    };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockActiveMeetingSessionId = null;
  mockCompanionSessionId = null;

  mockReadMeetingManifest.mockResolvedValue({
    localId: 'meeting-local-1',
    nextChunkIndex: 1,
    lastAckedChunkIndex: -1,
    meetingTitle: 'Meeting',
    startTime: 123,
  });

  let manifestState = {
    localId: 'meeting-local-1',
    cloudSessionId: undefined as string | undefined,
    nextChunkIndex: 1,
    lastAckedChunkIndex: -1,
    meetingTitle: 'Meeting',
    startTime: 123,
  };
  mockUpdateMeetingManifest.mockImplementation(async (_localId: string, updater: (current: typeof manifestState) => typeof manifestState) => {
    manifestState = updater(manifestState);
    return manifestState;
  });

  mockFetch.mockResolvedValue({
    status: 200,
    ok: true,
    json: async () => ({ sessionId: 'cloud-session-1' }),
  });

  mockUploadAsync.mockResolvedValue({
    status: 200,
    headers: {},
    body: '',
  });
});

describe('createMeetingChunkConsumer cloud session wiring', () => {
  it('sets cloudSessionId in active recording store when meetingSessionId matches', async () => {
    mockActiveMeetingSessionId = 'meeting-local-1';
    const consumer = createMeetingChunkConsumer();
    const result = await consumer(
      makeChunkQueueItem('meeting-local-1'),
      '/tmp/chunk.m4a',
    );

    expect(result).toEqual({ success: true });
    expect(mockSetCloudSessionId).toHaveBeenCalledWith('cloud-session-1');
  });

  it('does not set cloudSessionId when active recording meetingSessionId differs', async () => {
    mockActiveMeetingSessionId = 'meeting-local-newer';
    const consumer = createMeetingChunkConsumer();
    const result = await consumer(
      makeChunkQueueItem('meeting-local-1'),
      '/tmp/chunk.m4a',
    );

    expect(result).toEqual({ success: true });
    expect(mockSetCloudSessionId).not.toHaveBeenCalled();
  });

  it('includes companionSessionId and idempotency key when creating cloud sessions', async () => {
    mockCompanionSessionId = 'companion-42';
    const consumer = createMeetingChunkConsumer();
    const result = await consumer(
      makeChunkQueueItem('meeting-local-1'),
      '/tmp/chunk.m4a',
    );

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://mock-cloud.test/api/meeting/session/create',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Idempotency-Key': 'meeting-meeting-local-1',
          Authorization: 'Bearer mock-token',
        }),
        body: JSON.stringify({ companionSessionId: 'companion-42' }),
      }),
    );
  });
});

describe('createMeetingChunkConsumer upload failure classification', () => {
  // REBEL-6BJ / FOX-3516: a transient 404 (route-not-found during a deploy
  // window / version skew) on the chunk upload must be retryable, not
  // permanent — otherwise the meeting recording is destroyed on the first
  // failure. 409 (idempotency conflict) and >=500 (defer) semantics are
  // preserved unchanged by the other tests / classifier whitelist.
  it.each([
    [404],
    [408],
    [425],
    [429],
  ])('returns retryable temporary error on transient %i chunk upload response', async (status) => {
    mockUploadAsync.mockResolvedValueOnce({
      status,
      headers: {},
      body: JSON.stringify({ error: 'transient' }),
    });
    const consumer = createMeetingChunkConsumer();
    const result = await consumer(makeChunkQueueItem('meeting-local-1'), '/tmp/chunk.m4a');

    expect(result).toEqual({
      success: false,
      error: `Chunk upload failed (${status})`,
      errorCategory: 'temporary',
    });
  });

  // A 403 on the chunk upload means the cloud bearer / pairing has expired:
  // the shared classifier returns `'auth'`, which the helper must surface as an
  // auth signal — NOT a retryable `temporary` (re-sending the same expired
  // token can't succeed; the user needs to reconnect).
  it("maps a 403 chunk upload response to 'auth'", async () => {
    mockUploadAsync.mockResolvedValueOnce({
      status: 403,
      headers: {},
      body: JSON.stringify({ error: 'forbidden' }),
    });
    const consumer = createMeetingChunkConsumer();
    const result = await consumer(makeChunkQueueItem('meeting-local-1'), '/tmp/chunk.m4a');

    expect(result).toEqual({
      success: false,
      error: 'Authentication expired',
      errorCategory: 'auth',
    });
  });

  it('keeps permanent error on genuinely-permanent 400 chunk upload response', async () => {
    mockUploadAsync.mockResolvedValueOnce({
      status: 400,
      headers: {},
      body: JSON.stringify({ error: 'bad request' }),
    });
    const consumer = createMeetingChunkConsumer();
    const result = await consumer(makeChunkQueueItem('meeting-local-1'), '/tmp/chunk.m4a');

    expect(result).toEqual({
      success: false,
      error: 'Chunk upload failed (400)',
      errorCategory: 'permanent',
    });
  });

  it('preserves the intentional 409 idempotency-conflict permanent semantics', async () => {
    mockUploadAsync.mockResolvedValueOnce({
      status: 409,
      headers: {},
      body: '',
    });
    const consumer = createMeetingChunkConsumer();
    const result = await consumer(makeChunkQueueItem('meeting-local-1'), '/tmp/chunk.m4a');

    expect(result).toEqual({
      success: false,
      error: 'Chunk idempotency conflict on server',
      errorCategory: 'permanent',
    });
  });

  it('preserves the intentional >=500 defer semantics', async () => {
    mockUploadAsync.mockResolvedValueOnce({
      status: 500,
      headers: {},
      body: '',
    });
    const consumer = createMeetingChunkConsumer();
    const result = await consumer(makeChunkQueueItem('meeting-local-1'), '/tmp/chunk.m4a');

    expect(result).toEqual({
      success: false,
      error: 'Chunk upload deferred',
      errorCategory: 'temporary',
    });
  });
});

describe('createMeetingChunkConsumer finalize failure classification', () => {
  // The upload-path classification is covered above; these cover the FINALIZE
  // path (final chunk -> finalize the cloud session). A transient 404 finalize
  // must be retryable (`temporary`), genuinely-permanent 4xx stays `permanent`,
  // and the intentional finalize-409 / >=500 attempt-neutral `defer` is preserved.
  it("returns retryable 'temporary' on a transient 404 finalize response", async () => {
    mockFetchWithFinalizeStatus(404);
    const consumer = createMeetingChunkConsumer();
    const result = await consumer(makeFinalChunkQueueItem('meeting-local-1'), '/tmp/chunk.m4a');

    expect(result).toEqual({
      success: false,
      error: 'Finalize failed (404)',
      errorCategory: 'temporary',
    });
  });

  it("maps a 403 finalize response to 'auth'", async () => {
    mockFetchWithFinalizeStatus(403);
    const consumer = createMeetingChunkConsumer();
    const result = await consumer(makeFinalChunkQueueItem('meeting-local-1'), '/tmp/chunk.m4a');

    expect(result).toEqual({
      success: false,
      error: 'Authentication expired',
      errorCategory: 'auth',
    });
  });

  it("keeps 'permanent' on a genuinely-permanent 400 finalize response", async () => {
    mockFetchWithFinalizeStatus(400);
    const consumer = createMeetingChunkConsumer();
    const result = await consumer(makeFinalChunkQueueItem('meeting-local-1'), '/tmp/chunk.m4a');

    expect(result).toEqual({
      success: false,
      error: 'Finalize failed (400)',
      errorCategory: 'permanent',
    });
  });

  it("preserves the intentional finalize 409 attempt-neutral 'defer' semantics", async () => {
    mockFetchWithFinalizeStatus(409);
    const consumer = createMeetingChunkConsumer();
    const result = await consumer(makeFinalChunkQueueItem('meeting-local-1'), '/tmp/chunk.m4a');

    expect(result).toEqual({
      success: false,
      error: 'Finalize deferred',
      errorCategory: 'defer',
    });
  });

  it("preserves the intentional finalize >=500 attempt-neutral 'defer' semantics", async () => {
    mockFetchWithFinalizeStatus(500);
    const consumer = createMeetingChunkConsumer();
    const result = await consumer(makeFinalChunkQueueItem('meeting-local-1'), '/tmp/chunk.m4a');

    expect(result).toEqual({
      success: false,
      error: 'Finalize deferred',
      errorCategory: 'defer',
    });
  });
});
