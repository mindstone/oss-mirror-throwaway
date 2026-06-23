/**
 * Provider Catalogs — single source of truth for curated model rows.
 *
 * Reshapes the existing per-provider catalogs (`MODEL_OPTIONS`,
 * `CODEX_*_MODEL_OPTIONS`, `PROVIDER_PRESETS.google.models`,
 * `OR_MODEL_CATALOG`) into a uniform `CatalogEntry[]` per provider, stamped
 * with the `routeSurface` that distinguishes a Codex subscription row
 * (`'subscription'`) from a direct OpenAI API key row (`'api-key'`) — the two
 * have the same `(providerType, model)` but bill completely differently.
 *
 * Stage 4 of `docs/plans/260504_unified_provider_model_presentation.md` uses
 * `(providerType, routeSurface, normalizedModelId)` as the dedup key when
 * merging curated rows with user-managed profiles.
 *
 * This module is a pure consumer: no upstream catalog (`MODEL_CATALOG`,
 * `MODEL_OPTIONS`, `CODEX_*_MODEL_OPTIONS`, `PROVIDER_PRESETS`,
 * `OR_MODEL_CATALOG`) is mutated. Adding a new model upstream automatically
 * propagates here.
 */

import type { ModelProfile, RouteSurface } from '../types/settings';
import { MODEL_OPTIONS } from '../utils/modelNormalization';
import {
  CODEX_AUXILIARY_MODEL_OPTIONS,
  CODEX_MAIN_MODEL_OPTIONS,
} from './codexModels';
import { PROVIDER_PRESETS } from './modelProviderPresets';
import { OR_MODEL_CATALOG } from './openRouterModels';

export type CatalogProviderType = 'anthropic' | 'openai' | 'google' | 'openrouter';
type CatalogCapabilitySupport = NonNullable<ModelProfile['jsonCompatibility']>;

export interface CatalogEntry {
  providerType: CatalogProviderType;
  routeSurface: RouteSurface;
  /** Canonical, normalized model ID — never carries the `[1m]` extended-context suffix. */
  model: string;
  label: string;
  description?: string;
  isMainModel: boolean;
  isAuxiliaryModel: boolean;
  auxiliaryHint?: string;
  supportsReasoning?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** When true, the row exposes the per-model thinking-effort segmented control. */
  reasoning?: boolean;
  /** Static JSON structured-output support. Uses the same tri-state as ModelProfile. */
  jsonSupport?: CatalogCapabilitySupport;
  /** Static tool-use (function calling) support. Uses the same tri-state as ModelProfile. */
  toolUseSupport?: CatalogCapabilitySupport;
}

/**
 * Canonicalize a raw model ID for dedup comparison.
 *
 * Strips the `[1m]` extended-context suffix, lowercases, and trims whitespace.
 * Used by Stage 4's composite dedup key
 * `(providerType, routeSurface, normalizeCatalogModelId(model))` so that
 * `claude-sonnet-4-6[1m]` and ` Claude-Sonnet-4-6 ` collide with the
 * canonical `claude-sonnet-4-6` curated entry.
 */
export function normalizeCatalogModelId(model: string): string {
  return model.trim().toLowerCase().replace(/\[1m\]$/i, '');
}

export const normalizeModelId = normalizeCatalogModelId;

function freezeEntries(entries: CatalogEntry[]): readonly CatalogEntry[] {
  for (const entry of entries) Object.freeze(entry);
  return Object.freeze(entries);
}

const ANTHROPIC_CATALOG_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'claude-fable-5': 'Frontier Claude reasoning. Twice the price; bring hard problems.',
  'claude-opus-4-8': 'Top Claude reasoning for thorny work.',
  'claude-opus-4-7': 'Previous Claude reasoning, still extremely capable.',
  'claude-opus-4-6': 'Older Claude reasoning, still extremely capable.',
  'claude-sonnet-4-6': 'Balanced Claude reasoning for everyday serious work.',
  'claude-haiku-4-5': 'Fast, lighter Claude for quick turns and cleanup.',
});

const OPENROUTER_CATALOG_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'anthropic/claude-fable-5': 'Frontier Claude reasoning via OpenRouter. Premium price.',
  'anthropic/claude-opus-4-8': 'Top Claude reasoning via OpenRouter.',
  'anthropic/claude-opus-4-7': 'Previous Claude reasoning via OpenRouter.',
  'anthropic/claude-opus-4-6': 'Older Claude reasoning via OpenRouter.',
  'anthropic/claude-sonnet-4-6': 'Balanced Claude reasoning via OpenRouter.',
  'anthropic/claude-haiku-4-5': 'Fast, lighter Claude via OpenRouter.',
  'openai/gpt-5.5': 'Best OpenAI reasoning via OpenRouter.',
  'openai/gpt-5.5-pro': 'Premium OpenAI reasoning when cost can take a walk.',
  'openai/gpt-5.4': 'Strong OpenAI reasoning at a calmer cost.',
  'openai/gpt-5.3-codex': 'OpenAI model tuned for code-heavy work.',
  'openai/gpt-5.2': 'Strong OpenAI coding and multi-step work.',
  'openai/gpt-5.1': 'Reliable OpenAI reasoning for general work.',
  'openai/gpt-5': 'Capable OpenAI reasoning at lower cost.',
  'openai/gpt-5-mini': 'Fast OpenAI reasoning for background work.',
  'openai/gpt-5-nano': 'Cheapest OpenAI reasoning for small jobs.',
  'openai/gpt-5.4-mini': 'Fast OpenAI reasoning for lighter work.',
  'openai/gpt-5.4-nano': 'Cheapest OpenAI reasoning for tiny tasks.',
  'openai/gpt-4.1': 'Smart OpenAI model for routine work.',
  'openai/gpt-4.1-mini': 'Fast OpenAI model for routine work.',
  'openai/gpt-4.1-nano': 'Cheapest OpenAI model for small routine jobs.',
  'openai/o3': 'Legacy OpenAI reasoning. Still here, somehow.',
  'openai/o3-pro': 'Legacy OpenAI reasoning; slower but more thorough.',
  'openai/o4-mini': 'Legacy fast OpenAI reasoning for lighter tasks.',
  'google/gemini-3.1-pro-preview': 'Google preview reasoning via OpenRouter.',
  'google/gemini-3-flash-preview': 'Fast Gemini preview at a sensible cost.',
  'google/gemini-3.1-flash-lite-preview': 'Cheapest Gemini preview for quick work.',
  'google/gemini-2.5-pro': 'Stable Gemini reasoning and coding.',
  'google/gemini-2.5-flash': 'Fast, cost-efficient stable Gemini.',
  'google/gemini-2.5-flash-lite': 'Budget-friendly stable Gemini.',
  'deepseek/deepseek-v4-pro': 'Latest DeepSeek model for hard problems.',
  'deepseek/deepseek-v4-flash': 'Fast DeepSeek V4 for quick work.',
  'deepseek/deepseek-v3.2': 'Strong open-source DeepSeek model.',
  'deepseek/deepseek-r1-0528': 'Open-source DeepSeek reasoning.',
  'x-ai/grok-4.20': 'xAI reasoning via OpenRouter for hard problems.',
  'x-ai/grok-4.1-fast': 'Fast xAI reasoning for lighter work.',
  'moonshotai/kimi-k2.6': 'Long-horizon coding and agent work.',
  'moonshotai/kimi-k2.5': 'Visual coding and multi-step reasoning.',
  'minimax/minimax-m3': 'Latest MiniMax frontier model for agentic, long-context work.',
  'minimax/minimax-m2.7': 'Strong Minimax model for general work.',
  'z-ai/glm-5.2': 'Latest GLM model for hard problems.',
  'z-ai/glm-5.1': 'Previous GLM model for hard problems.',
  'z-ai/glm-5-turbo': 'Fast GLM model for everyday work.',
  'z-ai/glm-5': 'Strong GLM model for general work.',
  'z-ai/glm-4.7': 'Budget GLM model for lighter jobs.',
  'z-ai/glm-4.7-flash': 'Cheapest GLM model for tiny errands.',
});

/** Hand-maintained picker blurbs — keys must match catalog ids (see providerCatalogs.descriptions.test.ts). */
export const HAND_MAINTAINED_CATALOG_DESCRIPTION_MAPS: Readonly<
  Record<'anthropic' | 'openrouter', Readonly<Record<string, string>>>
> = Object.freeze({
  anthropic: ANTHROPIC_CATALOG_DESCRIPTIONS,
  openrouter: OPENROUTER_CATALOG_DESCRIPTIONS,
});

/**
 * Anthropic catalog: BYOK (`api-key`) rows derived from the canonical
 * `MODEL_OPTIONS` list. Haiku is the only current entry without reasoning
 * support; encoded via the same heuristic the legacy UI used, so Stage 4's
 * `ProviderCatalogRow` keeps parity.
 */
export function deriveAnthropicCatalog(): readonly CatalogEntry[] {
  const entries: CatalogEntry[] = MODEL_OPTIONS.map(option => {
    const entry: CatalogEntry = {
      providerType: 'anthropic',
      routeSurface: 'api-key',
      model: normalizeCatalogModelId(option.value),
      label: option.label,
      isMainModel: option.isMainModel,
      isAuxiliaryModel: option.isAuxiliaryModel,
      reasoning: !/haiku/i.test(option.value),
      jsonSupport: 'compatible',
      toolUseSupport: 'compatible',
    };
    const description = ANTHROPIC_CATALOG_DESCRIPTIONS[entry.model];
    if (description) entry.description = description;
    if (option.auxiliaryHint) entry.auxiliaryHint = option.auxiliaryHint;
    return entry;
  });
  return freezeEntries(entries);
}

/**
 * Codex catalog: ChatGPT Pro subscription rows (`subscription`) derived from
 * `CODEX_MAIN_MODEL_OPTIONS` + `CODEX_AUXILIARY_MODEL_OPTIONS`. Capability
 * metadata (context window, max output, reasoning gate) is enriched from
 * `PROVIDER_PRESETS.openai.models` when a matching entry exists — the two
 * lists share the same canonical OpenAI model IDs.
 */
export function deriveCodexCatalog(): readonly CatalogEntry[] {
  const openaiPresets = PROVIDER_PRESETS.openai.models;
  const buildEntry = (
    option: { value: string; label: string; description?: string },
    isMainModel: boolean,
    isAuxiliaryModel: boolean,
  ): CatalogEntry => {
    const preset = openaiPresets.find(p => p.value === option.value);
    const entry: CatalogEntry = {
      providerType: 'openai',
      routeSurface: 'subscription',
      model: normalizeCatalogModelId(option.value),
      label: option.label,
      isMainModel,
      isAuxiliaryModel,
      jsonSupport: 'compatible',
      toolUseSupport: 'compatible',
    };
    if (option.description) entry.description = option.description;
    if (preset?.contextWindow !== undefined) entry.contextWindow = preset.contextWindow;
    if (preset?.maxOutputTokens !== undefined) entry.maxOutputTokens = preset.maxOutputTokens;
    if (preset?.reasoning !== undefined) entry.reasoning = preset.reasoning;
    return entry;
  };
  const main = CODEX_MAIN_MODEL_OPTIONS.map(option => buildEntry(option, true, false));
  const aux = CODEX_AUXILIARY_MODEL_OPTIONS.map(option => buildEntry(option, false, true));
  return freezeEntries([...main, ...aux]);
}

/**
 * Gemini catalog: BYOK (`api-key`) rows derived directly from
 * `PROVIDER_PRESETS.google.models`. Each entry already carries the
 * description / context-window / max-output / reasoning metadata Stage 4
 * needs, so this is a near pass-through.
 */
export function deriveGeminiCatalog(): readonly CatalogEntry[] {
  const entries: CatalogEntry[] = PROVIDER_PRESETS.google.models.map(option => {
    const entry: CatalogEntry = {
      providerType: 'google',
      routeSurface: 'api-key',
      model: normalizeCatalogModelId(option.value),
      label: option.label,
      isMainModel: true,
      isAuxiliaryModel: false,
      jsonSupport: 'compatible',
      toolUseSupport: 'compatible',
    };
    if (option.description) entry.description = option.description;
    if (option.contextWindow !== undefined) entry.contextWindow = option.contextWindow;
    if (option.maxOutputTokens !== undefined) entry.maxOutputTokens = option.maxOutputTokens;
    if (option.reasoning !== undefined) entry.reasoning = option.reasoning;
    return entry;
  });
  return freezeEntries(entries);
}

/**
 * OpenRouter catalog: credit-pool (`pool`) rows derived from
 * `OR_MODEL_CATALOG`. Each OR entry already carries the `(isMainModel,
 * isAuxiliaryModel, auxiliaryHint)` triplet that the renderer dropdowns
 * consume; this just re-shapes them into `CatalogEntry`.
 */
export function deriveOpenRouterCatalog(): readonly CatalogEntry[] {
  const entries: CatalogEntry[] = OR_MODEL_CATALOG.map(option => {
    const entry: CatalogEntry = {
      providerType: 'openrouter',
      routeSurface: 'pool',
      model: normalizeCatalogModelId(option.id),
      label: option.label,
      isMainModel: option.isMainModel,
      isAuxiliaryModel: option.isAuxiliaryModel,
    };
    const description = OPENROUTER_CATALOG_DESCRIPTIONS[entry.model];
    if (description) entry.description = description;
    if (option.auxiliaryHint) entry.auxiliaryHint = option.auxiliaryHint;
    return entry;
  });
  return freezeEntries(entries);
}

/**
 * Curated provider catalogs, deeply frozen so consumers (Stage 4 dedup,
 * `ConversationModelSelector`, etc.) cannot mutate the shared array.
 *
 * Every entry is stamped with `routeSurface`. Consumers must use
 * `(providerType, routeSurface, normalizeCatalogModelId(model))` as the dedup key
 * — collapsing on `(providerType, model)` alone would silently merge a
 * Codex subscription row with a direct OpenAI API key profile, despite
 * their billing semantics being incompatible.
 */
export const PROVIDER_CATALOGS: Readonly<Record<CatalogProviderType, readonly CatalogEntry[]>> =
  Object.freeze({
    anthropic: deriveAnthropicCatalog(),
    openai: deriveCodexCatalog(),
    google: deriveGeminiCatalog(),
    openrouter: deriveOpenRouterCatalog(),
  });
