import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { z } from 'zod';
import { cloudStorePathOnlyFactory } from '../services/cloudStorePathFactory';
import { createScopedLogger } from '@core/logger';
import {
  SLACK_WORKSPACE_CHANGED_CHANNEL,
  SlackWorkspaceChangedSchema,
} from '@shared/ipc/channels/slack';
import { readRawBody, RouteError, sendJson } from '../httpUtils';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import { createSlackWorkspaceStore, type SlackWorkspaceStore } from '../services/slackWorkspaceStore';
import { dispatchSlackInboundRaw } from './slackWebhook';

const log = createScopedLogger({ service: 'slackManagedRoute' });

const PROXY_SIGNATURE_HEADER = 'x-mindstone-proxy-signature';

const ProvisionTokensBodySchema = z.object({
  teamId: z.string().min(1),
  teamName: z.string().min(1),
  teamDomain: z.string().optional(),
  botUserId: z.string().min(1),
  botToken: z.string().min(1),
  authedUserId: z.string().optional(),
  peerInstanceCount: z.number().int().nonnegative().optional(),
  installedAt: z.number(),
});

const ManagedInboundBodySchema = z.object({
  event_id: z.string().min(1),
  raw_body: z.string().min(1),
  signature: z.string().min(1),
  timestamp: z.string().min(1),
});

interface SlackManagedRouteDeps {
  workspaceStore: SlackWorkspaceStore;
  broadcast: (channel: string, payload: unknown) => void;
}

let testDeps: Partial<SlackManagedRouteDeps> | null = null;
let loggedMissingProxySecret = false;
let loggedMissingSlackSigningSecret = false;

const storeFactory = cloudStorePathOnlyFactory;

function deps(): SlackManagedRouteDeps {
  return {
    workspaceStore: testDeps?.workspaceStore ?? createSlackWorkspaceStore({ storeFactory }),
    // dynamic-broadcast-reviewed: default Slack-managed route broadcast dep — forwards the `channel`
    // the route emits (slack:*/inbox:*/conversations:* declared at their own emit-sites); no channel of its own.
    broadcast: testDeps?.broadcast ?? ((channel, payload) => cloudEventBroadcaster.broadcast(channel, payload)),
  };
}

export function __setSlackManagedRouteDepsForTesting(overrides: Partial<SlackManagedRouteDeps> | null): void {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    testDeps = overrides;
    loggedMissingProxySecret = false;
    loggedMissingSlackSigningSecret = false;
  }
}

function getProxySecret(): string {
  const secret = process.env.MINDSTONE_PROXY_SHARED_SECRET?.trim() ?? '';
  if (!secret) {
    if (!loggedMissingProxySecret) {
      loggedMissingProxySecret = true;
      log.error(
        { envVar: 'MINDSTONE_PROXY_SHARED_SECRET', reason: 'missing_proxy_shared_secret' },
        'slack_managed_routes_disabled',
      );
    }
    throw new RouteError('INTERNAL_ERROR', { status: 503, message: 'Slack managed routes are not configured' });
  }
  return secret;
}

function getSlackSigningSecret(): string {
  const secret = process.env.SLACK_SIGNING_SECRET?.trim() ?? '';
  if (!secret) {
    if (!loggedMissingSlackSigningSecret) {
      loggedMissingSlackSigningSecret = true;
      log.error(
        { envVar: 'SLACK_SIGNING_SECRET', reason: 'missing_slack_signing_secret' },
        'slack_managed_routes_disabled',
      );
    }
    throw new RouteError('INTERNAL_ERROR', { status: 503, message: 'Slack managed inbound is not configured' });
  }
  return secret;
}

function normalizeSignature(value: string | undefined): string | null {
  if (!value) return null;
  return value.startsWith('sha256=') ? value.slice('sha256='.length) : value;
}

function verifyProxySignature(rawBody: Buffer, headerValue: string | undefined): boolean {
  const signature = normalizeSignature(headerValue);
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', getProxySecret()).update(rawBody).digest('hex');
  try {
    const signatureBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    return signatureBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

function verifySlackForwardedSignature(rawBody: string, timestamp: string, signature: string): boolean {
  const expected = `v0=${crypto.createHmac('sha256', getSlackSigningSecret()).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  try {
    return Buffer.byteLength(expected) === Buffer.byteLength(signature)
      && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function safeBroadcastWorkspaceChanged(routeDeps: SlackManagedRouteDeps, payload: unknown): void {
  const parsed = SlackWorkspaceChangedSchema.safeParse(payload);
  if (!parsed.success) {
    log.warn({ error: parsed.error.flatten() }, 'Slack managed workspace changed broadcast payload failed schema validation');
    return;
  }
  try {
    routeDeps.broadcast(SLACK_WORKSPACE_CHANGED_CHANNEL, parsed.data);
  } catch (err) {
    log.warn({ err }, 'Slack managed workspace changed broadcast failed');
  }
}

export async function handleSlackManagedProvisionTokens(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') throw new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Method Not Allowed' });
  const { raw, parsed } = await readRawBody(req);
  if (!verifyProxySignature(raw, Array.isArray(req.headers[PROXY_SIGNATURE_HEADER]) ? req.headers[PROXY_SIGNATURE_HEADER][0] : req.headers[PROXY_SIGNATURE_HEADER])) {
    throw new RouteError('UNAUTHORIZED', { status: 401, message: 'Invalid proxy signature' });
  }
  const body = ProvisionTokensBodySchema.safeParse(parsed);
  if (!body.success) throw new RouteError('INVALID_BODY', { status: 400, message: 'Invalid Slack managed provision body' });

  const routeDeps = deps();
  routeDeps.workspaceStore.set({
    teamId: body.data.teamId,
    teamName: body.data.teamName,
    teamDomain: body.data.teamDomain,
    botUserId: body.data.botUserId,
    botToken: body.data.botToken,
    authedUserId: body.data.authedUserId,
    ...(typeof body.data.peerInstanceCount === 'number'
      ? { peerInstanceCount: body.data.peerInstanceCount }
      : {}),
    provisionMode: 'managed',
    installedAt: body.data.installedAt,
    status: 'connected',
  });
  safeBroadcastWorkspaceChanged(routeDeps, {
    teamId: body.data.teamId,
    teamName: body.data.teamName,
    status: 'connected',
    ...(typeof body.data.peerInstanceCount === 'number'
      ? { peerInstanceCount: body.data.peerInstanceCount }
      : {}),
    occurredAt: Date.now(),
  });
  return sendJson(res, 200, { ok: true }, req);
}

export async function handleSlackManagedInbound(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') throw new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Method Not Allowed' });
  const { raw, parsed } = await readRawBody(req);
  if (!verifyProxySignature(raw, Array.isArray(req.headers[PROXY_SIGNATURE_HEADER]) ? req.headers[PROXY_SIGNATURE_HEADER][0] : req.headers[PROXY_SIGNATURE_HEADER])) {
    throw new RouteError('UNAUTHORIZED', { status: 401, message: 'Invalid proxy signature' });
  }
  const body = ManagedInboundBodySchema.safeParse(parsed);
  if (!body.success) throw new RouteError('INVALID_BODY', { status: 400, message: 'Invalid Slack managed inbound body' });

  if (!verifySlackForwardedSignature(body.data.raw_body, body.data.timestamp, body.data.signature)) {
    log.warn({ eventId: body.data.event_id }, 'Managed Slack inbound failed Slack signature precheck; dropping');
    return sendJson(res, 200, { ok: true, dropped: true }, req);
  }

  return dispatchSlackInboundRaw({
    rawBody: Buffer.from(body.data.raw_body, 'utf8'),
    headers: {
      get(name: string) {
        if (name === 'x-slack-request-timestamp') return body.data.timestamp;
        if (name === 'x-slack-signature') return body.data.signature;
        return null;
      },
    },
    req,
    res,
    returnSlackAuthFailureAsDropped: true,
  });
}

export const __test = {
  verifyProxySignature,
  verifySlackForwardedSignature,
};
