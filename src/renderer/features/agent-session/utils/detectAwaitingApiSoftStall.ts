/**
 * Soft "still waiting" (State B) detection for an interactive `awaiting_api`
 * stall.
 *
 * The watchdog dispatches a one-shot `status` event carrying an optional
 * `stall: { phase: 'awaiting_api'; sinceMs }` marker when an interactive turn
 * has been silent in the `awaiting_api` phase (request sent, no first token)
 * past the soft threshold (~30s). The turn keeps running — this is purely a
 * calm "this is taking longer than usual" affordance, NOT a terminal.
 *
 * This pure helper decides, from a turn's events, whether State B should be
 * shown right now: the LAST stall-bearing status must not be followed by any
 * output (assistant/result/error/tool) event. As soon as the turn produces
 * something — or ends — the soft surface clears.
 *
 * Load-bearing invariant (Stage 1b / chief-designer brief §2): State B fires
 * ONLY when no first token has arrived. The watchdog already gates the `stall`
 * marker on `awaiting_api` + no-raw-stream-activity, and this consumer-side
 * "no later output" check is the renderer-side belt: a slowly-streaming turn
 * (which emits assistant/assistant_delta/tool events) clears the surface, so a
 * user watching text appear is never told it is "still waiting".
 *
 * @see src/core/services/watchdog/watchdogTracker.ts isAwaitingApiSoftStall
 * @see docs/plans/260617_bricked-state-0448-electron42/PLAN.md Stage 1b
 */

import type { AgentEvent } from '@shared/types';

/** Event types that represent the turn producing output / ending — any of these
 *  AFTER a stall-bearing status means the stall has cleared. A subsequent
 *  `status` WITHOUT `stall` (e.g. activity-resume) also clears it. */
function isOutputOrTerminalEvent(event: AgentEvent): boolean {
  switch (event.type) {
    case 'assistant':
    case 'assistant_delta':
    case 'thinking_delta':
    case 'tool':
    case 'result':
    case 'error':
      return true;
    default:
      return false;
  }
}

/**
 * Returns the active soft-stall marker for a turn, or `null` if State B should
 * not be shown. Pure — no side effects, safe to call in render/memo.
 *
 * Rule: scan from the end; the most recent meaningful event must be a `status`
 * event carrying a `stall` marker. If any output/terminal event, or a `status`
 * without `stall`, appears after the last stall-bearing status, the surface is
 * cleared (returns `null`).
 */
export function detectAwaitingApiSoftStall(
  turnEvents: readonly AgentEvent[],
): { phase: 'awaiting_api'; sinceMs: number } | null {
  for (let i = turnEvents.length - 1; i >= 0; i--) {
    const event = turnEvents[i];
    if (event.type === 'status') {
      // A stall-bearing status with nothing after it → State B is active.
      if (event.stall) {
        return event.stall;
      }
      // A later status WITHOUT a stall marker supersedes the stall (e.g. the
      // existing progressive watchdog status, or activity-resume copy) → cleared.
      return null;
    }
    if (isOutputOrTerminalEvent(event)) {
      // The turn produced output / ended after any stall → cleared.
      return null;
    }
    // Other event kinds (seq-only envelopes, recovery markers, etc.) are
    // neutral — keep scanning back toward the most recent status.
  }
  return null;
}
