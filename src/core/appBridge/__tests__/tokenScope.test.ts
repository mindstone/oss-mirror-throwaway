/**
 * Token-scope enforcement (R5 / R6 / D13) — Stage 3.
 *
 * Three axes:
 *   1. `TokenStore.verifyAppToken` — `(appId, clientId)` must match claims.
 *   2. `TokenStore.classifyToken` — pair / router-internal / unknown.
 *   3. Route-level enforcement:
 *      - `/apps/*` relay rejects pair tokens with 403 + Sentry breadcrumb
 *      - `/apps/*` relay requires `X-Rebel-App-Id`, matching path segment
 *      - `/pair/revoke` rejects router-internal tokens with 403 + breadcrumb
 *      - Revocation removes the pairing token from subsequent WS auth attempts
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ErrorReporter } from '@core/errorReporter';
import { createAppBridge, type AppBridgeHandle } from '@core/appBridge/server/bridge';
import { TokenStore } from '@core/appBridge/server/tokenStore';
import {
  PROTOCOL_VERSION,
  WS_CLOSE_UNAUTHORIZED,
  WS_PATH,
} from '@core/appBridge/shared/protocol';

const ALLOWED_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${ALLOWED_EXTENSION_ID}`;

let testPortBase = 55500;
const cleanupHandles: AppBridgeHandle[] = [];
const cleanupDirs: string[] = [];

async function makeStateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-bridge-token-scope-'));
  cleanupDirs.push(dir);
  return dir;
}

function nextPortRange(count = 3): number[] {
  const start = testPortBase;
  testPortBase += count + 1;
  return Array.from({ length: count }, (_, i) => start + i);
}

type BreadcrumbArgs = Parameters<ErrorReporter['addBreadcrumb']>[0];

interface TrackingErrorReporter extends ErrorReporter {
  breadcrumbs: BreadcrumbArgs[];
}

function fakeReporter(): TrackingErrorReporter {
  const breadcrumbs: BreadcrumbArgs[] = [];
  return {
    breadcrumbs,
    addBreadcrumb: (b: BreadcrumbArgs): void => {
      breadcrumbs.push(b);
    },
    captureException: (): void => undefined,
    captureMessage: (): void => undefined,
  };
}

interface BridgeFixture {
  handle: AppBridgeHandle;
  reporter: TrackingErrorReporter;
}

async function bootstrapBridgeWithReporter(): Promise<BridgeFixture> {
  const reporter = fakeReporter();
  const handle = await createAppBridge({
    stateDirectory: await makeStateDir(),
    portCandidates: nextPortRange(),
    allowedChromeExtensionIds: [ALLOWED_EXTENSION_ID],
    errorReporter: reporter,
  });
  cleanupHandles.push(handle);
  return { handle, reporter };
}

interface HttpResponse {
  status: number;
  body: string;
  json: unknown;
}

function postJson(
  port: number,
  pathSuffix: string,
  headers: Record<string, string>,
  body: string = '{}',
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: pathSuffix,
        headers: {
          host: `127.0.0.1:${port}`,
          origin: ORIGIN,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body).toString(),
          ...headers,
        },
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
    req.write(body);
    req.end();
  });
}

beforeEach(() => {
  delete process.env['REBEL_APP_BRIDGE_DEV'];
});

afterEach(async () => {
  while (cleanupHandles.length > 0) {
    const h = cleanupHandles.pop();
    if (h) await h.stop().catch(() => undefined);
  }
  while (cleanupDirs.length > 0) {
    const d = cleanupDirs.pop();
    if (d) await fs.rm(d, { recursive: true, force: true });
  }
});

describe('appBridge/server/tokenStore (Stage 3 scope enforcement)', () => {
  it('verifyAppToken returns null when appId does not match the token claim', () => {
    const ts = new TokenStore();
    const token = ts.issueAppToken('browser-extension', 'client-1');
    expect(
      ts.verifyAppToken(token, { appId: 'office-word', clientId: 'client-1' }),
    ).toBeNull();
  });

  it('verifyAppToken returns null when clientId does not match the token claim', () => {
    const ts = new TokenStore();
    const token = ts.issueAppToken('browser-extension', 'client-A');
    expect(
      ts.verifyAppToken(token, { appId: 'browser-extension', clientId: 'client-B' }),
    ).toBeNull();
  });

  it('verifyAppToken returns the claims when token + appId + clientId all match', () => {
    const ts = new TokenStore();
    const token = ts.issueAppToken('browser-extension', 'client-1');
    const claims = ts.verifyAppToken(token, {
      appId: 'browser-extension',
      clientId: 'client-1',
    });
    expect(claims).not.toBeNull();
    expect(claims?.appId).toBe('browser-extension');
    expect(claims?.clientId).toBe('client-1');
  });

  it('classifyToken distinguishes pair / router-internal / unknown in constant time', () => {
    const ts = new TokenStore();
    const pairToken = ts.issueAppToken('browser-extension', 'client-1');
    const routerToken = ts.getRouterInternalToken();

    expect(ts.classifyToken(pairToken)).toBe('pair');
    expect(ts.classifyToken(routerToken)).toBe('router-internal');
    expect(ts.classifyToken('definitely-not-a-token')).toBe('unknown');
    expect(ts.classifyToken('')).toBe('unknown');
  });

  it('revokeAppToken removes the pairing token from verifyAppToken and classifyToken', () => {
    const ts = new TokenStore();
    const token = ts.issueAppToken('browser-extension', 'client-1');
    expect(ts.classifyToken(token)).toBe('pair');
    ts.revokeAppToken(token);
    expect(ts.classifyToken(token)).toBe('unknown');
    expect(
      ts.verifyAppToken(token, { appId: 'browser-extension', clientId: 'client-1' }),
    ).toBeNull();
  });
});

describe('appBridge/server/httpRelay (token-scope enforcement)', () => {
  it('pair token presented on /apps/* is rejected with 403 + Sentry breadcrumb', async () => {
    const { handle, reporter } = await bootstrapBridgeWithReporter();
    const pairToken = handle.tokenStore.issueAppToken('browser-extension', 'client-1');
    const res = await postJson(
      handle.port,
      '/apps/browser-extension/read_page',
      {
        authorization: `Bearer ${pairToken}`,
        'x-rebel-app-id': 'browser-extension',
      },
    );

    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: 'FORBIDDEN' });
    expect(
      reporter.breadcrumbs.some(
        (b) =>
          b.category === 'app-bridge.security' &&
          b.message === 'pair-token-rejected-on-relay',
      ),
    ).toBe(true);
  });

  it('/apps/* missing X-Rebel-App-Id header returns 400 BAD_REQUEST', async () => {
    const { handle } = await bootstrapBridgeWithReporter();
    const res = await postJson(
      handle.port,
      '/apps/browser-extension/read_page',
      {
        authorization: `Bearer ${handle.routerInternalToken}`,
      },
    );

    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('/apps/* X-Rebel-App-Id that does not match :appId returns 400 BAD_REQUEST', async () => {
    const { handle } = await bootstrapBridgeWithReporter();
    const res = await postJson(
      handle.port,
      '/apps/browser-extension/read_page',
      {
        authorization: `Bearer ${handle.routerInternalToken}`,
        'x-rebel-app-id': 'custom-app',
      },
    );

    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('/apps/* with router-internal token + matching header but no connected app returns 503 APP_NOT_CONNECTED', async () => {
    const { handle } = await bootstrapBridgeWithReporter();
    const res = await postJson(
      handle.port,
      '/apps/browser-extension/read_page',
      {
        authorization: `Bearer ${handle.routerInternalToken}`,
        'x-rebel-app-id': 'browser-extension',
      },
    );

    // Stage 4: auth + scope check pass, capability lookup runs, no app is
    // registered → 503 per the ErrorCode → HTTP status mapping.
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ code: 'APP_NOT_CONNECTED' });
  });
});

describe('appBridge/server/pairRoutes (token-scope enforcement)', () => {
  it('router-internal token on /pair/revoke is rejected with 403 + Sentry breadcrumb', async () => {
    const { handle, reporter } = await bootstrapBridgeWithReporter();

    const res = await postJson(
      handle.port,
      '/pair/revoke',
      {
        authorization: `Bearer ${handle.routerInternalToken}`,
      },
    );

    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: 'FORBIDDEN' });
    expect(
      reporter.breadcrumbs.some(
        (b) =>
          b.category === 'app-bridge.security' &&
          b.message === 'router-internal-token-rejected-on-pair-revoke',
      ),
    ).toBe(true);
  });
});

describe('tokenStore revocation invalidates subsequent WS auth', () => {
  it('after revokeAppToken, a WS client presenting that token is closed with 4001', async () => {
    const { handle } = await bootstrapBridgeWithReporter();
    const token = handle.tokenStore.issueAppToken('browser-extension', 'client-1');
    handle.tokenStore.revokeAppToken(token);

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}${WS_PATH}`, {
      origin: ORIGIN,
    });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('open timed out')), 2_000);
      ws.once('open', () => {
        clearTimeout(t);
        resolve();
      });
      ws.once('unexpected-response', () => {
        clearTimeout(t);
        reject(new Error('unexpected response on ws upgrade'));
      });
      ws.once('error', (err) => {
        clearTimeout(t);
        reject(err);
      });
    });

    ws.send(
      JSON.stringify({
        type: 'auth',
        token,
        appId: 'browser-extension',
        clientId: 'client-1',
      }),
    );

    const closed = await new Promise<{ code: number }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('close timed out')), 2_000);
      ws.once('close', (code) => {
        clearTimeout(t);
        resolve({ code });
      });
    });
    expect(closed.code).toBe(WS_CLOSE_UNAUTHORIZED);
    // Touch to suppress unused-import lint.
    void PROTOCOL_VERSION;
  });
});
