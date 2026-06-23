// REBEL-5RT: Defensive wrapper for `logger.fatal()` / `logger.error()` inside
// process-level error handlers (`uncaughtException`, `unhandledRejection`),
// Electron crash handlers (`render-process-gone`, `child-process-gone`),
// and graceful-shutdown rejection paths. The wrapped pino path can throw
// "the worker has exited" once pino's thread-stream worker has died — see
// FU-1 researcher report in this plan folder for the four root-cause
// hypotheses. When that happens inside an error handler, the secondary throw
// re-enters the same handler path (or is silently dropped by Electron's
// EventEmitter) and either generates tens of thousands of cascading Sentry
// events (Stage 1 / REBEL-5RT, since fixed at the outer uncaughtException
// boundary) or loses the original crash context entirely. This helper
// guarantees the handler never re-throws: on failure it falls back to
// `console.error` and records the swallow via `ignoreBestEffortCleanup` so
// observability degrades gracefully instead of cascading.

import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

export type SafeLogLevel = 'fatal' | 'error';

type LeveledLogger = {
  fatal: (mergingObject: Record<string, unknown>, message?: string) => void;
  error: (mergingObject: Record<string, unknown>, message?: string) => void;
};

export function safeLog(
  logger: LeveledLogger,
  level: SafeLogLevel,
  payload: Record<string, unknown>,
  message: string,
): void {
  try {
    logger[level](payload, message);
  } catch (loggerError) {
    try {
      console.error(
        `[main] logger.${level} failed; falling back to console:`,
        message,
        payload,
        loggerError,
      );
    } catch (consoleError) {
      ignoreBestEffortCleanup(consoleError, {
        operation: 'safeLog.consoleFallback',
        reason: 'Last-resort console.error inside an error/shutdown handler must never re-throw — see REBEL-5RT cascade postmortem. Originating log level is in the failed-fallback message above.',
      });
    }
  }
}
