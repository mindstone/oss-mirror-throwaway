import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSessions } from '../routes/sessions';
import { getContentStore } from '@core/contentStore';

vi.mock('@core/contentStore', async () => {
  const actual = await vi.importActual<typeof import('@core/contentStore')>('@core/contentStore');
  return {
    ...actual,
    getContentStore: vi.fn(),
  };
});

vi.mock('../httpUtils', () => ({
  sendJson: vi.fn(),
  sendRouteError: vi.fn(),
  RouteError: class extends Error {
    details: { status?: number; message?: string };
    constructor(code: string, details: { status?: number; message?: string }) {
      super(code);
      this.details = details;
    }
  },
  getHeaderValue: vi.fn((req: { headers: Record<string, string> }, name: string) => req.headers[name]),
}));

describe('POST /api/sessions/:id/content/:contentId', () => {
  let deps: { getSession: ReturnType<typeof vi.fn> };
  let res: { statusCode: number; end: ReturnType<typeof vi.fn>; writeHead: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn> };
  let mockContentStore: {
    writeContent: ReturnType<typeof vi.fn>;
    readContent: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    deps = {
      getSession: vi.fn().mockResolvedValue({ id: 'sess-1' }),
    };
    res = {
      statusCode: 200,
      end: vi.fn(),
      writeHead: vi.fn(),
      setHeader: vi.fn(),
    };
    mockContentStore = {
      writeContent: vi.fn().mockResolvedValue({
        ref: {
          contentId: 'content-1',
          mimeType: 'text/plain',
          byteSize: 5,
          etag: 'content-1',
        },
        status: 'created',
      }),
      readContent: vi.fn(),
    };
    vi.mocked(getContentStore).mockReturnValue(
      mockContentStore as unknown as ReturnType<typeof getContentStore>,
    );
  });

  function createMockReq(chunks: Buffer[], headers: Record<string, string>) {
    const req = new EventEmitter() as EventEmitter & {
      method: string;
      headers: Record<string, string>;
      destroy: ReturnType<typeof vi.fn>;
      [Symbol.asyncIterator]?: () => AsyncIterator<Buffer>;
    };
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

  it('rejects invalid sessionId before any IO', async () => {
    const req = createMockReq(
      [Buffer.from('hello')],
      { 'content-length': '5' },
    );

    const { sendRouteError } = await import('../httpUtils');
    await handleSessions(
      req as unknown as import('node:http').IncomingMessage,
      res as unknown as import('node:http').ServerResponse,
      ['api', 'sessions', '../etc', 'content', 'content-1'],
      deps as unknown as import('../bootstrap').CloudServiceDeps,
    );

    expect(deps.getSession).not.toHaveBeenCalled();
    expect(mockContentStore.writeContent).not.toHaveBeenCalled();
    expect(sendRouteError).toHaveBeenCalled();
    const call = vi.mocked(sendRouteError).mock.calls[0];
    expect((call[2] as unknown as { details: { status: number } }).details.status).toBe(400);
  });

  it('rejects when Content-Length header is missing', async () => {
    const req = createMockReq([Buffer.from('hello')], {});

    const { sendRouteError } = await import('../httpUtils');
    await handleSessions(
      req as unknown as import('node:http').IncomingMessage,
      res as unknown as import('node:http').ServerResponse,
      ['api', 'sessions', 'sess-1', 'content', 'content-1'],
      deps as unknown as import('../bootstrap').CloudServiceDeps,
    );

    expect(sendRouteError).toHaveBeenCalled();
    const call = vi.mocked(sendRouteError).mock.calls[0];
    expect((call[2] as unknown as { details: { status: number } }).details.status).toBe(411);
  });

  it('rejects a 13MB payload via content-length preflight', async () => {
    const req = createMockReq([], {
      'content-length': String(13 * 1024 * 1024),
    });

    const { sendRouteError } = await import('../httpUtils');
    await handleSessions(
      req as unknown as import('node:http').IncomingMessage,
      res as unknown as import('node:http').ServerResponse,
      ['api', 'sessions', 'sess-1', 'content', 'content-1'],
      deps as unknown as import('../bootstrap').CloudServiceDeps,
    );

    expect(sendRouteError).toHaveBeenCalled();
    const call = vi.mocked(sendRouteError).mock.calls[0];
    expect((call[2] as unknown as { details: { status: number } }).details.status).toBe(413);
    expect(mockContentStore.writeContent).not.toHaveBeenCalled();
  });

  it('rejects when session does not exist with 403', async () => {
    deps.getSession.mockResolvedValueOnce(null);
    const req = createMockReq(
      [Buffer.from('hello')],
      { 'content-length': '5' },
    );

    const { sendRouteError } = await import('../httpUtils');
    await handleSessions(
      req as unknown as import('node:http').IncomingMessage,
      res as unknown as import('node:http').ServerResponse,
      ['api', 'sessions', 'sess-1', 'content', 'content-1'],
      deps as unknown as import('../bootstrap').CloudServiceDeps,
    );

    expect(sendRouteError).toHaveBeenCalled();
    const call = vi.mocked(sendRouteError).mock.calls[0];
    expect((call[2] as unknown as { details: { status: number } }).details.status).toBe(403);
  });

  it('writes content and returns 201 on first create', async () => {
    const req = createMockReq(
      [Buffer.from('hello')],
      { 'content-length': '5', 'x-content-mime-type': 'text/plain' },
    );

    const { sendJson } = await import('../httpUtils');
    await handleSessions(
      req as unknown as import('node:http').IncomingMessage,
      res as unknown as import('node:http').ServerResponse,
      ['api', 'sessions', 'sess-1', 'content', 'content-1'],
      deps as unknown as import('../bootstrap').CloudServiceDeps,
    );

    expect(mockContentStore.writeContent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        contentId: 'content-1',
        mimeType: 'text/plain',
      }),
    );
    expect(sendJson).toHaveBeenCalledWith(
      res,
      201,
      expect.objectContaining({ status: 'created', etag: 'content-1' }),
      req,
    );
  });

  it('returns 200 for an idempotent duplicate write', async () => {
    mockContentStore.writeContent.mockResolvedValueOnce({
      ref: {
        contentId: 'content-1',
        mimeType: 'text/plain',
        byteSize: 5,
        etag: 'content-1',
      },
      status: 'duplicate',
    });
    const req = createMockReq(
      [Buffer.from('hello')],
      { 'content-length': '5', 'x-content-mime-type': 'text/plain' },
    );

    const { sendJson } = await import('../httpUtils');
    await handleSessions(
      req as unknown as import('node:http').IncomingMessage,
      res as unknown as import('node:http').ServerResponse,
      ['api', 'sessions', 'sess-1', 'content', 'content-1'],
      deps as unknown as import('../bootstrap').CloudServiceDeps,
    );

    expect(sendJson).toHaveBeenCalledWith(
      res,
      200,
      expect.objectContaining({ status: 'duplicate' }),
      req,
    );
  });

  it('maps content store conflict to 409', async () => {
    mockContentStore.writeContent.mockRejectedValueOnce({
      code: 'conflict',
      message: 'mismatched bytes',
    });
    const req = createMockReq(
      [Buffer.from('hello')],
      { 'content-length': '5' },
    );

    const { sendRouteError } = await import('../httpUtils');
    await handleSessions(
      req as unknown as import('node:http').IncomingMessage,
      res as unknown as import('node:http').ServerResponse,
      ['api', 'sessions', 'sess-1', 'content', 'content-1'],
      deps as unknown as import('../bootstrap').CloudServiceDeps,
    );

    expect(sendRouteError).toHaveBeenCalled();
    const call = vi.mocked(sendRouteError).mock.calls[0];
    expect((call[2] as unknown as { details: { status: number } }).details.status).toBe(409);
  });
});

describe('GET /api/sessions/:id/content/:contentId', () => {
  let deps: { getSession: ReturnType<typeof vi.fn> };
  let res: {
    statusCode: number;
    end: ReturnType<typeof vi.fn>;
    writeHead: ReturnType<typeof vi.fn>;
    setHeader: ReturnType<typeof vi.fn>;
  };
  let mockContentStore: {
    writeContent: ReturnType<typeof vi.fn>;
    readContent: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    deps = {
      getSession: vi.fn().mockResolvedValue({ id: 'sess-1' }),
    };
    res = {
      statusCode: 200,
      end: vi.fn(),
      writeHead: vi.fn(),
      setHeader: vi.fn(),
    };
    mockContentStore = {
      writeContent: vi.fn(),
      readContent: vi.fn().mockResolvedValue({
        reason: 'ok',
        bytes: Buffer.from('hello'),
        mimeType: 'text/plain',
        byteSize: 5,
      }),
    };
    vi.mocked(getContentStore).mockReturnValue(
      mockContentStore as unknown as ReturnType<typeof getContentStore>,
    );
  });

  function createGetReq(headers: Record<string, string>) {
    return {
      method: 'GET',
      url: '/api/sessions/sess-1/content/content-1',
      headers,
    } as unknown as import('node:http').IncomingMessage;
  }

  it('streams content bytes with caching headers on success', async () => {
    const req = createGetReq({});

    await handleSessions(
      req,
      res as unknown as import('node:http').ServerResponse,
      ['api', 'sessions', 'sess-1', 'content', 'content-1'],
      deps as unknown as import('../bootstrap').CloudServiceDeps,
    );

    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        'Content-Type': 'text/plain',
        'Content-Length': '5',
        'X-Content-Type-Options': 'nosniff',
        ETag: '"content-1"',
      }),
    );
    expect(res.end).toHaveBeenCalledWith(Buffer.from('hello'));
  });

  it('returns 304 when If-None-Match matches the etag', async () => {
    const req = createGetReq({ 'if-none-match': '"content-1"' });

    await handleSessions(
      req,
      res as unknown as import('node:http').ServerResponse,
      ['api', 'sessions', 'sess-1', 'content', 'content-1'],
      deps as unknown as import('../bootstrap').CloudServiceDeps,
    );

    expect(res.writeHead).toHaveBeenCalledWith(
      304,
      expect.objectContaining({ ETag: '"content-1"' }),
    );
    expect(res.end).toHaveBeenCalledWith();
  });

  it('returns 404 when content is missing', async () => {
    mockContentStore.readContent.mockResolvedValueOnce({ reason: 'not-found' });
    const req = createGetReq({});

    await handleSessions(
      req,
      res as unknown as import('node:http').ServerResponse,
      ['api', 'sessions', 'sess-1', 'content', 'content-1'],
      deps as unknown as import('../bootstrap').CloudServiceDeps,
    );

    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  });

  it('returns 403 when session does not exist', async () => {
    deps.getSession.mockResolvedValueOnce(null);
    const req = createGetReq({});
    const { sendRouteError } = await import('../httpUtils');

    await handleSessions(
      req,
      res as unknown as import('node:http').ServerResponse,
      ['api', 'sessions', 'sess-1', 'content', 'content-1'],
      deps as unknown as import('../bootstrap').CloudServiceDeps,
    );

    expect(mockContentStore.readContent).not.toHaveBeenCalled();
    expect(sendRouteError).toHaveBeenCalled();
    const call = vi.mocked(sendRouteError).mock.calls[0];
    expect((call[2] as unknown as { details: { status: number } }).details.status).toBe(403);
  });
});
