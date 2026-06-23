import path from 'node:path';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { addToLogBuffer } from './logBuffer';
import { getErrorReporter } from './errorReporter';
import { getDataPath, getAppVersion } from './utils/dataPaths';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { assertNever } from '@shared/utils/assertNever';

// Re-export LogBufferEntry for backwards compatibility with any code that imports it from here
export type { LogBufferEntry } from './logBuffer';
export type { Logger } from 'pino';
export { getRecentLogs, clearLogBuffer } from './logBuffer';


/**
 * Turn context for automatic log correlation.
 * When code runs within runWithTurnContext(), all scoped loggers
 * automatically include turnId and sessionId in their output.
 */
export interface TurnContext {
  turnId: string;
  sessionId?: string;
}

const turnContextStorage = new AsyncLocalStorage<TurnContext>();

/**
 * Execute an async function with turn context.
 * All createScopedLogger() calls within this context will automatically
 * include turnId and sessionId in their log output.
 */
export const runWithTurnContext = <T>(
  context: TurnContext,
  fn: () => Promise<T>
): Promise<T> => {
  return turnContextStorage.run(context, fn);
};

/**
 * Get the current turn context, if any.
 * Returns undefined when called outside of runWithTurnContext().
 */
export const getTurnContext = (): TurnContext | undefined => {
  return turnContextStorage.getStore();
};

const { isoTime } = pino.stdTimeFunctions;

const LOG_FILE_BASENAME = 'mindstone-rebel.log';
const SESSION_LOG_SUBDIR = 'sessions';
const DEFAULT_MAX_FILE_SIZE = '5m';
const FALLBACK_STALE_SIZE_THRESHOLD_BYTES = 50 * 1024 * 1024;
const FALLBACK_MARKER = 'Rotating log transport unavailable';
const FALLBACK_MARKER_SCAN_BYTES = 64 * 1024;
const FALLBACK_MARKER_TAIL_BYTES = FALLBACK_MARKER_SCAN_BYTES;

// ---------------------------------------------------------------------------
// Session log cleanup defaults & types
// ---------------------------------------------------------------------------

export const SESSION_LOG_DEFAULTS = {
  retentionDays: 14,
  maxFiles: 200,
  maxBytes: 250 * 1024 * 1024, // 250 MB
} as const;

export interface SessionLogCleanupOptions {
  retentionDays?: number;
  maxFiles?: number;
  maxBytes?: number;
}

export interface SessionLogCleanupResult {
  deleted: number;
  errors: number;
  remainingCount: number;
  remainingBytes: number;
}

/** Concurrency guard — only one cleanup runs at a time */
let isCleanupRunning = false;

const moduleRequire = createRequire(import.meta.url);

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return String(error);
};

const warnLoggerStartupFailure = (
  message: string,
  payload: Record<string, unknown>,
): void => {
  console.warn(message, payload);
};

/** @internal Exposed for focused logger startup tests. */
export const registerBundlerPathOverride = (
  overrides: Record<string, string>,
  key: string,
  pkg: string,
  resolver: () => string,
): boolean => {
  try {
    const resolved = resolver();
    if (resolved && overrides[key] !== resolved) {
      overrides[key] = resolved;
      return true;
    }
  } catch (error) {
    warnLoggerStartupFailure(
      '[logger] failed to register __bundlerPathsOverrides — packaged build may fall back to unbounded log destination',
      { pkg, code: errorCode(error), message: errorMessage(error) },
    );
  }
  return false;
};

const ensureWorkerOverrides = () => {
  const globalAny = globalThis as typeof globalThis & {
    __bundlerPathsOverrides?: Record<string, string>;
  };
  const overrides = globalAny.__bundlerPathsOverrides ? { ...globalAny.__bundlerPathsOverrides } : {};
  let updated = false;

  const register = (key: string, pkg: string, resolver: () => string) => {
    updated = registerBundlerPathOverride(overrides, key, pkg, resolver) || updated;
  };

  register('thread-stream-worker', 'thread-stream/lib/worker.js', () => moduleRequire.resolve('thread-stream/lib/worker.js'));
  register('pino-worker', 'pino/lib/worker.js', () => moduleRequire.resolve('pino/lib/worker.js'));
  register('pino-roll', 'pino-roll', () => moduleRequire.resolve('pino-roll'));

  if (updated) {
    globalAny.__bundlerPathsOverrides = overrides;
  }
};

let bundlerOverridesEnsured = false;

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface SessionLogMeta {
  turnId: string;
  rendererSessionId?: string | null;
}

export interface TurnSessionLogger extends Logger {
  sessionLogPath: string | null;
  flushSessionLogs: () => Promise<void>;
}

const ensureLogDirectory = (): string => {
  const userData = getDataPath();
  const logsDir = path.join(userData, 'logs');
  mkdirSync(logsDir, { recursive: true });
  return logsDir;
};

const ensureSessionLogDirectory = (): string => {
  const base = ensureLogDirectory();
  const sessionDir = path.join(base, SESSION_LOG_SUBDIR);
  mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
};

const resolveLogFilePath = (): string => path.join(ensureLogDirectory(), LOG_FILE_BASENAME);

const safeAppVersion = () => {
  try {
    return getAppVersion();
  } catch {
    return undefined;
  }
};

const LOG_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

const shouldRecordBreadcrumb = (level: LogLevel) =>
  level === 'info' || level === 'warn' || level === 'error' || level === 'fatal';

const toBreadcrumbLevel = (level: LogLevel): 'fatal' | 'error' | 'warning' | 'info' | 'debug' => {
  switch (level) {
    case 'fatal':
      return 'fatal';
    case 'error':
      return 'error';
    case 'warn':
      return 'warning';
    case 'info':
      return 'info';
    case 'debug':
    case 'trace':
      return 'debug';
    default:
      return assertNever(level, 'LogLevel');
  }
};

type ClosableDestinationStream = DestinationStream & {
  on?: (event: 'error', listener: (err: unknown) => void) => void;
  end?: () => void;
};

const extractLogDetails = (
  args: unknown[]
): { message: string; data?: Record<string, unknown> } => {
  if (!args || args.length === 0) {
    return { message: 'Log entry' };
  }

  const [first, second] = args;

  if (typeof first === 'string') {
    const data = typeof second === 'object' && second !== null ? (second as Record<string, unknown>) : undefined;
    return { message: first, data };
  }

  if (typeof second === 'string') {
    const data = typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : undefined;
    return { message: second, data };
  }

  if (first instanceof Error) {
    return {
      message: first.message,
      data: {
        name: first.name,
        stack: first.stack
      }
    };
  }

  try {
    return { message: JSON.stringify(first) };
  } catch {
    return { message: String(first) };
  }
};

// =============================================================================
// Sentry Breadcrumb Integration
// =============================================================================

/** Type-safe accessor for pino Logger methods by level name */
type LogMethod = (...args: unknown[]) => void;
const getLogMethod = (logger: Logger, level: LogLevel): LogMethod | undefined => {
  const fn = (logger as unknown as Record<string, unknown>)[level];
  return typeof fn === 'function' ? fn as LogMethod : undefined;
};
const setLogMethod = (logger: Logger, level: LogLevel, fn: LogMethod): void => {
  (logger as unknown as Record<string, LogMethod>)[level] = fn;
};

function attachSentryBreadcrumbs(target: Logger) {
  for (const level of LOG_LEVELS) {
    const original = getLogMethod(target, level);
    if (!original) {
      continue;
    }
    setLogMethod(target, level, (...args: unknown[]) => {
      // PERF: Skip buffer/breadcrumb work for levels below the configured threshold.
      // pino filters these internally, but the wrapper runs first. This eliminates
      // extractLogDetails + addToLogBuffer overhead for debug/trace calls in production.
      if (!target.isLevelEnabled(level)) {
        return original.apply(target, args);
      }

      const { message, data } = extractLogDetails(args);

      try {
        addToLogBuffer({ timestamp: Date.now(), level, message, data });
      } catch {
        // Silent failure - don't break logging
      }

      if (shouldRecordBreadcrumb(level)) {
        try {
          getErrorReporter().addBreadcrumb({
            category: 'log',
            level: toBreadcrumbLevel(level),
            message,
            data
          });
        } catch (error) {
          ignoreBestEffortCleanup(error, {
            operation: 'logger.addBreadcrumb',
            reason: 'Telemetry sink failure must never resurrect the original log call; logger is foundational and breadcrumb recording is best-effort',
          });
        }
      }
      return original.apply(target, args);
    });
  }
}

const createBaseOptions = (): LoggerOptions => ({
  level: process.env['MINDSTONE_LOG_LEVEL'] ?? (process.env['NODE_ENV'] === 'development' ? 'debug' : 'info'),
  base: {
    pid: process.pid,
    appVersion: safeAppVersion(),
    component: 'main'
  },
  redact: {
    paths: ['context.apiKey', 'context.voiceApiKey'],
    remove: true
  },
  timestamp: isoTime
});

const buildRolledLogPattern = (destinationPath: string): RegExp => {
  const destinationName = path.basename(destinationPath);
  const extension = path.extname(destinationName);
  const stem = extension ? destinationName.slice(0, -extension.length) : destinationName;
  const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedExtension = extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escapedStem}\\.\\d+${escapedExtension}$`);
};

interface FallbackDestinationPreparationResult {
  archived: boolean;
  archivedPath?: string;
  sizeBytes?: number;
}

/** @internal Exposed for focused fallback handling tests. */
export const prepareFallbackDestination = (
  destinationPath: string,
  now: () => number = Date.now,
): FallbackDestinationPreparationResult => {
  try {
    if (!existsSync(destinationPath)) {
      return { archived: false };
    }

    const destinationStat = statSync(destinationPath);
    if (!destinationStat.isFile() || destinationStat.size < FALLBACK_STALE_SIZE_THRESHOLD_BYTES) {
      return { archived: false, sizeBytes: destinationStat.size };
    }

    const archivedPath = `${destinationPath}.fallback-stale-${now()}.log`;
    renameSync(destinationPath, archivedPath);
    return { archived: true, archivedPath, sizeBytes: destinationStat.size };
  } catch (error) {
    warnLoggerStartupFailure(
      '[logger] failed to archive oversized fallback log before reopening fallback destination',
      {
        destinationPath,
        code: errorCode(error),
        message: errorMessage(error),
      },
    );
    return { archived: false };
  }
};

const readFallbackMarkerSlice = (
  fileDescriptor: number,
  bytesToRead: number,
  position: number,
): boolean => {
  const buffer = Buffer.alloc(bytesToRead);
  const bytesRead = readSync(fileDescriptor, buffer, 0, bytesToRead, position);
  return buffer.subarray(0, bytesRead).toString('utf8').includes(FALLBACK_MARKER);
};

const containsFallbackMarker = (filePath: string, sizeBytes: number): boolean => {
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(filePath, 'r');
    const headBytesToRead = Math.min(FALLBACK_MARKER_SCAN_BYTES, sizeBytes);
    if (readFallbackMarkerSlice(fileDescriptor, headBytesToRead, 0)) {
      return true;
    }

    if (sizeBytes <= headBytesToRead) {
      return false;
    }

    const tailPosition = Math.max(
      headBytesToRead,
      sizeBytes - FALLBACK_MARKER_TAIL_BYTES - (FALLBACK_MARKER.length - 1),
    );
    const tailBytesToRead = sizeBytes - tailPosition;
    return readFallbackMarkerSlice(fileDescriptor, tailBytesToRead, tailPosition);
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch (error) {
        warnLoggerStartupFailure(
          '[logger] failed to close stale fallback log after scanning for fallback marker',
          {
            filePath,
            code: errorCode(error),
            message: errorMessage(error),
          },
        );
      }
    }
  }
};

interface CleanupStaleFallbackOptions {
  rotationOk: boolean;
  destinationPath: string;
  logger?: Pick<Logger, 'info' | 'warn'>;
  now?: () => number;
}

interface CleanupStaleFallbackResult {
  deleted: boolean;
  reason:
    | 'rotation-not-ready'
    | 'missing'
    | 'not-file'
    | 'marker-missing'
    | 'no-rolled-siblings'
    | 'newer-than-rolled'
    | 'deleted'
    | 'error';
}

/** @internal Exposed for focused fallback handling tests. */
export const cleanupStaleFallback = ({
  rotationOk,
  destinationPath,
  logger,
  now = Date.now,
}: CleanupStaleFallbackOptions): CleanupStaleFallbackResult => {
  if (!rotationOk) {
    return { deleted: false, reason: 'rotation-not-ready' };
  }

  try {
    if (!existsSync(destinationPath)) {
      return { deleted: false, reason: 'missing' };
    }

    const fallbackStat = statSync(destinationPath);
    if (!fallbackStat.isFile()) {
      return { deleted: false, reason: 'not-file' };
    }

    if (!containsFallbackMarker(destinationPath, fallbackStat.size)) {
      return { deleted: false, reason: 'marker-missing' };
    }

    const logsDir = path.dirname(destinationPath);
    const rolledLogPattern = buildRolledLogPattern(destinationPath);
    let newestRolledMtimeMs: number | undefined;

    for (const name of readdirSync(logsDir)) {
      if (!rolledLogPattern.test(name)) {
        continue;
      }
      const rolledPath = path.join(logsDir, name);
      const rolledStat = statSync(rolledPath);
      if (!rolledStat.isFile()) {
        continue;
      }
      if (newestRolledMtimeMs === undefined || rolledStat.mtimeMs > newestRolledMtimeMs) {
        newestRolledMtimeMs = rolledStat.mtimeMs;
      }
    }

    if (newestRolledMtimeMs === undefined) {
      return { deleted: false, reason: 'no-rolled-siblings' };
    }

    if (fallbackStat.mtimeMs >= newestRolledMtimeMs) {
      return { deleted: false, reason: 'newer-than-rolled' };
    }

    unlinkSync(destinationPath);
    logger?.info(
      { sizeBytes: fallbackStat.size, ageMs: Math.max(0, now() - fallbackStat.mtimeMs) },
      'Cleaned up stale fallback log file',
    );
    return { deleted: true, reason: 'deleted' };
  } catch (error) {
    if (logger) {
      logger.warn(
        {
          err: error,
          destinationPath,
          code: errorCode(error),
          message: errorMessage(error),
        },
        'Failed to clean up stale fallback log file',
      );
    } else {
      warnLoggerStartupFailure(
        '[logger] failed to clean up stale fallback log file',
        {
          destinationPath,
          code: errorCode(error),
          message: errorMessage(error),
        },
      );
    }
    return { deleted: false, reason: 'error' };
  }
};

// =============================================================================
// Transport lifecycle / REBEL-5RT — dead-worker resilience
// =============================================================================
//
// pino's pino-roll transport runs on a worker thread (thread-stream). When that
// worker dies — packaged-build worker-loading edge, a rotation/destination error,
// FD pressure, or process-exit autoEnd racing a late log — any subsequent write
// does NOT throw at the call site. thread-stream's write() schedules an
// asynchronous `'error'` event (`setImmediate(() => stream.emit('error', err))`).
// pino attaches no `'error'` listener to the worker stream, so Node promotes the
// unhandled event to `uncaughtException`; the app's uncaughtException handler
// then logs again, which schedules another async `'error'`, which re-enters the
// handler — a self-sustaining cascade (the 81,680-event REBEL-5RT storm). A
// try/catch around `logger.fatal()` cannot break this, because the write never
// throws synchronously (verified by reproduction spike + pino/thread-stream
// source; see docs/plans/260527_rebel-5rt-logger-fatal-cascade/).
//
// The fix: build the transport via `pino.transport()`, retain the stream handle,
// and attach `'error'`/`'close'` listeners. The listener (1) reports the ORIGINAL
// transport error to Sentry once (rate-limited) — the root-cause signal that was
// previously masked by the cascade — and (2) degrades the root logger to a
// synchronous destination so logging survives and the dead worker is never
// written to again. Handlers must never throw and never log through the (dead)
// pino transport.

// Lazy-init: rootLogger is created on first access, not at module load time.
// This avoids calling getPlatformConfig() before setPlatformConfig() runs,
// which happens when this module is transitively imported during bootstrap
// (ensureVersionCompatibility -> versionMarker -> logger).
let _rootLogger: Logger | undefined;

// Bumped whenever _rootLogger is replaced (e.g. degraded to the sync fallback on
// transport death). Cached scoped/session child loggers compare against this and
// rebuild from the new root when stale, so existing log call sites follow the
// swap instead of writing forever to the dead worker's child stream.
let rootLoggerGeneration = 0;

let transportDegraded = false;
let transportClosedCleanly = false;
let transportErrorReports = 0;
const MAX_TRANSPORT_ERROR_REPORTS = 5;
// Secondary symptom messages emitted by thread-stream's write() once the worker
// is gone — NEVER the root cause, always noise. The real cause arrives either as
// a different error (the worker's posted ERROR payload, e.g. ENOENT) or as
// "the worker thread exited" with an exit code (which we DO want to capture).
//
// INGEST-DEAD STRINGS: these exact message strings are (pending Greg applying
// the proposal in docs/plans/260610_improve-sentry-noise/OUTWARD_PROPOSAL.md)
// also filtered SERVER-SIDE at Sentry ingest (Project Settings → Inbound
// Filters → Custom Filters → Error Message) to kill the residual flood from
// old builds (REBEL-5RT family, ~68% of all events). If you rename or extend
// this list, check the inbound filter stays in sync — see
// docs/project/SENTRY_TRIAGE.md § Worker-exit residue. Regressions on current
// builds stay visible via the structured ['logger-transport-error','REBEL-5RT']
// channel below, which the inbound message filter does not match.
const WORKER_LIFECYCLE_MESSAGES = new Set(['the worker has exited', 'the worker is ending']);

/** @internal Reset transport health flags between tests. */
export const __resetTransportHealthForTests = (): void => {
  transportDegraded = false;
  transportClosedCleanly = false;
  transportErrorReports = 0;
};

// Build a synchronous fallback logger (no worker thread). Used both when the
// rotating transport fails to construct, and when a live worker later dies.
function buildSyncFallbackLogger(destinationPath: string, cause: unknown): Logger {
  // sync: true ensures logs are written immediately — no worker, no async buffer
  // to lose on crash, and no thread-stream lifecycle to fail.
  prepareFallbackDestination(destinationPath);
  const destination = pino.destination({ dest: destinationPath, mkdir: true, sync: true });
  const fallbackLogger = pino(createBaseOptions(), destination);
  attachSentryBreadcrumbs(fallbackLogger);
  if (cause !== undefined) {
    fallbackLogger.warn({ err: cause }, 'Rotating log transport unavailable; using fallback log destination');
  }
  return fallbackLogger;
}

// Report the ORIGINAL transport error to Sentry, decoupled via getErrorReporter
// (never writes through pino). Rate-limited; suppresses the secondary
// worker-lifecycle symptom messages so the captured event is the actual cause.
function reportTransportError(err: unknown, destinationPath: string): void {
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  // Suppress the secondary "worker has exited / is ending" symptoms regardless
  // of close ordering — they are never the root cause and would otherwise burn
  // the report budget and pollute the fingerprint with noise (the H2 late-write
  // path can emit these before the 'close' event fires).
  if (WORKER_LIFECYCLE_MESSAGES.has(message) || transportErrorReports >= MAX_TRANSPORT_ERROR_REPORTS) {
    return;
  }
  transportErrorReports++;
  // One-time-ish diagnostic payload to actually pin down WHY the worker dies in
  // production (dev cannot reproduce it). Decoupled from pino; best-effort.
  const code = (err as { code?: unknown } | null)?.code;
  const overrides = (globalThis as { __bundlerPathsOverrides?: Record<string, string> }).__bundlerPathsOverrides;
  try {
    getErrorReporter().captureException(err, {
      level: 'error',
      fingerprint: ['logger-transport-error', 'REBEL-5RT'],
      tags: { subsystem: 'logger-transport' },
      extra: {
        destinationPath,
        errorName: name,
        errorCode: typeof code === 'string' || typeof code === 'number' ? code : undefined,
        transportClosedCleanly,
        transportDegraded,
        bundlerOverrides: overrides,
        packaged: process.env.NODE_ENV !== 'development',
        platform: process.platform,
        arch: process.arch,
        note: 'pino-roll worker transport error; root logger degraded to synchronous fallback (REBEL-5RT)',
      },
    });
  } catch (reportError) {
    ignoreBestEffortCleanup(reportError, {
      operation: 'logger.reportTransportError.sentry',
      reason: 'Sentry capture is best-effort; a dead-transport handler must never throw (REBEL-5RT).',
    });
  }
  try {
    // Last-resort channel: the pino transport is dead, so we cannot log through it.
    console.error('[logger] pino transport error; degrading to synchronous fallback:', err);
  } catch (consoleError) {
    ignoreBestEffortCleanup(consoleError, {
      operation: 'logger.reportTransportError.console',
      reason: 'Last-resort console.error inside a dead-transport handler must never re-throw (REBEL-5RT).',
    });
  }
}

// Swap the root logger to a synchronous destination and bump the generation so
// cached child loggers rebuild from it. Idempotent on success; if the fallback
// build throws, leave transportDegraded false so a later error can retry (the
// 'error' listener alone already prevents the cascade either way).
function degradeToSyncFallback(destinationPath: string): void {
  if (transportDegraded) {
    return;
  }
  try {
    _rootLogger = buildSyncFallbackLogger(destinationPath, undefined);
    rootLoggerGeneration++;
    transportDegraded = true;
  } catch (fallbackError) {
    // Keep the existing root logger; the listener still prevents the
    // unhandled-error cascade. We just lose the keep-logging-alive enhancement.
    ignoreBestEffortCleanup(fallbackError, {
      operation: 'logger.degradeToSyncFallback',
      reason: 'If the synchronous fallback cannot be built, keep the existing root logger; the transport error listener already prevents the cascade (REBEL-5RT).',
    });
  }
}

/** @internal Exposed for focused rotating transport tests. */
export const setupRotatingTransport = (destinationPath: string): Logger => {
  if (!bundlerOverridesEnsured) {
    ensureWorkerOverrides();
  }

  // Use sync: true to ensure size checks happen after each write completes.
  // This fixes a pino-roll bug where async writes can exceed size limits
  // under high throughput (size check happens after write, rotation waits for drain).
  //
  // REBEL-5RT: construct the transport via pino.transport() (not the
  // pino({ transport }) shorthand) so we retain the ThreadStream handle and can
  // attach lifecycle listeners. See the block comment above for why this is the
  // real fix rather than a try/catch at the call site.
  const transportStream = pino.transport({
    target: 'pino-roll',
    options: {
      file: destinationPath,
      size: DEFAULT_MAX_FILE_SIZE,
      limit: { count: 50, removeOtherLogFiles: true },
      mkdir: true,
      sync: true
    }
  });
  transportStream.on('close', () => {
    // Normal worker close (e.g. process-exit autoEnd). Marks subsequent
    // "the worker has exited" errors as benign lifecycle noise, not root cause.
    transportClosedCleanly = true;
  });
  transportStream.on('error', (err: unknown) => {
    reportTransportError(err, destinationPath);
    degradeToSyncFallback(destinationPath);
  });
  const loggerInstance = pino(createBaseOptions(), transportStream);
  bundlerOverridesEnsured = true;
  attachSentryBreadcrumbs(loggerInstance);
  return loggerInstance;
};

const createLogger = (): Logger => {
  const destinationPath = resolveLogFilePath();
  try {
    const loggerInstance = setupRotatingTransport(destinationPath);
    cleanupStaleFallback({ rotationOk: true, destinationPath, logger: loggerInstance });
    return loggerInstance;
  } catch (error) {
    // Synchronous construction failure (the worker never started): fall straight
    // back to a synchronous destination. (Async worker death after a successful
    // construction is handled by the transport 'error' listener above.)
    return buildSyncFallbackLogger(destinationPath, error);
  }
};

function getRootLogger(): Logger {
  if (!_rootLogger) {
    _rootLogger = createLogger();
  }
  return _rootLogger;
}

export const logger: Logger = new Proxy({} as Logger, {
  get(_, prop) {
    const target = getRootLogger();
    const value = (target as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === 'function') return value.bind(target);
    return value;
  },
  set(_, prop, value) {
    (getRootLogger() as unknown as Record<string | symbol, unknown>)[prop] = value;
    return true;
  },
});

/**
 * Create a scoped logger with additional bindings.
 * Automatically includes turnId and sessionId when called within runWithTurnContext().
 *
 * Returns a lazy proxy so that module-level `const log = createScopedLogger(...)`
 * is safe even before PlatformConfig is initialized. The actual child logger is
 * created on first use (first log call) and cached thereafter.
 */
export const createScopedLogger = (bindings: Record<string, unknown>): Logger => {
  let _child: Logger | undefined;
  let _childGeneration = -1;
  function getChild(): Logger {
    // Rebuild when first used OR when the root logger has been swapped (transport
    // death → sync fallback), so existing scoped loggers follow the swap rather
    // than writing forever to the dead worker's child stream.
    if (!_child || _childGeneration !== rootLoggerGeneration) {
      const turnContext = turnContextStorage.getStore();
      if (turnContext) {
        const enrichedBindings: Record<string, unknown> = {
          ...bindings,
          turnId: turnContext.turnId,
        };
        if (turnContext.sessionId) {
          enrichedBindings.sessionId = turnContext.sessionId;
        }
        _child = getRootLogger().child(enrichedBindings);
      } else {
        _child = getRootLogger().child(bindings);
      }
      _childGeneration = rootLoggerGeneration;
    }
    return _child;
  }
  return new Proxy({} as Logger, {
    get(_, prop) {
      const target = getChild();
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof value === 'function') return value.bind(target);
      return value;
    },
    set(_, prop, value) {
      (getChild() as unknown as Record<string | symbol, unknown>)[prop] = value;
      return true;
    },
  });
};

const sanitizeFilenameComponent = (value: string): string => {
  return value
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '')
    .slice(0, 32)
    .toLowerCase() || 'unknown';
};

const buildSessionLogFilePath = ({ turnId, rendererSessionId }: SessionLogMeta): string => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const turnSegment = sanitizeFilenameComponent(turnId);
  const rendererSegment = rendererSessionId ? `-renderer-${sanitizeFilenameComponent(rendererSessionId)}` : '';
  const fileName = `${timestamp}-turn-${turnSegment}${rendererSegment}.log`;
  return path.join(ensureSessionLogDirectory(), fileName);
};

export const createTurnSessionLogger = (
  bindings: Record<string, unknown>,
  meta: SessionLogMeta
): TurnSessionLogger => {
  let aggregateLogger = getRootLogger().child(bindings);
  let aggregateGeneration = rootLoggerGeneration;
  // Rebuild the aggregate child from the current root if the root logger has been
  // swapped (transport death → sync fallback), so an in-flight turn keeps logging
  // to the live destination instead of the dead worker.
  const getAggregate = (): Logger => {
    if (aggregateGeneration !== rootLoggerGeneration) {
      aggregateLogger = getRootLogger().child(bindings);
      aggregateGeneration = rootLoggerGeneration;
    }
    return aggregateLogger;
  };
  let sessionLogger: Logger | null = null;
  let sessionDestination: ClosableDestinationStream | null = null;
  let sessionLogPath: string | null = null;
  // Flag to prevent writes after session log is closed (avoids SonicBoom destroyed errors)
  let sessionClosed = false;

  try {
    sessionLogPath = buildSessionLogFilePath(meta);
    sessionDestination = pino.destination({ dest: sessionLogPath, mkdir: true, sync: false }) as ClosableDestinationStream;
    // Handle stream errors to prevent unhandled "write after end" exceptions
    // This can occur if async writes race with stream closure
    sessionDestination.on?.('error', (err: unknown) => {
      // Mark session as closed to prevent further writes
      sessionClosed = true;
      aggregateLogger.warn({ err, sessionLogPath }, 'Session log stream error (writes will continue to aggregate log)');
    });
    const baseOptions = createBaseOptions();
    const sessionOptions: LoggerOptions = {
      ...baseOptions,
      level: 'trace',
      base: {
        ...baseOptions.base,
        component: 'agent-turn-session',
        ...bindings
      }
    };
    sessionLogger = pino(sessionOptions, sessionDestination);
    attachSentryBreadcrumbs(sessionLogger);
  } catch (error) {
    aggregateLogger.warn({ err: error }, 'Failed to initialize session-specific log file; falling back to aggregate log');
    sessionLogger = null;
    sessionDestination = null;
    sessionLogPath = null;
  }

  const dualLogger = Object.create(aggregateLogger) as TurnSessionLogger;

  for (const level of LOG_LEVELS) {
    setLogMethod(dualLogger, level, (...args: unknown[]) => {
      // Always write to aggregate logger (generation-aware: follows a root swap)
      getLogMethod(getAggregate(), level)?.(...args);
      // Only write to session logger if not closed (async callbacks may fire after close)
      if (sessionLogger && !sessionClosed) {
        try {
          getLogMethod(sessionLogger, level)?.(...args);
        } catch {
          // Silent - stream may be closing, don't cascade errors (e.g., SonicBoom destroyed).
          // The aggregate logger above already captured this log entry.
          if (process.env.MINDSTONE_LOG_LEVEL === 'trace') {
            aggregateLogger.trace({ sessionLogPath }, 'Dropped late write to closed session log');
          }
        }
      }
    });
  }

  dualLogger.sessionLogPath = sessionLogPath;
  dualLogger.flushSessionLogs = async () => {
    if (!sessionLogger) {
      return;
    }
    // Set closed flag BEFORE flush/end to prevent race with async callbacks
    sessionClosed = true;
    try {
      sessionLogger.flush();
    } catch (flushError) {
      aggregateLogger.error({ err: flushError, sessionLogPath }, 'Failed to flush session log');
    } finally {
      if (sessionDestination?.end) {
        try {
          sessionDestination.end();
        } catch (closeError) {
          aggregateLogger.error({ err: closeError, sessionLogPath }, 'Failed to close session log stream');
        }
      }
    }
  };

  return dualLogger;
};

export const logAtLevel = (level: LogLevel, message: string, context?: Record<string, unknown>) => {
  const payload = context ?? {};
  switch (level) {
    case 'trace':
      getRootLogger().trace(payload, message);
      break;
    case 'debug':
      getRootLogger().debug(payload, message);
      break;
    case 'info':
      getRootLogger().info(payload, message);
      break;
    case 'warn':
      getRootLogger().warn(payload, message);
      break;
    case 'error':
      getRootLogger().error(payload, message);
      break;
    case 'fatal':
      getRootLogger().fatal(payload, message);
      break;
    default:
      getRootLogger().info(payload, message);
      break;
  }
};

export const getLogDirectory = ensureLogDirectory;
export const getLogFilePath = resolveLogFilePath;

/**
 * Clean up session log files, enforcing age, count, and size bounds.
 *
 * Algorithm (single pass over files sorted newest→oldest):
 *  1. Files younger than 60 s are always kept (grace floor — avoids deleting active logs).
 *  2. Among remaining files, keep those within the age cutoff AND under the file-count
 *     AND cumulative-size caps.
 *  3. Everything else is deleted.
 *
 * Handles per-file errors (especially Windows EBUSY/EPERM) and continues cleanup.
 * Only one cleanup runs at a time (concurrency guard).
 */
export async function cleanupSessionLogs(
  options?: SessionLogCleanupOptions
): Promise<SessionLogCleanupResult> {
  const zeroResult: SessionLogCleanupResult = { deleted: 0, errors: 0, remainingCount: 0, remainingBytes: 0 };

  // Concurrency guard — skip if another cleanup is in progress
  if (isCleanupRunning) {
    getRootLogger().debug('Session log cleanup already running; skipping');
    return zeroResult;
  }

  isCleanupRunning = true;
  try {
    const {
      retentionDays = SESSION_LOG_DEFAULTS.retentionDays,
      maxFiles = SESSION_LOG_DEFAULTS.maxFiles,
      maxBytes = SESSION_LOG_DEFAULTS.maxBytes,
    } = options ?? {};

    const sessionsDir = path.join(ensureLogDirectory(), SESSION_LOG_SUBDIR);
    const now = Date.now();
    const ageCutoffMs = now - retentionDays * 86_400_000;
    const graceFloorMs = now - 60_000; // never delete files younger than 60 s

    // Read directory contents
    let fileNames: string[];
    try {
      fileNames = await readdir(sessionsDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        getRootLogger().debug({ sessionsDir }, 'Session logs directory does not exist; skipping cleanup');
        return zeroResult;
      }
      getRootLogger().warn({ err, sessionsDir }, 'Failed to read session logs directory');
      return zeroResult;
    }

    // Filter to .log files only
    const logFileNames = fileNames.filter((name) => name.endsWith('.log'));

    if (logFileNames.length === 0) {
      getRootLogger().debug({ retentionDays }, 'Session log cleanup: no .log files found');
      return zeroResult;
    }

    // Parallel stat all .log files
    const statResults = await Promise.allSettled(
      logFileNames.map((name) =>
        stat(path.join(sessionsDir, name)).then((s) => ({
          name,
          size: s.size,
          mtimeMs: s.mtimeMs,
          isFile: s.isFile(),
        }))
      )
    );

    // Collect successful stats for actual files; log non-ENOENT stat failures
    const fileEntries: { name: string; size: number; mtimeMs: number }[] = [];
    for (const result of statResults) {
      if (result.status === 'fulfilled' && result.value.isFile) {
        fileEntries.push(result.value);
      } else if (result.status === 'rejected') {
        const errCode = (result.reason as NodeJS.ErrnoException)?.code;
        // ENOENT is expected (file vanished between readdir and stat)
        if (errCode !== 'ENOENT') {
          getRootLogger().warn({ err: result.reason }, 'Failed to stat session log file during cleanup');
        }
      }
    }

    // Sort newest first (descending mtime)
    fileEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);

    // Single-pass: decide keep/delete for each file
    let keptCount = 0;
    let keptBytes = 0;
    const toDelete: string[] = [];

    for (const entry of fileEntries) {
      if (entry.mtimeMs >= graceFloorMs) {
        // Always protect very recent files
        keptCount++;
        keptBytes += entry.size;
      } else if (
        entry.mtimeMs >= ageCutoffMs &&
        keptCount < maxFiles &&
        keptBytes + entry.size <= maxBytes
      ) {
        // Within all bounds — keep
        keptCount++;
        keptBytes += entry.size;
      } else {
        // Outside at least one bound — delete
        toDelete.push(entry.name);
      }
    }

    // Delete marked files
    let deleted = 0;
    let errors = 0;
    for (const name of toDelete) {
      const filePath = path.join(sessionsDir, name);
      try {
        await unlink(filePath);
        deleted++;
      } catch (err: unknown) {
        const errCode = (err as NodeJS.ErrnoException).code;
        if (errCode === 'EBUSY' || errCode === 'EPERM' || errCode === 'ENOENT') {
          getRootLogger().debug({ filePath, errCode }, 'Skipped session log file during cleanup');
        } else {
          getRootLogger().warn({ err, filePath }, 'Failed to delete session log file');
        }
        errors++;
      }
    }

    // Log summary
    const cleanupResult: SessionLogCleanupResult = {
      deleted,
      errors,
      remainingCount: keptCount,
      remainingBytes: keptBytes,
    };

    if (deleted > 0 || errors > 0) {
      getRootLogger().info(
        { ...cleanupResult, retentionDays, maxFiles, maxBytes },
        'Session log cleanup completed'
      );
    } else {
      getRootLogger().debug(
        { remainingCount: keptCount, remainingBytes: keptBytes, retentionDays },
        'Session log cleanup: no files to delete'
      );
    }

    return cleanupResult;
  } finally {
    isCleanupRunning = false;
  }
}

/** @internal Exposed for tests only — reset the cleanup concurrency guard. */
export function _resetCleanupGuard(): void {
  isCleanupRunning = false;
}

/** @internal Exposed for tests only — read the cleanup concurrency guard. */
export function _isCleanupRunning(): boolean {
  return isCleanupRunning;
}

export type { LogLevel };
