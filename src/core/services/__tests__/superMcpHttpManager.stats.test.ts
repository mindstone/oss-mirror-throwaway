/**
 * Tests for `SuperMcpHttpManager.fetchStats()` + `getLastStatsCache()` —
 * Stage 4b of `docs/plans/260423_secondary_process_cpu_observability.md`.
 *
 * Exercises the status-mapping matrix:
 *   - 200 OK      → `status: 'ok'`, `payload` populated.
 *   - 404         → `status: 'unsupported'`.
 *   - 500         → `status: 'error'`, `httpStatus: 500`.
 *   - AbortError  → `status: 'timeout'`.
 *   - not-running → fetch NOT called; cache untouched.
 *   - circuit-breaker active → fetch NOT called; cache untouched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks (must precede manager import) ───────────────────────

 
vi.mock('@core/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

 
vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    captureException: vi.fn(),
  }),
}));

 
vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-data',
  isPackaged: () => false,
  getAppRoot: () => '/tmp/test-app',
}));

 
vi.mock('@core/utils/buildChannel', () => ({
  getBuildChannel: () => 'dev',
}));

 
vi.mock('@core/services/settingsStore', () => ({
  getSettings: () => ({ coreDirectory: '/tmp/test-core' }),
}));

 
vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getActiveTurnCount: () => 0,
    onDrained: vi.fn(),
  },
}));

import { SuperMcpHttpManager, type SuperMcpStatsSnapshot } from '../superMcpHttpManager';

// ── Helpers ──────────────────────────────────────────────────────────

function createConfiguredManager(port = 3200): SuperMcpHttpManager {
  const manager = new SuperMcpHttpManager();
  manager.configure({
    enabled: true,
    port,
    configPath: '/tmp/test-config.json',
    startupTimeoutMs: 5000,
    healthCheckIntervalMs: 200,
  });
  return manager;
}

/**
 * Drive the manager's private state directly. `fetchStats()` only reads
 * `state.isRunning` / `state.port` / `lastStartupFailureAt` — no need to
 * actually spawn a process.
 */
function markRunning(m: SuperMcpHttpManager, port = 3200): void {
  const p = m as unknown as {
    state: { isRunning: boolean; port: number };
  };
  p.state.isRunning = true;
  p.state.port = port;
}

function markCircuitBreakerActive(m: SuperMcpHttpManager, whenMs = Date.now()): void {
  const p = m as unknown as { lastStartupFailureAt: number | null };
  p.lastStartupFailureAt = whenMs;
}

function makeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('SuperMcpHttpManager.fetchStats()', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy on the global `fetch` — ReActed afresh per test.
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('200 OK → status "ok" with payload populated and recent `at`', async () => {
    const manager = createConfiguredManager();
    markRunning(manager);

    const samplePayload = {
      router: { running: true, pid: 4242, uptime_ms: 1_234, started_at: 'iso' },
      children: [{ package_id: 'alpha', pid: 9999, connected: true }],
      generated_at: 'iso',
    };
    fetchSpy.mockResolvedValue(makeJsonResponse(200, samplePayload));

    const before = Date.now();
    await manager.fetchStats();
    const after = Date.now();

    const cache = manager.getLastStatsCache();
    expect(cache).not.toBeNull();
    expect(cache?.status).toBe('ok');
    expect(cache?.payload).toEqual(samplePayload);
    expect(cache?.httpStatus).toBeUndefined();
    expect(cache?.lastErr).toBeUndefined();
    expect(cache?.at).toBeGreaterThanOrEqual(before);
    expect(cache?.at).toBeLessThanOrEqual(after);

    expect(manager.getLastStatsFetchAt()).not.toBeNull();

    // Fetched the expected URL.
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('http://127.0.0.1:3200/stats'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('404 → status "unsupported" (older bundled super-mcp)', async () => {
    const manager = createConfiguredManager();
    markRunning(manager);
    fetchSpy.mockResolvedValue(new Response('not found', { status: 404 }));

    await manager.fetchStats();

    const cache = manager.getLastStatsCache();
    expect(cache?.status).toBe('unsupported');
    expect(cache?.httpStatus).toBeUndefined();
    expect(cache?.payload).toBeUndefined();
  });

  it('500 → status "error" with httpStatus populated', async () => {
    const manager = createConfiguredManager();
    markRunning(manager);
    fetchSpy.mockResolvedValue(new Response('oops', { status: 500 }));

    await manager.fetchStats();

    const cache = manager.getLastStatsCache();
    expect(cache?.status).toBe('error');
    expect(cache?.httpStatus).toBe(500);
    expect(cache?.payload).toBeUndefined();
  });

  it('AbortError (timeout) → status "timeout" with lastErr populated', async () => {
    const manager = createConfiguredManager();
    markRunning(manager);

    // Simulate what fetch() throws when the timeout AbortController fires.
    fetchSpy.mockImplementation(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    await manager.fetchStats();

    const cache = manager.getLastStatsCache();
    expect(cache?.status).toBe('timeout');
    expect(cache?.lastErr).toBe('The operation was aborted');
  });

  it('generic network error → status "error" with lastErr populated', async () => {
    const manager = createConfiguredManager();
    markRunning(manager);

    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:3200'));

    await manager.fetchStats();

    const cache = manager.getLastStatsCache();
    expect(cache?.status).toBe('error');
    expect(cache?.lastErr).toContain('ECONNREFUSED');
    expect(cache?.httpStatus).toBeUndefined();
  });

  it('not-running manager → fetch not called; cache unchanged', async () => {
    const manager = createConfiguredManager();
    // Deliberately do NOT call markRunning — state.isRunning stays false.

    // Seed a known "previous" snapshot so we can prove it wasn't overwritten.
    const previous: SuperMcpStatsSnapshot = {
      status: 'ok',
      at: 1_000,
      payload: { router: { running: true } },
    };
    (manager as unknown as { lastStatsCache: SuperMcpStatsSnapshot | null }).lastStatsCache =
      previous;

    await manager.fetchStats();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(manager.getLastStatsCache()).toBe(previous);
    // lastStatsFetchAt stays null because no fetch ran.
    expect(manager.getLastStatsFetchAt()).toBeNull();
  });

  it('circuit-breaker active → fetch not called; cache unchanged', async () => {
    const manager = createConfiguredManager();
    markRunning(manager);
    markCircuitBreakerActive(manager);

    const previous: SuperMcpStatsSnapshot = { status: 'ok', at: 1_000, payload: {} };
    (manager as unknown as { lastStatsCache: SuperMcpStatsSnapshot | null }).lastStatsCache =
      previous;

    await manager.fetchStats();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(manager.getLastStatsCache()).toBe(previous);
  });

  it('expired circuit-breaker (failure >120s old) → fetch IS called', async () => {
    const manager = createConfiguredManager();
    markRunning(manager);
    // Failure 121s ago — breaker cooldown expired.
    markCircuitBreakerActive(manager, Date.now() - 121_000);
    fetchSpy.mockResolvedValue(makeJsonResponse(200, {}));

    await manager.fetchStats();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const cache = manager.getLastStatsCache();
    expect(cache?.status).toBe('ok');
  });

  it('fetchStats() never rejects (fail-observable contract)', async () => {
    const manager = createConfiguredManager();
    markRunning(manager);
    fetchSpy.mockRejectedValue(new Error('kaboom'));

    // If this throws, the test fails — no need for try/catch.
    await expect(manager.fetchStats()).resolves.toBeUndefined();
  });
});

describe('SuperMcpHttpManager.getLastStatsCache() — initial state', () => {
  it('returns null before any fetchStats() invocation', () => {
    const manager = createConfiguredManager();
    expect(manager.getLastStatsCache()).toBeNull();
    expect(manager.getLastStatsFetchAt()).toBeNull();
    expect(manager.getLastGoodStatsAt()).toBeNull();
  });
});

// ── M1: cache invalidation on subprocess exit ────────────────────────

describe('SuperMcpHttpManager cache invalidation on subprocess exit (Stage 4b M1)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('clears lastStatsCache / lastStatsFetchAt / lastGoodStatsAt when `exited` fires', async () => {
    const manager = createConfiguredManager();
    markRunning(manager);
    fetchSpy.mockImplementation(() =>
      Promise.resolve(makeJsonResponse(200, { router: {}, children: [] })),
    );

    // Prime the cache with an `ok` snapshot.
    await manager.fetchStats();
    expect(manager.getLastStatsCache()?.status).toBe('ok');
    expect(manager.getLastStatsFetchAt()).not.toBeNull();
    expect(manager.getLastGoodStatsAt()).not.toBeNull();

    // Simulate the subprocess exit path that emits `exited` — we hit the
    // internal `invalidateStatsCache()` method directly because wiring an
    // actual ChildProcess-dispatched emit requires a fake spawn.
    (manager as unknown as { invalidateStatsCache(): void }).invalidateStatsCache();

    expect(manager.getLastStatsCache()).toBeNull();
    expect(manager.getLastStatsFetchAt()).toBeNull();
    expect(manager.getLastGoodStatsAt()).toBeNull();
  });

  it('subsequent fetchStats() after invalidation repopulates cache from scratch (no residue)', async () => {
    const manager = createConfiguredManager();
    markRunning(manager);
    // Each call gets a fresh Response — body is consumable once.
    fetchSpy.mockImplementation(() =>
      Promise.resolve(makeJsonResponse(200, { router: {}, children: [] })),
    );

    await manager.fetchStats();
    const firstGoodAt = manager.getLastGoodStatsAt();
    expect(firstGoodAt).not.toBeNull();

    (manager as unknown as { invalidateStatsCache(): void }).invalidateStatsCache();
    expect(manager.getLastGoodStatsAt()).toBeNull();

    // Small wall-clock gap so the second ok's timestamp is strictly later.
    await new Promise((r) => setTimeout(r, 5));

    // New fetch after simulated restart — fresh snapshot.
    markRunning(manager);
    await manager.fetchStats();
    const secondGoodAt = manager.getLastGoodStatsAt();
    expect(secondGoodAt).not.toBeNull();
    expect(secondGoodAt!).toBeGreaterThanOrEqual(firstGoodAt!);
  });
});

// ── M4: status-transition logging (fail-observable contract) ─────────

describe('SuperMcpHttpManager.fetchStats() — status-transition logging (Stage 4b M4)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let loggerMock: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    trace: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const loggerModule = await import('@core/logger');
    // The mocked logger is a plain object shared across the test file.
    loggerMock = loggerModule.logger as unknown as typeof loggerMock;
    loggerMock.info.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  /** Filter warn calls to the status-degradation family only (bounded per plan). */
  const statusDegradeWarns = () =>
    loggerMock.warn.mock.calls.filter(
      ([, msg]) =>
        msg === 'super-mcp /stats: status degraded' ||
        msg === 'super-mcp /stats: degraded status changed',
    );

  /** Filter info calls to the recovery family only. */
  const statusRecoverInfos = () =>
    loggerMock.info.mock.calls.filter(
      ([, msg]) => msg === 'super-mcp /stats: status recovered',
    );

  it('ok → ok: no log (steady-state is silent)', async () => {
    const manager = createConfiguredManager();
    markRunning(manager);
    // Must return fresh `Response` objects — the body is consumable once.
    fetchSpy.mockImplementation(() => Promise.resolve(makeJsonResponse(200, {})));

    await manager.fetchStats();
    await manager.fetchStats();

    expect(statusDegradeWarns()).toHaveLength(0);
    expect(statusRecoverInfos()).toHaveLength(0);
  });

  it('ok → timeout → ok: exactly one warn (degrade) and one info (recover)', async () => {
    const manager = createConfiguredManager();
    markRunning(manager);

    // Tick 1: ok (fresh Response per call).
    fetchSpy.mockImplementationOnce(() => Promise.resolve(makeJsonResponse(200, {})));
    await manager.fetchStats();

    // Tick 2: timeout (AbortError).
    fetchSpy.mockImplementationOnce(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    await manager.fetchStats();

    // Tick 3: ok — fresh Response.
    fetchSpy.mockImplementationOnce(() => Promise.resolve(makeJsonResponse(200, {})));
    await manager.fetchStats();

    expect(statusDegradeWarns()).toHaveLength(1);
    expect(statusRecoverInfos()).toHaveLength(1);
    expect(statusDegradeWarns()[0][1]).toBe('super-mcp /stats: status degraded');
    expect(statusRecoverInfos()[0][1]).toBe('super-mcp /stats: status recovered');
  });

  it('null → unsupported: exactly one info (version-skew breadcrumb)', async () => {
    const manager = createConfiguredManager();
    markRunning(manager);
    fetchSpy.mockImplementation(() => Promise.resolve(new Response('not found', { status: 404 })));

    await manager.fetchStats();

    const versionSkewInfos = loggerMock.info.mock.calls.filter(
      ([, msg]) => msg === 'super-mcp /stats: endpoint not available (version skew)',
    );
    expect(versionSkewInfos).toHaveLength(1);
  });

  it('null → ok: no log (normal startup is silent)', async () => {
    const manager = createConfiguredManager();
    markRunning(manager);
    fetchSpy.mockImplementation(() => Promise.resolve(makeJsonResponse(200, {})));

    await manager.fetchStats();

    expect(statusDegradeWarns()).toHaveLength(0);
    expect(statusRecoverInfos()).toHaveLength(0);
    // No version-skew message either.
    const versionSkewInfos = loggerMock.info.mock.calls.filter(
      ([, msg]) => msg === 'super-mcp /stats: endpoint not available (version skew)',
    );
    expect(versionSkewInfos).toHaveLength(0);
  });
});

// ── M5: lastGoodStatsAt persistence across failures ─────────────────

describe('SuperMcpHttpManager.getLastGoodStatsAt() (Stage 4b M5)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('preserves the ok timestamp through a subsequent timeout (stale-detection signal)', async () => {
    const manager = createConfiguredManager();
    markRunning(manager);

    // Ok tick → lastGoodStatsAt populated.
    fetchSpy.mockImplementationOnce(() => Promise.resolve(makeJsonResponse(200, {})));
    await manager.fetchStats();
    const goodAtAfterOk = manager.getLastGoodStatsAt();
    expect(goodAtAfterOk).not.toBeNull();

    // Small wall-clock gap so the timeout-tick's fetchAt is strictly later.
    await new Promise((r) => setTimeout(r, 5));

    // Timeout tick → lastGoodStatsAt MUST stay at the ok timestamp.
    fetchSpy.mockImplementationOnce(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    await manager.fetchStats();
    expect(manager.getLastGoodStatsAt()).toBe(goodAtAfterOk);

    // fetchAt advanced because a tick completed (success OR failure).
    const fetchAtAfterTimeout = manager.getLastStatsFetchAt();
    expect(fetchAtAfterTimeout).not.toBeNull();
    expect(fetchAtAfterTimeout!).toBeGreaterThanOrEqual(goodAtAfterOk!);
  });

  it('refreshes lastGoodStatsAt on a subsequent ok (tracks most-recent success)', async () => {
    const manager = createConfiguredManager();
    markRunning(manager);

    fetchSpy.mockImplementationOnce(() => Promise.resolve(makeJsonResponse(200, {})));
    await manager.fetchStats();
    const firstGood = manager.getLastGoodStatsAt();

    // Small wall-clock gap to guarantee Date.now() advances.
    await new Promise((r) => setTimeout(r, 5));

    fetchSpy.mockImplementationOnce(() => Promise.resolve(makeJsonResponse(200, {})));
    await manager.fetchStats();
    const secondGood = manager.getLastGoodStatsAt();

    expect(secondGood).not.toBeNull();
    expect(secondGood!).toBeGreaterThanOrEqual(firstGood!);
  });
});

// ── iter-2 safety: in-flight fetch race with invalidateStatsCache() ──

describe('SuperMcpHttpManager.fetchStats() — in-flight race with invalidation (Stage 4b iter-2)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('in-flight fetch that resolves AFTER invalidateStatsCache() is discarded (no stale-data leak)', async () => {
    const manager = createConfiguredManager();
    markRunning(manager);

    // Capture the resolver so we can hold the fetch in flight past the
    // invalidation point.
    let resolveFetch!: (r: Response) => void;
    const pendingResp = new Promise<Response>((r) => {
      resolveFetch = r;
    });
    fetchSpy.mockImplementationOnce(() => pendingResp);

    const fetchPromise = manager.fetchStats();

    // Simulate subprocess exit mid-flight.
    (manager as unknown as { invalidateStatsCache(): void }).invalidateStatsCache();
    expect(manager.getLastStatsCache()).toBeNull();
    expect(manager.getLastStatsFetchAt()).toBeNull();

    // Now let the in-flight fetch complete with a fresh ok payload that
    // belongs to the DEAD process's lifetime.
    resolveFetch(makeJsonResponse(200, { router: {}, children: [{ package_id: 'stale' }] }));
    await fetchPromise;

    // The race guard must have refused to write the stale result — cache
    // stays null, no "dead-process" payload leaks.
    expect(manager.getLastStatsCache()).toBeNull();
    expect(manager.getLastStatsFetchAt()).toBeNull();
    expect(manager.getLastGoodStatsAt()).toBeNull();
  });

  it('fresh fetch AFTER invalidation populates cache normally (generation check is per-call)', async () => {
    const manager = createConfiguredManager();
    markRunning(manager);

    (manager as unknown as { invalidateStatsCache(): void }).invalidateStatsCache();

    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(makeJsonResponse(200, { router: {}, children: [] })),
    );
    await manager.fetchStats();

    expect(manager.getLastStatsCache()?.status).toBe('ok');
    expect(manager.getLastStatsFetchAt()).not.toBeNull();
    expect(manager.getLastGoodStatsAt()).not.toBeNull();
  });
});
