import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveProviderBasePath } from '@shared/authRelayConfig';

const authorizeMock = vi.fn(() => true);
const getBearerTokenHashMock = vi.fn(() => 'bearer-hash');
const onPeerTombstoneMock = vi.fn(async () => {});

vi.mock('../auth', () => ({
  authorize: authorizeMock,
  getBearerTokenHash: getBearerTokenHashMock,
}));

vi.mock('@core/setTokenSyncCoordinator', () => ({
  getTokenSyncCoordinator: () => ({
    ensureFreshish: vi.fn(async () => ({ ok: true, source: 'peer' })),
    onPeerSignal: vi.fn(async () => {}),
    onPeerTombstone: onPeerTombstoneMock,
  }),
}));

type MockResShape = {
  _status: number;
  _body: unknown;
  _headers: Record<string, string | number>;
};

function createMockRes(): http.ServerResponse & { _status: number; _body: unknown } {
  return {
    _status: 0,
    _body: null as unknown,
    _headers: {} as Record<string, string | number>,
    writeHead(this: MockResShape, status: number, headers?: Record<string, string | number>) {
      this._status = status;
      if (headers) Object.assign(this._headers, headers);
      return this;
    },
    end(this: MockResShape, data?: string | Buffer) {
      const str = typeof data === 'string' ? data : data ? data.toString('utf8') : undefined;
      if (str) {
        try {
          this._body = JSON.parse(str);
        } catch {
          this._body = str;
        }
      }
      return this;
    },
    setHeader() { return this; },
    getHeader() { return undefined; },
  } as unknown as http.ServerResponse & { _status: number; _body: unknown };
}

function createMockReq(args: {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}): http.IncomingMessage {
  const req = new http.IncomingMessage(null as never);
  req.method = args.method;
  req.url = args.url;
  req.headers = {
    authorization: 'Bearer test-token',
    ...args.headers,
  };
  if (args.body === undefined) {
    req.push(null);
    return req;
  }
  req.push(JSON.stringify(args.body));
  req.push(null);
  return req;
}

async function loadHandler(dataPath: string): Promise<typeof import('../routes/authRelayPull').handleAuthRelayPull> {
  process.env.REBEL_USER_DATA = dataPath;
  vi.resetModules();
  return (await import('../routes/authRelayPull')).handleAuthRelayPull;
}

async function seedGoogleTokenFile(dataPath: string, fileName = 'google.token.json'): Promise<{
  accountKey: string;
  relativePath: string;
  absolutePath: string;
  content: string;
}> {
  const providerRoot = resolveProviderBasePath('google-workspace', dataPath, os.homedir());
  const accountKey = 'user@example.com';
  const relativePath = `${accountKey}/credentials/${fileName}`;
  const absolutePath = path.join(providerRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const content = JSON.stringify({
    expiryEpochMs: Date.now() + 60_000,
    surfaceWrote: 'cloud',
    accessToken: 'masked',
  });
  await fs.writeFile(absolutePath, content, 'utf8');
  return { accountKey, relativePath, absolutePath, content };
}

let tempDir: string | null = null;

describe('auth relay pull route', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-relay-pull-test-'));
    authorizeMock.mockReturnValue(true);
    getBearerTokenHashMock.mockReturnValue('bearer-hash');
    onPeerTombstoneMock.mockClear();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('returns metadata for an authenticated request by account key', async () => {
    const dataPath = tempDir!;
    const { accountKey, relativePath } = await seedGoogleTokenFile(dataPath);
    const handleAuthRelayPull = await loadHandler(dataPath);
    const req = createMockReq({
      method: 'GET',
      url: `/api/auth/relay/google/${encodeURIComponent(accountKey)}/metadata`,
    });
    const res = createMockRes();

    await handleAuthRelayPull(req, res);

    expect(res._status).toBe(200);
    const body = res._body as { relativePath?: string; expiryEpochMs?: number; mtimeMs?: number };
    expect(body.relativePath).toBe(relativePath);
    expect(typeof body.expiryEpochMs).toBe('number');
    expect(typeof body.mtimeMs).toBe('number');
  });

  it('returns token content for an authenticated request by relative path', async () => {
    const dataPath = tempDir!;
    const { relativePath, content } = await seedGoogleTokenFile(dataPath);
    const handleAuthRelayPull = await loadHandler(dataPath);
    const req = createMockReq({
      method: 'GET',
      url: `/api/auth/relay/google/${encodeURIComponent(relativePath)}`,
    });
    const res = createMockRes();

    await handleAuthRelayPull(req, res);

    expect(res._status).toBe(200);
    const body = res._body as { content?: string; relativePath?: string };
    expect(body.relativePath).toBe(relativePath);
    expect(body.content).toBe(Buffer.from(content, 'utf8').toString('base64'));
  });

  it('handles DELETE tombstone requests and notifies the coordinator', async () => {
    const dataPath = tempDir!;
    const { accountKey, relativePath } = await seedGoogleTokenFile(dataPath);
    const handleAuthRelayPull = await loadHandler(dataPath);
    const req = createMockReq({
      method: 'DELETE',
      url: `/api/auth/relay/google/${encodeURIComponent(relativePath)}`,
      body: { tombstoneEpochMs: 1234567890 },
    });
    const res = createMockRes();

    await handleAuthRelayPull(req, res);

    expect(res._status).toBe(200);
    expect(onPeerTombstoneMock).toHaveBeenCalledWith({
      provider: 'google',
      accountKey,
      relativePath,
      tombstoneEpochMs: 1234567890,
    });
  });

  it('rejects double-encoded paths', async () => {
    const dataPath = tempDir!;
    const { relativePath } = await seedGoogleTokenFile(dataPath);
    const handleAuthRelayPull = await loadHandler(dataPath);
    const doubleEncodedPath = encodeURIComponent(encodeURIComponent(relativePath));
    const req = createMockReq({
      method: 'GET',
      url: `/api/auth/relay/google/${doubleEncodedPath}`,
    });
    const res = createMockRes();

    await handleAuthRelayPull(req, res);

    expect(res._status).toBe(400);
    const body = res._body as { error?: { code?: string } };
    expect(body.error?.code).toBe('INVALID_BODY');
  });

  it('rejects non-json files', async () => {
    const dataPath = tempDir!;
    const providerRoot = resolveProviderBasePath('google-workspace', dataPath, os.homedir());
    const relativePath = 'user@example.com/credentials/not-token.txt';
    const absolutePath = path.join(providerRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, 'hello', 'utf8');
    const handleAuthRelayPull = await loadHandler(dataPath);
    const req = createMockReq({
      method: 'GET',
      url: `/api/auth/relay/google/${encodeURIComponent(relativePath)}`,
    });
    const res = createMockRes();

    await handleAuthRelayPull(req, res);

    expect(res._status).toBe(403);
    const body = res._body as { error?: { code?: string } };
    expect(body.error?.code).toBe('INVALID_BODY');
  });

  it('rejects symlink paths', async () => {
    const dataPath = tempDir!;
    const providerRoot = resolveProviderBasePath('google-workspace', dataPath, os.homedir());
    const outsidePath = path.join(dataPath, 'outside.token.json');
    await fs.writeFile(outsidePath, JSON.stringify({ expiryEpochMs: Date.now() + 1_000 }), 'utf8');
    const relativePath = 'user@example.com/credentials/symlink.token.json';
    const symlinkPath = path.join(providerRoot, relativePath);
    await fs.mkdir(path.dirname(symlinkPath), { recursive: true });
    await fs.symlink(outsidePath, symlinkPath);
    const handleAuthRelayPull = await loadHandler(dataPath);
    const req = createMockReq({
      method: 'GET',
      url: `/api/auth/relay/google/${encodeURIComponent(relativePath)}`,
    });
    const res = createMockRes();

    await handleAuthRelayPull(req, res);

    expect(res._status).toBe(403);
    const body = res._body as { error?: { code?: string } };
    expect(body.error?.code).toBe('INVALID_BODY');
  });

  it('rejects unauthorized requests', async () => {
    const dataPath = tempDir!;
    await seedGoogleTokenFile(dataPath);
    authorizeMock.mockReturnValue(false);
    const handleAuthRelayPull = await loadHandler(dataPath);
    const req = createMockReq({
      method: 'GET',
      url: '/api/auth/relay/google/user%40example.com/metadata',
    });
    const res = createMockRes();

    await handleAuthRelayPull(req, res);

    expect(res._status).toBe(401);
  });

  it('enforces per-bearer rate limiting', async () => {
    const dataPath = tempDir!;
    const { accountKey } = await seedGoogleTokenFile(dataPath);
    getBearerTokenHashMock.mockReturnValue('rate-limit-bearer');
    const handleAuthRelayPull = await loadHandler(dataPath);
    const url = `/api/auth/relay/google/${encodeURIComponent(accountKey)}/metadata`;

    for (let i = 0; i < 60; i += 1) {
      const res = createMockRes();
      await handleAuthRelayPull(createMockReq({ method: 'GET', url }), res);
      expect(res._status).toBe(200);
    }

    const throttledRes = createMockRes();
    await handleAuthRelayPull(createMockReq({ method: 'GET', url }), throttledRes);
    expect(throttledRes._status).toBe(429);
    const body = throttledRes._body as { error?: { code?: string } };
    expect(body.error?.code).toBe('RATE_LIMITED');
  });
});
