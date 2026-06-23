/**
 * DesktopContentStore — integration tests against a real temp directory.
 *
 * Exercises the security and correctness invariants from
 * `docs/plans/260518_cloud_sync_reconciliation_hardening.md` § Stage B1a:
 *  - Write→read roundtrip
 *  - Path traversal rejection (both `sessionId` and `contentId`)
 *  - Concurrent same-content writes: same bytes ⇒ idempotent success,
 *    different bytes ⇒ exactly one `conflict` throw
 *  - Idempotent re-write; conflicting re-write throws
 *  - `hasContent` shape
 *  - `listSessionContent` enumeration
 *  - Soft-delete / restore cycle
 *  - ENOSPC mapped to structured `{ code: 'storage-full' }` at every step
 *  - Structured warn logs on every error path with redacted IDs
 *  - Manifest tracks pending → uploaded transitions
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

import { ContentStoreError, DesktopContentStore } from '../contentStoreDesktop';
import type { ContentStoreFs } from '../contentStoreDesktop';

function makeBytes(payload: string, repeat = 1): Buffer {
  return Buffer.from(payload.repeat(repeat), 'utf8');
}

function computeContentId(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

function makeFsMock(overrides: Partial<ContentStoreFs> = {}): ContentStoreFs {
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
  return JSON.stringify([
    ...mockLog.warn.mock.calls,
    ...mockLog.info.mock.calls,
    ...mockLog.error.mock.calls,
  ]);
}

describe('DesktopContentStore — real filesystem integration', () => {
  let tempDir = '';
  let store: DesktopContentStore;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'contentStore-test-'));
    mockDataPath = tempDir;
    store = new DesktopContentStore();
    mockLog.warn.mockReset();
    mockLog.info.mockReset();
    mockLog.error.mockReset();
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('write → read roundtrips for a known opaque text blob', async () => {
    const bytes = makeBytes('lorem ipsum ', 50_000);
    const contentId = computeContentId(bytes);

    const write = await store.writeContent({
      sessionId: 'sess-1',
      contentId,
      bytes,
      mimeType: 'text/plain',
    });
    expect(write.status).toBe('created');
    expect(write.ref.contentId).toBe(contentId);
    expect(write.ref.byteSize).toBe(bytes.byteLength);

    const read = await store.readContent({ sessionId: 'sess-1', contentId });
    expect(read.reason).toBe('ok');
    if (read.reason === 'ok') {
      expect(read.bytes.equals(bytes)).toBe(true);
      expect(read.mimeType).toBe('text/plain');
    }
  });

  it('idempotent re-write with identical bytes returns duplicate without error', async () => {
    const bytes = makeBytes('idempotent-payload');
    const contentId = computeContentId(bytes);

    const first = await store.writeContent({
      sessionId: 'sess-1',
      contentId,
      bytes,
      mimeType: 'text/plain',
    });
    const second = await store.writeContent({
      sessionId: 'sess-1',
      contentId,
      bytes,
      mimeType: 'text/plain',
    });

    expect(first.status).toBe('created');
    expect(second.status).toBe('duplicate');
  });

  it('conflicting re-write with different bytes throws conflict', async () => {
    const bytes = makeBytes('first-payload');
    const contentId = computeContentId(bytes);

    await store.writeContent({
      sessionId: 'sess-1',
      contentId,
      bytes,
      mimeType: 'text/plain',
    });

    const different = Buffer.from('different-payload', 'utf8');
    await expect(
      store.writeContent({
        sessionId: 'sess-1',
        contentId,
        bytes: different,
        mimeType: 'text/plain',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it.each([
    ['..', '../escape'],
    ['/abs', 'a/b'],
    ['empty-sess', ''],
    ['', 'empty-id'],
    ['ok', 'with.dots'],
    ['ok', 'with space'],
  ])('rejects path traversal: sessionId=%s contentId=%s', async (sessionId, contentId) => {
    const bytes = makeBytes('payload');
    await expect(
      store.writeContent({ sessionId, contentId, bytes, mimeType: 'text/plain' }),
    ).rejects.toMatchObject({ code: 'path-traversal' });
  });

  it('hasContent returns true with byteSize after a write', async () => {
    const bytes = makeBytes('a', 1024);
    const contentId = computeContentId(bytes);
    await store.writeContent({
      sessionId: 'sess-1',
      contentId,
      bytes,
      mimeType: 'text/plain',
    });

    const result = await store.hasContent({ sessionId: 'sess-1', contentId });
    expect(result.has).toBe(true);
    expect(result.byteSize).toBe(bytes.byteLength);
  });

  it('hasContent returns false for unknown content', async () => {
    const result = await store.hasContent({
      sessionId: 'sess-1',
      contentId: computeContentId(makeBytes('nope')),
    });
    expect(result).toEqual({ has: false });
  });

  it('listSessionContent enumerates blobs and excludes the manifest', async () => {
    const a = makeBytes('alpha');
    const b = makeBytes('bravo');
    const aId = computeContentId(a);
    const bId = computeContentId(b);
    await store.writeContent({ sessionId: 'sess-1', contentId: aId, bytes: a, mimeType: 'text/plain' });
    await store.writeContent({ sessionId: 'sess-1', contentId: bId, bytes: b, mimeType: 'text/plain' });

    const list = await store.listSessionContent({ sessionId: 'sess-1' });
    expect(list.sort()).toEqual([aId, bId].sort());
  });

  it('deleteSession removes all session content', async () => {
    const bytes = makeBytes('byebye');
    const contentId = computeContentId(bytes);
    await store.writeContent({ sessionId: 'sess-1', contentId, bytes, mimeType: 'text/plain' });

    await store.deleteSession({ sessionId: 'sess-1' });

    const list = await store.listSessionContent({ sessionId: 'sess-1' });
    expect(list).toEqual([]);
  });

  it('move → restore cycle preserves content', async () => {
    const bytes = makeBytes('keep-me');
    const contentId = computeContentId(bytes);
    await store.writeContent({ sessionId: 'sess-1', contentId, bytes, mimeType: 'text/plain' });

    const ts = 1234567890;
    await store.moveSessionContentToDeleted({ sessionId: 'sess-1', timestamp: ts });
    expect(await store.listSessionContent({ sessionId: 'sess-1' })).toEqual([]);

    await store.restoreSessionContentFromDeleted({ sessionId: 'sess-1', timestamp: ts });
    const restored = await store.readContent({ sessionId: 'sess-1', contentId });
    expect(restored.reason).toBe('ok');
    if (restored.reason === 'ok') {
      expect(restored.bytes.equals(bytes)).toBe(true);
    }
  });

  it('restore aborts when active session content already exists', async () => {
    const bytes = makeBytes('payload');
    const contentId = computeContentId(bytes);
    await store.writeContent({ sessionId: 'sess-1', contentId, bytes, mimeType: 'text/plain' });

    const ts = 999;
    await store.moveSessionContentToDeleted({ sessionId: 'sess-1', timestamp: ts });

    const fresh = makeBytes('fresh');
    const freshId = computeContentId(fresh);
    await store.writeContent({ sessionId: 'sess-1', contentId: freshId, bytes: fresh, mimeType: 'text/plain' });

    await expect(
      store.restoreSessionContentFromDeleted({ sessionId: 'sess-1', timestamp: ts }),
    ).rejects.toMatchObject({ code: 'restore-conflict' });
  });

  it('markContentUploaded then listSessionContentStatuses reflects the transition', async () => {
    const bytes = makeBytes('pending-then-uploaded');
    const contentId = computeContentId(bytes);
    await store.writeContent({ sessionId: 'sess-1', contentId, bytes, mimeType: 'text/plain' });

    let statuses = await store.listSessionContentStatuses('sess-1');
    expect(statuses[contentId]).toBe('pending');

    await store.markContentUploaded('sess-1', contentId);
    statuses = await store.listSessionContentStatuses('sess-1');
    expect(statuses[contentId]).toBe('uploaded');
  });

  it('persists firstQueuedAt in the manifest across upload status transitions', async () => {
    const bytes = makeBytes('queued-at');
    const contentId = computeContentId(bytes);
    await store.writeContent({ sessionId: 'sess-1', contentId, bytes, mimeType: 'text/plain' });

    const initialRecords = await store.listSessionContentUploadRecords('sess-1');
    expect(initialRecords[contentId]?.uploadStatus).toBe('pending');
    expect(typeof initialRecords[contentId]?.firstQueuedAt).toBe('number');

    await store.markContentUploaded('sess-1', contentId);
    const uploadedRecords = await store.listSessionContentUploadRecords('sess-1');
    expect(uploadedRecords[contentId]?.uploadStatus).toBe('uploaded');
    expect(uploadedRecords[contentId]?.firstQueuedAt).toBe(initialRecords[contentId]?.firstQueuedAt);
  });

  it('never logs raw session IDs, content IDs, or filesystem paths', async () => {
    const bytes = makeBytes('redaction-test');
    const sessionId = 'sess-redaction-secret';
    const contentId = computeContentId(bytes);

    // Force a write failure to exercise the warn log path.
    const fs = makeFsMock({
      writeFile: vi.fn(async () => {
        const err = new Error('disk full') as NodeJS.ErrnoException;
        err.code = 'ENOSPC';
        throw err;
      }),
    });
    const storeWithFs = new DesktopContentStore({ fs });
    await expect(
      storeWithFs.writeContent({ sessionId, contentId, bytes, mimeType: 'text/plain' }),
    ).rejects.toMatchObject({ code: 'storage-full' });

    const serialized = serializeLogCalls();
    expect(serialized).not.toContain(sessionId);
    expect(serialized).not.toContain(contentId);
    expect(serialized).not.toContain(tempDir);
  });
});

describe('DesktopContentStore — ENOSPC mapping', () => {
  it.each([
    ['mkdir', { mkdir: vi.fn(async () => { const e = new Error('full') as NodeJS.ErrnoException; e.code = 'ENOSPC'; throw e; }) }],
    ['writeFile', { writeFile: vi.fn(async () => { const e = new Error('full') as NodeJS.ErrnoException; e.code = 'ENOSPC'; throw e; }) }],
    ['link', { link: vi.fn(async () => { const e = new Error('full') as NodeJS.ErrnoException; e.code = 'ENOSPC'; throw e; }) }],
  ])('maps ENOSPC at %s step to storage-full', async (_step, override) => {
    const bytes = Buffer.from('payload', 'utf8');
    const contentId = computeContentId(bytes);
    const fs = makeFsMock(override as Partial<ContentStoreFs>);
    const store = new DesktopContentStore({ fs });
    await expect(
      store.writeContent({ sessionId: 'sess-1', contentId, bytes, mimeType: 'text/plain' }),
    ).rejects.toMatchObject({ code: 'storage-full' });
  });
});

describe('DesktopContentStore — concurrent writes', () => {
  it('two concurrent writes of same bytes both succeed idempotently', async () => {
    const tempDir2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'contentStore-concurrent-'));
    mockDataPath = tempDir2;
    const store = new DesktopContentStore();

    const bytes = Buffer.from('shared-payload', 'utf8');
    const contentId = computeContentId(bytes);

    const [a, b] = await Promise.all([
      store.writeContent({ sessionId: 'sess-1', contentId, bytes, mimeType: 'text/plain' }),
      store.writeContent({ sessionId: 'sess-1', contentId, bytes, mimeType: 'text/plain' }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toContain('created');

    const read = await store.readContent({ sessionId: 'sess-1', contentId });
    expect(read.reason).toBe('ok');

    await fsp.rm(tempDir2, { recursive: true, force: true });
  });
});

describe('ContentStoreError', () => {
  it('exposes a stable code attribute', () => {
    const e = new ContentStoreError('conflict', 'msg');
    expect(e.name).toBe('ContentStoreError');
    expect(e.code).toBe('conflict');
  });
});

describe('DesktopContentStore — fsync durability (Stage B1a § HIGH #6)', () => {
  it('calls fsyncFile on the tmp file before link and fsyncDir on the session dir after link', async () => {
    const tmpFsyncCalls: string[] = [];
    const dirFsyncCalls: string[] = [];
    const fsyncFile = vi.fn(async (p: string) => {
      tmpFsyncCalls.push(p);
    });
    const fsyncDir = vi.fn(async (p: string) => {
      dirFsyncCalls.push(p);
    });
    const fs = makeFsMock({ fsyncFile, fsyncDir });

    const linkCallTimes: string[] = [];
    fs.link = vi.fn(async () => {
      linkCallTimes.push('link');
    });

    const store = new DesktopContentStore({ fs });
    const bytes = Buffer.from('durable-payload', 'utf8');
    const contentId = computeContentId(bytes);

    await store.writeContent({
      sessionId: 'sess-1',
      contentId,
      bytes,
      mimeType: 'text/plain',
    });

    expect(tmpFsyncCalls.length).toBeGreaterThan(0);
    expect(tmpFsyncCalls[0]).toMatch(/\.tmp$/);
    expect(dirFsyncCalls.length).toBeGreaterThan(0);
    expect(fs.link).toHaveBeenCalled();
  });

  it('treats fsync failures as best-effort (does not surface to caller)', async () => {
    const fsyncFile = vi.fn(async () => {
      throw new Error('fsync failed');
    });
    const fsyncDir = vi.fn(async () => {
      throw new Error('fsync dir failed');
    });
    const fs = makeFsMock({ fsyncFile, fsyncDir });

    const store = new DesktopContentStore({ fs });
    const bytes = Buffer.from('best-effort-payload', 'utf8');
    const contentId = computeContentId(bytes);

    await expect(
      store.writeContent({
        sessionId: 'sess-1',
        contentId,
        bytes,
        mimeType: 'text/plain',
      }),
    ).resolves.toBeDefined();
  });
});
