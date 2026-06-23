import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-ws-pull',
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => loggerMock,
}));

import { CloudWorkspaceSync } from '../cloudWorkspaceSync';
import type { SyncClient, CloudManifest } from '../cloudWorkspaceSync';

const WORKSPACE_DIR = '/tmp/test-cloud-ws-pull/workspace';

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function createWorkspaceFile(relativePath: string, content: string): void {
  const fullPath = path.join(WORKSPACE_DIR, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
}

function makeCloudManifest(entries: CloudManifest['entries'] = {}): CloudManifest {
  return { entries, complete: true, reasons: [] };
}

function makeClient(cloudEntries: CloudManifest['entries'], fileContents: Record<string, string> = {}): SyncClient & { post: ReturnType<typeof vi.fn> } {
  const cloudManifest = makeCloudManifest(cloudEntries);
  return {
    post: vi.fn().mockImplementation((endpoint: string, body?: { path?: string }) => {
      if (endpoint === '/api/library/manifest') return Promise.resolve(cloudManifest);
      if (endpoint === '/api/library/read' && body?.path) {
        const content = fileContents[body.path];
        if (content !== undefined) return Promise.resolve({ content });
        return Promise.reject(new Error('File not found'));
      }
      return Promise.resolve({ path: 'test', updatedAt: Date.now() });
    }),
  };
}

function makeCloudServiceError(message: string, code: string, statusCode?: number): Error & { code: string; statusCode?: number } {
  const err = new Error(message) as Error & { code: string; statusCode?: number };
  err.name = 'CloudServiceError';
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function readCalls(client: { post: ReturnType<typeof vi.fn> }): unknown[][] {
  return client.post.mock.calls.filter((call) => call[0] === '/api/library/read');
}

describe('CloudWorkspaceSync — pullChangedFiles', () => {
  let sync: CloudWorkspaceSync;

  beforeEach(() => {
    sync = new CloudWorkspaceSync();
    cleanupDir('/tmp/test-cloud-ws-pull');
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    loggerMock.info.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
    loggerMock.debug.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    sync._resetForTesting();
    cleanupDir('/tmp/test-cloud-ws-pull');
  });

  it('pulls a file that cloud edited (local unchanged since push)', async () => {
    const originalContent = 'original content';
    const cloudContent = 'cloud edited content';
    const originalHash = hashContent(originalContent);
    const cloudHash = hashContent(cloudContent);

    createWorkspaceFile('notes.md', originalContent);

    // Seed lastPushedManifest to simulate prior push
    sync.load();
    sync.recordPulledFile('notes.md', {
      mtime: Math.floor(fs.statSync(path.join(WORKSPACE_DIR, 'notes.md')).mtimeMs),
      size: Buffer.byteLength(originalContent),
      hash: originalHash,
    });

    const client = makeClient(
      { 'notes.md': { hash: cloudHash, size: Buffer.byteLength(cloudContent) } },
      { 'notes.md': cloudContent },
    );

    const result = await sync.pullChangedFiles(client, WORKSPACE_DIR);

    expect(result.pulled).toBe(1);
    expect(result.conflicts).toBe(0);
    expect(result.deferredEditedCloud).toBe(0);
    expect(fs.readFileSync(path.join(WORKSPACE_DIR, 'notes.md'), 'utf8')).toBe(cloudContent);
  });

  it('detects conflict when both sides edited the same file', async () => {
    const originalContent = 'original';
    const localEdited = 'local edited';
    const cloudEdited = 'cloud edited';
    const originalHash = hashContent(originalContent);
    const cloudHash = hashContent(cloudEdited);

    // Write the locally-edited version
    createWorkspaceFile('shared.md', localEdited);

    // Seed lastPushedManifest with the ORIGINAL hash (before local edit)
    sync.load();
    sync.recordPulledFile('shared.md', {
      mtime: 1000,
      size: Buffer.byteLength(originalContent),
      hash: originalHash,
    });

    const client = makeClient(
      { 'shared.md': { hash: cloudHash, size: Buffer.byteLength(cloudEdited) } },
      { 'shared.md': cloudEdited },
    );

    const result = await sync.pullChangedFiles(client, WORKSPACE_DIR);

    expect(result.conflicts).toBe(1);
    expect(result.pulled).toBe(0);
    // Local file should be unchanged (conflict = skip)
    expect(fs.readFileSync(path.join(WORKSPACE_DIR, 'shared.md'), 'utf8')).toBe(localEdited);
    expect(fs.readFileSync(path.join(WORKSPACE_DIR, 'shared.conflict-cloud.md'), 'utf8')).toBe(cloudEdited);
  });

  it('pulls bounded batch and defers remainder when > 50 files changed', async () => {
    const originalHash = hashContent('original');
    const cloudHash = hashContent('changed');
    const cloudContent = 'changed';

    // Create 51 files to exceed MAX_PULL_FILES (50)
    sync.load();
    const cloudEntries: Record<string, { hash: string; size: number }> = {};
    const fileContents: Record<string, string> = {};
    for (let i = 0; i < 51; i++) {
      const name = `file-${String(i).padStart(3, '0')}.md`;
      createWorkspaceFile(name, 'original');
      sync.recordPulledFile(name, { mtime: 1000, size: 8, hash: originalHash });
      cloudEntries[name] = { hash: cloudHash, size: Buffer.byteLength(cloudContent) };
      fileContents[name] = cloudContent;
    }

    const client = makeClient(cloudEntries, fileContents);
    const result = await sync.pullChangedFiles(client, WORKSPACE_DIR);

    expect(result.pulled).toBe(50);
    expect(result.deferred).toBe(1);
  });

  it('deferred files are not counted as skipped', async () => {
    const originalHash = hashContent('original');
    const cloudHash = hashContent('changed');
    const cloudContent = 'changed';

    sync.load();
    const cloudEntries: Record<string, { hash: string; size: number }> = {};
    const fileContents: Record<string, string> = {};
    for (let i = 0; i < 55; i++) {
      const name = `file-${String(i).padStart(3, '0')}.md`;
      createWorkspaceFile(name, 'original');
      sync.recordPulledFile(name, { mtime: 1000, size: 8, hash: originalHash });
      cloudEntries[name] = { hash: cloudHash, size: Buffer.byteLength(cloudContent) };
      fileContents[name] = cloudContent;
    }

    const client = makeClient(cloudEntries, fileContents);
    const result = await sync.pullChangedFiles(client, WORKSPACE_DIR);

    expect(result.pulled).toBe(50);
    expect(result.deferred).toBe(5);
    expect(result.skipped).toBe(0);
  });

  it('pulls alphabetically first batch for deterministic ordering', async () => {
    const originalHash = hashContent('original');
    const cloudHash = hashContent('changed');
    const cloudContent = 'changed';

    sync.load();
    const cloudEntries: Record<string, { hash: string; size: number }> = {};
    const fileContents: Record<string, string> = {};
    // Create 51 files with names that sort: aaa.md, bbb.md, ..., zzz.md, etc.
    const names = Array.from({ length: 51 }, (_, i) => `${String(i).padStart(3, '0')}-file.md`);
    for (const name of names) {
      createWorkspaceFile(name, 'original');
      sync.recordPulledFile(name, { mtime: 1000, size: 8, hash: originalHash });
      cloudEntries[name] = { hash: cloudHash, size: Buffer.byteLength(cloudContent) };
      fileContents[name] = cloudContent;
    }

    const client = makeClient(cloudEntries, fileContents);
    await sync.pullChangedFiles(client, WORKSPACE_DIR);

    // The last file (050-file.md) should NOT have been pulled (deferred)
    const lastFile = path.join(WORKSPACE_DIR, '050-file.md');
    expect(fs.readFileSync(lastFile, 'utf8')).toBe('original');
    // The 50th file (049-file.md) SHOULD have been pulled
    const fiftiethFile = path.join(WORKSPACE_DIR, '049-file.md');
    expect(fs.readFileSync(fiftiethFile, 'utf8')).toBe(cloudContent);
  });

  it('second pull cycle picks up remaining deferred files', async () => {
    const originalHash = hashContent('original');
    const cloudHash = hashContent('changed');
    const cloudContent = 'changed';

    sync.load();
    const cloudEntries: Record<string, { hash: string; size: number }> = {};
    const fileContents: Record<string, string> = {};
    for (let i = 0; i < 52; i++) {
      const name = `file-${String(i).padStart(3, '0')}.md`;
      createWorkspaceFile(name, 'original');
      sync.recordPulledFile(name, { mtime: 1000, size: 8, hash: originalHash });
      cloudEntries[name] = { hash: cloudHash, size: Buffer.byteLength(cloudContent) };
      fileContents[name] = cloudContent;
    }

    const client = makeClient(cloudEntries, fileContents);

    // First cycle: pulls 50, defers 2
    const result1 = await sync.pullChangedFiles(client, WORKSPACE_DIR);
    expect(result1.pulled).toBe(50);
    expect(result1.deferred).toBe(2);

    // Second cycle: the 50 already-pulled files now match cloud hash,
    // so only the 2 deferred remain as candidates
    const result2 = await sync.pullChangedFiles(client, WORKSPACE_DIR);
    expect(result2.pulled).toBe(2);
    expect(result2.deferred).toBe(0);
  });

  it('skips binary files (non-text extensions)', async () => {
    const cloudHash = hashContent('binary data');

    sync.load();
    sync.recordPulledFile('image.png', { mtime: 1000, size: 100, hash: 'oldhash123456789' });

    const client = makeClient(
      { 'image.png': { hash: cloudHash, size: 100 } },
      { 'image.png': 'binary data' },
    );

    const result = await sync.pullChangedFiles(client, WORKSPACE_DIR);

    expect(result.pulled).toBe(0);
  });

  it('skips files that exceed size limit', async () => {
    const cloudHash = hashContent('big');

    sync.load();
    sync.recordPulledFile('big.md', { mtime: 1000, size: 100, hash: 'oldhash123456789' });

    const client = makeClient(
      { 'big.md': { hash: cloudHash, size: 8 * 1024 * 1024 } }, // 8MB > 7MB limit
      {},
    );

    const result = await sync.pullChangedFiles(client, WORKSPACE_DIR);

    expect(result.pulled).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('pulls new cloud files not in local manifest', async () => {
    const cloudContent = 'new file from cloud';
    const cloudHash = hashContent(cloudContent);

    const client = makeClient(
      { 'cloud-new.md': { hash: cloudHash, size: Buffer.byteLength(cloudContent) } },
      { 'cloud-new.md': cloudContent },
    );

    const result = await sync.pullChangedFiles(client, WORKSPACE_DIR);

    expect(result.pulled).toBe(1);
    expect(result.newFiles).toBe(1);
    expect(fs.readFileSync(path.join(WORKSPACE_DIR, 'cloud-new.md'), 'utf8')).toBe(cloudContent);
  });

  it('skips new cloud file if it already exists locally (prevents overwrite)', async () => {
    const localContent = 'local version';
    const cloudContent = 'cloud version';
    const cloudHash = hashContent(cloudContent);

    // File exists locally but was never pushed (not in lastPushedManifest)
    createWorkspaceFile('local-only.md', localContent);

    const client = makeClient(
      { 'local-only.md': { hash: cloudHash, size: Buffer.byteLength(cloudContent) } },
      { 'local-only.md': cloudContent },
    );

    const result = await sync.pullChangedFiles(client, WORKSPACE_DIR);

    expect(result.pulled).toBe(0);
    expect(result.skipped).toBe(1);
    // Local file should be unchanged
    expect(fs.readFileSync(path.join(WORKSPACE_DIR, 'local-only.md'), 'utf8')).toBe(localContent);
  });

  it('is a no-op when cloud manifest is empty', async () => {
    const client = makeClient({});
    const result = await sync.pullChangedFiles(client, WORKSPACE_DIR);

    expect(result).toEqual({
      pulled: 0,
      skipped: 0,
      conflicts: 0,
      conflictPaths: [],
      newFiles: 0,
      deferred: 0,
      deferredDriveSettle: 0,
      forcedAfterSettle: 0,
      deferredEditedCloud: 0,
    });
  });

  it('handles manifest fetch failure gracefully', async () => {
    const client = {
      post: vi.fn().mockRejectedValue(new Error('network error')),
    };

    const result = await sync.pullChangedFiles(client, WORKSPACE_DIR);

    expect(result).toEqual({
      pulled: 0,
      skipped: 0,
      conflicts: 0,
      conflictPaths: [],
      newFiles: 0,
      deferred: 0,
      deferredDriveSettle: 0,
      forcedAfterSettle: 0,
      deferredEditedCloud: 0,
    });
  });

  it('updates manifest after pulling so file is not re-uploaded', async () => {
    const cloudContent = 'cloud content';
    const cloudHash = hashContent(cloudContent);

    const client = makeClient(
      { 'synced.md': { hash: cloudHash, size: Buffer.byteLength(cloudContent) } },
      { 'synced.md': cloudContent },
    );

    await sync.pullChangedFiles(client, WORKSPACE_DIR);

    const manifest = sync._getLastPushedManifest();
    expect(manifest.has('synced.md')).toBe(true);
    expect(manifest.get('synced.md')!.hash).toBe(cloudHash);
  });

  it('creates subdirectories for new cloud files', async () => {
    const cloudContent = 'nested file';
    const cloudHash = hashContent(cloudContent);

    const client = makeClient(
      { 'sub/dir/deep.md': { hash: cloudHash, size: Buffer.byteLength(cloudContent) } },
      { 'sub/dir/deep.md': cloudContent },
    );

    const result = await sync.pullChangedFiles(client, WORKSPACE_DIR);

    expect(result.pulled).toBe(1);
    expect(fs.readFileSync(path.join(WORKSPACE_DIR, 'sub', 'dir', 'deep.md'), 'utf8')).toBe(cloudContent);
  });

  it('skips files already in sync (same hash)', async () => {
    const content = 'same content';
    const hash = hashContent(content);

    createWorkspaceFile('same.md', content);
    sync.load();
    sync.recordPulledFile('same.md', {
      mtime: Math.floor(fs.statSync(path.join(WORKSPACE_DIR, 'same.md')).mtimeMs),
      size: Buffer.byteLength(content),
      hash,
    });

    const client = makeClient(
      { 'same.md': { hash, size: Buffer.byteLength(content) } },
      {},
    );

    const result = await sync.pullChangedFiles(client, WORKSPACE_DIR);

    expect(result.pulled).toBe(0);
    expect(result.conflicts).toBe(0);
  });

  it('memoizes a transient pull failure, suppresses until expiry, then retries and succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T00:00:00.000Z'));

    const relativePath = 'retry/me.md';
    const cloudContent = 'eventually available';
    const cloudHash = hashContent(cloudContent);
    const client = makeClient(
      { [relativePath]: { hash: cloudHash, size: Buffer.byteLength(cloudContent) } },
      {},
    );

    const first = await sync.pullChangedFiles(client, WORKSPACE_DIR);
    expect(first.pulled).toBe(0);
    expect(first.skipped).toBe(1);
    expect(readCalls(client)).toHaveLength(1);

    const suppressed = await sync.pullChangedFiles(client, WORKSPACE_DIR);
    expect(suppressed.pulled).toBe(0);
    expect(readCalls(client)).toHaveLength(1);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ failingFiles: 1, suppressed: 1 }),
      'Workspace pull failure memo summary',
    );

    client.post.mockImplementation((endpoint: string, body?: { path?: string }) => {
      if (endpoint === '/api/library/manifest') {
        return Promise.resolve(makeCloudManifest({ [relativePath]: { hash: cloudHash, size: Buffer.byteLength(cloudContent) } }));
      }
      if (endpoint === '/api/library/read' && body?.path === relativePath) {
        return Promise.resolve({ content: cloudContent });
      }
      return Promise.resolve({});
    });

    vi.setSystemTime(new Date('2026-06-11T00:05:00.001Z'));
    const retried = await sync.pullChangedFiles(client, WORKSPACE_DIR);
    expect(retried.pulled).toBe(1);
    expect(readCalls(client)).toHaveLength(2);
    expect(fs.readFileSync(path.join(WORKSPACE_DIR, relativePath), 'utf8')).toBe(cloudContent);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ path: relativePath, cloudHash }),
      'Workspace pull failure memo expired; retrying file',
    );
  });

  it('invalidates a pull-failure memo when the cloud hash changes', async () => {
    const relativePath = 'changed-hash.md';
    const firstHash = hashContent('v1');
    const secondContent = 'v2';
    const secondHash = hashContent(secondContent);
    const client = makeClient(
      { [relativePath]: { hash: firstHash, size: 2 } },
      {},
    );

    await sync.pullChangedFiles(client, WORKSPACE_DIR);
    expect(readCalls(client)).toHaveLength(1);

    client.post.mockImplementation((endpoint: string, body?: { path?: string }) => {
      if (endpoint === '/api/library/manifest') {
        return Promise.resolve(makeCloudManifest({ [relativePath]: { hash: secondHash, size: Buffer.byteLength(secondContent) } }));
      }
      if (endpoint === '/api/library/read' && body?.path === relativePath) {
        return Promise.resolve({ content: secondContent });
      }
      return Promise.resolve({});
    });

    const result = await sync.pullChangedFiles(client, WORKSPACE_DIR);
    expect(result.pulled).toBe(1);
    expect(readCalls(client)).toHaveLength(2);
    expect(fs.readFileSync(path.join(WORKSPACE_DIR, relativePath), 'utf8')).toBe(secondContent);
  });

  it('invalidates a new-file pull-failure memo when the file appears locally', async () => {
    const relativePath = 'drive-delivered.md';
    const cloudContent = 'cloud copy';
    const cloudHash = hashContent(cloudContent);
    const client = makeClient(
      { [relativePath]: { hash: cloudHash, size: Buffer.byteLength(cloudContent) } },
      {},
    );

    await sync.pullChangedFiles(client, WORKSPACE_DIR);
    expect(readCalls(client)).toHaveLength(1);

    createWorkspaceFile(relativePath, 'delivered locally');
    const delivered = await sync.pullChangedFiles(client, WORKSPACE_DIR);
    expect(delivered.pulled).toBe(0);
    expect(delivered.skipped).toBe(1);
    expect(readCalls(client)).toHaveLength(1);

    fs.rmSync(path.join(WORKSPACE_DIR, relativePath));
    client.post.mockImplementation((endpoint: string, body?: { path?: string }) => {
      if (endpoint === '/api/library/manifest') {
        return Promise.resolve(makeCloudManifest({ [relativePath]: { hash: cloudHash, size: Buffer.byteLength(cloudContent) } }));
      }
      if (endpoint === '/api/library/read' && body?.path === relativePath) {
        return Promise.resolve({ content: cloudContent });
      }
      return Promise.resolve({});
    });

    const retried = await sync.pullChangedFiles(client, WORKSPACE_DIR);
    expect(retried.pulled).toBe(1);
    expect(readCalls(client)).toHaveLength(2);
  });

  it('forceSync clears pull-failure memos and retries immediately', async () => {
    const relativePath = 'manual-retry.md';
    const cloudContent = 'manual retry';
    const cloudHash = hashContent(cloudContent);
    const client = makeClient(
      { [relativePath]: { hash: cloudHash, size: Buffer.byteLength(cloudContent) } },
      {},
    );

    await sync.pullChangedFiles(client, WORKSPACE_DIR);
    await sync.pullChangedFiles(client, WORKSPACE_DIR);
    expect(readCalls(client)).toHaveLength(1);

    client.post.mockImplementation((endpoint: string, body?: { path?: string }) => {
      if (endpoint === '/api/library/manifest') {
        return Promise.resolve(makeCloudManifest({ [relativePath]: { hash: cloudHash, size: Buffer.byteLength(cloudContent) } }));
      }
      if (endpoint === '/api/library/read' && body?.path === relativePath) {
        return Promise.resolve({ content: cloudContent });
      }
      return Promise.resolve({});
    });

    await sync.forceSync(client, WORKSPACE_DIR);
    expect(readCalls(client)).toHaveLength(2);
    expect(fs.readFileSync(path.join(WORKSPACE_DIR, relativePath), 'utf8')).toBe(cloudContent);
  });

  it('keeps memoized failures out of the MAX_PULL_FILES slice', async () => {
    const failingPath = 'file-000.md';
    const failingHash = hashContent('failing');
    const firstClient = makeClient(
      { [failingPath]: { hash: failingHash, size: 7 } },
      {},
    );
    await sync.pullChangedFiles(firstClient, WORKSPACE_DIR);

    const cloudEntries: Record<string, { hash: string; size: number }> = {
      [failingPath]: { hash: failingHash, size: 7 },
    };
    const fileContents: Record<string, string> = {};
    for (let i = 1; i <= 50; i += 1) {
      const name = `file-${String(i).padStart(3, '0')}.md`;
      const content = `content ${i}`;
      cloudEntries[name] = { hash: hashContent(content), size: Buffer.byteLength(content) };
      fileContents[name] = content;
    }

    const client = makeClient(cloudEntries, fileContents);
    const result = await sync.pullChangedFiles(client, WORKSPACE_DIR);
    expect(result.pulled).toBe(50);
    expect(result.deferred).toBe(0);
    expect(readCalls(client)).toHaveLength(50);
  });

  it('preflights an invalid parent before cloud read and records one terminal warn', async () => {
    const relativePath = 'blocked/child.md';
    fs.writeFileSync(path.join(WORKSPACE_DIR, 'blocked'), 'not a directory', 'utf8');
    const cloudHash = hashContent('child');
    const client = makeClient(
      { [relativePath]: { hash: cloudHash, size: 5 } },
      { [relativePath]: 'child' },
    );

    const first = await sync.pullChangedFiles(client, WORKSPACE_DIR);
    const second = await sync.pullChangedFiles(client, WORKSPACE_DIR);

    expect(first.pulled).toBe(0);
    expect(second.pulled).toBe(0);
    expect(readCalls(client)).toHaveLength(0);
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: relativePath, cause: 'parent_not_directory' }),
      'Workspace pull: terminal file failure memoized',
    );
  });

  it.runIf(process.platform !== 'win32')('classifies a dangling symlink parent as terminal before cloud read', async () => {
    const relativePath = 'memory/teams/Product Marketing/fact.md';
    fs.mkdirSync(path.join(WORKSPACE_DIR, 'memory', 'teams'), { recursive: true });
    fs.symlinkSync(path.join(WORKSPACE_DIR, 'missing-target'), path.join(WORKSPACE_DIR, 'memory', 'teams', 'Product Marketing'), 'dir');
    const cloudHash = hashContent('fact');
    const client = makeClient(
      { [relativePath]: { hash: cloudHash, size: 4 } },
      { [relativePath]: 'fact' },
    );

    const result = await sync.pullChangedFiles(client, WORKSPACE_DIR);

    expect(result.pulled).toBe(0);
    expect(readCalls(client)).toHaveLength(0);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: relativePath, cause: 'dangling_symlink_parent' }),
      'Workspace pull: terminal file failure memoized',
    );
  });

  it('escalates identical transient failures to max backoff after the third failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T01:00:00.000Z'));

    const relativePath = 'flaky.md';
    const cloudHash = hashContent('flaky');
    const client = makeClient(
      { [relativePath]: { hash: cloudHash, size: 5 } },
      {},
    );

    await sync.pullChangedFiles(client, WORKSPACE_DIR);
    vi.setSystemTime(new Date('2026-06-11T01:05:00.001Z'));
    await sync.pullChangedFiles(client, WORKSPACE_DIR);
    vi.setSystemTime(new Date('2026-06-11T01:15:00.002Z'));
    await sync.pullChangedFiles(client, WORKSPACE_DIR);

    expect(readCalls(client)).toHaveLength(3);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        path: relativePath,
        classification: 'transient',
        consecutiveFailures: 3,
        backoffMs: 6 * 60 * 60 * 1000,
      }),
      'Workspace pull failure memo recorded',
    );

    vi.setSystemTime(new Date('2026-06-11T02:00:00.000Z'));
    await sync.pullChangedFiles(client, WORKSPACE_DIR);
    expect(readCalls(client)).toHaveLength(3);
  });

  it('aborts remaining pull probes when the cloud host is unreachable', async () => {
    const cloudEntries: Record<string, { hash: string; size: number }> = {};
    for (const name of ['a.md', 'b.md', 'c.md']) {
      cloudEntries[name] = { hash: hashContent(name), size: Buffer.byteLength(name) };
    }
    const client = makeClient(cloudEntries, {});
    client.post.mockImplementation((endpoint: string) => {
      if (endpoint === '/api/library/manifest') {
        return Promise.resolve(makeCloudManifest(cloudEntries));
      }
      if (endpoint === '/api/library/read') {
        return Promise.reject(makeCloudServiceError('offline', 'CLOUD_UNREACHABLE'));
      }
      return Promise.resolve({});
    });

    const result = await sync.pullChangedFiles(client, WORKSPACE_DIR);

    expect(result.pulled).toBe(0);
    expect(result.skipped).toBe(3);
    expect(readCalls(client)).toHaveLength(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'CLOUD_UNREACHABLE', total: 3 }),
      'Workspace pull: cloud host unreachable, aborting remainder of batch',
    );
  });
});
