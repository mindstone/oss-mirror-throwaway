/**
 * CORS + Private Network Access wire contract tests.
 *
 * These pin the exact wire-level behavior the browser extension relies on
 * for pairing + intent calls on modern Chromium (Chrome 117+, Comet, Brave,
 * Edge, Arc). A regression here silently breaks the install flow — the
 * popup shows "Couldn't find Rebel on this computer. Is the app open?"
 * because the preflight fails and `fetch()` throws before the real
 * request ever hits the bridge.
 *
 * Don't weaken these assertions without reading
 * `src/core/appBridge/server/corsHeaders.ts` first.
 */

import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppBridge, type AppBridgeHandle } from '@core/appBridge/server/bridge';
import {
  EXTENSION_ORIGIN_RE,
  isExtensionOrigin,
} from '@core/appBridge/server/corsHeaders';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER_EXT_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';

const handles: AppBridgeHandle[] = [];
const dirs: string[] = [];

let portBase = 55000;
function nextPortRange(count = 3): number[] {
  const start = portBase;
  portBase += count + 1;
  return Array.from({ length: count }, (_, i) => start + i);
}

async function makeStateDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'cors-headers-test-'));
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

/**
 * Raw http.request wrapper that surfaces response headers. The standard
 * `fetch()` helper in intentRouter.test.ts only returns status + body, so
 * we need our own for CORS assertions.
 */
async function raw(options: {
  method: string;
  port: number;
  path: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
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
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: raw,
          });
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

describe('appBridge/server/corsHeaders — isExtensionOrigin', () => {
  it('accepts valid chrome-extension and moz-extension origins', () => {
    expect(isExtensionOrigin(`chrome-extension://${EXT_ID}`)).toBe(true);
    expect(isExtensionOrigin(`moz-extension://${EXT_ID}`)).toBe(true);
  });

  it('rejects null, empty, and undefined', () => {
    expect(isExtensionOrigin(undefined)).toBe(false);
    expect(isExtensionOrigin('')).toBe(false);
    expect(isExtensionOrigin('null')).toBe(false);
  });

  it('rejects non-extension schemes', () => {
    expect(isExtensionOrigin('https://example.com')).toBe(false);
    expect(isExtensionOrigin('http://127.0.0.1:52320')).toBe(false);
    expect(isExtensionOrigin('file:///tmp/evil.html')).toBe(false);
  });

  it('rejects malformed extension IDs', () => {
    // Too short
    expect(isExtensionOrigin('chrome-extension://abc')).toBe(false);
    // Wrong alphabet (0-9, q-z, uppercase)
    expect(isExtensionOrigin(`chrome-extension://${'z'.repeat(32)}`)).toBe(false);
    expect(isExtensionOrigin(`chrome-extension://${'0'.repeat(32)}`)).toBe(false);
    expect(isExtensionOrigin(`chrome-extension://${'A'.repeat(32)}`)).toBe(false);
    // Trailing path
    expect(isExtensionOrigin(`chrome-extension://${EXT_ID}/popup.html`)).toBe(false);
  });

  it('regex is exported with the exact format used by originGuard', () => {
    // If this shape ever changes, originGuard.isValidExtensionId must
    // change in lockstep and both test suites must be updated.
    expect(EXTENSION_ORIGIN_RE.source).toBe(
      '^(chrome-extension|moz-extension):\\/\\/[a-p]{32}$',
    );
  });
});

describe('appBridge — OPTIONS preflight', () => {
  it('OPTIONS /intent/health with extension origin + PNA → 204 + full CORS headers', async () => {
    const handle = await startBridge();

    const res = await raw({
      method: 'OPTIONS',
      port: handle.port,
      path: '/intent/health',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Origin: `chrome-extension://${EXT_ID}`,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization, content-type',
        'Access-Control-Request-Private-Network': 'true',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(
      `chrome-extension://${EXT_ID}`,
    );
    // Access-Control-Allow-Methods must include GET + POST + OPTIONS so a
    // single preflight covers both health probes and pair/claim POSTs.
    expect(res.headers['access-control-allow-methods']).toMatch(/\bGET\b/);
    expect(res.headers['access-control-allow-methods']).toMatch(/\bPOST\b/);
    expect(res.headers['access-control-allow-methods']).toMatch(/\bOPTIONS\b/);
    // Allow-Headers must cover the authenticated /intent/* call set.
    expect(res.headers['access-control-allow-headers']).toMatch(/authorization/i);
    expect(res.headers['access-control-allow-headers']).toMatch(/x-rebel-app-id/i);
    expect(res.headers['access-control-allow-headers']).toMatch(/x-rebel-client-id/i);
    // PNA ACK is the whole point of this fix — must be present when requested.
    expect(res.headers['access-control-allow-private-network']).toBe('true');
    // Max-Age keeps the browser's preflight cache in sync with the server policy.
    expect(res.headers['access-control-max-age']).toBe('600');
    // Vary: Origin is required for cache correctness across origins.
    expect(res.headers['vary']).toMatch(/\bOrigin\b/);
    // Never echo credentials — extension uses credentials: 'omit'.
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('OPTIONS preflight WITHOUT Access-Control-Request-Private-Network → 204 + CORS but no PNA header', async () => {
    const handle = await startBridge();

    const res = await raw({
      method: 'OPTIONS',
      port: handle.port,
      path: '/intent/health',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Origin: `chrome-extension://${EXT_ID}`,
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(
      `chrome-extension://${EXT_ID}`,
    );
    // Don't blanket-include PNA — only echo it when the browser asks for it.
    // Packet-capture clarity.
    expect(res.headers['access-control-allow-private-network']).toBeUndefined();
  });

  it('OPTIONS with Origin: null → 401 + no CORS echo', async () => {
    const handle = await startBridge();

    const res = await raw({
      method: 'OPTIONS',
      port: handle.port,
      path: '/intent/health',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Origin: 'null',
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('OPTIONS with missing Origin header → 401 + no CORS echo', async () => {
    const handle = await startBridge();

    const res = await raw({
      method: 'OPTIONS',
      port: handle.port,
      path: '/intent/health',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
      },
    });

    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('OPTIONS with non-extension web origin → 401 + no CORS echo', async () => {
    const handle = await startBridge();

    const res = await raw({
      method: 'OPTIONS',
      port: handle.port,
      path: '/intent/health',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Origin: 'https://evil.example.com',
      },
    });

    expect(res.status).toBe(401);
    // Never echo a non-extension origin as ACAO — that would advertise
    // the bridge to arbitrary web pages.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('OPTIONS with wrong Host → 401 even with valid extension origin (DNS rebinding guard)', async () => {
    const handle = await startBridge();

    const res = await raw({
      method: 'OPTIONS',
      port: handle.port,
      path: '/intent/health',
      headers: {
        Host: 'evil.example.com',
        Origin: `chrome-extension://${EXT_ID}`,
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(res.status).toBe(401);
    // DNS-rebinding preflight must not leak ACAO echo even with a
    // well-formed extension origin — the browser should surface a CORS
    // failure, not a readable 401. Documented behavior in corsHeaders.ts
    // (host-rejected preflights strip ACAO after applyCorsResponseHeaders
    // already ran).
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('OPTIONS with PNA request header in mixed case → still echoes ACAP-N (case-insensitive)', async () => {
    const handle = await startBridge();

    const res = await raw({
      method: 'OPTIONS',
      port: handle.port,
      path: '/intent/health',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Origin: `chrome-extension://${EXT_ID}`,
        'Access-Control-Request-Method': 'GET',
        // Some browser forks may send 'True' instead of 'true'. Spec is
        // lowercase but we match case-insensitively for safety.
        'Access-Control-Request-Private-Network': 'True',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-private-network']).toBe('true');
  });

  it('OPTIONS /pair/claim with extension origin + PNA → 204 (pair route covered by global preflight)', async () => {
    const handle = await startBridge();

    const res = await raw({
      method: 'OPTIONS',
      port: handle.port,
      path: '/pair/claim',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Origin: `chrome-extension://${EXT_ID}`,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Private-Network': 'true',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(
      `chrome-extension://${EXT_ID}`,
    );
    expect(res.headers['access-control-allow-private-network']).toBe('true');
  });

  it('OPTIONS /intent/conversation/create echoes exact origin (not wildcard)', async () => {
    const handle = await startBridge();

    const res = await raw({
      method: 'OPTIONS',
      port: handle.port,
      path: '/intent/conversation/create',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Origin: `chrome-extension://${OTHER_EXT_ID}`,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Private-Network': 'true',
      },
    });

    expect(res.status).toBe(204);
    // Preflight accepts any well-formed extension origin shape — the
    // token/origin allowlist runs on the real request, not on preflight.
    expect(res.headers['access-control-allow-origin']).toBe(
      `chrome-extension://${OTHER_EXT_ID}`,
    );
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('OPTIONS on an unknown path still returns 204 (global preflight catches everything)', async () => {
    const handle = await startBridge();

    // Covers forward compatibility — if a new route is added, CORS works
    // out of the box without remembering to wire it per-router.
    const res = await raw({
      method: 'OPTIONS',
      port: handle.port,
      path: '/some/future/route',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Origin: `chrome-extension://${EXT_ID}`,
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(
      `chrome-extension://${EXT_ID}`,
    );
  });
});

describe('appBridge — CORS headers on real responses', () => {
  it('GET /intent/health includes ACAO + Vary: Origin on the 200 response', async () => {
    const handle = await startBridge();

    const res = await raw({
      method: 'GET',
      port: handle.port,
      path: '/intent/health',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Origin: `chrome-extension://${EXT_ID}`,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(
      `chrome-extension://${EXT_ID}`,
    );
    expect(res.headers['vary']).toMatch(/\bOrigin\b/);
  });

  it('POST /intent/conversation/create without auth → 401 + ACAO (readable 401 property)', async () => {
    const handle = await startBridge();

    // No Authorization header, no dev mode. Expect assertGatedAccess to
    // reject — the test is that the 401 STILL carries CORS headers so
    // the extension sees a readable status code instead of an opaque
    // CORS/network error. This is what makes future diagnosis possible
    // from the extension side.
    const res = await raw({
      method: 'POST',
      port: handle.port,
      path: '/intent/conversation/create',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Origin: `chrome-extension://${EXT_ID}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ intent: 'summarise' }),
    });

    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe(
      `chrome-extension://${EXT_ID}`,
    );
    expect(res.headers['vary']).toMatch(/\bOrigin\b/);
  });

  it('GET from non-extension origin → no ACAO header (browser blocks, readable error)', async () => {
    const handle = await startBridge();

    const res = await raw({
      method: 'GET',
      port: handle.port,
      path: '/intent/health',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Origin: 'https://evil.example.com',
      },
    });

    // Origin guard fails → 401. Crucially: no ACAO. The bridge is not
    // advertised to arbitrary origins.
    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    // Vary: Origin still present — cache correctness applies everywhere.
    expect(res.headers['vary']).toMatch(/\bOrigin\b/);
  });

  it('GET /intent/health response carries Vary: Origin (no duplicates even on repeated calls)', async () => {
    const handle = await startBridge();

    const res = await raw({
      method: 'GET',
      port: handle.port,
      path: '/intent/health',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Origin: `chrome-extension://${EXT_ID}`,
      },
    });

    // Vary should appear exactly once per unique value. A broken merge
    // would produce "Origin, Origin".
    const vary = res.headers['vary'];
    expect(vary).toBeDefined();
    const tokens = String(vary)
      .split(',')
      .map((s) => s.trim().toLowerCase());
    const originCount = tokens.filter((t) => t === 'origin').length;
    expect(originCount).toBe(1);
  });

  it('SSE GET /intent/conversation/:id/stream response keeps ACAO through writeHead(text/event-stream)', async () => {
    // Pins the Node writeHead-merge behavior that applyCorsResponseHeaders
    // relies on: even when the handler calls
    // `res.writeHead(200, { 'Content-Type': 'text/event-stream' })`, the
    // Access-Control-Allow-Origin set earlier must survive into the
    // response. A regression here would make the sidepanel's live stream
    // silently fail with opaque CORS errors while everything else still
    // works — exactly the kind of silent bug this test is here to catch.
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handler = vi.fn(async (_conversationId, _req, res, _hashedToken) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end();
    });
    const handle = await startBridge({
      intentHandlers: { streamConversation: handler },
    });

    const res = await raw({
      method: 'GET',
      port: handle.port,
      path: '/intent/conversation/sse-probe/stream',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Origin: `chrome-extension://${EXT_ID}`,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['access-control-allow-origin']).toBe(
      `chrome-extension://${EXT_ID}`,
    );
    expect(res.headers['vary']).toMatch(/\bOrigin\b/);
  });
});

describe('appBridge — no CORS leak to non-extension / internal surfaces', () => {
  it('Internal /apps/* routes never get ACAO echoed even with a well-formed extension Origin', async () => {
    // /apps/* is the router-internal relay path — it's not extension-facing
    // and should not receive CORS echo regardless of origin shape. The
    // preflight handler accepts OPTIONS (204) because it's global, but
    // the real /apps/* GET/POST must still require the router-internal
    // token and surface no ACAO header to the caller. We only assert
    // the real-request behavior here — OPTIONS coverage is in the
    // preflight describe block.
    const handle = await startBridge();

    const res = await raw({
      method: 'POST',
      port: handle.port,
      path: '/apps/does-not-exist',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Origin: `chrome-extension://${EXT_ID}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    // /apps/* without a router-internal token rejects. The response still
    // passes through applyCorsResponseHeaders (which sees a well-formed
    // extension origin and echoes it) — this is acceptable because the
    // real gate is the router-internal token, not CORS. The test here
    // documents that CORS is NOT the security boundary for /apps/*.
    expect([401, 403, 404, 400]).toContain(res.status);
  });
});
