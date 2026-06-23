// @vitest-environment happy-dom
/**
 * Stage 3 of docs/plans/260610_queue-drain-cancels-turn/PLAN.md —
 * engine-level behavior for `supersedePolicy` dispatches:
 * - the turn request carries the policy to `agent:turn`;
 * - a typed target-busy refusal rethrows (enriched with the persisted
 *   message id) WITHOUT setError / run-failed toast;
 * - pending network-retry state survives a refusal (defer-the-clear,
 *   FMM 14 / GPT F4) but is cleared once a reject-policy dispatch is admitted;
 * - non-reject dispatches keep the legacy eager clear + error UX;
 * - cross-session re-drain reuses a provided existingMessageId (FMM 9).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createTargetBusyRejectionError,
  getRequeueMessageId,
  isTargetBusyRejection,
} from '@shared/utils/agentTurnAdmission';
import { useAgentSessionEngine, type AgentSessionEngineApi } from '../useAgentSessionEngine';
import {
  clearCurrentSessionEvents,
  useSessionStore,
} from '../../store/sessionStore';

vi.mock('@renderer/contexts', () => ({
  useEmitLog: vi.fn(() => vi.fn()),
  useRecordBreadcrumb: vi.fn(() => vi.fn()),
}));

vi.mock('@renderer/src/sentry', () => ({
  captureRendererException: vi.fn(),
  captureRendererMessage: vi.fn(),
}));

const engineRef: { current: AgentSessionEngineApi | null } = { current: null };
const showToastMock = vi.fn();

function TestHarness() {
  engineRef.current = useAgentSessionEngine({
    emitLog: vi.fn(),
    recordBreadcrumb: vi.fn(),
    showToast: showToastMock,
  });
  return null;
}

/** Build the IPC-wrapped form of the typed refusal, as the renderer sees it. */
function makeIpcWrappedRefusal(sessionId: string, activeTurnId: string): Error {
  const original = createTargetBusyRejectionError(sessionId, activeTurnId);
  return new Error(`Error invoking remote method 'agent:turn': Error: ${original.message}`);
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  // @ts-expect-error - test env flag
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  vi.stubGlobal('sessionsApi', {
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    applyTurnEventUnion: vi.fn().mockResolvedValue({ success: true }),
  });

  vi.stubGlobal('api', {
    onAgentEvent: vi.fn(() => () => {}),
    onSessionTitleGenerated: vi.fn(() => () => {}),
    onSessionActivitySummaryGenerated: vi.fn(() => () => {}),
    onSafetyEvaluating: vi.fn(() => () => {}),
    onSafetyEvaluated: vi.fn(() => () => {}),
    onSafetyEvaluatingComplete: vi.fn(() => () => {}),
  });

  vi.stubGlobal('agentApi', {
    onSessionTitleGenerated: vi.fn(() => () => {}),
    stopTurn: vi.fn().mockResolvedValue({ success: true }),
    turn: vi.fn().mockResolvedValue({ turnId: 'default-turn' }),
    evaluateDoneSafety: vi.fn().mockResolvedValue({ safeToMarkDone: false, reason: 'test' }),
    deleteCachedAttachments: vi.fn().mockResolvedValue({ success: true }),
  });

  act(() => {
    clearCurrentSessionEvents();
    useSessionStore.getState().resetSession();
    useSessionStore.getState().clearAllPendingTurns();
  });

  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
  }
  container = null;
  root = null;
  engineRef.current = null;
  clearCurrentSessionEvents();
});

async function mountHarness(): Promise<void> {
  await act(async () => {
    root!.render(createElement(TestHarness));
  });
  expect(engineRef.current).not.toBeNull();
}

function seedPendingRetry(sessionId: string): void {
  act(() => {
    useSessionStore.getState().setPendingTurnForSession(sessionId, {
      sessionId,
      turnId: 'interrupted-turn',
      userMessageText: 'message awaiting network retry',
      failedAt: Date.now(),
      retryCount: 1,
    });
  });
}

describe('useAgentSessionEngine — supersedePolicy dispatch behavior', () => {
  it("threads supersedePolicy: 'reject' onto the agent:turn request (and omits it when absent)", async () => {
    await mountHarness();
    const turnMock = window.agentApi.turn as ReturnType<typeof vi.fn>;

    await act(async () => {
      await engineRef.current!.handleUserMessage(
        'queued dispatch', 'text', undefined, undefined, undefined,
        { supersedePolicy: 'reject' },
      );
    });
    expect(turnMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ supersedePolicy: 'reject' }),
    );

    await act(async () => {
      await engineRef.current!.handleUserMessage('plain dispatch', 'text');
    });
    expect(turnMock.mock.calls[1][0]).not.toHaveProperty('supersedePolicy');
  });

  it('typed refusal: rethrows enriched with the persisted message id; no setError, no run-failed toast; pending retry state intact', async () => {
    await mountHarness();
    const sessionId = useSessionStore.getState().currentSessionId;
    seedPendingRetry(sessionId);

    const turnMock = window.agentApi.turn as ReturnType<typeof vi.fn>;
    turnMock.mockRejectedValueOnce(makeIpcWrappedRefusal(sessionId, 'turn-busy-1'));

    let thrown: unknown;
    await act(async () => {
      try {
        await engineRef.current!.handleUserMessage(
          'refused send', 'text', undefined, undefined, undefined,
          { supersedePolicy: 'reject' },
        );
      } catch (err) {
        thrown = err;
      }
    });

    // Rethrown as the typed refusal, enriched with the persisted message id
    // (same-session path persists via addUserMessage before IPC).
    expect(isTargetBusyRejection(thrown)).toBe(true);
    const persistedMessage = useSessionStore.getState().messages.find(
      (m) => m.role === 'user' && m.text === 'refused send',
    );
    expect(persistedMessage).toBeDefined();
    expect(getRequeueMessageId(thrown)).toBe(persistedMessage!.id);

    // Not surfaced as a failure: no error banner, no run-failed toast.
    expect(useSessionStore.getState().lastError).toBeNull();
    expect(showToastMock).not.toHaveBeenCalled();

    // Defer-the-clear (FMM 14): the refusal means no replacement turn started
    // — the interrupted turn's retry state (and its attachment cache) must
    // survive so auto-resume still works.
    expect(useSessionStore.getState().pendingNetworkRetryTurns[sessionId]).toBeDefined();
    expect(window.agentApi.deleteCachedAttachments).not.toHaveBeenCalled();
  });

  it('reject-policy dispatch clears pending retry state AFTER successful admission (deferred, not skipped)', async () => {
    await mountHarness();
    const sessionId = useSessionStore.getState().currentSessionId;
    seedPendingRetry(sessionId);

    await act(async () => {
      await engineRef.current!.handleUserMessage(
        'admitted send', 'text', undefined, undefined, undefined,
        { supersedePolicy: 'reject' },
      );
    });

    expect(useSessionStore.getState().pendingNetworkRetryTurns[sessionId]).toBeUndefined();
  });

  it('non-reject dispatch keeps the legacy eager clear and error UX on failure', async () => {
    await mountHarness();
    const sessionId = useSessionStore.getState().currentSessionId;
    seedPendingRetry(sessionId);

    const turnMock = window.agentApi.turn as ReturnType<typeof vi.fn>;
    turnMock.mockRejectedValueOnce(new Error('genuine launch failure'));

    // No supersedePolicy: initiateAgentTurn swallows the error after
    // reporting it (legacy contract) — handleUserMessage resolves.
    await act(async () => {
      await engineRef.current!.handleUserMessage('legacy send', 'text');
    });

    // Eager clear ran before dispatch (unchanged semantics)…
    expect(useSessionStore.getState().pendingNetworkRetryTurns[sessionId]).toBeUndefined();
    // …and the failure surfaced through the existing error path.
    expect(useSessionStore.getState().lastError).toContain('genuine launch failure');
  });

  it('cross-session dispatch reuses a provided-but-not-found existingMessageId for the created message (FMM 9 dedup)', async () => {
    await mountHarness();
    const targetSessionId = 'background-target-session';

    await act(async () => {
      await engineRef.current!.handleUserMessage(
        'redrained after switch', 'text', undefined,
        'persisted-stable-id', targetSessionId,
        { supersedePolicy: 'reject' },
      );
    });

    const targetSession = useSessionStore.getState().loadedSessions.get(targetSessionId);
    expect(targetSession).toBeDefined();
    const insertedIds = targetSession!.messages.map((m) => m.id);
    expect(insertedIds).toContain('persisted-stable-id');
    // Exactly one copy — the stable id is what lets messageExistsInTarget dedup.
    expect(insertedIds.filter((id) => id === 'persisted-stable-id')).toHaveLength(1);
  });

  it('cross-session typed refusal leaves no orphan message in the target session', async () => {
    await mountHarness();
    const targetSessionId = 'busy-target-session';
    const turnMock = window.agentApi.turn as ReturnType<typeof vi.fn>;
    turnMock.mockRejectedValueOnce(makeIpcWrappedRefusal(targetSessionId, 'turn-busy-2'));

    let thrown: unknown;
    await act(async () => {
      try {
        await engineRef.current!.handleUserMessage(
          'cross-session refused', 'text', undefined, undefined, targetSessionId,
          { supersedePolicy: 'reject' },
        );
      } catch (err) {
        thrown = err;
      }
    });

    expect(isTargetBusyRejection(thrown)).toBe(true);
    // The target-session insert happens only in the post-IPC sessionChanged
    // branch, which a refusal never reaches.
    expect(useSessionStore.getState().loadedSessions.get(targetSessionId)).toBeUndefined();
    // And the viewed session's store didn't get the cross-session message either.
    expect(
      useSessionStore.getState().messages.some((m) => m.text === 'cross-session refused'),
    ).toBe(false);
  });
});
