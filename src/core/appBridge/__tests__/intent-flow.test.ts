/**
 * Stage 7 integration tests — full HTTP path from `/intent/*` routes
 * through the `createAppBridgeIntentService` handler, validating the
 * race story that matters most: an active turn + incoming intent
 * message → buffered; same scenario N times in rapid succession → all
 * buffered, all drained in order.
 *
 * Unlike the unit tests for `appBridgeIntentService`, this suite wires
 * the real bridge (binds a loopback port, exercises origin/host guards,
 * goes through Zod), so a regression in the wiring layer surfaces here.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { createAppBridge, type AppBridgeHandle } from '@core/appBridge/server/bridge';
import { createAppBridgeIntentService } from '../../../main/services/appBridgeIntentService';
import { APP_BRIDGE_BROADCAST_CHANNELS } from '@shared/ipc/channels/appBridge';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

interface TestBroadcast {
  calls: Array<{ channel: string; payload: unknown }>;
  sendToAllWindows: (channel: string, ...args: unknown[]) => void;
  sendToFocusedWindow: (channel: string, ...args: unknown[]) => void;
}

function makeBroadcast(): TestBroadcast {
  const calls: Array<{ channel: string; payload: unknown }> = [];
  return {
    calls,
    sendToAllWindows: (channel, ...args) => calls.push({ channel, payload: args[0] }),
    sendToFocusedWindow: (channel, ...args) => calls.push({ channel, payload: args[0] }),
  };
}

function buildBasicErrorReporter() {
  const breadcrumbs: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const exceptions: unknown[] = [];
  return {
    breadcrumbs,
    exceptions,
    addBreadcrumb: (b: {
      message: string;
      category: string;
      level?: string;
      data?: Record<string, unknown>;
    }) => {
      breadcrumbs.push({ message: b.message, data: b.data });
    },
    captureException: (err: unknown) => {
      exceptions.push(err);
    },
    captureMessage: () => {},
  };
}

interface FakeTurnRegistry {
  active: Set<string>;
  turnBySession: Map<string, string>;
  listeners: Map<string, (event: AgentEvent) => void>;
  hasActiveTurnForSession(sessionId: string): boolean;
  getActiveTurnForSession(sessionId: string): string | undefined;
  setEventListener(turnId: string, listener: (event: AgentEvent) => void): void;
  fire(turnId: string, event: AgentEvent): void;
}

function makeTurnRegistry(): FakeTurnRegistry {
  const active = new Set<string>();
  const turnBySession = new Map<string, string>();
  const listeners = new Map<string, (event: AgentEvent) => void>();
  return {
    active,
    turnBySession,
    listeners,
    hasActiveTurnForSession: (id) => active.has(id),
    getActiveTurnForSession: (id) => turnBySession.get(id),
    setEventListener: (turnId, listener) => listeners.set(turnId, listener),
    fire: (turnId, event) => {
      const l = listeners.get(turnId);
      if (l) l(event);
    },
  };
}

const handles: AppBridgeHandle[] = [];
const dirs: string[] = [];

let portBase = 54300;
function nextPortRange(count = 3): number[] {
  const start = portBase;
  portBase += count + 1;
  return Array.from({ length: count }, (_, i) => start + i);
}

async function makeStateDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'intent-flow-test-'));
  dirs.push(d);
  return d;
}

async function requestJson(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

beforeEach(() => {
  process.env['REBEL_APP_BRIDGE_DEV'] = '1';
});

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.stop().catch(() => undefined);
  }
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) await fs.rm(d, { recursive: true, force: true });
  }
  delete process.env['REBEL_APP_BRIDGE_DEV'];
});

describe('Stage 7 — intent flow integration', () => {
  it('create → inject while idle → submitted as new turn via broadcast', async () => {
    const broadcast = makeBroadcast();
    const errorReporter = buildBasicErrorReporter();
    const turnRegistry = makeTurnRegistry();
    const knownSessions = new Set<string>();

    const service = createAppBridgeIntentService({
      broadcast,
      errorReporter,
      turnRegistry,
      getSession: async (id) => (knownSessions.has(id) ? { id } : null),
      uuid: () => 'uuid-create-1',
    });

    const stateDir = await makeStateDir();
    const handle = await createAppBridge({
      stateDirectory: stateDir,
      portCandidates: nextPortRange(),
      allowedChromeExtensionIds: [EXT_ID],
      intentHandlers: {
        createConversation: (req) => service.createConversation(req),
        injectMessage: (conversationId, req) => service.injectMessage(conversationId, req),
        getConversationState: (conversationId) => service.getState(conversationId),
      },
    });
    handles.push(handle);

    // 1. createConversation
    const createRes = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/create`,
      { Origin: `chrome-extension://${EXT_ID}`, Host: `127.0.0.1:${handle.port}` },
      JSON.stringify({
        appId: 'browser-extension',
        clientId: 'c1',
        intent: 'summarise',
        tabContext: { tabId: 1, url: 'https://stripe.com' },
      }),
    );
    expect(createRes.status).toBe(200);
    const conversationId = (createRes.body as { conversationId: string }).conversationId;
    knownSessions.add(conversationId);

    // 2. injectMessage (idle → submitted)
    const injectRes = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/${conversationId}/message`,
      { Origin: `chrome-extension://${EXT_ID}`, Host: `127.0.0.1:${handle.port}` },
      JSON.stringify({ appId: 'browser-extension', clientId: 'c1', text: 'And price in EUR?' }),
    );
    expect(injectRes.status).toBe(200);
    expect(injectRes.body).toMatchObject({
      success: true,
      conversationId,
      state: 'submitted',
      queueSize: 0,
    });
    // Two start-requested broadcasts: one for create, one for inject.
    const starts = broadcast.calls.filter((c) => c.channel === 'conversations:start-requested');
    expect(starts.length).toBe(2);
  });

  it('10 rapid-fire intents during an active turn → all buffered in order, drained in order', async () => {
    const broadcast = makeBroadcast();
    const errorReporter = buildBasicErrorReporter();
    const turnRegistry = makeTurnRegistry();
    const knownSessions = new Set<string>();

    const service = createAppBridgeIntentService({
      broadcast,
      errorReporter,
      turnRegistry,
      getSession: async (id) => (knownSessions.has(id) ? { id } : null),
      uuid: (() => {
        let n = 0;
        return () => `uuid-${++n}`;
      })(),
    });

    const stateDir = await makeStateDir();
    const handle = await createAppBridge({
      stateDirectory: stateDir,
      portCandidates: nextPortRange(),
      allowedChromeExtensionIds: [EXT_ID],
      intentHandlers: {
        createConversation: (req) => service.createConversation(req),
        injectMessage: (conversationId, req) => service.injectMessage(conversationId, req),
        getConversationState: (conversationId) => service.getState(conversationId),
      },
    });
    handles.push(handle);

    // Seed a conversation; mark active
    const sessionId = 'conv-race';
    knownSessions.add(sessionId);
    turnRegistry.active.add(sessionId);
    turnRegistry.turnBySession.set(sessionId, 'turn-race');

    // 10 rapid-fire sequential HTTP POSTs (serial to keep order deterministic)
    for (let i = 0; i < 10; i++) {
      const res = await requestJson(
        'POST',
        `http://127.0.0.1:${handle.port}/intent/conversation/${sessionId}/message`,
        { Origin: `chrome-extension://${EXT_ID}`, Host: `127.0.0.1:${handle.port}` },
        JSON.stringify({
          appId: 'browser-extension',
          clientId: 'c1',
          text: `msg-${i}`,
        }),
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ state: 'buffered' });
    }

    expect(service.getBufferSize(sessionId)).toBe(10);
    // All 10 buffered-message broadcasts should have fired
    const bufferedBroadcasts = broadcast.calls.filter(
      (c) => c.channel === APP_BRIDGE_BROADCAST_CHANNELS.BUFFERED_MESSAGE,
    );
    expect(bufferedBroadcasts.length).toBe(10);

    // Simulate turn completion — drain
    turnRegistry.active.delete(sessionId);
    turnRegistry.fire('turn-race', {
      type: 'result',
      sessionId,
    } as unknown as AgentEvent);
    await new Promise<void>((r) => queueMicrotask(() => r()));

    // All 10 should be replayed as start-requested broadcasts in FIFO order
    const drained = broadcast.calls.filter(
      (c) => c.channel === 'conversations:start-requested',
    );
    // Only the 10 replay broadcasts (no create-new-conversation in this test)
    expect(drained.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect((drained[i]?.payload as { text: string }).text).toBe(`msg-${i}`);
    }

    const drainedBroadcast = broadcast.calls.find(
      (c) => c.channel === APP_BRIDGE_BROADCAST_CHANNELS.BUFFER_DRAINED,
    );
    expect(drainedBroadcast).toBeDefined();
    expect((drainedBroadcast?.payload as { flushedIds: string[] }).flushedIds).toHaveLength(10);
  });

  it('getState via HTTP reflects the current buffer depth + turnStatus', async () => {
    const broadcast = makeBroadcast();
    const errorReporter = buildBasicErrorReporter();
    const turnRegistry = makeTurnRegistry();
    const knownSessions = new Set<string>(['conv-stateful']);

    const service = createAppBridgeIntentService({
      broadcast,
      errorReporter,
      turnRegistry,
      getSession: async (id) => (knownSessions.has(id) ? { id } : null),
    });

    const stateDir = await makeStateDir();
    const handle = await createAppBridge({
      stateDirectory: stateDir,
      portCandidates: nextPortRange(),
      allowedChromeExtensionIds: [EXT_ID],
      intentHandlers: {
        getConversationState: (conversationId) => service.getState(conversationId),
        injectMessage: (conversationId, req) => service.injectMessage(conversationId, req),
      },
    });
    handles.push(handle);

    // State #1 — idle, empty
    const idleRes = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/conversation/conv-stateful/state`,
      { Origin: `chrome-extension://${EXT_ID}`, Host: `127.0.0.1:${handle.port}` },
    );
    expect(idleRes.status).toBe(200);
    expect(idleRes.body).toMatchObject({
      turnStatus: 'idle',
      pendingMessages: 0,
    });

    // Seed an active turn + buffer 3 messages via HTTP
    turnRegistry.active.add('conv-stateful');
    turnRegistry.turnBySession.set('conv-stateful', 'turn-stateful');
    for (let i = 0; i < 3; i++) {
      await requestJson(
        'POST',
        `http://127.0.0.1:${handle.port}/intent/conversation/conv-stateful/message`,
        { Origin: `chrome-extension://${EXT_ID}`, Host: `127.0.0.1:${handle.port}` },
        JSON.stringify({ appId: 'browser-extension', clientId: 'c1', text: `m-${i}` }),
      );
    }

    // State #2 — running, 3 pending
    const busyRes = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/conversation/conv-stateful/state`,
      { Origin: `chrome-extension://${EXT_ID}`, Host: `127.0.0.1:${handle.port}` },
    );
    expect(busyRes.status).toBe(200);
    expect(busyRes.body).toMatchObject({
      turnStatus: 'running',
      pendingMessages: 3,
    });
  });
});
