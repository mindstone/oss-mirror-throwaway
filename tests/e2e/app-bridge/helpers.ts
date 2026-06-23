/**
 * helpers.ts — shared fixtures for the `bridge-browser` E2E project.
 *
 * We deliberately do NOT spin up the full Electron app for every Stage 9
 * scenario. A Playwright Chromium context + an in-process Rebel App Bridge
 * give us deterministic, low-flake coverage of the pair / read / fill /
 * click / revoke / offscreen / port-fallback behaviours that matter.
 *
 * For scenarios that need a real MV3 extension (popup UI, service-worker
 * respawn), we rely on the browser-level `launchPersistentContext` already
 * configured in `playwright.config.ts` (`bridge-browser` project). The
 * extension ZIP lives at `dist/browser-extension.zip`; the on-disk
 * exploded copy lives at `packages/browser-extension/dist/`.
 *
 * These helpers only import from `@core/appBridge` + the public HTTP/WS
 * surface — no main-process Electron imports, so the suite runs in a
 * plain Node worker and never touches `electron-store` or Sentry.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 9)
 */

import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { chromium, test, type BrowserContext, type TestInfo } from '@playwright/test';
import {
  createAppBridge,
  type AppBridgeHandle,
  type AppBridgeOptions,
} from '../../../src/core/appBridge';

/** Base allow-listed extension ID Playwright uses for the test extension. */
export const TEST_EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const TEST_APP_ID = 'browser-extension';
export const TEST_CLIENT_ID = 'e2e-client-1';

/** Port range start — we bump it per-file so parallel runners don't clash. */
export const BRIDGE_E2E_PORT_BASE = 52400;

/**
 * Returns a list of port candidates that are very likely free on the current
 * host. We open a real socket to probe, then return the first N consecutive
 * free ports starting at `start`. This keeps E2E tests out of the 52320–52325
 * production range so a running Rebel dev instance doesn't compete.
 */
export async function reserveFreePorts(
  start: number,
  count: number,
): Promise<number[]> {
  const results: number[] = [];
  let cursor = start;
  while (results.length < count && cursor < start + 200) {
    const ok = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => {
        srv.close(() => resolve(false));
      });
      srv.once('listening', () => {
        srv.close(() => resolve(true));
      });
      srv.listen(cursor, '127.0.0.1');
    });
    if (ok) results.push(cursor);
    cursor += 1;
  }
  if (results.length < count) {
    throw new Error(
      `Could not find ${count} free ports starting at ${start}; got ${results.length}`,
    );
  }
  return results;
}

/**
 * Returns a unique temp directory per-test to host the bridge state file.
 * We clean it up via `registerCleanup`.
 */
export async function makeStateDir(testInfo: TestInfo): Promise<string> {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), `rebel-bridge-e2e-${slug}-`),
  );
  testInfo.annotations.push({ type: 'bridge-state-dir', description: dir });
  return dir;
}

/**
 * Spin up the App Bridge for a test. Accepts overrides for port candidates
 * and origin allow-list so individual scenarios can exercise the fallback
 * path or a non-default extension id.
 */
export async function startTestBridge(
  testInfo: TestInfo,
  overrides: Partial<AppBridgeOptions> = {},
): Promise<AppBridgeHandle> {
  const stateDirectory = await makeStateDir(testInfo);
  const baseOptions: AppBridgeOptions = {
    stateDirectory,
    portCandidates: await reserveFreePorts(BRIDGE_E2E_PORT_BASE, 3),
    allowedChromeExtensionIds: [TEST_EXT_ID],
    // Dev mode flips the pair-start `/pair/*` gate open for the pre-paired
    // state setup; production callers would present the router-internal
    // token. We still exercise the router-internal token in dedicated tests.
    devMode: true,
  };
  const merged: AppBridgeOptions = { ...baseOptions, ...overrides };
  // Set the dev env flag since some routes probe it directly.
  process.env['REBEL_APP_BRIDGE_DEV'] = '1';
  const handle = await createAppBridge(merged);
  testInfo.annotations.push({
    type: 'bridge-port',
    description: String(handle.port),
  });
  return handle;
}

/**
 * POST helper — always JSON, sets Origin and Host so the origin guard
 * accepts the request. Returns parsed body + status.
 */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const parsed = new URL(url);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: `chrome-extension://${TEST_EXT_ID}`,
      host: `${parsed.hostname}:${parsed.port}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsedBody: unknown = text;
  try {
    parsedBody = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // Keep the raw text on parse failure so tests can assert on it.
  }
  return { status: res.status, body: parsedBody, headers: res.headers };
}

/**
 * Complete the pair flow and return the issued app pairing token.
 * Uses the dev-mode /pair/start path (no router-internal token needed).
 */
export async function pairAsExtension(
  handle: AppBridgeHandle,
  appId: string = TEST_APP_ID,
  clientId: string = TEST_CLIENT_ID,
): Promise<{ token: string; code: string }> {
  const base = `http://127.0.0.1:${handle.port}`;
  const startRes = await postJson(`${base}/pair/start`, { appId });
  if (startRes.status !== 200) {
    throw new Error(
      `pair/start failed: ${startRes.status} ${JSON.stringify(startRes.body)}`,
    );
  }
  const startBody = startRes.body as { code: string; expiresAt: number };
  const claimRes = await postJson(`${base}/pair/claim`, {
    code: startBody.code,
    clientId,
  });
  if (claimRes.status !== 200) {
    throw new Error(
      `pair/claim failed: ${claimRes.status} ${JSON.stringify(claimRes.body)}`,
    );
  }
  const token = (claimRes.body as { token: string }).token;
  return { token, code: startBody.code };
}

/**
 * Connect + register a fake browser extension over WebSocket.
 * Capabilities default to the full browser set the MCP relay knows about.
 */
export async function connectFakeExtension(
  handle: AppBridgeHandle,
  token: string,
  opts: {
    appId?: string;
    clientId?: string;
    capabilities?: Array<{
      id: string;
      description?: string;
      inputSchema?: unknown;
    }>;
    commandHandler?: (cmd: {
      id: string;
      action: string;
      params: Record<string, unknown>;
    }) => Promise<{ success: true; data: unknown } | { success: false; error: string; code?: string }>;
  } = {},
): Promise<{
  ws: WebSocket;
  close(): Promise<void>;
}> {
  const appId = opts.appId ?? TEST_APP_ID;
  const clientId = opts.clientId ?? TEST_CLIENT_ID;
  const capabilities = opts.capabilities ?? defaultBrowserCapabilities();
  const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`, {
    headers: {
      origin: `chrome-extension://${TEST_EXT_ID}`,
      host: `127.0.0.1:${handle.port}`,
    },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'auth', token, appId, clientId }));
  ws.send(
    JSON.stringify({
      type: 'register',
      appId,
      protocolVersion: '1.0',
      appVersion: '0.1.0',
      clientId,
      capabilities,
    }),
  );
  // Wait for the `registered` ack before returning.
  await waitForMessage(ws, (msg) => msg.type === 'registered', 5_000);

  ws.on('message', (raw) => {
    if (!opts.commandHandler) return;
    let msg: unknown;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (
      !msg ||
      typeof msg !== 'object' ||
      (msg as { type?: string }).type !== 'command'
    ) {
      return;
    }
    const cmd = msg as {
      id: string;
      action: string;
      params: Record<string, unknown>;
    };
    opts
      .commandHandler(cmd)
      .then((result) => {
        if (result.success) {
          ws.send(
            JSON.stringify({
              type: 'response',
              id: cmd.id,
              success: true,
              data: result.data,
            }),
          );
        } else {
          ws.send(
            JSON.stringify({
              type: 'response',
              id: cmd.id,
              success: false,
              error: result.error,
              code: result.code ?? 'BAD_REQUEST',
            }),
          );
        }
      })
      .catch((err) => {
        ws.send(
          JSON.stringify({
            type: 'response',
            id: cmd.id,
            success: false,
            error: String(err),
            code: 'INTERNAL_ERROR',
          }),
        );
      });
  });

  return {
    ws,
    close: async () => {
      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        ws.once('close', () => resolve());
        ws.close(1000, 'test-teardown');
      });
    },
  };
}

async function waitForMessage(
  ws: WebSocket,
  predicate: (msg: { type?: string } & Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`Timed out waiting for WS message after ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData): void => {
      try {
        const parsed = JSON.parse(String(raw)) as { type?: string } & Record<
          string,
          unknown
        >;
        if (predicate(parsed)) {
          clearTimeout(t);
          ws.off('message', onMessage);
          resolve(parsed);
        }
      } catch {
        // ignore malformed frames
      }
    };
    ws.on('message', onMessage);
  });
}

/** Default capability catalog the fake extension advertises. */
export function defaultBrowserCapabilities(): Array<{
  id: string;
  description?: string;
}> {
  return [
    { id: 'status' },
    { id: 'read_page' },
    { id: 'get_selection' },
    { id: 'get_current_tab_url' },
    { id: 'fill_form' },
    { id: 'click' },
    { id: 'scroll' },
  ];
}

/**
 * Shorthand skip — the Playwright `bridge-browser` project is Chromium
 * headful; on Linux CI without Xvfb we want to bow out gracefully rather
 * than flake.
 */
export function skipIfHeadlessLinux(): void {
  test.skip(
    process.platform === 'linux' && !process.env['CI_XVFB'],
    'Stage 9 bridge-browser tests require headful Chromium; set CI_XVFB=1 on Linux.',
  );
}

/**
 * Resolve the built extension directory on disk. Playwright's
 * `bridge-browser` project loads this via `--load-extension`; tests can also
 * `fs.stat` it to ensure the build ran before the scenario.
 */
export function resolveBuiltExtensionDir(): string {
  return path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'packages',
    'browser-extension',
    'dist',
  );
}

/**
 * Ensure the browser-extension dist directory exists — fail loud with a
 * helpful message if Stage 9's build step was skipped.
 */
export async function assertExtensionBuilt(): Promise<void> {
  const dir = resolveBuiltExtensionDir();
  const manifestPath = path.join(dir, 'manifest.json');
  try {
    await fs.stat(manifestPath);
  } catch {
    throw new Error(
      `Browser extension not built at ${dir}. Run \`npm run build:browser-extension\` before running bridge-browser tests.`,
    );
  }
}

export async function getLoadedExtensionId(context: BrowserContext): Promise<string> {
  const existingWorker = context.serviceWorkers()[0];
  if (existingWorker) {
    const match = /^chrome-extension:\/\/([^/]+)\//.exec(existingWorker.url());
    if (match?.[1]) {
      return match[1];
    }
  }

  const page = context.pages()[0] ?? await context.newPage();
  const cdp = await context.newCDPSession(page);
  const targets = await cdp.send('Target.getTargets');
  const target = targets.targetInfos.find(
    (info: { url?: string; type?: string }) =>
      typeof info.url === 'string' &&
      info.url.startsWith('chrome-extension://') &&
      (info.type === 'service_worker' || info.type === 'page'),
  );
  const match = target?.url
    ? /^chrome-extension:\/\/([^/]+)\//.exec(target.url)
    : null;
  if (!match?.[1]) {
    throw new Error('Could not determine the loaded browser-extension id from Chromium targets');
  }
  return match[1];
}

interface CdpEnvelope {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
  sessionId?: string;
}

export class RawCdpClient {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (reason: unknown) => void;
      timer: NodeJS.Timeout;
    }
  >();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data) => {
      const parsed = JSON.parse(String(data)) as CdpEnvelope;
      if (typeof parsed.id !== 'number') {
        return;
      }
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(parsed.id);
      if (parsed.error) {
        pending.reject(new Error(parsed.error.message ?? 'CDP command failed'));
        return;
      }
      pending.resolve(parsed.result ?? {});
    });
    socket.on('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('CDP socket closed'));
      }
      this.pending.clear();
    });
  }

  static async connect(wsUrl: string): Promise<RawCdpClient> {
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return new RawCdpClient(socket);
  }

  async send<T extends Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    const id = this.nextId++;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP response to ${method}`));
      }, 10_000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      const envelope: CdpEnvelope = { id, method, params };
      if (sessionId) {
        envelope.sessionId = sessionId;
      }
      this.socket.send(JSON.stringify(envelope), (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.close();
    });
  }
}

async function resolveBrowserWsUrl(userDataDir: string): Promise<string> {
  const activePortFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(activePortFile, 'utf8');
      const [port, browserPath] = raw.trim().split('\n');
      if (port && browserPath) {
        return `ws://127.0.0.1:${port}${browserPath}`;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${activePortFile}`);
}

export async function launchExtensionBrowserForE2E(
  testInfo: TestInfo,
): Promise<{
  context: BrowserContext;
  extensionId: string;
  cdp: RawCdpClient;
  close: () => Promise<void>;
}> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), `rebel-ext-${testInfo.testId}-`));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${resolveBuiltExtensionDir()}`,
      `--load-extension=${resolveBuiltExtensionDir()}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
    ],
  });
  const cdp = await RawCdpClient.connect(await resolveBrowserWsUrl(userDataDir));
  const extensionId = await getLoadedExtensionId(context);

  return {
    context,
    extensionId,
    cdp,
    close: async () => {
      await cdp.close().catch(() => undefined);
      await context.close();
      await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export async function evaluateInExtensionServiceWorker<T>(
  cdp: RawCdpClient,
  extensionId: string,
  expression: string,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  let targetId: string | null = null;
  while (!targetId && Date.now() < deadline) {
    const targets = await cdp.send<{ targetInfos: Array<{ targetId: string; type?: string; url?: string }> }>(
      'Target.getTargets',
    );
    const match = targets.targetInfos.find(
      (info) =>
        info.type === 'service_worker' &&
        typeof info.url === 'string' &&
        info.url.startsWith(`chrome-extension://${extensionId}/`),
    );
    targetId = match?.targetId ?? null;
    if (!targetId) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  if (!targetId) {
    throw new Error(`Could not find extension service worker target for ${extensionId}`);
  }

  const attached = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const result = await cdp.send<{
    result: { value?: T };
    exceptionDetails?: {
      text?: string;
      exception?: {
        description?: string;
        value?: unknown;
      };
    };
  }>(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
    attached.sessionId,
  );
  await cdp.send('Target.detachFromTarget', { sessionId: attached.sessionId }).catch(() => undefined);

  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'Extension worker evaluation failed',
    );
  }
  return result.result.value as T;
}
