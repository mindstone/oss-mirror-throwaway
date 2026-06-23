/**
 * CloudContentStore smoke tests — same boundary contract as
 * `DesktopContentStore`, parallel to `assetStoreCloud.test.ts`.
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { CloudContentStore, ContentStoreError, type ContentStoreFs } from '../contentStoreCloud';

function computeContentId(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

describe('CloudContentStore — real filesystem integration', () => {
  let tempDir = '';
  let store: CloudContentStore;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cloudContent-test-'));
    mockDataPath = tempDir;
    store = new CloudContentStore();
    mockLog.warn.mockReset();
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('write → read roundtrip', async () => {
    const bytes = Buffer.from('cloud-payload'.repeat(20_000), 'utf8');
    const contentId = computeContentId(bytes);

    const write = await store.writeContent({
      sessionId: 'sess-1',
      contentId,
      bytes,
      mimeType: 'text/plain',
    });
    expect(write.ref.contentId).toBe(contentId);

    const read = await store.readContent({ sessionId: 'sess-1', contentId });
    expect(read.reason).toBe('ok');
    if (read.reason === 'ok') {
      expect(read.bytes.equals(bytes)).toBe(true);
      expect(read.mimeType).toBe('text/plain');
    }
  });

  it('writes a desktop-shaped manifest with uploadStatus and mime metadata', async () => {
    const bytes = Buffer.from('manifest-payload', 'utf8');
    const contentId = computeContentId(bytes);

    await store.writeContent({
      sessionId: 'sess-1',
      contentId,
      bytes,
      mimeType: 'text/markdown',
    });

    const manifestPath = path.join(tempDir, 'contentStore', 'sess-1', '_manifest.json');
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest[contentId]).toMatchObject({
      uploadStatus: 'uploaded',
      mimeType: 'text/markdown',
      byteSize: bytes.byteLength,
    });

    const read = await store.readContent({ sessionId: 'sess-1', contentId });
    expect(read.reason).toBe('ok');
    if (read.reason === 'ok') {
      expect(read.mimeType).toBe('text/markdown');
    }
  });

  it('idempotent re-write returns duplicate', async () => {
    const bytes = Buffer.from('dup', 'utf8');
    const contentId = computeContentId(bytes);

    const a = await store.writeContent({ sessionId: 's', contentId, bytes, mimeType: 'text/plain' });
    const b = await store.writeContent({ sessionId: 's', contentId, bytes, mimeType: 'text/plain' });
    expect(a.status).toBe('created');
    expect(b.status).toBe('duplicate');
  });

  it('rejects path traversal in sessionId', async () => {
    await expect(
      store.writeContent({
        sessionId: '../escape',
        contentId: 'abc123',
        bytes: Buffer.from('x'),
        mimeType: 'text/plain',
      }),
    ).rejects.toBeInstanceOf(ContentStoreError);
  });

  it('hasContent reports has=false for unknown content', async () => {
    expect(await store.hasContent({ sessionId: 'sess-1', contentId: 'unknown-content-id-1234' }))
      .toEqual({ has: false });
  });

  it('listSessionContent returns [] for unknown session', async () => {
    expect(await store.listSessionContent({ sessionId: 'unknown' })).toEqual([]);
  });

  it('calls fsyncFile on the tmp file and fsyncDir on the session dir', async () => {
    const fs: ContentStoreFs = {
      writeFile: vi.fn(async () => undefined),
      readFile: vi.fn(async () => {
        const err = new Error('not found') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }),
      rename: vi.fn(async () => undefined),
      link: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
      rm: vi.fn(async () => undefined),
      stat: vi.fn(async () => ({ size: 0 })),
      readdir: vi.fn(async () => []),
      unlink: vi.fn(async () => undefined),
      access: vi.fn(async () => undefined),
      fsyncFile: vi.fn(async () => undefined),
      fsyncDir: vi.fn(async () => undefined),
    };
    const storeWithFs = new CloudContentStore({ fs });
    const bytes = Buffer.from('durable-cloud', 'utf8');

    await storeWithFs.writeContent({
      sessionId: 'sess-1',
      contentId: computeContentId(bytes),
      bytes,
      mimeType: 'text/plain',
    });

    expect(fs.fsyncFile).toHaveBeenCalled();
    expect(fs.fsyncDir).toHaveBeenCalled();
  });
});
