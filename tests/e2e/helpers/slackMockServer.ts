import crypto from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';

const DEFAULT_SIGNING_SECRET = 'slack-smoke-self-test-secret-never-print';
const DEFAULT_TEAM_ID = 'T123';
const DEFAULT_TEAM_NAME = 'Acme Test';
const DEFAULT_TEAM_DOMAIN = 'acme-test';
const DEFAULT_BOT_USER_ID = 'U123BOT';
const DEFAULT_USER_ID = 'U123USER';
const DEFAULT_CHANNEL_ID = 'C123';
const DEFAULT_THREAD_TS = '1779854400.000100';

export interface SlackMockCall {
  method: string;
  body: unknown;
  headers: Record<string, string>;
  metadata?: unknown;
}

export interface SlackMockServer {
  baseUrl: string;
  port: number;
  stop: () => Promise<void>;
  waitForCall: (
    method: string,
    predicate?: (req: SlackMockCall) => boolean,
    opts?: { timeout?: number },
  ) => Promise<{ body: unknown; headers: Record<string, string> }>;
  getCalls: (method?: string) => SlackMockCall[];
  reset: () => void;
}

interface Waiter {
  method: string;
  predicate?: (req: SlackMockCall) => boolean;
  resolve: (call: { body: unknown; headers: Record<string, string> }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type JsonRecord = Record<string, unknown>;

export function createSignedSlackPayload(args: {
  payload: JsonRecord;
  signingSecret: string;
  timestamp?: number;
}): { headers: Record<string, string>; rawBody: string } {
  const rawBody = JSON.stringify(args.payload);
  const timestamp = String(args.timestamp ?? Math.floor(Date.now() / 1000));
  const base = `v0:${timestamp}:${rawBody}`;
  const signature = `v0=${crypto
    .createHmac('sha256', args.signingSecret)
    .update(base, 'utf8')
    .digest('hex')}`;

  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
  };
}

function toHeaderRecord(headers: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
    else if (Array.isArray(value)) out[key.toLowerCase()] = value.join(', ');
  }
  return out;
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseBody(req: IncomingMessage, raw: Buffer, baseUrl: string): unknown {
  const url = new URL(req.url ?? '/', baseUrl);
  const fromQuery = Object.fromEntries(url.searchParams.entries());
  if (raw.length === 0) return fromQuery;

  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  const text = raw.toString('utf8');
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return {
      ...fromQuery,
      ...Object.fromEntries(new URLSearchParams(text).entries()),
    };
  }
  if (contentType.includes('application/json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
    return {
      ...fromQuery,
      ...JSON.parse(text) as JsonRecord,
    };
  }
  return { ...fromQuery, rawBody: text };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(raw),
  });
  res.end(raw);
}

function pickString(body: unknown, key: string, fallback: string): string {
  if (body && typeof body === 'object') {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return fallback;
}

function extractMetadata(body: unknown): unknown {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const metadata = (body as Record<string, unknown>).metadata;
    if (metadata !== undefined) return metadata;
  }
  return undefined;
}

function buildEventCallback(event: unknown): JsonRecord {
  const eventRecord = event && typeof event === 'object' ? event as JsonRecord : {};
  if (eventRecord.type === 'event_callback' && eventRecord.event && typeof eventRecord.event === 'object') {
    return eventRecord;
  }

  const inner = {
    type: 'app_mention',
    team: DEFAULT_TEAM_ID,
    team_id: DEFAULT_TEAM_ID,
    user: DEFAULT_USER_ID,
    text: `<@${DEFAULT_BOT_USER_ID}> e2e smoke`,
    channel: DEFAULT_CHANNEL_ID,
    channel_type: 'channel',
    ts: DEFAULT_THREAD_TS,
    thread_ts: DEFAULT_THREAD_TS,
    ...eventRecord,
  };
  const eventIdSuffix = typeof inner.ts === 'string'
    ? inner.ts.replace(/[^A-Za-z0-9_-]/g, '_')
    : String(Date.now());
  return {
    token: 'stage6-test-token',
    team_id: typeof inner.team_id === 'string' ? inner.team_id : DEFAULT_TEAM_ID,
    api_app_id: 'A123',
    type: 'event_callback',
    event_id: `E_STAGE6_${eventIdSuffix}`,
    event_time: 1_779_854_400,
    event: inner,
  };
}

async function relaySignedSlackPayload(args: {
  payload: JsonRecord;
  signingSecret: string;
  webhookUrl: string;
}): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const signed = createSignedSlackPayload({
    payload: args.payload,
    signingSecret: args.signingSecret,
  });
  const response = await fetch(args.webhookUrl, {
    method: 'POST',
    headers: signed.headers,
    body: signed.rawBody,
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, body, headers };
}

export async function startSlackMockServer(): Promise<SlackMockServer> {
  const calls: SlackMockCall[] = [];
  const waiters: Waiter[] = [];
  let tsCounter = 0;
  let baseUrl = '';

  const deterministicTs = (): string => {
    tsCounter += 1;
    return `1779854400.${String(tsCounter).padStart(6, '0')}`;
  };

  const notifyWaiters = (call: SlackMockCall): void => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (!waiter || waiter.method !== call.method) continue;
      if (waiter.predicate && !waiter.predicate(call)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(i, 1);
      waiter.resolve({ body: call.body, headers: call.headers });
    }
  };

  const recordCall = (call: SlackMockCall): void => {
    calls.push(call);
    notifyWaiters(call);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', baseUrl);
      const raw = await readRawBody(req);
      const body = parseBody(req, raw, baseUrl);
      const headers = toHeaderRecord(req.headers);

      if (url.pathname.startsWith('/api/')) {
        const method = decodeURIComponent(url.pathname.slice('/api/'.length));
        const metadata = extractMetadata(body);
        const call = metadata === undefined
          ? { method, body, headers }
          : { method, body, headers, metadata };
        recordCall(call);

        switch (method) {
          case 'oauth.v2.access':
            return sendJson(res, 200, {
              ok: true,
              access_token: 'xoxb-stage6-bot-token',
              scope: 'app_mentions:read,chat:write,channels:history,channels:read,users:read,team:read',
              bot_user_id: DEFAULT_BOT_USER_ID,
              team: { id: DEFAULT_TEAM_ID, name: DEFAULT_TEAM_NAME, domain: DEFAULT_TEAM_DOMAIN },
              authed_user: { id: DEFAULT_USER_ID },
              app_id: 'A123',
              enterprise: null,
              is_enterprise_install: false,
            });
          case 'chat.postMessage':
            return sendJson(res, 200, {
              ok: true,
              ts: deterministicTs(),
              channel: pickString(body, 'channel', DEFAULT_CHANNEL_ID),
            });
          case 'conversations.replies':
            return sendJson(res, 200, {
              ok: true,
              messages: [
                { type: 'message', user: DEFAULT_USER_ID, text: `<@${DEFAULT_BOT_USER_ID}> first mention`, ts: DEFAULT_THREAD_TS },
                { type: 'message', user: 'U234', text: 'A teammate adds context.', ts: '1779854401.000200', thread_ts: DEFAULT_THREAD_TS },
                { type: 'message', user: 'U345', text: 'Another useful detail lands here.', ts: '1779854402.000300', thread_ts: DEFAULT_THREAD_TS },
                { type: 'message', user: DEFAULT_USER_ID, text: `<@${DEFAULT_BOT_USER_ID}> follow up`, ts: '1779854403.000400', thread_ts: DEFAULT_THREAD_TS },
              ],
            });
          case 'conversations.info':
            return sendJson(res, 200, {
              ok: true,
              channel: {
                id: pickString(body, 'channel', DEFAULT_CHANNEL_ID),
                name: 'general',
                is_channel: true,
                is_group: false,
                is_im: false,
                is_mpim: false,
                is_private: false,
              },
            });
          case 'users.info':
            return sendJson(res, 200, {
              ok: true,
              user: {
                id: pickString(body, 'user', DEFAULT_USER_ID),
                name: 'jane',
                real_name: 'Jane Example',
                profile: {
                  display_name: 'Jane',
                  real_name: 'Jane Example',
                  email: 'jane@example.test',
                },
              },
            });
          case 'team.info':
            return sendJson(res, 200, {
              ok: true,
              team: { id: DEFAULT_TEAM_ID, name: DEFAULT_TEAM_NAME, domain: DEFAULT_TEAM_DOMAIN },
            });
          default:
            return sendJson(res, 404, { ok: false, error: `Unsupported Slack API method: ${method}` });
        }
      }

      if (url.pathname === '/__test/send-event' && req.method === 'POST') {
        const request = body && typeof body === 'object' ? body as JsonRecord : {};
        const webhookUrl = typeof request.webhookUrl === 'string' ? request.webhookUrl : '';
        if (!webhookUrl) return sendJson(res, 400, { ok: false, error: 'webhookUrl is required' });
        const signingSecret = typeof request.signingSecret === 'string'
          ? request.signingSecret
          : DEFAULT_SIGNING_SECRET;
        const result = await relaySignedSlackPayload({
          payload: buildEventCallback(request.event),
          signingSecret,
          webhookUrl,
        });
        return sendJson(res, 200, { ok: true, relayed: result });
      }

      if (url.pathname === '/__test/tokens-revoked' && req.method === 'POST') {
        const request = body && typeof body === 'object' ? body as JsonRecord : {};
        const webhookUrl = typeof request.webhookUrl === 'string' ? request.webhookUrl : '';
        if (!webhookUrl) return sendJson(res, 400, { ok: false, error: 'webhookUrl is required' });
        const signingSecret = typeof request.signingSecret === 'string'
          ? request.signingSecret
          : DEFAULT_SIGNING_SECRET;
        const teamId = typeof request.teamId === 'string' ? request.teamId : DEFAULT_TEAM_ID;
        const result = await relaySignedSlackPayload({
          payload: {
            token: 'stage6-test-token',
            team_id: teamId,
            api_app_id: 'A123',
            type: 'event_callback',
            event_id: `E_STAGE6_TOKENS_REVOKED_${Date.now()}`,
            event_time: 1_779_854_500,
            event: {
              type: 'tokens_revoked',
              team_id: teamId,
              tokens: {
                oauth: [DEFAULT_USER_ID],
                bot: [DEFAULT_BOT_USER_ID],
              },
            },
          },
          signingSecret,
          webhookUrl,
        });
        return sendJson(res, 200, { ok: true, relayed: result });
      }

      return sendJson(res, 404, { ok: false, error: 'Not Found' });
    } catch (err) {
      return sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : 'Unknown mock server error',
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Slack mock server did not bind to a TCP port'));
        return;
      }
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Slack mock server did not expose a TCP address');
  }

  return {
    baseUrl,
    port: address.port,
    stop: () => new Promise<void>((resolve, reject) => {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Slack mock server stopped before call arrived'));
      }
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
    waitForCall(method, predicate, opts = {}) {
      const existing = calls.find((call) => call.method === method && (!predicate || predicate(call)));
      if (existing) return Promise.resolve({ body: existing.body, headers: existing.headers });
      const timeout = opts.timeout ?? 5_000;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for Slack API call ${method}`));
        }, timeout);
        waiters.push({ method, predicate, resolve, reject, timer });
      });
    },
    getCalls(method) {
      const filtered = method ? calls.filter((call) => call.method === method) : calls;
      return filtered.map((call) => ({ ...call }));
    },
    reset() {
      calls.splice(0);
      tsCounter = 0;
    },
  };
}
