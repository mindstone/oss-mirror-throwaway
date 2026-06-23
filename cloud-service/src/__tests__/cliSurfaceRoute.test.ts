import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudServiceDeps } from '../bootstrap';

const { processSessionPutMock } = vi.hoisted(() => ({
  processSessionPutMock: vi.fn(),
}));

vi.mock('@core/services/cloudSessionMergeService', async () => {
  const actual = await vi.importActual<typeof import('@core/services/cloudSessionMergeService')>('@core/services/cloudSessionMergeService');
  return {
    ...actual,
    processSessionPut: processSessionPutMock,
  };
});

import { handleSessions, parseSurfaceHeader } from '../routes/sessions';

function createPutReq(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = 'PUT';
  req.url = url;
  req.headers = { host: 'localhost', ...headers };
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function createRes(): {
  res: http.ServerResponse;
  statusCode: () => number;
  body: <T = unknown>() => T;
} {
  let status = 200;
  let rawBody = '';

  const res = {
    writeHead: vi.fn((nextStatus: number) => { status = nextStatus; }),
    end: vi.fn((payload?: string) => { rawBody = payload ?? ''; }),
  } as unknown as http.ServerResponse;

  return {
    res,
    statusCode: () => status,
    body: <T = unknown>() => JSON.parse(rawBody) as T,
  };
}

function makeDeps(): CloudServiceDeps {
  return {
    getSession: vi.fn(async () => null),
    upsertSession: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    listSessions: vi.fn(() => []),
    loadSessions: vi.fn(async () => []),
  } as unknown as CloudServiceDeps;
}

describe('cli surface routing', () => {
  beforeEach(() => {
    processSessionPutMock.mockReset();
    processSessionPutMock.mockResolvedValue({
      kind: 'persisted',
      cloudUpdatedAt: 1_700_000_000_000,
      serverSeq: 0,
      changedFields: [],
    });
  });

  it('parses X-Rebel-Surface: cli as cli', () => {
    const req = {
      method: 'PUT',
      url: '/api/sessions/session-1',
      headers: { host: 'localhost', 'x-rebel-surface': 'cli' },
    } as unknown as http.IncomingMessage;

    expect(parseSurfaceHeader(req)).toBe('cli');
  });

  it('passes cli surface through to processSessionPut for PUT /api/sessions/:id', async () => {
    const req = createPutReq(
      '/api/sessions/session-1',
      { title: 'CLI title' },
      { 'x-rebel-surface': 'cli' },
    );
    const { res, statusCode, body } = createRes();

    await handleSessions(req, res, ['api', 'sessions', 'session-1'], makeDeps());

    expect(statusCode()).toBe(200);
    expect(body()).toMatchObject({
      success: true,
      tombstoned: false,
    });
    expect(processSessionPutMock).toHaveBeenCalledTimes(1);
    expect(processSessionPutMock.mock.calls[0]?.[1]).toMatchObject({
      surface: 'cli',
      source: 'cli',
      sessionId: 'session-1',
    });
  });
});
