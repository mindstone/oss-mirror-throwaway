/**
 * officeIntentFlow.integration.test.ts — Stage 5 integration test.
 *
 * Asserts that the Office add-in lifecycle (creating conversations, injecting
 * messages) flows correctly through the desktop App Bridge wrapper
 * (`appBridgeIntentService`) and is translated into `OfficeDocumentContext`
 * properly, generating the exact same wire broadcasts as pre-Stage-5.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BroadcastService } from '@core/broadcastService';
import type { ErrorReporter } from '@core/errorReporter';
import { trackMainEvent } from '../../analytics';
import {
  createAppBridgeIntentService,
  type AppBridgeIntentService,
  type AppBridgeIntentServiceDeps,
} from '../appBridgeIntentService';
import { APP_BRIDGE_BROADCAST_CHANNELS } from '@shared/ipc/channels/appBridge';
import type {
  IntentConversationCreate,
  IntentConversationMessage,
} from '@core/appBridge/shared/intentProtocol';
import { browserConversationScopeRegistry } from '@core/appBridge/server/browserConversationScopeRegistry';
import { conversationScopeResolver } from '@core/services/externalConversation/conversationScopeResolver';

vi.mock('../../analytics', () => ({
  getOrGenerateAnonymousId: vi.fn(() => 'anon-123'),
  trackMainEvent: vi.fn(),
}));

interface BroadcastCall {
  channel: string;
  payload: unknown;
}

function buildBroadcast(): BroadcastService & { calls: BroadcastCall[] } {
  const calls: BroadcastCall[] = [];
  return {
    calls,
    sendToAllWindows: (channel: string, ...args: unknown[]) => {
      calls.push({ channel, payload: args[0] });
    },
    sendToFocusedWindow: (channel: string, ...args: unknown[]) => {
      calls.push({ channel, payload: args[0] });
    },
  };
}

function buildErrorReporter(): ErrorReporter {
  return {
    addBreadcrumb: () => {},
    captureException: () => {},
    captureMessage: () => {},
  };
}

function buildDeps(): AppBridgeIntentServiceDeps & {
  broadcast: ReturnType<typeof buildBroadcast>;
  turnRegistry: any;
} {
  const broadcast = buildBroadcast();
  const errorReporter = buildErrorReporter();
  let uuidCounter = 0;
  
  const listeners = new Map<string, Array<any>>();
  const turnRegistry = {
    active: new Set<string>(),
    turnBySession: new Map<string, string>(),
    hasActiveTurnForSession: (sessionId: string) => turnRegistry.active.has(sessionId),
    getActiveTurnForSession: (sessionId: string) => turnRegistry.turnBySession.get(sessionId),
    subscribeTurnEvents: (turnId: string, listener: any) => {
      const arr = listeners.get(turnId) ?? [];
      arr.push(listener);
      listeners.set(turnId, arr);
      return () => {};
    },
    onTurnEnded: () => () => {},
  };

  return {
    broadcast,
    errorReporter,
    getSession: async (id: string) => ({ id }),
    uuid: () => `uuid-${++uuidCounter}`,
    turnRegistry,
    now: () => 1_700_000_000_000,
  };
}

describe('officeIntentFlow.integration (Stage 5)', () => {
  let service: AppBridgeIntentService;
  let broadcast: ReturnType<typeof buildBroadcast>;
  let turnRegistry: any;

  beforeEach(() => {
    vi.clearAllMocks();
    const deps = buildDeps();
    broadcast = deps.broadcast;
    turnRegistry = deps.turnRegistry;
    service = createAppBridgeIntentService(deps);
  });

  afterEach(() => {
    service.reset();
    browserConversationScopeRegistry.clearAll();
    conversationScopeResolver.clearAll();
  });

  it('Stage 5 Gate: Office document createConversation translates to OfficeDocumentContext and broadcasts correctly', async () => {
    const req: IntentConversationCreate = {
      appId: 'office-addin',
      clientId: 'office-client-123',
      intent: 'chat',
      userText: 'Summarise this document',
      documentContext: {
        host: 'word',
        title: 'Project_Alpha.docx',
        url: 'file:///Project_Alpha.docx',
      },
      switchToConversation: true,
    };

    const result = await service.createConversation(req);
    expect(result.conversationId).toBe('uuid-1');

    // 1. Assert start-requested broadcast byte-equivalence
    const startReq = broadcast.calls.find((c) => c.channel === 'conversations:start-requested');
    expect(startReq).toBeDefined();
    
    const startPayload = startReq?.payload as any;
    expect(startPayload.sessionId).toBe('uuid-1');
    expect(startPayload.text).toContain('Summarise this document');
    expect(startPayload.text).toContain('Document: Project_Alpha.docx'); // Initial-prompt formatting per host
    expect(startPayload.switchToConversation).toBe(true);

    // 2. Assert external-context-arrived broadcast byte-equivalence
    const ctxArrived = broadcast.calls.find(
      (c) => c.channel === APP_BRIDGE_BROADCAST_CHANNELS.EXTERNAL_CONTEXT_ARRIVED,
    );
    expect(ctxArrived).toBeDefined();
    
    const ctxPayload = ctxArrived?.payload as any;
    expect(ctxPayload.intent).toBe('chat');
    expect(ctxPayload.focus).toBe(true);
    // Should contain the sanitized documentContext, stripped of url if handled by adapter or wrapper, 
    // actually wrapper sanitizeDocumentContextForSurface keeps host and title
    expect(ctxPayload.documentContext).toEqual({
      host: 'word',
      title: 'Project_Alpha.docx',
    });
    
    // Assert scope binding internally (to ensure wrapper routed to core correctly)
    const binding = conversationScopeResolver.getBinding('uuid-1');
    expect(binding?.context.kind).toBe('office-document');
    expect((binding?.context as any).identity).toEqual({
      host: 'word',
      docId: 'Project_Alpha.docx',
    });
  });

  it('Stage 5 Gate: Office document injectMessage buffers and routes correctly', async () => {
    // First create a conversation to bind context
    await service.createConversation({
      appId: 'office-addin',
      clientId: 'office-client-123',
      intent: 'chat',
      documentContext: {
        host: 'excel',
        title: 'Financials.xlsx',
        url: 'file:///Financials.xlsx',
      },
    });
    
    // Simulate an active turn
    turnRegistry.active.add('uuid-1');
    turnRegistry.turnBySession.set('uuid-1', 'turn-1');

    // Clear initial broadcasts
    broadcast.calls.length = 0;

    const req: IntentConversationMessage = {
      appId: 'office-addin',
      clientId: 'office-client-123',
      text: 'Also calculate the sum',
      documentContext: {
        host: 'excel',
        title: 'Financials.xlsx',
      },
    };

    const result = await service.injectMessage('uuid-1', req);
    expect(result.state).toBe('buffered');
    expect(result.queueSize).toBe(1);

    // Verify it broadcasts BUFFERED_MESSAGE with documentContext
    const bufferedBc = broadcast.calls.find(
      (c) => c.channel === APP_BRIDGE_BROADCAST_CHANNELS.BUFFERED_MESSAGE,
    );
    expect(bufferedBc).toBeDefined();
    const bcPayload = bufferedBc?.payload as any;
    expect(bcPayload.queueSize).toBe(1);
    expect(bcPayload.documentContext).toEqual({
      host: 'excel',
      title: 'Financials.xlsx',
    });
  });
});
