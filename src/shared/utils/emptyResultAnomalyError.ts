/**
 * Error thrown by the agent message handler when the runtime returns an empty
 * result despite claiming to have produced output tokens.
 *
 * Carries typed diagnostic fields that downstream error recovery (Sentry
 * capture, graceful degradation) can read without parsing error strings.
 *
 * See: docs/plans/260417_empty_result_anomaly_resilience.md
 */

export class EmptyResultAnomalyError extends Error {
  readonly lastTurnOutputTokens: number | undefined;
  readonly loopTotalOutputTokens: number;
  readonly model: string;
  readonly stopReason: string | null | undefined;

  constructor(params: {
    lastTurnOutputTokens: number | undefined;
    loopTotalOutputTokens: number;
    model: string;
    stopReason: string | null | undefined;
  }) {
    // Message format is preserved for existing classification in
    // `friendlyErrors.ts` and `turnErrorRecovery.ts` (which match the
    // `empty_result_anomaly` substring).
    const anomalyTokens = params.lastTurnOutputTokens ?? params.loopTotalOutputTokens;
    super(
      `empty_result_anomaly: Runtime returned empty result with ${anomalyTokens} output tokens (model: ${params.model})`
    );
    this.name = 'EmptyResultAnomalyError';
    this.lastTurnOutputTokens = params.lastTurnOutputTokens;
    this.loopTotalOutputTokens = params.loopTotalOutputTokens;
    this.model = params.model;
    this.stopReason = params.stopReason;

    // Remove the constructor itself from the stack trace for cleaner logs.
    // Optional chaining guards against runtimes where this V8 API is missing.
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, EmptyResultAnomalyError);
    }
  }
}

export function isEmptyResultAnomalyError(error: unknown): error is EmptyResultAnomalyError {
  return error instanceof EmptyResultAnomalyError;
}
