import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import { createSessionStore } from '../../store/sessionStore';
import { applyRecoveryEventToStore } from '../useRecoveryAdapter';
import type { AgentSessionWithRuntime } from '../../types';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', {
    sessionsApi: {
      get: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const recoveryBase = {
  turnId: 'turn-1',
  sessionId: 'session-1',
  originalSessionId: 'session-1',
  depth: 1,
  attempt: 1,
  totalCalls: 1,
  timestamp: 1,
};

function dispatch(
  store: ReturnType<typeof createSessionStore>,
  event: AgentEvent,
  emitLog?: Parameters<typeof applyRecoveryEventToStore>[2],
): void {
  applyRecoveryEventToStore(store, event as Parameters<typeof applyRecoveryEventToStore>[1], emitLog);
}

function backgroundSession(id: string): AgentSessionWithRuntime {
  return {
    id,
    title: 'Background',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    origin: 'manual',
  };
}

type RecoveryEventForRendererTest = Parameters<typeof applyRecoveryEventToStore>[1];

interface StubRecoveryAdapterForRendererTest extends Record<string, unknown> {
  dispatchedEvents: RecoveryEventForRendererTest[];
}

type CreateStubRecoveryAdapterForRendererTest = (options: {
  outcomes: Array<{ kind: 'error_non_overflow'; error: Error }>;
}) => StubRecoveryAdapterForRendererTest;

type RunRecoveryPipelineForRendererTest = (input: {
  phase: string;
  prompt: string;
  agentLoopOptions: { sessionId: string };
  enableRecovery: boolean;
  ctx: Record<string, unknown>;
  adapter: StubRecoveryAdapterForRendererTest;
  abortSignal: AbortSignal;
  revealDurationMs: number;
}) => Promise<{ kind: string; exhaustedReason?: string }>;

type MakeMessageForRendererTest = (role: AgentTurnMessage['role'], text: string) => AgentTurnMessage;

async function loadRecoveryPipelineTestModules(): Promise<{
  runRecoveryPipeline: RunRecoveryPipelineForRendererTest;
  createStubRecoveryAdapter: CreateStubRecoveryAdapterForRendererTest;
  makeMessage: MakeMessageForRendererTest;
}> {
  const recoveryPipelinePath = '../../../../../core/services/recovery/recoveryPipeline';
  const stubAdapterPath = '../../../../../core/services/recovery/__tests__/fixtures/stubAdapter';
  const [recoveryPipelineModule, stubAdapterModule] = await Promise.all([
    import(recoveryPipelinePath),
    import(stubAdapterPath),
  ]);
  return {
    runRecoveryPipeline: (recoveryPipelineModule as unknown as { runRecoveryPipeline: RunRecoveryPipelineForRendererTest }).runRecoveryPipeline,
    createStubRecoveryAdapter: (stubAdapterModule as unknown as { createStubRecoveryAdapter: CreateStubRecoveryAdapterForRendererTest }).createStubRecoveryAdapter,
    makeMessage: (stubAdapterModule as unknown as { makeMessage: MakeMessageForRendererTest }).makeMessage,
  };
}

describe('useRecoveryAdapter event projection', () => {
  it('maps recovery events to overlay phases', () => {
    const store = createSessionStore();
    const currentSessionId = store.getState().currentSessionId;

    dispatch(store, { type: 'recovery:started', ...recoveryBase, originalSessionId: currentSessionId, sessionId: currentSessionId, phase: 'post_activity' });
    expect(store.getState().compaction.phase).toBe('compacting');
    expect(store.getState().compaction.turnId).toBe('turn-1');

    dispatch(store, { type: 'recovery:summary_ready', ...recoveryBase, originalSessionId: currentSessionId, sessionId: currentSessionId, summary: 'summary', revealDurationMs: 123 });
    expect(store.getState().compaction.phase).toBe('revealing');
    expect(store.getState().compaction.summary).toBe('summary');
    expect(store.getState().compaction.revealDurationMs).toBe(123);

    dispatch(store, { type: 'recovery:retrying', ...recoveryBase, originalSessionId: currentSessionId, sessionId: currentSessionId });
    expect(store.getState().compaction.phase).toBe('continuing');
  });

  it('rejects out-of-order summary_ready before started', () => {
    const store = createSessionStore();
    const currentSessionId = store.getState().currentSessionId;

    dispatch(store, { type: 'recovery:summary_ready', ...recoveryBase, originalSessionId: currentSessionId, sessionId: currentSessionId, summary: 'summary' });

    expect(store.getState().compaction.phase).toBe('idle');
    expect(store.getState().compaction.summary).toBeNull();
  });

  it('ignores recovery:failed from idle compaction state and logs a warning', () => {
    const store = createSessionStore();
    const currentSessionId = store.getState().currentSessionId;
    const emitLog = vi.fn();

    dispatch(
      store,
      {
        type: 'recovery:failed',
        ...recoveryBase,
        originalSessionId: currentSessionId,
        sessionId: currentSessionId,
        error: 'Recovery failed: agent_loop_error_before_recovery',
        exhaustedReason: 'agent_loop_error_before_recovery',
      },
      emitLog,
    );

    expect(store.getState().compaction.phase).toBe('idle');
    expect(emitLog).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn',
      message: 'Ignored recovery:failed event because compaction was not active for this turn',
      turnId: 'turn-1',
      sessionId: currentSessionId,
      context: expect.objectContaining({
        eventType: 'recovery:failed',
        exhaustedReason: 'agent_loop_error_before_recovery',
        compactionPhase: 'idle',
      }),
    }));
  });

  it('keeps the overlay closed for the historical Codex provider-error recovery chain and the post-fix chain', () => {
    // Regression test for `docs-private/investigations/260513_codex_unknown_error_misroutes_to_compaction_overlay.md`.
    const turnId = 'db291374-cfa6-40f3-b793-adcc9ac24881';

    const runChain = (includeLegacyRecoveryFailed: boolean) => {
      const store = createSessionStore();
      const currentSessionId = store.getState().currentSessionId;
      const originalSetCompactionError = store.getState().setCompactionError;
      const setCompactionError = vi.fn(originalSetCompactionError);
      store.setState({ setCompactionError });

      const codexError: AgentEvent = {
        type: 'error',
        error: 'Unknown error',
        rawError: 'Unknown error',
        errorKind: 'server_error',
        isTransient: true,
        provider: 'OpenAI',
        timestamp: 1,
      };
      const userFacingError: AgentEvent = {
        type: 'error',
        error: "Something went wrong mid-conversation. Your work so far is saved — try sending your message again to pick up where I left off.",
        rawError: 'Unknown error',
        errorKind: 'server_error',
        isTransient: true,
        provider: 'OpenAI (Codex)',
        timestamp: 3,
      };

      store.getState().processEvent(turnId, codexError);
      if (includeLegacyRecoveryFailed) {
        dispatch(store, {
          type: 'recovery:failed',
          ...recoveryBase,
          turnId,
          sessionId: currentSessionId,
          originalSessionId: currentSessionId,
          depth: 0,
          attempt: 0,
          totalCalls: 1,
          timestamp: 2,
          error: 'Recovery failed: summary_generation_failed',
          exhaustedReason: 'summary_generation_failed',
        });
      }
      store.getState().processEvent(turnId, userFacingError);

      return { store, setCompactionError };
    };

    const legacyBadChain = runChain(true);
    expect(legacyBadChain.setCompactionError).not.toHaveBeenCalled();
    expect(legacyBadChain.store.getState().compaction.phase).toBe('idle');

    const postFixChain = runChain(false);
    expect(postFixChain.setCompactionError).not.toHaveBeenCalled();
    expect(postFixChain.store.getState().compaction.phase).toBe('idle');
  });

  it('keeps compaction idle when consuming pipeline-output events for a first-call non-overflow provider error', async () => {
    const store = createSessionStore();
    const currentSessionId = store.getState().currentSessionId;
    const originalSetCompactionError = store.getState().setCompactionError;
    const setCompactionError = vi.fn(originalSetCompactionError);
    const emitLog = vi.fn();
    store.setState({ setCompactionError });
    const { createStubRecoveryAdapter, makeMessage, runRecoveryPipeline } = await loadRecoveryPipelineTestModules();
    const controller = new AbortController();
    const context = {
      phase: 'post_activity',
      depth: 0,
      attempt: 0,
      longContextFallbackAttempted: false,
      skeletonAttempted: false,
      isRecoveryModelAttempt: false,
      enableRecovery: true,
      sessionId: currentSessionId,
      turnId: 'turn-provider-error-before-recovery',
      originalSessionId: currentSessionId,
      originalPrompt: 'Please continue the work',
      abortSignal: controller.signal,
      messages: [makeMessage('user', 'Please continue the work')],
    };
    const adapter = createStubRecoveryAdapter({
      outcomes: [{ kind: 'error_non_overflow', error: new Error('provider failed before recovery') }],
    });

    const outcome = await runRecoveryPipeline({
      phase: context.phase,
      prompt: context.originalPrompt,
      agentLoopOptions: { sessionId: context.sessionId },
      enableRecovery: context.enableRecovery,
      ctx: context,
      adapter,
      abortSignal: context.abortSignal,
      revealDurationMs: 0,
    });

    expect(outcome).toMatchObject({
      kind: 'failure_terminal',
      exhaustedReason: 'agent_loop_error_before_recovery',
    });

    // Falsifiability guard for Phase 7 F7: this replays the pipeline's actual
    // emitted events through the renderer adapter. If producer-side
    // `safeDispatch(makeRecoveryFailedEvent(...))` is re-enabled for first-call
    // `error_non_overflow`, `adapter.dispatchedEvents` will include
    // `recovery:failed`; replay below will hit the intentional idle-state
    // warning/reject path, and the `emitLog` assertion will fail.
    for (const event of adapter.dispatchedEvents) {
      dispatch(store, event, emitLog);
    }

    expect(adapter.dispatchedEvents.map((event) => event.type)).toEqual([]);
    expect(setCompactionError).not.toHaveBeenCalled();
    expect(store.getState().compaction.phase).toBe('idle');
    expect(emitLog).not.toHaveBeenCalled();
  });

  it('maps genuine started recovery failures to the compaction error overlay state', () => {
    const store = createSessionStore();
    const currentSessionId = store.getState().currentSessionId;

    dispatch(store, { type: 'recovery:started', ...recoveryBase, originalSessionId: currentSessionId, sessionId: currentSessionId, phase: 'post_activity' });
    dispatch(store, {
      type: 'recovery:failed',
      ...recoveryBase,
      originalSessionId: currentSessionId,
      sessionId: currentSessionId,
      error: 'Recovery failed: summary_generation_failed',
      exhaustedReason: 'summary_generation_failed',
    });

    expect(store.getState().compaction.phase).toBe('error');
    expect(store.getState().compaction.statusMessage).toBe('Recovery failed: summary_generation_failed');
    // The exhausted reason is threaded into the store so the overlay can render
    // reason-aware copy (REBEL-5BM Stage 2).
    expect(store.getState().compaction.reason).toBe('summary_generation_failed');
  });

  it('threads the agent_loop_error_after_recovery reason into the compaction error state', () => {
    const store = createSessionStore();
    const currentSessionId = store.getState().currentSessionId;

    dispatch(store, { type: 'recovery:started', ...recoveryBase, originalSessionId: currentSessionId, sessionId: currentSessionId, phase: 'post_activity' });
    dispatch(store, {
      type: 'recovery:failed',
      ...recoveryBase,
      originalSessionId: currentSessionId,
      sessionId: currentSessionId,
      error: 'Recovery failed: agent_loop_error_after_recovery',
      exhaustedReason: 'agent_loop_error_after_recovery',
    });

    expect(store.getState().compaction.phase).toBe('error');
    // The new reason reaches the store verbatim — the overlay branches its copy
    // on this so it no longer claims the conversation is "still too large".
    expect(store.getState().compaction.reason).toBe('agent_loop_error_after_recovery');
  });

  it('ignores duplicate recovery:failed events for the same turn after the first error transition', () => {
    const store = createSessionStore();
    const currentSessionId = store.getState().currentSessionId;
    const emitLog = vi.fn();

    dispatch(store, {
      type: 'recovery:started',
      ...recoveryBase,
      originalSessionId: currentSessionId,
      sessionId: currentSessionId,
      phase: 'post_activity',
    });
    const originalSetCompactionError = store.getState().setCompactionError;
    const setCompactionError = vi.fn(originalSetCompactionError);
    store.setState({ setCompactionError });

    const failedEvent: AgentEvent = {
      type: 'recovery:failed',
      ...recoveryBase,
      originalSessionId: currentSessionId,
      sessionId: currentSessionId,
      error: 'Recovery failed: summary_generation_failed',
      exhaustedReason: 'summary_generation_failed',
    };
    dispatch(store, failedEvent, emitLog);
    const compactionAfterFirst = store.getState().compaction;
    dispatch(store, failedEvent, emitLog);

    expect(setCompactionError).toHaveBeenCalledTimes(1);
    expect(store.getState().compaction).toBe(compactionAfterFirst);
    expect(store.getState().compaction.phase).toBe('error');
    expect(emitLog).toHaveBeenCalledTimes(1);
    expect(emitLog).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn',
      message: 'Ignored recovery:failed event because compaction was not active for this turn',
      context: expect.objectContaining({
        eventType: 'recovery:failed',
        exhaustedReason: 'summary_generation_failed',
        compactionPhase: 'error',
      }),
    }));
  });

  it('rejects late failed after succeeded for the same overlay turn', async () => {
    const store = createSessionStore();
    const currentSessionId = store.getState().currentSessionId;

    dispatch(store, { type: 'recovery:started', ...recoveryBase, originalSessionId: currentSessionId, sessionId: currentSessionId, phase: 'post_activity' });
    dispatch(store, { type: 'recovery:succeeded', ...recoveryBase, originalSessionId: currentSessionId, sessionId: currentSessionId, finalDepth: 1, totalDurationMs: 1 });
    dispatch(store, { type: 'recovery:failed', ...recoveryBase, originalSessionId: currentSessionId, sessionId: currentSessionId, error: 'late', exhaustedReason: 'aborted' });

    expect(store.getState().compaction.phase).toBe('continuing');
  });

  it('routes concurrent background recoveries without corrupting the foreground overlay', () => {
    const store = createSessionStore();
    const currentSessionId = store.getState().currentSessionId;

    dispatch(store, { type: 'recovery:started', ...recoveryBase, originalSessionId: 'session-b', sessionId: 'session-b', phase: 'post_activity' });
    dispatch(store, { type: 'recovery:started', ...recoveryBase, turnId: 'turn-c', originalSessionId: 'session-c', sessionId: 'session-c', phase: 'post_activity' });

    expect(store.getState().currentSessionId).toBe(currentSessionId);
    expect(store.getState().compaction.phase).toBe('idle');
  });

  it('evicts a loaded background session when recovery succeeds', () => {
    const store = createSessionStore();
    const loadedSessions = new Map(store.getState().loadedSessions);
    loadedSessions.set('session-b', backgroundSession('session-b'));
    store.setState({ loadedSessions });

    dispatch(store, { type: 'recovery:succeeded', ...recoveryBase, originalSessionId: 'session-b', sessionId: 'session-b', finalDepth: 1, totalDurationMs: 1 });

    expect(store.getState().loadedSessions.has('session-b')).toBe(false);
  });

  it('reloads canonical state for current-session success', async () => {
    const store = createSessionStore();
    const currentSessionId = store.getState().currentSessionId;
    const get = vi.fn().mockResolvedValue(backgroundSession(currentSessionId));
    vi.stubGlobal('window', {
      sessionsApi: {
        get,
        upsert: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
      },
    });

    dispatch(store, { type: 'recovery:started', ...recoveryBase, originalSessionId: currentSessionId, sessionId: currentSessionId, phase: 'post_activity' });
    dispatch(store, { type: 'recovery:succeeded', ...recoveryBase, originalSessionId: currentSessionId, sessionId: currentSessionId, finalDepth: 1, totalDurationMs: 1 });
    await vi.runAllTimersAsync();

    expect(get).toHaveBeenCalledWith({ id: currentSessionId });
  });

  it('keeps the enhanced recovery prompt out of the foreground transcript', () => {
    const store = createSessionStore();
    const currentSessionId = store.getState().currentSessionId;
    store.setState({
      messages: [{ id: 'user-1', turnId: 'turn-1', role: 'user', text: 'Original user request', createdAt: 1 }],
    });

    dispatch(store, { type: 'recovery:started', ...recoveryBase, originalSessionId: currentSessionId, sessionId: currentSessionId, phase: 'post_activity' });
    dispatch(store, { type: 'recovery:summary_ready', ...recoveryBase, originalSessionId: currentSessionId, sessionId: currentSessionId, summary: 'summary' });
    dispatch(store, { type: 'recovery:retrying', ...recoveryBase, originalSessionId: currentSessionId, sessionId: currentSessionId });

    expect(store.getState().messages.map((message) => message.text)).toEqual(['Original user request']);
    expect(store.getState().messages.some((message) => message.text.includes('[COMPACTION_DEPTH:'))).toBe(false);
  });
});
