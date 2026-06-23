// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentEvent } from '@shared/types';
import { useAgentSessionEngine, type AgentSessionEngineApi } from '../useAgentSessionEngine';
import {
  clearCurrentSessionEvents,
  getCurrentSessionEvents,
  getCurrentSessionEventsForTurn,
  isCurrentSessionProjectionBusy,
  isRendererLocalTerminalEvent,
  isRendererOptimisticTurnStartedEvent,
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

type AgentEventEnvelope = {
  turnId: string;
  event: AgentEvent;
  sessionId?: string;
};

const engineRef: { current: AgentSessionEngineApi | null } = { current: null };

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
let onAgentEventHandler: ((payload: AgentEventEnvelope) => void) | null = null;

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
    onAgentEvent: vi.fn((handler: (payload: AgentEventEnvelope) => void) => {
      onAgentEventHandler = handler;
      return () => {
        onAgentEventHandler = null;
      };
    }),
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
  onAgentEventHandler = null;
  clearCurrentSessionEvents();
});

describe('useAgentSessionEngine optimistic turn start', () => {
  it('shows busy immediately on send before real turnId resolves', async () => {
    await act(async () => {
      root!.render(createElement(TestHarness));
    });
    expect(engineRef.current).not.toBeNull();

    const deferredTurn = createDeferred<{ turnId: string }>();
    const turnMock = window.agentApi.turn as ReturnType<typeof vi.fn>;
    turnMock.mockReturnValueOnce(deferredTurn.promise);

    let sendPromise: Promise<void> | null = null;
    await act(async () => {
      sendPromise = engineRef.current!.handleUserMessage('Immediate busy check', 'text');
      await Promise.resolve();
    });

    const requestedClientTurnId = turnMock.mock.calls[0]?.[0]?.clientTurnId as string | undefined;
    expect(requestedClientTurnId).toBeTruthy();
    expect(isCurrentSessionProjectionBusy(useSessionStore.getState())).toBe(true);
    expect(engineRef.current!.isBusy).toBe(true);
    expect(
      getCurrentSessionEventsForTurn(requestedClientTurnId!).some(isRendererOptimisticTurnStartedEvent),
    ).toBe(true);

    deferredTurn.resolve({ turnId: 'real-turn-immediate' });
    await act(async () => {
      await sendPromise;
    });
  });

  it('removes synthetic start when real turn_started arrives', async () => {
    await act(async () => {
      root!.render(createElement(TestHarness));
    });
    expect(engineRef.current).not.toBeNull();

    const turnMock = window.agentApi.turn as ReturnType<typeof vi.fn>;
    turnMock.mockResolvedValueOnce({ turnId: 'real-turn-started' });

    await act(async () => {
      await engineRef.current!.handleUserMessage('Supersede on turn_started', 'text');
    });

    const requestedClientTurnId = turnMock.mock.calls[0]?.[0]?.clientTurnId as string | undefined;
    expect(requestedClientTurnId).toBeTruthy();
    expect(
      getCurrentSessionEventsForTurn(requestedClientTurnId!).some(isRendererOptimisticTurnStartedEvent),
    ).toBe(true);

    await act(async () => {
      onAgentEventHandler?.({
        turnId: 'real-turn-started',
        sessionId: useSessionStore.getState().currentSessionId,
        event: {
          type: 'turn_started',
          timestamp: Date.now(),
        },
      });
    });

    expect(getCurrentSessionEventsForTurn(requestedClientTurnId!)).toEqual([]);
    expect(
      Object.prototype.hasOwnProperty.call(getCurrentSessionEvents(), requestedClientTurnId!),
    ).toBe(false);
    expect(
      getCurrentSessionEventsForTurn('real-turn-started').some(isRendererOptimisticTurnStartedEvent),
    ).toBe(false);
  });

  it('removes synthetic start when terminal event arrives before turn_started', async () => {
    await act(async () => {
      root!.render(createElement(TestHarness));
    });
    expect(engineRef.current).not.toBeNull();

    const turnMock = window.agentApi.turn as ReturnType<typeof vi.fn>;
    turnMock.mockResolvedValueOnce({ turnId: 'real-turn-terminal-first' });

    await act(async () => {
      await engineRef.current!.handleUserMessage('Terminal first supersede', 'text');
    });

    const requestedClientTurnId = turnMock.mock.calls[0]?.[0]?.clientTurnId as string | undefined;
    expect(requestedClientTurnId).toBeTruthy();
    expect(
      getCurrentSessionEventsForTurn(requestedClientTurnId!).some(isRendererOptimisticTurnStartedEvent),
    ).toBe(true);

    await act(async () => {
      onAgentEventHandler?.({
        turnId: 'real-turn-terminal-first',
        sessionId: useSessionStore.getState().currentSessionId,
        event: {
          type: 'result',
          text: 'done',
          timestamp: Date.now(),
        },
      });
    });

    expect(getCurrentSessionEventsForTurn(requestedClientTurnId!)).toEqual([]);
    expect(
      Object.prototype.hasOwnProperty.call(getCurrentSessionEvents(), requestedClientTurnId!),
    ).toBe(false);
    expect(isCurrentSessionProjectionBusy(useSessionStore.getState())).toBe(false);
    expect(engineRef.current!.isBusy).toBe(false);
  });

  it('cleans synthetic start when terminal event arrives before turn IPC resolves', async () => {
    await act(async () => {
      root!.render(createElement(TestHarness));
    });
    expect(engineRef.current).not.toBeNull();

    const deferredTurn = createDeferred<{ turnId: string }>();
    const turnMock = window.agentApi.turn as ReturnType<typeof vi.fn>;
    turnMock.mockReturnValueOnce(deferredTurn.promise);

    let sendPromise: Promise<void> | null = null;
    await act(async () => {
      sendPromise = engineRef.current!.handleUserMessage('Pre-ack terminal race', 'text');
      await Promise.resolve();
    });

    const requestedClientTurnId = turnMock.mock.calls[0]?.[0]?.clientTurnId as string | undefined;
    expect(requestedClientTurnId).toBeTruthy();
    const realTurnId = 'real-turn-pre-ack-terminal';

    await act(async () => {
      onAgentEventHandler?.({
        turnId: realTurnId,
        sessionId: useSessionStore.getState().currentSessionId,
        event: {
          type: 'result',
          text: 'finished before ack',
          timestamp: Date.now(),
        },
      });
    });

    expect(
      getCurrentSessionEventsForTurn(requestedClientTurnId!).some(isRendererOptimisticTurnStartedEvent),
    ).toBe(true);

    deferredTurn.resolve({ turnId: realTurnId });
    await act(async () => {
      await sendPromise;
    });

    expect(getCurrentSessionEventsForTurn(requestedClientTurnId!)).toEqual([]);
    expect(
      Object.prototype.hasOwnProperty.call(getCurrentSessionEvents(), requestedClientTurnId!),
    ).toBe(false);
    expect(isCurrentSessionProjectionBusy(useSessionStore.getState())).toBe(false);
  });

  it('clears synthetic start when turn IPC rejects', async () => {
    await act(async () => {
      root!.render(createElement(TestHarness));
    });
    expect(engineRef.current).not.toBeNull();

    const turnMock = window.agentApi.turn as ReturnType<typeof vi.fn>;
    turnMock.mockRejectedValueOnce(new Error('turn IPC rejected'));

    await act(async () => {
      await engineRef.current!.handleUserMessage('Send failure cleanup', 'text');
    });

    const requestedClientTurnId = turnMock.mock.calls[0]?.[0]?.clientTurnId as string | undefined;
    expect(requestedClientTurnId).toBeTruthy();
    expect(getCurrentSessionEventsForTurn(requestedClientTurnId!)).toEqual([]);
    expect(
      Object.prototype.hasOwnProperty.call(getCurrentSessionEvents(), requestedClientTurnId!),
    ).toBe(false);
    expect(isCurrentSessionProjectionBusy(useSessionStore.getState())).toBe(false);
    expect(engineRef.current!.isBusy).toBe(false);
  });

  it('applies pre-ack stop intent to correlated real turn and prevents re-prime on later turn_started', async () => {
    await act(async () => {
      root!.render(createElement(TestHarness));
    });
    expect(engineRef.current).not.toBeNull();

    const deferredTurn = createDeferred<{ turnId: string }>();
    const turnMock = window.agentApi.turn as ReturnType<typeof vi.fn>;
    turnMock.mockReturnValueOnce(deferredTurn.promise);

    const stopTurnMock = window.agentApi.stopTurn as ReturnType<typeof vi.fn>;
    stopTurnMock.mockResolvedValueOnce({
      success: false,
      reason: 'Turn not found',
    });
    stopTurnMock.mockResolvedValueOnce({ success: true });

    let sendPromise: Promise<void> | null = null;
    await act(async () => {
      sendPromise = engineRef.current!.handleUserMessage('Stop before ack', 'text');
      await Promise.resolve();
    });

    const requestedClientTurnId = turnMock.mock.calls[0]?.[0]?.clientTurnId as string | undefined;
    expect(requestedClientTurnId).toBeTruthy();
    expect(isCurrentSessionProjectionBusy(useSessionStore.getState())).toBe(true);

    await act(async () => {
      await engineRef.current!.stopActiveTurn();
    });

    expect(isCurrentSessionProjectionBusy(useSessionStore.getState())).toBe(false);
    expect(getCurrentSessionEventsForTurn(requestedClientTurnId!)).toEqual([]);
    expect(
      Object.prototype.hasOwnProperty.call(getCurrentSessionEvents(), requestedClientTurnId!),
    ).toBe(false);
    expect(stopTurnMock.mock.calls[0]?.[0]).toBe(requestedClientTurnId);

    const realTurnId = 'real-turn-after-pre-ack-stop';
    deferredTurn.resolve({ turnId: realTurnId });
    await act(async () => {
      await sendPromise;
    });

    expect(stopTurnMock.mock.calls[1]?.[0]).toBe(realTurnId);
    expect(
      getCurrentSessionEventsForTurn(realTurnId).some(isRendererLocalTerminalEvent),
    ).toBe(true);

    await act(async () => {
      onAgentEventHandler?.({
        turnId: realTurnId,
        sessionId: useSessionStore.getState().currentSessionId,
        event: {
          type: 'turn_started',
          timestamp: Date.now(),
        },
      });
    });

    expect(isCurrentSessionProjectionBusy(useSessionStore.getState())).toBe(false);
  });

  it('keeps projection terminal when a real terminal arrives after a renderer-local terminal marker', async () => {
    await act(async () => {
      root!.render(createElement(TestHarness));
    });
    expect(engineRef.current).not.toBeNull();

    const turnId = 'turn-late-real-terminal';
    act(() => {
      const store = useSessionStore.getState();
      store.addUserMessage('Run with late terminal');
      const messageId = useSessionStore.getState().messages[0]?.id;
      if (!messageId) throw new Error('Expected user message id');
      store.assignTurnToMessage(messageId, turnId, Date.now());
      store.processEvent(turnId, {
        type: 'turn_started',
        timestamp: Date.now(),
      });
    });

    const stopTurnMock = window.agentApi.stopTurn as ReturnType<typeof vi.fn>;
    stopTurnMock.mockResolvedValueOnce({
      success: false,
      reason: 'Turn not found',
    });

    await act(async () => {
      await engineRef.current!.stopActiveTurn();
    });

    expect(isCurrentSessionProjectionBusy(useSessionStore.getState())).toBe(false);
    expect(
      getCurrentSessionEventsForTurn(turnId).filter(isRendererLocalTerminalEvent),
    ).toHaveLength(1);

    await act(async () => {
      onAgentEventHandler?.({
        turnId,
        sessionId: useSessionStore.getState().currentSessionId,
        event: {
          type: 'error',
          error: 'real late terminal',
          timestamp: Date.now(),
        },
      });
    });

    expect(
      getCurrentSessionEventsForTurn(turnId).filter(isRendererLocalTerminalEvent),
    ).toHaveLength(1);
    expect(isCurrentSessionProjectionBusy(useSessionStore.getState())).toBe(false);
  });
});
