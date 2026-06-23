/**
 * Stage 2 of docs/plans/260610_queue-drain-cancels-turn/PLAN.md —
 * `supersedePolicy` admission guard in `startAgentTurn`.
 *
 * Uses the REAL `agentTurnRegistry` singleton (unlike the sibling
 * agentTurnService.test.ts, which mocks it) because the guard's correctness
 * depends on registry timing: the admission-window race (FMM 15) is only
 * observable against the real session→turn mapping. Each test cleans up the
 * registry state it creates.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const {
  mockDispatchAgentErrorEvent,
  mockRecordUserActivity,
  mockClearTurnQuipCache,
  mockAcquire,
} = vi.hoisted(() => ({
  mockDispatchAgentErrorEvent: vi.fn(),
  mockRecordUserActivity: vi.fn(),
  mockClearTurnQuipCache: vi.fn(),
  mockAcquire: vi.fn(async (): Promise<() => void> => () => {}),
}));

vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentErrorEvent: mockDispatchAgentErrorEvent,
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
  createScopedLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  })),
}));

import { startAgentTurn, type AgentTurnServiceDeps } from '../agentTurnService';
import { agentTurnRegistry } from '../agentTurnRegistry';
import {
  AGENT_TURN_TARGET_BUSY_CODE,
  isTargetBusyRejection,
} from '@shared/utils/agentTurnAdmission';

async function drainMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('startAgentTurn — supersedePolicy admission guard', () => {
  let executeAgentTurn: Mock<AgentTurnServiceDeps['executeAgentTurn']>;
  let dispatchAgentEvent: Mock<AgentTurnServiceDeps['dispatchAgentEvent']>;
  let deleteRendererSessionByTurn: Mock<AgentTurnServiceDeps['deleteRendererSessionByTurn']>;
  let cancelExistingTurnForSession: Mock<AgentTurnServiceDeps['cancelExistingTurnForSession']>;
  let deps: AgentTurnServiceDeps;
  const startedTurnIds: string[] = [];

  /** Track returned turnIds so afterEach can clean the real registry. */
  const start = (
    request: Parameters<typeof startAgentTurn>[1],
    overrideDeps: AgentTurnServiceDeps = deps,
  ): { turnId: string } => {
    const result = startAgentTurn(overrideDeps, request, null);
    startedTurnIds.push(result.turnId);
    return result;
  };

  /** Simulate a live turn the way admission records one (controller + session mapping). */
  const simulateActiveTurn = (turnId: string, sessionId: string): AbortController => {
    const controller = new AbortController();
    agentTurnRegistry.setActiveTurnController(turnId, controller);
    agentTurnRegistry.setRendererSession(turnId, sessionId);
    startedTurnIds.push(turnId);
    return controller;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    executeAgentTurn = vi.fn<AgentTurnServiceDeps['executeAgentTurn']>(async () => undefined);
    dispatchAgentEvent = vi.fn<AgentTurnServiceDeps['dispatchAgentEvent']>();
    deleteRendererSessionByTurn = vi.fn<AgentTurnServiceDeps['deleteRendererSessionByTurn']>();
    cancelExistingTurnForSession = vi.fn<AgentTurnServiceDeps['cancelExistingTurnForSession']>(
      (sessionId: string) => agentTurnRegistry.cancelExistingTurnForSession(sessionId),
    );
    deps = {
      executeAgentTurn,
      dispatchAgentEvent,
      deleteRendererSessionByTurn,
      cancelExistingTurnForSession,
      getActiveTurnForSession: (sessionId: string) =>
        agentTurnRegistry.getActiveTurnForSession(sessionId),
    };
  });

  afterEach(async () => {
    await drainMicrotasks();
    for (const turnId of startedTurnIds.splice(0)) {
      agentTurnRegistry.cleanupTurn(turnId);
    }
  });

  it("refuses admission with the typed error when policy is 'reject' and the target session has an active turn — active turn untouched", () => {
    const activeController = simulateActiveTurn('turn-active-1', 'session-busy');
    const controllersBefore = agentTurnRegistry.getActiveTurnIds();

    let thrown: unknown;
    try {
      startAgentTurn(
        deps,
        { prompt: 'queued follow-up', sessionId: 'session-busy', supersedePolicy: 'reject' },
        null,
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(isTargetBusyRejection(thrown)).toBe(true);
    expect((thrown as Error).message).toContain(AGENT_TURN_TARGET_BUSY_CODE);
    expect((thrown as Error).message).toContain('turn-active-1');
    // The active turn keeps running: no cancellation, no supersession event,
    // no new controller registered, no execution queued.
    expect(activeController.signal.aborted).toBe(false);
    expect(cancelExistingTurnForSession).not.toHaveBeenCalled();
    expect(dispatchAgentEvent).not.toHaveBeenCalled();
    expect(agentTurnRegistry.getActiveTurnIds()).toEqual(controllersBefore);
    expect(executeAgentTurn).not.toHaveBeenCalled();
  });

  it("starts normally when policy is 'reject' and the target session is idle", async () => {
    const { turnId } = start({
      prompt: 'first message',
      sessionId: 'session-idle',
      supersedePolicy: 'reject',
    });

    expect(typeof turnId).toBe('string');
    expect(agentTurnRegistry.getActiveTurnController(turnId)).toBeDefined();
    await drainMicrotasks();
    expect(executeAgentTurn).toHaveBeenCalledTimes(1);
    expect(dispatchAgentEvent).not.toHaveBeenCalled();
  });

  it('default (no policy) + active turn → cancels the existing turn and dispatches turn_superseded (legacy preserved)', () => {
    const activeController = simulateActiveTurn('turn-active-2', 'session-dedup');

    const { turnId } = start({ prompt: 'interrupting send', sessionId: 'session-dedup' });

    expect(activeController.signal.aborted).toBe(true);
    expect(cancelExistingTurnForSession).toHaveBeenCalledWith('session-dedup');
    expect(dispatchAgentEvent).toHaveBeenCalledTimes(1);
    expect(dispatchAgentEvent).toHaveBeenCalledWith(
      null,
      'turn-active-2',
      expect.objectContaining({ type: 'turn_superseded', newTurnId: turnId }),
    );
  });

  it("explicit 'supersede' + active turn behaves exactly like the default (cancel + turn_superseded)", () => {
    const activeController = simulateActiveTurn('turn-active-3', 'session-explicit');

    const { turnId } = start({
      prompt: 'explicit supersede',
      sessionId: 'session-explicit',
      supersedePolicy: 'supersede',
    });

    expect(activeController.signal.aborted).toBe(true);
    expect(dispatchAgentEvent).toHaveBeenCalledWith(
      null,
      'turn-active-3',
      expect.objectContaining({ type: 'turn_superseded', newTurnId: turnId }),
    );
  });

  it("treats an unknown policy value (open union over IPC) as 'supersede' — no exhaustiveness crash", () => {
    const activeController = simulateActiveTurn('turn-active-4', 'session-unknown-policy');

    const { turnId } = start({
      prompt: 'forward-compat value',
      sessionId: 'session-unknown-policy',
      // Future/unknown value arriving over IPC must fall through to legacy
      // supersede, never throw an assertNever-style crash (FMM 13).
      supersedePolicy: 'defer' as unknown as 'supersede',
    });

    expect(activeController.signal.aborted).toBe(true);
    expect(dispatchAgentEvent).toHaveBeenCalledWith(
      null,
      'turn-active-4',
      expect.objectContaining({ type: 'turn_superseded', newTurnId: turnId }),
    );
  });

  it("fails loud with a wiring error when policy is 'reject' but no getActiveTurnForSession probe is wired", () => {
    const unwiredDeps: AgentTurnServiceDeps = {
      executeAgentTurn,
      dispatchAgentEvent,
      deleteRendererSessionByTurn,
      cancelExistingTurnForSession,
      // getActiveTurnForSession deliberately absent
    };

    expect(() =>
      startAgentTurn(
        unwiredDeps,
        { prompt: 'reject without probe', sessionId: 'session-unwired', supersedePolicy: 'reject' },
        null,
      ),
    ).toThrow(/getActiveTurnForSession/);
    // Must NOT fall through to the supersede path.
    expect(cancelExistingTurnForSession).not.toHaveBeenCalled();
    expect(executeAgentTurn).not.toHaveBeenCalled();
  });

  it('admission-window race (FMM 15): a reject-policy request arriving immediately after a same-session start is refused, not run concurrently', () => {
    // First turn admitted; its pipeline admission (which used to record the
    // session→turn mapping) has NOT run yet — execution is queued behind a
    // microtask. The probe must still see the session as busy.
    executeAgentTurn.mockImplementation(() => new Promise<void>(() => {}));
    const { turnId: firstTurnId } = start({ prompt: 'first start', sessionId: 'session-race' });

    let thrown: unknown;
    try {
      startAgentTurn(
        deps,
        { prompt: 'near-simultaneous queued send', sessionId: 'session-race', supersedePolicy: 'reject' },
        null,
      );
    } catch (err) {
      thrown = err;
    }

    expect(isTargetBusyRejection(thrown)).toBe(true);
    expect((thrown as Error).message).toContain(firstTurnId);
    // The first turn is untouched.
    expect(agentTurnRegistry.getActiveTurnController(firstTurnId)?.signal.aborted).toBe(false);
  });

  it('admission-window race closure also fixes the legacy path: a default-policy second start supersedes (not duplicates) a just-admitted turn', () => {
    executeAgentTurn.mockImplementation(() => new Promise<void>(() => {}));
    const { turnId: firstTurnId } = start({ prompt: 'first start', sessionId: 'session-race-legacy' });
    const firstController = agentTurnRegistry.getActiveTurnController(firstTurnId);
    expect(firstController).toBeDefined();

    const { turnId: secondTurnId } = start({ prompt: 'second start', sessionId: 'session-race-legacy' });

    expect(firstController?.signal.aborted).toBe(true);
    expect(dispatchAgentEvent).toHaveBeenCalledWith(
      null,
      firstTurnId,
      expect.objectContaining({ type: 'turn_superseded', newTurnId: secondTurnId }),
    );
  });
});
