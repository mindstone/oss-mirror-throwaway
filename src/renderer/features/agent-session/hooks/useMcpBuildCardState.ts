/**
 * Hook to derive MCPBuildCardState from the contribution store
 * for the currently viewed session.
 *
 * Fetches contribution data via IPC (contribution:get-by-session)
 * and maps it through the state mapping utility.
 *
 * Returns null when no contribution exists for the session,
 * causing MCPBuildCard to not render.
 *
 * Also triggers a GitHub status refresh on mount when the contribution
 * is in a submitted-family state (has a prUrl), and exposes a manual
 * refreshStatus callback. The 5-minute debounce is enforced server-side
 * by contributionStatusService (staleness threshold).
 *
 * @see src/core/services/contributionStateMapping.ts
 * @see src/main/services/contributionStatusService.ts
 * @see docs/plans/260410_oss_mcp_integration_forward_plan.md (P3, D1)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { MCPBuildCardState } from '../components/MCPBuildCard';
import {
  mapContributionToCardState,
  type ContributionRecord,
} from '@shared/utils/contributionStateMapping';
import { computeEmfileBackoffDelay, isEmfileError } from '@renderer/utils/emfileBackoff';

/** Polling interval for contribution state updates (ms). */
const POLL_INTERVAL_MS = 2000;
/**
 * Number of consecutive EMFILE/ENFILE failures before the polling loop
 * switches to a longer cooldown so the OS can recover file descriptors.
 * Also see REBEL-1HF — `useMcpBuildCardState`'s 2s polling against
 * `contributionStore.read` (uncached) was the dominant amplifier.
 */
const EMFILE_PAUSE_AFTER_ATTEMPTS = 5;
/** Delay applied once `EMFILE_PAUSE_AFTER_ATTEMPTS` is reached (ms). */
const EMFILE_COOLDOWN_DELAY_MS = 60_000;

/** Statuses that indicate the contribution has been submitted to GitHub. */
const SUBMITTED_FAMILY = new Set([
  'submitted', 'ci_pass', 'ci_fail', 'changes_requested', 'approved', 'rejected', 'published',
]);

/**
 * Exponential-backoff schedule for `IN_FLIGHT` auto-polling. Stage 6.1 M1 of
 * `docs/plans/260420_oss_mcp_backend_relay.md`: when the relay accepts a
 * submission but the PR has not been created yet, `GET /status` returns
 * `404 IN_FLIGHT`. Previously the renderer silently punted on this by
 * turning every non-OK refresh into an error toast — the user saw "We
 * couldn't get the latest status" even though the backend was happily
 * creating their PR. Now: retry seven times with increasing delays (2s,
 * 4s, 8s, 16s, 30s, 30s, 30s — ~2 min total), stay in the "refreshing"
 * spinner state throughout, and surface a soft "still processing" message
 * only if the budget exhausts. No error toast at any point during the
 * backoff window.
 */
const IN_FLIGHT_BACKOFF_SCHEDULE_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000] as const;
/**
 * Soft copy surfaced when the IN_FLIGHT backoff budget runs out. Non-error by
 * design — the submission is valid, we've just exhausted our polling budget.
 * Exported so the toast consumer can identify this sentinel and render a
 * neutral (not destructive) toast variant.
 */
export const IN_FLIGHT_BUDGET_EXHAUSTED_MESSAGE =
  "We're still sending this through. Check back in a few minutes.";
/** Error-code literal returned by `contribution:refresh-status` for IN_FLIGHT responses. */
const IN_FLIGHT_ERROR_CODE = 'IN_FLIGHT';

/**
 * Stage 4 telemetry helper (260426 foolproof contribution flow).
 *
 * Fires a structured `console.warn` once per growth transition when a
 * session has multiple linked builds (matrix #25). The warn is captured
 * with the `[Renderer]` prefix in main logs (see AGENTS.md §Debugging).
 *
 * Cadence: warns when `count > 1 AND count > lastLoggedRef.current`. After
 * firing, updates the ref so subsequent polls observing the same count
 * stay silent. The session-switch effect in the hook resets the ref to 0
 * so the next session's first growth-to-N fires its own warn.
 *
 * Telemetry-only — does NOT change UX. The parent plan defers multi-card
 * stacking until this telemetry justifies the design + implementation
 * cost.
 *
 * Module-scoped (not component-scoped) so the closure can't accidentally
 * capture stale state — the `lastLoggedRef` is read at call time via the
 * ref parameter, not captured at hook-construction time.
 *
 * @see docs/plans/260426_foolproof_contribution_flow_stage4.md
 */
function maybeWarnOnMultiBuild(
  sessionId: string,
  activeContributionId: string | null,
  count: number,
  lastLoggedRef: { current: number },
): void {
  if (count <= 1) return;
  if (count <= lastLoggedRef.current) return;
  const previousLoggedCount = lastLoggedRef.current;
  lastLoggedRef.current = count;
  console.warn(
    '[useMcpBuildCardState] multiple builds detected for session — telemetry only',
    {
      component: 'useMcpBuildCardState',
      event: 'multiple_builds_detected',
      sessionId,
      activeContributionId,
      totalContributionsForSession: count,
      previousLoggedCount,
    },
  );
}

/**
 * Stable empty-array reference for `linkedConnectorNames`. Returning the same
 * reference on each render lets downstream `useMemo`/`useCallback` deps stay
 * stable when no contributions exist, and avoids spurious recomputations of
 * the connector-setup card-suppression callback in App.tsx.
 */
const EMPTY_LINKED_CONNECTOR_NAMES: readonly string[] = Object.freeze([]);

/**
 * Content-equality check used to dedupe `linkedConnectorNames` updates so
 * the array reference stays stable across polls when nothing changed.
 * Polling cadence is 2s; without dedupe every poll would emit a new array
 * reference and force the connector-setup card memo in App.tsx to recompute.
 */
function namesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export interface UseMcpBuildCardResult {
  cardState: MCPBuildCardState | null;
  /**
   * Footer-question suppression follow-on (260427). Connector names of
   * EVERY contribution linked to the current session, regardless of
   * status. Used by `useConnectorSetupSuggestions` to suppress the
   * `suggest_connector_setup` footer card once a build exists for the
   * same connector. Empty array when no contributions exist (or while
   * the IPC envelope predates the Stage 4 / 260427 fields). Reference
   * stays stable across renders when contents are unchanged.
   *
   * @see docs/plans/260427_contribution_flow_followon_self_block_at_registration.md
   */
  linkedConnectorNames: readonly string[];
  /** Trigger a GitHub status refresh. Server-side debounce (5 min) prevents excessive API calls. */
  refreshStatus: () => void;
  /** True while a refresh is in flight. */
  isRefreshing: boolean;
  /**
   * Most-recent refresh error message from an explicit `refreshStatus`
   * click. Null while a refresh is in flight, on initial mount, and on
   * success. Callers (App.tsx) can surface this as a toast so manual
   * refresh failures aren't silently dropped — previously the hook only
   * console.warn'd them. Cleared when a refresh starts and when it
   * succeeds. Stage 1 of docs/plans/260420_oss_mcp_backend_relay.md.
   */
  refreshError: string | null;
  /**
   * True when the most-recent refresh failure was a re-auth-required
   * signal from the GitHub path (`GitHubReAuthRequiredError` in the main
   * process). Downstream toast surface uses this to render a
   * "Reconnect GitHub" action. Reset when `refreshError` clears.
   */
  refreshErrorReAuthRequired: boolean;
  /**
   * Force an immediate re-fetch of the contribution record for the current
   * session (bypassing the 2s poll interval). Use after a state-mutating
   * action (e.g. `submitUnified` success) so the derived `cardState`
   * reflects the new status synchronously with the user's action instead of
   * up to 2s later. See docs-private/investigations/260416_mcp_submit_loading_then_nothing.md.
   */
  refetch: () => Promise<void>;
}

/**
 * Derives MCPBuildCardState from the contribution store for a given session.
 *
 * - Fetches contribution record via IPC on mount and on a polling interval.
 * - Maps through contributionStateMapping to produce the card state.
 * - Returns null when no contribution exists (card should not render).
 * - Guards against stale responses via two mechanisms: (a) a generation ref
 *   so in-flight fetches from a prior session drop their results, and
 *   (b) a `sessionId`-tagged stored state that makes the derived cardState
 *   yield null synchronously when the live sessionId no longer matches
 *   (closes the one-render stale-state leak).
 * - When contribution is in submitted-family state, triggers a GitHub status
 *   refresh on mount to check for PR updates.
 *
 * @param sessionId - The current session ID to look up.
 */
export function useMcpBuildCardState(sessionId: string | null | undefined): UseMcpBuildCardResult {
  const [innerState, setInnerState] = useState<{
    sessionId: string;
    cardState: MCPBuildCardState;
  } | null>(null);
  /**
   * Footer-question suppression follow-on (260427). Tracks linked
   * contribution connector names alongside the card-state but in its own
   * slot so it can be exposed even when there is no active card (e.g. a
   * session with a `testing` contribution maps `cardState` to null but
   * the suggest-connector-setup card must still be suppressed).
   * Session-tagged so a stale fetch from a prior session can't paint into
   * the new session's window.
   */
  const [linkedConnectorState, setLinkedConnectorState] = useState<{
    sessionId: string;
    names: readonly string[];
  } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshErrorReAuthRequired, setRefreshErrorReAuthRequired] = useState(false);
  const contributionIdRef = useRef<string | null>(null);
  const hasTriggeredMountRefreshRef = useRef(false);
  // Lets `refetch()` fetch for the currently-live session without needing a
  // hook prop. Kept in sync with the effect below.
  const activeSessionIdRef = useRef<string | null | undefined>(null);
  // Signals in-flight fetches from previous sessions to drop their results.
  const fetchGenerationRef = useRef(0);
  // Stage 6.1 M1: tracks the pending IN_FLIGHT backoff timer. Only one
  // backoff chain runs at a time per hook instance; re-entering the user-
  // facing `refreshStatus` callback cancels any pending timer so the new
  // click always supersedes the auto-retry schedule.
  const inFlightRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stage 4 telemetry (260426 foolproof contribution flow): tracks the
  // most-recently-logged `linkedContributionsCount` for this session so we
  // fire a `console.warn` once per growth transition (count > 1 AND
  // count > lastLogged). Reset to 0 on session change in the effect below.
  // See `maybeWarnOnMultiBuild` (module-scoped) for the cadence helper.
  const lastLoggedCountRef = useRef(0);

  // REBEL-1HF: tracks consecutive EMFILE/ENFILE polling failures so we can
  // back off exponentially and avoid amplifying the file-descriptor pressure
  // that's already saturating the main process. Reset to 0 on every
  // successful poll. Reset on session change so a new session doesn't
  // inherit a stale backoff state.
  const consecutiveEmfileFailuresRef = useRef(0);
  // Pending poll timer for the next scheduled fetch. We use setTimeout
  // rather than setInterval so the delay can adapt to EMFILE backoff.
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const cancelInFlightRetry = useCallback(() => {
    if (inFlightRetryRef.current !== null) {
      clearTimeout(inFlightRetryRef.current);
      inFlightRetryRef.current = null;
    }
  }, []);

  // Stage 6.1 M1: forward-declared via ref so `runInFlightRetry` can loop back
  // into `scheduleInFlightRetry` without a circular `useCallback` dependency.
  // Assigned on every render (just below) so the closure is always current.
  const scheduleInFlightRetryRef = useRef<(
    contributionId: string,
    attempt: number,
    generation: number,
  ) => void>(() => {});

  const runInFlightRetry = useCallback(
    (contributionId: string, attempt: number, generation: number): void => {
      window.contributionApi
        .refreshStatus({ contributionId, force: true })
        .then((result) => {
          if (generation !== fetchGenerationRef.current) return;
          // Still IN_FLIGHT — schedule the next backoff step.
          if (!result.success && result.error === IN_FLIGHT_ERROR_CODE) {
            scheduleInFlightRetryRef.current(contributionId, attempt + 1, generation);
            return;
          }
          // Terminal result — clear the spinner and surface the outcome.
          setIsRefreshing(false);
          if (result.success) {
            setRefreshError(null);
            setRefreshErrorReAuthRequired(false);
          } else {
            const copy =
              result.message
              ?? result.error
              ?? "We couldn't get the latest update. Try again in a minute.";
            setRefreshError(copy);
            setRefreshErrorReAuthRequired(result.reAuthRequired === true);
          }
        })
        .catch((err) => {
          if (generation !== fetchGenerationRef.current) return;
          // Network blip during auto-retry — stop polling to avoid flooding the
          // user with toasts. The 2s card-state poller will still pick up any
          // future state change from the store; the user can also click refresh.
          const message = err instanceof Error ? err.message : String(err);
          console.warn('[useMcpBuildCardState] IN_FLIGHT auto-retry failed', { error: message });
          setIsRefreshing(false);
        });
    },
    [],
  );

  const scheduleInFlightRetry = useCallback(
    (contributionId: string, attempt: number, generation: number): void => {
      cancelInFlightRetry();
      if (generation !== fetchGenerationRef.current) return;
      if (attempt >= IN_FLIGHT_BACKOFF_SCHEDULE_MS.length) {
        // Budget exhausted (~2 min). Deliberately NOT an error toast — the
        // submission is valid; we've just run out of patience polling for
        // the PR to appear. The user can retry manually or wait.
        setIsRefreshing(false);
        setRefreshError(IN_FLIGHT_BUDGET_EXHAUSTED_MESSAGE);
        setRefreshErrorReAuthRequired(false);
        return;
      }
      const delay = IN_FLIGHT_BACKOFF_SCHEDULE_MS[attempt];
      inFlightRetryRef.current = setTimeout(() => {
        inFlightRetryRef.current = null;
        if (generation !== fetchGenerationRef.current) return;
        runInFlightRetry(contributionId, attempt, generation);
      }, delay);
    },
    [cancelInFlightRetry, runInFlightRetry],
  );

  // Keep the ref pointed at the freshest closure so `runInFlightRetry` can
  // recurse without a circular `useCallback` dep. Safe to run on every render.
  scheduleInFlightRetryRef.current = scheduleInFlightRetry;

  const fetchAndApply = useCallback(async (sid: string, generation: number) => {
    try {
      const result = await window.contributionApi.getBySession({ sessionId: sid });
      if (generation !== fetchGenerationRef.current) return;
      // REBEL-1HF: the main-process store catches EMFILE internally and
      // serves cached/empty data, so the IPC promise resolves successfully
      // even during FD exhaustion. The `fdExhausted` envelope field is the
      // only post-success signal we have to ratchet up the backoff. When
      // it's true we increment the streak (NOT reset it); when it's false/
      // absent we reset to 0 as the normal-operation success path does.
      if (result.fdExhausted) {
        consecutiveEmfileFailuresRef.current += 1;
        console.warn(
          '[useMcpBuildCardState] contribution store reports FD exhaustion - backing off',
          { consecutiveFailures: consecutiveEmfileFailuresRef.current },
        );
      } else {
        consecutiveEmfileFailuresRef.current = 0;
      }
      const contribution: ContributionRecord | null = result.contribution ?? null;

      // Stage 4 telemetry: warn once per growth transition when multiple
      // contributions exist for this session (matrix #25). Fires AFTER the
      // generation race-guard above (so a late response from a prior session
      // can't fire a warn into the new session's window) and BEFORE
      // `setInnerState` (so the warn fires even when the active record maps
      // to `null`, e.g. testing-no-errors). The helper is module-scoped to
      // avoid stale-closure pitfalls. See parent plan §Stage 4 — Renderer
      // telemetry-only.
      const count = result.linkedContributionsCount;
      if (typeof count === 'number') {
        maybeWarnOnMultiBuild(sid, contribution?.id ?? null, count, lastLoggedCountRef);
      }

      // Track the contribution ID for refresh calls
      contributionIdRef.current = contribution?.id ?? null;

      const mapped = mapContributionToCardState(contribution) as MCPBuildCardState | null;
      // Tag the stored state with its sessionId so the derived `cardState`
      // yields null synchronously when the live `sessionId` no longer matches.
      // Prevents the one-render stale-state leak that caused a prior auto-
      // trigger to fire on the wrong conversation during session switch. The
      // guard remains load-bearing for any future per-session derived state.
      setInnerState(
        mapped
          ? {
              sessionId: sid,
              cardState: mapped,
            }
          : null,
      );

      // Footer-question suppression follow-on (260427). Update the linked
      // connector-name list with content-based dedupe so the array reference
      // stays stable across polls when nothing has changed. App.tsx wraps
      // this in a `useCallback` with the names array as a dep — keeping the
      // ref stable avoids re-running the connector-setup card memo every
      // 2s for no reason.
      const incomingNames = result.linkedContributionConnectorNames ?? [];
      setLinkedConnectorState((prev) => {
        if (prev && prev.sessionId === sid && namesEqual(prev.names, incomingNames)) {
          return prev;
        }
        return { sessionId: sid, names: incomingNames };
      });

      // On-mount refresh: trigger once when we first see a submitted-family contribution
      if (
        contribution?.id &&
        SUBMITTED_FAMILY.has(contribution.status) &&
        !hasTriggeredMountRefreshRef.current
      ) {
        hasTriggeredMountRefreshRef.current = true;
        // Stage 6.1 M1: also honour IN_FLIGHT on the mount-triggered refresh.
        // Kept fire-and-forget (no spinner, no visible error) — this path
        // exists so a freshly-mounted card doesn't sit on stale data, not as
        // a user-initiated action. If the relay says "still in flight" we
        // hand the retry chain off to the silent backoff scheduler so the
        // user never has to click refresh just to observe the PR appearing.
        const mountContributionId = contribution.id;
        void window.contributionApi
          .refreshStatus({ contributionId: mountContributionId })
          .then((result) => {
            if (generation !== fetchGenerationRef.current) return;
            if (!result.success && result.error === IN_FLIGHT_ERROR_CODE) {
              scheduleInFlightRetryRef.current(mountContributionId, 0, generation);
            }
          })
          .catch(() => {
            // Mount-path failures are intentionally silent — the user can
            // still click refresh and we don't want to flash a toast the
            // moment a card loads offline.
          });
      }
    } catch (err) {
      // Drop stale results from prior sessions/runs. Mirrors the guard at
      // the top of the try block — without it a late-arriving rejection
      // from a previous session could pollute `consecutiveEmfileFailuresRef`
      // for the new session.
      if (generation !== fetchGenerationRef.current) return;
      // IPC failure — leave state unchanged (don't flash the card away).
      // Stage 5 observability: breadcrumb the failure so silent refresh
      // failures are searchable in production logs via the [Renderer] prefix
      // capture path (see AGENTS.md §Debugging — renderer console.warn).
      // REBEL-1HF: an EMFILE/ENFILE failure increments the backoff streak
      // so the next poll waits longer; non-FD errors leave the streak alone
      // (they don't carry the same "stop polling" signal). This catch block
      // is a secondary defense — IPC transport errors that carry EMFILE
      // strings — since the main-process store catches FD errors internally
      // and surfaces them via the `fdExhausted` envelope flag handled above.
      if (isEmfileError(err)) {
        consecutiveEmfileFailuresRef.current += 1;
        console.warn(
          '[useMcpBuildCardState] EMFILE/ENFILE during contribution poll - backing off',
          {
            consecutiveFailures: consecutiveEmfileFailuresRef.current,
            error: String(err),
          },
        );
      } else {
        console.warn('[useMcpBuildCardState] refresh failed', { error: String(err) });
      }
    }
  }, []);

  // Derive session-scoped state synchronously: return null when the stored
  // state belongs to a different session. This eliminates the one-render-cycle
  // stale window that caused downstream effects to fire on the wrong session.
  const isForCurrentSession = innerState !== null && innerState.sessionId === sessionId;
  const cardState = isForCurrentSession ? innerState.cardState : null;

  // Same session-tagged guard for the linked connector-name list — a stale
  // fetch from a prior session must not bleed into the new session's
  // suppression decisions. Falls back to a stable empty-array reference.
  const linkedConnectorNames =
    linkedConnectorState !== null && linkedConnectorState.sessionId === sessionId
      ? linkedConnectorState.names
      : EMPTY_LINKED_CONNECTOR_NAMES;

  useEffect(() => {
    activeSessionIdRef.current = sessionId;

    if (!sessionId) {
      setInnerState(null);
      // 260427 footer-question suppression follow-on: clear linked-name
      // state when there's no live session so it can't bleed into the
      // next-selected one.
      setLinkedConnectorState(null);
      contributionIdRef.current = null;
      hasTriggeredMountRefreshRef.current = false;
      // Stage 1.1 M1 (260420 OSS MCP backend relay): session-scope the
      // refresh transients. Without this, a prior session's refresh error
      // or in-flight spinner bleeds into the newly-selected session until
      // the next refresh click.
      setRefreshError(null);
      setRefreshErrorReAuthRequired(false);
      setIsRefreshing(false);
      // Stage 6.1 M1: any pending IN_FLIGHT backoff timer belongs to the
      // prior session — cancel it so it can't fire into an unrelated card.
      cancelInFlightRetry();
      // REBEL-1HF: tear down the recursive poll timer so a no-session
      // window doesn't leak a pending fetch into the next session.
      cancelPollTimer();
      consecutiveEmfileFailuresRef.current = 0;
      // Stage 4 telemetry: reset the multi-build warn tracker so a prior
      // session's count doesn't suppress the next session's first growth.
      lastLoggedCountRef.current = 0;
      return;
    }

    // Generation-based cancellation: bumping the ref drops any in-flight
    // fetch that belongs to a prior session/run. Combined with the session-
    // tagged innerState above, this keeps both the poller and `refetch()`
    // safe against session switches.
    fetchGenerationRef.current += 1;
    const generation = fetchGenerationRef.current;
    contributionIdRef.current = null;
    hasTriggeredMountRefreshRef.current = false;
    // Stage 1.1 M1: also reset refresh transients when switching to a
    // different live session so stale errors and spinners don't bleed in.
    setRefreshError(null);
    setRefreshErrorReAuthRequired(false);
    setIsRefreshing(false);
    // Stage 6.1 M1: cancel any pending backoff from the previous session.
    // The generation bump above would cause the timer's callback to no-op,
    // but the timer itself still consumes a slot — cancel explicitly.
    cancelInFlightRetry();
    // REBEL-1HF: cancel any prior session's pending poll timer and reset
    // the EMFILE backoff streak so a fresh session starts at normal cadence.
    cancelPollTimer();
    consecutiveEmfileFailuresRef.current = 0;
    // Stage 4 telemetry: reset on every transition into a fresh session so
    // the first growth-to-N for the new session fires a warn even if the
    // prior session had already logged.
    lastLoggedCountRef.current = 0;

    // REBEL-1HF: switch from setInterval to recursive setTimeout so the
    // delay can adapt when EMFILE/ENFILE failures show up. Each poll waits
    // until the previous fetch resolves before scheduling the next one,
    // preventing overlapping fetches when the main process is slow.
    const scheduleNext = (): void => {
      if (generation !== fetchGenerationRef.current) return;
      const delay = computeEmfileBackoffDelay(consecutiveEmfileFailuresRef.current, {
        baseDelayMs: POLL_INTERVAL_MS,
        pauseAfterAttempts: EMFILE_PAUSE_AFTER_ATTEMPTS,
        cooldownDelayMs: EMFILE_COOLDOWN_DELAY_MS,
      });
      pollTimerRef.current = setTimeout(() => {
        pollTimerRef.current = null;
        if (generation !== fetchGenerationRef.current) return;
        void fetchAndApply(sessionId, generation).finally(() => {
          if (generation !== fetchGenerationRef.current) return;
          scheduleNext();
        });
      }, delay);
    };

    // Initial fetch fires immediately (matches the prior setInterval-based
    // behaviour where the first fetchAndApply ran on mount).
    void fetchAndApply(sessionId, generation).finally(() => {
      if (generation !== fetchGenerationRef.current) return;
      scheduleNext();
    });

    return () => {
      // Bumping the generation cancels any in-flight fetches for this session.
      fetchGenerationRef.current += 1;
      cancelPollTimer();
      // Stage 6.1 M1: ensure no backoff timer survives the hook's unmount.
      cancelInFlightRetry();
    };
  }, [sessionId, fetchAndApply, cancelInFlightRetry, cancelPollTimer]);

  const refreshStatus = useCallback(() => {
    const id = contributionIdRef.current;
    if (!id) return;
    // Stage 1.1 C3 (260420 OSS MCP backend relay): guard the late
    // completion against session switches by snapshotting the current
    // fetch generation. If the user navigates to another conversation
    // while the refresh is in flight, the completion handler bails so
    // the new session's UI isn't painted with the old session's result.
    const generationAtStart = fetchGenerationRef.current;
    // Stage 6.1 M1: a fresh click preempts any pending IN_FLIGHT backoff.
    // Previous ambient retry timer is cancelled so we don't fire duplicate
    // status calls after the user-initiated one completes.
    cancelInFlightRetry();
    setIsRefreshing(true);
    setRefreshError(null);
    setRefreshErrorReAuthRequired(false);
    void window.contributionApi
      .refreshStatus({ contributionId: id, force: true })
      .then((result) => {
        if (generationAtStart !== fetchGenerationRef.current) return;
        if (!result.success) {
          // Stage 6.1 M1: IN_FLIGHT is NOT an error state — the submission
          // was accepted and the PR is being created. Hand off to the
          // silent backoff scheduler; spinner stays true until a terminal
          // result (success, non-IN_FLIGHT failure, or budget exhausted).
          if (result.error === IN_FLIGHT_ERROR_CODE) {
            scheduleInFlightRetryRef.current(id, 0, generationAtStart);
            return;
          }
          // `message` (when present) is the contract's user-facing copy;
          // fall back to `error` (machine code) or a generic hint.
          const copy =
            result.message
            ?? result.error
            ?? "We couldn't get the latest update. Try again in a minute.";
          setRefreshError(copy);
          setRefreshErrorReAuthRequired(result.reAuthRequired === true);
        } else {
          setRefreshError(null);
          setRefreshErrorReAuthRequired(false);
        }
        setIsRefreshing(false);
      })
      .catch((err) => {
        if (generationAtStart !== fetchGenerationRef.current) return;
        // Transport-level failure (IPC broken, app backgrounded, etc.).
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[useMcpBuildCardState] refreshStatus failed', { error: message });
        // Stage 1.1 (260420 OSS MCP backend relay): the copy used to leak
        // the "community relay" subsystem name into the user surface even
        // for GitHub-attributed contributions (the refresh path may call
        // either GitHub or the relay, depending on `attributionMode`).
        // Neutralized to a generic connection hint.
        setRefreshError(
          "We couldn't check for updates. Check your connection and try again.",
        );
        setRefreshErrorReAuthRequired(false);
        setIsRefreshing(false);
      });
  }, [cancelInFlightRetry]);

  const refetch = useCallback(async () => {
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    await fetchAndApply(sid, fetchGenerationRef.current);
  }, [fetchAndApply]);

  return {
    cardState,
    linkedConnectorNames,
    refreshStatus,
    isRefreshing,
    refreshError,
    refreshErrorReAuthRequired,
    refetch,
  };
}
