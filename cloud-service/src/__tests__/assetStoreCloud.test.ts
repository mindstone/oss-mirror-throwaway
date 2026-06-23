import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let mockDataPath = '';
vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => mockDataPath,
}));

import { AssetStoreError, CloudAssetStore } from '../services/assetStoreCloud';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function makePngBytes(payload = 'cloud-asset-store-test'): Buffer {
  const padded = payload.padEnd(8, '-');
  return Buffer.concat([PNG_SIGNATURE, Buffer.from(padded, 'utf8')]);
}

function makeJpegBytes(payload = 'cloud-asset-store-jpeg'): Buffer {
  const jpegSignature = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  return Buffer.concat([jpegSignature, Buffer.from(payload.padEnd(12, '-'), 'utf8')]);
}

describe('CloudAssetStore', () => {
  let tmpDir: string;
  let store: CloudAssetStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-store-cloud-'));
    mockDataPath = tmpDir;
    store = new CloudAssetStore();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes and reads bytes for a session asset', async () => {
    const bytes = makePngBytes();
    const write = await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes,
      mimeType: 'image/png',
    });

    expect(write.ref).toEqual({
      assetId: 'turn-1-0',
      mimeType: 'image/png',
      byteSize: bytes.byteLength,
    });
    expect(write.status).toBe('created');

    const read = await store.readAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
    });
    expect(read.reason).toBe('ok');
    if (read.reason === 'ok') {
      expect(read.bytes.equals(bytes)).toBe(true);
      expect(read.mimeType).toBe('image/png');
      expect(read.byteSize).toBe(bytes.byteLength);
    }
  });

  it('treats identical rewrite as idempotent', async () => {
    const bytes = makePngBytes();
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes,
      mimeType: 'image/png',
    });

    const second = await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: Buffer.from(bytes),
      mimeType: 'image/png',
    });

    expect(second.ref.byteSize).toBe(bytes.byteLength);
    expect(second.status).toBe('duplicate');
  });

  it('throws conflict on rewrite with different bytes', async () => {
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: makePngBytes('first'),
      mimeType: 'image/png',
    });

    const promise = store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: makePngBytes('second'),
      mimeType: 'image/png',
    });

    await expect(promise).rejects.toBeInstanceOf(AssetStoreError);
    await expect(promise).rejects.toMatchObject({ code: 'conflict' });
  });

  it('throws conflict when same assetId is re-used with a different MIME extension', async () => {
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: makePngBytes('png-first'),
      mimeType: 'image/png',
    });

    await expect(
      store.writeAsset({
        sessionId: 'sess-a',
        assetId: 'turn-1-0',
        bytes: makeJpegBytes('jpeg-second'),
        mimeType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('publishes streamed temp uploads atomically via writeAssetFromTempFile', async () => {
    const sessionDir = path.join(tmpDir, 'sessions', 'sess-a.assets', '_pending');
    fs.mkdirSync(sessionDir, { recursive: true });
    const tempPath = path.join(sessionDir, 'temp-upload.pending');
    const bytes = makePngBytes('temp-upload');
    fs.writeFileSync(tempPath, bytes);

    const write = await store.writeAssetFromTempFile({
      sessionId: 'sess-a',
      assetId: 'turn-2-0',
      tempPath,
      mimeType: 'image/png',
    });

    expect(write.status).toBe('created');
    expect(fs.existsSync(tempPath)).toBe(false);
    const read = await store.readAsset({ sessionId: 'sess-a', assetId: 'turn-2-0' });
    expect(read.reason).toBe('ok');
    if (read.reason === 'ok') {
      expect(read.bytes.equals(bytes)).toBe(true);
    }
  });

  it('tracks hasAsset byte size', async () => {
    const bytes = makePngBytes();
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes,
      mimeType: 'image/png',
    });

    await expect(
      store.hasAsset({ sessionId: 'sess-a', assetId: 'turn-1-0' }),
    ).resolves.toEqual({
      has: true,
      byteSize: bytes.byteLength,
    });
    await expect(
      store.hasAsset({ sessionId: 'sess-a', assetId: 'missing' }),
    ).resolves.toEqual({
      has: false,
    });
  });

  it('lists only primary assets (excluding thumbnails)', async () => {
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: makePngBytes('a'),
      mimeType: 'image/png',
    });
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-1',
      bytes: makePngBytes('b'),
      mimeType: 'image/png',
    });
    await store.writeThumbnail({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      thumbnailAssetId: 'turn-1-0_thumb',
      bytes: makePngBytes('thumb'),
    });

    await expect(store.listSessionAssets({ sessionId: 'sess-a' })).resolves.toEqual([
      'turn-1-0',
      'turn-1-1',
    ]);
  });

  it('deletes a session asset folder', async () => {
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: makePngBytes(),
      mimeType: 'image/png',
    });

    await store.deleteSession({ sessionId: 'sess-a' });

    await expect(store.listSessionAssets({ sessionId: 'sess-a' })).resolves.toEqual([]);
    await expect(
      store.readAsset({ sessionId: 'sess-a', assetId: 'turn-1-0' }),
    ).resolves.toEqual({ reason: 'not-found' });
  });

  it('moves and restores soft-deleted session assets', async () => {
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: makePngBytes(),
      mimeType: 'image/png',
    });

    await store.moveSessionAssetsToDeleted({
      sessionId: 'sess-a',
      timestamp: 1234,
    });

    await expect(
      store.readAsset({ sessionId: 'sess-a', assetId: 'turn-1-0' }),
    ).resolves.toEqual({ reason: 'not-found' });

    await store.restoreSessionAssetsFromDeleted({
      sessionId: 'sess-a',
      timestamp: 1234,
    });

    const read = await store.readAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
    });
    expect(read.reason).toBe('ok');
  });

  it('returns unsupported from generateThumbnail on cloud', async () => {
    await expect(store.generateThumbnail(makePngBytes(), 'image/png')).resolves.toEqual({
      reason: 'unsupported',
    });
  });
});
