// @vitest-environment happy-dom
/**
 * Producer × consumer matrix — terminal lifecycle events × queue-drain
 * wake-up (docs/plans/260611_recs-round4 Stage 3, rec 4fb8e113b07cda68;
 * REPEAT of 260531 prevention #1).
 *
 * The existing useMessageQueue suite drives the `isSessionBusy` gate with
 * hand-rolled callbacks; nothing pinned the REAL chain from a terminal event
 * to the drain wake-up:
 *
 *   processHistoryEvent(terminal)            [producer: sessionStore]
 *     → summary busy scalars flip            (new sessionSummaries array)
 *       → isSessionBusy callback identity    (App.tsx wires it on
 *         changes                             [sessionSummaries])
 *         → drain effect re-evaluates and    [consumer: useMessageQueue]
 *           dispatches the held message
 *
 * An absent busy-flip silently strands the queued message (the inverse —
 * draining while the target is busy — was incident f6b3e9b0). This suite
 * wires a REAL session store to useMessageQueue exactly the way App.tsx
 * does and drives terminal producers through processHistoryEvent.
 *
 * Negative contract: turn_superseded is a hand-over, not an end — the queue
 * must keep holding the target's messages until the SUPERSEDING turn ends.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCallback } from 'react';
import type { AgentEvent, AgentSessionSummary } from '@shared/types';

import { renderHook, act, flushAsync } from '@renderer/test-utils';
import { createSessionStore } from '../../store/sessionStore';
import { isSummaryBusyForQueueGate, useMessageQueue } from '../useMessageQueue';

vi.mock('@renderer/src/sentry', () => ({
  recordRendererBreadcrumb: vi.fn(),
  captureRendererMessage: vi.fn(),
}));

beforeEach(() => {
  vi.stubGlobal('sessionsApi', {
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue({ success: true }),
    applyTurnEventUnion: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  });
});

const VIEWED_SESSION = 'viewed-session';
const TARGET_SESSION = 'busy-target-session';
const TURN_ID = 'turn-1';

const makeSummary = (overrides: Partial<AgentSessionSummary>): AgentSessionSummary => ({
  id: overrides.id ?? TARGET_SESSION,
  title: overrides.title ?? 'Target session',
  createdAt: overrides.createdAt ?? Date.now(),
  updatedAt: overrides.updatedAt ?? Date.now(),
  resolvedAt: null,
  doneAt: null,
  starredAt: null,
  deletedAt: null,
  origin: 'manual',
  isCorrupted: false,
  preview: '',
  messageCount: 1,
  hasDraft: false,
  draftPreview: null,
  draftUpdatedAt: null,
  usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 1 },
  activeTurnId: overrides.activeTurnId ?? null,
  isBusy: overrides.isBusy ?? false,
  lastActivityAt: overrides.lastActivityAt ?? Date.now(),
  lastError: null,
});

type Harness = {
  store: ReturnType<typeof createSessionStore>;
  processMessage: ReturnType<typeof vi.fn>;
  result: { current: ReturnType<typeof useMessageQueue> };
  unmount: () => void;
};

/**
 * Render useMessageQueue wired to a REAL session store the way App.tsx wires
 * it: `isSessionBusy` derives from `sessionSummaries` via
 * `isSummaryBusyForQueueGate`, and gets a new identity whenever the
 * summaries array changes (the drain gate's wake-up signal).
 */
function renderQueueAgainstStore(): Harness {
  const store = createSessionStore();
  store.getState().setSessionSummaries([
    makeSummary({ id: TARGET_SESSION, isBusy: true, activeTurnId: TURN_ID }),
  ]);

  const processMessage = vi.fn().mockResolvedValue(undefined);

  const useHarness = () => {
    const summaries = store((s) => s.sessionSummaries);
    const isSessionBusy = useCallback(
      (sessionId: string) =>
        isSummaryBusyForQueueGate(summaries.find((s) => s.id === sessionId)),
      [summaries],
    );
    return useMessageQueue({
      isBusy: false,
      isStopping: false,
      currentSessionId: VIEWED_SESSION,
      isSessionBusy,
      stopActiveTurn: vi.fn().mockResolvedValue(undefined),
      processMessage,
      rerunEditedMessage: vi.fn().mockResolvedValue(undefined),
      emitLog: vi.fn(),
      showToast: vi.fn(),
    });
  };

  const { result, unmount } = renderHook(useHarness);
  return { store, processMessage, result, unmount };
}

async function enqueueHeldMessage(harness: Harness): Promise<void> {
  await act(async () => {
    await harness.result.current.handleUserMessage(
      'queued while target busy',
      'text',
      undefined,
      { targetSessionId: TARGET_SESSION },
    );
  });
  expect(harness.processMessage).not.toHaveBeenCalled();
  expect(harness.result.current.messageQueue).toHaveLength(1);
}

const TERMINAL_PRODUCERS: Array<{ label: string; event: AgentEvent }> = [
  {
    label: "result (turnEndReason: 'completed')",
    event: { type: 'result', text: 'done', timestamp: 2_000, seq: 2, turnEndReason: 'completed' } as AgentEvent,
  },
  {
    label: "result (turnEndReason: 'user_stopped')",
    event: { type: 'result', text: '', timestamp: 2_000, seq: 2, turnEndReason: 'user_stopped' } as AgentEvent,
  },
  {
    label: "result (turnEndReason: 'superseded' — synthetic superseded result)",
    event: { type: 'result', text: '', timestamp: 2_000, seq: 2, turnEndReason: 'superseded' } as AgentEvent,
  },
  {
    label: 'error',
    event: { type: 'error', error: 'provider exploded', timestamp: 2_000, seq: 2 } as AgentEvent,
  },
];

describe('terminal events × queue-drain wake-up (real store → real gate)', () => {
  it.each(TERMINAL_PRODUCERS)(
    '$label on the target session wakes the drain and dispatches the held message',
    async ({ event }) => {
      const harness = renderQueueAgainstStore();
      await enqueueHeldMessage(harness);

      // Producer: terminal event for the busy background target.
      await act(async () => {
        harness.store.getState().processHistoryEvent(TARGET_SESSION, TURN_ID, event);
      });
      await flushAsync();

      // Consumer: the held message drains to the now-idle target with the
      // queue-intent admission policy (never legacy interrupt semantics).
      expect(harness.processMessage).toHaveBeenCalledTimes(1);
      expect(harness.processMessage).toHaveBeenCalledWith(
        'queued while target busy',
        'text',
        undefined,
        undefined,
        TARGET_SESSION,
        expect.objectContaining({
          supersedePolicy: 'reject',
          messageOrigin: 'queue-drain',
        }),
      );
      expect(harness.result.current.messageQueue).toHaveLength(0);
      harness.unmount();
    },
  );

  it('NEGATIVE: turn_superseded does NOT wake the drain — the session is still busy with the superseding turn', async () => {
    const harness = renderQueueAgainstStore();
    await enqueueHeldMessage(harness);

    await act(async () => {
      harness.store.getState().processHistoryEvent(TARGET_SESSION, TURN_ID, {
        type: 'turn_superseded',
        newTurnId: 'turn-2',
        timestamp: 2_000,
      } as AgentEvent);
    });
    await flushAsync();

    expect(harness.processMessage).not.toHaveBeenCalled();
    expect(harness.result.current.messageQueue).toHaveLength(1);

    // The superseding turn's OWN terminal event is what releases the queue.
    await act(async () => {
      harness.store.getState().processHistoryEvent(TARGET_SESSION, 'turn-2', {
        type: 'result',
        text: 'done',
        timestamp: 3_000,
        seq: 3,
        turnEndReason: 'completed',
      } as AgentEvent);
    });
    await flushAsync();

    expect(harness.processMessage).toHaveBeenCalledTimes(1);
    expect(harness.result.current.messageQueue).toHaveLength(0);
    harness.unmount();
  });
});
