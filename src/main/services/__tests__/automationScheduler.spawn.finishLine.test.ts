 
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import type { AgentSession } from '@shared/types';
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
      let nextSeq = 1;
      const stampSeq = (event: Record<string, unknown>) => {
        const seq = typeof event.seq === 'number' ? event.seq : nextSeq;
        nextSeq = Math.max(nextSeq, seq + 1);
        return { ...event, seq };
      };
      return {
        appendEvent: vi.fn((event: Record<string, unknown>) => {
          const stamped = stampSeq(event);
          events.push(stamped);
          return stamped;
        }),
        stampSeq: vi.fn((event: Record<string, unknown>) => stampSeq(event)),
        getConversationShape: vi.fn().mockImplementation(() => ({
          messages: [],
          eventsByTurn: { mockTurn: events },
        })),
      };
    }),
    clearToolCalls: vi.fn(),
  },
}));

vi.mock('../shutdownState', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
}));

vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentEvent: vi.fn(),
  dispatchAgentErrorEvent: vi.fn(),
  sanitizeEventForMainAccumulation: (event: unknown) => event,
  showAutomationOutcomeNotification: vi.fn(),
}));

vi.mock('../incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({
    updateSession: mockUpdateSession,
  }),
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

type SchedulerInstance = InstanceType<Awaited<ReturnType<typeof loadScheduler>>>;

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

function createScheduler(Scheduler: Awaited<ReturnType<typeof loadScheduler>>) {
  return new Scheduler({
    getCoreDirectory: () => '/tmp/test',
    executeAgentTurn: vi.fn().mockResolvedValue(undefined),
    notifyRenderer: vi.fn(),
  });
}

function createSchedulerWithDeps(Scheduler: Awaited<ReturnType<typeof loadScheduler>>) {
  const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
  const scheduler = new Scheduler({
    getCoreDirectory: () => '/tmp/test',
    executeAgentTurn,
    notifyRenderer: vi.fn(),
  });
  return { scheduler, executeAgentTurn };
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

describe('AutomationScheduler.runNow finishLine propagation', () => {
  it('seeds session.finishLine from automation.finishLine via incrementalSessionStore', async () => {
    const Scheduler = await loadScheduler();
    const scheduler = createScheduler(Scheduler);
    mockResolvedAutomationFile(scheduler);

    const definition = scheduler.upsertDefinition({
      name: 'Finish line automation',
      filePath: '/test/automation.md',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
      finishLine: 'The brief is ready to send',
    });
    expect(definition.finishLine).toBe('The brief is ready to send');

    const run = await scheduler.runNow(definition.id);
    expect(run).not.toBeNull();

    const seedCall = mockUpdateSession.mock.calls.find(([sessionId]) =>
      typeof sessionId === 'string' && sessionId.startsWith('automation-'),
    );
    expect(seedCall).toBeDefined();
    const [seededSessionId, seedMutator] = seedCall!;
    const seeded = seedMutator(null) as AgentSession | null;
    expect(seeded).toMatchObject({
      id: seededSessionId,
      origin: 'automation',
      automationId: definition.id,
      finishLine: 'The brief is ready to send',
    });
  });

  it('does not seed finishLine when automation.finishLine is unset', async () => {
    const Scheduler = await loadScheduler();
    const scheduler = createScheduler(Scheduler);
    mockResolvedAutomationFile(scheduler);

    const definition = scheduler.upsertDefinition({
      name: 'Plain automation',
      filePath: '/test/automation.md',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
    });
    expect(definition.finishLine).toBeUndefined();

    mockUpdateSession.mockClear();

    await scheduler.runNow(definition.id);

    for (const call of mockUpdateSession.mock.calls) {
      const seeded = call[1](null) as AgentSession | null;
      if (seeded) {
        expect(seeded.finishLine).toBeUndefined();
      }
    }
  });

  it('does not seed when automation.finishLine is whitespace-only (normalized to undefined)', async () => {
    const Scheduler = await loadScheduler();
    const scheduler = createScheduler(Scheduler);
    mockResolvedAutomationFile(scheduler);

    const definition = scheduler.upsertDefinition({
      name: 'Whitespace automation',
      filePath: '/test/automation.md',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
      finishLine: '   \n\t  ',
    });
    expect(definition.finishLine).toBeUndefined();

    mockUpdateSession.mockClear();

    await scheduler.runNow(definition.id);

    for (const call of mockUpdateSession.mock.calls) {
      const seeded = call[1](null) as AgentSession | null;
      if (seeded) {
        expect(seeded.finishLine).toBeUndefined();
      }
    }
  });

  it('preserves an existing session.finishLine (user-edited value wins over automation seed)', async () => {
    const Scheduler = await loadScheduler();
    const scheduler = createScheduler(Scheduler);
    mockResolvedAutomationFile(scheduler);

    const definition = scheduler.upsertDefinition({
      name: 'Edited automation',
      filePath: '/test/automation.md',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
      finishLine: 'Automation-level criterion',
    });

    const existingSession: AgentSession = {
      id: 'automation-existing-1',
      title: 'Existing session',
      createdAt: 1_000,
      updatedAt: 2_000,
      messages: [],
      eventsByTurn: {},
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      resolvedAt: null,
      origin: 'automation',
      automationId: definition.id,
      finishLine: 'User-edited criterion',
    };

    mockUpdateSession.mockImplementation(async (
      _sessionId: string,
      mutator: (existing: AgentSession | null) => AgentSession | null,
    ) => {
      const result = mutator(existingSession);
      return result !== null;
    });

    await scheduler.runNow(definition.id);

    const seedCall = mockUpdateSession.mock.calls.find(([sessionId]) =>
      typeof sessionId === 'string' && sessionId.startsWith('automation-'),
    );
    expect(seedCall).toBeDefined();
    const [, seedMutator] = seedCall!;
    expect(seedMutator(existingSession)).toBeNull();
  });

  it('seeds automation.finishLine onto an existing session that has no finishLine yet', async () => {
    const Scheduler = await loadScheduler();
    const scheduler = createScheduler(Scheduler);
    mockResolvedAutomationFile(scheduler);

    const definition = scheduler.upsertDefinition({
      name: 'Seeding automation',
      filePath: '/test/automation.md',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
      finishLine: 'Automation-level criterion',
    });

    const priorSession: AgentSession = {
      id: 'automation-existing-2',
      title: 'Prior session',
      createdAt: 1_000,
      updatedAt: 2_000,
      messages: [],
      eventsByTurn: {},
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      resolvedAt: null,
      origin: 'automation',
      automationId: definition.id,
    };

    mockUpdateSession.mockImplementation(async (
      _sessionId: string,
      mutator: (existing: AgentSession | null) => AgentSession | null,
    ) => {
      const result = mutator(priorSession);
      return result !== null;
    });

    await scheduler.runNow(definition.id);

    const seedCall = mockUpdateSession.mock.calls.find(([sessionId]) =>
      typeof sessionId === 'string' && sessionId.startsWith('automation-'),
    );
    expect(seedCall).toBeDefined();
    const [, seedMutator] = seedCall!;
    const merged = seedMutator(priorSession) as AgentSession | null;
    expect(merged).toMatchObject({
      id: priorSession.id,
      finishLine: 'Automation-level criterion',
    });
    expect(merged?.title).toBe('Prior session');
  });

  it('seeds session.finishLine BEFORE executeAgentTurn and does not pass finishLine in turn options', async () => {
    const Scheduler = await loadScheduler();
    const { scheduler, executeAgentTurn } = createSchedulerWithDeps(Scheduler);
    mockResolvedAutomationFile(scheduler);

    const callOrder: string[] = [];
    mockUpdateSession.mockImplementation(async (
      sessionId: string,
      mutator: (existing: AgentSession | null) => AgentSession | null,
    ) => {
      if (sessionId.startsWith('automation-')) {
        callOrder.push('seedFinishLine');
      }
      mutator(null);
      return true;
    });
    executeAgentTurn.mockImplementation(async () => {
      callOrder.push('executeAgentTurn');
    });

    const definition = scheduler.upsertDefinition({
      name: 'Ordering automation',
      filePath: '/test/automation.md',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
      finishLine: 'Order matters',
    });

    await scheduler.runNow(definition.id);

    const seedIndex = callOrder.indexOf('seedFinishLine');
    const executeIndex = callOrder.indexOf('executeAgentTurn');
    expect(seedIndex).toBeGreaterThanOrEqual(0);
    expect(executeIndex).toBeGreaterThanOrEqual(0);
    expect(seedIndex).toBeLessThan(executeIndex);

    expect(executeAgentTurn).toHaveBeenCalledTimes(1);
    const [, , options] = executeAgentTurn.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(options).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(options, 'finishLine')).toBe(false);
  });
});
