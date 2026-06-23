/**
 * Centralised restart-safety gate for `turnErrorRecovery.ts`.
 *
 * Stage 4 of `docs/plans/260526_hotspot-refactor-roadmap/PLAN.md` (Hotspot 2).
 *
 * Collapses the 7+ duplicated `messageCount === 0` / `messageCount > 0`
 * gates that were inlined across the recovery handlers (alt-model fast
 * retry, alt-model Claude fallback, server-error retry, codex rate-limit
 * fallback, post-fallback server-error retry, transient retry, output-cap
 * retry, long-context fallback) plus the existing configured-role fallback
 * predicate (formerly `canAttemptConfiguredFallback`) into one helper
 * driven by a discriminated `source` union.
 *
 * The configured-role fallback historically applied the strictest set of
 * checks (aborted, messageCount, receivedResultMessage, isToolInFlight,
 * lastToolName) with a narrow rate-limit messageCount bypass. Other gate
 * sites historically only checked `messageCount` (and sometimes `aborted`).
 * The discriminated `source` records that variance explicitly so adding a
 * new restart-safety signal is a single-place change and the existing
 * call-site semantics are preserved verbatim.
 *
 * Postmortem context (260427 outer-retry-guard) is the structural reason
 * the rate-limit `messageCount` bypass refuses to fire when a nested
 * `runAgentQuery` has already executed: nested runs only forward
 * `onApiOutput` (bumps `messageCount`) but do NOT propagate
 * `lastToolName` / `receivedResultMessage` / the watchdog tool tracker,
 * so the outer ctx's hard gates would be stale.
 */

import type { ErrorRecoveryContext } from './types';

/**
 * Discriminated union of every restart-safety decision point.
 *
 * Each variant maps to one historical gate site in the recovery dispatcher
 * (see file-level comment for the audit). Variants encode their source-
 * specific options (e.g. the rate-limit messageCount bypass on the
 * configured-fallback variant).
 */
export type RestartSafetyGateSource =
  | {
      kind: 'configured-fallback';
      /**
       * Which dispatcher path is invoking the configured-role fallback.
       * `rate-limit` opts into the messageCount bypass when no nested
       * fallback `runAgentQuery` has run earlier in this outer turn.
       */
      via: 'model-unavailable' | 'alt-model-fallback' | 'server-error-retry' | 'rate-limit';
    }
  | { kind: 'alt-model-fast-retry' }
  | { kind: 'alt-model-claude-fallback' }
  | { kind: 'server-error-retry' }
  | { kind: 'codex-rate-limit-fallback' }
  | { kind: 'multi-provider-rate-limit-fallback' }
  | { kind: 'multi-provider-server-error-fallback' }
  | { kind: 'post-fallback-server-error-retry' }
  | { kind: 'transient-retry' }
  | { kind: 'output-cap-retry' }
  | { kind: 'long-context-fallback' };

export type RestartSafetyGateResult = { ok: true } | { ok: false; reason: string };

/**
 * Per-source check matrix. Sources that historically only checked
 * `messageCount` keep the harder gates off; the configured-fallback path
 * keeps the full set; output-cap-retry / long-context-fallback keep
 * messageCount + aborted (matching their original inline checks).
 */
interface SafetyChecks {
  aborted: boolean;
  messageCount: boolean;
  /**
   * When true, the messageCount check is skipped. Currently only enabled
   * for the `configured-fallback` variant with `via: 'rate-limit'` AND
   * `!nestedFallbackQueryAttempted` — the post-260427 fail-closed guard.
   */
  bypassMessageCount: boolean;
  receivedResultMessage: boolean;
  isToolInFlight: boolean;
  lastToolName: boolean;
}

function checksFor(
  ctx: Pick<ErrorRecoveryContext, 'nestedFallbackQueryAttempted'>,
  source: RestartSafetyGateSource,
): SafetyChecks {
  switch (source.kind) {
    case 'configured-fallback': {
      const isRateLimit = source.via === 'rate-limit';
      return {
        aborted: true,
        messageCount: true,
        bypassMessageCount: isRateLimit && !ctx.nestedFallbackQueryAttempted,
        receivedResultMessage: true,
        isToolInFlight: true,
        lastToolName: true,
      };
    }
    case 'output-cap-retry':
    case 'long-context-fallback':
      return {
        aborted: true,
        messageCount: true,
        bypassMessageCount: false,
        receivedResultMessage: false,
        isToolInFlight: false,
        lastToolName: false,
      };
    case 'alt-model-fast-retry':
    case 'alt-model-claude-fallback':
    case 'server-error-retry':
    case 'post-fallback-server-error-retry':
    case 'transient-retry':
    case 'codex-rate-limit-fallback':
    case 'multi-provider-rate-limit-fallback':
    case 'multi-provider-server-error-fallback':
      // Same safety matrix as codex-rate-limit-fallback: no-abort check
      // (a transparent retry must not block when the turn hasn't streamed yet),
      // messageCount check (partial output → no restart).
      return {
        aborted: false,
        messageCount: true,
        bypassMessageCount: false,
        receivedResultMessage: false,
        isToolInFlight: false,
        lastToolName: false,
      };
    default: {
      const exhaustive: never = source;
      void exhaustive;
      return {
        aborted: true,
        messageCount: true,
        bypassMessageCount: false,
        receivedResultMessage: true,
        isToolInFlight: true,
        lastToolName: true,
      };
    }
  }
}

/**
 * Decide whether a recovery handler may attempt a restart / retry / fallback.
 *
 * Returns `{ ok: true }` when the source-specific checks all pass, else
 * `{ ok: false; reason }` with a stable reason string suitable for use in
 * `passthrough(...)` outcomes and structured log fields.
 */
export function restartSafetyGate(
  ctx: Pick<
    ErrorRecoveryContext,
    | 'abortController'
    | 'messageCount'
    | 'receivedResultMessage'
    | 'lastToolName'
    | 'isToolInFlight'
    | 'nestedFallbackQueryAttempted'
  >,
  source: RestartSafetyGateSource,
): RestartSafetyGateResult {
  const checks = checksFor(ctx, source);

  if (checks.aborted && ctx.abortController.signal.aborted) {
    return { ok: false, reason: 'aborted' };
  }
  if (checks.messageCount && !checks.bypassMessageCount && ctx.messageCount > 0) {
    return { ok: false, reason: 'message-count' };
  }
  if (checks.receivedResultMessage && ctx.receivedResultMessage) {
    return { ok: false, reason: 'result-received' };
  }
  if (checks.isToolInFlight && ctx.isToolInFlight?.()) {
    return { ok: false, reason: 'tool-or-subagent-in-flight' };
  }
  if (checks.lastToolName && ctx.lastToolName) {
    return { ok: false, reason: 'known-tool-activity' };
  }
  return { ok: true };
}
