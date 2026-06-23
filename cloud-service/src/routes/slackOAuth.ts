import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { z } from 'zod';
import { cloudStorePathOnlyFactory } from '../services/cloudStorePathFactory';
import { createScopedLogger } from '@core/logger';
import { SLACK_BOT_SCOPE_PARAM, SLACK_USER_SCOPE_PARAM } from '@shared/utils/slackOAuthScopes';
import { getSlackApiBaseUrl } from '@shared/utils/slackApiBaseUrl';
import {
  SLACK_WORKSPACE_CHANGED_CHANNEL,
  SLACK_WORKSPACE_DISCONNECTED_CHANNEL,
  SlackWorkspaceChangedSchema,
  SlackWorkspaceDisconnectedSchema,
} from '@shared/ipc/channels/slack';
import { readBody, RouteError, sendJson } from '../httpUtils';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import { createSlackOAuthStateStore, SLACK_OAUTH_MAX_ACTIVE_STATES, type SlackOAuthStateStore } from '../services/slackOAuthStateStore';
import { createSlackWorkspaceStore, type SlackWorkspaceStore } from '../services/slackWorkspaceStore';
import { createSlackByokCredentialsStore, type SlackByokCredentials, type SlackByokCredentialsStore } from '../services/slackByokCredentialsStore';
import { slackThreadAdapterInstance } from '../services/externalConversationServiceFactory';

const log = createScopedLogger({ service: 'slackOAuthRoute' });

const ByokStartBodySchema = z.object({
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1),
  signingSecret: z.string().trim().min(1),
  redirectUri: z.string().optional(),
});

const ManagedStartBodySchema = z.object({
  redirectUri: z.string().optional(),
}).optional().nullable();

const SlackOAuthResponseSchema = z.object({
  ok: z.boolean(),
  access_token: z.string().optional(),
  bot_user_id: z.string().optional(),
  team: z.object({ id: z.string(), name: z.string(), domain: z.string().optional() }).optional(),
  authed_user: z.object({ id: z.string().optional() }).optional(),
  error: z.string().optional(),
});

interface SlackOAuthRouteDeps {
  fetchImpl: typeof fetch;
  stateStore: SlackOAuthStateStore;
  workspaceStore: SlackWorkspaceStore;
  byokCredentialsStore: SlackByokCredentialsStore;
  broadcast: (channel: string, payload: unknown) => void;
  pendingDeliveries: { cancelByTeamId(teamId: string): void };
}

type SlackByokField = 'clientId' | 'clientSecret' | 'signingSecret';

let testDeps: Partial<SlackOAuthRouteDeps> | null = null;

const storeFactory = cloudStorePathOnlyFactory;

function slackApiUrl(path: string): string {
  return new URL(path, getSlackApiBaseUrl()).toString();
}

function deps(): SlackOAuthRouteDeps {
  return {
    fetchImpl: testDeps?.fetchImpl ?? globalThis.fetch,
    stateStore: testDeps?.stateStore ?? createSlackOAuthStateStore({ storeFactory }),
    workspaceStore: testDeps?.workspaceStore ?? createSlackWorkspaceStore({ storeFactory }),
    byokCredentialsStore: testDeps?.byokCredentialsStore ?? createSlackByokCredentialsStore({ storeFactory, log }),
    // dynamic-broadcast-reviewed: default Slack-OAuth route broadcast dep — forwards the `channel`
    // the route emits (slack:workspace-* declared at their own emit-sites); introduces no channel itself.
    broadcast: testDeps?.broadcast ?? ((channel, payload) => cloudEventBroadcaster.broadcast(channel, payload)),
    pendingDeliveries: testDeps?.pendingDeliveries ?? {
      cancelByTeamId(teamId: string) {
        slackThreadAdapterInstance?.cancelByTeamId(teamId);
      },
    },
  };
}

export function __setSlackOAuthRouteDepsForTesting(overrides: Partial<SlackOAuthRouteDeps> | null): void {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    testDeps = overrides;
  }
}

function inferCallbackUrl(req: IncomingMessage): string {
  const configuredBaseUrl = process.env.CLOUD_BASE_URL?.trim().replace(/\/+$/, '');
  if (configuredBaseUrl) return `${configuredBaseUrl}/api/integrations/slack/oauth/callback`;

  const host = req.headers.host ?? 'localhost';
  const proto = req.headers['x-forwarded-proto'] ?? 'https';
  return `${Array.isArray(proto) ? proto[0] : proto}://${host}/api/integrations/slack/oauth/callback`;
}

function allowedReturnUri(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^mindstone:\/\//.test(value) ? value : undefined;
}

function managedSlackClientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = (process.env.SLACK_CLIENT_ID ?? '').trim();
  const clientSecret = (process.env.SLACK_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) {
    log.error(
      { envVars: ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET'] },
      'Managed Slack OAuth credentials are not configured',
    );
    throw new RouteError('INTERNAL_ERROR', { status: 503, message: 'Managed Slack OAuth is not configured' });
  }
  return { clientId, clientSecret };
}

function byokFieldError(body: { clientId: string; clientSecret: string; signingSecret: string }): { field: SlackByokField; message: string } | null {
  if (!/^\d+\.\d+$/.test(body.clientId.trim())) {
    return { field: 'clientId', message: 'Client ID looks like 12345.67890' };
  }
  if (body.clientSecret.trim().length < 10) {
    return { field: 'clientSecret', message: 'Looks too short to be valid' };
  }
  if (body.signingSecret.trim().length < 10) {
    return { field: 'signingSecret', message: 'Looks too short to be valid' };
  }
  return null;
}

function sendInvalidField(res: ServerResponse, req: IncomingMessage, field: SlackByokField, message: string): void | Promise<void> {
  return sendJson(res, 400, { error: 'INVALID_FIELD', field, message }, req);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function renderError(res: ServerResponse, status: number, message: string): void {
  sendHtml(res, status, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Slack connection failed</title></head><body><h1>Slack connection failed</h1><p>${message}</p></body></html>`);
}

function successHtml(returnUri?: string): string {
  const returnLink = returnUri
    ? `<p><a href="${escapeHtml(returnUri)}">Return to Rebel</a></p>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Slack connected</title></head><body><h1>Slack connected</h1><p>You can close this window and return to Rebel.</p>${returnLink}</body></html>`;
}

function safeBroadcastWorkspaceChanged(routeDeps: SlackOAuthRouteDeps, payload: unknown): void {
  const parsed = SlackWorkspaceChangedSchema.safeParse(payload);
  if (!parsed.success) {
    log.warn({ error: parsed.error.flatten() }, 'Slack workspace changed broadcast payload failed schema validation');
    return;
  }
  try {
    routeDeps.broadcast(SLACK_WORKSPACE_CHANGED_CHANNEL, parsed.data);
  } catch (err) {
    log.warn({ err }, 'Slack workspace changed broadcast failed');
  }
}

function safeBroadcastWorkspaceDisconnected(routeDeps: SlackOAuthRouteDeps, payload: unknown): void {
  const parsed = SlackWorkspaceDisconnectedSchema.safeParse(payload);
  if (!parsed.success) {
    log.warn({ error: parsed.error.flatten() }, 'Slack workspace disconnected broadcast payload failed schema validation');
    return;
  }
  try {
    routeDeps.broadcast(SLACK_WORKSPACE_DISCONNECTED_CHANNEL, parsed.data);
  } catch (err) {
    log.warn({ err }, 'Slack workspace disconnected broadcast failed');
  }
}

async function startOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  body: {
    clientId: string;
    clientSecret: string;
    redirectUri?: string;
    provisionMode: 'managed' | 'byok';
    oauthCredentials: { clientId: string; clientSecret: string; signingSecret: string } | null;
  },
): Promise<void> {
  const routeDeps = deps();
  if (routeDeps.stateStore.activeCount() >= SLACK_OAUTH_MAX_ACTIVE_STATES) {
    return sendJson(res, 429, { error: { code: 'SLACK_OAUTH_STATE_STORE_FULL', message: 'Too many Slack connection attempts are already in progress.' } }, req);
  }

  const state = crypto.randomBytes(32).toString('hex');
  const callbackUrl = inferCallbackUrl(req);
  const returnUri = allowedReturnUri(body.redirectUri);
  if (body.redirectUri && !returnUri) {
    log.warn({ scheme: body.redirectUri.split(':', 1)[0] }, 'Ignoring unsupported Slack OAuth return URI');
  }
  routeDeps.stateStore.put({
    state,
    clientId: body.clientId,
    clientSecret: body.clientSecret,
    oauthCredentials: body.oauthCredentials,
    provisionMode: body.provisionMode,
    redirectUri: returnUri,
    createdAt: Date.now(),
  });

  const authUrl = new URL('https://slack.com/oauth/v2/authorize');
  authUrl.searchParams.set('client_id', body.clientId);
  authUrl.searchParams.set('scope', SLACK_BOT_SCOPE_PARAM);
  authUrl.searchParams.set('user_scope', SLACK_USER_SCOPE_PARAM);
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('state', state);

  return sendJson(res, 200, { authUrl: authUrl.toString(), state }, req);
}

export async function handleSlackOAuthStartByok(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    throw new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Method Not Allowed' });
  }

  const body = ByokStartBodySchema.safeParse(await readBody(req));
  if (!body.success) {
    const field = body.error.issues
      .map((issue) => issue.path[0])
      .find((path): path is SlackByokField => path === 'clientId' || path === 'clientSecret' || path === 'signingSecret');
    if (field) {
      return sendInvalidField(res, req, field, 'Required');
    }
    throw new RouteError('INVALID_BODY', { status: 400, message: 'Invalid Slack OAuth start body' });
  }

  const fieldError = byokFieldError(body.data);
  if (fieldError) {
    return sendInvalidField(res, req, fieldError.field, fieldError.message);
  }

  const credentials = {
    clientId: body.data.clientId.trim(),
    clientSecret: body.data.clientSecret.trim(),
    signingSecret: body.data.signingSecret.trim(),
  };

  return startOAuth(req, res, {
    ...credentials,
    redirectUri: body.data.redirectUri,
    provisionMode: 'byok',
    oauthCredentials: credentials,
  });
}

export async function handleSlackOAuthStartManaged(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    throw new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Method Not Allowed' });
  }

  const body = ManagedStartBodySchema.safeParse(await readBody(req));
  if (!body.success) {
    throw new RouteError('INVALID_BODY', { status: 400, message: 'Invalid Slack managed OAuth start body' });
  }

  return startOAuth(req, res, {
    ...managedSlackClientCredentials(),
    redirectUri: body.data?.redirectUri,
    provisionMode: 'managed',
    oauthCredentials: null,
  });
}

export const handleSlackOAuthStart = handleSlackOAuthStartByok;

export async function handleSlackOAuthCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '', 'https://localhost');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return renderError(res, 400, 'Authorization expired or invalid. Please try connecting again.');
  }

  const routeDeps = deps();
  const consumed = routeDeps.stateStore.consume(state);
  if (consumed.status !== 'ok') {
    return renderError(res, 400, 'Authorization expired or invalid. Please try connecting again.');
  }

  try {
    const provisionMode = consumed.record.provisionMode ?? 'byok';
    const credentials = provisionMode === 'managed'
      ? managedSlackClientCredentials()
      : consumed.record.oauthCredentials;
    if (!credentials) {
      routeDeps.stateStore.complete(state);
      return sendJson(res, 400, {
        error: {
          code: 'BYOK_NOT_INITIALISED',
          message: 'Slack BYOK credentials are missing. Start setup again.',
        },
      }, req);
    }

    const response = await routeDeps.fetchImpl(slackApiUrl('/api/oauth.v2.access'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code,
        redirect_uri: inferCallbackUrl(req),
      }),
    });
    const data = SlackOAuthResponseSchema.parse(await response.json());
    if (!data.ok || !data.access_token || !data.bot_user_id || !data.team?.id || !data.team.name) {
      routeDeps.stateStore.complete(state);
      return renderError(res, 400, 'Authorization expired or invalid. Please try connecting again.');
    }

    let previousByokCredentials: SlackByokCredentials | null = null;
    if (provisionMode === 'byok') {
      const byokOAuthCredentials = consumed.record.oauthCredentials;
      if (!byokOAuthCredentials) {
        routeDeps.stateStore.complete(state);
        return sendJson(res, 400, {
          error: {
            code: 'BYOK_NOT_INITIALISED',
            message: 'Slack BYOK credentials are missing. Start setup again.',
          },
        }, req);
      }
      previousByokCredentials = await routeDeps.byokCredentialsStore.get();
      await routeDeps.byokCredentialsStore.set({
        ...byokOAuthCredentials,
        installedAt: new Date().toISOString(),
      });
    }

    try {
      routeDeps.workspaceStore.set({
        teamId: data.team.id,
        teamName: data.team.name,
        teamDomain: data.team.domain,
        botUserId: data.bot_user_id,
        botToken: data.access_token,
        authedUserId: data.authed_user?.id,
        provisionMode,
        installedAt: Date.now(),
        status: 'connected',
      });
    } catch (err) {
      if (provisionMode === 'byok') {
        if (previousByokCredentials) {
          await routeDeps.byokCredentialsStore.set(previousByokCredentials);
        } else {
          await routeDeps.byokCredentialsStore.clear();
        }
      }
      throw err;
    }
    routeDeps.stateStore.complete(state);
    safeBroadcastWorkspaceChanged(routeDeps, {
      teamId: data.team.id,
      teamName: data.team.name,
      status: 'connected',
      occurredAt: Date.now(),
    });
    return sendHtml(res, 200, successHtml(consumed.record.redirectUri));
  } catch (err) {
    routeDeps.stateStore.complete(state);
    log.error({ err }, 'Slack OAuth callback could not persist workspace');
    return renderError(res, 400, "We received your authorization, but couldn't store it. Please try again.");
  }
}

export async function handleSlackWorkspaceGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    throw new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Method Not Allowed' });
  }

  const workspace = deps().workspaceStore.get();
  if (!workspace || workspace.status === 'disconnected') {
    return sendJson(res, 200, null, req);
  }

  return sendJson(res, 200, {
    teamId: workspace.teamId,
    teamName: workspace.teamName,
    status: workspace.status,
    ...(typeof workspace.peerInstanceCount === 'number'
      ? { peerInstanceCount: workspace.peerInstanceCount }
      : {}),
    lastSeenAt: workspace.lastSeenAt ? new Date(workspace.lastSeenAt).toISOString() : null,
  }, req);
}

export async function handleSlackWorkspaceDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'DELETE') {
    throw new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Method Not Allowed' });
  }

  const routeDeps = deps();
  const workspace = routeDeps.workspaceStore.get();
  if (!workspace) {
    await routeDeps.byokCredentialsStore.clear();
    return sendJson(res, 200, { ok: true }, req);
  }

  routeDeps.workspaceStore.updateStatus('disconnecting');
  safeBroadcastWorkspaceChanged(routeDeps, {
    teamId: workspace.teamId,
    teamName: workspace.teamName,
    status: 'disconnecting',
    ...(typeof workspace.peerInstanceCount === 'number'
      ? { peerInstanceCount: workspace.peerInstanceCount }
      : {}),
    occurredAt: Date.now(),
  });

  try {
    const revoke = await routeDeps.fetchImpl(slackApiUrl('/api/auth.revoke'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${workspace.botToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    const body = await revoke.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (body && body.ok === false) {
      log.warn({ error: body.error }, 'Slack auth.revoke returned an error during disconnect');
    }
  } catch (err) {
    log.warn({ err }, 'Slack auth.revoke failed during disconnect; clearing local workspace anyway');
  }

  routeDeps.workspaceStore.clear();
  await routeDeps.byokCredentialsStore.clear();
  routeDeps.pendingDeliveries.cancelByTeamId(workspace.teamId);
  safeBroadcastWorkspaceDisconnected(routeDeps, {
    teamId: workspace.teamId,
    reason: 'manual_disconnect',
    occurredAt: Date.now(),
  });
  return sendJson(res, 200, { ok: true }, req);
}
