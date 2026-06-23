// cloud-client/src/utils/logger.ts

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type PersistCallback = (level: LogLevel, tag: string, msg: string, data?: Record<string, unknown>) => void;

/**
 * Minimal subset of the desktop `ErrorReporter` interface used by the logger
 * bridge. Kept local (not imported from `@core/errorReporter`) so cloud-client
 * stays import-free from desktop-only paths.
 */
export interface LogErrorReporter {
  addBreadcrumb(breadcrumb: {
    category: string;
    message: string;
    level?: string;
    data?: Record<string, unknown>;
  }): void;
}

let _enabled = true;
let _persistCallback: PersistCallback | null = null;
let _errorReporter: LogErrorReporter | null = null;

/** Set whether logging is enabled globally. Call once at app startup. */
export function setLogEnabled(enabled: boolean): void {
  _enabled = enabled;
}

/** Set a callback for persisting logs (e.g., file writer on mobile). Call once at app startup. */
export function setLogPersistCallback(fn: PersistCallback): void {
  _persistCallback = fn;
}

/**
 * Register an `ErrorReporter`-compatible target that receives `warn`, `error`,
 * and (today, by coincidence) `error` entries as Sentry breadcrumbs. Mirrors
 * the desktop pattern in `src/core/logger.ts`.
 *
 * The call is fire-and-forget — if `addBreadcrumb` throws, we swallow the
 * error so logging never takes out the app.
 */
export function setLogErrorReporter(reporter: LogErrorReporter | null): void {
  _errorReporter = reporter;
}

/** Exported for tests. */
export function __getLogErrorReporterForTests(): LogErrorReporter | null {
  return _errorReporter;
}

function toBreadcrumbLevel(level: LogLevel): 'info' | 'warning' | 'error' | 'debug' {
  switch (level) {
    case 'warn':
      return 'warning';
    case 'error':
      return 'error';
    case 'info':
      return 'info';
    default:
      return 'debug';
  }
}

function log(level: LogLevel, tag: string, msg: string, data?: Record<string, unknown>) {
  if (!_enabled) return;
  const ts = new Date().toISOString().slice(11, 23);
  const prefix = `[${ts}] [${level.toUpperCase()}] [${tag}]`;
  const extra = data ? ` ${JSON.stringify(data)}` : '';
  console[level === 'debug' ? 'log' : level](`${prefix} ${msg}${extra}`);
  if (_persistCallback) {
    try { _persistCallback(level, tag, msg, data); } catch { /* never throw from logging */ }
  }
  // Bridge warn/error entries to the error reporter as breadcrumbs so they
  // show up alongside the event that captured them. Skip debug/info to avoid
  // flooding Sentry's 100-breadcrumb cap with routine chatter.
  if (_errorReporter && (level === 'warn' || level === 'error')) {
    try {
      _errorReporter.addBreadcrumb({
        category: `log.${tag}`,
        level: toBreadcrumbLevel(level),
        message: msg,
        data,
      });
    } catch {
      // never throw from logging
    }
  }
}

export function createLogger(tag: string) {
  return {
    debug: (msg: string, data?: Record<string, unknown>) => log('debug', tag, msg, data),
    info: (msg: string, data?: Record<string, unknown>) => log('info', tag, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => log('warn', tag, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => log('error', tag, msg, data),
  };
}
