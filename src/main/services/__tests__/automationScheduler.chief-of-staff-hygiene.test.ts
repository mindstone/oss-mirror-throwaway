import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, AutomationDefinition } from '@shared/types';
import type { ChiefOfStaffHygieneRunResult } from '@core/services/chiefOfStaffHygieneRunnerService';
import { AutomationSchedule } from '@shared/utils/automationSchedule';

const { mockHasInteractiveTurn, mockWaitForInteractiveTurnToSettle } = vi.hoisted(() => ({
  mockHasInteractiveTurn: vi.fn().mockReturnValue(false),
  mockWaitForInteractiveTurnToSettle: vi.fn().mockResolvedValue({
    deferred: true,
    deferredMs: 1,
    timedOut: false,
    shuttingDown: false,
  }),
}));

vi.mock('electron-store', () => {
  class MemoryStore<T> {
    store: T;
    constructor(options: { defaults: T }) {
      this.store = structuredClone(options.defaults);
    }
  }
  return { default: MemoryStore };
});

const mockLoggerMethods = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLoggerMethods,
  logger: mockLoggerMethods,
}));

vi.mock('@main/analytics', () => ({
  trackMainEvent: vi.fn(),
  getOrGenerateAnonymousId: () => 'test-anonymous-id',
}));

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({ sendToAllWindows: vi.fn(), sendToFocusedWindow: vi.fn() }),
}));

vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getSecurityDenials: vi.fn().mockReturnValue([]),
    clearSecurityDenials: vi.fn(),
    hasInteractiveTurn: mockHasInteractiveTurn,
  },
}));

vi.mock('@core/services/automation/automationRules', async () => {
  const actual = await vi.importActual<typeof import('@core/services/automation/automationRules')>(
    '@core/services/automation/automationRules',
  );
  return {
    ...actual,
    waitForInteractiveTurnToSettle: mockWaitForInteractiveTurnToSettle,
  };
});

vi.mock('../shutdownState', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
}));

vi.mock('../agentEventDispatcher', async () => {
  const actual = await vi.importActual<typeof import('../agentEventDispatcher')>(
    '../agentEventDispatcher',
  );
  return {
    ...actual,
    dispatchAgentEvent: vi.fn(),
    dispatchAgentErrorEvent: vi.fn(),
    showAutomationOutcomeNotification: vi.fn(),
  };
});

type SchedulerWithPrivate = {
  runChiefOfStaffHygienePipeline: (automation: AutomationDefinition, runId: string) => Promise<{
    status: string;
    error: string | null;
  }>;
};

function makeDefinition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'system-chief-of-staff-hygiene',
    name: 'Chief-of-Staff Hygiene',
    filePath: '',
    schedule: AutomationSchedule.weekly({ daysOfWeek: [0], time: '06:20' }),
    enabled: true,
    catchUpIfMissed: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isSystem: true,
    systemType: 'chief-of-staff-hygiene',
    ...overrides,
  };
}

function makeRunResult(overrides: Partial<ChiefOfStaffHygieneRunResult> = {}): ChiefOfStaffHygieneRunResult {
  return {
    readmePath: '/tmp/core/Chief-of-Staff/README.md',
    eligibility: null,
    rewrite: null,
    skippedReason: null,
    errors: [],
    elapsedMs: 1,
    ...overrides,
  };
}

describe('automationScheduler — Chief-of-Staff hygiene wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasInteractiveTurn.mockReturnValue(false);
    mockWaitForInteractiveTurnToSettle.mockResolvedValue({
      deferred: true,
      deferredMs: 1,
      timedOut: false,
      shuttingDown: false,
    });
  });

  it('fresh install seeds a weekly Chief-of-Staff hygiene automation', async () => {
    const { AutomationScheduler } = await import('../automationScheduler');
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/core',
      executeAgentTurn: vi.fn(),
    });

    const def = scheduler.getState().definitions.find(
      (automation) => automation.isSystem && automation.systemType === 'chief-of-staff-hygiene',
    );

    expect(def).toBeDefined();
    expect(def?.id).toBe('system-chief-of-staff-hygiene');
    expect(def?.enabled).toBe(true);
    expect(def?.filePath).toBe('');
    expect(def?.schedule).toEqual({ type: 'weekly', daysOfWeek: [0], time: '06:20' });
  });

  it('returns success when the hygiene dep completes without errors', async () => {
    const runChiefOfStaffHygiene = vi.fn().mockResolvedValue(makeRunResult());
    const { AutomationScheduler } = await import('../automationScheduler');
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/core',
      executeAgentTurn: vi.fn(),
      getSettings: () => ({ spaces: [] } as unknown as AppSettings),
      runChiefOfStaffHygiene,
    });

    const result = await (scheduler as unknown as SchedulerWithPrivate).runChiefOfStaffHygienePipeline(
      makeDefinition(),
      'test-run-id',
    );

    expect(result.status).toBe('success');
    expect(result.error).toBeNull();
    expect(runChiefOfStaffHygiene).toHaveBeenCalledWith('/tmp/core', expect.objectContaining({ spaces: [] }));
  });

  it('returns completed_with_blocks when the hygiene dep reports read errors', async () => {
    const runChiefOfStaffHygiene = vi.fn().mockResolvedValue(makeRunResult({ errors: ['read failed'] }));
    const { AutomationScheduler } = await import('../automationScheduler');
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/core',
      executeAgentTurn: vi.fn(),
      getSettings: () => ({ spaces: [] } as unknown as AppSettings),
      runChiefOfStaffHygiene,
    });

    const result = await (scheduler as unknown as SchedulerWithPrivate).runChiefOfStaffHygienePipeline(
      makeDefinition(),
      'test-run-id',
    );

    expect(result.status).toBe('completed_with_blocks');
    expect(result.error).toContain('read failed');
  });

  it('fails closed when the hygiene dep is not wired', async () => {
    const { AutomationScheduler } = await import('../automationScheduler');
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/core',
      executeAgentTurn: vi.fn(),
      getSettings: () => ({ spaces: [] } as unknown as AppSettings),
    });

    const result = await (scheduler as unknown as SchedulerWithPrivate).runChiefOfStaffHygienePipeline(
      makeDefinition(),
      'test-run-id',
    );

    expect(result.status).toBe('failure');
    expect(result.error).toContain('chief-of-staff-hygiene dep not wired');
  });

  it('defers scheduled runs during active interactive turns despite using a non-LLM pipeline', async () => {
    mockHasInteractiveTurn.mockReturnValue(true);
    const runChiefOfStaffHygiene = vi.fn().mockResolvedValue(makeRunResult());
    const { AutomationScheduler } = await import('../automationScheduler');
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/core',
      executeAgentTurn: vi.fn(),
      // onboarded user: the onboarding gate on executeAutomation must not skip this.
      getSettings: () => ({ spaces: [], onboardingCompleted: true } as unknown as AppSettings),
      runChiefOfStaffHygiene,
    });

    const run = await scheduler.runNow('system-chief-of-staff-hygiene', 'schedule');

    expect(run?.status).toBe('success');
    expect(mockWaitForInteractiveTurnToSettle).toHaveBeenCalledTimes(1);
    expect(runChiefOfStaffHygiene).toHaveBeenCalledTimes(1);
  });
});
