// Stage 19a refinement (Fix 2) — make the cross-session validator's drop /
// accepted-legacy outcomes observable in PRODUCTION.
//
// The validator's per-tuple counters and the `cross-session-event-dropped`
// Sentry *breadcrumb* only surface attached to a later captured error, so a
// steady-state over-drop OR a residual foreign-accept would otherwise be
// silent. The fix escalates to a standalone, production-readable Sentry
// *message* (`captureRendererMessage`, the established message-sink pattern)
// fired once per (source, outcome, eventType) tuple, so an operator can SEE the
// foreign-drop rate and the accepted-legacy rate on the Sentry issues page.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';

const { captureRendererMessage, recordRendererBreadcrumb } = vi.hoisted(() => ({
  captureRendererMessage: vi.fn(),
  recordRendererBreadcrumb: vi.fn(),
}));

vi.mock('@renderer/src/sentry', () => ({
  captureRendererMessage,
  recordRendererBreadcrumb,
  captureRendererException: vi.fn(),
}));

import {
  appendEventToCurrentSession,
  createSessionStore,
  setCurrentSessionEvents,
  clearCurrentSessionEvents,
  __resetValidationOutcomeReportingForTest,
  __resetShadowBusyReflipWarningsForTest,
} from '../sessionStore';
import {
  __resetEventSessionValidationDiagnosticsForTest,
  beginValidatedSessionWrite,
} from '@shared/utils/eventSessionValidation';

const statusEventForSession = (message: string, sessionId: string): AgentEvent =>
  ({ type: 'status', message, timestamp: Date.now(), sessionId }) as AgentEvent;

const statusEventNoProvenance = (message: string): AgentEvent =>
  ({ type: 'status', message, timestamp: Date.now() }) as AgentEvent;

describe('Stage 19a Fix 2 — production-readable validator telemetry', () => {
  const A = 'session-A-telemetry';
  const B = 'session-B-telemetry';

  beforeEach(() => {
    vi.clearAllMocks();
    clearCurrentSessionEvents();
    __resetEventSessionValidationDiagnosticsForTest();
    __resetValidationOutcomeReportingForTest();
    __resetShadowBusyReflipWarningsForTest();
  });

  it('fires a standalone rejected-foreign message (warning) on the first foreign drop', () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: A });

    store.getState().processEvent('turn-x', statusEventForSession('foreign', B), B);

    expect(captureRendererMessage).toHaveBeenCalledWith(
      'cross-session-event-rejected-foreign',
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          crossSessionOutcome: 'rejected-foreign',
          crossSessionSource: 'ipc-agent-event',
          crossSessionEventType: 'status',
        }),
      }),
    );
  });

  it('fires the rejected-foreign message ONCE per tuple (cheap — subsequent drops only bump the counter)', () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: A });

    store.getState().processEvent('turn-1', statusEventForSession('foreign 1', B), B);
    store.getState().processEvent('turn-2', statusEventForSession('foreign 2', B), B);
    store.getState().processEvent('turn-3', statusEventForSession('foreign 3', B), B);

    const rejectCalls = captureRendererMessage.mock.calls.filter(
      ([msg]) => msg === 'cross-session-event-rejected-foreign',
    );
    expect(rejectCalls).toHaveLength(1);
    // The first sample carries the running count from the validator diagnostics.
    expect(rejectCalls[0][1].extra.firstSeenCount).toBeGreaterThanOrEqual(1);
  });

  it('fires a standalone accepted-legacy message (info) so the legacy rate is visible', () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: A });

    store.getState().processEvent('turn-legacy', statusEventNoProvenance('no provenance'));

    expect(captureRendererMessage).toHaveBeenCalledWith(
      'cross-session-event-accepted-legacy',
      expect.objectContaining({
        level: 'info',
        tags: expect.objectContaining({
          crossSessionOutcome: 'accepted-legacy',
          crossSessionSource: 'ipc-agent-event',
        }),
      }),
    );
  });

  it('does NOT fire any message for a legitimate same-session event (no false signal)', () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: A });

    store.getState().processEvent('turn-ok', statusEventForSession('legit', A), A);

    expect(captureRendererMessage).not.toHaveBeenCalled();
  });

  it('keys the once-per-tuple message by source, so a bulk-import drop reports separately from the live drop', () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: A });

    // Live foreground foreign drop.
    store.getState().processEvent('turn-live', statusEventForSession('live foreign', B), B);
    // Bulk-import foreign drop (different source tuple).
    setCurrentSessionEvents(
      { 'turn-import': [statusEventForSession('import foreign', B)] },
      beginValidatedSessionWrite(A, 'history-hydration'),
    );

    const sources = captureRendererMessage.mock.calls
      .filter(([msg]) => msg === 'cross-session-event-rejected-foreign')
      .map(([, ctx]) => ctx.tags.crossSessionSource)
      .sort();
    expect(sources).toEqual(['history-hydration', 'ipc-agent-event']);
  });

  it('Stage 1 P3: warns once when a settled write flips isBusy false->true on a turn with terminal evidence', () => {
    const store = createSessionStore();
    const turnId = 'turn-shadow-reflip';
    store.setState({
      currentSessionId: A,
      activeTurnId: null,
      isBusy: false,
      terminatedTurnIds: new Set<string>(),
    });
    appendEventToCurrentSession(turnId, {
      type: 'result',
      text: 'done',
      timestamp: Date.now(),
      sessionId: A,
    } as AgentEvent);

    // Non-reducer write path simulation: re-enter busy on an already-terminal turn.
    store.setState({ isBusy: true, activeTurnId: turnId });
    store.setState({ isBusy: false, activeTurnId: null });
    store.setState({ isBusy: true, activeTurnId: turnId });

    const shadowBusyCalls = recordRendererBreadcrumb.mock.calls.filter(
      ([payload]) =>
        payload?.category === 'shadow-busy-reflip-detected',
    );
    expect(shadowBusyCalls).toHaveLength(1);
    expect(shadowBusyCalls[0][0]).toMatchObject({
      level: 'warning',
      data: expect.objectContaining({
        hasTerminalEvent: true,
      }),
    });
  });
});
