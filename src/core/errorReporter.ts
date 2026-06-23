/**
 * ErrorReporter — platform-agnostic error capture interface.
 *
 * Replaces direct Sentry imports in core business logic.
 * Electron impl wraps @sentry/electron; cloud impl wraps @sentry/node or console.
 *
 * Intentionally minimal: only covers the common captureException/captureMessage
 * pattern. Sentry-specific features (health context, log attachments, withScope)
 * stay in src/main/sentry.ts.
 */
import { KNOWN_CONDITIONS } from '@core/sentry/knownConditions';
import { KnownStructuredError } from '@core/sentry/knownStructuredError';

/**
 * Per-event scope mutator passed to {@link ErrorReporter.captureExceptionWithScope}.
 * Implementations MUST scope these to the captured event only (e.g. via
 * `Sentry.withScope`) — never mutate global isolation scope. See
 * docs/plans/260428_graceful_fs_emfile_fix.md Stage 3.
 */
export interface ErrorReporterEventScope {
  setTag(key: string, value: string): void;
  setContext(name: string, context: Record<string, unknown>): void;
}

type ErrorReporterSeverityLevel = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';

/**
 * Levels accepted by RAW (unwrapped) captures. `'info'` is deliberately
 * excluded at the type level: info-level telemetry must go through
 * `captureKnownCondition` (where the registry's `sink` policy adjudicates
 * ledger-only vs issue-stream delivery) or through breadcrumbs/the diagnostic
 * ledger. Raw info captures are what filled the Sentry issue stream with
 * telemetry-as-error noise — Stage 5 of
 * docs/plans/260610_improve-sentry-noise/PLAN.md (kill-by-construction;
 * the eslint `no-restricted-syntax` raw-info-capture selector backstops casts).
 */
export type RawCaptureSeverityLevel = Exclude<ErrorReporterSeverityLevel, 'info'>;

type ErrorReporterCaptureContextBase<
  TLevel extends ErrorReporterSeverityLevel = RawCaptureSeverityLevel,
> = {
  fingerprint?: readonly string[];
  level?: TLevel;
  tags?: Record<string, string | number | boolean>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown>>;
  user?: {
    id?: string;
    email?: string;
    username?: string;
    ip_address?: string;
  } & Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Sentry CaptureContext-compatible shape for ErrorReporter capture calls.
 *
 * Supported top-level fields: `fingerprint`, `level`, `tags`, `extra`,
 * `contexts`, `user`.
 *
 * `_knownConditionWrapped` is reserved for internal wrapper plumbing and is
 * intentionally typed as `never` so callers cannot set it directly.
 *
 * `level` excludes `'info'` — see {@link RawCaptureSeverityLevel}.
 */
export type ErrorReporterCaptureContext = ErrorReporterCaptureContextBase & {
  _knownConditionWrapped?: never;
};

/**
 * Context for raw MESSAGE captures — `level` is REQUIRED (Stage 6 of
 * docs/plans/260610_improve-sentry-noise/PLAN.md).
 *
 * Rationale: Sentry defaults a level-less `captureMessage` to `'info'`,
 * which is invisible to both raw-level guards (the `RawCaptureSeverityLevel`
 * type exclusion and the eslint literal-`level: 'info'` selector) — a
 * level-omitting site is a de-facto info event that fills the issue stream
 * without ever being adjudicated. Requiring the field forces an explicit,
 * reviewable level at every message-capture site. Exceptions keep an
 * optional level (Sentry defaults them to `'error'`, which is the correct
 * default for exceptions).
 */
export type ErrorReporterMessageCaptureContext = ErrorReporterCaptureContext & {
  level: RawCaptureSeverityLevel;
};

/**
 * Wrapper-internal extension of {@link ErrorReporterCaptureContext}.
 *
 * Reserved for typed wrapper plumbing (`captureKnownCondition` internals).
 * External callers must use {@link ErrorReporterCaptureContext}.
 *
 * Unlike the public context, `level` here spans the FULL severity union
 * (including `'info'`): the wrapper legitimately captures at registry-owned
 * levels — an info condition adjudicated `sink: 'issue-stream'` still goes
 * out at level info. The raw-API `'info'` exclusion targets un-adjudicated
 * call sites, not the registry-governed path.
 */
export type InternalCaptureContext = ErrorReporterCaptureContextBase<ErrorReporterSeverityLevel> & {
  _knownConditionWrapped?: true;
};

export interface ErrorReporter {
  captureException(error: unknown, context?: ErrorReporterCaptureContext): void;
  /** Context (with an explicit `level`) is REQUIRED — see {@link ErrorReporterMessageCaptureContext}. */
  captureMessage(message: string, context: ErrorReporterMessageCaptureContext): void;
  addBreadcrumb(breadcrumb: { category: string; message: string; level?: string; data?: Record<string, unknown> }): void;
  /**
   * Capture an exception with per-event tags/context applied via a scoped
   * Sentry mutator. Implementations MUST internally use `Sentry.withScope(...)`
   * (or equivalent) so the tag/context only applies to the captured event —
   * not to the global isolation scope. Optional for back-compat with
   * implementations that pre-date this method (silent reporter is a no-op).
   */
  captureExceptionWithScope?(
    error: unknown,
    scopeMutator: (scope: ErrorReporterEventScope) => void,
  ): void;
}

// Layer-2 guard warns use console.warn rather than pino so this module stays
// platform-agnostic — `src/core/` is bundled into the React Native mobile app
// via Metro, which can't resolve Node-only deps like pino. Structured payload
// goes as the second argument; the lint rule `pinoArgOrderSelectors` skips
// `console.*` callsites, so the message-first ordering is safe here.
const log = {
  warn(payload: Record<string, unknown>, message: string): void {
    console.warn(`[errorReporter] ${message}`, payload);
  },
};

/**
 * Thrown by the Layer-2 known-condition guard in test mode (Wave 2c Stage 2).
 *
 * In `process.env.NODE_ENV === 'test'` the guard escalates from warn-only to
 * hard-fail so accidental unwrapped `KnownStructuredError` captures (and
 * variable-driven `tags.condition` captures matching `KNOWN_CONDITIONS`) cause
 * deterministic CI failures instead of stdout warnings that get silently
 * dropped by the default test reporter.
 *
 * Production remains warn-only fail-safe. The escape hatch is the
 * `KNOWN_CONDITION_GUARD_LEVEL` env var (`'throw'` | `'warn'` | `'off'`).
 */
export class KnownConditionGuardError extends Error {
  readonly payload: Record<string, unknown>;
  constructor(message: string, payload: Record<string, unknown>) {
    super(message);
    this.name = 'KnownConditionGuardError';
    this.payload = payload;
  }
}

let offWarnLatched = false;
let throwIgnoredWarnLatched = false;
let unrecognizedWarnLatched = false;

/**
 * Test-only helper for resetting the once-per-process latch flags used by the
 * Layer-2 guard's env-knob observability warns. Tests reset between cases so
 * each test starts clean.
 */
export function __resetGuardLatchesForTesting(): void {
  offWarnLatched = false;
  throwIgnoredWarnLatched = false;
  unrecognizedWarnLatched = false;
}

type GuardLevel = 'throw' | 'warn' | 'off';

function resolveGuardLevel(): GuardLevel {
  const envValue = process.env.KNOWN_CONDITION_GUARD_LEVEL;
  const isTestEnv = process.env.NODE_ENV === 'test';

  if (envValue === 'off') {
    if (!offWarnLatched) {
      offWarnLatched = true;
      try {
        log.warn(
          { envKnob: 'KNOWN_CONDITION_GUARD_LEVEL=off' },
          'KNOWN_CONDITION_GUARD_LEVEL=off — Layer-2 known-condition guard fully disabled',
        );
      } catch {
        // Latched-warn must never block capture; swallow logger transport errors.
      }
    }
    return 'off';
  }
  if (envValue === 'warn') return 'warn';
  if (envValue === 'throw') {
    if (isTestEnv) return 'throw';
    if (!throwIgnoredWarnLatched) {
      throwIgnoredWarnLatched = true;
      try {
        log.warn(
          { envKnob: 'KNOWN_CONDITION_GUARD_LEVEL=throw', nodeEnv: process.env.NODE_ENV ?? 'undefined' },
          'KNOWN_CONDITION_GUARD_LEVEL=throw ignored: throw mode requires NODE_ENV=test; falling back to warn',
        );
      } catch {
        // Latched-warn must never block capture; swallow logger transport errors.
      }
    }
    return 'warn';
  }
  if (envValue !== undefined && envValue !== '') {
    if (!unrecognizedWarnLatched) {
      unrecognizedWarnLatched = true;
      try {
        log.warn(
          { envKnob: `KNOWN_CONDITION_GUARD_LEVEL=${envValue}` },
          `KNOWN_CONDITION_GUARD_LEVEL=${envValue} not recognized; expected throw|warn|off; falling back to default`,
        );
      } catch {
        // Latched-warn must never block capture; swallow logger transport errors.
      }
    }
  }
  return isTestEnv ? 'throw' : 'warn';
}

function emitGuardSignal(level: GuardLevel, payload: Record<string, unknown>, message: string): void {
  if (level === 'throw') {
    throw new KnownConditionGuardError(message, payload);
  }
  try {
    log.warn(payload, message);
  } catch {
    // Layer-2 guard must never block the underlying capture even if logging
    // throws (e.g. circular-reference serialization, transport down).
  }
}

const _silent: ErrorReporter = {
  captureException: (_error: unknown, _context?: ErrorReporterCaptureContext) => {},
  captureMessage: (_message: string, _context: ErrorReporterMessageCaptureContext) => {},
  addBreadcrumb: () => {},
  captureExceptionWithScope: () => {},
};

let _reporter: ErrorReporter = _silent;

function warnOnUnwrappedKnownStructuredError(
  error: unknown,
  context?: ErrorReporterCaptureContext,
): void {
  if ((context as InternalCaptureContext | undefined)?._knownConditionWrapped === true) return;

  const isKnownStructured = error instanceof KnownStructuredError;
  const conditionTag = context?.tags?.condition;
  const isVariableDriven =
    typeof conditionTag === 'string' && Object.hasOwn(KNOWN_CONDITIONS, conditionTag);

  if (!isKnownStructured && !isVariableDriven) return;

  const level = resolveGuardLevel();
  if (level === 'off') return;

  if (isKnownStructured) {
    emitGuardSignal(
      level,
      { errorClass: (error as Error).constructor.name, hasContext: context != null },
      'unwrapped known structured error capture — use captureKnownCondition',
    );
    return;
  }

  emitGuardSignal(
    level,
    {
      conditionTag,
      errorClass:
        (error as { constructor?: { name?: string } } | null)?.constructor?.name ?? 'unknown',
    },
    'unwrapped known-condition capture (variable-driven) — use captureKnownCondition',
  );
}

const _boundaryReporterWithoutScope: ErrorReporter = {
  captureException: (error, context) => {
    warnOnUnwrappedKnownStructuredError(error, context);
    _reporter.captureException(error, context);
  },
  captureMessage: (message, context) => {
    _reporter.captureMessage(message, context);
  },
  addBreadcrumb: (breadcrumb) => {
    _reporter.addBreadcrumb(breadcrumb);
  },
};

const _boundaryReporterWithScope: ErrorReporter = {
  ..._boundaryReporterWithoutScope,
  captureExceptionWithScope: (error, scopeMutator) => {
    // Wave 2d (W2D-7): close the Layer-2 guard symmetry asymmetry.
    // The guard runs against an empty context, so it catches the
    // `instanceof KnownStructuredError` arm but NOT the variable-driven
    // tags.condition arm. Today's two consumers (oauthRefreshTelemetry,
    // gracefulFsObservability) pass plain Error + non-known tags so
    // the gap is forward-looking only. If a future caller relies on
    // tags.condition === KNOWN_CONDITIONS-key detection through
    // captureExceptionWithScope, escalate to a recording-shim approach
    // (deferred — see Wave 2d Discovered Improvements / Wave 2e).
    warnOnUnwrappedKnownStructuredError(error, undefined);
    _reporter.captureExceptionWithScope?.(error, scopeMutator);
  },
};

export function setErrorReporter(reporter: ErrorReporter): void {
  _reporter = reporter;
}

export function getErrorReporter(): ErrorReporter {
  return _reporter.captureExceptionWithScope
    ? _boundaryReporterWithScope
    : _boundaryReporterWithoutScope;
}
