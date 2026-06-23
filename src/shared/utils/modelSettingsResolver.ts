import type { AppSettings, ModelProfile, ModelSettings, ThinkingEffort } from '@shared/types';

import { getDefaultModelForProvider } from './getDefaultModelForProvider';

/**
 * # Decision Rule — Which API to Use
 *
 * This module is the canonical home for resolving "what model setting is in
 * effect right now" across desktop, cloud, and renderer. Choose the smallest
 * API that satisfies your read:
 *
 * 1. **Per-field accessors** (`getCurrentModel`, `getThinkingModel`,
 *    `getPermissionMode`, etc., re-exported from
 *    `@core/rebelCore/settingsAccessors`): use when you read **one** raw field
 *    from the materialized `models` namespace. No profile lookup, no prefix
 *    strip. Reads exactly what the user stored in `models`.
 *
 * 2. **Per-tier helpers** (`getEffectiveWorkingModel`,
 *    `getEffectiveThinkingModel`): use when you need the **effective** model
 *    for a single tier — i.e., profile→raw with bare-id normalization. Returns
 *    one bare model id, ready for capability checks or display.
 *
 * 3. **`resolveEffectiveModelSettings`**: use when a consumer needs ≥3 fields
 *    derived consistently (effective working model, thinking model, profiles,
 *    fallbacks, effort). Returns a `ResolvedModelSettings` view with all
 *    tier/profile/prefix derivation applied once.
 *
 * 4. **Per-turn synthesis** (the executor's `resolvePlanModeTarget` +
 *    `resolveModelConfig` step): contextual layer that applies the per-turn
 *    `thinkingModelOverride` and resolves the typed plan-mode target on top of
 *    the resolved view. Plan mode is a non-null `PlanModeTarget` carrying a
 *    branded `RoutingModelId` — NOT a synthetic `PREFERRED_PLANNING_MODEL`
 *    sentinel substituted into a string compare. Stays in the executor; do NOT
 *    migrate per-turn synthesis into this module.
 *
 * Direct `settings.claude.*` reads outside the allowlist are blocked by ESLint
 * (`no-restricted-properties`). When in doubt, use the resolved view.
 *
 * @see docs/plans/260505_canonical_settings_accessor_and_lint_enforced_read_path.md
 * @see docs/project/MODEL_SETTINGS_RESOLUTION.md — runtime model-settings resolution and migration materialization policy
 */

type ModelSettingsLike = Partial<NonNullable<AppSettings['models']>>;

export const MODEL_SETTINGS_FIELD_KEYS = [
  'apiKey',
  'oauthToken',
  'oauthRefreshToken',
  'oauthTokenExpiresAt',
  'authMethod',
  'model',
  'permissionMode',
  'executablePath',
  'planMode',
  'thinkingModel',
  'thinkingProfileId',
  'workingProfileId',
  'thinkingFallback',
  'workingFallback',
  'extendedContext',
  'learnedContextWindowEnabled',
  'longContextFallbackModel',
  'longContextFallbackProfileId',
  'thinkingEffort',
  'modelEfforts',
  'oauthProfile',
  'oauthMigratedAt',
  'usageData',
] as const satisfies ReadonlyArray<keyof ModelSettings>;

// Compile-time exhaustiveness guard. `satisfies` above proves every LISTED key is a
// real ModelSettings key; this proves the converse — every ModelSettings key is LISTED.
// Together the list is exactly `keyof ModelSettings`, so the migration/normalize
// materializer can never silently drop a field (the `learnedContextWindowEnabled`
// drift bug class — see docs/plans/260604_models_namespace_migration_cleanup/). If a new
// ModelSettings field is added without listing it here, this line fails to compile with
// the missing key name(s) in the error.
type ModelSettingsKeyCoverageGap = Exclude<keyof ModelSettings, (typeof MODEL_SETTINGS_FIELD_KEYS)[number]>;
const modelSettingsKeyCoverageCheck: ModelSettingsKeyCoverageGap extends never ? true : ModelSettingsKeyCoverageGap = true;
void modelSettingsKeyCoverageCheck;

export function resolveModelSettings(
  settings: Partial<Pick<AppSettings, 'models' | 'claude'>> | null | undefined,
): ModelSettingsLike {
  if (!settings) {
    return {};
  }

  const resolved: ModelSettingsLike = {};
  const modelsBlock = settings.models;
  const put = <K extends keyof ModelSettingsLike>(key: K, value: ModelSettingsLike[K] | undefined): void => {
    if (value !== undefined) {
      resolved[key] = value;
    }
  };

  for (const key of MODEL_SETTINGS_FIELD_KEYS) {
    if (
      modelsBlock &&
      typeof modelsBlock === 'object' &&
      !Array.isArray(modelsBlock) &&
      Object.prototype.hasOwnProperty.call(modelsBlock, key)
    ) {
      put(key, modelsBlock[key] as ModelSettingsLike[typeof key] | undefined);
    }
  }

  return resolved;
}

export function materializeModelsFromLegacy(
  settings: Partial<Pick<AppSettings, 'models' | 'claude'>> | null | undefined,
): ModelSettingsLike {
  if (!settings) {
    return {};
  }

  const resolved: ModelSettingsLike = {};
  const modelsBlock = settings.models;
  const legacyClaude = settings.claude;
  const put = <K extends keyof ModelSettingsLike>(key: K, value: ModelSettingsLike[K] | undefined): void => {
    if (value !== undefined) {
      resolved[key] = value;
    }
  };

  for (const key of MODEL_SETTINGS_FIELD_KEYS) {
    if (
      modelsBlock &&
      typeof modelsBlock === 'object' &&
      !Array.isArray(modelsBlock) &&
      Object.prototype.hasOwnProperty.call(modelsBlock, key)
    ) {
      put(key, modelsBlock[key] as ModelSettingsLike[typeof key] | undefined);
      continue;
    }

    if (
      legacyClaude &&
      typeof legacyClaude === 'object' &&
      !Array.isArray(legacyClaude) &&
      Object.prototype.hasOwnProperty.call(legacyClaude, key)
    ) {
      put(key, legacyClaude[key] as ModelSettingsLike[typeof key] | undefined);
    }
  }

  return resolved;
}

// =============================================================================
// Resolved view — Stage 1 of canonical settings accessor plan
// =============================================================================

/**
 * Provider-aware bare model id helper.
 *
 * Strips a leading `anthropic/` prefix only when the active provider is
 * unambiguously direct-Anthropic. Cross-provider ids (e.g. `openai/...`,
 * `deepseek-ai/...`, `meta-llama/...`) are preserved unchanged because they
 * are legitimate routing hints for OpenRouter and other namespaced providers.
 *
 * Contract:
 *  - bare ids (no `/`) are returned unchanged.
 *  - non-`anthropic/` slashed ids are returned unchanged regardless of provider.
 *  - `anthropic/...` is stripped only when `activeProvider` is `'anthropic'` or
 *    omitted (treated as direct-Anthropic by default).
 *  - empty input throws.
 *  - `anthropic/anthropic/...` (or any still-slashed result after strip) throws.
 *
 * Divergence from `resolveAnthropicWireModel`: this helper does NOT
 * dot-normalize (e.g. `claude-opus-4.7` is preserved as-is). Dot-normalization
 * is the wire-resolver's job; the accessor's contract is "strip provider
 * prefix only" so renderer/cloud-client/mobile callers see the same canonical
 * id regardless of wire dialect.
 *
 * @TODO 260505_typed_provider_capability_matrix: when `wireModelId(provider, profile)`
 *   from the typed provider capability matrix lands, consider whether
 *   `toBareModelId` becomes a forwarding call into that helper.
 */
export function toBareModelId(
  modelId: string,
  options?: { activeProvider?: string },
): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    throw new Error('toBareModelId: model id is empty');
  }
  if (!trimmed.includes('/')) {
    return trimmed;
  }
  const activeProvider = options?.activeProvider;
  const isDirectAnthropic = activeProvider === undefined || activeProvider === 'anthropic';
  if (!trimmed.startsWith('anthropic/')) {
    return trimmed;
  }
  if (!isDirectAnthropic) {
    return trimmed;
  }
  const stripped = trimmed.slice('anthropic/'.length);
  if (!stripped || stripped.includes('/')) {
    throw new Error(`toBareModelId: invalid model id "${modelId}"`);
  }
  return stripped;
}

/**
 * 10-field derived view returned by `resolveEffectiveModelSettings`. Each
 * field is composed from per-field reads via `resolveModelSettings`, with
 * profile lookup + bare-id normalization applied once.
 */
export interface ResolvedModelSettings {
  /** Effective working-tier model id (bare). */
  workingModel: string;
  /** Effective thinking-tier model id (bare), or undefined for single-model mode. */
  thinkingModel: string | undefined;
  /** Working-tier profile id, when set. */
  workingProfileId: string | undefined;
  /** Thinking-tier profile id, when set. */
  thinkingProfileId: string | undefined;
  /** Working-tier resolved profile object, when `workingProfileId` matches a profile. */
  workingProfile: ModelProfile | undefined;
  /** Thinking-tier resolved profile object, when `thinkingProfileId` matches a profile. */
  thinkingProfile: ModelProfile | undefined;
  /** Working-tier fallback (encoded `model:<id>` or `profile:<id>`). */
  workingFallback: string | undefined;
  /** Thinking-tier fallback (encoded `model:<id>` or `profile:<id>`). */
  thinkingFallback: string | undefined;
  /** Global thinking effort. */
  thinkingEffort: ThinkingEffort | undefined;
  /** Per-model thinking effort overrides. */
  modelEfforts: Partial<Record<string, ThinkingEffort>> | undefined;
}

type EffectiveResolveInput = Partial<Pick<AppSettings, 'models' | 'claude' | 'localModel'>>;

export interface ResolveEffectiveOptions {
  /** Optional override for `localModel` (when calling outside the AppSettings shape). */
  localModel?: AppSettings['localModel'];
  /** Active provider; controls whether `anthropic/` prefix is stripped. */
  activeProvider?: string;
  /**
   * When true (default), throw on malformed `models` namespace blocks.
   * When false, fall back to defaults; callers without an `onMalformed` handler
   * receive a `console.warn` so the degradation is observable.
   */
  throwOnMalformed?: boolean;
  /**
   * Optional callback invoked when malformed namespace blocks are encountered.
   * The `@core/` re-export wires this to `errorReporter.captureException`.
   */
  onMalformed?: (reason: string, ctx: { settingsKeys: string[] }) => void;
}

function isMalformedNamespaceBlock(block: unknown): boolean {
  if (block === null || block === undefined) {
    return false;
  }
  if (typeof block !== 'object') {
    return true;
  }
  if (Array.isArray(block)) {
    return true;
  }
  return false;
}

function findProfileById(
  localModel: AppSettings['localModel'] | undefined,
  profileId: string | undefined,
): ModelProfile | undefined {
  if (!profileId) {
    return undefined;
  }
  const profiles = localModel?.profiles;
  if (!profiles?.length) {
    return undefined;
  }
  return profiles.find((p) => p.id === profileId);
}

/**
 * Resolve the canonical effective model settings view.
 *
 * Composes per-field reads independently from the materialized `models`
 * namespace (no legacy `claude` runtime fallback). `models[K]` is used when
 * present, including `null` user-clears, which are authoritative.
 *
 * The returned bag has tier/profile/prefix derivation applied: profile lookups
 * by id, bare-id normalization via `toBareModelId`, and effort/fallback
 * pass-through. Defaults applied: `workingModel` falls back to the
 * provider-aware default via `getDefaultModelForProvider` when `models` has no
 * model id.
 */
export function resolveEffectiveModelSettings(
  settings: EffectiveResolveInput | null | undefined,
  options?: ResolveEffectiveOptions,
): ResolvedModelSettings {
  const throwOnMalformed = options?.throwOnMalformed ?? true;
  const onMalformed = options?.onMalformed;

  const modelsBlock = settings?.models;

  const malformedReasons: string[] = [];
  if (isMalformedNamespaceBlock(modelsBlock)) {
    malformedReasons.push('models');
  }
  if (malformedReasons.length > 0) {
    const reason = `malformed namespace block(s): ${malformedReasons.join(', ')}`;
    const ctx = { settingsKeys: settings ? Object.keys(settings) : [] };
    if (throwOnMalformed) {
      throw new Error(`resolveEffectiveModelSettings: ${reason}`);
    }
    if (onMalformed) {
      onMalformed(reason, ctx);
    } else {
      console.warn(`[resolveEffectiveModelSettings] ${reason}`, ctx);
    }
  }

  const resolved = resolveModelSettings(settings ?? undefined);

  const localModel = options?.localModel ?? settings?.localModel;
  const activeProvider = options?.activeProvider;

  const workingProfileId = resolved.workingProfileId;
  const thinkingProfileId = resolved.thinkingProfileId;
  const workingProfile = findProfileById(localModel, workingProfileId);
  const thinkingProfile = findProfileById(localModel, thinkingProfileId);

  const rawWorkingModel =
    workingProfile?.model ?? resolved.model ?? getDefaultModelForProvider({ activeProvider }, 'working');
  const rawThinkingModel = thinkingProfile?.model ?? resolved.thinkingModel;

  const workingModel = toBareModelId(rawWorkingModel, { activeProvider });
  const thinkingModel = rawThinkingModel
    ? toBareModelId(rawThinkingModel, { activeProvider })
    : undefined;

  return {
    workingModel,
    thinkingModel,
    workingProfileId,
    thinkingProfileId,
    workingProfile,
    thinkingProfile,
    workingFallback: resolved.workingFallback,
    thinkingFallback: resolved.thinkingFallback,
    thinkingEffort: resolved.thinkingEffort as ThinkingEffort | undefined,
    modelEfforts: resolved.modelEfforts,
  };
}

/**
 * Per-tier helper: returns the effective working-tier bare model id.
 * Equivalent to `resolveEffectiveModelSettings(...).workingModel` but cheaper
 * when only one field is needed.
 */
export function getEffectiveWorkingModel(
  settings: EffectiveResolveInput | null | undefined,
  options?: ResolveEffectiveOptions,
): string {
  return resolveEffectiveModelSettings(settings, options).workingModel;
}

/**
 * Per-tier helper: returns the effective thinking-tier bare model id, or
 * `undefined` when single-model mode (no thinking model configured).
 */
export function getEffectiveThinkingModel(
  settings: EffectiveResolveInput | null | undefined,
  options?: ResolveEffectiveOptions,
): string | undefined {
  return resolveEffectiveModelSettings(settings, options).thinkingModel;
}

export type { ModelSettings };
