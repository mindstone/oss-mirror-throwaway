// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAgentSessionEngine, type AgentSessionEngineApi } from '../useAgentSessionEngine';
import {
  appendRendererOptimisticTurnStartedEvent,
  clearCurrentSessionEvents,
  getCurrentSessionEventsForTurn,
  isCurrentSessionProjectionBusy,
  isRendererLocalTerminalEvent,
  removeRendererOptimisticTurnStartedEvent,
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

function TestHarness() {
  engineRef.current = useAgentSessionEngine({
    emitLog: vi.fn(),
    recordBreadcrumb: vi.fn(),
    showToast: vi.fn(),
  });
  return null;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // @ts-expect-error - testing env
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  vi.stubGlobal('sessionsApi', {
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
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
    turn: vi.fn().mockResolvedValue({ turnId: 'test-turn-1' }),
    evaluateDoneSafety: vi.fn().mockResolvedValue({ safeToMarkDone: false, reason: 'test' }),
  });

  act(() => {
    clearCurrentSessionEvents();
    useSessionStore.getState().resetSession();
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
  vi.useRealTimers();
});

describe('useAgentSessionEngine — stop watchdog (Stage 3 Phase 6)', () => {
  it('force-clears isBusy after 30s when no terminal event arrives following stopActiveTurn', async () => {
    await act(async () => {
      root!.render(createElement(TestHarness));
    });
    expect(engineRef.current).not.toBeNull();

    const turnId = 'turn-watchdog-1';

    act(() => {
      appendRendererOptimisticTurnStartedEvent(turnId);
      useSessionStore.setState({ activeTurnId: turnId });
      const store = useSessionStore.getState();
      const summary = store.sessionSummaries.find((s) => s.id === store.currentSessionId);
      if (summary) {
        store.updateSessionSummary({ ...summary, isBusy: true, activeTurnId: turnId });
      }
    });

    expect(isCurrentSessionProjectionBusy(useSessionStore.getState())).toBe(true);
    expect(useSessionStore.getState().isStopping).toBe(false);

    await act(async () => {
      void engineRef.current!.stopActiveTurn();
    });

    expect(useSessionStore.getState().isStopping).toBe(true);
    expect(isCurrentSessionProjectionBusy(useSessionStore.getState())).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(isCurrentSessionProjectionBusy(useSessionStore.getState())).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(isCurrentSessionProjectionBusy(useSessionStore.getState())).toBe(false);
  });

  it('does NOT force-clear when a terminal event arrives before the 30s watchdog deadline', async () => {
    await act(async () => {
      root!.render(createElement(TestHarness));
    });
    expect(engineRef.current).not.toBeNull();

    const turnId = 'turn-watchdog-2';

    act(() => {
      appendRendererOptimisticTurnStartedEvent(turnId);
      useSessionStore.setState({ activeTurnId: turnId });
      const store = useSessionStore.getState();
      const summary = store.sessionSummaries.find((s) => s.id === store.currentSessionId);
      if (summary) {
        store.updateSessionSummary({ ...summary, isBusy: true, activeTurnId: turnId });
      }
    });

    await act(async () => {
      void engineRef.current!.stopActiveTurn();
    });

    expect(isCurrentSessionProjectionBusy(useSessionStore.getState())).toBe(true);

    act(() => {
      removeRendererOptimisticTurnStartedEvent(turnId);
    });

    expect(isCurrentSessionProjectionBusy(useSessionStore.getState())).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });

    expect(isCurrentSessionProjectionBusy(useSessionStore.getState())).toBe(false);
  });

  it('terminalizes a real running turn when stopTurn returns not found', async () => {
    await act(async () => {
      root!.render(createElement(TestHarness));
    });
    expect(engineRef.current).not.toBeNull();

    const turnId = 'turn-real-running-stop';
    act(() => {
      const store = useSessionStore.getState();
      store.addUserMessage('Run to stop');
      const messageId = useSessionStore.getState().messages[0]?.id;
      if (!messageId) throw new Error('Expected user message id');
      store.assignTurnToMessage(messageId, turnId, Date.now());
      store.processEvent(turnId, {
        type: 'turn_started',
        timestamp: Date.now(),
      });
    });

    expect(isCurrentSessionProjectionBusy(useSessionStore.getState())).toBe(true);

    vi.mocked(window.agentApi.stopTurn).mockResolvedValueOnce({
      success: false,
      reason: 'Turn not found',
    });
    await act(async () => {
      await engineRef.current!.stopActiveTurn();
    });

    expect(isCurrentSessionProjectionBusy(useSessionStore.getState())).toBe(false);
    expect(
      getCurrentSessionEventsForTurn(turnId).some((event) => isRendererLocalTerminalEvent(event)),
    ).toBe(true);
  });
});
