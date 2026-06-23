/**
 * Provider-failover telemetry payload builder
 * (docs/plans/260621_paid-fallback-indicator/).
 *
 * Builds the PII-safe, categorical-only analytics payload for the
 * `Provider Failover Observed` event, emitted once a transparent multi-provider
 * failover succeeds on a fallback provider — whether the switch was triggered by a
 * 429 (Stage 4b rate-limit chain) or a server/transient 5xx (Stage 3
 * provider-agnostic recovery "C"). Pulled out as a pure function so the payload
 * contract is unit-testable without standing up the full `executeAgentTurn`
 * integration harness.
 *
 * PII-safety: every field here is a closed category (credential source, billing
 * source, a fixed reason literal) or a small integer hop count — NO keys, tokens,
 * model strings, prompts, or user content.
 */
import type { BillingSource } from '@shared/utils/billingSource';
import type { ProviderCredentialSource } from '@shared/types/providerRoute';

/** Analytics event name for the paid-fallback class. */
export const PROVIDER_FAILOVER_EVENT = 'Provider Failover Observed';

/**
 * Why the failover episode was triggered.
 * - `rate-limit-failover` — a 429 on the prior credential (Stage 4b).
 * - `server-error-failover` — a server/transient (5xx / alt-model-owned) error
 *   on the prior credential (Stage 3, provider-agnostic recovery "C").
 * - `mixed-rate-limit-and-server-error` — a single logical turn that saw BOTH a
 *   429 hop AND a server/transient hop (mixed episode). Keeps the analytics stream
 *   honest instead of collapsing the episode to a dominant class. The user-facing
 *   billing indicator is reason-independent (driven by the per-record billingSource),
 *   so this value affects analytics fidelity only.
 */
export type ProviderFailoverReason =
  | 'rate-limit-failover'
  | 'server-error-failover'
  | 'mixed-rate-limit-and-server-error';

/**
 * Derive the failover `reason` from which attempted-credential class(es) drove the
 * switch this logical turn. Shared by the patch-back telemetry emit and the
 * success-log so both surfaces report the SAME reason.
 *
 * IMPORTANT (byte-identical 429 path): a pure 429 episode
 * (`serverTransientCount === 0`) returns `'rate-limit-failover'` exactly as before
 * Stage 3 — the new values only appear once a server/transient hop occurs.
 */
export function deriveProviderFailoverReason(args: {
  rateLimitCount: number;
  serverTransientCount: number;
}): ProviderFailoverReason {
  const hasRateLimit = args.rateLimitCount > 0;
  const hasServerTransient = args.serverTransientCount > 0;
  if (hasRateLimit && hasServerTransient) return 'mixed-rate-limit-and-server-error';
  if (hasServerTransient) return 'server-error-failover';
  return 'rate-limit-failover';
}

export interface ProviderFailoverTelemetryInput {
  /** Credential sources marked attempted before this hop resolved (in order). */
  attemptedCredentialSources: readonly ProviderCredentialSource[] | undefined;
  /** The credential source THIS hop resolved to (may itself fail on a later hop). */
  resolvedCredentialSource: ProviderCredentialSource;
  /** "Who pays" axis of the resolved route (null when no billing identity). */
  resolvedBillingSource: BillingSource | null;
  /** Why the failover episode was triggered. Defaults to 'rate-limit-failover'. */
  reason?: ProviderFailoverReason;
}

export interface ProviderFailoverTelemetryPayload {
  /**
   * EPISODE-ORIGIN semantics: the FIRST credential that failed (429 or server/
   * transient) in this failover episode (`attemptedCredentialSources[0]`), NOT the
   * immediate prior hop. With one event per hop, every hop's event shares the same
   * `from` (the credential that kicked off the episode); the per-hop destination is `to`.
   */
  from: string;
  /** The credential THIS hop resolved to (the per-hop destination). */
  to: ProviderCredentialSource;
  billingSource: BillingSource | null;
  reason: ProviderFailoverReason;
  hopCount: number;
}

export function buildProviderFailoverTelemetry(
  input: ProviderFailoverTelemetryInput,
): ProviderFailoverTelemetryPayload {
  return {
    // Episode origin (first failed credential), not the immediate prior hop — see
    // the field doc on ProviderFailoverTelemetryPayload.from.
    from: input.attemptedCredentialSources?.[0] ?? 'unknown',
    to: input.resolvedCredentialSource,
    billingSource: input.resolvedBillingSource,
    reason: input.reason ?? 'rate-limit-failover',
    hopCount: input.attemptedCredentialSources?.length ?? 0,
  };
}
