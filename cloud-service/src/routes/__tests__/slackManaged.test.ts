import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { handleSlackManagedInbound, handleSlackManagedProvisionTokens, __setSlackManagedRouteDepsForTesting } from '../slackManaged';
import { __setSlackWebhookRouteDepsForTesting } from '../slackWebhook';
import { RouteError } from '../../httpUtils';
import type { SlackWorkspaceRecord, SlackWorkspaceStore } from '../../services/slackWorkspaceStore';
import type { PendingInboundLog } from '../../services/slackPendingInboundLog';
import * as factory from '../../services/externalConversationServiceFactory';
import { SlackThreadAdapter } from '@core/services/externalConversation/adapters/slackThreadAdapter';
import { setStoreFactory, type StoreFactoryOptions } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { TestMemoryStore } from '@core/__tests__/TestMemoryStore';

describe('slackManaged routes', () => {
  let record: SlackWorkspaceRecord | null;
  let broadcasts: Array<{ channel: string; payload: unknown }>;
  let order: string[];
  let pendingLog: PendingInboundLog;
  let service: { createConversation: ReturnType<typeof vi.fn>; injectMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T00:00:00Z'));
    setStoreFactory(<T extends Record<string, unknown>>(opts: StoreFactoryOptions<T>) => new TestMemoryStore(opts) as unknown as KeyValueStore<T>);
    process.env.MINDSTONE_PROXY_SHARED_SECRET = 'proxy-secret';
    process.env.SLACK_SIGNING_SECRET = 'slack-secret';
    process.env.REBEL_CLOUD_TOKEN = 'route-token';
    record = connectedRecord();
    broadcasts = [];
    order = [];
    const markProcessed = vi.fn();
    pendingLog = {
      enqueue: vi.fn(() => order.push('enqueue')),
      markProcessed,
      drainUnprocessed: vi.fn(() => []),
      claimEventProcessing: vi.fn(() => ({ acquired: true as const, ownerToken: 'owner-token' })),
      releaseAfterSuccess: vi.fn(({ eventId }) => markProcessed(eventId)),
      markBroadcastDeferred: vi.fn(),
      tryResumeClaim: vi.fn(() => ({ acquired: true as const, ownerToken: 'owner-token' })),
    };
    service = { createConversation: vi.fn().mockResolvedValue({}), injectMessage: vi.fn().mockResolvedValue({}) };
    vi.spyOn(factory, 'getExternalConversationService').mockReturnValue(service as never);
    const slackAdapter = new SlackThreadAdapter({
      signingSecret: 'slack-secret',
      workspaceStore: workspaceStore(),
      broadcast: { sendToAllWindows: vi.fn(), sendToFocusedWindow: vi.fn() },
    });
    vi.spyOn(slackAdapter, 'enrichContextMetadata').mockImplementation(async (context) => context);
    factory.__setSlackThreadAdapterForTesting(slackAdapter);
    __setSlackManagedRouteDepsForTesting({ workspaceStore: workspaceStore(), broadcast: (channel, payload) => broadcasts.push({ channel, payload }) });
    __setSlackWebhookRouteDepsForTesting({
      pendingLog,
      workspaceStore: workspaceStore(),
      getSettings: () => ({ experimental: { slackCloudWebhookEnabled: true } } as never),
      hasOpenBroadcastClient: () => true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    factory.__setSlackThreadAdapterForTesting(null);
    __setSlackManagedRouteDepsForTesting(null);
    __setSlackWebhookRouteDepsForTesting(null);
    delete process.env.MINDSTONE_PROXY_SHARED_SECRET;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.REBEL_CLOUD_TOKEN;
  });

  function connectedRecord(): SlackWorkspaceRecord {
    return { teamId: 'T1', teamName: 'Acme', botUserId: 'UBOT', botToken: 'xoxb-token', installedAt: Date.now(), status: 'connected' };
  }

  function workspaceStore(): SlackWorkspaceStore {
    return {
      get: () => record,
      set: (next) => { record = next; },
      updateStatus: (status, lastError) => { if (record) record = { ...record, status, lastError }; },
      updateLastSeen: () => { if (record) record = { ...record, lastSeenAt: Date.now() }; },
      clear: () => { record = null; },
    };
  }

  function proxySignature(body: string): string {
    return crypto.createHmac('sha256', 'proxy-secret').update(body).digest('hex');
  }

  function slackSignature(rawBody: string, timestamp: string): string {
    return `v0=${crypto.createHmac('sha256', 'slack-secret').update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  }

  function req(body: unknown, headers: Record<string, string> = {}, method = 'POST'): IncomingMessage & { send: () => void } {
    const bodyText = JSON.stringify(body);
    let dataCb: ((chunk: Buffer) => void) | undefined;
    let endCb: (() => void) | undefined;
    return ({
      method,
      headers: { ...headers },
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === 'data') dataCb = cb as (chunk: Buffer) => void;
        if (event === 'end') endCb = cb as () => void;
      },
      destroy: vi.fn(),
      send() { dataCb?.(Buffer.from(bodyText)); endCb?.(); },
    } as unknown) as IncomingMessage & { send: () => void };
  }

  function res() {
    const out = { status: 0, body: '' };
    return {
      out,
      writeHead(status: number) { out.status = status; },
      end(body?: string) { order.push('ack'); out.body = body ?? ''; },
      setHeader: vi.fn(),
      getHeader: vi.fn(),
    } as unknown as ServerResponse & { out: typeof out };
  }

  async function call(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>, body: unknown, signatureBody?: unknown) {
    const bodyForSignature = JSON.stringify(signatureBody ?? body);
    const request = req(body, { 'x-mindstone-proxy-signature': proxySignature(bodyForSignature) });
    const response = res();
    const promise = handler(request, response);
    request.send();
    await promise;
    return response;
  }

  it('provision-tokens missing bearer is rejected by route auth', async () => {
    vi.resetModules();
    process.env.REBEL_CLOUD_TOKEN = 'route-token';
    const { authorize } = await import('../../auth');
    expect(authorize({ headers: {} } as IncomingMessage)).toBe(false);
  });

  it('provision-tokens rejects bad proxy HMAC', async () => {
    const request = req({ teamId: 'T1' }, { 'x-mindstone-proxy-signature': 'bad' });
    const response = res();
    const promise = handleSlackManagedProvisionTokens(request, response);
    request.send();
    await expect(promise).rejects.toMatchObject({ status: 401 });
  });

  it('provision-tokens success persists workspace and broadcasts', async () => {
    record = null;
    const body = { teamId: 'T2', teamName: 'Beta', teamDomain: 'beta', botUserId: 'UBOT2', botToken: 'xoxb-new', authedUserId: 'U1', installedAt: Date.now() };
    const response = await call(handleSlackManagedProvisionTokens, body);
    expect(response.out.status).toBe(200);
    expect(record).toMatchObject({ teamId: 'T2', teamName: 'Beta', status: 'connected' });
    expect(broadcasts[0]).toMatchObject({ channel: 'slack:workspace-changed' });
  });

  it('proxy HMAC verification uses timingSafeEqual', async () => {
    const timingSpy = vi.spyOn(crypto, 'timingSafeEqual');
    const body = { teamId: 'T2', teamName: 'Beta', teamDomain: 'beta', botUserId: 'UBOT2', botToken: 'xoxb-new', installedAt: Date.now() };
    const response = await call(handleSlackManagedProvisionTokens, body);
    expect(response.out.status).toBe(200);
    expect(timingSpy).toHaveBeenCalled();
  });

  it('provision-tokens rejects empty body', async () => {
    const request = req({}, { 'x-mindstone-proxy-signature': proxySignature(JSON.stringify({})) });
    const response = res();
    const promise = handleSlackManagedProvisionTokens(request, response);
    request.send();
    await expect(promise).rejects.toMatchObject({ status: 400 });
  });

  it('inbound missing bearer is rejected by route auth', async () => {
    vi.resetModules();
    process.env.REBEL_CLOUD_TOKEN = 'route-token';
    const { authorize } = await import('../../auth');
    expect(authorize({ headers: {} } as IncomingMessage)).toBe(false);
  });

  it('inbound rejects bad proxy HMAC', async () => {
    const request = req({ event_id: 'E1', raw_body: '{}', signature: 's', timestamp: '1' }, { 'x-mindstone-proxy-signature': 'bad' });
    const response = res();
    const promise = handleSlackManagedInbound(request, response);
    request.send();
    await expect(promise).rejects.toMatchObject({ status: 401 });
  });

  it('inbound bad Slack HMAC returns dropped 200', async () => {
    const rawBody = JSON.stringify({ team_id: 'T1', event_id: 'E1', event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: 'hi' } });
    const body = { event_id: 'E1', raw_body: rawBody, signature: 'v0=bad', timestamp: String(Math.floor(Date.now() / 1000)) };
    const response = await call(handleSlackManagedInbound, body);
    expect(response.out.status).toBe(200);
    expect(JSON.parse(response.out.body)).toEqual({ ok: true, dropped: true });
  });

  it('inbound success verifies adapter and dispatches conversation async', async () => {
    const rawBody = JSON.stringify({ team_id: 'T1', event_id: 'E2', event: { type: 'message', channel_type: 'im', channel: 'C1', ts: '100.000', user: 'U1', text: 'hi' } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = { event_id: 'E2', raw_body: rawBody, signature: slackSignature(rawBody, timestamp), timestamp };
    const response = await call(handleSlackManagedInbound, body);
    expect(response.out.status).toBe(200);
    await Promise.resolve();
    expect(service.createConversation).toHaveBeenCalled();
  });

  it('inbound self-mention is dropped without injectMessage', async () => {
    const rawBody = JSON.stringify({ team_id: 'T1', event_id: 'E-self', event: { type: 'message', channel_type: 'im', channel: 'C1', ts: '100.000', user: 'UBOT', text: 'hi' } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = { event_id: 'E-self', raw_body: rawBody, signature: slackSignature(rawBody, timestamp), timestamp };
    const response = await call(handleSlackManagedInbound, body);
    expect(response.out.status).toBe(200);
    expect(JSON.parse(response.out.body)).toEqual({ ok: true, dropped: true });
    expect(pendingLog.enqueue).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(service.injectMessage).not.toHaveBeenCalled();
  });

  it('inbound workspace-not-connected is dropped without enqueue', async () => {
    record = { ...connectedRecord(), status: 'needs_reconnect' };
    const rawBody = JSON.stringify({ team_id: 'T1', event_id: 'E-not-connected', event: { type: 'message', channel_type: 'im', channel: 'C1', ts: '100.000', user: 'U1', text: 'hi' } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = { event_id: 'E-not-connected', raw_body: rawBody, signature: slackSignature(rawBody, timestamp), timestamp };
    const response = await call(handleSlackManagedInbound, body);
    expect(response.out.status).toBe(200);
    expect(JSON.parse(response.out.body)).toEqual({ ok: true, dropped: true, reason: 'workspace_needs_reconnect' });
    expect(pendingLog.enqueue).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(service.injectMessage).not.toHaveBeenCalled();
  });

  it('inbound durable enqueue happens before 200 ack', async () => {
    const rawBody = JSON.stringify({ team_id: 'T1', event_id: 'E3', event: { type: 'message', channel_type: 'im', channel: 'C1', ts: '100.000', user: 'U1', text: 'hi' } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = { event_id: 'E3', raw_body: rawBody, signature: slackSignature(rawBody, timestamp), timestamp };
    await call(handleSlackManagedInbound, body);
    expect(order.slice(0, 2)).toEqual(['enqueue', 'ack']);
  });
});
