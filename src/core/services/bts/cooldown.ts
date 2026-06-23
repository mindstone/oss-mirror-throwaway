/**
 * Centralised BTS cooldown discipline (Stage 10 — PLAN.md Hotspot 3, Researcher F3).
 *
 * Closes the cooldown regression class (PMs 260429 callWithModelAuthAware bypass,
 * 260428 compaction misclassification, 260502 safety-eval parity, 260422
 * concurrency) by moving cooldown *recording* out of the per-transport adapter
 * bodies and into the dispatch layer, so every transport is covered **by
 * construction** rather than by each adapter remembering to call the recorder.
 *
 * Division of responsibility (Arbitrator guidance, assessment #3):
 *   - **Provider-specific parsing stays in the adapter.** Each adapter knows how
 *     to read its own `retry-after` (fetch header vs. Anthropic SDK error
 *     headers) and how to classify a 4xx into a `ModelError`. That transport
 *     knowledge does NOT move.
 *   - **The actual `cooldown.record*` call lives at dispatch.** Adapters surface a
 *     typed {@link BtsCooldownSignal} instead of recording themselves:
 *       - on a classified rate-limit 4xx the adapter attaches the parsed
 *         `retryAfterMs` to the thrown `ModelError` via {@link attachCooldownRateLimitSignal};
 *       - on success the adapter simply returns its parsed response and the
 *         dispatch layer records success AFTER the adapter resolves (which is
 *         strictly after the body parse — preserving invariants 12/13: an SSE
 *         body throws inside `parseJsonResponseBody` before the adapter returns,
 *         so success is never recorded for an unparsed body).
 *
 * The single integration point is {@link recordBtsCooldownSuccess} /
 * {@link recordBtsCooldownRateLimitFromError}, both invoked from `executeBtsPlan`
 * in `behindTheScenesClient.ts`. The bucket is selected once via
 * {@link cooldownBucketFor} and threaded down as the `cooldown` argument.
 *
 * Platform-agnostic by contract: lives in `src/core/` (inherited by cloud +
 * mobile). MUST NOT import `electron`, `@main/*`, or `@renderer/*`.
 */

import { createScopedLogger } from '@core/logger';
import { ModelError } from '@core/rebelCore/modelErrors';
import {
  type ApiRateLimitCooldown,
  apiRateLimitCooldown,
  safetyEvalRateLimitCooldown,
} from '@core/services/apiRateLimitCooldown';
import type { AuxiliaryCostCategory } from '../costLedgerService';

const log = createScopedLogger({ service: 'behindTheScenesClient' });

/**
 * Per-category cooldown bucket selection (invariant 5).
 *
 * Safety evaluations use a dedicated cooldown so a 429 on the agent's main model
 * does not block Haiku safety evals and vice-versa (PM 260502 parity gap, REBEL-188).
 * Everything else uses the canonical persisted `apiRateLimitCooldown`.
 *
 * Typed as the single source of truth for the selection so the rule is not an
 * inline `category === 'safety' ? … : …` scattered across the entry points
 * (Researcher F3: "Encode as a typed `cooldownBucketFor(category)` not an inline check").
 */
export function cooldownBucketFor(category: AuxiliaryCostCategory | undefined): ApiRateLimitCooldown {
  return category === 'safety' ? safetyEvalRateLimitCooldown : apiRateLimitCooldown;
}

/**
 * Self-imposed rate-limit error (invariant 4).
 *
 * Thrown by the auth-aware entry points when the cooldown bucket they selected is
 * unavailable — i.e. WE are declining the call to protect the rate-limit budget,
 * not the upstream provider returning a 429. It extends `ModelError` so the ~45
 * consumers' existing `instanceof ModelError` / `.kind === 'rate_limit'` handling
 * is unchanged, while giving callers (e.g. `generateCompactionSummary`, PM 260428)
 * a mechanical way to discriminate the self-imposed case from a real upstream 429
 * via `instanceof SelfImposedRateLimitError` (or the preserved
 * `details.selfImposed === true`). Closes PM 260428: the misclassification
 * surfaced "Context overflow recovery failed" while the system was correctly
 * degrading because the synthetic self-imposed rate_limit was indistinguishable
 * from an upstream one at the catch site.
 */
export class SelfImposedRateLimitError extends ModelError {
  constructor(remainingMs: number, message?: string) {
    super(
      'rate_limit',
      message ??
        `Background task skipped: rate-limit cooldown active (${Math.ceil(remainingMs / 1000)}s remaining)`,
      429,
      undefined,
      { resetAtMs: Date.now() + remainingMs, details: { selfImposed: true } },
    );
    this.name = 'SelfImposedRateLimitError';
  }
}

/**
 * Typed cooldown signal an adapter surfaces to the dispatch layer instead of
 * recording cooldown itself. The success case is implicit (a resolved adapter
 * response); only the rate-limit case carries data (the provider-parsed
 * `retryAfterMs`), attached to the thrown `ModelError`.
 */
export interface BtsCooldownRateLimitSignal {
  /** Provider-parsed Retry-After in ms, if the upstream provided one. */
  retryAfterMs?: number;
  /** Origin transport, for the structured diagnostic log at the dispatch site. */
  provider: string;
  route: string;
}

/**
 * Non-enumerable symbol property used to ferry the parsed rate-limit signal out
 * of an adapter on the thrown `ModelError`. Non-enumerable so it never leaks into
 * JSON/Sentry serialisation of the error.
 */
const BTS_COOLDOWN_SIGNAL = Symbol('btsCooldownRateLimitSignal');

/**
 * Attach a parsed rate-limit cooldown signal to a classified error before the
 * adapter throws it. Only meaningful when `error.kind === 'rate_limit'`; the
 * dispatch layer reads it back via {@link readCooldownRateLimitSignal}. Returns
 * the same error for `throw attachCooldownRateLimitSignal(err, sig)` ergonomics.
 */
export function attachCooldownRateLimitSignal<E extends object>(
  error: E,
  signal: BtsCooldownRateLimitSignal,
): E {
  Object.defineProperty(error, BTS_COOLDOWN_SIGNAL, {
    value: signal,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return error;
}

/** Read back a rate-limit signal attached by an adapter, if any. */
export function readCooldownRateLimitSignal(error: unknown): BtsCooldownRateLimitSignal | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const signal = (error as Record<symbol, unknown>)[BTS_COOLDOWN_SIGNAL];
  return signal as BtsCooldownRateLimitSignal | undefined;
}

/**
 * Dispatch-layer success recorder. Called by `executeBtsPlan` AFTER an adapter
 * resolves a fully-parsed response — which is strictly after the body parse, so
 * an SSE body (which throws inside `parseJsonResponseBody`) never reaches here
 * (invariants 12/13). Clears the cooldown so queued background work can resume.
 */
export function recordBtsCooldownSuccess(cooldown: ApiRateLimitCooldown): void {
  cooldown.recordSuccess();
  log.debug('Recorded BTS API success and cleared cooldown (dispatch layer)');
}

/**
 * Dispatch-layer rate-limit recorder. Called by `executeBtsPlan` when an adapter
 * throws an error: records the cooldown ONLY when the adapter attached a
 * rate-limit signal (i.e. it classified a genuine 429 as `rate_limit`, not a
 * billing/quota 429). Returns the error unchanged so the caller can rethrow.
 *
 * Centralising here is the structural fix for PM 260429 (a transport silently
 * dropping its `recordRateLimit` call): no individual adapter records cooldown,
 * so none can drop it — the dispatch path covers every transport uniformly.
 */
export function recordBtsCooldownRateLimitFromError(
  cooldown: ApiRateLimitCooldown,
  error: unknown,
): void {
  const signal = readCooldownRateLimitSignal(error);
  if (!signal) return;
  cooldown.recordRateLimit(signal.retryAfterMs);
  log.warn(
    { provider: signal.provider, route: signal.route, retryAfterMs: signal.retryAfterMs },
    'Recorded BTS API rate-limit cooldown (dispatch layer)',
  );
}
