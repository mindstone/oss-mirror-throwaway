import { describe, expect, it, vi } from 'vitest';
import type { AssetStore } from '@core/assetStore';
import { materializeImageRefsForEvent } from '../imageAssetMaterialization';

function makeImageContent(count: number): Array<{ type: 'image'; data: string; mimeType: string }> {
  return Array.from({ length: count }, (_, index) => ({
    type: 'image' as const,
    data: Buffer.from(`img-${index}`).toString('base64'),
    mimeType: 'image/png',
  }));
}

function createMockAssetStore(): AssetStore & {
  writeAsset: ReturnType<typeof vi.fn>;
  writeThumbnail: ReturnType<typeof vi.fn>;
  generateThumbnail: ReturnType<typeof vi.fn>;
} {
  return {
    writeAsset: vi.fn(async ({ assetId, mimeType, bytes }) => ({
      ref: { assetId, mimeType, byteSize: bytes.byteLength },
    })),
    writeThumbnail: vi.fn(async () => undefined),
    generateThumbnail: vi.fn(async () => ({
      bytes: Buffer.from('thumb'),
      mimeType: 'image/png' as const,
    })),
    readAsset: vi.fn(async () => ({ reason: 'not-found' as const })),
    hasAsset: vi.fn(async () => ({ has: false })),
    listSessionAssets: vi.fn(async () => []),
    deleteSession: vi.fn(async () => undefined),
    moveSessionAssetsToDeleted: vi.fn(async () => undefined),
    restoreSessionAssetsFromDeleted: vi.fn(async () => undefined),
  };
}

describe('materializeImageRefsForEvent', () => {
  it.each([
    { surface: 'desktop' as const, expectedUploadStatus: 'pending' as const },
    { surface: 'cloud' as const, expectedUploadStatus: 'uploaded' as const },
  ])('materializes refs for all images on $surface', async ({ surface, expectedUploadStatus }) => {
    const assetStore = createMockAssetStore();
    const result = await materializeImageRefsForEvent(
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        eventSeq: 17,
        imageContent: makeImageContent(3),
        surface,
      },
      assetStore,
    );

    expect(result.failures).toEqual([]);
    expect(result.refs).toEqual([
      {
        assetId: 'turn-1-17-0',
        mimeType: 'image/png',
        byteSize: Buffer.from('img-0').byteLength,
        thumbnailAssetId: 'turn-1-17-0_thumb',
        uploadStatus: expectedUploadStatus,
      },
      {
        assetId: 'turn-1-17-1',
        mimeType: 'image/png',
        byteSize: Buffer.from('img-1').byteLength,
        thumbnailAssetId: 'turn-1-17-1_thumb',
        uploadStatus: expectedUploadStatus,
      },
      {
        assetId: 'turn-1-17-2',
        mimeType: 'image/png',
        byteSize: Buffer.from('img-2').byteLength,
        thumbnailAssetId: 'turn-1-17-2_thumb',
        uploadStatus: expectedUploadStatus,
      },
    ]);
    expect(assetStore.writeAsset).toHaveBeenCalledTimes(3);
    expect(assetStore.writeThumbnail).toHaveBeenCalledTimes(3);
  });

  it('returns positional refs with null at a middle failure index', async () => {
    const assetStore = createMockAssetStore();
    assetStore.writeAsset
      .mockImplementationOnce(async ({ assetId, mimeType, bytes }) => ({
        ref: { assetId, mimeType, byteSize: bytes.byteLength },
      }))
      .mockRejectedValueOnce({ code: 'storage-full' })
      .mockImplementationOnce(async ({ assetId, mimeType, bytes }) => ({
        ref: { assetId, mimeType, byteSize: bytes.byteLength },
      }));

    const result = await materializeImageRefsForEvent(
      {
        sessionId: 'session-1',
        turnId: 'turn-2',
        eventSeq: 4,
        imageContent: makeImageContent(3),
        surface: 'desktop',
      },
      assetStore,
    );

    expect(result.refs.map((ref) => ref?.assetId ?? null)).toEqual([
      'turn-2-4-0',
      null,
      'turn-2-4-2',
    ]);
    expect(result.refs).toHaveLength(3);
    expect(result.failures).toEqual([
      {
        index: 1,
        reason: 'storage-full',
        error: { code: 'storage-full' },
      },
    ]);
  });

  it.each([
    {
      label: 'first write failure in a multi-image input',
      failingIndices: [0],
      expectedAssetIds: [null, 'turn-pos-6-1', 'turn-pos-6-2'],
    },
    {
      label: 'last write failure',
      failingIndices: [2],
      expectedAssetIds: ['turn-pos-6-0', 'turn-pos-6-1', null],
    },
    {
      label: 'multiple write failures',
      failingIndices: [0, 2],
      expectedAssetIds: [null, 'turn-pos-6-1', null],
    },
  ])('preserves positional refs and surviving images for $label', async ({
    failingIndices,
    expectedAssetIds,
  }) => {
    const assetStore = createMockAssetStore();
    const failingIndexSet = new Set(failingIndices);

    assetStore.writeAsset.mockImplementation(async ({ assetId, mimeType, bytes }) => {
      const index = Number(assetId.slice(assetId.lastIndexOf('-') + 1));
      if (failingIndexSet.has(index)) {
        throw { code: 'storage-full' };
      }
      return {
        ref: { assetId, mimeType, byteSize: bytes.byteLength },
      };
    });

    const result = await materializeImageRefsForEvent(
      {
        sessionId: 'session-1',
        turnId: 'turn-pos',
        eventSeq: 6,
        imageContent: makeImageContent(3),
        surface: 'desktop',
      },
      assetStore,
    );

    expect(result.refs).toHaveLength(3);
    expect(result.refs.map((ref) => ref?.assetId ?? null)).toEqual(expectedAssetIds);
    expect(result.failures.map((failure) => failure.index)).toEqual(failingIndices);
    expect(result.failures.map((failure) => failure.reason)).toEqual(
      failingIndices.map(() => 'storage-full'),
    );
  });

  it('returns failures for all images when all writes fail', async () => {
    const assetStore = createMockAssetStore();
    assetStore.writeAsset.mockRejectedValue({ code: 'storage-full' });

    const result = await materializeImageRefsForEvent(
      {
        sessionId: 'session-1',
        turnId: 'turn-3',
        eventSeq: 8,
        imageContent: makeImageContent(3),
        surface: 'desktop',
      },
      assetStore,
    );

    expect(result.refs).toEqual([null, null, null]);
    expect(result.failures).toHaveLength(3);
    expect(result.failures.map((failure) => failure.reason)).toEqual([
      'storage-full',
      'storage-full',
      'storage-full',
    ]);
  });

  it('keeps refs when thumbnail write fails', async () => {
    const assetStore = createMockAssetStore();
    assetStore.writeThumbnail.mockRejectedValueOnce(new Error('thumbnail failed'));

    const result = await materializeImageRefsForEvent(
      {
        sessionId: 'session-1',
        turnId: 'turn-4',
        eventSeq: 10,
        imageContent: makeImageContent(1),
        surface: 'desktop',
      },
      assetStore,
    );

    expect(result.failures).toEqual([]);
    expect(result.refs).toHaveLength(1);
    expect(result.refs[0]?.thumbnailAssetId).toBeUndefined();
  });

  it('maps conflict write failures to reason=conflict', async () => {
    const assetStore = createMockAssetStore();
    assetStore.writeAsset.mockRejectedValueOnce({ code: 'conflict' });

    const result = await materializeImageRefsForEvent(
      {
        sessionId: 'session-1',
        turnId: 'turn-5',
        eventSeq: 2,
        imageContent: makeImageContent(1),
        surface: 'desktop',
      },
      assetStore,
    );

    expect(result.refs).toEqual([null]);
    expect(result.failures).toEqual([
      {
        index: 0,
        reason: 'conflict',
        error: { code: 'conflict' },
      },
    ]);
  });

  it('derives asset IDs from turnId-eventSeq-index exactly', async () => {
    const assetStore = createMockAssetStore();

    const result = await materializeImageRefsForEvent(
      {
        sessionId: 'session-1',
        turnId: 'turn-alpha',
        eventSeq: 99,
        imageContent: makeImageContent(3),
        surface: 'desktop',
      },
      assetStore,
    );

    expect(result.refs.map((ref) => ref?.assetId)).toEqual([
      'turn-alpha-99-0',
      'turn-alpha-99-1',
      'turn-alpha-99-2',
    ]);
  });
});
