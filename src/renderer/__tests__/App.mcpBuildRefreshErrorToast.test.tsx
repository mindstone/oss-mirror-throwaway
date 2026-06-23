// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';

// Enable React act() environment
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = require('react-dom/client');
const { act: reactAct } = require('react');

import { useMcpBuildRefreshErrorToast } from '@renderer/features/agent-session/hooks/useMcpBuildRefreshErrorToast';
import { IN_FLIGHT_BUDGET_EXHAUSTED_MESSAGE } from '@renderer/features/agent-session/hooks/useMcpBuildCardState';

// ─── Stage 1.1 M4 (260420 OSS MCP backend relay) ─────────────────────
//
// The App-level toast dedupe for `mcpBuildRefreshError` lives in a
// dedicated hook (`useMcpBuildRefreshErrorToast`). We test the hook in
// isolation rather than rendering the full App tree, but keep this test
// file named `App.*` because the behaviour is conceptually owned by
// App.tsx (it's the one consumer that maps refresh-error-to-toast).

type ShowToastArg = {
  title: string;
  variant?: string;
  action?: { label: string; onClick: () => void } | unknown;
};

function renderHarness(props: {
  sessionId: string | null;
  refreshError: string | null;
  refreshErrorReAuthRequired?: boolean;
  showToast: (msg: ShowToastArg) => void;
}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);

  const Harness = (p: typeof props) => {
    useMcpBuildRefreshErrorToast({
      sessionId: p.sessionId,
      refreshError: p.refreshError,
      refreshErrorReAuthRequired: p.refreshErrorReAuthRequired,
      showToast: p.showToast,
    });
    return null;
  };

  reactAct(() => {
    root.render(React.createElement(Harness, props));
  });

  return {
    rerender: (next: typeof props) => {
      reactAct(() => {
        root.render(React.createElement(Harness, next));
      });
    },
    unmount: () => {
      reactAct(() => { root.unmount(); });
      container.remove();
    },
  };
}

type ShowToastFn = (msg: ShowToastArg) => void;

describe('useMcpBuildRefreshErrorToast — App-level dedupe', () => {
  let showToast: ShowToastFn & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    showToast = vi.fn() as ShowToastFn & ReturnType<typeof vi.fn>;
  });

  it('fires one toast for the same message repeated in a row', () => {
    const { rerender, unmount } = renderHarness({
      sessionId: 'session-1',
      refreshError: 'Rate-limited.',
      showToast,
    });
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Rate-limited.', variant: 'error' }),
    );

    // Same message again (no session change) — no new toast.
    rerender({
      sessionId: 'session-1',
      refreshError: 'Rate-limited.',
      showToast,
    });
    expect(showToast).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('fires a second toast when the message changes', () => {
    const { rerender, unmount } = renderHarness({
      sessionId: 'session-1',
      refreshError: 'Rate-limited.',
      showToast,
    });
    expect(showToast).toHaveBeenCalledTimes(1);

    rerender({
      sessionId: 'session-1',
      refreshError: 'Network unreachable.',
      showToast,
    });
    expect(showToast).toHaveBeenCalledTimes(2);
    expect(showToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Network unreachable.' }),
    );
    unmount();
  });

  it('re-fires the same message when session changes between them', () => {
    const { rerender, unmount } = renderHarness({
      sessionId: 'session-1',
      refreshError: 'Rate-limited.',
      showToast,
    });
    expect(showToast).toHaveBeenCalledTimes(1);

    // Session switch resets the dedupe ref.
    rerender({
      sessionId: 'session-2',
      refreshError: null,
      showToast,
    });
    // Same error surfaces in session-2 — dedupe is scoped per-session, so this fires.
    rerender({
      sessionId: 'session-2',
      refreshError: 'Rate-limited.',
      showToast,
    });
    expect(showToast).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('does not fire when refreshError is null', () => {
    const { rerender, unmount } = renderHarness({
      sessionId: 'session-1',
      refreshError: null,
      showToast,
    });
    expect(showToast).not.toHaveBeenCalled();

    // Transitioning null → null stays quiet.
    rerender({ sessionId: 'session-1', refreshError: null, showToast });
    expect(showToast).not.toHaveBeenCalled();
    unmount();
  });

  it('clears dedupe when refreshError returns to null', () => {
    const { rerender, unmount } = renderHarness({
      sessionId: 'session-1',
      refreshError: 'Rate-limited.',
      showToast,
    });
    expect(showToast).toHaveBeenCalledTimes(1);

    rerender({ sessionId: 'session-1', refreshError: null, showToast });
    // Same error afterward — re-fires because the dedupe ref was cleared.
    rerender({ sessionId: 'session-1', refreshError: 'Rate-limited.', showToast });
    expect(showToast).toHaveBeenCalledTimes(2);
    unmount();
  });

  // Stage 6.1 M1 (260420 OSS MCP backend relay): the IN_FLIGHT backoff
  // scheduler surfaces a "still processing" sentinel through the same
  // `refreshError` channel when it exhausts its retry budget. That message
  // is NOT an error — it's a reassuring progress update — so the toast
  // must render with a neutral (default) variant, not the destructive
  // `error` variant used for actual failures.
  it('renders the IN_FLIGHT budget-exhausted sentinel with neutral variant (no error styling)', () => {
    const { unmount } = renderHarness({
      sessionId: 'session-1',
      refreshError: IN_FLIGHT_BUDGET_EXHAUSTED_MESSAGE,
      showToast,
    });
    expect(showToast).toHaveBeenCalledTimes(1);
    const call = showToast.mock.calls[0][0];
    expect(call.title).toBe(IN_FLIGHT_BUDGET_EXHAUSTED_MESSAGE);
    // Default (neutral) variant — explicitly NOT 'error'.
    expect(call.variant).toBeUndefined();
    unmount();
  });

  it('keeps the error variant for other refresh errors (regression guard)', () => {
    const { unmount } = renderHarness({
      sessionId: 'session-1',
      refreshError: 'GitHub is rate-limiting us.',
      showToast,
    });
    expect(showToast).toHaveBeenCalledTimes(1);
    const call = showToast.mock.calls[0][0];
    expect(call.variant).toBe('error');
    unmount();
  });

  it('does nothing after unmount', () => {
    const { rerender, unmount } = renderHarness({
      sessionId: 'session-1',
      refreshError: 'Rate-limited.',
      showToast,
    });
    expect(showToast).toHaveBeenCalledTimes(1);

    unmount();
    // Calling rerender after unmount shouldn't happen in practice; just verify
    // that the initial count stayed at 1 (no delayed calls from effects).
    expect(showToast).toHaveBeenCalledTimes(1);

    // Silence unused-variable lint from the outer scope.
    void rerender;
  });

  // ── Re-authentication action (auth-expired / unmigrated token) ────
  //
  // When the main-process refresh path throws `GitHubReAuthRequiredError`,
  // the handler returns `reAuthRequired: true`. The toast hook must surface
  // the error as a recoverable warning. Covers BOTH the normal expired-token
  // case AND the legacy unmigrated token case (no refresh_token stored) —
  // the main process collapses both into the same
  // `GitHubReAuthRequiredError` path.
  describe('reAuthRequired warning', () => {
    it('renders a warning-variant toast when reAuthRequired is true', () => {
      const { unmount } = renderHarness({
        sessionId: 'session-1',
        refreshError: 'Authentication expired. Please re-authenticate.',
        refreshErrorReAuthRequired: true,
        showToast,
      });
      expect(showToast).toHaveBeenCalledTimes(1);
      const call = showToast.mock.calls[0][0] as ShowToastArg;
      expect(call.title).toBe('Authentication expired. Please re-authenticate.');
      // Warning, not error — the error is recoverable, but the deleted
      // contribution OAuth flow no longer provides a reconnect action.
      expect(call.variant).toBe('warning');
      expect(call.action).toBeUndefined();
      unmount();
    });

    it('does NOT attach an action when reAuthRequired is false', () => {
      const { unmount } = renderHarness({
        sessionId: 'session-1',
        refreshError: 'GitHub is rate-limiting us.',
        refreshErrorReAuthRequired: false,
        showToast,
      });
      const call = showToast.mock.calls[0][0] as ShowToastArg;
      expect(call.variant).toBe('error');
      expect(call.action).toBeUndefined();
      unmount();
    });

    it('does NOT attach an action when reAuthRequired is omitted (legacy callers)', () => {
      const { unmount } = renderHarness({
        sessionId: 'session-1',
        refreshError: 'GitHub is rate-limiting us.',
        showToast,
      });
      const call = showToast.mock.calls[0][0] as ShowToastArg;
      expect(call.action).toBeUndefined();
      unmount();
    });
  });
});
