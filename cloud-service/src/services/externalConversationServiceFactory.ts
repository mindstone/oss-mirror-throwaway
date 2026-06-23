import { createExternalConversationService, type ExternalConversationService } from '@core/services/externalConversation/externalConversationService';
import { conversationScopeResolver } from '@core/services/externalConversation/conversationScopeResolver';
import { getErrorReporter } from '@core/errorReporter';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { getIncrementalSessionStore } from '@core/services/incrementalSessionStore';
import { SlackThreadAdapter } from '@core/services/externalConversation/adapters/slackThreadAdapter';
import type { BroadcastService } from '@core/broadcastService';
import { cloudStorePathOnlyFactory } from './cloudStorePathFactory';
import { createScopedLogger } from '@core/logger';
import { createSlackWorkspaceStore } from './slackWorkspaceStore';
import { createSlackByokCredentialsStore } from './slackByokCredentialsStore';
import { triggerSlackInboundReplay } from './slackInboundReplayRegistry';

const log = createScopedLogger({ service: 'externalConversationServiceFactory' });

let externalConversationServiceInstance: ExternalConversationService | null = null;
export let slackThreadAdapterInstance: SlackThreadAdapter | null = null;
let unsubscribeClientConnectedReplay: (() => void) | null = null;

const storeFactory = cloudStorePathOnlyFactory;

export function initExternalConversationService(): ExternalConversationService {
  if (externalConversationServiceInstance) {
    return externalConversationServiceInstance;
  }

  const managedSigningSecret = process.env.SLACK_SIGNING_SECRET?.trim() ?? null;

  // dynamic-broadcast-reviewed: BroadcastService adapter for the external-conversation (Slack) service
  // — forwards whatever `channel` that service emits (conversations:*/inbox:* channels declared at their
  // own emit-sites) to the cloud→desktop fan-out; the seam introduces no channel itself.
  const broadcastService: BroadcastService = {
    sendToAllWindows: (channel: string, ...args: unknown[]) => cloudEventBroadcaster.broadcast(channel, ...args),
    // dynamic-broadcast-reviewed: sibling forwarder of the adapter above — same channel-passthrough contract.
    sendToFocusedWindow: (channel: string, ...args: unknown[]) => cloudEventBroadcaster.broadcast(channel, ...args),
  };

  const store = getIncrementalSessionStore();
  const workspaceStore = createSlackWorkspaceStore({ storeFactory });
  const byokCredentialsStore = createSlackByokCredentialsStore({ storeFactory, log });

  slackThreadAdapterInstance = new SlackThreadAdapter({
    signingSecret: managedSigningSecret,
    signingSecretProvider: async (workspace) => {
      if (workspace?.provisionMode === 'managed') {
        return managedSigningSecret;
      }
      if (workspace?.provisionMode === 'byok') {
        const creds = await byokCredentialsStore.get();
        return creds?.signingSecret ?? null;
      }
      return null;
    },
    workspaceStore,
    broadcast: broadcastService,
  });

  const adapters = new Map<string, SlackThreadAdapter>();
  adapters.set(slackThreadAdapterInstance.kind, slackThreadAdapterInstance);

  externalConversationServiceInstance = createExternalConversationService({
    broadcast: broadcastService,
    errorReporter: getErrorReporter(),
    agentTurnRegistry,
    conversationScopeResolver,
    sessionStore: {
      getSession: (id: string) => store.getSession(id),
      updateSession: (id, mutator) => store.updateSession(id, mutator),
    },
    adapters,
  });

  slackThreadAdapterInstance.resumePendingDeliveries().catch((err: unknown) => {
    getErrorReporter().captureException(err, { area: 'external-conversation', phase: 'resume-pending-deliveries' });
  });

  triggerSlackInboundReplay().catch((err: unknown) => {
    getErrorReporter().captureException(err, { area: 'external-conversation', phase: 'replay-pending-slack-inbound' });
  });

  // Re-drive replay every time a fresh client connects so entries broadcast-dropped
  // during a no-client window get re-processed once a consumer is back. Replay is
  // routed via the slackInboundReplayRegistry so the factory does not need a
  // static or dynamic import on slackWebhook (avoiding the import cycle).
  if (unsubscribeClientConnectedReplay) {
    unsubscribeClientConnectedReplay();
  }
  unsubscribeClientConnectedReplay = cloudEventBroadcaster.onClientConnected(() => {
    triggerSlackInboundReplay().catch((err: unknown) => {
      getErrorReporter().captureException(err, {
        area: 'external-conversation',
        phase: 'replay-pending-slack-inbound-on-connect',
      });
    });
  });

  return externalConversationServiceInstance;
}

export function getExternalConversationService(): ExternalConversationService {
  if (!externalConversationServiceInstance) {
    throw new Error('External conversation service has not been initialized');
  }
  return externalConversationServiceInstance;
}

export function __setSlackThreadAdapterForTesting(adapter: SlackThreadAdapter | null): void {
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    return;
  }

  slackThreadAdapterInstance = adapter;
}
