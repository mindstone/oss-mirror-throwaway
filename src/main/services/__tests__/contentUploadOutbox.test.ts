import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContentUploadOutbox } from '../contentUploadOutbox';
import { getContentStore } from '@core/contentStore';
import { uploadContent, CloudClientError } from '@rebel/cloud-client/cloudClient';
import { getIncrementalSessionStore } from '@core/services/incrementalSessionStore';
import { getErrorReporter } from '@core/errorReporter';

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

 
vi.mock('@core/contentStore', () => ({
  getContentStore: vi.fn(),
  CONTENT_REF_THRESHOLD_BYTES: 200 * 1024,
}));

 
vi.mock('@rebel/cloud-client/cloudClient', () => ({
  uploadContent: vi.fn(),
  CloudClientError: class extends Error {
    statusCode?: number;
    constructor(msg: string, code?: number) {
      super(msg);
      this.statusCode = code;
    }
  },
}));

 
vi.mock('@core/services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(),
}));

 
vi.mock('@core/errorReporter', () => ({
  getErrorReporter: vi.fn(),
}));

describe('ContentUploadOutbox', () => {
  let outbox: ContentUploadOutbox;
  let mockContentStore: any;
  let mockSessionStore: any;
  let mockErrorReporter: {
    addBreadcrumb: ReturnType<typeof vi.fn>;
    captureMessage: ReturnType<typeof vi.fn>;
    captureException: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(uploadContent).mockReset();
    vi.mocked(uploadContent).mockResolvedValue(undefined);
    outbox = new ContentUploadOutbox();

    mockContentStore = {
      onContentWritten: vi.fn().mockReturnValue(vi.fn()),
      listSessionContent: vi.fn().mockResolvedValue([]),
      listSessionContentStatuses: vi.fn().mockResolvedValue({}),
      readContent: vi.fn().mockResolvedValue({
        reason: 'ok',
        bytes: Buffer.from('test'),
        mimeType: 'text/plain',
        byteSize: 4,
      }),
      markContentUploaded: vi.fn().mockResolvedValue(undefined),
      markContentFailed: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(getContentStore).mockReturnValue(mockContentStore);

    mockSessionStore = {
      listSessions: vi.fn().mockReturnValue([]),
      getSession: vi.fn(),
      upsertSession: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(getIncrementalSessionStore).mockReturnValue(mockSessionStore);

    mockErrorReporter = {
      addBreadcrumb: vi.fn(),
      captureMessage: vi.fn(),
      captureException: vi.fn(),
    };
    vi.mocked(getErrorReporter).mockReturnValue(mockErrorReporter as never);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await outbox.stop({ timeoutMs: 1000 }).catch(() => {});
    vi.resetAllMocks();
  });

  it('uploads queued content on enqueue', async () => {
    await outbox.start();
    outbox.enqueue('sess-1', 'content-1');

    await vi.runAllTimersAsync();

    expect(uploadContent).toHaveBeenCalledWith(
      'sess-1',
      'content-1',
      expect.any(Buffer),
      'text/plain',
    );
    expect(mockContentStore.markContentUploaded).toHaveBeenCalledWith('sess-1', 'content-1');
  });

  it('treats non-retryable 4xx as terminal and emits observability', async () => {
    await outbox.start();
    vi.mocked(uploadContent).mockRejectedValueOnce(new CloudClientError('Forbidden', 403));
    outbox.enqueue('sess-1', 'content-1');

    await vi.runAllTimersAsync();

    expect(mockContentStore.markContentFailed).toHaveBeenCalledWith(
      'sess-1',
      'content-1',
      'upload-4xx-403',
    );
    expect(mockErrorReporter.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'content-upload-outbox',
        message: 'content-upload-outbox:terminal-failure',
      }),
    );
    expect(mockErrorReporter.captureMessage).toHaveBeenCalledWith(
      'content-upload-outbox:terminal-failure',
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('uses manifest firstQueuedAt for 7-day stuck backlog escalation after restart', async () => {
    const oldFirstQueuedAt = Date.now() - (8 * 24 * 60 * 60 * 1000);
    mockContentStore.listSessionContent.mockResolvedValueOnce(['content-1']);
    mockContentStore.listSessionContentUploadRecords = vi.fn().mockResolvedValueOnce({
      'content-1': { uploadStatus: 'pending', firstQueuedAt: oldFirstQueuedAt },
    });
    mockSessionStore.listSessions.mockReturnValueOnce([{ id: 'sess-1' }]);
    mockSessionStore.getSession.mockResolvedValueOnce({ id: 'sess-1', eventsByTurn: {} });

    await outbox.start();
    await vi.runAllTimersAsync();

    expect(mockErrorReporter.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'content-upload-outbox',
        message: 'content-upload-outbox:stuck',
        data: expect.objectContaining({ ageDays: expect.any(Number) }),
      }),
    );
  });

  it('retries on 5xx until primary backoff is exhausted, then dead-letter retries', async () => {
    await outbox.start();
    vi.mocked(uploadContent).mockRejectedValue(new CloudClientError('Server Error', 500));
    outbox.enqueue('sess-1', 'content-1');

    await vi.runAllTimersAsync();

    expect(uploadContent).toHaveBeenCalled();
    expect(mockContentStore.markContentFailed).toHaveBeenCalledWith(
      'sess-1',
      'content-1',
      'upload-retries-exhausted',
    );
  });

  it('deduplicates enqueue by sessionId::contentId', async () => {
    await outbox.start();
    outbox.enqueue('sess-1', 'content-1');
    outbox.enqueue('sess-1', 'content-1');

    await vi.runAllTimersAsync();

    expect(uploadContent).toHaveBeenCalledTimes(1);
  });

  it('drains queued retries during stop(timeoutMs)', async () => {
    await outbox.start();
    vi.mocked(uploadContent)
      .mockRejectedValueOnce(new CloudClientError('Server Error', 500))
      .mockResolvedValueOnce(undefined);
    outbox.enqueue('sess-1', 'content-1');

    const stopPromise = outbox.stop({ timeoutMs: 5000 });
    await vi.runAllTimersAsync();
    await expect(stopPromise).resolves.toBeUndefined();

    expect(uploadContent).toHaveBeenCalledTimes(2);
    expect(outbox.getStatus().pending).toBe(0);
    expect(outbox.getStatus().uploading).toBe(0);
  });
});
