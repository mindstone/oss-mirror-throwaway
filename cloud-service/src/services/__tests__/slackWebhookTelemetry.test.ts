import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { dispatchSlackInboundRaw, __setSlackWebhookRouteDepsForTesting } from '../../routes/slackWebhook';
import * as factory from '../externalConversationServiceFactory';
import { TeamRateLimiter } from '../teamRateLimiter';
import { SlackThreadAdapter, type SlackWorkspaceStoreLike } from '@core/services/externalConversation/adapters/slackThreadAdapter';
import type { ExternalConversationService } from '@core/services/externalConversation/externalConversationService';
import type { KeyValueStore } from '@core/store';
import { setStoreFactory, type StoreFactoryOptions } from '@core/storeFactory';
import { TestMemoryStore } from '@core/__tests__/TestMemoryStore';
import type { PendingInboundLog } from '../slackPendingInboundLog';
import type { Logger } from '@core/logger';
import type { AppSettings } from '@shared/types';
import { hashTeamId } from '@shared/utils/teamIdHash';

interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  data: Record<string, unknown>;
  message: string;
}

interface MockResponseState {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

describe('slack webhook telemetry', () => {
  const signingSecret = 'test_secret';
  let logEntries: LogEntry[];
  let workspace: NonNullable<ReturnType<SlackWorkspaceStoreLike['get']>> | null;
  let pendingLog: PendingInboundLog;
  let service: { createConversation: ReturnType<typeof vi.fn>; injectMessage: ReturnType<typeof vi.fn> };
  let injectMessageMock: ReturnType<typeof vi.fn>;
  let slackAdapter: SlackThreadAdapter;
  let teamRateLimiter: TeamRateLimiter;

  beforeEach(() => {
    setStoreFactory(<T extends Record<string, unknown>>(opts: StoreFactoryOptions<T>) => new TestMemoryStore(opts) as unknown as KeyValueStore<T>);
    logEntries = [];
    workspace = {
      teamId: 'T1',
      teamName: 'Acme',
      botUserId: 'UBOT',
      botToken: 'xoxb-token',
      installedAt: Date.now(),
      status: 'connected',
    };
    const markProcessed = vi.fn();
    pendingLog = {
      enqueue: vi.fn(),
      markProcessed,
      drainUnprocessed: vi.fn(() => []),
      claimEventProcessing: vi.fn(() => ({ acquired: true as const, ownerToken: 'owner-token' })),
      releaseAfterSuccess: vi.fn(({ eventId }) => markProcessed(eventId)),
      markBroadcastDeferred: vi.fn(),
      tryResumeClaim: vi.fn(() => ({ acquired: true as const, ownerToken: 'owner-token' })),
    };
    injectMessageMock = vi.fn().mockResolvedValue(undefined);
    service = {
      createConversation: vi.fn().mockResolvedValue(undefined),
      injectMessage: injectMessageMock,
    };
    teamRateLimiter = new TeamRateLimiter({ now: () => 0 });
    slackAdapter = new SlackThreadAdapter({
      signingSecret,
      workspaceStore: workspaceStore(),
      log: testLogger(),
    });
    vi.spyOn(slackAdapter, 'enrichContextMetadata').mockImplementation(async (context) => context);
    vi.spyOn(factory, 'getExternalConversationService').mockReturnValue(service as unknown as ExternalConversationService);
    factory.__setSlackThreadAdapterForTesting(slackAdapter);
    __setSlackWebhookRouteDepsForTesting({
      pendingLog,
      workspaceStore: workspaceStore(),
      getSettings: () => ({ experimental: { slackCloudWebhookEnabled: true, slackInboundThreadHistory: false } } as AppSettings),
      log: testLogger(),
      broadcast: vi.fn(),
      hasOpenBroadcastClient: () => true,
      pendingDeliveries: { cancelByTeamId: vi.fn() },
      teamRateLimiter,
    });
  });

  afterEach(() => {
    factory.__setSlackThreadAdapterForTesting(null);
    __setSlackWebhookRouteDepsForTesting(null);
    vi.restoreAllMocks();
  });

  function workspaceStore(): SlackWorkspaceStoreLike {
    return {
      get: () => workspace,
      set: (record) => { workspace = record; },
      updateStatus: (status, lastError) => { if (workspace) workspace = { ...workspace, status, lastError }; },
      updateLastSeen: () => { if (workspace) workspace = { ...workspace, lastSeenAt: Date.now() }; },
      clear: () => { workspace = null; },
    };
  }

  function testLogger(): Logger {
    const push = (level: LogEntry['level']) => (data: unknown, message?: string) => {
      logEntries.push({
        level,
        data: typeof data === 'object' && data !== null ? data as Record<string, unknown> : {},
        message: message ?? String(data),
      });
    };
    return {
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
    } as unknown as Logger;
  }

  function createResponse(): { res: ServerResponse; state: MockResponseState } {
    const state: MockResponseState = { status: 0, body: undefined, headers: {} };
    const res = {
      setHeader(name: string, value: number | string) {
        state.headers[name] = String(value);
      },
      getHeader(name: string) {
        return state.headers[name];
      },
      writeHead(status: number, headers?: Record<string, string>) {
        state.status = status;
        state.headers = { ...state.headers, ...(headers ?? {}) };
      },
      end(body?: string | Buffer) {
        if (body) {
          state.body = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body);
        }
      },
    } as unknown as ServerResponse;
    return { res, state };
  }

  function signedHeaders(rawBody: Buffer, secret = signingSecret, badSignature = false) {
    const timestamp = Math.floor(Date.now() / 1000);
    const sigBasestring = `v0:${timestamp}:${rawBody.toString('utf8')}`;
    const signature = `v0=${crypto.createHmac('sha256', secret).update(sigBasestring).digest('hex')}`;
    return {
      get(name: string) {
        if (name === 'x-slack-request-timestamp') return String(timestamp);
        if (name === 'x-slack-signature') return badSignature ? 'v0=bad' : signature;
        return null;
      },
    };
  }

  async function dispatch(payload: unknown, options: { badSignature?: boolean } = {}) {
    const rawBody = Buffer.from(JSON.stringify(payload));
    const { res, state } = createResponse();
    await dispatchSlackInboundRaw({
      rawBody,
      headers: signedHeaders(rawBody, signingSecret, options.badSignature),
      res,
      returnSlackAuthFailureAsDropped: false,
    });
    return state;
  }

  async function dispatchWithIp(payload: unknown, ip: string, options: { badSignature?: boolean } = {}) {
    const rawBody = Buffer.from(JSON.stringify(payload));
    const { res, state } = createResponse();
    await dispatchSlackInboundRaw({
      rawBody,
      headers: signedHeaders(rawBody, signingSecret, options.badSignature),
      req: {
        headers: { 'x-forwarded-for': ip },
        socket: { remoteAddress: ip },
      } as never,
      res,
      returnSlackAuthFailureAsDropped: false,
    });
    return state;
  }

  async function flushAsyncProcessing(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  function event(name: string): LogEntry {
    const entry = logEntries.find((candidate) => candidate.data['event'] === name);
    if (!entry) throw new Error(`missing log event ${name}`);
    return entry;
  }

  it('logs received and dispatched lifecycle events for a valid signed webhook', async () => {
    const payload = {
      team_id: 'T1',
      event_id: 'E-valid',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello' },
    };
    const state = await dispatch(payload);
    await flushAsyncProcessing();

    expect(state.status).toBe(200);
    expect(event('slack_webhook_received').data).toMatchObject({
      teamIdHash: hashTeamId('T1'),
      eventId: 'E-valid',
      eventType: 'message',
      channelType: 'channel',
      payloadBytes: Buffer.byteLength(JSON.stringify(payload)),
    });
    expect(event('slack_webhook_dispatched').data).toMatchObject({
      teamIdHash: hashTeamId('T1'),
      eventId: 'E-valid',
      isNewConversation: true,
    });
    expect(typeof event('slack_webhook_dispatched').data['conversationId']).toBe('string');
    expect(Number(event('slack_webhook_dispatched').data['durationMs'])).toBeGreaterThan(0);
    expect(JSON.stringify(event('slack_webhook_dispatched').data)).not.toContain('teamId":"T1');
    expect(logEntries.findIndex((entry) => entry.data['event'] === 'slack_webhook_received'))
      .toBeLessThan(logEntries.findIndex((entry) => entry.data['event'] === 'slack_webhook_dispatched'));
  });

  it('logs received then signature failure without logging raw signature data', async () => {
    const payload = {
      team_id: 'T1',
      event_id: 'E-bad-signature',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: 'hello' },
    };

    await expect(dispatch(payload, { badSignature: true })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(event('slack_webhook_received').data['teamIdHash']).toBe(hashTeamId('T1'));
    expect(event('slack_signature_failure').data).toMatchObject({
      teamIdHash: hashTeamId('T1'),
      code: 'SIGNATURE_MISMATCH',
    });
    expect(JSON.stringify(logEntries)).not.toContain('v0=bad');
  });

  it('logs async processing failures with redacted error details', async () => {
    injectMessageMock.mockRejectedValue(new Error('Slack failed with bot_token=xoxb-secret-token and signature v0=abcdef1234567890'));
    const state = await dispatch({
      team_id: 'T1',
      event_id: 'E-async-error',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello' },
    });
    await flushAsyncProcessing();

    expect(state.status).toBe(200);
    expect(event('slack_webhook_async_error').data).toMatchObject({
      teamIdHash: hashTeamId('T1'),
      eventId: 'E-async-error',
      phase: 'processAsync',
    });
    expect(Number(event('slack_webhook_async_error').data['durationMs'])).toBeGreaterThan(0);
    expect(JSON.stringify(event('slack_webhook_async_error').data)).not.toContain('xoxb-secret-token');
    expect(JSON.stringify(event('slack_webhook_async_error').data)).not.toContain('abcdef1234567890');
  });

  it('logs team-keyed rate limiting and returns 429 after the 60-request burst', async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const state = await dispatch({
        team_id: 'T1',
        event_id: `E-rate-${index}`,
        event: { type: 'message', channel: 'C1', ts: `100.${index}`, user: 'U1', text: 'hello' },
      });
      statuses.push(state.status);
    }

    expect(statuses.filter((status) => status === 200)).toHaveLength(60);
    expect(statuses.filter((status) => status === 429)).toHaveLength(40);
    expect(event('slack_webhook_rate_limited').data).toMatchObject({
      teamIdHash: hashTeamId('T1'),
      scope: 'verified_team',
      retryAfter: 1,
    });
  });

  it('pre-verification IP limit catches spoofed team bursts without growing team buckets', async () => {
    teamRateLimiter = new TeamRateLimiter();
    __setSlackWebhookRouteDepsForTesting({
      pendingLog,
      workspaceStore: workspaceStore(),
      getSettings: () => ({ experimental: { slackCloudWebhookEnabled: true } } as AppSettings),
      log: testLogger(),
      broadcast: vi.fn(),
      hasOpenBroadcastClient: () => true,
      pendingDeliveries: { cancelByTeamId: vi.fn() },
      teamRateLimiter,
      preVerifyIpRateLimiter: new TeamRateLimiter({ refillPerSecond: 1, burstCapacity: 2 }),
    });

    const statuses: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const state = await dispatchWithIp({
        team_id: `T-spoof-${index}`,
        event_id: `E-spoof-${index}`,
        event: { type: 'message', channel: 'C1', ts: `100.${index}`, user: 'U1', text: 'hello' },
      }, '203.0.113.10', { badSignature: true }).catch((err: unknown) => {
        if (err && typeof err === 'object' && 'status' in err) {
          return { status: Number((err as { status: unknown }).status), body: undefined, headers: {} };
        }
        throw err;
      });
      statuses.push(state.status);
    }

    expect(statuses.filter((status) => status === 429)).toHaveLength(3);
    expect(teamRateLimiter.getBucketCountForTesting()).toBe(0);
    expect(event('slack_webhook_rate_limited').data).toMatchObject({
      scope: 'pre_verify_ip',
      ip: '203.0.113.10',
    });
  });

  it('never logs Slack signature or signing secret values', async () => {
    process.env.SLACK_SIGNING_SECRET = signingSecret;
    await dispatch({
      team_id: 'T1',
      event_id: 'E-no-secret-logs',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: 'hello' },
    });
    await flushAsyncProcessing();

    const serialized = JSON.stringify(logEntries);
    expect(serialized).not.toContain('x-slack-signature');
    expect(serialized).not.toContain('v0=');
    expect(serialized).not.toContain(signingSecret);
  });
});
