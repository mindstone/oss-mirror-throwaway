import type { AppSettings, ModelProfile, ModelRoleTier } from '@shared/types';
import { normalizeOrModelId } from '@shared/data/openRouterModels';
import { isNetworkError, isRateLimitMessage } from '@shared/utils/friendlyErrors';
import { decodeRoleFallback } from '@shared/utils/modelChoiceCodec';
import { isProfileSelectable } from '@shared/utils/profileHelpers';

/**
 * The model-role tier whose fallback is being resolved. Canonical type:
 * {@link ModelRoleTier} (single source of tier membership — these no longer
 * drift). Kept as a domain-named alias for call-site readability.
 */
export type ConfiguredFallbackRole = ModelRoleTier;

export type ConfiguredRoleFallbackAttemptState = Partial<Record<ConfiguredFallbackRole, boolean>>;

export type ModelRuntimePhase = 'planning' | 'execution' | 'bts';

export interface ModelRuntimeRoleMetadata {
  role: ConfiguredFallbackRole;
  model?: string;
  phase?: ModelRuntimePhase;
}

const MODEL_RUNTIME_ROLE_METADATA_SYMBOL = Symbol.for('rebel.model_runtime_role_metadata');

function isObjectLike(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

export function annotateModelRuntimeRole<T>(
  error: T,
  metadata: ModelRuntimeRoleMetadata,
): T {
  if (!isObjectLike(error)) return error;
  const existing = getModelRuntimeRoleMetadata(error);
  const next = existing ? { ...existing, ...metadata } : metadata;
  Object.defineProperty(error, MODEL_RUNTIME_ROLE_METADATA_SYMBOL, {
    value: next,
    configurable: true,
    writable: true,
    enumerable: false,
  });
  return error;
}

export function getModelRuntimeRoleMetadata(error: unknown): ModelRuntimeRoleMetadata | undefined {
  if (!isObjectLike(error)) return undefined;
  const metadata = error[MODEL_RUNTIME_ROLE_METADATA_SYMBOL];
  if (!metadata || typeof metadata !== 'object') return undefined;
  const typed = metadata as Partial<ModelRuntimeRoleMetadata>;
  if (typed.role !== 'working' && typed.role !== 'thinking' && typed.role !== 'background') {
    return undefined;
  }
  return {
    role: typed.role,
    ...(typeof typed.model === 'string' ? { model: typed.model } : {}),
    ...(typed.phase === 'planning' || typed.phase === 'execution' || typed.phase === 'bts'
      ? { phase: typed.phase }
      : {}),
  };
}

export type ConfiguredFallbackRouteHintTarget =
  | { kind: 'model'; model: string }
  | { kind: 'profile'; profileId: string };

export interface ConfiguredFallbackModelTarget {
  kind: 'model';
  model: string;
  encoded: string;
}

export interface ConfiguredFallbackProfileTarget {
  kind: 'profile';
  profileId: string;
  profile: ModelProfile;
  encoded: string;
}

export type ConfiguredFallbackTarget = ConfiguredFallbackModelTarget | ConfiguredFallbackProfileTarget;

export type ConfiguredFallbackSkipReason =
  | 'skip_no_fallback'
  | 'skip_not_recoverable'
  | 'skip_already_attempted'
  | 'skip_same_target'
  | 'skip_unroutable';

export type ConfiguredFallbackDecision =
  | { kind: 'use_fallback'; role: ConfiguredFallbackRole; target: ConfiguredFallbackTarget }
  | { kind: 'skip'; role: ConfiguredFallbackRole; reason: ConfiguredFallbackSkipReason };

export interface ResolveConfiguredRoleFallbackInput {
  role: ConfiguredFallbackRole;
  settings: AppSettings | Partial<AppSettings> | null | undefined;
  availableProfiles?: ReadonlyArray<ModelProfile> | null;
  attempted?: boolean;
  errorKind: string | null | undefined;
  errorMessage?: string | null;
  allowRateLimit?: boolean;
  currentModel?: string | null;
  currentProfileId?: string | null;
}

export function normalizeComparableModelId(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;
  return normalizeOrModelId(trimmed).toLowerCase();
}

function isFallbackProfileRoutable(profile: ModelProfile | undefined): profile is ModelProfile {
  if (!profile) return false;
  if (profile.enabled === false) return false;
  if (!isProfileSelectable(profile)) return false;
  return typeof profile.model === 'string' && profile.model.trim().length > 0;
}

function isSameTarget(
  target: ConfiguredFallbackTarget,
  current: { model?: string | null; profileId?: string | null },
): boolean {
  const currentProfileId = current.profileId?.trim();
  const currentModel = normalizeComparableModelId(current.model);

  if (target.kind === 'profile') {
    if (currentProfileId && currentProfileId === target.profileId) {
      return true;
    }
    if (!currentProfileId) {
      const fallbackProfileModel = normalizeComparableModelId(target.profile.model);
      if (fallbackProfileModel && currentModel && fallbackProfileModel === currentModel) {
        return true;
      }
    }
    return false;
  }

  if (currentProfileId) {
    return false;
  }
  const targetModel = normalizeComparableModelId(target.model);
  return Boolean(targetModel && currentModel && targetModel === currentModel);
}

export function isConfiguredRoleFallbackEligibleError(input: {
  errorKind: string | null | undefined;
  errorMessage?: string | null;
  allowRateLimit?: boolean;
}): boolean {
  const errorMessage = input.errorMessage ?? '';
  if (errorMessage && isNetworkError(errorMessage)) {
    return false;
  }

  switch (input.errorKind) {
    case 'server_error':
    case 'model_unavailable':
      return true;
    case 'network':
      return false;
    case 'rate_limit':
      return input.allowRateLimit === true;
    case undefined:
    case null:
    default:
      // Text-classified 429: the handler in turnErrorRecovery accepts mid-stream
      // rate limits matched by isRateLimitMessage() even when getErrorKind()
      // doesn't tag them 'rate_limit' (e.g. providers that return a non-standard
      // shape). Without this branch the resolver silently rejects them as
      // skip_not_recoverable, even though the calling handler classified them as
      // rate-limited and passed allowRateLimit:true. Match that classification
      // here so configured role fallback actually fires.
      if (input.allowRateLimit === true && errorMessage && isRateLimitMessage(errorMessage)) {
        return true;
      }
      return false;
  }
}

export function resolveConfiguredRoleFallback(
  input: ResolveConfiguredRoleFallbackInput,
): ConfiguredFallbackDecision {
  if (input.attempted) {
    return { kind: 'skip', role: input.role, reason: 'skip_already_attempted' };
  }

  if (!isConfiguredRoleFallbackEligibleError({
    errorKind: input.errorKind,
    errorMessage: input.errorMessage,
    allowRateLimit: input.allowRateLimit,
  })) {
    return { kind: 'skip', role: input.role, reason: 'skip_not_recoverable' };
  }

  const fallback = decodeRoleFallback(input.role, input.settings);
  if (!fallback || (fallback.kind !== 'model' && fallback.kind !== 'profile')) {
    return { kind: 'skip', role: input.role, reason: 'skip_no_fallback' };
  }

  let target: ConfiguredFallbackTarget;

  if (fallback.kind === 'model') {
    const model = fallback.modelId.trim();
    if (!model) {
      return { kind: 'skip', role: input.role, reason: 'skip_no_fallback' };
    }
    target = {
      kind: 'model',
      model,
      encoded: `model:${model}`,
    };
  } else {
    const profileId = fallback.profileId.trim();
    if (!profileId) {
      return { kind: 'skip', role: input.role, reason: 'skip_no_fallback' };
    }
    const profile = (input.availableProfiles ?? []).find((candidate) => candidate.id === profileId);
    if (!isFallbackProfileRoutable(profile)) {
      return { kind: 'skip', role: input.role, reason: 'skip_unroutable' };
    }
    target = {
      kind: 'profile',
      profileId,
      profile,
      encoded: `profile:${profileId}`,
    };
  }

  if (isSameTarget(target, { model: input.currentModel, profileId: input.currentProfileId })) {
    return { kind: 'skip', role: input.role, reason: 'skip_same_target' };
  }

  return { kind: 'use_fallback', role: input.role, target };
}

export function toConfiguredFallbackRouteHintTarget(
  target: ConfiguredFallbackTarget,
): ConfiguredFallbackRouteHintTarget {
  switch (target.kind) {
    case 'model':
      return { kind: 'model', model: target.model };
    case 'profile':
      return { kind: 'profile', profileId: target.profileId };
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}
