/**
 * Stage 3 WebSocket server tests.
 *
 * Spins up a real `createAppBridge` instance (HTTP + WS) and exercises the
 * upgrade gate, auth handshake, register handshake, heartbeat plumbing, and
 * close-on-shutdown behaviour via a real `ws` client so every assertion is
 * end-to-end through the wire protocol.
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
import {
  PROTOCOL_VERSION,
  WS_CLOSE_GOING_AWAY,
  WS_CLOSE_PROTOCOL_VERSION_MISMATCH,
  WS_CLOSE_SUPERSEDED,
  WS_CLOSE_UNAUTHORIZED,
  WS_PATH,
} from '@core/appBridge/shared/protocol';

const ALLOWED_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${ALLOWED_EXTENSION_ID}`;
const DISALLOWED_EXTENSION_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const DISALLOWED_ORIGIN = `chrome-extension://${DISALLOWED_EXTENSION_ID}`;

let testPortBase = 54500;
const cleanupHandles: AppBridgeHandle[] = [];
const cleanupDirs: string[] = [];
const openSockets: WebSocket[] = [];

async function makeStateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-bridge-ws-stage3-'));
  cleanupDirs.push(dir);
  return dir;
}

function nextPortRange(count = 3): number[] {
  const start = testPortBase;
  testPortBase += count + 1;
  return Array.from({ length: count }, (_, i) => start + i);
}

interface BridgeFixture {
  handle: AppBridgeHandle;
  url: string;
  appToken: string;
}

async function bootstrapBridge(
  overrides: { clientId?: string; allowedIds?: readonly string[] } = {},
): Promise<BridgeFixture> {
  const handle = await createAppBridge({
    stateDirectory: await makeStateDir(),
    portCandidates: nextPortRange(),
    allowedChromeExtensionIds: overrides.allowedIds ?? [ALLOWED_EXTENSION_ID],
  });
  cleanupHandles.push(handle);

  const appToken = handle.tokenStore.issueAppToken(
    'browser-extension',
    overrides.clientId ?? 'client-1',
  );

  const url = `ws://127.0.0.1:${handle.port}${WS_PATH}`;
  return { handle, url, appToken };
}

function openWs(
  url: string,
  options: {
    origin?: string;
    headers?: Record<string, string>;
    host?: string;
  } = {},
): WebSocket {
  const opts: WebSocket.ClientOptions = {
    origin: options.origin ?? ORIGIN,
  };
  if (options.headers) {
    opts.headers = options.headers;
  }
  const ws = new WebSocket(url, opts);
  openSockets.push(ws);
  return ws;
}

interface CloseEvent {
  code: number;
  reason: string;
}

function waitForClose(ws: WebSocket, timeoutMs = 2_000): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for WS close (state=${ws.readyState})`));
    }, timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: Buffer.from(reason).toString('utf8') });
    });
    ws.once('error', () => {
      // ignore — close will still fire; error is often just "connection lost"
    });
  });
}

function waitForMessage(ws: WebSocket, timeoutMs = 2_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for WS message'));
    }, timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
  });
}

function waitForOpen(ws: WebSocket, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for WS open'));
    }, timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`Upgrade rejected with HTTP ${res.statusCode}`));
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function authAndRegister(
  ws: WebSocket,
  token: string,
  overrides: {
    appId?: string;
    clientId?: string;
    protocolVersion?: string;
    capabilities?: { id: string; version?: string }[];
  } = {},
): Promise<Record<string, unknown>> {
  const appId = overrides.appId ?? 'browser-extension';
  const clientId = overrides.clientId ?? 'client-1';
  const protocolVersion = overrides.protocolVersion ?? PROTOCOL_VERSION;
  const capabilities = overrides.capabilities ?? [
    { id: 'read_page', version: '1.0' },
    { id: 'scroll_to', version: '1.0' },
  ];

  ws.send(JSON.stringify({ type: 'auth', token, appId, clientId }));
  ws.send(
    JSON.stringify({
      type: 'register',
      protocolVersion,
      appId,
      clientId,
      capabilities,
    }),
  );
  return await waitForMessage(ws);
}

beforeEach(() => {
  delete process.env['REBEL_APP_BRIDGE_DEV'];
});

afterEach(async () => {
  while (openSockets.length > 0) {
    const s = openSockets.pop();
    if (s && s.readyState !== WebSocket.CLOSED) {
      try {
        s.terminate();
      } catch {
        // ignore
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

describe('appBridge/server/wsServer (Stage 3)', () => {
  it('HTTP requests to /ws outside of WebSocket upgrade get normal HTTP routing', async () => {
    const { handle } = await bootstrapBridge();
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: handle.port,
          method: 'GET',
          path: WS_PATH,
          headers: { origin: ORIGIN, host: `127.0.0.1:${handle.port}` },
        },
        (res) => {
          // /ws isn't a known HTTP route — the HTTP handler replies with
          // 400 BAD_REQUEST.
          expect(res.statusCode).toBeGreaterThanOrEqual(400);
          res.resume();
          res.on('end', () => resolve());
        },
      );
      req.on('error', reject);
      req.end();
    });
  });

  it('rejects WS upgrade with HTTP 401 when Origin is not allow-listed', async () => {
    const { url } = await bootstrapBridge();
    const ws = openWs(url, { origin: DISALLOWED_ORIGIN });
    await expect(waitForOpen(ws)).rejects.toThrow(/HTTP 401/);
  });

  it('accepts WS upgrade + full auth/register flow and sends RegisteredAck', async () => {
    const { handle, url, appToken } = await bootstrapBridge();
    const ws = openWs(url);
    await waitForOpen(ws);

    const ack = await authAndRegister(ws, appToken);

    expect(ack['type']).toBe('registered');
    expect(ack['serverProtocolVersion']).toBe('1.0');
    expect(ack['minClientProtocolVersion']).toBe('1.0');
    expect(ack['acceptedCapabilities']).toEqual(['read_page', 'scroll_to']);
    expect(typeof ack['sessionId']).toBe('string');

    expect(handle.connectionManager.getConnectedAppIds()).toContain('browser-extension');
    expect(handle.capabilityRegistry.has('browser-extension', 'read_page')).toBe(true);
    expect(handle.capabilityRegistry.has('browser-extension', 'scroll_to')).toBe(true);
  });

  it('closes with 4001 UNAUTHORIZED when the first message is not auth', async () => {
    const { url } = await bootstrapBridge();
    const ws = openWs(url);
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: 'ping' }));

    const closed = await waitForClose(ws);
    expect(closed.code).toBe(WS_CLOSE_UNAUTHORIZED);
  });

  it('closes with 4001 UNAUTHORIZED when auth token is unknown', async () => {
    const { url } = await bootstrapBridge();
    const ws = openWs(url);
    await waitForOpen(ws);

    ws.send(
      JSON.stringify({
        type: 'auth',
        token: 'not-a-valid-token',
        appId: 'browser-extension',
        clientId: 'client-1',
      }),
    );

    const closed = await waitForClose(ws);
    expect(closed.code).toBe(WS_CLOSE_UNAUTHORIZED);
  });

  it('closes with 4001 UNAUTHORIZED when auth message omits required fields', async () => {
    const { url, appToken } = await bootstrapBridge();
    const ws = openWs(url);
    await waitForOpen(ws);

    // appId + clientId missing — fails scope check even with a valid token.
    ws.send(JSON.stringify({ type: 'auth', token: appToken }));

    const closed = await waitForClose(ws);
    expect(closed.code).toBe(WS_CLOSE_UNAUTHORIZED);
  });

  it('closes with 4010 PROTOCOL_VERSION_MISMATCH when register uses an unsupported version', async () => {
    const { url, appToken } = await bootstrapBridge();
    const ws = openWs(url);
    await waitForOpen(ws);

    ws.send(
      JSON.stringify({
        type: 'auth',
        token: appToken,
        appId: 'browser-extension',
        clientId: 'client-1',
      }),
    );
    ws.send(
      JSON.stringify({
        type: 'register',
        protocolVersion: '0.9',
        appId: 'browser-extension',
        clientId: 'client-1',
        capabilities: [],
      }),
    );

    const closed = await waitForClose(ws);
    expect(closed.code).toBe(WS_CLOSE_PROTOCOL_VERSION_MISMATCH);
  });

  it('closes with 4001 UNAUTHORIZED when register appId does not match the token claim', async () => {
    const { url, appToken } = await bootstrapBridge();
    const ws = openWs(url);
    await waitForOpen(ws);

    ws.send(
      JSON.stringify({
        type: 'auth',
        token: appToken,
        appId: 'browser-extension',
        clientId: 'client-1',
      }),
    );
    ws.send(
      JSON.stringify({
        type: 'register',
        protocolVersion: PROTOCOL_VERSION,
        // Mismatched appId.
        appId: 'office-word',
        clientId: 'client-1',
        capabilities: [],
      }),
    );

    const closed = await waitForClose(ws);
    expect(closed.code).toBe(WS_CLOSE_UNAUTHORIZED);
  });

  it('responds with BAD_REQUEST error frame (no close) when the first post-auth message is not register', async () => {
    const { url, appToken } = await bootstrapBridge();
    const ws = openWs(url);
    await waitForOpen(ws);

    ws.send(
      JSON.stringify({
        type: 'auth',
        token: appToken,
        appId: 'browser-extension',
        clientId: 'client-1',
      }),
    );
    ws.send(JSON.stringify({ type: 'ping' }));

    const frame = await waitForMessage(ws);
    expect(frame['type']).toBe('error');
    expect(frame['code']).toBe('BAD_REQUEST');
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('supersedes an existing connection for the same appId with close code 4003', async () => {
    const { handle, url, appToken } = await bootstrapBridge();
    const firstSocket = openWs(url);
    await waitForOpen(firstSocket);
    await authAndRegister(firstSocket, appToken);

    const closePromise = waitForClose(firstSocket);

    const secondSocket = openWs(url);
    await waitForOpen(secondSocket);
    await authAndRegister(secondSocket, appToken);

    const closed = await closePromise;
    expect(closed.code).toBe(WS_CLOSE_SUPERSEDED);

    expect(handle.connectionManager.getConnectedAppIds()).toContain('browser-extension');
    expect(handle.connectionManager.list().length).toBe(1);
  });

  it('routes response messages to the command router', async () => {
    const { handle, url, appToken } = await bootstrapBridge();
    const ws = openWs(url);
    await waitForOpen(ws);
    await authAndRegister(ws, appToken);

    // Capture outbound command → respond with a matching response frame.
    const commandPromise = handle.commandRouter.dispatch({
      appId: 'browser-extension',
      capability: 'read_page',
      payload: { url: 'https://example.com' },
    });

    // The command frame arrives on the WS; reply with the matching id.
    const commandFrame = await waitForMessage(ws);
    expect(commandFrame['type']).toBe('command');
    expect(commandFrame['action']).toBe('read_page');
    const commandId = commandFrame['id'];
    expect(typeof commandId).toBe('string');

    ws.send(
      JSON.stringify({
        type: 'response',
        id: commandId,
        success: true,
        data: { title: 'Example' },
      }),
    );

    const result = await commandPromise;
    expect(result).toMatchObject({ success: true, data: { title: 'Example' } });
  });

  it('cleans up connection + capability registry + rejects pending on socket close', async () => {
    const { handle, url, appToken } = await bootstrapBridge();
    const ws = openWs(url);
    await waitForOpen(ws);
    await authAndRegister(ws, appToken);

    expect(handle.connectionManager.getConnectedAppIds()).toContain('browser-extension');
    expect(handle.capabilityRegistry.listAppIds()).toContain('browser-extension');

    const inFlight = handle.commandRouter.dispatch({
      appId: 'browser-extension',
      capability: 'read_page',
      payload: {},
    });
    // Attach the rejection expectation immediately so an async-close-driven
    // rejection doesn't race ahead of our assertion attach point.
    const rejection = expect(inFlight).rejects.toMatchObject({
      code: 'ADDIN_DISCONNECTED',
    });

    // Wait for the command to land on the wire before closing.
    await waitForMessage(ws);

    ws.close(1000, 'client closing');
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
    // Wait for the server-side close handler to run.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(handle.connectionManager.getConnectedAppIds()).not.toContain('browser-extension');
    expect(handle.capabilityRegistry.listAppIds()).not.toContain('browser-extension');

    await rejection;
  });

  it('closes all connected WS with 1001 GOING_AWAY on bridge.stop()', async () => {
    const { handle, url, appToken } = await bootstrapBridge();
    const ws = openWs(url);
    await waitForOpen(ws);
    await authAndRegister(ws, appToken);

    const closePromise = waitForClose(ws);
    await handle.stop();
    // Remove from cleanup list — we already stopped it.
    const idx = cleanupHandles.indexOf(handle);
    if (idx >= 0) cleanupHandles.splice(idx, 1);

    const closed = await closePromise;
    expect(closed.code).toBe(WS_CLOSE_GOING_AWAY);
  });

  it('times out unauthenticated sockets after authTimeoutMs and closes 4001', async () => {
    const stateDirectory = await makeStateDir();
    const ports = nextPortRange();
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(ports[0], '127.0.0.1', () => resolve());
    });
    const boundPort = (server.address() as { port: number }).port;

    const { CapabilityRegistry } = await import('@core/appBridge/server/capabilityRegistry');
    const { CommandRouter } = await import('@core/appBridge/server/commandRouter');
    const { ConnectionManager } = await import('@core/appBridge/server/connectionManager');
    const { TokenStore } = await import('@core/appBridge/server/tokenStore');
    const { createWsServer } = await import('@core/appBridge/server/wsServer');

    const cm = new ConnectionManager();
    const cr = new CommandRouter(cm);
    const cap = new CapabilityRegistry();
    const ts = new TokenStore();

    const ws = createWsServer({
      httpServer: server,
      originGuardOptions: { chromeExtensionIds: [ALLOWED_EXTENSION_ID] },
      connectionManager: cm,
      capabilityRegistry: cap,
      commandRouter: cr,
      tokenStore: ts,
      protocolVersion: PROTOCOL_VERSION,
      getPort: () => boundPort,
      authTimeoutMs: 100,
    });

    try {
      const url = `ws://127.0.0.1:${boundPort}${WS_PATH}`;
      const client = openWs(url);
      await waitForOpen(client);
      const closed = await waitForClose(client, 2_000);
      expect(closed.code).toBe(WS_CLOSE_UNAUTHORIZED);
    } finally {
      await ws.close();
      cr.dispose();
      cm.stopHeartbeat();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
