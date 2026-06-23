/**
 * Turn Pipeline — Stage 3 completion + recovery shell.
 *
 * Lifts the orchestrator catch-block recovery dispatch into a typed shell.
 */

import type { MessageTimeoutError } from '@core/utils/timeoutAsyncIterator';
import type { ErrorRecoveryContext } from '@main/services/turnErrorRecovery';
import type {
  PhaseName,
  RuntimePhaseAccumulator,
  TurnCompletionBaseContext,
} from '@main/services/turnPipeline/types';

import { getErrorReporter } from '@core/errorReporter';
import { ConnectionNotConfiguredError, UnsupportedModelError } from '@shared/utils/connectionCredentials';
import { dispatchAgentErrorEvent } from '@main/services/agentEventDispatcher';
import { completeTurnCleanup } from '@main/services/agentTurnCleanup';
import { dispatchErrorRecovery } from '@main/services/turnErrorRecovery';

export interface TurnFailure {
  readonly phase: PhaseName;
  readonly error: unknown;
  /** Indicates the phase returned `failed-*` rather than throwing. */
  readonly recoverable: boolean;
}

export async function handleError(
  base: TurnCompletionBaseContext,
  accumulator: RuntimePhaseAccumulator,
  failure: TurnFailure,
): Promise<void> {
  const { turnId, win, turnLogger, settings } = base;
  const error = failure.error;

  if (settings.activeProvider === 'codex') {
    turnLogger.error({
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack?.split('\n').slice(0, 5).join('\n') : undefined,
      agentErrorKind: (error as Record<string, unknown>)?.__agentErrorKind,
      messageCount: base.trackingCounters.messageCount,
      receivedResultMessage: base.trackingCounters.receivedResultMessage,
    }, '[CODEX-DIAG] Raw turn error before recovery');
  }

  if (error instanceof Error && error.name === 'MessageTimeoutError') {
    const timeoutError = error as MessageTimeoutError;
    turnLogger.warn(
      {
        reason: timeoutError.reason,
        rearmCount: timeoutError.rearmCount,
        rawStreamLastEvent: base.watchdogDiagnostics.rawStreamLastEventType,
        rawStreamLastEventAgeMs: base.watchdogDiagnostics.rawStreamLastEventAgeMs,
        rawStreamEventCount: base.watchdogDiagnostics.rawStreamEventCount,
        messageCount: base.trackingCounters.messageCount,
      },
      `MessageTimeoutError (${timeoutError.reason ?? 'inactivity'}) with raw stream diagnostics`,
    );
  }

  if (accumulator.stage === 'pre-runtime') {
    turnLogger.warn(
      {
        failurePhase: failure.phase,
        recoverable: failure.recoverable,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      'Pre-runtime phase failure — running minimum-viable terminal cleanup',
    );
    const cause = error instanceof Error
      ? error
      : new Error(typeof error === 'string' ? error : 'Pre-runtime phase failed');
    // Skip Sentry capture for expected user-state events — the executor's
    // recoverable terminal-route-plan path throws user-fixable errors when
    // credentials or subscription-compatible model choices need attention, not
    // when code is broken.
    const isExpectedUserState =
      cause instanceof ConnectionNotConfiguredError ||
      cause instanceof UnsupportedModelError;
    if (!isExpectedUserState) {
      // Sentry coverage for pre-runtime failures — preserves the observability
      // that the pre-Stage-3 catch block got via `dispatchErrorRecovery`'s
      // fallthrough capture (turnErrorRecovery.ts ~line 1556). Without this,
      // any exception thrown during admission / modelMcp / routingProxy phases
      // would be silently lost to Sentry. Wrapped in try/catch per project
      // convention: observability must not mask the original error.
      try {
        getErrorReporter().captureException(cause, {
          tags: {
            source: 'rebel-core-runtime',
            pre_runtime: true,
            failurePhase: failure.phase,
          },
          extra: {
            turnId,
            recoverable: failure.recoverable,
          },
        });
      } catch (err) {
        // Wave 2d (W2D-6) sentinel: re-throw KnownConditionGuardError so the
        // Wave 2c deterministic-CI-failure contract (KNOWN_CONDITION_GUARD_LEVEL=throw
        // in NODE_ENV=test) survives this fail-safe wrapper. Production behaviour
        // is unchanged (env-knob unset → warn; throw-mode outside test → warn).
        // See docs/plans/260503_wave2d_layer2_contract_completion.md (Wave 2d).
        if (
          process.env.NODE_ENV === 'test' &&
          (err as { name?: string } | null)?.name === 'KnownConditionGuardError'
        ) {
          throw err;
        }
        /* observability must not mask the error */
      }
    }
    dispatchAgentErrorEvent(win, turnId, cause);
    completeTurnCleanup(turnId, 'pre-runtime-failure');
    return;
  }

  await dispatchErrorRecovery(buildErrorRecoveryContext(base, accumulator, error));
}

function buildErrorRecoveryContext(
  base: TurnCompletionBaseContext,
  accumulator: Extract<RuntimePhaseAccumulator, { stage: 'runtime-ready' }>,
  error: unknown,
): ErrorRecoveryContext {
  return {
    error,
    turnId: base.turnId,
    win: base.win,
    turnLogger: base.turnLogger,
    abortController: base.abortController,
    settings: base.settings,
    rendererSessionId: base.rendererSessionId,
    modelConfig: accumulator.modelConfig,
    extendedContextEnabled: accumulator.extendedContextEnabled,
    queryOptions: accumulator.queryOptions,
    buildQueryOptions: accumulator.buildQueryOptions,
    createPromptOrGenerator: accumulator.createPromptOrGenerator,
    routerContext: accumulator.routerContext,
    thinkingModelOverride: accumulator.thinkingModelOverride,
    plan: accumulator.plan,
    routeInput: accumulator.routeInput,
    routeRuntimeContextForDecision: accumulator.routeRuntimeContextForDecision,
    applyRoutePlan: accumulator.applyRoutePlan,
    activeProfile: accumulator.activeProfile,
    isDirectRoleProfile: accumulator.isDirectRoleProfile,
    altModelFallbackAttempted: accumulator.altModelFallbackAttempted,
    nestedFallbackQueryAttempted: accumulator.nestedFallbackQueryAttempted,
    thinkingProfile: base.thinkingProfile,
    workingProfile: base.workingProfile,
    availableProfiles: [...base.availableProfiles],
    requestedModelForTurn: base.requestedModelForTurn,
    messageCount: base.trackingCounters.messageCount,
    receivedResultMessage: base.trackingCounters.receivedResultMessage,
    lastMessageType: base.trackingCounters.lastMessageType,
    lastToolName: base.trackingCounters.lastToolName,
    mcpMode: base.trackingCounters.mcpMode,
    hasMedia: base.trackingCounters.hasMedia,
    abortedByWatchdog: base.watchdogDiagnostics.abortedByWatchdog,
    abortedByAwaitingApiStall: base.watchdogDiagnostics.abortedByAwaitingApiStall,
    watchdogFired: base.watchdogDiagnostics.watchdogFired,
    watchdogFiredAt: base.watchdogDiagnostics.watchdogFiredAt,
    maxWatchdogLevel: base.watchdogDiagnostics.maxWatchdogLevel,
    watchdogLevel: base.watchdogDiagnostics.watchdogLevel,
    effectiveAbortMs: base.watchdogDiagnostics.effectiveAbortMs,
    rawStreamEventCount: base.watchdogDiagnostics.rawStreamEventCount,
    rawStreamLastEventType: base.watchdogDiagnostics.rawStreamLastEventType,
    rawStreamLastEventAgeMs: base.watchdogDiagnostics.rawStreamLastEventAgeMs,
    effectiveResetConversation: base.effectiveResetConversation,
    turnOptions: base.turnOptions,
    prompt: base.prompt,
    retryTurn: base.retryTurn,
    getLastActivityAgeMs: base.getLastActivityAgeMs,
    getMessageTimeoutMs: base.getMessageTimeoutMs,
    ...(base.isToolInFlight && { isToolInFlight: base.isToolInFlight }),
  };
}
