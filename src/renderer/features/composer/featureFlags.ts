/**
 * Renderer-local feature flags for composer experiments.
 *
 * These flags are intentionally module-level constants (not user settings, not env-driven) because
 * they gate experimental in-tree rewrites that we want to flip behind a one-line code change. Once
 * a flag's owning migration completes (per its planning doc), the flag is removed entirely along
 * with the legacy code path it gated.
 *
 * Active flags:
 * - `composer.tiptap` — enables the TipTap-based prompt editor with inline removable mention chips.
 *   Plan: `docs/plans/260429_composer_rich_chips_input.md`.
 */
export const COMPOSER_FEATURE_FLAGS = {
  /**
   * When `true`, `AgentComposer` mounts the TipTap-based prompt editor in place of the legacy
   * `<textarea>`. The legacy code path is retained alongside until the migration completes
   * (Stage 4 of `docs/plans/260429_composer_rich_chips_input.md`).
   */
  tiptap: true,
} as const;

export type ComposerFeatureFlag = keyof typeof COMPOSER_FEATURE_FLAGS;

export function isComposerFlagEnabled(flag: ComposerFeatureFlag): boolean {
  return COMPOSER_FEATURE_FLAGS[flag];
}
