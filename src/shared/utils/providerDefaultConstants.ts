/**
 * Provider default model constants — leaf module with zero downstream imports.
 *
 * Extracted to break the import cycle:
 *   modelSettingsResolver → getDefaultModelForProvider → codexDefaults/openRouterDefaults
 *     → modelSettingsResolver (resolveModelSettings)
 *
 * `getDefaultModelForProvider` only needs the raw string constants, not the
 * full `applyCodexModelDefaults` / `applyOpenRouterModelDefaults` machinery
 * that imports `resolveModelSettings`. Pulling the constants into a leaf
 * module keeps both the application defaults (in their original `*Defaults.ts`
 * files) and the cycle-free resolver chain working.
 *
 * Source-of-truth note: The original definitions remain exported from
 * `codexDefaults.ts`, `openRouterDefaults.ts`, and `modelNormalization.ts` for
 * backwards compatibility — those files now re-export or derive from this leaf
 * so existing call sites continue to work without churn. Do NOT edit values
 * here without updating related catalog entries.
 *
 * @see docs/plans/260514_openrouter_sonnet_bypass_remediation.md (Stage 3)
 */

// ---------------------------------------------------------------------------
// Codex (ChatGPT Pro Subscription)
// ---------------------------------------------------------------------------
export const CODEX_DEFAULT_MODEL = 'gpt-5.5';
export const CODEX_DEFAULT_BTS_MODEL = 'gpt-5.4-mini';

// ---------------------------------------------------------------------------
// Anthropic (direct API)
// ---------------------------------------------------------------------------
export const ANTHROPIC_DEFAULT_WORKING_MODEL = 'claude-sonnet-4-6';
/**
 * Single source of truth for the default planning/thinking Opus model.
 *
 * For the next model bump, update this value and follow
 * docs/project/NEW_MODEL_SUPPORT_PROCESS.md step 2/2b so the Anthropic catalog
 * row and OpenRouter twin stay aligned.
 */
export const ANTHROPIC_DEFAULT_THINKING_MODEL = 'claude-opus-4-8';
export const ANTHROPIC_DEFAULT_BACKGROUND_MODEL = 'claude-haiku-4-5';

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------
// Canonical (dashed) OpenRouter id — must be a key in OR_MODEL_MAP. `normalizeSettings()`
// validates the OR thinking model via `OR_MODEL_MAP.has(...)` (no legacy-id remap on that
// path) and OR dropdowns are built from the dashed catalog ids, so the default must be the
// dashed form, NOT the dotted `anthropic/claude-opus-4.8` (a legacy alias only). REBEL-1G9.
export const OR_DEFAULT_THINKING_MODEL = `anthropic/${ANTHROPIC_DEFAULT_THINKING_MODEL}`;
export const OR_DEFAULT_WORKING_MODEL = 'openai/gpt-5.5';
export const OR_DEFAULT_BTS_MODEL = 'deepseek/deepseek-v4-flash';

// ---------------------------------------------------------------------------
// Provider classification (shared, single source of truth)
//
// Which `activeProvider` values route through OpenRouter for model-default and
// routing purposes. `mindstone` is the managed-subscription tier — Mindstone
// pays the OpenRouter bill behind a server-provisioned managed key — so it is
// OpenRouter-effective exactly like a BYO `openrouter` user.
//
// This list (and `isOpenRouterEffectiveProvider`) is consumed by BOTH
// `getDefaultModelForProvider` (default-model selection) and
// `settingsUtils.normalizeSettings`'s `isEffectivelyOpenRouter` so the two
// cannot silently disagree on whether a provider is OpenRouter-effective — the
// drift that left `mindstone` users defaulting to Anthropic models. Adding a
// future managed-OpenRouter provider here updates both consumers at once.
// `undefined` is intentionally NOT OpenRouter-effective on this literal axis
// (pre-normalisation callers must default to Anthropic — see
// `getDefaultModelForProvider`'s header). `normalizeSettings` layers its own
// `undefined + OR-credentials` legacy case on top of this predicate.
// ---------------------------------------------------------------------------
export const OPENROUTER_EFFECTIVE_PROVIDERS = ['openrouter', 'mindstone'] as const;

export function isOpenRouterEffectiveProvider(activeProvider: string | undefined): boolean {
  return (
    activeProvider !== undefined &&
    (OPENROUTER_EFFECTIVE_PROVIDERS as readonly string[]).includes(activeProvider)
  );
}

// ---------------------------------------------------------------------------
// Mindstone managed-subscription (Dash/Rogue flat-fee) client fallback defaults
//
// For `activeProvider: 'mindstone'` the AUTHORITATIVE defaults are server-seeded
// (managedProvider.defaultModels from /api/config — see MANAGED_PROVIDER_LIFECYCLE.md);
// the client only reaches these when a slot is unseeded. They MIRROR the current
// managed tier (cheap, since Mindstone pays the bill) so the client fallback stays
// allow-list-safe — the managed proxy's allow-list is exactly the seeded
// {working, thinking, bts}, so a fallback that matches them avoids
// `MANAGED_MODEL_NOT_ALLOWED` (403). OpenRouter wire form (mindstone routes
// through the managed OpenRouter key). The server remains the source of truth;
// if the managed tier changes, derive these at runtime from the seeded defaults
// rather than editing here (tracked follow-up).
// ---------------------------------------------------------------------------
export const MINDSTONE_DEFAULT_WORKING_MODEL = 'deepseek/deepseek-v4-flash';
export const MINDSTONE_DEFAULT_THINKING_MODEL = 'openai/gpt-5.5';
export const MINDSTONE_DEFAULT_BTS_MODEL = 'deepseek/deepseek-v4-flash';
