import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StoreFactory } from '@core/storeFactory';
import { SlackOAuthStartResponseSchema, SlackWorkspaceNullableResponseSchema } from '@rebel/shared';
import { SLACK_BOT_SCOPES, SLACK_USER_SCOPES } from '@shared/utils/slackOAuthScopes';
import {
  handleSlackOAuthCallback,
  handleSlackOAuthStart,
  handleSlackOAuthStartManaged,
  handleSlackWorkspaceDelete,
  handleSlackWorkspaceGet,
  __setSlackOAuthRouteDepsForTesting,
} from '../slackOAuth';
import { createSlackOAuthStateStore, SLACK_OAUTH_MAX_ACTIVE_STATES, SLACK_OAUTH_STATE_TTL_MS } from '../../services/slackOAuthStateStore';
import type { SlackWorkspaceRecord, SlackWorkspaceStore } from '../../services/slackWorkspaceStore';
import type { SlackByokCredentials, SlackByokCredentialsStore } from '../../services/slackByokCredentialsStore';

type CancelByTeamIdMock = ReturnType<typeof vi.fn> & ((teamId: string) => void);

describe('slackOAuth route', () => {
  let tempDir: string;
  let storeFactory: StoreFactory;
  let stateStore: ReturnType<typeof createSlackOAuthStateStore>;
  let record: SlackWorkspaceRecord | null;
  let byokCredentials: SlackByokCredentials | null;
  let throwOnSet = false;
  let broadcasts: Array<{ channel: string; payload: unknown }>;
  let cancelByTeamId: CancelByTeamIdMock;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T00:00:00Z'));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-oauth-route-'));
    storeFactory = ((opts) => ({
      path: path.join(tempDir, `${opts.name}.json`),
      get: () => undefined, set: () => undefined, has: () => false,
      delete: () => undefined, clear: () => undefined, store: {},
    })) as StoreFactory;
    stateStore = createSlackOAuthStateStore({ storeFactory });
    record = null;
    byokCredentials = null;
    throwOnSet = false;
    broadcasts = [];
    cancelByTeamId = vi.fn() as CancelByTeamIdMock;
    __setSlackOAuthRouteDepsForTesting({
      stateStore,
      workspaceStore: workspaceStore(),
      byokCredentialsStore: byokStore(),
      fetchImpl: vi.fn(),
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      pendingDeliveries: { cancelByTeamId },
    });
  });

  afterEach(() => {
    __setSlackOAuthRouteDepsForTesting(null);
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.REBEL_CLOUD_TOKEN;
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;
    vi.resetModules();
  });

  function workspaceStore(): SlackWorkspaceStore {
    return {
      get: () => record,
      set: (next) => { if (throwOnSet) throw new Error('disk full'); record = next; },
      updateStatus: (status) => { if (record) record = { ...record, status }; },
      updateLastSeen: () => { if (record) record = { ...record, lastSeenAt: Date.now() }; },
      clear: () => { record = null; },
    };
  }

  function byokStore(): SlackByokCredentialsStore {
    return {
      get: async () => byokCredentials,
      set: async (next) => { byokCredentials = next; },
      clear: async () => { byokCredentials = null; },
    };
  }

  function req(bodyOrUrl: unknown, method = 'POST', headers: Record<string, string> = {}): IncomingMessage & { send?: () => void } {
    const requestHeaders = { host: 'cloud.example', 'x-forwarded-proto': 'https', ...headers };
    if (typeof bodyOrUrl === 'string') return { method, url: bodyOrUrl, headers: requestHeaders } as unknown as IncomingMessage;
    const body = JSON.stringify(bodyOrUrl);
    let dataCb: ((chunk: Buffer) => void) | undefined;
    let endCb: (() => void) | undefined;
    return ({
      method,
      url: '/api/integrations/slack/oauth/start',
      headers: requestHeaders,
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === 'data') dataCb = cb as (chunk: Buffer) => void;
        if (event === 'end') endCb = cb as () => void;
      },
      send() { dataCb?.(Buffer.from(body)); endCb?.(); },
    } as unknown) as IncomingMessage & { send: () => void };
  }

  function res() {
    const out = { status: 0, body: '', headers: {} as Record<string, string> };
    return {
      out,
      writeHead(status: number, headers?: Record<string, string>) { out.status = status; out.headers = headers ?? {}; },
      end(body?: string) { out.body = body ?? ''; },
      setHeader: vi.fn(),
      getHeader: vi.fn(),
    } as unknown as ServerResponse & { out: typeof out };
  }

  async function start(body: { clientId: string; clientSecret: string; signingSecret: string; redirectUri?: string } = { clientId: '123.456', clientSecret: 'client-secret', signingSecret: 'signing-secret' }) {
    const response = res();
    const request = req(body);
    const promise = handleSlackOAuthStart(request, response);
    request.send?.();
    await promise;
    return { response, json: JSON.parse(response.out.body) as { authUrl?: string; state?: string; error?: { code: string } } };
  }

  async function startManaged(body: { redirectUri?: string } = {}) {
    process.env.SLACK_CLIENT_ID = 'managed-cid';
    process.env.SLACK_CLIENT_SECRET = 'managed-secret';
    const response = res();
    const request = req(body);
    const promise = handleSlackOAuthStartManaged(request, response);
    request.send?.();
    await promise;
    return { response, json: JSON.parse(response.out.body) as { authUrl?: string; state?: string; error?: { code: string } } };
  }

  async function dispatchSlackRoute(
    routePath: string,
    method: 'GET' | 'POST' | 'DELETE',
    body: unknown,
    authorization?: string,
  ) {
    process.env.REBEL_CLOUD_TOKEN = 'route-token';
    vi.resetModules();
    const { authorize } = await import('../../auth');
    const response = res();
    const request = typeof body === 'string'
      ? req(body, method, authorization ? { authorization } : {})
      : req(body, method, authorization ? { authorization } : {});
    if (typeof body !== 'string') request.url = routePath;

    if (routePath === '/api/integrations/slack/oauth/callback') {
      await handleSlackOAuthCallback(request, response);
      return response;
    }

    if (!authorize(request)) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing bearer token' } }));
      return response;
    }

    if (routePath === '/api/integrations/slack/oauth/start') {
      const promise = handleSlackOAuthStart(request, response);
      request.send?.();
      await promise;
      return response;
    }
    if (routePath === '/api/integrations/slack/oauth/start/managed') {
      const promise = handleSlackOAuthStartManaged(request, response);
      request.send?.();
      await promise;
      return response;
    }
    if (routePath === '/api/integrations/slack/workspace') {
      if (method === 'GET') await handleSlackWorkspaceGet(request, response);
      else if (method === 'DELETE') await handleSlackWorkspaceDelete(request, response);
      else throw new Error('Method Not Allowed');
      return response;
    }
    throw new Error(`Unhandled test route: ${routePath}`);
  }

  function seedState(state = 'state1', createdAt = Date.now(), provisionMode: 'managed' | 'byok' = 'byok') {
    if (provisionMode === 'byok') {
      byokCredentials = {
        clientId: 'cid',
        clientSecret: 'client-secret',
        signingSecret: 'signing-secret',
        installedAt: new Date(Date.now()).toISOString(),
      };
    }
    stateStore.put({
      state,
      clientId: 'cid',
      clientSecret: 'client-secret',
      oauthCredentials: provisionMode === 'byok'
        ? { clientId: 'cid', clientSecret: 'client-secret', signingSecret: 'signing-secret' }
        : null,
      provisionMode,
      createdAt,
    });
  }

  function oauthFetch(teamName = 'Acme') {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, access_token: 'xoxb-token', bot_user_id: 'UBOT', team: { id: 'T1', name: teamName, domain: 'acme' }, authed_user: { id: 'U1' } }),
    } as Response);
    __setSlackOAuthRouteDepsForTesting({ stateStore, workspaceStore: workspaceStore(), byokCredentialsStore: byokStore(), fetchImpl, broadcast: (channel, payload) => broadcasts.push({ channel, payload }) });
    return fetchImpl;
  }

  it('start returns authUrl and persists state', async () => {
    const { json } = await start();
    const authUrl = new URL(json.authUrl!);
    expect(authUrl.hostname).toBe('slack.com');
    expect(authUrl.searchParams.get('redirect_uri')).toBe('https://cloud.example/api/integrations/slack/oauth/callback');
    expect(json.state).toBe(authUrl.searchParams.get('state'));
    expect(SlackOAuthStartResponseSchema.parse(json)).toEqual({
      authUrl: json.authUrl,
      state: json.state,
    });
    expect(stateStore.consume(json.state!).status).toBe('ok');
  });

  it('managed start uses deploy-time credentials and returns the shared client schema shape', async () => {
    const { json } = await startManaged();
    const parsed = SlackOAuthStartResponseSchema.parse(json);
    const authUrl = new URL(parsed.authUrl);

    expect(authUrl.searchParams.get('client_id')).toBe('managed-cid');
    expect(authUrl.searchParams.get('state')).toBe(parsed.state);
    const consumed = stateStore.consume(parsed.state);
    expect(consumed.status).toBe('ok');
    if (consumed.status === 'ok') {
      expect(consumed.record.clientId).toBe('managed-cid');
      expect(consumed.record.clientSecret).toBe('managed-secret');
    }
  });

  it('managed start returns 503 when deploy-time credentials are missing', async () => {
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;
    const response = res();
    const request = req({});
    const promise = handleSlackOAuthStartManaged(request, response);
    request.send?.();

    await expect(promise).rejects.toMatchObject({ status: 503 });
  });

  it('start rejects missing bearer auth at the route layer', async () => {
    const response = await dispatchSlackRoute('/api/integrations/slack/oauth/start', 'POST', { clientId: 'cid', clientSecret: 'secret', signingSecret: 'signing-secret' });
    expect(response.out.status).toBe(401);
    expect(JSON.parse(response.out.body)).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or missing bearer token' },
    });
  });

  it('delete workspace rejects missing bearer auth at the route layer', async () => {
    const response = await dispatchSlackRoute('/api/integrations/slack/workspace', 'DELETE', {});
    expect(response.out.status).toBe(401);
    expect(JSON.parse(response.out.body)).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or missing bearer token' },
    });
  });

  it('get workspace returns null when no workspace exists', async () => {
    const response = res();
    await handleSlackWorkspaceGet(req('/api/integrations/slack/workspace', 'GET'), response);

    expect(response.out.status).toBe(200);
    expect(SlackWorkspaceNullableResponseSchema.parse(JSON.parse(response.out.body))).toBeNull();
  });

  it('get workspace returns the connected workspace client shape', async () => {
    record = {
      teamId: 'T1',
      teamName: 'Acme',
      botUserId: 'UBOT',
      botToken: 'xoxb-token',
      installedAt: Date.now(),
      lastSeenAt: Date.parse('2026-05-03T12:00:00.000Z'),
      status: 'connected',
    };
    const response = res();
    await handleSlackWorkspaceGet(req('/api/integrations/slack/workspace', 'GET'), response);

    expect(SlackWorkspaceNullableResponseSchema.parse(JSON.parse(response.out.body))).toEqual({
      teamId: 'T1',
      teamName: 'Acme',
      status: 'connected',
      lastSeenAt: '2026-05-03T12:00:00.000Z',
    });
  });

  it('workspace route rejects methods other than GET and DELETE', async () => {
    await expect(handleSlackWorkspaceGet(req('/api/integrations/slack/workspace', 'POST'), res())).rejects.toMatchObject({ status: 405 });
    await expect(handleSlackWorkspaceDelete(req('/api/integrations/slack/workspace', 'POST'), res())).rejects.toMatchObject({ status: 405 });
  });

  it('auth URL scopes match the desktop Slack OAuth scope set exactly', async () => {
    const { json } = await start();
    const authUrl = new URL(json.authUrl!);
    expect(new Set(authUrl.searchParams.get('scope')?.split(',') ?? [])).toEqual(new Set(SLACK_BOT_SCOPES));
    expect(new Set(authUrl.searchParams.get('user_scope')?.split(',') ?? [])).toEqual(new Set(SLACK_USER_SCOPES));
  });

  it('BYOK start with all credentials binds them to state without replacing the active BYOK store', async () => {
    byokCredentials = {
      clientId: '111.222',
      clientSecret: 'previous-secret',
      signingSecret: 'previous-signing-secret',
      installedAt: '2026-05-02T00:00:00.000Z',
    };
    const { json } = await start({
      clientId: '123.456',
      clientSecret: 'client-secret',
      signingSecret: 'signing-secret',
    });
    const authUrl = new URL(json.authUrl!);

    expect(json.state).toBe(authUrl.searchParams.get('state'));
    expect(authUrl.searchParams.get('client_id')).toBe('123.456');
    const consumed = stateStore.consume(json.state!);
    expect(consumed.status).toBe('ok');
    if (consumed.status !== 'ok') throw new Error('expected state');
    expect(consumed.record.oauthCredentials).toEqual({
      clientId: '123.456',
      clientSecret: 'client-secret',
      signingSecret: 'signing-secret',
    });
    expect(byokCredentials).toEqual({
      clientId: '111.222',
      clientSecret: 'previous-secret',
      signingSecret: 'previous-signing-secret',
      installedAt: '2026-05-02T00:00:00.000Z',
    });
  });

  it('BYOK start rejects missing signing secret with 400', async () => {
    const response = res();
    const request = req({ clientId: '123.456', clientSecret: 'client-secret' });
    const promise = handleSlackOAuthStart(request, response);
    request.send?.();

    await promise;
    expect(response.out.status).toBe(400);
    expect(JSON.parse(response.out.body)).toEqual({
      error: 'INVALID_FIELD',
      field: 'signingSecret',
      message: 'Required',
    });
    expect(byokCredentials).toBeNull();
  });

  it('BYOK start rejects invalid client ID with a field-specific 400', async () => {
    const response = res();
    const request = req({ clientId: 'not-valid', clientSecret: 'client-secret', signingSecret: 'signing-secret' });
    const promise = handleSlackOAuthStart(request, response);
    request.send?.();

    await promise;

    expect(response.out.status).toBe(400);
    expect(JSON.parse(response.out.body)).toEqual({
      error: 'INVALID_FIELD',
      field: 'clientId',
      message: 'Client ID looks like 12345.67890',
    });
  });

  it('start with full state store returns 429', async () => {
    for (let i = 0; i < SLACK_OAUTH_MAX_ACTIVE_STATES; i += 1) seedState(`s${i}`);
    const { response, json } = await start();
    expect(response.out.status).toBe(429);
    expect(json.error?.code).toBe('SLACK_OAUTH_STATE_STORE_FULL');
  });

  it('callback with unknown state returns error HTML and no side effects', async () => {
    const response = res();
    await handleSlackOAuthCallback(req('/api/integrations/slack/oauth/callback?code=c&state=missing'), response);
    expect(response.out.body).toContain('Authorization expired or invalid');
    expect(record).toBeNull();
  });

  it('callback with expired state returns error HTML and no side effects', async () => {
    seedState('old', Date.now() - SLACK_OAUTH_STATE_TTL_MS - 1);
    const response = res();
    await handleSlackOAuthCallback(req('/api/integrations/slack/oauth/callback?code=c&state=old'), response);
    expect(response.out.body).toContain('Authorization expired or invalid');
    expect(record).toBeNull();
  });

  it('callback with reused state returns error HTML', async () => {
    seedState('s1');
    stateStore.consume('s1');
    const response = res();
    await handleSlackOAuthCallback(req('/api/integrations/slack/oauth/callback?code=c&state=s1'), response);
    expect(response.out.body).toContain('Authorization expired or invalid');
  });

  it('callback success persists workspace and broadcasts changed', async () => {
    seedState('s1');
    const fetchImpl = oauthFetch();
    const response = res();
    await handleSlackOAuthCallback(req('/api/integrations/slack/oauth/callback?code=c&state=s1'), response);
    expect(fetchImpl).toHaveBeenCalledWith('https://slack.com/api/oauth.v2.access', expect.any(Object));
    expect(record?.teamId).toBe('T1');
    expect(broadcasts[0].channel).toBe('slack:workspace-changed');
  });

  it('BYOK callback uses credentials embedded in the OAuth state instead of env or latest store credentials', async () => {
    process.env.SLACK_CLIENT_ID = 'env-cid';
    process.env.SLACK_CLIENT_SECRET = 'env-secret';
    stateStore.put({
      state: 's-byok',
      clientId: 'state-cid',
      clientSecret: 'state-secret',
      oauthCredentials: {
        clientId: 'state-cid',
        clientSecret: 'state-secret',
        signingSecret: 'state-signing-secret',
      },
      provisionMode: 'byok',
      createdAt: Date.now(),
    });
    byokCredentials = {
      clientId: 'latest-cid',
      clientSecret: 'latest-secret',
      signingSecret: 'latest-signing-secret',
      installedAt: '2026-05-03T00:00:00.000Z',
    };
    const fetchImpl = oauthFetch();

    const response = res();
    await handleSlackOAuthCallback(req('/api/integrations/slack/oauth/callback?code=c&state=s-byok'), response);

    const body = (fetchImpl.mock.calls[0][1] as RequestInit).body as URLSearchParams;
    expect(body.get('client_id')).toBe('state-cid');
    expect(body.get('client_secret')).toBe('state-secret');
    expect(body.get('client_id')).not.toBe('env-cid');
    expect(record?.provisionMode).toBe('byok');
    expect(byokCredentials).toMatchObject({
      clientId: 'state-cid',
      clientSecret: 'state-secret',
      signingSecret: 'state-signing-secret',
    });
  });

  it('BYOK callback fails closed when credentials are missing', async () => {
    stateStore.put({
      state: 's-missing-byok',
      clientId: 'cid',
      clientSecret: 'client-secret',
      oauthCredentials: null,
      provisionMode: 'byok',
      createdAt: Date.now(),
    });
    byokCredentials = null;
    const fetchImpl = vi.fn();
    __setSlackOAuthRouteDepsForTesting({
      stateStore,
      workspaceStore: workspaceStore(),
      byokCredentialsStore: byokStore(),
      fetchImpl,
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    });

    const response = res();
    await handleSlackOAuthCallback(req('/api/integrations/slack/oauth/callback?code=c&state=s-missing-byok'), response);

    expect(response.out.status).toBe(400);
    expect(JSON.parse(response.out.body)).toEqual({
      error: {
        code: 'BYOK_NOT_INITIALISED',
        message: 'Slack BYOK credentials are missing. Start setup again.',
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('public callback is accepted without bearer auth', async () => {
    seedState('s1');
    oauthFetch();
    const response = await dispatchSlackRoute('/api/integrations/slack/oauth/callback', 'GET', '/api/integrations/slack/oauth/callback?code=c&state=s1');
    expect(response.out.status).toBe(200);
    expect(response.out.body).toContain('Slack connected');
    expect(record?.teamId).toBe('T1');
  });

  it('supports concurrent OAuth states without one callback invalidating the other', async () => {
    const first = await start({
      clientId: '111.222',
      clientSecret: 'first-client-secret',
      signingSecret: 'first-signing-secret',
    });
    const second = await start({
      clientId: '333.444',
      clientSecret: 'second-client-secret',
      signingSecret: 'second-signing-secret',
    });
    const firstState = new URL(first.json.authUrl!).searchParams.get('state')!;
    const secondState = new URL(second.json.authUrl!).searchParams.get('state')!;
    expect(firstState).not.toBe(secondState);

    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ ok: true, access_token: 'xoxb-token-1', bot_user_id: 'UBOT1', team: { id: 'T1', name: 'Acme', domain: 'acme' }, authed_user: { id: 'U1' } }),
      } as Response)
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ ok: true, access_token: 'xoxb-token-2', bot_user_id: 'UBOT2', team: { id: 'T2', name: 'Beta', domain: 'beta' }, authed_user: { id: 'U2' } }),
      } as Response);
    __setSlackOAuthRouteDepsForTesting({ stateStore, workspaceStore: workspaceStore(), byokCredentialsStore: byokStore(), fetchImpl, broadcast: (channel, payload) => broadcasts.push({ channel, payload }) });

    const firstResponse = res();
    await handleSlackOAuthCallback(req(`/api/integrations/slack/oauth/callback?code=c1&state=${firstState}`, 'GET'), firstResponse);
    expect(firstResponse.out.status).toBe(200);
    expect(record?.teamName).toBe('Acme');
    expect(byokCredentials).toMatchObject({
      clientId: '111.222',
      clientSecret: 'first-client-secret',
      signingSecret: 'first-signing-secret',
    });

    const secondResponse = res();
    await handleSlackOAuthCallback(req(`/api/integrations/slack/oauth/callback?code=c2&state=${secondState}`, 'GET'), secondResponse);
    expect(secondResponse.out.status).toBe(200);
    expect(record?.teamName).toBe('Beta');
    expect(record?.botToken).toBe('xoxb-token-2');
    expect(byokCredentials).toMatchObject({
      clientId: '333.444',
      clientSecret: 'second-client-secret',
      signingSecret: 'second-signing-secret',
    });
  });

  it('ignores malicious non-mindstone return URIs', async () => {
    const { json } = await start({ clientId: '123.456', clientSecret: 'client-secret', signingSecret: 'signing-secret', redirectUri: 'http://evil.com/steal' });
    const authUrl = new URL(json.authUrl!);
    expect(authUrl.searchParams.get('redirect_uri')).toBe('https://cloud.example/api/integrations/slack/oauth/callback');
    oauthFetch();
    const response = res();
    await handleSlackOAuthCallback(req(`/api/integrations/slack/oauth/callback?code=c&state=${authUrl.searchParams.get('state')!}`, 'GET'), response);
    expect(response.out.status).toBe(200);
    expect(response.out.body).not.toContain('evil.com');
    expect(response.out.body).not.toContain('Return to Rebel</a>');
  });

  it('renders a return link for allowed mindstone return URIs', async () => {
    const { json } = await start({ clientId: '123.456', clientSecret: 'client-secret', signingSecret: 'signing-secret', redirectUri: 'mindstone://slack/connected?from=cloud' });
    const authUrl = new URL(json.authUrl!);
    expect(authUrl.searchParams.get('redirect_uri')).toBe('https://cloud.example/api/integrations/slack/oauth/callback');
    oauthFetch();
    const response = res();
    await handleSlackOAuthCallback(req(`/api/integrations/slack/oauth/callback?code=c&state=${authUrl.searchParams.get('state')!}`, 'GET'), response);
    expect(response.out.body).toContain('href="mindstone://slack/connected?from=cloud"');
  });

  it('omits the return link when no return URI was provided', async () => {
    const { json } = await start();
    const authUrl = new URL(json.authUrl!);
    oauthFetch();
    const response = res();
    await handleSlackOAuthCallback(req(`/api/integrations/slack/oauth/callback?code=c&state=${authUrl.searchParams.get('state')!}`, 'GET'), response);
    expect(response.out.status).toBe(200);
    expect(response.out.body).not.toContain('Return to Rebel</a>');
  });

  it('renders success and persists workspace when callback broadcast fails', async () => {
    seedState('s1');
    const fetchImpl = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, access_token: 'xoxb-token', bot_user_id: 'UBOT', team: { id: 'T1', name: 'Acme', domain: 'acme' }, authed_user: { id: 'U1' } }),
    } as Response);
    __setSlackOAuthRouteDepsForTesting({
      stateStore,
      workspaceStore: workspaceStore(),
      byokCredentialsStore: byokStore(),
      fetchImpl,
      broadcast: () => { throw new Error('push channel unavailable'); },
    });
    const response = res();
    await handleSlackOAuthCallback(req('/api/integrations/slack/oauth/callback?code=c&state=s1', 'GET'), response);
    expect(response.out.status).toBe(200);
    expect(response.out.body).toContain('Slack connected');
    expect(record?.teamId).toBe('T1');
  });

  it('callback success page does not render raw Slack team HTML', async () => {
    seedState('s1');
    oauthFetch('<script>alert(1)</script>');
    const response = res();
    await handleSlackOAuthCallback(req('/api/integrations/slack/oauth/callback?code=c&state=s1'), response);
    expect(response.out.body).not.toContain('<script>');
  });

  it('callback workspace write failure returns error HTML and no partial workspace', async () => {
    seedState('s1');
    throwOnSet = true;
    oauthFetch();
    const response = res();
    await handleSlackOAuthCallback(req('/api/integrations/slack/oauth/callback?code=c&state=s1'), response);
    expect(response.out.body).toContain("couldn't store it");
    expect(record).toBeNull();
    expect(stateStore.consume('s1')).toEqual({ status: 'missing' });
  });

  it('disconnect is idempotent when no workspace exists', async () => {
    const response = res();
    await handleSlackWorkspaceDelete(req({}, 'DELETE'), response);
    expect(JSON.parse(response.out.body)).toEqual({ ok: true });
  });

  it('disconnect revoke failure does not block clearing', async () => {
    record = { teamId: 'T1', teamName: 'Acme', botUserId: 'UBOT', botToken: 'xoxb-token', installedAt: Date.now(), status: 'connected' };
    __setSlackOAuthRouteDepsForTesting({ stateStore, workspaceStore: workspaceStore(), byokCredentialsStore: byokStore(), fetchImpl: vi.fn().mockRejectedValue(new Error('nope')), broadcast: (channel, payload) => broadcasts.push({ channel, payload }) });
    const response = res();
    await handleSlackWorkspaceDelete(req({}, 'DELETE'), response);
    expect(record).toBeNull();
    expect(JSON.parse(response.out.body)).toEqual({ ok: true });
  });

  it('disconnect broadcasts changed before disconnected', async () => {
    record = { teamId: 'T1', teamName: 'Acme', botUserId: 'UBOT', botToken: 'xoxb-token', installedAt: Date.now(), status: 'connected' };
    __setSlackOAuthRouteDepsForTesting({ stateStore, workspaceStore: workspaceStore(), byokCredentialsStore: byokStore(), fetchImpl: vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true }) } as Response), broadcast: (channel, payload) => broadcasts.push({ channel, payload }) });
    const response = res();
    await handleSlackWorkspaceDelete(req({}, 'DELETE'), response);
    expect(broadcasts.map((b) => b.channel)).toEqual(['slack:workspace-changed', 'slack:workspace-disconnected']);
  });

  it('disconnect cancels pending deliveries for the workspace team', async () => {
    record = { teamId: 'T1', teamName: 'Acme', botUserId: 'UBOT', botToken: 'xoxb-token', installedAt: Date.now(), status: 'connected' };
    cancelByTeamId = vi.fn() as CancelByTeamIdMock;
    __setSlackOAuthRouteDepsForTesting({
      stateStore,
      workspaceStore: workspaceStore(),
      byokCredentialsStore: byokStore(),
      fetchImpl: vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true }) } as Response),
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      pendingDeliveries: { cancelByTeamId },
    });
    const response = res();
    await handleSlackWorkspaceDelete(req({}, 'DELETE'), response);
    expect(cancelByTeamId).toHaveBeenCalledWith('T1');
  });

  it('disconnect clears BYOK credentials for BYOK workspaces', async () => {
    record = { teamId: 'T1', teamName: 'Acme', botUserId: 'UBOT', botToken: 'xoxb-token', provisionMode: 'byok', installedAt: Date.now(), status: 'connected' };
    byokCredentials = {
      clientId: 'cid',
      clientSecret: 'secret',
      signingSecret: 'signing-secret',
      installedAt: '2026-05-03T00:00:00.000Z',
    };
    __setSlackOAuthRouteDepsForTesting({
      stateStore,
      workspaceStore: workspaceStore(),
      byokCredentialsStore: byokStore(),
      fetchImpl: vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true }) } as Response),
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      pendingDeliveries: { cancelByTeamId },
    });

    const response = res();
    await handleSlackWorkspaceDelete(req({}, 'DELETE'), response);

    expect(JSON.parse(response.out.body)).toEqual({ ok: true });
    expect(record).toBeNull();
    expect(byokCredentials).toBeNull();
  });

  it('disconnect clears stale BYOK credentials even for managed workspaces', async () => {
    record = { teamId: 'T1', teamName: 'Acme', botUserId: 'UBOT', botToken: 'xoxb-token', provisionMode: 'managed', installedAt: Date.now(), status: 'connected' };
    byokCredentials = {
      clientId: '123.456',
      clientSecret: 'client-secret',
      signingSecret: 'signing-secret',
      installedAt: '2026-05-03T00:00:00.000Z',
    };
    __setSlackOAuthRouteDepsForTesting({
      stateStore,
      workspaceStore: workspaceStore(),
      byokCredentialsStore: byokStore(),
      fetchImpl: vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true }) } as Response),
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      pendingDeliveries: { cancelByTeamId },
    });

    const response = res();
    await handleSlackWorkspaceDelete(req({}, 'DELETE'), response);

    expect(JSON.parse(response.out.body)).toEqual({ ok: true });
    expect(record).toBeNull();
    expect(byokCredentials).toBeNull();
  });

  it('disconnect still succeeds when broadcasts fail', async () => {
    record = { teamId: 'T1', teamName: 'Acme', botUserId: 'UBOT', botToken: 'xoxb-token', installedAt: Date.now(), status: 'connected' };
    __setSlackOAuthRouteDepsForTesting({
      stateStore,
      workspaceStore: workspaceStore(),
      byokCredentialsStore: byokStore(),
      fetchImpl: vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true }) } as Response),
      broadcast: () => { throw new Error('push channel unavailable'); },
    });
    const response = res();
    await handleSlackWorkspaceDelete(req({}, 'DELETE'), response);
    expect(record).toBeNull();
    expect(JSON.parse(response.out.body)).toEqual({ ok: true });
  });
});
