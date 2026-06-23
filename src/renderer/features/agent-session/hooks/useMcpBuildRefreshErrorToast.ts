/**
 * useMcpBuildRefreshErrorToast
 *
 * Surface the MCP build card's manual-refresh failures as toasts with
 * de-duplication — firing the same message twice in a row (e.g. user
 * clicks refresh repeatedly while rate-limited) should produce ONE
 * toast, not a flood.
 *
 * The dedupe ref resets on session change so that an error surfaced in
 * conversation A can still fire after the user switches to conversation
 * B and encounters the same upstream failure.
 *
 * Stage 1.1 M1 of `docs/plans/260420_oss_mcp_backend_relay.md`.
 *
 * Stage 6.1 M1 of the same plan: the IN_FLIGHT budget-exhausted sentinel
 * is surfaced via the same `refreshError` channel but is NOT an error —
 * the submission is valid and the backend is still processing. We detect
 * the sentinel here and render a neutral toast so the user sees a
 * reassuring "still processing" banner rather than a destructive-looking
 * error state.
 */

import { useEffect, useRef } from 'react';
import type { ShowToastFn } from '@renderer/contexts/AppContext';
import { IN_FLIGHT_BUDGET_EXHAUSTED_MESSAGE } from './useMcpBuildCardState';

export interface UseMcpBuildRefreshErrorToastArgs {
  /** Current sessionId — used to reset the dedupe ref on session switch. */
  sessionId: string | null | undefined;
  /** Most-recent refresh error message from useMcpBuildCardState (null when OK). */
  refreshError: string | null | undefined;
  /**
   * True when the most-recent refresh failure is a re-auth-required
   * signal from the GitHub path. When set, the toast renders a
   * warning variant.
   */
  refreshErrorReAuthRequired?: boolean;
  /** Toast surface. */
  showToast: ShowToastFn;
}

export function useMcpBuildRefreshErrorToast(args: UseMcpBuildRefreshErrorToastArgs): void {
  const { sessionId, refreshError, refreshErrorReAuthRequired, showToast } = args;
  const lastShownRef = useRef<string | null>(null);

  // Reset dedupe when switching sessions so the same message can re-fire
  // for a different conversation's refresh path.
  useEffect(() => {
    lastShownRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    if (refreshError && refreshError !== lastShownRef.current) {
      lastShownRef.current = refreshError;

      // Re-auth-required: surface as a recoverable warning with an inline
      // "Reconnect GitHub" action. Covers both the expired-token path and
      // the legacy pre-refresh-rotation token path — the main process sets
      // reAuthRequired: true for both via GitHubReAuthRequiredError.
      if (refreshErrorReAuthRequired) {
        showToast({ title: refreshError, variant: 'warning' });
        return;
      }

      // Stage 6.1 M1: the IN_FLIGHT budget-exhausted sentinel is terminal but
      // NOT an error — render it as a neutral toast (default variant) so the
      // user sees "still processing" rather than a destructive-looking toast.
      const variant = refreshError === IN_FLIGHT_BUDGET_EXHAUSTED_MESSAGE
        ? undefined
        : 'error';
      showToast({ title: refreshError, variant });
    } else if (!refreshError) {
      lastShownRef.current = null;
    }
  }, [refreshError, refreshErrorReAuthRequired, showToast]);
}
