import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppSettings } from '@shared/types';
import type { MemoryUpdateDeps, TurnContext } from '../memoryUpdateService';

const mockTrack = vi.fn();

 
vi.mock('@core/tracking', () => ({
  getTracker: () => ({
    track: mockTrack,
    identify: vi.fn(),
    getAnonymousId: () => 'test-anonymous-id',
    isAvailable: () => false,
  }),
}));

const RESULT_TEXT = '- Updated [Chief of Staff](Chief-of-Staff/memory/topics/test.md): Saved useful detail';

type ErrorEvent = Extract<AgentEvent, { type: 'error' }>;
type ToolEvent = Extract<AgentEvent, { type: 'tool' }>;
type ResultEvent = Extract<AgentEvent, { type: 'result' }>;

function makeContext(): TurnContext {
  return {
    originalTurnId: 'original-turn-1',
    originalSessionId: 'session-1',
    userPrompt: 'Remember this.',
    messages: [],
    eventsByTurn: {},
  };
}

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    coreDirectory: '/tmp/rebel-core',
    memoryUpdateEnabled: true,
    ...overrides,
  } as AppSettings;
}

function tool(toolName: string, stage: ToolEvent['stage'] = 'end'): ToolEvent {
  return {
    type: 'tool',
    toolName,
    stage,
    detail: `${toolName} ${stage}`,
    timestamp: Date.now(),
  };
}

function transientError(overrides: Partial<Omit<ErrorEvent, 'type' | 'error' | 'timestamp'>> = {}): ErrorEvent {
  return {
    type: 'error',
    error: 'Connection error.',
    isTransient: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

function errorEvent(error: string, overrides: Partial<Omit<ErrorEvent, 'type' | 'error' | 'timestamp'>> = {}): ErrorEvent {
  return {
    type: 'error',
    error,
    timestamp: Date.now(),
    ...overrides,
  };
}

function resultEvent(): ResultEvent {
  return {
    type: 'result',
    text: RESULT_TEXT,
    timestamp: Date.now(),
  };
}

async function flushMemoryUpdate(): Promise<void> {
  await vi.runAllTimersAsync();
  await Promise.resolve();
}

function setupDeps(attemptEvents: AgentEvent[][], settings: AppSettings = makeSettings()) {
  const executeAgentTurn = vi.fn<MemoryUpdateDeps['executeAgentTurn']>(async (_turnId, _prompt, options) => {
    const attemptIndex = executeAgentTurn.mock.calls.length - 1;
    for (const event of attemptEvents[attemptIndex] ?? []) {
      options.onEvent(event);
    }
  });
  const broadcastMemoryUpdateStatus = vi.fn<MemoryUpdateDeps['broadcastMemoryUpdateStatus']>();
  const deps: MemoryUpdateDeps = {
    executeAgentTurn,
    getSettings: vi.fn(() => settings),
    broadcastMemoryUpdateStatus,
  };
  return { deps, executeAgentTurn, broadcastMemoryUpdateStatus };
}

function terminalStatuses(broadcastMemoryUpdateStatus: ReturnType<typeof vi.fn>) {
  return broadcastMemoryUpdateStatus.mock.calls
    .map(([status]) => status.status)
    .filter((status) => status !== 'running');
}

describe('memoryUpdateService retry wrapper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function importService() {
    return import('../memoryUpdateService');
  }

  it('retries on transient error after only reads and then succeeds', async () => {
    const { deps, executeAgentTurn, broadcastMemoryUpdateStatus } = setupDeps([
      [tool('Read', 'start'), tool('Read', 'end'), transientError()],
      [resultEvent()],
    ]);
    const { initializeMemoryUpdateService, triggerMemoryUpdate } = await importService();
    initializeMemoryUpdateService(deps);

    await triggerMemoryUpdate(makeContext());
    await flushMemoryUpdate();

    expect(executeAgentTurn).toHaveBeenCalledTimes(2);
    expect(terminalStatuses(broadcastMemoryUpdateStatus)).toEqual(['success']);
  });

  it('retries the triggering incident shape and emits a single success', async () => {
    const { deps, executeAgentTurn, broadcastMemoryUpdateStatus } = setupDeps([
      [
        tool('MissionSet', 'start'),
        tool('MissionSet', 'end'),
        tool('Read', 'start'),
        tool('Read', 'end'),
        tool('Read', 'start'),
        tool('Read', 'end'),
        tool('SearchFiles', 'start'),
        tool('SearchFiles', 'end'),
        transientError(),
      ],
      [resultEvent()],
    ]);
    const { initializeMemoryUpdateService, triggerMemoryUpdate } = await importService();
    initializeMemoryUpdateService(deps);

    await triggerMemoryUpdate(makeContext());
    await flushMemoryUpdate();

    expect(executeAgentTurn).toHaveBeenCalledTimes(2);
    expect(executeAgentTurn.mock.calls[0][0]).not.toBe(executeAgentTurn.mock.calls[1][0]);
    expect(executeAgentTurn.mock.calls[0][2].sessionId).not.toBe(executeAgentTurn.mock.calls[1][2].sessionId);
    expect(terminalStatuses(broadcastMemoryUpdateStatus)).toEqual(['success']);
  });

  it('does not retry when a write tool fired', async () => {
    const { deps, executeAgentTurn, broadcastMemoryUpdateStatus } = setupDeps([
      [tool('Read'), tool('Edit', 'start'), transientError()],
    ]);
    const { initializeMemoryUpdateService, triggerMemoryUpdate } = await importService();
    initializeMemoryUpdateService(deps);

    await triggerMemoryUpdate(makeContext());
    await flushMemoryUpdate();

    expect(executeAgentTurn).toHaveBeenCalledTimes(1);
    expect(terminalStatuses(broadcastMemoryUpdateStatus)).toEqual(['error']);
  });

  it('keeps write activity latched after later read tools', async () => {
    const { deps, executeAgentTurn, broadcastMemoryUpdateStatus } = setupDeps([
      [tool('Read'), tool('Edit', 'start'), tool('Read'), transientError()],
    ]);
    const { initializeMemoryUpdateService, triggerMemoryUpdate } = await importService();
    initializeMemoryUpdateService(deps);

    await triggerMemoryUpdate(makeContext());
    await flushMemoryUpdate();

    expect(executeAgentTurn).toHaveBeenCalledTimes(1);
    expect(terminalStatuses(broadcastMemoryUpdateStatus)).toEqual(['error']);
  });

  it("does not retry billing errors even if the message text looks retryable", async () => {
    const { deps, executeAgentTurn, broadcastMemoryUpdateStatus } = setupDeps([
      [tool('Read'), errorEvent('Connection error.', { errorKind: 'billing' })],
    ]);
    const { initializeMemoryUpdateService, triggerMemoryUpdate } = await importService();
    initializeMemoryUpdateService(deps);

    await triggerMemoryUpdate(makeContext());
    await flushMemoryUpdate();

    expect(executeAgentTurn).toHaveBeenCalledTimes(1);
    expect(terminalStatuses(broadcastMemoryUpdateStatus)).toEqual(['error']);
  });

  it('surfaces an error after the retry budget is exhausted', async () => {
    const { deps, executeAgentTurn, broadcastMemoryUpdateStatus } = setupDeps([
      [tool('Read'), transientError()],
      [tool('Read'), transientError()],
      [tool('Read'), transientError()],
    ]);
    const { initializeMemoryUpdateService, triggerMemoryUpdate } = await importService();
    initializeMemoryUpdateService(deps);

    await triggerMemoryUpdate(makeContext());
    await flushMemoryUpdate();

    expect(executeAgentTurn).toHaveBeenCalledTimes(3);
    expect(terminalStatuses(broadcastMemoryUpdateStatus)).toEqual(['error']);
  });

  it('does not retry when an unknown MCP tool fired', async () => {
    const { deps, executeAgentTurn, broadcastMemoryUpdateStatus } = setupDeps([
      [tool('mcp__GoogleWorkspace__send_email', 'start'), transientError()],
    ]);
    const { initializeMemoryUpdateService, triggerMemoryUpdate } = await importService();
    initializeMemoryUpdateService(deps);

    await triggerMemoryUpdate(makeContext());
    await flushMemoryUpdate();

    expect(executeAgentTurn).toHaveBeenCalledTimes(1);
    expect(terminalStatuses(broadcastMemoryUpdateStatus)).toEqual(['error']);
  });

  it('aborts pending retry when settings are disabled mid-backoff', async () => {
    const enabledSettings = makeSettings();
    const disabledSettings = makeSettings({ memoryUpdateEnabled: false });
    let settingsRef = enabledSettings;
    const executeAgentTurn = vi.fn<MemoryUpdateDeps['executeAgentTurn']>(async (_turnId, _prompt, options) => {
      const attemptIndex = executeAgentTurn.mock.calls.length - 1;
      const events = attemptIndex === 0
        ? [tool('Read'), transientError()]
        : [resultEvent()];
      for (const event of events) options.onEvent(event);
    });
    const broadcastMemoryUpdateStatus = vi.fn<MemoryUpdateDeps['broadcastMemoryUpdateStatus']>();
    const getSettings = vi.fn(() => settingsRef);
    const deps: MemoryUpdateDeps = {
      executeAgentTurn,
      getSettings,
      broadcastMemoryUpdateStatus,
    };
    const { initializeMemoryUpdateService, triggerMemoryUpdate } = await importService();
    initializeMemoryUpdateService(deps);

    const promise = triggerMemoryUpdate(makeContext());
    // Run the first attempt's microtask + reach the backoff sleep.
    await Promise.resolve();
    await Promise.resolve();
    // User disables memory updates while we're sleeping.
    settingsRef = disabledSettings;
    await flushMemoryUpdate();
    await promise;

    expect(executeAgentTurn).toHaveBeenCalledTimes(1);
    expect(terminalStatuses(broadcastMemoryUpdateStatus)).toEqual(['error']);
  });
});
