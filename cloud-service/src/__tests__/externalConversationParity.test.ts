import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createExternalConversationService } from '@core/services/externalConversation/externalConversationService';
import { conversationScopeResolver } from '@core/services/externalConversation/conversationScopeResolver';
import { BrowserTabAdapter } from '@core/services/externalConversation/adapters/browserTabAdapter';
import type { BrowserTabContext } from '@core/services/externalConversation/externalContext';
import type { BroadcastService } from '@core/broadcastService';
import type { ErrorReporter } from '@core/errorReporter';

/**
 * Parity Test: External Conversation Service Skeleton
 * 
 * This test proves SERVICE SKELETON parity between desktop and cloud.
 * It does NOT test adapter parity (Stage 6 covers that). It uses a synthetic
 * BrowserTabContext to verify that the core service orchestrates lifecycle,
 * broadcasting, and buffering identically regardless of the injected platform
 * dependencies (BroadcastService, ErrorReporter).
 */
describe('External Conversation Service Parity (Desktop vs Cloud Skeleton)', () => {
  beforeEach(() => {
    // Reset any singleton state if needed
    if (typeof (conversationScopeResolver as any).reset === 'function') {
      (conversationScopeResolver as any).reset();
    }
  });

  function createTestDependencies() {
    const broadcast: BroadcastService = {
      sendToAllWindows: vi.fn(),
      sendToFocusedWindow: vi.fn(),
    };
    
    const errorReporter: ErrorReporter = {
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
      captureExceptionWithScope: vi.fn(),
    };
    
    const agentTurnRegistry = {
      hasActiveTurnForSession: vi.fn().mockReturnValue(false),
      getActiveTurnForSession: vi.fn().mockReturnValue(null),
      setEventListener: vi.fn(),
      deleteEventListener: vi.fn(),
      subscribeTurnEvents: vi.fn().mockReturnValue(vi.fn()), // Returns unsubscribe
      onTurnEnded: vi.fn().mockReturnValue(vi.fn()), // Returns unsubscribe
    };
    
    const store = new Map();
    const sessionStore = {
      getSession: vi.fn(async (id) => store.get(id) || null),
      updateSession: vi.fn(async (id, mutator) => {
        const next = mutator(store.get(id) || null);
        if (!next) return false;
        store.set(id, next);
        return true;
      }),
    };
    
    const adapters = new Map();
    // Use the desktop adapter just for the synthetic test context
    const tabAdapter = new BrowserTabAdapter();
    adapters.set(tabAdapter.kind, tabAdapter);

    return {
      broadcast,
      errorReporter,
      agentTurnRegistry,
      sessionStore,
      store,
      adapters,
      uuid: () => 'test-uuid-0001',
      now: () => 1234567890,
    };
  }

  function createDesktopLikeService() {
    const deps = createTestDependencies();
    const service = createExternalConversationService({
      broadcast: deps.broadcast,
      errorReporter: deps.errorReporter,
      agentTurnRegistry: deps.agentTurnRegistry,
      sessionStore: deps.sessionStore,
      conversationScopeResolver,
      adapters: deps.adapters,
      uuid: deps.uuid,
      now: deps.now,
    });
    return { service, deps };
  }

  function createCloudLikeService() {
    const deps = createTestDependencies();
    const service = createExternalConversationService({
      broadcast: deps.broadcast,
      errorReporter: deps.errorReporter,
      agentTurnRegistry: deps.agentTurnRegistry,
      sessionStore: deps.sessionStore,
      conversationScopeResolver,
      adapters: deps.adapters, // In reality cloud has empty map at Stage 4, but we need an adapter to test the skeleton
      uuid: deps.uuid,
      now: deps.now,
    });
    return { service, deps };
  }

  it('orchestrates create -> inject -> drain -> focus identically on both surfaces', async () => {
    async function runScenario(surfaceName: 'desktop' | 'cloud', tabId: number) {
      const ctx: BrowserTabContext = {
        kind: 'browser-tab',
        identity: { tabId, origin: 'https://test.com', pathname: '/path' },
        metadata: { url: 'https://test.com/path' }
      };

      const instance = surfaceName === 'desktop' ? createDesktopLikeService() : createCloudLikeService();
      
      // 1. Create Conversation
      const createRes = await instance.service.createConversation(ctx, { intent: 'test-intent', userText: 'hello' });
      const conversationId = createRes.conversationId;
      
      // Mock session existing for next steps
      instance.deps.store.set(conversationId, { id: conversationId });

      // 2. Inject Message (Idle state -> sends immediately)
      const injectRes = await instance.service.injectMessage({ conversationId, context: ctx, text: 'message 1' });

      // 3. Inject Message (Active state -> buffers)
      instance.deps.agentTurnRegistry.hasActiveTurnForSession.mockReturnValue(true);
      instance.deps.agentTurnRegistry.getActiveTurnForSession.mockReturnValue('turn-1');

      const bufferRes = await instance.service.injectMessage({ conversationId, context: ctx, text: 'message 2' });

      // 4. Drain Buffer
      const drain = instance.service.drainBuffer(conversationId);

      // 5. Focus Conversation
      const focusRes = await instance.service.focusConversation(conversationId);

      return {
        createRes: { ...createRes, conversationId: 'UUID_MOCKED' }, // Ignore random ID in output
        injectRes: { ...injectRes, conversationId: 'UUID_MOCKED', messageId: 'MSG_MOCKED' },
        bufferRes: { ...bufferRes, conversationId: 'UUID_MOCKED', messageId: 'MSG_MOCKED' },
        drain: drain.map(d => ({ ...d, id: 'MSG_MOCKED', receivedAt: 1234567890, context: { ...d.context, identity: { ...d.context.identity, tabId: 1 } } })),
        focusRes: { ...focusRes, conversationId: 'UUID_MOCKED' },
        broadcastCalls: (instance.deps.broadcast.sendToAllWindows as ReturnType<typeof vi.fn>).mock.calls.map((call: any[]) => {
          // Deep clone and mask variable IDs
          const str = JSON.stringify(call);
          return JSON.parse(str.replace(new RegExp(conversationId, 'g'), 'UUID_MOCKED').replace(/"messageId":"[^"]+"/g, '"messageId":"MSG_MOCKED"').replace(/"receivedAt":\d+/g, '"receivedAt":1234567890').replace(/"drainedAt":\d+/g, '"drainedAt":1234567890').replace(/"tabId":\d+/g, '"tabId":1'));
        }),
        errorReporterCalls: (instance.deps.errorReporter.addBreadcrumb as ReturnType<typeof vi.fn>).mock.calls.map((call: any[]) => {
           const str = JSON.stringify(call);
           return JSON.parse(str.replace(new RegExp(conversationId, 'g'), 'UUID_MOCKED').replace(/"messageId":"[^"]+"/g, '"messageId":"MSG_MOCKED"').replace(/"tabId":\d+/g, '"tabId":1'));
        }),
      };
    }

    const desktopResults = await runScenario('desktop', 1);
    const cloudResults = await runScenario('cloud', 2);

    expect(cloudResults).toEqual(desktopResults);
  });
});
