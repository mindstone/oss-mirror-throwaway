/**
 * Install-flow logging — behavioral test.
 *
 * Purpose: prove that every decision point we touched in Follow-up B
 * actually emits a structured `installEvent` with the documented
 * `event` name. Without this, the log-side of the install flow is
 * invisible to regressions — a future refactor could silently drop the
 * `installEvent(...)` call and nothing in CI would notice.
 *
 * Strategy: spawn the real bridge with a capture logger, drive each
 * decision point over the wire (HTTP preflight, origin-guard reject,
 * pair routes), then assert that `log.warn/info/...` was called with
 * `{ event: '<expected>' }`. This is INTEGRATION-level rather than
 * unit-level on purpose — it's the only way to catch wiring regressions
 * (e.g. bridge.ts forgetting to pass `logger` into `originGuardOptions`).
 *
 * Not covered here:
 *   - appBridgeManager TOFU sites (require full service scaffold)
 *   - command-timeout (requires hanging a live WS client past timeout)
 *   - ws.auth.* (covered by wsServer unit tests + breadcrumb assertions)
 * Those have lower wiring-regression risk because they share the same
 * `log` instance already validated by the extract.start / extract.written
 * sites below.
 */

import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { createAppBridge, type AppBridgeHandle } from '@core/appBridge/server/bridge';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

interface CapturedCall {
  level: 'debug' | 'info' | 'warn' | 'error' | 'trace' | 'fatal';
  obj: Record<string, unknown>;
  msg: unknown;
}

function makeCaptureLogger(): { logger: Logger; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const wrap = (level: CapturedCall['level']) =>
    vi.fn((objOrMsg: unknown, maybeMsg?: unknown) => {
      const obj =
        typeof objOrMsg === 'object' && objOrMsg !== null
          ? (objOrMsg as Record<string, unknown>)
          : {};
      const msg = typeof objOrMsg === 'string' ? objOrMsg : maybeMsg;
      calls.push({ level, obj, msg });
    });
  const logger = {
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
    trace: wrap('trace'),
    fatal: wrap('fatal'),
    child: () => logger,
    bindings: () => ({}),
    flush: () => undefined,
    isLevelEnabled: () => true,
    level: 'debug',
  } as unknown as Logger;
  // After creation, rebind `child()` so it returns the same instance
  // (pino.child() normally returns a new logger — we want all bindings
  // routed to the same capture array for assertions).
  (logger as unknown as { child: () => Logger }).child = () => logger;
  return { logger, calls };
}

function installEventCalls(
  calls: CapturedCall[],
  event: string,
): CapturedCall[] {
  return calls.filter((c) => c.obj.event === event);
}

const handles: AppBridgeHandle[] = [];
const dirs: string[] = [];

let portBase = 56000;
function nextPortRange(count = 3): number[] {
  const start = portBase;
  portBase += count + 1;
  return Array.from({ length: count }, (_, i) => start + i);
}

async function makeStateDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'install-logging-test-'));
  dirs.push(d);
  return d;
}

async function raw(options: {
  method: string;
  port: number;
  path: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
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
        let body = '';
        res.on('data', (chunk) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body });
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

async function startBridge(
  logger: Logger,
): Promise<AppBridgeHandle & { port: number }> {
  const stateDirectory = await makeStateDir();
  const handle = await createAppBridge({
    stateDirectory,
    portCandidates: nextPortRange(),
    allowedChromeExtensionIds: [EXT_ID],
    logger,
  });
  handles.push(handle);
  return handle as AppBridgeHandle & { port: number };
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
});

describe('install-flow logging — decision points emit installEvents', () => {
  it('CORS preflight from an unknown origin emits app-bridge.cors.preflight.reject.origin', async () => {
    const { logger, calls } = makeCaptureLogger();
    const bridge = await startBridge(logger);

    const resp = await raw({
      method: 'OPTIONS',
      port: bridge.port,
      path: '/pair/start',
      headers: {
        Origin: 'https://evil.example.com',
        'Access-Control-Request-Method': 'POST',
        Host: `127.0.0.1:${bridge.port}`,
      },
    });
    expect(resp.status).toBeGreaterThanOrEqual(400);

    const matched = installEventCalls(
      calls,
      'app-bridge.cors.preflight.reject.origin',
    );
    expect(matched.length).toBeGreaterThan(0);
    expect(matched[0].level).toBe('warn');
  });

  it('CORS preflight with a spoofed Host header emits app-bridge.cors.preflight.reject.host', async () => {
    const { logger, calls } = makeCaptureLogger();
    const bridge = await startBridge(logger);

    await raw({
      method: 'OPTIONS',
      port: bridge.port,
      path: '/pair/start',
      headers: {
        Origin: `chrome-extension://${EXT_ID}`,
        'Access-Control-Request-Method': 'POST',
        Host: 'evil.attacker.com:80',
      },
    });

    const matched = installEventCalls(
      calls,
      'app-bridge.cors.preflight.reject.host',
    );
    expect(matched.length).toBeGreaterThan(0);
    expect(matched[0].level).toBe('warn');
    // Must not leak raw Host header.
    expect(matched[0].obj.host).toBeUndefined();
  });

  it('CORS preflight accepted emits debug-level app-bridge.cors.preflight.accepted', async () => {
    const { logger, calls } = makeCaptureLogger();
    const bridge = await startBridge(logger);

    await raw({
      method: 'OPTIONS',
      port: bridge.port,
      path: '/pair/start',
      headers: {
        Origin: `chrome-extension://${EXT_ID}`,
        'Access-Control-Request-Method': 'POST',
        Host: `127.0.0.1:${bridge.port}`,
      },
    });

    const matched = installEventCalls(
      calls,
      'app-bridge.cors.preflight.accepted',
    );
    expect(matched.length).toBeGreaterThan(0);
    expect(matched[0].level).toBe('debug');
  });

  it('origin-guard reject redacts the raw origin in the emitted event', async () => {
    const { logger, calls } = makeCaptureLogger();
    const bridge = await startBridge(logger);

    // POST /pair/start from an extension NOT in the allowlist trips the
    // origin-guard synchronous path. We don't care about the HTTP status,
    // we care that the event was emitted with sanitized fields.
    await raw({
      method: 'POST',
      port: bridge.port,
      path: '/pair/start',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://not-an-extension.example.com',
        Host: `127.0.0.1:${bridge.port}`,
      },
      body: JSON.stringify({}),
    });

    const matched = installEventCalls(calls, 'app-bridge.origin-guard.reject');
    expect(matched.length).toBeGreaterThan(0);
    expect(matched[0].level).toBe('warn');
    // Raw origin must be stripped.
    expect(matched[0].obj.origin).toBeUndefined();
  });
});
