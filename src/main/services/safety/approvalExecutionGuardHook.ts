/**
 * Approval-Execution Guard (Stop hook)
 *
 * Deterministic post-approval execution guard for LEGACY (non-staged) approval
 * flows (FOX-2771/2601 Stage 2 — "clean_post_approval" dropped-resume class).
 *
 * Mechanism being guarded: when the user approves a blocked tool call or
 * memory write, the approval is stored as a single-use entry
 * (`sessionApprovals.storeSingleUseApproval`) and the renderer sends a
 * model-mediated continuation asking the model to RE-RUN the operation
 * (`buildContinuationMessage` / `buildToolContinuationMessage`). Nothing used
 * to verify the model actually re-ran it — the continuation turn could close
 * cleanly with the approved work silently undone.
 *
 * This Stop hook runs at end-of-turn (before `autoContinueHook`, deterministic
 * before behavioral) and checks the single-use approval store — the
 * consumption seam — for execution-expected approvals that were stored before
 * this turn started and are still unconsumed:
 *
 *  1. First detection → block the stop ONCE with a stronger system message
 *     naming the approved operation identifier(s). Each approval gets exactly
 *     one forced continuation, ever (`forcedContinuationAt`).
 *  2. Still unconsumed after its forced continuation → surface an explicit
 *     "Approved but not executed" state via the host-provided callback (a
 *     status event in the turn timeline) exactly once (`surfacedAt`), then
 *     allow the stop. The stored approval is left intact so a manual retry
 *     still works (until the 24h staleness sweep in sessionApprovals).
 *
 * Suppression rules (mirrors `autoContinueHook` safety stops):
 *  - abort signal (user pressed Stop) → always allow the stop;
 *  - awaiting user input (pending AskUserQuestion) → allow the stop WITHOUT
 *    spending the forced-continuation budget — the expectation stays
 *    actionable for the post-answer continuation turn (GPT review F2).
 *
 * Ordering note (GPT review F1 + confirm-round F1): the task-board
 * forced-continuation layer in `rebelCoreQuery` runs BEFORE all Stop hooks.
 * It consults `hasActionableExecutionExpectations` (injected via
 * `TurnParams.hasPendingApprovalExecutions`) and surrenders its generic
 * continuation while this guard still has work to do — BOTH the forced
 * continuation pass AND the follow-up "approved but not executed" surfacing
 * pass (the predicate stays true until the expectation is consumed or
 * surfaced). Without the second yield, a model that ignores the forced
 * continuation while tasks remain pending would let generic task-board
 * injections consume the remaining attempts and the surfacing leg would
 * never run (the last attempt skips Stop hooks).
 *
 * Staged flows (`stagedToolCallsService`, staged memory writes) execute
 * deterministically after approval and never opt into `expectExecution`, so
 * this hook ignores them by construction.
 *
 * NOT autoContinueHook: this file deliberately leaves the behavioral
 * stop-evaluation logic untouched (Stage 3 of the plan is HELD).
 */

import type { HookJSONOutput } from '@core/agentRuntimeTypes';
import { createScopedLogger } from '@core/logger';
import {
  listUnconsumedExecutionExpectations,
  markExecutionExpectationForced,
  markExecutionExpectationSurfaced,
  type UnconsumedExecutionExpectation,
} from './sessionApprovals';

const log = createScopedLogger({ service: 'approvalExecutionGuardHook' });

export interface ApprovalExecutionGuardOptions {
  /** Renderer session the turn belongs to (approvals are stored per-session). */
  sessionId: string;
  /**
   * Approval-store sequence snapshot taken at turn start
   * (`currentApprovalSequence()`). Only approvals stored at-or-before this
   * snapshot are considered — the running turn is the continuation that was
   * supposed to consume them; approvals stored mid-turn get their own
   * continuation turn. Sequence (not wall-clock) so a same-millisecond
   * approve-then-turn-start cannot be misclassified (GPT review F3).
   */
  approvalSeqAtTurnStart: number;
  /**
   * Surface the terminal "approved but not executed" state. The host wires
   * this to a status event in the turn timeline (closest existing surface).
   */
  onApprovedNotExecuted: (items: UnconsumedExecutionExpectation[]) => void;
  /**
   * True when the turn is stopping to wait for the USER (pending
   * AskUserQuestion batch). Host wires this to
   * `agentTurnRegistry.hasUserQuestionPending(turnId)` — the same predicate
   * `autoContinueHook` uses. When true the guard allows the stop without
   * spending the forced-continuation budget (GPT review F2).
   */
  isAwaitingUserInput?: () => boolean;
  /** When aborted (user pressed Stop), never force a continuation. */
  abortSignal?: AbortSignal;
}

function describeItem(item: UnconsumedExecutionExpectation): string {
  return item.domain === 'memory'
    ? `memory write to ${item.identifier}`
    : `tool call ${item.identifier}`;
}

export function buildForcedContinuationReason(items: UnconsumedExecutionExpectation[]): string {
  const listing = items.map((item) => `- ${describeItem(item)}`).join('\n');
  return [
    '[System: auto-continue] The user explicitly approved the following operation(s), but they have NOT been executed yet:',
    listing,
    'You must perform the approved operation(s) now by making the actual tool call(s) / write(s) — the approval is already stored, so they will succeed without asking again. Do not merely acknowledge this message. If you genuinely cannot execute one, state explicitly why.',
  ].join('\n');
}

export function buildApprovedNotExecutedStatus(items: UnconsumedExecutionExpectation[]): string {
  const listing = items.map(describeItem).join(', ');
  return `Approved but not executed: ${listing}. You can approve it again or ask Rebel to retry.`;
}

/**
 * Create the Stop hook. Registered in `agentTurnExecute.ts` Stop hooks BEFORE
 * `autoContinueHook` (first block wins in `runStopHooksWithReason`).
 */
export function createApprovalExecutionGuardHook(
  options: ApprovalExecutionGuardOptions,
): () => Promise<HookJSONOutput> {
  const {
    sessionId,
    approvalSeqAtTurnStart,
    onApprovedNotExecuted,
    isAwaitingUserInput,
    abortSignal,
  } = options;

  return async (): Promise<HookJSONOutput> => {
    // User explicitly pressed stop — never override that decision.
    if (abortSignal?.aborted) return {};

    // The turn stopped to wait for the user (AskUserQuestion). Never force a
    // continuation past that, and do NOT spend the forced-continuation budget
    // — the expectation stays actionable for the post-answer continuation.
    if (isAwaitingUserInput?.()) {
      log.info({ sessionId }, 'User input pending — approval-execution guard yielding (budget unspent)');
      return {};
    }

    let pending: UnconsumedExecutionExpectation[];
    try {
      pending = listUnconsumedExecutionExpectations(sessionId, approvalSeqAtTurnStart);
    } catch (err) {
      // Fail open (allow stop) — guard must never wedge a turn.
      log.warn({ sessionId, err }, 'Approval-execution guard query failed — allowing stop');
      return {};
    }
    if (pending.length === 0) return {};

    const fresh = pending.filter((p) => p.forcedContinuationAt === undefined);
    if (fresh.length > 0) {
      // Spend the single forced continuation for these approvals NOW (before
      // returning) so a re-entrant stop evaluation can never double-force.
      for (const item of fresh) {
        markExecutionExpectationForced(item.domain, sessionId, item.identifier);
      }
      log.info(
        { sessionId, identifiers: fresh.map((f) => f.identifier), domains: fresh.map((f) => f.domain) },
        'Approved operation(s) not executed by continuation turn — forcing one follow-up continuation',
      );
      return {
        decision: 'block',
        reason: buildForcedContinuationReason(fresh),
      };
    }

    // Every pending expectation already had its forced continuation — surface
    // the explicit terminal state once, then allow the stop.
    const unsurfaced = pending.filter((p) => p.surfacedAt === undefined);
    if (unsurfaced.length > 0) {
      for (const item of unsurfaced) {
        markExecutionExpectationSurfaced(item.domain, sessionId, item.identifier);
      }
      log.warn(
        { sessionId, identifiers: unsurfaced.map((f) => f.identifier) },
        'Approved operation(s) still not executed after forced continuation — surfacing to user',
      );
      try {
        onApprovedNotExecuted(unsurfaced);
      } catch (err) {
        log.warn({ sessionId, err }, 'Failed to surface approved-but-not-executed state');
      }
    }
    return {};
  };
}
