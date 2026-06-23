export type IntentionalSwallowSeverity = 'debug' | 'warn';

export interface IntentionalSwallowContext {
  operation: string;
  reason: string;
  owner?: string;
  severity?: IntentionalSwallowSeverity;
}

export interface IntentionalSwallowSinks {
  log: (
    level: IntentionalSwallowSeverity,
    message: string,
    context: Record<string, unknown>,
  ) => void;
  breadcrumb: (message: string, context: Record<string, unknown>) => void;
}

let activeSinks: IntentionalSwallowSinks | null = null;

/**
 * Inject main-process observability sinks without forcing this shared module to
 * import `@core/logger`, `@sentry/*`, or `@core/errorReporter` (renderer builds
 * must be able to load this file).
 */
export function setIntentionalSwallowSinks(
  sinks: IntentionalSwallowSinks | null,
): void {
  activeSinks = sinks;
}

function safeStringify(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '<unstringifiable>';
  }
}

function summarizeError(error: unknown): Record<string, unknown> {
  try {
    if (error instanceof Error) {
      return {
        errorName: safeStringify(error.name),
        errorMessage: safeStringify(error.message),
      };
    }
  } catch {
    // fall through to fallback path
  }

  return {
    errorValue: safeStringify(error),
  };
}

function safeContextField(context: unknown, field: 'operation' | 'reason' | 'owner'): string | undefined {
  try {
    if (!context || typeof context !== 'object') return undefined;
    const raw = (context as Record<string, unknown>)[field];
    if (typeof raw !== 'string') return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

function safeContextSeverity(context: unknown): IntentionalSwallowSeverity {
  try {
    if (!context || typeof context !== 'object') return 'debug';
    const raw = (context as Record<string, unknown>).severity;
    return raw === 'warn' ? 'warn' : 'debug';
  } catch {
    return 'debug';
  }
}

function safeSpread(context: unknown): Record<string, unknown> {
  try {
    if (!context || typeof context !== 'object') return {};
    return { ...(context as Record<string, unknown>) };
  } catch {
    return {};
  }
}

function emitDefaultLog(
  level: IntentionalSwallowSeverity,
  message: string,
  context: Record<string, unknown>,
): void {
  void level;
  const defaultConsole = globalThis.console as Pick<Console, 'debug'> | undefined;
  defaultConsole?.debug(message, context);
}

// Reentry guard: a sink can itself call this helper (e.g. recordMainBreadcrumb's
// own catch handler when SentryMain.addBreadcrumb throws is wired to be the
// breadcrumb sink). Without this guard, the chain
//   ignoreBestEffortCleanup → sinks.breadcrumb → recordMainBreadcrumb →
//   catch → ignoreBestEffortCleanup → ...
// recurses until stack exhaustion. Single-threaded JS means a module-scoped
// boolean is a safe reentry indicator.
let emittingIntentionalSwallow = false;

/**
 * Mark a best-effort cleanup/fallback error as intentionally discarded.
 *
 * The helper emits low-severity observability and then swallows both the
 * original error and any sink failures. Use only when the caller has a clear,
 * documented reason that the operation is optional.
 *
 * Reentry-safe: if a sink itself calls this helper during emission, the nested
 * call short-circuits (the original error is still swallowed; observability of
 * the observability failure is intentionally dropped).
 */
export function ignoreBestEffortCleanup(
  error: unknown,
  context: IntentionalSwallowContext,
): void {
  if (emittingIntentionalSwallow) {
    return;
  }
  emittingIntentionalSwallow = true;
  try {
    const severity = safeContextSeverity(context);
    const operation = safeContextField(context, 'operation') ?? '<missing-operation>';
    const reason = safeContextField(context, 'reason') ?? '<missing-reason>';
    const message = `Intentionally swallowed best-effort failure: ${operation}`;
    const payload: Record<string, unknown> = {
      ...safeSpread(context),
      operation,
      reason,
      severity,
      ...summarizeError(error),
    };

    const sinks = activeSinks;
    if (sinks) {
      try {
        sinks.log(severity, message, payload);
      } catch {
        // log sink failed; still attempt the breadcrumb so observability
        // degrades by one channel rather than zero.
      }
      try {
        sinks.breadcrumb(message, payload);
      } catch {
        // breadcrumb sink failed; nothing further to do.
      }
      return;
    }

    emitDefaultLog(severity, message, payload);
  } catch {
    // Intentional swallow telemetry is best-effort by definition. A broken sink
    // or hostile error/context value must not resurrect the original
    // cleanup/fallback failure. See JSDoc above for the never-throws contract.
  } finally {
    emittingIntentionalSwallow = false;
  }
}
