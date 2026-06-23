/**
 * Silent stop detection and classification.
 *
 * Extracted from ContextualProgressCard to enable unit testing and
 * differentiated messaging per stop reason.
 *
 * @see docs/plans/260415_silent_stop_detection_improvement.md
 * @see docs/plans/260610_fox2771-2601-silent-stall/PLAN.md (Stage 1 — interrupted + timeout continue)
 */

import type { AgentEvent, TurnEndReason } from '@shared/types';
import { isChatApprovalQuestionBatch } from '@shared/types/userQuestion';
import { TURN_INTERRUPTION_MESSAGE, type TurnInterruptionSource } from '@shared/constants/turnInterruption';
import type { TaskProgressItem } from './turnStepContext';
import { classifySessionError } from './classifySessionError';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StopClassification =
  | 'none'                  // No stop detected (turn running, all tasks done, or plan-only)
  | 'interrupted'           // Turn was cut off when the app closed (quit or crash) — no terminal event
  | 'user_stopped'          // User explicitly pressed Stop
  | 'superseded'            // Turn was replaced by a newer turn on the same session
  | 'awaiting_user'         // Agent is waiting for user input (e.g., asked a question)
  | 'finished_with_handoff' // Agent finished cleanly but left a next step for the user
  | 'error_exit'            // Turn ended due to an error
  | 'unexpected_stop';      // Genuine silent stop — agent stopped without clear reason

export interface SilentStopInput {
  taskProgress: TaskProgressItem[] | undefined;
  isThinking: boolean;
  isBusy: boolean;
  /** Events for this turn — used to detect stop reason from result/error/question events */
  turnEvents: AgentEvent[];
  /** Whether the user pressed Stop (live turns only; always false for historical turns) */
  isStopping: boolean;
}

export interface SilentStopResult {
  /**
   * Backward-compatible flag: true when the card should render a status chip/banner
   * in addition to (or instead of) the regular result. True for `interrupted`,
   * `user_stopped`, `awaiting_user`, `unexpected_stop`, and `finished_with_handoff`.
   */
  hasSilentStop: boolean;
  incompleteTaskCount: number;
  classification: StopClassification;
  /**
   * For `error_exit` only: true when the terminal error is a recoverable
   * timeout/stall shape (watchdog kill, response-stalled, extended-silence)
   * where a Continue affordance is appropriate alongside the existing error
   * banner / Try-again. Always false for non-error classifications.
   * Conservative by design — only the empirically-evidenced categories
   * (FOX-2771/2601 corpus), not all errors.
   */
  errorContinueEligible: boolean;
  /**
   * For `interrupted` only: WHY the turn was cut off (app quit vs crash/kill),
   * threaded from the synthetic interruption status event's `source` field. The
   * renderer uses it to say "Rebel was closed" vs "Rebel restarted" instead of
   * the network-implying default. `undefined` for pre-discriminator sessions
   * (the status event predates the field) and for all non-interrupted
   * classifications.
   */
  interruptionSource?: TurnInterruptionSource;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract `turnEndReason` from the result event, if present.
 * Older sessions (pre-improvement) won't have it — callers must handle `undefined`.
 */
export function getResultTurnEndReason(events: AgentEvent[]): TurnEndReason | undefined {
  // Scan from end: rare timing windows can produce two result events (API + synthetic).
  // The synthetic (last) one carries turnEndReason; the API one may not.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'result') return e.turnEndReason;
  }
  return undefined;
}

/**
 * True when the turn's last event is the synthetic interruption status appended
 * by `markSessionTurnsAsCompleted` (app quit or crash mid-turn). The producer
 * appends it only when the turn has no terminal event, and always appends it
 * last — so a strict last-event check mirrors the producer's idempotency
 * predicate exactly.
 */
export function isTurnInterrupted(events: AgentEvent[]): boolean {
  const last = events[events.length - 1];
  return last?.type === 'status' && last.message === TURN_INTERRUPTION_MESSAGE;
}

/**
 * Extract the interruption `source` discriminator (shutdown vs
 * startup-correction) when the turn's LAST event is the synthetic interruption
 * status — mirroring {@link isTurnInterrupted}'s last-event check exactly so the
 * two cannot disagree. Returns `undefined` when the turn is not interrupted, or
 * when the status event predates the `source` field (pre-discriminator session).
 */
export function getTurnInterruptionSource(events: AgentEvent[]): TurnInterruptionSource | undefined {
  const last = events[events.length - 1];
  if (last?.type === 'status' && last.message === TURN_INTERRUPTION_MESSAGE) {
    return last.source;
  }
  return undefined;
}

/**
 * Continue-eligible timeout/stall error shapes (Stage 1b — FOX-2771/2601).
 *
 * Eligible categories (from the 70-incident corpus):
 *  - watchdog kills ("unresponsive", "watchdog", "stopped automatically" —
 *    includes the extended-silence "went silent … stopped automatically" copy)
 *  - upstream response stalls ("response stalled and timed out",
 *    "took too long to respond" / structural `message_timeout`)
 *
 * Deliberately NOT eligible: billing, auth, moderation, invalid-request,
 * context-overflow, generic api/server errors — those need user action or a
 * different remedy; a blind "Continue" would loop into the same failure.
 */
function isContinueEligibleErrorEvent(event: AgentEvent): boolean {
  if (event.type !== 'error') return false;
  if (event.errorKind === 'message_timeout') return true;
  const lower = event.error.toLowerCase();
  if (classifySessionError(lower) === 'watchdog') return true;
  return (
    lower.includes('response stalled and timed out') ||
    lower.includes('took too long to respond')
  );
}

/**
 * For an `error_exit` turn, whether the TERMINAL error (last error event in
 * the turn) is a continue-eligible timeout/stall. Mid-turn tool errors don't
 * count — only the error that ended the turn.
 */
function isErrorExitContinueEligible(events: AgentEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'error') return isContinueEligibleErrorEvent(e);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Classify why an agent turn stopped with incomplete tasks.
 *
 * Priority order (first match wins):
 * 1. Turn still running → 'none'
 * 2. Last event is the app-closed interruption status → 'interrupted'
 *    (does NOT require taskProgress — interruption is detectable from events alone)
 * 3. No incomplete tasks → 'none'
 * 4. Incomplete tasks but no completed tasks → 'none' (plan-only)
 * 5. User stopped → 'user_stopped'
 * 6. Awaiting user input → 'awaiting_user'
 * 7. Error exit → 'error_exit' (continue-eligible when timeout/stall shaped)
 * 8. Finished cleanly with incomplete handoff steps → 'finished_with_handoff'
 * 9. Remaining → 'unexpected_stop'
 */
export function detectSilentStop(input: SilentStopInput): SilentStopResult {
  const { taskProgress, isThinking, isBusy, turnEvents, isStopping } = input;

  const none: SilentStopResult = {
    hasSilentStop: false,
    incompleteTaskCount: 0,
    classification: 'none',
    errorContinueEligible: false,
  };

  // 1. Turn still running — no classification possible
  if (isThinking || isBusy) return none;

  // 2. Interrupted by app close (quit or crash) — fires WITHOUT taskProgress.
  //    The producer (markSessionTurnsAsCompleted) only appends the interruption
  //    status to turns lacking a terminal event, so there is no result/error
  //    event to conflict with the classifications below.
  if (isTurnInterrupted(turnEvents)) {
    const interruptedIncomplete = (taskProgress ?? []).filter(
      t => t.status === 'pending' || t.status === 'in_progress',
    ).length;
    return {
      hasSilentStop: true,
      incompleteTaskCount: interruptedIncomplete,
      classification: 'interrupted',
      errorContinueEligible: false,
      interruptionSource: getTurnInterruptionSource(turnEvents),
    };
  }

  // 3. No tasks or no incomplete tasks — nothing to warn about
  if (!taskProgress || taskProgress.length === 0) return none;

  const incomplete = taskProgress.filter(
    t => t.status === 'pending' || t.status === 'in_progress',
  );
  if (incomplete.length === 0) return none;

  // 4. Incomplete tasks but nothing completed — plan-only turn (tasks created but work not started)
  const hasCompletedAtLeastOne = taskProgress.some(t => t.status === 'completed');
  if (!hasCompletedAtLeastOne) return none;

  // ── From here: incomplete tasks + at least one completed task ──
  const incompleteTaskCount = incomplete.length;
  const turnEndReason = getResultTurnEndReason(turnEvents);

  // 5a. Superseded — turn was replaced by a newer request (not user-facing)
  if (turnEndReason === 'superseded') {
    return { hasSilentStop: false, incompleteTaskCount, classification: 'superseded', errorContinueEligible: false };
  }

  // 5b. User stopped (live `isStopping` flag or persisted `turnEndReason`)
  if (isStopping || turnEndReason === 'user_stopped') {
    return { hasSilentStop: true, incompleteTaskCount, classification: 'user_stopped', errorContinueEligible: false };
  }

  // 6. Awaiting user (persisted `turnEndReason` or `user_question` event in turn)
  if (
    turnEndReason === 'awaiting_user' ||
    turnEvents.some(e => e.type === 'user_question' && !isChatApprovalQuestionBatch(e))
  ) {
    return { hasSilentStop: true, incompleteTaskCount, classification: 'awaiting_user', errorContinueEligible: false };
  }

  // 7. Error exit — defer to existing error handling (no silent stop banner),
  //    BUT mark timeout/stall-shaped terminal errors continue-eligible so the
  //    card can offer Continue alongside the error banner (Stage 1b).
  //    Check both error events AND turnEndReason: 'error' (some graceful degradation
  //    paths emit synthetic results tagged 'error' without a separate error event)
  if (turnEndReason === 'error' || turnEvents.some(e => e.type === 'error')) {
    return {
      hasSilentStop: false,
      incompleteTaskCount,
      classification: 'error_exit',
      errorContinueEligible: isErrorExitContinueEligible(turnEvents),
    };
  }

  // 8. Finished cleanly with handoff steps — agent completed its turn (turnEndReason: 'completed')
  //    but left incomplete tasks queued as next steps for the user. This is intentional
  //    behaviour, not a silent stop. We still want a status chip rendered (informational
  //    handoff banner — "Next step for you"), so hasSilentStop stays true and the renderer
  //    differentiates by classification. See docs/plans/260528_rebel-h5-stopped-finished/PLAN.md (REBEL-H5).
  if (turnEndReason === 'completed') {
    return { hasSilentStop: true, incompleteTaskCount, classification: 'finished_with_handoff', errorContinueEligible: false };
  }

  // 9. Remaining: genuine unexpected stop
  return { hasSilentStop: true, incompleteTaskCount, classification: 'unexpected_stop', errorContinueEligible: false };
}

// ---------------------------------------------------------------------------
// Continue eligibility
// ---------------------------------------------------------------------------

/**
 * Whether the Continue button should be offered for a given classification.
 *
 * - For `user_stopped`, `unexpected_stop`, or `interrupted`
 *   (not `awaiting_user` — user should answer)
 * - For `error_exit` ONLY when the terminal error was timeout/stall shaped
 *   (`errorContinueEligible` from {@link detectSilentStop}) — the existing
 *   error banner / Try-again is unaffected; Continue is additive
 * - Only for the last turn in the conversation
 * - Not while a turn is currently processing
 */
export function canOfferContinue(
  classification: StopClassification,
  isLastTurn: boolean,
  isBusy: boolean,
  errorContinueEligible = false,
): boolean {
  const eligibleClassification =
    classification === 'user_stopped' ||
    classification === 'unexpected_stop' ||
    classification === 'interrupted' ||
    (classification === 'error_exit' && errorContinueEligible);
  return eligibleClassification && isLastTurn && !isBusy;
}
