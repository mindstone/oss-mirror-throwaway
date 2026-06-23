/**
 * AssetStore — interface contract tests.
 *
 * Verifies the contract documented in `src/core/assetStore.ts` against a
 * minimal in-memory implementation. Desktop-specific behavior (atomic writes,
 * MIME re-sniff on read, soft-delete via fs.rename, path traversal protection,
 * structured ENOSPC, log redaction) is exercised in the desktop-impl tests at
 * `src/main/services/__tests__/assetStoreDesktop.test.ts`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  type AllowedImageMimeType,
} from '@shared/markdownImageAssets';
import type {
  AssetStore,
  AssetStoreReadResult,
} from '@core/assetStore';

interface StoredAsset {
  bytes: Buffer;
  mimeType: AllowedImageMimeType;
}

interface SessionAssets {
  primary: Map<string, StoredAsset>;
  thumbnails: Map<string, Buffer>;
}

const PNG_BYTES = Buffer.from('one', 'utf8');
const JPEG_BYTES = Buffer.from('two', 'utf8');

function createInMemoryAssetStore(): AssetStore {
  const active = new Map<string, SessionAssets>();
  const trash = new Map<string, SessionAssets>();

  const sessionKey = (sessionId: string) => sessionId;
  const trashKey = (sessionId: string, timestamp: number) =>
    `${sessionId}_${timestamp}`;

  const ensureSession = (sessionId: string): SessionAssets => {
    const key = sessionKey(sessionId);
    let bucket = active.get(key);
    if (!bucket) {
      bucket = { primary: new Map(), thumbnails: new Map() };
      active.set(key, bucket);
    }
    return bucket;
  };

  return {
    async writeAsset({ sessionId, assetId, bytes, mimeType }) {
      if (
        !ALLOWED_IMAGE_MIME_TYPES.includes(mimeType as AllowedImageMimeType)
      ) {
        throw new Error(`Disallowed MIME type: ${mimeType}`);
      }
      const bucket = ensureSession(sessionId);
      const existing = bucket.primary.get(assetId);
      if (existing) {
        if (existing.bytes.equals(bytes)) {
          return {
            ref: {
              assetId,
              mimeType: existing.mimeType,
              byteSize: existing.bytes.byteLength,
            },
          };
        }
        throw new Error(
          `Asset conflict: ${sessionId}/${assetId} already exists with different bytes`,
        );
      }
      bucket.primary.set(assetId, {
        bytes: Buffer.from(bytes),
        mimeType: mimeType as AllowedImageMimeType,
      });
      return {
        ref: {
          assetId,
          mimeType,
          byteSize: bytes.byteLength,
        },
      };
    },

    async writeThumbnail({ sessionId, thumbnailAssetId, bytes }) {
      const bucket = ensureSession(sessionId);
      bucket.thumbnails.set(thumbnailAssetId, Buffer.from(bytes));
    },

    async generateThumbnail() {
      return { reason: 'unsupported' as const };
    },

    async readAsset({ sessionId, assetId }): Promise<AssetStoreReadResult> {
      const bucket = active.get(sessionKey(sessionId));
      const stored = bucket?.primary.get(assetId);
      if (!stored) return { reason: 'not-found' };
      return {
        reason: 'ok',
        bytes: stored.bytes,
        mimeType: stored.mimeType,
        byteSize: stored.bytes.byteLength,
      };
    },

    async hasAsset({ sessionId, assetId }) {
      const bucket = active.get(sessionKey(sessionId));
      const stored = bucket?.primary.get(assetId);
      if (!stored) return { has: false };
      return { has: true, byteSize: stored.bytes.byteLength };
    },

    async listSessionAssets({ sessionId }) {
      const bucket = active.get(sessionKey(sessionId));
      if (!bucket) return [];
      return Array.from(bucket.primary.keys()).sort();
    },

    async deleteSession({ sessionId }) {
      active.delete(sessionKey(sessionId));
    },

    async moveSessionAssetsToDeleted({ sessionId, timestamp }) {
      const bucket = active.get(sessionKey(sessionId));
      if (!bucket) return;
      const key = trashKey(sessionId, timestamp);
      if (trash.has(key)) {
        throw new Error(
          `Soft-delete collision: ${sessionId}_${timestamp} already exists`,
        );
      }
      trash.set(key, bucket);
      active.delete(sessionKey(sessionId));
    },

    async restoreSessionAssetsFromDeleted({ sessionId, timestamp }) {
      const key = trashKey(sessionId, timestamp);
      const bucket = trash.get(key);
      if (!bucket) {
        throw new Error(`No soft-deleted assets for ${sessionId}_${timestamp}`);
      }
      if (active.has(sessionKey(sessionId))) {
        throw new Error(
          `Restore conflict: active assets already exist for ${sessionId}`,
        );
      }
      active.set(sessionKey(sessionId), bucket);
      trash.delete(key);
    },
  };
}

describe('AssetStore interface contract', () => {
  let store: AssetStore;

  beforeEach(() => {
    store = createInMemoryAssetStore();
  });

  it('writes and reads back identical bytes', async () => {
    const { ref } = await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: PNG_BYTES,
      mimeType: 'image/png',
    });

    expect(ref.assetId).toBe('turn-1-0');
    expect(ref.byteSize).toBe(PNG_BYTES.byteLength);
    expect(ref.mimeType).toBe('image/png');

    const read = await store.readAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
    });
    expect(read.reason).toBe('ok');
    if (read.reason === 'ok') {
      expect(read.bytes.equals(PNG_BYTES)).toBe(true);
      expect(read.mimeType).toBe('image/png');
      expect(read.byteSize).toBe(PNG_BYTES.byteLength);
    }
  });

  it('rejects writes with a disallowed MIME', async () => {
    await expect(
      store.writeAsset({
        sessionId: 'sess-a',
        assetId: 'turn-1-0',
        bytes: PNG_BYTES,
        mimeType: 'image/svg+xml',
      }),
    ).rejects.toThrow(/Disallowed MIME/);
  });

  it('hasAsset returns {has: false} for missing assets', async () => {
    const result = await store.hasAsset({
      sessionId: 'sess-a',
      assetId: 'missing',
    });
    expect(result).toEqual({ has: false });
  });

  it('hasAsset returns {has: true, byteSize} for existing assets', async () => {
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: PNG_BYTES,
      mimeType: 'image/png',
    });
    const result = await store.hasAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
    });
    expect(result.has).toBe(true);
    expect(result.byteSize).toBe(PNG_BYTES.byteLength);
  });

  it('listSessionAssets returns ids for stored primary assets', async () => {
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: PNG_BYTES,
      mimeType: 'image/png',
    });
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-1',
      bytes: JPEG_BYTES,
      mimeType: 'image/jpeg',
    });
    const ids = await store.listSessionAssets({ sessionId: 'sess-a' });
    expect(ids).toEqual(['turn-1-0', 'turn-1-1']);
  });

  it('deleteSession cascades — assets disappear and list returns []', async () => {
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: PNG_BYTES,
      mimeType: 'image/png',
    });
    await store.deleteSession({ sessionId: 'sess-a' });
    const read = await store.readAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
    });
    expect(read.reason).toBe('not-found');
    expect(await store.listSessionAssets({ sessionId: 'sess-a' })).toEqual([]);
  });

  it('moveSessionAssetsToDeleted removes the session from the active path', async () => {
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: PNG_BYTES,
      mimeType: 'image/png',
    });
    await store.moveSessionAssetsToDeleted({
      sessionId: 'sess-a',
      timestamp: 1000,
    });
    const read = await store.readAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
    });
    expect(read.reason).toBe('not-found');
    expect(await store.listSessionAssets({ sessionId: 'sess-a' })).toEqual([]);
  });

  it('restoreSessionAssetsFromDeleted reverses the soft-delete move', async () => {
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: PNG_BYTES,
      mimeType: 'image/png',
    });
    await store.moveSessionAssetsToDeleted({
      sessionId: 'sess-a',
      timestamp: 1000,
    });
    await store.restoreSessionAssetsFromDeleted({
      sessionId: 'sess-a',
      timestamp: 1000,
    });

    const read = await store.readAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
    });
    expect(read.reason).toBe('ok');
    if (read.reason === 'ok') {
      expect(read.bytes.equals(PNG_BYTES)).toBe(true);
    }
  });

  it('treats re-write with identical bytes as idempotent (no-op success)', async () => {
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: PNG_BYTES,
      mimeType: 'image/png',
    });
    const second = await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: Buffer.from(PNG_BYTES),
      mimeType: 'image/png',
    });
    expect(second.ref.assetId).toBe('turn-1-0');
    const read = await store.readAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
    });
    expect(read.reason).toBe('ok');
    if (read.reason === 'ok') {
      expect(read.bytes.equals(PNG_BYTES)).toBe(true);
    }
  });

  it('throws on conflicting re-write (same id, different bytes)', async () => {
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: PNG_BYTES,
      mimeType: 'image/png',
    });
    await expect(
      store.writeAsset({
        sessionId: 'sess-a',
        assetId: 'turn-1-0',
        bytes: JPEG_BYTES,
        mimeType: 'image/png',
      }),
    ).rejects.toThrow(/conflict/i);
  });
});
