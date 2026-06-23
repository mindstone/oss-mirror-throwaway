import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAssetStore, resetAssetStoreForTesting } from '@core/assetStore';
import { CloudAssetStore } from '../services/assetStoreCloud';
import { handleSessions } from '../routes/sessions';
import { parsePath, RouteError, sendRouteError } from '../httpUtils';

let mockDataPath = '';
vi.mock('@core/utils/dataPaths', async () => {
  const actual = await vi.importActual<typeof import('@core/utils/dataPaths')>('@core/utils/dataPaths');
  return {
    ...actual,
    getDataPath: () => mockDataPath,
  };
});

const AUTH_TOKEN = 'session-assets-integration-token';

function makePngBytes(payload = 'png-test'): Buffer {
  const pngSignature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47,
    0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  return Buffer.concat([pngSignature, Buffer.from(payload.padEnd(8, '-'), 'utf8')]);
}

function makeJpegBytes(payload = 'jpeg-test'): Buffer {
  const jpegSignature = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  return Buffer.concat([jpegSignature, Buffer.from(payload.padEnd(12, '-'), 'utf8')]);
}

function getBinary(args: {
  port: number;
  sessionId: string;
  assetId: string;
  thumb?: boolean;
  ifNoneMatch?: string;
  includeAuth?: boolean;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const { port, sessionId, assetId, thumb = false, ifNoneMatch, includeAuth = true } = args;
  const path =
    `/api/sessions/${encodeURIComponent(sessionId)}/assets/${encodeURIComponent(assetId)}`
    + (thumb ? '?thumb=1' : '');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'GET',
        host: '127.0.0.1',
        port,
        path,
        headers: {
          ...(includeAuth ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
          ...(ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function postBinary(args: {
  port: number;
  sessionId: string;
  assetId: string;
  mimeType: string;
  body: Buffer;
  contentLength?: string;
  includeAuth?: boolean;
}): Promise<{ status: number; body: string }> {
  const {
    port,
    sessionId,
    assetId,
    mimeType,
    body,
    contentLength = String(body.byteLength),
    includeAuth = true,
  } = args;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port,
        path: `/api/sessions/${encodeURIComponent(sessionId)}/assets/${encodeURIComponent(assetId)}`,
        headers: {
          ...(includeAuth ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
          'x-asset-mime-type': mimeType,
          'content-length': contentLength,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('session assets route integration', () => {
  let tmpDir: string;
  let server: http.Server;
  let port: number;
  let store: CloudAssetStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-assets-integration-'));
    mockDataPath = tmpDir;
    store = new CloudAssetStore({ baseDir: tmpDir });
    setAssetStore(store);

    const deps = {
      getSession: vi.fn(async (sessionId: string) => (sessionId === 'sess-1' ? ({ id: sessionId } as any) : null)),
    } as any;

    server = http.createServer(async (req, res) => {
      const segments = parsePath(req.url);
      if (segments[0] !== 'api' || segments[1] !== 'sessions') {
        return sendRouteError(res, undefined, new RouteError('NOT_FOUND', { status: 404, message: 'Not Found' }));
      }
      if (req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
        return sendRouteError(
          res,
          undefined,
          new RouteError('UNAUTHORIZED', { status: 401, message: 'Invalid or missing bearer token' }),
        );
      }
      try {
        await handleSessions(req, res, segments, deps);
      } catch (err) {
        if (err instanceof RouteError) {
          return sendRouteError(res, undefined, err);
        }
        return sendRouteError(
          res,
          undefined,
          new RouteError('INTERNAL_ERROR', { status: 500, message: 'An unexpected error occurred' }),
        );
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind integration test server');
    }
    port = address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetAssetStoreForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1) stores valid PNG upload and persists bytes', async () => {
    const bytes = makePngBytes('case-1');
    const response = await postBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-1',
      mimeType: 'image/png',
      body: bytes,
    });

    expect(response.status).toBe(201);
    const read = await store.readAsset({ sessionId: 'sess-1', assetId: 'asset-1' });
    expect(read.reason).toBe('ok');
    if (read.reason === 'ok') {
      expect(read.bytes.equals(bytes)).toBe(true);
    }
  });

  it('2) returns 200 on idempotent duplicate upload', async () => {
    const bytes = makePngBytes('case-2');
    await postBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-2',
      mimeType: 'image/png',
      body: bytes,
    });
    const response = await postBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-2',
      mimeType: 'image/png',
      body: bytes,
    });
    expect(response.status).toBe(200);
  });

  it('3) returns 409 when same asset id is re-uploaded with different bytes', async () => {
    await postBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-3',
      mimeType: 'image/png',
      body: makePngBytes('first'),
    });
    const response = await postBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-3',
      mimeType: 'image/png',
      body: makePngBytes('second'),
    });
    expect(response.status).toBe(409);
  });

  it('4) rejects magic-byte mismatch', async () => {
    const response = await postBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-4',
      mimeType: 'image/png',
      body: makeJpegBytes('jpeg-as-png'),
    });
    expect(response.status).toBe(400);
  });

  it('5) rejects disallowed SVG MIME', async () => {
    const response = await postBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-5',
      mimeType: 'image/svg+xml',
      body: Buffer.from('<svg></svg>'),
    });
    expect(response.status).toBe(400);
  });

  it('6) rejects oversized uploads via Content-Length preflight', async () => {
    const response = await postBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-6',
      mimeType: 'image/png',
      body: Buffer.from('x'),
      contentLength: '100000000',
    });
    expect(response.status).toBe(413);
    const pendingDir = path.join(tmpDir, 'sessions', 'sess-1.assets', '_pending');
    if (fs.existsSync(pendingDir)) {
      expect(fs.readdirSync(pendingDir)).toEqual([]);
    }
  });

  it('7) rejects invalid session id traversal payload', async () => {
    const response = await postBinary({
      port,
      sessionId: '../etc',
      assetId: 'asset-7',
      mimeType: 'image/png',
      body: makePngBytes('case-7'),
    });
    expect(response.status).toBe(400);
  });

  it('8) rejects invalid asset id traversal payload', async () => {
    const response = await postBinary({
      port,
      sessionId: 'sess-1',
      assetId: '..',
      mimeType: 'image/png',
      body: makePngBytes('case-8'),
    });
    expect(response.status).toBe(400);
  });

  it('9) requires auth at the server gate', async () => {
    const response = await postBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-9',
      mimeType: 'image/png',
      body: makePngBytes('case-9'),
      includeAuth: false,
    });
    expect(response.status).toBe(401);
  });

  it('10) returns 403 with updated session-not-found message for unknown sessions', async () => {
    const response = await postBinary({
      port,
      sessionId: 'missing-session',
      assetId: 'asset-10',
      mimeType: 'image/png',
      body: makePngBytes('case-10'),
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain('Session not found');
  });

  it('11) blocks MIME-extension bypass for same asset id', async () => {
    await postBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-11',
      mimeType: 'image/png',
      body: makePngBytes('case-11'),
    });
    const response = await postBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-11',
      mimeType: 'image/jpeg',
      body: makeJpegBytes('case-11'),
    });
    expect(response.status).toBe(409);
  });

  // Stage 7b — GET /api/sessions/:id/assets/:assetId
  it('GET 1) returns 200 with PNG bytes and asserts headers', async () => {
    const bytes = makePngBytes('get-1');
    const post = await postBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-get-1',
      mimeType: 'image/png',
      body: bytes,
    });
    expect(post.status).toBe(201);

    const response = await getBinary({ port, sessionId: 'sess-1', assetId: 'asset-get-1' });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.body.equals(bytes)).toBe(true);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['cache-control']).toContain('private');
    expect(response.headers['etag']).toBe('"asset-get-1"');
    expect(Number(response.headers['content-length'])).toBe(bytes.byteLength);
  });

  it('GET 2) ?thumb=1 falls back to full-size when no thumbnail exists', async () => {
    const bytes = makePngBytes('get-2');
    await postBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-get-2',
      mimeType: 'image/png',
      body: bytes,
    });

    const response = await getBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-get-2',
      thumb: true,
    });
    expect(response.status).toBe(200);
    expect(response.headers['etag']).toBe('"asset-get-2-thumb"');
    expect(response.body.equals(bytes)).toBe(true);
  });

  it('GET 3) returns 404 for non-existent assetId', async () => {
    const response = await getBinary({ port, sessionId: 'sess-1', assetId: 'asset-missing' });
    expect(response.status).toBe(404);
    expect(response.body.byteLength).toBe(0);
  });

  it('GET 4) returns 403 with "Session not found" for unknown sessions', async () => {
    const response = await getBinary({
      port,
      sessionId: 'missing-session',
      assetId: 'asset-get-4',
    });
    expect(response.status).toBe(403);
  });

  it('GET 5) rejects invalid sessionId path traversal payload', async () => {
    const response = await getBinary({ port, sessionId: '../etc', assetId: 'asset-get-5' });
    expect(response.status).toBe(400);
  });

  it('GET 6) requires auth at the server gate', async () => {
    const response = await getBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-get-6',
      includeAuth: false,
    });
    expect(response.status).toBe(401);
  });

  it('GET 7) honours If-None-Match with the asset ETag and returns 304', async () => {
    const bytes = makePngBytes('get-7');
    await postBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-get-7',
      mimeType: 'image/png',
      body: bytes,
    });

    const response = await getBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-get-7',
      ifNoneMatch: '"asset-get-7"',
    });
    expect(response.status).toBe(304);
    expect(response.body.byteLength).toBe(0);
    expect(response.headers['etag']).toBe('"asset-get-7"');
  });

  it('GET 8) emits nosniff and strict CSP headers on all responses', async () => {
    const bytes = makePngBytes('get-8');
    await postBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-get-8',
      mimeType: 'image/png',
      body: bytes,
    });

    const ok = await getBinary({ port, sessionId: 'sess-1', assetId: 'asset-get-8' });
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['content-security-policy']).toBe(
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline';",
    );

    const missing = await getBinary({ port, sessionId: 'sess-1', assetId: 'never-uploaded' });
    expect(missing.headers['x-content-type-options']).toBe('nosniff');
    expect(missing.headers['content-security-policy']).toBe(
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline';",
    );
  });

  it('GET 9) preserves stored Content-Type for JPEG uploads', async () => {
    const bytes = makeJpegBytes('get-9');
    await postBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-get-9',
      mimeType: 'image/jpeg',
      body: bytes,
    });

    const response = await getBinary({ port, sessionId: 'sess-1', assetId: 'asset-get-9' });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.body.equals(bytes)).toBe(true);
  });

  it('GET 10) round-trips POST→GET bytes exactly', async () => {
    const bytes = makePngBytes('roundtrip-10');
    const post = await postBinary({
      port,
      sessionId: 'sess-1',
      assetId: 'asset-roundtrip',
      mimeType: 'image/png',
      body: bytes,
    });
    expect(post.status).toBe(201);

    const get = await getBinary({ port, sessionId: 'sess-1', assetId: 'asset-roundtrip' });
    expect(get.status).toBe(200);
    expect(get.body.equals(bytes)).toBe(true);
  });
});
