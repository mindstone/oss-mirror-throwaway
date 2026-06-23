import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppSettings } from '@shared/types';
import type { MemoryUpdateDeps, TurnContext } from '../memoryUpdateService';

const mockTrack = vi.fn();
const mockUpdateSession = vi.fn<(sessionId: string, mutator: (s: unknown) => unknown) => Promise<boolean>>(async () => true);


vi.mock('@core/tracking', () => ({
  getTracker: () => ({
    track: mockTrack,
    identify: vi.fn(),
    getAnonymousId: () => 'test-anonymous-id',
    isAvailable: () => false,
  }),
}));

// Core terminal-status persistence (260619) writes through the incremental
// session store on the executing surface; mock it so we can assert WHAT gets
// persisted WHEN, without touching the filesystem.
vi.mock('../incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({ updateSession: mockUpdateSession }),
}));

type ErrorEvent = Extract<AgentEvent, { type: 'error' }>;
type ResultEvent = Extract<AgentEvent, { type: 'result' }>;

function makeContext(): TurnContext {
  return {
    originalTurnId: 'origin-turn-1',
    originalSessionId: 'origin-session-1',
    userPrompt: 'Remember this detail',
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

function resultEvent(): ResultEvent {
  return {
    type: 'result',
    text: '- Updated [Chief of Staff](Chief-of-Staff/memory/topics/test.md): Saved useful detail',
    timestamp: Date.now(),
  };
}

function errorEvent(error = 'Something failed'): ErrorEvent {
  return {
    type: 'error',
    error,
    timestamp: Date.now(),
  };
}

async function flushMemoryUpdate(): Promise<void> {
  await vi.runAllTimersAsync();
  await Promise.resolve();
}

describe('memoryUpdateService cross-session provenance', () => {
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

  it('includes originalSessionId on running + success broadcasts', async () => {
    const executeAgentTurn = vi.fn<MemoryUpdateDeps['executeAgentTurn']>(async (_turnId, _prompt, options) => {
      options.onEvent(resultEvent());
    });
    const broadcastMemoryUpdateStatus = vi.fn<MemoryUpdateDeps['broadcastMemoryUpdateStatus']>();
    const deps: MemoryUpdateDeps = {
      executeAgentTurn,
      getSettings: vi.fn(() => makeSettings()),
      broadcastMemoryUpdateStatus,
    };

    const { initializeMemoryUpdateService, triggerMemoryUpdate } = await importService();
    initializeMemoryUpdateService(deps);

    await triggerMemoryUpdate(makeContext());
    await flushMemoryUpdate();

    expect(broadcastMemoryUpdateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'running',
        originalTurnId: 'origin-turn-1',
        originalSessionId: 'origin-session-1',
      }),
    );
    expect(broadcastMemoryUpdateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        originalTurnId: 'origin-turn-1',
        originalSessionId: 'origin-session-1',
      }),
    );
  });

  it('includes originalSessionId on error broadcasts', async () => {
    const executeAgentTurn = vi.fn<MemoryUpdateDeps['executeAgentTurn']>(async (_turnId, _prompt, options) => {
      options.onEvent(errorEvent('Boom'));
    });
    const broadcastMemoryUpdateStatus = vi.fn<MemoryUpdateDeps['broadcastMemoryUpdateStatus']>();
    const deps: MemoryUpdateDeps = {
      executeAgentTurn,
      getSettings: vi.fn(() => makeSettings()),
      broadcastMemoryUpdateStatus,
    };

    const { initializeMemoryUpdateService, triggerMemoryUpdate } = await importService();
    initializeMemoryUpdateService(deps);

    await triggerMemoryUpdate(makeContext());
    await flushMemoryUpdate();

    const nonRunningPayloads = broadcastMemoryUpdateStatus.mock.calls
      .map(([status]) => status)
      .filter((status) => status.status !== 'running');

    expect(nonRunningPayloads).toHaveLength(1);
    expect(nonRunningPayloads[0]).toEqual(
      expect.objectContaining({
        status: 'error',
        originalTurnId: 'origin-turn-1',
        originalSessionId: 'origin-session-1',
      }),
    );
  });

  // 260619 cloud catch-up: the executing surface persists the TERMINAL status so a
  // client that missed the live broadcast recovers it on sync. `running` is
  // transient and must NOT be persisted.
  it('persists ONLY the terminal success status to the store (running is not persisted)', async () => {
    const executeAgentTurn = vi.fn<MemoryUpdateDeps['executeAgentTurn']>(async (_turnId, _prompt, options) => {
      options.onEvent(resultEvent());
    });
    const deps: MemoryUpdateDeps = {
      executeAgentTurn,
      getSettings: vi.fn(() => makeSettings()),
      broadcastMemoryUpdateStatus: vi.fn(),
    };

    const { initializeMemoryUpdateService, triggerMemoryUpdate } = await importService();
    initializeMemoryUpdateService(deps);

    await triggerMemoryUpdate(makeContext());
    await flushMemoryUpdate();

    // running broadcasts but does not persist → exactly one persist (the terminal).
    expect(mockUpdateSession).toHaveBeenCalledTimes(1);
    const [sessionId, mutator] = mockUpdateSession.mock.calls[0];
    expect(sessionId).toBe('origin-session-1');
    // The mutator writes the terminal status keyed by originalTurnId.
    const next = mutator({
      id: 'origin-session-1',
      memoryUpdateStatusByTurn: {},
      updatedAt: 0,
      messages: [],
      eventsByTurn: {},
    }) as { memoryUpdateStatusByTurn: Record<string, { status: string }> };
    expect(next.memoryUpdateStatusByTurn['origin-turn-1'].status).toBe('success');
  });

  it('persists the terminal error status to the store', async () => {
    const executeAgentTurn = vi.fn<MemoryUpdateDeps['executeAgentTurn']>(async (_turnId, _prompt, options) => {
      options.onEvent(errorEvent('Boom'));
    });
    const deps: MemoryUpdateDeps = {
      executeAgentTurn,
      getSettings: vi.fn(() => makeSettings()),
      broadcastMemoryUpdateStatus: vi.fn(),
    };

    const { initializeMemoryUpdateService, triggerMemoryUpdate } = await importService();
    initializeMemoryUpdateService(deps);

    await triggerMemoryUpdate(makeContext());
    await flushMemoryUpdate();

    expect(mockUpdateSession).toHaveBeenCalledTimes(1);
    const [, mutator] = mockUpdateSession.mock.calls[0];
    const next = mutator({
      id: 'origin-session-1',
      memoryUpdateStatusByTurn: {},
      updatedAt: 0,
      messages: [],
      eventsByTurn: {},
    }) as { memoryUpdateStatusByTurn: Record<string, { status: string }> };
    expect(next.memoryUpdateStatusByTurn['origin-turn-1'].status).toBe('error');
  });
});
