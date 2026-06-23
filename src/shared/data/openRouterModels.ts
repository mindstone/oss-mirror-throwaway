/**
 * OpenRouter Model Catalog (derived view)
 *
 * Eagerly derived at module load from `MODEL_CATALOG` entries with
 * `provider: 'openrouter'` and a populated `openRouter` block. Adding a new
 * OpenRouter model is a single-place change in `modelCatalog.ts` — this
 * module then provides the dropdown-shaped views, ID translation maps, and
 * legacy remap consumed by the Settings UI, BYOK switch, and pricing layer.
 *
 * @see docs/plans/260428_kw_eval_infra_and_model_registry.md — Stage 1
 *      ("derive from catalog, eager evaluation")
 * @see docs/plans/260324_openrouter_integration.md — Stage 2 amendments (H4, H5)
 */
import { MODEL_CATALOG, type ModelCatalogEntry, type OpenRouterRouting } from './modelCatalog';

export interface OpenRouterModelEntry {
  /** OpenRouter model ID (e.g., 'anthropic/claude-sonnet-4-6') */
  id: string;
  /** Human-readable label for UI dropdowns */
  label: string;
  /** Corresponding Anthropic SDK model ID, if this is a Claude model */
  sdkModel?: string;
  /** Available as a main conversation model */
  isMainModel: boolean;
  /** Available as a behind-the-scenes / auxiliary model */
  isAuxiliaryModel: boolean;
  /** Hint text appended to label in auxiliary dropdowns */
  auxiliaryHint?: string;
}

/**
 * Type guard: catalog entry has a populated `openRouter` block.
 * Stage 1 invariant: every `provider: 'openrouter'` catalog entry MUST have
 * an `openRouter` block UNLESS it's a historical-only entry kept for cost
 * lookup (handled by `LEGACY_OR_MODEL_REMAP`). The Stage 0 consistency check
 * (`scripts/check-model-registry-consistency.ts`) enforces this.
 */
function hasOrRouting(
  e: ModelCatalogEntry,
): e is ModelCatalogEntry & { openRouter: OpenRouterRouting } {
  return e.provider === 'openrouter' && !!e.openRouter;
}

/** Eager — array, not getter (mutable consumers expect a real array). */
type OrCatalogEntry = ModelCatalogEntry & { openRouter: OpenRouterRouting };
const OR_CATALOG_ENTRIES: readonly OrCatalogEntry[] = MODEL_CATALOG.filter(hasOrRouting);

/**
 * Curated OpenRouter model catalog (eagerly derived from `MODEL_CATALOG`).
 * Order is the iteration order of `MODEL_CATALOG`'s OR section, which is the
 * intended UI dropdown order.
 */
export const OR_MODEL_CATALOG: readonly OpenRouterModelEntry[] = OR_CATALOG_ENTRIES.map(e => {
  const routing = e.openRouter;
  const entry: OpenRouterModelEntry = {
    id: e.id,
    label: routing.label,
    isMainModel: routing.isMainModel,
    isAuxiliaryModel: routing.isAuxiliaryModel,
  };
  if (routing.sdkModel) entry.sdkModel = routing.sdkModel;
  if (routing.auxiliaryHint) entry.auxiliaryHint = routing.auxiliaryHint;
  return entry;
});

/**
 * Backwards-compat: map old OR model IDs to their replacements.
 *
 * Eagerly derived from `entry.openRouter.legacyIds`. Exported so registry-
 * consistency tooling can verify that catalog entries for legacy IDs (kept
 * for historical cost calculation) are explicitly accounted for as
 * legacy-mapped, rather than indistinguishable from drift.
 */
export const LEGACY_OR_MODEL_REMAP: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const e of OR_CATALOG_ENTRIES) {
    const legacyIds = e.openRouter.legacyIds;
    if (!legacyIds) continue;
    for (const legacy of legacyIds) {
      if (m.has(legacy)) {
        throw new Error(
          `[openRouterModels] Conflicting LEGACY_OR_MODEL_REMAP entry for ${legacy}: ` +
            `${m.get(legacy)} vs ${e.id}. Check openRouter.legacyIds in MODEL_CATALOG.`,
        );
      }
      m.set(legacy, e.id);
    }
  }
  return m;
})();

/** Map from OpenRouter model ID → catalog entry (for quick lookup) */
export const OR_MODEL_MAP: ReadonlyMap<string, OpenRouterModelEntry> = new Map(
  OR_MODEL_CATALOG.map(entry => [entry.id, entry]),
);

/** Map from SDK model ID → OpenRouter model ID (for BYOK → OR translation) */
const SDK_TO_OR_MAP: ReadonlyMap<string, string> = new Map(
  OR_MODEL_CATALOG
    .filter((e): e is OpenRouterModelEntry & { sdkModel: string } => !!e.sdkModel)
    .map(e => [e.sdkModel, e.id]),
);

/**
 * Map from OpenRouter model ID → pricing-compatible model ID (for cost tracking).
 *
 * Built from two sources in `MODEL_CATALOG`:
 *  - `entry.openRouter.sdkModel` — Anthropic SDK pricing key for Claude OR entries
 *  - `entry.openRouter.pricingFollows` — non-Anthropic OR entries whose suffix
 *    differs from the direct-provider pricing key (e.g., `google/gemini-3.1-pro-preview`
 *    → `gemini-3.1-pro`)
 */
export const OR_TO_SDK_MAP: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const e of OR_CATALOG_ENTRIES) {
    const routing = e.openRouter;
    if (routing.sdkModel) m.set(e.id, routing.sdkModel);
    else if (routing.pricingFollows) m.set(e.id, routing.pricingFollows);
  }
  return m;
})();

/**
 * Resolve an OpenRouter model ID to a pricing-compatible model ID.
 * Returns null if the input is not an OpenRouter-format model ID (no `/`).
 *
 * Resolution order:
 * 1. Explicit catalog mapping (e.g., 'anthropic/claude-sonnet-4-6' → 'claude-sonnet-4-6')
 * 2. Date-stripped catalog mapping (e.g., 'anthropic/claude-opus-4-6-20260205' → 'claude-opus-4-6')
 * 3. Anthropic pattern matching (e.g., 'anthropic/claude-4.6-opus-20260205' → 'claude-opus-4-6')
 * 4. Prefix-stripping fallback (e.g., 'openai/gpt-5.5' → 'gpt-5.5')
 *
 * Expects lowercase input (caller should normalize first).
 */
export function resolveOrModelToSdkId(orModelId: string): string | null {
  const legacyTarget = LEGACY_OR_MODEL_REMAP.get(orModelId);
  if (legacyTarget) return resolveOrModelToSdkId(legacyTarget);

  // 1. Exact catalog mapping
  const mapped = OR_TO_SDK_MAP.get(orModelId);
  if (mapped) return mapped;

  // 2. Try stripping trailing date (YYYYMMDD) and re-check catalog
  const dateStripped = orModelId.replace(/-\d{8}$/, '');
  if (dateStripped !== orModelId) {
    const mappedDateStripped = OR_TO_SDK_MAP.get(dateStripped);
    if (mappedDateStripped) return mappedDateStripped;
  }

  // 3. Strip provider prefix and try Anthropic pattern matching
  const slashIndex = orModelId.indexOf('/');
  if (slashIndex >= 0 && slashIndex < orModelId.length - 1) {
    const suffix = orModelId.slice(slashIndex + 1);
    const stripped = suffix.replace(/-\d{8}$/, '');

    // Match Anthropic claude-{version}-{tier} format (e.g., 'claude-4.6-opus' after prefix/date strip)
    const match = stripped.match(/^claude-(\d+\.\d+)-(\w+)$/);
    if (match) {
      return `claude-${match[2]}-${match[1].replace('.', '-')}`;  // 'claude-opus-4-6'
    }

    // 4. Final fallback: strip prefix and date, return suffix
    return stripped;
  }

  return null;
}

export interface OrModelOption {
  value: string;
  label: string;
  isMainModel: boolean;
  isAuxiliaryModel: boolean;
  auxiliaryHint?: string;
}

/** Main model options for OpenRouter provider (conversation models) */
export const OR_MAIN_MODEL_OPTIONS: OrModelOption[] = OR_MODEL_CATALOG
  .filter(e => e.isMainModel)
  .map(e => ({
    value: e.id,
    label: e.label,
    isMainModel: true,
    isAuxiliaryModel: e.isAuxiliaryModel,
    auxiliaryHint: e.auxiliaryHint,
  }));

/** Auxiliary/background model options for OpenRouter provider */
export const OR_AUXILIARY_MODEL_OPTIONS: OrModelOption[] = OR_MODEL_CATALOG
  .filter(e => e.isAuxiliaryModel)
  .map(e => ({
    value: e.id,
    label: e.auxiliaryHint ? `${e.label} ${e.auxiliaryHint}` : e.label,
    isMainModel: e.isMainModel,
    isAuxiliaryModel: true,
    auxiliaryHint: e.auxiliaryHint,
  }));

/** All model options for OpenRouter (used in fallback dropdowns) */
export const OR_ALL_MODEL_OPTIONS: OrModelOption[] = OR_MODEL_CATALOG.map(e => ({
  value: e.id,
  label: e.label,
  isMainModel: e.isMainModel,
  isAuxiliaryModel: e.isAuxiliaryModel,
  auxiliaryHint: e.auxiliaryHint,
}));

/** Normalize a potentially-stale OR model ID to its current replacement. Returns the input if no remap exists. */
export function normalizeOrModelId(modelId: string): string {
  return LEGACY_OR_MODEL_REMAP.get(modelId) ?? modelId;
}

/**
 * Translate a model ID when switching between BYOK (direct Anthropic) and OpenRouter providers.
 * Returns the closest equivalent model ID for the target provider, or a sensible default.
 */
export function remapModelOnProviderSwitch(
  currentModelId: string,
  toOpenRouter: boolean,
): string {
  if (toOpenRouter) {
    // BYOK SDK ID → OpenRouter ID
    return SDK_TO_OR_MAP.get(currentModelId) ?? 'openai/gpt-5.5';
  }
  // OpenRouter ID → SDK model ID
  const normalizedOrModelId = normalizeOrModelId(currentModelId);
  const entry = OR_MODEL_MAP.get(normalizedOrModelId);
  return entry?.sdkModel ?? 'claude-sonnet-4-6';
}
