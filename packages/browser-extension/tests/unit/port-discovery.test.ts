import { describe, expect, it, vi } from 'vitest';
import {
  createPortDiscovery,
  probePort,
  HEALTH_PATH,
  HEALTH_IDENTITY,
} from '../../src/lib/port-discovery';

/**
 * Build a mock `fetch` that replies with the shape the real server emits.
 * The default body includes `service: HEALTH_IDENTITY`, `version: '1.0'`,
 * `protocolVersion: '1.0'`, and `ok: true` — callers can override via
 * `bodyOverride` but MUST keep the identity contract in mind.
 */
function buildFetch(
  behavior: Map<number, { status: number; body?: unknown }>,
): typeof fetch {
  return (async (url: string) => {
    const match = /127\.0\.0\.1:(\d+)/.exec(url);
    if (!match) throw new TypeError('refused');
    const port = Number(match[1]);
    const entry = behavior.get(port);
    if (!entry) throw new TypeError('refused');
    return new Response(JSON.stringify(entry.body ?? {}), {
      status: entry.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('probePort', () => {
  it('returns the discovered record on a valid 200/identity match', async () => {
    // Must mirror the *real* server response from
    // `src/core/appBridge/server/intentRouter.ts` (HEALTH_SERVICE_ID +
    // HEALTH_SERVICE_VERSION). Drifting this mock silently hides contract
    // regressions.
    const fetchImpl = buildFetch(
      new Map([
        [
          52320,
          {
            status: 200,
            body: {
              ok: true,
              service: HEALTH_IDENTITY,
              version: '1.0',
              protocolVersion: '1.0',
              port: 52320,
            },
          },
        ],
      ]),
    );
    const res = await probePort(52320, { fetchImpl });
    expect(res).not.toBeNull();
    expect(res!.port).toBe(52320);
    expect(res!.origin).toBe('http://127.0.0.1:52320');
    expect(res!.version).toBe('1.0');
  });

  it('rejects non-Rebel health bodies', async () => {
    const fetchImpl = buildFetch(
      new Map([[52320, { status: 200, body: { ok: true, service: 'someone-else' } }]]),
    );
    const res = await probePort(52320, { fetchImpl });
    expect(res).toBeNull();
  });

  it('rejects non-200 responses', async () => {
    const fetchImpl = buildFetch(
      new Map([[52320, { status: 500, body: { ok: false } }]]),
    );
    const res = await probePort(52320, { fetchImpl });
    expect(res).toBeNull();
  });
});

describe('createPortDiscovery', () => {
  it('returns the first responding candidate', async () => {
    const fetchImpl = buildFetch(
      new Map([
        [52322, { status: 200, body: { ok: true, service: HEALTH_IDENTITY } }],
      ]),
    );
    const d = createPortDiscovery({ fetchImpl });
    const res = await d.getPort();
    expect(res?.port).toBe(52322);
  });

  it('caches the discovery for the configured TTL', async () => {
    const calls = new Map<number, number>();
    const fetchImpl = (async (url: string) => {
      const match = /127\.0\.0\.1:(\d+)/.exec(url);
      expect(match).not.toBeNull();
      expect(url.endsWith(HEALTH_PATH)).toBe(true);
      const port = Number(match![1]);
      calls.set(port, (calls.get(port) ?? 0) + 1);
      if (port === 52320) {
        return new Response(
          JSON.stringify({ ok: true, service: HEALTH_IDENTITY }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new TypeError('refused');
    }) as unknown as typeof fetch;
    let clock = 0;
    const d = createPortDiscovery({
      fetchImpl,
      cacheTtlMs: 1_000,
      now: () => clock,
    });
    const a = await d.getPort();
    expect(a?.port).toBe(52320);
    const b = await d.getPort();
    expect(b?.port).toBe(52320);
    expect(calls.get(52320)).toBe(1);
    clock += 2_000;
    await d.getPort();
    expect(calls.get(52320)).toBe(2);
  });

  it('invalidate() forces a fresh probe on next call', async () => {
    let hits = 0;
    const fetchImpl = (async () => {
      hits += 1;
      return new Response(
        JSON.stringify({ ok: true, service: HEALTH_IDENTITY }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const d = createPortDiscovery({ fetchImpl });
    await d.getPort();
    expect(hits).toBe(1);
    d.invalidate();
    await d.getPort();
    expect(hits).toBe(2);
  });

  it('returns null when no candidate responds', async () => {
    const fetchImpl = (() =>
      Promise.reject(new TypeError('refused'))) as unknown as typeof fetch;
    const d = createPortDiscovery({ fetchImpl, candidates: [52320, 52321] });
    const res = await d.getPort();
    expect(res).toBeNull();
    expect(d.peekCache()).toBeNull();
  });

  it('aborts slow probes using the configured timeout', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError') as unknown as Error);
        });
      })) as unknown as typeof fetch;
    const d = createPortDiscovery({
      fetchImpl,
      probeTimeoutMs: 5,
      candidates: [52320],
    });
    const start = Date.now();
    const res = await d.getPort();
    expect(res).toBeNull();
    expect(Date.now() - start).toBeLessThan(200);
  });
});
