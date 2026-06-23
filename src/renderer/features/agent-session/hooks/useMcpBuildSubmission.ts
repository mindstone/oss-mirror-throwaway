/**
 * useMcpBuildSubmission
 *
 * Owns the attribution-picker submission flow for the MCPBuildCard:
 *   - "Add to the community" (submit-prompt → github-check picker)
 *   - "Use my Rebel name" (relay + rebel-name attribution)
 *   - "Share anonymously" (relay + anonymous attribution)
 *   - "Use my GitHub account" (disabled in OSS-scrubbed builds)
 *
 * Extracted from App.tsx for testability — the logic involves multiple
 * `await` points and branches (session-switch races, re-auth loops,
 * submit failures, attribution routing) that were hard to
 * exercise against the full App render tree. Each handler returns
 * `Promise<boolean>` so the picker (SessionSurfaceContent) only dismisses
 * the question card when the action actually succeeded — recoverable
 * failures (missing name, submit failure, reAuthRequired)
 * keep the picker visible for retry.
 *
 * Session-switch safety:
 *   - `currentSessionIdRef` snapshots the session id at handler entry;
 *     every post-await mutation is gated on "still on the origin session".
 *   - `isSubmittingRef` is cleared on session change so a stuck flag
 *     can't lock out the next session's submit click.
 *
 * Attribution persistence:
 *   - The dispatcher owns attribution persistence on terminal submit
 *     success. The renderer now passes desired attribution fields through
 *     `submitUnified` and does not pre-write attribution to local state.
 *
 * @see docs/plans/260420_oss_mcp_backend_relay.md (Stage 1.1 fixes)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { EmitLogFn, ShowToastFn } from '@renderer/contexts/AppContext';
import { useAppNavigationSafe } from '@renderer/hooks/useAppNavigation';
import { formatConnectorDisplayName } from '@shared/utils/formatConnectorDisplayName';

export interface UseMcpBuildSubmissionArgs {
  currentSessionId: string | null | undefined;
  userFirstName: string | null | undefined;
  /**
   * Force-refetch the derived MCPBuildCard state. Called after submit
   * completion so the UI reflects the new status synchronously with the
   * user's action instead of waiting up to 2s for the poller.
   */
  refetchMcpBuildCardState: () => Promise<void>;
  showToast: ShowToastFn;
  emitLog: EmitLogFn;
  /**
   * Stage 5a of `docs/plans/260420_oss_mcp_backend_relay.md`: when
   * `false`, the two relay-attributed submit handlers (`handleUseRebelName`
   * and `handleAnonymous`) short-circuit with a brand-voice toast instead
   * of writing to the store or calling the unified submit IPC. The GitHub
   * path and the refresh path are unaffected.
   *
   * Callers should pass the resolved value from
   * `resolveContributionRelayEnabled` so user overrides and channel
   * defaults both flow through a single source of truth. Optional for
   * backwards compat with existing call sites — `undefined` is treated
   * as `true` (legacy behaviour) so pre-Stage-5a consumers aren't
   * accidentally gated.
   */
  enableContributionRelay?: boolean;
  /**
   * When true, contribution sharing is unavailable in the OSS build. This
   * suppresses all share-entry handlers defensively; normal UI hides the
   * controls before users can reach these callbacks.
   */
  isOssBuild?: boolean;
}

export interface UseMcpBuildSubmissionResult {
  /** Overlay: connector name while the github-check picker is shown (transient). */
  githubCheckConnectorName: string | null;
  /** Overlay: connector name while submission is in flight (transient). */
  submittingConnectorName: string | null;
  /**
   * "Add to the community" primary click. Returns `true` when the
   * submit-prompt batch should be dismissed (picker is now showing);
   * `false` when the click was a no-op (no contribution / session switched).
   */
  handleSubmitToCommunity: () => Promise<boolean>;
  /**
   * Picker option: attribute with the user's Rebel name.
   *
   * 260424 PR-template revamp follow-up (addendum #2): the inline form
   * collecting Summary / Motivation / Notes was removed. Handlers no
   * longer accept form values — the PR content comes from the agent's
   * `contribution.prTitle` / `prBody` (if set) or the formatter default.
   */
  handleUseRebelName: () => Promise<boolean>;
  /** Picker option: submit anonymously via the relay. */
  handleAnonymous: () => Promise<boolean>;
  /** Picker option: submit via direct GitHub fork when available. */
  handleGitHubYes: () => Promise<boolean>;
  /**
   * Clear the preserved `github-check` transient plus the GitHub re-auth
   * bookkeeping (`needsReAuthRef`, the reAuth failure counter, and the
   * one-shot nudge latch). Call this when the user explicitly abandons
   * the picker — e.g. dismissing the github-check question batch via
   * the footer X button — so the memo falls back to the store-derived
   * state and the `submit-prompt` retry affordance can render again.
   * Stage 1.3 X1a of `docs/plans/260420_oss_mcp_backend_relay.md`.
   *
   * Does NOT void the contribution record — dismissal is UI-only. The
   * next `handleSubmitToCommunity` click will re-enter the picker.
   */
  clearGithubCheck: () => void;
}

type AttributionMode = 'github' | 'rebel-name' | 'anonymous';

export function useMcpBuildSubmission(
  args: UseMcpBuildSubmissionArgs,
): UseMcpBuildSubmissionResult {
  const {
    currentSessionId,
    userFirstName,
    refetchMcpBuildCardState,
    showToast,
    emitLog,
    enableContributionRelay,
    isOssBuild,
  } = args;
  const navigation = useAppNavigationSafe();
  // Stage 5a: keep the flag in a ref so every handler sees the current
  // value without the callback deps churning on every re-render. Defaults
  // to `true` when undefined — pre-Stage-5a callers must continue to
  // behave as before (3-way picker fully wired).
  const relayEnabledRef = useRef<boolean>(enableContributionRelay ?? true);
  const isOssBuildRef = useRef<boolean>(isOssBuild === true);
  useEffect(() => {
    relayEnabledRef.current = enableContributionRelay ?? true;
  }, [enableContributionRelay]);
  useEffect(() => {
    isOssBuildRef.current = isOssBuild === true;
  }, [isOssBuild]);

  const [githubCheckConnectorName, setGithubCheckConnectorName] = useState<string | null>(null);
  const [submittingConnectorName, setSubmittingConnectorName] = useState<string | null>(null);

  // Kept in sync with `currentSessionId` so post-await session checks see the
  // up-to-date value without the handler needing `currentSessionId` in deps
  // (which would re-create the callbacks on every session switch).
  const currentSessionIdRef = useRef<string | null | undefined>(currentSessionId);
  const isSubmittingRef = useRef(false);
  // Forces a fresh OAuth attempt on the next GitHub click after the upstream
  // told us re-auth is required. We can't rely on `getAuthStatus` alone —
  // the local token may still report "connected + not expired" even when
  // the server rejects it (scope change, revoked grant, etc.).
  const needsReAuthRef = useRef(false);
  // Stage 1.2 FU4 (260420 OSS MCP backend relay): after repeated
  // `reAuthRequired` responses on the same session, the user is in a
  // dead-end UX — GitHub genuinely isn't working for them. We count
  // consecutive reAuth failures and surface a one-off nudge pointing at
  // the Rebel-name / Anonymous alternatives so they can still ship.
  const reAuthAttemptCountRef = useRef(0);
  const reAuthNudgeShownRef = useRef(false);

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
    // Reset transient overlays AND the double-click guard when switching
    // sessions. Without clearing `isSubmittingRef` here, a session that was
    // locked mid-submit (e.g. handler threw before finally{} ran) would
    // block the next session's submit click.
    setGithubCheckConnectorName(null);
    setSubmittingConnectorName(null);
    isSubmittingRef.current = false;
    // Stage 1.2 FU4: the reAuth nudge is session-scoped — a fresh session
    // shouldn't carry the prior session's "you've failed 3 times" toast
    // history. The raw `needsReAuthRef` is deliberately NOT cleared on
    // session switch (see comment below) because the underlying OAuth
    // state is user-scoped.
    reAuthAttemptCountRef.current = 0;
    reAuthNudgeShownRef.current = false;
    // `needsReAuthRef` is intentionally NOT cleared on session switch:
    // the OAuth state is user-scoped, not session-scoped, so a fresh
    // conversation shouldn't auto-silently retry a rejected token.
  }, [currentSessionId]);

  const originStillActive = useCallback(
    (originSessionId: string | null | undefined): boolean => {
      return (
        originSessionId !== null &&
        originSessionId !== undefined &&
        originSessionId === currentSessionIdRef.current
      );
    },
    [],
  );

  /**
   * Call submitUnified with desired attribution fields. Returns true on
   * terminal success; false on any recoverable failure (picker stays visible).
   *
   * This helper is fully session-aware: every post-await state mutation and
   * toast is gated on "still on the origin session". If the user switches
   * conversations mid-flight, the late completion is logged and swallowed
   * so it can't paint into the newly-opened session.
   */
  const runAttributedSubmit = useCallback(
    async (innerArgs: {
      contributionId: string;
      connectorName: string;
      attributionMode: AttributionMode;
      attributionName?: string;
      originSessionId: string | null | undefined;
    }): Promise<boolean> => {
      const {
        contributionId,
        connectorName,
        attributionMode,
        attributionName,
        originSessionId,
      } = innerArgs;
      const desiredAttributionName =
        attributionMode === 'rebel-name'
          ? attributionName?.trim()
          : attributionMode === 'anonymous'
            ? null
            : undefined;

      setSubmittingConnectorName(connectorName);
      try {
        const result = await window.contributionApi.submitUnified({
          contributionId,
          desiredAttributionMode: attributionMode,
          ...(desiredAttributionName !== undefined
            ? { desiredAttributionName }
            : {}),
        });

        if (!originStillActive(originSessionId)) {
          // Session switched mid-submit. The overlay and picker belong to
          // the NEW session (already reset by the effect), so we just
          // swallow the late result — and crucially, we do NOT refetch
          // the newly-selected session's state just because the prior
          // session's submit happened to finish (Stage 1.2 R2).
          return false;
        }

        // Stage 1.2 R2 (260420): refetch is only useful for the session
        // that initiated the submit. Gating behind `originStillActive`
        // prevents a late completion from forcing an IPC fetch against
        // the newly-selected session — its own poller already handles
        // freshness. Closes the 2s polling gap — see 260416 investigation.
        await refetchMcpBuildCardState();

        setSubmittingConnectorName(null);

        if (result.success) {
          // Submit succeeded — reset the reAuth flag so the next click
          // doesn't gratuitously bounce the user through OAuth.
          needsReAuthRef.current = false;
          // Stage 1.2 FU4: a successful submission resets the reAuth
          // failure counter and clears the one-shot nudge latch.
          reAuthAttemptCountRef.current = 0;
          reAuthNudgeShownRef.current = false;
          // Stage 1.2 R1: only clear the `github-check` overlay on
          // terminal success. Recoverable failures must keep the picker
          // visible for retry.
          setGithubCheckConnectorName(null);
          if (result.skippedDenylisted && result.skippedDenylisted.length > 0) {
            const skippedCount = result.skippedDenylisted.length;
            const suffix = skippedCount === 1 ? '' : 's';
            const preview = result.skippedDenylisted.slice(0, 3).join(', ');
            const listPreview = skippedCount > 3 ? `${preview}, …` : preview;
            showToast({
              title: `We left ${skippedCount} sensitive file${suffix} out before sending it: ${listPreview}`,
            });
          }
          if (result.degraded) {
            emitLog({
              level: 'warn',
              message:
                'Connector submission reached the community, but local contribution state did not persist cleanly',
              context: {
                contributionId,
                attributionMode,
                degraded: result.degraded,
                prUrl: result.prUrl,
              },
              timestamp: Date.now(),
            });
            showToast({
              title:
                "Your tool was sent, but Rebel couldn't update its local note. Reload the app to sync it back up.",
              variant: 'error',
            });
          } else {
            showToast({ title: `Your ${formatConnectorDisplayName(connectorName)} tool is on its way.` });
          }
          return true;
        }

        if (result.reAuthRequired) {
          // GitHub-path only — leave the picker card up so the user can
          // retry with a fresh OAuth flow. Set the reAuth flag so the
          // next click forces a startAuth rather than trusting the
          // local getAuthStatus cache (M2).
          needsReAuthRef.current = true;
          // Stage 1.2 R1: the transient was never cleared in this branch
          // after R1 — this re-set is harmless and preserved explicitly
          // so the invariant "reAuthRequired ⇒ picker visible" is local
          // to this call site (no need to trace the fix back to the
          // click handler).
          setGithubCheckConnectorName(connectorName);
          // Stage 1.2 FU4: count consecutive reAuth failures; after the
          // 3rd one, surface a one-shot nudge toward Rebel-name /
          // Anonymous so the user has an escape hatch from a broken
          // GitHub integration. Counter is reset on success, session
          // switch, or the user choosing a non-GitHub attribution mode.
          reAuthAttemptCountRef.current += 1;
          showToast({
            title: result.error.message ?? 'GitHub needs you to sign in again.',
            variant: 'error',
          });
          if (
            reAuthAttemptCountRef.current >= 3
            && !reAuthNudgeShownRef.current
          ) {
            reAuthNudgeShownRef.current = true;
            showToast({
              title:
                "GitHub still isn't accepting the sign-in. You can use your Rebel name or share anonymously instead.",
            });
          }
        } else if (result.error.code === 'UNAUTHORIZED') {
          showToast({
            title: 'Your Rebel sign-in expired',
            description: 'Reconnect from Settings → Account.',
            variant: 'error',
            action: {
              label: 'Open Settings',
              onClick: () => {
                void navigation?.navigate('rebel://settings/account');
              },
            },
          });
        } else {
          // 260424 bug fix: the relay returns `GITHUB_API` (HTTP 502) when
          // its bot fails to reach GitHub to create the PR — e.g. the
          // GitHub App installation is misconfigured, the bot fork is
          // missing, or GitHub is rate-limiting. The backend message
          // ("GitHub upstream error.") is bare and leaves the user
          // thinking *they* did something wrong. Replace it with a
          // brand-voice, retryable message that calls out the backend
          // origin without scaring the user. The raw backend message is
          // already captured in the structured log inside
          // `submitViaRelay` (contribution-relay scope), so we keep the
          // diagnostic trail intact while upgrading the UX.
          // `RATE_LIMIT` gets the same treatment — also a "try again
          // later" situation where the raw backend message ("Rate
          // limited") is not actionable to a non-technical user.
          const isTransientRelayFailure =
            result.error.code === 'GITHUB_API'
            || result.error.code === 'RATE_LIMIT'
            || result.error.code === 'TIMEOUT';
          const title = isTransientRelayFailure
            ? "GitHub didn't take the hand-off on our side. Try again in a minute, or use your GitHub account to send it directly."
            : (result.error.message ?? "We couldn't send this yet.");
          const transientDescription = result.error.code === 'TIMEOUT'
            ? result.error.message
            : undefined;
          showToast({
            title,
            variant: 'error',
            ...(transientDescription ? { description: transientDescription } : {}),
          });
        }
        return false;
      } catch (error) {
        if (!originStillActive(originSessionId)) {
          // Stage 1.2 R2: same guard as the success path — don't refetch
          // a newly-selected session's state just because the previous
          // session's submit threw.
          return false;
        }
        // Refresh the derived card state so the failure is reflected
        // synchronously with the thrown error. Only meaningful when the
        // origin session is still active (guarded above).
        await refetchMcpBuildCardState();
        setSubmittingConnectorName(null);
        const message = error instanceof Error ? error.message : "We couldn't send this yet.";
        showToast({ title: message, variant: 'error' });
        return false;
      }
    },
    [emitLog, navigation, showToast, refetchMcpBuildCardState, originStillActive],
  );

  const handleSubmitToCommunity = useCallback(async (): Promise<boolean> => {
    const originSessionId = currentSessionIdRef.current;
    if (!originSessionId || isSubmittingRef.current) return false;
    if (isOssBuildRef.current) {
      showToast({ title: "Sharing isn't available in this build." });
      return false;
    }
    try {
      const { contribution } = await window.contributionApi.getBySession({
        sessionId: originSessionId,
      });
      if (!originStillActive(originSessionId)) return false;
      if (!contribution) {
        showToast({ title: "I can't find the tool we were making in this conversation." });
        return false;
      }
      setGithubCheckConnectorName(contribution.connectorName);
      return true;
    } catch (error) {
      if (!originStillActive(originSessionId)) return false;
      const message = error instanceof Error ? error.message : "I couldn't load the sharing details.";
      showToast({ title: message });
      return false;
    }
  }, [originStillActive, showToast]);

  const handleUseRebelName = useCallback(async (): Promise<boolean> => {
    const originSessionId = currentSessionIdRef.current;
    if (!originSessionId || isSubmittingRef.current) return false;
    if (isOssBuildRef.current) {
      showToast({ title: "Sharing isn't available in this build." });
      return false;
    }
    // Stage 5a (260420 OSS MCP backend relay): the relay path is gated
    // behind `enableContributionRelay`. When off on the user's channel
    // (stable by default), belt-and-suspenders guard: short-circuit
    // BEFORE touching the contribution record so a stale UI code path
    // (e.g. in-memory picker held open across a flag flip) can't submit.
    if (!relayEnabledRef.current) {
      showToast({
        title: "Sharing without GitHub is still rolling out. Use GitHub for now.",
      });
      return false;
    }
    isSubmittingRef.current = true;
    try {
      const { contribution } = await window.contributionApi.getBySession({
        sessionId: originSessionId,
      });
      if (!originStillActive(originSessionId)) {
        // 260424 PR-template revamp follow-up (addendum #2): footer
        // clicks now submit directly with no intermediate form, so a
        // session switch before the IPC completes results in a silent
        // no-op with no inline-card feedback. Log it structurally so
        // the no-op is observable without spamming the user with a
        // toast (AGENTS.md "Silent failure is a bug" — this is an
        // expected recovery path, but must still be observable).
        emitLog({
          level: 'info',
          message: 'MCP submit (rebel-name): dropping click — session switched before getBySession resolved',
          context: { originSessionId },
          timestamp: Date.now(),
        });
        return false;
      }
      if (!contribution) {
        // Stage 1.2 R1: do NOT clear `githubCheckConnectorName` on
        // recoverable failures. The picker must stay visible so the user
        // can pick a different attribution mode or retry.
        showToast({ title: "I can't find the tool we were making in this conversation." });
        return false;
      }
      if (!userFirstName || !userFirstName.trim()) {
        // Stage 1.2 R1: missing Rebel name is recoverable — user can
        // switch to Anonymous or fill Settings > Profile. Keep picker.
        showToast({
          title:
            "We need your Rebel name first. Add it in Settings > Profile, or choose another option.",
          variant: 'error',
        });
        return false;
      }
      // Stage 1.2 FU4: picking a non-GitHub attribution path is an
      // escape hatch from persistent reAuth failures — reset the
      // counter so a future GitHub retry starts fresh and the nudge
      // can fire again if the user bounces back.
      reAuthAttemptCountRef.current = 0;
      reAuthNudgeShownRef.current = false;
      // Stage 1.2 R1: transient is cleared inside `runAttributedSubmit`
      // only on terminal success. On any recoverable failure the picker
      // stays mounted for retry.
      return await runAttributedSubmit({
        contributionId: contribution.id,
        connectorName: contribution.connectorName,
        attributionMode: 'rebel-name',
        attributionName: userFirstName,
        originSessionId,
      });
    } finally {
      isSubmittingRef.current = false;
    }
  }, [emitLog, originStillActive, runAttributedSubmit, showToast, userFirstName]);

  const handleAnonymous = useCallback(async (): Promise<boolean> => {
    const originSessionId = currentSessionIdRef.current;
    if (!originSessionId || isSubmittingRef.current) return false;
    if (isOssBuildRef.current) {
      showToast({ title: "Sharing isn't available in this build." });
      return false;
    }
    // Stage 5a (260420 OSS MCP backend relay): mirror of the
    // `handleUseRebelName` guard — anonymous attribution flows through
    // the same relay path and must be gated behind the flag.
    if (!relayEnabledRef.current) {
      showToast({
        title: "Sharing without GitHub is still rolling out. Use GitHub for now.",
      });
      return false;
    }
    isSubmittingRef.current = true;
    try {
      const { contribution } = await window.contributionApi.getBySession({
        sessionId: originSessionId,
      });
      if (!originStillActive(originSessionId)) {
        // 260424 addendum #2: see handleUseRebelName for rationale.
        emitLog({
          level: 'info',
          message: 'MCP submit (anonymous): dropping click — session switched before getBySession resolved',
          context: { originSessionId },
          timestamp: Date.now(),
        });
        return false;
      }
      if (!contribution) {
        // Stage 1.2 R1: see handleUseRebelName — keep picker for retry.
        showToast({ title: "I can't find the tool we were making in this conversation." });
        return false;
      }
      // Stage 1.2 FU4: same reset as the Rebel-name path — switching
      // away from GitHub breaks any reAuth streak.
      reAuthAttemptCountRef.current = 0;
      reAuthNudgeShownRef.current = false;
      return await runAttributedSubmit({
        contributionId: contribution.id,
        connectorName: contribution.connectorName,
        attributionMode: 'anonymous',
        originSessionId,
      });
    } finally {
      isSubmittingRef.current = false;
    }
  }, [emitLog, originStillActive, runAttributedSubmit, showToast]);

  const handleGitHubYes = useCallback(async (): Promise<boolean> => {
    const originSessionId = currentSessionIdRef.current;
    if (!originSessionId || isSubmittingRef.current) return false;
    if (isOssBuildRef.current) {
      showToast({ title: "Sharing isn't available in this build." });
      return false;
    }
    isSubmittingRef.current = true;
    try {
      const { contribution } = await window.contributionApi.getBySession({
        sessionId: originSessionId,
      });
      if (!originStillActive(originSessionId)) {
        // 260424 addendum #2: see handleUseRebelName for rationale.
        emitLog({
          level: 'info',
          message: 'MCP submit (github): dropping click — session switched before getBySession resolved',
          context: { originSessionId },
          timestamp: Date.now(),
        });
        return false;
      }
      if (!contribution) {
        // Stage 1.2 R1: keep picker visible on recoverable failure.
        showToast({ title: "I can't find the tool we were making in this conversation." });
        return false;
      }
      const contributionId = contribution.id;
      const connectorName = contribution.connectorName;

      return await runAttributedSubmit({
        contributionId,
        connectorName,
        attributionMode: 'github',
        originSessionId,
      });
    } catch (error) {
      if (!originStillActive(originSessionId)) return false;
      const message = error instanceof Error ? error.message : "GitHub sign-in didn't work";
      // Stage 1.2 R1: thrown during OAuth is recoverable — keep picker.
      showToast({ title: message, variant: 'error' });
      return false;
    } finally {
      isSubmittingRef.current = false;
    }
  }, [emitLog, originStillActive, runAttributedSubmit, showToast]);

  // Stage 1.3 X1a (260420 OSS MCP backend relay): explicit user
  // dismissal of the preserved github-check transient. Also clears the
  // GitHub re-auth bookkeeping so a future retry through the picker
  // starts from a clean slate — the user is abandoning the current
  // attribution attempt entirely. Without this, Stage 1.2 R1's
  // preservation of `githubCheckConnectorName` on recoverable failures
  // would keep the memo wedged in `github-check` phase after the user
  // X-ed the batch, hiding the submit-prompt retry affordance until
  // the session was switched.
  const clearGithubCheck = useCallback((): void => {
    setGithubCheckConnectorName(null);
    needsReAuthRef.current = false;
    reAuthAttemptCountRef.current = 0;
    reAuthNudgeShownRef.current = false;
  }, []);

  return {
    githubCheckConnectorName,
    submittingConnectorName,
    handleSubmitToCommunity,
    handleUseRebelName,
    handleAnonymous,
    handleGitHubYes,
    clearGithubCheck,
  };
}
