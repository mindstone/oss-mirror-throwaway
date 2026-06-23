/**
 * Shared fail-fast-offline gate for client retry loops
 * (260618_arthur-offline-resilience Stage 2 + refinement).
 *
 * Single implementation consumed by BOTH `AnthropicClient.runWithRetry` and
 * `OpenAIClient.runWithRetry` (the two structurally-identical retry seams). When
 * a transient error is about to be retried, the caller consults this — at most
 * ONCE per `runWithRetry` invocation (the caller caches the verdict in a loop
 * local) — and if the machine is CONFIRMED offline, throws the
 * `offlineFailFast`-marked error instead of churning. `turnErrorRecovery`'s
 * `handleOfflineFailFast` keys on the structural `details.offlineFailFast` marker
 * (no string match), so no recovery-layer change is needed per client.
 *
 * @see docs/plans/260618_arthur-offline-resilience/PLAN.md (Stage 2)
 */
import { createScopedLogger } from '@core/logger';
import { isMachineOffline } from '@core/services/timeoutDiagnosticsService';
import { ModelError } from '../modelErrors';

const log = createScopedLogger({ service: 'offlineFailFast' });

/**
 * Budget for the fail-fast-offline reachability probe consulted at the
 * retry-decision boundary. ≤1.5 s so an offline turn ends in seconds instead of
 * churning through stacked retries and dangling to the multi-minute watchdog
 * ceilings.
 */
export const OFFLINE_PROBE_BUDGET_MS = 1_500;

/**
 * Honest, calm copy for the fail-fast-offline terminal. Surfaced as the existing
 * retryable `message_timeout` "Try again" card (see
 * `turnErrorRecovery.handleOfflineFailFast`). Recovery may override copy but uses
 * this as the default for the offline case.
 */
export const OFFLINE_FAIL_FAST_MESSAGE =
  "You appear to be offline. Your work is saved. Try again when you're back.";

/**
 * Kill-switch for the fail-fast-offline retry gate. Default ON; set
 * `REBEL_OFFLINE_FAILFAST=0` to disable so a false-offline (e.g. a strange
 * network where every probe host is blocked but the provider is reachable) can
 * never brick the turn — retries then behave exactly as before this change.
 * Mirrors the `REBEL_DNS_DECOUPLE=0` kill-switch pattern.
 *
 * Cross-surface safe: tolerates a missing/undefined `process` (`@core` runs on
 * mobile/cloud) — absence of the var means "enabled" (the default), never a throw.
 */
export function isOfflineFailFastEnabled(): boolean {
  try {
    return typeof process === 'undefined' || process.env?.REBEL_OFFLINE_FAILFAST !== '0';
  } catch {
    // Any environment-shim weirdness must not break the retry path — default ON.
    return true;
  }
}

/**
 * Build the fail-fast-offline terminal error from the classified transient error.
 *
 * Deliberately NOT a catch-block clobber: the kind stays `server_error` (so the
 * error remains transient/retryable end-to-end) and the original raw message /
 * upstreamProvider are preserved — we only ATTACH the `offlineFailFast` marker
 * that `turnErrorRecovery.handleOfflineFailFast` keys on (structural, not a string
 * match) to route to the honest message_timeout offline terminal.
 */
export function buildOfflineFailFastError(base: ModelError, provider: string): ModelError {
  return new ModelError(
    'server_error',
    OFFLINE_FAIL_FAST_MESSAGE,
    base.status,
    provider,
    {
      rawMessage: base.__rawMessage,
      ...(base.upstreamProvider ? { upstreamProvider: base.upstreamProvider } : {}),
      details: { ...(base.details ?? {}), offlineFailFast: true },
    },
  );
}

/**
 * Probe reachability at most once per `runWithRetry` invocation.
 *
 * The caller threads a loop-local `cachedVerdict` (`undefined` = not yet probed)
 * so N retries never trigger N probes. Returns the (possibly newly-computed)
 * boolean verdict; the caller writes it back to its local.
 *
 * Defensive fail-OPEN at this call site (F2): `isMachineOffline` already promises
 * never to throw, but this is the high-blast-radius shared seam — any throw here
 * (future probe regression, env shim, logging path) must NOT break a legitimate
 * retry, so it is caught and treated as online (`false`).
 */
export async function probeOfflineOnce(
  signal: AbortSignal | undefined,
  cachedVerdict: boolean | undefined,
): Promise<boolean> {
  if (cachedVerdict !== undefined) {
    return cachedVerdict;
  }
  // Computed inside the try/catch and returned AFTER it (not a bare
  // return-sentinel-in-catch) so the fail-open swallow stays observable
  // (rebel-silent-swallow): the catch logs its reason before defaulting to online.
  let verdict = false;
  try {
    verdict = await isMachineOffline(signal, OFFLINE_PROBE_BUDGET_MS);
  } catch (error) {
    log.warn({ err: error }, 'isMachineOffline threw unexpectedly — failing open (treat as online)');
    verdict = false;
  }
  return verdict;
}
