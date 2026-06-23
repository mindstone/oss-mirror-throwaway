import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addBreadcrumbMock,
  getMachineStateMock,
  warmupSnapshot,
  bootstrapState,
} = vi.hoisted(() => ({
  addBreadcrumbMock: vi.fn(),
  getMachineStateMock: vi.fn(),
  warmupSnapshot: {
    state: 'succeeded' as 'not_scheduled' | 'scheduled' | 'running' | 'succeeded' | 'failed',
    failedAttempts: 0,
    stateChangedAtMs: null as number | null,
  },
  bootstrapState: {
    completedAtMs: null as number | null,
  },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: vi.fn(() => ({
    addBreadcrumb: addBreadcrumbMock,
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  })),
}));

vi.mock('@core/services/flyApiClient', () => ({
  getMachineState: (...args: unknown[]) => getMachineStateMock(...args),
}));

vi.mock('../../services/cloudBootstrapWarmup', () => ({
  cloudBootstrapWarmup: {
    getHealthSnapshot: () => warmupSnapshot,
  },
}));

vi.mock('../../bootstrap', () => ({
  get cloudBootstrapCompletedAtMs() {
    return bootstrapState.completedAtMs;
  },
}));

import {
  __resetCloudHealthCheckStateForTests,
  checkBootBudget,
  getCachedRssBudgetMb,
  checkMemoryUsage,
  checkWarmupState,
} from '../checks';

const MB = 1024 * 1024;
const FLY_ENV = {
  FLY_API_TOKEN: 'fly-token',
  FLY_APP_NAME: 'rebel-cloud-test',
  FLY_MACHINE_ID: 'machine-123',
} as const;

let nowMs = 1_000_000;

function setMemoryUsage(rssMb: number, heapUsedMb = 100, heapTotalMb = 200): void {
  vi.spyOn(process, 'memoryUsage').mockReturnValue({
    rss: rssMb * MB,
    heapUsed: heapUsedMb * MB,
    heapTotal: heapTotalMb * MB,
    external: 0,
    arrayBuffers: 0,
  });
}

function setWarmupSnapshot(
  state: 'not_scheduled' | 'scheduled' | 'running' | 'succeeded' | 'failed',
  options?: { failedAttempts?: number; stateChangedAtMs?: number | null },
): void {
  warmupSnapshot.state = state;
  warmupSnapshot.failedAttempts = options?.failedAttempts ?? 0;
  warmupSnapshot.stateChangedAtMs = options?.stateChangedAtMs ?? nowMs - 15_000;
}

function setBootDuration(bootDurationMs: number, uptimeSeconds = 600): void {
  vi.spyOn(process, 'uptime').mockReturnValue(uptimeSeconds);
  const processStartAtMs = nowMs - uptimeSeconds * 1000;
  bootstrapState.completedAtMs = processStartAtMs + bootDurationMs;
}

describe('cloud-service health checks (Stage A4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    __resetCloudHealthCheckStateForTests();

    nowMs = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    vi.spyOn(process, 'uptime').mockReturnValue(120);
    setMemoryUsage(500);
    setWarmupSnapshot('succeeded', { failedAttempts: 0, stateChangedAtMs: nowMs - 5_000 });

    delete process.env.REBEL_CLOUD_RSS_BUDGET_MB;
    delete process.env.FLY_API_TOKEN;
    delete process.env.FLY_APP_NAME;
    delete process.env.FLY_MACHINE_ID;
    bootstrapState.completedAtMs = null;
  });

  it('uses Fly guest RSS budgets and fallback ordering', async () => {
    process.env.FLY_API_TOKEN = FLY_ENV.FLY_API_TOKEN;
    process.env.FLY_APP_NAME = FLY_ENV.FLY_APP_NAME;
    process.env.FLY_MACHINE_ID = FLY_ENV.FLY_MACHINE_ID;

    getMachineStateMock.mockResolvedValueOnce({
      success: true,
      machine: {
        config: {
          guest: { cpu_kind: 'shared', cpus: 4, memory_mb: 4096 },
        },
      },
    });
    setMemoryUsage(1_700, 80, 200);
    const standard = await checkMemoryUsage();
    expect(standard.status).toBe('warn');
    expect(standard.details?.rss_budget_mb).toBe(4096);

    __resetCloudHealthCheckStateForTests();
    getMachineStateMock.mockResolvedValueOnce({
      success: true,
      machine: {
        config: {
          guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 8192 },
        },
      },
    });
    setMemoryUsage(3_300, 80, 200);
    const offGridWithExtraMemory = await checkMemoryUsage();
    expect(offGridWithExtraMemory.status).toBe('warn');
    expect(offGridWithExtraMemory.details?.rss_budget_mb).toBe(8192);

    __resetCloudHealthCheckStateForTests();
    getMachineStateMock.mockResolvedValueOnce({
      success: true,
      machine: {
        config: {
          guest: { cpu_kind: 'performance', cpus: 4, memory_mb: 8192 },
        },
      },
    });
    setMemoryUsage(3_300, 80, 200);
    const heavyWork = await checkMemoryUsage();
    expect(heavyWork.status).toBe('warn');
    expect(heavyWork.details?.rss_budget_mb).toBe(8192);

    __resetCloudHealthCheckStateForTests();
    getMachineStateMock.mockResolvedValueOnce({
      success: true,
      machine: {
        config: {
          guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 },
        },
      },
    });
    setMemoryUsage(120, 80, 200);
    const offGridBelowStandard = await checkMemoryUsage();
    expect(offGridBelowStandard.status).toBe('warn');
    expect(offGridBelowStandard.details?.rss_budget_mb).toBe(256);

    __resetCloudHealthCheckStateForTests();
    delete process.env.FLY_API_TOKEN;
    delete process.env.FLY_APP_NAME;
    delete process.env.FLY_MACHINE_ID;
    process.env.REBEL_CLOUD_RSS_BUDGET_MB = '2000';
    setMemoryUsage(900, 80, 200);
    const envOverride = await checkMemoryUsage();
    expect(envOverride.status).toBe('warn');
    expect(envOverride.details?.rss_budget_mb).toBe(2000);

    __resetCloudHealthCheckStateForTests();
    process.env.FLY_API_TOKEN = FLY_ENV.FLY_API_TOKEN;
    process.env.FLY_APP_NAME = FLY_ENV.FLY_APP_NAME;
    process.env.FLY_MACHINE_ID = FLY_ENV.FLY_MACHINE_ID;
    process.env.REBEL_CLOUD_RSS_BUDGET_MB = '3000';
    getMachineStateMock.mockResolvedValueOnce({ success: false, error: 'fly unavailable' });
    setMemoryUsage(1_500, 80, 200);
    const flyFailureFallback = await checkMemoryUsage();
    expect(flyFailureFallback.status).toBe('warn');
    expect(flyFailureFallback.details?.rss_budget_mb).toBe(3000);

    __resetCloudHealthCheckStateForTests();
    delete process.env.FLY_API_TOKEN;
    delete process.env.FLY_APP_NAME;
    delete process.env.FLY_MACHINE_ID;
    delete process.env.REBEL_CLOUD_RSS_BUDGET_MB;
    setMemoryUsage(1_700, 80, 200);
    const defaultFallback = await checkMemoryUsage();
    expect(defaultFallback.status).toBe('warn');
    expect(defaultFallback.details?.rss_budget_mb).toBe(4096);
  });

  it('refreshes cached tier budget after cache expiry', async () => {
    process.env.FLY_API_TOKEN = FLY_ENV.FLY_API_TOKEN;
    process.env.FLY_APP_NAME = FLY_ENV.FLY_APP_NAME;
    process.env.FLY_MACHINE_ID = FLY_ENV.FLY_MACHINE_ID;
    setMemoryUsage(3_000, 80, 200);

    getMachineStateMock
      .mockResolvedValueOnce({
        success: true,
        machine: {
          config: {
            guest: { cpu_kind: 'shared', cpus: 4, memory_mb: 4096 },
          },
        },
      })
      .mockResolvedValueOnce({
        success: true,
        machine: {
          config: {
            guest: { cpu_kind: 'performance', cpus: 4, memory_mb: 8192 },
          },
        },
      });

    const first = await checkMemoryUsage();
    expect(first.status).toBe('fail');
    expect(first.details?.rss_budget_mb).toBe(4096);

    nowMs += 120_000;
    const second = await checkMemoryUsage();
    expect(second.status).toBe('fail');
    expect(second.details?.rss_budget_mb).toBe(4096);
    expect(getMachineStateMock).toHaveBeenCalledTimes(1);

    nowMs += 181_000;
    const third = await checkMemoryUsage();
    expect(third.status).toBe('pass');
    expect(third.details?.rss_budget_mb).toBe(8192);
    expect(getMachineStateMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent Fly budget fetches after cache expiry', async () => {
    process.env.FLY_API_TOKEN = FLY_ENV.FLY_API_TOKEN;
    process.env.FLY_APP_NAME = FLY_ENV.FLY_APP_NAME;
    process.env.FLY_MACHINE_ID = FLY_ENV.FLY_MACHINE_ID;
    setMemoryUsage(900, 80, 200);

    getMachineStateMock.mockResolvedValueOnce({
      success: true,
      machine: {
        config: {
          guest: { cpu_kind: 'shared', cpus: 4, memory_mb: 4096 },
        },
      },
    });
    await checkMemoryUsage();
    expect(getMachineStateMock).toHaveBeenCalledTimes(1);

    getMachineStateMock.mockClear();
    nowMs += 301_000;

    type MachineStateValue = { success: true; machine: { config: { guest: { cpu_kind: string; cpus: number; memory_mb: number } } } };
    const deferred: { resolve: ((value: MachineStateValue) => void) | null } = { resolve: null };
    const machineStatePromise = new Promise<MachineStateValue>((resolve) => {
      deferred.resolve = resolve;
    });
    getMachineStateMock.mockImplementation(() => machineStatePromise);

    const checksPromise = Promise.all([
      checkMemoryUsage(),
      checkMemoryUsage(),
      checkMemoryUsage(),
      checkMemoryUsage(),
      checkMemoryUsage(),
    ]);
    await Promise.resolve();
    expect(getMachineStateMock).toHaveBeenCalledTimes(1);

    if (!deferred.resolve) {
      throw new Error('Machine state resolver was not initialized');
    }
    deferred.resolve({
      success: true,
      machine: {
        config: {
          guest: { cpu_kind: 'performance', cpus: 4, memory_mb: 8192 },
        },
      },
    });

    const results = await checksPromise;
    expect(results).toHaveLength(5);
    for (const result of results) {
      expect(result.details?.rss_budget_mb).toBe(8192);
    }
  });

  it('returns fallback budget immediately from cached accessor while Fly refresh is unresolved', () => {
    process.env.FLY_API_TOKEN = FLY_ENV.FLY_API_TOKEN;
    process.env.FLY_APP_NAME = FLY_ENV.FLY_APP_NAME;
    process.env.FLY_MACHINE_ID = FLY_ENV.FLY_MACHINE_ID;

    getMachineStateMock.mockImplementation(() => new Promise(() => {}));

    const first = getCachedRssBudgetMb();
    const second = getCachedRssBudgetMb();

    expect(first).toBe(4096);
    expect(second).toBe(4096);
    expect(getMachineStateMock).toHaveBeenCalledTimes(1);
  });

  it('maps boot duration budgets to pass/warn/fail', async () => {
    setBootDuration(59_000);
    const passResult = await checkBootBudget();
    expect(passResult.status).toBe('pass');

    setBootDuration(120_000);
    const warnResult = await checkBootBudget();
    expect(warnResult.status).toBe('warn');

    setBootDuration(200_000);
    const failResult = await checkBootBudget();
    expect(failResult.status).toBe('fail');
  });

  it('surfaces warmup state-machine status in health checks', async () => {
    setWarmupSnapshot('succeeded', { stateChangedAtMs: nowMs - 10_000 });
    expect((await checkWarmupState()).status).toBe('pass');

    setWarmupSnapshot('scheduled', { stateChangedAtMs: nowMs - 20_000 });
    expect((await checkWarmupState()).status).toBe('pass');

    setWarmupSnapshot('running', { stateChangedAtMs: nowMs - 30_000 });
    expect((await checkWarmupState()).status).toBe('pass');

    setWarmupSnapshot('failed', { failedAttempts: 2, stateChangedAtMs: nowMs - 30_000 });
    const failed = await checkWarmupState();
    expect(failed.status).toBe('warn');
    expect(failed.details).toMatchObject({
      state: 'failed',
      failedAttempts: 2,
    });

    vi.spyOn(process, 'uptime').mockReturnValue(120);
    setWarmupSnapshot('not_scheduled', { failedAttempts: 0, stateChangedAtMs: nowMs - 120_000 });
    const notScheduled = await checkWarmupState();
    expect(notScheduled.status).toBe('warn');
    expect(notScheduled.details).toMatchObject({
      state: 'not_scheduled',
      failedAttempts: 0,
    });
  });

  it('debounces memory warn breadcrumbs during threshold flapping', async () => {
    setMemoryUsage(1_700, 80, 200);
    await checkMemoryUsage();

    nowMs += 10_000;
    setMemoryUsage(1_000, 80, 200);
    await checkMemoryUsage();

    nowMs += 10_000;
    setMemoryUsage(1_700, 80, 200);
    await checkMemoryUsage();

    nowMs += 10_000;
    setMemoryUsage(1_000, 80, 200);
    await checkMemoryUsage();

    const warnBreadcrumbsWithinCooldown = addBreadcrumbMock.mock.calls
      .map(([breadcrumb]) => breadcrumb as { message?: string })
      .filter((breadcrumb) => breadcrumb.message === 'cloud.health.memory.budget_breached');
    expect(warnBreadcrumbsWithinCooldown).toHaveLength(1);

    nowMs += 61_000;
    setMemoryUsage(1_700, 80, 200);
    await checkMemoryUsage();

    const warnBreadcrumbsAfterCooldown = addBreadcrumbMock.mock.calls
      .map(([breadcrumb]) => breadcrumb as { message?: string })
      .filter((breadcrumb) => breadcrumb.message === 'cloud.health.memory.budget_breached');
    expect(warnBreadcrumbsAfterCooldown).toHaveLength(2);
  });

  it('debounces boot warn breadcrumbs during threshold flapping', async () => {
    setBootDuration(70_000);
    await checkBootBudget();

    nowMs += 10_000;
    setBootDuration(40_000);
    await checkBootBudget();

    nowMs += 10_000;
    setBootDuration(70_000);
    await checkBootBudget();

    nowMs += 10_000;
    setBootDuration(40_000);
    await checkBootBudget();

    const warnBreadcrumbsWithinCooldown = addBreadcrumbMock.mock.calls
      .map(([breadcrumb]) => breadcrumb as { message?: string })
      .filter((breadcrumb) => breadcrumb.message === 'cloud.health.boot.budget_breached');
    expect(warnBreadcrumbsWithinCooldown).toHaveLength(1);

    nowMs += 61_000;
    setBootDuration(70_000);
    await checkBootBudget();

    const warnBreadcrumbsAfterCooldown = addBreadcrumbMock.mock.calls
      .map(([breadcrumb]) => breadcrumb as { message?: string })
      .filter((breadcrumb) => breadcrumb.message === 'cloud.health.boot.budget_breached');
    expect(warnBreadcrumbsAfterCooldown).toHaveLength(2);
  });

  it('emits Sentry breadcrumbs only on memory/boot warn-fail transitions', async () => {
    setMemoryUsage(1_000, 80, 200);
    await checkMemoryUsage();
    expect(addBreadcrumbMock).not.toHaveBeenCalled();

    setMemoryUsage(1_700, 80, 200);
    await checkMemoryUsage();
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
    expect(addBreadcrumbMock).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'cloud.health.memory.budget_breached',
      data: expect.objectContaining({ state: 'warn', rss_mb: 1700, budget_mb: 4096 }),
    }));

    await checkMemoryUsage();
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);

    setMemoryUsage(2_300, 80, 200);
    await checkMemoryUsage();
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(2);
    expect(addBreadcrumbMock).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'cloud.health.memory.budget_breached',
      data: expect.objectContaining({ state: 'fail', rss_mb: 2300, budget_mb: 4096 }),
    }));

    addBreadcrumbMock.mockClear();
    __resetCloudHealthCheckStateForTests();

    setBootDuration(40_000);
    await checkBootBudget();
    expect(addBreadcrumbMock).not.toHaveBeenCalled();

    setBootDuration(70_000);
    await checkBootBudget();
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
    expect(addBreadcrumbMock).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'cloud.health.boot.budget_breached',
      data: expect.objectContaining({ state: 'warn', boot_duration_ms: 70000, budget_ms: 60000 }),
    }));

    await checkBootBudget();
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);

    setBootDuration(190_000);
    await checkBootBudget();
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(2);
    expect(addBreadcrumbMock).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'cloud.health.boot.budget_breached',
      data: expect.objectContaining({ state: 'fail', boot_duration_ms: 190000, budget_ms: 180000 }),
    }));
  });
});
