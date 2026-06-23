import { z } from 'zod';
import {
  SlackOAuthStartResponseSchema,
  SlackWorkspaceNullableResponseSchema,
  SlackWorkspaceResponseSchema,
} from '@rebel/shared';
import {
  CloudClientError,
  isNetworkError,
  request,
} from './cloudClient';

export interface SlackOAuthStartResponse {
  authUrl: string;
  state: string;
}

export interface SlackWorkspaceResponse {
  teamId: string;
  teamName: string;
  status: 'connected' | 'needs_reconnect' | 'disconnected' | 'disconnecting';
  peerInstanceCount?: number;
  lastSeenAt: string | null;
}

export interface SlackByokOAuthStartArgs {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

export class SlackResponseValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: readonly unknown[],
  ) {
    super(message);
    this.name = 'SlackResponseValidationError';
  }
}

export class SlackAuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly field?: 'clientId' | 'clientSecret' | 'signingSecret',
  ) {
    super(message);
    this.name = 'SlackAuthError';
  }
}

export class SlackTransientError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'SlackTransientError';
  }
}

export class SlackNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackNetworkError';
  }
}

function mapSlackError(err: unknown): never {
  if (err instanceof CloudClientError) {
    if (err.statusCode === 400 || err.statusCode === 401 || err.statusCode === 403) {
      const body = err.responseBody;
      const field = body && typeof body === 'object'
        ? (body as { field?: unknown }).field
        : undefined;
      const message = body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : err.message;
      throw new SlackAuthError(
        message,
        err.statusCode,
        field === 'clientId' || field === 'clientSecret' || field === 'signingSecret' ? field : undefined,
      );
    }
    if (err.statusCode === 429 || (err.statusCode !== undefined && err.statusCode >= 500)) {
      throw new SlackTransientError(err.message, err.statusCode);
    }
  }
  if (isNetworkError(err)) {
    throw new SlackNetworkError(err instanceof Error ? err.message : 'Network request failed');
  }
  throw err;
}

interface SlackResponseSchema<T> {
  safeParse(payload: unknown): { success: true; data: T } | { success: false; error: { issues: readonly unknown[] } };
}

function parseSlackResponse<T>(schema: SlackResponseSchema<T>, payload: unknown, label: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new SlackResponseValidationError(`${label} response did not match the expected shape`, parsed.error.issues);
  }
  return parsed.data;
}

const SlackByokOAuthStartArgsSchema = z.object({
  clientId: z.string().trim().regex(/^\d+\.\d+$/),
  clientSecret: z.string().trim().min(10),
  signingSecret: z.string().trim().min(10),
});

export async function startSlackOAuth(signal?: AbortSignal): Promise<SlackOAuthStartResponse> {
  try {
    const payload = await request<unknown>('POST', '/api/integrations/slack/oauth/start/managed', undefined, undefined, undefined, signal);
    return parseSlackResponse<SlackOAuthStartResponse>(SlackOAuthStartResponseSchema, payload, 'Slack OAuth start');
  } catch (err) {
    mapSlackError(err);
  }
}

export async function startByokSlackOAuth(
  args: SlackByokOAuthStartArgs,
  opts?: { signal?: AbortSignal },
): Promise<SlackOAuthStartResponse> {
  const parsedArgs = SlackByokOAuthStartArgsSchema.safeParse(args);
  if (!parsedArgs.success) {
    throw new SlackResponseValidationError('Slack BYOK OAuth start arguments did not match the expected shape', parsedArgs.error.issues);
  }

  try {
    const payload = await request<unknown>(
      'POST',
      '/api/integrations/slack/oauth/start/byok',
      parsedArgs.data,
      undefined,
      undefined,
      opts?.signal,
    );
    return parseSlackResponse<SlackOAuthStartResponse>(SlackOAuthStartResponseSchema, payload, 'Slack BYOK OAuth start');
  } catch (err) {
    mapSlackError(err);
  }
}

export async function getSlackWorkspace(signal?: AbortSignal): Promise<SlackWorkspaceResponse | null> {
  try {
    const payload = await request<unknown>('GET', '/api/integrations/slack/workspace', undefined, undefined, undefined, signal);
    return parseSlackResponse<SlackWorkspaceResponse | null>(SlackWorkspaceNullableResponseSchema, payload, 'Slack workspace');
  } catch (err) {
    mapSlackError(err);
  }
}

export async function deleteSlackWorkspace(signal?: AbortSignal): Promise<void> {
  try {
    const payload = await request<unknown>('DELETE', '/api/integrations/slack/workspace', undefined, undefined, undefined, signal);
    parseSlackResponse(z.object({ ok: z.literal(true) }), payload, 'Slack workspace delete');
  } catch (err) {
    mapSlackError(err);
  }
}

export const __slackSchemas = {
  OAuthStart: SlackOAuthStartResponseSchema,
  Workspace: SlackWorkspaceResponseSchema,
};
