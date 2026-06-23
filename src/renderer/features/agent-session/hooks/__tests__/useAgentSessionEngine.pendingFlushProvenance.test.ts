// @vitest-environment happy-dom
//
// Stage 19a refinement (Fix 1) — preserve envelope provenance through the
// pending-event queue.
//
// `onAgentEvent` queues live events in `pendingEventsRef` when a turn cannot
// yet be resolved to a session, then flushes them via `assignTurnToSession`.
// Before the fix the flush dropped the envelope `eventSessionId` provenance, so
// a queued live event was re-validated on flush against `event.sessionId` /
// `accepted-legacy` only — a phantom guard for queued live events; an
// envelope-only-foreign queued event could slip into the foreground. The fix
// queues `{ event, eventSessionId }` and threads `eventSessionId` to
// `processAgentEvent` on flush, so a queued live event is validated against its
// TRUE provenance — exactly like the immediate (non-queued) path.
//
// Two layers of coverage:
//   1. `dispatchPendingEventsForTurn` (the extracted, pure flush-dispatch
//      helper): the RED-without-fix contract — an envelope-only-foreign queued
//      event is dispatched WITH its captured provenance, so the store guard can
//      reject it. (Drop the 4th arg → the envelope-only-foreign case is no
//      longer validated → fails.)
//   2. The REAL hook end-to-end through its `onAgentEvent` IPC callback:
//      behaviour preservation (a legitimate queued event still flushes; a
//      foreign queued event is dropped) against the live session store.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  useAgentSessionEngine,
  dispatchPendingEventsForTurn,
  type PendingAgentEvent,
} from '../useAgentSessionEngine';
import {
  useSessionStore,
  getCurrentSessionEventsForTurn,
} from '../../store/sessionStore';
import {
  __resetEventSessionValidationDiagnosticsForTest,
  getEventSessionValidationDiagnostics,
} from '@shared/utils/eventSessionValidation';
import type { AgentEvent } from '@shared/types';

vi.mock('@renderer/contexts', () => ({
  useEmitLog: vi.fn(() => vi.fn()),
  useRecordBreadcrumb: vi.fn(() => vi.fn()),
}));

vi.mock('@renderer/src/sentry', () => ({
  captureRendererException: vi.fn(),
  captureRendererMessage: vi.fn(),
  recordRendererBreadcrumb: vi.fn(),
}));

const statusEvent = (message: string): AgentEvent => ({
  type: 'status',
  message,
  timestamp: Date.now(),
});

// ===========================================================================
// Layer 1 — the flush-dispatch contract (RED-without-fix).
// ===========================================================================
describe('dispatchPendingEventsForTurn — threads captured envelope provenance (Stage 19a Fix 1)', () => {
  it('passes each queued event WITH its captured eventSessionId (envelope-only-foreign provenance survives the flush)', () => {
    const turnId = 'turn-flush';
    const sessionId = 'resolved-session';
    // The decisive case: the event object itself carries NO sessionId; the ONLY
    // provenance is the envelope `eventSessionId` captured at enqueue, and it is
    // FOREIGN. Before the fix this provenance was dropped on flush and the event
    // fell back to accepted-legacy.
    const pending: PendingAgentEvent[] = [
      { event: statusEvent('envelope-only-foreign'), eventSessionId: 'foreign-session' },
      { event: statusEvent('legit'), eventSessionId: sessionId },
      { event: statusEvent('no-provenance') }, // eventSessionId undefined
    ];

    const dispatch = vi.fn();
    dispatchPendingEventsForTurn(turnId, sessionId, pending, dispatch);

    // FIFO ordering preserved AND the 4th arg carries the captured provenance.
    expect(dispatch).toHaveBeenNthCalledWith(1, turnId, sessionId, pending[0].event, 'foreign-session');
    expect(dispatch).toHaveBeenNthCalledWith(2, turnId, sessionId, pending[1].event, sessionId);
    expect(dispatch).toHaveBeenNthCalledWith(3, turnId, sessionId, pending[2].event, undefined);
  });
});

// ===========================================================================
// Layer 2 — end-to-end through the real hook + live store.
// ===========================================================================
type OnAgentEventPayload = { turnId: string; event: AgentEvent; sessionId?: string };
let onEventCallback: ((payload: OnAgentEventPayload) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  __resetEventSessionValidationDiagnosticsForTest();
  onEventCallback = null;
  // @ts-expect-error - testing env
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  vi.stubGlobal('sessionsApi', {
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  });

  vi.stubGlobal('api', {
    onAgentEvent: vi.fn((cb) => {
      onEventCallback = cb;
      return () => { onEventCallback = null; };
    }),
    onSessionTitleGenerated: vi.fn(() => () => {}),
    onSessionActivitySummaryGenerated: vi.fn(() => () => {}),
    onSafetyEvaluating: vi.fn(() => () => {}),
    onSafetyEvaluated: vi.fn(() => () => {}),
    onSafetyEvaluatingComplete: vi.fn(() => () => {}),
  });

  vi.stubGlobal('agentApi', {
    onSessionTitleGenerated: vi.fn(() => () => {}),
    stopTurn: vi.fn().mockResolvedValue(undefined),
    turn: vi.fn().mockResolvedValue({ turnId: 'test-turn-1' }),
    evaluateDoneSafety: vi.fn().mockResolvedValue({ safeToMarkDone: false, reason: 'test' }),
  });
});

afterEach(() => {
  __resetEventSessionValidationDiagnosticsForTest();
});

function TestHarness() {
  useAgentSessionEngine({
    emitLog: vi.fn(),
    recordBreadcrumb: vi.fn(),
    showToast: vi.fn(),
  });
  return null;
}

async function mountHook() {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(TestHarness));
  });
  expect(onEventCallback).not.toBeNull();
  return root;
}

describe('useAgentSessionEngine — pending-queue flush (real hook, live store)', () => {
  it('a FOREIGN event that queues-then-flushes is REJECTED at the foreground ingress', async () => {
    const store = useSessionStore;
    const activeSessionId = 'fg-active-session';
    const foreignSessionId = 'bg-foreign-session';
    const turnId = 'turn-queued-foreign';

    act(() => {
      store.getState().resetSession();
      store.setState({ currentSessionId: activeSessionId });
    });

    const root = await mountHook();

    // Event for an unresolvable turn, foreign provenance on the event itself,
    // no envelope → it queues.
    const foreignEvent = {
      ...statusEvent('foreign leak via queue'),
      sessionId: foreignSessionId,
    } as AgentEvent;

    await act(async () => {
      onEventCallback!({ turnId, event: foreignEvent, sessionId: undefined });
    });
    expect(getCurrentSessionEventsForTurn(turnId)).toHaveLength(0);

    // Turn resolves to the active session (activeTurnId fallback) → flush.
    act(() => { store.setState({ activeTurnId: turnId }); });
    await act(async () => {
      onEventCallback!({
        turnId,
        event: { ...statusEvent('active follow-up'), sessionId: activeSessionId } as AgentEvent,
        sessionId: activeSessionId,
      });
    });

    const foregroundEvents = getCurrentSessionEventsForTurn(turnId);
    expect(
      foregroundEvents.some((e) => (e as { message?: string }).message === 'foreign leak via queue'),
    ).toBe(false);

    const diag = getEventSessionValidationDiagnostics();
    expect(diag.rejectsByKey['ipc-agent-event:rejected-foreign:status']).toBeGreaterThanOrEqual(1);

    await act(async () => { root.unmount(); });
  });

  it('a LEGITIMATE same-session event that queues-then-flushes still WRITES (no false drop)', async () => {
    const store = useSessionStore;
    const activeSessionId = 'fg-active-session-2';
    const turnId = 'turn-queued-legit';

    act(() => {
      store.getState().resetSession();
      store.setState({ currentSessionId: activeSessionId });
    });

    const root = await mountHook();

    const legitEvent = {
      ...statusEvent('legit queued'),
      sessionId: activeSessionId,
    } as AgentEvent;

    await act(async () => {
      onEventCallback!({ turnId, event: legitEvent, sessionId: undefined });
    });
    expect(getCurrentSessionEventsForTurn(turnId)).toHaveLength(0);

    act(() => { store.setState({ activeTurnId: turnId }); });
    await act(async () => {
      onEventCallback!({
        turnId,
        event: { ...statusEvent('legit follow-up'), sessionId: activeSessionId } as AgentEvent,
        sessionId: activeSessionId,
      });
    });

    const foregroundEvents = getCurrentSessionEventsForTurn(turnId);
    expect(
      foregroundEvents.some((e) => (e as { message?: string }).message === 'legit queued'),
    ).toBe(true);

    const diag = getEventSessionValidationDiagnostics();
    expect(diag.rejectsByKey).toEqual({});

    await act(async () => { root.unmount(); });
  });
});
