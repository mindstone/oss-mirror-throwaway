/**
 * Provider reachability telemetry — registry-owned Sentry captures + ledger for
 * the all-providers-unreachable verdict transition family
 * (all_providers_unreachable / providers_reachability_recovered).
 *
 * Workstream β / M2 of docs/plans/260621_monitoring-active-detection/PLAN.md.
 * Mirrors the edge-emission pattern in cloudConnectionTelemetry.ts.
 *
 * Fail-safe contract: these helpers must never throw — they run on the
 * recovery-pipeline exhaustion hot path (fire-and-forget).
 */

import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import {
  captureKnownCondition,
  recordKnownConditionLedgerOnly,
} from '@core/sentry/captureKnownCondition';
import type { ProviderId, ProbeErrorCode } from '@shared/diagnostics/providerReachabilitySnapshot';
import type { ReachabilityAssessment } from './providerReachabilitySnapshot';
import {
  detectAllProvidersUnreachable,
  getProviderReachabilitySnapshot,
  refreshProviderReachabilityCache,
} from './providerReachabilitySnapshot';

export const MIN_EMIT_INTERVAL_MS = 5 * 60_000;

let log: ReturnType<typeof createScopedLogger> | null = null;

function getLog(): ReturnType<typeof createScopedLogger> {
  if (!log) {
    log = createScopedLogger({ service: 'providerReachabilityTelemetry' });
  }
  return log;
}

// Episode-based latch (fixes the suppressed-forever bug, GPT review F1): track whether we're
// CURRENTLY in an all-unreachable episode and whether we've already emitted its warning — distinct
// from "last observed verdict". A warning suppressed by the min-interval leaves the episode
// "not yet emitted", so a later evaluation (once the interval elapses, while still all-down) still
// emits; and "recovered" only fires for an episode whose warning actually fired (no phantom recovery).
let inAllUnreachableEpisode = false;
let episodeWarningEmitted = false;
let lastWarningEmitAt = 0;
// In-flight coalescing (GPT review F2): N concurrent recovery exhaustions during one outage collapse
// to a single probe wave instead of 6×N HEAD probes (the snapshot cache is only TTL-aware AFTER it
// has been populated, so a cold/stale cache under a burst would otherwise launch N independent waves).
let inFlightEval: Promise<void> | null = null;

function stringifyErrorCodes(
  errorCodes: Partial<Record<ProviderId, ProbeErrorCode>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errorCodes).map(([provider, code]) => [provider, code ?? 'unknown']),
  );
}

// Kinds where reachability is NOT the question — skip the probe wave entirely (the verdict gate is
// the correctness backstop, so a loose skip only affects cost, never correctness; GPT review F3).
const NON_REACHABILITY_ERROR_KINDS = new Set<string>([
  'aborted',
  'rate_limit',
  'billing',
  'billing_quota',
  'auth',
  'moderation',
  'invalid_request',
  'unsupported_model',
  'routing',
  'summary_generation_failed',
]);

function shouldSkipReachabilityEvaluation(errorKind?: string): boolean {
  if (!errorKind) {
    return false;
  }
  if (NON_REACHABILITY_ERROR_KINDS.has(errorKind)) {
    return true;
  }
  // Context-overflow family (e.g. context_overflow, long_context_*) is never a reachability signal.
  if (errorKind.includes('context')) {
    return true;
  }
  return false;
}

/**
 * Resets module-level latch state for unit tests.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention -- double-underscore convention denotes test-only escape hatch
export function __resetReachabilityTelemetryForTest(): void {
  inAllUnreachableEpisode = false;
  episodeWarningEmitted = false;
  lastWarningEmitAt = 0;
  inFlightEval = null;
}

/**
 * Records a reachability verdict and emits edge-triggered telemetry when
 * appropriate. Synchronous and testable; must never throw.
 */
export function recordReachabilityVerdict(assessment: ReachabilityAssessment): void {
  try {
    const { verdict } = assessment;

    // No new evidence — leave episode state untouched (a stale/empty snapshot must never read as a
    // confident recovery or a fresh outage).
    if (verdict === 'inconclusive') {
      return;
    }

    if (verdict === 'all_unreachable') {
      // Enter (or stay in) the episode. `episodeWarningEmitted` is keyed to the EPISODE, not the
      // observation, so a min-interval-suppressed first observation stays "not yet emitted" and a
      // later observation (still all-down, interval elapsed) emits — fixes the suppressed-forever bug.
      if (!inAllUnreachableEpisode) {
        inAllUnreachableEpisode = true;
        episodeWarningEmitted = false;
      }
      if (!episodeWarningEmitted && Date.now() - lastWarningEmitAt >= MIN_EMIT_INTERVAL_MS) {
        captureKnownCondition(
          'all_providers_unreachable',
          {
            extra: {
              providerCount: assessment.consideredProviders.length,
              unreachableProviders: [...assessment.unreachableProviders],
              consideredProviders: [...assessment.consideredProviders],
              errorCodes: stringifyErrorCodes(assessment.errorCodes),
            },
          },
          new Error('all_providers_unreachable'),
        );
        episodeWarningEmitted = true;
        lastWarningEmitAt = Date.now();
      }
      return;
    }

    // Definite non-all verdict (none/partially unreachable): the episode (if any) has ended. Emit
    // "recovered" ONLY when this episode actually emitted a warning — otherwise a min-interval-
    // suppressed episode would mint a phantom recovery for a warning that never fired.
    if (inAllUnreachableEpisode && episodeWarningEmitted) {
      try {
        getErrorReporter().addBreadcrumb({
          category: 'provider.reachability',
          message: 'providers_reachability_recovered',
          level: 'info',
          data: {
            verdict,
            consideredProviders: [...assessment.consideredProviders],
            unreachableProviders: [...assessment.unreachableProviders],
            lastRefreshAt: assessment.lastRefreshAt,
          },
        });
      } catch (breadcrumbError) {
        getLog().warn(
          { err: breadcrumbError },
          'providers_reachability_recovered breadcrumb emit failed',
        );
      }
      recordKnownConditionLedgerOnly('providers_reachability_recovered');
    }

    inAllUnreachableEpisode = false;
    episodeWarningEmitted = false;
  } catch (err) {
    getLog().warn({ err }, 'recordReachabilityVerdict failed');
  }
}

/**
 * Cache-first reachability evaluation triggered from recovery exhaustion.
 * Fail-open: never blocks or throws the terminal path.
 */
export async function evaluateAndRecordReachability(errorKind?: string): Promise<void> {
  try {
    if (shouldSkipReachabilityEvaluation(errorKind)) {
      return;
    }

    // Coalesce concurrent calls (F2): if a probe wave is already running, await it and return rather
    // than launching another 6-probe wave. The wave records the verdict itself, so coalesced callers
    // need do nothing further.
    if (inFlightEval) {
      await inFlightEval;
      return;
    }

    const wave = (async () => {
      await refreshProviderReachabilityCache();
      recordReachabilityVerdict(detectAllProvidersUnreachable(getProviderReachabilitySnapshot()));
    })().catch((err) => {
      // Swallow inside the wave so coalesced awaiters never see a rejection; observable, not silent.
      getLog().warn({ err, errorKind }, 'evaluateAndRecordReachability wave failed');
    });
    inFlightEval = wave;
    try {
      await wave;
    } finally {
      if (inFlightEval === wave) {
        inFlightEval = null;
      }
    }
  } catch (err) {
    getLog().warn({ err, errorKind }, 'evaluateAndRecordReachability failed');
  }
}
