/**
 * Codex (ChatGPT Pro Subscription) Model Catalog
 *
 * Curated list of OpenAI models available via Codex/ChatGPT Pro subscription.
 * Used by the Settings UI for provider-aware dropdowns when Codex is the active provider.
 *
 * Follows the same pattern as `openRouterModels.ts` (OR_MAIN_MODEL_OPTIONS, etc.)
 * but uses bare OpenAI model IDs (no provider prefix).
 *
 * @see docs/plans/260504_unified_provider_model_presentation.md
 */

import type { ModelOption } from './modelProviderPresets';

/** Frontier reasoning models for Codex — suitable for thinking/working roles. */
export const CODEX_MAIN_MODEL_OPTIONS: ModelOption[] = [
  { value: 'gpt-5.5', label: 'GPT-5.5', description: 'Latest frontier reasoning model' },
  { value: 'gpt-5.4', label: 'GPT-5.4', description: 'Strong frontier reasoning, lower cost' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', description: 'Best for code-heavy work' },
  { value: 'gpt-5.2', label: 'GPT-5.2', description: 'Strong coding and agentic tasks' },
  { value: 'gpt-5.1', label: 'GPT-5.1', description: 'Strong general-purpose reasoning' },
  { value: 'gpt-5', label: 'GPT-5', description: 'Capable reasoning, lower cost' },
];

/** Smaller/cheaper models for Codex — suitable for behind-the-scenes tasks. */
export const CODEX_AUXILIARY_MODEL_OPTIONS: ModelOption[] = [
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'Fast, cost-efficient frontier reasoning' },
  { value: 'gpt-5.4-nano', label: 'GPT-5.4 nano', description: 'Fastest, cheapest frontier reasoning' },
  { value: 'gpt-5-mini', label: 'GPT-5 mini', description: 'Fast, cost-efficient reasoning' },
  { value: 'gpt-5-nano', label: 'GPT-5 nano', description: 'Fastest, cheapest reasoning' },
  { value: 'gpt-4.1', label: 'GPT-4.1', description: 'Smartest non-reasoning model' },
  { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini', description: 'Fast non-reasoning' },
  { value: 'gpt-4.1-nano', label: 'GPT-4.1 nano', description: 'Fastest, cheapest non-reasoning' },
];

/** All Codex model options — union of main + auxiliary. */
export const CODEX_ALL_MODEL_OPTIONS: ModelOption[] = [
  ...CODEX_MAIN_MODEL_OPTIONS,
  ...CODEX_AUXILIARY_MODEL_OPTIONS,
];

// REBEL-520: Codex with a ChatGPT account rejects gpt-5.5-pro even though it
// exists in the general OpenAI/OpenRouter catalogs. Keep a narrow deny-list so
// stale settings fail before they reach the Codex proxy without blocking future
// ChatGPT-supported models that are not yet listed here.
const CODEX_CHATGPT_UNSUPPORTED_MODEL_IDS = new Set(['gpt-5.5-pro']);

export function isCodexModelSupported(modelId: string): boolean {
  const normalizedModelId = modelId.trim().toLowerCase().replace(/^openai\//, '');
  return !CODEX_CHATGPT_UNSUPPORTED_MODEL_IDS.has(normalizedModelId);
}

/**
 * Is this model id one the Codex (ChatGPT Pro) proxy can actually SERVE on the
 * wire? The proxy speaks a single dialect — bare OpenAI-compatible ids: the
 * `gpt-*` family and the true o-series (`o3`, `o4-mini`, …). It cannot serve a
 * slash-namespaced OpenRouter id (`deepseek/…`, `openai/gpt-5.5`) nor a bare
 * non-OpenAI id (`gemini-2.5-flash`, `claude-*`).
 *
 * memory-BTS route mismatch (rebel://conversation/mobile-1782164402735-51bh8pna):
 * BOTH codex route arms (active-provider + subscription-profile) must gate
 * dispatch on this predicate — `isCodexModelSupported` alone is a deny-list that
 * admits every non-`gpt-5.5-pro` id, so a foreign-dialect override/profile model
 * fell through to a dispatchable codex-proxy decision and either threw "routing
 * mismatch" at the wire (`anthropicClient.ts:802`) for slash ids or dispatched
 * SILENTLY to the wrong proxy for bare non-OpenAI ids.
 *
 * PRECISION (Stage 2b GPT must-address): we deliberately do NOT reuse
 * `toModelDialect`'s broad `startsWith('o')` rule, which admits non-codex bare
 * ids like `ollama:llama3` / `omni-foo`. The o-series check is the precise
 * `^o\d` family. We also gate on the existing `gpt-5.5-pro` deny-list so a
 * not-actually-served `gpt-*` id still terminals.
 *
 * Kept narrow and LOCAL in intent (codex route arms only): does NOT replace
 * `isCodexModelSupported`, which is consumed by proxy egress remap +
 * settings validation where a different (deny-list) semantics is required.
 */
export function isCodexServableModel(modelId: string): boolean {
  const trimmedLower = modelId.trim().toLowerCase();
  // ANY slash-namespaced id is non-servable — including `openai/gpt-5.5`. The wire
  // body keeps the slash form (`brandRouteWireModel` does not strip the prefix), so
  // it would still throw at the non-passthrough Anthropic wire (`anthropicClient.ts:802`).
  // Do NOT normalize `openai/` away here (that is `isCodexModelSupported`'s deny-list
  // normalization, a different concern): a slash id must be re-shaped to the bare
  // form by the selection layer, not silently admitted. (The fallback rebuild that
  // hands a slash `openai/gpt-5.5` instead of bare `gpt-5.5` is the spun-out
  // dialect-aware-selection concern; the terminal here is the safe interim.)
  if (trimmedLower.includes('/')) return false;
  // PRECISE bare OpenAI-compatible shape: `gpt-*` family or the true o-series
  // (`^o\d` — `o3`, `o4-mini`, …), NOT the broad `startsWith('o')` that admits
  // `ollama:`/`omni-*` (Stage 2b GPT must-address). Also honour the existing
  // `gpt-5.5-pro` deny-list (REBEL-520).
  const isBareOpenAiCompatible = trimmedLower.startsWith('gpt-') || /^o\d/.test(trimmedLower);
  return isBareOpenAiCompatible && isCodexModelSupported(trimmedLower);
}
