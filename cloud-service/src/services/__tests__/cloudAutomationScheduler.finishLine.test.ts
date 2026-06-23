import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, AutomationDefinition } from '@shared/types';
import { AutomationSchedule } from '@shared/utils/automationSchedule';

const mockUpdateSession = vi.fn();

vi.mock('@shared/utils/automationScheduling', () => ({
  calculateNextRunAt: vi.fn(),
}));

vi.mock('../cloudAutomationPrompt', () => ({
  readAutomationPrompt: vi.fn().mockResolvedValue('Test automation prompt'),
}));

vi.mock('@core/services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({
    updateSession: mockUpdateSession,
  }),
}));

import { calculateNextRunAt } from '@shared/utils/automationScheduling';
import {
  CloudAutomationScheduler,
  type CloudAutomationSchedulerDeps,
} from '../cloudAutomationScheduler';

const mockCalculateNextRunAt = vi.mocked(calculateNextRunAt);

function createDefinition(
  id: string,
  overrides: Partial<AutomationDefinition> = {},
): AutomationDefinition {
  return {
    id,
    name: `Automation ${id}`,
    filePath: `/tmp/${id}.md`,
    schedule: AutomationSchedule.daily({ time: '09:00' }),
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    executeIn: 'cloud',
    timezone: 'UTC',
    ...overrides,
  };
}

function createSchedulerContext(initialDefinitions: AutomationDefinition[]) {
  let definitions = initialDefinitions;
  const getDefinitions = vi.fn(() => definitions);
  const executeAgentTurn = vi
    .fn<CloudAutomationSchedulerDeps['executeAgentTurn']>()
    .mockResolvedValue(undefined);
  const recordRun = vi.fn();
  const updateDefinitionNextRunAt = vi.fn();

  const scheduler = new CloudAutomationScheduler({
    getDefinitions,
    executeAgentTurn,
    store: {
      recordRun,
      updateDefinitionNextRunAt,
    } as unknown as CloudAutomationSchedulerDeps['store'],
  });

  return {
    scheduler,
    getDefinitions,
    executeAgentTurn,
    recordRun,
    updateDefinitionNextRunAt,
    setDefinitions: (nextDefinitions: AutomationDefinition[]) => {
      definitions = nextDefinitions;
    },
  };
}

describe('CloudAutomationScheduler finishLine seeding', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T08:00:00.000Z'));
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockCalculateNextRunAt.mockImplementation(() => Date.now() + 60_000);
    mockUpdateSession.mockImplementation(async (
      _sessionId: string,
      mutator: (existing: AgentSession | null) => AgentSession | null,
    ) => {
      mutator(null);
      return true;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('seeds session.finishLine when automation.finishLine is set and session does not yet exist', async () => {
    const definition = createDefinition('cloud-fl-shell', {
      systemType: 'source-capture',
      finishLine: 'The brief is ready to send',
    });
    const { scheduler, executeAgentTurn } = createSchedulerContext([definition]);

    mockCalculateNextRunAt
      .mockReturnValueOnce(Date.now() + 5)
      .mockReturnValueOnce(Date.now() + 60_000);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(5);

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

    expect(executeAgentTurn).toHaveBeenCalledTimes(1);
    const [, , options] = executeAgentTurn.mock.calls[0] as Parameters<
      CloudAutomationSchedulerDeps['executeAgentTurn']
    >;
    expect(options.sessionId).toBe(seededSessionId);
    expect((options as Record<string, unknown>).finishLine).toBeUndefined();
  });

  it('omits finishLine seeding when automation.finishLine is unset', async () => {
    const definition = createDefinition('cloud-fl-none');
    const { scheduler, executeAgentTurn } = createSchedulerContext([definition]);

    mockCalculateNextRunAt
      .mockReturnValueOnce(Date.now() + 5)
      .mockReturnValueOnce(Date.now() + 60_000);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(5);

    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(executeAgentTurn).toHaveBeenCalledTimes(1);
    const [, , options] = executeAgentTurn.mock.calls[0] as Parameters<
      CloudAutomationSchedulerDeps['executeAgentTurn']
    >;
    expect((options as Record<string, unknown>).finishLine).toBeUndefined();
  });

  it('omits finishLine seeding when automation.finishLine is whitespace-only', async () => {
    const definition = createDefinition('cloud-fl-whitespace', {
      finishLine: '   \n\t  ',
    });
    const { scheduler, executeAgentTurn } = createSchedulerContext([definition]);

    mockCalculateNextRunAt
      .mockReturnValueOnce(Date.now() + 5)
      .mockReturnValueOnce(Date.now() + 60_000);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(5);

    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(executeAgentTurn).toHaveBeenCalledTimes(1);
    const [, , options] = executeAgentTurn.mock.calls[0] as Parameters<
      CloudAutomationSchedulerDeps['executeAgentTurn']
    >;
    expect((options as Record<string, unknown>).finishLine).toBeUndefined();
  });

  it('preserves an existing session.finishLine (user-edited value wins over automation seed)', async () => {
    const definition = createDefinition('cloud-fl-preserve', {
      finishLine: 'Automation-level criterion',
    });
    const { scheduler } = createSchedulerContext([definition]);

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

    mockCalculateNextRunAt
      .mockReturnValueOnce(Date.now() + 5)
      .mockReturnValueOnce(Date.now() + 60_000);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(5);

    const seedCall = mockUpdateSession.mock.calls.find(([sessionId]) =>
      typeof sessionId === 'string' && sessionId.startsWith('automation-'),
    );
    expect(seedCall).toBeDefined();
    const [, seedMutator] = seedCall!;
    expect(seedMutator(existingSession)).toBeNull();
  });

  it('seeds automation.finishLine onto an existing session that has no finishLine yet', async () => {
    const definition = createDefinition('cloud-fl-merge', {
      finishLine: 'Automation-level criterion',
    });
    const { scheduler } = createSchedulerContext([definition]);

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

    mockCalculateNextRunAt
      .mockReturnValueOnce(Date.now() + 5)
      .mockReturnValueOnce(Date.now() + 60_000);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(5);

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

  it('seeds onto the session BEFORE executeAgentTurn is called', async () => {
    const definition = createDefinition('cloud-fl-ordering', {
      finishLine: 'Order matters',
    });
    const { scheduler, executeAgentTurn } = createSchedulerContext([definition]);

    const callOrder: string[] = [];
    mockUpdateSession.mockImplementation(async (
      _sessionId: string,
      mutator: (existing: AgentSession | null) => AgentSession | null,
    ) => {
      callOrder.push('updateSession');
      mutator(null);
      return true;
    });
    executeAgentTurn.mockImplementation(async () => {
      callOrder.push('executeAgentTurn');
    });

    mockCalculateNextRunAt
      .mockReturnValueOnce(Date.now() + 5)
      .mockReturnValueOnce(Date.now() + 60_000);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(5);

    expect(callOrder).toEqual(['updateSession', 'executeAgentTurn']);
  });
});
