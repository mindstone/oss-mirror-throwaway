/**
 * Provider-Neutral Settings Accessors for Rebel Core
 *
 * Node/Electron-side wrapper around `./settingsAccessorsPure`. The pure module
 * holds the materialized `models.*` per-field accessor surface; this wrapper
 * layers on:
 *
 *   1. Structured `log.warn` observability via `@core/logger` (with dedupe
 *      Sets so we don't spam logs for the same field/kind combination), and
 *   2. `errorReporter.captureException` reporting for malformed `models`
 *      namespace blocks via the effective resolvers.
 *
 * Renderer code paths must NOT import this module — they pull in
 * `@core/logger` (which calls `node:fs.mkdirSync` at module-init time) and
 * `@core/errorReporter` (Electron/Sentry main-process bindings) which crash
 * externalization on the landing loader. Renderer callers should import
 * `./settingsAccessorsPure` directly instead.
 *
 * Public signatures here are intentionally identical to the pre-split surface
 * (no `onWarn` parameter exposed) so existing Node/Electron callers stay
 * unchanged. Internally we route to the pure module passing a private
 * `onWarn` callback that drives the logger + dedupe Sets.
 *
 * @see src/core/rebelCore/settingsAccessorsPure.ts (renderer-safe pure twin)
 * @see docs/plans/260405_rebelcore_model_independence_final_cleanup.md (Stage 2)
 * @see docs/plans/260505_canonical_settings_accessor_and_lint_enforced_read_path.md (Stage 1)
 */
import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import {
  MODEL_SETTINGS_FIELD_KEYS,
  resolveModelSettings as resolveModelSettingsPure,
  getModelEfforts as getModelEffortsPure,
  getGlobalThinkingEffort as getGlobalThinkingEffortPure,
  getContextOverflowFallbackModel as getContextOverflowFallbackModelPure,
  getContextOverflowFallbackProfileId as getContextOverflowFallbackProfileIdPure,
  getCurrentModel as getCurrentModelPure,
  getThinkingModel as getThinkingModelPure,
  getThinkingProfileId as getThinkingProfileIdPure,
  getWorkingProfileId as getWorkingProfileIdPure,
  getThinkingFallback as getThinkingFallbackPure,
  getWorkingFallback as getWorkingFallbackPure,
  getApiKey as getApiKeyPure,
  getOAuthToken as getOAuthTokenPure,
  getAuthMethod as getAuthMethodPure,
  getPermissionMode as getPermissionModePure,
  getPlanMode as getPlanModePure,
  getExecutablePath as getExecutablePathPure,
  getExtendedContext as getExtendedContextPure,
  getLearnedContextWindowEnabled as getLearnedContextWindowEnabledPure,
  getOauthMigratedAt as getOauthMigratedAtPure,
} from './settingsAccessorsPure';
import type {
  ModelSettingsAccessorSettings,
  AccessorOnWarn,
} from './settingsAccessorsPure';
import {
  resolveEffectiveModelSettings as resolveEffectiveModelSettingsPure,
  getEffectiveWorkingModel as getEffectiveWorkingModelPure,
  getEffectiveThinkingModel as getEffectiveThinkingModelPure,
} from '@shared/utils/modelSettingsResolver';
import type {
  ResolvedModelSettings,
  ResolveEffectiveOptions,
} from '@shared/utils/modelSettingsResolver';
import type { AppSettings, ModelSettings, ThinkingEffort } from '@shared/types';

const log = createScopedLogger({ service: 'settingsAccessors' });

const warnedNullNamespaces = new Set<string>();
const warnedMalformedNamespaces = new Set<string>();

const onWarn: AccessorOnWarn = (namespace, kind, field) => {
  const key = `${namespace}:${String(field)}:${kind}`;
  if (kind === 'null') {
    if (warnedNullNamespaces.has(key)) {
      return;
    }
    warnedNullNamespaces.add(key);
    log.warn(
      { namespace, field },
      '[settings] namespace block is null; treating as absent'
    );
    return;
  }
  if (warnedMalformedNamespaces.has(key)) {
    return;
  }
  warnedMalformedNamespaces.add(key);
  log.warn(
    { namespace, field },
    '[settings] namespace block is malformed; treating as absent'
  );
};

export type { ModelSettingsAccessorSettings } from './settingsAccessorsPure';
export { MODEL_SETTINGS_FIELD_KEYS } from './settingsAccessorsPure';

export function resolveModelSettings(
  settings: ModelSettingsAccessorSettings,
): Partial<ModelSettings> {
  return resolveModelSettingsPure(settings, onWarn);
}

/**
 * Per-model thinking effort overrides map.
 *
 * Returns a map of model ID → effort level, allowing per-model thinking
 * configuration. When a model has an override, it takes precedence over
 * the global thinking effort.
 *
 * Reads from: `settings.models.modelEfforts`.
 */
export function getModelEfforts(
  settings: ModelSettingsAccessorSettings,
): Partial<Record<string, ThinkingEffort>> | undefined {
  return getModelEffortsPure(settings, onWarn);
}

/**
 * Global thinking effort level.
 *
 * The default effort applied to all models unless overridden by
 * a per-model entry in `getModelEfforts()`.
 *
 * Reads from: `settings.models.thinkingEffort`.
 */
export function getGlobalThinkingEffort(
  settings: ModelSettingsAccessorSettings,
): ThinkingEffort | undefined {
  return getGlobalThinkingEffortPure(settings, onWarn);
}

/**
 * Context overflow fallback model name.
 *
 * When the primary model hits its context window limit, the runtime
 * can fall back to this model (typically one with a larger context window).
 * Only used when no `longContextFallbackProfileId` is configured.
 *
 * Reads from: `settings.models.longContextFallbackModel`.
 */
export function getContextOverflowFallbackModel(
  settings: ModelSettingsAccessorSettings,
): string | undefined {
  return getContextOverflowFallbackModelPure(settings, onWarn);
}

/**
 * Context overflow fallback profile ID.
 *
 * When set, this profile takes precedence over `getContextOverflowFallbackModel()`
 * for context overflow fallback. Enables fallback to non-Anthropic providers
 * (e.g., an OpenAI profile with a larger context window).
 *
 * Reads from: `settings.models.longContextFallbackProfileId`.
 */
export function getContextOverflowFallbackProfileId(
  settings: ModelSettingsAccessorSettings,
): string | undefined {
  return getContextOverflowFallbackProfileIdPure(settings, onWarn);
}

export function getCurrentModel(settings: ModelSettingsAccessorSettings): string | undefined {
  return getCurrentModelPure(settings, onWarn);
}

export function getThinkingModel(settings: ModelSettingsAccessorSettings): string | undefined {
  return getThinkingModelPure(settings, onWarn);
}

export function getThinkingProfileId(settings: ModelSettingsAccessorSettings): string | undefined {
  return getThinkingProfileIdPure(settings, onWarn);
}

export function getWorkingProfileId(settings: ModelSettingsAccessorSettings): string | undefined {
  return getWorkingProfileIdPure(settings, onWarn);
}

export function getThinkingFallback(settings: ModelSettingsAccessorSettings): string | undefined {
  return getThinkingFallbackPure(settings, onWarn);
}

export function getWorkingFallback(settings: ModelSettingsAccessorSettings): string | undefined {
  return getWorkingFallbackPure(settings, onWarn);
}

export function getApiKey(settings: ModelSettingsAccessorSettings): string | null | undefined {
  return getApiKeyPure(settings, onWarn);
}

export function getOAuthToken(settings: ModelSettingsAccessorSettings): string | null | undefined {
  return getOAuthTokenPure(settings, onWarn);
}

export function getAuthMethod(settings: ModelSettingsAccessorSettings): string | undefined {
  return getAuthMethodPure(settings, onWarn);
}

export function getPermissionMode(settings: ModelSettingsAccessorSettings): ModelSettings['permissionMode'] | undefined {
  return getPermissionModePure(settings, onWarn);
}

export function getPlanMode(settings: ModelSettingsAccessorSettings): boolean | undefined {
  return getPlanModePure(settings, onWarn);
}

export function getExecutablePath(settings: ModelSettingsAccessorSettings): string | null | undefined {
  return getExecutablePathPure(settings, onWarn);
}

export function getExtendedContext(settings: ModelSettingsAccessorSettings): boolean | undefined {
  return getExtendedContextPure(settings, onWarn);
}

export function getLearnedContextWindowEnabled(settings: ModelSettingsAccessorSettings): boolean | undefined {
  return getLearnedContextWindowEnabledPure(settings, onWarn);
}

export function getOauthMigratedAt(settings: ModelSettingsAccessorSettings): string | undefined {
  return getOauthMigratedAtPure(settings, onWarn);
}

// Reference MODEL_SETTINGS_FIELD_KEYS to ensure tree-shakers preserve the
// re-export; also silences "unused import" lint for the named import above.
void MODEL_SETTINGS_FIELD_KEYS;

// =============================================================================
// Resolved view re-exports (observability layer)
//
// Wraps the pure `@shared/utils/modelSettingsResolver` resolver with a default
// `onMalformed` handler that reports to `errorReporter`. Callers may still pass
// their own `onMalformed` to override.
// =============================================================================

export { toBareModelId } from '@shared/utils/modelSettingsResolver';
export type { ResolvedModelSettings, ResolveEffectiveOptions } from '@shared/utils/modelSettingsResolver';

type EffectiveResolveInput = Partial<Pick<AppSettings, 'models' | 'localModel'>>;

function withErrorReporterOnMalformed(
  options: ResolveEffectiveOptions | undefined,
): ResolveEffectiveOptions {
  if (options?.onMalformed) {
    return options;
  }
  return {
    ...options,
    onMalformed: (reason, ctx) => {
      getErrorReporter().captureException(
        new Error('models namespace malformed'),
        {
          tags: { migration: 'models-namespace', condition: 'models_namespace_malformed' },
          fingerprint: ['models-namespace-malformed', reason],
          extra: { malformedReason: reason, ...ctx },
        },
      );
    },
  };
}

export function resolveEffectiveModelSettings(
  settings: EffectiveResolveInput | null | undefined,
  options?: ResolveEffectiveOptions,
): ResolvedModelSettings {
  return resolveEffectiveModelSettingsPure(settings, withErrorReporterOnMalformed(options));
}

export function getEffectiveWorkingModel(
  settings: EffectiveResolveInput | null | undefined,
  options?: ResolveEffectiveOptions,
): string {
  return getEffectiveWorkingModelPure(settings, withErrorReporterOnMalformed(options));
}

export function getEffectiveThinkingModel(
  settings: EffectiveResolveInput | null | undefined,
  options?: ResolveEffectiveOptions,
): string | undefined {
  return getEffectiveThinkingModelPure(settings, withErrorReporterOnMalformed(options));
}
