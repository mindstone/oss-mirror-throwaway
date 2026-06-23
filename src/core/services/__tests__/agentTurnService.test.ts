import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — wrapped in vi.hoisted so the factories below can close over the
// spies without hitting the TDZ during vi.mock hoisting.
// ---------------------------------------------------------------------------

const {
  mockDispatchAgentErrorEvent,
  mockSetActiveTurnController,
  mockSetRendererSession,
  mockSetTurnInputSource,
  mockRecordUserActivity,
  mockClearTurnQuipCache,
  mockAcquire,
} = vi.hoisted(() => ({
  mockDispatchAgentErrorEvent: vi.fn(),
  mockSetActiveTurnController: vi.fn(),
  mockSetRendererSession: vi.fn(),
  mockSetTurnInputSource: vi.fn(),
  mockRecordUserActivity: vi.fn(),
  mockClearTurnQuipCache: vi.fn(),
  mockAcquire: vi.fn(async (): Promise<() => void> => () => {}),
}));

vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentErrorEvent: mockDispatchAgentErrorEvent,
}));

vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    setActiveTurnController: mockSetActiveTurnController,
    // Eager session→turn mapping at admission (260610 queue-drain-cancels-turn
    // Stage 2 — closes the admission-window race for probe and cancel).
    setRendererSession: mockSetRendererSession,
    setTurnInputSource: mockSetTurnInputSource,
  },
}));

vi.mock('../startupScheduler', () => ({
  startupScheduler: {
    recordUserActivity: mockRecordUserActivity,
  },
}));

vi.mock('../quipGeneratorService', () => ({
  clearTurnQuipCache: mockClearTurnQuipCache,
}));

vi.mock('../turnConcurrencyLimiter', () => ({
  localTurnLimiter: {
    acquire: mockAcquire,
  },
}));

vi.mock('@core/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (must follow mocks).
// ---------------------------------------------------------------------------

import { startAgentTurn, type AgentTurnServiceDeps } from '../agentTurnService';

// Flush the microtask queue by yielding past a macrotask boundary. This is
// deterministic against any number of internal awaits inside the
// `queueMicrotask` IIFE (`acquire`, `executeAgentTurn`, catch body) and is
// resilient to future awaits being added without the test silently racing.
async function drainMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('startAgentTurn — catch-all error dispatch', () => {
  let executeAgentTurn: Mock<AgentTurnServiceDeps['executeAgentTurn']>;
  let dispatchAgentEvent: Mock<AgentTurnServiceDeps['dispatchAgentEvent']>;
  let deleteRendererSessionByTurn: Mock<AgentTurnServiceDeps['deleteRendererSessionByTurn']>;
  let cancelExistingTurnForSession: Mock<AgentTurnServiceDeps['cancelExistingTurnForSession']>;
  let deps: AgentTurnServiceDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    executeAgentTurn = vi.fn<AgentTurnServiceDeps['executeAgentTurn']>();
    dispatchAgentEvent = vi.fn<AgentTurnServiceDeps['dispatchAgentEvent']>();
    deleteRendererSessionByTurn =
      vi.fn<AgentTurnServiceDeps['deleteRendererSessionByTurn']>();
    cancelExistingTurnForSession =
      vi.fn<AgentTurnServiceDeps['cancelExistingTurnForSession']>(() => undefined);
    deps = {
      executeAgentTurn,
      dispatchAgentEvent,
      deleteRendererSessionByTurn,
      cancelExistingTurnForSession,
    };
  });

  const baseRequest = {
    prompt: 'hello',
    sessionId: 'session-a',
  };

  it('uses clientTurnId as the canonical turnId when provided', () => {
    const { turnId } = startAgentTurn(
      deps,
      {
        ...baseRequest,
        clientTurnId: 'client-turn-canonical',
      },
      null,
    );

    expect(turnId).toBe('client-turn-canonical');
    expect(mockSetActiveTurnController).toHaveBeenCalledWith(
      'client-turn-canonical',
      expect.any(AbortController),
    );
  });

  it('adopts a non-colliding clientTurnId when active-turn predicate says it is free', () => {
    const isActiveTurnId = vi.fn(() => false);
    deps.isActiveTurnId = isActiveTurnId;

    const { turnId } = startAgentTurn(
      deps,
      {
        ...baseRequest,
        clientTurnId: 'client-turn-open',
      },
      null,
    );

    expect(turnId).toBe('client-turn-open');
    expect(isActiveTurnId).toHaveBeenCalledExactlyOnceWith('client-turn-open');
    expect(mockSetActiveTurnController).toHaveBeenCalledWith(
      'client-turn-open',
      expect.any(AbortController),
    );
  });

  it('falls back to a fresh UUID when clientTurnId collides with a live active turn', () => {
    deps.isActiveTurnId = vi.fn(() => true);

    const { turnId } = startAgentTurn(
      deps,
      {
        ...baseRequest,
        clientTurnId: 'client-turn-live-collision',
      },
      null,
    );

    expect(turnId).not.toBe('client-turn-live-collision');
    expect(turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(mockSetActiveTurnController).toHaveBeenCalledWith(
      turnId,
      expect.any(AbortController),
    );
  });

  it('routes an Error thrown by executeAgentTurn through dispatchAgentErrorEvent with the message as humanizedOverride', async () => {
    const boom = new Error('Upstream exploded');
    executeAgentTurn.mockRejectedValueOnce(boom);

    const { turnId } = startAgentTurn(deps, baseRequest, null);
    await drainMicrotasks();

    expect(mockDispatchAgentErrorEvent).toHaveBeenCalledTimes(1);
    expect(mockDispatchAgentErrorEvent).toHaveBeenCalledWith(
      null,
      turnId,
      boom,
      expect.objectContaining({ humanizedOverride: 'Upstream exploded' }),
    );
  });

  it('falls back to "Agent turn aborted." when the Error has no message', async () => {
    // `new Error()` has `message === ''`. Verifies that the catch-all treats
    // an empty string as "no message" and uses the user-facing fallback copy
    // rather than emitting an empty error banner.
    const silent = new Error();
    executeAgentTurn.mockRejectedValueOnce(silent);

    const { turnId } = startAgentTurn(deps, baseRequest, null);
    await drainMicrotasks();

    expect(mockDispatchAgentErrorEvent).toHaveBeenCalledWith(
      null,
      turnId,
      silent,
      expect.objectContaining({ humanizedOverride: 'Agent turn aborted.' }),
    );
  });

  it('preserves a thrown raw string as the user-facing copy', async () => {
    // Synchronous string throw inside an async mock propagates as a rejected
    // promise at the `await` boundary in startAgentTurn's IIFE. The catch-all
    // surfaces the raw string content rather than swallowing it into the
    // generic fallback, so a rare upstream that `throw "Connection reset"`s
    // still reaches the user.
    executeAgentTurn.mockImplementationOnce(() => {
      throw 'Connection reset';
    });

    const { turnId } = startAgentTurn(deps, baseRequest, null);
    await drainMicrotasks();

    expect(mockDispatchAgentErrorEvent).toHaveBeenCalledWith(
      null,
      turnId,
      'Connection reset',
      expect.objectContaining({ humanizedOverride: 'Connection reset' }),
    );
  });

  it('falls back to "Agent turn aborted." for an empty thrown string', async () => {
    executeAgentTurn.mockImplementationOnce(() => {
      throw '';
    });

    const { turnId } = startAgentTurn(deps, baseRequest, null);
    await drainMicrotasks();

    expect(mockDispatchAgentErrorEvent).toHaveBeenCalledWith(
      null,
      turnId,
      '',
      expect.objectContaining({ humanizedOverride: 'Agent turn aborted.' }),
    );
  });

  it('falls back to "Agent turn aborted." when the thrown value is undefined', async () => {
    executeAgentTurn.mockRejectedValueOnce(undefined);

    const { turnId } = startAgentTurn(deps, baseRequest, null);
    await drainMicrotasks();

    expect(mockDispatchAgentErrorEvent).toHaveBeenCalledWith(
      null,
      turnId,
      undefined,
      expect.objectContaining({ humanizedOverride: 'Agent turn aborted.' }),
    );
  });

  it('falls back to "Agent turn aborted." when a plain object is thrown', async () => {
    // A thrown `{ code: 'FOO' }` has no `.message` and is not an Error or
    // string. The catch-all should not extract `.code` or stringify the
    // object — that would leak `[object Object]` to the user. Route to
    // fallback instead.
    executeAgentTurn.mockImplementationOnce(() => {
      throw { code: 'WEIRD_STATE' };
    });

    const { turnId } = startAgentTurn(deps, baseRequest, null);
    await drainMicrotasks();

    expect(mockDispatchAgentErrorEvent).toHaveBeenCalledWith(
      null,
      turnId,
      { code: 'WEIRD_STATE' },
      expect.objectContaining({ humanizedOverride: 'Agent turn aborted.' }),
    );
  });

  it('invokes deleteRendererSessionByTurn and clearTurnQuipCache with the turnId on the error path', async () => {
    executeAgentTurn.mockRejectedValueOnce(new Error('fail'));

    const { turnId } = startAgentTurn(deps, baseRequest, null);
    await drainMicrotasks();

    expect(deleteRendererSessionByTurn).toHaveBeenCalledExactlyOnceWith(turnId);
    expect(mockClearTurnQuipCache).toHaveBeenCalledExactlyOnceWith(turnId);
  });

  it('does not dispatch an error or delete the renderer session on a successful turn (but still clears quip cache)', async () => {
    executeAgentTurn.mockResolvedValueOnce(undefined);

    const { turnId } = startAgentTurn(deps, baseRequest, null);
    await drainMicrotasks();

    expect(mockDispatchAgentErrorEvent).not.toHaveBeenCalled();
    expect(deleteRendererSessionByTurn).not.toHaveBeenCalled();
    expect(mockClearTurnQuipCache).toHaveBeenCalledExactlyOnceWith(turnId);
  });

  it('returns turnId synchronously while recovery executor runs inside the queued microtask', async () => {
    const executeAgentTurnWithRecovery = vi.fn<NonNullable<AgentTurnServiceDeps['executeAgentTurnWithRecovery']>>(
      () => new Promise((resolve) => setTimeout(resolve, 250)),
    );
    deps.executeAgentTurnWithRecovery = executeAgentTurnWithRecovery;

    const startedAt = performance.now();
    const { turnId } = startAgentTurn(deps, baseRequest, null);
    const elapsed = performance.now() - startedAt;

    // When no clientTurnId is supplied, admission must still allocate a real turn id.
    expect(turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(turnId).not.toBe('__pending__');
    expect(elapsed).toBeLessThan(100);
    expect(executeAgentTurnWithRecovery).not.toHaveBeenCalled();

    await drainMicrotasks();
    expect(executeAgentTurnWithRecovery).toHaveBeenCalledWith(
      null,
      turnId,
      'hello',
      expect.objectContaining({ sessionId: 'session-a' }),
    );
  });
});
