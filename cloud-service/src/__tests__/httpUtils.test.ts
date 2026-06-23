import type http from 'node:http';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function importHttpUtils() {
  const { setPlatformConfig } = await import('@core/platform');
  setPlatformConfig({
    userDataPath: '/tmp/mindstone-rebel-tests',
    appPath: '/tmp/mindstone-rebel-tests',
    tempPath: '/tmp',
    logsPath: '/tmp/mindstone-rebel-tests/logs',
    homePath: '/tmp',
    documentsPath: '/tmp',
    desktopPath: '/tmp',
    appDataPath: '/tmp',
    version: 'test',
    isPackaged: false,
    platform: process.platform,
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    arch: process.arch,
    surface: 'cloud',
    isOss: false,
  });
  return import('../httpUtils');
}

function createMockReq(acceptEncoding?: string): http.IncomingMessage {
  return {
    headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {},
  } as http.IncomingMessage;
}

function createMockRes(initialHeaders: Record<string, string> = {}): {
  res: http.ServerResponse;
  statusCode: () => number;
  body: () => Buffer;
  headers: () => Record<string, string>;
  ended: Promise<void>;
} {
  let capturedStatus = 200;
  let capturedBody: Buffer = Buffer.alloc(0);
  let resolveEnded: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  const headerMap = new Map<string, string>(
    Object.entries(initialHeaders).map(([key, value]) => [key.toLowerCase(), value]),
  );

  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headerMap.set(name.toLowerCase(), value);
    }),
    getHeader: vi.fn((name: string) => headerMap.get(name.toLowerCase())),
    writeHead: vi.fn((status: number, headers: Record<string, string>) => {
      capturedStatus = status;
      for (const [name, value] of Object.entries(headers)) {
        headerMap.set(name.toLowerCase(), value);
      }
    }),
    end: vi.fn((body?: string | Buffer) => {
      if (typeof body === 'undefined') {
        capturedBody = Buffer.alloc(0);
        resolveEnded();
        return;
      }
      capturedBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
      resolveEnded();
    }),
  } as unknown as http.ServerResponse;

  return {
    res,
    statusCode: () => capturedStatus,
    body: () => capturedBody,
    headers: () => Object.fromEntries(headerMap.entries()),
    ended,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.doUnmock('node:zlib');
  vi.resetModules();
});

describe('sendJson compression', () => {
  it('compresses large payloads when request accepts gzip', async () => {
    const { sendJson } = await importHttpUtils();
    const payload = { text: 'x'.repeat(5000) };
    const { res, statusCode, body, headers, ended } = createMockRes({ vary: 'Origin' });
    const req = createMockReq('gzip, br');

    sendJson(res, 200, payload, req);
    await ended;

    expect(statusCode()).toBe(200);
    expect(headers()['content-encoding']).toBe('gzip');
    expect(headers()['vary']).toBe('Origin, Accept-Encoding');
    expect(Number(headers()['content-length'])).toBe(body().byteLength);

    const decoded = JSON.parse(gunzipSync(body()).toString('utf-8')) as Record<string, unknown>;
    expect(decoded).toEqual(payload);
  });

  it('sends uncompressed payload when accept-encoding is absent', async () => {
    const { sendJson } = await importHttpUtils();
    const payload = { text: 'x'.repeat(5000) };
    const { res, statusCode, body, headers, ended } = createMockRes();
    const req = createMockReq();

    sendJson(res, 200, payload, req);
    await ended;

    expect(statusCode()).toBe(200);
    expect(headers()['content-encoding']).toBeUndefined();
    expect(headers()['vary']).toBeUndefined();
    expect(Number(headers()['content-length'])).toBe(body().byteLength);
    expect(body().toString('utf-8')).toBe(JSON.stringify(payload));
  });

  it('skips compression for small payloads even when gzip is accepted', async () => {
    const { sendJson } = await importHttpUtils();
    const payload = { text: 'small payload' };
    const { res, statusCode, body, headers, ended } = createMockRes();
    const req = createMockReq('gzip');

    sendJson(res, 200, payload, req);
    await ended;

    expect(statusCode()).toBe(200);
    expect(headers()['content-encoding']).toBeUndefined();
    expect(headers()['vary']).toBeUndefined();
    expect(Number(headers()['content-length'])).toBe(body().byteLength);
    expect(body().toString('utf-8')).toBe(JSON.stringify(payload));
  });

});

describe('readBody size guards', () => {
  function buildMockBodyReq(opts: {
    chunks: Buffer[];
    contentEncoding?: 'gzip';
  }): http.IncomingMessage {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    let endFired = false;
    const req: Record<string, unknown> = {
      headers: opts.contentEncoding ? { 'content-encoding': opts.contentEncoding } : {},
      on(event: string, cb: (...args: unknown[]) => void) {
        (handlers[event] ??= []).push(cb);
        if (event === 'end' && !endFired) {
          endFired = true;
          process.nextTick(() => {
            for (const chunk of opts.chunks) {
              handlers.data?.forEach((fn) => fn(chunk));
            }
            handlers.end?.forEach((fn) => fn());
          });
        }
        return req;
      },
      removeAllListeners: () => req,
      resume: () => req,
    };
    return req as unknown as http.IncomingMessage;
  }

  it('rejects raw bodies that exceed the 100MB byte limit before decoding', async () => {
    const { readBody } = await importHttpUtils();
    // Send 101MB of raw bytes split into chunks. The size guard inside the
    // 'data' listener should fire and reject before 'end' is emitted.
    const oversizedChunk = Buffer.alloc(51 * 1024 * 1024, 0);
    const req = buildMockBodyReq({ chunks: [oversizedChunk, oversizedChunk] });

    await expect(readBody(req)).rejects.toMatchObject({
      name: 'RouteError',
      code: 'BODY_TOO_LARGE',
      status: 413,
    });
  });

  it('rejects gzipped bodies whose decompressed size exceeds the 100MB limit', async () => {
    // Compose a 101MB body of zeros — gzip compresses this to ~100KB (well under the
    // raw 100MB ingress cap), but the decompressed buffer exceeds 100MB and must be
    // rejected by the post-gunzip inflated-size guard.
    const decompressed = Buffer.alloc(101 * 1024 * 1024, 0);
    const compressed = gzipSync(decompressed);
    expect(compressed.byteLength).toBeLessThan(100 * 1024 * 1024); // sanity: passes raw guard

    const { readBody } = await importHttpUtils();
    const req = buildMockBodyReq({ chunks: [compressed], contentEncoding: 'gzip' });

    await expect(readBody(req)).rejects.toMatchObject({
      name: 'RouteError',
      code: 'BODY_TOO_LARGE',
      status: 413,
      message: expect.stringContaining('Decompressed'),
    });
  });

  it('accepts gzipped bodies whose decompressed size is within the limit', async () => {
    const payload = { hello: 'world', nested: { x: 1 } };
    const compressed = gzipSync(Buffer.from(JSON.stringify(payload)));

    const { readBody } = await importHttpUtils();
    const req = buildMockBodyReq({ chunks: [compressed], contentEncoding: 'gzip' });

    await expect(readBody(req)).resolves.toEqual(payload);
  });
});

describe('sendJson compression (continued)', () => {
  it('falls back to uncompressed payload when gzip throws', async () => {
    vi.doMock('node:zlib', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:zlib')>();
      return {
        ...actual,
        gzip: vi.fn((_: unknown, callback: (error: Error | null, result?: Buffer) => void) => {
          callback(new Error('gzip failed'));
        }),
      };
    });

    const { sendJson } = await importHttpUtils();
    const payload = { text: 'x'.repeat(5000) };
    const { res, statusCode, body, headers, ended } = createMockRes();
    const req = createMockReq('gzip');

    sendJson(res, 200, payload, req);
    await ended;

    expect(statusCode()).toBe(200);
    expect(headers()['content-encoding']).toBeUndefined();
    expect(headers()['vary']).toBeUndefined();
    expect(Number(headers()['content-length'])).toBe(body().byteLength);
    expect(body().toString('utf-8')).toBe(JSON.stringify(payload));
  });
});
