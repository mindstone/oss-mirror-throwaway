/**
 * Turn Pipeline — `runPhase` wrapper helper (R1 Stage 1 / Round 3 finding #6)
 *
 * Typed wrapper that:
 *   - Pre-checks `signal.aborted` and short-circuits to `'terminal'` if so.
 *   - Emits `turnPhase.entry` / `turnPhase.exit` log events around the phase fn.
 *   - Catches throws and maps them to `failed-terminal` / `failed-recoverable`
 *     based on the phase's metadata. Pre-runtime phases (admission, preTurn,
 *     modelMcp, routingProxy) escalate to `failed-terminal` with completion
 *     reason `'pre-runtime-failure'`. Runtime phases (hookGraph, primaryQueryShell,
 *     completion) preserve the recovery context and emit `failed-recoverable`.
 *
 * The orchestrator threads `(base, accumulator)` through every phase so that
 * `turnCompletion.handleError` (Stage 3) can build either a "minimum viable
 * recovery context" (when `accumulator.stage === 'pre-runtime'`) or the full
 * `ErrorRecoveryContext` (when `accumulator.stage === 'runtime-ready'`).
 *
 * Stage 1 ships the wrapper + log emission; Stage 3 wires it into the
 * orchestrator's catch block.
 *
 * NOT a phase impl — this file is intentionally one of the three
 * always-importable shared modules in `turnPipeline/`. The phase-to-phase
 * ESLint rule explicitly allows imports of `./runPhase` from any phase.
 */

import type { TurnSessionLogger } from '@core/logger';
import type {
  PhaseName,
  TurnCleanupReason,
  TurnCompletionBaseContext,
  TurnPhaseError,
  TurnPhaseLogEvent,
  TurnPhaseResult,
  RuntimePhaseAccumulator,
} from './types';

/**
 * Phases that run before `RuntimeContextData` is fully assembled. A throw
 * from these phases means we cannot build a full `ErrorRecoveryContext` —
 * fall back to a "minimum viable" terminal cleanup with reason
 * `'pre-runtime-failure'`.
 */
const PRE_RUNTIME_PHASES: ReadonlySet<PhaseName> = new Set<PhaseName>([
  'admission',
  'preTurnContext',
  'modelMcp',
  'routingProxy',
]);

/**
 * Inputs the wrapper threads through every phase. Phase impls receive `input`
 * (their typed payload-input) plus an explicit `signal` and `logger`. The
 * `base` and `accumulator` are passed through to `turnCompletion` on failure
 * — they are intentionally NOT visible to the phase fn body (so a phase
 * cannot reach into orchestrator scope and bypass the typed-payload contract).
 */
export interface RunPhaseDeps {
  readonly logger: TurnSessionLogger;
  readonly signal: AbortSignal;
  readonly base: TurnCompletionBaseContext;
  readonly accumulator: RuntimePhaseAccumulator;
  /**
   * Per-turn attempt counter (1, 2, 3 ... incremented across recursive
   * `retryTurn` self-calls). Stage 1 ships the parameter; the orchestrator
   * supplies the value when phases land in Stages 2+.
   */
  readonly attempt: number;
  /**
   * Optional sink for typed log events. Used by the replay harness to
   * intercept phase-boundary events without parsing log strings.
   *
   * When present, the wrapper emits to BOTH the structured logger AND this
   * sink. When absent, only the logger is used.
   */
  readonly emitPhaseLog?: (event: TurnPhaseLogEvent) => void;
}

/**
 * Wraps a phase function with abort pre-check, structured logging, and typed
 * throw-mapping.
 *
 * @param phaseName  The phase identity (used for log events + throw mapping).
 * @param phaseFn    The phase implementation.
 * @param input      The phase's typed input payload.
 * @param deps       Logger / signal / base context / accumulator / attempt.
 * @returns The phase's `TurnPhaseResult<TOut>` or a synthetic terminal /
 *          failed-terminal / failed-recoverable result on signal-abort or throw.
 */
export async function runPhase<TIn, TOut>(
  phaseName: PhaseName,
  phaseFn: (input: TIn, signal: AbortSignal, logger: TurnSessionLogger) => Promise<TurnPhaseResult<TOut>>,
  input: TIn,
  deps: RunPhaseDeps,
): Promise<TurnPhaseResult<TOut>> {
  const { logger, signal, base, emitPhaseLog, attempt } = deps;
  const turnId = base.turnId;
  const sessionId = base.rendererSessionId;

  // 1. Pre-check: short-circuit if the controller is already aborted.
  if (signal.aborted) {
    const result: TurnPhaseResult<TOut> = {
      status: 'terminal',
      reason: 'aborted',
    };
    emitPhaseExit(phaseName, turnId, result, 0, logger, emitPhaseLog);
    return result;
  }

  // 2. Emit entry event.
  const entryEvent: TurnPhaseLogEvent = {
    type: 'entry',
    phaseName,
    turnId,
    sessionId,
    attempt,
  };
  emitPhaseEntry(entryEvent, logger, emitPhaseLog);

  const startedAt = Date.now();

  // 3. Run the phase fn under try/catch, post-await abort recheck.
  let result: TurnPhaseResult<TOut>;
  try {
    result = await phaseFn(input, signal, logger);
    if (signal.aborted && result.status === 'ok') {
      // Late abort: phase produced a value but the user cancelled mid-flight.
      // Convert to terminal so the orchestrator runs cleanup.
      result = { status: 'terminal', reason: 'aborted' };
    }
  } catch (cause) {
    result = mapThrowToResult<TOut>(phaseName, cause);
  }

  // 4. Emit exit event.
  emitPhaseExit(phaseName, turnId, result, Date.now() - startedAt, logger, emitPhaseLog);
  return result;
}

/**
 * Maps a thrown value to the appropriate `failed-*` arm based on the phase's
 * pre-runtime / runtime classification.
 *
 * Pre-runtime phases (admission, preTurn, modelMcp, routingProxy) escalate
 * to `failed-terminal` with reason `'pre-runtime-failure'` because the
 * runtime context isn't fully assembled — the recovery handlers cannot
 * rebuild a route plan or swap models without it.
 *
 * Runtime phases (hookGraph, primaryQueryShell, completion) emit
 * `failed-recoverable` with a default `recursive-retry` directive; the
 * orchestrator's catch block dispatches through `turnErrorRecovery` which
 * picks the actual handler by error classification (transient / billing /
 * rate-limit / etc.).
 */
function mapThrowToResult<TOut>(phaseName: PhaseName, cause: unknown): TurnPhaseResult<TOut> {
  const error: TurnPhaseError = {
    phase: phaseName,
    cause,
    message: extractMessage(cause),
  };

  if (PRE_RUNTIME_PHASES.has(phaseName)) {
    return {
      status: 'failed-terminal',
      error,
      completion: { reason: 'pre-runtime-failure' satisfies TurnCleanupReason },
    };
  }

  return {
    status: 'failed-recoverable',
    error,
    recovery: { kind: 'recursive-retry' },
  };
}

function extractMessage(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return undefined;
}

function emitPhaseEntry(
  event: Extract<TurnPhaseLogEvent, { type: 'entry' }>,
  logger: TurnSessionLogger,
  emitPhaseLog: ((e: TurnPhaseLogEvent) => void) | undefined,
): void {
  logger.debug(
    {
      event: 'turnPhase.entry',
      phaseName: event.phaseName,
      turnId: event.turnId,
      sessionId: event.sessionId,
      attempt: event.attempt,
    },
    'turnPhase.entry',
  );
  emitPhaseLog?.(event);
}

function emitPhaseExit(
  phaseName: PhaseName,
  turnId: string,
  result: TurnPhaseResult<unknown>,
  durationMs: number,
  logger: TurnSessionLogger,
  emitPhaseLog: ((e: TurnPhaseLogEvent) => void) | undefined,
): void {
  const exitEvent: Extract<TurnPhaseLogEvent, { type: 'exit' }> = {
    type: 'exit',
    phaseName,
    turnId,
    status: result.status,
    durationMs,
    terminalKind:
      result.status === 'terminal'
        ? result.reason
        : result.status === 'failed-terminal'
          ? result.completion.reason
          : undefined,
    recoveryKind: result.status === 'failed-recoverable' ? result.recovery.kind : undefined,
  };
  logger.debug(
    {
      event: 'turnPhase.exit',
      phaseName,
      turnId,
      status: result.status,
      durationMs,
      terminalKind: exitEvent.terminalKind,
      recoveryKind: exitEvent.recoveryKind,
    },
    'turnPhase.exit',
  );
  emitPhaseLog?.(exitEvent);
}
