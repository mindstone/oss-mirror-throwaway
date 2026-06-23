/**
 * MCP build-card question-answer router.
 *
 * Takes a user answer (the selected option ids), fans it out to the right
 * action handler on `MCPBuildCardActionHandlers`, and reports the desired
 * disposition for the question batch — either dismiss (terminal — adds the
 * batch id to `dismissedMcpBuildQuestionId`) or minimize (deferred —
 * routes through `handleMinimizeQuestion` so the user gets a
 * `MinimizedQuestionPill` they can restore). Currently only `keep-private`
 * sets `shouldMinimize: true`; all other branches return only
 * `shouldDismiss`.
 *
 * Pure helper — lives in its own module so the consuming test file doesn't
 * have to pull in the full `SessionSurfaceContent` dependency graph. Stage
 * 1.1 C1 of `docs/plans/260420_oss_mcp_backend_relay.md`.
 *
 * Disposition contract:
 *   - Attribution-mode IDs (`rebel-name` / `github-yes` / `anonymous`)
 *     submit directly from the footer. No intermediate form — the PR
 *     title/body come from the agent's `contribution.prTitle`/`prBody`
 *     or the formatter default (see
 *     `composePrMetadataFromContribution`). If the handler returns
 *     `false` (recoverable failure — missing Rebel name, OAuth cancel,
 *     reAuthRequired, etc.), the batch stays visible so the user can
 *     retry or pick a different option. Addendum #2 of
 *     `docs/plans/260424_contribution_pr_template_revamp.md`.
 *   - `github-skip` (Stage 5a; emitted only when `enableContributionRelay`
 *     is off) is pure dismissal — no handler, no submit.
 *   - `onSubmitToCommunity` may return `boolean | void`. When the handler
 *     explicitly returns `false` we keep the card visible (e.g. no
 *     contribution record found — toast was already shown); otherwise we
 *     dismiss so the follow-up github-check picker isn't obscured.
 *   - "Instantaneous" actions (run-check / re-run-check / contact-team)
 *     don't dismiss — the state machine will produce a new batch id on
 *     the next state change.
 *   - Terminal actions (view-on-github / make-changes / unknown) dismiss
 *     immediately.
 */

import type {
  MCPBuildCardActionHandlers,
  MCPBuildCardState,
} from './MCPBuildCard';

export async function routeMcpBuildAnswer(args: {
  selectedOptionIds: ReadonlySet<string>;
  actions: MCPBuildCardActionHandlers | undefined;
  mcpBuildCardState: MCPBuildCardState | null | undefined;
}): Promise<{ shouldDismiss: boolean; shouldMinimize?: boolean }> {
  const { selectedOptionIds, actions, mcpBuildCardState } = args;

  if (selectedOptionIds.has('run-check')) {
    actions?.onRunTest?.();
    return { shouldDismiss: false };
  }
  if (selectedOptionIds.has('re-run-check')) {
    actions?.onReRunTest?.();
    return { shouldDismiss: false };
  }
  if (selectedOptionIds.has('contact-team')) {
    actions?.onContactTeam?.();
    return { shouldDismiss: false };
  }

  if (selectedOptionIds.has('add-to-community')) {
    const result = await actions?.onSubmitToCommunity?.();
    return { shouldDismiss: result !== false };
  }

  // "Keep it private" — voice-doc-canonical secondary action surfaced on
  // the submit-prompt batch. Routes through the existing minimize
  // machinery so the user gets a `MinimizedQuestionPill` they can
  // restore (same code path as clicking the manual minimize button on
  // the question card). Contribution status is unchanged — the
  // contribution stays at `ready_to_submit`. Recovery paths:
  //   1. Pill click restores the question card (preserves the answer).
  //   2. Pill X button (or busy-transition cleanup) records dismissal of
  //      the current batch id; the SAME submit-prompt re-emerges only
  //      after the contribution leaves `ready_to_submit` (which makes
  //      `mcpBuildQuestionBatch` go null and clears
  //      `dismissedMcpBuildQuestionId` via the `useEffect` at
  //      `SessionSurfaceContent.tsx:723-727`). Until that happens,
  //      simply re-asking the agent does NOT make the same batch
  //      reappear.
  //   3. Settings → Tools → "Share with everyone" button (Stage 2)
  //      navigates back to the source conversation deterministically.
  // See docs/project/MCP_CONNECTOR_CONTRIBUTION_FLOW.md and
  // docs/project/CONNECTOR_CONTRIBUTION_VOICE.md § Inflection points.
  if (selectedOptionIds.has('keep-private')) {
    return { shouldDismiss: false, shouldMinimize: true };
  }

  // 260424 PR-template revamp follow-up (addendum #2): footer attribution
  // clicks submit directly — no intermediate form. Only dismiss when the
  // handler returns `true` (terminal success). On recoverable failure
  // (`false`) the batch stays visible so the user can retry or pick a
  // different attribution mode.
  if (selectedOptionIds.has('rebel-name')) {
    const ok = (await actions?.onUseRebelName?.()) ?? false;
    return { shouldDismiss: ok };
  }
  if (selectedOptionIds.has('github-yes')) {
    const ok = (await actions?.onGitHubYes?.()) ?? false;
    return { shouldDismiss: ok };
  }
  if (selectedOptionIds.has('anonymous')) {
    const ok = (await actions?.onAnonymous?.()) ?? false;
    return { shouldDismiss: ok };
  }
  // Stage 5a (260420 OSS MCP backend relay): `github-skip` is emitted
  // by the 2-option picker when `enableContributionRelay` is off on the
  // user's channel. It's a pure dismissal — no handler, no submit, just
  // close the card. Made explicit so the intent is obvious at the
  // routing layer (it would otherwise fall through to the default
  // dismiss branch below — same result, less obvious).
  if (selectedOptionIds.has('github-skip')) {
    return { shouldDismiss: true };
  }

  if (selectedOptionIds.has('view-on-github')) {
    const prUrl =
      mcpBuildCardState?.phase === 'submitted' ? mcpBuildCardState.prUrl : undefined;
    if (prUrl) actions?.onViewOnGitHub?.(prUrl);
    return { shouldDismiss: true };
  }
  if (selectedOptionIds.has('make-changes')) {
    actions?.onMakeChanges?.();
    return { shouldDismiss: true };
  }

  return { shouldDismiss: true };
}
