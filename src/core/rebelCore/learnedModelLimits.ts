/**
 * @deprecated Stage 2 (260503_unify_learned_limits_into_profiles.md): the
 * dedicated `rebel-core-learned-model-limits` store has been folded onto
 * `ModelProfile` provenance fields. New code MUST use
 * `recordContextOverflowOnProfile` from `learnedProfileWriter.ts` and the
 * cascade in `resolveModelLimits` (with `allProfiles`/`profileContextWindowSource`).
 *
 * This module is kept as a tombstone:
 *  - `getLearnedContextWindow` always returns undefined.
 *  - `recordContextOverflow` is a no-op (the migration ran on first boot
 *    after Stage 2 to fold any prior data; the legacy store is also cleared
 *    by the migration).
 *  - `_resetStoreForTesting` is a no-op.
 *  - `LEARNED_MODEL_LIMITS_STORE_VERSION` stays exported so the store
 *    version registry still validates without a churn-y rename.
 *
 * The store name itself is preserved here for historical reference; the
 * migration in `learnedLimitsMigration.ts` opens the legacy store via the
 * same name on first boot, drains TTL-valid entries onto profiles, and
 * empties it.
 */

import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'learnedModelLimits' });

const STORE_VERSION = 1;

const warnedFns = new Set<string>();
function warnTombstoneOnce(fn: 'getLearnedContextWindow' | 'recordContextOverflow'): void {
  if (warnedFns.has(fn)) return;
  warnedFns.add(fn);
  log.warn(
    { fn },
    `[tombstone] legacy learnedModelLimits.${fn} called; this should be unreachable post-Stage-2`,
  );
}

/** @internal Test-only: clears the rate-limit memory so other tests can verify the warn fires. */
export function _resetTombstoneWarningsForTesting(): void {
  warnedFns.clear();
}

/**
 * @deprecated Always returns undefined. The cascade in `resolveModelLimits`
 * now reads auto-learned values directly from profiles via `allProfiles`.
 */
export function getLearnedContextWindow(_model: string): number | undefined {
  warnTombstoneOnce('getLearnedContextWindow');
  return undefined;
}

/**
 * @deprecated No-op. Use `recordContextOverflowOnProfile` from
 * `learnedProfileWriter.ts` instead — it stamps the learned ceiling onto the
 * relevant `ModelProfile` (auto-creating a stub when no profile matches).
 */
export function recordContextOverflow(_model: string, _lastKnownInputTokens: number): void {
  warnTombstoneOnce('recordContextOverflow');
}

/** Re-exported for the store version registry (`ALL_STORE_VERSIONS`). */
export { STORE_VERSION as LEARNED_MODEL_LIMITS_STORE_VERSION };

/** @deprecated No-op — there's no live store to reset. */
export function _resetStoreForTesting(): void {
  // intentionally empty
}
