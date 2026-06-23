import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSessions } from '../routes/sessions';
import { getAssetStore } from '@core/assetStore';

let mockDataPath = '';
vi.mock('@core/utils/dataPaths', async () => {
  const actual = await vi.importActual<typeof import('@core/utils/dataPaths')>('@core/utils/dataPaths');
  return {
    ...actual,
    getDataPath: () => mockDataPath,
  };
});

vi.mock('@core/assetStore', () => ({
  getAssetStore: vi.fn(),
}));

vi.mock('../httpUtils', () => ({
  sendJson: vi.fn(),
  sendRouteError: vi.fn(),
  RouteError: class extends Error {
    details: any;
    constructor(code: string, details: any) { super(code); this.details = details; }
  },
  getHeaderValue: vi.fn((req, name) => req.headers[name])
}));

describe('POST /api/sessions/:id/assets/:assetId', () => {
  let deps: any;
  let res: any;
  let mockAssetStore: any;
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-assets-route-'));
    mockDataPath = tmpDir;
    deps = {
      getSession: vi.fn().mockResolvedValue({ id: 'sess-1' }),
    };
    res = { statusCode: 200, end: vi.fn(), setHeader: vi.fn() };
    mockAssetStore = {
      writeAssetFromTempFile: vi.fn().mockResolvedValue({
        ref: { assetId: 'asset-1', mimeType: 'image/png', byteSize: 4 },
        status: 'created',
      }),
    };
    vi.mocked(getAssetStore).mockReturnValue(mockAssetStore);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createMockReq(chunks: Buffer[], headers: Record<string, string>) {
    const req = new EventEmitter() as any;
    req.method = 'POST';
    req.headers = headers;
    req.destroy = vi.fn();
    req[Symbol.asyncIterator] = async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    };
    return req;
  }

  it('rejects invalid session id format before session lookup', async () => {
    const req = createMockReq(
      [Buffer.from('test')],
      { 'x-asset-mime-type': 'image/png', 'content-length': '4' },
    );

    const { sendRouteError } = await import('../httpUtils');
    await handleSessions(req, res, ['api', 'sessions', '../etc', 'assets', 'asset-1'], deps);

    expect(deps.getSession).not.toHaveBeenCalled();
    expect(sendRouteError).toHaveBeenCalled();
    const call = vi.mocked(sendRouteError).mock.calls[0];
    expect((call[2] as any).details.status).toBe(400);
  });

  it('rejects if session does not exist', async () => {
    deps.getSession.mockResolvedValue(null);
    const req = createMockReq(
      [Buffer.from('test')],
      { 'x-asset-mime-type': 'image/png', 'content-length': '4' },
    );

    const { sendRouteError } = await import('../httpUtils');
    await handleSessions(req, res, ['api', 'sessions', 'sess-1', 'assets', 'asset-1'], deps);

    expect(sendRouteError).toHaveBeenCalled();
    const call = vi.mocked(sendRouteError).mock.calls[0];
    expect((call[2] as any).details.status).toBe(403);
    expect((call[2] as any).details.message).toBe('Session not found');
  });

  it('rejects missing content-length', async () => {
    const req = createMockReq([Buffer.from('test')], { 'x-asset-mime-type': 'image/png' });

    const { sendRouteError } = await import('../httpUtils');
    await handleSessions(req, res, ['api', 'sessions', 'sess-1', 'assets', 'asset-1'], deps);

    expect(sendRouteError).toHaveBeenCalled();
    const call = vi.mocked(sendRouteError).mock.calls[0];
    expect((call[2] as any).details.status).toBe(411);
  });

  it('rejects invalid content-length', async () => {
    const req = createMockReq(
      [Buffer.from('test')],
      { 'x-asset-mime-type': 'image/png', 'content-length': '4x' },
    );

    const { sendRouteError } = await import('../httpUtils');
    await handleSessions(req, res, ['api', 'sessions', 'sess-1', 'assets', 'asset-1'], deps);

    expect(sendRouteError).toHaveBeenCalled();
    const call = vi.mocked(sendRouteError).mock.calls[0];
    expect((call[2] as any).details.status).toBe(400);
  });

  it('cleans temp files when body length does not match content-length', async () => {
    const req = createMockReq(
      [Buffer.from('tiny')],
      { 'x-asset-mime-type': 'image/png', 'content-length': '8' },
    );

    const { sendRouteError } = await import('../httpUtils');
    await handleSessions(req, res, ['api', 'sessions', 'sess-1', 'assets', 'asset-1'], deps);

    expect(sendRouteError).toHaveBeenCalled();
    const call = vi.mocked(sendRouteError).mock.calls[0];
    expect((call[2] as any).details.status).toBe(400);
    const pendingDir = path.join(tmpDir, 'sessions', 'sess-1.assets', '_pending');
    if (fs.existsSync(pendingDir)) {
      expect(fs.readdirSync(pendingDir)).toEqual([]);
    }
  });

  it('rejects payload exceeding 50MB via content-length preflight', async () => {
    const req = createMockReq([], {
      'x-asset-mime-type': 'image/png',
      'content-length': '100000000',
    });

    const { sendRouteError } = await import('../httpUtils');
    await handleSessions(req, res, ['api', 'sessions', 'sess-1', 'assets', 'asset-1'], deps);

    expect(sendRouteError).toHaveBeenCalled();
    const call = vi.mocked(sendRouteError).mock.calls[0];
    expect((call[2] as any).details.status).toBe(413);
    expect(mockAssetStore.writeAssetFromTempFile).not.toHaveBeenCalled();
  });

  it('writes asset via temp file path and returns 201 on create', async () => {
    const req = createMockReq(
      [Buffer.from('test')],
      { 'x-asset-mime-type': 'image/png', 'content-length': '4' },
    );

    const { sendJson } = await import('../httpUtils');
    await handleSessions(req, res, ['api', 'sessions', 'sess-1', 'assets', 'asset-1'], deps);

    expect(mockAssetStore.writeAssetFromTempFile).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        assetId: 'asset-1',
        mimeType: 'image/png',
      }),
    );
    expect(sendJson).toHaveBeenCalledWith(res, 201, { success: true }, req);
  });

  it('returns 200 for idempotent duplicate uploads', async () => {
    mockAssetStore.writeAssetFromTempFile.mockResolvedValueOnce({
      ref: { assetId: 'asset-1', mimeType: 'image/png', byteSize: 4 },
      status: 'duplicate',
    });
    const req = createMockReq(
      [Buffer.from('test')],
      { 'x-asset-mime-type': 'image/png', 'content-length': '4' },
    );

    const { sendJson } = await import('../httpUtils');
    await handleSessions(req, res, ['api', 'sessions', 'sess-1', 'assets', 'asset-1'], deps);

    expect(sendJson).toHaveBeenCalledWith(res, 200, { success: true }, req);
  });

  it('maps path-traversal store errors to 400', async () => {
    mockAssetStore.writeAssetFromTempFile.mockRejectedValueOnce({
      code: 'path-traversal',
      message: 'bad path',
    });
    const req = createMockReq(
      [Buffer.from('test')],
      { 'x-asset-mime-type': 'image/png', 'content-length': '4' },
    );

    const { sendRouteError } = await import('../httpUtils');
    await handleSessions(req, res, ['api', 'sessions', 'sess-1', 'assets', 'asset-1'], deps);

    expect(sendRouteError).toHaveBeenCalled();
    const call = vi.mocked(sendRouteError).mock.calls[0];
    expect((call[2] as any).details.status).toBe(400);
  });
});