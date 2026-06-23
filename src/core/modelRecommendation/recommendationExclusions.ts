/**
 * Explicit recommendation EXCLUSIONS (Stage 3, DECISION E — inverted catalog-rot guard).
 *
 * The inverted rot guard (see `recommendModels.test.ts`) enumerates every addable
 * `PROVIDER_CATALOGS` row and requires each to be EITHER covered by recommendation
 * metadata (`recommendationMetadata.ts`) OR present here with a reason. This inverts
 * the old "eligible-flag-inside-metadata" approach, which could not catch omissions
 * (a new catalog model with no metadata row was simply never flagged eligible, so the
 * old test passed silently).
 *
 * When you add a model to the catalog you MUST either give it recommendation metadata
 * or add an exclusion entry here — the guard fails CI otherwise. This is the real
 * "did someone add a model without curating it" guard that slots into
 * NEW_MODEL_SUPPORT_PROCESS.
 *
 * Keyed by `normalizeCatalogModelId(catalog.model)` — the same normalized id the
 * addable row carries (slash-id forms keep their slash; bare forms stay bare).
 *
 * PURE: no electron import.
 *
 * @see docs/plans/260614_recommended-models-engine/PLAN.md (Stage 3, DECISION E)
 */

export interface RecommendationExclusion {
  /** Why this addable row is intentionally NOT in the recommended shortlist. */
  readonly reason: string;
}

/**
 * Addable rows intentionally left out of the "Recommended for most people" set.
 * Reasons fall into a few buckets:
 *  - prior-generation / superseded variants (we recommend the latest in the family);
 *  - smaller / cheaper sub-variants of a family whose flagship is already covered;
 *  - legacy or niche models we don't surface to non-technical users.
 *
 * NOTE: a family's flagship being covered by metadata does NOT auto-exclude its
 * siblings — each sibling addable row must be listed explicitly so the guard stays
 * honest about omissions.
 */
const RECOMMENDATION_EXCLUSION_LIST: Readonly<Record<string, RecommendationExclusion>> =
  Object.freeze({
    // --- Anthropic: prior generation ---
    'claude-opus-4-6': { reason: 'Prior-generation Opus; superseded by Opus 4.7/4.8 in the shortlist.' },
    'anthropic/claude-opus-4-6': { reason: 'Prior-generation Opus (OpenRouter form); superseded.' },

    // --- OpenAI / Codex: non-flagship + prior generation ---
    'gpt-5.4': { reason: 'Prior-generation GPT; GPT-5.5 is the recommended flagship.' },
    'gpt-5.3-codex': { reason: 'Coding-tuned variant; not a general knowledge-worker pick.' },
    'gpt-5.2': { reason: 'Prior-generation GPT; superseded by GPT-5.5.' },
    'gpt-5.1': { reason: 'Prior-generation GPT; superseded by GPT-5.5.' },
    'gpt-5': { reason: 'Prior-generation GPT; superseded by GPT-5.5.' },
    'gpt-5.4-mini': { reason: 'Smaller sub-variant; not surfaced in the curated shortlist.' },
    'gpt-5.4-nano': { reason: 'Smaller sub-variant; not surfaced in the curated shortlist.' },
    'gpt-5-mini': { reason: 'Smaller sub-variant; not surfaced in the curated shortlist.' },
    'gpt-5-nano': { reason: 'Smaller sub-variant; not surfaced in the curated shortlist.' },
    'gpt-4.1': { reason: 'Legacy GPT-4.1 family; superseded by GPT-5.x.' },
    'gpt-4.1-mini': { reason: 'Legacy GPT-4.1 family; superseded.' },
    'gpt-4.1-nano': { reason: 'Legacy GPT-4.1 family; superseded.' },
    'openai/gpt-5.5-pro': { reason: 'Premium GPT-5.5 variant; not a default knowledge-worker pick.' },
    'openai/gpt-5.4': { reason: 'Prior-generation GPT (OpenRouter form); superseded.' },
    'openai/gpt-5.3-codex': { reason: 'Coding-tuned variant (OpenRouter form).' },
    'openai/gpt-5.2': { reason: 'Prior-generation GPT (OpenRouter form); superseded.' },
    'openai/gpt-5.1': { reason: 'Prior-generation GPT (OpenRouter form); superseded.' },
    'openai/gpt-5': { reason: 'Prior-generation GPT (OpenRouter form); superseded.' },
    'openai/gpt-5-mini': { reason: 'Smaller sub-variant (OpenRouter form).' },
    'openai/gpt-5-nano': { reason: 'Smaller sub-variant (OpenRouter form).' },
    'openai/gpt-5.4-mini': { reason: 'Smaller sub-variant (OpenRouter form).' },
    'openai/gpt-5.4-nano': { reason: 'Smaller sub-variant (OpenRouter form).' },
    'openai/gpt-4.1': { reason: 'Legacy GPT-4.1 family (OpenRouter form); superseded.' },
    'openai/gpt-4.1-mini': { reason: 'Legacy GPT-4.1 family (OpenRouter form); superseded.' },
    'openai/gpt-4.1-nano': { reason: 'Legacy GPT-4.1 family (OpenRouter form); superseded.' },
    'openai/o3': { reason: 'Legacy OpenAI reasoning model; not surfaced.' },
    'openai/o3-pro': { reason: 'Legacy OpenAI reasoning model; not surfaced.' },
    'openai/o4-mini': { reason: 'Legacy OpenAI reasoning model; not surfaced.' },

    // --- Google / Gemini: non-flagship + prior generation ---
    // (gemini-3.1-pro-preview / gemini-3-flash-preview ARE covered: they canonicalize
    //  to gemini-3.1-pro / gemini-3-flash, which the metadata is keyed on.)
    'gemini-3.1-flash-lite-preview': { reason: 'Flash-lite sub-variant; the flagship Gemini Flash is covered.' },
    'gemini-2.5-pro': { reason: 'Prior-generation Gemini; superseded by 3.x.' },
    'gemini-2.5-flash': { reason: 'Prior-generation Gemini; superseded by 3.x.' },
    'gemini-2.5-flash-lite': { reason: 'Prior-generation Gemini; superseded by 3.x.' },
    'google/gemini-3.1-flash-lite-preview': { reason: 'Flash-lite sub-variant (OpenRouter form).' },
    'google/gemini-2.5-pro': { reason: 'Prior-generation Gemini (OpenRouter form).' },
    'google/gemini-2.5-flash': { reason: 'Prior-generation Gemini (OpenRouter form).' },
    'google/gemini-2.5-flash-lite': { reason: 'Prior-generation Gemini (OpenRouter form).' },

    // --- OpenRouter: other families without trustworthy KW data / non-flagship ---
    'deepseek/deepseek-v3.2': { reason: 'Prior-generation DeepSeek; v4 Flash/Pro are the recommended picks.' },
    'deepseek/deepseek-r1-0528': { reason: 'Legacy DeepSeek reasoning model; superseded by v4.' },
    'x-ai/grok-4.20': { reason: 'Grok family has no KW eval data and is not editorially seeded this run.' },
    'x-ai/grok-4.1-fast': { reason: 'Grok family has no KW eval data; not seeded.' },
    'moonshotai/kimi-k2.5': { reason: 'Prior-generation Kimi; k2.6 is the recommended pick.' },
    'minimax/minimax-m2.7': { reason: 'Prior-generation MiniMax; m3 is the recommended pick.' },
    'z-ai/glm-5.2': { reason: 'Newest GLM, but no KW eval data yet; the eval-grounded 5.1 remains the recommended pick.' },
    'z-ai/glm-5-turbo': { reason: 'Sub-variant; GLM 5.1 is the recommended pick.' },
    'z-ai/glm-5': { reason: 'Prior-generation GLM; 5.1 is the recommended pick.' },
    'z-ai/glm-4.7': { reason: 'Prior-generation GLM; superseded by 5.1.' },
    'z-ai/glm-4.7-flash': { reason: 'Prior-generation GLM; superseded by 5.1.' },
  });

/** All explicit recommendation exclusions (frozen). */
export const RECOMMENDATION_EXCLUSIONS: Readonly<Record<string, RecommendationExclusion>> =
  RECOMMENDATION_EXCLUSION_LIST;

/** Whether a normalized catalog id is explicitly excluded from recommendations. */
export function isRecommendationExcluded(normalizedCatalogId: string): boolean {
  return Object.prototype.hasOwnProperty.call(RECOMMENDATION_EXCLUSION_LIST, normalizedCatalogId);
}
