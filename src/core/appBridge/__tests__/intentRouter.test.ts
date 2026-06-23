import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppBridge, type AppBridgeHandle } from '@core/appBridge/server/bridge';
import { DEV_EXTENSION_IDS_FILE } from '@core/appBridge/server/originGuard';
import { createAppBridgeError, ErrorCode } from '@core/appBridge/shared/errors';
import type {
  IntentConversationCreate,
  IntentConversationCreateResult,
} from '@core/appBridge/shared/intentProtocol';

type CreateConversationHandler = (
  req: IntentConversationCreate,
) => Promise<IntentConversationCreateResult>;

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const UNKNOWN_EXT_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';

const handles: AppBridgeHandle[] = [];
const dirs: string[] = [];

let portBase = 54000;
function nextPortRange(count = 3): number[] {
  const start = portBase;
  portBase += count + 1;
  return Array.from({ length: count }, (_, i) => start + i);
}

async function makeStateDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'intent-router-test-'));
  dirs.push(d);
  return d;
}

async function startBridge(
  extraOptions: Partial<Parameters<typeof createAppBridge>[0]> = {},
): Promise<AppBridgeHandle> {
  const stateDirectory = await makeStateDir();
  const handle = await createAppBridge({
    stateDirectory,
    portCandidates: nextPortRange(),
    allowedChromeExtensionIds: [EXT_ID],
    ...extraOptions,
  });
  handles.push(handle);
  return handle;
}

async function requestJson(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
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

/**
 * Low-level http.request so we can set otherwise-forbidden headers like Host.
 */
async function rawRequest(options: {
  method: string;
  port: number;
  path: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: unknown }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: options.method,
        hostname: '127.0.0.1',
        port: options.port,
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk.toString();
        });
        res.on('end', () => {
          let parsed: unknown;
          try {
            parsed = raw.length > 0 ? JSON.parse(raw) : null;
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

beforeEach(() => {
  delete process.env['REBEL_APP_BRIDGE_DEV'];
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

describe('appBridge/server/intentRouter', () => {
  it('GET /intent/health returns 200 + service + version + protocolVersion + port', async () => {
    const handle = await startBridge();
    const res = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/health`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    );
    expect(res.status).toBe(200);
    // The `service: 'rebel-app-bridge'` + `version` fields are the
    // wire-contract that port-discovery in the browser extension relies on.
    // Drift here silently breaks discovery without any other symptom.
    expect(res.body).toMatchObject({
      ok: true,
      service: 'rebel-app-bridge',
      version: '1.0',
      protocolVersion: '1.0',
      port: handle.port,
    });
  });

  it('GET /intent/health returns the limited probe response for an unknown extension origin', async () => {
    const handle = await startBridge({
      previewMode: true,
      onUnknownExtensionOrigin: async () => true,
    });

    const res = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/health`,
      {
        Origin: `chrome-extension://${UNKNOWN_EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      service: 'rebel-app-bridge',
    });
  });

  it('GET /intent/health does not persist trust when the probe uses persistOnApproval=false', async () => {
    const handle = await startBridge({
      previewMode: true,
      onUnknownExtensionOrigin: async () => true,
    });
    const stateDirectory = path.dirname(handle.stateFilePath);

    const res = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/health`,
      {
        Origin: `chrome-extension://${UNKNOWN_EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    );

    expect(res.status).toBe(200);
    await expect(
      fs.readFile(path.join(stateDirectory, DEV_EXTENSION_IDS_FILE), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Pins the fix for the MV3 service-worker port-discovery probe.
  // Chromium strips the Origin header on a same-origin / localhost
  // fetch() issued with `credentials: 'omit'` from a service worker,
  // so `/intent/health` MUST accept a missing Origin — otherwise every
  // install ends with the extension popup saying "Couldn't find Rebel
  // on this computer."
  //
  // Security posture: the limited probe response ({ ok, service }) is
  // identical to what we already return for unknown extension IDs, so
  // no additional info is leaked. Port + protocolVersion still require
  // an allowlisted Origin.
  it('GET /intent/health with no Origin returns the limited probe response', async () => {
    const handle = await startBridge();

    const res = await rawRequest({
      method: 'GET',
      port: handle.port,
      path: '/intent/health',
      headers: { Host: `127.0.0.1:${handle.port}` },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      service: 'rebel-app-bridge',
    });
    // Explicit negative assertions — an Origin-less probe must NOT see
    // the full payload reserved for an allowlisted extension.
    expect(res.body).not.toHaveProperty('port');
    expect(res.body).not.toHaveProperty('protocolVersion');
    expect(res.body).not.toHaveProperty('version');
  });

  // Complements the test above: the fix must NOT widen the gate to any
  // caller that bothers to send an Origin header. A hostile website
  // origin is still rejected with 401.
  it('GET /intent/health with a disallowed web Origin still returns 401', async () => {
    const handle = await startBridge();

    const res = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/health`,
      {
        Origin: 'https://evil.example.com',
        Host: `127.0.0.1:${handle.port}`,
      },
    );

    expect(res.status).toBe(401);
  });

  it('POST /intent/conversation/create with malformed body returns 400 BAD_REQUEST', async () => {
    // This must run with dev-mode ON so the request clears assertGatedAccess
    // and reaches the Zod validator — else we'd see 401 instead of 400.
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handle = await startBridge();
    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/create`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      JSON.stringify({}),
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'BAD_REQUEST' });
    expect((res.body as { message: string }).message).toMatch(/intent|clientId|tabContext/i);
  });

  it('POST /intent/conversation/create returns 501 NOT_IMPLEMENTED when body is valid but no handler injected', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handle = await startBridge();
    const body = JSON.stringify({
      appId: 'browser-extension',
      clientId: 'client-abc',
      intent: 'summarise',
      tabContext: { tabId: 1, url: 'https://example.com/a', title: 'A' },
    });
    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/create`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      body,
    );
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({
      success: false,
      code: 'NOT_IMPLEMENTED',
    });
    expect((res.body as { message: string }).message).toMatch(/stage 7/i);
  });

  it('POST /intent/conversation/create dispatches to injected handler and returns 200 with conversationId', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handler = vi.fn<CreateConversationHandler>(async () => ({
      conversationId: 's_injected',
      state: 'new' as const,
    }));
    const handle = await startBridge({
      intentHandlers: { createConversation: handler },
    });
    const body = JSON.stringify({
      appId: 'browser-extension',
      clientId: 'client-abc',
      intent: 'summarise',
      tabContext: { tabId: 77, windowId: 1, url: 'https://example.com/a', title: 'A' },
      pageContext: { title: 'A', url: 'https://example.com/a', text: 'body' },
    });
    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/create`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      body,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      conversationId: 's_injected',
      state: 'new',
    });
    expect(handler).toHaveBeenCalledTimes(1);
    // The handler receives the Zod-parsed payload — tabContext must be preserved verbatim.
    const firstCall = handler.mock.calls[0];
    if (!firstCall) throw new Error('expected at least one handler call');
    const [called] = firstCall;
    expect(called.intent).toBe('summarise');
    expect(called.tabContext).toMatchObject({ tabId: 77, url: 'https://example.com/a' });
  });

  it('POST /intent/conversation/create accepts additive office documentContext payloads', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handler = vi.fn<CreateConversationHandler>(async () => ({
      conversationId: 's_office',
      state: 'new' as const,
    }));
    const handle = await startBridge({
      intentHandlers: { createConversation: handler },
    });
    const body = JSON.stringify({
      appId: 'office-addin',
      clientId: 'office-client',
      intent: 'chat',
      documentContext: {
        host: 'word',
        title: 'Quarterly Plan.docx',
        url: 'file:///Quarterly%20Plan.docx',
      },
    });
    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/create`,
      {
        Host: `127.0.0.1:${handle.port}`,
      },
      body,
    );
    expect(res.status).toBe(200);
    const firstCall = handler.mock.calls[0];
    if (!firstCall) throw new Error('expected at least one handler call');
    expect(firstCall[0].documentContext).toEqual({
      host: 'word',
      title: 'Quarterly Plan.docx',
      url: 'file:///Quarterly%20Plan.docx',
    });
    expect(firstCall[0].tabContext).toBeUndefined();
  });

  it('POST /intent/conversation/create maps handler-thrown AppBridgeError to its canonical HTTP status', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handler = vi.fn<CreateConversationHandler>(async () => {
      throw createAppBridgeError(
        ErrorCode.TAB_CONTEXT_GONE,
        'The browser tab has closed.',
      );
    });
    const handle = await startBridge({
      intentHandlers: { createConversation: handler },
    });
    const body = JSON.stringify({
      appId: 'browser-extension',
      clientId: 'client-abc',
      intent: 'summarise',
      tabContext: { tabId: 1 },
    });
    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/create`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      body,
    );
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ code: 'TAB_CONTEXT_GONE' });
  });

  it('POST /intent/conversation/create funnels generic handler throws to 500 INTERNAL_ERROR', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handler = vi.fn<CreateConversationHandler>(async () => {
      throw new Error('boom — something unexpected');
    });
    const handle = await startBridge({
      intentHandlers: { createConversation: handler },
    });
    const body = JSON.stringify({
      appId: 'browser-extension',
      clientId: 'client-abc',
      intent: 'summarise',
      tabContext: { tabId: 1 },
    });
    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/create`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      body,
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('POST /intent/conversation/:id/message returns 501 when body is valid but no handler injected', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handle = await startBridge();
    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_abc/message`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      JSON.stringify({ appId: 'browser-extension', clientId: 'c1', text: 'hi' }),
    );
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('POST /intent/conversation/:id/message with malformed body returns 400', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handle = await startBridge();
    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_abc/message`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      JSON.stringify({ text: 'hi' /* missing appId/clientId */ }),
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('POST /intent/conversation/:id/message dispatches to injected handler and returns 200', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handler = vi.fn(async (conversationId: string, _req) => ({
      conversationId,
      messageId: 'm_injected',
      state: 'submitted' as const,
      queueSize: 0,
    }));
    const handle = await startBridge({
      intentHandlers: { injectMessage: handler },
    });
    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_abc/message`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      JSON.stringify({ appId: 'browser-extension', clientId: 'c1', text: 'Follow-up' }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      conversationId: 's_abc',
      messageId: 'm_injected',
      state: 'submitted',
    });
    expect(handler).toHaveBeenCalledWith('s_abc', expect.objectContaining({ text: 'Follow-up' }));
  });

  it('POST /intent/conversation/:id/message propagates AppBridgeError status from handler', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handler = vi.fn(async () => {
      throw createAppBridgeError(
        ErrorCode.CAPABILITY_NOT_SUPPORTED,
        'No such conversation.',
      );
    });
    const handle = await startBridge({
      intentHandlers: { injectMessage: handler },
    });
    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_missing/message`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      JSON.stringify({ appId: 'browser-extension', clientId: 'c1', text: 'x' }),
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'CAPABILITY_NOT_SUPPORTED' });
  });

  it('GET /intent/conversation/:id/state returns 501 when no handler injected', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handle = await startBridge();
    const res = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_xyz/state`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    );
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('GET /intent/conversation/:id/state dispatches to injected handler and returns 200', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handler = vi.fn(async (conversationId: string) => ({
      conversationId,
      turnStatus: 'running' as const,
      pendingMessages: 2,
      lastAssistantAt: null,
    }));
    const handle = await startBridge({
      intentHandlers: { getConversationState: handler },
    });
    const res = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_xyz/state`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      conversationId: 's_xyz',
      turnStatus: 'running',
      pendingMessages: 2,
    });
    expect(handler).toHaveBeenCalledWith('s_xyz');
  });

  // --- GET /intent/conversation/:id/messages (embedded chat — Stage 1) -----

  it('GET /intent/conversation/:id/messages returns 501 when no handler injected', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handle = await startBridge();
    const res = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_abc/messages`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    );
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('GET /intent/conversation/:id/messages dispatches to injected handler and returns 200', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handler = vi.fn(async (conversationId: string) => ({
      conversationId,
      messages: [
        { id: 'm1', role: 'user' as const, text: 'hi', createdAt: 1 },
        { id: 'm2', role: 'assistant' as const, text: 'hello', createdAt: 2 },
      ],
      turnStatus: 'idle' as const,
      conversationTitle: 'Test title',
    }));
    const handle = await startBridge({
      intentHandlers: { getMessages: handler },
    });
    const res = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_abc/messages`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      conversationId: 's_abc',
      messages: [
        { id: 'm1', role: 'user', text: 'hi', createdAt: 1 },
        { id: 'm2', role: 'assistant', text: 'hello', createdAt: 2 },
      ],
      turnStatus: 'idle',
      conversationTitle: 'Test title',
    });
    expect(handler).toHaveBeenCalledWith('s_abc');
  });

  it('GET /intent/conversation/:id/messages propagates AppBridgeError from handler (404)', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handler = vi.fn(async () => {
      throw createAppBridgeError(
        ErrorCode.CAPABILITY_NOT_SUPPORTED,
        'No such conversation.',
      );
    });
    const handle = await startBridge({
      intentHandlers: { getMessages: handler },
    });
    const res = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_missing/messages`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'CAPABILITY_NOT_SUPPORTED' });
  });

  it('GET /intent/conversation/:id/messages funnels handler throw → 500 INTERNAL_ERROR', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    const handle = await startBridge({
      intentHandlers: { getMessages: handler },
    });
    const res = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_xyz/messages`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('GET /intent/conversation/:id/messages requires auth (no token → 401)', async () => {
    // Post-review A4 parity: gated intent routes must reject anonymous
    // requests with 401 when dev mode is off, proving the route sits
    // behind `assertGatedAccess` like its siblings.
    delete process.env['REBEL_APP_BRIDGE_DEV'];
    const handle = await startBridge();
    const res = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_abc/messages`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('GET /intent/conversation/:id/messages accepts a valid paired token', async () => {
    // With correct headers + a real paired token the request should clear
    // the auth gate. No handler injected → 501 proves the gate let it through.
    delete process.env['REBEL_APP_BRIDGE_DEV'];
    const handle = await startBridge();
    const session = handle.pairingStore.createPendingSession('browser-extension');
    const claim = handle.pairingStore.claim(session.code, { clientId: 'client-abc' });
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error('pair-claim failed');

    const res = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_abc/messages`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${claim.token}`,
        'X-Rebel-App-Id': 'browser-extension',
        'X-Rebel-Client-Id': 'client-abc',
      },
    );
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({
      success: false,
      code: 'NOT_IMPLEMENTED',
    });
  });

  // --- GET /intent/conversation/:id/stream (embedded chat — Stage 2) -----

  it('GET /intent/conversation/:id/stream returns 501 when no handler injected', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handle = await startBridge();
    const res = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_abc/stream`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    );
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('GET /intent/conversation/:id/stream requires auth (no token → 401)', async () => {
    // Same auth posture as the sibling /messages route — proves the
    // stream endpoint sits behind `assertGatedAccess` and doesn't leak
    // live events to anonymous callers.
    delete process.env['REBEL_APP_BRIDGE_DEV'];
    const handle = await startBridge();
    const res = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_abc/stream`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('GET /intent/conversation/:id/stream accepts a valid paired token and reaches the handler', async () => {
    // With a real paired token + headers, we should clear the auth gate.
    // No handler injected → 501 proves the gate let it through.
    delete process.env['REBEL_APP_BRIDGE_DEV'];
    const handle = await startBridge();
    const session = handle.pairingStore.createPendingSession('browser-extension');
    const claim = handle.pairingStore.claim(session.code, { clientId: 'client-abc' });
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error('pair-claim failed');

    const res = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_abc/stream`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${claim.token}`,
        'X-Rebel-App-Id': 'browser-extension',
        'X-Rebel-Client-Id': 'client-abc',
      },
    );
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({
      success: false,
      code: 'NOT_IMPLEMENTED',
    });
  });

  it('GET /intent/conversation/:id/stream dispatches to injected handler with conversationId + hashedToken', async () => {
    // With REBEL_APP_BRIDGE_DEV=1 the router skips token checks and
    // passes an empty hashedToken — exactly the safe dev-mode behaviour
    // the coordinator's closeAllForToken contract expects.
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const seenConversationIds: string[] = [];
    const seenTokenLen: number[] = [];
    const handler = vi.fn(async (conversationId: string, _req, res, hashedToken: string) => {
      seenConversationIds.push(conversationId);
      seenTokenLen.push(hashedToken.length);
      // Immediately end — we just want to prove dispatch happened.
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end();
    });
    const handle = await startBridge({
      intentHandlers: { streamConversation: handler },
    });
    const url = `http://127.0.0.1:${handle.port}/intent/conversation/s_stream/stream`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    });
    await res.text(); // drain
    expect(res.status).toBe(200);
    expect(seenConversationIds).toEqual(['s_stream']);
    // Dev-mode → no bearer presented → hashedToken is empty.
    expect(seenTokenLen).toEqual([0]);
  });

  it('GET /intent/conversation/:id/stream hashes the bearer token into a 64-hex hashedToken', async () => {
    // With a real paired token the router must compute a sha256 hex of
    // the presented bearer so the service can close streams by token
    // on revoke.
    delete process.env['REBEL_APP_BRIDGE_DEV'];
    const seenTokenLen: number[] = [];
    const handler = vi.fn(async (_conversationId: string, _req, res, hashedToken: string) => {
      seenTokenLen.push(hashedToken.length);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end();
    });
    const handle = await startBridge({
      intentHandlers: { streamConversation: handler },
    });
    const session = handle.pairingStore.createPendingSession('browser-extension');
    const claim = handle.pairingStore.claim(session.code, { clientId: 'client-abc' });
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error('pair-claim failed');

    const res = await fetch(
      `http://127.0.0.1:${handle.port}/intent/conversation/s_stream/stream`,
      {
        method: 'GET',
        headers: {
          Origin: `chrome-extension://${EXT_ID}`,
          Host: `127.0.0.1:${handle.port}`,
          Authorization: `Bearer ${claim.token}`,
          'X-Rebel-App-Id': 'browser-extension',
          'X-Rebel-Client-Id': 'client-abc',
        },
      },
    );
    await res.text();
    expect(res.status).toBe(200);
    // sha256 hex is always 64 chars.
    expect(seenTokenLen).toEqual([64]);
  });

  it('GET /intent/conversation/:id/stream maps pre-stream AppBridgeError to HTTP status (404)', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handler = vi.fn(async () => {
      throw createAppBridgeError(
        ErrorCode.CAPABILITY_NOT_SUPPORTED,
        'No such conversation.',
      );
    });
    const handle = await startBridge({
      intentHandlers: { streamConversation: handler },
    });
    const res = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_missing/stream`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'CAPABILITY_NOT_SUPPORTED' });
  });

  // --- POST /intent/conversation/:id/focus (embedded chat — Stage 3) -----

  it('POST /intent/conversation/:id/focus returns 501 when no handler injected', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handle = await startBridge();
    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_abc/focus`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    );
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('POST /intent/conversation/:id/focus requires auth (no token → 401)', async () => {
    // Same auth posture as the sibling /messages and /stream routes —
    // proves the focus endpoint sits behind `assertGatedAccess`.
    delete process.env['REBEL_APP_BRIDGE_DEV'];
    const handle = await startBridge();
    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_abc/focus`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('POST /intent/conversation/:id/focus dispatches to injected handler and returns 200', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handler = vi.fn(async (conversationId: string) => ({
      conversationId,
      focused: true,
    }));
    const handle = await startBridge({
      intentHandlers: { focusConversation: handler },
    });
    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_abc/focus`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      conversationId: 's_abc',
      focused: true,
    });
    expect(handler).toHaveBeenCalledWith('s_abc');
  });

  it('POST /intent/conversation/:id/focus propagates AppBridgeError from handler (404)', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handler = vi.fn(async () => {
      throw createAppBridgeError(
        ErrorCode.CAPABILITY_NOT_SUPPORTED,
        'No such conversation.',
      );
    });
    const handle = await startBridge({
      intentHandlers: { focusConversation: handler },
    });
    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_missing/focus`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'CAPABILITY_NOT_SUPPORTED' });
  });

  it('POST /intent/conversation/:id/focus funnels handler throw → 500 INTERNAL_ERROR', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    const handle = await startBridge({
      intentHandlers: { focusConversation: handler },
    });
    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_xyz/focus`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('POST /intent/conversation/:id/focus accepts a valid paired token and reaches the handler', async () => {
    // With a real paired token + headers, we should clear the auth gate.
    // No handler injected → 501 proves the gate let it through.
    delete process.env['REBEL_APP_BRIDGE_DEV'];
    const handle = await startBridge();
    const session = handle.pairingStore.createPendingSession('browser-extension');
    const claim = handle.pairingStore.claim(session.code, { clientId: 'client-abc' });
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error('pair-claim failed');

    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_abc/focus`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${claim.token}`,
        'X-Rebel-App-Id': 'browser-extension',
        'X-Rebel-Client-Id': 'client-abc',
      },
    );
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({
      success: false,
      code: 'NOT_IMPLEMENTED',
    });
  });

  it('GET /intent/conversation/:id/state funnels handler throw → 500 INTERNAL_ERROR', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    const handle = await startBridge({
      intentHandlers: { getConversationState: handler },
    });
    const res = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/conversation/s_xyz/state`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('Origin-rejected routes return 401', async () => {
    const handle = await startBridge();
    const res = await requestJson(
      'GET',
      `http://127.0.0.1:${handle.port}/intent/health`,
      {
        Origin: 'https://evil.example',
        Host: `127.0.0.1:${handle.port}`,
      },
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      success: false,
      code: 'UNAUTHORIZED',
    });
  });

  it('Host-mismatched requests are rejected (DNS-rebind guard)', async () => {
    const handle = await startBridge();
    // Use http.request directly — `fetch` overrides the Host header.
    const res = await rawRequest({
      method: 'GET',
      port: handle.port,
      path: '/intent/health',
      headers: {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `evil.example:${handle.port}`,
      },
    });
    expect(res.status).toBe(401);
  });

  it('gated intent routes without dev mode + without any token return 401', async () => {
    delete process.env['REBEL_APP_BRIDGE_DEV'];
    const handle = await startBridge();
    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/create`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      JSON.stringify({}),
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  // --- A4 — app-token auth model ------------------------------------------

  it('rejects the router-internal token on /intent/* with 403 FORBIDDEN (A4)', async () => {
    // Post-review A4: router-internal tokens are for `/apps/*` relay only.
    // Presenting one on /intent/* must return 403, not 401, so the caller
    // can distinguish "wrong token class" from "no credentials at all".
    delete process.env['REBEL_APP_BRIDGE_DEV'];
    const handle = await startBridge();
    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/create`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.routerInternalToken}`,
        'X-Rebel-App-Id': 'browser-extension',
        'X-Rebel-Client-Id': 'client-abc',
      },
      JSON.stringify({
        appId: 'browser-extension',
        clientId: 'client-abc',
        intent: 'summarise',
        tabContext: { tabId: 1 },
      }),
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a paired token without X-Rebel-App-Id/Client-Id with 400 BAD_REQUEST (A4)', async () => {
    delete process.env['REBEL_APP_BRIDGE_DEV'];
    const handle = await startBridge();
    const session = handle.pairingStore.createPendingSession('browser-extension');
    const claim = handle.pairingStore.claim(session.code, { clientId: 'client-abc' });
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error('pair-claim failed');

    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/create`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${claim.token}`,
        // X-Rebel-App-Id + X-Rebel-Client-Id deliberately missing.
      },
      JSON.stringify({
        appId: 'browser-extension',
        clientId: 'client-abc',
        intent: 'summarise',
        tabContext: { tabId: 1 },
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects a paired token with wrong X-Rebel-App-Id with 401 (A4)', async () => {
    delete process.env['REBEL_APP_BRIDGE_DEV'];
    const handle = await startBridge();
    const session = handle.pairingStore.createPendingSession('browser-extension');
    const claim = handle.pairingStore.claim(session.code, { clientId: 'client-abc' });
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error('pair-claim failed');

    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/create`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${claim.token}`,
        'X-Rebel-App-Id': 'word', // mismatch vs claim ('browser-extension')
        'X-Rebel-Client-Id': 'client-abc',
      },
      JSON.stringify({
        appId: 'browser-extension',
        clientId: 'client-abc',
        intent: 'summarise',
        tabContext: { tabId: 1 },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects a paired token with wrong X-Rebel-Client-Id with 401 (A4)', async () => {
    delete process.env['REBEL_APP_BRIDGE_DEV'];
    const handle = await startBridge();
    const session = handle.pairingStore.createPendingSession('browser-extension');
    const claim = handle.pairingStore.claim(session.code, { clientId: 'client-abc' });
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error('pair-claim failed');

    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/create`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${claim.token}`,
        'X-Rebel-App-Id': 'browser-extension',
        'X-Rebel-Client-Id': 'someone-else',
      },
      JSON.stringify({
        appId: 'browser-extension',
        clientId: 'someone-else',
        intent: 'summarise',
        tabContext: { tabId: 1 },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('accepts a paired token with matching headers + no handler → 501 (A4)', async () => {
    // With the correct credential envelope we should clear the auth gate
    // and fall into the Stage-7-handler branch; when no handler is
    // injected we see 501 NOT_IMPLEMENTED. That proves the auth path
    // itself is sound.
    delete process.env['REBEL_APP_BRIDGE_DEV'];
    const handle = await startBridge();
    const session = handle.pairingStore.createPendingSession('browser-extension');
    const claim = handle.pairingStore.claim(session.code, { clientId: 'client-abc' });
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error('pair-claim failed');

    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/create`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${claim.token}`,
        'X-Rebel-App-Id': 'browser-extension',
        'X-Rebel-Client-Id': 'client-abc',
      },
      JSON.stringify({
        appId: 'browser-extension',
        clientId: 'client-abc',
        intent: 'summarise',
        tabContext: { tabId: 1 },
      }),
    );
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({
      success: false,
      code: 'NOT_IMPLEMENTED',
    });
  });

  // --- B4 — fingerprint binding ------------------------------------------

  it('rejects an app-token with a mismatched fingerprint (B4)', async () => {
    delete process.env['REBEL_APP_BRIDGE_DEV'];
    const handle = await startBridge();
    const session = handle.pairingStore.createPendingSession('browser-extension');
    const claim = handle.pairingStore.claim(session.code, {
      clientId: 'client-abc',
      fingerprint: 'fp-original',
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error('pair-claim failed');

    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/create`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${claim.token}`,
        'X-Rebel-App-Id': 'browser-extension',
        'X-Rebel-Client-Id': 'client-abc',
        'X-Rebel-Client-Fingerprint': 'fp-attacker',
      },
      JSON.stringify({
        appId: 'browser-extension',
        clientId: 'client-abc',
        intent: 'summarise',
        tabContext: { tabId: 1 },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects an app-token that was bound to a fingerprint when none is presented (B4)', async () => {
    delete process.env['REBEL_APP_BRIDGE_DEV'];
    const handle = await startBridge();
    const session = handle.pairingStore.createPendingSession('browser-extension');
    const claim = handle.pairingStore.claim(session.code, {
      clientId: 'client-abc',
      fingerprint: 'fp-original',
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error('pair-claim failed');

    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/create`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${claim.token}`,
        'X-Rebel-App-Id': 'browser-extension',
        'X-Rebel-Client-Id': 'client-abc',
        // No X-Rebel-Client-Fingerprint header.
      },
      JSON.stringify({
        appId: 'browser-extension',
        clientId: 'client-abc',
        intent: 'summarise',
        tabContext: { tabId: 1 },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('accepts an app-token with null fingerprint both sides (B4 legacy compat)', async () => {
    // Office + older browser extensions that paired before fingerprint
    // binding landed must continue to work. `null`-on-both-sides is the
    // backward-compat path.
    delete process.env['REBEL_APP_BRIDGE_DEV'];
    const handle = await startBridge();
    const session = handle.pairingStore.createPendingSession('browser-extension');
    const claim = handle.pairingStore.claim(session.code, {
      clientId: 'client-abc',
      // no fingerprint passed
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error('pair-claim failed');

    const res = await requestJson(
      'POST',
      `http://127.0.0.1:${handle.port}/intent/conversation/create`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${claim.token}`,
        'X-Rebel-App-Id': 'browser-extension',
        'X-Rebel-Client-Id': 'client-abc',
      },
      JSON.stringify({
        appId: 'browser-extension',
        clientId: 'client-abc',
        intent: 'summarise',
        tabContext: { tabId: 1 },
      }),
    );
    expect(res.status).toBe(501); // passed auth → no handler → 501
  });
});
