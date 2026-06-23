import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../index';
import type { Env } from '../types';

function signRecallWebhook(rawBody: string, secret: string, timestampSeconds: number): string {
  const signature = createHmac('sha256', secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest('hex');
  return `t=${timestampSeconds},v1=${signature}`;
}

function createTranscriptWebhookBody(): {
  event: string;
  data: {
    bot: { id: string };
    data: {
      words: Array<{ text: string }>;
      participant: { name: string; id: number };
    };
  };
} {
  return {
    event: 'transcript.data',
    data: {
      bot: { id: 'recall-bot-123' },
      data: {
        words: [{ text: 'hello' }, { text: 'team' }],
        participant: { name: 'Alex', id: 42 },
      },
    },
  };
}

function createMockEnv(overrides: Partial<Env> = {}): {
  env: Env;
  doFetchMock: ReturnType<typeof vi.fn>;
} {
  const doFetchMock = vi.fn(async () => new Response('OK', { status: 200 }));
  const meetingBotsGet = vi.fn(async (key: string, type?: string) => {
    if (key === 'recall_relay:recall-bot-123') return 'relay-bot-123';
    if (key === 'bot:recall-bot-123' && type === 'json') {
      return { meetingTitle: 'Weekly sync' };
    }
    return null;
  });

  const env: Env = {
    MEETING_BOTS: {
      get: meetingBotsGet,
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
      getWithMetadata: vi.fn(async () => ({ value: null, metadata: null, cacheStatus: null })),
    } as unknown as KVNamespace,
    BOT_RELAY: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ fetch: doFetchMock })),
    } as unknown as DurableObjectNamespace,
    RECALL_API_KEY: 'recall-api-key',
    MINDSTONE_AUTH_SECRET: 'mindstone-auth-secret',
    RECALL_WEBHOOK_SECRET: 'recall-webhook-secret',
    MINDSTONE_TRANSCRIPT_HMAC_SECRET: 'transcript-hmac-secret',
    CLOUD_SERVICE_URL: 'https://cloud.example',
    CLOUD_TRANSCRIPT_FORWARD_ENABLED: 'false',
    JWT_SECRET: 'jwt-secret',
    RECALL_BASE_URL: 'https://us-west-2.recall.ai/api/v1',
    KV_TTL_SECONDS: '604800',
    ...overrides,
  } as Env;

  return { env, doFetchMock };
}

describe('transcript webhook', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts valid Recall signatures and rejects missing/mangled/expired signatures', async () => {
    const { env, doFetchMock } = createMockEnv();
    const payload = createTranscriptWebhookBody();
    const rawBody = JSON.stringify(payload);
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const validSignature = signRecallWebhook(rawBody, env.RECALL_WEBHOOK_SECRET as string, timestampSeconds);
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

    const validResponse = await worker.fetch(
      new Request('https://worker.example/webhook/recall/transcript', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': validSignature,
        },
        body: rawBody,
      }),
      env,
      ctx,
    );
    expect(validResponse.status).toBe(200);
    expect(doFetchMock).toHaveBeenCalledTimes(1);

    const missingSignatureResponse = await worker.fetch(
      new Request('https://worker.example/webhook/recall/transcript', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: rawBody,
      }),
      env,
      ctx,
    );
    expect(missingSignatureResponse.status).toBe(401);

    const mangledSignatureResponse = await worker.fetch(
      new Request('https://worker.example/webhook/recall/transcript', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `t=${timestampSeconds},v1=deadbeef`,
        },
        body: rawBody,
      }),
      env,
      ctx,
    );
    expect(mangledSignatureResponse.status).toBe(401);

    const expiredTimestampSeconds = timestampSeconds - (6 * 60);
    const expiredSignature = signRecallWebhook(rawBody, env.RECALL_WEBHOOK_SECRET as string, expiredTimestampSeconds);
    const expiredSignatureResponse = await worker.fetch(
      new Request('https://worker.example/webhook/recall/transcript', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': expiredSignature,
        },
        body: rawBody,
      }),
      env,
      ctx,
    );
    expect(expiredSignatureResponse.status).toBe(401);
  });

  it('returns 401 with no DO fan-out or cloud fan-out when the Recall signature is missing', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { env, doFetchMock } = createMockEnv({
      CLOUD_TRANSCRIPT_FORWARD_ENABLED: 'true',
    });
    const payload = createTranscriptWebhookBody();
    const rawBody = JSON.stringify(payload);
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

    const response = await worker.fetch(
      new Request('https://worker.example/webhook/recall/transcript', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: rawBody,
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(401);
    expect(doFetchMock).toHaveBeenCalledTimes(0);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('returns 401 with no DO fan-out or cloud fan-out when the Recall signature is mangled', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { env, doFetchMock } = createMockEnv({
      CLOUD_TRANSCRIPT_FORWARD_ENABLED: 'true',
    });
    const payload = createTranscriptWebhookBody();
    const rawBody = JSON.stringify(payload);
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

    const response = await worker.fetch(
      new Request('https://worker.example/webhook/recall/transcript', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `t=${timestampSeconds},v1=deadbeef`,
        },
        body: rawBody,
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(401);
    expect(doFetchMock).toHaveBeenCalledTimes(0);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('keeps cloud forwarding disabled when kill-switch is off', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { env, doFetchMock } = createMockEnv({
      CLOUD_TRANSCRIPT_FORWARD_ENABLED: 'false',
    });
    const payload = createTranscriptWebhookBody();
    const rawBody = JSON.stringify(payload);
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const signature = signRecallWebhook(rawBody, env.RECALL_WEBHOOK_SECRET as string, timestampSeconds);
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

    const response = await worker.fetch(
      new Request('https://worker.example/webhook/recall/transcript', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
        },
        body: rawBody,
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(doFetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 200 and resolves ctx.waitUntil when cloud fan-out fetch rejects', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network unreachable');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { env, doFetchMock } = createMockEnv({
      CLOUD_TRANSCRIPT_FORWARD_ENABLED: 'true',
    });
    const payload = createTranscriptWebhookBody();
    const rawBody = JSON.stringify(payload);
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const signature = signRecallWebhook(rawBody, env.RECALL_WEBHOOK_SECRET as string, timestampSeconds);
    const waitUntilPromises: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
    } as unknown as ExecutionContext;

    const response = await worker.fetch(
      new Request('https://worker.example/webhook/recall/transcript', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
        },
        body: rawBody,
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(doFetchMock).toHaveBeenCalledTimes(1);
    expect(waitUntilPromises).toHaveLength(1);

    const settled = await Promise.allSettled(waitUntilPromises);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);
  });

  it('forwards signed transcript payloads to cloud when kill-switch is enabled and still hits the DO path', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { env, doFetchMock } = createMockEnv({
      CLOUD_TRANSCRIPT_FORWARD_ENABLED: 'true',
    });
    const payload = createTranscriptWebhookBody();
    const rawBody = JSON.stringify(payload);
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const signature = signRecallWebhook(rawBody, env.RECALL_WEBHOOK_SECRET as string, timestampSeconds);
    const waitUntilPromises: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
    } as unknown as ExecutionContext;

    const response = await worker.fetch(
      new Request('https://worker.example/webhook/recall/transcript', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
        },
        body: rawBody,
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(doFetchMock).toHaveBeenCalledTimes(1);

    await Promise.all(waitUntilPromises);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe('https://cloud.example/api/meeting/transcript-segment');
    expect(requestInit.method).toBe('POST');

    const headers = requestInit.headers as Record<string, string>;
    const cloudRawBody = String(requestInit.body ?? '');
    const expectedSignature = createHmac('sha256', env.MINDSTONE_TRANSCRIPT_HMAC_SECRET as string)
      .update(`${headers['X-Mindstone-Timestamp']}.${headers['X-Mindstone-Nonce']}.${cloudRawBody}`)
      .digest('hex');
    expect(headers['X-Mindstone-Signature']).toBe(expectedSignature);

    const parsedCloudBody = JSON.parse(cloudRawBody) as {
      recallBotId: string;
      meetingTitle?: string;
      segments: Array<{
        segmentId: string;
        text: string;
        speaker: string | null;
        timestamp: number;
        isFinal: boolean;
        source: string;
      }>;
    };
    expect(parsedCloudBody.recallBotId).toBe('recall-bot-123');
    expect(parsedCloudBody.meetingTitle).toBe('Weekly sync');
    expect(parsedCloudBody.segments).toHaveLength(1);
    expect(parsedCloudBody.segments[0]).toMatchObject({
      text: 'hello team',
      speaker: 'Alex',
      isFinal: true,
      source: 'recall-bot',
    });
    const expectedSegmentId = createHash('sha256')
      .update(JSON.stringify({
        recallBotId: 'recall-bot-123',
        participantId: 42,
        participantName: 'Alex',
        words: ['hello', 'team'],
      }))
      .digest('hex');
    expect(parsedCloudBody.segments[0]?.segmentId).toBe(expectedSegmentId);
  });
});
