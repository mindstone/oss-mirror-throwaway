import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AutomationDefinition } from '@shared/types';
import { AutomationSchedule } from '@shared/utils/automationSchedule';
import { clearAutomationScripts, registerAutomationScript } from '@core/services/automations/scriptRegistry';
import type { ProviderCredentialState } from '@core/utils/validateProviderCredentials';
import { apiRateLimitCooldown } from '@core/services/apiRateLimitCooldown';

vi.mock('@shared/utils/automationScheduling', () => ({
  calculateNextRunAt: vi.fn(),
}));

vi.mock('../cloudAutomationPrompt', () => ({
  readAutomationPrompt: vi.fn().mockResolvedValue('Test automation prompt'),
}));

import { calculateNextRunAt } from '@shared/utils/automationScheduling';
import { readAutomationPrompt } from '../cloudAutomationPrompt';
import {
  CloudAutomationScheduler,
  type CloudAutomationSchedulerDeps,
} from '../cloudAutomationScheduler';

const mockCalculateNextRunAt = vi.mocked(calculateNextRunAt);
const mockReadAutomationPrompt = vi.mocked(readAutomationPrompt);

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

function getTimers(
  scheduler: CloudAutomationScheduler,
): Map<string, NodeJS.Timeout> {
  return (
    scheduler as unknown as { timers: Map<string, NodeJS.Timeout> }
  ).timers;
}

function getRunning(scheduler: CloudAutomationScheduler): Set<string> {
  return (scheduler as unknown as { running: Set<string> }).running;
}

function createSchedulerContext(initialDefinitions: AutomationDefinition[]) {
  let definitions = initialDefinitions;
  let providerCredentialState: ProviderCredentialState | null = null;
  const getDefinitions = vi.fn(() => definitions);
  const executeAgentTurn = vi
    .fn<CloudAutomationSchedulerDeps['executeAgentTurn']>()
    .mockResolvedValue(undefined);
  const recordRun = vi.fn();
  const updateDefinitionNextRunAt = vi.fn();

  const scheduler = new CloudAutomationScheduler({
    getDefinitions,
    getProviderCredentialState: () => providerCredentialState,
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
    setProviderCredentialState: (nextState: ProviderCredentialState | null) => {
      providerCredentialState = nextState;
    },
  };
}

const staleCases: Array<{
  label: string;
  mutate: (definition: AutomationDefinition) => AutomationDefinition;
}> = [
  {
    label: 'local',
    mutate: (definition) => ({ ...definition, executeIn: 'local' }),
  },
  {
    label: 'disabled',
    mutate: (definition) => ({ ...definition, enabled: false }),
  },
];

describe('CloudAutomationScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T08:00:00.000Z'));
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockCalculateNextRunAt.mockImplementation(() => Date.now() + 60_000);
    mockReadAutomationPrompt.mockResolvedValue('Test automation prompt');
    vi.spyOn(apiRateLimitCooldown, 'isAvailable').mockReturnValue(true);
    vi.spyOn(apiRateLimitCooldown, 'remainingMs').mockReturnValue(0);
  });

  afterEach(() => {
    clearAutomationScripts();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('start() schedules only enabled cloud timer-based definitions', () => {
    const cloudDefinition = createDefinition('cloud-enabled');
    const disabledCloudDefinition = createDefinition('cloud-disabled', {
      enabled: false,
    });
    const localDefinition = createDefinition('local-enabled', {
      executeIn: 'local',
    });
    const eventCloudDefinition = createDefinition('cloud-event', {
      schedule: AutomationSchedule.event({ eventType: 'transcript-ready' }),
    });

    const { scheduler } = createSchedulerContext([
      cloudDefinition,
      disabledCloudDefinition,
      localDefinition,
      eventCloudDefinition,
    ]);

    scheduler.start();

    expect(mockCalculateNextRunAt).toHaveBeenCalledTimes(1);
    expect(mockCalculateNextRunAt).toHaveBeenCalledWith(
      cloudDefinition,
      expect.any(Number),
      cloudDefinition.timezone,
    );
    expect(getTimers(scheduler).size).toBe(1);
    expect(getTimers(scheduler).has(cloudDefinition.id)).toBe(true);
    expect(getTimers(scheduler).has(disabledCloudDefinition.id)).toBe(false);
    expect(getTimers(scheduler).has(localDefinition.id)).toBe(false);
    expect(getTimers(scheduler).has(eventCloudDefinition.id)).toBe(false);
  });

  it('stop() clears all timers', () => {
    const definitionA = createDefinition('cloud-a');
    const definitionB = createDefinition('cloud-b');
    const { scheduler } = createSchedulerContext([definitionA, definitionB]);

    scheduler.start();
    expect(vi.getTimerCount()).toBe(2);

    scheduler.stop();

    expect(vi.getTimerCount()).toBe(0);
    expect(getTimers(scheduler).size).toBe(0);
  });

  it('onDefinitionsChanged() reschedules timers using updated definitions', () => {
    const originalDefinition = createDefinition('cloud-original');
    const updatedDefinition = createDefinition('cloud-updated');
    const { scheduler } = createSchedulerContext([originalDefinition]);

    scheduler.start();
    expect(getTimers(scheduler).has(originalDefinition.id)).toBe(true);

    scheduler.onDefinitionsChanged([updatedDefinition]);

    expect(getTimers(scheduler).size).toBe(1);
    expect(getTimers(scheduler).has(originalDefinition.id)).toBe(false);
    expect(getTimers(scheduler).has(updatedDefinition.id)).toBe(true);
  });

  it('onDefinitionsChanged() cancels timers for removed/disabled definitions', () => {
    const removedDefinition = createDefinition('cloud-removed');
    const disabledDefinition = createDefinition('cloud-disabled', {
      enabled: false,
    });
    const { scheduler } = createSchedulerContext([
      removedDefinition,
      createDefinition('cloud-kept'),
    ]);

    scheduler.start();
    expect(getTimers(scheduler).size).toBe(2);

    scheduler.onDefinitionsChanged([disabledDefinition]);

    expect(getTimers(scheduler).size).toBe(0);
    expect(getTimers(scheduler).has(removedDefinition.id)).toBe(false);
    expect(getTimers(scheduler).has(disabledDefinition.id)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('X2 executes registered cloud scripts without creating an agent session', async () => {
    const scriptFn = vi.fn(async () => ({ summary: 'ok' }));
    registerAutomationScript('cloud-test-script', scriptFn);
    const definition = createDefinition('cloud-script-success', {
      executor: 'script',
      scriptModule: 'cloud-test-script',
    });
    const { scheduler, executeAgentTurn, recordRun } = createSchedulerContext([definition]);

    mockCalculateNextRunAt
      .mockReturnValueOnce(Date.now() + 5)
      .mockReturnValueOnce(Date.now() + 60_000);

    scheduler.start();
    await vi.advanceTimersToNextTimerAsync();

    expect(executeAgentTurn).not.toHaveBeenCalled();
    expect(scriptFn).toHaveBeenCalledTimes(1);
    expect(scriptFn).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.any(String),
        trigger: 'scheduled',
      }),
    );
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: definition.id,
        status: 'success',
        trigger: 'schedule',
        sessionId: null,
        error: null,
      }),
    );
  });

  it('X3-cloud records a persisted failure run when a cloud script is not registered', () => {
    const moduleId = 'missing-cloud-script';
    const definition = createDefinition('cloud-script-missing', {
      executor: 'script',
      scriptModule: moduleId,
    });
    const { scheduler, executeAgentTurn, recordRun } = createSchedulerContext([definition]);

    scheduler.start();

    expect(executeAgentTurn).not.toHaveBeenCalled();
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: definition.id,
        status: 'failure',
        trigger: 'schedule',
        sessionId: null,
        error: `No automation script is registered for "${moduleId}".`,
      }),
    );
    expect(getTimers(scheduler).size).toBe(0);
    expect(mockCalculateNextRunAt).not.toHaveBeenCalled();
    // The structured logger writes via createScopedLogger now (BUG 10);
    // the failure-run recordRun assertion above already proves the error
    // message ("No automation script is registered for ...") propagates.
  });

  it('X3-onChange persists failure run when onDefinitionsChanged adds an unregistered script', () => {
    const { scheduler, recordRun } = createSchedulerContext([]);

    scheduler.start();

    const unregisteredScript = createDefinition('cloud-unregistered', {
      executor: 'script',
      scriptModule: 'never.registered',
    });

    scheduler.onDefinitionsChanged([unregisteredScript]);

    expect(recordRun).toHaveBeenCalledTimes(1);
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: unregisteredScript.id,
        status: 'failure',
        error: 'No automation script is registered for "never.registered".',
        sessionId: null,
        trigger: 'schedule',
      }),
    );
    expect(getTimers(scheduler).size).toBe(0);
  });

  it('X5 fails closed on malformed cloud executors with the desktop-parity error text', async () => {
    const definition = createDefinition('cloud-mystery', {
      executor: 'mystery' as any,
    });
    const { scheduler, executeAgentTurn, recordRun } = createSchedulerContext([definition]);

    mockCalculateNextRunAt
      .mockReturnValueOnce(Date.now() + 5)
      .mockReturnValueOnce(Date.now() + 60_000);

    scheduler.start();
    await vi.advanceTimersToNextTimerAsync();

    expect(executeAgentTurn).not.toHaveBeenCalled();
    expect(mockReadAutomationPrompt).not.toHaveBeenCalled();
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: definition.id,
        status: 'failure',
        trigger: 'schedule',
        sessionId: null,
        error: 'Unknown executor: mystery',
      }),
    );
  });

  it('X-RACE records a failure when a script unregisters after scheduling but before execution', async () => {
    const moduleId = 'cloud-race-script';
    const unregister = registerAutomationScript(moduleId, async () => ({ summary: 'ok' }));
    const definition = createDefinition('cloud-race', {
      executor: 'script',
      scriptModule: moduleId,
    });
    const { scheduler, executeAgentTurn, recordRun } = createSchedulerContext([definition]);

    mockCalculateNextRunAt
      .mockReturnValueOnce(Date.now() + 5)
      .mockReturnValueOnce(Date.now() + 60_000);

    scheduler.start();
    expect(getTimers(scheduler).size).toBe(1);

    unregister();
    await vi.advanceTimersByTimeAsync(5);

    expect(executeAgentTurn).not.toHaveBeenCalled();
    expect(recordRun).toHaveBeenCalledTimes(1);
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: definition.id,
        status: 'failure',
        trigger: 'schedule',
        sessionId: null,
        error: `No automation script is registered for "${moduleId}".`,
      }),
    );
    expect(getTimers(scheduler).size).toBe(0);
  });

  it('executes agent turn with prompt/session/model overrides, records run, and reschedules', async () => {
    const definition = createDefinition('cloud-success', {
      systemType: 'source-capture',
      model: 'claude-sonnet-4-5',
      thinkingModel: 'claude-opus-4-1',
    });
    const { scheduler, executeAgentTurn, recordRun } = createSchedulerContext([
      definition,
    ]);

    mockCalculateNextRunAt
      .mockReturnValueOnce(Date.now() + 5)
      .mockReturnValueOnce(Date.now() + 60_000);

    scheduler.start();
    await vi.advanceTimersToNextTimerAsync();

    expect(mockReadAutomationPrompt).toHaveBeenCalledWith(definition);
    expect(executeAgentTurn).toHaveBeenCalledTimes(1);

    const [turnId, prompt, options] = executeAgentTurn.mock
      .calls[0] as Parameters<CloudAutomationSchedulerDeps['executeAgentTurn']>;
    expect(typeof turnId).toBe('string');
    expect(prompt).toBe('Test automation prompt');
    expect(options.sessionId).toMatch(/^automation-source-capture--/);
    expect(options.modelOverride).toBe('claude-sonnet-4-5');
    expect(options.thinkingModelOverride).toBe('claude-opus-4-1');
    expect(typeof options.onEvent).toBe('function');

    expect(recordRun).toHaveBeenCalledTimes(1);
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: definition.id,
        status: 'success',
        trigger: 'schedule',
        sessionId: options.sessionId,
        error: null,
      }),
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(mockCalculateNextRunAt).toHaveBeenCalledTimes(2);
  });

  it('records failure when execution throws', async () => {
    const definition = createDefinition('cloud-failure');
    const { scheduler, executeAgentTurn, recordRun } = createSchedulerContext([
      definition,
    ]);

    executeAgentTurn.mockRejectedValueOnce(new Error('agent crashed'));
    mockCalculateNextRunAt
      .mockReturnValueOnce(Date.now() + 5)
      .mockReturnValueOnce(Date.now() + 60_000);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(5);

    expect(executeAgentTurn).toHaveBeenCalledTimes(1);
    expect(recordRun).toHaveBeenCalledTimes(1);
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: definition.id,
        status: 'failure',
        error: 'agent crashed',
      }),
    );
    expect(getTimers(scheduler).has(definition.id)).toBe(true);
  });

  it('records errorKind and bounded rawError from error events', async () => {
    const definition = createDefinition('cloud-error-metadata');
    const longRawError = 'x'.repeat(260);
    const { scheduler, executeAgentTurn, recordRun } = createSchedulerContext([
      definition,
    ]);

    executeAgentTurn.mockImplementationOnce(async (_turnId, _prompt, options) => {
      options.onEvent({
        type: 'error',
        error: "Your AI provider's rate limit was reached.",
        errorKind: 'rate_limit',
        rawError: longRawError,
        errorSource: 'main',
        timestamp: Date.now(),
      } as AgentEvent);
      throw new Error('agent crashed');
    });
    mockCalculateNextRunAt
      .mockReturnValueOnce(Date.now() + 5)
      .mockReturnValueOnce(Date.now() + 60_000);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(5);

    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: definition.id,
        status: 'failure',
        error: 'agent crashed',
        errorKind: 'rate_limit',
        rawError: longRawError.slice(0, 200),
      }),
    );
  });

  it('defers cooldown and retries the same scheduled occurrence', async () => {
    const isAvailableMock = vi.mocked(apiRateLimitCooldown.isAvailable)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const remainingMock = vi.mocked(apiRateLimitCooldown.remainingMs).mockReturnValue(30_000);

    try {
      const definition = createDefinition('cloud-cooldown-same-occurrence');
      const { scheduler, executeAgentTurn, recordRun } = createSchedulerContext([definition]);

      mockCalculateNextRunAt
        .mockReturnValueOnce(Date.now() + 5)
        .mockReturnValueOnce(Date.now() + 60_000)
        .mockReturnValueOnce(Date.now() + 120_000);

      scheduler.start();
      await vi.advanceTimersByTimeAsync(5);

      expect(executeAgentTurn).not.toHaveBeenCalled();
      expect(recordRun).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(executeAgentTurn).toHaveBeenCalledTimes(1);
      expect(recordRun).toHaveBeenCalledWith(
        expect.objectContaining({
          automationId: definition.id,
          status: 'success',
        }),
      );
    } finally {
      isAvailableMock.mockReturnValue(true);
      remainingMock.mockReturnValue(0);
    }
  });

  it('blocks cloud scheduler spawns on provider readiness with shared cause vocabulary', async () => {
    const definition = createDefinition('cloud-provider-readiness');
    const {
      scheduler,
      executeAgentTurn,
      recordRun,
      setProviderCredentialState,
    } = createSchedulerContext([definition]);

    setProviderCredentialState({ kind: 'codex', status: 'disconnected' });
    mockCalculateNextRunAt
      .mockReturnValueOnce(Date.now() + 5)
      .mockReturnValueOnce(Date.now() + 60_000);

    scheduler.start();
    await vi.advanceTimersToNextTimerAsync();

    expect(executeAgentTurn).not.toHaveBeenCalled();
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: definition.id,
        status: 'provider_not_ready',
        trigger: 'schedule',
        sessionId: null,
        errorKind: 'connection-not-configured',
        headlineClass: 'auth',
        admissionBlock: expect.objectContaining({
          source: 'provider-readiness',
          code: 'codex_disconnected',
          provider: 'codex',
        }),
      }),
      { advanceScheduleSlot: true },
    );
    expect(getTimers(scheduler).has(definition.id)).toBe(true);
  });

  it('does not provider-readiness block scheduled script automations', async () => {
    const scriptFn = vi.fn(async () => ({ summary: 'cloud script bypassed readiness gate' }));
    registerAutomationScript('cloud-readiness-script', scriptFn);
    const definition = createDefinition('cloud-script-readiness', {
      executor: 'script',
      scriptModule: 'cloud-readiness-script',
    });
    const {
      scheduler,
      executeAgentTurn,
      recordRun,
      setProviderCredentialState,
    } = createSchedulerContext([definition]);

    setProviderCredentialState({ kind: 'codex', status: 'disconnected' });
    mockCalculateNextRunAt
      .mockReturnValueOnce(Date.now() + 5)
      .mockReturnValueOnce(Date.now() + 60_000);

    scheduler.start();
    await vi.advanceTimersToNextTimerAsync();

    expect(scriptFn).toHaveBeenCalled();
    expect(executeAgentTurn).not.toHaveBeenCalled();
    const recordedStatuses = recordRun.mock.calls
      .map(([run]) => (run as { status?: string }).status)
      .filter((status): status is string => typeof status === 'string');
    expect(recordedStatuses).toContain('success');
    expect(recordedStatuses).not.toContain('provider_not_ready');
  });

  describe('all-tool-failure classification (REBEL-1BK)', () => {
    beforeEach(() => {
      vi.spyOn(apiRateLimitCooldown, 'isAvailable').mockReturnValue(true);
      vi.spyOn(apiRateLimitCooldown, 'remainingMs').mockReturnValue(0);
    });

    // These tests verify the fix for the silent automation failure bug where
    // validator-stripped parameters (e.g., maxResults vs max_results) caused
    // 100% tool-call failure but runs were marked `success`. See planning doc
    // docs/plans/260415_automation_silent_failure_fix.md.

    const completedResult = (toolMetrics: { totalToolCalls: number; failedToolCalls: number }) => ({
      type: 'result' as const,
      text: 'done',
      timestamp: Date.now(),
      toolMetrics: {
        ...toolMetrics,
        filesCreated: 0,
        filesEdited: 0,
        toolUsageByCategory: {},
        mcpServerUsage: {},
        totalToolOutputChars: 0,
        mcpToolOutputChars: 0,
        builtinToolOutputChars: 0,
      },
    });

    it('classifies as failure when every tool call failed', async () => {
      const definition = createDefinition('cloud-all-tools-failed');
      const { scheduler, executeAgentTurn, recordRun } = createSchedulerContext([
        definition,
      ]);

      executeAgentTurn.mockImplementationOnce(async (_turnId, _prompt, options) => {
        options.onEvent(completedResult({ totalToolCalls: 5, failedToolCalls: 5 }));
      });
      mockCalculateNextRunAt
        .mockReturnValueOnce(Date.now() + 5)
        .mockReturnValueOnce(Date.now() + 60_000);

      scheduler.start();
      await vi.advanceTimersToNextTimerAsync();

      expect(recordRun).toHaveBeenCalledWith(
        expect.objectContaining({
          automationId: definition.id,
          status: 'failure',
          error: "The automation couldn't complete — all 5 tool calls failed.",
        }),
      );
    });

    it('uses singular phrasing when a single tool call failed', async () => {
      const definition = createDefinition('cloud-single-tool-failed');
      const { scheduler, executeAgentTurn, recordRun } = createSchedulerContext([
        definition,
      ]);

      executeAgentTurn.mockImplementationOnce(async (_turnId, _prompt, options) => {
        options.onEvent(completedResult({ totalToolCalls: 1, failedToolCalls: 1 }));
      });
      mockCalculateNextRunAt
        .mockReturnValueOnce(Date.now() + 5)
        .mockReturnValueOnce(Date.now() + 60_000);

      scheduler.start();
      await vi.advanceTimersByTimeAsync(5);

      expect(recordRun).toHaveBeenCalledWith(
        expect.objectContaining({
          automationId: definition.id,
          status: 'failure',
          error: "The automation couldn't complete — its only tool call failed.",
        }),
      );
    });

    it('stays success when some tools failed and some succeeded', async () => {
      const definition = createDefinition('cloud-mixed');
      const { scheduler, executeAgentTurn, recordRun } = createSchedulerContext([
        definition,
      ]);

      executeAgentTurn.mockImplementationOnce(async (_turnId, _prompt, options) => {
        options.onEvent(completedResult({ totalToolCalls: 5, failedToolCalls: 2 }));
      });
      mockCalculateNextRunAt
        .mockReturnValueOnce(Date.now() + 5)
        .mockReturnValueOnce(Date.now() + 60_000);

      scheduler.start();
      await vi.advanceTimersByTimeAsync(5);

      expect(recordRun).toHaveBeenCalledWith(
        expect.objectContaining({
          automationId: definition.id,
          status: 'success',
          error: null,
        }),
      );
    });

    it('stays success when automation used zero tools', async () => {
      const definition = createDefinition('cloud-no-tools');
      const { scheduler, executeAgentTurn, recordRun } = createSchedulerContext([
        definition,
      ]);

      executeAgentTurn.mockImplementationOnce(async (_turnId, _prompt, options) => {
        options.onEvent(completedResult({ totalToolCalls: 0, failedToolCalls: 0 }));
      });
      mockCalculateNextRunAt
        .mockReturnValueOnce(Date.now() + 5)
        .mockReturnValueOnce(Date.now() + 60_000);

      scheduler.start();
      await vi.advanceTimersByTimeAsync(5);

      expect(recordRun).toHaveBeenCalledWith(
        expect.objectContaining({
          automationId: definition.id,
          status: 'success',
          error: null,
        }),
      );
    });

    it('stays success when result event has no toolMetrics', async () => {
      const definition = createDefinition('cloud-no-metrics');
      const { scheduler, executeAgentTurn, recordRun } = createSchedulerContext([
        definition,
      ]);

      executeAgentTurn.mockImplementationOnce(async (_turnId, _prompt, options) => {
        // Synthetic result with no toolMetrics (e.g., from recovery paths)
        options.onEvent({ type: 'result', text: '', timestamp: Date.now() });
      });
      mockCalculateNextRunAt
        .mockReturnValueOnce(Date.now() + 5)
        .mockReturnValueOnce(Date.now() + 60_000);

      scheduler.start();
      await vi.advanceTimersByTimeAsync(5);

      expect(recordRun).toHaveBeenCalledWith(
        expect.objectContaining({
          automationId: definition.id,
          status: 'success',
          error: null,
        }),
      );
    });

    it('thrown error takes precedence over all-tools-failed metrics', async () => {
      const definition = createDefinition('cloud-throw-after-fail');
      const { scheduler, executeAgentTurn, recordRun } = createSchedulerContext([
        definition,
      ]);

      // Simulate: onEvent captures all-tools-failed metrics, THEN turn throws
      executeAgentTurn.mockImplementationOnce(async (_turnId, _prompt, options) => {
        options.onEvent(completedResult({ totalToolCalls: 3, failedToolCalls: 3 }));
        throw new Error('network blew up');
      });
      mockCalculateNextRunAt
        .mockReturnValueOnce(Date.now() + 5)
        .mockReturnValueOnce(Date.now() + 60_000);

      scheduler.start();
      await vi.advanceTimersByTimeAsync(5);

      // The thrown error wins — run is failure with the thrown error message
      expect(recordRun).toHaveBeenCalledWith(
        expect.objectContaining({
          automationId: definition.id,
          status: 'failure',
          error: 'network blew up',
        }),
      );
    });
  });

  it('skips execution when automation is already running', async () => {
    const definition = createDefinition('cloud-running');
    const { scheduler, executeAgentTurn, recordRun } = createSchedulerContext([
      definition,
    ]);

    mockCalculateNextRunAt.mockReturnValueOnce(Date.now() + 5);

    scheduler.start();
    getRunning(scheduler).add(definition.id);

    await vi.advanceTimersByTimeAsync(5);

    expect(mockReadAutomationPrompt).not.toHaveBeenCalled();
    expect(executeAgentTurn).not.toHaveBeenCalled();
    expect(recordRun).not.toHaveBeenCalled();
  });

  it.each(staleCases)(
    're-reads definitions and skips execution when automation becomes $label',
    async ({ mutate }) => {
      const definition = createDefinition('cloud-stale');
      const {
        scheduler,
        getDefinitions,
        executeAgentTurn,
        recordRun,
        setDefinitions,
      } = createSchedulerContext([definition]);

      mockCalculateNextRunAt.mockReturnValueOnce(Date.now() + 5);

      scheduler.start();
      setDefinitions([mutate(definition)]);

      await vi.advanceTimersToNextTimerAsync();

      expect(getDefinitions.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mockReadAutomationPrompt).not.toHaveBeenCalled();
      expect(executeAgentTurn).not.toHaveBeenCalled();
      expect(recordRun).not.toHaveBeenCalled();
    },
  );
});
