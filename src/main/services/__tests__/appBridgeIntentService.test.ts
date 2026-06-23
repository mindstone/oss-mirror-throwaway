/**
 * appBridgeIntentService — Stage 7 unit tests.
 *
 * Covers:
 *   - `createConversation`: formatted prompt per intent, broadcast of
 *     `conversations:start-requested` + `intent:external-context-arrived`,
 *     breadcrumbs, graceful handling of broadcast failure.
 *   - `injectMessage`: submit-as-new-turn when idle, buffer-when-active,
 *     FIFO drain on `result` event, buffer overflow → RATE_LIMITED,
 *     unknown session → CAPABILITY_NOT_SUPPORTED, drain listener is
 *     idempotent across multiple appends.
 *   - `getState`: returns correct shape for idle/running + reflects
 *     pending buffer depth.
 *
 * The service is wired with fake deps so tests don't touch the real
 * BroadcastService, ErrorReporter, IncrementalSessionStore, or
 * agentTurnRegistry. Hermetic + fast.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BroadcastService } from '@core/broadcastService';
import type { ErrorReporter } from '@core/errorReporter';
import type { AgentEvent, AgentSession, AgentTurnMessage } from '@shared/types';
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

vi.mock('../../analytics', () => ({
  getOrGenerateAnonymousId: vi.fn(() => 'anon-123'),
  trackMainEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

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

function buildErrorReporter(): ErrorReporter & {
  breadcrumbs: Array<Parameters<ErrorReporter['addBreadcrumb']>[0]>;
  exceptions: Array<{ err: unknown; ctx?: Record<string, unknown> }>;
} {
  const breadcrumbs: Array<Parameters<ErrorReporter['addBreadcrumb']>[0]> = [];
  const exceptions: Array<{ err: unknown; ctx?: Record<string, unknown> }> = [];
  return {
    breadcrumbs,
    exceptions,
    addBreadcrumb: (b) => {
      breadcrumbs.push(b);
    },
    captureException: (err, ctx) => {
      exceptions.push({ err, ctx });
    },
    captureMessage: () => {},
  };
}

interface FakeTurnRegistry {
  active: Set<string>;
  turnBySession: Map<string, string>;
  listeners: Map<string, Array<(event: AgentEvent) => void>>;
  turnEndedListeners: Map<string, () => void>;
  hasActiveTurnForSession(sessionId: string): boolean;
  getActiveTurnForSession(sessionId: string): string | undefined;
  subscribeTurnEvents(turnId: string, listener: (event: AgentEvent) => void): () => void;
  onTurnEnded(turnId: string, listener: () => void): () => void;
  /** Simulate the agent dispatching an event for a turn — fires the listener. */
  fire(turnId: string, event: AgentEvent): void;
  fireTurnEnded(turnId: string): void;
}

function buildTurnRegistry(): FakeTurnRegistry {
  const active = new Set<string>();
  const turnBySession = new Map<string, string>();
  const listeners = new Map<string, Array<(event: AgentEvent) => void>>();
  const turnEndedListeners = new Map<string, () => void>();
  return {
    active,
    turnBySession,
    listeners,
    turnEndedListeners,
    hasActiveTurnForSession: (sessionId) => active.has(sessionId),
    getActiveTurnForSession: (sessionId) => turnBySession.get(sessionId),
    subscribeTurnEvents: (turnId, listener) => {
      const arr = listeners.get(turnId) ?? [];
      arr.push(listener);
      listeners.set(turnId, arr);
      return () => {
        const filtered = (listeners.get(turnId) ?? []).filter(l => l !== listener);
        listeners.set(turnId, filtered);
      };
    },
    onTurnEnded: (turnId, listener) => {
      turnEndedListeners.set(turnId, listener);
      return () => {
        turnEndedListeners.delete(turnId);
      };
    },
    fire: (turnId, event) => {
      const arr = listeners.get(turnId) ?? [];
      for (const listener of arr) listener(event);
    },
    fireTurnEnded: (turnId) => {
      turnEndedListeners.get(turnId)?.();
    },
  };
}

function buildDeps(
  overrides: Partial<AppBridgeIntentServiceDeps> = {},
): {
  deps: AppBridgeIntentServiceDeps;
  broadcast: ReturnType<typeof buildBroadcast>;
  errorReporter: ReturnType<typeof buildErrorReporter>;
  turnRegistry: FakeTurnRegistry;
} {
  const broadcast = buildBroadcast();
  const errorReporter = buildErrorReporter();
  const turnRegistry = buildTurnRegistry();
  let uuidCounter = 0;
  const defaults: AppBridgeIntentServiceDeps = {
    broadcast,
    errorReporter,
    getSession: async (id: string) => ({ id }),
    updateSession: async () => false,
    uuid: () => `uuid-${++uuidCounter}`,
    turnRegistry,
    now: () => 1_700_000_000_000,
  };
  return {
    deps: { ...defaults, ...overrides },
    broadcast,
    errorReporter,
    turnRegistry,
  };
}

function makeCreateReq(
  overrides: Partial<IntentConversationCreate> = {},
): IntentConversationCreate {
  return {
    appId: 'browser-extension',
    clientId: 'client-abc',
    intent: 'summarise',
    tabContext: { tabId: 11, url: 'https://stripe.com/pricing', title: 'Pricing' },
    pageContext: { title: 'Pricing', url: 'https://stripe.com/pricing', text: 'Prices' },
    ...overrides,
  };
}

function makeOfficeCreateReq(
  overrides: Partial<IntentConversationCreate> = {},
): IntentConversationCreate {
  return {
    appId: 'office-addin',
    clientId: 'office-client',
    intent: 'chat',
    documentContext: {
      host: 'word',
      title: 'Quarterly Plan.docx',
      url: 'file:///Quarterly%20Plan.docx',
    },
    ...overrides,
  };
}

function makeMessageReq(
  overrides: Partial<IntentConversationMessage> = {},
): IntentConversationMessage {
  return {
    appId: 'browser-extension',
    clientId: 'client-abc',
    text: 'hello',
    tabContext: { tabId: 11, url: 'https://stripe.com/pricing', title: 'Pricing' },
    ...overrides,
  };
}

function makeOfficeMessageReq(
  overrides: Partial<IntentConversationMessage> = {},
): IntentConversationMessage {
  return {
    appId: 'office-addin',
    clientId: 'office-client',
    text: 'follow up on this draft',
    documentContext: {
      host: 'word',
      title: 'Quarterly Plan.docx',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('appBridgeIntentService', () => {
  let service: AppBridgeIntentService;
  let broadcast: ReturnType<typeof buildBroadcast>;
  let errorReporter: ReturnType<typeof buildErrorReporter>;
  let turnRegistry: FakeTurnRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    const built = buildDeps();
    broadcast = built.broadcast;
    errorReporter = built.errorReporter;
    turnRegistry = built.turnRegistry;
    service = createAppBridgeIntentService(built.deps);
  });

  afterEach(() => {
    service.reset();
    browserConversationScopeRegistry.clearAll();
  });

  // ---- createConversation --------------------------------------------------

  it('createConversation: summarise emits the canonical prompt + both broadcasts', async () => {
    const result = await service.createConversation(makeCreateReq({ intent: 'summarise' }));

    expect(result).toMatchObject({ conversationId: 'uuid-1', state: 'new' });
    const startReq = broadcast.calls.find((c) => c.channel === 'conversations:start-requested');
    expect(startReq).toBeDefined();
    expect((startReq?.payload as { text: string }).text).toContain('Summarise the page');
    expect((startReq?.payload as { text: string }).text).toContain('stripe.com/pricing');
    expect((startReq?.payload as { switchToConversation: boolean }).switchToConversation).toBe(true);
    expect((startReq?.payload as { origin?: string }).origin).toBe('browser-extension');

    const ctxArrived = broadcast.calls.find(
      (c) => c.channel === APP_BRIDGE_BROADCAST_CHANNELS.EXTERNAL_CONTEXT_ARRIVED,
    );
    expect(ctxArrived).toBeDefined();
    expect((ctxArrived?.payload as { intent: string }).intent).toBe('summarise');
    expect((ctxArrived?.payload as { focus: boolean }).focus).toBe(true);
  });

  it('createConversation: ask-with-userText prefers the user question', async () => {
    const result = await service.createConversation(
      makeCreateReq({ intent: 'ask', userText: 'What is the annual plan cost?' }),
    );

    expect(result.conversationId).toBe('uuid-1');
    const startReq = broadcast.calls.find((c) => c.channel === 'conversations:start-requested');
    expect((startReq?.payload as { text: string }).text).toContain('annual plan cost');
  });

  it('createConversation: save_to_notes formats the save prompt', async () => {
    await service.createConversation(makeCreateReq({ intent: 'save_to_notes' }));
    const startReq = broadcast.calls.find((c) => c.channel === 'conversations:start-requested');
    expect((startReq?.payload as { text: string }).text).toContain('Save this page to my notes');
  });

  it('createConversation: adds selection blockquote when present', async () => {
    await service.createConversation(
      makeCreateReq({
        intent: 'ask',
        userText: 'Explain this',
        pageContext: {
          title: 'Article',
          url: 'https://example.com/a',
          selection: 'The interesting bit\nsecond line',
        },
      }),
    );
    const startReq = broadcast.calls.find((c) => c.channel === 'conversations:start-requested');
    const text = (startReq?.payload as { text: string }).text;
    expect(text).toContain('Selection:');
    expect(text).toContain('> The interesting bit');
    expect(text).toContain('> second line');
  });

  it('createConversation: records Sentry breadcrumbs with appId, intent, conversationId', async () => {
    await service.createConversation(makeCreateReq());
    const crumb = errorReporter.breadcrumbs.find((c) => c.message === 'intent-create-conversation');
    expect(crumb).toBeDefined();
    expect(crumb?.category).toBe('external-conversation');
    expect(crumb?.data).toMatchObject({
      kind: 'browser-tab',
      intent: 'summarise',
      conversationId: 'uuid-1',
    });
  });

  it('createConversation: binds browser conversations to their tab context', async () => {
    await service.createConversation(makeCreateReq());

    const binding = browserConversationScopeRegistry.get('uuid-1');
    expect(binding?.tabContext).toMatchObject({
      tabId: 11,
      url: 'https://stripe.com/pricing',
      title: 'Pricing',
    });
  });

  it('createConversation: switchToConversation:false suppresses focus on BOTH broadcasts', async () => {
    // Embedded chat (Stage 3 of 260421_embedded_chat_in_extension) sends
    // `switchToConversation: false` so the side panel does NOT yank
    // Rebel's window to the foreground. Both downstream broadcasts must
    // honour the flag — `conversations:start-requested` AND
    // `intent:external-context-arrived` (the "double focus" issue
    // flagged in plan review).
    await service.createConversation(
      makeCreateReq({ intent: 'chat', switchToConversation: false }),
    );

    const startReq = broadcast.calls.find(
      (c) => c.channel === 'conversations:start-requested',
    );
    expect(startReq).toBeDefined();
    expect((startReq?.payload as { switchToConversation: boolean }).switchToConversation).toBe(
      false,
    );

    const ctxArrived = broadcast.calls.find(
      (c) => c.channel === APP_BRIDGE_BROADCAST_CHANNELS.EXTERNAL_CONTEXT_ARRIVED,
    );
    expect(ctxArrived).toBeDefined();
    expect((ctxArrived?.payload as { focus: boolean }).focus).toBe(false);
  });

  it('createConversation: switchToConversation:true (explicit) preserves focus on BOTH broadcasts', async () => {
    // Backward-compat parity check — when the field is explicitly true
    // we must keep firing focus on both channels (popup quick actions
    // continue to land the user on the thread).
    await service.createConversation(
      makeCreateReq({ intent: 'summarise', switchToConversation: true }),
    );

    const startReq = broadcast.calls.find(
      (c) => c.channel === 'conversations:start-requested',
    );
    expect((startReq?.payload as { switchToConversation: boolean }).switchToConversation).toBe(
      true,
    );

    const ctxArrived = broadcast.calls.find(
      (c) => c.channel === APP_BRIDGE_BROADCAST_CHANNELS.EXTERNAL_CONTEXT_ARRIVED,
    );
    expect((ctxArrived?.payload as { focus: boolean }).focus).toBe(true);
  });

  it('createConversation: missing switchToConversation defaults to true (backward compat)', async () => {
    // Pre-Stage-3 callers (popup quick actions, MCP) never set the
    // field. The omission must continue to focus the window so we
    // don't break their UX silently.
    await service.createConversation(makeCreateReq({ intent: 'ask' }));

    const startReq = broadcast.calls.find(
      (c) => c.channel === 'conversations:start-requested',
    );
    expect((startReq?.payload as { switchToConversation: boolean }).switchToConversation).toBe(
      true,
    );

    const ctxArrived = broadcast.calls.find(
      (c) => c.channel === APP_BRIDGE_BROADCAST_CHANNELS.EXTERNAL_CONTEXT_ARRIVED,
    );
    expect((ctxArrived?.payload as { focus: boolean }).focus).toBe(true);
  });

  it('createConversation: chat intent with userText passes the user prompt through verbatim', async () => {
    // The "chat" kind comes from the embedded chat composer — there's
    // no canned template, just the user's own words plus page context.
    await service.createConversation(
      makeCreateReq({
        intent: 'chat',
        userText: 'What does this article say about CO2 emissions?',
        switchToConversation: false,
      }),
    );

    const startReq = broadcast.calls.find(
      (c) => c.channel === 'conversations:start-requested',
    );
    const text = (startReq?.payload as { text: string }).text;
    expect(text).toContain('What does this article say about CO2 emissions?');
    // Page context still flows through so the agent has grounding.
    expect(text).toContain('stripe.com/pricing');
    // No template prefix — chat skips the "Help me understand this page" /
    // "Summarise the page" canned wrappers.
    expect(text).not.toContain('Summarise the page');
    expect(text).not.toContain('Help me understand this page');
  });

  it('createConversation: office document context formats Document instead of Tab and preserves payload', async () => {
    await service.createConversation(
      makeOfficeCreateReq({
        userText: 'Summarise this draft',
        switchToConversation: false,
      }),
    );

    const startReq = broadcast.calls.find((c) => c.channel === 'conversations:start-requested');
    expect(startReq).toBeDefined();
    const text = (startReq?.payload as { text: string }).text;
    expect(text).toContain('Summarise this draft');
    expect(text).toContain('Document: Quarterly Plan.docx');
    expect(text).not.toContain('Tab:');

    const ctxArrived = broadcast.calls.find(
      (c) => c.channel === APP_BRIDGE_BROADCAST_CHANNELS.EXTERNAL_CONTEXT_ARRIVED,
    );
    expect((ctxArrived?.payload as { documentContext?: unknown }).documentContext).toEqual({
      host: 'word',
      title: 'Quarterly Plan.docx',
    });
  });

  it('createConversation: emits embedded intent analytics with document scope', async () => {
    await service.createConversation(makeOfficeCreateReq());

    expect(trackMainEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'Embedded Intent Scope Resolved',
      properties: expect.objectContaining({
        surface: 'office-addin',
        scopeType: 'document',
      }),
    }));
  });

  it('createConversation: chat intent without userText falls back to a generic chat opener', async () => {
    await service.createConversation(
      makeCreateReq({ intent: 'chat', userText: undefined, switchToConversation: false }),
    );
    const startReq = broadcast.calls.find(
      (c) => c.channel === 'conversations:start-requested',
    );
    const text = (startReq?.payload as { text: string }).text;
    // The fallback differs from the 'ask' fallback so the agent can
    // tell the surfaces apart from the prompt alone if needed.
    expect(text).toContain('Help me with this page');
    expect(text).toContain('stripe.com/pricing');
  });

  it('createConversation: waits briefly for the renderer-created session to materialize', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const getSession = vi.fn(async (id: string) => {
        reads += 1;
        return reads >= 3 ? { id } : null;
      });
      const built = buildDeps({ getSession });
      const materializingService = createAppBridgeIntentService(built.deps);

      const pending = materializingService.createConversation(makeCreateReq());
      await vi.waitFor(() => {
        expect(getSession).toHaveBeenCalledTimes(1);
      });
      await vi.advanceTimersByTimeAsync(25);
      await vi.waitFor(() => {
        expect(getSession).toHaveBeenCalledTimes(2);
      });
      await vi.advanceTimersByTimeAsync(50);

      await expect(pending).resolves.toMatchObject({ conversationId: 'uuid-1' });
      expect(getSession).toHaveBeenCalledTimes(3);
      expect(
        built.errorReporter.breadcrumbs.some(
          (crumb) => crumb.message === 'intent-create-session-not-yet-materialized',
        ),
      ).toBe(false);
      materializingService.reset();
    } finally {
      vi.useRealTimers();
    }
  });

  it('createConversation: wraps broadcast failure as INTERNAL_ERROR AppBridgeError', async () => {
    const built = buildDeps();
    const throwingBroadcast: BroadcastService = {
      sendToAllWindows: () => {
        throw new Error('no broadcaster');
      },
      sendToFocusedWindow: () => undefined,
    };
    const failingService = createAppBridgeIntentService({
      ...built.deps,
      broadcast: throwingBroadcast,
    });
    await expect(failingService.createConversation(makeCreateReq())).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 500,
    });
    // Original thrown Error is captured so ops can diagnose; the AppBridgeError
    // surfaced to the wire stays clean.
    expect(built.errorReporter.exceptions.length).toBe(1);
    expect(built.errorReporter.exceptions[0]?.ctx).toMatchObject({
      area: 'external-conversation',
      phase: 'create-broadcast',
    });
  });

  // ---- injectMessage -------------------------------------------------------

  it('injectMessage: no active turn → submits as new user turn', async () => {
    const result = await service.injectMessage('s1', makeMessageReq({ text: 'Follow-up please' }));

    expect(result).toMatchObject({ conversationId: 's1', state: 'submitted', queueSize: 0 });
    const startReq = broadcast.calls.find((c) => c.channel === 'conversations:start-requested');
    expect(startReq).toBeDefined();
    expect((startReq?.payload as { text: string; sessionId: string }).sessionId).toBe('s1');
    expect((startReq?.payload as { text: string }).text).toBe('Follow-up please');
    expect((startReq?.payload as { origin?: string }).origin).toBe('browser-extension');

    const crumb = errorReporter.breadcrumbs.find((c) => c.message === 'intent-message-submitted');
    expect(crumb).toBeDefined();
  });

  it('injectMessage: updates browser conversation binding from follow-up tab context', async () => {
    await service.injectMessage('s1', makeMessageReq({
      tabContext: {
        tabId: 22,
        url: 'https://example.com/updated',
        title: 'Updated',
      },
    }));

    const binding = browserConversationScopeRegistry.get('s1');
    expect(binding?.tabContext).toMatchObject({
      tabId: 22,
      url: 'https://example.com/updated',
      title: 'Updated',
    });
  });

  it('injectMessage: rejects follow-up attempts that would move a browser conversation to another tab', async () => {
    browserConversationScopeRegistry.bind('s1', {
      tabId: 11,
      url: 'https://stripe.com/pricing',
      title: 'Pricing',
    });

    await expect(
      service.injectMessage('s1', makeMessageReq({
        tabContext: {
          tabId: 22,
          url: 'https://example.com/other',
          title: 'Other',
        },
      })),
    ).rejects.toMatchObject({
      code: 'TAB_CONTEXT_DIVERGED',
      status: 410,
    });
  });

  it('injectMessage: active turn → buffered + IntentBufferedMessage broadcast + queueSize=1', async () => {
    turnRegistry.active.add('s1');
    turnRegistry.turnBySession.set('s1', 't1');

    const result = await service.injectMessage('s1', makeMessageReq({ text: 'Also, export pdf' }));

    expect(result).toMatchObject({ state: 'buffered', queueSize: 1 });
    // No new-turn broadcast should fire
    expect(
      broadcast.calls.some(
        (c) => c.channel === 'conversations:start-requested',
      ),
    ).toBe(false);
    // Buffered-message broadcast fires
    const bufferedBc = broadcast.calls.find(
      (c) => c.channel === APP_BRIDGE_BROADCAST_CHANNELS.BUFFERED_MESSAGE,
    );
    expect(bufferedBc).toBeDefined();
    expect((bufferedBc?.payload as { queueSize: number }).queueSize).toBe(1);

    // Drain listener was registered
    expect(turnRegistry.listeners.has('t1')).toBe(true);
  });

  it('injectMessage: office document context is preserved on buffered follow-ups', async () => {
    turnRegistry.active.add('s1');
    turnRegistry.turnBySession.set('s1', 't1');

    const result = await service.injectMessage('s1', makeOfficeMessageReq());

    expect(result).toMatchObject({ state: 'buffered', queueSize: 1 });
    const bufferedBc = broadcast.calls.find(
      (c) => c.channel === APP_BRIDGE_BROADCAST_CHANNELS.BUFFERED_MESSAGE,
    );
    expect((bufferedBc?.payload as { documentContext?: unknown }).documentContext).toEqual({
      host: 'word',
      title: 'Quarterly Plan.docx',
    });
    expect(trackMainEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'Embedded Intent Buffered',
      properties: expect.objectContaining({
        surface: 'office-addin',
        scopeType: 'document',
      }),
    }));
  });

  it('injectMessage: buffered queue grows FIFO and increments queueSize', async () => {
    turnRegistry.active.add('s1');
    turnRegistry.turnBySession.set('s1', 't1');

    const r1 = await service.injectMessage('s1', makeMessageReq({ text: 'first' }));
    const r2 = await service.injectMessage('s1', makeMessageReq({ text: 'second' }));
    const r3 = await service.injectMessage('s1', makeMessageReq({ text: 'third' }));

    expect(r1.queueSize).toBe(1);
    expect(r2.queueSize).toBe(2);
    expect(r3.queueSize).toBe(3);
    expect(service.getBufferSize('s1')).toBe(3);
  });

  it('injectMessage: drain listener stays idempotent across many buffered calls', async () => {
    turnRegistry.active.add('s1');
    turnRegistry.turnBySession.set('s1', 't1');

    const spy = vi.fn();
    turnRegistry.subscribeTurnEvents = (turnId, listener) => {
      spy(turnId);
      const arr = turnRegistry.listeners.get(turnId) ?? [];
      arr.push(listener);
      turnRegistry.listeners.set(turnId, arr);
      return () => {};
    };

    // Re-init so the spy is used
    const built = buildDeps({ turnRegistry });
    const svc = createAppBridgeIntentService(built.deps);

    for (let i = 0; i < 5; i++) {
      await svc.injectMessage('s1', makeMessageReq({ text: `msg-${i}` }));
    }
    // Listener should be registered exactly once despite 5 appends
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('t1');
  });

  it('injectMessage: buffer drain on result event replays in FIFO + emits buffer-drained', async () => {
    turnRegistry.active.add('s1');
    turnRegistry.turnBySession.set('s1', 't1');

    await service.injectMessage('s1', makeMessageReq({ text: 'first' }));
    await service.injectMessage('s1', makeMessageReq({ text: 'second' }));

    // Clear pre-drain broadcasts so assertions focus on drain-triggered ones
    const preDrainBroadcastCount = broadcast.calls.length;

    // Simulate turn completion. Drain fires on a microtask; wait for it.
    turnRegistry.active.delete('s1');
    turnRegistry.fire('t1', {
      type: 'result',
      sessionId: 's1',
      durationMs: 100,
      totalCostUsd: 0,
      subtype: 'success',
    } as unknown as AgentEvent);
    await new Promise<void>((r) => queueMicrotask(() => r()));

    const newCalls = broadcast.calls.slice(preDrainBroadcastCount);
    const startCalls = newCalls.filter((c) => c.channel === 'conversations:start-requested');
    expect(startCalls.length).toBe(2);
    expect((startCalls[0]?.payload as { text: string }).text).toBe('first');
    expect((startCalls[1]?.payload as { text: string }).text).toBe('second');
    const drained = newCalls.find((c) => c.channel === APP_BRIDGE_BROADCAST_CHANNELS.BUFFER_DRAINED);
    expect(drained).toBeDefined();
    expect((drained?.payload as { flushedIds: string[] }).flushedIds).toHaveLength(2);

    expect(service.getBufferSize('s1')).toBe(0);
  });

  it('injectMessage: error event drains the buffer exactly once even if turn-ended also fires', async () => {
    turnRegistry.active.add('s1');
    turnRegistry.turnBySession.set('s1', 't1');

    await service.injectMessage('s1', makeMessageReq({ text: 'first' }));
    const preDrainBroadcastCount = broadcast.calls.length;

    turnRegistry.active.delete('s1');
    turnRegistry.fire('t1', {
      type: 'error',
      sessionId: 's1',
      error: 'boom',
    } as unknown as AgentEvent);
    turnRegistry.fireTurnEnded('t1');
    await new Promise<void>((r) => queueMicrotask(() => r()));

    const newCalls = broadcast.calls.slice(preDrainBroadcastCount);
    const startCalls = newCalls.filter((c) => c.channel === 'conversations:start-requested');
    expect(startCalls).toHaveLength(1);
    expect((startCalls[0]?.payload as { text: string }).text).toBe('first');
    expect(
      newCalls.filter((c) => c.channel === APP_BRIDGE_BROADCAST_CHANNELS.BUFFER_DRAINED),
    ).toHaveLength(1);
  });

  it('injectMessage: turn-ended callback drains buffered messages on cancellation', async () => {
    turnRegistry.active.add('s1');
    turnRegistry.turnBySession.set('s1', 't1');

    await service.injectMessage('s1', makeMessageReq({ text: 'cancelled-follow-up' }));
    const preDrainBroadcastCount = broadcast.calls.length;

    turnRegistry.active.delete('s1');
    turnRegistry.fireTurnEnded('t1');
    await new Promise<void>((r) => queueMicrotask(() => r()));

    const newCalls = broadcast.calls.slice(preDrainBroadcastCount);
    const startCalls = newCalls.filter((c) => c.channel === 'conversations:start-requested');
    expect(startCalls).toHaveLength(1);
    expect((startCalls[0]?.payload as { text: string }).text).toBe('cancelled-follow-up');
  });

  it('injectMessage: unknown session → CAPABILITY_NOT_SUPPORTED', async () => {
    const built = buildDeps({ getSession: async () => null });
    const svc = createAppBridgeIntentService(built.deps);

    await expect(svc.injectMessage('missing', makeMessageReq())).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_SUPPORTED',
      status: 404,
    });
    // No broadcast for rejected requests
    expect(built.broadcast.calls.length).toBe(0);
  });

  it('injectMessage: empty conversationId → BAD_REQUEST', async () => {
    await expect(service.injectMessage('', makeMessageReq())).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      status: 400,
    });
  });

  it('injectMessage: buffer overflow (>50 entries) throws RATE_LIMITED', async () => {
    turnRegistry.active.add('s1');
    turnRegistry.turnBySession.set('s1', 't1');
    for (let i = 0; i < 50; i++) {
      await service.injectMessage('s1', makeMessageReq({ text: `bulk-${i}` }));
    }
    await expect(
      service.injectMessage('s1', makeMessageReq({ text: 'overflow' })),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
    });
  });

  // ---- getState ------------------------------------------------------------

  it('getState: idle session with empty buffer → idle + 0', async () => {
    const result = await service.getState('s1');
    expect(result).toMatchObject({
      conversationId: 's1',
      turnStatus: 'idle',
      pendingMessages: 0,
      lastAssistantAt: null,
    });
  });

  it('getState: active turn with pending buffer → running + N', async () => {
    turnRegistry.active.add('s1');
    turnRegistry.turnBySession.set('s1', 't1');
    await service.injectMessage('s1', makeMessageReq({ text: 'one' }));
    await service.injectMessage('s1', makeMessageReq({ text: 'two' }));
    const result = await service.getState('s1');
    expect(result.turnStatus).toBe('running');
    expect(result.pendingMessages).toBe(2);
  });

  it('getState: unknown session → CAPABILITY_NOT_SUPPORTED', async () => {
    const built = buildDeps({ getSession: async () => null });
    const svc = createAppBridgeIntentService(built.deps);
    await expect(svc.getState('missing')).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_SUPPORTED',
      status: 404,
    });
  });

  it('getState: lastAssistantAt advances after the registry fires an assistant_delta', async () => {
    turnRegistry.active.add('s1');
    turnRegistry.turnBySession.set('s1', 't1');
    await service.injectMessage('s1', makeMessageReq({ text: 'one' }));

    // Fire a delta — our drain listener captures lastAssistantAt
    turnRegistry.fire('t1', {
      type: 'assistant_delta',
      delta: 'hi',
    } as unknown as AgentEvent);

    const after = await service.getState('s1');
    expect(after.lastAssistantAt).toBe(1_700_000_000_000);
  });

  // ---- getMessages ---------------------------------------------------------

  // Build a message with just the fields selectVisibleMessages + the projector
  // care about. The test uses this builder so we don't have to keep stale
  // `usage`/`attachments` fields in sync with AgentTurnMessage.
  function buildMessage(overrides: Partial<AgentTurnMessage>): AgentTurnMessage {
    return {
      id: 'm',
      turnId: 't1',
      role: 'user',
      text: '',
      createdAt: 1_700_000_000_000,
      ...overrides,
    };
  }

  function buildSession(
    overrides: Partial<AgentSession> & { id: string },
  ): AgentSession {
    return {
      title: '',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      messages: [],
      eventsByTurn: {},
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      resolvedAt: null,
      ...overrides,
    };
  }

  it('getMessages: returns projected messages + idle status + title for a valid conversation', async () => {
    const session = buildSession({
      id: 's1',
      title: 'Summarising Stripe pricing',
      messages: [
        buildMessage({
          id: 'm1',
          turnId: 't1',
          role: 'user',
          text: 'Hello Rebel',
          createdAt: 1,
        }),
        buildMessage({
          id: 'm2',
          turnId: 't1',
          role: 'assistant',
          text: 'Hello back',
          createdAt: 2,
        }),
      ],
    });
    const built = buildDeps({ getSession: async () => session });
    const svc = createAppBridgeIntentService(built.deps);

    const result = await svc.getMessages('s1');

    expect(result).toMatchObject({
      conversationId: 's1',
      turnStatus: 'idle',
      conversationTitle: 'Summarising Stripe pricing',
    });
    expect(result.messages).toEqual([
      { id: 'm1', role: 'user', text: 'Hello Rebel', createdAt: 1, turnId: 't1' },
      { id: 'm2', role: 'assistant', text: 'Hello back', createdAt: 2, turnId: 't1' },
    ]);
  });

  it('getMessages: projects result-role messages as role="assistant" on the wire', async () => {
    // selectVisibleMessages keeps `result` messages as-is; the wire shape
    // collapses `result → assistant` so the extension renders a single
    // Rebel bubble per turn.
    const session = buildSession({
      id: 's1',
      messages: [
        buildMessage({ id: 'm1', turnId: 't1', role: 'user', text: 'question', createdAt: 1 }),
        buildMessage({ id: 'm2', turnId: 't1', role: 'result', text: 'final answer', createdAt: 2 }),
      ],
    });
    const built = buildDeps({ getSession: async () => session });
    const svc = createAppBridgeIntentService(built.deps);

    const result = await svc.getMessages('s1');

    expect(result.messages).toEqual([
      { id: 'm1', role: 'user', text: 'question', createdAt: 1, turnId: 't1' },
      { id: 'm2', role: 'assistant', text: 'final answer', createdAt: 2, turnId: 't1' },
    ]);
  });

  it('getMessages: filters hidden messages and system-prompt prefixes via selectVisibleMessages', async () => {
    // Mix visible + hidden content. selectVisibleMessages should drop:
    //   - `isHidden: true` messages
    //   - user messages starting with `[ONBOARDING...` / `<conversation_history>`
    //   - earlier assistant messages of a turn that has a later assistant
    // Everything else must round-trip through the projector.
    const session = buildSession({
      id: 's1',
      messages: [
        buildMessage({
          id: 'm-hidden',
          turnId: 't0',
          role: 'user',
          text: '[ONBOARDING STEP 1] setup',
          createdAt: 1,
        }),
        buildMessage({
          id: 'm-isHidden',
          turnId: 't0',
          role: 'user',
          text: 'secret context',
          isHidden: true,
          createdAt: 2,
        }),
        buildMessage({
          id: 'm-conv-history',
          turnId: 't0',
          role: 'user',
          text: '<conversation_history>replayed</conversation_history>',
          createdAt: 3,
        }),
        buildMessage({
          id: 'm-user',
          turnId: 't1',
          role: 'user',
          text: 'real question',
          createdAt: 4,
        }),
        buildMessage({
          id: 'm-asst-early',
          turnId: 't1',
          role: 'assistant',
          text: 'partial',
          createdAt: 5,
        }),
        buildMessage({
          id: 'm-asst-late',
          turnId: 't1',
          role: 'assistant',
          text: 'final',
          createdAt: 6,
        }),
      ],
    });
    const built = buildDeps({ getSession: async () => session });
    const svc = createAppBridgeIntentService(built.deps);

    const result = await svc.getMessages('s1');

    expect(result.messages.map((m) => m.id)).toEqual(['m-user', 'm-asst-late']);
  });

  it('getMessages: unknown conversation → CAPABILITY_NOT_SUPPORTED (404)', async () => {
    const built = buildDeps({ getSession: async () => null });
    const svc = createAppBridgeIntentService(built.deps);

    await expect(svc.getMessages('missing')).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_SUPPORTED',
      status: 404,
    });
  });

  it('getMessages: empty conversationId → BAD_REQUEST', async () => {
    await expect(service.getMessages('')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      status: 400,
    });
  });

  it('getMessages: turnStatus reflects the registry — running when turn active, idle otherwise', async () => {
    const session = buildSession({
      id: 's1',
      messages: [
        buildMessage({ id: 'm1', turnId: 't1', role: 'user', text: 'q', createdAt: 1 }),
      ],
    });
    const built = buildDeps({ getSession: async () => session });
    const svc = createAppBridgeIntentService(built.deps);

    // Idle path
    let result = await svc.getMessages('s1');
    expect(result.turnStatus).toBe('idle');

    // Flip the fake registry to active and re-check
    built.turnRegistry.active.add('s1');
    result = await svc.getMessages('s1');
    expect(result.turnStatus).toBe('running');
  });

  it('getMessages: empty conversations return messages: [] with idle status and no title', async () => {
    const session = buildSession({ id: 's1', messages: [], title: '' });
    const built = buildDeps({ getSession: async () => session });
    const svc = createAppBridgeIntentService(built.deps);

    const result = await svc.getMessages('s1');

    expect(result.messages).toEqual([]);
    expect(result.turnStatus).toBe('idle');
    expect(result.conversationTitle).toBeUndefined();
  });

  // ---- focusConversation (Stage 3 of 260421_embedded_chat_in_extension) ----

  it('focusConversation: validates the session then broadcasts a focus-only start-requested', async () => {
    const session = buildSession({ id: 's-focus', title: 'Existing chat' });
    const built = buildDeps({ getSession: async () => session });
    const svc = createAppBridgeIntentService(built.deps);

    const result = await svc.focusConversation('s-focus');

    expect(result).toEqual({ conversationId: 's-focus', focused: true });

    // Exactly one start-requested broadcast — the focus-only event.
    const startReqs = built.broadcast.calls.filter(
      (c) => c.channel === 'conversations:start-requested',
    );
    expect(startReqs).toHaveLength(1);
    const payload = startReqs[0]?.payload as {
      sessionId: string;
      text: string;
      sendMessage: boolean;
      switchToConversation: boolean;
      origin?: string;
    };
    expect(payload.sessionId).toBe('s-focus');
    expect(payload.text).toBe('');
    expect(payload.sendMessage).toBe(false);
    expect(payload.switchToConversation).toBe(true);
    // Origin is fixed to 'browser-extension' — focus is only ever fired
    // from the embedded chat side panel; no other surface uses it today.
    expect(payload.origin).toBe('browser-extension');

    // Focus must not fire EXTERNAL_CONTEXT_ARRIVED — the conversation
    // already exists, so there's no new external context to render.
    expect(
      built.broadcast.calls.some(
        (c) => c.channel === APP_BRIDGE_BROADCAST_CHANNELS.EXTERNAL_CONTEXT_ARRIVED,
      ),
    ).toBe(false);
  });

  it('focusConversation: records a Sentry breadcrumb', async () => {
    const session = buildSession({ id: 's-focus' });
    const built = buildDeps({ getSession: async () => session });
    const svc = createAppBridgeIntentService(built.deps);

    await svc.focusConversation('s-focus');

    const crumb = built.errorReporter.breadcrumbs.find(
      (c) => c.message === 'intent-focus-conversation',
    );
    expect(crumb).toBeDefined();
    expect(crumb?.category).toBe('external-conversation');
    expect(crumb?.data).toMatchObject({ conversationId: 's-focus' });
  });

  it('focusConversation: unknown conversation → CAPABILITY_NOT_SUPPORTED (404) and no broadcast', async () => {
    const built = buildDeps({ getSession: async () => null });
    const svc = createAppBridgeIntentService(built.deps);

    await expect(svc.focusConversation('missing')).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_SUPPORTED',
      status: 404,
    });
    // 404 must be emitted BEFORE any broadcast — otherwise we'd ask the
    // renderer to focus a session that doesn't exist.
    expect(built.broadcast.calls).toHaveLength(0);
  });

  it('focusConversation: empty conversationId → BAD_REQUEST', async () => {
    await expect(service.focusConversation('')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      status: 400,
    });
  });

  it('focusConversation: broadcast failure surfaces as INTERNAL_ERROR AppBridgeError', async () => {
    const built = buildDeps();
    const session = buildSession({ id: 's-focus' });
    const throwingBroadcast: BroadcastService = {
      sendToAllWindows: () => {
        throw new Error('no broadcaster');
      },
      sendToFocusedWindow: () => undefined,
    };
    const failingService = createAppBridgeIntentService({
      ...built.deps,
      broadcast: throwingBroadcast,
      getSession: async () => session,
    });
    await expect(failingService.focusConversation('s-focus')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 500,
    });
    expect(built.errorReporter.exceptions[0]?.ctx).toMatchObject({
      area: 'external-conversation',
      phase: 'focus-broadcast',
      conversationId: 's-focus',
    });
  });
});
