/**
 * Terminal-route-decision observability (cross-surface).
 *
 * Background: a `mindstone` (managed-subscription) turn executed on cloud/mobile
 * terminalises `missing-mindstone-credentials` *pre-dispatch* — the turn never
 * runs, never calls a model, and resolves with no assistant response. For ~27
 * days this failure was telemetry-silent: the ONLY signal was the misleading
 * "subscription isn't ready" string in the transcript that synced back to
 * desktop. There was no log, no Sentry event, nothing the fleet could page on.
 * See docs-private/postmortems/260623_mobile_managed_subscription_cloud_parity_silent_noresponse_postmortem.md
 * (Pathologist rec #1) and docs/plans/260622_mobile-record-recreated-session/PLAN.md.
 *
 * This module emits, for a RECOVERABLE terminal route decision (a `missing-*` /
 * `codex-unsupported-model` reason — the turn is rejected before dispatch but the
 * user could in principle recover):
 *   1. a distinct, greppable structured log (`Turn terminal route decision`), and
 *   2. a THROTTLED, level:'warning' Sentry capture (NOT a per-turn flood) tagged
 *      with `surface` / `activeProvider` / `credentialSource` / `invalidReason` /
 *      `wireModel` — so a fleet/dashboard monitor can split + alert on a sustained
 *      rate (mirroring the safety-eval Check-H `reasonKind` degradation pattern in
 *      `safetyPromptLogic.ts`).
 *
 * No tokens/keys/secrets are emitted: `credentialSource` is a categorical enum
 * (e.g. `missing-mindstone`), `wireModel` is a model id, never a credential.
 *
 * The throttle mirrors `recordSafetyEvalFailed` in `safetyPromptLogic.ts`:
 * a single fingerprint-keyed wire-emission gate (`failureFireDedup`) so a
 * sustained outage doesn't burn Sentry quota, with no recovery state machine.
 */
import { getErrorReporter } from '@core/errorReporter';
import { getPlatformConfig } from '@core/platform';
import {
  isTerminalDecision,
  isRecoverableTerminalReason,
  type ProviderRouteDecision,
} from '@core/rebelCore/providerRouteDecision';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

/** Greppable log message + Sentry fingerprint root. */
export const TERMINAL_ROUTE_DECISION_LOG = 'Turn terminal route decision';

// Sentry server-side fingerprint grouping handles UI-level dedup, but every
// captureMessage still consumes quota. This Map gates wire-level emission: at
// most one event per fingerprint-tuple per window. Mirrors the safety-eval
// `failureFireDedup` throttle (no recovery tracking; cardinality bounded by the
// fingerprint shape: surface × activeProvider × invalidReason × credentialSource).
const TERMINAL_ROUTE_FIRE_THROTTLE_MS = 60_000;
const terminalRouteFireDedup = new Map<string, number>();

/** Minimal structured logger surface (a per-turn scoped pino logger). */
export interface TerminalRouteLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

export type TerminalRouteTelemetryFields = {
  surface: string;
  activeProvider: string;
  credentialSource: string;
  invalidReason: string;
  wireModel: string;
};

/**
 * Extract the categorical, secret-free telemetry fields for a terminal route
 * decision. Exported for the unit test (asserts no secrets / right fields).
 */
export function terminalRouteTelemetryFields(
  decision: ProviderRouteDecision,
  activeProvider: string | undefined,
): TerminalRouteTelemetryFields {
  return {
    surface: getPlatformConfig().surface,
    activeProvider: activeProvider ?? 'anthropic',
    credentialSource: decision.credentialSource,
    invalidReason: decision.invalidReason,
    wireModel: decision.wireModelId,
  };
}

/**
 * Emit the terminal-route observability signal IFF the decision is a recoverable
 * terminal one (a `missing-*` / `codex-unsupported-model` reason that blocks the
 * turn pre-dispatch). Dispatchable decisions and non-recoverable terminals (e.g.
 * the internal `proxy-dialect-in-direct-anthropic` invariant breach, which has
 * its own `captureRouteInvariantBreach` path) are no-ops here.
 *
 * Fail-safe: never throws — telemetry must not break turn execution.
 */
export function recordTerminalRouteDecision(args: {
  decision: ProviderRouteDecision;
  activeProvider: string | undefined;
  logger: TerminalRouteLogger;
}): void {
  const { decision, activeProvider, logger } = args;
  if (!isTerminalDecision(decision)) return;
  if (!isRecoverableTerminalReason(decision.invalidReason)) return;

  let fields: TerminalRouteTelemetryFields;
  try {
    fields = terminalRouteTelemetryFields(decision, activeProvider);
  } catch (error) {
    // getPlatformConfig() throws if not initialised (e.g. unit tests that don't
    // bootstrap). Telemetry must never break the turn — bail.
    ignoreBestEffortCleanup(error, {
      operation: 'terminal-route-telemetry/resolve-fields',
      reason: 'platform-config-or-decision-read-failed; telemetry is best-effort',
      severity: 'debug',
    });
    return;
  }

  // (1) Distinct, greppable structured log — fires on EVERY terminal decision
  // (no throttle) so per-turn forensics stay intact in the log files.
  try {
    logger.warn(fields, TERMINAL_ROUTE_DECISION_LOG);
  } catch (error) {
    // Logging must never block the Sentry signal.
    ignoreBestEffortCleanup(error, {
      operation: 'terminal-route-telemetry/log',
      reason: 'turn logger threw; telemetry is best-effort',
      severity: 'debug',
    });
  }

  // (2) Thresholded Sentry signal — fingerprint-keyed throttle so a sustained
  // degradation surfaces a STABLE issue + tag the dashboard can rate-alert on,
  // not a per-turn flood.
  try {
    const fingerprint = [
      'terminal-route-decision',
      fields.surface,
      fields.activeProvider,
      fields.invalidReason,
      fields.credentialSource,
    ];
    const dedupKey = fingerprint.join('::');
    const now = Date.now();
    const lastFireMs = terminalRouteFireDedup.get(dedupKey);
    if (lastFireMs !== undefined && now - lastFireMs < TERMINAL_ROUTE_FIRE_THROTTLE_MS) {
      return;
    }
    terminalRouteFireDedup.set(dedupKey, now);
    getErrorReporter().captureMessage(TERMINAL_ROUTE_DECISION_LOG, {
      level: 'warning',
      fingerprint,
      tags: {
        // Categorical, secret-free dimensions. A fleet monitor (cf. the
        // safety-eval Check-H `reasonKind` degradation alert) can split on
        // `surface` + `invalidReason` and page on a sustained rate — e.g. a
        // `surface:cloud` × `invalidReason:missing-mindstone-credentials` surge
        // is exactly the cross-surface managed-key gap that went silent here.
        surface: fields.surface,
        activeProvider: fields.activeProvider,
        credentialSource: fields.credentialSource,
        invalidReason: fields.invalidReason,
        wireModel: fields.wireModel,
        nonCritical: true,
      },
    });
  } catch (error) {
    // captureMessage failures must never break turn execution.
    ignoreBestEffortCleanup(error, {
      operation: 'terminal-route-telemetry/capture',
      reason: 'error reporter threw; telemetry is best-effort',
      severity: 'debug',
    });
  }
}

/** Test-only: reset the wire-emission throttle between cases. */
export function __resetTerminalRouteTelemetryForTesting(): void {
  terminalRouteFireDedup.clear();
}
