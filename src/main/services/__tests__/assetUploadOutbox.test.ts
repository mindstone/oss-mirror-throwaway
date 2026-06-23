import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AssetUploadOutbox } from '../assetUploadOutbox';
import { getAssetStore } from '@core/assetStore';
import { uploadAsset, CloudClientError } from '@rebel/cloud-client/cloudClient';
import { getIncrementalSessionStore } from '@core/services/incrementalSessionStore';

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));

 
vi.mock('@core/assetStore', () => ({
  getAssetStore: vi.fn()
}));

 
vi.mock('@rebel/cloud-client/cloudClient', () => ({
  uploadAsset: vi.fn(),
  CloudClientError: class extends Error {
    statusCode?: number;
    constructor(msg: string, code?: number) { super(msg); this.statusCode = code; }
  }
}));

 
vi.mock('@core/services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn()
}));

describe('AssetUploadOutbox', () => {
  let outbox: AssetUploadOutbox;
  let mockAssetStore: any;
  let mockSessionStore: any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(uploadAsset).mockReset();
    vi.mocked(uploadAsset).mockResolvedValue(undefined);
    outbox = new AssetUploadOutbox();

    mockAssetStore = {
      onAssetWritten: vi.fn().mockReturnValue(vi.fn()),
      listSessionAssets: vi.fn().mockResolvedValue([]),
      listSessionAssetStatuses: vi.fn().mockResolvedValue({}),
      readAsset: vi.fn().mockResolvedValue({ reason: 'ok', bytes: Buffer.from('test'), mimeType: 'image/png' }),
      markAssetUploaded: vi.fn().mockResolvedValue(undefined),
      markAssetFailed: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(getAssetStore).mockReturnValue(mockAssetStore);

    mockSessionStore = {
      listSessions: vi.fn().mockReturnValue([]),
      getSession: vi.fn(),
      upsertSession: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(getIncrementalSessionStore).mockReturnValue(mockSessionStore);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await outbox.stop({ timeoutMs: 1000 }).catch(() => {});
    vi.resetAllMocks();
  });

  it('scans listSessionAssets + manifest statuses on boot and cross-checks missing refs', async () => {
    const mockSession = {
      id: 'sess-1',
      eventsByTurn: {
        t1: [{
          type: 'tool',
          imageRef: [
            { assetId: 'a-pending', uploadStatus: 'pending', mimeType: 'image/png', byteSize: 1 },
            { assetId: 'a-uploaded', uploadStatus: 'uploaded', mimeType: 'image/png', byteSize: 1 },
            { assetId: 'a-missing', uploadStatus: 'pending', mimeType: 'image/png', byteSize: 1 },
          ],
        }],
      },
    };
    mockSessionStore.listSessions.mockReturnValue([{ id: 'sess-1' }] as any);
    mockSessionStore.getSession.mockResolvedValue(mockSession as any);
    mockAssetStore.listSessionAssets.mockResolvedValue(['a-pending', 'a-uploaded']);
    mockAssetStore.listSessionAssetStatuses.mockResolvedValue({
      'a-pending': 'pending',
      'a-uploaded': 'uploaded',
    });

    await outbox.start();
    await vi.runAllTimersAsync();

    expect(uploadAsset).toHaveBeenCalledWith('sess-1', 'a-pending', expect.any(Buffer), 'image/png');
    expect(uploadAsset).not.toHaveBeenCalledWith('sess-1', 'a-uploaded', expect.any(Buffer), 'image/png');
    expect(mockAssetStore.markAssetFailed).toHaveBeenCalledWith(
      'sess-1',
      'a-missing',
      'missing-on-boot-recovery',
    );
  });

  it('marks asset missing on non-retryable 4xx dead-letter', async () => {
    const session = {
      id: 'sess-1',
      eventsByTurn: {
        t1: [{
          type: 'tool',
          imageRef: [{ assetId: 'a1', uploadStatus: 'pending', mimeType: 'image/png', byteSize: 1 }],
        }],
      },
    };
    mockSessionStore.getSession.mockResolvedValue(session as any);
    await outbox.start();
    outbox.enqueue('sess-1', 'a1');

    vi.mocked(uploadAsset).mockRejectedValueOnce(new CloudClientError('Forbidden', 403));

    await vi.runAllTimersAsync();

    expect(mockAssetStore.markAssetFailed).toHaveBeenCalledWith('sess-1', 'a1', 'upload-4xx-403');
    expect(session.eventsByTurn.t1[0].imageRef[0].uploadStatus).toBe('missing');
    expect(outbox.getStatus().failedCount).toBe(1);
    expect(outbox.getStatus().pending).toBe(0);
  });

  it('marks asset missing when retries are exhausted', async () => {
    const session = {
      id: 'sess-1',
      eventsByTurn: {
        t1: [{
          type: 'tool',
          imageRef: [{ assetId: 'a1', uploadStatus: 'pending', mimeType: 'image/png', byteSize: 1 }],
        }],
      },
    };
    mockSessionStore.getSession.mockResolvedValue(session as any);
    await outbox.start();
    vi.mocked(uploadAsset).mockRejectedValue(new CloudClientError('Server Error', 500));
    outbox.enqueue('sess-1', 'a1');

    await vi.runAllTimersAsync();

    expect(uploadAsset).toHaveBeenCalledTimes(6);
    expect(mockAssetStore.markAssetFailed).toHaveBeenCalledWith(
      'sess-1',
      'a1',
      'upload-retries-exhausted',
    );
    expect(session.eventsByTurn.t1[0].imageRef[0].uploadStatus).toBe('missing');
    expect(outbox.getStatus().failedCount).toBe(1);
  });

  it('deduplicates queue entries by sessionId::assetId key', async () => {
    await outbox.start();
    outbox.enqueue('sess-1', 'a1');
    outbox.enqueue('sess-1', 'a1');

    await vi.runAllTimersAsync();

    expect(uploadAsset).toHaveBeenCalledTimes(1);
    expect(outbox.getStatus().pending).toBe(0);
  });

  it('drains queued retries during stop(timeoutMs)', async () => {
    await outbox.start();
    vi.mocked(uploadAsset)
      .mockRejectedValueOnce(new CloudClientError('Server Error', 500))
      .mockResolvedValueOnce(undefined);
    outbox.enqueue('sess-1', 'a1');

    const stopPromise = outbox.stop({ timeoutMs: 5000 });
    await vi.runAllTimersAsync();
    await expect(stopPromise).resolves.toBeUndefined();

    expect(uploadAsset).toHaveBeenCalledTimes(2);
    expect(outbox.getStatus().pending).toBe(0);
    expect(outbox.getStatus().uploading).toBe(0);
  });
});
