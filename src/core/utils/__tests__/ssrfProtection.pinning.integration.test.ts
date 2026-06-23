/**
 * Unmocked integration tests for the SSRF connect-to-validated-IP pinning.
 *
 * The sibling `ssrfProtection.test.ts` mocks `node:dns/promises` and spies on
 * `globalThis.fetch`, which proves the wiring but hides the REAL undici
 * dispatcher behaviour. These tests use a real loopback HTTP server and the
 * real `buildPinnedDispatcher` to prove the actual socket/lifecycle contract:
 *
 *  1. The pinned dispatcher controls the connect target — fetching a URL whose
 *     hostname is a fake public-looking name, pinned to 127.0.0.1, actually
 *     connects to the local server, and the `Host` header is derived from the
 *     URL hostname (NOT the pinned IP).
 *  2. A graceful `Agent.close()` does not truncate a body the caller reads.
 *  3. A graceful `Agent.close()` stays pending until an unread body is
 *     consumed or cancelled — the precise reason discard paths must cancel
 *     the body before returning (regression lock for the lifecycle fix).
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildPinnedDispatcher } from '@core/utils/ssrfProtection';

let server: http.Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function startServer(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve((server!.address() as AddressInfo).port);
    });
  });
}

describe('SSRF pinning — real dispatcher integration', () => {
  it('connects to the pinned IP and preserves the Host header from the URL hostname', async () => {
    const port = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`host=${req.headers.host}`);
    });

    const dispatcher = buildPinnedDispatcher('127.0.0.1');
    try {
      // The URL hostname is a fake public-looking name; only the pin sends us to
      // the local server. If pinning didn't work this would not resolve/connect.
      const res = await fetch(`http://validated-host.example:${port}/`, {
        // @ts-expect-error undici dispatcher option not in lib DOM fetch types
        dispatcher,
      });
      const body = await res.text();
      expect(res.status).toBe(200);
      // Host header is derived from the URL hostname, not the pinned IP.
      expect(body).toBe(`host=validated-host.example:${port}`);
      expect(body).not.toContain('127.0.0.1');
    } finally {
      await dispatcher.close();
    }
  });

  it('graceful close does not truncate a body the caller reads', async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('full-body-payload');
    });

    const dispatcher = buildPinnedDispatcher('127.0.0.1');
    const res = await fetch(`http://validated-host.example:${port}/`, {
      // @ts-expect-error undici dispatcher option
      dispatcher,
    });
    // Fire close BEFORE reading — graceful close must not truncate.
    const closeP = dispatcher.close();
    const body = await res.text();
    expect(body).toBe('full-body-payload');
    await closeP;
  });

  it('graceful close stays pending until an unread body is cancelled (lifecycle invariant)', async () => {
    // Hold the response stream OPEN: send headers + a first chunk but never end.
    // This is the realistic "body left unread" shape — undici keeps the socket
    // busy, so a graceful Agent.close() cannot resolve until the body is drained
    // or cancelled. (A tiny fully-buffered body would free the socket
    // immediately and not exercise the invariant.)
    let serverRes: http.ServerResponse | undefined;
    const port = await startServer((_req, res) => {
      serverRes = res;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write('chunk-1'); // intentionally no res.end()
    });

    const dispatcher = buildPinnedDispatcher('127.0.0.1');
    const res = await fetch(`http://validated-host.example:${port}/`, {
      // @ts-expect-error undici dispatcher option
      dispatcher,
    });

    let closed = false;
    const closeP = dispatcher.close().then(() => {
      closed = true;
    });

    // Give the close a chance to resolve; it must NOT while the body is open/unread.
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(false);

    // Cancelling the body releases the connection → close resolves.
    await res.body?.cancel();
    await closeP;
    expect(closed).toBe(true);

    // Let the dangling server response end so the server can close cleanly.
    serverRes?.end();
  });
});
