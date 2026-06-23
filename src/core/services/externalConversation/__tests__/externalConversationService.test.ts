import { describe, expect, it } from 'vitest';
import type { BroadcastService } from '@core/broadcastService';
import type { ErrorReporter } from '@core/errorReporter';
import type { AgentSession } from '@shared/types';
import { ConversationScopeResolver } from '../conversationScopeResolver';
import { createExternalConversationService } from '../externalConversationService';
import type { ExternalConversationAdapter } from '../externalConversationAdapter';
import type { BrowserTabContext, SlackThreadContext } from '../externalContext';

describe('createExternalConversationService Slack provenance', () => {
  const slackContext: SlackThreadContext = {
    kind: 'slack-thread',
    identity: { teamId: 'T1', channelId: 'C1', threadTs: '1700000000.123456' },
    metadata: {
      userId: 'U1',
      userName: 'Alice',
      userDisplayName: 'Alice',
      channelName: 'planning',
      teamName: 'Acme',
      permalink: 'https://acme.slack.com/archives/C1/p1700000000123456',
    },
  };

  function makeSession(id = 'conversation-1', sessionActive = false, externalContext?: SlackThreadContext): AgentSession {
    return {
      id,
      title: 'Slack Session',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      messages: [],
      eventsByTurn: {},
      activeTurnId: sessionActive ? 'turn-1' : null,
      isBusy: sessionActive,
      lastError: null,
      resolvedAt: null,
      ...(externalContext ? { externalContext } : {}),
    };
  }

  function buildService(active = false, initialExternalContext?: SlackThreadContext) {
    const broadcasts: Array<{ channel: string; payload: unknown }> = [];
    const sessions = new Map<string, AgentSession>([
      ['conversation-1', makeSession('conversation-1', active, initialExternalContext)],
    ]);
    let updateWrites = 0;
    const broadcast: BroadcastService = {
      sendToAllWindows: (channel, payload) => broadcasts.push({ channel, payload }),
      sendToFocusedWindow: (channel, payload) => broadcasts.push({ channel, payload }),
    };
    const adapter: ExternalConversationAdapter<SlackThreadContext> = {
      kind: 'slack-thread',
      async deliverResponse() {
        return { status: 'delivered' };
      },
      getContextTools() {
        return [];
      },
      async resumePendingDeliveries() {},
      formatInitialPrompt() {
        return 'Slack prompt';
      },
    };
    const service = createExternalConversationService({
      broadcast,
      errorReporter: {
        captureException: () => {},
        captureMessage: () => {},
        addBreadcrumb: () => {},
      } satisfies ErrorReporter,
      agentTurnRegistry: {
        hasActiveTurnForSession: () => active,
        getActiveTurnForSession: () => 'turn-1',
        subscribeTurnEvents: () => () => {},
        onTurnEnded: () => () => {},
      },
      conversationScopeResolver: new ConversationScopeResolver(),
      sessionStore: {
        getSession: async (id: string) => sessions.get(id) ?? null,
        updateSession: async (id, mutator) => {
          const next = mutator(sessions.get(id) ?? null);
          if (!next) return false;
          sessions.set(id, next);
          updateWrites += 1;
          return true;
        },
      },
      uuid: () => 'conversation-1',
      now: () => 1_700_000_000_000,
      adapters: new Map([[adapter.kind, adapter]]),
    });
    return { service, broadcasts, sessions, getUpdateWrites: () => updateWrites };
  }

  it('emits appId "slack" and the full context for Slack conversation arrivals', async () => {
    const { service, broadcasts } = buildService();

    await service.createConversation(slackContext, { intent: 'chat', userText: 'hello' });

    const arrived = broadcasts.find((entry) => entry.channel === 'intent:external-context-arrived');
    expect(arrived?.payload).toMatchObject({
      appId: 'slack',
      externalContext: slackContext,
    });
  });

  it('emits appId "slack" and the full context for buffered Slack messages', async () => {
    const { service, broadcasts } = buildService(true);

    await service.injectMessage({
      conversationId: 'conversation-1',
      context: slackContext,
      text: 'follow-up',
    });

    const buffered = broadcasts.find((entry) => entry.channel === 'intent:buffered-message');
    expect(buffered?.payload).toMatchObject({
      appId: 'slack',
      externalContext: slackContext,
    });
  });

  it('persists Slack externalContext onto the materialized AgentSession after createConversation', async () => {
    const { service, sessions } = buildService();

    await service.createConversation(slackContext, { intent: 'chat', userText: 'hello' });

    expect(sessions.get('conversation-1')?.externalContext).toEqual(slackContext);
  });

  it('does not rewrite the session when injectMessage receives the already-persisted Slack externalContext', async () => {
    const { service, sessions, getUpdateWrites } = buildService(false, slackContext);

    await service.injectMessage({
      conversationId: 'conversation-1',
      context: slackContext,
      text: 'follow-up',
    });

    expect(sessions.get('conversation-1')?.externalContext).toEqual(slackContext);
    expect(getUpdateWrites()).toBe(0);
  });

  it('does not persist browser-tab externalContext onto the session (privacy narrowing)', async () => {
    const browserContext: BrowserTabContext = {
      kind: 'browser-tab',
      identity: { tabId: 1, origin: 'https://docs.example.com', pathname: '/private/notes' },
      metadata: {
        url: 'https://docs.example.com/private/notes?token=secret',
        title: 'Private Notes',
        search: '?token=secret',
        hash: '#section-1',
      },
    };
    const broadcasts: Array<{ channel: string; payload: unknown }> = [];
    const sessions = new Map<string, AgentSession>([
      ['conversation-1', makeSession('conversation-1')],
    ]);
    let updateWrites = 0;
    const broadcast: BroadcastService = {
      sendToAllWindows: (channel, payload) => broadcasts.push({ channel, payload }),
      sendToFocusedWindow: (channel, payload) => broadcasts.push({ channel, payload }),
    };
    const adapter: ExternalConversationAdapter<BrowserTabContext> = {
      kind: 'browser-tab',
      async deliverResponse() {
        return { status: 'delivered' };
      },
      getContextTools() {
        return [];
      },
      async resumePendingDeliveries() {},
      formatInitialPrompt() {
        return 'Browser prompt';
      },
    };
    const service = createExternalConversationService({
      broadcast,
      errorReporter: {
        captureException: () => {},
        captureMessage: () => {},
        addBreadcrumb: () => {},
      } satisfies ErrorReporter,
      agentTurnRegistry: {
        hasActiveTurnForSession: () => false,
        getActiveTurnForSession: () => 'turn-1',
        subscribeTurnEvents: () => () => {},
        onTurnEnded: () => () => {},
      },
      conversationScopeResolver: new ConversationScopeResolver(),
      sessionStore: {
        getSession: async (id: string) => sessions.get(id) ?? null,
        updateSession: async (id, mutator) => {
          const next = mutator(sessions.get(id) ?? null);
          if (!next) return false;
          sessions.set(id, next);
          updateWrites += 1;
          return true;
        },
      },
      uuid: () => 'conversation-1',
      now: () => 1_700_000_000_000,
      adapters: new Map([[adapter.kind, adapter]]),
    });

    await service.createConversation(browserContext, { intent: 'chat', userText: 'check this' });

    expect(sessions.get('conversation-1')?.externalContext).toBeUndefined();
    expect(updateWrites).toBe(0);
  });
});
