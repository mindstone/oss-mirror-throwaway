import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildContentDisposition,
  buildSharedFileMetadata,
  computeExpiresAt,
  createConversationShare,
  escapeHtml,
  fileShareKey,
  findShareByShareId,
  generateShareId,
  getMimeType,
  getShareFilePath,
  hashPassword,
  isExpired,
  isTextMime,
  isValidExpiryOption,
  isValidPassword,
  readShareLinks,
  resetRateLimitersForTests,
  resolveSharedFilePath,
  sanitizeSession,
  signFileDownloadUrl,
  stripMarkdown,
  validateFilePath,
  verifyFileDownloadSignature,
  verifyPassword,
  withShareLinksMutex,
  writeShareLinks,
  type ShareableSession,
} from '../shareLinksService';

const TEST_ROOT = path.join('/tmp', `test-share-links-service-${process.pid}`);
let testDataDir = TEST_ROOT;
let workspaceDir = path.join(TEST_ROOT, 'workspace');

const session: ShareableSession = {
  title: 'Test Conversation',
  createdAt: 1000,
  updatedAt: 2000,
  privateMode: false,
  messages: [
    { id: 'm1', role: 'user', text: 'Hello', createdAt: 1100 },
    { id: 'm2', role: 'assistant', text: 'Hidden', createdAt: 1200, isHidden: true },
    { id: 'm3', role: 'assistant', text: 'Visible', createdAt: 1300 },
  ],
};

async function resetFs(): Promise<void> {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  testDataDir = path.join(TEST_ROOT, 'data');
  workspaceDir = path.join(TEST_ROOT, 'workspace');
  process.env.REBEL_USER_DATA = testDataDir;
  await fs.mkdir(testDataDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  workspaceDir = await fs.realpath(workspaceDir);
  await fs.writeFile(path.join(workspaceDir, 'note.md'), '# Hello\n\nShared text');
  await fs.writeFile(path.join(workspaceDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
}

beforeEach(async () => {
  vi.restoreAllMocks();
  resetRateLimitersForTests();
  await resetFs();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetRateLimitersForTests();
  delete process.env.REBEL_SHARE_DOWNLOAD_SECRET;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe('shareLinksService crypto and validation helpers', () => {
  it('hashPassword and verifyPassword round-trip with salt/hash hex format', async () => {
    const stored = await hashPassword('correct horse battery staple');

    expect(stored).toMatch(/^[a-f0-9]{32}:[a-f0-9]{64}$/);
    await expect(verifyPassword('correct horse battery staple', stored)).resolves.toBe(true);
  });

  it('verifyPassword returns false for mismatches and malformed stored values', async () => {
    const stored = await hashPassword('right');

    await expect(verifyPassword('wrong', stored)).resolves.toBe(false);
    await expect(verifyPassword('right', 'not-a-valid-hash')).resolves.toBe(false);
  });

  it('generateShareId produces the existing 22-character base64url format', () => {
    const shareId = generateShareId();

    expect(shareId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('signFileDownloadUrl and verifyFileDownloadSignature round-trip byte-equivalent HMAC URLs', () => {
    const shareId = 'ABCDEFGHIJKLMNOPQRSTUV';
    const secret = 'test-secret';
    const { sig, exp } = signFileDownloadUrl(shareId, secret, 300_000);
    const expectedSig = crypto.createHmac('sha256', secret).update(`${shareId}:${exp}`).digest('hex');

    expect(sig).toBe(expectedSig);
    expect(verifyFileDownloadSignature({ shareId, sig, exp: String(exp), secret })).toBe(true);
  });

  it('verifyFileDownloadSignature rejects tampered, wrong-length, and expired signatures', () => {
    const shareId = 'ABCDEFGHIJKLMNOPQRSTUV';
    const secret = 'test-secret';
    const exp = String(Date.now() + 300_000);
    const sig = crypto.createHmac('sha256', secret).update(`${shareId}:${exp}`).digest('hex');

    expect(verifyFileDownloadSignature({ shareId, sig: 'a'.repeat(64), exp, secret })).toBe(false);
    expect(verifyFileDownloadSignature({ shareId, sig: 'abc', exp, secret })).toBe(false);
    expect(verifyFileDownloadSignature({ shareId, sig, exp: String(Date.now() - 1), secret })).toBe(false);
  });

  it('computeExpiresAt preserves existing expiry math', () => {
    const now = () => 1_000;

    expect(computeExpiresAt('never', now)).toBeUndefined();
    expect(computeExpiresAt(undefined, now)).toBeUndefined();
    expect(computeExpiresAt('24h', now)).toBe(86_401_000);
    expect(computeExpiresAt('7d', now)).toBe(604_801_000);
    expect(computeExpiresAt('30d', now)).toBe(2_592_001_000);
  });

  it('isExpired uses strict greater-than comparison', () => {
    expect(isExpired({ shareId: 's', createdAt: 1, expiresAt: 100 }, () => 100)).toBe(false);
    expect(isExpired({ shareId: 's', createdAt: 1, expiresAt: 101 }, () => 100)).toBe(false);
    expect(isExpired({ shareId: 's', createdAt: 1, expiresAt: 99 }, () => 100)).toBe(true);
  });

  it('validates password and expiry inputs', () => {
    expect(isValidPassword('x')).toBe(true);
    expect(isValidPassword('')).toBe(false);
    expect(isValidPassword('x'.repeat(129))).toBe(false);
    expect(isValidExpiryOption('24h')).toBe(true);
    expect(isValidExpiryOption('never')).toBe(true);
    expect(isValidExpiryOption('1y')).toBe(false);
  });
});

describe('shareLinksService markdown and HTML helpers', () => {
  it('stripMarkdown preserves the route parity vector', () => {
    expect(stripMarkdown('# Heading')).toBe('Heading');
    expect(stripMarkdown('> quoted\n- item\n1. numbered')).toBe('quoted item numbered');
    expect(stripMarkdown('**bold** __strong__ *em* _i_ ~gone~')).toBe('bold strong em i gone');
    expect(stripMarkdown('`inline` and ```\ncode block\n``` after')).toBe('inline and after');
    expect(stripMarkdown('<b>tag</b> ![alt](img.png) [link](https://example.com)')).toBe('tag alt link');
    expect(stripMarkdown('before\n---\nafter')).toBe('before after');
  });

  it('escapeHtml preserves the route parity vector', () => {
    expect(escapeHtml('&<gt>"\'')).toBe('&amp;&lt;gt&gt;&quot;&#39;');
  });
});

describe('shareLinksService file helpers', () => {
  it('getMimeType and isTextMime use the existing MIME table', () => {
    expect(getMimeType('README.md')).toBe('text/markdown');
    expect(getMimeType('data.JSON')).toBe('application/json');
    expect(getMimeType('photo.jpeg')).toBe('image/jpeg');
    expect(getMimeType('unknown.bin')).toBe('application/octet-stream');
    expect(isTextMime('text/markdown')).toBe(true);
    expect(isTextMime('application/json')).toBe(true);
    expect(isTextMime('image/png')).toBe(false);
  });

  it('buildContentDisposition strips control characters and uses RFC 5987 encoding', () => {
    const header = buildContentDisposition('résumé\n2026.md');

    expect(header).toContain('attachment');
    expect(header).toContain('filename="r_sum__2026.md"');
    expect(header).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9_2026.md");
  });

  it('resolveSharedFilePath returns file details for workspace files', async () => {
    const resolved = await resolveSharedFilePath('note.md', workspaceDir);

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.resolved).toBe(path.join(workspaceDir, 'note.md'));
      expect(resolved.size).toBeGreaterThan(0);
      expect(resolved.mtimeMs).toBeGreaterThan(0);
    }
  });

  it('resolveSharedFilePath rejects traversal, symlink escape, and directories', async () => {
    await fs.writeFile(path.join(TEST_ROOT, 'outside.txt'), 'secret');
    await fs.symlink(path.join(TEST_ROOT, 'outside.txt'), path.join(workspaceDir, 'outside-link.txt'));

    await expect(resolveSharedFilePath('../outside.txt', workspaceDir)).resolves.toEqual({ ok: false });
    await expect(resolveSharedFilePath('outside-link.txt', workspaceDir)).resolves.toEqual({ ok: false });
    await expect(resolveSharedFilePath('.', workspaceDir)).resolves.toEqual({ ok: false });
  });

  it('validateFilePath preserves create-time error codes', async () => {
    await fs.mkdir(path.join(workspaceDir, 'subdir'), { recursive: true });

    await expect(validateFilePath('', workspaceDir)).resolves.toEqual({ ok: false, error: 'filePath is required', code: 'INVALID_BODY', status: 400 });
    await expect(validateFilePath('../outside.txt', workspaceDir)).resolves.toEqual({ ok: false, error: 'Path traversal not allowed', code: 'INVALID_PATH', status: 400 });
    await expect(validateFilePath('missing.md', workspaceDir)).resolves.toEqual({ ok: false, error: 'File not found', code: 'FILE_NOT_FOUND', status: 404 });
    await expect(validateFilePath('subdir', workspaceDir)).resolves.toEqual({ ok: false, error: 'Path is not a regular file', code: 'INVALID_PATH', status: 400 });
  });

  it('buildSharedFileMetadata includes capped text content and omits binary content', async () => {
    const textMetadata = await buildSharedFileMetadata(
      'share-text',
      { shareId: 'share-text', createdAt: 1, resourceType: 'file', filePath: 'note.md' },
      workspaceDir,
    );
    const binaryMetadata = await buildSharedFileMetadata(
      'share-binary',
      { shareId: 'share-binary', createdAt: 1, resourceType: 'file', filePath: 'image.png' },
      workspaceDir,
    );

    expect(textMetadata?.content).toContain('Shared text');
    expect(textMetadata?.downloadUrl).toBe('/api/shared/share-text/download');
    expect(binaryMetadata?.content).toBeUndefined();
  });
});

describe('shareLinksService persistence and orchestration', () => {
  it('getShareFilePath reads REBEL_USER_DATA on every call', () => {
    process.env.REBEL_USER_DATA = path.join(TEST_ROOT, 'first');
    expect(getShareFilePath()).toBe(path.join(TEST_ROOT, 'first', 'share-links.json'));

    process.env.REBEL_USER_DATA = path.join(TEST_ROOT, 'second');
    expect(getShareFilePath()).toBe(path.join(TEST_ROOT, 'second', 'share-links.json'));
  });

  it('readShareLinks returns an empty map for missing files and round-trips writes', async () => {
    await expect(readShareLinks()).resolves.toEqual({});

    await writeShareLinks({ session: { shareId: 'ABCDEFGHIJKLMNOPQRSTUV', createdAt: 1 } });

    await expect(readShareLinks()).resolves.toEqual({
      session: { shareId: 'ABCDEFGHIJKLMNOPQRSTUV', createdAt: 1 },
    });
  });

  it('readShareLinks rejects corrupt JSON', async () => {
    await fs.writeFile(getShareFilePath(), '{{{not json');

    await expect(readShareLinks()).rejects.toThrow('share-links.json is corrupt');
  });

  it('findShareByShareId and fileShareKey preserve lookup semantics', () => {
    const map = {
      session: { shareId: 'ABCDEFGHIJKLMNOPQRSTUV', createdAt: 1 },
      [fileShareKey('note.md')]: { shareId: 'ZYXWVUTSRQPONMLKJIHGFE', createdAt: 2, resourceType: 'file' as const, filePath: 'note.md' },
    };

    expect(fileShareKey('note.md')).toBe('file:note.md');
    expect(findShareByShareId(map, 'ZYXWVUTSRQPONMLKJIHGFE')).toEqual({
      sessionId: 'file:note.md',
      entry: map['file:note.md'],
    });
    expect(findShareByShareId(map, 'missing')).toBeNull();
  });

  it('sanitizeSession filters hidden messages and strips unsafe message fields', () => {
    const sanitized = sanitizeSession(session);

    expect(sanitized).toEqual({
      title: 'Test Conversation',
      createdAt: 1000,
      updatedAt: 2000,
      messages: [
        { id: 'm1', role: 'user', text: 'Hello', createdAt: 1100 },
        { id: 'm3', role: 'assistant', text: 'Visible', createdAt: 1300 },
      ],
    });
  });

  it('withShareLinksMutex serializes concurrent critical sections', async () => {
    const order: string[] = [];

    await Promise.all([
      withShareLinksMutex(async () => {
        order.push('first:start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('first:end');
      }),
      withShareLinksMutex(async () => {
        order.push('second:start');
        order.push('second:end');
      }),
    ]);

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('createConversationShare maps write failures to write_failed', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'));

    const result = await createConversationShare(
      'session-1',
      {},
      { getSession: vi.fn(async () => session) },
    );

    expect(result).toEqual({
      ok: false,
      error: { kind: 'write_failed', message: 'Failed to create share link' },
    });
  });
});
