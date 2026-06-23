/**
 * Soft "still waiting" (State B) shared constants.
 *
 * Stage 1b (260617_bricked-state-0448-electron42). When an interactive turn
 * stalls in the `awaiting_api` phase (request sent to the provider, no first
 * token) past the soft threshold, the watchdog dispatches a one-shot
 * `status.stall` event and the renderer surfaces a calm, non-destructive
 * "Try again / Stop" affordance — WITHOUT ending the turn.
 *
 * Shared here (mirroring `turnInterruption.ts`) so the PRODUCER
 * (`agentTurnExecute.ts` watchdog, via `watchdogTracker.ts` re-export) and the
 * READER (the renderer's `MessageItem` State-B row + the copy-leak eval) cannot
 * drift — all sides import the same literal. The eval pins this exact string,
 * so the rendered headline MUST be this constant for the eval to guard the
 * displayed text.
 *
 * NO raw enums/codes (`awaiting_api`, timeout, ms, token, provider, stream) in
 * the user-visible copy — those belong in diagnostics, not the surface
 * (BRAND_VOICE.md).
 *
 * Lives in `@shared` (not `@core/services/watchdog`) so the renderer doesn't
 * pull the watchdog tracker module — with its `@core/rebelCore/runtimeActivity`
 * dependency — into the renderer bundle.
 *
 * @see src/core/services/watchdog/watchdogTracker.ts (re-export + thresholds)
 * @see src/renderer/features/agent-session/components/MessageItem.tsx (State B)
 * @see evals/awaiting-api-soft-stall.ts (copy-leak gate)
 */

/** Calm, brand-voice headline for the soft "still waiting" affordance. */
export const AWAITING_API_SOFT_STALL_MESSAGE =
  'Still on this one — it is taking longer than usual.';

/** Muted action sub-line shown beneath the headline in State B (the what-you-can-do). */
export const AWAITING_API_SOFT_STALL_HINT = 'Hang tight, or give it a nudge.';
