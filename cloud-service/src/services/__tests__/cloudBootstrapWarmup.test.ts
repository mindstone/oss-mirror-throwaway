import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCloudBootstrapWarmupServiceForTests } from '../cloudBootstrapWarmup';

type WarmupHarnessOptions = {
  isEagerOverrideEnabled?: () => boolean;
  idleTriggerMs?: number;
  watchdogDelayMs?: number;
  fetchImpl?: typeof fetch;
  loadToolIndexService?: () => Promise<{
    initializeToolIndex: () => Promise<void>;
    refreshToolIndex: () => Promise<{
      success: boolean;
      added: number;
      updated: number;
      removed: number;
      total: number;
    }>;
    refreshToolIndexFromCatalogData?: (
      catalogData: unknown,
      options?: {
        packageHashes?: ReadonlyMap<string, string>;
        updateAliasesFromCatalog?: boolean;
        etag?: string;
      },
    ) => Promise<{
      success: boolean;
      added: number;
      updated: number;
      removed: number;
      total: number;
    }>;
  }>;
};

function createHarness(options: WarmupHarnessOptions = {}) {
  const addBreadcrumb = vi.fn();
  const captureException = vi.fn();
  const captureMessage = vi.fn();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const initializeToolIndex = vi.fn(async () => undefined);
  const refreshToolIndex = vi.fn(async () => ({
    success: true,
    added: 3,
    updated: 0,
    removed: 0,
    total: 3,
  }));
  const refreshToolIndexFromCatalogData = vi.fn(async () => ({
    success: true,
    added: 3,
    updated: 0,
    removed: 0,
    total: 3,
  }));

  const fetchImpl = options.fetchImpl ?? vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      tools: [
        {
          package_id: 'pkg.test',
          package_name: 'Pkg Test',
          tool_id: 'pkg__tool',
          name: 'Pkg Tool',
          description: 'desc',
        },
      ],
      package_hashes: { 'pkg.test': 'hash-1' },
      etag: 'etag-1',
    }),
  }) as unknown as Response);

  const loadToolIndexService = options.loadToolIndexService ?? vi.fn(async () => ({
    initializeToolIndex,
    refreshToolIndex,
    refreshToolIndexFromCatalogData,
  }));

  const scheduler = {
    registerTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clear: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    now: () => Date.now(),
  };

  const warmup = createCloudBootstrapWarmupServiceForTests({
    scheduler,
    logger,
    errorReporter: {
      captureException,
      captureMessage,
      addBreadcrumb,
    },
    fetchImpl,
    loadToolIndexService,
    isEagerOverrideEnabled: options.isEagerOverrideEnabled ?? (() => false),
  });

  warmup.configure({
    superMcpUrl: 'https://super-mcp.example/mcp',
    idleTriggerMs: options.idleTriggerMs,
    watchdogDelayMs: options.watchdogDelayMs,
  });

  return {
    warmup,
    fetchImpl,
    loadToolIndexService,
    initializeToolIndex,
    refreshToolIndex,
    refreshToolIndexFromCatalogData,
    addBreadcrumb,
    captureException,
    captureMessage,
    logger,
  };
}

describe('cloudBootstrapWarmup', () => {
  let previousNodeEnv: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-27T10:00:00.000Z'));
    previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    delete process.env.REBEL_SUPPRESS_WARMUP_WATCHDOG;
  });

  afterEach(() => {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    delete process.env.REBEL_SUPPRESS_WARMUP_WATCHDOG;
    vi.useRealTimers();
  });

  it('transitions not_scheduled → scheduled → running → succeeded on first request', async () => {
    const deferredFetch: { resolve: ((value: Response) => void) | null } = { resolve: null };
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      deferredFetch.resolve = resolve;
    }));
    const harness = createHarness({ fetchImpl: fetchImpl as unknown as typeof fetch });

    harness.warmup.scheduleIdleTimerAndWatchdog(1_234);
    expect(harness.warmup.getState()).toBe('not_scheduled');

    harness.warmup.observeRequest('GET', '/api/health', true);
    expect(harness.warmup.getState()).toBe('not_scheduled');

    harness.warmup.observeRequest('POST', '/api/sessions', false);
    expect(harness.warmup.getState()).toBe('scheduled');

    await Promise.resolve();
    expect(harness.warmup.getState()).toBe('running');

    deferredFetch.resolve?.({
      ok: true,
      status: 200,
      json: async () => ({
        tools: [{ package_id: 'pkg.test', package_name: 'Pkg Test', tool_id: 'pkg__tool', name: 'Pkg Tool', description: 'desc' }],
        package_hashes: { 'pkg.test': 'hash-1' },
        etag: 'etag-1',
      }),
    } as Response);

    await vi.waitFor(() => {
      expect(harness.warmup.getState()).toBe('succeeded');
    });

    expect(harness.initializeToolIndex).toHaveBeenCalledTimes(1);
    expect(harness.refreshToolIndexFromCatalogData).toHaveBeenCalledTimes(1);
    expect(harness.refreshToolIndex).toHaveBeenCalledTimes(0);
    expect(harness.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'cloud.bootstrap.completed',
      data: expect.objectContaining({ durationMs: 1_234 }),
    }));
    expect(harness.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'cloud.warmup.tool_index.scheduled',
      data: expect.objectContaining({ trigger: 'first-request' }),
    }));
    expect(harness.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'cloud.warmup.tool_index.running',
    }));
    expect(harness.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'cloud.warmup.tool_index.succeeded',
    }));
  });

  it('triggers warmup from idle timer when traffic has not arrived', async () => {
    const harness = createHarness();
    harness.warmup.scheduleIdleTimerAndWatchdog(200);

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(harness.warmup.getState()).toBe('succeeded');
    });

    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(harness.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'cloud.warmup.tool_index.scheduled',
      data: expect.objectContaining({ trigger: 'idle-timer' }),
    }));
  });

  it('fires watchdog when warmup remains unscheduled past threshold', async () => {
    const harness = createHarness({ idleTriggerMs: 120_000, watchdogDelayMs: 65_000 });
    harness.warmup.scheduleIdleTimerAndWatchdog(500);

    await vi.advanceTimersByTimeAsync(65_000);

    expect(harness.warmup.getState()).toBe('not_scheduled');
    expect(harness.captureMessage).toHaveBeenCalledWith(
      'cloud.warmup.watchdog.late',
      expect.objectContaining({
        level: 'error',
        extra: expect.objectContaining({
          stateAtFire: 'not_scheduled',
          reason: 'warmup-never-scheduled',
        }),
      }),
    );
    expect(harness.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'cloud.warmup.watchdog.late',
    }));
  });

  it('suppresses watchdog sentry capture when REBEL_SUPPRESS_WARMUP_WATCHDOG=1', async () => {
    process.env.REBEL_SUPPRESS_WARMUP_WATCHDOG = '1';
    const harness = createHarness({ idleTriggerMs: 120_000, watchdogDelayMs: 65_000 });
    harness.warmup.scheduleIdleTimerAndWatchdog(500);

    await vi.advanceTimersByTimeAsync(65_000);

    expect(harness.warmup.getState()).toBe('not_scheduled');
    expect(harness.captureMessage).not.toHaveBeenCalled();
    expect(harness.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'cloud.warmup.watchdog.late',
      data: expect.objectContaining({
        sentrySuppressed: true,
      }),
    }));
  });

  it('deduplicates concurrent first-request and idle-timer triggers', async () => {
    const harness = createHarness({ idleTriggerMs: 0 });
    harness.warmup.scheduleIdleTimerAndWatchdog(100);
    harness.warmup.observeRequest('POST', '/api/sessions', false);

    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => {
      expect(harness.warmup.getState()).toBe('succeeded');
    });

    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(harness.initializeToolIndex).toHaveBeenCalledTimes(1);
    const scheduledBreadcrumbs = harness.addBreadcrumb.mock.calls.filter(([entry]) => (
      entry?.message === 'cloud.warmup.tool_index.scheduled'
    ));
    expect(scheduledBreadcrumbs).toHaveLength(1);
  });

  it('runs immediately when eager override is enabled', async () => {
    const harness = createHarness({
      isEagerOverrideEnabled: () => true,
      idleTriggerMs: 120_000,
      watchdogDelayMs: 130_000,
    });

    harness.warmup.scheduleIdleTimerAndWatchdog(350);

    await vi.waitFor(() => {
      expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
      expect(harness.warmup.getState()).toBe('succeeded');
    });
  });

  it('skips scheduling without capturing an exception when superMcpUrl is missing', () => {
    const harness = createHarness();
    harness.warmup.configure({ superMcpUrl: null });

    harness.warmup.scheduleIdleTimerAndWatchdog(123);

    // Expected upstream condition — must NOT surface as a Sentry exception and
    // the state machine stays parked at `not_scheduled` (no `failed` state).
    expect(harness.warmup.getState()).toBe('not_scheduled');
    expect(harness.captureException).not.toHaveBeenCalled();
    expect(harness.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'cloud.warmup.tool_index.skipped',
      data: expect.objectContaining({
        reason: 'super-mcp-unavailable',
        phase: 'scheduling',
        superMcpUrlPresent: false,
      }),
    }));
    // No `failed` telemetry should have been emitted for the missing-URL case.
    expect(harness.addBreadcrumb).not.toHaveBeenCalledWith(expect.objectContaining({
      message: 'cloud.warmup.tool_index.failed',
    }));
  });

  it('skips ensureWarm without capturing an exception and reports at most once (no spam)', async () => {
    const harness = createHarness();
    harness.warmup.configure({ superMcpUrl: null });

    await harness.warmup.ensureWarm('first-request');
    await harness.warmup.ensureWarm('first-request');
    await harness.warmup.ensureWarm('idle-timer');

    expect(harness.warmup.getState()).toBe('not_scheduled');
    expect(harness.captureException).not.toHaveBeenCalled();
    expect(harness.fetchImpl).not.toHaveBeenCalled();

    const skippedBreadcrumbs = harness.addBreadcrumb.mock.calls.filter(([entry]) => (
      entry?.message === 'cloud.warmup.tool_index.skipped'
    ));
    expect(skippedBreadcrumbs).toHaveLength(1);
    expect(skippedBreadcrumbs[0]?.[0]).toEqual(expect.objectContaining({
      data: expect.objectContaining({
        reason: 'super-mcp-unavailable',
        phase: 'trigger',
        trigger: 'first-request',
      }),
    }));
  });

  it('reports the missing-URL skip at most once across BOTH the scheduling and ensureWarm guards', async () => {
    const harness = createHarness();
    harness.warmup.configure({ superMcpUrl: null });

    // Hit the scheduling guard, then the ensureWarm guard via request + direct calls.
    harness.warmup.scheduleIdleTimerAndWatchdog(100);
    harness.warmup.observeRequest('POST', '/api/sessions', false);
    await harness.warmup.ensureWarm('first-request');
    await harness.warmup.ensureWarm('idle-timer');

    expect(harness.warmup.getState()).toBe('not_scheduled');
    expect(harness.captureException).not.toHaveBeenCalled();
    expect(harness.fetchImpl).not.toHaveBeenCalled();

    const skippedBreadcrumbs = harness.addBreadcrumb.mock.calls.filter(([entry]) => (
      entry?.message === 'cloud.warmup.tool_index.skipped'
    ));
    expect(skippedBreadcrumbs).toHaveLength(1);
    // First (and only) emission is the scheduling guard.
    expect(skippedBreadcrumbs[0]?.[0]).toEqual(expect.objectContaining({
      data: expect.objectContaining({ phase: 'scheduling', reason: 'super-mcp-unavailable' }),
    }));
  });

  it('transitions to failed and captures exception when tool-index refresh throws', async () => {
    const harness = createHarness({
      loadToolIndexService: vi.fn(async () => ({
        initializeToolIndex: vi.fn(async () => undefined),
        refreshToolIndex: vi.fn(async () => {
          throw new Error('refresh crashed');
        }),
      })),
      fetchImpl: vi.fn(async () => ({
        ok: false,
        status: 503,
      }) as Response) as unknown as typeof fetch,
    });

    harness.warmup.scheduleIdleTimerAndWatchdog(99);
    harness.warmup.observeRequest('POST', '/api/sessions', false);

    await vi.waitFor(() => {
      expect(harness.warmup.getState()).toBe('failed');
    });

    expect(harness.captureException).toHaveBeenCalled();
    expect(harness.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'cloud.warmup.tool_index.failed',
    }));
  });

  it('allows failed warmup to retry after 30 seconds', async () => {
    let refreshAttempts = 0;
    const harness = createHarness({
      loadToolIndexService: vi.fn(async () => ({
        initializeToolIndex: vi.fn(async () => undefined),
        refreshToolIndex: vi.fn(async () => {
          refreshAttempts += 1;
          if (refreshAttempts === 1) {
            throw new Error('transient failure');
          }
          return {
            success: true,
            added: 1,
            updated: 0,
            removed: 0,
            total: 1,
          };
        }),
      })),
      fetchImpl: vi.fn(async () => ({
        ok: false,
        status: 503,
      }) as Response) as unknown as typeof fetch,
    });

    harness.warmup.observeRequest('POST', '/api/sessions', false);
    await vi.waitFor(() => {
      expect(harness.warmup.getState()).toBe('failed');
    });
    expect(refreshAttempts).toBe(1);

    await harness.warmup.ensureWarm('first-request');
    expect(refreshAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    const retryPromise = harness.warmup.ensureWarm('first-request');
    expect(harness.warmup.getState()).toBe('scheduled');
    await retryPromise;

    await vi.waitFor(() => {
      expect(harness.warmup.getState()).toBe('succeeded');
    });
    expect(refreshAttempts).toBe(2);
  });

  it('stops retrying after three failed attempts and reports terminal failure once', async () => {
    let refreshAttempts = 0;
    const harness = createHarness({
      loadToolIndexService: vi.fn(async () => ({
        initializeToolIndex: vi.fn(async () => undefined),
        refreshToolIndex: vi.fn(async () => {
          refreshAttempts += 1;
          throw new Error(`persistent failure ${refreshAttempts}`);
        }),
      })),
      fetchImpl: vi.fn(async () => ({
        ok: false,
        status: 503,
      }) as Response) as unknown as typeof fetch,
    });

    harness.warmup.observeRequest('POST', '/api/sessions', false);
    await vi.waitFor(() => {
      expect(harness.warmup.getState()).toBe('failed');
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await harness.warmup.ensureWarm('first-request');
    await vi.waitFor(() => {
      expect(harness.warmup.getState()).toBe('failed');
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await harness.warmup.ensureWarm('first-request');
    await vi.waitFor(() => {
      expect(harness.warmup.getState()).toBe('failed');
    });

    expect(refreshAttempts).toBe(3);
    expect(harness.captureMessage).toHaveBeenCalledWith(
      'cloud.warmup.tool_index.failed.terminal',
      expect.objectContaining({
        level: 'error',
      }),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    await harness.warmup.ensureWarm('first-request');
    expect(refreshAttempts).toBe(3);
    expect(harness.captureMessage.mock.calls.filter(([message]) => (
      message === 'cloud.warmup.tool_index.failed.terminal'
    ))).toHaveLength(1);
  });
});
