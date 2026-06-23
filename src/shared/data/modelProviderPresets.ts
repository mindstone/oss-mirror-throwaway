import type { ModelProfile, ModelProviderType, ThinkingEffort } from '../types';
import { MODEL_CATALOG, getCatalogEntryById, normalizeModelId } from './modelCatalog';
import {
  getAnthropicContextWindow,
  getAnthropicMaxOutput,
  normalizeForAnthropicMatch,
} from './anthropicModelLimits';

export interface ModelOption {
  value: string;
  label: string;
  description?: string;
  /** Whether this model supports reasoning/thinking effort. Defaults to true if omitted. */
  reasoning?: boolean;
  /** Known maximum context window in tokens. Omit when unknown or provider-dependent. */
  contextWindow?: number;
  /** Known maximum output tokens. Omit when unknown or provider-dependent. */
  maxOutputTokens?: number;
}

export interface PresetProfile {
  /** Display name in Quick Add UI */
  label: string;
  /** Description for context */
  description: string;
  /** Partial ModelProfile fields (excluding id, createdAt which are generated) */
  template: {
    name: string;
    model: string;
    reasoningEffort?: ThinkingEffort;
    councilEnabled?: boolean;
    contextWindow?: number;
  };
}

const OPENAI_REASONING_CONTEXT_WINDOW = 400_000;
const OPENAI_GPT_4_1_CONTEXT_WINDOW = 1_047_576;
const OPENAI_O_SERIES_CONTEXT_WINDOW = 200_000;
const GEMINI_LONG_CONTEXT_WINDOW = 1_047_576;

const OPENAI_GPT5_MAX_OUTPUT = 128_000;
const OPENAI_GPT4_1_MAX_OUTPUT = 32_768;
const OPENAI_O_SERIES_MAX_OUTPUT = 100_000;
const GEMINI_MAX_OUTPUT = 65_536;

/**
 * Derive the OpenRouter model list from `MODEL_CATALOG` entries with
 * populated `openRouter` and `presets` blocks.
 *
 * Stage 1 of `docs/plans/260428_kw_eval_infra_and_model_registry.md` folded
 * the hand-maintained `openrouter.models` array into MODEL_CATALOG so that
 * adding a new OpenRouter model is a single-place change. Order matches
 * `MODEL_CATALOG`'s OR section ordering, which is the intended UI dropdown
 * order. Historical-only entries (no `openRouter` block) are excluded.
 */
function deriveOpenRouterPresetModels(): ModelOption[] {
  const out: ModelOption[] = [];
  for (const entry of MODEL_CATALOG) {
    if (entry.provider !== 'openrouter' || !entry.openRouter) continue;
    // NOTE: this list is ALSO the OR metadata registry (context-window /
    // output-token / reasoning), and check-model-registry-consistency enforces
    // OR_MODEL_CATALOG ⊆ this list — so it must include hidden models too. A
    // withdrawn model (e.g. Fable 5, 2026-06) is hidden from the MAIN/role
    // pickers via its catalog isMainModel/isAuxiliaryModel flags; it stays here
    // for metadata. (Splitting "offerable" from "metadata" is the planned
    // single-source OR-registry refactor referenced by that gate.)
    const presets = entry.presets;
    const option: ModelOption = {
      value: entry.id,
      label: entry.openRouter.label,
    };
    if (presets?.description) option.description = presets.description;
    if (presets?.contextWindow !== undefined) option.contextWindow = presets.contextWindow;
    if (presets?.maxOutputTokens !== undefined) option.maxOutputTokens = presets.maxOutputTokens;
    if (presets?.reasoning === false) option.reasoning = false;
    out.push(option);
  }
  return out;
}

/**
 * @internal — exported only so registry-consistency tests can verify
 * derivation parity. Do not consume directly; use
 * `PROVIDER_PRESETS.openrouter.models` instead.
 */
export function _deriveOpenRouterPresetModelsForTesting(): ModelOption[] {
  return deriveOpenRouterPresetModels();
}

export interface ProviderPreset {
  type: ModelProviderType;
  label: string;
  serverUrl: string;
  requiresApiKey: boolean;
  models: ModelOption[];
  defaultModel: string;
  apiKeyPlaceholder: string;
  apiKeyHelpUrl: string;
  presetProfiles?: PresetProfile[];
}

export interface LocalInferencePreset {
  key: 'ds4' | 'lm-studio' | 'ollama-custom' | 'llama-cpp';
  presetKey: `local:${string}`;
  label: string;
  description: string;
  serverUrl: string;
  defaultModel: string;
  supportsThinking: boolean;
}

export const LOCAL_INFERENCE_PRESETS = [
  {
    key: 'ds4',
    presetKey: 'local:ds4',
    label: 'DS4',
    serverUrl: 'http://127.0.0.1:8000/v1',
    defaultModel: 'deepseek-v4-flash',
    supportsThinking: true,
    description: 'DeepSeek V4 Flash running on this machine. Use this if you followed the DS4 guide.',
  },
  {
    key: 'lm-studio',
    presetKey: 'local:lm-studio',
    label: 'LM Studio',
    serverUrl: 'http://127.0.0.1:1234/v1',
    defaultModel: '',
    supportsThinking: false,
    description: 'Open-weight models running on this machine via LM Studio.',
  },
  {
    key: 'ollama-custom',
    presetKey: 'local:ollama-custom',
    label: 'Ollama (custom server)',
    serverUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: '',
    supportsThinking: false,
    description: 'Connect to an Ollama instance you manage yourself.',
  },
  {
    key: 'llama-cpp',
    presetKey: 'local:llama-cpp',
    label: 'llama.cpp',
    serverUrl: 'http://127.0.0.1:8080/v1',
    defaultModel: '',
    supportsThinking: false,
    description: 'llama.cpp server in OpenAI-compatible mode.',
  },
] as const satisfies readonly LocalInferencePreset[];

export function getLocalInferencePresetByPresetKey(
  presetKey: string | undefined,
): LocalInferencePreset | undefined {
  if (!presetKey) return undefined;
  return LOCAL_INFERENCE_PRESETS.find((preset) => preset.presetKey === presetKey);
}

export const PROVIDER_PRESETS: Record<Exclude<ModelProviderType, 'anthropic' | 'other' | 'local'>, ProviderPreset> = {
  together: {
    type: 'together',
    label: 'Together AI',
    serverUrl: 'https://api.together.xyz/v1',
    requiresApiKey: true,
    defaultModel: '',
    apiKeyPlaceholder: 'Your Together API key',
    apiKeyHelpUrl: 'https://api.together.xyz/settings/api-keys',
    models: [],
  },
  cerebras: {
    type: 'cerebras',
    label: 'Cerebras',
    serverUrl: 'https://api.cerebras.ai/v1',
    requiresApiKey: true,
    defaultModel: 'llama-3.3-70b',
    apiKeyPlaceholder: 'Your Cerebras API key',
    apiKeyHelpUrl: 'https://cloud.cerebras.ai/',
    models: [
      { value: 'llama-3.3-70b', label: 'Llama 3.3 70B', description: 'Fast general-purpose (70B, ~2100 tok/s)' },
      { value: 'llama3.1-8b', label: 'Llama 3.1 8B', description: 'Ultra-fast lightweight (8B, ~2200 tok/s)' },
      { value: 'qwen-3-32b', label: 'Qwen 3 32B', description: 'Strong reasoning (32B, ~2600 tok/s)' },
      { value: 'gpt-oss-120b', label: 'OpenAI GPT OSS 120B', description: 'Largest model (120B, ~3000 tok/s)' },
    ],
  },
  openai: {
    type: 'openai',
    label: 'OpenAI',
    serverUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    defaultModel: 'gpt-5.5',
    apiKeyPlaceholder: 'sk-...',
    apiKeyHelpUrl: 'https://platform.openai.com/api-keys',
    models: [
      // Frontier reasoning models
      { value: 'gpt-5.5', label: 'GPT-5.5', description: 'Latest frontier reasoning model', contextWindow: OPENAI_REASONING_CONTEXT_WINDOW, maxOutputTokens: OPENAI_GPT5_MAX_OUTPUT },
      { value: 'gpt-5.5-pro', label: 'GPT-5.5 Pro', description: 'Premium quality, higher cost', contextWindow: OPENAI_REASONING_CONTEXT_WINDOW, maxOutputTokens: OPENAI_GPT5_MAX_OUTPUT },
      { value: 'gpt-5.4', label: 'GPT-5.4', description: 'Strong frontier reasoning, lower cost', contextWindow: OPENAI_REASONING_CONTEXT_WINDOW, maxOutputTokens: OPENAI_GPT5_MAX_OUTPUT },
      { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', description: 'Best for code-heavy work', contextWindow: OPENAI_REASONING_CONTEXT_WINDOW, maxOutputTokens: OPENAI_GPT5_MAX_OUTPUT },
      { value: 'gpt-5.2', label: 'GPT-5.2', description: 'Strong coding and agentic tasks', contextWindow: OPENAI_REASONING_CONTEXT_WINDOW, maxOutputTokens: OPENAI_GPT5_MAX_OUTPUT },
      { value: 'gpt-5.2-pro', label: 'GPT-5.2 Pro', description: 'Previous-gen premium reasoning', contextWindow: OPENAI_REASONING_CONTEXT_WINDOW, maxOutputTokens: OPENAI_GPT5_MAX_OUTPUT },
      { value: 'gpt-5.1', label: 'GPT-5.1', description: 'Strong general-purpose reasoning', contextWindow: OPENAI_REASONING_CONTEXT_WINDOW, maxOutputTokens: OPENAI_GPT5_MAX_OUTPUT },
      { value: 'gpt-5', label: 'GPT-5', description: 'Capable reasoning, lower cost than 5.1+', contextWindow: OPENAI_REASONING_CONTEXT_WINDOW, maxOutputTokens: OPENAI_GPT5_MAX_OUTPUT },
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'Fast, cost-efficient frontier reasoning', contextWindow: OPENAI_REASONING_CONTEXT_WINDOW, maxOutputTokens: OPENAI_GPT5_MAX_OUTPUT },
      { value: 'gpt-5.4-nano', label: 'GPT-5.4 nano', description: 'Fastest, cheapest frontier reasoning', contextWindow: OPENAI_REASONING_CONTEXT_WINDOW, maxOutputTokens: OPENAI_GPT5_MAX_OUTPUT },
      { value: 'gpt-5-mini', label: 'GPT-5 mini', description: 'Fast, cost-efficient reasoning', contextWindow: OPENAI_REASONING_CONTEXT_WINDOW, maxOutputTokens: OPENAI_GPT5_MAX_OUTPUT },
      { value: 'gpt-5-nano', label: 'GPT-5 nano', description: 'Fastest, cheapest reasoning', contextWindow: OPENAI_REASONING_CONTEXT_WINDOW, maxOutputTokens: OPENAI_GPT5_MAX_OUTPUT },
      // Non-reasoning models
      { value: 'gpt-4.1', label: 'GPT-4.1', description: 'Smartest non-reasoning model', reasoning: false, contextWindow: OPENAI_GPT_4_1_CONTEXT_WINDOW, maxOutputTokens: OPENAI_GPT4_1_MAX_OUTPUT },
      { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini', description: 'Fast non-reasoning', reasoning: false, contextWindow: OPENAI_GPT_4_1_CONTEXT_WINDOW, maxOutputTokens: OPENAI_GPT4_1_MAX_OUTPUT },
      { value: 'gpt-4.1-nano', label: 'GPT-4.1 nano', description: 'Fastest, cheapest non-reasoning', reasoning: false, contextWindow: OPENAI_GPT_4_1_CONTEXT_WINDOW, maxOutputTokens: OPENAI_GPT4_1_MAX_OUTPUT },
      // Legacy reasoning (succeeded by GPT-5 series)
      { value: 'o3', label: 'o3', description: 'Legacy reasoning (use GPT-5 instead)', contextWindow: OPENAI_O_SERIES_CONTEXT_WINDOW, maxOutputTokens: OPENAI_O_SERIES_MAX_OUTPUT },
      { value: 'o3-pro', label: 'o3-pro', description: 'Legacy high-compute reasoning', contextWindow: OPENAI_O_SERIES_CONTEXT_WINDOW, maxOutputTokens: OPENAI_O_SERIES_MAX_OUTPUT },
      { value: 'o4-mini', label: 'o4-mini', description: 'Legacy fast reasoning (use GPT-5 mini instead)', contextWindow: OPENAI_O_SERIES_CONTEXT_WINDOW, maxOutputTokens: OPENAI_O_SERIES_MAX_OUTPUT },
    ],
    presetProfiles: [
      {
        label: 'GPT-5.5 — High Thinking',
        description: 'Deep reasoning for complex tasks',
        template: {
          name: 'GPT-5.5 High Thinking',
          model: 'gpt-5.5',
          reasoningEffort: 'high',
          councilEnabled: true,
        },
      },
      {
        label: 'GPT-5 mini — Fast & Affordable',
        description: 'Quick reasoning at a fraction of the cost',
        template: {
          name: 'GPT-5 mini',
          model: 'gpt-5-mini',
          reasoningEffort: 'medium',
          contextWindow: OPENAI_REASONING_CONTEXT_WINDOW,
        },
      },
      {
        label: 'GPT-4.1 — No Reasoning',
        description: 'Fast responses without reasoning overhead',
        template: {
          name: 'GPT-4.1',
          model: 'gpt-4.1',
          contextWindow: OPENAI_GPT_4_1_CONTEXT_WINDOW,
        },
      },
    ],
  },
  openrouter: {
    type: 'openrouter',
    label: 'OpenRouter',
    serverUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: false,
    defaultModel: 'openai/gpt-5.5',
    apiKeyPlaceholder: 'Connected via OAuth',
    apiKeyHelpUrl: 'https://openrouter.ai/docs',
    // Derived from MODEL_CATALOG entries with populated openRouter + presets blocks.
    // See deriveOpenRouterPresetModels() above and Stage 1 of
    // docs/plans/260428_kw_eval_infra_and_model_registry.md.
    models: deriveOpenRouterPresetModels(),
    presetProfiles: [
      {
        label: 'GPT-5.5 — OpenAI Frontier',
        description: 'OpenAI latest reasoning model (default working model)',
        template: {
          name: 'GPT-5.5 (OpenRouter)',
          model: 'openai/gpt-5.5',
          reasoningEffort: 'high',
          contextWindow: 1_050_000,
        },
      },
      // Claude Fable 5 preset profile removed while Fable access is withdrawn
      // (2026-06) — the app shouldn't feature a one-click add for a model that
      // 404s. Re-add this entry when access returns (alongside restoring the
      // catalog flags). See the claude-fable-5 entries in modelCatalog.ts.
      {
        label: 'Claude Opus 4.8 — Deep Reasoning',
        description: 'Most capable reasoning model (default thinking model)',
        template: {
          name: 'Claude Opus 4.8 (OpenRouter)',
          model: 'anthropic/claude-opus-4-8',
          reasoningEffort: 'high',
          contextWindow: 1_000_000,
        },
      },
      {
        label: 'Claude Haiku 4.5 — Fast & Affordable',
        description: 'Quick tasks at a fraction of the cost',
        template: {
          name: 'Claude Haiku 4.5 (OpenRouter)',
          model: 'anthropic/claude-haiku-4-5',
          reasoningEffort: 'medium',
          contextWindow: 200_000,
        },
      },
    ],
  },
  google: {
    type: 'google',
    label: 'Google Gemini',
    serverUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresApiKey: true,
    defaultModel: 'gemini-2.5-flash',
    apiKeyPlaceholder: 'Your Gemini API key',
    apiKeyHelpUrl: 'https://aistudio.google.com/apikey',
    models: [
      // Gemini 3 series (preview)
      { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', description: 'Most advanced reasoning (preview)', maxOutputTokens: GEMINI_MAX_OUTPUT },
      { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', description: 'Frontier-class at low cost (preview)', contextWindow: GEMINI_LONG_CONTEXT_WINDOW, maxOutputTokens: GEMINI_MAX_OUTPUT },
      { value: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash-Lite', description: 'Fastest, cheapest (preview)', maxOutputTokens: GEMINI_MAX_OUTPUT },
      // Gemini 2.5 series (stable)
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Deep reasoning and coding (stable)', contextWindow: GEMINI_LONG_CONTEXT_WINDOW, maxOutputTokens: GEMINI_MAX_OUTPUT },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Fast, cost-efficient reasoning (stable)', contextWindow: GEMINI_LONG_CONTEXT_WINDOW, maxOutputTokens: GEMINI_MAX_OUTPUT },
      { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', description: 'Budget-friendly multimodal (stable)', contextWindow: GEMINI_LONG_CONTEXT_WINDOW, maxOutputTokens: GEMINI_MAX_OUTPUT },
    ],
    presetProfiles: [
      {
        label: 'Gemini 2.5 Flash — Fast & Capable',
        description: 'Great balance of speed, quality, and cost',
        template: {
          name: 'Gemini 2.5 Flash',
          model: 'gemini-2.5-flash',
          reasoningEffort: 'medium',
          contextWindow: GEMINI_LONG_CONTEXT_WINDOW,
        },
      },
      {
        label: 'Gemini 3.1 Pro — Best Quality',
        description: 'Most advanced reasoning and multimodal (preview)',
        template: {
          name: 'Gemini 3.1 Pro',
          model: 'gemini-3.1-pro-preview',
          reasoningEffort: 'high',
        },
      },
      {
        label: 'Gemini 3 Flash — Frontier Budget',
        description: 'Next-gen quality at a fraction of the cost',
        template: {
          name: 'Gemini 3 Flash',
          model: 'gemini-3-flash-preview',
          reasoningEffort: 'medium',
          contextWindow: GEMINI_LONG_CONTEXT_WINDOW,
        },
      },
    ],
  },
};

const KNOWN_MODEL_CONTEXT_WINDOWS = (() => {
  const map = new Map<string, number | null>();

  for (const preset of Object.values(PROVIDER_PRESETS)) {
    for (const model of preset.models) {
      if (!model.contextWindow) continue;
      const key = model.value.toLowerCase();
      const existing = map.get(key);
      if (existing === undefined) {
        map.set(key, model.contextWindow);
      } else if (existing !== model.contextWindow) {
        map.set(key, null);
      }
    }
  }

  // Also pick up catalog entries for providers that don't have a PROVIDER_PRESETS
  // section (cohere, and together/cerebras entries we don't surface as built-in
  // presets). Without this, models reached via providerType='other' +
  // customProviderId fall through to DEFAULT_CONTEXT_WINDOW (200k) even when
  // the catalog has accurate metadata.
  for (const entry of MODEL_CATALOG) {
    const ctx = entry.presets?.contextWindow;
    if (!ctx) continue;
    const keys = [
      entry.id,
      ...(entry.aliases ?? []),
      ...(entry.openRouter?.sdkModel ? [entry.openRouter.sdkModel] : []),
      ...(entry.openRouter?.legacyIds ?? []),
    ];
    for (const rawKey of keys) {
      const key = rawKey.toLowerCase();
      const existing = map.get(key);
      if (existing === undefined) {
        map.set(key, ctx);
      } else if (existing !== ctx) {
        map.set(key, null);
      }
    }
  }

  return map;
})();

export function getKnownContextWindowForModel(model: string | null | undefined): number | null {
  if (!model) return null;
  return KNOWN_MODEL_CONTEXT_WINDOWS.get(model.trim().toLowerCase()) ?? null;
}

/**
 * Combined registry lookup: Anthropic patterns first (1M ceiling for known
 * Claude models), then the cross-provider preset map. Returns `null` when
 * neither has an entry. Used by source-aware helpers to decide whether a
 * stored profile value matches "the registry" (and therefore could not have
 * been a user override).
 */
export function getRegistryContextWindowForModel(model: string | null | undefined): number | null {
  if (!model) return null;
  const anthropic = getAnthropicContextWindow(model);
  if (anthropic !== null) return anthropic;
  return getKnownContextWindowForModel(normalizeForAnthropicMatch(model));
}

/**
 * Combined registry lookup for max output tokens: Anthropic patterns first,
 * then the cross-provider preset map. Returns `undefined` when neither has an
 * entry.
 */
export function getRegistryMaxOutputForModel(
  model: string | null | undefined,
): number | undefined {
  if (!model) return undefined;
  const anthropic = getAnthropicMaxOutput(model);
  if (anthropic !== null) return anthropic;
  return getKnownMaxOutputForModel(normalizeForAnthropicMatch(model)) ?? undefined;
}

/**
 * Read the known context window for a profile. Source-aware: when
 * `contextWindowSource === 'auto'` the helper returns the known-model value
 * (or null) and IGNORES the profile's auto-learned value, so callers (notably
 * recovery adapters) fall through to `resolveModelLimits` with its full
 * cascade. When `contextWindowSource === 'user'` the user value wins. For
 * legacy profiles (source absent) the existing precedence is preserved.
 *
 * See docs/plans/260503_unify_learned_limits_into_profiles.md
 * — Cascade Resolution → Source-blind legacy data (Finding M).
 */
export function getKnownContextWindowForProfile(
  profile:
    | Pick<ModelProfile, 'model' | 'contextWindow' | 'contextWindowSource'>
    | null
    | undefined,
): number | null {
  if (!profile) return null;
  if (profile.contextWindowSource === 'auto') {
    return getKnownContextWindowForModel(profile.model);
  }
  return profile.contextWindow ?? getKnownContextWindowForModel(profile.model);
}

const KNOWN_MODEL_MAX_OUTPUT = (() => {
  const map = new Map<string, number | null>();

  for (const preset of Object.values(PROVIDER_PRESETS)) {
    for (const model of preset.models) {
      if (!model.maxOutputTokens) continue;
      const key = model.value.toLowerCase();
      const existing = map.get(key);
      if (existing === undefined) {
        map.set(key, model.maxOutputTokens);
      } else if (existing !== model.maxOutputTokens) {
        map.set(key, null);
      }
    }
  }

  // Also pick up catalog entries for providers without a PROVIDER_PRESETS
  // section (e.g. Cohere). Required so that models reached via
  // providerType='other' + customProviderId (i.e. custom OpenAI-compatible
  // providers) get their declared output cap and don't fall through to
  // DEFAULT_MAX_OUTPUT_TOKENS = 32_768. Cohere Command A caps output at 8192;
  // sending the default triggers an HTTP 400 from the compatibility endpoint.
  for (const entry of MODEL_CATALOG) {
    const max = entry.presets?.maxOutputTokens;
    if (!max) continue;
    const key = entry.id.toLowerCase();
    const existing = map.get(key);
    if (existing === undefined) {
      map.set(key, max);
    } else if (existing !== max) {
      map.set(key, null);
    }
  }

  return map;
})();

export function getKnownMaxOutputForModel(model: string | null | undefined): number | null {
  if (!model) return null;
  const key = model.trim().toLowerCase();
  const exact = KNOWN_MODEL_MAX_OUTPUT.get(key);
  if (exact !== undefined) return exact;
  // Fallback: strip a trailing dated suffix (`-YYYYMMDD` or `-YYYY-MM-DD`) and retry.
  // Catalog ids for non-Anthropic providers are undated (e.g. `openai/gpt-5.5`), but a
  // dated id can appear as a sub-agent `routedModel` (e.g. `openai/gpt-5.5-20260301`).
  // Without this, the cascade in resolveModelLimits() misses the preset and over-clamps
  // max_tokens to the 32768 default. (Anthropic dated ids are already handled upstream by
  // normalizeForAnthropicMatch; this covers the cross-provider case.) The strip only
  // matches a trailing date, so it can't shorten a real undated model id.
  const undated = key.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  if (undated !== key) {
    return KNOWN_MODEL_MAX_OUTPUT.get(undated) ?? null;
  }
  return null;
}

/**
 * Default capability hints for known models, used by adaptive routing.
 * Applied when a profile is created (user can edit). Keyed by model ID, checked
 * case-insensitively — entries cover both direct-provider IDs (e.g. "gpt-5.5")
 * and OpenRouter-prefixed IDs (e.g. "openai/gpt-5.5").
 *
 * Writing guidelines:
 * - Keep each note to 1-2 short sentences — the planner reads these in a prompt.
 * - Focus on relative capabilities vs the rest of the pool.
 * - Include both what to route TO this model and what to route AWAY.
 */
export const MODEL_CAPABILITY_DEFAULTS: Record<string, { modelNotes: string }> = {
  // --- OpenAI GPT-5 series ---
  'gpt-5.5': {
    modelNotes: 'Top-tier reasoning, complex multi-step analysis, nuanced writing, reliable tool orchestration. Expensive. Overkill for simple lookups, data retrieval, or routine tool calls.',
  },
  'gpt-5.5-pro': {
    modelNotes: 'Highest quality reasoning and generation. Use for the hardest problems only. Very expensive. Rarely needed — GPT-5.5 handles most complex tasks well.',
  },
  'gpt-5.4': {
    modelNotes: 'Strong reasoning at half the cost of GPT-5.5. Good for most analytical and synthesis tasks. Slightly less capable than GPT-5.5 on the most complex reasoning chains.',
  },
  'gpt-5.3-codex': {
    modelNotes: 'Specialised for code generation, debugging, and technical analysis. Less versatile for general writing and non-technical tasks.',
  },
  'gpt-5.2': {
    modelNotes: 'Solid reasoning at moderate cost. Good for structured tasks and tool use. Outperformed by GPT-5.4+ on complex multi-source synthesis.',
  },
  'gpt-5.2-pro': {
    modelNotes: 'Previous-gen premium reasoning. Thorough analysis for complex problems. Expensive for its generation. GPT-5.4 is usually better value.',
  },
  'gpt-5.1': {
    modelNotes: 'Reliable general-purpose reasoning at lower cost. Less capable on nuanced judgment calls and complex analysis.',
  },
  'gpt-5': {
    modelNotes: 'Good reasoning at low cost. Handles most straightforward analytical tasks. Weaker on complex multi-step reasoning and subtle judgment.',
  },
  'gpt-5.4-mini': {
    modelNotes: 'Fast, cost-efficient reasoning. Great for tool calls, search, data gathering, and routine steps. Not suited for complex synthesis, nuanced writing, or multi-source analysis.',
  },
  'gpt-5.4-nano': {
    modelNotes: 'Fastest and cheapest reasoning model. Ideal for simple lookups, classifications, and data extraction. Limited reasoning depth. Not for tasks requiring judgment or complex analysis.',
  },
  'gpt-5-mini': {
    modelNotes: 'Fast, cheap reasoning. Good for tool orchestration and straightforward tasks. Weaker reasoning than 5.4 mini. Avoid for synthesis or complex judgment.',
  },
  'gpt-5-nano': {
    modelNotes: 'Cheapest reasoning option. Use for simple, low-stakes steps. Minimal reasoning capability. Only for trivial tasks.',
  },
  // --- OpenAI o-series (legacy reasoning) ---
  // Keyed by BARE id (no `openai/` prefix) deliberately, matching the gpt-5.x
  // convention above: these are selectable BOTH as direct OpenAI models (bare
  // `o3` etc., via PROVIDER_PRESETS.openai) AND as OpenRouter models (`openai/o3`).
  // A bare key resolves the direct id by exact match AND the OR-prefixed id via
  // the provider-prefix strip; a prefixed key would leave the direct route
  // (`getModelCapabilityDefaults('o3')`) returning undefined.
  'o3': {
    modelNotes: 'Legacy reasoning model. Capable step-by-step analysis, but superseded by the GPT-5 reasoning series on quality and cost. Prefer GPT-5.x for new routing.',
  },
  'o3-pro': {
    modelNotes: 'Legacy high-compute reasoning. Thorough on hard problems but very expensive and slow. GPT-5.5 / GPT-5.5 Pro are better value for the same tasks.',
  },
  'o4-mini': {
    modelNotes: 'Legacy fast reasoning. Quick step-by-step analysis at low cost, but superseded by GPT-5 mini on quality and cost. Prefer GPT-5 mini for new routing.',
  },
  // --- OpenAI non-reasoning ---
  'gpt-4.1': {
    modelNotes: 'Fast, no reasoning overhead. Great for straightforward generation, summaries, and formatting. No reasoning/thinking support. Cannot handle tasks requiring step-by-step analysis.',
  },
  'gpt-4.1-mini': {
    modelNotes: 'Very fast and cheap. Good for simple generation and formatting tasks. No reasoning. Limited capability on anything requiring analysis.',
  },
  'gpt-4.1-nano': {
    modelNotes: 'Fastest, cheapest non-reasoning model. Use for trivial formatting or classification. Minimal capability. Only for the simplest tasks.',
  },
  // --- Google Gemini ---
  'gemini-3.1-pro-preview': {
    modelNotes: 'Advanced reasoning with massive context window. Strong on long-document analysis and multimodal tasks. Preview model — may have rough edges. Higher latency than Flash variants.',
  },
  'gemini-3-flash-preview': {
    modelNotes: 'Frontier-class quality at low cost. Excellent for most tasks including tool use and analysis. Preview model. Slightly less capable than Pro on the hardest reasoning tasks.',
  },
  'gemini-2.5-pro': {
    modelNotes: 'Strong reasoning with huge context. Good for document analysis and complex coding. Higher cost and latency than Flash. Stable but outperformed by 3.x series.',
  },
  'gemini-3.1-flash-lite-preview': {
    modelNotes: 'Fastest, cheapest Gemini. Good for simple tasks and high-volume use. Preview model. Limited reasoning depth — not for complex analysis.',
  },
  'gemini-2.5-flash': {
    modelNotes: 'Fast, cost-efficient with large context. Good balance of speed, quality, and cost. Less capable than Pro on complex reasoning. Stable but older generation.',
  },
  'gemini-2.5-flash-lite': {
    modelNotes: 'Budget-friendly with large context. Good for simple multimodal tasks. Weakest Gemini reasoning. Only for low-stakes tasks.',
  },
  // --- Anthropic ---
  // Keyed by BARE id (no `anthropic/` prefix) deliberately: getModelCapabilityDefaults
  // matches the Anthropic-DIRECT id (`profile.model` is bare, e.g. `claude-opus-4-8`)
  // by exact match, AND the OpenRouter-prefixed id (`anthropic/claude-opus-4-8`) via
  // the provider-prefix strip on fallback. One bare entry covers both routes; a
  // prefixed key would leave the (more common) direct route resolving to undefined.
  'claude-fable-5': {
    modelNotes: 'Anthropic\'s frontier tier — reasoning depth beyond Opus 4.8 for the very hardest analysis, judgment, and writing. Twice the price of Opus, and safety classifiers may refuse borderline requests. Route simple lookups, routine tool calls, and everyday tasks to cheaper models.',
  },
  'claude-opus-4-6': {
    modelNotes: 'Strong reasoning and creative writing. Previous-gen Opus — still very capable. Expensive. Outperformed by Opus 4.8 on the hardest tasks.',
  },
  'claude-opus-4-7': {
    modelNotes: 'Strong reasoning and creative writing. Previous-gen Opus — still very capable. Expensive. Outperformed by Opus 4.8 on the hardest tasks.',
  },
  'claude-opus-4-8': {
    modelNotes: 'Exceptional reasoning depth and nuance. Best for complex analysis, creative writing, and careful judgment. Very expensive and slower. Overkill for routine tool calls or simple tasks.',
  },
  'claude-sonnet-4-6': {
    modelNotes: 'Fast, high-quality reasoning. Good for most tasks including tool use and writing. Less depth than Opus on the most complex reasoning chains.',
  },
  'claude-haiku-4-5': {
    modelNotes: 'Very fast and affordable. Great for simple tool calls, lookups, and quick responses. Limited reasoning depth. Not for complex analysis or nuanced writing.',
  },
  // --- DeepSeek ---
  'deepseek/deepseek-v4-pro': {
    modelNotes: 'Latest DeepSeek frontier model. Strong reasoning and general capability at low cost. Less battle-tested tool use than the top GPT/Claude/Gemini tiers; text-only.',
  },
  'deepseek/deepseek-r1-0528': {
    modelNotes: 'Deep reasoning (open-source). Good for analytical tasks at low cost. Smaller context window. Less reliable tool use than frontier models.',
  },
  'deepseek/deepseek-v3.2': {
    modelNotes: 'Fast, cost-effective generation. Good for straightforward tasks. No reasoning support. Weaker on complex analysis.',
  },
  'deepseek/deepseek-v4-flash': {
    modelNotes: 'Fast and very affordable. Default behind-the-scenes worker for OpenRouter — handles summaries, titles, and quick lookups. Limited reasoning depth; not for complex analysis.',
  },
  // --- Grok ---
  'x-ai/grok-4.20': {
    modelNotes: 'Strong reasoning with good tool use. Competitive frontier model. Smaller context window than GPT-5.5 or Gemini.',
  },
  'x-ai/grok-4.1-fast': {
    modelNotes: 'Fast reasoning at lower cost. Good for routine analytical tasks. Less capable than Grok 4.20 on complex reasoning.',
  },
  // --- MiniMax ---
  'minimax/minimax-m3': {
    modelNotes: 'Latest MiniMax frontier model — agentic, with a very large context window for long-document and multi-step workflows. Good cost/capability balance. Less proven on nuanced writing than the top GPT/Claude tiers.',
  },
  'minimax/minimax-m2.7': {
    modelNotes: 'Strong open-weight model. Good for general tasks at reasonable cost. No reasoning support. Less capable than frontier reasoning models on complex tasks.',
  },
  // --- Kimi ---
  'moonshotai/kimi-k2.6': {
    modelNotes: 'Strong at long-horizon coding and multi-agent coordination. Large context. Less versatile for general writing and non-technical tasks.',
  },
  'moonshotai/kimi-k2.5': {
    modelNotes: 'Visual coding and agentic reasoning. Good for tool-heavy workflows. Less capable than frontier models on nuanced writing or complex synthesis.',
  },
  // --- GLM ---
  'z-ai/glm-5.2': {
    modelNotes: 'Latest GLM frontier model — strongest general-purpose GLM, with a large (~200k) context window. Text-only (no image input) and no client-side reasoning param. Route complex multi-step reasoning to frontier reasoning models, and image tasks elsewhere.',
  },
  'z-ai/glm-5.1': {
    modelNotes: 'Previous GLM frontier model. Strong general-purpose capabilities. No reasoning support. Outperformed by GLM 5.2 and frontier reasoning models on complex tasks.',
  },
  'z-ai/glm-5-turbo': {
    modelNotes: 'Fast GLM variant. Good for high-throughput, latency-sensitive general tasks. No reasoning support. Weaker on complex analysis than GLM 5.1/5.2.',
  },
  'z-ai/glm-5': {
    modelNotes: 'Strong open-weight model. Good for general tasks. No reasoning support. Weaker on complex analysis.',
  },
  'z-ai/glm-4.7': {
    modelNotes: 'Budget GLM model. Cheap general-purpose generation for simple, high-volume tasks. No reasoning support. Outperformed by GLM 5.x and frontier models on anything requiring analysis.',
  },
  'z-ai/glm-4.7-flash': {
    modelNotes: 'Cheapest GLM model. Use for trivial, high-throughput tasks where cost matters most. No reasoning support. Minimal capability on analysis or nuanced writing.',
  },
  // --- Cerebras ---
  'llama-3.3-70b': {
    modelNotes: 'Extremely fast inference (~2100 tok/s). Good for high-volume, latency-sensitive tasks. Lower quality than frontier models. No reasoning support.',
  },
  'llama3.1-8b': {
    modelNotes: 'Ultra-fast lightweight model (~2200 tok/s). Use for trivial, high-throughput tasks where speed and cost dominate. Minimal capability — not for analysis or nuanced writing. No reasoning support.',
  },
  'qwen-3-32b': {
    modelNotes: 'Strong reasoning at extreme speed (~2600 tok/s). Good cost/performance ratio. Smaller model — less capable on the most complex tasks.',
  },
  'gpt-oss-120b': {
    modelNotes: 'Largest Cerebras-hosted open-weight model (120B, ~3000 tok/s). Good general-purpose capability at very high throughput. Weaker than frontier models on the hardest reasoning; no reasoning param.',
  },
};

/**
 * Look up default capability hints for a model ID.
 * Tries exact match first, then strips the OpenRouter provider prefix (e.g. "openai/gpt-5.5" → "gpt-5.5").
 */
export function getModelCapabilityDefaults(modelId: string | undefined): { modelNotes: string } | undefined {
  if (!modelId) return undefined;
  const lower = modelId.toLowerCase();
  // Check exact match (covers OpenRouter-prefixed entries like "anthropic/claude-opus-4-7")
  for (const [key, value] of Object.entries(MODEL_CAPABILITY_DEFAULTS)) {
    if (key.toLowerCase() === lower) return value;
  }
  // Strip provider prefix and check again (covers "openai/gpt-5.5" → "gpt-5.5")
  const slashIdx = lower.indexOf('/');
  if (slashIdx >= 0) {
    const bare = lower.slice(slashIdx + 1);
    for (const [key, value] of Object.entries(MODEL_CAPABILITY_DEFAULTS)) {
      if (key.toLowerCase() === bare) return value;
    }
  }
  return undefined;
}

/**
 * Whether a model supports reasoning/thinking effort, derived from the model
 * catalog's `presets.reasoning` flag. Defaults to `true` (the catalog convention
 * is that reasoning is opt-out: only explicitly non-reasoning models set
 * `reasoning: false`). Unknown/unlisted models default to `true`, matching the
 * `ModelOption.reasoning` default documented above.
 *
 * Used to populate the `__working__` routing-catalog entry's `reasoning` flag
 * from the working model's actual capability instead of hardcoding `true`,
 * so the planner is not told a non-reasoning working model supports thinking.
 */
export function modelSupportsReasoning(modelId: string | undefined): boolean {
  if (!modelId) return true;
  const entry = getCatalogEntryById(modelId) ?? getCatalogEntryById(normalizeModelId(modelId));
  return entry?.presets?.reasoning !== false;
}

export const PROVIDER_OPTIONS: { value: ModelProviderType; label: string }[] = [
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google Gemini' },
  { value: 'cerebras', label: 'Cerebras' },
  { value: 'together', label: 'Together AI' },
  { value: 'other', label: 'Other (custom endpoint)' },
  // 'local' intentionally excluded — managed by LocalInferenceSection, not the cloud provider picker
];
