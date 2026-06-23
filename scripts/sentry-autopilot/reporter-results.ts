/**
 * Sentry Autopilot reporter result types.
 *
 * Stage A of the deferred-items plan introduces a typed discriminated union for
 * reporter side-effect outcomes. The contract is:
 *   - Private side-effect methods either resolve with their typed value, or throw.
 *   - `Reporter.executeOperation()` wraps each call, emits success/failure counters,
 *     and returns a `ReportOperationResult<T>` so the orchestrator can keep going
 *     after a single failure without losing observability.
 *
 * This is intentionally minimal. Subsequent stages (mirror-mode reconciliation,
 * push-mode retry policy) layer on top: mirror mode reads the result to decide
 * whether the action remains pending; push mode reads the error subclass to
 * decide retry vs. terminal failure.
 *
 * HTTP error subclasses:
 *   - TransientHttpError — 5xx, 408, 429, or fetch/network/AbortError. Treat as
 *     retryable.
 *   - PermanentHttpError — other 4xx. Treat as terminal; retrying won't help.
 *   - Any other thrown Error (e.g. JSON parse, contract violation) is returned
 *     verbatim and not classified — callers should treat it as terminal.
 */

export class TransientHttpError extends Error {
  public readonly kind = 'transient_http' as const;

  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'TransientHttpError';
  }
}

export class PermanentHttpError extends Error {
  public readonly kind = 'permanent_http' as const;

  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'PermanentHttpError';
  }
}

export type ReportOperationResult<T> =
  | { success: true; operation: string; value: T }
  | { success: false; operation: string; error: Error };

/**
 * Classify a fetch Response status into the right HTTP error subclass.
 * 5xx, 408 (Request Timeout) and 429 (Too Many Requests) are transient.
 * Other 4xx are permanent.
 */
export function classifyHttpError(
  message: string,
  statusCode: number,
): TransientHttpError | PermanentHttpError {
  if (statusCode >= 500 || statusCode === 408 || statusCode === 429) {
    return new TransientHttpError(message, statusCode);
  }
  return new PermanentHttpError(message, statusCode);
}
