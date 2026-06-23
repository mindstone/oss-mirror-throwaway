import type { ModelProfile, ModelSettings, ModelRoleTier, ModelRoleWire } from '@shared/types';
import { isProfileSelectable } from '@shared/utils/profileHelpers';
import {
  decodeRoutingModelId,
  normalizeStoredBtsModelValue,
  rejectionReasonLabel,
  type RoutingModelId,
} from '@shared/utils/modelChoiceCodec';
import { DEFAULT_AUXILIARY_MODEL } from '@shared/utils/modelNormalization';

type NullableModelSettings = {
  [K in keyof ModelSettings]?: ModelSettings[K] | null;
};

/**
 * Runtime iteration order for the canonical capability tiers. The cheap/auxiliary
 * tier is spelled `'background'` (see {@link ModelRoleTier}). This is the runtime
 * array; `ModelRole` is the canonical type — same membership by construction.
 *
 * The internal tier (`'background'`) intentionally diverges from the persisted
 * WIRE spelling (`ModelRoleWire`, `'fast'`). The wire is an isolated boundary:
 * `ModelRoleBinding.role` is authored as wire literals in
 * `agentMessageHandler.buildModelRoles` and read back by the usage tooltip / usage
 * summary — it never crosses with this canonical type, so no runtime mapper is
 * needed (and already-persisted `'fast'` turns stay valid). If a future consumer
 * needs to convert, add an explicit mapper rather than reviving a lockstep guard.
 *
 * @internal Canonical reference array currently consumed only by the wire-invariant
 * test (modelRoleTier.wireInvariant.test.ts) — no production import yet, so the knip
 * production leg flags it; the default leg keeps tracking it.
 */
export const MODEL_ROLES = ['thinking', 'working', 'background'] as const satisfies readonly ModelRoleTier[];

export type ModelRole = ModelRoleTier;

export type RoleResolutionFailureReason =
  | 'no-profile-and-no-setting-for-role'
  | 'profile-disabled-or-incomplete'
  | 'role-key-references-unknown-profile';

export type RoleResolutionSuccess = {
  ok: true;
  role: ModelRole;
  source: 'profile' | 'setting';
  model: RoutingModelId;
  profileId?: string;
};

export type RoleResolutionFailure = {
  ok: false;
  role: ModelRole;
  reason: RoleResolutionFailureReason;
  profileId?: string;
};

export type RoleResolution = RoleResolutionSuccess | RoleResolutionFailure;

export type RoleModelPrecedenceResolution = {
  effectiveModelId: RoutingModelId | null;
  failureReason: RoleResolutionFailureReason | null;
};

export type ModelRoleResolverSettings = {
  models?: NullableModelSettings | null;
  behindTheScenesModel?: string | null;
  localModel?: {
    activeProfileId?: string | null;
    profiles?: readonly ModelProfile[];
  };
};

const ROLE_LABELS: Record<ModelRole, string> = {
  thinking: 'Thinking',
  working: 'Working',
  background: 'Behind the Scenes',
};

export const ROLE_NOT_CONFIGURED_STATUS_PREFIX = 'agent:role-not-configured:';

function trimToUndefined(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readModelField<K extends keyof ModelSettings>(
  settings: ModelRoleResolverSettings,
  key: K,
): ModelSettings[K] | null | undefined {
  // eslint-disable-next-line no-restricted-properties -- Canonical role-resolver reader. The `settings` parameter is `ModelRoleResolverSettings` (not AppSettings); this helper IS the per-field accessor abstraction the rule directs callers to.
  const models = settings.models;
  if (models && typeof models === 'object' && !Array.isArray(models)) {
    if (Object.prototype.hasOwnProperty.call(models, key)) {
      return models[key] as ModelSettings[K] | null;
    }
    return undefined;
  }
  return undefined;
}

function profileModel(profile: ModelProfile | undefined): string | undefined {
  return trimToUndefined(profile?.model);
}

function decodedModel(value: string | null | undefined): RoutingModelId | undefined {
  const trimmed = trimToUndefined(value);
  if (!trimmed) return undefined;
  return decodeRoutingModelId(trimmed) ?? undefined;
}

function profileIsUsable(profile: ModelProfile | undefined): profile is ModelProfile {
  if (!profile) return false;
  if (profile.enabled === false) return false;
  if (!isProfileSelectable(profile)) return false;
  return Boolean(profileModel(profile));
}

function findProfileById(
  profilesById: ReadonlyMap<string, ModelProfile>,
  profileId: string | null | undefined,
): ModelProfile | undefined {
  if (!profileId) return undefined;
  return profilesById.get(profileId);
}

function resolveSettingsProfile(
  role: 'thinking' | 'working',
  settings: ModelRoleResolverSettings,
  profilesById: ReadonlyMap<string, ModelProfile>,
): RoleResolution | null {
  const roleProfileId = role === 'thinking'
    ? readModelField(settings, 'thinkingProfileId')
    : readModelField(settings, 'workingProfileId');

  if (roleProfileId) {
    const roleProfile = findProfileById(profilesById, roleProfileId);
    if (!roleProfile) {
      return { ok: false, role, reason: 'role-key-references-unknown-profile', profileId: roleProfileId };
    }
    if (profileIsUsable(roleProfile)) {
      const model = decodedModel(profileModel(roleProfile));
      if (model) {
        return {
          ok: true,
          role,
          source: 'profile',
          model,
          profileId: roleProfile.id,
        };
      }
    }
  } else if (role === 'working') {
    const activeProfileId = settings.localModel?.activeProfileId;
    const activeProfile = findProfileById(profilesById, activeProfileId);
    if (profileIsUsable(activeProfile)) {
      const model = decodedModel(profileModel(activeProfile));
      if (model) {
        return {
          ok: true,
          role: 'working',
          source: 'profile',
          model,
          profileId: activeProfile.id,
        };
      }
    }
  }

  const settingModel = role === 'thinking'
    ? decodedModel(readModelField(settings, 'thinkingModel') as string | null | undefined)
    : decodedModel(readModelField(settings, 'model') as string | null | undefined);

  if (settingModel) {
    return { ok: true, role, source: 'setting', model: settingModel };
  }

  if (roleProfileId) {
    return { ok: false, role, reason: 'profile-disabled-or-incomplete', profileId: roleProfileId };
  }

  return { ok: false, role, reason: 'no-profile-and-no-setting-for-role' };
}

function resolveRoleResolution(
  role: ModelRole,
  settings: ModelRoleResolverSettings,
  profilesById: ReadonlyMap<string, ModelProfile>,
): RoleResolution {
  if (role === 'background') {
    return resolveFastRole(settings, profilesById);
  }

  return resolveSettingsProfile(role, settings, profilesById)
    ?? { ok: false, role, reason: 'no-profile-and-no-setting-for-role' };
}

export function resolveModelRolePrecedence(
  role: ModelRole,
  settings: ModelRoleResolverSettings,
  profiles: readonly ModelProfile[],
): RoleModelPrecedenceResolution {
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const resolution = resolveRoleResolution(role, settings, profilesById);
  if (resolution.ok) {
    return { effectiveModelId: resolution.model, failureReason: null };
  }
  return { effectiveModelId: null, failureReason: resolution.reason };
}

/** @internal Exported for testing. */
export function resolveFastRole(
  settings: ModelRoleResolverSettings,
  profilesById: ReadonlyMap<string, ModelProfile>,
): RoleResolution {
  // Legacy settings files predating BTS-model resolution have no
  // behindTheScenesModel set. Without this fallback, fast/haiku subagents
  // skip with "fast model is not configured" — a silent degradation for
  // anyone whose settings file was written before the BTS model was
  // promoted to a first-class setting. Fall back to the canonical default
  // (claude-haiku-4-5) so subagents work out of the box; users can still
  // override via Settings → Models. Other clear-to-undefined paths in
  // normalizeSettings (stale profile:<id>, etc.) intentionally keep the
  // user-set state — this fallback only applies when no BTS setting is
  // present at all.
  const rawBtsSetting = settings.behindTheScenesModel;
  const normalized = normalizeStoredBtsModelValue(rawBtsSetting);

  if (!normalized.ok) {
    if (typeof rawBtsSetting === 'string' && rawBtsSetting.length > 0) {
      const resolutionMessage = normalized.reason === 'empty-profile-id'
        ? 'returning role-key-references-unknown-profile'
        : 'falling through to DEFAULT_AUXILIARY_MODEL';
      console.warn(`[resolveFastRole] BTS read rejected by normalizer: ${rejectionReasonLabel(normalized.reason)}; ${resolutionMessage}`, {
        siteId: 'modelRoleResolver:resolveFastRole',
        rawTruncated: rawBtsSetting.slice(0, 32),
        rejectionReason: normalized.reason,
      });
    } else if (rawBtsSetting != null && typeof rawBtsSetting !== 'string') {
      console.warn(`[resolveFastRole] BTS read rejected non-string input by normalizer: ${rejectionReasonLabel(normalized.reason)}; falling through to DEFAULT_AUXILIARY_MODEL`, {
        siteId: 'modelRoleResolver:resolveFastRole',
        rawType: typeof rawBtsSetting,
        rejectionReason: normalized.reason,
      });
    }
    if (normalized.reason === 'empty-profile-id') {
      return { ok: false, role: 'background', reason: 'role-key-references-unknown-profile' };
    }
    return { ok: true, role: 'background', source: 'setting', model: decodedModel(DEFAULT_AUXILIARY_MODEL)! };
  }

  if (normalized.kind === 'profile') {
    const profileId = normalized.profileId;
    const profile = findProfileById(profilesById, profileId);
    if (!profile) {
      return { ok: false, role: 'background', reason: 'role-key-references-unknown-profile', profileId };
    }
    if (!profileIsUsable(profile)) {
      return { ok: false, role: 'background', reason: 'profile-disabled-or-incomplete', profileId };
    }
    const model = decodedModel(profileModel(profile));
    if (!model) {
      return { ok: false, role: 'background', reason: 'profile-disabled-or-incomplete', profileId };
    }
    return {
      ok: true,
      role: 'background',
      source: 'profile',
      model,
      profileId: profile.id,
    };
  }

  return { ok: true, role: 'background', source: 'setting', model: normalized.modelId };
}

/**
 * Resolve the runtime model for a semantic role without introducing provider defaults.
 *
 * Priority order:
 * 1) Role-bound profile ID (thinkingProfileId / workingProfileId / BTS profile:<id>)
 * 2) Role-bound setting string (thinkingModel / model / behindTheScenesModel)
 * 3) Typed failure with reason
 */
export function resolveDefaultModelForRole(
  role: ModelRole,
  settings: ModelRoleResolverSettings,
  profiles: readonly ModelProfile[],
): RoleResolution {
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  return resolveRoleResolution(role, settings, profilesById);
}

export function roleLabel(role: ModelRole): string {
  return ROLE_LABELS[role];
}

export function humanizeRoleResolutionFailure(failure: RoleResolutionFailure): string {
  const label = roleLabel(failure.role);
  switch (failure.reason) {
    case 'no-profile-and-no-setting-for-role':
      return `${label} model isn't configured yet. Open Settings → Models to pick one.`;
    case 'profile-disabled-or-incomplete':
      return `${label} model setup is incomplete or disabled. Open Settings → Models to fix it.`;
    case 'role-key-references-unknown-profile':
      return `${label} model points to a deleted profile. Open Settings → Models to pick another model.`;
    default:
      return `${label} model isn't configured yet. Open Settings → Models to pick one.`;
  }
}

export function summarizeRoleResolutionFailureReason(reason: RoleResolutionFailureReason): string {
  switch (reason) {
    case 'no-profile-and-no-setting-for-role':
      return 'No model is selected yet.';
    case 'profile-disabled-or-incomplete':
      return 'Selected profile needs setup or is disabled.';
    case 'role-key-references-unknown-profile':
      return 'Selected profile is no longer available. Pick another model before Rebel can use this role.';
    default:
      return 'Model setup needs attention.';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isModelRole(value: unknown): value is ModelRole {
  return value === 'thinking' || value === 'working' || value === 'background';
}

/**
 * Map the canonical `ModelRole` to its persisted WIRE spelling (`ModelRoleWire`).
 * The cheap tier serializes as `'fast'` so error payloads + sub-agent status
 * strings stay byte-identical to already-persisted events (cross-version safe).
 * Internal code holds `'background'`; only serialization crosses to the wire.
 */
export function modelRoleToWire(role: ModelRole): ModelRoleWire {
  return role === 'background' ? 'fast' : role;
}

/**
 * Read a wire role spelling back to canonical `ModelRole`. Tolerant of BOTH the
 * legacy/current wire `'fast'` and a canonical `'background'` (forward-compat),
 * returning `null` for anything else. Used when deserializing persisted error
 * payloads + status strings written by any app version.
 */
export function modelRoleFromWire(value: unknown): ModelRole | null {
  if (value === 'fast') return 'background';
  return isModelRole(value) ? value : null;
}

/** If `value` is a record carrying a wire `role` string, return a copy with the role canonicalized. */
function withCanonicalWireRole(value: unknown): unknown {
  if (isRecord(value) && typeof value.role === 'string') {
    const canonical = modelRoleFromWire(value.role);
    if (canonical && canonical !== value.role) {
      return { ...value, role: canonical };
    }
  }
  return value;
}

function isRoleResolutionFailureReason(value: unknown): value is RoleResolutionFailureReason {
  return value === 'no-profile-and-no-setting-for-role'
    || value === 'profile-disabled-or-incomplete'
    || value === 'role-key-references-unknown-profile';
}

export function isRoleResolutionFailure(value: unknown): value is RoleResolutionFailure {
  if (!isRecord(value)) return false;
  if (value.ok !== false) return false;
  if (!isModelRole(value.role)) return false;
  if (!isRoleResolutionFailureReason(value.reason)) return false;
  if (value.profileId != null && typeof value.profileId !== 'string') return false;
  return true;
}

function extractRoleResolutionFailureFromUnknown(value: unknown): RoleResolutionFailure | null {
  if (!isRecord(value)) return null;
  // Canonicalize the legacy wire role (`'fast'` -> `'background'`) on each candidate
  // before validation, so error payloads persisted before the rename still re-parse.
  if ('roleResolutionFailure' in value) {
    const candidate = withCanonicalWireRole(value.roleResolutionFailure);
    if (isRoleResolutionFailure(candidate)) return candidate;
  }
  if ('details' in value && isRecord(value.details)) {
    const fromDetails = withCanonicalWireRole(value.details.roleResolutionFailure);
    if (isRoleResolutionFailure(fromDetails)) return fromDetails;
  }
  const self = withCanonicalWireRole(value);
  if (isRoleResolutionFailure(self)) return self;
  return null;
}

export function serializeRoleResolutionFailureRawError(
  failure: RoleResolutionFailure,
  message: string,
): string {
  // Persist the role in its WIRE spelling (cheap tier -> `'fast'`) so the payload
  // stays byte-identical to events written before the 'fast'->'background' rename.
  const wireFailure = { ...failure, role: modelRoleToWire(failure.role) };
  return JSON.stringify({ message, details: { roleResolutionFailure: wireFailure } });
}

export function parseRoleResolutionFailureFromRawError(
  rawError: string | null | undefined,
): RoleResolutionFailure | null {
  if (!rawError) return null;
  try {
    const parsed = JSON.parse(rawError);
    return extractRoleResolutionFailureFromUnknown(parsed);
  } catch {
    return null;
  }
}

export function makeRoleNotConfiguredStatusMessage(role: ModelRole): string {
  // WIRE spelling: this status string is persisted in session history as an opaque
  // string, so the cheap tier stays `'fast'` (byte-identical across versions).
  return `${ROLE_NOT_CONFIGURED_STATUS_PREFIX}${modelRoleToWire(role)}`;
}

export function parseRoleNotConfiguredStatusMessage(message: string): ModelRole | null {
  if (!message.startsWith(ROLE_NOT_CONFIGURED_STATUS_PREFIX)) {
    return null;
  }
  const value = message.slice(ROLE_NOT_CONFIGURED_STATUS_PREFIX.length);
  // Tolerant of both the wire `'fast'` (any app version) and a canonical `'background'`.
  return modelRoleFromWire(value);
}
