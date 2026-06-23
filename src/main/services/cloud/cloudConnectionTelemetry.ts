/**
 * Cloud-connection telemetry — registry-owned Sentry captures + ledger for the
 * cloudFailureCooldown state-transition family (cloud_connection_degraded /
 * cloud_connection_degraded_escalated / cloud_connection_recovered).
 *
 * Stages 3–4 of docs/plans/260610_improve-sentry-noise/PLAN.md:
 * - "recovered" is SUCCESS telemetry — it never reaches the Sentry issue
 *   stream (was REBEL info noise, ~4.3k events/14d). It goes to the
 *   diagnostic ledger + a breadcrumb so the recovery context rides along on
 *   the next real Sentry event.
 * - "degraded" (info) and "degraded_escalated" (warning) are registry-owned
 *   (`captureKnownCondition`) so level + fingerprint are governed and every
 *   call is mirrored to the on-device ledger. Since Stage 4, "degraded" is
 *   additionally `sink: 'ledger-only'` — the wrapper skips its Sentry
 *   capture (open-state flap telemetry; the skip breadcrumb carries the
 *   transition extras onto the next real event, and "escalated" marks
 *   sustained incidents in the issue stream).
 *
 * Extracted from inline `deferredErrorReporter.captureMessage` hook bodies in
 * cloudConnectionReconcilerSingleton.ts so the payload assembly is
 * unit-testable against the REAL wrapper + registry.
 *
 * Fail-safe contract: these helpers must never throw — they run inside
 * cloudFailureCooldown observability hooks on the reconciler hot path. The
 * cooldown's notifyObservabilityHook try/catches as a second layer, but the
 * helpers are independently safe (captureKnownCondition and
 * recordKnownConditionLedgerOnly swallow internal failures; the breadcrumb
 * write is wrapped here).
 */

import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import {
  captureKnownCondition,
  recordKnownConditionLedgerOnly,
} from '@core/sentry/captureKnownCondition';
import type {
  CloudFailureCooldownRecoveryContext,
  CloudFailureCooldownTransitionContext,
} from './cloudFailureCooldown';

const log = createScopedLogger({ service: 'cloudConnectionTelemetry' });

/** Cloud-instance identity threaded into every connection-telemetry payload. */
export interface CloudInstanceObservabilityExtra {
  cloudUrl?: string;
  flyAppName?: string;
}

/**
 * Cloud connection entered the degraded state (healthy → degraded edge).
 * Registry-owned info, `sink: 'ledger-only'` — the wrapper writes the ledger
 * and a breadcrumb (with these extras) instead of a Sentry capture; open
 * degraded state, flap-pair partner of recovered.
 */
export function captureCloudConnectionDegraded(
  context: CloudFailureCooldownTransitionContext,
  instanceExtra: CloudInstanceObservabilityExtra,
): void {
  captureKnownCondition(
    'cloud_connection_degraded',
    {
      extra: {
        category: context.category,
        writer: context.writer,
        escalationLevel: context.escalationLevel,
        consecutiveFailures: context.consecutiveFailures,
        ...instanceExtra,
      },
    },
    new Error('cloud_connection_degraded'),
  );
}

/**
 * Degradation crossed an escalation-level threshold while already degraded.
 * Registry-owned warning — sustained degradation, sweep-worthy.
 */
export function captureCloudConnectionDegradedEscalated(
  context: CloudFailureCooldownTransitionContext,
  instanceExtra: CloudInstanceObservabilityExtra,
): void {
  captureKnownCondition(
    'cloud_connection_degraded_escalated',
    {
      extra: {
        category: context.category,
        writer: context.writer,
        escalationLevel: context.escalationLevel,
        consecutiveFailures: context.consecutiveFailures,
        ...instanceExtra,
      },
    },
    new Error('cloud_connection_degraded_escalated'),
  );
}

/**
 * Cloud connection recovered after a degraded period. Ledger + breadcrumb
 * ONLY — deliberately no Sentry capture (success telemetry; the degraded /
 * escalated events already mark the incident in the issue stream).
 * Fail-safe: must never throw on the reconciler hot path.
 */
export function recordCloudConnectionRecovered(
  context: CloudFailureCooldownRecoveryContext,
  instanceExtra: CloudInstanceObservabilityExtra,
): void {
  try {
    getErrorReporter().addBreadcrumb({
      category: 'cloud.connection',
      message: 'cloud_connection_recovered',
      level: 'info',
      data: {
        downtime_ms: context.downtimeMs,
        ticks_to_recovery: context.ticksToRecovery,
        lastCategory: context.lastCategory,
        lastWriter: context.lastWriter,
        ...instanceExtra,
      },
    });
  } catch (breadcrumbError) {
    log.warn({ err: breadcrumbError }, 'cloud_connection_recovered breadcrumb emit failed');
  }
  recordKnownConditionLedgerOnly('cloud_connection_recovered');
}
