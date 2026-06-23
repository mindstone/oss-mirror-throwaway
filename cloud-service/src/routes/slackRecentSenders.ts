import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { cloudStorePathOnlyFactory } from '../services/cloudStorePathFactory';
import { SlackRecentSenderDtoSchema } from '@rebel/shared';
import { readBody, RouteError, sendJson } from '../httpUtils';
import { createSlackWorkspaceStore, type SlackWorkspaceStore } from '../services/slackWorkspaceStore';
import { createSlackRecentSendersStore, type SlackRecentSendersStore } from '../services/slackRecentSendersStore';

const DeleteSlackRecentSenderBodySchema = z.object({
  principalKey: z.string().trim().min(1),
});

const ListSlackRecentSendersResponseSchema = z.object({
  senders: z.array(SlackRecentSenderDtoSchema),
});

const DeleteSlackRecentSenderResponseSchema = z.object({
  ok: z.literal(true),
});

const ClearSlackRecentSendersResponseSchema = z.object({
  ok: z.literal(true),
  cleared: z.number().int().nonnegative(),
});

interface SlackRecentSendersRouteDeps {
  workspaceStore: SlackWorkspaceStore;
  recentSendersStore: SlackRecentSendersStore;
}

let testDeps: Partial<SlackRecentSendersRouteDeps> | null = null;

const storeFactory = cloudStorePathOnlyFactory;

function deps(): SlackRecentSendersRouteDeps {
  return {
    workspaceStore: testDeps?.workspaceStore ?? createSlackWorkspaceStore({ storeFactory }),
    recentSendersStore: testDeps?.recentSendersStore ?? createSlackRecentSendersStore({ storeFactory }),
  };
}

function getCurrentTeamId(routeDeps: SlackRecentSendersRouteDeps): string | null {
  const record = routeDeps.workspaceStore.get();
  const teamId = record?.teamId?.trim();
  return teamId && teamId.length > 0 ? teamId : null;
}

export function __setSlackRecentSendersRouteDepsForTesting(overrides: Partial<SlackRecentSendersRouteDeps> | null): void {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    testDeps = overrides;
  }
}

export async function handleSlackRecentSenders(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const routeDeps = deps();

  if (req.method === 'GET') {
    const teamId = getCurrentTeamId(routeDeps);
    const senders = teamId
      ? routeDeps.recentSendersStore
        .list(teamId)
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      : [];
    const response = ListSlackRecentSendersResponseSchema.parse({ senders });
    return sendJson(res, 200, response, req);
  }

  if (req.method === 'DELETE') {
    const body = await readBody(req);
    const parsedBody = DeleteSlackRecentSenderBodySchema.safeParse(body);
    if (!parsedBody.success) {
      throw new RouteError('INVALID_BODY', {
        status: 400,
        message: 'Body must include principalKey',
        details: { fieldErrors: parsedBody.error.flatten().fieldErrors },
      });
    }

    routeDeps.recentSendersStore.remove(parsedBody.data.principalKey);
    const response = DeleteSlackRecentSenderResponseSchema.parse({ ok: true });
    return sendJson(res, 200, response, req);
  }

  throw new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Method Not Allowed' });
}

export async function handleSlackRecentSendersClearAll(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    throw new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Method Not Allowed' });
  }

  const routeDeps = deps();
  const teamId = getCurrentTeamId(routeDeps);
  const cleared = teamId ? routeDeps.recentSendersStore.clear(teamId) : 0;
  const response = ClearSlackRecentSendersResponseSchema.parse({ ok: true, cleared });
  return sendJson(res, 200, response, req);
}
