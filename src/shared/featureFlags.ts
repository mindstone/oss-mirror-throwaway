/**
 * Main-process feature flag registry.
 *
 * Lightweight, statically-typed flags consumed by main-process services that
 * need an opt-in switch for destructive or behavior-changing code paths. The
 * registry intentionally avoids any runtime dependency (no settings store, no
 * Posthog) so it can be safely called from store-migration code paths that run
 * before the settings system is fully wired.
 *
 * Stage 2C plan-doc context:
 * `docs/plans/260514_openrouter_sonnet_bypass_remediation.md` (L577–582)
 * - `enableV26V27ProviderMigration` defaults OFF.
 * - Flag-OFF: v26→v27 automation-scheduler migration runs telemetry-only
 *   (no mutation). Runtime call sites resolve via
 *   `getDefaultModelForProvider` at fire-time.
 * - Flag-ON + `activeProvider === 'anthropic'` + record lacking a model:
 *   mutation applied.
 * - Flag-ON + `activeProvider !== 'anthropic'`: hard guard — never mutate
 *   regardless of flag state.
 *
 * The retired flag name `automationMigrationMutationEnabled` from earlier
 * iterations is intentionally NOT exposed here. Stage 0 iter-3 BLOCKER #2
 * pinned the canonical name to `enableV26V27ProviderMigration`.
 */

export const MAIN_FEATURE_FLAGS = {
  enableV26V27ProviderMigration: false,
} as const;

export type MainFeatureFlag = keyof typeof MAIN_FEATURE_FLAGS;

export type MainFeatureFlagOverrides = Partial<Record<MainFeatureFlag, boolean>>;

/**
 * Resolve a main-process feature flag. Overrides win when supplied — primarily
 * for tests that need to exercise both flag states without monkey-patching the
 * registry. In production no caller supplies overrides; the registry constant
 * is the single source of truth.
 */
export function isMainFlagEnabled(
  flag: MainFeatureFlag,
  overrides?: MainFeatureFlagOverrides,
): boolean {
  return overrides?.[flag] ?? MAIN_FEATURE_FLAGS[flag];
}
