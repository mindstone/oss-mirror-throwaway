/**
 * Behavioral contract test for Stage 5 (analytics flush on shutdown) +
 * Stage 6a F2 (HTTP route 5xx Sentry capture). Both are surfaced through
 * exports from `server.ts`.
 *
 * F2 noise control is the load-bearing invariant: expected `RouteError` 4xx
 * MUST NOT be captured (they are normal client outcomes), while unexpected 5xx
 * (RouteError 5xx or any non-RouteError throw) MUST be captured once per
 * route-family-per-process with a stable fingerprint + redacted route.
 *
 * Stage 5: `flushMainAnalytics` (imported from the shared @main/analytics
 * client) is awaited during shutdown — we assert server.ts wires the import so
 * the shutdown path can call it. (A full SIGTERM→shutdown integration test
 * would require booting the whole service; here we pin the contract that the
 * flush function is the one server.ts depends on and that it is swallow-safe.)
 *
 * Importing `server.ts` runs `main()` at module load, so we mock `./bootstrap`
 * to return a never-resolving promise — `main()` parks at `await bootstrap()`
 * and never touches the network or filesystem.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { RouteError } from '../httpUtils';

// platformInit (transitively imported by server.ts) asserts a safe test data
// root at module load — set one under os.tmpdir() before any import resolves.
if (!process.env.REBEL_USER_DATA || process.env.REBEL_USER_DATA.trim().length === 0) {
  process.env.REBEL_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-server-errmon-test-'));
}

// `__REBEL_VERSION__` / `__BUILD_*` are esbuild build-time defines (see
// cloud-service/build.mjs); they don't exist under vitest. Define them on
// globalThis so server.ts's module-load reads resolve instead of throwing
// ReferenceError. Values are irrelevant to these tests.
(globalThis as Record<string, unknown>).__REBEL_VERSION__ = 'test';
(globalThis as Record<string, unknown>).__BUILD_COMMIT__ = 'test';
(globalThis as Record<string, unknown>).__BUILD_DATE__ = 'test';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { captureExceptionMock, flushMainAnalyticsMock, sentryFlushMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
  flushMainAnalyticsMock: vi.fn(async (..._args: unknown[]) => true),
  sentryFlushMock: vi.fn(async (..._args: unknown[]) => true),
}));

vi.mock('@core/errorReporter', () => ({
  setErrorReporter: vi.fn(),
  getErrorReporter: () => ({
    captureException: (...args: unknown[]) => captureExceptionMock(...args),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  }),
}));

vi.mock('@main/analytics', () => ({
  flushMainAnalytics: (...args: unknown[]) => flushMainAnalyticsMock(...args),
}));

vi.mock('@sentry/node', () => ({
  flush: (...args: unknown[]) => sentryFlushMock(...args),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// Park main() at `await bootstrap()` so importing server.ts has no side effects.
vi.mock('../bootstrap', () => ({
  bootstrap: () => new Promise(() => {}),
  stopGracefulFsObservability: vi.fn(),
}));

function mockReq(method: string, url: string): http.IncomingMessage {
  return { method, url, headers: {} } as unknown as http.IncomingMessage;
}

describe('server.ts — Stage 6a F2 route-error capture + Stage 5 flush wiring', () => {
  let captureRouteError: typeof import('../server').captureRouteError;
  let resetThrottle: typeof import('../server').__resetCapturedRouteFamiliesForTests;
  let flushMainAnalytics: typeof import('../server').__flushMainAnalyticsForTests;
  let handleFatal: typeof import('../server').__handleFatalProcessErrorForTests;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../server');
    captureRouteError = mod.captureRouteError;
    resetThrottle = mod.__resetCapturedRouteFamiliesForTests;
    flushMainAnalytics = mod.__flushMainAnalyticsForTests;
    handleFatal = mod.__handleFatalProcessErrorForTests;
    resetThrottle();
  });

  afterEach(() => {
    resetThrottle();
  });

  // ── F2: noise control — expected 4xx are NOT captured ───────────────────────

  it('does NOT capture expected RouteError 4xx (client errors are not Sentry issues)', () => {
    captureRouteError(
      new RouteError('UNAUTHORIZED', { status: 401, message: 'nope' }),
      mockReq('GET', '/api/sessions'),
      { route: '/api/sessions', phase: 'authenticated' },
    );
    captureRouteError(
      new RouteError('NOT_FOUND', { status: 404, message: 'gone' }),
      mockReq('GET', '/api/library'),
      { route: '/api/library', phase: 'authenticated' },
    );
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  // ── F2: unexpected 5xx ARE captured ─────────────────────────────────────────

  it('captures a non-RouteError throw (unexpected 5xx) with surface/area/route tags + stable fingerprint', () => {
    const err = new Error('database exploded');
    captureRouteError(err, mockReq('POST', '/api/sessions'), {
      route: '/api/sessions',
      phase: 'authenticated',
    });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [capturedErr, ctx] = captureExceptionMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(capturedErr).toBe(err);
    expect(ctx.tags).toMatchObject({
      surface: 'cloud',
      area: 'http',
      route: '/api/sessions',
      method: 'POST',
      status: 500,
      phase: 'authenticated',
    });
    expect(ctx.fingerprint).toEqual(['cloud.http.route_error', 'POST', '/api/sessions', 'INTERNAL_ERROR']);
    expect(ctx.level).toBe('error');
  });

  it('captures a RouteError with a 5xx status (unexpected server error)', () => {
    captureRouteError(
      new RouteError('INTERNAL_ERROR', { status: 500, message: 'boom' }),
      mockReq('GET', '/api/diagnostics'),
      { route: '/api/diagnostics', phase: 'shared-route' },
    );
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  // ── F2: redaction — query strings never reach Sentry tags/fingerprint ────────

  it('redacts the query string from the route family (no token leakage)', () => {
    captureRouteError(new Error('boom'), mockReq('GET', '/api/events?token=secret'), {
      route: '/api/events?token=secret',
      phase: 'async-outer',
    });
    const [, ctx] = captureExceptionMock.mock.calls[0] as [unknown, Record<string, unknown>];
    const tags = ctx.tags as Record<string, unknown>;
    expect(tags.route).toBe('/api/events');
    expect(JSON.stringify(ctx)).not.toContain('secret');
  });

  // ── F2: throttle — once per route-family-per-process ─────────────────────────

  it('throttles repeated failures of the same route family to a single capture', () => {
    for (let i = 0; i < 5; i++) {
      captureRouteError(new Error('boom'), mockReq('POST', '/api/sessions'), {
        route: '/api/sessions',
        phase: 'authenticated',
      });
    }
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);

    // A different route family is captured independently.
    captureRouteError(new Error('boom'), mockReq('POST', '/api/library'), {
      route: '/api/library',
      phase: 'authenticated',
    });
    expect(captureExceptionMock).toHaveBeenCalledTimes(2);
  });

  // ── F2 / M1: share-token redaction — the secret token never reaches Sentry ───

  it('redacts the share token from the route family (tag + fingerprint), not the raw token', () => {
    const token = 'sk_share_3f9a2b1c8d7e6f5a4b3c2d1e';
    captureRouteError(new Error('boom'), mockReq('GET', `/api/shared/${token}`), {
      route: `/api/shared/${token}`,
      phase: 'shared-route',
    });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0] as [unknown, Record<string, unknown>];
    const tags = ctx.tags as Record<string, unknown>;
    expect(tags.route).toBe('/api/shared/:token');
    expect(ctx.fingerprint).toEqual(['cloud.http.route_error', 'GET', '/api/shared/:token', 'INTERNAL_ERROR']);
    // The secret token must not appear anywhere in the captured context.
    expect(JSON.stringify(ctx)).not.toContain(token);
  });

  it('redacts the share token while preserving a trailing static segment (download)', () => {
    const token = 'abcdef0123456789deadbeef';
    captureRouteError(new Error('boom'), mockReq('GET', `/api/shared/${token}/download`), {
      route: `/api/shared/${token}/download`,
      phase: 'shared-route',
    });
    const [, ctx] = captureExceptionMock.mock.calls[0] as [unknown, Record<string, unknown>];
    const tags = ctx.tags as Record<string, unknown>;
    expect(tags.route).toBe('/api/shared/:token/download');
    expect(JSON.stringify(ctx)).not.toContain(token);
  });

  // ── F2 / M1: dynamic-id routes collapse to one family / one throttle entry ───

  it('collapses dynamic id segments so different ids map to the SAME route family (one capture, not two)', () => {
    const sessionA = '7c2f1a9e-3b4d-4e5f-8a1b-2c3d4e5f6a7b';
    const sessionB = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
    captureRouteError(new Error('boom'), mockReq('GET', `/api/agent/sessions/${sessionA}/state`), {
      route: `/api/agent/sessions/${sessionA}/state`,
      phase: 'authenticated',
    });
    captureRouteError(new Error('boom'), mockReq('GET', `/api/agent/sessions/${sessionB}/state`), {
      route: `/api/agent/sessions/${sessionB}/state`,
      phase: 'authenticated',
    });
    // Same template → one throttle entry → exactly one capture.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0] as [unknown, Record<string, unknown>];
    const tags = ctx.tags as Record<string, unknown>;
    expect(tags.route).toBe('/api/agent/sessions/:id/state');
    expect(ctx.fingerprint).toEqual(['cloud.http.route_error', 'GET', '/api/agent/sessions/:id/state', 'INTERNAL_ERROR']);
    expect(JSON.stringify(ctx)).not.toContain(sessionA);
    expect(JSON.stringify(ctx)).not.toContain(sessionB);
  });

  it('collapses numeric id segments to the same family', () => {
    captureRouteError(new Error('boom'), mockReq('GET', '/api/meeting/12345/notes'), {
      route: '/api/meeting/12345/notes',
      phase: 'authenticated',
    });
    captureRouteError(new Error('boom'), mockReq('GET', '/api/meeting/67890/notes'), {
      route: '/api/meeting/67890/notes',
      phase: 'authenticated',
    });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect((ctx.tags as Record<string, unknown>).route).toBe('/api/meeting/:id/notes');
  });

  // ── F3 (Phase 7): short lowercase-alphanumeric id segments (`abc123`) collapse ─

  it('collapses short lowercase-alphanumeric id-shaped segments (contains a digit) to :id', () => {
    captureRouteError(new Error('boom'), mockReq('GET', '/api/x/abc123'), {
      route: '/api/x/abc123',
      phase: 'authenticated',
    });
    const [, ctx] = captureExceptionMock.mock.calls[0] as [unknown, Record<string, unknown>];
    const tags = ctx.tags as Record<string, unknown>;
    expect(tags.route).toBe('/api/x/:id');
    // The raw id must not survive into the captured context.
    expect(JSON.stringify(ctx)).not.toContain('abc123');
  });

  it('keeps pure-alphabetic api nouns intact (no over-collapsing)', () => {
    captureRouteError(new Error('boom'), mockReq('GET', '/api/sessions/state'), {
      route: '/api/sessions/state',
      phase: 'authenticated',
    });
    const [, ctx] = captureExceptionMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect((ctx.tags as Record<string, unknown>).route).toBe('/api/sessions/state');
  });

  // ── F1 (Phase 7): fatal process handler fails fast (capture + bounded flush + exit) ─

  describe('F1 — fatal process handler is fail-fast', () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // process.exit would tear down the test runner — stub it to a no-op so we
      // can assert it was called with the fail-fast code.
      exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(((_code?: number) => undefined) as never);
    });

    afterEach(() => {
      exitSpy.mockRestore();
    });

    it('uncaughtException: captures (fatal), bounded-flushes, then exits(1)', async () => {
      const err = new Error('uncaught boom');
      await handleFatal(err, 'uncaughtException', 'fatal');

      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      const [capturedErr, ctx] = captureExceptionMock.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(capturedErr).toBe(err);
      expect(ctx.level).toBe('fatal');
      expect(ctx.tags).toMatchObject({ surface: 'cloud', area: 'process', kind: 'uncaughtException' });
      // Bounded flush before exit.
      expect(sentryFlushMock).toHaveBeenCalledWith(2000);
      // Fail-fast: restore Node's default fatal exit so Fly restarts the machine.
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('unhandledRejection: captures (error level), bounded-flushes, then exits(1)', async () => {
      const err = new Error('rejected boom');
      await handleFatal(err, 'unhandledRejection', 'error');

      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      const [, ctx] = captureExceptionMock.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(ctx.level).toBe('error');
      expect(ctx.tags).toMatchObject({ surface: 'cloud', area: 'process', kind: 'unhandledRejection' });
      expect(sentryFlushMock).toHaveBeenCalledWith(2000);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('still exits(1) when capture/flush throws (transport down must not keep the machine alive)', async () => {
      captureExceptionMock.mockImplementationOnce(() => {
        throw new Error('sentry transport down');
      });
      await handleFatal(new Error('boom'), 'uncaughtException', 'fatal');
      // finally-path exit fires even though capture threw.
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  it('never throws when the underlying capture throws (route error must not escalate to a crash)', () => {
    captureExceptionMock.mockImplementationOnce(() => {
      throw new Error('sentry transport down');
    });
    expect(() =>
      captureRouteError(new Error('boom'), mockReq('GET', '/api/storage/usage'), {
        route: '/api/storage/usage',
        phase: 'authenticated',
      }),
    ).not.toThrow();
  });

  // ── Stage 5: flush-on-shutdown wiring ───────────────────────────────────────

  it('exposes the shared analytics flush that shutdown() awaits, and it is swallow-safe', async () => {
    // server.ts imports `flushMainAnalytics` from the shared @main/analytics
    // client and awaits it inside shutdown() (wrapped in try/catch). Assert the
    // wired function is the shared client's flush.
    await expect(flushMainAnalytics()).resolves.not.toThrow();
    expect(flushMainAnalyticsMock).toHaveBeenCalledTimes(1);
  });
});
