import type {
  ActiveProvider,
  AppSettings,
  GoogleDriveLink,
  InboxLayoutMode,
  ModelProfile,
  NpsSurveyState,
  ProviderKeys,
  SafetyLevel,
  SpaceConfig,
  SurveyState,
  ThemePreference,
} from '../types';
import {
  DEFAULT_DIAGNOSTICS_SETTINGS,
  DEFAULT_LOCAL_MODEL_SETTINGS,
  DEFAULT_OPENROUTER_SETTINGS,
  DEFAULT_VOICE_ACTIVATION_HOTKEY,
  DEFAULT_VOICE_ACTIVATION_VOICE_MODE,
  DEFAULT_TRANSCRIPTION_VOCABULARY,
  DEFAULT_SCRATCHPAD_SETTINGS,
  NPS_INITIAL_DELAY_DAYS,
  getWorkingModelProfile
} from '../types';
import { normalizeModel, MODEL_OPTIONS } from './modelNormalization';
import { getDefaultModelForProvider } from './getDefaultModelForProvider';
import { isOpenRouterEffectiveProvider } from './providerDefaultConstants';
import { isCodexSubscriptionProfile, normalizeApiKey, resolveProfileApiKey } from './providerKeys';
import { isLoopbackRoutableProfile } from './profileHelpers';
import { OR_MODEL_MAP } from '../data/openRouterModels';
import { CODEX_ALL_MODEL_OPTIONS, isCodexModelSupported } from '../data/codexModels';
import { normalizeTrustedTools } from './trustedToolNormalization';
import { VOICE_INPUT_LANGUAGE_CODES } from '../data/voiceLanguages';
import { getKnownContextWindowForProfile } from '../data/modelProviderPresets';
import { canRouteSlashFormModel } from './slashFormRouting';
import { toRoutedFallbackProvider } from './modelIdClassifier';
import { PROFILE_PREFIX, MODEL_PREFIX } from './btsModelValueNormalization';
import { stripStoredModelPrefix } from './modelChoiceCodec';
import { materializeModelsFromLegacy, resolveModelSettings } from './modelSettingsResolver';
import {
  emitSettingsFallbackTelemetry,
  emitFallbackTelemetryAuto,
  deriveCredentialStateFromSettings,
} from './emitFallbackTelemetry';
import type {
  FallbackTelemetryProvider,
  FallbackTelemetryRole,
} from '../types/fallbackTelemetry';
import {
  InboundAuthorPolicySchema,
  InboundAuthorPolicySchemaVersion,
  type InboundAuthorPolicy,
  type PolicyMode,
} from '@rebel/shared';

const log = {
  info(data: Record<string, unknown>, message: string): void {
    // eslint-disable-next-line no-console -- intentional: shared settings normalization cannot import @core/logger; console capture preserves the structured breadcrumb
    console.info(message, data);
  },
  warn(data: Record<string, unknown>, message: string): void {
    console.warn(message, data);
  },
};

const INBOUND_AUTHOR_POLICY_CORRUPTED_EVENT = 'inbound_author_policy_corrupted_schema_v1';
const INBOUND_AUTHOR_POLICY_BACKUP_PERSISTED_EVENT = 'inbound_author_policy_backup_persisted';
const DEFAULT_INBOUND_AUTHOR_POLICY_REVISION = 0;
const LEGACY_PERMISSIVE_MODE: PolicyMode = 'legacyPermissive';
const OWNER_ONLY_MODE: PolicyMode = 'ownerOnly';

type GlobalCryptoLike = {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
};

function getGlobalCrypto(): GlobalCryptoLike | undefined {
  if (typeof globalThis === 'undefined') return undefined;
  const maybeCrypto = (globalThis as { crypto?: GlobalCryptoLike }).crypto;
  return maybeCrypto;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const globalCrypto = getGlobalCrypto();
  if (globalCrypto?.getRandomValues) {
    try {
      return globalCrypto.getRandomValues(bytes);
    } catch {
      // fall through to Math.random fallback
    }
  }
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function mintUuidV4(): string {
  const globalCrypto = getGlobalCrypto();
  if (globalCrypto?.randomUUID) {
    try {
      return globalCrypto.randomUUID();
    } catch {
      // fall through
    }
  }

  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function isCloudSettingsRuntime(): boolean {
  return typeof process !== 'undefined' && process?.env?.IS_CLOUD_SERVICE === '1';
}

function createInboundAuthorPolicySeed(mode: PolicyMode, upgradeReviewPending: boolean): InboundAuthorPolicy {
  return {
    inboundAuthorPolicySchemaVersion: InboundAuthorPolicySchemaVersion,
    policyRevision: DEFAULT_INBOUND_AUTHOR_POLICY_REVISION,
    mode,
    allowlist: {},
    blocklist: {},
    surfaceTrusted: {},
    agentAllowlist: {},
    notices: {
      upgradeReviewPending,
    },
  };
}

function persistInboundAuthorPolicyBackup(args: {
  experimental: NonNullable<AppSettings['experimental']>;
  inboundAuthorPolicyRaw: unknown;
  branch: 'schema_v1_refine_failure' | 'unknown_shape_fallback';
  schemaVersion?: unknown;
}): void {
  args.experimental.inboundAuthorPolicyBackup = args.inboundAuthorPolicyRaw;
  log.warn({
    event: INBOUND_AUTHOR_POLICY_BACKUP_PERSISTED_EVENT,
    branch: args.branch,
    type: typeof args.inboundAuthorPolicyRaw,
    schemaVersion: args.schemaVersion ?? null,
  }, INBOUND_AUTHOR_POLICY_BACKUP_PERSISTED_EVENT);
}

const FALLBACK_AGENT_INSTANCE_ID = mintUuidV4();

type ModelProfileWithPresetKey = ModelProfile & { presetKey?: string };

function getProfilePresetKey(profile: ModelProfile | undefined): string | undefined {
  const presetKey = (profile as ModelProfileWithPresetKey | undefined)?.presetKey;
  return typeof presetKey === 'string' ? presetKey : undefined;
}

export function setLocalInferenceCloudFallback(
  settings: AppSettings,
  fallback: string | undefined,
): AppSettings {
  const normalizedFallback = fallback?.trim() ? fallback.trim() : undefined;
  if (normalizedFallback?.startsWith(PROFILE_PREFIX)) {
    const fallbackProfileId = normalizedFallback.slice(PROFILE_PREFIX.length);
    const fallbackProfile = settings.localModel?.profiles?.find((profile) => profile.id === fallbackProfileId);
    if (fallbackProfile && isLoopbackRoutableProfile(fallbackProfile)) {
      throw new Error(
        `localInferenceCloudFallback must point to a cloud-routable profile. Profile "${fallbackProfileId}" is local-only; choose a cloud profile.`,
      );
    }
  }

  if (normalizedFallback === undefined) {
    const { localInferenceCloudFallback: _omitFallback, ...rest } = settings;
    return rest as AppSettings;
  }

  return { ...settings, localInferenceCloudFallback: normalizedFallback };
}

const VIRTUAL_THINKING_PROFILE_ID = '__virtual-thinking';
const VIRTUAL_WORKING_PROFILE_ID = '__virtual-working';
type ModelSettingsLike = Partial<NonNullable<AppSettings['models']>>;

export { resolveModelSettings };

function withKnownProfileContextWindow(profile: ModelProfile): ModelProfile {
  const contextWindow = getKnownContextWindowForProfile(profile);
  if (contextWindow == null) {
    const { contextWindow: _contextWindow, ...profileWithoutContextWindow } = profile;
    return profileWithoutContextWindow;
  }
  return { ...profile, contextWindow };
}

function upsertVirtualAnthropicProfile(
  profiles: ModelProfile[],
  options: { id: string; name: string; model: string }
): ModelProfile[] {
  const existingIndex = profiles.findIndex(profile => profile.id === options.id);
  if (existingIndex === -1) {
    return [
      ...profiles,
      withKnownProfileContextWindow({
        id: options.id,
        name: options.name,
        model: options.model,
        providerType: 'anthropic',
        serverUrl: '',
        enabled: true,
        isVirtual: true,
        createdAt: Date.now(),
      }),
    ];
  }

  const existingProfile = profiles[existingIndex];
  const updatedProfile = withKnownProfileContextWindow(
    existingProfile.model === options.model
      ? existingProfile
      : { ...existingProfile, model: options.model }
  );
  if (updatedProfile === existingProfile) {
    return profiles;
  }

  const nextProfiles = [...profiles];
  nextProfiles[existingIndex] = updatedProfile;
  return nextProfiles;
}

/**
 * Resolve the Thinking role's model profile from settings.
 * Returns null if no profile is assigned (use the configured thinking model).
 */
export function getThinkingProfile(settings: AppSettings): ModelProfile | null {
  const profileId = resolveModelSettings(settings).thinkingProfileId;
  if (!profileId || !settings.localModel?.profiles) return null;
  return settings.localModel.profiles.find(p => p.id === profileId) ?? null;
}

/**
 * Resolve the Working role's model profile from settings.
 * Returns null if no profile is assigned (use the configured working model).
 */
export function getWorkingProfile(settings: AppSettings): ModelProfile | null {
  const profileId = resolveModelSettings(settings).workingProfileId;
  if (!profileId || !settings.localModel?.profiles) return null;
  return settings.localModel.profiles.find(p => p.id === profileId) ?? null;
}

/**
 * Helper: returns true if levelA is stricter than levelB.
 * Order: cautious > balanced > permissive
 */
function isStricterLevel(levelA: SafetyLevel, levelB: SafetyLevel): boolean {
  const order: Record<SafetyLevel, number> = { permissive: 0, balanced: 1, cautious: 2 };
  return order[levelA] > order[levelB];
}

/**
 * Returns the stricter of two safety levels.
 */
function stricterOf(a: SafetyLevel, b: SafetyLevel): SafetyLevel {
  return isStricterLevel(a, b) ? a : b;
}

/**
 * Migrate old 3-tier memory safety settings to new spaceSafetyLevels format.
 * 
 * Migration principles (from plan):
 * 1. Chief-of-Staff → always 'permissive' (but NOT stored - it's hardcoded in resolution)
 * 2. Other spaces → take strictest of existing local settings
 * 3. Never make things less strict during migration
 * 4. Default to 'balanced' for all non-CoS spaces without explicit settings
 * 5. Preserve prefix matching semantics from spaceSafetyOverrides (parent overrides apply to children)
 * 
 * This is a one-time migration that runs when spaceSafetyLevels is empty but
 * legacy settings exist.
 * 
 * @param settings - The current settings
 * @param spaces - The configured spaces
 * @returns The migrated spaceSafetyLevels record, or undefined if no migration needed
 */
export function migrateToSpaceSafetyLevels(
  settings: AppSettings,
  spaces: SpaceConfig[] | undefined
): Record<string, SafetyLevel> | undefined {
  // Skip if already migrated
  if (settings.spaceSafetyLevels && Object.keys(settings.spaceSafetyLevels).length > 0) {
    return settings.spaceSafetyLevels;
  }
  
  // Skip if no legacy settings to migrate from
  const hasLegacySettings = (
    settings.spaceSafetyOverrides?.length ||
    settings.memorySafetyBySharing ||
    settings.memorySafetyPrivate !== undefined ||
    settings.memorySafetyShared !== undefined
  );
  
  if (!hasLegacySettings) {
    // Return empty object for fresh installs - ensures new resolver is always used
    // (prevents fallback to legacy resolution which has different defaults)
    return {};
  }
  
  const result: Record<string, SafetyLevel> = {};
  
  // Process each configured space
  if (spaces && Array.isArray(spaces)) {
    for (const space of spaces) {
      // Skip Chief-of-Staff - it's always 'permissive' via hardcoded check
      if (space.type === 'chief-of-staff') {
        continue;
      }
      
      // Start with 'balanced' as the baseline (safety-conservative default)
      let level: SafetyLevel = 'balanced';
      
      // Check Tier 3: spaceSafetyOverrides (per-space override)
      // IMPORTANT: Legacy used prefix matching - a parent path override applies to child paths
      // e.g., override for "work/Acme" applies to "work/Acme/General" and "work/Acme/Exec"
      if (settings.spaceSafetyOverrides?.length) {
        for (const override of settings.spaceSafetyOverrides) {
          // Match exact path OR if space is under the override path (prefix match)
          if (space.path === override.spacePath || space.path.startsWith(override.spacePath + '/')) {
            level = stricterOf(level, override.level);
          }
        }
      }
      
      // Check Tier 2: memorySafetyBySharing (per-sharing-level defaults)
      if (space.sharing && space.sharing !== 'private' && settings.memorySafetyBySharing) {
        const sharingLevel = settings.memorySafetyBySharing[space.sharing];
        if (sharingLevel) {
          level = stricterOf(level, sharingLevel);
        }
      }
      
      // Check Tier 1: base defaults
      if (space.sharing === 'private' && settings.memorySafetyPrivate) {
        level = stricterOf(level, settings.memorySafetyPrivate);
      } else if (settings.memorySafetyShared) {
        level = stricterOf(level, settings.memorySafetyShared);
      }
      
      // Store the result (only if different from default 'balanced')
      // Actually, store all of them for clarity during migration
      result[space.path] = level;
    }
  }
  
  // Also migrate any spaceSafetyOverrides for paths not in the spaces list
  // (edge case: user might have overrides for spaces that were removed)
  if (settings.spaceSafetyOverrides) {
    for (const override of settings.spaceSafetyOverrides) {
      if (!(override.spacePath in result)) {
        result[override.spacePath] = override.level;
      }
    }
  }
  
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Migrate legacy googleDriveLinks to the new spaces format.
 * Keeps existing spaces intact and only adds spaces from googleDriveLinks that don't already exist.
 */
const migrateGoogleDriveLinksToSpaces = (
  existingSpaces: SpaceConfig[] | undefined,
  googleDriveLinks: GoogleDriveLink[] | undefined,
  companyName: string | null | undefined
): SpaceConfig[] => {
  const spaces: SpaceConfig[] = existingSpaces ? [...existingSpaces] : [];
  const existingPaths = new Set(spaces.map(s => s.path));

  // Migrate each googleDriveLink to a SpaceConfig if not already present
  if (googleDriveLinks && Array.isArray(googleDriveLinks)) {
    for (const link of googleDriveLinks) {
      // Skip if this path already exists in spaces
      if (existingPaths.has(link.symlinkPath)) {
        continue;
      }

      // Infer company name from path if not provided
      // Path format: work/[Company]/[SpaceName]
      const pathParts = link.symlinkPath.split('/');
      let inferredCompanyName = companyName || '';
      if (pathParts.length >= 2 && pathParts[0] === 'work') {
        inferredCompanyName = pathParts[1];
      }

      const spaceConfig: SpaceConfig = {
        name: link.driveName,
        path: link.symlinkPath,
        type: 'company', // Default to company for migrated Google Drive links
        isSymlink: true,
        sourcePath: link.sourcePath,
        storageProvider: 'google_drive',
        companyName: inferredCompanyName || undefined,
        sharing: 'company-wide', // Default for Google Drive shared folders
        createdAt: link.createdAt,
        hasReadme: undefined, // Will be determined at runtime
      };

      spaces.push(spaceConfig);
      existingPaths.add(link.symlinkPath);
    }
  }

  return spaces;
};

/** Strip legacy opusPlanMode key from raw model settings to prevent stale re-persistence. */
function stripLegacyPlanModeKey(models: ModelSettingsLike): ModelSettingsLike {
  const { opusPlanMode: _, ...rest } = models as ModelSettingsLike & { opusPlanMode?: unknown };
  return rest as ModelSettingsLike;
}

/**
 * Shallow clone that drops keys whose value is `undefined`.
 *
 * Why this exists (Stage 2a): `normalizeSettings` emits many optional fields
 * (e.g. `thinkingModel`, `openRouter`, `trustedTools`, `contextWindow`). When a
 * consumer like `ensureNormalizedSettings` compares the pre-persist normalized
 * value with the current in-memory store, `{ key: undefined }` and `{}` compare
 * as unequal under `fast-deep-equal`, but JSON persistence strips the former
 * into the latter. That drove a write-every-call regression on every explicit
 * `ensureNormalizedSettings()` site. This helper is applied at specific nested
 * objects whose shape is unstable across JSON round-trip; it is NOT applied to
 * the whole return value (that would be the Stage 2b comparator pattern — see
 * `docs/plans/260420_perf_observability_and_low_risk_wins.md`).
 */
function stripUndefined<T extends object>(obj: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) result[key] = value;
  }
  return result as T;
}

/**
 * Phase context for a `normalizeSettings()` call. Used by Stage 4 telemetry
 * to attribute the settings-context breadcrumb (`bootPhase`) emitted at the
 * provider-aware fallback sites inside this function.
 *
 *   - `'boot'`      : called from `ensureNormalizedSettings()` at app start.
 *   - `'save'`      : called from any user/IPC-initiated settings write (default).
 *   - `'migration'` : called from a versioned migration path (rare; v26→v27
 *                     migration uses `automationScheduler` directly and emits
 *                     its own `MigrationFallbackTelemetry`).
 */
export type NormalizeSettingsBootPhase = 'boot' | 'save' | 'migration';

const resolveTelemetryProvider = (
  settings: { activeProvider?: AppSettings['activeProvider'] | string },
): FallbackTelemetryProvider =>
  settings.activeProvider === 'openrouter' || settings.activeProvider === 'codex'
    ? settings.activeProvider
    : 'anthropic';

/**
 * Read the user's ordered enabled-provider list (Phase-2 multi-provider).
 *
 * Returns `settings.enabledProviders` when it is present AND non-empty (ordered,
 * highest-priority first). Otherwise it DEGENERATES to `[activeProvider]` — the
 * single current provider — which is the behaviour-preserving default: an existing
 * single-provider user (field absent) reads exactly as `[activeProvider]`.
 *
 * Pure: no I/O, no mutation, no normalization side effects. `settings` is not read
 * for anything beyond `enabledProviders` + `activeProvider`.
 *
 * ## Dual semantic — router vs. settings-UI editor
 *
 * This function has two distinct callers with opposite requirements:
 *
 *  **Router** (`enumerateProviderModeCandidates` in `providerRouting.ts`):
 *    Needs the raw list exactly as stored — provider order IS the failover priority.
 *    `activeProvider` is independent of list head. Callers in `src/core/` use this
 *    function directly.
 *
 *  **Settings-UI editor** (`BackupConnectionsSection` and similar renderer code):
 *    Needs the list with `activeProvider` coerced to the head — i.e. "main + backups"
 *    where the main is always first. Use `getDisplayProviderChain` instead, which
 *    wraps this function with the head-sync reconcile. **Never call `getEnabledProviders`
 *    directly from `src/renderer/**` for display or editing purposes.**
 *
 * Flag-gated (`experimental.multiProviderRoutingEnabled`): the router only consults
 * this helper when the flag is on; otherwise selection resolves the single
 * `activeProvider` via `selectProviderMode`. The `activeProvider`↔list write-sync
 * contract (Stage 6a) is enforced by the `normalizeSettings` head-sync invariant —
 * see `syncEnabledProvidersHead`. See docs/plans/260618_multiprovider-foundation/PLAN.md.
 *
 * @internal Production consumers: the router (`enumerateProviderModeCandidates`, flag-gated)
 * and `getDisplayProviderChain`. The knip *production* leg nonetheless flags it (the router
 * consumption sits behind the experimental flag), so `@internal` is the sanctioned
 * production-leg hatch — the default leg keeps tracking it, so it can't go dead unnoticed.
 * NOT a test-only seam. See docs/project/DEAD_CODE_DETECTION_AND_REMOVAL.md.
 */
export function getEnabledProviders(
  settings: Pick<AppSettings, 'enabledProviders' | 'activeProvider'>,
): ActiveProvider[] {
  const list = settings.enabledProviders;
  if (Array.isArray(list) && list.length > 0) {
    return list;
  }
  return settings.activeProvider !== undefined ? [settings.activeProvider] : [];
}

/**
 * The provider chain with the active/main provider coerced to the head — for the
 * settings UI's "main + backups" editor view, where `activeProvider` must read as
 * the head even when the draft's `enabledProviders` is transiently stale (e.g.
 * after `planProviderSwitch`, before `normalizeSettings` runs on the save
 * round-trip).
 *
 * Composition: `syncEnabledProvidersHead(getEnabledProviders(settings), settings.activeProvider) ?? getEnabledProviders(settings)`
 *
 * ## NOT for the router
 * The router uses `getEnabledProviders` (raw list-priority, `activeProvider`-independent).
 * This function is renderer/editor-scoped: use it in `src/renderer/**` whenever you
 * need to display or edit the provider list and want the active provider to appear
 * first. Do NOT use it in `src/core/**` or `src/shared/**` outside of display contexts.
 *
 * Pure: no I/O, no mutation. Idempotent — equivalent to `normalizeSettings` head-sync
 * on the draft.
 *
 * See docs/plans/260618_multiprovider-foundation/PLAN.md — Stage 7.
 *
 * @internal Consumed by `BackupConnectionsSection` (renderer settings editor); the knip
 * *production* leg flags it (the renderer consumer isn't in the production-leg entry graph),
 * so `@internal` is the sanctioned production-leg hatch — the default leg keeps tracking it.
 * NOT a test-only seam. See docs/project/DEAD_CODE_DETECTION_AND_REMOVAL.md.
 */
export function getDisplayProviderChain(
  settings: Pick<AppSettings, 'enabledProviders' | 'activeProvider'>,
): ActiveProvider[] {
  const base = getEnabledProviders(settings);
  // `?? base` is a type guard, not dead code: `syncEnabledProvidersHead`'s return
  // type is `ActiveProvider[] | undefined`, but `base` is always an array here, so
  // the reconcile never actually returns undefined — the coalesce satisfies the type.
  return syncEnabledProvidersHead(base, settings.activeProvider) ?? base;
}

/**
 * Stage 6a write contract: write `enabledProviders` (ordered list) AND set
 * `activeProvider` to the head of the list atomically.
 *
 * This is the canonical writer for the Stage-6 UI — every write path that edits
 * the provider list MUST go through this helper so the invariant
 * `activeProvider === enabledProviders[0]` is maintained by construction.
 *
 * Returns a `Partial<AppSettings>` update patch suitable for use with
 * `updateSettings` / `onSettingsChange` / `applyPlanUpdates`.
 *
 * Invariants:
 *  - The list MUST be non-empty (the user cannot remove all providers; the UI
 *    enforces this by keeping the active provider row non-togglable).
 *  - `activeProvider` is always set to `list[0]` (the head of the enabled list).
 *  - Duplicates are removed (first-occurrence order preserved) so `normalizeSettings`
 *    never persists duplicate providers. Deliberate: 6a-F2.
 *  - Idempotent: applying the patch and then normalizing is the same as applying once.
 *
 * See docs/plans/260618_multiprovider-foundation/PLAN.md — Stage 6a write contract.
 */
export function writeProviderList(
  orderedList: [ActiveProvider, ...ActiveProvider[]],
): Pick<AppSettings, 'enabledProviders' | 'activeProvider'> {
  // Dedup: preserve first-occurrence order (6a-F2).
  const seen = new Set<ActiveProvider>();
  const deduped = orderedList.filter(p => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  }) as [ActiveProvider, ...ActiveProvider[]];
  return {
    enabledProviders: deduped,
    activeProvider: deduped[0],
  };
}

/**
 * Stage 6a: enforce the `activeProvider === enabledProviders[0]` head-sync
 * invariant when `enabledProviders` is SET (non-empty). Called by
 * `normalizeSettings` after the `activeProvider` is derived.
 *
 * Cases:
 *  - `enabledProviders` UNSET or empty: no-op (zero-write migration — existing
 *    single-provider users are never touched).
 *  - `activeProvider` undefined: no-op (fresh user, no provider yet — don't
 *    fabricate a list).
 *  - `activeProvider` is already the head: no-op (already consistent).
 *  - `activeProvider` ∈ list but NOT at head: reorder — put `activeProvider`
 *    first, preserve remaining order.
 *  - `activeProvider` ∉ list: prepend `activeProvider` to the list.
 *
 * Returns the reconciled `enabledProviders` array, or `undefined` if no list
 * was present (preserves the no-list state for single-provider users).
 *
 * Note (6a-F1): The invariant "`activeProvider === enabledProviders[0]` after normalize"
 * is conditional. The one unreachable edge — non-empty list + undefined `activeProvider`
 * — returns the list unchanged (the list IS the source of truth in that state). This
 * edge cannot be reached via product paths (all provider-switch writes set `activeProvider`
 * before touching `enabledProviders`), so no code guard is added. Deliberate: 6a-F1.
 *
 * Pure and idempotent (running twice = running once).
 *
 * Deliberate: see docs/plans/260618_multiprovider-foundation/PLAN.md — Stage 6a.
 */
export function syncEnabledProvidersHead(
  enabledProviders: ActiveProvider[] | undefined,
  activeProvider: ActiveProvider | undefined,
): ActiveProvider[] | undefined {
  // Zero-write migration: if the list isn't set, leave it unset.
  // The `getEnabledProviders` degenerate default covers reads.
  if (!Array.isArray(enabledProviders) || enabledProviders.length === 0) {
    return enabledProviders;
  }
  // Fresh user: no active provider yet — don't fabricate a list.
  if (activeProvider === undefined) {
    return enabledProviders;
  }
  // Already consistent — head matches activeProvider.
  if (enabledProviders[0] === activeProvider) {
    return enabledProviders;
  }

  // activeProvider ∈ list but not at head → reorder: put activeProvider first,
  // then the rest in their original order (without the activeProvider entry).
  const withoutActive = enabledProviders.filter(p => p !== activeProvider);
  return [activeProvider, ...withoutActive];
  // Note: if activeProvider was NOT in the list, withoutActive === enabledProviders
  // (unchanged), so the result is [activeProvider, ...enabledProviders] — prepend.
  // This handles the legacy providerSwitch case: an activeProvider-only write
  // put a new head that wasn't in the list, and normalize reconciles it.
}

/**
 * Normalize and validate application settings
 * Includes model normalization, path trimming, API key migration, and voice provider auto-selection.
 *
 * Pass `bootPhase` to attribute Stage 4 fallback telemetry (defaults to
 * `'save'` so legacy callers do not need a code change).
 */
export const normalizeSettings = (
  settings: AppSettings,
  bootPhase: NormalizeSettingsBootPhase = 'save',
): AppSettings => {
  const telemetryProvider = resolveTelemetryProvider(settings);
  const telemetryCredentialState = deriveCredentialStateFromSettings({
    activeProvider: settings.activeProvider,
    // Post-cutover: read the EFFECTIVE api key via the materializer (models, else legacy claude),
    // not a raw `settings.claude` read — a post-cutover install has no `claude`, so the old read
    // mis-reported credentialState. This is also the last runtime legacy-namespace read removed.
    apiKey: materializeModelsFromLegacy(settings).apiKey ?? null,
    openRouter: settings.openRouter
      ? { oauthToken: settings.openRouter.oauthToken ?? null, enabled: settings.openRouter.enabled ?? null }
      : null,
    codex: null, // boot/save paths cannot consult the codex auth provider — turn admission is SoT.
  });
  const emitSettingsBreadcrumb = (
    site: string,
    role: FallbackTelemetryRole,
    resolvedModel: string,
  ): void => {
    emitSettingsFallbackTelemetry({
      bootPhase,
      site,
      provider: telemetryProvider,
      role,
      resolvedModel,
      credentialState: telemetryCredentialState,
      providerFallbackReason: null,
    });
  };
  // L869/L874 may fire inside a turn (user switches provider mid-session).
  // The auto-detect helper inspects `getTurnContext()` and emits the turn
  // variant when present, settings variant otherwise — per Stage 4 wire policy.
  const emitMaybeTurnBreadcrumb = (
    site: string,
    role: FallbackTelemetryRole,
    resolvedModel: string,
  ): void => {
    emitFallbackTelemetryAuto({
      bootPhase,
      site,
      provider: telemetryProvider,
      role,
      resolvedModel,
      credentialState: telemetryCredentialState,
      providerFallbackReason: null,
    });
  };

  // Guard against corrupted/partial settings
  const claudeModelFallback = getDefaultModelForProvider(settings, 'working');
  emitSettingsBreadcrumb('settingsUtils:claudeModelFallback', 'working', claudeModelFallback);
  const claude: ModelSettingsLike = {
    apiKey: null,
    oauthToken: null,
    authMethod: 'api-key',
    model: claudeModelFallback,
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: true,
    thinkingEffort: 'high',
    ...materializeModelsFromLegacy(settings),
  };

  // Migration: Claude Max OAuth → API key (April 2026 — Anthropic blocked third-party OAuth)
  // Trigger on ANY OAuth artifact: authMethod, token, or refresh token.
  // This runs on every normalizeSettings() call but is idempotent and O(1).
  const hasOAuthArtifacts =
    claude.authMethod === 'oauth-token' ||
    !!claude.oauthToken ||
    !!claude.oauthRefreshToken;
  if (hasOAuthArtifacts) {
    log.info(
      { migration: 'claude-oauth-to-api-key', reason: 'oauth-deprecated-april-2026' },
      '[settings-migration] Migrating Claude OAuth to API key auth (OAuth deprecated April 2026)',
    );
    claude.authMethod = 'api-key';
    claude.oauthToken = null;
    claude.oauthRefreshToken = null;
    claude.oauthTokenExpiresAt = null;
    // Delete optional fields rather than assigning `undefined` so the spread
    // below doesn't emit `oauthProfile: undefined` / `usageData: undefined`
    // keys that would get stripped by JSON persistence (Stage 2a).
    delete claude.oauthProfile;
    delete claude.usageData;
  }
  // Legacy `claude` is input-only in C2b-2. The materializer may read it above
  // to seed `models`, but normalizeSettings no longer writes the stale mirror
  // back, so OAuth cleanup and codec clears only need to affect `models`.
  const baseVoice = settings.voice ?? { provider: 'openai-whisper', openaiApiKey: null, elevenlabsApiKey: null, model: 'gpt-4o-mini-transcribe-2025-12-15', ttsVoice: 'nova', activationHotkey: DEFAULT_VOICE_ACTIVATION_HOTKEY, activationHotkeyVoiceMode: DEFAULT_VOICE_ACTIVATION_VOICE_MODE };

  // Compute once: is this user effectively on OpenRouter?
  // - Explicit activeProvider='openrouter' → yes
  // - activeProvider undefined + OR credentials present → yes (legacy OR user before auto-derivation)
  // - activeProvider explicitly set to something else (e.g. 'anthropic') → no, even if OR creds exist
  // `isOpenRouterEffectiveProvider` (shared with getProviderModelDefaults) owns
  // the explicit-provider axis {openrouter, mindstone} so the two classifiers
  // cannot drift. The undefined+OR-credentials legacy case is normalize-only.
  const isEffectivelyOpenRouter = isOpenRouterEffectiveProvider(settings.activeProvider)
    || (settings.activeProvider === undefined && !!(settings.openRouter?.enabled && settings.openRouter?.oauthToken));

  let normalizedModel: string;
  if (claude.model) {
    normalizedModel = normalizeModel(claude.model);
  } else {
    normalizedModel = normalizeModel(getDefaultModelForProvider(settings, 'working'));
    emitSettingsBreadcrumb('settingsUtils:normalizedModelFallback', 'working', normalizedModel);
  }
  // Profile-backed exception: a slashed model ID that exactly matches a local
  // profile's `model` field is a custom-provider model (Together, Cerebras,
  // user-configured OpenAI-compatible endpoints, etc.), not an OR-format leak.
  // Without this, any non-OR custom provider with a slashed upstream model ID
  // would silently fall back to DEFAULT_MODEL after normalizeSettings.
  const hasMatchingProfile = !!settings.localModel?.profiles?.some(p => p.model === normalizedModel);
  // Normalize OR-format working model (e.g. "anthropic/claude-opus-4.7") to SDK format
  // when not on OpenRouter. Mirrors the thinkingModel normalization (FOX-3096).
  // WS0: raw slash-form `.includes('/')` sniff kept — a bare "is slash-form" boolean;
  // the classifier's `toBillingFamily`/`toModelDialect` add other arms (ollama-first,
  // dialect mapping) that would change this branch's meaning. (lint allowlist)
  if (normalizedModel.includes('/') && !isEffectivelyOpenRouter && !hasMatchingProfile) {
    const bareModel = normalizedModel.startsWith('anthropic/')
      ? normalizeModel(normalizedModel.slice('anthropic/'.length))
      : normalizedModel;
    const validModels = MODEL_OPTIONS.map(opt => opt.value);
    if (validModels.includes(bareModel)) {
      normalizedModel = bareModel;
    } else {
      normalizedModel = getDefaultModelForProvider(settings, 'working');
      emitSettingsBreadcrumb('settingsUtils:slashedModelNonOrFallback', 'working', normalizedModel);
    }
  }
  // Stage 2 of docs/plans/260428_kw_eval_infra_and_model_registry.md:
  // Symmetric registry-aware validation for the WORKING model. Previously
  // claude.model had no check for "OR-format ID on OR provider" — any string
  // would silently pass through, which is how DeepSeek-V4 broke evals before
  // Stage 0 (the entry was missing from `OR_MODEL_CATALOG`/`OR_MODEL_MAP`).
  // Stage 1 now derives `OR_MODEL_MAP` directly from `MODEL_CATALOG`, so any
  // catalog entry with `provider: 'openrouter'` and a populated `openRouter`
  // block automatically validates. Adding a new model is a single-place edit.
  // WS0: raw slash-form sniff kept (bare "is slash-form" boolean; classifier adapters
  // add behaviour-changing arms). (lint allowlist)
  if (normalizedModel.includes('/') && isEffectivelyOpenRouter) {
    if (!OR_MODEL_MAP.has(normalizedModel)) {
      normalizedModel = getDefaultModelForProvider(settings, 'working');
      emitSettingsBreadcrumb('settingsUtils:slashedModelOrUnmappedFallback', 'working', normalizedModel);
    }
  }
  const trimmedExecutable =
    claude.executablePath && claude.executablePath.trim().length > 0
      ? claude.executablePath.trim()
      : null;
  const trimmedMcpConfig =
    settings.mcpConfigFile && settings.mcpConfigFile.trim().length > 0
      ? settings.mcpConfigFile.trim()
      : null;

  const diagnostics = {
    ...DEFAULT_DIAGNOSTICS_SETTINGS,
    ...(settings.diagnostics ?? DEFAULT_DIAGNOSTICS_SETTINGS),
    developerMode: settings.diagnostics?.developerMode ?? false,
  };

  if (diagnostics.debugBreadcrumbsUntil && diagnostics.debugBreadcrumbsUntil <= Date.now()) {
    diagnostics.debugBreadcrumbsUntil = null;
  }

  // NPS normalization
  const defaultNps: NpsSurveyState = {
    firstEligibleAt: null,
    lastShownAt: null,
    lastDismissedAt: null,
    lastCompletedAt: null,
    lastScore: null,
    lastFeedback: null,
    snoozeUntil: null,
    showCount: 0,
    completedCount: 0,
    neverShowAgain: false
  };
  const npsRaw = settings.nps ?? defaultNps;
  const nps: NpsSurveyState = {
    firstEligibleAt:
      typeof npsRaw.firstEligibleAt === 'number' ? npsRaw.firstEligibleAt : null,
    lastShownAt: typeof npsRaw.lastShownAt === 'number' ? npsRaw.lastShownAt : null,
    lastDismissedAt:
      typeof npsRaw.lastDismissedAt === 'number' ? npsRaw.lastDismissedAt : null,
    lastCompletedAt:
      typeof npsRaw.lastCompletedAt === 'number' ? npsRaw.lastCompletedAt : null,
    lastScore: typeof npsRaw.lastScore === 'number' ? npsRaw.lastScore : null,
    lastFeedback:
      typeof npsRaw.lastFeedback === 'string' ? npsRaw.lastFeedback : null,
    snoozeUntil:
      typeof npsRaw.snoozeUntil === 'number' ? npsRaw.snoozeUntil : null,
    showCount: typeof npsRaw.showCount === 'number' ? npsRaw.showCount : 0,
    completedCount:
      typeof npsRaw.completedCount === 'number' ? npsRaw.completedCount : 0,
    neverShowAgain: npsRaw.neverShowAgain === true
  };

  // Survey state normalization — type-guard each field per entry
  const rawSurveys = settings.surveys ?? {};
  const surveys: Record<string, SurveyState> = {};
  for (const [id, raw] of Object.entries(rawSurveys)) {
    if (raw && typeof raw === 'object') {
      surveys[id] = {
        showCount: typeof raw.showCount === 'number' ? raw.showCount : 0,
        dismissCount: typeof raw.dismissCount === 'number' ? raw.dismissCount : 0,
        completed: raw.completed === true,
        snoozeUntil: typeof raw.snoozeUntil === 'number' ? raw.snoozeUntil : null,
        lastShownAt: typeof raw.lastShownAt === 'number' ? raw.lastShownAt : null,
        completedAt: typeof raw.completedAt === 'number' ? raw.completedAt : null,
      };
    }
  }

  // If onboarding was completed and NPS hasn't been scheduled yet, set the first eligibility
  const onboardingFirstCompletedAt =
    typeof settings.onboardingFirstCompletedAt === 'number'
      ? settings.onboardingFirstCompletedAt
      : null;
  if (onboardingFirstCompletedAt && nps.firstEligibleAt === null) {
    nps.firstEligibleAt =
      onboardingFirstCompletedAt + NPS_INITIAL_DELAY_DAYS * 24 * 60 * 60 * 1000;
  }

  // Migrate old apiKey field to openaiApiKey if needed
  const voice = { ...baseVoice };
  const voiceWithLegacyApiKey = voice as typeof voice & { apiKey?: string | null };
  if (
    'apiKey' in voiceWithLegacyApiKey &&
    typeof voiceWithLegacyApiKey.apiKey === 'string' &&
    !voiceWithLegacyApiKey.openaiApiKey
  ) {
    voiceWithLegacyApiKey.openaiApiKey = voiceWithLegacyApiKey.apiKey;
    delete voiceWithLegacyApiKey.apiKey;
  }

  const hasActivationHotkeyProp = Object.prototype.hasOwnProperty.call(voice, 'activationHotkey');
  let activationHotkey =
    typeof voice.activationHotkey === 'string' ? voice.activationHotkey.trim() : null;
  if (activationHotkey && activationHotkey.length === 0) {
    activationHotkey = null;
  }
  if (!hasActivationHotkeyProp) {
    activationHotkey = DEFAULT_VOICE_ACTIVATION_HOTKEY;
  }

  const activationHotkeyVoiceMode =
    typeof voice.activationHotkeyVoiceMode === 'boolean'
      ? voice.activationHotkeyVoiceMode
      : DEFAULT_VOICE_ACTIVATION_VOICE_MODE;

  const inlineVoiceHotkey: string | null =
    typeof voice.inlineVoiceHotkey === 'string' && voice.inlineVoiceHotkey.trim().length > 0
      ? voice.inlineVoiceHotkey.trim()
      : null;

  const hasElevenLabsKey = Boolean(voice.elevenlabsApiKey && voice.elevenlabsApiKey.trim().length > 0);

  // Respect explicit provider choice - don't auto-switch based on credentials.
  // Users need to be able to select a provider BEFORE entering their API key.
  // The UI shows the appropriate API key field based on the selected provider.
  let provider = voice.provider;

  // Desktop-side migration: `local-moonshine` was removed from the desktop UI
  // after an unresolved ONNX decoder bug (Sentry REBEL-1FP / Linear FOX-3123).
  // Any desktop user with Moonshine selected gets migrated to Parakeet — the
  // other on-device provider that already works on desktop. The enum value
  // stays in the schema because mobile still uses it (via its own AsyncStorage
  // key `rebel:mobileVoiceProvider`, which is independent of AppSettings).
  if (provider === 'local-moonshine') {
    provider = 'local-parakeet';
  }

  // Only default provider if it's completely unset or invalid
  if (
    provider !== 'elevenlabs-scribe' &&
    provider !== 'openai-whisper' &&
    provider !== 'local-parakeet' &&
    provider !== 'custom-openai'
  ) {
    // Pick a sensible default based on available credentials
    provider = hasElevenLabsKey ? 'elevenlabs-scribe' : 'openai-whisper';
  }

  let model = voice.model || '';
  const isElevenLabsModel = model.startsWith('scribe_');
  const isOpenAIModel = model.startsWith('gpt-') || model.startsWith('whisper-');

  // Local provider doesn't use the model field for STT (model is implicit)
  if (provider === 'local-parakeet') {
    model = 'parakeet-v3'; // Informational only
  } else if (provider === 'elevenlabs-scribe' && !isElevenLabsModel) {
    model = 'scribe_v2';
  } else if (provider === 'openai-whisper' && !isOpenAIModel) {
    model = 'gpt-4o-mini-transcribe-2025-12-15';
  }

  // Auto-migrate gpt-4o-transcribe → gpt-4o-mini-transcribe (70% fewer hallucinations,
  // same cost). gpt-4o-transcribe was the only OpenAI option ever offered in the UI.
  if (provider === 'openai-whisper' && model === 'gpt-4o-transcribe') {
    model = 'gpt-4o-mini-transcribe-2025-12-15';
  }

  // Set default models if empty
  if (!model) {
    if (provider === 'elevenlabs-scribe') {
      model = 'scribe_v2';
    } else if (provider === 'openai-whisper') {
      model = 'gpt-4o-mini-transcribe-2025-12-15';
    } else if (provider === 'local-parakeet') {
      model = 'parakeet-v3';
    }
  }

  // Normalize ttsVoice to match provider (prevents cross-provider voice ID mismatch,
  // e.g. ElevenLabs voice ID being sent to OpenAI TTS when provider changes via authService)
  const OPENAI_TTS_VOICES = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
  let ttsVoice = voice.ttsVoice;
  if (provider === 'openai-whisper' && ttsVoice && !OPENAI_TTS_VOICES.has(ttsVoice)) {
    ttsVoice = 'nova';
  } else if (provider === 'elevenlabs-scribe' && ttsVoice && OPENAI_TTS_VOICES.has(ttsVoice)) {
    ttsVoice = '21m00Tcm4TlvDq8ikWAM'; // Rachel (ElevenLabs default)
  }

  // Migration: voice.openaiApiKey → providerKeys.openai (one-time)
  const providerKeys: ProviderKeys = { ...(settings.providerKeys ?? {}) };
  if (!normalizeApiKey(providerKeys.openai) && normalizeApiKey(voice.openaiApiKey)) {
    providerKeys.openai = normalizeApiKey(voice.openaiApiKey);
  }

  // Migrate googleDriveLinks to spaces if needed
  const spaces = migrateGoogleDriveLinksToSpaces(
    settings.spaces,
    settings.googleDriveLinks,
    settings.companyName
  );

  // Theme normalization - default to 'dark' for users without a theme preference
  const theme: ThemePreference =
    settings.theme === 'light' || settings.theme === 'dark' || settings.theme === 'system'
      ? settings.theme
      : 'dark';

  // Inbox layout mode normalization - default to 'grid' (Eisenhower matrix)
  const inboxLayoutMode: InboxLayoutMode =
    settings.inboxLayoutMode === 'grid' || settings.inboxLayoutMode === 'list'
      ? settings.inboxLayoutMode
      : 'grid';

  // Normalize autoSpeak - default to false (not used, kept for backwards compatibility)
  const autoSpeak = typeof voice.autoSpeak === 'boolean' ? voice.autoSpeak : false;

  // Normalize transcriptionVocabulary - apply defaults if not set
  const transcriptionVocabulary =
    Array.isArray(voice.transcriptionVocabulary) && voice.transcriptionVocabulary.length > 0
      ? voice.transcriptionVocabulary
      : DEFAULT_TRANSCRIPTION_VOCABULARY;

  // Normalize voiceInputLanguage - default to 'auto', validate against known codes
  let voiceInputLanguage = voice.voiceInputLanguage;
  if (!voiceInputLanguage || !VOICE_INPUT_LANGUAGE_CODES.has(voiceInputLanguage)) {
    voiceInputLanguage = 'auto';
  }

  // Normalize custom voice profiles and clean stale active profile references.
  const customProfiles = Array.isArray(voice.customProfiles) ? voice.customProfiles : [];
  let activeCustomProfileId =
    typeof voice.activeCustomProfileId === 'string' && voice.activeCustomProfileId.trim().length > 0
      ? voice.activeCustomProfileId
      : null;
  if (activeCustomProfileId && !customProfiles.find(profile => profile.id === activeCustomProfileId)) {
    activeCustomProfileId = null;
  }

  // Migration: Initialize tutorial checklist for existing users who completed onboarding
  // but don't have checklist state yet. Preserves existing state (including 'dismissed').
  // Also cleans up any orphaned step 5 data (step 5 was archived before implementation).
  let onboardingChecklist = settings.onboardingChecklist ??
    (settings.onboardingCompleted ? { step: 1 as const } : undefined);
  
  if (onboardingChecklist) {
    // Clean up any orphaned step 5 data from before it was removed
    const anyChecklist = onboardingChecklist as {
      step: number | string;
      completedSteps?: Record<number, boolean>;
      sessionIds?: Record<number, string>;
    };
    if (anyChecklist.completedSteps && 5 in anyChecklist.completedSteps) {
      delete anyChecklist.completedSteps[5];
    }
    if (anyChecklist.sessionIds && 5 in anyChecklist.sessionIds) {
      delete anyChecklist.sessionIds[5];
    }
    // If step was somehow 5, treat as complete (user must have finished 1-4)
    if (anyChecklist.step === 5) {
      onboardingChecklist = { ...onboardingChecklist, step: 'complete' as const };
    }
    // If steps 1-4 are all complete but step isn't 'complete', fix it
    const completed = anyChecklist.completedSteps ?? {};
    if (completed[1] && completed[2] && completed[3] && completed[4] &&
        typeof anyChecklist.step === 'number') {
      onboardingChecklist = { ...onboardingChecklist, step: 'complete' as const };
    }
  }

  // Migration: Strip deprecated fields + fields we re-emit below.
  // - semanticSearchEnabled: now keyword-triggered only
  // - workspaceWatcherEnabled: always enabled (auto-refresh is default behavior)
  //
  // Also destructure out fields whose value this function re-derives so that a
  // stale value in the input (e.g. `behindTheScenesModel: 'use-alternative'`)
  // does not survive through the `...settingsWithoutDeprecated` spread when the
  // derived value is undefined (Stage 2a). Each of these is re-added below via
  // conditional spread when the derived value is defined.
  const {
    semanticSearchEnabled: _semantic,
    workspaceWatcherEnabled: _watcher,
    // Fields with re-derived values (explicit cleanup to undefined must drop the key):
    activeProvider: _activeProviderIn,
    memorySafetyPrivate: _memorySafetyPrivateIn,
    memorySafetyShared: _memorySafetySharedIn,
    memorySafetyBySharing: _memorySafetyBySharingIn,
    spaceSafetyOverrides: _spaceSafetyOverridesIn,
    spaceSafetyLevels: _spaceSafetyLevelsIn,
    onboardingChecklist: _onboardingChecklistIn,
    behindTheScenesModel: _behindTheScenesModelIn,
    backgroundFallback: _backgroundFallbackIn,
    localInferenceCloudFallback: _localInferenceCloudFallbackIn,
    behindTheScenesOverrides: _behindTheScenesOverridesIn,
    managedCloudEnabled: _managedCloudEnabledIn,
    cloudUpdateChannel: _cloudUpdateChannelIn,
    firstTimeTooltips: _firstTimeTooltipsIn,
    seededBundledPluginIds: _seededBundledPluginIdsIn,
    openRouter: _openRouterIn,
    trustedTools: _trustedToolsIn,
    klavisMigrationPending: _klavisMigrationPendingIn,
    // eslint-disable-next-line no-restricted-syntax -- normalize intentionally drops the inert legacy claude mirror from its output (never re-emitted post-cutover; settingsUtils is the materializer/normalize point)
    claude: _claudeIn,
    ...settingsWithoutDeprecated
  } = settings as AppSettings & {
    semanticSearchEnabled?: boolean;
    workspaceWatcherEnabled?: boolean;
    klavisMigrationPending?: boolean;
  };
  // Silence unused-destructured-variable warnings (these are intentionally dropped).
  void _semantic; void _watcher;
  void _activeProviderIn; void _memorySafetyPrivateIn; void _memorySafetySharedIn;
  void _memorySafetyBySharingIn; void _spaceSafetyOverridesIn; void _spaceSafetyLevelsIn;
  void _onboardingChecklistIn; void _behindTheScenesModelIn; void _backgroundFallbackIn;
  void _localInferenceCloudFallbackIn;
  void _behindTheScenesOverridesIn; void _managedCloudEnabledIn; void _cloudUpdateChannelIn;
  void _firstTimeTooltipsIn; void _seededBundledPluginIdsIn; void _openRouterIn; void _trustedToolsIn;
  void _klavisMigrationPendingIn;
  void _claudeIn;

  // Migration: modelRoles -> behindTheScenesModel
  // If user has modelRoles but no behindTheScenesModel, migrate to unified setting
  let behindTheScenesModel = settings.behindTheScenesModel;
  if (!behindTheScenesModel && settings.modelRoles) {
    // Take auxiliary as the primary choice (most common), then safety, then memory
    behindTheScenesModel = 
      settings.modelRoles.auxiliary ?? 
      settings.modelRoles.safety ?? 
      settings.modelRoles.memory ?? 
      undefined;
  }

  // Migration: convert legacy "use-alternative" to explicit profile:<id> encoding.
  // "use-alternative" always delegated to the working profile, so resolve it now.
  if (behindTheScenesModel === 'use-alternative') {
    const workingProfile = getWorkingModelProfile({
      ...settings,
      models: claude as AppSettings['models'],
    });
    behindTheScenesModel = workingProfile ? `${PROFILE_PREFIX}${workingProfile.id}` : undefined;
  }

  // Clean up stale profile:<id> references when the referenced profile no longer exists.
  if (behindTheScenesModel?.startsWith(PROFILE_PREFIX)) {
    const btsProfileId = behindTheScenesModel.slice(PROFILE_PREFIX.length);
    const btsProfiles = settings.localModel?.profiles ?? [];
    if (!btsProfiles.find(p => p.id === btsProfileId)) {
      behindTheScenesModel = undefined;
    }
  }

  // Clean up stale profile references in per-task BTS overrides
  let behindTheScenesOverrides = settings.behindTheScenesOverrides;
  if (behindTheScenesOverrides) {
    const btsOverrideProfiles = settings.localModel?.profiles ?? [];
    const cleanedOverrides: Partial<Record<string, string>> = {};
    for (const [group, model] of Object.entries(behindTheScenesOverrides)) {
      if (model?.startsWith(PROFILE_PREFIX)) {
        const profileId = model.slice(PROFILE_PREFIX.length);
        if (btsOverrideProfiles.find(p => p.id === profileId)) {
          cleanedOverrides[group] = model;
        }
      } else if (model) {
        cleanedOverrides[group] = model;
      }
    }
    behindTheScenesOverrides = Object.keys(cleanedOverrides).length > 0
      ? cleanedOverrides as typeof behindTheScenesOverrides
      : undefined;
  }

  // Guard: clear slash-form BTS settings when no slash-form route exists.
  // Cross-provider BTS allows slash-form models (e.g. 'openai/gpt-5.4-mini') when they can
  // route via personal OR OAuth or Mindstone-managed routing.
  const hasOrCredentials = !!(settings.openRouter?.oauthToken);
  const hasOrBackedCredentials = canRouteSlashFormModel(settings);
  const canKeepSlashFormBtsModels = hasOrBackedCredentials;
  // WS0: raw slash-form `.includes('/')` sniffs kept below — bare "is slash-form"
  // booleans for clearing un-routable cross-provider BTS models; the classifier
  // adapters add behaviour-changing arms (ollama-first, dialect mapping). (lint allowlist)
  if (!canKeepSlashFormBtsModels) {
    if (behindTheScenesModel?.includes('/')) {
      behindTheScenesModel = undefined;
    }
    if (behindTheScenesOverrides) {
      const orCleaned = Object.fromEntries(
        Object.entries(behindTheScenesOverrides).filter(([, model]) => !model?.includes('/'))
      );
      behindTheScenesOverrides = Object.keys(orCleaned).length > 0
        ? orCleaned as typeof behindTheScenesOverrides
        : undefined;
    }
  }

  // Clean up defunct multiModelEnabled and councilModeEnabled keys
  // (council mode is now always available when council-enabled profiles exist)
  const experimental = { ...(settings.experimental ?? {}) };
  delete (experimental as Record<string, unknown>).councilModeEnabled;
  delete (experimental as Record<string, unknown>).multiModelEnabled;

  // Default localInferenceEnabled to false (opt-in feature)
  if (experimental.localInferenceEnabled === undefined) {
    experimental.localInferenceEnabled = false;
  }
  if (experimental.slackInboundThreadHistory === undefined) {
    experimental.slackInboundThreadHistory = true;
  }
  if (experimental.slackDesktopThreadContinuity === undefined) {
    experimental.slackDesktopThreadContinuity = true;
  }
  if (typeof experimental.agentInstanceId !== 'string' || !experimental.agentInstanceId.trim()) {
    experimental.agentInstanceId = FALLBACK_AGENT_INSTANCE_ID;
  }

  const inboundAuthorPolicyRaw = (experimental as { inboundAuthorPolicy?: unknown }).inboundAuthorPolicy;
  const shouldUseCloudPermissiveSeed = isCloudSettingsRuntime();
  const shouldUseUpgradePermissiveSeed = !!experimental.cloudSlackWorkspace;
  if (inboundAuthorPolicyRaw === undefined) {
    const shouldSeedLegacyPermissive = shouldUseCloudPermissiveSeed || shouldUseUpgradePermissiveSeed;
    experimental.inboundAuthorPolicy = createInboundAuthorPolicySeed(
      shouldSeedLegacyPermissive ? LEGACY_PERMISSIVE_MODE : OWNER_ONLY_MODE,
      shouldSeedLegacyPermissive,
    );
  } else if (
    typeof inboundAuthorPolicyRaw === 'object'
    && inboundAuthorPolicyRaw !== null
    && (inboundAuthorPolicyRaw as { inboundAuthorPolicySchemaVersion?: unknown }).inboundAuthorPolicySchemaVersion === InboundAuthorPolicySchemaVersion
  ) {
    const parsedInboundAuthorPolicy = InboundAuthorPolicySchema.safeParse(inboundAuthorPolicyRaw);
    if (!parsedInboundAuthorPolicy.success) {
      log.warn({
        event: INBOUND_AUTHOR_POLICY_CORRUPTED_EVENT,
        issues: parsedInboundAuthorPolicy.error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.join('.'),
        })),
      }, INBOUND_AUTHOR_POLICY_CORRUPTED_EVENT);
      persistInboundAuthorPolicyBackup({
        experimental: experimental as NonNullable<AppSettings['experimental']>,
        inboundAuthorPolicyRaw,
        branch: 'schema_v1_refine_failure',
        schemaVersion: InboundAuthorPolicySchemaVersion,
      });
      experimental.inboundAuthorPolicy = createInboundAuthorPolicySeed(LEGACY_PERMISSIVE_MODE, true);
    } else {
      experimental.inboundAuthorPolicy = parsedInboundAuthorPolicy.data;
    }
  } else {
    const schemaVersion = (
      typeof inboundAuthorPolicyRaw === 'object'
      && inboundAuthorPolicyRaw !== null
    )
      ? (inboundAuthorPolicyRaw as { inboundAuthorPolicySchemaVersion?: unknown }).inboundAuthorPolicySchemaVersion
      : undefined;
    log.warn({
      event: 'inbound_author_policy_corrupted_unknown_shape',
      type: typeof inboundAuthorPolicyRaw,
      schemaVersion: schemaVersion ?? null,
    }, 'inbound_author_policy_corrupted_unknown_shape');
    persistInboundAuthorPolicyBackup({
      experimental: experimental as NonNullable<AppSettings['experimental']>,
      inboundAuthorPolicyRaw,
      branch: 'unknown_shape_fallback',
      schemaVersion: schemaVersion ?? null,
    });
    experimental.inboundAuthorPolicy = createInboundAuthorPolicySeed(LEGACY_PERMISSIVE_MODE, true);
  }

  // Migration: memorySafetyLevel -> memorySafetyPrivate + memorySafetyShared
  // Preserve existing behavior: if user had a global memorySafetyLevel, apply to BOTH.
  // Only new users (no memorySafetyLevel set) get the new defaults (private=permissive).
  let memorySafetyPrivate = settings.memorySafetyPrivate;
  let memorySafetyShared = settings.memorySafetyShared;
  if (settings.memorySafetyLevel !== undefined &&
      memorySafetyPrivate === undefined &&
      memorySafetyShared === undefined) {
    // Existing user: preserve their behavior for both private and shared spaces
    memorySafetyPrivate = settings.memorySafetyLevel;
    memorySafetyShared = settings.memorySafetyLevel;
  }

  // Migration: Normalize 'team' -> 'restricted' in spaces
  // Accept 'team' for backward compatibility but normalize to 'restricted' on read
  const spacesWithNormalizedSharing = spaces.map(space => {
    if ((space.sharing as string) === 'team') {
      return { ...space, sharing: 'restricted' as const };
    }
    return space;
  });

  // Migration: 3-tier memory safety → spaceSafetyLevels (one-time migration)
  // This runs when spaceSafetyLevels is empty but legacy settings exist
  const migratedSpaceSafetyLevels = migrateToSpaceSafetyLevels(
    { ...settings, memorySafetyPrivate, memorySafetyShared },
    spacesWithNormalizedSharing
  );

  // Clean up stale spaceSafetyLevels entries for deleted spaces
  // Chief-of-Staff is never stored in spaceSafetyLevels (hardcoded to permissive)
  const spacePaths = new Set(
    spacesWithNormalizedSharing
      .filter(s => s.type !== 'chief-of-staff')
      .map(s => s.path)
  );
  const spaceSafetyLevels = migratedSpaceSafetyLevels
    ? Object.fromEntries(
        Object.entries(migratedSpaceSafetyLevels).filter(([path]) => spacePaths.has(path))
      )
    : undefined;

  // Migration: Pre-populate firstTimeTooltips for existing users so they don't
  // see discovery tooltips for features they've already used. New users (no
  // onboardingCompleted) get undefined → tooltips fire at natural trigger points.
  const firstTimeTooltips: Record<string, boolean> | undefined =
    settings.firstTimeTooltips ??
    (settings.onboardingCompleted
      ? {
          memoryFirstSave: true,
          permissionFirstPrompt: true,
          skillFirstUse: true,
          mentionFirstUse: true,
          automationFirstRun: true,
          spacesFirstUse: true,
        }
      : undefined);

  // Migration: Detect existing meeting bot users based on settings signals.
  // One-shot: only runs when meetingBotUnlocked is undefined (never evaluated).
  // Once set to true or false, this block is skipped on subsequent normalizations.
  let meetingBotUnlocked = settings.meetingBotUnlocked;
  const mb = settings.meetingBot;
  if (meetingBotUnlocked === undefined) {
    // Broad detection for first-time migration: any historical signal proves prior usage.
    const hasUsage = !!(
      (mb?.joinMode && mb.joinMode !== 'never') ||
      mb?.firefliesApiKey ||
      mb?.fathomApiKey ||
      mb?.recallApiKey ||
      mb?.triggerPhrase ||
      mb?.localRecordingConsentAcknowledged === true ||
      mb?.plaud?.enabled === true ||
      mb?.enabled === false  // explicitly disabled = proves they had it
    );
    meetingBotUnlocked = hasUsage;
  } else if (meetingBotUnlocked === false && mb?.joinMode && mb.joinMode !== 'never') {
    // Reactive upgrade: user (or agent) set joinMode to an active value after
    // the one-shot migration locked meetingBotUnlocked to false.
    // Only joinMode is checked here (not historical signals like API keys) so
    // that explicit opt-out via System tab toggle (which sets joinMode='never')
    // remains sticky.
    meetingBotUnlocked = true;
  }

  // managedCloudEnabled is set server-side via fetchAuthConfig() in authService.ts.
  // No client-side derivation — the server is the source of truth for entitlement.
  const managedCloudEnabled = settings.managedCloudEnabled;

  // Migration: legacy opusPlanMode → thinkingModel
  // Read both old persisted key (opusPlanMode) and new key (planMode) for backward compat.
  // If either is true and thinkingModel is not set, migrate to explicit thinkingModel.
  const claudeWithLegacyPlanMode = claude as ModelSettingsLike & { opusPlanMode?: boolean };
  const legacyPlanMode = claudeWithLegacyPlanMode.opusPlanMode ?? claude.planMode ?? false;
  let thinkingModel: string | undefined = claude.thinkingModel;
  if (legacyPlanMode && !thinkingModel) {
    thinkingModel = getDefaultModelForProvider(settings, 'thinking');
    // Stage 4: this site can fire both at boot/save AND mid-turn (user toggling
    // planMode in Settings while a turn is in flight). The auto-detect helper
    // emits the turn variant when `getTurnContext()` is populated.
    emitMaybeTurnBreadcrumb('settingsUtils:legacyPlanModeThinkingFallback', 'thinking', thinkingModel);
    // In legacy plan mode, Sonnet was used for execution regardless of claude.model.
    // If the user's model was Opus (common — it's the default), normalize to Sonnet
    // so thinkingModel !== workingModel and plan mode stays active.
    if (!normalizedModel.includes('sonnet')) {
      normalizedModel = getDefaultModelForProvider(settings, 'working');
      emitMaybeTurnBreadcrumb('settingsUtils:legacyPlanModeWorkingFallback', 'working', normalizedModel);
    }
  }
  // Guard: if thinkingModel is set but not a known model for the active provider, reset to undefined.
  // OpenRouter models contain '/' (e.g., 'z-ai/glm-5.1') and are validated against OR_MODEL_MAP.
  // Codex models are bare OpenAI IDs (e.g., 'gpt-5.5') and are validated against CODEX_ALL_MODEL_OPTIONS.
  // Anthropic/BYOK models are validated against MODEL_OPTIONS (the Anthropic catalog).
  //
  // NOTE: intentionally NOT using `isOpenRouterEffectiveProvider` here. That helper covers only
  // the explicit-provider axis (activeProvider = 'openrouter' | 'mindstone') and returns false for
  // undefined. This check adds an extra branch for any provider that has OR credentials — an
  // intentionally broader "can route OR" check for the thinking-model validation context, where
  // we want to accept slashed OR-format models even when the user's active provider has OR creds
  // in the background. The two checks have a different truth table for the
  // (activeProvider=!undefined && OR creds exist) case, so collapsing them here would change
  // behaviour for users on e.g. 'anthropic' with stale OR OAuth tokens. Tracked as cleanup debt
  // in docs/plans/260612_new-provider-process.
  const isOpenRouterProvider = settings.activeProvider === 'openrouter'
    || settings.activeProvider === 'mindstone'
    || (settings.openRouter?.enabled && settings.openRouter?.oauthToken);
  const isCodexProvider = settings.activeProvider === 'codex';
  if (thinkingModel) {
    // WS0: raw slash-form sniff kept (bare "is slash-form" boolean; classifier adapters
    // add behaviour-changing arms). (lint allowlist)
    const isOrModel = thinkingModel.includes('/');
    // Profile-backed exception: a slashed thinking model that matches a local
    // profile is a custom-provider model (e.g., Together's
    // 'deepseek-ai/DeepSeek-V4-Pro'). The runtime resolves it via
    // thinkingProfileId — keep it as-is so the executor can pick it up.
    const thinkingProfileMatch = isOrModel
      && !!settings.localModel?.profiles?.some(p => p.model === thinkingModel);
    if (thinkingProfileMatch) {
      // keep thinkingModel as-is
    } else if (isOrModel && isOpenRouterProvider) {
      if (!OR_MODEL_MAP.has(thinkingModel)) thinkingModel = undefined;
    } else if (!isOrModel) {
      if (!thinkingModel.trim()) {
        thinkingModel = undefined;
      } else if (isCodexProvider) {
        // REBEL-5MJ: Codex models are bare OpenAI IDs (e.g., 'gpt-5.5').
        // However, users can legitimately choose a claude-prefixed thinking model
        // while on the codex provider (cross-provider thinking state — the virtual
        // __virtual-thinking profile created at L1204-1211 lets a claude- thinkingModel
        // run via Anthropic-direct while the working model stays on codex).
        // - claude-prefixed: normalize + validate against the Anthropic catalog.
        // - bare non-claude IDs: validate against the Codex catalog.
        // WS0: raw `claude-` sniff kept — needs the claude-SPECIFIC predicate; the
        // classifier's `toModelDialect` collapses claude-/ollama/unknown/empty all to
        // 'anthropic-native', so it cannot stand in here. (lint allowlist)
        if (thinkingModel.startsWith('claude-')) {
          thinkingModel = normalizeModel(thinkingModel);
          const validAnthropicModels = MODEL_OPTIONS.map(opt => opt.value);
          if (!validAnthropicModels.includes(thinkingModel)) thinkingModel = undefined;
        } else {
          const validCodexModels = CODEX_ALL_MODEL_OPTIONS.map(opt => opt.value);
          if (!validCodexModels.includes(thinkingModel) || !isCodexModelSupported(thinkingModel)) {
            thinkingModel = undefined;
          }
        }
      } else {
        // Non-Codex active provider (anthropic / openrouter / mindstone / undefined)
        // with a bare (no-slash) thinking model. The thinking model can legitimately
        // be a cross-provider choice — e.g. GPT-5.5 thinking via a supplemental Codex
        // connection while the working model stays on the active provider (REBEL-5JN).
        //
        // Anthropic-catalog IDs are always accepted: a `claude-`-prefixed thinking
        // model is materialized into a `__virtual-thinking` profile downstream (L1570),
        // so it is reachable without an existing profile.
        //
        // A bare Codex/OpenAI ID, however, is ONLY reachable at runtime when an enabled
        // local profile already names it: `createClientForModel` turns a bare model into
        // a profile via `resolveProfileFromModelString`, which matches on an enabled
        // profile's `.model` field (clientFactory.ts:462-464, 666-677). With no such
        // profile, an active-Anthropic turn sends the bare OpenAI ID through direct
        // Anthropic (providerRouting.ts:1048-1080) — i.e. broken. So we apply the SAME
        // reachability check the runtime uses, not a mere catalog-membership/deny-list
        // test (`isCodexModelSupported` is a support deny-list, not a routing check).
        // The auto Codex working profile (`codex-gpt-5.5`, model `gpt-5.5`) provides
        // this routability for the reported REBEL-5JN case once Codex is connected;
        // `gpt-5.4` / `gpt-5.3-codex` etc. have no auto profile and are cleared (as
        // before Stage 1) unless the user has a matching enabled profile.
        thinkingModel = normalizeModel(thinkingModel);
        const validAnthropicModels = MODEL_OPTIONS.map(opt => opt.value);
        const validCodexModels = CODEX_ALL_MODEL_OPTIONS.map(opt => opt.value);
        const isKnownAnthropic = validAnthropicModels.includes(thinkingModel);
        // Reachability: mirror resolveProfileFromModelString's bare-ID branch — an
        // enabled local profile whose `.model` equals the thinking model.
        const hasRoutableProfile = !!settings.localModel?.profiles?.some(
          p => p.model === thinkingModel && p.enabled !== false,
        );
        const isKnownCodex =
          validCodexModels.includes(thinkingModel)
          && isCodexModelSupported(thinkingModel)
          && hasRoutableProfile;
        if (!isKnownAnthropic && !isKnownCodex) thinkingModel = undefined;
      }
    } else {
      // OR-format model but not on OpenRouter provider.
      // Anthropic-prefixed models can be normalized to SDK format (FOX-3096).
      // Non-Anthropic OR-format models on non-OR providers are invalid → clear.
      if (thinkingModel.startsWith('anthropic/')) {
        const bareModel = thinkingModel.slice('anthropic/'.length);
        const normalizedBare = normalizeModel(bareModel);
        const validModels = MODEL_OPTIONS.map(opt => opt.value);
        thinkingModel = validModels.includes(normalizedBare) ? normalizedBare : undefined;
      } else {
        thinkingModel = undefined;
      }
    }
  }
  // FOX-3096: OR-format Anthropic models (e.g. "anthropic/claude-opus-4.7") route to
  // Anthropic-direct in clientFactory, not OpenRouter. Normalize to bare SDK ID.
  // Skipped when user is effectively on OpenRouter (explicit OR provider OR OR credentials).
  if (thinkingModel?.startsWith('anthropic/') && !isEffectivelyOpenRouter) {
    const bareModel = thinkingModel.slice('anthropic/'.length);
    const normalizedThinkingModel = normalizeModel(bareModel);
    const validThinkingModels = MODEL_OPTIONS.map(opt => opt.value);
    thinkingModel = validThinkingModels.includes(normalizedThinkingModel)
      ? normalizedThinkingModel
      : undefined;
  }

  // Migration: derive activeProvider from existing state when not yet set.
  // 'codex' and 'mindstone' are only set by their respective onboarding/settings
  // flows (never auto-derived). Fresh users (no provider connected yet) get
  // undefined so onboarding shows no pre-selection.
  const activeProvider: ActiveProvider | undefined = (() => {
    if (settings.activeProvider === 'codex') return 'codex';
    if (settings.activeProvider === 'mindstone') return 'mindstone';
    if (settings.activeProvider === 'openrouter') return 'openrouter';
    if (settings.activeProvider === 'anthropic') return 'anthropic';
    // Auto-derive from openRouter.enabled for users who predate activeProvider
    if (settings.openRouter?.enabled && settings.openRouter?.oauthToken) return 'openrouter';
    return undefined;
  })();
  // Stage 6a: enforce `activeProvider === enabledProviders[0]` when the list is
  // present. This is the normalizeSettings head-sync invariant — it reconciles
  // the list after a legacy `providerSwitch` that writes `activeProvider` only.
  // Zero-write migration: if `enabledProviders` is absent (all existing users),
  // this is a no-op and output is byte-identical. Deliberate: see
  // docs/plans/260618_multiprovider-foundation/PLAN.md — Stage 6a.
  const enabledProviders = syncEnabledProvidersHead(
    settingsWithoutDeprecated.enabledProviders,
    activeProvider,
  );

  const orShouldBeEnabled =
    activeProvider === 'openrouter' && !!settings.openRouter?.oauthToken;
  const openRouter = settings.openRouter && settings.openRouter.enabled !== orShouldBeEnabled
    ? { ...settings.openRouter, enabled: orShouldBeEnabled }
    : settings.openRouter;

  // Stage 2a: stop stamping `contextWindow` from the registry on non-virtual
  // profiles. The cascade in `resolveModelLimits` already consults the
  // registry at call time (priority 2), so the stamp was redundant and
  // actively harmful — it left registry-derived values indistinguishable
  // from user-set values, blocking the auto-learn source guard. Virtual
  // profiles are still stamped via `withKnownProfileContextWindow` because
  // their `contextWindow` field is part of how routing components surface
  // them. See docs/plans/260503_unify_learned_limits_into_profiles.md
  // — Cascade Resolution → Source-blind legacy data.
  const normalizeLocalPresetProfile = (rawProfile: ModelProfile): ModelProfile => {
    // MIGRATION (REBEL-5RJ; applies to EVERY profile, not just local presets):
    // the manual "Off" thinking level (`reasoningDisabled`) was removed 2026-06-18;
    // thinking suppression is now driven solely by the auto-detected
    // `thinkingCompatibility` verdict. Preserve any profile that relied on the
    // manual flag to suppress reasoning by marking it thinking-incompatible (it
    // self-heals if a fresh Test later succeeds), clear the now-orphaned effort,
    // and drop the legacy key so it doesn't linger via the schema's `.passthrough()`.
    // Without this, a manually-"Off" profile that was never Test-probed
    // (`thinkingCompatibility:'unknown'`) would resume sending `reasoning_effort`
    // and re-break the very gateways the flag protected. See
    // docs/project/CUSTOM_GATEWAY_COMPATIBILITY.md.
    const legacy = rawProfile as ModelProfile & { reasoningDisabled?: boolean };
    let profile: ModelProfile = rawProfile;
    if (legacy.reasoningDisabled !== undefined) {
      const { reasoningDisabled, ...rest } = legacy;
      profile =
        reasoningDisabled === true
          ? { ...rest, thinkingCompatibility: 'incompatible', reasoningEffort: undefined }
          : rest;
    }

    const presetKey = getProfilePresetKey(profile);
    if (!presetKey?.startsWith('local:')) {
      return profile;
    }

    const updates: Partial<ModelProfile> = {};
    if (profile.providerType !== 'other') {
      log.info(
        {
          category: 'profile-normalization',
          field: 'providerType',
          from: profile.providerType,
          to: 'other',
          reason: 'preset-key-coercion',
          profileId: profile.id,
        },
        '[normalize] Coerced profile providerType for local preset',
      );
      updates.providerType = 'other';
    }

    if (profile.routeSurface === undefined) {
      updates.routeSurface = 'local';
    } else if (profile.routeSurface !== 'local') {
      log.info(
        {
          category: 'profile-normalization',
          field: 'routeSurface',
          from: profile.routeSurface,
          to: 'local',
          reason: 'preset-key-coercion',
          profileId: profile.id,
        },
        '[normalize] Coerced profile routeSurface for local preset',
      );
      updates.routeSurface = 'local';
    }

    return Object.keys(updates).length > 0
      ? { ...profile, ...updates }
      : profile;
  };

  const rawProfiles = (settings.localModel?.profiles ?? []).map(normalizeLocalPresetProfile);

  // Defensive cleanup: prune stale providerType:'local' profiles when local inference is disabled.
  // This prevents orphaned local profiles from lingering if the feature is toggled off.
  let profiles = experimental.localInferenceEnabled
    ? rawProfiles
    : rawProfiles.filter(p => p.providerType !== 'local');

  // Migration: thinkingProfileId / workingProfileId
  // Validate that profile IDs reference existing profiles; reset stale references.
  const profileIds = new Set(profiles.map(p => p.id));

  let thinkingProfileId: string | undefined = claude.thinkingProfileId;
  let workingProfileId: string | undefined = claude.workingProfileId;
  let longContextFallbackProfileId: string | undefined = claude.longContextFallbackProfileId;
  const hadPrunedLocalThinkingProfile = !!claude.thinkingProfileId
    && !profileIds.has(claude.thinkingProfileId)
    && rawProfiles.some((profile) => profile.id === claude.thinkingProfileId && profile.providerType === 'local');
  const hadPrunedLocalWorkingProfile = !!claude.workingProfileId
    && !profileIds.has(claude.workingProfileId)
    && rawProfiles.some((profile) => profile.id === claude.workingProfileId && profile.providerType === 'local');

  // Reset stale profile references
  if (thinkingProfileId && !profileIds.has(thinkingProfileId)) {
    thinkingProfileId = undefined;
  }
  if (workingProfileId && !profileIds.has(workingProfileId)) {
    workingProfileId = undefined;
  }
  if (longContextFallbackProfileId && !profileIds.has(longContextFallbackProfileId)) {
    longContextFallbackProfileId = undefined;
  }

  // Normalize longContextFallbackModel: clear blank values, migrate deprecated models
  let longContextFallbackModel: string | undefined = claude.longContextFallbackModel;
  if (longContextFallbackModel !== undefined) {
    if (!longContextFallbackModel.trim()) {
      longContextFallbackModel = undefined;
    } else {
      longContextFallbackModel = normalizeModel(longContextFallbackModel);
    }
  }
  let thinkingFallback: string | undefined = claude.thinkingFallback;
  let workingFallback: string | undefined = claude.workingFallback;
  let backgroundFallback: string | undefined = settings.backgroundFallback;
  let localInferenceCloudFallback: string | undefined = settings.localInferenceCloudFallback;

  const normalizeTierFallback = (fallback: string | undefined): string | undefined => {
    if (!fallback) return undefined;
    if (fallback.startsWith(PROFILE_PREFIX)) {
      const profileId = fallback.slice(PROFILE_PREFIX.length);
      if (!profileIds.has(profileId)) {
        return undefined;
      }
      return fallback;
    }
    if (fallback.startsWith(MODEL_PREFIX)) {
      return `${MODEL_PREFIX}${normalizeModel(fallback.slice(MODEL_PREFIX.length))}`;
    }
    return fallback;
  };

  thinkingFallback = normalizeTierFallback(thinkingFallback);
  workingFallback = normalizeTierFallback(workingFallback);
  backgroundFallback = normalizeTierFallback(backgroundFallback);
  localInferenceCloudFallback = normalizeTierFallback(localInferenceCloudFallback);

  type RoutedFallbackProvider = 'anthropic' | 'codex' | 'openai' | 'openrouter';

  const profileById = new Map(profiles.map(profile => [profile.id, profile]));
  const rawProfileById = new Map(rawProfiles.map(profile => [profile.id, profile]));
  const inferProviderFromModelId = (modelId: string): RoutedFallbackProvider | undefined =>
    toRoutedFallbackProvider(modelId);
  const resolveFallbackProvider = (
    rawValue: string,
    options?: { treatAsProfileId?: boolean }
  ): RoutedFallbackProvider | undefined => {
    const profileId = options?.treatAsProfileId
      ? rawValue
      : rawValue.startsWith(PROFILE_PREFIX)
        ? rawValue.slice(PROFILE_PREFIX.length)
        : undefined;

    if (profileId) {
      const profile = profileById.get(profileId);
      if (!profile) {
        return undefined;
      }
      if (isLoopbackRoutableProfile(profile)) {
        return undefined;
      }
      if (isCodexSubscriptionProfile(profile)) {
        return 'codex';
      }
      if (resolveProfileApiKey(profile, settings.providerKeys, settings.customProviders)) {
        return undefined;
      }
      if (profile.providerType === 'openrouter') {
        return 'openrouter';
      }
      if (profile.providerType === 'openai') {
        return 'openai';
      }
      return undefined;
    }

    const modelId = stripStoredModelPrefix(rawValue) ?? rawValue;
    return inferProviderFromModelId(modelId);
  };
  const clearFallbackIfCredentialPathMissing = (
    field: string,
    value: string | undefined,
    options?: { treatAsProfileId?: boolean }
  ): string | undefined => {
    if (!value) {
      return value;
    }

    const provider = resolveFallbackProvider(value, options);
    let reason: string | undefined;
    if (provider === 'openrouter' && !canKeepSlashFormBtsModels) {
      reason = 'no-openrouter-credentials';
    } else if (provider === 'anthropic' && !normalizeApiKey(claude.apiKey) && !hasOrCredentials) {
      reason = 'no-anthropic-or-openrouter-credentials';
    } else if (provider === 'openai' && !normalizeApiKey(settings.providerKeys?.openai) && !hasOrCredentials) {
      reason = 'no-openai-or-openrouter-credentials';
    }

    if (reason) {
      log.info({ field, previousValue: value, reason }, '[normalize] Cleared fallback with no credential path');
      return undefined;
    }

    return value;
  };

  thinkingFallback = clearFallbackIfCredentialPathMissing('thinkingFallback', thinkingFallback);
  workingFallback = clearFallbackIfCredentialPathMissing('workingFallback', workingFallback);
  backgroundFallback = clearFallbackIfCredentialPathMissing('backgroundFallback', backgroundFallback);
  localInferenceCloudFallback = clearFallbackIfCredentialPathMissing(
    'localInferenceCloudFallback',
    localInferenceCloudFallback
  );
  longContextFallbackModel = clearFallbackIfCredentialPathMissing('longContextFallbackModel', longContextFallbackModel);
  longContextFallbackProfileId = clearFallbackIfCredentialPathMissing(
    'longContextFallbackProfileId',
    longContextFallbackProfileId,
    { treatAsProfileId: true }
  );
  if (localInferenceCloudFallback?.startsWith(PROFILE_PREFIX)) {
    const fallbackProfileId = localInferenceCloudFallback.slice(PROFILE_PREFIX.length);
    const fallbackProfile = profileById.get(fallbackProfileId) ?? rawProfileById.get(fallbackProfileId);
    if (fallbackProfile && isLoopbackRoutableProfile(fallbackProfile)) {
      log.info(
        {
          fallbackProfileId,
          providerType: fallbackProfile.providerType,
          routeSurface: fallbackProfile.routeSurface,
          serverUrl: fallbackProfile.serverUrl,
          presetKey: getProfilePresetKey(fallbackProfile),
          reason: 'loopback-fallback-not-allowed',
        },
        'localInferenceCloudFallback: cleared loopback fallback profile during normalization',
      );
      localInferenceCloudFallback = undefined;
    }
  }
  if (!workingProfileId && hadPrunedLocalWorkingProfile && localInferenceCloudFallback?.startsWith(PROFILE_PREFIX)) {
    const fallbackProfileId = localInferenceCloudFallback.slice(PROFILE_PREFIX.length);
    if (profileIds.has(fallbackProfileId)) {
      const sourceProfileId = claude.workingProfileId;
      const sourceProfile = sourceProfileId ? rawProfileById.get(sourceProfileId) : undefined;
      log.info(
        {
          profileId: sourceProfileId,
          providerType: sourceProfile?.providerType,
          routeSurface: sourceProfile?.routeSurface,
          serverUrl: sourceProfile?.serverUrl,
          presetKey: getProfilePresetKey(sourceProfile),
          surface: 'working',
          fallbackProfileId,
        },
        'localInferenceCloudFallback: substituted local-only profile for cloud surface',
      );
      workingProfileId = fallbackProfileId;
    }
  }
  if (!thinkingProfileId && hadPrunedLocalThinkingProfile && localInferenceCloudFallback?.startsWith(PROFILE_PREFIX)) {
    const fallbackProfileId = localInferenceCloudFallback.slice(PROFILE_PREFIX.length);
    if (profileIds.has(fallbackProfileId)) {
      const sourceProfileId = claude.thinkingProfileId;
      const sourceProfile = sourceProfileId ? rawProfileById.get(sourceProfileId) : undefined;
      log.info(
        {
          profileId: sourceProfileId,
          providerType: sourceProfile?.providerType,
          routeSurface: sourceProfile?.routeSurface,
          serverUrl: sourceProfile?.serverUrl,
          presetKey: getProfilePresetKey(sourceProfile),
          surface: 'thinking',
          fallbackProfileId,
        },
        'localInferenceCloudFallback: substituted local-only profile for cloud surface',
      );
      thinkingProfileId = fallbackProfileId;
    }
  }
  if (behindTheScenesOverrides) {
    const cleanedOverrides = Object.fromEntries(
      Object.entries(behindTheScenesOverrides).reduce<Array<[string, string]>>((acc, [group, model]) => {
        const cleanedModel = clearFallbackIfCredentialPathMissing(
          `behindTheScenesOverrides.${group}`,
          model
        );
        if (cleanedModel) {
          acc.push([group, cleanedModel]);
        }
        return acc;
      }, [])
    );
    behindTheScenesOverrides = Object.keys(cleanedOverrides).length > 0
      ? cleanedOverrides as typeof behindTheScenesOverrides
      : undefined;
  }

  // Migrate activeProfileId → workingProfileId (one-time, when workingProfileId is absent)
  // Keep activeProfileId intact — BTS and other consumers depend on it.
  const activeProfileId = settings.localModel?.activeProfileId ?? null;
  if (activeProfileId && profileIds.has(activeProfileId) && !workingProfileId) {
    workingProfileId = activeProfileId;
    // Same-as-working: clear thinkingModel so single-model mode is used
    thinkingModel = undefined;
  }

  // WS0: raw `claude-` sniff kept — claude-SPECIFIC gate for the virtual-thinking
  // Anthropic profile; `toModelDialect` is too broad ('anthropic-native' also covers
  // ollama/unknown/empty), so consolidation would change behaviour. (lint allowlist)
  if (!thinkingProfileId && thinkingModel?.startsWith('claude-')) {
    profiles = upsertVirtualAnthropicProfile(profiles, {
      id: VIRTUAL_THINKING_PROFILE_ID,
      name: 'Claude (Thinking)',
      model: thinkingModel,
    });
    thinkingProfileId = VIRTUAL_THINKING_PROFILE_ID;
  }

  // WS0: raw `claude-` sniff kept — claude-SPECIFIC gate for the virtual-working
  // Anthropic profile; `toModelDialect` is too broad ('anthropic-native' also covers
  // ollama/unknown/empty), so consolidation would change behaviour. (lint allowlist)
  if (
    !workingProfileId &&
    activeProvider !== undefined &&
    activeProvider !== 'anthropic' &&
    normalizedModel.startsWith('claude-')
  ) {
    profiles = upsertVirtualAnthropicProfile(profiles, {
      id: VIRTUAL_WORKING_PROFILE_ID,
      name: 'Claude (Working)',
      model: normalizedModel,
    });
    workingProfileId = VIRTUAL_WORKING_PROFILE_ID;
  }

  // thinkingProfileId and thinkingModel are mutually exclusive: profile takes precedence
  if (thinkingProfileId) {
    thinkingModel = undefined;
  }

  // Derive planMode from thinkingModel (true when thinking and working models differ)
  const derivedPlanMode = !!thinkingModel && thinkingModel !== normalizedModel;
  const normalizedLocalModel = settings.localModel
    ? { ...settings.localModel, profiles }
    : { ...DEFAULT_LOCAL_MODEL_SETTINGS, profiles };

  // Build the normalized `models` sub-object. Use `stripUndefined` to drop
  // keys whose value is `undefined` (thinkingModel, thinkingProfileId, etc.)
  // so JSON persistence and `fast-deep-equal` agree on shape (Stage 2a).
  const normalizedClaude = stripUndefined({
    ...stripLegacyPlanModeKey(claude),
    oauthToken: claude.oauthToken ?? null,
    authMethod: claude.authMethod ?? 'api-key',
    model: normalizedModel,
    executablePath: trimmedExecutable,
    // Migration: 'default' and 'acceptEdits' modes were removed (they caused silent
    // tool denials because Rebel's canUseTool callback unconditionally denies).
    permissionMode: claude.permissionMode === 'bypassPermissions' || claude.permissionMode === 'plan'
      ? claude.permissionMode
      : 'bypassPermissions',
    planMode: derivedPlanMode,
    thinkingModel,
    thinkingProfileId,
    workingProfileId,
    thinkingFallback,
    workingFallback,
    // 1M context is GA for supported Claude models. Keep the stored field for backward
    // compatibility, but normalize to enabled and rely on runtime 200K fallback paths when
    // OAuth or account limits reject long context for a given turn/session.
    extendedContext: true,
    learnedContextWindowEnabled: claude.learnedContextWindowEnabled,
    longContextFallbackModel,
    longContextFallbackProfileId,
  });

  // Build OpenRouter settings when present (null oauthToken is valid — only drop
  // the whole object when `settings.openRouter` is absent).
  // Uses the `openRouter` variable (not `settings.openRouter`) to pick up the
  // `orShouldBeEnabled` fix that repairs the `.enabled` flag.
  const normalizedOpenRouter = openRouter
    ? {
        ...DEFAULT_OPENROUTER_SETTINGS,
        ...openRouter,
        oauthToken: openRouter.oauthToken ?? null,
        selectedModel: openRouter.selectedModel || DEFAULT_OPENROUTER_SETTINGS.selectedModel,
      }
    : undefined;

  // Migration: canonicalize legacy compound trustedTools entries ("packageId/toolId" → "toolId")
  const normalizedTrustedTools = settings.trustedTools
    ? normalizeTrustedTools(settings.trustedTools)
    : undefined;

  // Normalize dismissedAnnouncements, with migration from legacy klavisMigrationPending=false.
  // klavisMigrationPending is no longer a field on AppSettings (the entire Klavis banner UI
  // is gone), but persisted settings on disk may still carry the legacy value — preserve
  // dismissal state for users who already dismissed before the field was removed. The legacy
  // field itself is stripped from the normalised output by the destructure below.
  const legacyKlavisMigrationPending = (settings as { klavisMigrationPending?: boolean })
    .klavisMigrationPending;
  const normalizedDismissedAnnouncements = (() => {
    const base = settings.dismissedAnnouncements ?? {};
    if (legacyKlavisMigrationPending === false && !base['klavis-migration']) {
      return { ...base, 'klavis-migration': true };
    }
    return base;
  })();

  // Clamp sessionLogRetentionDays (undefined/NaN/Infinity → default 14; clamp to [7, 365]).
  const normalizedSessionLogRetentionDays = (() => {
    const raw = settings.sessionLogRetentionDays;
    if (raw === undefined || typeof raw !== 'number' || !Number.isFinite(raw)) {
      return 14;
    }
    return Math.max(7, Math.min(365, Math.round(raw)));
  })();

  // Return with conditional spread at each potentially-undefined emitter site
  // (Stage 2a). Emitting `{ key: undefined }` would get stripped by JSON
  // persistence but diffs unequal against `{}` in `fast-deep-equal`, driving a
  // write on every explicit `ensureNormalizedSettings()` call. Conditional
  // spread drops the key entirely when the value is undefined.
  //
  // `stripUndefined(settingsWithoutDeprecated)` guards against the spread
  // source leaking undefined keys (e.g. `DEFAULT_SETTINGS.cloudUpdateChannel`
  // is explicitly `undefined` — without stripping, the key would appear as
  // `{ cloudUpdateChannel: undefined }` regardless of our explicit emission).
  return {
    ...stripUndefined(settingsWithoutDeprecated),
    localModel: normalizedLocalModel,
    experimental,
    spaces: spacesWithNormalizedSharing,
    onboardingCompleted:
      typeof settings.onboardingCompleted === 'boolean' ? settings.onboardingCompleted : false,
    onboardingFirstCompletedAt:
      typeof settings.onboardingFirstCompletedAt === 'number'
        ? settings.onboardingFirstCompletedAt
        : null,
    models: normalizedClaude as AppSettings['models'],
    mcpConfigFile: trimmedMcpConfig,
    providerKeys,
    voice: {
      ...voice,
      provider,
      model,
      ttsVoice,
      activationHotkey,
      activationHotkeyVoiceMode,
      inlineVoiceHotkey,
      autoSpeak,
      transcriptionVocabulary,
      voiceInputLanguage,
      customProfiles,
      activeCustomProfileId,
      // Derive voice.openaiApiKey from providerKeys.openai for backwards compat
      openaiApiKey: normalizeApiKey(providerKeys.openai) ?? normalizeApiKey(voice.openaiApiKey),
    },
    diagnostics,
    nps,
    surveys,
    theme,
    inboxLayoutMode,
    // Normalize lastSeenChangelogVersion: undefined -> null (never viewed)
    lastSeenChangelogVersion: settings.lastSeenChangelogVersion ?? null,
    // Preserve dismissed What's New highlights (keyed by version)
    dismissedWhatsNewHighlights: settings.dismissedWhatsNewHighlights ?? {},
    dismissedAnnouncements: normalizedDismissedAnnouncements,
    scratchpad: {
      ...DEFAULT_SCRATCHPAD_SETTINGS,
      ...(settings.scratchpad ?? {})
    },
    meetingBotUnlocked,
    mcpServerEnabled: settings.mcpServerEnabled ?? false,
    showDirectMcpSetupUi: settings.showDirectMcpSetupUi ?? false,
    enforceSoftwareEngineerEvidence: settings.enforceSoftwareEngineerEvidence ?? false,
    chatIntentRulePersistence: settings.chatIntentRulePersistence ?? true,
    safetyEvalMemoization: settings.safetyEvalMemoization ?? true,
    safetyEvalSessionIntent: settings.safetyEvalSessionIntent ?? true,
    safetyEvalBlockConsensus: settings.safetyEvalBlockConsensus ?? true,
    safetyEvalUserIntentFence: settings.safetyEvalUserIntentFence ?? true,
    sessionLogRetentionDays: normalizedSessionLogRetentionDays,
    // Normalize favoriteFilePaths - default to empty array
    favoriteFilePaths: Array.isArray(settings.favoriteFilePaths) ? settings.favoriteFilePaths : [],

    actionsFirstVisitedAt: typeof settings.actionsFirstVisitedAt === 'number' ? settings.actionsFirstVisitedAt : null,
    // Conditional inclusion for potentially-undefined fields — see Stage 2a.
    ...(activeProvider !== undefined ? { activeProvider } : {}),
    ...(memorySafetyPrivate !== undefined ? { memorySafetyPrivate } : {}),
    ...(memorySafetyShared !== undefined ? { memorySafetyShared } : {}),
    ...(settings.memorySafetyBySharing !== undefined ? { memorySafetyBySharing: settings.memorySafetyBySharing } : {}),
    ...(settings.spaceSafetyOverrides !== undefined ? { spaceSafetyOverrides: settings.spaceSafetyOverrides } : {}),
    ...(settings.seededBundledPluginIds !== undefined ? { seededBundledPluginIds: settings.seededBundledPluginIds } : {}),
    ...(spaceSafetyLevels !== undefined ? { spaceSafetyLevels } : {}),
    ...(onboardingChecklist !== undefined ? { onboardingChecklist } : {}),
    ...(behindTheScenesModel !== undefined ? { behindTheScenesModel } : {}),
    ...(backgroundFallback !== undefined ? { backgroundFallback } : {}),
    ...(localInferenceCloudFallback !== undefined ? { localInferenceCloudFallback } : {}),
    ...(behindTheScenesOverrides !== undefined ? { behindTheScenesOverrides } : {}),
    ...(managedCloudEnabled !== undefined ? { managedCloudEnabled } : {}),
    ...(settings.cloudUpdateChannel !== undefined ? { cloudUpdateChannel: settings.cloudUpdateChannel } : {}),
    ...(firstTimeTooltips !== undefined ? { firstTimeTooltips } : {}),
    ...(normalizedOpenRouter !== undefined ? { openRouter: normalizedOpenRouter } : {}),
    ...(normalizedTrustedTools !== undefined ? { trustedTools: normalizedTrustedTools } : {}),
    // Stage 6a: emit the head-sync–reconciled `enabledProviders` rather than the
    // raw value from `settingsWithoutDeprecated` (which would otherwise win via the
    // leading spread). Conditional: when `enabledProviders` was absent in the input
    // (all existing single-provider users), this is undefined and the spread is a
    // no-op → byte-identical output for those users. Deliberate: see
    // docs/plans/260618_multiprovider-foundation/PLAN.md — Stage 6a.
    ...(enabledProviders !== undefined ? { enabledProviders } : {}),
  };
};
