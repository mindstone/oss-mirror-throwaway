/**
 * Renderer-Safe Pure Twin of `settingsAccessors`
 *
 * Mirrors the materialized `models.*` per-field accessor surface of
 * `@core/rebelCore/settingsAccessors`, but has NO runtime imports from
 * `@core/*` — specifically no `@core/logger` (which
 * pulls in `node:fs.mkdirSync`) and no `@core/errorReporter` (which pulls in
 * Electron/Sentry main-process bindings).
 *
 * Renderer code paths (e.g. `@shared/utils/councilProfiles`) import from this
 * module so that lazy-loading them in the browser bundle does not drag the
 * Node-only `@core/logger` boot-time `mkdirSync` call into the renderer
 * (which crashes externalization on the landing loader).
 *
 * Observability hook: instead of importing `@core/logger`/`@core/errorReporter`
 * directly, each accessor accepts an optional `onWarn(namespace, kind, field)`
 * callback so the Node/Electron-side wrapper (`settingsAccessors.ts`) can
 * route warnings to its scoped logger and dedupe Sets while the renderer can
 * pass `undefined` (silent) or its own console-based handler.
 *
 * Effective resolvers (`resolveEffectiveModelSettings`, `getEffectiveWorkingModel`,
 * `getEffectiveThinkingModel`) are re-exported directly from the already-pure
 * `@shared/utils/modelSettingsResolver` resolver — no `errorReporter` wrap.
 * Desktop/Cloud callers should continue to use the `settingsAccessors.ts`
 * wrapper to get full Sentry reporting on malformed namespace blocks.
 *
 * @see src/core/rebelCore/settingsAccessors.ts (Node/Electron wrapper)
 * @see docs/plans/260405_rebelcore_model_independence_final_cleanup.md (Stage 2)
 * @see docs/plans/260505_canonical_settings_accessor_and_lint_enforced_read_path.md (Stage 1)
 */
import {
  MODEL_SETTINGS_FIELD_KEYS as SHARED_MODEL_SETTINGS_FIELD_KEYS,
  resolveEffectiveModelSettings as resolveEffectiveModelSettingsPure,
  getEffectiveWorkingModel as getEffectiveWorkingModelPure,
  getEffectiveThinkingModel as getEffectiveThinkingModelPure,
} from '@shared/utils/modelSettingsResolver';
import type {
  ResolvedModelSettings,
  ResolveEffectiveOptions,
} from '@shared/utils/modelSettingsResolver';
import type { ModelSettings, ThinkingEffort } from '@shared/types';

export type ModelSettingsAccessorSettings = {
  models?: Partial<ModelSettings> | null;
};

export type AccessorWarnKind = 'null' | 'malformed';
export type AccessorOnWarn = (
  namespace: 'models',
  kind: AccessorWarnKind,
  field: keyof ModelSettings,
) => void;

export { MODEL_SETTINGS_FIELD_KEYS } from '@shared/utils/modelSettingsResolver';

function readField<K extends keyof ModelSettings>(
  settings: ModelSettingsAccessorSettings,
  key: K,
  onWarn?: AccessorOnWarn,
): ModelSettings[K] | undefined {
  const modelsBlock = settings.models as unknown;
  if (modelsBlock === null) {
    onWarn?.('models', 'null', key);
  } else if (modelsBlock !== undefined && (typeof modelsBlock !== 'object' || Array.isArray(modelsBlock))) {
    onWarn?.('models', 'malformed', key);
  } else if (
    modelsBlock !== undefined &&
    Object.prototype.hasOwnProperty.call(modelsBlock, key)
  ) {
    return (modelsBlock as Partial<ModelSettings>)[key] as ModelSettings[K];
  }

  return undefined;
}

export function resolveModelSettings(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): Partial<ModelSettings> {
  const resolved: Partial<ModelSettings> = {};
  const put = <K extends keyof ModelSettings>(key: K, value: ModelSettings[K] | undefined): void => {
    if (value !== undefined) {
      resolved[key] = value;
    }
  };

  for (const key of SHARED_MODEL_SETTINGS_FIELD_KEYS) {
    put(key, readField(settings, key, onWarn));
  }

  return resolved;
}

export function getModelEfforts(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): Partial<Record<string, ThinkingEffort>> | undefined {
  return readField(settings, 'modelEfforts', onWarn);
}

export function getGlobalThinkingEffort(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): ThinkingEffort | undefined {
  return readField(settings, 'thinkingEffort', onWarn);
}

export function getContextOverflowFallbackModel(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): string | undefined {
  return readField(settings, 'longContextFallbackModel', onWarn);
}

export function getContextOverflowFallbackProfileId(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): string | undefined {
  return readField(settings, 'longContextFallbackProfileId', onWarn);
}

export function getCurrentModel(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): string | undefined {
  return readField(settings, 'model', onWarn);
}

export function getThinkingModel(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): string | undefined {
  return readField(settings, 'thinkingModel', onWarn);
}

export function getThinkingProfileId(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): string | undefined {
  return readField(settings, 'thinkingProfileId', onWarn);
}

export function getWorkingProfileId(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): string | undefined {
  return readField(settings, 'workingProfileId', onWarn);
}

export function getThinkingFallback(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): string | undefined {
  return readField(settings, 'thinkingFallback', onWarn);
}

export function getWorkingFallback(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): string | undefined {
  return readField(settings, 'workingFallback', onWarn);
}

export function getApiKey(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): string | null | undefined {
  return readField(settings, 'apiKey', onWarn);
}

export function getOAuthToken(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): string | null | undefined {
  return readField(settings, 'oauthToken', onWarn);
}

export function getAuthMethod(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): string | undefined {
  return readField(settings, 'authMethod', onWarn);
}

export function getPermissionMode(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): ModelSettings['permissionMode'] | undefined {
  return readField(settings, 'permissionMode', onWarn);
}

export function getPlanMode(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): boolean | undefined {
  return readField(settings, 'planMode', onWarn);
}

export function getExecutablePath(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): string | null | undefined {
  return readField(settings, 'executablePath', onWarn);
}

export function getExtendedContext(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): boolean | undefined {
  return readField(settings, 'extendedContext', onWarn);
}

/**
 * Master kill-switch for the context-window auto-learn writer. Default-off:
 * an absent/undefined value reads as `false` at the call site. See
 * `learnedProfileWriter.recordContextOverflowOnProfile`.
 */
export function getLearnedContextWindowEnabled(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): boolean | undefined {
  return readField(settings, 'learnedContextWindowEnabled', onWarn);
}

export function getOauthMigratedAt(
  settings: ModelSettingsAccessorSettings,
  onWarn?: AccessorOnWarn,
): string | undefined {
  return readField(settings, 'oauthMigratedAt', onWarn);
}

// =============================================================================
// Resolved view re-exports (pure passthrough — no errorReporter wrap)
//
// Renderer code that wants malformed-namespace reporting must pass its own
// `onMalformed` callback. Desktop/Cloud callers should use
// `@core/rebelCore/settingsAccessors` instead to get the errorReporter wrap.
// =============================================================================

export { toBareModelId } from '@shared/utils/modelSettingsResolver';
export type { ResolvedModelSettings, ResolveEffectiveOptions } from '@shared/utils/modelSettingsResolver';

export function resolveEffectiveModelSettings(
  settings: Parameters<typeof resolveEffectiveModelSettingsPure>[0],
  options?: ResolveEffectiveOptions,
): ResolvedModelSettings {
  return resolveEffectiveModelSettingsPure(settings, options);
}

export function getEffectiveWorkingModel(
  settings: Parameters<typeof getEffectiveWorkingModelPure>[0],
  options?: ResolveEffectiveOptions,
): string {
  return getEffectiveWorkingModelPure(settings, options);
}

export function getEffectiveThinkingModel(
  settings: Parameters<typeof getEffectiveThinkingModelPure>[0],
  options?: ResolveEffectiveOptions,
): string | undefined {
  return getEffectiveThinkingModelPure(settings, options);
}
