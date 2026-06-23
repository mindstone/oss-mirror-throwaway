/**
 * Model normalization utilities
 * 
 * Uses Anthropic model aliases (e.g., 'claude-sonnet-4-6') which automatically
 * resolve to the latest snapshot version. This simplifies maintenance and ensures
 * users always get the latest model improvements.
 * 
 * Model metadata (pricing, aliases, capabilities) is defined in the unified
 * model catalog at `src/shared/data/modelCatalog.ts`. When adding a new model,
 * update the catalog — MODEL_OPTIONS and migration maps are derived automatically.
 * 
 * See: https://docs.anthropic.com/en/docs/about-claude/models/overview
 */

import { MODEL_CATALOG, getCatalogMigrationMap, getCatalogEntryById } from '../data/modelCatalog';
import { decodeRoutingModelId, type RoutingModelId } from './btsModelValueNormalization';
import { ANTHROPIC_DEFAULT_THINKING_MODEL } from './providerDefaultConstants';

/** Internal model alias indicating plan mode (thinking + execution model split). */
export const PLAN_MODE_ALIAS = 'planner';

/** Env var key: the thinking/planning model for plan mode. */
export const ENV_THINKING_MODEL = 'PLANNING_MODEL';

/** Env var key: the execution/working model for plan mode. */
export const ENV_EXECUTION_MODEL = 'EXECUTION_MODEL';

export const DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * Default model for auxiliary/background tasks (safety checks, quips, time estimates, etc.).
 * Haiku is chosen for speed and cost efficiency on these lightweight tasks.
 * This is NOT a fallback for the main agent - the main agent uses DEFAULT_MODEL.
 */
export const DEFAULT_AUXILIARY_MODEL = 'claude-haiku-4-5';

/**
 * Preferred model for the planning/thinking role in plan mode.
 */
export const PREFERRED_PLANNING_MODEL = ANTHROPIC_DEFAULT_THINKING_MODEL;

/**
 * Fallback model when PREFERRED_PLANNING_MODEL is unavailable for user's subscription.
 */
export const FALLBACK_PLANNING_MODEL = 'claude-sonnet-4-6';

/**
 * REBEL-655: Resolve the *real* thinking/planning model to hand to
 * {@link resolveModelConfig}. This must always name a model the user can
 * actually route — NEVER a synthetic Claude sentinel — so that:
 *   - thinking == working → single-model mode (no plan mode), and
 *   - a distinct thinking model names the real (e.g. proxy-backed) model, so
 *     `rebelCoreQuery` builds the planning client via the same provider/proxy.
 *
 * Precedence mirrors the `effectiveThinking` computation in agentTurnExecute:
 *   1. explicit per-turn override (`thinkingModelOverride`):
 *        - `undefined` → inherit (fall through to profile/setting)
 *        - `''`        → suppress thinking model (single-model mode) → null
 *        - a model     → that model
 *   2. the configured Thinking *profile*'s actual model (NOT a sentinel)
 *   3. `settings.thinkingModel`
 * Falsy/whitespace-only values normalize to `null` (single-model mode).
 *
 * Before this fix, the executor substituted `PREFERRED_PLANNING_MODEL`
 * (a Claude model) whenever ANY thinking profile existed — which leaked a
 * Claude planning model for Codex/OpenRouter users who can't route Anthropic.
 */
export const resolvePlanningThinkingModel = (args: {
  thinkingModelOverride: string | undefined;
  thinkingProfileModel: string | null | undefined;
  settingsThinkingModel: string | null | undefined;
}): string | null => {
  const normalize = (v: string | null | undefined): string | null => {
    const trimmed = v?.trim();
    return trimmed ? trimmed : null;
  };
  if (args.thinkingModelOverride !== undefined) {
    // '' (empty string) explicitly suppresses the thinking model.
    return normalize(args.thinkingModelOverride);
  }
  return normalize(args.thinkingProfileModel) ?? normalize(args.settingsThinkingModel);
};

/**
 * Typed plan-mode target (the class-kill for `provider_route_plan_missing_axis`).
 *
 * Plan mode is now represented by an explicit value, not inferred from a
 * "thinking-model string ≠ working-model string" comparison. A non-null
 * `PlanModeTarget` is the ONLY way to request plan mode through
 * {@link resolveModelConfig}. Its `thinkingModel` carries a branded
 * {@link RoutingModelId}, so a synthetic string (e.g. `PREFERRED_PLANNING_MODEL`)
 * can no longer masquerade positionally as a "thinking model" the active
 * provider may not be able to serve — the only way in is an explicit decode of a
 * model that came from a real role resolution.
 *
 * C3: keep this SINGLE (no array/list — that is a future feature). C6: carries a
 * typed `RoutingModelId`; no new string-format-sniffing.
 */
export interface PlanModeTarget {
  thinkingModel: RoutingModelId;
}

/**
 * Brand a (already-resolved) thinking-model string into a {@link PlanModeTarget},
 * applying the single-model-mode collapse: returns `null` when the thinking model
 * is absent or equals the working model. Used by the executor's fallback/override
 * producers that already hold a concrete model string (e.g. the auth-failure
 * fallback to `PREFERRED_PLANNING_MODEL`, or a bare thinking setting) so they enter
 * plan mode through the same typed gate as the primary accessor — never via a raw
 * string passed positionally to {@link resolveModelConfig}.
 */
export const planModeTargetFromThinkingModel = (
  thinkingModel: string | null | undefined,
  workingModel: string,
): PlanModeTarget | null => {
  const trimmed = thinkingModel?.trim();
  if (!trimmed || trimmed === workingModel) return null;
  const decoded = decodeRoutingModelId(trimmed);
  if (!decoded) return null;
  return { thinkingModel: decoded };
};

/**
 * The one accessor that decides plan mode and produces the typed
 * {@link PlanModeTarget}. Layers the working model onto
 * {@link resolvePlanningThinkingModel}'s precedence logic so the typed target is
 * the single authority for "is plan mode on for this turn":
 *   - resolves the REAL thinking model (never a synthetic Claude sentinel),
 *   - returns `null` (single-model mode) when there is no thinking model OR the
 *     thinking model equals the working model,
 *   - otherwise brands the thinking model into a `PlanModeTarget`.
 *
 * `hasThinkingModel`/`planModeEnabled`/`extendedContextEnabled` and
 * {@link resolveModelConfig} all key off `target !== null`, NOT a raw string
 * compare — so every plan-mode producer/consumer agrees by construction.
 */
export const resolvePlanModeTarget = (args: {
  workingModel: string;
  thinkingModelOverride: string | undefined;
  thinkingProfileModel: string | null | undefined;
  settingsThinkingModel: string | null | undefined;
}): PlanModeTarget | null => {
  const thinkingModel = resolvePlanningThinkingModel({
    thinkingModelOverride: args.thinkingModelOverride,
    thinkingProfileModel: args.thinkingProfileModel,
    settingsThinkingModel: args.settingsThinkingModel,
  });
  return planModeTargetFromThinkingModel(thinkingModel, args.workingModel);
};

export interface ModelOption {
  value: string;
  label: string;
  /** Available as a main conversation model */
  isMainModel: boolean;
  /** Available as a behind-the-scenes / auxiliary model */
  isAuxiliaryModel: boolean;
  /** Hint text appended to label in auxiliary dropdowns (e.g. "(fastest)") */
  auxiliaryHint?: string;
  /** Whether this model supports the 1M extended context window ([1m] suffix) */
  supportsExtendedContext?: boolean;
}

/**
 * Canonical list of user-selectable models.
 * Derived from the model catalog — add new models there, not here.
 * UI dropdowns consume this. Order is determined by catalog order.
 *
 * When adding a new model to the catalog, set `supportsExtendedContext: true` if the
 * model supports the 1M token context window. All fallback logic (200K context, Opus
 * downgrade, header stripping) derives from this single flag.
 */
// MODEL_OPTIONS describes user-selectable BYOK Anthropic main-conversation models.
// We filter to provider:'anthropic' explicitly because non-Anthropic catalog
// entries (OpenRouter etc.) also use isMainModel for their own dropdown lists.
// Without this guard, the BYOK dropdown would erroneously include OR entries.
export const MODEL_OPTIONS: ModelOption[] = MODEL_CATALOG
  .filter(e => e.provider === 'anthropic' && e.isMainModel)
  .map(e => ({
    value: e.id,
    label: e.displayLabel ?? e.id,
    isMainModel: true,
    isAuxiliaryModel: e.isAuxiliaryModel ?? false,
    auxiliaryHint: e.auxiliaryHint,
    supportsExtendedContext: e.supportsExtendedContext,
  }));

/**
 * Return a short human-readable display name for a model ID.
 * Falls back to the raw model ID when unknown.
 */
export const getModelDisplayName = (modelId: string): string => {
  const baseId = modelId.replace(/\[1m\]$/i, '');
  const option = MODEL_OPTIONS.find(opt => opt.value === baseId);
  if (option) return option.label;
  // Fall back to the unified catalog's label. MODEL_OPTIONS only covers the Anthropic-only
  // main-conversation models, so OpenRouter / auxiliary catalog models (e.g. `deepseek/deepseek-v4-pro`
  // → "DeepSeek V4 Pro") would otherwise render as their raw id.
  const catalogLabel = getCatalogEntryById(baseId)?.openRouter?.label;
  return catalogLabel ?? modelId;
};

/**
 * Resolve the effective thinking effort for a specific Claude model.
 * Checks per-model overrides first, then falls back to the global thinkingEffort.
 */
export const getModelEffort = (
  claude: { thinkingEffort?: string; modelEfforts?: Partial<Record<string, string>> } | undefined,
  modelId: string,
): string => {
  const perModel = claude?.modelEfforts?.[modelId];
  if (perModel) return perModel;
  return claude?.thinkingEffort ?? 'high';
};

/**
 * Migration map for legacy dated model versions stored in user settings.
 * Derived from the model catalog — deprecated models and their aliases map to current models.
 * Maps old dated versions to current aliases so existing users are migrated.
 */
const LEGACY_MODEL_MIGRATIONS: Record<string, string> = getCatalogMigrationMap();

/**
 * Normalize a Claude model name to its canonical alias version.
 * Migrates legacy dated versions to current aliases.
 */
export const normalizeModel = (model: string): string => {
  const canonical = model?.trim();
  // eslint-disable-next-line rebel-provider-defaults/no-default-model-literal -- normalizeModel is the canonical Claude alias-normalisation helper; the input is already an Anthropic model name. Empty input is a "missing Claude model" signal, not a provider-routing decision. See docs/plans/260514_openrouter_sonnet_bypass_remediation.md.
  if (!canonical) return DEFAULT_MODEL;

  // Check if this is a legacy dated version that needs migration
  const migrated = LEGACY_MODEL_MIGRATIONS[canonical] ?? LEGACY_MODEL_MIGRATIONS[canonical.toLowerCase()];
  if (migrated) return migrated;

  // Migrate any old Claude 3.x models to current default
  // eslint-disable-next-line rebel-provider-defaults/no-default-model-literal -- Claude-3.x legacy migration is intrinsically Anthropic; the input prefix already gates the branch. See docs/plans/260514_openrouter_sonnet_bypass_remediation.md.
  if (canonical.toLowerCase().startsWith('claude-3')) return DEFAULT_MODEL;

  // Return as-is (already an alias or unknown model)
  return canonical;
};

/**
 * Anthropic catalog ids that support the 1M extended-context window — an
 * INTRINSIC model capability, decoupled from picker visibility.
 *
 * Derived from the catalog's `supportsExtendedContext` flag WITHOUT the
 * `isMainModel` filter (unlike `MODEL_OPTIONS`). This matters because a model
 * can be hidden from selection (`isMainModel:false`) while still HAVING the
 * capability — e.g. Claude Fable 5 while its API access is withdrawn (2026-06).
 * Resolving capability through the visibility-filtered `MODEL_OPTIONS` used to
 * conflate the two, so hiding a model silently flipped its reported 1M support
 * to false (a latent bug; benign only while the model was unusable anyway). Now
 * capability follows the catalog, like every other capability predicate
 * (`modelSupportsImageInput`, `isAlwaysOnThinkingCatalogModel`, …).
 *
 * Anthropic-only by construction, so the prefix-strip / dot→dash normalization
 * in `modelSupportsExtendedContext` can't false-match a non-Anthropic OpenRouter
 * id (`openai/…`, `deepseek/…`).
 */
const EXTENDED_CONTEXT_MODEL_IDS: ReadonlySet<string> = new Set(
  MODEL_CATALOG
    .filter(e => e.provider === 'anthropic' && e.supportsExtendedContext)
    .map(e => e.id.toLowerCase()),
);

/**
 * Check whether a model supports the 1M extended context window.
 * Resolves from the catalog capability set `EXTENDED_CONTEXT_MODEL_IDS` (the
 * model's INTRINSIC capability), independent of whether it's offered in any
 * picker. Uses exact equality (after stripping the [1m] suffix) to avoid false
 * positives from substring matches (e.g., a hypothetical 'claude-sonnet-4-50'
 * must not match 'claude-sonnet-4-5').
 *
 * Capability follows the underlying model, NOT the route: an OpenRouter-routed
 * Anthropic id carries a provider prefix (e.g. `anthropic/claude-opus-4-8`) that
 * isn't a direct-Anthropic catalog id, so we also try the id with a leading
 * `provider/` segment stripped — giving OR-routed Anthropic 1M parity with
 * direct (Greg, 260614: "1M by default always"). Safe against false positives
 * because the capability set is Anthropic-only: non-Anthropic OR ids
 * (`openai/…`, `deepseek/…`) strip to ids that simply aren't present.
 *
 * Falls back to false for unknown models (safe default -- 200K always works).
 */
export const modelSupportsExtendedContext = (model: string): boolean => {
  if (!model) return false;
  const baseModel = model.replace(/\[1m\]$/i, '').toLowerCase();
  // Capability follows the underlying model — not the route, nor the version-punctuation spelling.
  // Try the id as-is, with a leading `provider/` segment stripped (OpenRouter-routed), and each of
  // those with version dots normalized to dashes: OpenRouter's canonical ids use dots
  // (`anthropic/claude-opus-4.8`) while our catalog uses dashes (`claude-opus-4-8`). The capability
  // set is Anthropic-only, so none of these normalizations can false-match a non-Anthropic OR id
  // (`openai/…`, `deepseek/…`), and dot→dash only matches a genuinely extended-context dashed id.
  const withoutPrefix = baseModel.includes('/') ? baseModel.slice(baseModel.indexOf('/') + 1) : baseModel;
  const candidates = [
    baseModel,
    withoutPrefix,
    baseModel.replace(/\./g, '-'),
    withoutPrefix.replace(/\./g, '-'),
  ];
  return candidates.some(c => EXTENDED_CONTEXT_MODEL_IDS.has(c));
};

/**
 * Apply the [1m] suffix to enable 1M token extended context window.
 * Only applies to models that declare `supportsExtendedContext: true` in the
 * catalog (resolved via `modelSupportsExtendedContext` / EXTENDED_CONTEXT_MODEL_IDS).
 *
 * The `[1m]` suffix is an Anthropic-DIRECT convention (the Anthropic client/proxy translate it).
 * OpenRouter-routed ids carry a `provider/` prefix and serve 1M via AUTOMATIC model capability
 * (GA), NOT via this suffix — appending `[1m]` would yield an unknown-model slug
 * (`anthropic/claude-opus-4-8[1m]`) and 400 at OpenRouter. So for provider-prefixed ids we budget
 * 1M (the predicate above returns true) but send the BARE slug; OpenRouter serves the larger window
 * by capability, and the existing context-overflow fallback handles any provider that caps at 200K.
 * (Greg, 260614: "1M by default always" — capability follows the model, not the route.)
 */
export const applyExtendedContextSuffix = (model: string, extendedContext: boolean): string => {
  if (!extendedContext) return model;
  if (!model) return model;
  if (model.endsWith('[1m]')) return model;
  if (!modelSupportsExtendedContext(model)) return model;
  if (model.includes('/')) return model; // OpenRouter-routed: bare slug + GA 1M, never the [1m] suffix
  return `${model}[1m]`;
};

export interface ModelConfig {
  model: string;
  envOverrides?: Record<string, string>;
}

/**
 * Resolve the effective model configuration based on settings.
 *
 * Plan mode is requested ONLY by a non-null typed {@link PlanModeTarget} — the
 * plan-mode branch keys off `planMode !== null`, NOT a raw thinking-model-string
 * comparison. The single-model-mode collapse (thinking == working) is decided
 * upstream by the {@link PlanModeTarget} accessors, so a synthetic Claude string
 * can no longer reach this function as a plan-mode trigger.
 *
 * When a `PlanModeTarget` is provided (plan mode):
 * - Uses PLAN_MODE_ALIAS which internally uses the thinking model for planning,
 *   working model for execution
 * - Sets ENV_THINKING_MODEL to the thinking model
 * - Sets ENV_EXECUTION_MODEL to the working model
 * - Applies [1m] suffix to both models when extendedContext is true (if they support it)
 *
 * When `planMode` is null (single model mode):
 * - Uses the working model with optional [1m] suffix for extended context
 */
export const resolveModelConfig = (
  workingModel: string,
  planMode: PlanModeTarget | null,
  extendedContext: boolean
): ModelConfig => {
  if (planMode) {
    // Plan mode: use the typed target's thinking model for planning, workingModel
    // for execution. The target's thinkingModel is a branded RoutingModelId that
    // came from a real role resolution — never a synthetic sentinel.
    const opusModel = applyExtendedContextSuffix(planMode.thinkingModel, extendedContext);
    const sonnetModel = applyExtendedContextSuffix(workingModel, extendedContext);
    
    const baseEnvOverrides: Record<string, string> = {
      [ENV_THINKING_MODEL]: opusModel,
      [ENV_EXECUTION_MODEL]: sonnetModel,
    };
    
    if (extendedContext) {
      return {
        model: PLAN_MODE_ALIAS,
        envOverrides: {
          ...baseEnvOverrides,
        }
      };
    }
    return { 
      model: PLAN_MODE_ALIAS,
      envOverrides: baseEnvOverrides
    };
  }
  return { model: applyExtendedContextSuffix(workingModel, extendedContext) };
};

/**
 * Strip extended context features from a model config.
 * Used for fallback when 1M context is not available for the user's account.
 * - Removes [1m] suffix from model name
 * - Removes [1m] from ENV_EXECUTION_MODEL env override
 * - Removes [1m] from ENV_THINKING_MODEL env override
 */
export const stripExtendedContextFromConfig = (config: ModelConfig): ModelConfig => {
  const strippedModel = config.model.replace(/\[1m\]$/i, '');
  const strippedEnvOverrides = config.envOverrides ? { ...config.envOverrides } : undefined;
  
  if (strippedEnvOverrides) {
    if (strippedEnvOverrides[ENV_EXECUTION_MODEL]) {
      strippedEnvOverrides[ENV_EXECUTION_MODEL] = 
        strippedEnvOverrides[ENV_EXECUTION_MODEL].replace(/\[1m\]$/i, '');
    }
    if (strippedEnvOverrides[ENV_THINKING_MODEL]) {
      strippedEnvOverrides[ENV_THINKING_MODEL] = 
        strippedEnvOverrides[ENV_THINKING_MODEL].replace(/\[1m\]$/i, '');
    }
  }
  
  return {
    model: strippedModel,
    envOverrides: strippedEnvOverrides
  };
};

/**
 * Remove the 1M context beta header from ANTHROPIC_CUSTOM_HEADERS string.
 * Returns the modified headers string, or undefined if empty after removal.
 */
export const stripExtendedContextHeader = (headers: string | undefined): string | undefined => {
  if (!headers) return undefined;
  
  // Claude Code expects ANTHROPIC_CUSTOM_HEADERS as newline-delimited `Header: value` entries.
  // Strip the context-1m beta header while preserving any other headers.
  const filtered = headers
    .split(/\r?\n/)
    .map(h => h.trim())
    .filter(Boolean)
    .filter(h => !h.includes('context-1m'))
    .join('\n');
  
  return filtered.length > 0 ? filtered : undefined;
};

/**
 * Check if an error indicates that 1M context is not available for the user's subscription.
 * Handles both direct error.message and nested API error structures like error.error.message.
 * 
 * To avoid false positives (e.g., Claude mentioning "long context beta" in conversation),
 * we require BOTH:
 * 1. The text contains "long context beta"
 * 2. The text looks like an API error (starts with "API Error:" or contains error JSON structure)
 */
export const isExtendedContextUnavailableError = (error: unknown): boolean => {
  if (!error) return false;
  
  // Check direct message property
  const errRecord = error as Record<string, unknown>;
  const directMessage = (typeof errRecord?.message === 'string' ? errRecord.message : '') as string;
  // Check nested error.error.message (API error format)
  const nestedErr = errRecord?.error as Record<string, unknown> | undefined;
  const nestedMessage = (typeof nestedErr?.message === 'string' ? nestedErr.message : '') as string;
  // Stringify the whole error as fallback
  const fullString = String(error);
  
  const combined = `${directMessage} ${nestedMessage} ${fullString}`.toLowerCase();
  
  // Must contain the specific error phrase
  if (!combined.includes('long context beta')) {
    return false;
  }
  
  // Must look like an API error to avoid false positives from conversational mentions
  // API errors have format: "API Error: 400 {...}" or contain "invalid_request_error"
  // Note: checking for "type":"error" or "type": "error" to handle spacing variations
  const looksLikeApiError = 
    combined.includes('api error:') ||
    combined.includes('invalid_request_error') ||
    combined.includes('"type":"error"') ||
    combined.includes('"type": "error"');
  
  // Defensive logging: if we found the phrase but it doesn't look like an API error,
  // log for debugging to catch potential format changes from upstream
  if (!looksLikeApiError) {
    console.warn('[modelNormalization] "long context beta" found but not recognized as API error - may be conversational mention or format change:', combined.slice(0, 200));
  }
  
  return looksLikeApiError;
};

/**
 * Check if an error indicates that the thinking model is not available for the user's subscription.
 * Returns true for:
 * - 403 permission errors mentioning model access denial (Anthropic pattern)
 * - 404 model-not-found errors with model context (OpenAI-compatible pattern)
 * The check is model-agnostic; the known-thinking-model list below only gates
 * a defensive console.warn for unrecognized models.
 */
export const isThinkingModelUnavailableError = (error: unknown): boolean => {
  if (!error) return false;
  
  const errRecord = error as Record<string, unknown>;
  const statusCode = typeof errRecord?.status === 'number' ? errRecord.status : 0;
  const directMessage = (typeof errRecord?.message === 'string' ? errRecord.message : '') as string;
  const nestedErr = errRecord?.error as Record<string, unknown> | undefined;
  const nestedMessage = (typeof nestedErr?.message === 'string' ? nestedErr.message : '') as string;
  const fullString = String(error);
  const combined = `${directMessage} ${nestedMessage} ${fullString}`.toLowerCase();
  
  // Must contain 403/permission error indicator
  const looksLikePermissionError = 
    combined.includes('403') || 
    combined.includes('permission_error') ||
    combined.includes('permission error');
  
  // Must mention model access denial
  const mentionsModelAccess = 
    combined.includes("don't have access to the model") ||
    combined.includes("do not have access to the model") ||
    combined.includes("you don't have access") ||
    combined.includes('access to it');

  const looksLikeNotFoundError =
    statusCode === 404 ||
    combined.includes('404') ||
    combined.includes('not_found');

  const mentionsModelNotExist =
    combined.includes('does not exist') ||
    combined.includes('model not found');

  // Require model context for 404 path to avoid false positives on generic "does not exist" errors
  // (e.g., "workspace does not exist") or conversational text explaining errors.
  const hasModelContext =
    combined.includes('the model') ||
    combined.includes('model `') ||
    combined.includes('model "') ||
    combined.includes('model not found');

  if (looksLikePermissionError && mentionsModelAccess) {
    // Log if we can't confirm it's about a known Anthropic thinking-tier model
    // (Fable 5, Opus 4.6-4.8). Purely defensive observability — the return
    // value is unaffected. Keep in step with the thinking-model roster
    // (NEW_MODEL_SUPPORT_PROCESS).
    const mentionsKnownThinkingModel =
      combined.includes('fable-5') || combined.includes('fable_5') ||
      combined.includes('opus-4-8') || combined.includes('opus_4_8') ||
      combined.includes('opus-4-7') || combined.includes('opus_4_7') ||
      combined.includes('opus-4-6') || combined.includes('opus_4_6');
    if (!mentionsKnownThinkingModel) {
      console.warn('[modelNormalization] Permission error for model access, but model not confirmed as a known thinking model:', combined.slice(0, 200));
    }
    return true;
  }

  if (looksLikeNotFoundError && mentionsModelNotExist && hasModelContext) {
    return true;
  }
  
  return false;
};

/**
 * Thinking-model downgrade ladder: maps an unavailable thinking model to the
 * model the turn should degrade to. Models above the default thinking tier
 * (e.g. Fable 5) step down to the default thinking model; the default steps
 * down to the broadly-available fallback. Models not in this map have no
 * downgrade path — `downgradeThinkingModelConfig` returns the config
 * unchanged (and `handleThinkingModelFallback` soft-fails with an honest
 * "no downgrade path" log instead of the false "already on fallback").
 *
 * When adding a model ABOVE the default tier, add it here so unavailability
 * degrades to the default instead of soft-failing (NEW_MODEL_SUPPORT_PROCESS).
 */
const THINKING_MODEL_DOWNGRADE_TARGETS: Readonly<Record<string, string>> = {
  'claude-fable-5': PREFERRED_PLANNING_MODEL,
  [PREFERRED_PLANNING_MODEL]: FALLBACK_PLANNING_MODEL,
};

/**
 * The downgrade target for a thinking model (ignores any [1m] suffix), or
 * `undefined` when the model has no downgrade path. Exposed so error
 * recovery can distinguish "already on the terminal fallback" from
 * "no downgrade path defined" when logging a non-downgradable model.
 */
export const getThinkingModelDowngradeTarget = (model: string): string | undefined =>
  THINKING_MODEL_DOWNGRADE_TARGETS[model.replace(/\[1m\]$/i, '')];

/**
 * Downgrade the thinking model config one step down the downgrade ladder
 * (Fable 5 → default thinking model → fallback). Used when the user doesn't
 * have access to the configured thinking model.
 * Strips [1m] suffix if the downgrade target doesn't support extended context.
 * Handles both direct-model mode and plan mode (envOverrides[ENV_THINKING_MODEL]).
 * Idempotent: returns unchanged config if the model has no downgrade path
 * (already on fallback, or not on the ladder at all).
 */
export const downgradeThinkingModelConfig = (config: ModelConfig): ModelConfig => {
  // Plan mode: thinking model is in envOverrides
  const currentThinkingModel = config.envOverrides?.[ENV_THINKING_MODEL];
  if (currentThinkingModel) {
    const target = getThinkingModelDowngradeTarget(currentThinkingModel);
    if (!target) {
      return config;
    }

    // Apply [1m] to the downgrade target only if it supports extended context
    const fallbackModel = modelSupportsExtendedContext(target) && currentThinkingModel.endsWith('[1m]')
      ? `${target}[1m]`
      : target;

    return {
      ...config,
      envOverrides: {
        ...config.envOverrides,
        [ENV_THINKING_MODEL]: fallbackModel
      }
    };
  }

  // Direct mode: the thinking model is the model itself (with or without [1m] suffix)
  const target = getThinkingModelDowngradeTarget(config.model);
  if (!target) {
    return config;
  }

  // Downgrade — only keep [1m] if the target supports it
  const fallbackModel = modelSupportsExtendedContext(target) && config.model.endsWith('[1m]')
    ? `${target}[1m]`
    : target;
  return {
    ...config,
    model: fallbackModel
  };
};

/**
 * Build the chat completions URL from a server URL.
 * Handles both styles:
 *  - URLs ending in /v1 or /v1beta/openai (cloud APIs): append /chat/completions
 *  - Bare URLs like http://localhost:1234: append /v1/chat/completions
 */
export function buildCompletionsUrl(serverUrl: string): string {
  const base = serverUrl.replace(/\/+$/, '');
  if (/\/v\d+(?:beta)?(?:\/|$)/i.test(base)) {
    return `${base}/chat/completions`;
  }
  return `${base}/v1/chat/completions`;
}

/**
 * Build the responses API URL from a server URL.
 * Mirrors buildCompletionsUrl but targets /v1/responses instead of /v1/chat/completions.
 * Used when reasoning_effort + tools requires the Responses API endpoint.
 */
export function buildResponsesUrl(serverUrl: string): string {
  const base = serverUrl.replace(/\/+$/, '');
  if (/\/v\d+(?:beta)?(?:\/|$)/i.test(base)) {
    return `${base}/responses`;
  }
  return `${base}/v1/responses`;
}
