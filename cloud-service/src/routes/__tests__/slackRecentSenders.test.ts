import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RouteError, sendRouteError } from '../../httpUtils';
import {
  __setSlackRecentSendersRouteDepsForTesting,
  handleSlackRecentSenders,
  handleSlackRecentSendersClearAll,
} from '../slackRecentSenders';
import { createSlackRecentSendersStore, type SlackRecentSendersStore } from '../../services/slackRecentSendersStore';
import type { SlackWorkspaceStore } from '../../services/slackWorkspaceStore';

interface MockReq extends IncomingMessage {
  send: () => void;
}

interface MockRes extends ServerResponse {
  out: {
    status: number;
    body: string;
    headers: Record<string, string>;
  };
}

function createMockReq(args: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}): MockReq {
  const req = new EventEmitter() as MockReq;
  req.method = args.method;
  req.url = args.url;
  req.headers = { host: 'cloud.test', ...(args.headers ?? {}) };
  req.resume = (() => req) as MockReq['resume'];
  req.send = () => {
    if (typeof args.body !== 'undefined') {
      req.emit('data', Buffer.from(JSON.stringify(args.body)));
    }
    req.emit('end');
  };
  return req;
}

function createMockRes(): MockRes {
  const out = {
    status: 0,
    body: '',
    headers: {} as Record<string, string>,
  };
  return {
    out,
    statusCode: 0,
    setHeader(key: string, value: string) {
      out.headers[key] = value;
    },
    getHeader(key: string) {
      return out.headers[key];
    },
    writeHead(status: number, headers?: Record<string, string>) {
      out.status = status;
      if (headers) Object.assign(out.headers, headers);
    },
    end(body?: string) {
      if (body) out.body = body;
    },
  } as unknown as MockRes;
}

async function runRoute(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  req: MockReq,
  res: MockRes,
): Promise<void> {
  try {
    const promise = handler(req, res);
    req.send();
    await promise;
  } catch (error) {
    if (error instanceof RouteError) {
      await sendRouteError(res, req, error);
      return;
    }
    throw error;
  }
}

function parseBody<T>(res: MockRes): T {
  return JSON.parse(res.out.body) as T;
}

async function isAuthorized(req: IncomingMessage, token: string): Promise<boolean> {
  vi.resetModules();
  process.env.REBEL_CLOUD_TOKEN = token;
  const { authorize } = await import('../../auth');
  return authorize(req);
}

describe('slackRecentSenders route', () => {
  let tempDir: string;
  let workspaceStore: SlackWorkspaceStore;
  let recentSendersStore: SlackRecentSendersStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-recent-senders-route-'));
    const storePath = path.join(tempDir, 'slackRecentSenders.json');
    recentSendersStore = createSlackRecentSendersStore({
      storeFactory: () => ({ path: storePath } as any),
      log: { error: vi.fn() } as any,
    });
    workspaceStore = {
      get: () => ({
        teamId: 'T1',
        teamName: 'Acme',
        botUserId: 'UBOT',
        botToken: 'xoxb-token',
        installedAt: Date.now(),
        status: 'connected',
      }),
      set: vi.fn(),
      updateStatus: vi.fn(),
      updateLastSeen: vi.fn(),
      clear: vi.fn(),
    };
    __setSlackRecentSendersRouteDepsForTesting({
      workspaceStore,
      recentSendersStore,
    });
  });

  afterEach(() => {
    __setSlackRecentSendersRouteDepsForTesting(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.REBEL_CLOUD_TOKEN;
  });

  it('GET returns an empty list when no denied senders were recorded', async () => {
    const req = createMockReq({
      method: 'GET',
      url: '/api/slack/recent-senders',
    });
    const res = createMockRes();

    await runRoute(handleSlackRecentSenders, req, res);

    expect(res.out.status).toBe(200);
    expect(parseBody<{ senders: unknown[] }>(res)).toEqual({ senders: [] });
  });

  it('GET returns senders sorted by lastSeenAt DESC', async () => {
    recentSendersStore.recordAttempt({
      transport: 'slack',
      teamId: 'T1',
      principalKind: 'human',
      authorId: 'u_old',
      channelId: 'D_OLD',
      channelType: 'im',
      seenAt: 1000,
    });
    recentSendersStore.recordAttempt({
      transport: 'slack',
      teamId: 'T1',
      principalKind: 'agent',
      authorId: 'A_BOT',
      channelId: 'C_AGENT',
      channelType: 'channel',
      seenAt: 2000,
    });
    recentSendersStore.recordAttempt({
      transport: 'slack',
      teamId: 'T1',
      principalKind: 'human',
      authorId: 'U_NEW',
      channelId: 'D_NEW',
      channelType: 'im',
      seenAt: 3000,
    });

    const req = createMockReq({
      method: 'GET',
      url: '/api/slack/recent-senders',
    });
    const res = createMockRes();

    await runRoute(handleSlackRecentSenders, req, res);

    expect(res.out.status).toBe(200);
    const body = parseBody<{ senders: Array<{ authorId: string; normalizedAuthorId: string; teamId: string; lastSeenAt: number }> }>(res);
    expect(body.senders.map((sender) => sender.lastSeenAt)).toEqual([3000, 2000, 1000]);
    expect(body.senders[0]).toMatchObject({
      authorId: 'U_NEW',
      normalizedAuthorId: 'U_NEW',
      teamId: 'T1',
    });
    expect(body.senders[2]).toMatchObject({
      authorId: 'u_old',
      normalizedAuthorId: 'U_OLD',
      teamId: 'T1',
    });
  });

  it('DELETE removes an existing sender by principal key', async () => {
    const created = recentSendersStore.recordAttempt({
      transport: 'slack',
      teamId: 'T1',
      principalKind: 'human',
      authorId: 'U_DELETE',
      channelId: 'D1',
      channelType: 'im',
      seenAt: 1000,
    });

    const req = createMockReq({
      method: 'DELETE',
      url: '/api/slack/recent-senders',
      body: { principalKey: created.principalKey },
    });
    const res = createMockRes();

    await runRoute(handleSlackRecentSenders, req, res);

    expect(res.out.status).toBe(200);
    expect(parseBody<{ ok: boolean }>(res)).toEqual({ ok: true });
    expect(recentSendersStore.list('T1')).toEqual([]);
  });

  it('DELETE is idempotent and returns ok for unknown principal keys', async () => {
    const req = createMockReq({
      method: 'DELETE',
      url: '/api/slack/recent-senders',
      body: { principalKey: 'slack:T1:human:DOES_NOT_EXIST' },
    });
    const res = createMockRes();

    await runRoute(handleSlackRecentSenders, req, res);

    expect(res.out.status).toBe(200);
    expect(parseBody<{ ok: boolean }>(res)).toEqual({ ok: true });
  });

  it('DELETE validates request body and returns 400 for missing principalKey', async () => {
    const req = createMockReq({
      method: 'DELETE',
      url: '/api/slack/recent-senders',
      body: {},
    });
    const res = createMockRes();

    await runRoute(handleSlackRecentSenders, req, res);

    expect(res.out.status).toBe(400);
    expect(parseBody<{ error: { code: string } }>(res).error.code).toBe('INVALID_BODY');
  });

  it('POST /clear-all returns zero when there are no entries', async () => {
    const req = createMockReq({
      method: 'POST',
      url: '/api/slack/recent-senders/clear-all',
    });
    const res = createMockRes();

    await runRoute(handleSlackRecentSendersClearAll, req, res);

    expect(res.out.status).toBe(200);
    expect(parseBody<{ ok: boolean; cleared: number }>(res)).toEqual({ ok: true, cleared: 0 });
  });

  it('POST /clear-all removes only the current workspace entries and returns cleared count', async () => {
    recentSendersStore.recordAttempt({
      transport: 'slack',
      teamId: 'T1',
      principalKind: 'human',
      authorId: 'U_ONE',
      channelId: 'D1',
      channelType: 'im',
      seenAt: 1000,
    });
    recentSendersStore.recordAttempt({
      transport: 'slack',
      teamId: 'T1',
      principalKind: 'human',
      authorId: 'U_TWO',
      channelId: 'D2',
      channelType: 'im',
      seenAt: 1001,
    });
    recentSendersStore.recordAttempt({
      transport: 'slack',
      teamId: 'T2',
      principalKind: 'human',
      authorId: 'U_THREE',
      channelId: 'D3',
      channelType: 'im',
      seenAt: 1002,
    });

    const req = createMockReq({
      method: 'POST',
      url: '/api/slack/recent-senders/clear-all',
    });
    const res = createMockRes();

    await runRoute(handleSlackRecentSendersClearAll, req, res);

    expect(res.out.status).toBe(200);
    expect(parseBody<{ ok: boolean; cleared: number }>(res)).toEqual({ ok: true, cleared: 2 });
    expect(recentSendersStore.list('T1')).toEqual([]);
    expect(recentSendersStore.list('T2')).toHaveLength(1);
  });

  it('auth gate returns 401 for missing bearer token', async () => {
    const req = createMockReq({
      method: 'GET',
      url: '/api/slack/recent-senders',
    });
    const res = createMockRes();

    if (!(await isAuthorized(req, 'route-token'))) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing bearer token' } }));
    }

    expect(res.out.status).toBe(401);
    expect(parseBody<{ error: { code: string; message: string } }>(res)).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or missing bearer token' },
    });
  });

  it('auth gate returns 401 for invalid bearer token', async () => {
    const req = createMockReq({
      method: 'GET',
      url: '/api/slack/recent-senders',
      headers: { authorization: 'Bearer wrong-token' },
    });
    const res = createMockRes();

    if (!(await isAuthorized(req, 'route-token'))) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing bearer token' } }));
    }

    expect(res.out.status).toBe(401);
    expect(parseBody<{ error: { code: string; message: string } }>(res)).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or missing bearer token' },
    });
  });
});
