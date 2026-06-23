/**
 * Unified Model Catalog
 *
 * Single source of truth for model metadata: identity, pricing, capabilities, and aliases.
 * When adding a new model, add it here — consumers derive their data from this catalog.
 *
 * Consumers:
 * - `modelNormalization.ts` → MODEL_OPTIONS, LEGACY_MODEL_MIGRATIONS
 * - `pricingCalculator.ts` → MODEL_PRICING, MODEL_ALIASES
 *
 * @see docs/project/MODEL_REGISTRIES.md — registry topology; this catalog is the SSOT everything else derives from
 * @see docs/project/MODEL_CONSTANTS.md — model-id constants and normalization rules
 * @see docs/project/NEW_MODEL_SUPPORT_PROCESS.md — runbook for adding a model here
 *
 * SCOPE — this catalog is the APP's pricing: per-provider, actual cost paid. The
 * knowledge-work EVAL intentionally prices provider-agnostically (one canonical rate
 * per base model) via `evals/eval-model-pricing.ts` — do NOT route eval cost through
 * this catalog. See docs/project/TESTING_EVALS_KNOWLEDGE_WORK_COSTS.md.
 * NOTE (2026-06-05): spot-checked OpenRouter entries against the live API. Most match the
 * documented `× 1.055` convention and are current (e.g. deepseek/deepseek-v4-pro 0.46 =
 * list 0.435 × 1.055; minimax/minimax-m3 0.32 = 0.30 × 1.055). deepseek/deepseek-v4-flash
 * was genuinely stale (~45% high) and was refreshed (see its inline note). A full per-entry
 * staleness audit + structured per-entry provenance remains a tracked follow-up. NOTE: the
 * knowledge-work EVAL does NOT use these prices — it uses raw OpenRouter list prices
 * (no × 1.055) via evals/eval-model-pricing.ts; see TESTING_EVALS_KNOWLEDGE_WORK_COSTS.md.
 *
 * Pricing last updated: 2026-04-27 (all OpenRouter pricing entries in this catalog re-verified against openrouter.ai/<model> list prices × 1.055 platform-fee convention; gpt-5.4 added back as a half-cost alternative to gpt-5.5; Anthropic SDK direct verified 2026-04-08; other SDK direct entries carried forward from 2026-03-25)
 * Sources:
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 * - OpenAI: https://platform.openai.com/docs/pricing
 * - Google Gemini: https://ai.google.dev/gemini-api/docs/pricing
 * - DeepSeek: https://api-docs.deepseek.com/quick_start/pricing
 * - xAI: https://docs.x.ai/docs/models
 * - Cerebras: https://www.cerebras.ai/pricing
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelProvider = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'xai' | 'cerebras' | 'openrouter' | 'together' | 'cohere' | 'local';

/** Per-million-token pricing in USD. */
export interface ModelPricingInfo {
  /** Cost per million input tokens */
  input: number;
  /** Cost per million output tokens */
  output: number;
  /** Cost per million cache read tokens */
  cacheRead: number;
  /** Cost per million cache creation tokens */
  cacheCreation: number;
}

/**
 * OpenRouter routing + UI metadata for catalog entries with `provider:'openrouter'`.
 *
 * Stage 1 of `docs/plans/260428_kw_eval_infra_and_model_registry.md` introduced
 * this nested block so that adding a new OpenRouter model is a single-place
 * change in `MODEL_CATALOG`. Consumers (`OR_MODEL_CATALOG`, `OR_MODEL_MAP`,
 * `SDK_TO_OR_MAP`, `OR_TO_SDK_MAP`, `LEGACY_OR_MODEL_REMAP`,
 * `OR_MAIN_MODEL_OPTIONS`, `OR_AUXILIARY_MODEL_OPTIONS`,
 * `OR_ALL_MODEL_OPTIONS`) are eagerly derived from this data at module load.
 */
export interface OpenRouterRouting {
  /** Human-readable label for UI dropdowns (e.g., 'Claude Opus 4.7') */
  label: string;
  /** Anthropic SDK ID for FOX-3096 narrowing (only for Claude entries) */
  sdkModel?: string;
  /** Available as a main conversation model in OR dropdowns */
  isMainModel: boolean;
  /** Available as a behind-the-scenes / auxiliary model in OR dropdowns */
  isAuxiliaryModel: boolean;
  /** Hint text appended in auxiliary dropdowns (e.g., '(fastest Claude)') */
  auxiliaryHint?: string;
  /**
   * Legacy OR IDs that should be rewritten to this entry's `id` when present
   * in user settings (`LEGACY_OR_MODEL_REMAP` semantics — active rewrite, not
   * pricing equivalence). Distinct from top-level `aliases` to preserve the
   * original semantic split.
   */
  legacyIds?: string[];
  /**
   * For non-Anthropic OR entries whose suffix doesn't match the SDK pricing
   * key (e.g. `google/gemini-3.1-pro-preview` ↔ `gemini-3.1-pro`): the
   * non-OR catalog entry whose pricing rules apply for cost-tracking.
   * Documentation hint only — this entry's own `pricing` is the source of
   * truth for what to charge.
   */
  pricingFollows?: string;
}

/**
 * Capability metadata for catalog entries that also appear in
 * `PROVIDER_PRESETS` (typically OpenRouter and provider-onboarding flows).
 * Stage 1 folds the `PROVIDER_PRESETS.openrouter.models` array into per-entry
 * `presets` blocks so context-window/output-token info can't drift.
 */
export interface ModelPresetMetadata {
  /** Human-readable description shown in profile-creation UI */
  description?: string;
  /** Known maximum context window in tokens */
  contextWindow?: number;
  /** Known maximum output tokens */
  maxOutputTokens?: number;
  /** Whether this model supports reasoning/thinking effort. Defaults to true. */
  reasoning?: boolean;
}

export interface ModelCatalogEntry {
  /** Canonical model ID (e.g., 'claude-sonnet-4-6'). Always lowercase. */
  id: string;

  /** Model provider */
  provider: ModelProvider;

  /** Per-million-token pricing in USD. */
  pricing: ModelPricingInfo;

  /**
   * Alternative names that resolve to this model.
   * Includes dated snapshots, old naming formats, and variant names.
   * Used for both pricing lookup and settings migration.
   */
  aliases?: string[];

  // --- UI metadata (only for user-selectable Anthropic models) ---

  /** Human-readable display label for UI dropdowns (e.g., 'Sonnet 4.6') */
  displayLabel?: string;

  /** Available as a main conversation model in the UI (Anthropic-only — see `MODEL_OPTIONS`) */
  isMainModel?: boolean;

  /** Available as a behind-the-scenes / auxiliary model in the UI */
  isAuxiliaryModel?: boolean;

  /** Hint text appended to label in auxiliary dropdowns (e.g., '(fastest)') */
  auxiliaryHint?: string;

  // --- Capabilities ---

  /** Supports 1M extended context window (the [1m] suffix) */
  supportsExtendedContext?: boolean;
  /** Supports Anthropic compact context management (`compact_20260112`). */
  supportsCompact?: boolean;
  /** Supports Anthropic `effort: "max"` (xhigh maps to max). */
  supportsMaxEffort?: boolean;
  /**
   * Whether this model accepts a reasoning-EFFORT request parameter — Anthropic
   * `effort`, OpenAI `reasoning_effort`, or Gemini `thinking_config`. This is the
   * per-model SSOT consumed by `supportsEffort()` (`src/core/rebelCore/modelLimits.ts`),
   * which feeds `resolveEffortForApi`. It is the catalog field that replaced the
   * hardcoded family regexes (`^claude-(opus|sonnet)-` / `^gpt-5` / `^o[34]` /
   * `^gemini-(2.5|3)` excl. flash-lite); those regexes survive ONLY as the
   * un-rostered fallback in `supportsEffort`.
   *
   * Set per-row (direct AND openrouter), populated to reproduce the historical
   * regex output exactly. Pinned by the parity test in
   * `__tests__/modelLimits.openrouter.test.ts` ("supportsReasoningEffort catalog
   * field == regex" over the whole catalog). Absent/`undefined` ⇒ `false`.
   *
   * NOTE — distinct axes, do NOT conflate:
   *  - `presets.reasoning` ("reasoning AT ALL", opt-OUT, default `true`) is a
   *    different predicate consumed by `modelSupportsReasoning()`; e.g.
   *    `deepseek-reasoner` reasons but takes no effort param ⇒ here `undefined`.
   *  - The OpenAI `developer`-vs-`system` role split (`getSystemRole`) is a third,
   *    separate predicate (it matches `o1`, which has no effort param) and is NOT
   *    backed by this field.
   */
  supportsReasoningEffort?: boolean;
  /**
   * Thinking is ALWAYS ON for this model and cannot be disabled.
   * Implies: sampling params (`temperature`/`top_p`/`top_k`) are rejected
   * (400), explicit `thinking: { type: 'disabled' }` is rejected (400), and
   * the `thinking.display` request param is available. Consumed by the BTS
   * options sanitizer (sampling-param strip + token floor) and the
   * `thinking.display` opt-in. Set on the direct-provider row only — OR wire
   * ids normalize to it via `normalizeForCapabilityCheck`.
   * Absent/`undefined` ⇒ `false` (thinking can be disabled; sampling allowed).
   */
  thinkingAlwaysOn?: boolean;
  /**
   * Model rejects sampling params (`temperature`/`top_p`/`top_k`) with a
   * 400 (Fable 5, Opus 4.7, Opus 4.8). `thinkingAlwaysOn: true` IMPLIES this.
   * Distinct axis because Opus 4.7/4.8 forbid sampling params but are not
   * always-on-thinking.
   */
  samplingParamsForbidden?: boolean;
  /**
   * Whether the model accepts image (vision) input blocks.
   *
   * `undefined` ⇒ assume vision-capable (fail-open BY DESIGN): the managed
   * roster is server-seeded at runtime and future models can't be enumerated
   * here, so an unknown id must never silently lose vision. Misdeclared
   * text-only models degrade to the `image_input_unsupported` error-kind
   * backstop — a visible, actionable error — never to silent image-stripping
   * on a capable model. Only set `false` for models VERIFIED to reject image
   * input (consume via `modelSupportsImageInput()`).
   */
  supportsImageInput?: boolean;

  // --- Migration ---

  /**
   * For deprecated Anthropic models: the current model ID this should migrate to
   * in user settings. When set, both the model's id AND all its aliases will map
   * to this target in the legacy migration map.
   */
  migratesTo?: string;

  // --- Provider-specific overlays (additive, optional) ---

  /**
   * OpenRouter routing + UI metadata. Required on entries with
   * `provider: 'openrouter'`; absent on direct-provider entries.
   * @see {@link OpenRouterRouting}
   */
  openRouter?: OpenRouterRouting;

  /**
   * Capability/onboarding metadata used by `PROVIDER_PRESETS`. Optional.
   * Used by context-window / output-token / reasoning lookups.
   * @see {@link ModelPresetMetadata}
   */
  presets?: ModelPresetMetadata;
}

// ---------------------------------------------------------------------------
// The Catalog
// ---------------------------------------------------------------------------

/**
 * Canonical model catalog. Order matters for UI models — determines dropdown order.
 *
 * When adding a new model:
 * 1. Add an entry here with all relevant fields
 * 2. That's it — MODEL_OPTIONS, MODEL_PRICING, and MODEL_ALIASES are derived automatically
 */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  // =========================================================================
  // Anthropic — Current models (available in UI)
  // =========================================================================
  // Fable 5 — Anthropic's frontier tier above Opus 4.8 (2× Opus price).
  // Model-specific constraints (verified live 2026-06-11, see
  // docs/plans/260611_fable-5-support/PLAN.md Stage 3 results):
  // - Thinking is always-on adaptive: explicit `disabled`/`budget_tokens` and
  //   sampling params (`temperature`/`top_p`/`top_k`) are rejected with 400.
  // - Safety-classifier refusals: can return `stop_reason: 'refusal'` (HTTP 200).
  // - Requires 30-day data retention — zero-data-retention orgs get 400 on
  //   EVERY request.
  // - New tokenizer: ~30% more tokens than Opus-tier for the same text.
  // No dated-snapshot alias exists yet (the OR-canonical slug lives on the OR
  // entry's legacyIds below).
  {
    id: 'claude-fable-5',
    provider: 'anthropic',
    supportsReasoningEffort: true,
    displayLabel: 'Fable 5',
    // Hidden from pickers while Claude Fable 5 access is withdrawn (2026-06):
    // Anthropic pulled Fable for all keys (404 "use Opus 4.8"), so offering it
    // would 404 every turn. The catalog ENTRY stays (pricing / limits / alias /
    // always-on-thinking handling / downgrade ladder all still resolve); only
    // selectability is off. Restore both flags to `true` when access returns.
    isMainModel: false,
    isAuxiliaryModel: false,
    supportsExtendedContext: true,
    supportsCompact: true,
    supportsMaxEffort: true,
    thinkingAlwaysOn: true,
    samplingParamsForbidden: true,
    pricing: { input: 10.0, output: 50.0, cacheRead: 1.00, cacheCreation: 12.50 },
  },
  {
    id: 'claude-opus-4-8',
    provider: 'anthropic',
    supportsReasoningEffort: true,
    displayLabel: 'Opus 4.8',
    isMainModel: true,
    isAuxiliaryModel: true,
    supportsExtendedContext: true,
    supportsCompact: true,
    supportsMaxEffort: true,
    samplingParamsForbidden: true,
    pricing: { input: 5.0, output: 25.0, cacheRead: 0.50, cacheCreation: 6.25 },
    aliases: ['claude-opus-4.8'],
  },
  {
    id: 'claude-opus-4-7',
    provider: 'anthropic',
    supportsReasoningEffort: true,
    displayLabel: 'Opus 4.7',
    isMainModel: true,
    isAuxiliaryModel: true,
    supportsExtendedContext: true,
    supportsCompact: true,
    supportsMaxEffort: true,
    samplingParamsForbidden: true,
    pricing: { input: 5.0, output: 25.0, cacheRead: 0.50, cacheCreation: 6.25 },
    aliases: ['claude-opus-4.7'],
  },
  {
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    supportsReasoningEffort: true,
    displayLabel: 'Opus 4.6',
    isMainModel: true,
    isAuxiliaryModel: true,
    supportsExtendedContext: true,
    supportsCompact: true,
    supportsMaxEffort: true,
    pricing: { input: 5.0, output: 25.0, cacheRead: 0.50, cacheCreation: 6.25 },
    aliases: ['claude-opus-4-6-20260205', 'claude-opus-4.6'],
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    supportsReasoningEffort: true,
    displayLabel: 'Sonnet 4.6',
    isMainModel: true,
    isAuxiliaryModel: true,
    supportsExtendedContext: true,
    supportsCompact: true,
    pricing: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 },
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    displayLabel: 'Haiku 4.5',
    isMainModel: true,
    isAuxiliaryModel: true,
    auxiliaryHint: '(fastest)',
    pricing: { input: 1.0, output: 5.0, cacheRead: 0.10, cacheCreation: 1.25 },
    aliases: [
      'claude-haiku-4-5-20241022',
      'claude-3-5-haiku-20241022',
      'claude-haiku-4-5-20251001',
    ],
  },

  // =========================================================================
  // Anthropic — Deprecated models (pricing retained for historical cost calculation)
  // =========================================================================
  {
    id: 'claude-sonnet-4-5',
    provider: 'anthropic',
    supportsReasoningEffort: true,
    migratesTo: 'claude-sonnet-4-6',
    pricing: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 },
    aliases: [
      'claude-sonnet-4-5-20241022',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-20240620',
      'claude-sonnet-4-5-20250929',
    ],
  },
  {
    id: 'claude-opus-4-5',
    provider: 'anthropic',
    supportsReasoningEffort: true,
    migratesTo: 'claude-opus-4-8',
    pricing: { input: 5.0, output: 25.0, cacheRead: 0.50, cacheCreation: 6.25 },
    aliases: [
      'claude-opus-4-5-20250219',
      'claude-opus-4-5-20251101',
    ],
  },
  {
    id: 'claude-opus-4-1',
    provider: 'anthropic',
    supportsReasoningEffort: true,
    migratesTo: 'claude-opus-4-8',
    pricing: { input: 15.0, output: 75.0, cacheRead: 1.50, cacheCreation: 18.75 },
    aliases: ['claude-opus-4-1-20250805'],
  },
  {
    id: 'claude-opus-4',
    provider: 'anthropic',
    supportsReasoningEffort: true,
    migratesTo: 'claude-opus-4-8',
    pricing: { input: 15.0, output: 75.0, cacheRead: 1.50, cacheCreation: 18.75 },
    aliases: ['claude-opus-4-20250514'],
  },
  {
    id: 'claude-sonnet-4',
    provider: 'anthropic',
    supportsReasoningEffort: true,
    migratesTo: 'claude-sonnet-4-6',
    pricing: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 },
    aliases: ['claude-sonnet-4-20250514'],
  },
  {
    id: 'claude-sonnet-3-7',
    provider: 'anthropic',
    supportsReasoningEffort: true,
    migratesTo: 'claude-sonnet-4-6',
    pricing: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 },
    aliases: [
      'claude-sonnet-3-7-20250219',
      'claude-3-7-sonnet-20250219',
    ],
  },
  {
    id: 'claude-haiku-3-5',
    provider: 'anthropic',
    migratesTo: 'claude-haiku-4-5',
    pricing: { input: 0.80, output: 4.0, cacheRead: 0.08, cacheCreation: 1.0 },
  },
  {
    id: 'claude-opus-3',
    provider: 'anthropic',
    supportsReasoningEffort: true,
    migratesTo: 'claude-opus-4-8',
    pricing: { input: 15.0, output: 75.0, cacheRead: 1.50, cacheCreation: 18.75 },
    aliases: ['claude-3-opus-20240229'],
  },
  {
    id: 'claude-haiku-3',
    provider: 'anthropic',
    migratesTo: 'claude-haiku-4-5',
    pricing: { input: 0.25, output: 1.25, cacheRead: 0.03, cacheCreation: 0.30 },
    aliases: ['claude-3-haiku-20240307'],
  },

  // =========================================================================
  // OpenAI
  // =========================================================================
  // Frontier reasoning models
  {
    id: 'gpt-5.5',
    provider: 'openai',
    supportsReasoningEffort: true,
    pricing: { input: 5.0, output: 30.0, cacheRead: 0.50, cacheCreation: 5.0 },
  },
  {
    id: 'gpt-5.4',
    provider: 'openai',
    supportsReasoningEffort: true,
    pricing: { input: 2.50, output: 15.0, cacheRead: 0.25, cacheCreation: 2.50 },
    aliases: ['gpt-5.4-codex'],
  },
  {
    id: 'gpt-5.4-mini',
    provider: 'openai',
    supportsReasoningEffort: true,
    pricing: { input: 0.75, output: 4.50, cacheRead: 0.075, cacheCreation: 0.75 },
  },
  {
    id: 'gpt-5.4-nano',
    provider: 'openai',
    supportsReasoningEffort: true,
    pricing: { input: 0.20, output: 1.25, cacheRead: 0.02, cacheCreation: 0.20 },
  },
  {
    id: 'gpt-5.5-pro',
    provider: 'openai',
    supportsReasoningEffort: true,
    pricing: { input: 30.0, output: 180.0, cacheRead: 30.0, cacheCreation: 30.0 },
  },
  {
    id: 'gpt-5.4-pro',
    provider: 'openai',
    supportsReasoningEffort: true,
    pricing: { input: 30.0, output: 180.0, cacheRead: 30.0, cacheCreation: 30.0 },
  },
  {
    id: 'gpt-5.3-codex',
    provider: 'openai',
    supportsReasoningEffort: true,
    pricing: { input: 1.75, output: 14.0, cacheRead: 0.175, cacheCreation: 1.75 },
    aliases: ['gpt-5.3-chat-latest'],
  },
  {
    id: 'gpt-5.2',
    provider: 'openai',
    supportsReasoningEffort: true,
    pricing: { input: 1.25, output: 10.0, cacheRead: 0.125, cacheCreation: 1.25 },
    aliases: ['gpt-5.2-codex', 'gpt-5.2-pro'],
  },
  {
    id: 'gpt-5.1',
    provider: 'openai',
    supportsReasoningEffort: true,
    pricing: { input: 1.0, output: 8.0, cacheRead: 0.10, cacheCreation: 1.0 },
  },
  {
    id: 'gpt-5',
    provider: 'openai',
    supportsReasoningEffort: true,
    pricing: { input: 0.75, output: 6.0, cacheRead: 0.075, cacheCreation: 0.75 },
  },
  {
    id: 'gpt-5-mini',
    provider: 'openai',
    supportsReasoningEffort: true,
    pricing: { input: 0.30, output: 1.20, cacheRead: 0.03, cacheCreation: 0.30 },
  },
  {
    id: 'gpt-5-nano',
    provider: 'openai',
    supportsReasoningEffort: true,
    pricing: { input: 0.10, output: 0.40, cacheRead: 0.01, cacheCreation: 0.10 },
  },
  // Non-reasoning models
  {
    id: 'gpt-4.1',
    provider: 'openai',
    pricing: { input: 2.0, output: 8.0, cacheRead: 0.50, cacheCreation: 2.0 },
  },
  {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    pricing: { input: 0.40, output: 1.60, cacheRead: 0.10, cacheCreation: 0.40 },
  },
  {
    id: 'gpt-4.1-nano',
    provider: 'openai',
    pricing: { input: 0.10, output: 0.40, cacheRead: 0.025, cacheCreation: 0.10 },
  },
  // Legacy OpenAI models
  {
    id: 'gpt-4o',
    provider: 'openai',
    pricing: { input: 2.50, output: 10.0, cacheRead: 1.25, cacheCreation: 2.50 },
    aliases: ['gpt-4o-2024-08-06'],
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    pricing: { input: 0.15, output: 0.60, cacheRead: 0.075, cacheCreation: 0.15 },
    aliases: ['gpt-4o-mini-2024-07-18'],
  },
  {
    id: 'o1',
    provider: 'openai',
    pricing: { input: 15.0, output: 60.0, cacheRead: 7.50, cacheCreation: 15.0 },
    aliases: ['o1-2024-12-17'],
  },
  {
    id: 'o1-mini',
    provider: 'openai',
    supportsImageInput: false, // text-only — o1-mini does not accept image input
    pricing: { input: 1.10, output: 4.40, cacheRead: 0.55, cacheCreation: 1.10 },
    aliases: ['o1-mini-2024-09-12'],
  },
  {
    id: 'o1-pro',
    provider: 'openai',
    pricing: { input: 150.0, output: 600.0, cacheRead: 150.0, cacheCreation: 150.0 },
  },
  {
    id: 'o3',
    provider: 'openai',
    supportsReasoningEffort: true,
    pricing: { input: 2.0, output: 8.0, cacheRead: 0.50, cacheCreation: 2.0 },
    aliases: ['o3-2025-04-16'],
  },
  {
    id: 'o3-pro',
    provider: 'openai',
    supportsReasoningEffort: true,
    pricing: { input: 20.0, output: 80.0, cacheRead: 20.0, cacheCreation: 20.0 },
  },
  {
    id: 'o3-mini',
    provider: 'openai',
    supportsReasoningEffort: true,
    supportsImageInput: false, // text-only (accepts text/file, not image)
    pricing: { input: 1.10, output: 4.40, cacheRead: 0.55, cacheCreation: 1.10 },
    aliases: ['o3-mini-2025-01-31'],
  },
  {
    id: 'o4-mini',
    provider: 'openai',
    supportsReasoningEffort: true,
    pricing: { input: 1.10, output: 4.40, cacheRead: 0.55, cacheCreation: 1.10 },
    aliases: ['o4-mini-2025-04-16'],
  },

  // =========================================================================
  // Google Gemini
  // =========================================================================
  {
    id: 'gemini-2.0-flash',
    provider: 'google',
    pricing: { input: 0.10, output: 0.40, cacheRead: 0.01, cacheCreation: 0.10 },
    aliases: ['gemini-2.0-flash-exp'],
  },
  {
    id: 'gemini-2.5-flash',
    provider: 'google',
    supportsReasoningEffort: true,
    pricing: { input: 0.30, output: 2.50, cacheRead: 0.03, cacheCreation: 0.30 },
    aliases: ['gemini-2.5-flash-preview-05-20'],
  },
  {
    id: 'gemini-2.5-flash-lite',
    provider: 'google',
    pricing: { input: 0.10, output: 0.40, cacheRead: 0.01, cacheCreation: 0.10 },
    aliases: ['gemini-2.5-flash-lite-preview-09-2025'],
  },
  {
    id: 'gemini-2.5-pro',
    provider: 'google',
    supportsReasoningEffort: true,
    pricing: { input: 1.25, output: 10.0, cacheRead: 0.125, cacheCreation: 1.25 },
    aliases: ['gemini-2.5-pro-preview-05-06'],
  },
  {
    id: 'gemini-3-flash',
    provider: 'google',
    supportsReasoningEffort: true,
    pricing: { input: 0.50, output: 3.0, cacheRead: 0.05, cacheCreation: 0.50 },
    aliases: ['gemini-3-flash-preview', 'gemini-3.1-flash-preview'],
  },
  {
    id: 'gemini-3.1-flash-lite',
    provider: 'google',
    pricing: { input: 0.25, output: 1.50, cacheRead: 0.025, cacheCreation: 0.25 },
    aliases: ['gemini-3.1-flash-lite-preview'],
  },
  {
    id: 'gemini-3.1-pro',
    provider: 'google',
    supportsReasoningEffort: true,
    pricing: { input: 2.0, output: 12.0, cacheRead: 0.20, cacheCreation: 2.0 },
    aliases: ['gemini-3-pro-preview', 'gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-customtools'],
  },

  // =========================================================================
  // DeepSeek
  // =========================================================================
  // DeepSeek has never shipped a vision-capable chat model — every DeepSeek
  // entry (here and the openrouter/together mirrors below) is text-only.
  // NOTE on other open-weight families: GLM (z-ai/*) and MiniMax m2.x were
  // audited against OpenRouter `input_modalities` on 2026-06-22 and marked
  // text-only (`supportsImageInput: false`); MiniMax m3 IS vision-capable and
  // stays unmarked. Kimi and Grok remain fail-open (assumed vision-capable)
  // where modality isn't authoritatively verified. If you verify one rejects
  // image input, set `supportsImageInput: false` with a dated comment.
  {
    id: 'deepseek-chat',
    provider: 'deepseek',
    pricing: { input: 0.27, output: 1.10, cacheRead: 0.27, cacheCreation: 0.27 },
    aliases: ['deepseek-v3'],
    supportsImageInput: false,
  },
  {
    id: 'deepseek-reasoner',
    provider: 'deepseek',
    pricing: { input: 0.55, output: 2.19, cacheRead: 0.55, cacheCreation: 0.55 },
    aliases: ['deepseek-r1'],
    supportsImageInput: false,
  },
  {
    id: 'deepseek-v4-flash',
    provider: 'local',
    pricing: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    presets: { description: 'DS4 / DeepSeek V4 Flash (local inference)', contextWindow: 131072, reasoning: true },
    supportsImageInput: false,
  },

  // =========================================================================
  // xAI
  // =========================================================================
  {
    id: 'grok-3',
    provider: 'xai',
    pricing: { input: 3.0, output: 15.0, cacheRead: 3.0, cacheCreation: 3.0 },
  },
  {
    id: 'grok-3-mini',
    provider: 'xai',
    pricing: { input: 0.30, output: 0.50, cacheRead: 0.30, cacheCreation: 0.30 },
    aliases: ['grok-3-fast'],
  },

  // =========================================================================
  // Cerebras (no caching support)
  // =========================================================================
  {
    id: 'llama3.1-8b',
    provider: 'cerebras',
    supportsImageInput: false, // text-only
    pricing: { input: 0.10, output: 0.10, cacheRead: 0.10, cacheCreation: 0.10 },
  },
  {
    id: 'llama-3.3-70b',
    provider: 'cerebras',
    supportsImageInput: false, // text-only
    pricing: { input: 0.60, output: 0.60, cacheRead: 0.60, cacheCreation: 0.60 },
  },
  {
    id: 'gpt-oss-120b',
    provider: 'cerebras',
    supportsImageInput: false, // text-only
    pricing: { input: 0.35, output: 0.75, cacheRead: 0.35, cacheCreation: 0.35 },
  },
  {
    id: 'qwen-3-32b',
    provider: 'cerebras',
    supportsImageInput: false, // text-only
    pricing: { input: 0.60, output: 1.20, cacheRead: 0.60, cacheCreation: 0.60 },
  },

  // =========================================================================
  // OpenRouter (single source of truth — pricing includes 5.5% OR platform fee)
  // ─────────────────────────────────────────────────────────────────────────
  // Stage 1 of docs/plans/260428_kw_eval_infra_and_model_registry.md folded
  // openRouterModels.ts and PROVIDER_PRESETS.openrouter.models into per-entry
  // `openRouter` and `presets` blocks. Adding a new OpenRouter model is now a
  // single-place edit — `OR_MODEL_CATALOG`, dropdowns, presets, and pricing
  // all derive from these entries at module load.
  //
  // @see docs/project/ADDING_AN_OPENROUTER_MODEL.md — full runbook (incl. CN/SGP allowlist step)
  // =========================================================================
  // REBEL-1G9: OpenRouter rejects dotted Claude 4.x IDs such as
  // `anthropic/claude-sonnet-4.6`; keep those spellings as legacyIds only.
  {
    // Pricing = Anthropic list × 1.055 OR platform fee ($10/$50, cache $1.00/$12.50).
    // legacyIds carries OR's internal canonical slug (`claude-5-fable-20260609`) so an
    // OR response echoing it still resolves to `claude-fable-5` for pricing — the
    // resolveOrModelToSdkId step-3 regex needs a dotted version and won't match it.
    id: 'anthropic/claude-fable-5',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 10.55, output: 52.75, cacheRead: 1.06, cacheCreation: 13.19 },
    // isMainModel/isAuxiliaryModel false while Fable access is withdrawn (2026-06) — see the direct claude-fable-5 entry above. Restore to true when access returns.
    openRouter: { label: 'Claude Fable 5', sdkModel: 'claude-fable-5', isMainModel: false, isAuxiliaryModel: false, legacyIds: ['anthropic/claude-5-fable-20260609'] },
    presets: { description: 'Frontier reasoning, top quality', contextWindow: 1000000, maxOutputTokens: 128000 },
  },
  {
    id: 'anthropic/claude-opus-4-8',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 5.28, output: 26.38, cacheRead: 0.53, cacheCreation: 6.59 },
    openRouter: { label: 'Claude Opus 4.8', sdkModel: 'claude-opus-4-8', isMainModel: true, isAuxiliaryModel: true, legacyIds: ['anthropic/claude-opus-4.8'] },
    presets: { description: 'Most capable reasoning', contextWindow: 1000000, maxOutputTokens: 128000 },
  },
  {
    id: 'anthropic/claude-opus-4-7',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 5.28, output: 26.38, cacheRead: 0.53, cacheCreation: 6.59 },
    openRouter: { label: 'Claude Opus 4.7', sdkModel: 'claude-opus-4-7', isMainModel: true, isAuxiliaryModel: true, legacyIds: ['anthropic/claude-opus-4.7'] },
    presets: { description: 'Previous frontier reasoning', contextWindow: 1000000, maxOutputTokens: 128000 },
  },
  {
    id: 'anthropic/claude-opus-4-6',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 5.28, output: 26.38, cacheRead: 0.53, cacheCreation: 6.59 },
    openRouter: { label: 'Claude Opus 4.6', sdkModel: 'claude-opus-4-6', isMainModel: true, isAuxiliaryModel: true, legacyIds: ['anthropic/claude-opus-4.6'] },
    presets: { description: 'Previous frontier reasoning', contextWindow: 1000000, maxOutputTokens: 128000 },
  },
  {
    id: 'anthropic/claude-sonnet-4-6',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 3.17, output: 15.83, cacheRead: 0.32, cacheCreation: 3.96 },
    openRouter: { label: 'Claude Sonnet 4.6', sdkModel: 'claude-sonnet-4-6', isMainModel: true, isAuxiliaryModel: true, legacyIds: ['anthropic/claude-sonnet-4.6'] },
    presets: { description: 'Fast, high-quality (recommended)', contextWindow: 1000000, maxOutputTokens: 64000 },
  },
  {
    id: 'anthropic/claude-haiku-4-5',
    provider: 'openrouter',
    pricing: { input: 1.06, output: 5.28, cacheRead: 0.11, cacheCreation: 1.32 },
    openRouter: { label: 'Claude Haiku 4.5', sdkModel: 'claude-haiku-4-5', isMainModel: false, isAuxiliaryModel: true, auxiliaryHint: '(fastest Claude)', legacyIds: ['anthropic/claude-haiku-4.5'] },
    presets: { description: 'Fastest, most affordable Claude', contextWindow: 200000, maxOutputTokens: 64000 },
  },
  {
    id: 'openai/gpt-5.5',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 5.28, output: 31.65, cacheRead: 0.53, cacheCreation: 5.28 },
    openRouter: { label: 'GPT-5.5', isMainModel: true, isAuxiliaryModel: false },
    presets: { description: 'OpenAI frontier reasoning', contextWindow: 1050000, maxOutputTokens: 128000 },
  },
  {
    id: 'openai/gpt-5.5-pro',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 31.65, output: 189.90, cacheRead: 31.65, cacheCreation: 31.65 },
    openRouter: { label: 'GPT-5.5 Pro', isMainModel: true, isAuxiliaryModel: false },
    presets: { description: 'Premium quality, higher cost', contextWindow: 1050000, maxOutputTokens: 128000 },
  },
  {
    id: 'openai/gpt-5.4',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 2.64, output: 15.83, cacheRead: 0.26, cacheCreation: 2.64 },
    openRouter: { label: 'GPT-5.4', isMainModel: true, isAuxiliaryModel: false },
    presets: { description: 'Strong frontier reasoning, lower cost', contextWindow: 1050000, maxOutputTokens: 128000 },
  },
  {
    id: 'openai/gpt-5.3-codex',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 1.85, output: 14.77, cacheRead: 0.18, cacheCreation: 1.85 },
    openRouter: { label: 'GPT-5.3 Codex', isMainModel: true, isAuxiliaryModel: false },
    presets: { description: 'Best for code-heavy work', contextWindow: 400000, maxOutputTokens: 128000 },
  },
  {
    id: 'openai/gpt-5.2',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 1.32, output: 10.55, cacheRead: 0.13, cacheCreation: 1.32 },
    openRouter: { label: 'GPT-5.2', isMainModel: true, isAuxiliaryModel: false },
    presets: { description: 'Strong coding and agentic tasks', contextWindow: 400000, maxOutputTokens: 128000 },
  },
  {
    id: 'openai/gpt-5.1',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 1.06, output: 8.44, cacheRead: 0.11, cacheCreation: 1.06 },
    openRouter: { label: 'GPT-5.1', isMainModel: true, isAuxiliaryModel: false },
    presets: { description: 'Strong general-purpose reasoning', contextWindow: 400000, maxOutputTokens: 128000 },
  },
  {
    id: 'openai/gpt-5',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 0.79, output: 6.33, cacheRead: 0.079, cacheCreation: 0.79 },
    openRouter: { label: 'GPT-5', isMainModel: true, isAuxiliaryModel: false },
    presets: { description: 'Capable reasoning, lower cost', contextWindow: 400000, maxOutputTokens: 128000 },
  },
  {
    id: 'openai/gpt-5-mini',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 0.32, output: 1.27, cacheRead: 0.032, cacheCreation: 0.32 },
    openRouter: { label: 'GPT-5 Mini', isMainModel: false, isAuxiliaryModel: true, auxiliaryHint: '(fast reasoning)' },
    presets: { description: 'Fast, cost-efficient reasoning', contextWindow: 400000, maxOutputTokens: 128000 },
  },
  {
    id: 'openai/gpt-5-nano',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 0.11, output: 0.42, cacheRead: 0.011, cacheCreation: 0.11 },
    openRouter: { label: 'GPT-5 Nano', isMainModel: false, isAuxiliaryModel: true, auxiliaryHint: '(cheapest reasoning)' },
    presets: { description: 'Fastest, cheapest reasoning', contextWindow: 400000, maxOutputTokens: 128000 },
  },
  {
    id: 'openai/gpt-5.4-mini',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 0.79, output: 4.75, cacheRead: 0.079, cacheCreation: 0.79 },
    openRouter: { label: 'GPT-5.4 Mini', isMainModel: false, isAuxiliaryModel: true, auxiliaryHint: '(fast frontier reasoning)' },
    presets: { description: 'Fast frontier reasoning', contextWindow: 400000, maxOutputTokens: 128000 },
  },
  {
    id: 'openai/gpt-5.4-nano',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 0.21, output: 1.32, cacheRead: 0.021, cacheCreation: 0.21 },
    openRouter: { label: 'GPT-5.4 Nano', isMainModel: false, isAuxiliaryModel: true, auxiliaryHint: '(cheapest frontier reasoning)' },
    presets: { description: 'Cheapest frontier reasoning', contextWindow: 400000, maxOutputTokens: 128000 },
  },
  {
    id: 'openai/gpt-4.1',
    provider: 'openrouter',
    pricing: { input: 2.11, output: 8.44, cacheRead: 0.53, cacheCreation: 2.11 },
    openRouter: { label: 'GPT-4.1', isMainModel: true, isAuxiliaryModel: false },
    presets: { description: 'Smartest non-reasoning model', contextWindow: 1047576, maxOutputTokens: 32768, reasoning: false },
  },
  {
    id: 'openai/gpt-4.1-mini',
    provider: 'openrouter',
    pricing: { input: 0.42, output: 1.69, cacheRead: 0.11, cacheCreation: 0.42 },
    openRouter: { label: 'GPT-4.1 Mini', isMainModel: false, isAuxiliaryModel: true, auxiliaryHint: '(fast)' },
    presets: { description: 'Fast non-reasoning', contextWindow: 1047576, maxOutputTokens: 32768, reasoning: false },
  },
  {
    id: 'openai/gpt-4.1-nano',
    provider: 'openrouter',
    pricing: { input: 0.11, output: 0.42, cacheRead: 0.026, cacheCreation: 0.11 },
    openRouter: { label: 'GPT-4.1 Nano', isMainModel: false, isAuxiliaryModel: true, auxiliaryHint: '(cheapest)' },
    presets: { description: 'Fastest non-reasoning', contextWindow: 1047576, maxOutputTokens: 32768, reasoning: false },
  },
  {
    id: 'openai/o3',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 2.11, output: 8.44, cacheRead: 0.53, cacheCreation: 2.11 },
    openRouter: { label: 'o3', isMainModel: true, isAuxiliaryModel: false },
    presets: { description: 'Legacy reasoning model', contextWindow: 200000, maxOutputTokens: 100000 },
  },
  {
    id: 'openai/o3-pro',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 21.10, output: 84.40, cacheRead: 21.10, cacheCreation: 21.10 },
    openRouter: { label: 'o3 Pro', isMainModel: true, isAuxiliaryModel: false },
    presets: { description: 'Legacy high-compute reasoning', contextWindow: 200000, maxOutputTokens: 100000 },
  },
  {
    id: 'openai/o4-mini',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 1.16, output: 4.64, cacheRead: 0.58, cacheCreation: 1.16 },
    openRouter: { label: 'o4 Mini', isMainModel: false, isAuxiliaryModel: true, auxiliaryHint: '(fast reasoning)' },
    presets: { description: 'Legacy fast reasoning', contextWindow: 200000, maxOutputTokens: 100000 },
  },
  {
    id: 'google/gemini-3.1-pro-preview',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 2.11, output: 12.66, cacheRead: 0.21, cacheCreation: 2.11 },
    openRouter: { label: 'Gemini 3.1 Pro', isMainModel: true, isAuxiliaryModel: false, pricingFollows: 'gemini-3.1-pro' },
    presets: { description: 'Most advanced reasoning (preview)', contextWindow: 1048576, maxOutputTokens: 65536 },
  },
  {
    id: 'google/gemini-3-flash-preview',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 0.53, output: 3.17, cacheRead: 0.053, cacheCreation: 0.53 },
    openRouter: { label: 'Gemini 3 Flash', isMainModel: true, isAuxiliaryModel: true, auxiliaryHint: '(fast)', pricingFollows: 'gemini-3-flash' },
    presets: { description: 'Frontier-class at low cost (preview)', contextWindow: 1048576, maxOutputTokens: 65536 },
  },
  {
    id: 'google/gemini-3.1-flash-lite-preview',
    provider: 'openrouter',
    pricing: { input: 0.26, output: 1.58, cacheRead: 0.026, cacheCreation: 0.26 },
    openRouter: { label: 'Gemini 3.1 Flash-Lite', isMainModel: false, isAuxiliaryModel: true, auxiliaryHint: '(cheapest Gemini)', pricingFollows: 'gemini-3.1-flash-lite' },
    presets: { description: 'Fastest, cheapest Gemini (preview)', contextWindow: 1048576, maxOutputTokens: 65536 },
  },
  {
    id: 'google/gemini-2.5-pro',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 1.32, output: 10.55, cacheRead: 0.13, cacheCreation: 1.32 },
    openRouter: { label: 'Gemini 2.5 Pro', isMainModel: true, isAuxiliaryModel: false },
    presets: { description: 'Deep reasoning and coding (stable)', contextWindow: 1048576, maxOutputTokens: 65536 },
  },
  {
    id: 'google/gemini-2.5-flash',
    provider: 'openrouter',
    supportsReasoningEffort: true,
    pricing: { input: 0.32, output: 2.64, cacheRead: 0.032, cacheCreation: 0.32 },
    openRouter: { label: 'Gemini 2.5 Flash', isMainModel: false, isAuxiliaryModel: true, auxiliaryHint: '(fast)' },
    presets: { description: 'Fast, cost-efficient (stable)', contextWindow: 1048576, maxOutputTokens: 65535 },
  },
  {
    id: 'google/gemini-2.5-flash-lite',
    provider: 'openrouter',
    pricing: { input: 0.11, output: 0.42, cacheRead: 0.011, cacheCreation: 0.11 },
    openRouter: { label: 'Gemini 2.5 Flash-Lite', isMainModel: false, isAuxiliaryModel: true, auxiliaryHint: '(budget)' },
    presets: { description: 'Budget-friendly multimodal (stable)', contextWindow: 1048576, maxOutputTokens: 65535 },
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    provider: 'openrouter',
    pricing: { input: 0.46, output: 0.92, cacheRead: 0.004, cacheCreation: 0.46 },
    openRouter: { label: 'DeepSeek V4 Pro', isMainModel: true, isAuxiliaryModel: true },
    presets: { description: 'Latest DeepSeek frontier model', contextWindow: 163840, maxOutputTokens: 32768 },
    supportsImageInput: false,
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    provider: 'openrouter',
    // Refreshed 2026-06-05 from OpenRouter API (list 0.0983/0.1966/0.0197 in/out/cacheRead)
    // × the 1.055 platform-fee convention used catalog-wide. Prior 0.15/0.30/0.003 was stale
    // (~45% high) — the v4-flash list price dropped and this entry had not been updated.
    pricing: { input: 0.104, output: 0.207, cacheRead: 0.021, cacheCreation: 0.104 },
    openRouter: { label: 'DeepSeek V4 Flash', isMainModel: false, isAuxiliaryModel: true, auxiliaryHint: '(fast)' },
    presets: { description: 'Fast DeepSeek V4 variant', contextWindow: 163840, maxOutputTokens: 32768 },
    supportsImageInput: false,
  },
  {
    id: 'deepseek/deepseek-v3.2',
    provider: 'openrouter',
    pricing: { input: 0.28, output: 1.16, cacheRead: 0.28, cacheCreation: 0.28 },
    openRouter: { label: 'DeepSeek V3.2', isMainModel: true, isAuxiliaryModel: true, legacyIds: ['deepseek/deepseek-chat-v3-0324'], pricingFollows: 'deepseek-chat' },
    presets: { description: 'Strong open-source model', contextWindow: 163840, reasoning: false },
    supportsImageInput: false,
  },
  {
    id: 'deepseek/deepseek-r1-0528',
    provider: 'openrouter',
    pricing: { input: 0.58, output: 2.31, cacheRead: 0.58, cacheCreation: 0.58 },
    openRouter: { label: 'DeepSeek R1', isMainModel: true, isAuxiliaryModel: false, legacyIds: ['deepseek/deepseek-r1'], pricingFollows: 'deepseek-r1' },
    presets: { description: 'Deep reasoning (open-source)', contextWindow: 64000, maxOutputTokens: 16000 },
    supportsImageInput: false,
  },
  {
    id: 'x-ai/grok-4.20',
    provider: 'openrouter',
    pricing: { input: 5.28, output: 21.10, cacheRead: 1.32, cacheCreation: 5.28 },
    openRouter: { label: 'Grok 4.20', isMainModel: true, isAuxiliaryModel: false, legacyIds: ['x-ai/grok-3'] },
    presets: { description: 'xAI frontier reasoning', contextWindow: 131072 },
  },
  {
    id: 'x-ai/grok-4.1-fast',
    provider: 'openrouter',
    pricing: { input: 0.21, output: 0.53, cacheRead: 0.050, cacheCreation: 0.21 },
    openRouter: { label: 'Grok 4.1 Fast', isMainModel: false, isAuxiliaryModel: true, auxiliaryHint: '(fast)', legacyIds: ['x-ai/grok-3-mini'] },
    presets: { description: 'Fast xAI reasoning', contextWindow: 131072 },
  },
  {
    id: 'moonshotai/kimi-k2.6',
    provider: 'openrouter',
    pricing: { input: 0.84, output: 3.69, cacheRead: 0.21, cacheCreation: 0.84 },
    openRouter: { label: 'Kimi K2.6', isMainModel: true, isAuxiliaryModel: false },
    presets: { description: 'Long-horizon coding and agent swarm', contextWindow: 262144 },
  },
  {
    id: 'moonshotai/kimi-k2.5',
    provider: 'openrouter',
    pricing: { input: 0.46, output: 2.11, cacheRead: 0.23, cacheCreation: 0.46 },
    openRouter: { label: 'Kimi K2.5', isMainModel: true, isAuxiliaryModel: true },
    presets: { description: 'Visual coding and agentic reasoning', contextWindow: 262144 },
  },
  {
    id: 'minimax/minimax-m3',
    provider: 'openrouter',
    pricing: { input: 0.32, output: 1.27, cacheRead: 0.063, cacheCreation: 0.32 },
    openRouter: { label: 'MiniMax M3', isMainModel: true, isAuxiliaryModel: true },
    presets: { description: 'Latest MiniMax frontier model (agentic, long-context)', contextWindow: 524288, maxOutputTokens: 65536 },
  },
  {
    id: 'minimax/minimax-m2.7',
    provider: 'openrouter',
    pricing: { input: 0.32, output: 1.27, cacheRead: 0.32, cacheCreation: 0.32 },
    supportsImageInput: false, // text-only per OR input_modalities (m3 is vision; m2.x is not)
    openRouter: { label: 'MiniMax M2.7', isMainModel: true, isAuxiliaryModel: true, legacyIds: ['minimax/minimax-m2.5'] },
    presets: { description: 'Strong open-weight model', contextWindow: 196608, maxOutputTokens: 65536, reasoning: false },
  },
  {
    // GLM 5.2 — text-only (input_modalities: ['text']). Pricing = OR list
    // ($1.00 in / $4.00 out per MTok) × 1.055 platform-fee convention.
    // contextWindow/maxOutputTokens are the conservative floor across the
    // z-ai/ provider allowlist (DeepInfra/Fireworks/AtlasCloud) — AtlasCloud
    // caps context at 202752 and the model's top_provider caps completion at
    // 32768, so a larger value could fail when OR load-balances to that route.
    // legacyIds carries OR's canonical slug for exact-match resolution of
    // OR-echoed usage (cost tracking + OR-remap/settings normalization).
    // resolveOrModelToSdkId's date-strip fallback would also map the slug to this
    // row, but the explicit alias is more robust (see pricingCalculator.test).
    id: 'z-ai/glm-5.2',
    provider: 'openrouter',
    pricing: { input: 1.06, output: 4.22, cacheRead: 1.06, cacheCreation: 1.06 },
    supportsImageInput: false,
    openRouter: { label: 'GLM 5.2', isMainModel: true, isAuxiliaryModel: false, legacyIds: ['z-ai/glm-5.2-20260616'] },
    presets: { description: 'Latest GLM frontier model', contextWindow: 202752, maxOutputTokens: 32768, reasoning: false },
  },
  {
    id: 'z-ai/glm-5.1',
    provider: 'openrouter',
    pricing: { input: 1.11, output: 3.69, cacheRead: 1.11, cacheCreation: 1.11 },
    supportsImageInput: false, // text-only per OR input_modalities
    openRouter: { label: 'GLM 5.1', isMainModel: true, isAuxiliaryModel: false },
    presets: { description: 'Previous GLM frontier model', contextWindow: 128000, reasoning: false },
  },
  {
    id: 'z-ai/glm-5-turbo',
    provider: 'openrouter',
    pricing: { input: 1.27, output: 4.22, cacheRead: 1.27, cacheCreation: 1.27 },
    supportsImageInput: false, // text-only per OR input_modalities
    openRouter: { label: 'GLM 5 Turbo', isMainModel: true, isAuxiliaryModel: false },
    presets: { description: 'Fast GLM model', contextWindow: 128000, reasoning: false },
  },
  {
    id: 'z-ai/glm-5',
    provider: 'openrouter',
    pricing: { input: 0.63, output: 2.19, cacheRead: 0.63, cacheCreation: 0.63 },
    supportsImageInput: false, // text-only per OR input_modalities
    openRouter: { label: 'GLM 5', isMainModel: true, isAuxiliaryModel: true },
    presets: { description: 'Strong open-weight model', contextWindow: 128000, reasoning: false },
  },
  {
    id: 'z-ai/glm-4.7',
    provider: 'openrouter',
    pricing: { input: 0.40, output: 1.84, cacheRead: 0.40, cacheCreation: 0.40 },
    supportsImageInput: false, // text-only per OR input_modalities
    openRouter: { label: 'GLM 4.7', isMainModel: false, isAuxiliaryModel: true, auxiliaryHint: '(budget)' },
    presets: { description: 'Budget GLM model', contextWindow: 128000, reasoning: false },
  },
  {
    id: 'z-ai/glm-4.7-flash',
    provider: 'openrouter',
    pricing: { input: 0.060, output: 0.42, cacheRead: 0.060, cacheCreation: 0.060 },
    supportsImageInput: false, // text-only per OR input_modalities
    openRouter: { label: 'GLM 4.7 Flash', isMainModel: false, isAuxiliaryModel: true, auxiliaryHint: '(cheapest GLM)' },
    presets: { description: 'Cheapest GLM model', contextWindow: 128000, reasoning: false },
  },
  {
    id: 'minimax/minimax-m2.5',
    provider: 'openrouter',
    pricing: { input: 0.53, output: 2.10, cacheRead: 0.53, cacheCreation: 0.53 },
    supportsImageInput: false, // text-only (matches m2.7; canonical entry wins over m2.7's legacyId)
    // Historical-only — no OR routing block; superseded via LEGACY_OR_MODEL_REMAP
  },
  // ── Together.ai-hosted models ────────────────────────────────────────────
  // Together exposes an OpenAI-compatible chat completions API at
  // https://api.together.xyz/v1. Custom-provider profiles use the upstream
  // model ID verbatim (Together accepts e.g. 'deepseek-ai/DeepSeek-V4-Pro').
  // Catalog id is stored lowercase per convention — `resolveModelAlias` lowercases
  // its input before lookup, so cost tracking still resolves the mixed-case
  // upstream ID to this entry. Pricing scraped from /v1/models response on
  // 2026-04-29 (USD per million tokens).
  {
    id: 'deepseek-ai/deepseek-v4-pro',
    provider: 'together',
    pricing: { input: 2.10, output: 4.40, cacheRead: 0.20, cacheCreation: 2.10 },
    presets: { description: 'DeepSeek V4 Pro on Together (512k context, OpenAI-compatible)', contextWindow: 512000 },
    supportsImageInput: false,
  },
  {
    id: 'deepseek-ai/deepseek-v3.2',
    provider: 'together',
    // /v1/models returned $0/$0; treat as effectively free / sub-cent and use a
    // safe non-zero estimate to avoid divide-by-zero in efficiency scoring.
    pricing: { input: 0.28, output: 1.16, cacheRead: 0.28, cacheCreation: 0.28 },
    presets: { description: 'DeepSeek V3.2 on Together (164k context, OpenAI-compatible)', contextWindow: 163840 },
    supportsImageInput: false,
  },
  // NOTE on Kimi K2.6 on Together: Together exposes `moonshotai/Kimi-K2.6`
  // (mixed-case) at $1.20 input / $4.50 output / $0.20 cached input /
  // 256k ctx (verified via /v1/models on 2026-05-04). It is NOT added as a
  // separate catalog entry here because `resolveModelAlias` lowercases input
  // before lookup, which would collide with the existing OR-routed
  // `moonshotai/kimi-k2.6` entry above and silently overwrite its pricing
  // (last-entry-wins in the pricing map). Routing for Together-hosted Kimi
  // works via profile-direct match (the eval bootstrap routes by
  // `profile.model === bundle.working`); cost tracking falls back to OR
  // pricing ($0.74 / $3.49), which under-counts Together actual spend by
  // ~60% on input and ~30% on output. Followup: introduce a provider-aware
  // lookup convention (e.g. composite `<provider>:<id>` keys) before adding
  // any further Together-hosted entries that share an OR-prefix model ID.
  // ── Cohere ───────────────────────────────────────────────────────────────
  // Cohere exposes an OpenAI-compatible chat completions API at
  // https://api.cohere.ai/compatibility/v1 (per their Compatibility API docs).
  // Use a `customProviders` entry + a profile with `providerType: 'other'` and
  // `customProviderId` pointing at it; the eval bootstrap routes by
  // `profile.model === bundle.working`, so the model id below must match the
  // value passed to `--model` on the eval CLI verbatim.
  //
  // Quirks (verified against Cohere docs 2026-04-29):
  //   - Tool/function-calling is supported, but `parallel_tool_calls` is NOT
  //     accepted on the compatibility endpoint. Rebel's OpenAIClient does not
  //     send this parameter, so no client-side change is needed.
  //   - Production rate limit: 500 req/min for Command A keys.
  //
  // Pricing per 1M tokens, USD (https://cohere.com/pricing, verified
  // 2026-04-29). The compatibility API does not currently surface separate
  // prompt-caching pricing, so cacheRead/cacheCreation use the headline
  // input rate (no caching discount).
  {
    id: 'command-a-03-2025',
    provider: 'cohere',
    supportsImageInput: false, // text-only — Cohere Command A accepts text only
    pricing: { input: 2.50, output: 10.00, cacheRead: 2.50, cacheCreation: 2.50 },
    // Cohere Command A caps output at 8192 tokens (256k context). Without this
    // explicit `maxOutputTokens`, `resolveModelLimits` falls through to
    // DEFAULT_MAX_OUTPUT_TOKENS (32_768), which Cohere rejects with HTTP 400
    // ("max tokens must be less than or equal to 8192"). The runtime resolves
    // via getKnownMaxOutputForModel(modelId) which reads this preset.
    presets: { description: 'Cohere Command A flagship (256k context, 8k output, OpenAI-compatible via api.cohere.ai/compatibility/v1)', contextWindow: 256000, maxOutputTokens: 8192 },
  },
];

// ---------------------------------------------------------------------------
// Lazy-computed lookup maps (computed once on first access)
// ---------------------------------------------------------------------------

let _pricingMap: Record<string, ModelPricingInfo> | null = null;
let _aliasMap: Record<string, string> | null = null;
let _migrationMap: Record<string, string> | null = null;
let _entryById: Map<string, ModelCatalogEntry> | null = null;
let _entryByLegacyOpenRouterId: Map<string, ModelCatalogEntry> | null = null;

/**
 * Get a map of canonical model IDs → pricing info.
 * Used by pricingCalculator to replace its hardcoded MODEL_PRICING.
 */
export function getCatalogPricingMap(): Record<string, ModelPricingInfo> {
  if (!_pricingMap) {
    _pricingMap = {};
    for (const entry of MODEL_CATALOG) {
      _pricingMap[entry.id] = entry.pricing;
    }
  }
  return _pricingMap;
}

/**
 * Get a map of alias names → canonical model IDs.
 * Used by pricingCalculator to replace its hardcoded MODEL_ALIASES.
 */
export function getCatalogAliasMap(): Record<string, string> {
  if (!_aliasMap) {
    _aliasMap = {};
    for (const entry of MODEL_CATALOG) {
      for (const alias of entry.aliases ?? []) {
        _aliasMap[alias] = entry.id;
      }
    }
  }
  return _aliasMap;
}

/**
 * Normalize a model identifier to a canonical catalog ID when possible.
 *
 * Rules:
 * - trim + lowercase
 * - strip `[1m]` suffix (extended-context tag)
 * - strip trailing dated snapshot suffixes (`-YYYYMMDD` / `-YYYY-MM-DD`)
 * - resolve aliases via the catalog alias map
 * - return canonical id when candidate exists in MODEL_CATALOG
 * - otherwise return the normalized candidate unchanged
 */
export function normalizeModelId(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (!normalized) {
    return normalized;
  }

  const aliasMap = getCatalogAliasMap();
  const withoutExtendedSuffix = normalized.replace(/\[1m\]$/, '');
  const withoutDateSuffix = withoutExtendedSuffix.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '');

  const canonicalFromAlias = aliasMap[withoutDateSuffix];
  if (canonicalFromAlias) {
    return canonicalFromAlias;
  }

  if (getCatalogEntryById(withoutDateSuffix)) {
    return withoutDateSuffix;
  }

  return withoutDateSuffix;
}

/**
 * Get a map of legacy model names → current model IDs for settings migration.
 *
 * For deprecated Anthropic models (those with `migratesTo`):
 *   - model.id → migratesTo
 *   - each alias → migratesTo
 *
 * For current Anthropic models (no `migratesTo`):
 *   - each alias → model.id  (normalizes dated snapshots to the canonical alias)
 */
export function getCatalogMigrationMap(): Record<string, string> {
  if (!_migrationMap) {
    _migrationMap = {};
    for (const entry of MODEL_CATALOG) {
      if (entry.provider !== 'anthropic') continue;

      if (entry.migratesTo) {
        // Deprecated: both the id and all aliases migrate to the successor
        _migrationMap[entry.id] = entry.migratesTo;
        for (const alias of entry.aliases ?? []) {
          _migrationMap[alias] = entry.migratesTo;
        }
      } else if (entry.aliases?.length) {
        // Current: normalize dated snapshots to the canonical alias
        for (const alias of entry.aliases) {
          _migrationMap[alias] = entry.id;
        }
      }
    }
  }
  return _migrationMap;
}

/**
 * Look up a catalog entry by its canonical ID.
 */
export function getCatalogEntryById(id: string): ModelCatalogEntry | undefined {
  if (!_entryById) {
    _entryById = new Map();
    for (const entry of MODEL_CATALOG) {
      _entryById.set(entry.id, entry);
    }
  }
  return _entryById.get(id);
}

/**
 * Get all model IDs that support the 1M extended context window.
 */
export function getExtendedContextModelIds(): string[] {
  return MODEL_CATALOG
    .filter(e => e.supportsExtendedContext)
    .map(e => e.id);
}

/**
 * Look up the catalog entry that OWNS a legacy OpenRouter id
 * (`openRouter.legacyIds`). Legacy ids are actively rewritten in user
 * settings (`LEGACY_OR_MODEL_REMAP`, derived from this same data in
 * openRouterModels.ts), but they can still reach the agent loop as the
 * live wire model (e.g. sub-agent delegation — see
 * subAgentProxyRouting.test.ts), so capability lookups must resolve them
 * to the owning entry rather than treating them as unknown ids.
 * Kept here (not via openRouterModels.ts) to avoid importing a derived
 * module back into its source.
 *
 * COLLISION PRECEDENCE (GPT stage-4 review F1): a legacy id can ALSO exist as
 * a canonical catalog entry (live example: `minimax/minimax-m2.5` is a
 * historical entry kept for cost calculation AND a legacyId of
 * `minimax/minimax-m2.7`). `modelSupportsImageInput` consults the canonical
 * entry FIRST, so the historical entry wins here — deliberately different
 * from `LEGACY_OR_MODEL_REMAP`'s active-rewrite semantics (that map rewrites
 * ids in user SETTINGS; this resolver answers "what can the id on the wire
 * do", and the entry named by that exact id is the more specific record).
 * If capability metadata for such a pair ever needs to diverge, mark the
 * historical entry itself — a `supportsImageInput` mark on the legacyIds
 * owner will NOT be consulted for the colliding id
 * (modelCatalog.test.ts pins this agreement so divergence is a conscious
 * decision, not drift).
 */
function getCatalogEntryByLegacyOpenRouterId(id: string): ModelCatalogEntry | undefined {
  if (!_entryByLegacyOpenRouterId) {
    _entryByLegacyOpenRouterId = new Map();
    for (const entry of MODEL_CATALOG) {
      for (const legacyId of entry.openRouter?.legacyIds ?? []) {
        // Key on the LOWERCASED id: lookups arrive via `normalizeModelId()`
        // (which lowercases), so a future non-lowercase legacyId entry would
        // otherwise silently miss and fail open (Claude stage-4 review F2).
        _entryByLegacyOpenRouterId.set(legacyId.toLowerCase(), entry);
      }
    }
  }
  return _entryByLegacyOpenRouterId.get(id);
}

/**
 * Whether a model accepts image (vision) input blocks.
 *
 * Resolves the id through `normalizeModelId()` (lowercase, `[1m]`/date-suffix
 * strip, alias resolution), falling back to `openRouter.legacyIds` ownership
 * (GPT stage-2 review F1 — legacy DeepSeek ids are runtime-reachable loop
 * models and must not fail open), and consults the catalog entry's
 * `supportsImageInput` field. Unknown / unresolvable ids return `true`
 * (fail-open by design — see the field's JSDoc on {@link ModelCatalogEntry}):
 * the error-kind backstop covers misdeclared models; silently stripping
 * images from a capable model is the failure mode this must never produce.
 */
export function modelSupportsImageInput(modelId: string): boolean {
  const normalized = normalizeModelId(modelId);
  const entry = getCatalogEntryById(normalized) ?? getCatalogEntryByLegacyOpenRouterId(normalized);
  return entry?.supportsImageInput !== false;
}

/**
 * Whether a model id resolves to a catalog entry whose thinking is ALWAYS ON
 * (`thinkingAlwaysOn`, e.g. Claude Fable 5) — the premium 2x-cost class that
 * cost-consent gates key on (Maximum-tier swap exclusion in qualityTiers.ts,
 * the RebelSettings cost-escalation gate in toolSafetyService.ts, the
 * routing-eligibility default in catalogMaterialization.ts).
 *
 * Alias-complete by design (GPT stage-12 review F1): a user profile or
 * agent-supplied id can carry ANY Fable-shaped spelling, and a miss here
 * silently re-prices the user's work. Resolution:
 * 1. `normalizeModelId()` — lowercase, `[1m]` strip, dated-suffix strip,
 *    alias resolution (covers `claude-fable-5[1m]`, `claude-fable-5-20260609`,
 *    `anthropic/claude-fable-5[1m]`).
 * 2. `openRouter.legacyIds` ownership, checked on BOTH the pre- and
 *    post-date-strip spellings — `anthropic/claude-5-fable-20260609` is keyed
 *    WITH its date, which step 1's date strip would otherwise erase, and it is
 *    NOT in `getCatalogAliasMap()` (aliases ≠ openRouter.legacyIds).
 * 3. `openRouter.sdkModel` hop — the flag lives on the direct-provider row
 *    only; OR rows (their own catalog entries) point at it.
 *
 * Distinct from `isAlwaysOnThinkingModel()` in @core/rebelCore/modelLimits.ts
 * (which src/shared must not import): that one feeds the wire-shape
 * sanitizers and today resolves only via the alias map (no
 * `openRouter.legacyIds` lookup, no `openRouter.sdkModel` hop), so it misses
 * OR-shaped spellings. Cost-consent checks must use THIS helper; aligning the
 * core helper's resolution is a separate (wire-behavior) decision. Unknown /
 * unrostered ids ⇒ `false` (matching the core helper's
 * no-legacy-always-on fallback).
 *
 * F4 / STAGE0: the two predicates are kept separate by design, but their AGREEMENT over every
 * catalog entry is pinned by the F4 parity test in
 * `src/core/rebelCore/__tests__/modelLimits.test.ts`. Keep both docstrings + that test in lockstep
 * if either resolution changes.
 */
export function isAlwaysOnThinkingCatalogModel(modelId: string): boolean {
  const lowered = modelId.trim().toLowerCase().replace(/\[1m\]$/, '');
  const normalized = normalizeModelId(modelId);
  const entry =
    getCatalogEntryById(normalized) ??
    getCatalogEntryByLegacyOpenRouterId(lowered) ??
    getCatalogEntryByLegacyOpenRouterId(normalized);
  if (!entry) return false;
  if (entry.thinkingAlwaysOn === true) return true;
  const directEntry = entry.openRouter?.sdkModel
    ? getCatalogEntryById(entry.openRouter.sdkModel)
    : undefined;
  return directEntry?.thinkingAlwaysOn === true;
}

/**
 * Whether a model id resolves to a catalog entry that rejects sampling params
 * (`temperature`/`top_p`/`top_k`) with a 400.
 *
 * Always-on-thinking models imply this, but this predicate is broader: Opus
 * 4.7/4.8 also reject sampling params while still allowing thinking to be
 * disabled. Resolution intentionally mirrors
 * {@link isAlwaysOnThinkingCatalogModel}: normalize first, check
 * `openRouter.legacyIds` on both lowered and normalized spellings, then hop
 * from an OpenRouter row to its direct-provider `openRouter.sdkModel`.
 *
 * @internal Capability predicate consumed only by tests today (modelLimits.test.ts,
 * modelCatalog.test.ts) — shipped ahead of its egress-gating consumer, so the knip
 * production leg flags it; the default leg keeps tracking it.
 */
export function isSamplingParamsForbiddenCatalogModel(modelId: string): boolean {
  const lowered = modelId.trim().toLowerCase().replace(/\[1m\]$/, '');
  const normalized = normalizeModelId(modelId);
  const entry =
    getCatalogEntryById(normalized) ??
    getCatalogEntryByLegacyOpenRouterId(lowered) ??
    getCatalogEntryByLegacyOpenRouterId(normalized);
  if (!entry) return false;
  if (entry.samplingParamsForbidden === true || entry.thinkingAlwaysOn === true) return true;
  const directEntry = entry.openRouter?.sdkModel
    ? getCatalogEntryById(entry.openRouter.sdkModel)
    : undefined;
  return directEntry?.samplingParamsForbidden === true || directEntry?.thinkingAlwaysOn === true;
}
