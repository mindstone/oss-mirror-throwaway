import type { AgentEvent } from '@shared/types';

/**
 * Stage 1a (260617_bricked-state-0448-electron42): the single source of truth for
 * the interactive `awaiting_api` hard-stall terminal — a recognised retryable
 * `message_timeout` error event followed by a synthetic `result('error')`.
 *
 * Lives in its own module (not in `agentTurnExecute.ts`) so BOTH terminal exit
 * paths can share it WITHOUT a circular import:
 *   - the post-loop terminal block in `agentTurnExecute.ts`, and
 *   - the AbortError catch path (`handleAbortErrors` in `turnErrorRecovery.ts`,
 *     reached via `agentTurnExecute → turnCompletion → turnErrorRecovery`).
 *
 * `errorKindOverride: 'message_timeout'` is REQUIRED — the dispatcher only
 * derives `message_timeout` from a `MessageTimeoutError` name or this explicit
 * override (agentEventDispatcher.ts deriveErrorKind / agentErrorCatalog.ts
 * getErrorKind). `isTransient` alone will NOT produce the Try-again copy/action
 * (`classifyErrorUx('message_timeout')` → `transient` → `retryAction('Try again')`).
 */
export interface AwaitingApiTimeoutDispatchOptions {
  errorKindOverride: 'message_timeout';
  isTransient: true;
  markActionable: true;
  humanizedOverride: string;
}

export function buildAwaitingApiTimeoutDispatchOptions(
  humanizedOverride: string,
): AwaitingApiTimeoutDispatchOptions {
  return {
    errorKindOverride: 'message_timeout',
    isTransient: true,
    markActionable: true,
    humanizedOverride,
  };
}

export type ErrorEventWatchdogDiagnostic = Extract<AgentEvent, { type: 'error' }>['watchdogDiagnostic'];

/**
 * Emit the interactive `awaiting_api` hard-stall terminal: a recognised
 * retryable `message_timeout` error event FOLLOWED BY a synthetic
 * `result('error')` (which clears the renderer's `isBusy`). Dispatch functions
 * are injected so the contract AND its ordering are unit-testable without
 * harnessing `executeAgentTurn`.
 *
 * The order matters: the error event carries the actionable retry surface, and
 * the synthetic result is the terminal that flips the renderer out of its busy
 * state — mirroring every other terminal in the post-loop block.
 */
export function dispatchAwaitingApiTimeoutTerminal(args: {
  humanizedOverride: string;
  watchdogDiagnostic?: ErrorEventWatchdogDiagnostic;
  dispatchError: (
    error: Error,
    options: AwaitingApiTimeoutDispatchOptions & {
      watchdogDiagnostic?: ErrorEventWatchdogDiagnostic;
    },
  ) => void;
  dispatchSyntheticErrorResult: () => void;
}): void {
  const { humanizedOverride, watchdogDiagnostic, dispatchError, dispatchSyntheticErrorResult } = args;
  dispatchError(new Error(humanizedOverride), {
    ...buildAwaitingApiTimeoutDispatchOptions(humanizedOverride),
    ...(watchdogDiagnostic !== undefined ? { watchdogDiagnostic } : {}),
  });
  dispatchSyntheticErrorResult();
}
