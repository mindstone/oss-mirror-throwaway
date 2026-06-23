import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { BroadcastService } from '@core/broadcastService';
import { createExternalConversationService } from '@core/services/externalConversation/externalConversationService';
import { conversationScopeResolver } from '@core/services/externalConversation/conversationScopeResolver';
import { SlackThreadAdapter } from '@core/services/externalConversation/adapters/slackThreadAdapter';
import {
  runInboundColdBootScenario,
  type HarnessRouteDeps,
  type InboundRouteHandler,
} from './helpers/inboundColdBootHarness';
import {
  __setSlackWebhookRouteDepsForTesting,
  handleSlackWebhook,
} from '../routes/slackWebhook';
import type { PendingInboundLog } from '../services/slackPendingInboundLog';
import type { SlackWorkspaceStore } from '../services/slackWorkspaceStore';

const SLACK_SIGNING_SECRET = 'slack-signing-secret-test';
const SLACK_SYNC_ACK_BUDGET_MS = 3_000;
const FIRST_SEARCH_TOOLS_COLD_START_BUDGET_MS = 10_000;

function signSlackBody(rawBody: string, timestamp: string, signingSecret: string): string {
  const base = `v0:${timestamp}:${rawBody}`;
  const digest = crypto.createHmac('sha256', signingSecret).update(base).digest('hex');
  return `v0=${digest}`;
}

function buildSlackEventBody(): string {
  return JSON.stringify({
    type: 'event_callback',
    team_id: 'T1',
    event_id: 'E-cold-boot-slack',
    event: {
      type: 'message',
      channel: 'C1',
      ts: '100.000',
      user: 'U1',
      text: '<@UBOT> cold boot ping',
    },
  });
}

function signSlackRequest(body: string, headers: Record<string, string>): void {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signSlackBody(body, timestamp, SLACK_SIGNING_SECRET);
  headers['x-slack-request-timestamp'] = timestamp;
  headers['x-slack-signature'] = signature;
}

function installSlackRoute(deps: HarnessRouteDeps): InboundRouteHandler {
  const workspaceStore: SlackWorkspaceStore = {
    get: () => ({
      teamId: 'T1',
      teamName: 'Acme',
      teamDomain: 'acme',
      botUserId: 'UBOT',
      botToken: 'xoxb-token',
      authedUserId: 'UOWNER',
      provisionMode: 'managed',
      installedAt: Date.now(),
      status: 'connected',
    }),
    set: vi.fn(),
    updateStatus: vi.fn(),
    updateLastSeen: vi.fn(),
    clear: vi.fn(),
  };

  const pendingLog: PendingInboundLog = {
    enqueue: vi.fn(),
    markProcessed: vi.fn(),
    drainUnprocessed: vi.fn(() => []),
    claimEventProcessing: vi.fn(() => ({ acquired: true as const, ownerToken: 'owner-token' })),
    releaseAfterSuccess: vi.fn(),
    markBroadcastDeferred: vi.fn(),
    tryResumeClaim: vi.fn(() => ({ acquired: true as const, ownerToken: 'owner-token' })),
  };

  const broadcast: BroadcastService = {
    sendToAllWindows: (channel: string, ...args: unknown[]) => deps.broadcaster.broadcast(channel, ...args),
    sendToFocusedWindow: (channel: string, ...args: unknown[]) => deps.broadcaster.broadcast(channel, ...args),
  };

  const slackApiFetch: typeof fetch = vi.fn(async () => ({
    ok: false,
    status: 404,
    json: async () => ({ ok: false }),
  }) as unknown as Response);

  const slackThreadAdapter = new SlackThreadAdapter({
    signingSecret: SLACK_SIGNING_SECRET,
    workspaceStore,
    fetchImpl: slackApiFetch,
    broadcast,
  });

  const externalConversationService = createExternalConversationService({
    broadcast,
    errorReporter: {
      addBreadcrumb: vi.fn(),
      captureException: deps.captureException,
      captureMessage: vi.fn(),
    },
    agentTurnRegistry: deps.agentTurnRegistry,
    conversationScopeResolver,
    sessionStore: {
      getSession: async (id: string) => deps.sessions.get(id) ?? null,
      updateSession: async (id, mutator) => {
        const current = deps.sessions.get(id) ?? null;
        const next = mutator(current);
        if (next) deps.sessions.set(id, next);
        else deps.sessions.delete(id);
        return true;
      },
    },
    adapters: new Map([[slackThreadAdapter.kind, slackThreadAdapter]]),
  });

  deps.bindExternalConversationFactory({
    externalConversationService,
    adapter: slackThreadAdapter,
  });

  __setSlackWebhookRouteDepsForTesting({
    workspaceStore,
    pendingLog,
    getSettings: () => ({ experimental: { slackCloudWebhookEnabled: true } } as never),
    hasOpenBroadcastClient: () => true,
  });
  deps.registerCleanup(() => {
    __setSlackWebhookRouteDepsForTesting(null);
  });

  return handleSlackWebhook;
}

describe('cold-boot inbound integration', () => {
  it('slack: acks within budget and completes first cold search_tools within budget', async () => {
    const result = await runInboundColdBootScenario({
      name: 'slack',
      syncAckBudgetMs: SLACK_SYNC_ACK_BUDGET_MS,
      firstSearchToolsBudgetMs: FIRST_SEARCH_TOOLS_COLD_START_BUDGET_MS,
      endpointPath: '/api/integrations/slack/events',
      buildRequestBody: buildSlackEventBody,
      signRequest: signSlackRequest,
      installRoute: installSlackRoute,
      assertHttpAck: (response, parsedResponseBody) => {
        expect(response.status).toBe(200);
        expect(parsedResponseBody).toEqual({ ok: true });
      },
    });

    expect(result.searchToolsInvoked).toBe(true);
    expect(result.agentTurnDispatched).toBe(true);
    expect(result.durationsMs.firstSearchTools).not.toBeNull();
  });
});
