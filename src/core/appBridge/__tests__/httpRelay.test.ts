/**
 * Stage 4 httpRelay tests — end-to-end HTTP + WS.
 *
 * Spins up a full `createAppBridge` + a real WebSocket client so each test
 * exercises the router-internal token → capability registry → command
 * dispatch → response pipeline on the wire. Uses the `ws` client because
 * the CommandRouter speaks WS frames, not in-memory callbacks.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createAppBridge, type AppBridgeHandle } from '@core/appBridge/server/bridge';
import { browserConversationScopeRegistry } from '@core/appBridge/server/browserConversationScopeRegistry';
import {
  PROTOCOL_VERSION,
  WS_PATH,
} from '@core/appBridge/shared/protocol';

const ALLOWED_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${ALLOWED_EXTENSION_ID}`;
const TAB_CONTEXT = {
  tabId: 42,
  windowId: 7,
  url: 'https://example.com/form',
  title: 'Example form',
};

let testPortBase = 55800;
const cleanupHandles: AppBridgeHandle[] = [];
const cleanupDirs: string[] = [];
const openSockets: WebSocket[] = [];

async function makeStateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-bridge-http-relay-'));
  cleanupDirs.push(dir);
  return dir;
}

function nextPortRange(count = 3): number[] {
  const start = testPortBase;
  testPortBase += count + 1;
  return Array.from({ length: count }, (_, i) => start + i);
}

async function bootstrapBridge(): Promise<AppBridgeHandle> {
  const handle = await createAppBridge({
    stateDirectory: await makeStateDir(),
    portCandidates: nextPortRange(),
    allowedChromeExtensionIds: [ALLOWED_EXTENSION_ID],
  });
  cleanupHandles.push(handle);
  return handle;
}

interface HttpResponse {
  status: number;
  body: string;
  json: unknown;
}

function httpRequest(
  options: {
    port: number;
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string | null;
  },
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const body = options.body ?? null;
    const headers: Record<string, string> = {
      host: `127.0.0.1:${options.port}`,
      ...(options.headers ?? {}),
    };
    if (body !== null && !('content-type' in Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    ))) {
      headers['content-type'] = 'application/json';
    }
    if (body !== null) {
      headers['content-length'] = Buffer.byteLength(body).toString();
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = null;
          }
          resolve({
            status: res.statusCode ?? 0,
            body: text,
            json: parsed,
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}

function postApp(
  handle: AppBridgeHandle,
  capabilityId: string,
  options: {
    token?: string;
    appIdHeader?: string;
    appIdPath?: string;
    body?: unknown;
  } = {},
): Promise<HttpResponse> {
  const token = options.token ?? handle.routerInternalToken;
  const appIdHeader = options.appIdHeader ?? 'browser-extension';
  const appIdPath = options.appIdPath ?? 'browser-extension';
  const body =
    options.body !== undefined ? JSON.stringify(options.body) : JSON.stringify({});
  return httpRequest({
    port: handle.port,
    method: 'POST',
    path: `/apps/${appIdPath}/${capabilityId}`,
    headers: {
      authorization: `Bearer ${token}`,
      'x-rebel-app-id': appIdHeader,
    },
    body,
  });
}

function startAbortablePostApp(
  handle: AppBridgeHandle,
  capabilityId: string,
  options: { body?: unknown } = {},
): { req: http.ClientRequest; done: Promise<void> } {
  const body = options.body !== undefined ? JSON.stringify(options.body) : JSON.stringify({});
  let req!: http.ClientRequest;
  const done = new Promise<void>((resolve) => {
    req = http.request(
      {
        host: '127.0.0.1',
        port: handle.port,
        method: 'POST',
        path: `/apps/browser-extension/${capabilityId}`,
        headers: {
          authorization: `Bearer ${handle.routerInternalToken}`,
          'x-rebel-app-id': 'browser-extension',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body).toString(),
        },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });

  return { req, done };
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForOpen(ws: WebSocket, timeoutMs = 2_000): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('open timeout')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(t);
      resolve();
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(t);
      reject(new Error(`upgrade rejected ${res.statusCode}`));
    });
    ws.once('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

function waitForMessage(ws: WebSocket, timeoutMs = 2_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('message timeout')), timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function registerBrowserExtension(
  handle: AppBridgeHandle,
  capabilities: readonly { id: string; version?: string }[],
): Promise<WebSocket> {
  const token = handle.tokenStore.issueAppToken('browser-extension', 'client-1');
  const ws = new WebSocket(`ws://127.0.0.1:${handle.port}${WS_PATH}`, { origin: ORIGIN });
  openSockets.push(ws);
  await waitForOpen(ws);

  ws.send(
    JSON.stringify({
      type: 'auth',
      token,
      appId: 'browser-extension',
      clientId: 'client-1',
    }),
  );
  ws.send(
    JSON.stringify({
      type: 'register',
      protocolVersion: PROTOCOL_VERSION,
      appId: 'browser-extension',
      clientId: 'client-1',
      capabilities,
    }),
  );

  const ack = await waitForMessage(ws);
  if (ack['type'] !== 'registered') {
    throw new Error(`expected registered ack, got ${JSON.stringify(ack)}`);
  }
  return ws;
}

/**
 * Auto-respond to the next command frame on this WS with the provided
 * success payload. Keeps the test concise when we only need one round-trip.
 */
function autoRespondOnce(
  ws: WebSocket,
  reply:
    | { success: true; data: unknown }
    | { success: false; error: string; code?: string; details?: Record<string, unknown> },
): Promise<{ commandFrame: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData): void => {
      try {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (frame['type'] !== 'command') {
          return; // ignore heartbeat/register acks
        }
        ws.off('message', onMessage);
        const commandId = frame['id'];
        ws.send(
          JSON.stringify({
            type: 'response',
            id: commandId,
            ...reply,
          }),
        );
        resolve({ commandFrame: frame });
      } catch (err) {
        reject(err);
      }
    };
    ws.on('message', onMessage);
  });
}

beforeEach(() => {
  delete process.env['REBEL_APP_BRIDGE_DEV'];
});

afterEach(async () => {
  browserConversationScopeRegistry.clearAll();
  while (openSockets.length > 0) {
    const s = openSockets.pop();
    if (s && s.readyState !== WebSocket.CLOSED) {
      try {
        s.terminate();
      } catch {
        /* ignore */
      }
    }
  }
  while (cleanupHandles.length > 0) {
    const h = cleanupHandles.pop();
    if (h) await h.stop().catch(() => undefined);
  }
  while (cleanupDirs.length > 0) {
    const d = cleanupDirs.pop();
    if (d) await fs.rm(d, { recursive: true, force: true });
  }
});

describe('appBridge/server/httpRelay (Stage 4 dispatch)', () => {
  it('returns 401 when Authorization header is missing entirely', async () => {
    const handle = await bootstrapBridge();
    const res = await httpRequest({
      port: handle.port,
      method: 'POST',
      path: '/apps/browser-extension/read_page',
      headers: { 'x-rebel-app-id': 'browser-extension' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('returns 401 when a stranger token is presented', async () => {
    const handle = await bootstrapBridge();
    const res = await postApp(handle, 'read_page', {
      token: 'not-a-real-token-value',
    });
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('returns 405 METHOD_NOT_ALLOWED when GET is used on /apps/:appId/:capabilityId', async () => {
    const handle = await bootstrapBridge();
    const res = await httpRequest({
      port: handle.port,
      method: 'GET',
      path: '/apps/browser-extension/read_page',
      headers: {
        authorization: `Bearer ${handle.routerInternalToken}`,
        'x-rebel-app-id': 'browser-extension',
      },
    });
    expect(res.status).toBe(405);
    expect(res.json).toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
  });

  it('returns 503 APP_NOT_CONNECTED when no extension is registered', async () => {
    const handle = await bootstrapBridge();
    const res = await postApp(handle, 'read_page', { body: { payload: {} } });
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ code: 'APP_NOT_CONNECTED' });
  });

  it('returns 404 CAPABILITY_NOT_SUPPORTED when the connected app did not advertise the capability', async () => {
    const handle = await bootstrapBridge();
    // Register an extension that only advertises read_page.
    await registerBrowserExtension(handle, [{ id: 'read_page' }]);
    const res = await postApp(handle, 'fill_form', {
      body: { payload: { selector: '#q', value: 'x' } },
    });
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ code: 'CAPABILITY_NOT_SUPPORTED' });
  });

  it('allows status dispatch even when a stale extension registration omitted status', async () => {
    const handle = await bootstrapBridge();
    const ws = await registerBrowserExtension(handle, [{ id: 'read_page' }]);
    const responsePromise = autoRespondOnce(ws, {
      success: true,
      data: { tabId: 42, capabilities: [{ id: 'read_page' }] },
    });

    const res = await postApp(handle, 'status', { body: { payload: {} } });

    const { commandFrame } = await responsePromise;
    expect(commandFrame['action']).toBe('status');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      success: true,
      data: { tabId: 42 },
    });
  });

  it('dispatches a command and returns 200 with the app response on success', async () => {
    const handle = await bootstrapBridge();
    const ws = await registerBrowserExtension(handle, [{ id: 'read_page' }]);
    const responsePromise = autoRespondOnce(ws, {
      success: true,
      data: { title: 'Example', html: '<html/>' },
    });

    const res = await postApp(handle, 'read_page', {
      body: { payload: { tabContext: TAB_CONTEXT, url: 'https://example.com' } },
    });

    const { commandFrame } = await responsePromise;
    expect(commandFrame['type']).toBe('command');
    expect(commandFrame['action']).toBe('read_page');
    expect(commandFrame['params']).toEqual({ tabContext: TAB_CONTEXT, url: 'https://example.com' });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      success: true,
      data: { title: 'Example', html: '<html/>' },
    });
    expect(typeof (res.json as { commandId?: unknown }).commandId).toBe('string');
  });

  it('forwards payload tabContext as command tabContext for browser DOM tools', async () => {
    const handle = await bootstrapBridge();
    const ws = await registerBrowserExtension(handle, [{ id: 'read_page' }]);
    const responsePromise = autoRespondOnce(ws, {
      success: true,
      data: { title: 'Example', html: '<html/>' },
    });
    const res = await postApp(handle, 'read_page', {
      body: { payload: { tabContext: TAB_CONTEXT, maxChars: 1000 } },
    });

    const { commandFrame } = await responsePromise;
    expect(commandFrame['tabContext']).toEqual(TAB_CONTEXT);
    expect(commandFrame['params']).toEqual({ tabContext: TAB_CONTEXT, maxChars: 1000 });
    expect(res.status).toBe(200);
  });

  it('uses the conversation-bound tab context for browser DOM tools and strips internal context from params', async () => {
    const handle = await bootstrapBridge();
    const ws = await registerBrowserExtension(handle, [{ id: 'read_page' }]);
    const responsePromise = autoRespondOnce(ws, {
      success: true,
      data: { title: 'Example', html: '<html/>' },
    });
    const conversationId = 'conversation-1';
    const boundTabContext = {
      tabId: 99,
      windowId: 8,
      url: 'https://bound.example/path',
      title: 'Bound page',
    };
    browserConversationScopeRegistry.bind(conversationId, boundTabContext);

    const res = await postApp(handle, 'read_page', {
      body: { payload: { __rebel_conversation_id: conversationId, maxChars: 1000 } },
    });

    const { commandFrame } = await responsePromise;
    expect(commandFrame['tabContext']).toEqual(boundTabContext);
    expect(commandFrame['params']).toEqual({ maxChars: 1000 });
    expect(res.status).toBe(200);
  });

  it('rejects browser DOM commands with an internal conversation id when no scope binding exists', async () => {
    const handle = await bootstrapBridge();
    await registerBrowserExtension(handle, [{ id: 'read_page' }]);

    const res = await postApp(handle, 'read_page', {
      body: {
        payload: {
          __rebel_conversation_id: 'missing-conversation-binding',
          tabContext: TAB_CONTEXT,
        },
      },
    });

    expect(res.status).toBe(410);
    expect(res.json).toMatchObject({ code: 'TAB_CONTEXT_GONE' });
  });

  it('rejects browser status with an internal conversation id when no scope binding exists', async () => {
    const handle = await bootstrapBridge();
    await registerBrowserExtension(handle, [{ id: 'read_page' }]);

    const res = await postApp(handle, 'status', {
      body: {
        payload: {
          __rebel_conversation_id: 'missing-conversation-binding',
        },
      },
    });

    expect(res.status).toBe(410);
    expect(res.json).toMatchObject({ code: 'TAB_CONTEXT_GONE' });
  });

  it('rejects browser DOM commands when model-supplied tab context diverges from the conversation binding', async () => {
    const handle = await bootstrapBridge();
    await registerBrowserExtension(handle, [{ id: 'read_page' }]);
    const conversationId = 'conversation-2';
    browserConversationScopeRegistry.bind(conversationId, TAB_CONTEXT);

    const res = await postApp(handle, 'read_page', {
      body: {
        payload: {
          __rebel_conversation_id: conversationId,
          tabContext: {
            ...TAB_CONTEXT,
            tabId: 43,
          },
        },
      },
    });

    expect(res.status).toBe(410);
    expect(res.json).toMatchObject({ code: 'TAB_CONTEXT_DIVERGED' });
  });

  it('rejects browser DOM commands when same-tab URL query/hash diverges from the conversation binding', async () => {
    const handle = await bootstrapBridge();
    await registerBrowserExtension(handle, [{ id: 'read_page' }]);
    const conversationId = 'conversation-3';
    browserConversationScopeRegistry.bind(conversationId, {
      ...TAB_CONTEXT,
      url: 'https://example.com/form?step=1#details',
    });

    const res = await postApp(handle, 'read_page', {
      body: {
        payload: {
          __rebel_conversation_id: conversationId,
          tabContext: {
            ...TAB_CONTEXT,
            url: 'https://example.com/form?step=2#confirm',
          },
        },
      },
    });

    expect(res.status).toBe(410);
    expect(res.json).toMatchObject({ code: 'TAB_CONTEXT_DIVERGED' });
  });

  it('treats a bare JSON body (not wrapped in { payload }) as the payload itself', async () => {
    const handle = await bootstrapBridge();
    const ws = await registerBrowserExtension(handle, [{ id: 'click' }]);
    const responsePromise = autoRespondOnce(ws, { success: true, data: { clicked: true } });

    const res = await postApp(handle, 'click', {
      body: { selector: '#submit', tabContext: TAB_CONTEXT },
    });

    const { commandFrame } = await responsePromise;
    expect(commandFrame['params']).toEqual({ selector: '#submit', tabContext: TAB_CONTEXT });
    expect(res.status).toBe(200);
  });

  it('forwards an app-reported structured failure as 502 with the app error payload', async () => {
    const handle = await bootstrapBridge();
    const ws = await registerBrowserExtension(handle, [{ id: 'fill_form' }]);
    void autoRespondOnce(ws, {
      success: false,
      error: 'Selector not found',
      code: 'BAD_REQUEST',
    });

    const res = await postApp(handle, 'fill_form', {
      body: { payload: { selector: '#missing', value: 'x', tabContext: TAB_CONTEXT } },
    });
    expect(res.status).toBe(502);
    expect(res.json).toMatchObject({
      success: false,
      message: 'Selector not found',
      code: 'BAD_REQUEST',
    });
    expect(typeof (res.json as { commandId?: unknown }).commandId).toBe('string');
  });

  it('maps extension-reported INJECTION_REFUSED to 403 and preserves details', async () => {
    const handle = await bootstrapBridge();
    const ws = await registerBrowserExtension(handle, [{ id: 'read_page' }]);
    void autoRespondOnce(ws, {
      success: false,
      error: 'injection refused',
      code: 'INJECTION_REFUSED',
      details: {
        reason: 'no-host-permission',
        origin: 'https://example.com',
      },
    });

    const res = await postApp(handle, 'read_page', {
      body: { payload: { maxChars: 1000, tabContext: TAB_CONTEXT } },
    });
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({
      success: false,
      code: 'INJECTION_REFUSED',
      message: 'injection refused',
      details: {
        reason: 'no-host-permission',
        origin: 'https://example.com',
      },
    });
  });

  it('returns 504 COMMAND_TIMEOUT when the app does not respond within timeoutMs', async () => {
    const handle = await bootstrapBridge();
    // Register the app but never reply — we override timeoutMs in the POST
    // body so the test runs in ~200ms rather than the default 30 s.
    await registerBrowserExtension(handle, [{ id: 'scroll' }]);
    const res = await postApp(handle, 'scroll', {
      body: { payload: { y: 100, tabContext: TAB_CONTEXT }, timeoutMs: 200 },
    });
    expect(res.status).toBe(504);
    expect(res.json).toMatchObject({ code: 'COMMAND_TIMEOUT' });
  });

  it('returns 409 IDEMPOTENT_DROP when retrying a commandId whose late response already landed', async () => {
    const handle = await bootstrapBridge();
    const ws = await registerBrowserExtension(handle, [{ id: 'click' }]);

    // Step 1: dispatch a command, let it time out via a short timeoutMs.
    const timeoutRes = await postApp(handle, 'click', {
      body: { payload: { selector: '#a', tabContext: TAB_CONTEXT }, timeoutMs: 100 },
    });
    expect(timeoutRes.status).toBe(504);

    // The timeout fired, so the commandId is in recent history. We now
    // need the WS client to deliver a late response for that commandId so
    // the history entry is marked as "wasLateResponse" — the idempotent-
    // drop trigger. We intercept the latest command's id from the wire.
    // Since the relay already sent the command, we capture it by asking
    // the router for the most recently-recorded history entry.
    // Simpler path: send a bogus late response and use a known bogus id so
    // the router records wasLateResponse=false (no match). Instead, we
    // mimic the real pattern: listen on the WS for any command frames that
    // arrive later and immediately echo them. So let's first dispatch a
    // second command that we know the ID for, then replay.

    // Easier deterministic approach: explicitly call dispatch via the
    // command router so we know the commandId, time it out, then send the
    // late response from the WS.
    const dispatchPromise = handle.commandRouter
      .dispatch({
        appId: 'browser-extension',
        capability: 'click',
        payload: { selector: '#b' },
        timeoutMs: 100,
      })
      .catch((err) => err);

    // Grab the commandId from the WS side.
    const commandFrame = await waitForMessage(ws);
    const commandId = commandFrame['id'] as string;

    await dispatchPromise;
    // Now replay a late response with that id — marks wasLateResponse.
    ws.send(
      JSON.stringify({
        type: 'response',
        id: commandId,
        success: true,
        data: { late: true },
      }),
    );
    // Give the router a moment to process the late response.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // A retry with that commandId as prevCommandId should be dropped.
    const retryRes = await postApp(handle, 'click', {
      body: { payload: { selector: '#b', tabContext: TAB_CONTEXT }, prevCommandId: commandId },
    });
    expect(retryRes.status).toBe(409);
    expect(retryRes.json).toMatchObject({ code: 'IDEMPOTENT_DROP' });
  });

  it('rejects a pair token on /apps/* with 403 FORBIDDEN (never forwards to dispatch)', async () => {
    const handle = await bootstrapBridge();
    await registerBrowserExtension(handle, [{ id: 'read_page' }]);
    const pairToken = handle.tokenStore.issueAppToken('browser-extension', 'client-2');

    const res = await postApp(handle, 'read_page', {
      token: pairToken,
    });
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns 400 BAD_REQUEST when the body is not valid JSON', async () => {
    const handle = await bootstrapBridge();
    const res = await httpRequest({
      port: handle.port,
      method: 'POST',
      path: '/apps/browser-extension/read_page',
      headers: {
        authorization: `Bearer ${handle.routerInternalToken}`,
        'x-rebel-app-id': 'browser-extension',
      },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('never exposes the router-internal token in any response body (defence-in-depth)', async () => {
    const handle = await bootstrapBridge();
    await registerBrowserExtension(handle, [{ id: 'status' }]);
    const errResponses = await Promise.all([
      postApp(handle, 'read_page', { body: { payload: {} } }), // 404 CAPABILITY_NOT_SUPPORTED
      postApp(handle, 'status', {
        token: 'wrong',
      }), // 401
      postApp(handle, 'status', { body: { payload: {}, timeoutMs: 50 } }), // 504
    ]);
    for (const res of errResponses) {
      expect(res.body).not.toContain(handle.routerInternalToken);
    }
  });

  describe('INJECTION_REFUSED → permission auto-replay', () => {
    /**
     * Bridge factory that shortens the wait window so timeout-path tests
     * complete in ~250ms instead of 60s. Each test gets its own bridge so
     * the in-memory tracker state is isolated.
     */
    async function bootstrapBridgeWithShortWait(waitMs: number): Promise<AppBridgeHandle> {
      const handle = await createAppBridge({
        stateDirectory: await makeStateDir(),
        portCandidates: nextPortRange(),
        allowedChromeExtensionIds: [ALLOWED_EXTENSION_ID],
        permissionGrantWaitMs: waitMs,
      });
      cleanupHandles.push(handle);
      return handle;
    }

    /**
     * Reply to the first command frame with the given failure, then reply
     * to the second (retry) frame with the given success. Returns the two
     * captured frames so the test can assert prevCommandId is set on the
     * retry — the contract that prevents IDEMPOTENT_DROP from firing.
     */
    function autoRespondInjectionRefusedThenSuccess(
      ws: WebSocket,
      refusedDetails: Record<string, unknown>,
      successData: unknown,
    ): Promise<{
      firstFrame: Record<string, unknown>;
      retryFrame: Record<string, unknown>;
    }> {
      return new Promise((resolve, reject) => {
        const frames: Record<string, unknown>[] = [];
        const onMessage = (raw: WebSocket.RawData): void => {
          try {
            const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
            if (frame['type'] !== 'command') return;
            frames.push(frame);
            const commandId = frame['id'];
            if (frames.length === 1) {
              ws.send(
                JSON.stringify({
                  type: 'response',
                  id: commandId,
                  success: false,
                  error: 'injection refused',
                  code: 'INJECTION_REFUSED',
                  details: refusedDetails,
                }),
              );
            } else if (frames.length === 2) {
              ws.send(
                JSON.stringify({
                  type: 'response',
                  id: commandId,
                  success: true,
                  data: successData,
                }),
              );
              ws.off('message', onMessage);
              const [firstFrame, retryFrame] = frames as [
                Record<string, unknown>,
                Record<string, unknown>,
              ];
              resolve({ firstFrame, retryFrame });
            }
          } catch (err) {
            reject(err);
          }
        };
        ws.on('message', onMessage);
      });
    }

    it('retries dispatch after a permission grant arrives → 200 with retry data', async () => {
      const handle = await bootstrapBridgeWithShortWait(2_000);
      const ws = await registerBrowserExtension(handle, [{ id: 'click' }]);

      const replyPromise = autoRespondInjectionRefusedThenSuccess(
        ws,
        {
          reason: 'no-host-permission',
          retryable: true,
          origin: 'https://example.com',
        },
        { clicked: true },
      );

      // Drive the flow: post the request, then deliver the grant via the
      // tracker (simulating what the SW will do over the WS event channel).
      const postPromise = postApp(handle, 'click', {
        body: { payload: { selector: '#submit', tabContext: TAB_CONTEXT } },
      });

      // Give the bridge a tick to register the waiter before the grant
      // lands; any earlier and the grant would race ahead of the dispatch.
      await new Promise((r) => setTimeout(r, 30));
      handle.permissionGrantTracker.recordGrant({
        origin: 'https://example.com',
        at: Date.now(),
      });

      const res = await postPromise;
      const { firstFrame, retryFrame } = await replyPromise;

      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        success: true,
        data: { clicked: true },
      });
      // Retry must reference the original commandId so the recent-history
      // cache treats it as a deliberate retry.
      expect(retryFrame['prevCommandId']).toBe(firstFrame['id']);
    });

    it('surfaces original 403 INJECTION_REFUSED if the grant times out', async () => {
      const handle = await bootstrapBridgeWithShortWait(150);
      const ws = await registerBrowserExtension(handle, [{ id: 'click' }]);
      void autoRespondOnce(ws, {
        success: false,
        error: 'injection refused',
        code: 'INJECTION_REFUSED',
        details: {
          reason: 'no-host-permission',
          retryable: true,
          origin: 'https://example.com',
        },
      });

      const res = await postApp(handle, 'click', {
        body: { payload: { selector: '#submit', tabContext: TAB_CONTEXT } },
      });
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({
        success: false,
        code: 'INJECTION_REFUSED',
        details: { reason: 'no-host-permission' },
      });
    });

    it('clears the pending grant wait promptly when the HTTP request closes', async () => {
      const handle = await bootstrapBridgeWithShortWait(60_000);
      const ws = await registerBrowserExtension(handle, [{ id: 'click' }]);
      const refusalPromise = autoRespondOnce(ws, {
        success: false,
        error: 'injection refused',
        code: 'INJECTION_REFUSED',
        details: {
          reason: 'no-host-permission',
          retryable: true,
          origin: 'https://example.com',
        },
      });

      const { req, done } = startAbortablePostApp(handle, 'click', {
        body: { payload: { selector: '#submit', tabContext: TAB_CONTEXT } },
      });

      await refusalPromise;
      await waitForCondition(() => handle.permissionGrantTracker.pendingWaiterCount() === 1);

      req.destroy();
      await done;

      await waitForCondition(() => handle.permissionGrantTracker.pendingWaiterCount() === 0);
    });

    it('does not wait for non-grantable reasons — unsupported-scheme returns 403 immediately', async () => {
      // 60s wait — if the test takes more than ~1s we know the relay
      // incorrectly waited. Keeps the assertion enforcement in the test.
      const handle = await bootstrapBridgeWithShortWait(60_000);
      const ws = await registerBrowserExtension(handle, [{ id: 'click' }]);
      void autoRespondOnce(ws, {
        success: false,
        error: 'injection refused',
        code: 'INJECTION_REFUSED',
        details: {
          reason: 'unsupported-scheme',
          retryable: false,
          origin: 'chrome://settings',
        },
      });

      const startedAt = Date.now();
      const res = await postApp(handle, 'click', {
        body: { payload: { selector: '#submit', tabContext: TAB_CONTEXT } },
      });
      const elapsed = Date.now() - startedAt;

      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({
        success: false,
        code: 'INJECTION_REFUSED',
        details: { reason: 'unsupported-scheme' },
      });
      // 1s is a generous ceiling; real elapsed should be <100ms. If the
      // relay incorrectly waits, this fails immediately rather than at 60s.
      expect(elapsed).toBeLessThan(1_000);
    });

    it('honors a grant that landed BEFORE dispatch (recency window)', async () => {
      const handle = await bootstrapBridgeWithShortWait(2_000);
      const ws = await registerBrowserExtension(handle, [{ id: 'click' }]);

      // Pre-record the grant — simulating the SW signalling a grant a
      // moment before the agent's tool call reached the relay.
      handle.permissionGrantTracker.recordGrant({
        origin: 'https://example.com',
        at: Date.now(),
      });

      const replyPromise = autoRespondInjectionRefusedThenSuccess(
        ws,
        {
          reason: 'no-host-permission',
          retryable: true,
          origin: 'https://example.com',
        },
        { clicked: true },
      );

      const res = await postApp(handle, 'click', {
        body: { payload: { selector: '#submit', tabContext: TAB_CONTEXT } },
      });
      await replyPromise;

      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        success: true,
        data: { clicked: true },
      });
    });

    it('end-to-end via WS event frame: SW → wsServer → tracker → relay retry', async () => {
      // This is the full chain test. Instead of poking the tracker directly,
      // we push the same `{type:'event',event:'permission-granted',...}` frame
      // the offscreen ConnectionRunner.sendEvent() produces. That validates:
      //   - wsServer's `event` case parses the frame
      //   - wsServer canonicalizes the origin (URL parsing + scheme://host)
      //   - tracker.recordGrant fires with the canonical key
      //   - the in-flight relay's awaitGrant resolves
      //   - the relay retries the dispatch
      const handle = await bootstrapBridgeWithShortWait(2_000);
      const ws = await registerBrowserExtension(handle, [{ id: 'click' }]);

      const replyPromise = autoRespondInjectionRefusedThenSuccess(
        ws,
        {
          reason: 'no-host-permission',
          retryable: true,
          origin: 'https://example.com',
        },
        { clicked: true, viaEventFrame: true },
      );

      const postPromise = postApp(handle, 'click', {
        body: { payload: { selector: '#submit', tabContext: TAB_CONTEXT } },
      });

      // Give the relay a tick to land on awaitGrant before the event arrives.
      await new Promise((r) => setTimeout(r, 30));
      // Push the event frame over the wire — what offscreen.sendEvent does.
      ws.send(
        JSON.stringify({
          type: 'event',
          event: 'permission-granted',
          origin: 'https://example.com',
          at: Date.now(),
        }),
      );

      const res = await postPromise;
      const { firstFrame, retryFrame } = await replyPromise;

      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        success: true,
        data: { clicked: true, viaEventFrame: true },
      });
      expect(retryFrame['prevCommandId']).toBe(firstFrame['id']);
    });

    it('end-to-end via WS event frame: trailing-slash origin canonicalizes through wsServer', async () => {
      const handle = await bootstrapBridgeWithShortWait(2_000);
      const ws = await registerBrowserExtension(handle, [{ id: 'click' }]);

      const replyPromise = autoRespondInjectionRefusedThenSuccess(
        ws,
        {
          reason: 'no-host-permission',
          retryable: true,
          // Refusal carries the canonical form (what dispatch.origin sees).
          origin: 'https://example.com',
        },
        { clicked: true },
      );

      const postPromise = postApp(handle, 'click', {
        body: { payload: { selector: '#submit', tabContext: TAB_CONTEXT } },
      });

      await new Promise((r) => setTimeout(r, 30));
      // SW pushes the trailing-slash variant — wsServer must canonicalize so
      // it matches the relay's awaitGrant key.
      ws.send(
        JSON.stringify({
          type: 'event',
          event: 'permission-granted',
          origin: 'https://example.com/',
          at: Date.now(),
        }),
      );

      const res = await postPromise;
      await replyPromise;

      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ success: true, data: { clicked: true } });
    });

    it('end-to-end via WS event frame: malformed origin gets an error frame, not a silent grant', async () => {
      const handle = await bootstrapBridgeWithShortWait(150);
      const ws = await registerBrowserExtension(handle, [{ id: 'click' }]);

      // Set up an error-frame collector before pushing the bad event.
      const errorFramePromise = new Promise<Record<string, unknown>>((resolve) => {
        const onMsg = (raw: WebSocket.RawData): void => {
          try {
            const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
            if (frame['type'] === 'error') {
              ws.off('message', onMsg);
              resolve(frame);
            }
          } catch {
            // ignore
          }
        };
        ws.on('message', onMsg);
      });

      // Have the dispatch get refused so the relay enters awaitGrant.
      void autoRespondOnce(ws, {
        success: false,
        error: 'injection refused',
        code: 'INJECTION_REFUSED',
        details: {
          reason: 'no-host-permission',
          retryable: true,
          origin: 'https://example.com',
        },
      });

      const postPromise = postApp(handle, 'click', {
        body: { payload: { selector: '#submit', tabContext: TAB_CONTEXT } },
      });

      await new Promise((r) => setTimeout(r, 30));
      // Garbage origin — wsServer should reject with INVALID_MESSAGE error
      // frame and NOT call tracker.recordGrant. The relay's awaitGrant
      // therefore times out, surfacing the original 403.
      ws.send(
        JSON.stringify({
          type: 'event',
          event: 'permission-granted',
          origin: 'this-is-not-a-url',
          at: Date.now(),
        }),
      );

      const errorFrame = await errorFramePromise;
      expect(errorFrame).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });

      const res = await postPromise;
      // Original 403 stands because no grant was recorded.
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ code: 'INJECTION_REFUSED' });
    });

    it('end-to-end via WS event frame: unknown event name is rejected (defence-in-depth)', async () => {
      const handle = await bootstrapBridgeWithShortWait(150);
      const ws = await registerBrowserExtension(handle, [{ id: 'status' }]);

      const errorFramePromise = new Promise<Record<string, unknown>>((resolve) => {
        const onMsg = (raw: WebSocket.RawData): void => {
          try {
            const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
            if (frame['type'] === 'error') {
              ws.off('message', onMsg);
              resolve(frame);
            }
          } catch {
            // ignore
          }
        };
        ws.on('message', onMsg);
      });

      ws.send(
        JSON.stringify({
          type: 'event',
          event: 'some-other-event',
          origin: 'https://example.com',
          at: Date.now(),
        }),
      );

      const errorFrame = await errorFramePromise;
      expect(errorFrame).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });

    it('canonicalizes origin — trailing-slash variants still match', async () => {
      const handle = await bootstrapBridgeWithShortWait(2_000);
      const ws = await registerBrowserExtension(handle, [{ id: 'click' }]);

      const replyPromise = autoRespondInjectionRefusedThenSuccess(
        ws,
        {
          reason: 'no-host-permission',
          retryable: true,
          origin: 'https://example.com/',
        },
        { clicked: true },
      );

      const postPromise = postApp(handle, 'click', {
        body: { payload: { selector: '#submit', tabContext: TAB_CONTEXT } },
      });

      await new Promise((r) => setTimeout(r, 30));
      // Tracker stores canonical scheme://host. The relay canonicalizes
      // the dispatch's origin the same way before awaiting.
      handle.permissionGrantTracker.recordGrant({
        origin: 'https://example.com',
        at: Date.now(),
      });

      const res = await postPromise;
      await replyPromise;

      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ success: true, data: { clicked: true } });
    });
  });
});
