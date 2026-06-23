export type InvariantLogger = {
  error: (payload: Record<string, unknown>, message: string) => void;
};

let invariantLogger: InvariantLogger | null = null;

/**
 * Inject the main-process structured logger without making this shared module
 * import `@core/logger` (renderer builds must be able to load this file).
 */
export function setInvariantLogger(logger: InvariantLogger | null): void {
  invariantLogger = logger;
}

export class InvariantViolationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InvariantViolationError';
  }
}

function causeSummary(cause: unknown): Record<string, unknown> | undefined {
  if (cause === undefined) return undefined;
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
    };
  }
  return {
    value: String(cause),
  };
}

function emitStderrBreadcrumb(error: InvariantViolationError, loggerError?: unknown): void {
  try {
    const stderr = typeof process !== 'undefined' ? process.stderr : undefined;
    if (!stderr || typeof stderr.write !== 'function') return;
    const payload = {
      event: 'invariant.violation',
      name: error.name,
      message: error.message,
      cause: causeSummary(error.cause),
      loggerError: causeSummary(loggerError),
    };
    stderr.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // Best-effort observability only. Never replace the assertion error.
  }
}

function emitInvariantViolation(error: InvariantViolationError): void {
  try {
    if (!invariantLogger) {
      emitStderrBreadcrumb(error);
      return;
    }
    invariantLogger.error(
      {
        errorName: error.name,
        message: error.message,
        cause: causeSummary(error.cause),
      },
      'Invariant violation',
    );
  } catch (loggerError) {
    emitStderrBreadcrumb(error, loggerError);
  }
}

/**
 * Runtime contract assertion for impossible or unsafe states.
 *
 * Use `assertNever()` for compile-time exhaustiveness in discriminated-union
 * switches; use `invariant()` for runtime contracts that can be violated by
 * external data, lifecycle ordering, or corrupted state.
 *
 * This helper is synchronous. Async call sites must `await` the promise chain
 * containing the invariant call (or return that enclosing promise) so thrown
 * `InvariantViolationError`s surface as rejections. If a call is intentionally
 * detached, use the Stage 6 `fireAndForget` helper rather than floating the
 * promise.
 *
 * Avoid embedding user-controlled data (paths, IDs, free-form input) in
 * `message` — the message lands in stderr breadcrumbs and structured-log
 * sinks unfiltered. Pass diagnostic context through a structured-log call
 * adjacent to the invariant invocation (where the safe-fields scrubber can
 * normalise it) instead.
 *
 * @throws {InvariantViolationError} when `condition` is falsy.
 */
export function invariant(
  condition: unknown,
  message: string,
  cause?: unknown,
): asserts condition {
  if (condition) return;
  const error = new InvariantViolationError(message, { cause });
  emitInvariantViolation(error);
  throw error;
}

/**
 * Require a value to be present. Unlike truthiness checks, `0`, `false`, and
 * `''` are valid values; only `null` and `undefined` violate the contract.
 *
 * @throws {InvariantViolationError} when `value` is `null` or `undefined`.
 */
export function requireDefined<T>(
  value: T | null | undefined,
  name: string,
  cause?: unknown,
): T {
  invariant(value !== null && value !== undefined, `${name} is required`, cause);
  return value;
}
