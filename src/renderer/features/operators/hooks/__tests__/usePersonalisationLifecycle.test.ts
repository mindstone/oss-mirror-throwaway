// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanupFakeTimers,
  renderHook,
  setupFakeTimers,
} from '@renderer/test-utils/hookTestHarness';
import {
  clearPersonalisationSessionRegistry,
  registerPersonalisationSession,
} from '../../state/personalisationSessionRegistry';

interface FakeSummary {
  id: string;
  origin?: string;
  resolvedAt: number | null;
  deletedAt: number | null;
  updatedAt: number;
}

interface FakeStoreState {
  sessionSummaries: FakeSummary[];
}

type Listener = (state: FakeStoreState, prev: FakeStoreState) => void;

const { storeState, listeners, useSessionStoreMock } = vi.hoisted(() => {
  const state: FakeStoreState = { sessionSummaries: [] };
  const subscribers: Listener[] = [];
  const setState = (next: Partial<FakeStoreState>) => {
    const prev = { sessionSummaries: state.sessionSummaries };
    if (next.sessionSummaries !== undefined) {
      state.sessionSummaries = next.sessionSummaries;
    }
    for (const subscriber of [...subscribers]) {
      subscriber(state, prev);
    }
  };
  const useSessionStore = Object.assign(
    () => state,
    {
      getState: () => state,
      subscribe: (subscriber: Listener) => {
        subscribers.push(subscriber);
        return () => {
          const idx = subscribers.indexOf(subscriber);
          if (idx >= 0) subscribers.splice(idx, 1);
        };
      },
      setState,
    },
  );
  return { storeState: state, listeners: subscribers, useSessionStoreMock: useSessionStore };
});

vi.mock('@renderer/features/agent-session/store/sessionStore', () => ({
  useSessionStore: useSessionStoreMock,
}));

import { usePersonalisationLifecycle } from '../usePersonalisationLifecycle';

const setSummaries = (summaries: FakeSummary[]) => {
  (useSessionStoreMock as unknown as { setState: (next: { sessionSummaries: FakeSummary[] }) => void })
    .setState({ sessionSummaries: summaries });
};

describe('usePersonalisationLifecycle', () => {
  beforeEach(() => {
    setupFakeTimers();
    storeState.sessionSummaries = [];
    listeners.splice(0, listeners.length);
    clearPersonalisationSessionRegistry();
  });

  afterEach(() => {
    cleanupFakeTimers();
    clearPersonalisationSessionRegistry();
  });

  it('tracks operators after markStarted and clears them after markEnded', () => {
    const now = 1_000;
    const { result } = renderHook(() => usePersonalisationLifecycle(() => now));

    expect(result.current.isPersonalising('op-1')).toBe(false);

    act(() => {
      result.current.markStarted({ operatorId: 'op-1', sessionId: 'session-a' });
    });
    expect(result.current.isPersonalising('op-1')).toBe(true);

    act(() => {
      result.current.markEnded('op-1');
    });
    expect(result.current.isPersonalising('op-1')).toBe(false);
  });

  it('clears the operator entry after the idle timeout elapses', () => {
    const now = 0;
    const { result } = renderHook(() => usePersonalisationLifecycle(() => now));

    act(() => {
      result.current.markStarted({ operatorId: 'op-1', sessionId: 'session-a' });
    });
    expect(result.current.isPersonalising('op-1')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    });

    expect(result.current.isPersonalising('op-1')).toBe(false);
  });

  it('clears the operator when the session is resolved', () => {
    const now = 0;
    const { result } = renderHook(() => usePersonalisationLifecycle(() => now));

    setSummaries([
      { id: 'session-a', resolvedAt: null, deletedAt: null, updatedAt: 0 },
    ]);

    act(() => {
      result.current.markStarted({ operatorId: 'op-1', sessionId: 'session-a' });
    });
    expect(result.current.isPersonalising('op-1')).toBe(true);

    act(() => {
      setSummaries([
        { id: 'session-a', resolvedAt: 5_000, deletedAt: null, updatedAt: 5_000 },
      ]);
    });
    expect(result.current.isPersonalising('op-1')).toBe(false);
  });

  it('clears the operator when the session is soft-deleted', () => {
    const now = 0;
    const { result } = renderHook(() => usePersonalisationLifecycle(() => now));

    setSummaries([
      { id: 'session-a', resolvedAt: null, deletedAt: null, updatedAt: 0 },
    ]);

    act(() => {
      result.current.markStarted({ operatorId: 'op-1', sessionId: 'session-a' });
    });
    expect(result.current.isPersonalising('op-1')).toBe(true);

    act(() => {
      setSummaries([
        { id: 'session-a', resolvedAt: null, deletedAt: 10_000, updatedAt: 10_000 },
      ]);
    });
    expect(result.current.isPersonalising('op-1')).toBe(false);
  });

  it('preserves the personalising badge across panel unmount/remount via the session registry + summaries', () => {
    setSummaries([
      { id: 'session-a', origin: 'operator-personalisation', resolvedAt: null, deletedAt: null, updatedAt: 0 },
    ]);
    registerPersonalisationSession({ sessionId: 'session-a', operatorId: 'op-1' });

    const first = renderHook(() => usePersonalisationLifecycle(() => 0));
    expect(first.result.current.isPersonalising('op-1')).toBe(true);

    first.unmount();

    const second = renderHook(() => usePersonalisationLifecycle(() => 0));
    expect(second.result.current.isPersonalising('op-1')).toBe(true);

    act(() => {
      setSummaries([
        { id: 'session-a', origin: 'operator-personalisation', resolvedAt: 5_000, deletedAt: null, updatedAt: 5_000 },
      ]);
    });
    expect(second.result.current.isPersonalising('op-1')).toBe(false);
  });

  it('does not extend the idle window when unrelated store mutations fire without changing the tracked session updatedAt', () => {
    const now = 0;
    const { result } = renderHook(() => usePersonalisationLifecycle(() => now));

    setSummaries([
      { id: 'session-a', resolvedAt: null, deletedAt: null, updatedAt: 0 },
    ]);

    act(() => {
      result.current.markStarted({ operatorId: 'op-1', sessionId: 'session-a' });
    });
    expect(result.current.isPersonalising('op-1')).toBe(true);

    // Fire 10 unrelated store mutations that do NOT change the tracked session's updatedAt.
    // The original (buggy) implementation re-scheduled the idle timer on every mutation
    // because scheduleIdleClear was called inside the reducer; the fixed implementation
    // only re-schedules when the tracked session's updatedAt actually advances.
    for (let i = 0; i < 10; i++) {
      act(() => {
        setSummaries([
          { id: 'session-a', resolvedAt: null, deletedAt: null, updatedAt: 0 },
          { id: `unrelated-${i}`, resolvedAt: null, deletedAt: null, updatedAt: i + 1 },
        ]);
      });
    }
    expect(result.current.isPersonalising('op-1')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    });

    expect(result.current.isPersonalising('op-1')).toBe(false);
  });
});
