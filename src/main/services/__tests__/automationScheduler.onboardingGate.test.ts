import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import type { AgentSession, AppSettings } from '@shared/types';
import { AutomationSchedule } from '@shared/utils/automationSchedule';

const mockUpdateSession = vi.fn();

vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getSecurityDenials: vi.fn().mockReturnValue([]),
    clearSecurityDenials: vi.fn(),
    hasInteractiveTurn: vi.fn().mockReturnValue(false),
    getRendererSession: vi.fn().mockReturnValue(null),
    getTurnCategory: vi.fn().mockReturnValue('automation'),
    setTurnCategory: vi.fn(),
    getEventListener: vi.fn().mockReturnValue(null),
    deleteEventListener: vi.fn(),
    getOrCreateAccumulator: vi.fn().mockImplementation(() => {
      const events: Array<Record<string, unknown>> = [];
      return {
        appendEvent: vi.fn((event: Record<string, unknown>) => event),
        stampSeq: vi.fn((event: Record<string, unknown>) => event),
        getConversationShape: vi.fn().mockReturnValue({ messages: [], eventsByTurn: { mockTurn: events } }),
      };
    }),
    clearToolCalls: vi.fn(),
  },
}));

vi.mock('../shutdownState', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentEvent: vi.fn(),
  dispatchAgentErrorEvent: vi.fn(),
  sanitizeEventForMainAccumulation: (event: unknown) => event,
  showAutomationOutcomeNotification: vi.fn(),
}));

vi.mock('../incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({ updateSession: mockUpdateSession }),
}));

async function loadScheduler() {
  vi.resetModules();
  await initTestPlatformConfig();
  const { setSchedulerFactory } = await import('@core/scheduler');
  setSchedulerFactory(() => ({
    registerTimeout: (callback, delayMs) => setTimeout(callback, Math.max(0, delayMs)),
    registerInterval: (callback, intervalMs) => setInterval(callback, Math.max(0, intervalMs)),
    clear: (timer) => clearTimeout(timer),
    now: () => Date.now(),
    sleep: async (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
    isVisible: () => true,
    deferUntilVisible: async () => 'visible',
  }));
  const module = await import('../automationScheduler');
  return module.AutomationScheduler;
}

type SchedulerCtor = Awaited<ReturnType<typeof loadScheduler>>;
type SchedulerInstance = InstanceType<SchedulerCtor>;

function createScheduler(Scheduler: SchedulerCtor, onboardingCompleted: boolean | undefined) {
  const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
  const getSettings = onboardingCompleted === undefined
    ? undefined
    : () => ({ onboardingCompleted } as unknown as AppSettings);
  const scheduler = new Scheduler({
    getCoreDirectory: () => '/tmp/test',
    executeAgentTurn,
    notifyRenderer: vi.fn(),
    getSettings,
  });
  return { scheduler, executeAgentTurn };
}

function mockResolvedAutomationFile(scheduler: SchedulerInstance) {
  const internals = scheduler as unknown as {
    resolveAutomationFile: () => Promise<{ resolved: string; root: string; fileContent: string }>;
  };
  vi.spyOn(internals, 'resolveAutomationFile').mockResolvedValue({
    resolved: '/tmp/test/automation.md',
    root: '/tmp/test',
    fileContent: '# Test automation\n\nSay hello.',
  });
}

function addDailyAutomation(scheduler: SchedulerInstance) {
  return scheduler.upsertDefinition({
    name: 'Morning Triage',
    filePath: '/test/automation.md',
    schedule: AutomationSchedule.daily({ time: '09:00' }),
    enabled: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateSession.mockImplementation(async (
    _sessionId: string,
    mutator: (existing: AgentSession | null) => AgentSession | null,
  ) => {
    mutator(null);
    return true;
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AutomationScheduler — onboarding gate on automatic execution', () => {
  it('skips a scheduled/catch-up run when onboarding is not complete (the fresh-install bug)', async () => {
    const Scheduler = await loadScheduler();
    const { scheduler, executeAgentTurn } = createScheduler(Scheduler, false);
    mockResolvedAutomationFile(scheduler);
    const def = addDailyAutomation(scheduler);

    const run = await scheduler.runNow(def.id, 'schedule');

    expect(run).toBeNull();
    expect(executeAgentTurn).not.toHaveBeenCalled();
    // The skip happens before any run is staged: no session is created/updated.
    expect(mockUpdateSession).not.toHaveBeenCalled();
  });

  it('skips an event-triggered automation pre-onboarding (and event schedules are not rescheduled)', async () => {
    const Scheduler = await loadScheduler();
    const { scheduler, executeAgentTurn } = createScheduler(Scheduler, false);
    mockResolvedAutomationFile(scheduler);
    const def = scheduler.upsertDefinition({
      name: 'Transcript Ready',
      filePath: '/test/automation.md',
      schedule: AutomationSchedule.event({ eventType: 'transcript-ready' }),
      enabled: true,
    });
    const scheduleSpy = vi.spyOn(
      scheduler as unknown as { scheduleAutomation: (d: unknown) => void },
      'scheduleAutomation',
    );

    const run = await scheduler.runNow(def.id, 'event');

    expect(run).toBeNull();
    expect(executeAgentTurn).not.toHaveBeenCalled();
    expect(scheduleSpy).not.toHaveBeenCalled(); // event schedules must not be rescheduled
  });

  it('treats missing settings (no getSettings dep) as not-onboarded and skips automatic runs', async () => {
    const Scheduler = await loadScheduler();
    const { scheduler, executeAgentTurn } = createScheduler(Scheduler, undefined);
    mockResolvedAutomationFile(scheduler);
    const def = addDailyAutomation(scheduler);

    expect(await scheduler.runNow(def.id, 'catch-up')).toBeNull();
    expect(executeAgentTurn).not.toHaveBeenCalled();
  });

  it('still runs a manual run before onboarding completes (explicit user action)', async () => {
    const Scheduler = await loadScheduler();
    const { scheduler, executeAgentTurn } = createScheduler(Scheduler, false);
    mockResolvedAutomationFile(scheduler);
    const def = addDailyAutomation(scheduler);

    const run = await scheduler.runNow(def.id, 'manual');

    expect(run).not.toBeNull();
    expect(executeAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('runs scheduled automations once onboarding is complete (no regression for existing users)', async () => {
    const Scheduler = await loadScheduler();
    const { scheduler, executeAgentTurn } = createScheduler(Scheduler, true);
    mockResolvedAutomationFile(scheduler);
    const def = addDailyAutomation(scheduler);

    const run = await scheduler.runNow(def.id, 'schedule');

    expect(run).not.toBeNull();
    expect(executeAgentTurn).toHaveBeenCalledTimes(1);
  });
});
