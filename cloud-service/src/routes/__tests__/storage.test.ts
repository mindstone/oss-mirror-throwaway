import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';

interface MockRes {
  _status: number;
  _body: string;
  _headers: Record<string, string>;
  statusCode: number;
  setHeader(key: string, value: string): void;
  getHeader(key: string): string | undefined;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

function createMockReq(headers: Record<string, string> = {}): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = 'GET';
  req.headers = { host: 'cloud.local', ...headers };
  req.url = '/api/storage/usage';
  return req;
}

function createMockRes(): http.ServerResponse & MockRes {
  const res: MockRes = {
    _status: 0,
    _body: '',
    _headers: {},
    statusCode: 0,
    setHeader(key: string, value: string) {
      this._headers[key] = value;
    },
    getHeader(key: string) {
      return this._headers[key];
    },
    writeHead(status: number, headers?: Record<string, string>) {
      this._status = status;
      this.statusCode = status;
      if (headers) Object.assign(this._headers, headers);
    },
    end(body?: string) {
      if (body) this._body = body;
    },
  };
  return res as unknown as http.ServerResponse & MockRes;
}

async function loadStorageRoute(dataDir: string) {
  vi.resetModules();
  process.env.REBEL_USER_DATA = dataDir;
  const mod = await import('../storage');
  return mod.handleStorageUsage;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('/api/storage/usage', () => {
  it('returns 200 for a valid data dir', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-storage-valid-'));
    const handleStorageUsage = await loadStorageRoute(dataDir);
    const res = createMockRes();

    await handleStorageUsage(createMockReq({ authorization: 'Bearer token' }), res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body) as {
      totalBytes: number;
      usedBytes: number;
      availableBytes: number;
      dataPath: string;
      generatedAt: number;
    };
    expect(body.totalBytes).toBeGreaterThan(0);
    expect(body.usedBytes).toBeGreaterThanOrEqual(0);
    expect(body.availableBytes).toBeGreaterThan(0);
    expect(body.dataPath).toBe(dataDir);
    expect(body.generatedAt).toBeGreaterThan(0);
  });

  it('honours bearer auth gate convention by rejecting missing bearer when a token is configured', async () => {
    vi.resetModules();
    vi.stubEnv('REBEL_CLOUD_TOKEN', 'expected-token');
    const { authorize } = await import('../../auth');

    expect(authorize(createMockReq())).toBe(false);
    expect(authorize(createMockReq({ authorization: 'Bearer expected-token' }))).toBe(true);
  });

  it('multi-state gate: empty data dir works, half-full statfs is reported, and statfs error returns 500', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-storage-multi-'));
    const handleStorageUsage = await loadStorageRoute(dataDir);

    const emptyRes = createMockRes();
    await handleStorageUsage(createMockReq(), emptyRes);
    expect(emptyRes._status).toBe(200);

    vi.spyOn(fs, 'statfsSync').mockReturnValue({
      type: 0,
      bsize: 1024,
      blocks: 100,
      bfree: 50,
      bavail: 50,
      files: 0,
      ffree: 0,
    } as fs.StatsFs);
    const halfRes = createMockRes();
    await handleStorageUsage(createMockReq(), halfRes);
    expect(JSON.parse(halfRes._body)).toMatchObject({
      totalBytes: 102400,
      usedBytes: 51200,
      availableBytes: 51200,
    });

    vi.mocked(fs.statfsSync).mockImplementation(() => {
      throw new Error('statfs boom');
    });
    const errorRes = createMockRes();
    await handleStorageUsage(createMockReq(), errorRes);
    expect(errorRes._status).toBe(500);
    expect(JSON.parse(errorRes._body).error.message).toContain('statfs boom');
  });
});
