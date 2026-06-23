// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

// ─── Mock contribution IPC ──────────────────────────────────────────

const mockGetBySession = vi.fn();

// Mock the state mapping module — pure function, tested separately
vi.mock('@shared/utils/contributionStateMapping', () => ({
  mapContributionToCardState: vi.fn((contribution: any) => {
    if (!contribution) return null;
    // Stage 3 (260420): `testing` without errors is invisible — the agent
    // owns the testing phase end-to-end, so the card doesn't render.
    if (contribution.status === 'testing') {
      return null;
    }
    if (contribution.status === 'submitted') {
      return {
        phase: 'submitted',
        connectorName: contribution.connectorName,
        helperText: 'Under review',
        substatus: 'under_review',
      };
    }
    if (contribution.status === 'approved') {
      return {
        phase: 'submitted',
        connectorName: contribution.connectorName,
        helperText: 'Approved! Publishing soon.',
        substatus: 'approved',
      };
    }
    return { phase: 'submit-prompt', connectorName: contribution.connectorName, tools: [] };
  }),
}));

const mockRefreshStatus = vi.fn().mockResolvedValue({ success: true });

// Mock window.contributionApi (DomainApi maps channel names to camelCase methods)
(window as any).contributionApi = {
  getBySession: (...args: unknown[]) => mockGetBySession(...args),
  refreshStatus: (...args: unknown[]) => mockRefreshStatus(...args),
};

// Enable React act() environment
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = require('react-dom/client');
const { act: reactAct } = require('react');

import {
  IN_FLIGHT_BUDGET_EXHAUSTED_MESSAGE,
  useMcpBuildCardState,
} from '../useMcpBuildCardState';

// ── Minimal renderHook (same pattern as useSessionSearch.test.ts) ───

function renderHook<P, T>(
  hookFn: (props: P) => T,
  options?: { initialProps?: P },
): { result: { current: T }; rerender: (props: P) => void; unmount: () => void } {
  const result = { current: undefined as unknown as T };

  const TestComponent = (props: P) => {
    result.current = hookFn(props);
    return null;
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);

  reactAct(() => {
    root.render(React.createElement(TestComponent as any, options?.initialProps ?? {}));
  });

  return {
    result,
    rerender: (props: P) => {
      reactAct(() => {
        root.render(React.createElement(TestComponent as any, props as any));
      });
    },
    unmount: () => {
      reactAct(() => { root.unmount(); });
      container.remove();
    },
  };
}

/** Flush pending promises and microtasks within act(). */
async function flushAsync() {
  await reactAct(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ─── Helper wrapper for the hook (takes props object) ───────────────

function useHookWrapper(props: { sessionId: string | null | undefined }) {
  const { cardState } = useMcpBuildCardState(props.sessionId);
  return cardState;
}

function useFullHookWrapper(props: { sessionId: string | null | undefined }) {
  return useMcpBuildCardState(props.sessionId);
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('useMcpBuildCardState', () => {
  beforeEach(() => {
    mockGetBySession.mockReset();
  });

  // VAL-CARD-006: No card shown when no contribution for session
  it('returns null when sessionId is null', () => {
    const { result, unmount } = renderHook(useHookWrapper, {
      initialProps: { sessionId: null },
    });
    expect(result.current).toBeNull();
    unmount();
  });

  it('returns null when sessionId is undefined', () => {
    const { result, unmount } = renderHook(useHookWrapper, {
      initialProps: { sessionId: undefined },
    });
    expect(result.current).toBeNull();
    unmount();
  });

  // VAL-CARD-006: No card when no contribution exists
  it('returns null when no contribution exists for the session', async () => {
    mockGetBySession.mockResolvedValue({ contribution: null });

    const { result, unmount } = renderHook(useHookWrapper, {
      initialProps: { sessionId: 'session-no-contribution' },
    });

    await flushAsync();

    expect(mockGetBySession).toHaveBeenCalledWith({ sessionId: 'session-no-contribution' });
    expect(result.current).toBeNull();
    unmount();
  });

  // VAL-CARD-001: mcpBuildCardState derived from contribution store for current session
  it('derives card state from contribution for given session', async () => {
    mockGetBySession.mockResolvedValue({
      contribution: {
        id: 'c1',
        sessionId: 'session-1',
        connectorName: 'MyConnector',
        // Post-Stage-3: draft is the first visible phase (submit-prompt).
        status: 'draft',
      },
    });

    const { result, unmount } = renderHook(useHookWrapper, {
      initialProps: { sessionId: 'session-1' },
    });

    await flushAsync();

    expect(result.current).toEqual({
      phase: 'submit-prompt',
      connectorName: 'MyConnector',
      tools: [],
    });
    unmount();
  });

  // VAL-CARD-001: Session switch changes derived state
  it('updates state when sessionId changes', async () => {
    mockGetBySession.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'session-1') {
        return { contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'ConnA', status: 'draft' } };
      }
      if (sessionId === 'session-2') {
        return { contribution: { id: 'c2', sessionId: 'session-2', connectorName: 'ConnB', status: 'submitted' } };
      }
      return { contribution: null };
    });

    const { result, rerender, unmount } = renderHook(useHookWrapper, {
      initialProps: { sessionId: 'session-1' },
    });

    await flushAsync();
    expect(result.current?.phase).toBe('submit-prompt');

    // Switch session
    rerender({ sessionId: 'session-2' });
    await flushAsync();

    expect(result.current?.phase).toBe('submitted');
    expect(result.current?.connectorName).toBe('ConnB');
    unmount();
  });

  it('does not crash on IPC failure', async () => {
    mockGetBySession.mockRejectedValue(new Error('IPC failed'));

    const { result, unmount } = renderHook(useHookWrapper, {
      initialProps: { sessionId: 'session-1' },
    });

    await flushAsync();

    expect(mockGetBySession).toHaveBeenCalled();
    // Should remain null, not throw
    expect(result.current).toBeNull();
    unmount();
  });

  // VAL-CARD-005: Card reacts to store updates
  // Note: The hook polls every 2s. We test that the mechanism exists
  // by verifying multiple calls to the IPC channel over time.
  // The actual reactivity is integration-tested in contributionCrossIntegration.test.ts.
  it('calls IPC on mount to fetch contribution', async () => {
    mockGetBySession.mockResolvedValue({ contribution: null });

    const { unmount } = renderHook(useHookWrapper, {
      initialProps: { sessionId: 'session-poll' },
    });

    await flushAsync();

    expect(mockGetBySession).toHaveBeenCalledTimes(1);
    expect(mockGetBySession).toHaveBeenCalledWith({ sessionId: 'session-poll' });
    unmount();
  });

  // ── Stale-response race condition tests ──────────────────────────

  it('discards stale fetch when session switches before response arrives', async () => {
    // Simulate a slow response for session-1 that resolves AFTER session-2 is active
    let resolveSession1: (value: any) => void;
    const session1Promise = new Promise((resolve) => { resolveSession1 = resolve; });

    mockGetBySession.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'session-1') {
        return session1Promise;
      }
      if (sessionId === 'session-2') {
        return { contribution: { id: 'c2', sessionId: 'session-2', connectorName: 'ConnB', status: 'submitted' } };
      }
      return { contribution: null };
    });

    const { result, rerender, unmount } = renderHook(useHookWrapper, {
      initialProps: { sessionId: 'session-1' },
    });

    // session-1 fetch is now in-flight (slow)

    // Switch to session-2 before session-1 responds
    rerender({ sessionId: 'session-2' });
    await flushAsync();

    // session-2 resolved immediately
    expect(result.current?.phase).toBe('submitted');
    expect(result.current?.connectorName).toBe('ConnB');

    // Now session-1 finally resolves — should be discarded
    resolveSession1!({
      contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'ConnA', status: 'testing' },
    });
    await flushAsync();

    // State must still reflect session-2, not the stale session-1 response
    expect(result.current?.phase).toBe('submitted');
    expect(result.current?.connectorName).toBe('ConnB');
    unmount();
  });

  it('only applies responses matching current sessionId', async () => {
    // Track the order of setCardState calls by observing result.current
    let resolveSession1: (value: any) => void;
    const session1Promise = new Promise((resolve) => { resolveSession1 = resolve; });

    mockGetBySession.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'session-slow') {
        return session1Promise;
      }
      return { contribution: null };
    });

    const { result, rerender, unmount } = renderHook(useHookWrapper, {
      initialProps: { sessionId: 'session-slow' as string | null },
    });

    // Switch to null session (no contribution) before slow fetch resolves
    rerender({ sessionId: null });
    await flushAsync();

    expect(result.current).toBeNull();

    // Slow fetch resolves — should be discarded because session is now null
    resolveSession1!({
      contribution: { id: 'c1', sessionId: 'session-slow', connectorName: 'SlowConn', status: 'approved' },
    });
    await flushAsync();

    expect(result.current).toBeNull();
    unmount();
  });

  it('clears stale state immediately on session switch', async () => {
    // Start with session-1 having state
    mockGetBySession.mockResolvedValue({
      contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'ConnA', status: 'draft' },
    });

    const { result, rerender, unmount } = renderHook(useHookWrapper, {
      initialProps: { sessionId: 'session-1' },
    });

    await flushAsync();
    expect(result.current?.phase).toBe('submit-prompt');

    // Switch to session-2 which has no contribution (slow response)
    let resolveSession2: (value: any) => void;
    const session2Promise = new Promise((resolve) => { resolveSession2 = resolve; });
    mockGetBySession.mockImplementation(async () => session2Promise);

    rerender({ sessionId: 'session-2' });

    // State should be cleared immediately, before session-2 fetch resolves
    // (synchronous effect of the useEffect cleanup + re-run)
    await reactAct(async () => { await Promise.resolve(); });
    expect(result.current).toBeNull();

    // Resolve session-2
    resolveSession2!({ contribution: null });
    await flushAsync();

    expect(result.current).toBeNull();
    unmount();
  });

  // Regression: the sessionId-gating invariant prevents stale per-session
  // state from leaking to downstream effects during a session switch. Post-
  // Stage-3 the `testing` phase is invisible, so the equivalent failure
  // would be a stale `submit-prompt` phase from a prior session leaking
  // into the current session's render cycle.
  it('never exposes stale submit-prompt phase from prior session on session switch', async () => {
    // Session-1 has a contribution in draft phase (→ submit-prompt card).
    mockGetBySession.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'session-build') {
        return { contribution: { id: 'c1', sessionId: 'session-build', connectorName: 'ConnA', status: 'draft' } };
      }
      return { contribution: null };
    });

    // Track every value the hook returns (simulating what a useEffect would see)
    const observedStates: Array<{ phase: string; connectorName: string } | null> = [];

    function useObservingWrapper(props: { sessionId: string | null }) {
      const { cardState } = useMcpBuildCardState(props.sessionId);
      observedStates.push(
        cardState ? { phase: cardState.phase, connectorName: cardState.connectorName } : null,
      );
      return cardState;
    }

    const { rerender, unmount } = renderHook(useObservingWrapper, {
      initialProps: { sessionId: 'session-build' },
    });

    await flushAsync();
    expect(observedStates.some(s => s?.phase === 'submit-prompt' && s.connectorName === 'ConnA')).toBe(true);

    // Clear history — we only care about states observed after the switch
    observedStates.length = 0;

    // Switch to a non-build session
    rerender({ sessionId: 'session-other' });
    await flushAsync();

    // No render cycle should have exposed the stale submit-prompt state
    // from the prior session.
    const stalePhaseLeaked = observedStates.some(
      s => s?.phase === 'submit-prompt' && s.connectorName === 'ConnA',
    );
    expect(stalePhaseLeaked).toBe(false);
    unmount();
  });
});

// ─── Refresh status tests ───────────────────────────────────────────

describe('useMcpBuildCardState refresh', () => {
  beforeEach(() => {
    mockGetBySession.mockReset();
    mockRefreshStatus.mockReset();
    mockRefreshStatus.mockResolvedValue({ success: true });
  });

  it('triggers refreshStatus on mount for submitted-family contributions', async () => {
    mockGetBySession.mockResolvedValue({
      contribution: {
        id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'submitted',
      },
    });

    const { unmount } = renderHook(useFullHookWrapper, {
      initialProps: { sessionId: 'session-1' },
    });

    await flushAsync();
    expect(mockRefreshStatus).toHaveBeenCalledWith({ contributionId: 'c1' });
    unmount();
  });

  it('does not trigger refreshStatus for non-submitted contributions', async () => {
    mockGetBySession.mockResolvedValue({
      contribution: {
        id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft',
      },
    });

    const { unmount } = renderHook(useFullHookWrapper, {
      initialProps: { sessionId: 'session-1' },
    });

    await flushAsync();
    expect(mockRefreshStatus).not.toHaveBeenCalled();
    unmount();
  });

  it('exposes refreshStatus callback', async () => {
    mockGetBySession.mockResolvedValue({
      contribution: {
        id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'submitted',
      },
    });

    const { result, unmount } = renderHook(useFullHookWrapper, {
      initialProps: { sessionId: 'session-1' },
    });

    await flushAsync();
    mockRefreshStatus.mockClear();

    reactAct(() => { result.current.refreshStatus(); });
    expect(mockRefreshStatus).toHaveBeenCalledWith({ contributionId: 'c1', force: true });
    unmount();
  });

  // Stage 3 (260420): the hook no longer exposes `lastTransitionError` on
  // its return shape — there is no renderer consumer after the testing
  // phase UI was removed. The raw field remains on `ContributionRecord` for
  // the LLM-facing bridge-response self-correction path, and the state-
  // mapping layer attaches it to the `testing-error` card state directly.
  describe('UseMcpBuildCardResult shape (Stage 3)', () => {
    it('does not expose lastTransitionError on the hook return value', async () => {
      mockGetBySession.mockResolvedValue({ contribution: null });
      const { result, unmount } = renderHook(useFullHookWrapper, {
        initialProps: { sessionId: 'session-1' },
      });
      await flushAsync();
      expect(Object.prototype.hasOwnProperty.call(result.current, 'lastTransitionError')).toBe(false);
      unmount();
    });
  });

  // Stage 1 (260420 OSS MCP backend relay): surface refresh errors so
  // manual refresh clicks don't silently no-op when the relay or GitHub
  // is unreachable.
  describe('refreshError surfacing (Stage 1 — 260420)', () => {
    it('sets refreshError when refreshStatus returns a non-success body', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: {
          id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'submitted',
        },
      });
      mockRefreshStatus.mockResolvedValueOnce({ success: true }); // on-mount
      mockRefreshStatus.mockResolvedValueOnce({
        success: false,
        error: 'RATE_LIMIT',
        message: 'GitHub is rate-limiting us. Try again in a minute.',
      });

      const { result, unmount } = renderHook(useFullHookWrapper, {
        initialProps: { sessionId: 'session-1' },
      });
      await flushAsync();

      reactAct(() => { result.current.refreshStatus(); });
      await flushAsync();

      expect(result.current.refreshError).toBe(
        'GitHub is rate-limiting us. Try again in a minute.',
      );
      unmount();
    });

    // Pairs with contributionStatusService.test.ts "returns re-auth error
    // for GitHubReAuthRequiredError" — the server sets `reAuthRequired: true`
    // and the hook must propagate it unchanged so the toast surfaces the
    // "Reconnect GitHub" action. Covers fresh-expiry AND legacy unmigrated
    // token records (both collapse into this path server-side).
    it('exposes refreshErrorReAuthRequired when the server returns reAuthRequired:true', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: {
          id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'submitted',
        },
      });
      mockRefreshStatus.mockResolvedValueOnce({ success: true }); // on-mount
      mockRefreshStatus.mockResolvedValueOnce({
        success: false,
        error: 'Authentication expired. Please re-authenticate.',
        reAuthRequired: true,
      });

      const { result, unmount } = renderHook(useFullHookWrapper, {
        initialProps: { sessionId: 'session-1' },
      });
      await flushAsync();

      reactAct(() => { result.current.refreshStatus(); });
      await flushAsync();

      expect(result.current.refreshError).toBe('Authentication expired. Please re-authenticate.');
      expect(result.current.refreshErrorReAuthRequired).toBe(true);
      unmount();
    });

    it('leaves refreshErrorReAuthRequired false for non-auth refresh errors', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: {
          id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'submitted',
        },
      });
      mockRefreshStatus.mockResolvedValueOnce({ success: true }); // on-mount
      mockRefreshStatus.mockResolvedValueOnce({
        success: false,
        error: 'RATE_LIMIT',
        message: 'GitHub is rate-limiting us.',
      });

      const { result, unmount } = renderHook(useFullHookWrapper, {
        initialProps: { sessionId: 'session-1' },
      });
      await flushAsync();

      reactAct(() => { result.current.refreshStatus(); });
      await flushAsync();

      expect(result.current.refreshError).toBe('GitHub is rate-limiting us.');
      expect(result.current.refreshErrorReAuthRequired).toBe(false);
      unmount();
    });

    it('sets a transport-level refreshError when refreshStatus throws', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: {
          id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'submitted',
        },
      });
      mockRefreshStatus.mockResolvedValueOnce({ success: true }); // on-mount
      mockRefreshStatus.mockRejectedValueOnce(new Error('IPC broken'));

      const { result, unmount } = renderHook(useFullHookWrapper, {
        initialProps: { sessionId: 'session-1' },
      });
      await flushAsync();

      reactAct(() => { result.current.refreshStatus(); });
      await flushAsync();

      // Stage 1.1 (260420): transport-error copy is now subsystem-neutral —
      // the refresh path may call GitHub or the relay depending on
      // `attributionMode`, so leaking "community relay" into the UI is wrong.
      expect(result.current.refreshError).toContain("couldn't check for updates");
      expect(result.current.refreshError).not.toContain('community relay');
      unmount();
    });

    it('falls back to the machine error code when body omits message', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: {
          id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'submitted',
        },
      });
      mockRefreshStatus.mockResolvedValueOnce({ success: true }); // on-mount
      mockRefreshStatus.mockResolvedValueOnce({ success: false, error: 'VALIDATION' });

      const { result, unmount } = renderHook(useFullHookWrapper, {
        initialProps: { sessionId: 'session-1' },
      });
      await flushAsync();

      reactAct(() => { result.current.refreshStatus(); });
      await flushAsync();

      expect(result.current.refreshError).toBe('VALIDATION');
      unmount();
    });

    it('uses a generic fallback when neither message nor error is present', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: {
          id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'submitted',
        },
      });
      mockRefreshStatus.mockResolvedValueOnce({ success: true }); // on-mount
      mockRefreshStatus.mockResolvedValueOnce({ success: false });

      const { result, unmount } = renderHook(useFullHookWrapper, {
        initialProps: { sessionId: 'session-1' },
      });
      await flushAsync();

      reactAct(() => { result.current.refreshStatus(); });
      await flushAsync();

      expect(result.current.refreshError).toBe(
        "We couldn't get the latest update. Try again in a minute.",
      );
      unmount();
    });

    it('resets refreshError and isRefreshing when sessionId changes', async () => {
      // Stage 1.1 M1 (260420): a refresh error from session-A must NOT leak
      // into session-B. Same for the spinner state.
      mockGetBySession.mockResolvedValue({
        contribution: {
          id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'submitted',
        },
      });
      mockRefreshStatus.mockResolvedValueOnce({ success: true }); // on-mount for session-1
      mockRefreshStatus.mockResolvedValueOnce({
        success: false,
        error: 'RATE_LIMIT',
        message: 'GitHub rate-limited us.',
      });

      const { result, rerender, unmount } = renderHook(useFullHookWrapper, {
        initialProps: { sessionId: 'session-1' },
      });
      await flushAsync();

      reactAct(() => { result.current.refreshStatus(); });
      await flushAsync();
      expect(result.current.refreshError).toBe('GitHub rate-limited us.');

      // Switch to session-2; state should be cleared immediately.
      mockGetBySession.mockResolvedValue({ contribution: null });
      rerender({ sessionId: 'session-2' });
      await flushAsync();

      expect(result.current.refreshError).toBeNull();
      expect(result.current.isRefreshing).toBe(false);
      unmount();
    });

    it('ignores a late refresh result after session switches', async () => {
      // Stage 1.1 C3 (260420): a refresh in-flight when the user switches
      // conversations must not paint into the new session's UI.
      mockGetBySession.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
        if (sessionId === 'session-1') {
          return { contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'A', status: 'submitted' } };
        }
        return { contribution: null };
      });

      let resolveRefresh: (value: unknown) => void;
      const refreshPromise = new Promise((resolve) => { resolveRefresh = resolve; });
      mockRefreshStatus.mockResolvedValueOnce({ success: true }); // on-mount
      mockRefreshStatus.mockReturnValueOnce(refreshPromise as Promise<{ success: boolean }>);

      const { result, rerender, unmount } = renderHook(useFullHookWrapper, {
        initialProps: { sessionId: 'session-1' as string | null },
      });
      await flushAsync();

      // Kick off a manual refresh that will NOT resolve until we say so.
      reactAct(() => { result.current.refreshStatus(); });
      await flushAsync();

      // Switch session before the refresh completes.
      rerender({ sessionId: 'session-2' });
      await flushAsync();
      expect(result.current.refreshError).toBeNull();
      expect(result.current.isRefreshing).toBe(false);

      // Now resolve the stale refresh with a failure — it should be dropped.
      resolveRefresh!({ success: false, error: 'RATE_LIMIT', message: 'too fast' });
      await flushAsync();

      expect(result.current.refreshError).toBeNull();
      expect(result.current.isRefreshing).toBe(false);
      unmount();
    });

    it('clears refreshError on a subsequent successful refresh', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: {
          id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'submitted',
        },
      });
      mockRefreshStatus.mockResolvedValueOnce({ success: true }); // on-mount
      mockRefreshStatus.mockResolvedValueOnce({ success: false, error: 'RATE_LIMIT' });
      mockRefreshStatus.mockResolvedValueOnce({ success: true });

      const { result, unmount } = renderHook(useFullHookWrapper, {
        initialProps: { sessionId: 'session-1' },
      });
      await flushAsync();

      reactAct(() => { result.current.refreshStatus(); });
      await flushAsync();
      expect(result.current.refreshError).toBeTruthy();

      reactAct(() => { result.current.refreshStatus(); });
      await flushAsync();
      expect(result.current.refreshError).toBeNull();
      unmount();
    });
  });
});

// ─── Stage 6.1 M1 — IN_FLIGHT auto-backoff scheduler ───────────────

describe('useMcpBuildCardState — IN_FLIGHT auto-backoff (Stage 6.1 M1)', () => {
  const IN_FLIGHT_RESULT = { success: false, error: 'IN_FLIGHT' } as const;
  const OK_RESULT = { success: true } as const;

  // Total schedule = 2s + 4s + 8s + 16s + 30s + 30s + 30s = 120s (~2 min).
  const IN_FLIGHT_SCHEDULE_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000];

  beforeEach(() => {
    mockGetBySession.mockReset();
    mockRefreshStatus.mockReset();
    // Use a hybrid timer config: fake setTimeout / clearTimeout so we can
    // step through the backoff schedule, but keep microtasks on the real
    // queue so awaited promises still settle inside `await flushAsync()`.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Helper: step the fake clock forward and flush microtasks so any
   *  timer-triggered promise continuations (refreshStatus → setState)
   *  actually paint into the hook's result. */
  async function advance(ms: number) {
    await reactAct(async () => {
      vi.advanceTimersByTime(ms);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('keeps the spinner true and schedules a retry when refreshStatus returns IN_FLIGHT', async () => {
    mockGetBySession.mockResolvedValue({
      contribution: {
        id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'submitted',
      },
    });
    // on-mount refresh: allow it to resolve as OK so we isolate the click path
    mockRefreshStatus.mockResolvedValueOnce(OK_RESULT);

    const { result, unmount } = renderHook(useFullHookWrapper, {
      initialProps: { sessionId: 'session-1' },
    });
    await flushAsync();

    // Manual click resolves with IN_FLIGHT — scheduler takes over.
    mockRefreshStatus.mockResolvedValueOnce(IN_FLIGHT_RESULT);
    reactAct(() => { result.current.refreshStatus(); });
    await flushAsync();

    // Spinner still true, no error surfaced — backoff is silent.
    expect(result.current.isRefreshing).toBe(true);
    expect(result.current.refreshError).toBeNull();

    // A setTimeout was queued for the first schedule entry (2s).
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
  });

  it('clears the spinner and refreshError when a retry in the chain succeeds', async () => {
    mockGetBySession.mockResolvedValue({
      contribution: {
        id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'submitted',
      },
    });
    mockRefreshStatus.mockResolvedValueOnce(OK_RESULT); // on-mount

    const { result, unmount } = renderHook(useFullHookWrapper, {
      initialProps: { sessionId: 'session-1' },
    });
    await flushAsync();

    // Click → IN_FLIGHT → (wait 2s) → OK.
    mockRefreshStatus.mockResolvedValueOnce(IN_FLIGHT_RESULT);
    mockRefreshStatus.mockResolvedValueOnce(OK_RESULT);
    reactAct(() => { result.current.refreshStatus(); });
    await flushAsync();

    expect(result.current.isRefreshing).toBe(true);

    // Advance past the first backoff slot (2s).
    await advance(IN_FLIGHT_SCHEDULE_MS[0]);

    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.refreshError).toBeNull();
    // one click + one retry = 2 calls after the on-mount.
    expect(mockRefreshStatus).toHaveBeenCalledTimes(3);
    unmount();
  });

  it('surfaces the neutral IN_FLIGHT budget-exhausted sentinel after the schedule runs out', async () => {
    mockGetBySession.mockResolvedValue({
      contribution: {
        id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'submitted',
      },
    });
    mockRefreshStatus.mockResolvedValueOnce(OK_RESULT); // on-mount
    // Every subsequent call stays IN_FLIGHT so the schedule exhausts.
    mockRefreshStatus.mockResolvedValue(IN_FLIGHT_RESULT);

    const { result, unmount } = renderHook(useFullHookWrapper, {
      initialProps: { sessionId: 'session-1' },
    });
    await flushAsync();

    reactAct(() => { result.current.refreshStatus(); });
    await flushAsync();

    // Walk every scheduled backoff slot; each one re-arms the next.
    for (const ms of IN_FLIGHT_SCHEDULE_MS) {
      await advance(ms);
    }

    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.refreshError).toBe(IN_FLIGHT_BUDGET_EXHAUSTED_MESSAGE);
    unmount();
  });

  it('cancels a pending backoff timer when the user clicks refresh again', async () => {
    mockGetBySession.mockResolvedValue({
      contribution: {
        id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'submitted',
      },
    });
    mockRefreshStatus.mockResolvedValueOnce(OK_RESULT); // on-mount

    const { result, unmount } = renderHook(useFullHookWrapper, {
      initialProps: { sessionId: 'session-1' },
    });
    await flushAsync();

    // First click: IN_FLIGHT → schedules a 2s retry.
    mockRefreshStatus.mockResolvedValueOnce(IN_FLIGHT_RESULT);
    reactAct(() => { result.current.refreshStatus(); });
    await flushAsync();

    const refreshCallsBeforeSecondClick = mockRefreshStatus.mock.calls.length;
    expect(result.current.isRefreshing).toBe(true);

    // Second click preempts: the pending backoff timer must be cancelled
    // so we don't end up with two parallel refresh chains.
    mockRefreshStatus.mockResolvedValueOnce(OK_RESULT);
    reactAct(() => { result.current.refreshStatus(); });
    await flushAsync();

    // Advancing past the first scheduled slot must NOT invoke refreshStatus
    // again — the timer was cancelled by the second click.
    await advance(IN_FLIGHT_SCHEDULE_MS[0] + 1_000);

    // After the preempting click settled: one additional call was made by
    // the click itself (which resolved OK, clearing the spinner). The
    // cancelled retry did NOT fire.
    expect(mockRefreshStatus).toHaveBeenCalledTimes(refreshCallsBeforeSecondClick + 1);
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.refreshError).toBeNull();
    unmount();
  });

  it('drops pending backoff retries when the session switches', async () => {
    mockGetBySession.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'session-1') {
        return {
          contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'A', status: 'submitted' },
        };
      }
      return { contribution: null };
    });
    mockRefreshStatus.mockResolvedValueOnce(OK_RESULT); // on-mount

    const { result, rerender, unmount } = renderHook(useFullHookWrapper, {
      initialProps: { sessionId: 'session-1' as string | null },
    });
    await flushAsync();

    // Start an IN_FLIGHT chain for session-1.
    mockRefreshStatus.mockResolvedValueOnce(IN_FLIGHT_RESULT);
    reactAct(() => { result.current.refreshStatus(); });
    await flushAsync();

    const callsBeforeSwitch = mockRefreshStatus.mock.calls.length;
    expect(result.current.isRefreshing).toBe(true);

    // Switch conversations — the backoff timer must be cancelled AND the
    // spinner / error state must be session-scoped to session-2's null.
    rerender({ sessionId: 'session-2' });
    await flushAsync();

    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.refreshError).toBeNull();

    // Even if we step time forward beyond the entire schedule, the
    // cancelled chain must NOT resume into the new session.
    for (const ms of IN_FLIGHT_SCHEDULE_MS) {
      await advance(ms);
    }
    expect(mockRefreshStatus).toHaveBeenCalledTimes(callsBeforeSwitch);
    unmount();
  });
});

// ─── Stage 4 — multi-build telemetry warn (260426 foolproof flow) ───
//
// `useMcpBuildCardState` fires a structured `console.warn` once per growth
// transition when a session has multiple linked builds (matrix #25). These
// tests pin the cadence + payload shape, including the per-session reset
// invariant. Telemetry-only — no UX behaviour change.
//
// See docs/plans/260426_foolproof_contribution_flow_stage4.md.

describe('useMcpBuildCardState — multi-build telemetry warn (Stage 4)', () => {
  const MULTI_BUILD_MSG = 'multiple builds detected';

  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetBySession.mockReset();
    mockRefreshStatus.mockReset();
    mockRefreshStatus.mockResolvedValue({ success: true });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function multiBuildCalls(): unknown[][] {
    return (warnSpy.mock.calls as unknown[][]).filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes(MULTI_BUILD_MSG),
    );
  }

  // Hidden gotcha #6: keep the existing IN_FLIGHT block on its narrower
  // fake-timer matrix. The 1→2 growth-transition test uses `setInterval`
  // for hook polling, scoped to this describe via `beforeEach`/`afterEach`.
  it('does not warn when linkedContributionsCount is undefined (legacy IPC)', async () => {
    mockGetBySession.mockResolvedValue({
      contribution: { id: 'c1', sessionId: 's1', connectorName: 'A', status: 'draft' },
      // linkedContributionsCount intentionally absent
    });

    const { unmount } = renderHook(useFullHookWrapper, { initialProps: { sessionId: 's1' } });
    await flushAsync();

    expect(multiBuildCalls()).toHaveLength(0);
    unmount();
  });

  it('does not warn when linkedContributionsCount is 1', async () => {
    mockGetBySession.mockResolvedValue({
      contribution: { id: 'c1', sessionId: 's1', connectorName: 'A', status: 'draft' },
      linkedContributionsCount: 1,
    });

    const { unmount } = renderHook(useFullHookWrapper, { initialProps: { sessionId: 's1' } });
    await flushAsync();

    expect(multiBuildCalls()).toHaveLength(0);
    unmount();
  });

  it('warns exactly once when linkedContributionsCount transitions from 1 → 2', async () => {
    // Drive the count from outside the mock so we can step it on the second poll.
    let resolveCount = 1;
    mockGetBySession.mockImplementation(async () => ({
      contribution: { id: 'c-active', sessionId: 's1', connectorName: 'A', status: 'draft' },
      linkedContributionsCount: resolveCount,
    }));

    // Hidden gotcha #6: scope `setInterval` faking to this test only — the
    // existing IN_FLIGHT block uses a narrower (setTimeout-only) matrix.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { unmount } = renderHook(useFullHookWrapper, { initialProps: { sessionId: 's1' } });
      await reactAct(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // First fetch returned count=1 — no warn yet.
      expect(multiBuildCalls()).toHaveLength(0);

      // Bump the count and advance the polling interval (2s) so the next
      // poll observes the growth.
      resolveCount = 2;
      await reactAct(async () => {
        vi.advanceTimersByTime(2_000);
        await Promise.resolve();
        await Promise.resolve();
      });

      const matching = multiBuildCalls();
      expect(matching).toHaveLength(1);

      const [msg, data] = matching[0];
      expect(msg).toContain('multiple builds detected for session');
      expect(data).toMatchObject({
        component: 'useMcpBuildCardState',
        event: 'multiple_builds_detected',
        sessionId: 's1',
        activeContributionId: 'c-active',
        totalContributionsForSession: 2,
        previousLoggedCount: 0,
      });

      // Subsequent polls at the same count must NOT re-warn (cadence guard).
      await reactAct(async () => {
        vi.advanceTimersByTime(2_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(multiBuildCalls()).toHaveLength(1);

      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets the warn tracker on session switch and re-warns for the new session', async () => {
    mockGetBySession.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'sA') {
        return {
          contribution: { id: 'cA', sessionId: 'sA', connectorName: 'A', status: 'draft' },
          linkedContributionsCount: 2,
        };
      }
      if (sessionId === 'sB') {
        return {
          contribution: { id: 'cB', sessionId: 'sB', connectorName: 'B', status: 'draft' },
          linkedContributionsCount: 2,
        };
      }
      return { contribution: null, linkedContributionsCount: 0 };
    });

    const { rerender, unmount } = renderHook(useFullHookWrapper, {
      initialProps: { sessionId: 'sA' as string | null },
    });
    await flushAsync();

    let matching = multiBuildCalls();
    expect(matching).toHaveLength(1);
    expect((matching[0][1] as { sessionId: string }).sessionId).toBe('sA');

    rerender({ sessionId: 'sB' });
    await flushAsync();

    matching = multiBuildCalls();
    expect(matching).toHaveLength(2); // one per session — tracker reset on switch
    expect((matching[1][1] as { sessionId: string }).sessionId).toBe('sB');
    expect((matching[1][1] as { previousLoggedCount: number }).previousLoggedCount).toBe(0);

    unmount();
  });
});
