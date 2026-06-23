/**
 * Pricing calculator for model API costs.
 *
 * Calculates costs from token counts based on model-specific pricing.
 * Returns null for unknown models rather than 0 to distinguish
 * "no cost" from "unable to calculate cost".
 *
 * Model pricing data is defined in the unified model catalog at
 * `src/shared/data/modelCatalog.ts`. When adding a new model, update
 * the catalog — MODEL_PRICING and MODEL_ALIASES are derived automatically.
 *
 * Pricing: see modelCatalog.ts for canonical pricing data and last-verified dates.
 *
 * SCOPE — this is the APP's per-provider pricing (actual cost paid, incl. the
 * specific provider/route). The knowledge-work EVAL deliberately does NOT use this:
 * it prices every model at a provider-agnostic canonical rate via
 * `evals/eval-model-pricing.ts` so the Pareto frontier compares models, not
 * providers. See docs/project/TESTING_EVALS_KNOWLEDGE_WORK_COSTS.md for the policy.
 *
 * @see docs/project/COST_TRACKING.md — how computed pricing feeds cost accounting
 * @see docs/project/MODEL_REGISTRIES.md — pricing tables derive from the unified MODEL_CATALOG
 */

import { getCatalogPricingMap, getCatalogAliasMap, type ModelPricingInfo } from '../data/modelCatalog';
import { resolveOrModelToSdkId } from '../data/openRouterModels';

import type { CostTier, ModelProviderType } from '@shared/types';

// Pricing per million tokens (MTok) in USD
type ModelPricing = ModelPricingInfo;

/**
 * Model pricing table.
 * Derived from the unified model catalog. Dated snapshots are resolved via MODEL_ALIASES.
 */
const MODEL_PRICING: Record<string, ModelPricing> = getCatalogPricingMap();

/**
 * Map of dated model snapshots to their canonical alias.
 * Derived from the unified model catalog.
 */
const MODEL_ALIASES: Record<string, string> = getCatalogAliasMap();

/**
 * Resolve a model name to its canonical alias for pricing lookup.
 * Handles both aliases (claude-haiku-4-5) and dated snapshots (claude-haiku-4-5-20241022).
 */
export function resolveModelAlias(model: string): string | null {
  const normalizedModel = model.toLowerCase().trim();

  // Check if it's already a canonical alias
  if (MODEL_PRICING[normalizedModel]) {
    return normalizedModel;
  }

  // Check if it's a known dated snapshot
  if (MODEL_ALIASES[normalizedModel]) {
    return MODEL_ALIASES[normalizedModel];
  }

  // Try pattern matching for unknown dated versions
  // e.g., 'claude-haiku-4-5-20251231' should match 'claude-haiku-4-5'
  for (const alias of Object.keys(MODEL_PRICING)) {
    // Match if the model starts with the alias followed by a date pattern
    if (normalizedModel.startsWith(alias + '-')) {
      // Verify it's a date pattern (YYYYMMDD or YYYY-MM-DD)
      const suffix = normalizedModel.slice(alias.length + 1);
      if (/^\d{8}$/.test(suffix) || /^\d{4}-\d{2}-\d{2}$/.test(suffix)) {
        return alias;
      }
    }
  }

  // Also check for [1m] suffix (extended context)
  const withoutSuffix = normalizedModel.replace(/\[1m\]$/, '');
  if (withoutSuffix !== normalizedModel) {
    return resolveModelAlias(withoutSuffix);
  }

  // Try OpenRouter model name resolution (e.g., 'anthropic/claude-4.7-opus-20260416' → 'claude-opus-4-7')
  if (normalizedModel.includes('/')) {
    const sdkId = resolveOrModelToSdkId(normalizedModel);
    if (sdkId) return resolveModelAlias(sdkId);
  }

  return null;
}

/**
 * Calculate the cost for an API call based on token usage.
 *
 * Returns null for unknown models (expected for custom/local models).
 * Throws on invalid token data (NaN, negative, Infinity) — always a bug upstream.
 *
 * For fire-and-forget call sites that should never throw, use {@link calculateCostOrWarn}
 * which wraps this function with try/catch and centralized warn-once logging.
 *
 * @param model - The model name (alias or dated snapshot)
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @param cacheCreationTokens - Optional: tokens used to create cache entries
 * @param cacheReadTokens - Optional: tokens read from cache
 * @returns Cost in USD, or null if model is unknown
 * @throws Error if any token count is NaN, negative, or Infinity
 *
 * @example
 * // Basic usage
 * const cost = calculateCost('claude-haiku-4-5', 1000, 500);
 *
 * @example
 * // With cache tokens
 * const cost = calculateCost('claude-sonnet-4-6', 10000, 2000, 5000, 3000);
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens?: number,
  cacheReadTokens?: number
): number | null {
  // Validate token counts - must be finite non-negative numbers.
  // Invalid tokens are always a bug upstream (corrupted API response, parsing error).
  if (!Number.isFinite(inputTokens) || inputTokens < 0) {
    throw new Error(`Invalid inputTokens: ${inputTokens}. Token counts must be finite non-negative numbers.`);
  }
  if (!Number.isFinite(outputTokens) || outputTokens < 0) {
    throw new Error(`Invalid outputTokens: ${outputTokens}. Token counts must be finite non-negative numbers.`);
  }
  if (cacheCreationTokens != null && (!Number.isFinite(cacheCreationTokens) || cacheCreationTokens < 0)) {
    throw new Error(`Invalid cacheCreationTokens: ${cacheCreationTokens}. Token counts must be finite non-negative numbers.`);
  }
  if (cacheReadTokens != null && (!Number.isFinite(cacheReadTokens) || cacheReadTokens < 0)) {
    throw new Error(`Invalid cacheReadTokens: ${cacheReadTokens}. Token counts must be finite non-negative numbers.`);
  }

  // Resolve model alias
  const alias = resolveModelAlias(model);
  if (!alias) {
    return null; // Unknown model
  }

  const pricing = MODEL_PRICING[alias];
  if (!pricing) {
    return null; // Should not happen if resolveModelAlias worked correctly
  }

  // Calculate cost components (pricing is per MTok, so divide by 1,000,000)
  const MTOK = 1_000_000;

  const inputCost = (inputTokens / MTOK) * pricing.input;
  const outputCost = (outputTokens / MTOK) * pricing.output;
  const cacheCreationCost = cacheCreationTokens
    ? (cacheCreationTokens / MTOK) * pricing.cacheCreation
    : 0;
  const cacheReadCost = cacheReadTokens ? (cacheReadTokens / MTOK) * pricing.cacheRead : 0;

  return inputCost + outputCost + cacheCreationCost + cacheReadCost;
}

/**
 * Get the pricing information for a model.
 * Useful for displaying pricing to users or debugging.
 *
 * @param model - The model name (alias or dated snapshot)
 * @returns Pricing info or null if model is unknown
 */
export function getModelPricing(model: string): ModelPricing | null {
  const alias = resolveModelAlias(model);
  if (!alias) return null;
  return MODEL_PRICING[alias] ?? null;
}

/** Compute cost tier from MODEL_CATALOG pricing (alias-aware). Returns null if unknown. */
export function getModelCostTier(modelId: string): CostTier | null {
  const pricing = getModelPricing(modelId);
  if (!pricing) return null;
  const outputCost = pricing.output;
  if (outputCost < 2) return 'economy';
  if (outputCost <= 20) return 'mid-tier';
  return 'premium';
}

export function resolveProfileCostTier(profile: {
  costTier?: CostTier;
  model?: string;
  providerType?: ModelProviderType;
  presetKey?: string;
}): CostTier | null {
  if (profile.costTier) return profile.costTier;
  if (profile.model) {
    const catalogTier = getModelCostTier(profile.model);
    if (catalogTier) return catalogTier;
  }
  if (profile.providerType === 'local') return 'economy';
  return null;
}

/**
 * Check if a model is supported for cost calculation.
 *
 * @param model - The model name to check
 * @returns true if the model's pricing is known
 */
export function isModelSupported(model: string): boolean {
  return resolveModelAlias(model) !== null;
}

/**
 * Get a list of all supported model aliases.
 * Useful for displaying to users or validation.
 */
export function getSupportedModels(): string[] {
  return Object.keys(MODEL_PRICING);
}

// ─── Fire-and-forget safe wrapper ──────────────────────────────────────────

/** Minimal logger interface — avoids importing Pino types into shared code. */
interface CostLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** Module-level warn-once set shared across all callers. */
const _warnedUnpricedModels = new Set<string>();

/** Reset the warn-once set. Exported for testing only. */
export function _resetWarnedModelsForTesting(): void {
  _warnedUnpricedModels.clear();
}

/**
 * Calculate cost with built-in warn-once handling for unknown models
 * and try/catch safety for invalid token data.
 *
 * - Returns the cost number on success
 * - Returns null for unknown models (logs warn once per model per process)
 * - Catches invalid-token throws from {@link calculateCost} and returns null
 *   (logs error — always a bug upstream)
 *
 * Use this for fire-and-forget call sites where cost tracking must never
 * break the main flow. Use {@link calculateCost} directly when you want
 * throws for dev/test visibility.
 *
 * @param model - The model name
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @param logger - Logger with warn/error methods (Pino-compatible argument order)
 * @param context - Context string for the warning message (e.g., 'enhancement', 'warmup')
 * @param cacheCreationTokens - Optional cache creation tokens
 * @param cacheReadTokens - Optional cache read tokens
 */
export function calculateCostOrWarn(
  model: string,
  inputTokens: number,
  outputTokens: number,
  logger: CostLogger,
  context?: string,
  cacheCreationTokens?: number,
  cacheReadTokens?: number,
): number | null {
  let cost: number | null;
  try {
    cost = calculateCost(model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens);
  } catch (err) {
    logger.error(
      { model, context: context ?? 'unknown', err: err instanceof Error ? err.message : String(err) },
      'calculateCost threw — invalid token data (bug)',
    );
    return null;
  }

  if (cost === null && !_warnedUnpricedModels.has(model)) {
    _warnedUnpricedModels.add(model);
    logger.warn(
      { model, context: context ?? 'unknown' },
      'Model has no pricing in MODEL_CATALOG — cost tracking skipped',
    );
  }

  return cost;
}
