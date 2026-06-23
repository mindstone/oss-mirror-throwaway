/**
 * Regression tests for the parallel-tool-result drop on the codex-proxy
 * passthrough path.
 *
 * Diagnosis: docs-private/investigations/260509_parallel_use_tool_result_dropped_codex_proxy.md
 *
 * The original bug had three layered failure modes:
 *
 * 1. Tier 1 — Undici default `bodyTimeout: 300_000` silently severed the
 *    SSE response stream of the second parallel `use_tool` POST when it
 *    sat queued behind another stdio call for >5 min. Fix: module-scope
 *    Undici dispatcher with `bodyTimeout: 0` wired into the
 *    `StreamableHTTPClientTransport` via a `fetch:` wrapper (not
 *    `requestInit.dispatcher`, which the SDK only spreads into POST and
 *    DELETE inits — the GET SSE path uses raw fetch with no spread).
 *
 * 2. Tier 2 — `mcpClient.executeTool(..., _signal)` accepted an
 *    `AbortSignal` but did not forward it to `client.callTool`, so
 *    watchdog cancellation could not reject in-flight MCP calls via the
 *    SDK's per-request signal path. Fix: `callToolWithOptions` helper
 *    threads `signal` into both the initial and the retry call sites.
 *
 * 3. Tier 3 — When the SSE stream was severed pre-response, the SDK's
 *    `Protocol._onerror` only NOTIFIED — pending request promises stayed
 *    forever in `_responseHandlers`. Fix: `client.onerror` handler that
 *    calls `client.close()` so `_onclose` rejects every pending entry
 *    with a `ConnectionClosed` McpError.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockConnect,
  mockListTools,
  mockCallTool,
  mockClose,
  mockTerminateSession,
  transportConstructorSpy,
  capturedClients,
  warnLog,
  infoLog,
  errorLog,
  debugLog,
  undiciAgentOptions,
} = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  mockListTools: vi.fn(),
  mockCallTool: vi.fn(),
  mockClose: vi.fn(),
  mockTerminateSession: vi.fn(),
  transportConstructorSpy: vi.fn(),
  capturedClients: [] as Array<{ onerror?: (error: Error) => void }>,
  warnLog: vi.fn(),
  infoLog: vi.fn(),
  errorLog: vi.fn(),
  debugLog: vi.fn(),
  undiciAgentOptions: [] as unknown[],
}));

 
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mockConnect;
    listTools = mockListTools;
    callTool = mockCallTool;
    close = mockClose;
    onerror?: (error: Error) => void;
    constructor() {
      capturedClients.push(this);
    }
  },
}));

 
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    terminateSession = mockTerminateSession;
    public requestInit?: { dispatcher?: unknown };
    public fetch?: typeof fetch;
    constructor(url: URL, opts?: { requestInit?: { dispatcher?: unknown }; fetch?: typeof fetch }) {
      this.requestInit = opts?.requestInit;
      this.fetch = opts?.fetch;
      transportConstructorSpy(url, opts);
    }
  },
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: infoLog,
    warn: warnLog,
    error: errorLog,
    debug: debugLog,
  }),
}));

vi.mock('undici', () => {
  class FakeUndiciAgent {
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
      undiciAgentOptions.push(options);
    }
    dispatch() {
      return true;
    }
    close() {
      return Promise.resolve();
    }
  }
  return { Agent: FakeUndiciAgent };
});

import { createMcpSession } from '../mcpClient';

const ORIGINAL_ENV = { ...process.env };

async function createSession() {
  const session = await createMcpSession('http://127.0.0.1:3100/mcp');
  expect(session).not.toBeNull();
  return session!;
}

describe('mcpClient transport hardening (260509 parallel use_tool drop)', () => {
  beforeEach(() => {
    mockConnect.mockReset();
    mockListTools.mockReset();
    mockCallTool.mockReset();
    mockClose.mockReset();
    mockTerminateSession.mockReset();
    transportConstructorSpy.mockReset();
    capturedClients.length = 0;
    undiciAgentOptions.length = 0;
    warnLog.mockReset();
    infoLog.mockReset();
    errorLog.mockReset();
    debugLog.mockReset();

    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockTerminateSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    capturedClients.length = 0;
    process.env = { ...ORIGINAL_ENV };
  });

  describe('Tier 1 — Undici dispatcher wiring', () => {
    async function importFreshMcpClientWithEnv(env: Record<string, string | undefined>) {
      vi.resetModules();
      process.env = { ...ORIGINAL_ENV };
      delete process.env.REBEL_HTTP_RESOLVER;
      delete process.env.REBEL_DNS_DECOUPLE;
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      undiciAgentOptions.length = 0;
      return import('../mcpClient');
    }

    it('passes a fetch wrapper (NOT requestInit.dispatcher) into StreamableHTTPClientTransport', async () => {
      const session = await createSession();

      expect(transportConstructorSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = transportConstructorSpy.mock.calls[0];

      expect(url).toBeInstanceOf(URL);
      expect((url as URL).toString()).toBe('http://127.0.0.1:3100/mcp');

      // The fix shape requires a `fetch:` wrapper because the SDK only
      // spreads `requestInit` into POST/DELETE — the GET SSE path uses
      // raw fetch with NO requestInit spread. Going via `fetch:` is the
      // only way to inject the dispatcher into all three paths.
      const optsTyped = opts as {
        fetch?: typeof fetch;
        requestInit?: { dispatcher?: unknown };
      };
      expect(typeof optsTyped.fetch).toBe('function');
      // requestInit is no longer used for dispatcher wiring.
      expect(optsTyped.requestInit?.dispatcher).toBeUndefined();

      await session.close();
    });

    it('fetch wrapper injects the module-scope Undici dispatcher into the underlying fetch init', async () => {
      // Spy on the global `fetch` so we can assert what the wrapper passes
      // through to it. The wrapper itself is a plain function value captured
      // by the transport constructor — we invoke it directly to inspect its
      // composed init blob.
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 200 }));

      try {
        const session = await createSession();
        const [, opts] = transportConstructorSpy.mock.calls[0];
        const wrapped = (opts as { fetch?: typeof fetch }).fetch;
        expect(typeof wrapped).toBe('function');

        await wrapped!('http://127.0.0.1:3100/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [, init] = fetchSpy.mock.calls[0];
        const initTyped = init as RequestInit & { dispatcher?: unknown };
        expect(initTyped.method).toBe('POST');
        expect(initTyped.dispatcher).toBeDefined();
        // Undici Agent instance — duck-typed: it implements `dispatch`/`close`.
        expect(typeof (initTyped.dispatcher as { dispatch?: unknown }).dispatch).toBe('function');

        await session.close();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('fetch wrapper applies the dispatcher to GET requests too (not just POST)', async () => {
      // Regression for Phase 7 iter 2: the previous shape used
      // `requestInit.dispatcher`, which the SDK only spreads into POST and
      // DELETE inits. The GET SSE path called raw fetch with NO requestInit
      // spread, so its idle stream still inherited Undici's default 300s
      // bodyTimeout. The wrapper MUST apply the dispatcher on every method.
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 200 }));

      try {
        const session = await createSession();
        const [, opts] = transportConstructorSpy.mock.calls[0];
        const wrapped = (opts as { fetch?: typeof fetch }).fetch;

        await wrapped!('http://127.0.0.1:3100/mcp', { method: 'POST' });
        await wrapped!('http://127.0.0.1:3100/mcp', { method: 'GET' });
        await wrapped!('http://127.0.0.1:3100/mcp', { method: 'DELETE' });

        expect(fetchSpy).toHaveBeenCalledTimes(3);
        for (const [, init] of fetchSpy.mock.calls) {
          const initTyped = init as RequestInit & { dispatcher?: unknown };
          expect(initTyped.dispatcher).toBeDefined();
          expect(typeof (initTyped.dispatcher as { dispatch?: unknown }).dispatch).toBe('function');
        }

        await session.close();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('uses OS-resolver dispatcher options by default and keeps autoSelectFamily', async () => {
      await importFreshMcpClientWithEnv({});

      expect(undiciAgentOptions).toHaveLength(1);
      const options = undiciAgentOptions[0] as { connect?: { lookup?: unknown; autoSelectFamily?: unknown } };
      expect(options.connect?.lookup).toBeUndefined();
      expect(options.connect?.autoSelectFamily).toBe(true);
    });

    it('adds the c-ares lookup to the MCP dispatcher only when opted in', async () => {
      await importFreshMcpClientWithEnv({ REBEL_HTTP_RESOLVER: 'cares' });

      expect(undiciAgentOptions).toHaveLength(1);
      const options = undiciAgentOptions[0] as { connect?: { lookup?: unknown; autoSelectFamily?: unknown } };
      expect(typeof options.connect?.lookup).toBe('function');
      expect(options.connect?.autoSelectFamily).toBe(true);
    });

    it('reuses the same dispatcher singleton across sessions (connection pool reuse)', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 200 }));

      try {
        const session1 = await createSession();
        const session2 = await createSession();

        const [, opts1] = transportConstructorSpy.mock.calls[0];
        const [, opts2] = transportConstructorSpy.mock.calls[1];

        const wrapped1 = (opts1 as { fetch?: typeof fetch }).fetch!;
        const wrapped2 = (opts2 as { fetch?: typeof fetch }).fetch!;

        await wrapped1('http://127.0.0.1:3100/mcp', { method: 'GET' });
        await wrapped2('http://127.0.0.1:3100/mcp', { method: 'GET' });

        const d1 = (fetchSpy.mock.calls[0][1] as { dispatcher?: unknown }).dispatcher;
        const d2 = (fetchSpy.mock.calls[1][1] as { dispatcher?: unknown }).dispatcher;

        expect(d1).toBeDefined();
        expect(d1).toBe(d2);

        await session1.close();
        await session2.close();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('two parallel callTool invocations both resolve when the second response is delayed', async () => {
      const session = await createSession();

      // Simulate: first call resolves immediately, second is delayed (mimicking
      // super-mcp's PQueue serialization). With the production dispatcher
      // (`bodyTimeout: 0`), the slow response does NOT silently sever.
      let resolveFirst!: (v: unknown) => void;
      let resolveSecond!: (v: unknown) => void;
      const firstPending = new Promise(r => { resolveFirst = r; });
      const secondPending = new Promise(r => { resolveSecond = r; });

      mockCallTool
        .mockReturnValueOnce(firstPending)
        .mockReturnValueOnce(secondPending);

      const both = Promise.all([
        session.executeTool('use_tool', { package_id: 'p', tool_id: 't1' }, 'tu-1'),
        session.executeTool('use_tool', { package_id: 'p', tool_id: 't2' }, 'tu-2'),
      ]);

      // Allow first to resolve immediately; defer second by ~250ms
      resolveFirst({ content: [{ type: 'text', text: 'first' }], isError: false });
      setTimeout(
        () => resolveSecond({ content: [{ type: 'text', text: 'second' }], isError: false }),
        250,
      );

      const [r1, r2] = await both;
      expect(r1.isError).toBe(false);
      expect(r1.output).toBe('first');
      expect(r2.isError).toBe(false);
      expect(r2.output).toBe('second');

      await session.close();
    });
  });

  describe('Tier 2 — Signal threading on initial + retry call sites', () => {
    it('forwards the externally-supplied AbortSignal into client.callTool on the initial call', async () => {
      const session = await createSession();
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      });

      const ac = new AbortController();
      await session.executeTool('use_tool', { package_id: 'p', tool_id: 't' }, 'tu-1', ac.signal);

      expect(mockCallTool).toHaveBeenCalledTimes(1);
      const opts = mockCallTool.mock.calls[0][2] as { signal?: AbortSignal; timeout?: number };
      expect(opts.signal).toBe(ac.signal);
      expect(typeof opts.timeout).toBe('number');

      await session.close();
    });

    it('forwards the AbortSignal into client.callTool on the retry call site after session-not-found reconnect', async () => {
      const sessionNotFound = new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"Session not found"}');
      (sessionNotFound as Error & { code: number }).code = 404;

      const session = await createSession();

      // Initial call: session-not-found → triggers reconnect.
      mockCallTool.mockRejectedValueOnce(sessionNotFound);
      // Retry call: success.
      mockCallTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'after-retry' }], isError: false });

      const ac = new AbortController();
      // list_tools is in the read-only meta-tool allowlist — so the retry path
      // is exercised even without connector annotations.
      const result = await session.executeTool('list_tools', {}, 'tu-1', ac.signal);

      expect(result.isError).toBe(false);
      expect(mockCallTool).toHaveBeenCalledTimes(2);

      const initialOpts = mockCallTool.mock.calls[0][2] as { signal?: AbortSignal };
      const retryOpts = mockCallTool.mock.calls[1][2] as { signal?: AbortSignal };
      expect(initialOpts.signal).toBe(ac.signal);
      expect(retryOpts.signal).toBe(ac.signal);

      await session.close();
    });

    it('omits signal field when no external signal is provided (no synthetic always-live signal)', async () => {
      const session = await createSession();
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      });

      await session.executeTool('list_tools', {});

      const opts = mockCallTool.mock.calls[0][2] as { signal?: AbortSignal };
      expect(opts.signal).toBeUndefined();

      await session.close();
    });
  });

  describe('Tier 3 — Fail-closed pre-response stream termination', () => {
    it('installs a client.onerror handler at connect time', async () => {
      const session = await createSession();

      expect(capturedClients.length).toBeGreaterThan(0);
      const c = capturedClients[capturedClients.length - 1];
      expect(typeof c.onerror).toBe('function');

      await session.close();
    });

    it('closes the client only on SSE stream severance errors with the exact prefix', async () => {
      const session = await createSession();

      const c = capturedClients[capturedClients.length - 1];
      expect(typeof c.onerror).toBe('function');

      // Simulate the SDK's `_handleSseStream` outer catch (streamableHttp.js:237)
      // which emits `new Error('SSE stream disconnected: ${error}')`.
      // Our narrowed handler must close on this exact prefix so `_onclose`
      // rejects every pending entry in `_responseHandlers`.
      c.onerror?.(new Error('SSE stream disconnected: BodyTimeoutError'));

      // Allow microtasks to drain.
      await Promise.resolve();
      await Promise.resolve();

      expect(mockClose).toHaveBeenCalled();
      expect(warnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          err: 'SSE stream disconnected: BodyTimeoutError',
          errName: 'Error',
          url: 'http://127.0.0.1:3100/mcp',
        }),
        'MCP client transport error',
      );
      expect(warnLog).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'http://127.0.0.1:3100/mcp' }),
        'Forcing client.close() on fatal pre-response SSE severance',
      );

      await session.close();
    });

    it('does NOT close the client on session-not-found / non-SSE-stream errors', async () => {
      const session = await createSession();

      const c = capturedClients[capturedClients.length - 1];
      expect(typeof c.onerror).toBe('function');

      // POST send() failures fire onerror BEFORE rethrowing — closing here
      // would race the existing `isSessionNotFoundError` → `ensureReconnected`
      // single-flight reconnect path that the next callTool will trigger.
      c.onerror?.(
        new Error(
          'Streamable HTTP error: Error POSTing to endpoint: {"error":"Session not found"}',
        ),
      );
      // Standalone GET SSE failures (no 'SSE stream disconnected' prefix).
      c.onerror?.(new TypeError('fetch failed'));
      // SDK's reconnection-attempt error path on the GET stream.
      c.onerror?.(new Error('Maximum reconnection attempts (5) exceeded.'));

      await Promise.resolve();
      await Promise.resolve();

      expect(mockClose).not.toHaveBeenCalled();
      expect(warnLog).not.toHaveBeenCalledWith(
        expect.anything(),
        'Forcing client.close() on fatal pre-response SSE severance',
      );

      await session.close();
    });

    it('client.close() failures inside onerror do not throw out of the handler', async () => {
      mockClose.mockRejectedValue(new Error('close failed'));

      const session = await createSession();
      const c = capturedClients[capturedClients.length - 1];

      // Use the fatal-pre-response prefix so the close path is exercised.
      expect(() =>
        c.onerror?.(new Error('SSE stream disconnected: socket hang up')),
      ).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();

      // The handler swallows close() failures (best-effort).
      expect(mockClose).toHaveBeenCalled();

      // Reset to a successful close so teardown succeeds.
      mockClose.mockReset();
      mockClose.mockResolvedValue(undefined);
      await session.close();
    });

    it('logs errName safely for non-Error onerror payloads (and does not close)', async () => {
      const session = await createSession();
      const c = capturedClients[capturedClients.length - 1];

      // Verifies the `error.constructor?.name` safe-access path: a non-Error
      // value should log `errName: typeof error` and NOT match the prefix.
      c.onerror?.('plain string error' as unknown as Error);

      await Promise.resolve();
      await Promise.resolve();

      expect(mockClose).not.toHaveBeenCalled();
      expect(warnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          err: 'plain string error',
          errName: 'string',
          url: 'http://127.0.0.1:3100/mcp',
        }),
        'MCP client transport error',
      );

      await session.close();
    });
  });
});
