import { getErrorReporter, type ErrorReporterCaptureContext, type InternalCaptureContext } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import { KNOWN_CONDITIONS, type ConditionMeta, type KnownCondition } from '@core/sentry/knownConditions';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import type { z } from 'zod';

type Registry = typeof KNOWN_CONDITIONS;

type FingerprintContextFor<TMeta> = TMeta extends {
  readonly fingerprint: (context: infer TContext) => readonly string[];
}
  ? TContext
  : Record<string, unknown>;

type SchemaContextFor<TMeta> = TMeta extends {
  readonly contextSchema: z.ZodSchema<infer TContext>;
}
  ? TContext
  : FingerprintContextFor<TMeta>;

export type ConditionContextFor<C extends KnownCondition> =
  ErrorReporterCaptureContext & SchemaContextFor<Registry[C]>;

const log = createScopedLogger({ service: 'captureKnownCondition' });

let warnedKillSwitch = false;

function captureErrorFor(condition: string, error: Error | undefined): Error {
  if (error) return error;
  safeWarn(
    { condition },
    'captureKnownCondition called without an error — capturing synthetic Error (caller should pass the original)',
  );
  return new Error(`captureKnownCondition[${condition}]`);
}

function safeWarn(payload: Record<string, unknown>, message: string): void {
  try {
    log.warn(payload, message);
  } catch {
    // Logging must never make Sentry capture paths throw.
  }
}

function safeCaptureException(
  condition: string,
  error: Error | undefined,
  context?: ErrorReporterCaptureContext,
): void {
  try {
    getErrorReporter().captureException(captureErrorFor(condition, error), context);
  } catch (adapterError) {
    // Wave 2d (W2D-6) sentinel: re-throw KnownConditionGuardError so the
    // Wave 2c deterministic-CI-failure contract (KNOWN_CONDITION_GUARD_LEVEL=throw
    // in NODE_ENV=test) survives this fail-safe wrapper. Fallback paths route
    // raw context (no `_knownConditionWrapped` flag), so the Layer-2 guard
    // CAN fire here when the error/condition matches KNOWN_CONDITIONS.
    // See docs/plans/260503_wave2d_layer2_contract_completion.md (Wave 2d).
    if (
      process.env.NODE_ENV === 'test' &&
      (adapterError as { name?: string } | null)?.name === 'KnownConditionGuardError'
    ) {
      throw adapterError;
    }
    safeWarn({ condition, err: adapterError }, 'captureKnownCondition reporter threw during fallback capture');
  }
}

function findKnownCondition(condition: string): ConditionMeta | undefined {
  const registry = KNOWN_CONDITIONS as Partial<Record<string, ConditionMeta>>;
  return registry[condition];
}

function validateContext(
  condition: string,
  meta: ConditionMeta,
  context: ErrorReporterCaptureContext,
): boolean {
  if (!meta.contextSchema) {
    return true;
  }

  try {
    const result = meta.contextSchema.safeParse(context);
    if (result.success) {
      return true;
    }

    safeWarn(
      { condition, issues: result.error.issues },
      'captureKnownCondition schema validation failed',
    );
    return false;
  } catch (schemaError) {
    safeWarn(
      { condition, err: schemaError },
      'captureKnownCondition schema validation threw',
    );
    return false;
  }
}

export function recordKnownConditionLedgerOnly(condition: KnownCondition): void {
  try {
    const meta = findKnownCondition(condition);
    if (meta) {
      appendDiagnosticEvent({
        kind: 'known_condition',
        data: {
          condition,
          level: meta.level,
        },
      });
    }
  } catch (ledgerError) {
    ignoreBestEffortCleanup(ledgerError, {
      operation: 'recordKnownConditionLedgerOnly.appendDiagnosticEvent',
      reason: 'Diagnostic ledger writes are best-effort and must never interrupt known-condition handling',
    });
  }
}

/**
 * Stage 4 sink policy (docs/plans/260610_improve-sentry-noise/PLAN.md):
 * `sink: 'ledger-only'` info conditions skip the Sentry capture entirely —
 * the ledger mirror (which always runs before this decision) is the sink.
 *
 * Fail-open by construction: any unexpected error in the skip decision
 * returns false, falling through to the normal wrapped capture. Requiring
 * BOTH `level === 'info'` AND an explicit `sink === 'ledger-only'` keeps the
 * fail direction safe — a malformed/forged meta can only ever cause an extra
 * send, never a silent drop.
 */
function shouldSkipSentryCapture(meta: ConditionMeta): boolean {
  try {
    return meta.level === 'info' && meta.sink === 'ledger-only';
  } catch (sinkError) {
    safeWarn(
      { err: sinkError },
      'captureKnownCondition sink-policy check threw — failing open to capture',
    );
    ignoreBestEffortCleanup(sinkError, {
      operation: 'captureKnownCondition.shouldSkipSentryCapture',
      reason: 'Sink-policy check is best-effort; on any failure we fail open and send the capture',
    });
    return false;
  }
}

/**
 * Debuggability for skipped captures: the condition (plus its `extra`
 * payload, which the ledger does NOT persist) rides on the next real Sentry
 * event as a breadcrumb. Best-effort — a breadcrumb failure never revives the
 * capture and never throws.
 */
function emitLedgerOnlySkipBreadcrumb(
  condition: string,
  context: ErrorReporterCaptureContext,
): void {
  try {
    const extra = context.extra;
    getErrorReporter().addBreadcrumb({
      category: 'known_condition',
      message: condition,
      level: 'info',
      data: { ...(extra ?? {}), condition, sink: 'ledger-only' },
    });
  } catch (breadcrumbError) {
    safeWarn(
      { condition, err: breadcrumbError },
      'captureKnownCondition ledger-only skip breadcrumb emit failed',
    );
  }
}

function resolveFingerprint(
  condition: KnownCondition,
  meta: ConditionMeta,
  context: ErrorReporterCaptureContext,
): readonly string[] {
  if (typeof meta.fingerprint !== 'function') {
    return meta.fingerprint;
  }

  try {
    return meta.fingerprint(context);
  } catch (fingerprintError) {
    safeWarn(
      { condition, err: fingerprintError },
      'captureKnownCondition dynamic fingerprint callback threw',
    );
    return [condition];
  }
}

export function captureKnownCondition<C extends KnownCondition>(
  condition: C,
  context: ConditionContextFor<C>,
  error?: Error,
): void {
  const originalContext = context;

  // Mirror every wrapped capture into the diagnostic-events ledger. Wrapped in
  // a defensive try/catch so a ledger failure (no writer registered, fs error,
  // etc.) can never break the Sentry capture path that is the actual contract
  // of this function.
  recordKnownConditionLedgerOnly(condition);

  try {
    if (process.env.KNOWN_CONDITION_WRAPPER_DISABLED === '1') {
      if (!warnedKillSwitch) {
        warnedKillSwitch = true;
        safeWarn(
          {},
          'KNOWN_CONDITION_WRAPPER_DISABLED is set — captureKnownCondition is operating as no-op pass-through. Known fingerprint stability is lost — fragmentation regression risk.',
        );
      }

      safeCaptureException(condition, error, originalContext);
      return;
    }

    const meta = findKnownCondition(condition);
    if (!meta) {
      safeWarn({ condition }, `unknown condition: ${condition}`);
      safeCaptureException(condition, error, originalContext);
      return;
    }

    if (!validateContext(condition, meta, originalContext)) {
      safeCaptureException(condition, error, originalContext);
      return;
    }

    // Stage 4 sink policy: ledger-only info conditions never reach the Sentry
    // issue stream. The ledger mirror already ran above; leave a breadcrumb
    // for debuggability. (The KNOWN_CONDITION_WRAPPER_DISABLED kill switch
    // above bypasses this skip — its pass-through restores Sentry delivery.)
    if (shouldSkipSentryCapture(meta)) {
      emitLedgerOnlySkipBreadcrumb(condition, originalContext);
      safeWarn({ condition, sink: 'ledger-only' }, 'sentry capture skipped — ledger-only sink');
      return;
    }

    const fingerprint = resolveFingerprint(condition, meta, originalContext);
    const internalContext: InternalCaptureContext = {
      ...originalContext,
      fingerprint,
      level: meta.level,
      // Queryable per-condition Sentry tag — lets alert rules / searches scope to a
      // SPECIFIC known condition (sibling conditions otherwise share area/component
      // tags). Independent of fingerprint (grouping unchanged). Authoritative: the
      // registry condition name overrides any caller-supplied `condition` tag. Tag
      // value is a fixed `KnownCondition` enum key — low-cardinality, no PII.
      tags: { ...originalContext.tags, condition },
      _knownConditionWrapped: true,
    };

    try {
      getErrorReporter().captureException(
        captureErrorFor(condition, error),
        internalContext as ErrorReporterCaptureContext,
      );
    } catch (adapterError) {
      safeWarn({ condition, err: adapterError }, 'captureKnownCondition reporter threw');
      return;
    }

    safeWarn({ condition, fingerprint }, 'sentry capture');
  } catch (unexpectedError) {
    safeWarn(
      { condition, err: unexpectedError },
      'captureKnownCondition unexpected failure; falling back to vanilla captureException',
    );
    safeCaptureException(condition, error);
  }
}
