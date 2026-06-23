import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorReporter } from '@core/errorReporter';
import type { BroadcastService } from '@core/broadcastService';
import type { AgentSession, AgentTurnMessage } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { getIncrementalSessionStore } from '@core/services/incrementalSessionStore';
import { getOrGenerateAnonymousId, trackMainEvent } from '../analytics';
import { ErrorCode, createAppBridgeError } from '@core/appBridge/shared/errors';
import { tabContextToBrowserTabContext } from '@core/appBridge/server/browserConversationScopeRegistry';
import type {
  IntentConversationCreate,
  IntentConversationCreateResult,
  IntentConversationFocusResult,
  IntentConversationHistoryResult,
  IntentConversationMessage,
  IntentConversationMessageResult,
  IntentConversationStateResult,
  IntentMessageWire,
} from '@core/appBridge/shared/intentProtocol';
import { selectVisibleMessages } from '@rebel/shared';
import type { ConversationStreamCoordinator } from '@core/appBridge/server/conversationStreamCoordinator';

import { createExternalConversationService } from '@core/services/externalConversation/externalConversationService';
import { BrowserTabAdapter } from '@core/services/externalConversation/adapters/browserTabAdapter';
import { OfficeDocumentAdapter } from '@core/services/externalConversation/adapters/officeDocumentAdapter';
import { conversationScopeResolver } from '@core/services/externalConversation/conversationScopeResolver';
import type { ExternalContext, BrowserTabContext, OfficeDocumentContext } from '@core/services/externalConversation/externalContext';

const log = createScopedLogger({ service: 'appBridgeIntentService' });

export interface AppBridgeIntentServiceDeps {
  broadcast: BroadcastService;
  errorReporter: ErrorReporter;
  getSession?: (id: string) => Promise<Pick<AgentSession, 'id'> & Partial<AgentSession> | null>;
  updateSession?: (
    id: string,
    mutator: (existing: AgentSession | null) => AgentSession | null,
  ) => Promise<boolean>;
  uuid?: () => string;
  turnRegistry?: any;
  now?: () => number;
  streamCoordinator?: ConversationStreamCoordinator;
}

export interface AppBridgeIntentService {
  createConversation(req: IntentConversationCreate): Promise<IntentConversationCreateResult>;
  injectMessage(conversationId: string, req: IntentConversationMessage): Promise<IntentConversationMessageResult>;
  getState(conversationId: string): Promise<IntentConversationStateResult>;
  getMessages(conversationId: string): Promise<IntentConversationHistoryResult>;
  streamConversation(conversationId: string, req: IncomingMessage, res: ServerResponse, hashedToken: string): Promise<void>;
  focusConversation(conversationId: string): Promise<IntentConversationFocusResult>;
  drainBuffer(conversationId: string): any[];
  getBufferSize(conversationId: string): number;
  reset(): void;
}

export function createAppBridgeIntentService(deps: AppBridgeIntentServiceDeps): AppBridgeIntentService {
  const resolvedGetSession = deps.getSession ?? (async (id) => {
    const store = getIncrementalSessionStore();
    return store.getSession(id);
  });
  const resolvedUpdateSession = deps.updateSession ?? (async (id, mutator) => {
    const store = getIncrementalSessionStore();
    return store.updateSession(id, mutator);
  });

  const adapters = new Map<string, any>();
  const browserTabAdapter = new BrowserTabAdapter();
  const officeDocumentAdapter = new OfficeDocumentAdapter();
  adapters.set(browserTabAdapter.kind, browserTabAdapter);
  adapters.set(officeDocumentAdapter.kind, officeDocumentAdapter);

  const coreService = createExternalConversationService({
    broadcast: deps.broadcast,
    errorReporter: deps.errorReporter,
    agentTurnRegistry: deps.turnRegistry ?? agentTurnRegistry,
    sessionStore: { getSession: resolvedGetSession, updateSession: resolvedUpdateSession },
    uuid: deps.uuid,
    now: deps.now,
    streamCoordinator: deps.streamCoordinator,
    conversationScopeResolver: conversationScopeResolver,
    adapters,
  });

  function sanitizeDocumentContextForSurface(appId: string, documentContext?: any) {
    if (!documentContext || appId !== 'office-addin') return documentContext;
    return {
      ...(documentContext.host ? { host: documentContext.host } : {}),
      ...(documentContext.title ? { title: documentContext.title } : {}),
    };
  }

  function emitIntentAnalyticsEvent(eventName: string, props: Record<string, any>): void {
    try {
      trackMainEvent({
        event: eventName,
        properties: {
          anonymousId: getOrGenerateAnonymousId(),
          ...props,
        }
      } as any);
    } catch (err) {
      log.warn({ err }, 'Failed to track intent event');
    }
  }

  function getBoundContext(
    conversationId: string | undefined,
    kind: ExternalContext['kind'],
  ): ExternalContext | undefined {
    if (!conversationId) return undefined;
    const binding = conversationScopeResolver.getBinding(conversationId);
    return binding?.context.kind === kind ? binding.context : undefined;
  }

  function toExternalContext(appId: string, tabContext?: any, documentContext?: any, conversationId?: string): ExternalContext {
    if (appId === 'office-addin') {
      const boundContext = !documentContext
        ? getBoundContext(conversationId, 'office-document')
        : undefined;
      if (boundContext) return boundContext;

      const sanitized = sanitizeDocumentContextForSurface(appId, documentContext);
      let docId = 'unknown';
      if (sanitized?.url) docId = sanitized.url;
      else if (sanitized?.title) docId = sanitized.title;

      return {
        kind: 'office-document',
        identity: {
          host: sanitized?.host ?? 'unknown',
          docId,
        },
        metadata: {
          title: sanitized?.title,
          url: sanitized?.url,
        }
      } as OfficeDocumentContext;
    }

    const boundContext = !tabContext
      ? getBoundContext(conversationId, 'browser-tab')
      : undefined;
    if (boundContext) return boundContext;

    if (tabContext) {
      return tabContextToBrowserTabContext(tabContext);
    }

    return {
      kind: 'browser-tab',
      identity: {
        tabId: -1,
        origin: '',
        pathname: '',
      },
      metadata: {
        url: '',
      }
    } as BrowserTabContext;
  }

  function hasBindableContext(req: IntentConversationCreate | IntentConversationMessage): boolean {
    if (req.appId === 'office-addin') {
      return Boolean(req.documentContext);
    }
    if (req.appId === 'browser-extension') {
      return Boolean(req.tabContext);
    }
    return true;
  }

  async function createConversation(req: IntentConversationCreate): Promise<IntentConversationCreateResult> {
    const ctx = toExternalContext(req.appId, req.tabContext, req.documentContext);

    const focus = req.switchToConversation ?? true;
    emitIntentAnalyticsEvent('Embedded Intent Scope Resolved', {
      surface: req.appId,
      intent: req.intent,
      focus,
      scopeType: req.documentContext ? 'document' : req.tabContext ? 'tab' : 'unknown',
    });

    try {
      const res = await coreService.createConversation(ctx, {
        intent: req.intent,
        userText: req.userText,
        pageContext: req.pageContext,
        switchToConversation: focus,
      });
      return { conversationId: res.conversationId, state: res.state as any };
    } catch (err: any) {
      if (err.code && err.status) {
        throw createAppBridgeError(err.code, err.message);
      }
      throw err;
    }
  }

  async function injectMessage(conversationId: string, req: IntentConversationMessage): Promise<IntentConversationMessageResult> {
    if (!conversationId || conversationId.trim().length === 0) {
      throw createAppBridgeError(ErrorCode.BAD_REQUEST, 'Missing conversationId in /intent/conversation/:id/message.');
    }

    const ctx = toExternalContext(req.appId, req.tabContext, req.documentContext, conversationId);

    try {
      const res = await coreService.injectMessage({
        conversationId,
        context: ctx,
        text: req.text,
        canBindContext: hasBindableContext(req),
      });

      if (res.state === 'buffered') {
        emitIntentAnalyticsEvent('Embedded Intent Buffered', {
          surface: req.appId,
          queueSize: res.queueSize,
          scopeType: req.documentContext ? 'document' : req.tabContext ? 'tab' : 'unknown',
        });
      }

      return { conversationId: res.conversationId, messageId: res.messageId, state: res.state as any, queueSize: res.queueSize };
    } catch (err: any) {
      if (err.code && err.status) {
        throw createAppBridgeError(err.code, err.message);
      }
      throw err;
    }
  }

  async function getState(conversationId: string): Promise<IntentConversationStateResult> {
    if (!conversationId || conversationId.trim().length === 0) {
      throw createAppBridgeError(ErrorCode.BAD_REQUEST, 'Missing conversationId in /intent/conversation/:id/state.');
    }
    try {
      const res = await coreService.getState(conversationId);
      return { conversationId, turnStatus: res.turnStatus as any, pendingMessages: res.pendingMessages, lastAssistantAt: res.lastAssistantAt };
    } catch (err: any) {
      if (err.code && err.status) {
        throw createAppBridgeError(err.code, err.message);
      }
      throw err;
    }
  }

  function projectMessage(message: AgentTurnMessage): IntentMessageWire {
    return {
      id: message.id,
      role: message.role === 'user' ? 'user' : 'assistant',
      text: message.text,
      createdAt: message.createdAt,
      turnId: message.turnId,
    };
  }

  async function getMessages(conversationId: string): Promise<IntentConversationHistoryResult> {
    if (!conversationId || conversationId.trim().length === 0) {
      throw createAppBridgeError(ErrorCode.BAD_REQUEST, 'Missing conversationId in /intent/conversation/:id/messages.');
    }
    try {
      const res = await coreService.getMessages(conversationId);
      const rawMessages: AgentTurnMessage[] = Array.isArray(res.messages) ? res.messages : [];
      const visible = selectVisibleMessages(rawMessages);
      const messages = visible.map(projectMessage);
      return {
        conversationId,
        messages,
        turnStatus: res.turnStatus as any,
        ...(res.conversationTitle ? { conversationTitle: res.conversationTitle } : {}),
      };
    } catch (err: any) {
      if (err.code && err.status) {
        throw createAppBridgeError(err.code, err.message);
      }
      throw err;
    }
  }

  async function streamConversation(conversationId: string, req: IncomingMessage, res: ServerResponse, hashedToken: string): Promise<void> {
    if (!conversationId || conversationId.trim().length === 0) {
      throw createAppBridgeError(ErrorCode.BAD_REQUEST, 'Missing conversationId in /intent/conversation/:id/stream.');
    }
    try {
      await coreService.streamConversation(conversationId, req, res, hashedToken);
    } catch (err: any) {
      if (err.code && err.status) {
        throw createAppBridgeError(err.code, err.message);
      }
      throw err;
    }
  }

  async function focusConversation(conversationId: string): Promise<IntentConversationFocusResult> {
    if (!conversationId || conversationId.trim().length === 0) {
      throw createAppBridgeError(ErrorCode.BAD_REQUEST, 'Missing conversationId in /intent/conversation/:id/focus.');
    }
    try {
      const res = await coreService.focusConversation(conversationId);
      return { conversationId, focused: res.focused };
    } catch (err: any) {
      if (err.code && err.status) {
        throw createAppBridgeError(err.code, err.message);
      }
      throw err;
    }
  }

  function drainBuffer(conversationId: string) {
    return coreService.drainBuffer(conversationId);
  }

  function getBufferSize(conversationId: string): number {
    return coreService.getBufferSize(conversationId);
  }

  function reset(): void {
    coreService.reset();
  }

  return {
    createConversation,
    injectMessage,
    getState,
    getMessages,
    streamConversation,
    focusConversation,
    drainBuffer,
    getBufferSize,
    reset,
  };
}
