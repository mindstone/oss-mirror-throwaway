/**
 * Timeout Diagnostics Service
 *
 * Runs lightweight parallel probes to classify the likely cause of a streaming
 * stall: Anthropic service issue, internet connectivity loss, or a transient
 * stall. Two callers today:
 *   - Post-timeout (`turnErrorRecovery.ts`): runs after a `MessageTimeoutError`
 *     fires to drive the user-facing error message.
 *   - Pre-timeout (`agentTurnExecute.ts`, FOX-3251): runs at watchdog Level 4
 *     (5 min silence) for Anthropic-routed turns to surface diagnostic-aware
 *     status copy 5 min before the abort, instead of after.
 *
 * Design: pure async function, no side effects, no state. Probes run with a
 * strict 2 s total budget so they don't noticeably delay the dispatched
 * status/error event.
 *
 * @see docs/plans/260408_timeout_diagnostics_and_messaging.md
 * @see docs-private/investigations/260522_fox-3251_transient_stall_no_auto_retry.md
 */

import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'timeout-diagnostics' });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TimeoutDiagnosticResult =
  | { kind: 'anthropic_issue'; indicator: string; description: string }
  | { kind: 'internet_unreachable' }
  | { kind: 'transient_stall' };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap for all probes combined. */
const TOTAL_BUDGET_MS = 2_000;

/** Per-probe timeout (must be < TOTAL_BUDGET_MS to leave headroom). */
const PROBE_TIMEOUT_MS = 1_500;

const ANTHROPIC_STATUS_URL = 'https://status.anthropic.com/api/v2/status.json';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/';

/**
 * Multi-host corroboration set for `isMachineOffline` (fail-fast-offline gate).
 *
 * A single-host probe (just `api.anthropic.com`) false-positives "offline" on
 * managed/corporate networks where Anthropic is domain-blocked / TLS-inspected
 * but the actual provider (OpenRouter, or an enterprise gateway to Vertex/Azure)
 * is reachable. Because `runWithRetry` is the shared retry seam across providers,
 * that would swallow a legitimate recoverable provider transient into the offline
 * terminal with no retry. So we corroborate across a small set of well-known
 * hosts — a provider host (`api.anthropic.com`), another provider host
 * (`openrouter.ai`), and a neutral host (`cloudflare.com`) — and only declare the
 * machine offline when EVERY host non-abort-fails. If ANY host returns a response
 * (any status) the machine is online; any abort/timeout is inconclusive → fail-open.
 *
 * Probed concurrently under one shared budget, so corroboration adds no latency.
 */
const OFFLINE_PROBE_HOSTS = [
  'https://api.anthropic.com/',
  'https://openrouter.ai/',
  'https://cloudflare.com/',
] as const;

// ---------------------------------------------------------------------------
// Internal probe helpers
// ---------------------------------------------------------------------------

interface AnthropicStatusResponse {
  status: {
    indicator: string; // 'none' | 'minor' | 'major' | 'critical'
    description: string;
  };
}

/**
 * Check the Anthropic public status page.
 * Returns `{ indicator, description }` when the API reports a non-`none` status,
 * or `null` when everything looks healthy.
 */
async function checkAnthropicStatus(
  signal: AbortSignal,
): Promise<{ indicator: string; description: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  // Forward external abort
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(ANTHROPIC_STATUS_URL, {
      method: 'GET',
      signal: controller.signal,
    });

    const body = (await res.json()) as AnthropicStatusResponse;

    if (
      !body ||
      typeof body !== 'object' ||
      !body.status ||
      typeof body.status.indicator !== 'string'
    ) {
      log.warn({ body }, 'Malformed Anthropic status response');
      return null;
    }

    const { indicator, description: rawDescription } = body.status;
    const description = typeof rawDescription === 'string' ? rawDescription : indicator;

    if (indicator !== 'none') {
      log.info({ indicator, description }, 'Anthropic reports non-healthy status');
      return { indicator, description };
    }

    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Lightweight connectivity probe — HEAD request to Anthropic's API endpoint.
 * Returns `true` when reachable, `false` otherwise.
 *
 * Uses api.anthropic.com (not google.com) to avoid false negatives behind
 * corporate proxies / VPNs / GFW that may block Google but allow Anthropic.
 * This mirrors the pattern in `src/main/services/health/checks/network.ts`.
 */
async function checkInternetConnectivity(signal: AbortSignal): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    await fetch(ANTHROPIC_API_URL, {
      method: 'HEAD',
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** Per-host reachability outcome for the multi-host offline probe. */
type HostProbeOutcome = 'reachable' | 'unreachable' | 'inconclusive';

/**
 * Reachability-only offline check for the fail-fast-offline retry gate
 * (260618_arthur-offline-resilience Stage 2). Probes a SMALL set of well-known
 * hosts (`OFFLINE_PROBE_HOSTS`) concurrently via HEAD — deliberately NOT the
 * Anthropic *status* check, because an Anthropic incident says nothing about an
 * OpenRouter (or any non-Anthropic) turn's reachability.
 *
 * **Multi-host corroboration (F1 fix):** a single-host probe false-positives
 * "offline" when one provider's host is domain-blocked / TLS-inspected on a
 * managed/corporate network but the real provider is reachable. So the machine is
 * declared offline ONLY when EVERY host non-abort-fails. If ANY host returns a
 * response (any status) → online; any abort/timeout host is inconclusive → online
 * (fail-open). Genuinely-offline (all hosts down, e.g. a fully-offline user) still returns true.
 *
 * Contract (load-bearing — `runWithRetry`'s gate relies on every clause):
 *  - **Abort-aware:** honors the passed `signal` so a cancelled turn cancels every probe.
 *  - **Bounded:** all hosts run in parallel under one shared `budgetMs` (default 1.5 s).
 *  - **Never throws, fail-OPEN:** any error / timeout / inconclusive / mixed result
 *    returns `false` ("treat as online"). Only ALL-hosts-non-abort-fail returns `true`.
 *    This is the regression guard: only a CONFIRMED-offline probe (`true`) is allowed
 *    to suppress a legitimate transient retry.
 *
 * @param signal    Optional external AbortSignal (e.g. the turn's cancellation token).
 * @param budgetMs  Shared hard cap for all host probes (default 1.5 s).
 * @returns `true` only when EVERY corroboration host is confirmed unreachable; `false` otherwise.
 *
 * @see docs/plans/260618_arthur-offline-resilience/PLAN.md (Stage 2)
 */
export async function isMachineOffline(
  signal?: AbortSignal,
  budgetMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  // Already aborted → don't probe; fail-open (treat as online) so the caller's
  // own abort handling stays in charge rather than this gate forcing a terminal.
  if (signal?.aborted) {
    return false;
  }

  const controller = new AbortController();
  // Distinguish "our budget timer fired" (→ inconclusive, fail-open) from a real
  // instant network failure. We run HEADs directly and discriminate by error type.
  // This is load-bearing for fail-OPEN: a timed-out or aborted probe must NEVER
  // classify the machine offline.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, budgetMs);
  const onAbort = () => controller.abort();
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const probeHost = async (url: string): Promise<HostProbeOutcome> => {
    try {
      await fetch(url, { method: 'HEAD', signal: controller.signal });
      // Any HTTP response (incl. 4xx/5xx) proves the network reached the host.
      return 'reachable';
    } catch (error) {
      // Abort (our budget timer OR the external signal) = INCONCLUSIVE → fail-open.
      // Only a non-abort throw (DNS/connect failure, e.g. ENOTFOUND/ECONNREFUSED,
      // which resolve instantly when offline) is treated as host-unreachable.
      if (timedOut || controller.signal.aborted || isAbortError(error)) {
        return 'inconclusive';
      }
      return 'unreachable';
    }
  };

  // `offline` is computed (with observable logging) and returned AFTER the finally
  // so this fail-OPEN result isn't a bare return-sentinel-in-catch
  // (rebel-silent-swallow): the decision branch logs its reason.
  let offline = false;
  try {
    const outcomes = await Promise.all(OFFLINE_PROBE_HOSTS.map(probeHost));
    // Offline ONLY if every host non-abort-failed. Any 'reachable' → online;
    // any 'inconclusive' (abort/timeout) → online (fail-open).
    offline = outcomes.length > 0 && outcomes.every((o) => o === 'unreachable');
    if (offline) {
      log.warn(
        { hosts: OFFLINE_PROBE_HOSTS.length },
        'Reachability probe failed for ALL corroboration hosts (non-abort) — machine appears offline (fail-fast gate)',
      );
    } else {
      log.info(
        { outcomes },
        'isMachineOffline: at least one host reachable or inconclusive — failing open (treat as online)',
      );
    }
  } finally {
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
  }
  return offline;
}

/** True when the thrown value is an AbortError (DOMException name or .name). */
function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError'))
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Diagnose the likely cause of a message timeout.
 *
 * Runs two parallel probes (Anthropic status page + API connectivity) with a
 * strict 2 s total budget.
 *
 * Classification priority (highest → lowest):
 *   1. `internet_unreachable` — connectivity probe failed
 *   2. `anthropic_issue`     — Anthropic status page reports degradation
 *   3. `transient_stall`     — everything looks fine; likely a transient API stall
 *
 * @param signal  Optional external AbortSignal (e.g. from the turn's cancellation token).
 */
export async function diagnoseTimeout(
  signal?: AbortSignal,
): Promise<TimeoutDiagnosticResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOTAL_BUDGET_MS);

  // Forward external abort into our controller
  const onAbort = () => controller.abort();
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const [anthropicResult, connectivityResult] = await Promise.allSettled([
      checkAnthropicStatus(controller.signal),
      checkInternetConnectivity(controller.signal),
    ]);

    const internetOk =
      connectivityResult.status === 'fulfilled' && connectivityResult.value === true;

    const anthropicIssue =
      anthropicResult.status === 'fulfilled' && anthropicResult.value !== null
        ? anthropicResult.value
        : null;

    // 1. If internet is unreachable, that's the primary issue
    if (!internetOk) {
      log.warn('Internet connectivity probe failed — classifying as internet_unreachable');
      return { kind: 'internet_unreachable' };
    }

    // 2. If Anthropic reports issues, surface that
    if (anthropicIssue) {
      log.info(
        { indicator: anthropicIssue.indicator, description: anthropicIssue.description },
        'Anthropic status page reports issue — classifying as anthropic_issue',
      );
      return {
        kind: 'anthropic_issue',
        indicator: anthropicIssue.indicator,
        description: anthropicIssue.description,
      };
    }

    // 3. Everything looks fine — transient stall
    log.info('Both probes healthy — classifying as transient_stall');
    return { kind: 'transient_stall' };
  } catch (error) {
    // Unexpected error in the diagnostics pipeline itself
    log.error({ err: error }, 'Unexpected error during timeout diagnostics — defaulting to transient_stall');
    return { kind: 'transient_stall' };
  } finally {
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
