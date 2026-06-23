/**
 * # ModelChoice codec
 *
 * Bridges the wire shape (`AppSettings` storage) and the canonical
 * `ModelChoice` type. Storage stays as it is — the codec is the single
 * place that knows about dual fields, prefix-encoded strings, and UI
 * sentinels.
 *
 *  - `working` / `thinking`: dual fields (`workingProfileId | model`,
 *    `thinkingProfileId | thinkingModel`)
 *  - `background`: prefix-encoded string (`profile:<id>` / `model:<id>` /
 *    bare model id) on `behindTheScenesModel`
 *  - `recovery`: dual fields (`longContextFallbackProfileId |
 *    longContextFallbackModel`); empty = `auto`
 *
 * Fallbacks (`thinkingFallback` / `workingFallback` / `backgroundFallback`)
 * use the same `profile:<id>` / `model:<id>` prefix encoding.
 *
 * Authoritative reads go through `resolveModelSettings` so the canonical
 * `models` namespace wins over legacy `claude` per-field — see
 * `260505_canonical_settings_accessor_and_lint_enforced_read_path.md`.
 *
 * @see docs/plans/260509_centralize_model_role_selection.md
 */

import type { AppSettings } from '@shared/types';
import type { ModelChoice, RoleId } from '@shared/types/modelChoice';
import { resolveModelSettings } from './modelSettingsResolver';
import {
  PROFILE_PREFIX,
  MODEL_PREFIX,
  trim,
  mintRoutingModelId,
  mintProfileRef,
  decodePrefixed,
  type DecodedModelChoice,
} from './btsModelValueNormalization';

// Re-export the pure normalization helpers + types from their canonical
// (dependency-free) home so existing `@shared/utils/modelChoiceCodec` imports
// keep working unchanged. The implementations live in
// `btsModelValueNormalization.ts` to break a circular dependency:
//   modelChoiceCodec → modelSettingsResolver → getDefaultModelForProvider →
//   btsModelResolver → modelChoiceCodec
// See `260527_bts-tier-aware-default-resolver` planning doc.
export {
  PROFILE_PREFIX,
  MODEL_PREFIX,
  decodePrefixed,
  decodeRoutingModelId,
  unsafeAssertRoutingModelId,
  stripStoredModelPrefix,
  normalizeStoredBtsModelValue,
  rejectionReasonLabel,
} from './btsModelValueNormalization';
export type {
  StoredModelChoice,
  RoutingModelId,
  ProfileRef,
  NormalizationRejectionReason,
  NormalizedBtsModelValue,
  DecodedModelChoice,
} from './btsModelValueNormalization';

function encodePrefixed(choice: ModelChoice | null): string | undefined {
  if (!choice) return undefined;
  switch (choice.kind) {
    case 'profile':
      return choice.profileId ? `${PROFILE_PREFIX}${choice.profileId}` : undefined;
    case 'model':
      return choice.modelId ? `${MODEL_PREFIX}${choice.modelId}` : undefined;
    case 'inherit':
    case 'auto':
    case 'off':
      return undefined;
  }
}

type SettingsView = Pick<AppSettings, 'models' | 'claude' | 'localModel' | 'behindTheScenesModel' | 'backgroundFallback'>;

/**
 * Unwrap synthetic "virtual" profiles back into a model choice.
 *
 * `settingsUtils.upsertVirtualAnthropicProfile` injects a virtual profile
 * (id `__virtual-thinking` / `__virtual-working`, `isVirtual: true`) so the
 * runtime role-resolver has a profile to bill against when the active provider
 * is non-Anthropic but Claude is selected for thinking/working. That virtual
 * profile is settings-normalisation glue — it must not appear in user-facing
 * pickers as a `kind: 'profile'` choice (it isn't in the visible profile list,
 * which would render "Unknown profile (__virtual-thinking)").
 *
 * Decoding it back to `kind: 'model'` lets the picker select the real catalog
 * entry (e.g. "Claude Opus 4.7") for both display and re-selection.
 */
function unwrapVirtualProfile(
  profileId: string,
  settings: Partial<SettingsView> | null | undefined,
): DecodedModelChoice {
  const profile = settings?.localModel?.profiles?.find((p) => p.id === profileId);
  if (profile?.isVirtual && trim(profile.model)) {
    return { kind: 'model', modelId: mintRoutingModelId(trim(profile.model)) };
  }
  return { kind: 'profile', profileId: mintProfileRef(profileId) };
}

/**
 * Decode a role's primary `ModelChoice` from settings.
 *
 * Empty/missing storage maps to:
 *  - `working`: a `model` choice with the canonical default model id (so the UI
 *    always shows a sensible value even before the user has touched anything)
 *  - `thinking`: `{ kind: 'off' }`
 *  - `background`: a `model` choice with the auxiliary default
 *  - `recovery`: `{ kind: 'auto' }`
 *
 * Note: this codec does NOT validate that referenced profiles exist or are
 * usable — that's `resolveRoleAssignment`'s job. The codec is purely a wire
 * translation.
 */
export function decodeRoleChoice(
  role: RoleId,
  settings: Partial<SettingsView> | null | undefined,
  options: { defaultWorkingModel: string; defaultBackgroundModel: string },
): DecodedModelChoice {
  const resolved = resolveModelSettings(settings ?? undefined);

  switch (role) {
    case 'working': {
      const profileId = trim(resolved.workingProfileId);
      if (profileId) return unwrapVirtualProfile(profileId, settings);
      const legacyActive = trim(settings?.localModel?.activeProfileId);
      if (legacyActive) {
        const legacyProfile = settings?.localModel?.profiles?.find((p) => p.id === legacyActive);
        if (legacyProfile) return unwrapVirtualProfile(legacyActive, settings);
      }
      const modelId = trim(resolved.model);
      return { kind: 'model', modelId: mintRoutingModelId(modelId || options.defaultWorkingModel) };
    }
    case 'thinking': {
      const profileId = trim(resolved.thinkingProfileId);
      if (profileId) return unwrapVirtualProfile(profileId, settings);
      const modelId = trim(resolved.thinkingModel);
      if (modelId) return { kind: 'model', modelId: mintRoutingModelId(modelId) };
      return { kind: 'off' };
    }
    case 'background': {
      const raw = trim(settings?.behindTheScenesModel);
      const decoded = decodePrefixed(raw);
      if (decoded) return decoded;
      return { kind: 'model', modelId: mintRoutingModelId(options.defaultBackgroundModel) };
    }
    case 'recovery': {
      const profileId = trim(resolved.longContextFallbackProfileId);
      if (profileId) return { kind: 'profile', profileId: mintProfileRef(profileId) };
      const modelId = trim(resolved.longContextFallbackModel);
      if (modelId) return { kind: 'model', modelId: mintRoutingModelId(modelId) };
      return { kind: 'auto' };
    }
  }
}

/**
 * Decode a role's fallback `ModelChoice` from settings, or null if no
 * fallback is configured. Recovery has no fallback (the role itself is the
 * fallback).
 */
export function decodeRoleFallback(
  role: RoleId,
  settings: Partial<SettingsView> | null | undefined,
): DecodedModelChoice | null {
  const resolved = resolveModelSettings(settings ?? undefined);
  switch (role) {
    case 'working':
      return decodePrefixed(trim(resolved.workingFallback));
    case 'thinking':
      return decodePrefixed(trim(resolved.thinkingFallback));
    case 'background':
      return decodePrefixed(trim(settings?.backgroundFallback));
    case 'recovery':
      return null;
  }
}

/**
 * Encoded fields for a role's primary choice. Caller spreads these into the
 * appropriate slice of `AppSettings`. `undefined` means "clear this field".
 *
 * For `working`/`thinking`/`recovery`: returns a partial models block.
 * For `background`: returns a partial of the top-level (`behindTheScenesModel`).
 */
export type RoleChoiceEncoding =
  | { scope: 'models'; fields: Partial<NonNullable<AppSettings['models']>> }
  | { scope: 'top'; fields: Partial<Pick<AppSettings, 'behindTheScenesModel' | 'backgroundFallback'>> };

/**
 * Encode a primary role choice back to storage shape. Caller is responsible
 * for clearing the OTHER side of the dual field (the function returns
 * explicit `undefined` values to make this safe to spread).
 */
export function encodeRoleChoice(role: RoleId, choice: ModelChoice): RoleChoiceEncoding {
  switch (role) {
    case 'working':
      switch (choice.kind) {
        case 'profile':
          return { scope: 'models', fields: { workingProfileId: choice.profileId, model: undefined } };
        case 'model':
          return { scope: 'models', fields: { workingProfileId: undefined, model: choice.modelId } };
        case 'inherit':
        case 'auto':
        case 'off':
          return { scope: 'models', fields: { workingProfileId: undefined, model: undefined } };
      }
      break;
    case 'thinking':
      switch (choice.kind) {
        case 'profile':
          return { scope: 'models', fields: { thinkingProfileId: choice.profileId, thinkingModel: undefined } };
        case 'model':
          return { scope: 'models', fields: { thinkingProfileId: undefined, thinkingModel: choice.modelId } };
        case 'off':
        case 'inherit':
          return { scope: 'models', fields: { thinkingProfileId: undefined, thinkingModel: undefined } };
        case 'auto':
          return { scope: 'models', fields: { thinkingProfileId: undefined, thinkingModel: undefined } };
      }
      break;
    case 'background':
      return { scope: 'top', fields: { behindTheScenesModel: encodePrefixed(choice) } };
    case 'recovery':
      switch (choice.kind) {
        case 'profile':
          return {
            scope: 'models',
            fields: { longContextFallbackProfileId: choice.profileId, longContextFallbackModel: undefined },
          };
        case 'model':
          return {
            scope: 'models',
            fields: { longContextFallbackProfileId: undefined, longContextFallbackModel: choice.modelId },
          };
        case 'inherit':
        case 'auto':
        case 'off':
          return {
            scope: 'models',
            fields: { longContextFallbackProfileId: undefined, longContextFallbackModel: undefined },
          };
      }
  }
  // Exhaustiveness fallback (unreachable).
  return { scope: 'models', fields: {} };
}

/**
 * Encode a fallback choice back to storage shape. `null` clears the fallback.
 */
export function encodeRoleFallback(role: RoleId, fallback: ModelChoice | null): RoleChoiceEncoding {
  switch (role) {
    case 'working':
      return { scope: 'models', fields: { workingFallback: encodePrefixed(fallback) } };
    case 'thinking':
      return { scope: 'models', fields: { thinkingFallback: encodePrefixed(fallback) } };
    case 'background':
      return { scope: 'top', fields: { backgroundFallback: encodePrefixed(fallback) } };
    case 'recovery':
      return { scope: 'models', fields: {} };
  }
}
