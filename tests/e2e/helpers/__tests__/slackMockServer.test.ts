import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSlackSignature } from '../../../../scripts/slack-cloud-smoke';
import { startSlackMockServer, type SlackMockServer } from '../slackMockServer';

let server: SlackMockServer | null = null;

async function postJson(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  if (!server) throw new Error('Slack mock server was not started');
  const response = await fetch(`${server.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as unknown };
}

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  if (!server) throw new Error('Slack mock server was not started');
  const response = await fetch(`${server.baseUrl}${path}`);
  return { status: response.status, body: await response.json() as unknown };
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTruthy();
  expect(typeof value).toBe('object');
  return value as Record<string, unknown>;
}

async function startWebhookVerifier(signingSecret: string): Promise<{
  url: string;
  stop: () => Promise<void>;
  received: () => { body: Record<string, unknown>; headers: Record<string, string> } | null;
}> {
  let received: { body: Record<string, unknown>; headers: Record<string, string> } | null = null;
  const webhook = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const timestamp = String(req.headers['x-slack-request-timestamp'] ?? '');
      const expected = createSlackSignature({ rawBody, signingSecret, timestamp });
      if (req.headers['x-slack-signature'] !== expected) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key] = value;
        else if (Array.isArray(value)) headers[key] = value.join(', ');
      }
      received = { body: JSON.parse(rawBody) as Record<string, unknown>, headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, accepted: true }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    webhook.once('error', reject);
    webhook.listen(0, '127.0.0.1', () => {
      webhook.off('error', reject);
      resolve();
    });
  });
  const address = webhook.address();
  if (!address || typeof address === 'string') throw new Error('Verifier did not bind to a TCP port');
  return {
    url: `http://127.0.0.1:${address.port}/slack/events`,
    stop: () => new Promise<void>((resolve, reject) => {
      webhook.close((err) => (err ? reject(err) : resolve()));
    }),
    received: () => received,
  };
}

describe('slackMockServer', () => {
  beforeEach(async () => {
    server = await startSlackMockServer();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it('returns the deterministic OAuth fixture for code exchange', async () => {
    const result = await postJson('/api/oauth.v2.access', { code: 'oauth-code' });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      access_token: 'xoxb-stage6-bot-token',
      bot_user_id: 'U123BOT',
      team: { id: 'T123', name: 'Acme Test' },
      authed_user: { id: 'U123USER' },
      app_id: 'A123',
      enterprise: null,
      is_enterprise_install: false,
    });
  });

  it('records chat.postMessage calls and increments deterministic timestamps', async () => {
    const first = await postJson('/api/chat.postMessage', { channel: 'C123', text: 'first' });
    const second = await postJson('/api/chat.postMessage', { channel: 'C123', text: 'second' });

    expect(first.body).toMatchObject({ ok: true, ts: '1779854400.000001', channel: 'C123' });
    expect(second.body).toMatchObject({ ok: true, ts: '1779854400.000002', channel: 'C123' });
    expect(server?.getCalls('chat.postMessage')).toHaveLength(2);
    expect(server?.getCalls('chat.postMessage')[0]?.body).toMatchObject({ text: 'first' });
  });

  it('records metadata for Slack API calls when present', async () => {
    const metadata = {
      event_type: 'assistant_context',
      event_payload: {
        agentInstanceId: 'agent-123',
        ownerUserId: 'U-owner',
        threadScope: 'thread',
      },
    };

    await postJson('/api/chat.postMessage', {
      channel: 'C123',
      text: 'with metadata',
      metadata,
    });

    const call = server?.getCalls('chat.postMessage')[0];
    expect(call?.metadata).toEqual(metadata);
  });

  it('supports metadata round-trip from outbound post capture to inbound event relay', async () => {
    const signingSecret = 'stage6-signing-secret';
    const verifier = await startWebhookVerifier(signingSecret);
    try {
      const metadata = {
        event_type: 'rebel_thread_reply',
        event_payload: {
          agentInstanceId: '7a14c8f2-6ab7-4974-b53a-c13bf9d0a585',
          ownerUserId: 'U123USER',
          threadScope: '1779854400.000100',
        },
      };

      await postJson('/api/chat.postMessage', {
        channel: 'C123',
        text: 'metadata round-trip',
        metadata,
      });

      const capturedMetadata = server?.getCalls('chat.postMessage')[0]?.metadata;
      expect(capturedMetadata).toEqual(metadata);

      const relay = await postJson('/__test/send-event', {
        webhookUrl: verifier.url,
        signingSecret,
        event: {
          type: 'app_mention',
          team_id: 'T123',
          user: 'U123USER',
          text: '<@U123BOT> metadata echo',
          channel: 'C123',
          channel_type: 'channel',
          ts: '1779854400.000100',
          thread_ts: '1779854400.000100',
          metadata: capturedMetadata,
        },
      });

      expect(relay.body).toMatchObject({ ok: true, relayed: { status: 200, body: { ok: true, accepted: true } } });
      expect(verifier.received()?.body).toMatchObject({
        event: {
          metadata,
        },
      });
    } finally {
      await verifier.stop();
    }
  });

  it('returns the deterministic conversations.replies fixture', async () => {
    const result = await getJson('/api/conversations.replies?channel=C123&ts=1779854400.000100');

    expect(result.status).toBe(200);
    const body = asRecord(result.body);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.messages)).toBe(true);
    expect((body.messages as unknown[]).length).toBeGreaterThanOrEqual(3);
    expect((body.messages as Array<Record<string, unknown>>)[0]).toMatchObject({
      user: 'U123USER',
      ts: '1779854400.000100',
    });
  });

  it('covers channel, user, team, and tokens_revoked helper endpoints', async () => {
    const channel = await getJson('/api/conversations.info?channel=C123');
    const user = await getJson('/api/users.info?user=U999');
    const team = await getJson('/api/team.info');
    const verifier = await startWebhookVerifier('stage6-signing-secret');
    try {
      const revoked = await postJson('/__test/tokens-revoked', {
        webhookUrl: verifier.url,
        signingSecret: 'stage6-signing-secret',
      });

      expect(channel.body).toMatchObject({ ok: true, channel: { id: 'C123', name: 'general' } });
      expect(user.body).toMatchObject({ ok: true, user: { id: 'U999', name: 'jane' } });
      expect(team.body).toMatchObject({ ok: true, team: { id: 'T123', name: 'Acme Test' } });
      expect(revoked.body).toMatchObject({ ok: true, relayed: { status: 200 } });
      expect(verifier.received()?.body).toMatchObject({
        team_id: 'T123',
        event: { type: 'tokens_revoked' },
      });
    } finally {
      await verifier.stop();
    }
  });

  it('signs and relays app_mention events through __test/send-event', async () => {
    const verifier = await startWebhookVerifier('stage6-signing-secret');
    try {
      const result = await postJson('/__test/send-event', {
        webhookUrl: verifier.url,
        signingSecret: 'stage6-signing-secret',
        event: {
          type: 'app_mention',
          team_id: 'T123',
          user: 'U123USER',
          text: '<@U123BOT> hello',
          channel: 'C123',
          channel_type: 'channel',
          ts: '1779854400.000100',
          thread_ts: '1779854400.000100',
        },
      });

      expect(result.body).toMatchObject({ ok: true, relayed: { status: 200, body: { ok: true, accepted: true } } });
      expect(verifier.received()?.headers['x-slack-signature']).toMatch(/^v0=/);
      expect(verifier.received()?.body).toMatchObject({
        team_id: 'T123',
        event: { type: 'app_mention', channel: 'C123' },
      });
    } finally {
      await verifier.stop();
    }
  });

  it('indexes request logs by Slack method', async () => {
    await postJson('/api/chat.postMessage', { channel: 'C123' });
    await getJson('/api/team.info');

    expect(server?.getCalls()).toHaveLength(2);
    expect(server?.getCalls('chat.postMessage')).toHaveLength(1);
    expect(server?.getCalls('team.info')).toHaveLength(1);
  });

  it('waitForCall resolves matching calls and rejects timeouts', async () => {
    const pending = server?.waitForCall(
      'chat.postMessage',
      (call) => asRecord(call.body).channel === 'C123',
      { timeout: 500 },
    );
    setTimeout(() => {
      void postJson('/api/chat.postMessage', { channel: 'C123' });
    }, 10);

    await expect(pending).resolves.toMatchObject({ body: { channel: 'C123' } });
    await expect(server?.waitForCall('chat.postMessage', () => false, { timeout: 10 }))
      .rejects.toThrow(/Timed out waiting for Slack API call chat\.postMessage/);
  });

  it('reset clears the request log', async () => {
    await postJson('/api/chat.postMessage', { channel: 'C123' });
    expect(server?.getCalls()).toHaveLength(1);

    server?.reset();

    expect(server?.getCalls()).toHaveLength(0);
  });

  it('stop releases the bound port', async () => {
    if (!server) throw new Error('Slack mock server was not started');
    const port = server.port;
    await server.stop();
    server = null;

    const probe = http.createServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => {
        probe.off('error', reject);
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      probe.close((err) => (err ? reject(err) : resolve()));
    });
  });
});
