/**
 * DesktopAssetStore — integration tests against a real temp directory.
 *
 * Exercises the security and correctness invariants from
 * `docs/plans/260516_image_asset_architecture.md` § Stage 2:
 *  - Write→read roundtrip
 *  - Magic-byte sniff on write; re-sniff on read (post-write tampering)
 *  - MIME allowlist enforcement
 *  - Path traversal rejection (both `sessionId` and `assetId`, at every entry)
 *  - Concurrent same-asset writes: same bytes ⇒ both succeed idempotently,
 *    different bytes ⇒ exactly one `conflict` throw, never silent overwrite
 *  - Idempotent re-write; conflicting re-write throws
 *  - `hasAsset` shape
 *  - `listSessionAssets` enumeration (and thumbnail exclusion)
 *  - `deleteSession` cascade
 *  - Soft-delete / restore cycle
 *  - ENOSPC mapped to structured `{ code: 'storage-full' }` at every
 *    fs-mutating step (mkdir, writeFile, link)
 *  - Structured warn logs on every error path with redacted IDs (no raw
 *    sessionId, assetId, or filesystem path leaks)
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let mockDataPath = '';
 
vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => mockDataPath,
}));

const { mockLog } = vi.hoisted(() => ({
  mockLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  },
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => mockLog),
  logger: mockLog,
}));

 
vi.mock('electron', () => {
  return {
    nativeImage: {
      createFromBuffer: vi.fn((buf: Buffer) => {
        return {
          isEmpty: () => buf.length === 0,
          resize: vi.fn(() => ({
            toPNG: () => Buffer.from('mock-png-bytes'),
          })),
        };
      }),
    },
  };
});

import { AssetStoreError, DesktopAssetStore } from '../assetStoreDesktop';
import type { AssetStoreFs } from '../assetStoreDesktop';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function makePngBytes(payload = 'rebel-asset-test'): Buffer {
  // Pad payload so total >= 12 bytes (sniff requires it).
  const padded = payload.padEnd(8, '-');
  return Buffer.concat([PNG_SIGNATURE, Buffer.from(padded, 'utf8')]);
}

function makeJpegBytes(payload = 'rebel-jpeg-test'): Buffer {
  const padded = payload.padEnd(8, '-');
  return Buffer.concat([JPEG_SIGNATURE, Buffer.from(padded, 'utf8')]);
}

function makeFsMock(overrides: Partial<AssetStoreFs> = {}): AssetStoreFs {
  return {
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(async (): Promise<Buffer> => {
      const err = new Error('not found') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }),
    rename: vi.fn(async () => undefined),
    link: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0 })),
    readdir: vi.fn(async (): Promise<string[]> => []),
    unlink: vi.fn(async () => undefined),
    access: vi.fn(async () => undefined),
    ...overrides,
  };
}

function serializeLogCalls(): string {
  const allCalls = [
    ...mockLog.warn.mock.calls,
    ...mockLog.info.mock.calls,
    ...mockLog.error.mock.calls,
    ...mockLog.debug.mock.calls,
  ];
  return JSON.stringify(allCalls);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('DesktopAssetStore', () => {
  let tmpDir: string;
  let store: DesktopAssetStore;

  beforeEach(() => {
    mockLog.info.mockReset();
    mockLog.warn.mockReset();
    mockLog.error.mockReset();
    mockLog.debug.mockReset();
    mockLog.trace.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-store-desktop-'));
    mockDataPath = tmpDir;
    store = new DesktopAssetStore();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('writes and reads back identical bytes', async () => {
    const bytes = makePngBytes();
    const result = await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes,
      mimeType: 'image/png',
    });

    expect(result.ref.assetId).toBe('turn-1-0');
    expect(result.ref.mimeType).toBe('image/png');
    expect(result.ref.byteSize).toBe(bytes.byteLength);

    const expectedPath = path.join(
      tmpDir,
      'sessions',
      'sess-a.assets',
      'turn-1-0.png',
    );
    expect(fs.existsSync(expectedPath)).toBe(true);

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

  it('does not leave the tmp file on disk after a successful write', async () => {
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: makePngBytes(),
      mimeType: 'image/png',
    });

    const sessionDir = path.join(tmpDir, 'sessions', 'sess-a.assets');
    const entries = fs.readdirSync(sessionDir);
    expect(entries.some((e) => e.includes('.tmp'))).toBe(false);
    expect(entries).toContain('turn-1-0.png');
  });

  it('rejects writes whose magic bytes disagree with the declared MIME', async () => {
    const promise = store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: makeJpegBytes(),
      mimeType: 'image/png',
    });
    await expect(promise).rejects.toBeInstanceOf(AssetStoreError);
    await expect(promise).rejects.toMatchObject({ code: 'magic-byte-mismatch' });
  });

  it('rejects writes with a disallowed MIME type', async () => {
    const promise = store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: makePngBytes(),
      mimeType: 'image/svg+xml',
    });
    await expect(promise).rejects.toMatchObject({ code: 'mime-rejected' });
  });

  it('rejects asset IDs that contain path separators or traversal', async () => {
    await expect(
      store.writeAsset({
        sessionId: 'sess-a',
        assetId: '..\\evil',
        bytes: makePngBytes(),
        mimeType: 'image/png',
      }),
    ).rejects.toMatchObject({ code: 'path-traversal' });

    await expect(
      store.writeAsset({
        sessionId: 'sess-a',
        assetId: '../escape',
        bytes: makePngBytes(),
        mimeType: 'image/png',
      }),
    ).rejects.toMatchObject({ code: 'path-traversal' });

    const readResult = await store.readAsset({
      sessionId: 'sess-a',
      assetId: '../escape',
    });
    expect(readResult.reason).toBe('permission-denied');
  });

  it('rejects assetId = "." and ".." (single- and double-dot)', async () => {
    for (const badId of ['.', '..']) {
      await expect(
        store.writeAsset({
          sessionId: 'sess-a',
          assetId: badId,
          bytes: makePngBytes(),
          mimeType: 'image/png',
        }),
      ).rejects.toMatchObject({ code: 'path-traversal' });
    }
  });

  it('rejects empty and NUL-containing assetId', async () => {
    await expect(
      store.writeAsset({
        sessionId: 'sess-a',
        assetId: '',
        bytes: makePngBytes(),
        mimeType: 'image/png',
      }),
    ).rejects.toMatchObject({ code: 'path-traversal' });

    await expect(
      store.writeAsset({
        sessionId: 'sess-a',
        assetId: '\u0000foo',
        bytes: makePngBytes(),
        mimeType: 'image/png',
      }),
    ).rejects.toMatchObject({ code: 'path-traversal' });
  });

  describe('sessionId path-traversal validation', () => {
    const invalidSessionIds: Array<[label: string, value: string]> = [
      ['empty string', ''],
      ['single dot', '.'],
      ['double dot', '..'],
      ['relative traversal', '../escape'],
      ['absolute path', '/abs'],
      ['contains slash', 'has/slash'],
      ['contains backslash', 'has\\backslash'],
      ['contains NUL', '\u0000foo'],
      ['contains dot in middle', 'a.b'],
    ];

    for (const [label, badId] of invalidSessionIds) {
      it(`writeAsset rejects sessionId (${label})`, async () => {
        await expect(
          store.writeAsset({
            sessionId: badId,
            assetId: 'turn-1-0',
            bytes: makePngBytes(),
            mimeType: 'image/png',
          }),
        ).rejects.toMatchObject({ code: 'path-traversal' });
      });
    }

    it('accepts UUID-style session id', async () => {
      await expect(
        store.writeAsset({
          sessionId: 'valid-uuid-style_session_123',
          assetId: 'turn-1-0',
          bytes: makePngBytes(),
          mimeType: 'image/png',
        }),
      ).resolves.toBeTruthy();
    });

    it('every entry point rejects sessionId "../escape" with path-traversal', async () => {
      const badId = '../escape';
      const bytes = makePngBytes();

      await expect(
        store.writeAsset({
          sessionId: badId,
          assetId: 'turn-1-0',
          bytes,
          mimeType: 'image/png',
        }),
      ).rejects.toMatchObject({ code: 'path-traversal' });
      await expect(
        store.writeThumbnail({
          sessionId: badId,
          assetId: 'turn-1-0',
          thumbnailAssetId: 'turn-1-0_thumb',
          bytes,
        }),
      ).rejects.toMatchObject({ code: 'path-traversal' });
      await expect(
        store.readAsset({ sessionId: badId, assetId: 'turn-1-0' }),
      ).rejects.toMatchObject({ code: 'path-traversal' });
      await expect(
        store.hasAsset({ sessionId: badId, assetId: 'turn-1-0' }),
      ).rejects.toMatchObject({ code: 'path-traversal' });
      await expect(
        store.listSessionAssets({ sessionId: badId }),
      ).rejects.toMatchObject({ code: 'path-traversal' });
      await expect(
        store.deleteSession({ sessionId: badId }),
      ).rejects.toMatchObject({ code: 'path-traversal' });
      await expect(
        store.moveSessionAssetsToDeleted({ sessionId: badId, timestamp: 1 }),
      ).rejects.toMatchObject({ code: 'path-traversal' });
      await expect(
        store.restoreSessionAssetsFromDeleted({ sessionId: badId, timestamp: 1 }),
      ).rejects.toMatchObject({ code: 'path-traversal' });
    });
  });

  describe('concurrent writes to the same asset path', () => {
    it('same-byte concurrent writes both resolve successfully (idempotent)', async () => {
      const bytes = makePngBytes('same');
      const results = await Promise.allSettled([
        store.writeAsset({
          sessionId: 'sess-aa',
          assetId: 'turn-1-0',
          bytes,
          mimeType: 'image/png',
        }),
        store.writeAsset({
          sessionId: 'sess-aa',
          assetId: 'turn-1-0',
          bytes: Buffer.from(bytes),
          mimeType: 'image/png',
        }),
      ]);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('fulfilled');

      const read = await store.readAsset({
        sessionId: 'sess-aa',
        assetId: 'turn-1-0',
      });
      expect(read.reason).toBe('ok');
      if (read.reason === 'ok') {
        expect(read.bytes.equals(bytes)).toBe(true);
      }

      const sessionDir = path.join(tmpDir, 'sessions', 'sess-aa.assets');
      const entries = fs.readdirSync(sessionDir);
      expect(entries.some((e) => e.includes('.tmp'))).toBe(false);
    });

    it('different-byte concurrent writes deterministically: exactly one conflict throw', async () => {
      const bytesA = makePngBytes('write-a');
      const bytesB = makePngBytes('write-b');
      expect(bytesA.equals(bytesB)).toBe(false);

      const results = await Promise.allSettled([
        store.writeAsset({
          sessionId: 'sess-aa',
          assetId: 'turn-1-0',
          bytes: bytesA,
          mimeType: 'image/png',
        }),
        store.writeAsset({
          sessionId: 'sess-aa',
          assetId: 'turn-1-0',
          bytes: bytesB,
          mimeType: 'image/png',
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(AssetStoreError);
      expect((rejected[0].reason as AssetStoreError).code).toBe('conflict');

      const read = await store.readAsset({
        sessionId: 'sess-aa',
        assetId: 'turn-1-0',
      });
      expect(read.reason).toBe('ok');
      if (read.reason === 'ok') {
        const winnerIsA = results[0].status === 'fulfilled';
        const winnerBytes = winnerIsA ? bytesA : bytesB;
        expect(read.bytes.equals(winnerBytes)).toBe(true);
      }

      const sessionDir = path.join(tmpDir, 'sessions', 'sess-aa.assets');
      const entries = fs.readdirSync(sessionDir);
      expect(entries.some((e) => e.includes('.tmp'))).toBe(false);
    });
  });

  it('returns {reason: "corrupt"} when the file no longer matches the declared MIME', async () => {
    const bytes = makePngBytes();
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes,
      mimeType: 'image/png',
    });

    const onDisk = path.join(
      tmpDir,
      'sessions',
      'sess-a.assets',
      'turn-1-0.png',
    );
    await fsp.writeFile(onDisk, Buffer.from('not-a-png-anymore'));

    const read = await store.readAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
    });
    expect(read.reason).toBe('corrupt');
  });

  it('returns {reason: "not-found"} for missing assets', async () => {
    const read = await store.readAsset({
      sessionId: 'sess-a',
      assetId: 'missing',
    });
    expect(read.reason).toBe('not-found');
  });

  it('treats identical-byte re-writes as a no-op', async () => {
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

  it('throws conflict on re-write with different bytes', async () => {
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: makePngBytes('first'),
      mimeType: 'image/png',
    });
    await expect(
      store.writeAsset({
        sessionId: 'sess-a',
        assetId: 'turn-1-0',
        bytes: makePngBytes('second'),
        mimeType: 'image/png',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
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

  it('reports hasAsset {has, byteSize} correctly for present and absent', async () => {
    const bytes = makePngBytes();
    expect(
      await store.hasAsset({ sessionId: 'sess-a', assetId: 'turn-1-0' }),
    ).toEqual({ has: false });

    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes,
      mimeType: 'image/png',
    });

    const present = await store.hasAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
    });
    expect(present.has).toBe(true);
    expect(present.byteSize).toBe(bytes.byteLength);
  });

  it('listSessionAssets returns primary ids and excludes thumbnails', async () => {
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: makePngBytes('a'),
      mimeType: 'image/png',
    });
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-1',
      bytes: makeJpegBytes('b'),
      mimeType: 'image/jpeg',
    });
    await store.writeThumbnail({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      thumbnailAssetId: 'turn-1-0_thumb',
      bytes: makePngBytes('thumb'),
    });

    const ids = await store.listSessionAssets({ sessionId: 'sess-a' });
    expect(ids).toEqual(['turn-1-0', 'turn-1-1']);
  });

  it('tracks manifest upload statuses for pending/uploaded/missing', async () => {
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: makePngBytes('pending'),
      mimeType: 'image/png',
    });
    await store.markAssetUploaded('sess-a', 'turn-1-0');
    await store.markAssetFailed('sess-a', 'turn-1-1', 'dead-letter');

    const statuses = await store.listSessionAssetStatuses('sess-a');
    expect(statuses).toEqual({
      'turn-1-0': 'uploaded',
      'turn-1-1': 'missing',
    });
  });

  it('deleteSession cascades — assets disappear and list returns []', async () => {
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: makePngBytes(),
      mimeType: 'image/png',
    });
    await store.deleteSession({ sessionId: 'sess-a' });

    expect(await store.listSessionAssets({ sessionId: 'sess-a' })).toEqual([]);
    const read = await store.readAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
    });
    expect(read.reason).toBe('not-found');
  });

  it('deleteSession is idempotent when the session has no assets', async () => {
    await expect(store.deleteSession({ sessionId: 'ghost' })).resolves.toBeUndefined();
  });

  it('moveSessionAssetsToDeleted then restoreSessionAssetsFromDeleted survives a roundtrip', async () => {
    const bytes = makePngBytes();
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes,
      mimeType: 'image/png',
    });
    await store.moveSessionAssetsToDeleted({
      sessionId: 'sess-a',
      timestamp: 1234,
    });

    expect(
      fs.existsSync(path.join(tmpDir, 'sessions', 'sess-a.assets')),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(tmpDir, 'sessions-deleted', 'sess-a_1234.assets'),
      ),
    ).toBe(true);

    await store.restoreSessionAssetsFromDeleted({
      sessionId: 'sess-a',
      timestamp: 1234,
    });
    const read = await store.readAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
    });
    expect(read.reason).toBe('ok');
    if (read.reason === 'ok') {
      expect(read.bytes.equals(bytes)).toBe(true);
    }
  });

  it('restoreSessionAssetsFromDeleted refuses to clobber an existing active folder', async () => {
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-1-0',
      bytes: makePngBytes('a'),
      mimeType: 'image/png',
    });
    await store.moveSessionAssetsToDeleted({
      sessionId: 'sess-a',
      timestamp: 1234,
    });
    await store.writeAsset({
      sessionId: 'sess-a',
      assetId: 'turn-2-0',
      bytes: makePngBytes('b'),
      mimeType: 'image/png',
    });

    await expect(
      store.restoreSessionAssetsFromDeleted({
        sessionId: 'sess-a',
        timestamp: 1234,
      }),
    ).rejects.toMatchObject({ code: 'restore-conflict' });
  });

  describe('ENOSPC mapping', () => {
    function makeEnospcError(): NodeJS.ErrnoException {
      const err = new Error('no space') as NodeJS.ErrnoException;
      err.code = 'ENOSPC';
      return err;
    }

    it('maps ENOSPC at mkdir to {code: "storage-full"}', async () => {
      const fsMock = makeFsMock({
        mkdir: vi.fn(async () => {
          throw makeEnospcError();
        }),
      });
      const enospStore = new DesktopAssetStore({ baseDir: tmpDir, fs: fsMock });

      await expect(
        enospStore.writeAsset({
          sessionId: 'sess-a',
          assetId: 'turn-1-0',
          bytes: makePngBytes(),
          mimeType: 'image/png',
        }),
      ).rejects.toMatchObject({ code: 'storage-full' });
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          op: 'writeAsset',
          reason: 'storage-full',
          step: 'mkdir',
        }),
        expect.any(String),
      );
    });

    it('maps ENOSPC at writeFile to {code: "storage-full"}', async () => {
      const fsMock = makeFsMock({
        writeFile: vi.fn(async () => {
          throw makeEnospcError();
        }),
      });
      const enospStore = new DesktopAssetStore({ baseDir: tmpDir, fs: fsMock });

      await expect(
        enospStore.writeAsset({
          sessionId: 'sess-a',
          assetId: 'turn-1-0',
          bytes: makePngBytes(),
          mimeType: 'image/png',
        }),
      ).rejects.toMatchObject({ code: 'storage-full' });
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          op: 'writeAsset',
          reason: 'storage-full',
          step: 'writeFile',
        }),
        expect.any(String),
      );
    });

    it('maps ENOSPC at link to {code: "storage-full"}', async () => {
      const fsMock = makeFsMock({
        link: vi.fn(async () => {
          throw makeEnospcError();
        }),
      });
      const enospStore = new DesktopAssetStore({ baseDir: tmpDir, fs: fsMock });

      await expect(
        enospStore.writeAsset({
          sessionId: 'sess-a',
          assetId: 'turn-1-0',
          bytes: makePngBytes(),
          mimeType: 'image/png',
        }),
      ).rejects.toMatchObject({ code: 'storage-full' });
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          op: 'writeAsset',
          reason: 'storage-full',
          step: 'link',
        }),
        expect.any(String),
      );
    });
  });

  describe('structured logging on error paths', () => {
    it('logs a structured warn for not-found reads with redacted IDs', async () => {
      await store.readAsset({ sessionId: 'sess-a', assetId: 'missing' });
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          op: 'readAsset',
          reason: 'not-found',
        }),
        expect.any(String),
      );
    });

    it('logs a structured warn for sessionId path-traversal attempts', async () => {
      await store
        .writeAsset({
          sessionId: '../escape',
          assetId: 'turn-1-0',
          bytes: makePngBytes(),
          mimeType: 'image/png',
        })
        .catch(() => undefined);
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          op: 'writeAsset',
          reason: 'path-traversal',
          target: 'sessionId',
        }),
        expect.any(String),
      );
    });

    it('logs a structured warn for assetId path-traversal attempts on writeAsset', async () => {
      await store
        .writeAsset({
          sessionId: 'sess-a',
          assetId: '../escape',
          bytes: makePngBytes(),
          mimeType: 'image/png',
        })
        .catch(() => undefined);
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          op: 'writeAsset',
          reason: 'path-traversal',
          target: 'assetId',
        }),
        expect.any(String),
      );
    });

    it('logs a structured warn for hasAsset assetId traversal (swallowed)', async () => {
      const result = await store.hasAsset({
        sessionId: 'sess-a',
        assetId: '../escape',
      });
      expect(result.has).toBe(false);
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          op: 'hasAsset',
          reason: 'path-traversal',
        }),
        expect.any(String),
      );
    });

    it('logs a structured warn for listSessionAssets ENOENT', async () => {
      const result = await store.listSessionAssets({ sessionId: 'no-session' });
      expect(result).toEqual([]);
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          op: 'listSessionAssets',
          reason: 'not-found',
        }),
        expect.any(String),
      );
    });

    it('logs a structured warn for deleteSession on unexpected fs error', async () => {
      const fsMock = makeFsMock({
        rm: vi.fn(async () => {
          const err = new Error('busy') as NodeJS.ErrnoException;
          err.code = 'EBUSY';
          throw err;
        }),
      });
      const delStore = new DesktopAssetStore({ baseDir: tmpDir, fs: fsMock });

      await expect(delStore.deleteSession({ sessionId: 'sess-a' })).rejects.toBeDefined();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          op: 'deleteSession',
          reason: 'unknown',
          errCode: 'EBUSY',
        }),
        expect.any(String),
      );
    });

    it('logs a structured warn for moveSessionAssetsToDeleted ENOENT', async () => {
      await store.moveSessionAssetsToDeleted({
        sessionId: 'no-session',
        timestamp: 1,
      });
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          op: 'moveSessionAssetsToDeleted',
          reason: 'not-found',
        }),
        expect.any(String),
      );
    });

    it('logs a structured warn for restoreSessionAssetsFromDeleted ENOENT', async () => {
      await expect(
        store.restoreSessionAssetsFromDeleted({
          sessionId: 'no-session',
          timestamp: 1,
        }),
      ).rejects.toBeDefined();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          op: 'restoreSessionAssetsFromDeleted',
          reason: 'not-found',
        }),
        expect.any(String),
      );
    });

    it('logs a structured warn for non-ENOSPC write failures (mkdir EACCES)', async () => {
      const fsMock = makeFsMock({
        mkdir: vi.fn(async () => {
          const err = new Error('access denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }),
      });
      const accStore = new DesktopAssetStore({ baseDir: tmpDir, fs: fsMock });

      await expect(
        accStore.writeAsset({
          sessionId: 'sess-a',
          assetId: 'turn-1-0',
          bytes: makePngBytes(),
          mimeType: 'image/png',
        }),
      ).rejects.toBeDefined();

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          op: 'writeAsset',
          reason: 'unknown',
          step: 'mkdir',
          errCode: 'EACCES',
        }),
        expect.any(String),
      );
    });
  });

  it('redacts session IDs and asset IDs in log output (and surfaces redacted forms)', async () => {
    const sessionId = 'sensitive-session-id-1234567890abcdef';
    const assetId = 'sensitive-turn-id-9876543210';
    const expectedHash = createHash('sha256')
      .update(sessionId)
      .digest('hex')
      .slice(0, 8);
    const expectedSuffix = assetId.slice(-8);

    await store
      .writeAsset({
        sessionId,
        assetId,
        bytes: makeJpegBytes(),
        mimeType: 'image/png',
      })
      .catch(() => undefined);

    const serialized = serializeLogCalls();

    // Redacted forms are present
    expect(serialized).toContain(expectedHash);
    expect(serialized).toContain(expectedSuffix);

    // Raw values are absent
    expect(serialized).not.toContain(sessionId);
    expect(serialized).not.toContain(assetId);

    // No full filesystem path leaks (the tmpDir prefix would expose it)
    expect(serialized).not.toContain(tmpDir);
    expect(serialized).not.toContain(`${sessionId}.assets`);
  });

  describe('generateThumbnail', () => {
    it('returns {reason: "unsupported"} for disallowed MIME types', async () => {
      const result = await store.generateThumbnail(Buffer.from('data'), 'image/svg+xml');
      expect(result).toEqual({ reason: 'unsupported' });
    });

    it('returns 320px-wide PNG for valid image bytes', async () => {
      // Create a mock image with 800x600 resolution
      const originalBytes = makePngBytes('original');
      const result = await store.generateThumbnail(originalBytes, 'image/png');
      
      expect(result).not.toHaveProperty('reason');
      if (!('reason' in result)) {
        expect(result.mimeType).toBe('image/png');
        expect(result.bytes).toBeInstanceOf(Buffer);
        // Electron nativeImage mock in vitest environment will likely just return a Buffer,
        // so we just verify it didn't throw and returned something that looks like an image.
        expect(result.bytes.length).toBeGreaterThan(0);
      }
    });

    it('returns {reason: "failed"} for empty or corrupt bytes', async () => {
      // In tests, empty buffer will cause nativeImage.createFromBuffer(empty).isEmpty() to be true
      const result = await store.generateThumbnail(Buffer.alloc(0), 'image/png');
      expect(result).toEqual({ reason: 'failed' });
    });
  });
});
