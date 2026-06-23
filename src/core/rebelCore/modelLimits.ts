import { createScopedLogger } from '@core/logger';
import type { ModelProfile, ThinkingEffort } from '@shared/types';

const log = createScopedLogger({ service: 'modelLimits' });
import { getKnownMaxOutputForModel } from '@shared/data/modelProviderPresets';
import { getKnownContextWindowForModel } from '@shared/data/modelProviderPresets';
import {
  getAnthropicContextWindow,
  getAnthropicMaxOutput,
} from '@shared/data/anthropicModelLimits';
import { getCatalogAliasMap, getCatalogEntryById } from '@shared/data/modelCatalog';

// Fallback for unknown models
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;
const DEFAULT_CONTEXT_WINDOW = 200_000;

export interface ModelTokenLimits {
  maxOutputTokens: number;
  contextWindow: number;
}

export interface ModelLimitsInput {
  model: string;
  profileMaxOutput?: number;
  /**
   * Provenance of `profileMaxOutput`. When `'user'`, the value beats all
   * catalog defaults. When `'auto'`, the value still beats catalog defaults
   * because it is provider-observed runtime truth.
   */
  profileMaxOutputSource?: 'user' | 'auto';
  profileContextWindow?: number;
  /**
   * Provenance of `profileContextWindow`. When `'user'`, the value beats the
   * Anthropic registry (today's behavior). When `'auto'`, the value slots in
   * BELOW the registry/preset and ABOVE the model-scoped fallback. When
   * undefined, `profileContextWindow` is treated as user-set (legacy).
   */
  profileContextWindowSource?: 'user' | 'auto';
  /**
   * All profiles, used to resolve auto-learned context windows when no
   * profile is in scope (callers like `clients/openaiClient`,
   * `turnErrorRecovery` that operate on a bare model id).
   */
  allProfiles?: readonly ModelProfile[];
  extendedContext?: boolean;
}

type CatalogCapability =
  | 'compact'
  | 'maxEffort'
  | 'extendedContext'
  | 'thinkingAlwaysOn'
  | 'samplingParamsForbidden'
  | 'reasoningEffort';

/**
 * Find the most-recently-learned `auto` context window across all profiles
 * matching `model` (canonicalised via `normalizeForCapabilityCheck`).
 *
 * Tiebreak: prefer the highest `contextWindowLearnedAt` across all matches.
 * Returns undefined when no profile carries an auto-learned value for this
 * model. See docs/plans/260503_unify_learned_limits_into_profiles.md
 * — Cascade Resolution.
 */
export function getAutoLearnedContextWindowForModel(
  profiles: readonly ModelProfile[],
  model: string,
): number | undefined {
  const normalized = normalizeForCapabilityCheck(model);
  let best: { value: number; learnedAt: number } | undefined;
  for (const profile of profiles) {
    if (profile.contextWindowSource !== 'auto') continue;
    if (!profile.contextWindow) continue;
    if (!profile.model) continue;
    if (normalizeForCapabilityCheck(profile.model) !== normalized) continue;
    const learnedAt = profile.contextWindowLearnedAt ?? 0;
    if (!best || learnedAt > best.learnedAt) {
      best = { value: profile.contextWindow, learnedAt };
    }
  }
  return best?.value;
}

/**
 * Find the most-recently-learned `auto` output cap across all profiles
 * matching `model` (canonicalised via `normalizeForCapabilityCheck`).
 *
 * Reads `lastLearnedOutputTokens` only (not `maxOutputTokens`) so legacy
 * user-authored values are never mistaken for auto-learned runtime caps.
 */
export function getAutoLearnedOutputCapForModel(
  profiles: readonly ModelProfile[],
  model: string,
): number | undefined {
  const normalized = normalizeForCapabilityCheck(model);
  let best: { value: number; learnedAt: number } | undefined;
  for (const profile of profiles) {
    if (profile.outputTokensSource !== 'auto') continue;
    if (!profile.model) continue;
    if (normalizeForCapabilityCheck(profile.model) !== normalized) continue;
    if (!profile.lastLearnedOutputTokens) continue;
    const learnedAt = profile.outputTokensLearnedAt ?? 0;
    if (!best || learnedAt > best.learnedAt) {
      best = { value: profile.lastLearnedOutputTokens, learnedAt };
    }
  }
  return best?.value;
}

/**
 * Resolve token limits for a model. Resolution order (Stage 2b):
 * 1. Profile context window with source='user' (user override beats registry)
 * 2. Anthropic-specific model limits
 * 3. Cross-provider model presets
 * 4. Profile context window with source='auto' (the in-scope profile's learned value)
 * 5. Auto-learned by model id (any matching profile's learned value)
 * 6. Default fallback (200K)
 */
export function resolveModelLimits(input: ModelLimitsInput): ModelTokenLimits {
  const {
    model,
    profileMaxOutput,
    profileMaxOutputSource,
    profileContextWindow,
    profileContextWindowSource,
    allProfiles,
    extendedContext,
  } = input;
  const cleanModel = normalizeForCapabilityCheck(model);

  const anthropicMaxOutput = getAnthropicModelMaxOutput(cleanModel);
  const presetMaxOutput = getKnownMaxOutputForModel(cleanModel);
  const isUserSetMaxOutput = profileMaxOutputSource !== 'auto';
  const userSetMaxOutput = isUserSetMaxOutput ? profileMaxOutput : undefined;
  const autoLearnedMaxOutput = profileMaxOutputSource === 'auto'
    ? profileMaxOutput
    : undefined;
  const fallbackAutoLearnedOutput = allProfiles
    ? getAutoLearnedOutputCapForModel(allProfiles, cleanModel)
    : undefined;

  // Output-cap cascade (Stage 3):
  // 1) profile user override
  // 2) profile auto-learned cap (runtime truth)
  // 3) model-scoped auto-learned cap across profiles
  // 4) catalog defaults (Anthropic registry / known presets)
  // 5) hard fallback
  const maxOutputTokens = userSetMaxOutput
    ?? autoLearnedMaxOutput
    ?? fallbackAutoLearnedOutput
    ?? anthropicMaxOutput
    ?? presetMaxOutput
    ?? DEFAULT_MAX_OUTPUT_TOKENS;

  // Source split: user-set values beat the registry; auto-learned values
  // slot in below the registry/preset and above the default.
  // Legacy callers without an explicit source are treated as user-set.
  const isUserSetContextWindow = profileContextWindowSource !== 'auto';
  const userSetContextWindow = isUserSetContextWindow ? profileContextWindow : undefined;
  const autoLearnedContextWindow = profileContextWindowSource === 'auto'
    ? profileContextWindow
    : undefined;
  const fallbackAutoLearned = allProfiles
    ? getAutoLearnedContextWindowForModel(allProfiles, cleanModel)
    : undefined;
  const anthropicContextWindow = getAnthropicModelContextWindow(cleanModel);
  const presetContextWindow = getKnownContextWindowForModel(cleanModel);

  let contextWindow = userSetContextWindow
    ?? anthropicContextWindow
    ?? presetContextWindow
    ?? autoLearnedContextWindow
    ?? fallbackAutoLearned
    ?? DEFAULT_CONTEXT_WINDOW;

  // Extended context doubles to 1M for models that support it
  if (extendedContext && contextWindow < 1_000_000 && isExtendedContextModel(cleanModel)) {
    contextWindow = 1_000_000;
  }

  // Determine resolution source for diagnostic logging
  const contextWindowSource = userSetContextWindow ? 'profile-user'
    : anthropicContextWindow ? 'anthropic'
    : presetContextWindow ? 'preset'
    : autoLearnedContextWindow ? 'profile-auto'
    : fallbackAutoLearned ? 'model-auto'
    : 'default';
  const maxOutputSource = userSetMaxOutput ? 'profile-user'
    : autoLearnedMaxOutput ? 'profile-auto'
    : fallbackAutoLearnedOutput ? 'model-auto'
    : anthropicMaxOutput ? 'anthropic'
    : presetMaxOutput ? 'preset'
    : 'default';

  log.debug({
    model: cleanModel,
    contextWindow,
    maxOutputTokens,
    contextWindowSource,
    maxOutputSource,
    extendedContext: extendedContext ?? false,
  }, 'Model limits resolved');

  return { maxOutputTokens, contextWindow };
}

function getAnthropicModelMaxOutput(model: string): number | null {
  return getAnthropicMaxOutput(model);
}

function getAnthropicModelContextWindow(model: string): number | null {
  return getAnthropicContextWindow(model);
}

/**
 * Whether this model supports the Anthropic extended context beta (`[1m]` suffix).
 * This is Claude-specific — non-Claude models define their context windows in provider presets.
 */
/** @internal Exported for testing. */
export function isExtendedContextModel(model: string): boolean {
  return getCatalogCapabilityForModel(model, 'extendedContext');
}

// --- Model ID normalization ---

/**
 * Strip provider routing prefixes from model IDs so capability checks work
 * regardless of whether the model name is in Anthropic SDK format (claude-*)
 * or OpenRouter format (anthropic/claude-*).
 *
 * Also strips the [1m] extended-context suffix (existing behavior).
 *
 * Exported so the auto-learn writer and migration can produce a canonical
 * model id for matching profiles and minting `auto:<id>` profile ids.
 */
export function normalizeForCapabilityCheck(model: string): string {
  let clean = model.replace(/\[1[mM]\]$/, '').trim();
  if (clean.startsWith('anthropic/')) {
    clean = clean.slice('anthropic/'.length);
  }
  // Normalize dot-format version numbers to dashes ONLY for Claude models
  // (e.g. claude-opus-4.7 → claude-opus-4-7). Scoped to Claude to avoid breaking
  // preset lookups for non-Claude models keyed with dots (openai/gpt-5.4, etc.).
  if (/^claude-/i.test(clean)) {
    clean = clean.replace(/(\d)\.(\d)/g, '$1-$2');
  }
  return clean;
}

// --- Thinking configuration ---

export type RebelCoreThinkingConfig =
  | {
      type: 'adaptive';
      /**
       * Anthropic `thinking.display` — requests summarized thinking text in
       * the response stream. NEW with the Fable/Mythos always-on-thinking
       * generation (verified live → 200, 2026-06-11; see
       * docs/plans/260611_fable-5-support/PLAN.md Stage 3 (c)). Always-on
       * models default to `"omitted"`, which would leave Rebel's reasoning
       * surface empty through long adaptive thinks, so
       * `resolveThinkingConfig` opts them in. NEVER set this for models where
       * the param is unverified — Opus 4.8/4.7/4.6 and Sonnet 4.6 wire shapes
       * must stay byte-identical (no `display` key at all); only the
       * `isAlwaysOnThinkingModel` branch may populate it.
       */
      display?: 'summarized';
    }
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'disabled' };

/**
 * Suppression gate for reasoning/thinking emission (`shouldSuppressProfileReasoning`
 * / `resolveProfileReasoningEffort`). The implementation lives in shared
 * (`@shared/utils/reasoningSuppression`) so the renderer's read-only thinking
 * display can honour the exact same predicate the egress paths use — keeping the
 * wire and the UI from diverging (Sentry REBEL-5RJ). Re-exported here so the
 * model-reasoning consumers (clientFactory, localModelProxyServer, planningMode,
 * rebelCoreQuery, agentTurnExecute) keep a domain-local import path. NOTE: any test
 * that `vi.mock('../modelLimits')` (or `@core/rebelCore/modelLimits`) with a partial
 * factory must also stub these two — vitest throws on access to an unstubbed
 * re-export even when the consumer imports from elsewhere.
 *
 * @see docs/project/CUSTOM_GATEWAY_COMPATIBILITY.md
 */
export {
  shouldSuppressProfileReasoning,
  resolveProfileReasoningEffort,
} from '@shared/utils/reasoningSuppression';

/**
 * Map this repo's ThinkingEffort to the provider API effort level.
 * This repo uses 'xhigh' but the API uses 'max' (only for models that support it).
 */
export function resolveEffortForApi(
  effort: ThinkingEffort | undefined,
  model: string,
): 'low' | 'medium' | 'high' | 'max' | undefined {
  if (!effort) return undefined;
  if (!supportsEffort(model)) return undefined;
  if (effort === 'xhigh') {
    return supportsMaxEffort(model) ? 'max' : 'high';
  }
  return effort;
}

/**
 * Resolve thinking configuration based on model capabilities.
 * - Opus 4.8/4.7/4.6 and Fable 5: adaptive thinking (budget_tokens deprecated;
 *   Fable's thinking is always-on — explicit `disabled` would 400, but the
 *   client boundary omits `disabled` configs so this stays wire-safe)
 * - Always-on-thinking models (Fable 5) additionally get
 *   `display: 'summarized'` so their thinking streams to Rebel's reasoning
 *   surface (their default is `"omitted"`); Opus keeps plain adaptive — the
 *   `display` param is unverified there (see RebelCoreThinkingConfig JSDoc)
 * - Sonnet 4.6 / older Claude with thinking: manual budget_tokens
 * - Non-Claude: disabled (they use reasoning_effort via proxy)
 */
export function resolveThinkingConfig(
  effort: ThinkingEffort | undefined,
  model: string,
  maxOutputTokens: number,
): RebelCoreThinkingConfig {
  if (!effort || effort === 'low') return { type: 'disabled' };

  const cleanModel = normalizeForCapabilityCheck(model);

  // Intentional provider-specific capability check: Anthropic thinking config
  // (budget_tokens, adaptive) only applies to Claude models. Non-Claude reasoning
  // models use reasoning_effort in the request body, handled by the proxy/client layer.
  // normalizeForCapabilityCheck strips provider prefixes (e.g. anthropic/claude-*)
  // so this check works for both Anthropic SDK and OpenRouter model ID formats.
  if (!cleanModel.startsWith('claude-')) return { type: 'disabled' };

  // Opus 4.6/4.7/4.8, Fable 5: use adaptive thinking.
  if (supportsMaxEffort(cleanModel)) {
    // Always-on-thinking models default to display:"omitted" — opt in to
    // summarized display so the reasoning surface isn't empty (Stage 5,
    // docs/plans/260611_fable-5-support). Scoped to always-on models ONLY:
    // Opus wire shape stays byte-identical (`display` unverified there).
    if (isAlwaysOnThinkingModel(cleanModel)) {
      return { type: 'adaptive', display: 'summarized' };
    }
    return { type: 'adaptive' };
  }

  // Other Claude models: manual budget_tokens
  // budget_tokens must be >= 1024 and < max_tokens
  const budgetRatio = effort === 'xhigh' ? 0.8 : effort === 'high' ? 0.6 : 0.4;
  const budget = Math.max(1024, Math.floor(maxOutputTokens * budgetRatio));
  // Ensure budget < maxOutputTokens (API requirement)
  const safeBudget = Math.min(budget, maxOutputTokens - 1);
  if (safeBudget < 1024) return { type: 'disabled' };

  return { type: 'enabled', budget_tokens: safeBudget };
}

/**
 * Whether this model supports the reasoning-`effort` API parameter at all
 * (Anthropic `effort` / OpenAI `reasoning_effort` / Gemini `thinking_config`).
 *
 * Catalog-first SSOT: resolves the per-model `supportsReasoningEffort` catalog
 * field (with `supportsMaxEffort ⇒ true`, since a model accepting `effort: max`
 * necessarily accepts the `effort` parameter). New rostered models set the field
 * — no regex edit here.
 *
 * Un-rostered fallback only: ids absent from the catalog fall back to the
 * historical family regexes (`legacyCapabilityRegexMatch` / `reasoningEffort`),
 * preserving behavior for never-before-seen spellings:
 * - Claude Opus and Sonnet — any name-first id (`claude-opus-*` /
 *   `claude-sonnet-*`), version-agnostic — via Anthropic `effort`
 * - OpenAI GPT-5.x reasoning + o-series (o3, o4) — via `reasoning_effort`
 * - Google Gemini reasoning (2.5+, not flash-lite) — via `thinking_config`
 *
 * Not supported: Haiku, legacy version-first Claude ids (`claude-3-5-sonnet-*`),
 * GPT-4.1 (non-reasoning), o1, non-reasoning open-source models.
 */
/** @internal Exported for testing. */
export function supportsEffort(model: string): boolean {
  return getCatalogCapabilityForModel(model, 'reasoningEffort');
}

function legacyCapabilityRegexMatch(cleanModel: string, capability: CatalogCapability): boolean {
  if (capability === 'compact') {
    return /^claude-(opus-4-[678]|sonnet-4-6)(?:-|$)/i.test(cleanModel);
  }
  if (capability === 'maxEffort') {
    return /^claude-opus-4-[67](?:-|$)/i.test(cleanModel);
  }
  if (capability === 'thinkingAlwaysOn') {
    // No legacy (pre-catalog) model has always-on thinking; unknown/unrostered
    // ids fall back to false (thinking can be disabled; sampling allowed).
    return false;
  }
  if (capability === 'samplingParamsForbidden') {
    // Sampling-param rejection is catalog-only. Unknown/unrostered ids keep
    // legacy behavior: do not strip temperature/top_p/top_k unless verified.
    return false;
  }
  if (capability === 'reasoningEffort') {
    // Un-rostered fallback ONLY: the catalog field (`supportsReasoningEffort`)
    // is the SSOT for rostered ids. These family regexes are the verbatim
    // predicate `supportsEffort` used before the catalog field landed, kept so
    // never-before-seen ids still resolve the same. Mirrors `supportsEffort`'s
    // normalize-then-bare split: Claude matches the normalized id; non-Claude
    // families match after stripping any OpenRouter provider prefix.
    if (/^claude-(opus|sonnet)-/i.test(cleanModel)) return true;
    const bare = cleanModel.includes('/') ? (cleanModel.split('/').pop() ?? cleanModel) : cleanModel;
    if (/^gpt-5/i.test(bare)) return true; // OpenAI GPT-5.x reasoning
    if (/^o[34]/i.test(bare)) return true; // OpenAI o-series (o3, o4)
    if (/^gemini-(2\.5|3)/i.test(bare) && !/flash-lite/i.test(bare)) return true; // Gemini reasoning
    return false;
  }
  return /^claude-(opus-4-[67]|sonnet-4-6)(?:-|$)/i.test(cleanModel);
}

/**
 * Catalog-first capability resolution with behavior-preserving regex fallback.
 *
 * Resolution order:
 * 1) normalizeForCapabilityCheck(model)
 * 2) strip trailing dated suffix for catalog lookup only
 * 3) resolve catalog entry by canonical id or alias
 * 4) if not found in catalog, fall back to the legacy per-capability regex
 */
/** @internal Exported for testing. */
export function getCatalogCapabilityForModel(model: string, capability: CatalogCapability): boolean {
  const cleanModel = normalizeForCapabilityCheck(model);
  const lookupModel = cleanModel.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  const aliasMap = getCatalogAliasMap();
  const canonicalModelId = aliasMap[lookupModel] ?? lookupModel;
  const catalogEntry = getCatalogEntryById(canonicalModelId);

  if (catalogEntry) {
    if (capability === 'compact') return catalogEntry.supportsCompact ?? false;
    if (capability === 'maxEffort') return catalogEntry.supportsMaxEffort ?? false;
    if (capability === 'reasoningEffort') {
      // A model accepting `effort: max` necessarily accepts the `effort`
      // parameter (mirrors the catalog short-circuit in `supportsEffort`).
      return (catalogEntry.supportsReasoningEffort ?? false) || (catalogEntry.supportsMaxEffort ?? false);
    }
    if (capability === 'thinkingAlwaysOn') return catalogEntry.thinkingAlwaysOn ?? false;
    if (capability === 'samplingParamsForbidden') {
      return (catalogEntry.samplingParamsForbidden ?? false) || (catalogEntry.thinkingAlwaysOn ?? false);
    }
    return catalogEntry.supportsExtendedContext ?? false;
  }

  return legacyCapabilityRegexMatch(cleanModel, capability);
}

/**
 * Whether this model supports the `max` effort level.
 * Currently Opus 4.6, 4.7 and 4.8.
 */
/** @internal Exported for testing. */
export function supportsMaxEffort(model: string): boolean {
  return getCatalogCapabilityForModel(model, 'maxEffort');
}

/**
 * Whether this model supports Anthropic's `compact_20260112` context strategy.
 * Catalog flags are the SSOT for rostered models; unknown/unrostered IDs fall
 * back to the legacy regex to preserve current behavior.
 */
export function supportsCompact(model: string): boolean {
  return getCatalogCapabilityForModel(model, 'compact');
}

/**
 * Whether this model's thinking is ALWAYS ON and cannot be disabled
 * (catalog `thinkingAlwaysOn` flag, e.g. Claude Fable 5).
 *
 * Always-on implies the model rejects sampling params
 * (`temperature`/`top_p`/`top_k`) and explicit `thinking: {type:'disabled'}`
 * with a 400 — consumed by the BTS options sanitizer
 * (`sanitizeBtsOptionsForWireModel`) and the wire-shape assertion
 * (`assertWireSafeForAlwaysOnThinking`). Handles `anthropic/` prefixes,
 * the `[1m]` suffix, and dated-suffix forms via the shared normalization in
 * `getCatalogCapabilityForModel`. Unknown/unrostered ids ⇒ `false`.
 *
 * SIBLING PREDICATE (F4 / STAGE0): `isAlwaysOnThinkingCatalogModel()` in
 * `@shared/data/modelCatalog.ts` answers the same question for the cost-consent /
 * src/shared surfaces (which must NOT import this core module). It additionally
 * resolves `openRouter.legacyIds` + the `openRouter.sdkModel` hop, so it can see
 * OR-shaped spellings this helper's alias-map-only resolution would miss. The two are
 * kept SEPARATE on purpose (different semantic contexts: wire-shape sanitizers here vs
 * cost-consent there) but their AGREEMENT over the catalog is pinned by the F4 parity
 * test in `__tests__/modelLimits.test.ts`. If you change resolution here, update that
 * test and the sibling's docstring.
 */
export function isAlwaysOnThinkingModel(model: string): boolean {
  return getCatalogCapabilityForModel(model, 'thinkingAlwaysOn');
}

/**
 * Whether this model rejects sampling params (`temperature`/`top_p`/`top_k`)
 * with a 400. Covers Claude Fable 5 plus Opus 4.7/4.8, so it is broader than
 * {@link isAlwaysOnThinkingModel}: Fable is always-on-thinking, but Opus
 * 4.7/4.8 forbid sampling params without requiring always-on thinking.
 */
export function isSamplingParamsForbiddenModel(model: string): boolean {
  return getCatalogCapabilityForModel(model, 'samplingParamsForbidden');
}
