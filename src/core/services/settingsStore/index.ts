import Store from 'electron-store';
import fs from 'node:fs';
import type { AppSettings, DiagnosticsSettings, ModelProfile } from '@shared/types';
import type { KeyValueStore } from '@core/store';
import { createStore } from '@core/storeFactory';
import { createScopedLogger, type Logger } from '@core/logger';
import {
  DEFAULT_DIAGNOSTICS_SETTINGS,
  DEFAULT_LOCAL_MODEL_SETTINGS,
  DEFAULT_VOICE_ACTIVATION_HOTKEY,
  DEFAULT_VOICE_ACTIVATION_VOICE_MODE,
  DEFAULT_MEETING_BOT_SETTINGS
} from '@shared/types';
import { PREFERRED_PLANNING_MODEL } from '@shared/utils/modelNormalization';
import { isCodexAutoProfile, repairCodexProfileState, stripAutoProfileCapabilityFlags, type CodexRepairResult } from '@shared/utils/codexDefaults';
import { findShadowingConnectionManagedSibling } from '@shared/utils/profileHelpers';
import { migrateProfileRouteSurfaces } from '@shared/utils/profileRouteSurfaceMigration';
import { normalizeSettings } from '@shared/utils/settingsUtils';
import { applyOpenRouterModelDefaults } from '@shared/utils/openRouterDefaults';
import { normalizeApiKey } from '@shared/utils/providerKeys';
import { DEFAULT_OPENROUTER_SETTINGS } from '@shared/types/settings';
import { materializeModelsFromLegacy } from '@shared/utils/modelSettingsResolver';
import type { ActiveProvider } from '@shared/types/settings';
import { validateProviderCredentials } from '@core/utils/validateProviderCredentials';
import { getTracker } from '@core/tracking';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { isUserDataReadOnly } from '@core/userDataWriteGate';
import { isTooManyOpenFilesError, withSingleSyncRetryOnEmfile } from '@core/utils/emfileRetry';
import { tagFsExhaustion } from '@core/utils/gracefulFsObservability';
import { getErrorReporter } from '@core/errorReporter';
import { WindowedCounter, type WindowedCounterSnapshot } from '@core/services/perfCounters';
import { PROFILE_PREFIX } from '@shared/utils/btsModelValueNormalization';
import { isProfileReference } from '@core/rebelCore/providerRouteDecision';
import deepEqual from 'fast-deep-equal';

const log = createScopedLogger({ service: 'settingsStore' });

export const DEFAULT_SETTINGS: AppSettings = {
  coreDirectory: null,
  mcpConfigFile: null,
  onboardingCompleted: false,
  userFirstName: null,
  userEmail: null,
  onboardingFirstCompletedAt: null,
  nps: {
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
  },
  voice: {
    provider: (process.platform === 'darwin' || process.platform === 'win32')
      ? 'local-parakeet'
      : 'openai-whisper',
    openaiApiKey: null,
    elevenlabsApiKey: null,
    model: (process.platform === 'darwin' || process.platform === 'win32')
      ? 'parakeet-v3'
      : 'gpt-4o-mini-transcribe-2025-12-15',
    ttsVoice: 'nova',
    activationHotkey: DEFAULT_VOICE_ACTIVATION_HOTKEY,
    activationHotkeyVoiceMode: DEFAULT_VOICE_ACTIVATION_VOICE_MODE
  },
  models: {
    apiKey: null,
    oauthToken: null,
    authMethod: 'api-key',
    model: PREFERRED_PLANNING_MODEL,
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: true,
    learnedContextWindowEnabled: false,
    thinkingEffort: 'high'
  },
  diagnostics: { ...DEFAULT_DIAGNOSTICS_SETTINGS },
  surveys: {},
  actionsFirstVisitedAt: null,
  theme: 'dark',
  memoryUpdateEnabled: true,
  // memorySafetyLevel removed - new users get memorySafetyPrivate/Shared defaults instead
  // Existing users with memorySafetyLevel will have it migrated in normalizeSettings()
  localModel: { ...DEFAULT_LOCAL_MODEL_SETTINGS },
  meetingBot: { ...DEFAULT_MEETING_BOT_SETTINGS },
  sessionLogRetentionDays: 14,
  showDirectMcpSetupUi: false,
  enforceSoftwareEngineerEvidence: false,
  cloudUpdateChannel: undefined,
  enablePriorTurnsHeader: false
};

// CRITICAL: This store MUST use `new Store()` (direct electron-store), NOT `createStore()`.
//
// Why: This file is imported at the top of src/main/index.ts (line ~37) via
// ES module hoisting, which resolves all imports BEFORE any code executes.
// setStoreFactory() runs on line ~46 of index.ts — AFTER this module has
// already loaded. Using createStore() here causes "StoreFactory not initialized"
// crash on every startup.
//
// The lazy getStore() pattern used by other stores doesn't work here because
// settingsStore is accessed synchronously during import-time initialization.
//
// CI enforced: scripts/check-settings-store-bootstrap.ts
type SettingsStoreOptions = ConstructorParameters<typeof Store<AppSettings>>[0] & {
  configFileMode?: number;
};

const settingsStoreOptions: SettingsStoreOptions = {
  name: 'app-settings',
  defaults: DEFAULT_SETTINGS,
  configFileMode: 0o600,
};

// electron-store reads the settings JSON synchronously in its constructor
// (conf `get store()` → fs.readFileSync) — graceful-fs can't reach sync reads, so
// a transient EMFILE at startup would crash. One sync retry absorbs it, matching
// the steady-state read/write sites below (REBEL-1C8 class).
const _rawSettingsStore = withSingleSyncRetryOnEmfile(() => new Store<AppSettings>(settingsStoreOptions));

export const CURRENT_CODEX_REPAIR_SCHEMA_VERSION = 2;
export const CURRENT_MODELS_NAMESPACE_SCHEMA_VERSION = 2;
export const CURRENT_OR_PROVIDER_HEAL_VERSION = 1;
export const CURRENT_CODEX_PROVIDER_HEAL_VERSION = 1;
export const CURRENT_OR_PROFILE_SOURCE_MIGRATION_VERSION = 1;
export const CURRENT_BTS_AUTO_PROFILE_REROUTE_VERSION = 1;

type ModelsNamespaceMigrationResult = {
  changes: Partial<AppSettings>;
  migrated: boolean;
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function readCurrentModelsNamespaceVersion(settings: AppSettings): number {
  if (typeof settings.modelsNamespaceSchemaVersion === 'number') {
    return settings.modelsNamespaceSchemaVersion;
  }
  return 0;
}

// electron-store's `conf` constructor SHALLOW-injects `DEFAULT_SETTINGS.models`
// into any persisted file that lacks a top-level `models` key (verified:
// node_modules/conf/dist/source/index.js #initializeStore → Object.assign({}, defaults, fileStore)),
// then writes it back. For a pre-v2 (claude-namespace) install that has never
// materialized `models`, that injected block is NOT real user data — it is the
// default. Any pre-materialization bootstrap reader (codex repair, OR heal, the
// namespace migration itself) MUST treat such an injected block as ABSENT, else
// it resolves model state from the `claude-*` default instead of the user's real
// legacy `claude` namespace (false codex-repair clobber; malformed-claude that
// fails to degrade because the injected default looks "usable").
//
// Detection: pre-v2 (`modelsNamespaceSchemaVersion` 0) AND `models` deep-equals
// `DEFAULT_SETTINGS.models` AND a legacy `claude` is present (object OR a
// malformed non-undefined value). A real post-C2b install ships `models` (not a
// bare `claude`) and carries a non-zero schema version, so `models==defaults &&
// claude-present` reliably means "electron-store injected the default over a
// legacy file" — not real user data. The "claude present incl. malformed"
// extension closes the malformed-claude degrade gap. Accepted edge: a pre-v2
// file whose REAL `models` coincidentally deep-equals defaults alongside a
// divergent `claude` favors the legacy `claude` — consistent with the original
// guard's bias toward legacy data.
const shouldIgnoreDefaultInjectedModelsForLegacyMaterialization = (settings: AppSettings): boolean => {
  if (readCurrentModelsNamespaceVersion(settings) > 0) return false;
  // eslint-disable-next-line no-restricted-properties -- migration guard inspects raw legacy/default-injected namespaces before materialization.
  const legacyClaude = settings.claude as unknown;
  // eslint-disable-next-line no-restricted-properties -- migration guard inspects raw default-injected models before materialization.
  const models = settings.models as unknown;
  const legacyClaudePresent = legacyClaude !== undefined;
  return legacyClaudePresent &&
    isObjectRecord(models) &&
    deepEqual(models, DEFAULT_SETTINGS.models);
};

// Returns the settings with a default-injected `models` block stripped (treated
// as absent) for pre-materialization bootstrap readers. Centralised here so every
// reader that runs BEFORE the namespace migration materializes `models` resolves
// from the real legacy `claude`, not electron-store's injected default. Other
// fields are preserved by reference; only `models` is cleared when the guard fires.
const withDefaultInjectedModelsStripped = (settings: AppSettings): AppSettings =>
  shouldIgnoreDefaultInjectedModelsForLegacyMaterialization(settings)
    // `models` is required on AppSettings, but stripping the default-injected block
    // to `undefined` is the whole point: downstream readers (materializeModelsFromLegacy,
    // repairCodexProfileState) tolerate an absent `models` at runtime and resolve from
    // the legacy `claude`. The cast keeps the public type honest for callers.
    ? ({ ...settings, models: undefined } as unknown as AppSettings)
    : settings;

const materializeModelsForLegacyBootstrap = (settings: AppSettings): ReturnType<typeof materializeModelsFromLegacy> =>
  materializeModelsFromLegacy(withDefaultInjectedModelsStripped(settings));

export function migrateClaudeToModelsNamespace(
  settings: AppSettings,
): ModelsNamespaceMigrationResult {
  if (readCurrentModelsNamespaceVersion(settings) >= CURRENT_MODELS_NAMESPACE_SCHEMA_VERSION) {
    return { changes: {}, migrated: false };
  }

  // eslint-disable-next-line no-restricted-properties -- this migration audits the raw legacy namespace shape before accessor-based resolution.
  const claudeBlock = settings.claude as unknown;
  // eslint-disable-next-line no-restricted-properties -- this migration audits the raw persisted models namespace shape before stamping schema version.
  const currentModels = settings.models as unknown;
  const reportMalformedNamespace = (reason: string, captureError: Error): void => {
    const reporter = getErrorReporter();
    log.error(
      {
        migration: 'models-namespace',
        claudeShape: claudeBlock === null ? 'null' : typeof claudeBlock,
        claudeIsArray: Array.isArray(claudeBlock),
        modelsShape: currentModels === null ? 'null' : typeof currentModels,
        modelsIsArray: Array.isArray(currentModels),
        reason,
      },
      '[settings] models namespace migration detected malformed settings shape',
    );
    reporter.captureException(captureError, {
      tags: { migration: 'models-namespace' },
      extra: {
        reason,
        claudeShape: claudeBlock === null ? 'null' : typeof claudeBlock,
        claudeIsArray: Array.isArray(claudeBlock),
        modelsShape: currentModels === null ? 'null' : typeof currentModels,
        modelsIsArray: Array.isArray(currentModels),
      },
    });
  };

  // When the persisted `models` is the electron-store default-injection over a
  // legacy `claude` file (not real user data), the guard treats it as absent. On a
  // degrade we must also CLEAR the persisted injected default (`models: undefined`),
  // otherwise the bootstrap write would leave the `claude-*` default behind on a
  // file that has no real usable model data — exactly what the degrade path means
  // to avoid. A genuinely-malformed file with no injected default carries no
  // `models` to clear, so this is a no-op there.
  const stripDefaultInjectedModels =
    shouldIgnoreDefaultInjectedModelsForLegacyMaterialization(settings);

  const degraded = (reason: string, captureError: Error): ModelsNamespaceMigrationResult => {
    reportMalformedNamespace(reason, captureError);
    return {
      changes: {
        ...(stripDefaultInjectedModels ? { models: undefined } : {}),
        settingsMigrationDegraded: {
          reason,
          timestamp: Date.now(),
        },
      },
      migrated: false,
    };
  };

  const malformedClaude =
    claudeBlock !== undefined && !isObjectRecord(claudeBlock);
  const malformedModels =
    currentModels !== undefined && !isObjectRecord(currentModels);
  const usableClaude = isObjectRecord(claudeBlock)
    ? (claudeBlock as unknown as AppSettings['claude'])
    : undefined;
  const usableModels = isObjectRecord(currentModels)
    ? (currentModels as unknown as AppSettings['models'])
    : undefined;
  const effectiveUsableModels = stripDefaultInjectedModels ? undefined : usableModels;

  if (malformedClaude && effectiveUsableModels === undefined) {
    return degraded(
      'malformed-claude-block',
      new Error('Malformed claude namespace block during models migration'),
    );
  }

  if (malformedModels && usableClaude === undefined) {
    return degraded(
      'malformed-models-block',
      new Error('Malformed models namespace block during models migration'),
    );
  }

  const recoveredMalformedReason = malformedModels
    ? 'malformed-models-block'
    : malformedClaude
      ? 'malformed-claude-block'
      : null;
  if (recoveredMalformedReason) {
    reportMalformedNamespace(
      recoveredMalformedReason,
      new Error(
        recoveredMalformedReason === 'malformed-models-block'
          ? 'Malformed models namespace block during models migration; recovered from claude namespace'
          : 'Malformed claude namespace block during models migration; recovered from models namespace',
      ),
    );
  }

  if (effectiveUsableModels !== undefined || usableClaude !== undefined) {
    const migratedModels = materializeModelsFromLegacy({
      models: effectiveUsableModels,
      claude: usableClaude,
    });
    const changes: Partial<AppSettings> = {
      models: migratedModels as AppSettings['models'],
      modelsNamespaceSchemaVersion: CURRENT_MODELS_NAMESPACE_SCHEMA_VERSION,
      settingsMigrationDegraded: recoveredMalformedReason
        ? {
            reason: recoveredMalformedReason,
            timestamp: Date.now(),
          }
        : undefined,
    };

    return {
      changes,
      migrated: true,
    };
  }

  return {
    changes: {
      modelsNamespaceSchemaVersion: CURRENT_MODELS_NAMESPACE_SCHEMA_VERSION,
      settingsMigrationDegraded: undefined,
    },
    migrated: false,
  };
}

export function readCurrentCodexRepairVersion(settings: AppSettings): number {
  if (typeof settings.codexRepairSchemaVersion === 'number') {
    return settings.codexRepairSchemaVersion;
  }
  if (settings.codexStaleClaudeRepaired === true) {
    return 1;
  }
  return 0;
}

export function applyCodexRepairMigration(
  settings: AppSettings,
  logger: Logger = log,
): { migrated: AppSettings; result: CodexRepairResult | null } {
  const currentVersion = readCurrentCodexRepairVersion(settings);
  if (currentVersion >= CURRENT_CODEX_REPAIR_SCHEMA_VERSION) {
    return { migrated: settings, result: null };
  }

  let migrated = settings;
  let result: CodexRepairResult | null = null;
  if (settings.activeProvider === 'codex') {
    // `bootstrapCodexRepairMigration` runs FIRST in bootstrap — BEFORE the
    // namespace migration materializes `models`. `repairCodexProfileState` (and
    // its helpers `needsModelRepair`/`needsWorkingProfileRepair`) call
    // `materializeModelsFromLegacy`, which prefers `models.model`. On an upgrading
    // claude-only Codex install, electron-store has injected the `claude-*`
    // DEFAULT_SETTINGS.models; reading it raw makes a Codex install look like it
    // carries a Claude model → a FALSE repair fires and clobbers the user's real
    // Codex model/working-profile. Strip the default-injected `models` here so the
    // repair resolves from the real legacy `claude`. (Done in core, which owns
    // DEFAULT_SETTINGS + the guard; not pushed down into shared `codexDefaults.ts`.)
    const repairInput = withDefaultInjectedModelsStripped(settings);
    const { changes, result: repairResult } = repairCodexProfileState(repairInput);
    if (Object.keys(changes).length > 0) {
      migrated = { ...settings, ...changes };
      // The repair clears stale Codex thinking fields by writing `undefined` into `models`,
      // which JSON-drops on persist. Clear the legacy `claude` mirror for the same fields too,
      // so the models-namespace per-field merge (260604 cutover, materialize-on-version-bump)
      // can't resurrect the stale value from `claude`. Without this the repaired `models`
      // re-acquires a stale Claude thinking model on the next migration pass.
      const changedModels = changes.models;
      const clearedThinkingModel =
        !!changedModels && 'thinkingModel' in changedModels && changedModels.thinkingModel === undefined;
      const clearedThinkingProfileId =
        !!changedModels && 'thinkingProfileId' in changedModels && changedModels.thinkingProfileId === undefined;
      // eslint-disable-next-line no-restricted-properties -- migration reads the raw legacy mirror to clear it in lockstep with the models clear
      const legacyClaude = settings.claude as unknown;
      if (
        (clearedThinkingModel || clearedThinkingProfileId) &&
        isObjectRecord(legacyClaude) &&
        ((clearedThinkingModel && legacyClaude.thinkingModel !== undefined) ||
          (clearedThinkingProfileId && legacyClaude.thinkingProfileId !== undefined))
      ) {
        migrated = {
          ...migrated,
          // Clear the legacy claude mirror so the models-namespace merge can't resurrect a cleared field.
          // (no eslint-disable needed: no-restricted-properties fires on member access, not object-literal keys.)
          claude: ({
            ...(legacyClaude as unknown as AppSettings['claude']),
            ...(clearedThinkingModel ? { thinkingModel: undefined } : {}),
            ...(clearedThinkingProfileId ? { thinkingProfileId: undefined } : {}),
          } as NonNullable<AppSettings['claude']>),
        };
      }
      result = repairResult;
      logger.info(
        { before: result.before, after: result.after },
        'ChatGPT Pro provider state repaired (v2)'
      );
    }
  }

  migrated = {
    ...migrated,
    codexRepairSchemaVersion: CURRENT_CODEX_REPAIR_SCHEMA_VERSION,
    codexProviderRepairedAt: result?.repaired ? Date.now() : settings.codexProviderRepairedAt,
  };

  return { migrated, result };
}

const bootstrapCodexRepairMigration = (): void => {
  // EMFILE resilience (Stage 1.5, REBEL-1C8 crash site): the conf library's
  // `.store` getter and setter both go through synchronous fs calls that
  // graceful-fs cannot patch. Single-attempt retry covers transient EMFILE
  // when the FD pool drains between attempts.
  const loaded = withSingleSyncRetryOnEmfile(() => _rawSettingsStore.store);
  const { migrated } = applyCodexRepairMigration(loaded, log);
  if (!deepEqual(loaded, migrated)) {
    if (isUserDataReadOnly()) {
      console.warn('[version-gate] Blocked Codex repair migration write on settingsStore — read-only mode');
      return;
    }
    withSingleSyncRetryOnEmfile(() => {
      _rawSettingsStore.store = migrated;
    });
  }
};

// ─── OpenRouter provider-state heal (one-shot) ──────────────────────
//
// Repairs the broken settings shape that earlier versions of
// `setupOpenRouterToken` could leave behind on a fresh install:
//   { activeProvider: 'anthropic', models.apiKey: null, openRouter.oauthToken: <set> }
//
// The OAuth handler defaulted undefined `activeProvider` to 'anthropic' and
// relied on the renderer's auto-select effect to switch to 'openrouter' after
// the broadcast. If the user navigated away during OAuth (or the renderer
// component unmounted), the broken state persisted permanently. This migration
// detects that exact shape and applies the OR model defaults that the renderer
// would have applied. Versioned so it runs once per user. Idempotent.

export function readCurrentOpenRouterProviderHealVersion(settings: AppSettings): number {
  return typeof settings.openRouterProviderHealVersion === 'number'
    ? settings.openRouterProviderHealVersion
    : 0;
}

export function readCurrentOpenRouterProfileSourceMigrationVersion(settings: AppSettings): number {
  return typeof settings.openRouterProfileSourceMigrationVersion === 'number'
    ? settings.openRouterProfileSourceMigrationVersion
    : 0;
}

export function applyOpenRouterProviderHeal(
  settings: AppSettings,
  logger: Logger = log,
): { migrated: AppSettings; healed: boolean } {
  if (readCurrentOpenRouterProviderHealVersion(settings) >= CURRENT_OR_PROVIDER_HEAL_VERSION) {
    return { migrated: settings, healed: false };
  }

  const hasAnthropicKey = !!normalizeApiKey(materializeModelsForLegacyBootstrap(settings).apiKey);
  const hasOrToken = !!settings.openRouter?.oauthToken;
  const shouldHeal =
    settings.activeProvider === 'anthropic' && !hasAnthropicKey && hasOrToken;

  let migrated = settings;
  if (shouldHeal) {
    const orDefaults = applyOpenRouterModelDefaults(settings);
    migrated = {
      ...settings,
      ...orDefaults,
      openRouter: {
        ...DEFAULT_OPENROUTER_SETTINGS,
        ...settings.openRouter,
        enabled: true,
      },
    };
    logger.info(
      { previousProvider: 'anthropic', healedTo: 'openrouter' },
      'OpenRouter provider state healed: activeProvider=anthropic + no Anthropic key + OR token present',
    );
  }

  migrated = {
    ...migrated,
    openRouterProviderHealVersion: CURRENT_OR_PROVIDER_HEAL_VERSION,
  };

  return { migrated, healed: shouldHeal };
}

export function applyOpenRouterProfileSourceMigration(
  settings: AppSettings,
  logger: Logger = log,
): { migrated: AppSettings; stamped: number } {
  if (
    readCurrentOpenRouterProfileSourceMigrationVersion(settings)
    >= CURRENT_OR_PROFILE_SOURCE_MIGRATION_VERSION
  ) {
    return { migrated: settings, stamped: 0 };
  }

  const isBlank = (value: string | null | undefined): boolean =>
    value === null || value === undefined || value.trim() === '';

  const isLegacyOrProfile = (profile: ModelProfile | null | undefined): profile is ModelProfile => {
    if (profile === null || profile === undefined) return false;
    if (typeof profile !== 'object') return false;
    return (
      profile.providerType === 'openrouter'
      && (profile.profileSource === undefined || profile.profileSource === null)
      && !normalizeApiKey(profile.apiKey ?? undefined)
      && isBlank(profile.customProviderId)
    );
  };

  const profiles = Array.isArray(settings.localModel?.profiles)
    ? settings.localModel.profiles
    : [];
  const eligibleProfiles = profiles.filter(isLegacyOrProfile);
  const hasOauthToken = !!normalizeApiKey(settings.openRouter?.oauthToken);
  const hasProviderKey = !!normalizeApiKey(settings.providerKeys?.openrouter);
  const shouldStamp = hasOauthToken && !hasProviderKey && eligibleProfiles.length > 0;
  const shouldStampVersion = shouldStamp || eligibleProfiles.length === 0;

  if (eligibleProfiles.length > 0 && !shouldStamp) {
    logger.debug(
      {
        migration: 'or-profile-source-backfill',
        eligibleCount: eligibleProfiles.length,
        reason: !hasOauthToken ? 'no-oauth-token' : 'byok-precedence',
      },
      'OR profileSource migration deferred',
    );
  }

  let migrated = settings;
  let stampedCount = 0;

  if (shouldStamp) {
    const nextProfiles = profiles.map((profile) => {
      if (!isLegacyOrProfile(profile)) return profile;
      stampedCount += 1;
      return {
        ...profile,
        profileSource: 'connection' as const,
      };
    });
    const totalOrProfiles = profiles.filter((profile) => profile?.providerType === 'openrouter').length;
    const localModel = settings.localModel ?? { activeProfileId: null, profiles: [] };

    migrated = {
      ...settings,
      localModel: {
        ...localModel,
        profiles: nextProfiles,
      },
    };

    logger.info(
      {
        migration: 'or-profile-source-backfill',
        stampedCount,
        totalOrProfiles,
      },
      'OR legacy profileSource stamped to connection',
    );
  }

  if (shouldStampVersion) {
    migrated = {
      ...migrated,
      openRouterProfileSourceMigrationVersion: CURRENT_OR_PROFILE_SOURCE_MIGRATION_VERSION,
    };
  }

  return { migrated, stamped: stampedCount };
}

const bootstrapOpenRouterProviderHeal = (): void => {
  const loaded = withSingleSyncRetryOnEmfile(() => _rawSettingsStore.store);
  const { migrated } = applyOpenRouterProviderHeal(loaded, log);
  if (!deepEqual(loaded, migrated)) {
    if (isUserDataReadOnly()) {
      console.warn('[version-gate] Blocked OR provider heal migration write on settingsStore — read-only mode');
      return;
    }
    withSingleSyncRetryOnEmfile(() => {
      _rawSettingsStore.store = migrated;
    });
  }
};

// ─── Codex (ChatGPT Pro) provider-state heal ───────────────────────
//
// FOX-3494: a ChatGPT-Pro user's `activeProvider` can drift off `'codex'`
// (e.g. to `'anthropic'`, or to `undefined` via the AgentsTab disconnect
// fallback) while valid Codex tokens remain. Settings shows "connected"
// (it reads token presence), but every turn gates on `activeProvider` via
// `validateProviderCredentials` and dead-ends on a provider the user has no
// credential for. Reconnecting ChatGPT only refreshes the token — it never
// restores `activeProvider: 'codex'` — so the user is permanently stranded.
//
// This is the codex twin of `applyOpenRouterProviderHeal`: heal
// `activeProvider → 'codex'` ONLY when the current state is genuinely
// unusable (no usable credential for the current provider) and Codex IS
// connected. A deliberate, working choice (e.g. Anthropic WITH a key) is
// never clobbered.
//
// Deliberate product choice (C-F3, FOX-3494): this WILL heal
// `activeProvider:'anthropic' + no key + codex connected` → codex. That is
// correct for this incident (a no-key Anthropic selection is unusable), but
// it does mean a mid-setup Anthropic user who hasn't yet added their key is
// pulled to codex. See docs/plans/260616_chatgpt-reconnect-auth-bug/PLAN.md.
//
// Relationship to `applyCodexRepairMigration` (~330 above): that migration is
// gated on `activeProvider === 'codex'` ALREADY and repairs the model PROFILE
// (a stale claude-* model under codex). It is orthogonal — this heal repairs the
// PROVIDER SELECTION (drifted off codex). A boot-healed user's profile is not
// re-run through the (version-stamped, one-shot) repair this boot; that residual
// is acceptable because Stage 2's route-time terminal already handles a stale
// claude-* model under codex with an actionable "switch to GPT" recovery.
//
// C-F2: `hasUsableCredentialFor` matches the RUNTIME credential seams, not
// just persisted settings fields — anthropic/openrouter via
// `validateProviderCredentials` (the exact admission gate, incl. env/profile
// Anthropic keys), and mindstone via the injected managed-key probe (the
// admission `hasManagedOpenRouterKey()` seam). The boot trigger is wired as a
// POST-bootstrap startup step (not an import-time migration like the OR heal)
// because `hasCodexTokens()` needs `createStore()`/secure-token wiring that
// isn't ready at module import.

export interface CodexProviderHealDeps {
  /** Whether valid Codex tokens are present (admission's `codexConnectedAtTurnStart` seam). */
  codexConnected: boolean;
  /**
   * Whether a managed (Mindstone subscription) OpenRouter key is available —
   * the runtime seam admission uses (`hasManagedOpenRouterKey()` /
   * `getManagedKeyAvailability()`). Injected so this helper stays pure.
   */
  hasManagedKey: boolean;
  logger?: Logger;
  /**
   * Defer the `provider_heal_applied` log/telemetry to the caller (so it can emit
   * AFTER a successful persist). When true, `applyCodexProviderHeal` performs the
   * pure transform but emits nothing; the caller must call `emitProviderHealApplied`
   * once persistence succeeds. Used by the boot path, which may be read-only and
   * must not over-report a heal it couldn't persist (F4/S1).
   */
  deferTelemetry?: boolean;
}

/**
 * Emit the observable record of a successful Codex provider heal. Split out from
 * `applyCodexProviderHeal` so callers that may not persist (read-only boot) can
 * defer it until after a durable write (F4/S1). Silent recovery must be
 * observable (project rule): structured log + telemetry.
 */
export function emitProviderHealApplied(
  from: ActiveProvider | undefined | null,
  logger: Logger = log,
): void {
  logger.info(
    { marker: 'provider_heal_applied', from, to: 'codex' },
    'Codex provider state healed: codex connected + current provider unusable → activeProvider=codex',
  );
  try {
    getTracker().track('provider_heal_applied', {
      from: from ?? 'unset',
      to: 'codex',
      heal: 'codex',
    });
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'applyCodexProviderHeal.track',
      reason: 'tracker-unavailable',
    });
  }
}

export function readCurrentCodexProviderHealVersion(settings: AppSettings): number {
  return typeof settings.codexProviderHealVersion === 'number'
    ? settings.codexProviderHealVersion
    : 0;
}

/**
 * Is the current `activeProvider` usable — i.e. does a turn admitted under it
 * have a credential? Mirrors the admission gate so the heal only fires on
 * genuinely-stranded states. `undefined`/`null` are treated as unusable (the
 * likely actual user state via the AgentsTab disconnect fallback).
 */
function hasUsableCredentialFor(
  provider: ActiveProvider | undefined | null,
  settings: AppSettings,
  deps: CodexProviderHealDeps,
): boolean {
  switch (provider) {
    case 'codex':
      // Already codex — usable iff connected (heal is a no-op here anyway).
      return deps.codexConnected;
    case 'mindstone':
      // Mindstone is always `status: 'valid'` in validateProviderCredentials;
      // its real fail-closed check is the managed-key storage probe (the
      // injected runtime seam, matching turnAdmission's hasManagedOpenRouterKey).
      return deps.hasManagedKey;
    case 'anthropic':
    case 'openrouter': {
      // Reuse the exact admission gate so the anthropic arm sees env/profile
      // keys too, not just persisted settings fields (C-F2). codexConnected is
      // irrelevant to these arms (only consulted in the codex arm).
      const state = validateProviderCredentials(settings, deps.codexConnected);
      return state.status !== 'missing' && state.status !== 'disconnected';
    }
    case undefined:
    case null:
      // Drifted/cleared selection (AgentsTab disconnect fallback writes
      // `undefined`). Two sub-cases:
      //  1. Legacy-OpenRouter shape (predates `activeProvider`): the normalizer
      //     derives `activeProvider: 'openrouter'` from `openRouter.enabled +
      //     openRouter.oauthToken` (settingsUtils.ts ~1301). The boot heal runs
      //     BEFORE `ensureNormalizedSettings`, so we must recognize this shape
      //     here or a legacy-OR user with codex tokens gets clobbered to codex
      //     (F1). Treat it as USABLE — no heal. Keep this in lockstep with the
      //     normalizer's legacy-OR derivation.
      //  2. Otherwise it resolves to the anthropic default arm at admission, so
      //     mirror that: unusable unless that default arm finds a credential.
      if (settings.openRouter?.enabled && settings.openRouter?.oauthToken) {
        return true;
      }
      return (
        validateProviderCredentials(settings, deps.codexConnected).status !== 'missing'
      );
    default: {
      const _exhaustive: never = provider;
      void _exhaustive;
      // Unknown future provider — be conservative and treat as usable (never
      // yank a user off a provider we don't understand).
      return true;
    }
  }
}

/**
 * Pure transformation: heal `activeProvider → 'codex'` when codex is connected
 * but the current provider selection is unusable. Returns the (possibly)
 * mutated settings and whether a heal was applied. NOT version-gated — callers
 * that need one-shot semantics (boot) wrap this; the reconnect/cloud triggers
 * call it directly every time (the event itself is the gate).
 */
export function applyCodexProviderHeal(
  settings: AppSettings,
  deps: CodexProviderHealDeps,
): { migrated: AppSettings; healed: boolean; from: ActiveProvider | undefined | null } {
  const logger = deps.logger ?? log;
  const from = settings.activeProvider ?? null;

  const shouldHeal =
    deps.codexConnected &&
    settings.activeProvider !== 'codex' &&
    !hasUsableCredentialFor(settings.activeProvider, settings, deps);

  if (!shouldHeal) {
    return { migrated: settings, healed: false, from };
  }

  const migrated: AppSettings = {
    ...settings,
    activeProvider: 'codex',
  };

  // Persisting callers (reconnect/cloud) emit inline; the boot path defers until
  // after a successful write so a read-only boot doesn't over-report (F4/S1).
  if (!deps.deferTelemetry) {
    emitProviderHealApplied(from, logger);
  }

  return { migrated, healed: true, from };
}

// NOTE: the one-shot boot heal `runCodexProviderHealAtBoot` lives further down,
// after `getSettings`/`updateSettings` are defined (it consumes those runtime
// store accessors, unlike the raw-store bootstrap migrations below).

const bootstrapModelsNamespaceMigration = (): void => {
  try {
    const loaded = withSingleSyncRetryOnEmfile(() => _rawSettingsStore.store);
    const namespaceMigration = migrateClaudeToModelsNamespace(loaded);
    const routeSurfaceMigration = migrateProfileRouteSurfaces(loaded);

    const changes: Partial<AppSettings> = { ...namespaceMigration.changes };
    if (routeSurfaceMigration.changed && loaded.localModel) {
      changes.localModel = {
        ...loaded.localModel,
        profiles: routeSurfaceMigration.profiles,
      };
    }

    if (Object.keys(changes).length === 0) {
      return;
    }
    if (isUserDataReadOnly()) {
      console.warn('[version-gate] Blocked models namespace migration write on settingsStore — read-only mode');
      return;
    }

    withSingleSyncRetryOnEmfile(() => {
      _rawSettingsStore.store = { ...loaded, ...changes };
    });

    if (namespaceMigration.migrated) {
      log.info(
        { migration: 'models-namespace' },
        '[one-shot] Migrated settings namespace from claude.* to models.*',
      );
    }
  } catch (error) {
    const reporter = getErrorReporter();
    log.error(
      {
        migration: 'models-namespace',
        err: error,
      },
      '[settings] models namespace migration failed; continuing with existing settings',
    );
    reporter.captureException(error, {
      tags: { migration: 'models-namespace' },
      extra: {
        reason: 'unexpected-throw',
      },
    });

    try {
      withSingleSyncRetryOnEmfile(() => {
        _rawSettingsStore.store = {
          ..._rawSettingsStore.store,
          settingsMigrationDegraded: {
            reason: 'unexpected-throw',
            timestamp: Date.now(),
          },
        };
      });
    } catch {
      // Best-effort only. Storage may itself be degraded.
    }
  }
};

export const bootstrapOpenRouterProfileSourceMigration = (): void => {
  try {
    const loaded = withSingleSyncRetryOnEmfile(() => _rawSettingsStore.store);
    const { migrated } = applyOpenRouterProfileSourceMigration(loaded, log);
    if (!deepEqual(loaded, migrated)) {
      if (isUserDataReadOnly()) {
        console.warn('[version-gate] Blocked OR profileSource migration write on settingsStore — read-only mode');
        return;
      }
      withSingleSyncRetryOnEmfile(() => {
        _rawSettingsStore.store = migrated;
      });
    }
  } catch (err) {
    log.error(
      { err, migration: 'or-profile-source-backfill' },
      'OR profileSource migration failed unexpectedly',
    );
    try {
      getErrorReporter().captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { migration: 'or-profile-source-backfill' },
        extra: { reason: 'unexpected-throw' },
      });
    } catch {
      // Telemetry best-effort.
    }
  }
};

// ─── BTS auto-profile reroute migration (one-shot) ──────────────────
//
// Heals legacy state where resolver target fields (`behindTheScenesModel`,
// `behindTheScenesOverrides[*]`, `models.workingProfileId`, and
// `models.thinkingProfileId`) point at an auto-managed Codex profile id.
// Auto profiles are uneditable plumbing — if a stale `jsonCompatibility:
// 'incompatible'` flag is on them (from a prior run before the A0 marker
// guard landed), every BTS structured-output call silently swaps to Claude
// with no recovery path (260521 BTS Haiku-fallback investigation).
//
// Strict eligibility predicate (DA finding "leave settings untouched"):
//   - The auto profile must have a connection-managed sibling sharing the
//     canonical `(providerType, routeSurface, normalisedModel)` key.
//   - Sibling must be `enabled !== false`, NOT carry
//     `jsonCompatibility: 'incompatible'`, and pass `isProfileSelectable`.
//   - Otherwise the reference is left untouched.
//
// Idempotent (gated on schemaVersion). Stamped even when no rewrites apply
// so the migration runs at most once per major bump.
const RESOLVER_TARGETS_DESC = ['behindTheScenesModel', 'workingProfileId', 'thinkingProfileId'] as const;

function readCurrentBtsAutoProfileRerouteVersion(settings: AppSettings): number {
  return settings.btsAutoProfileRerouteSchemaVersion ?? 0;
}

type ResolverFieldRewrite =
  | { next: string | undefined; rewrote: false }
  | { next: string; rewrote: true; rewrittenFromId: string; rewrittenToId: string };

function rewriteResolverTargetField(
  current: string | undefined | null,
  profilesById: Map<string, ModelProfile>,
  allProfiles: readonly ModelProfile[],
): ResolverFieldRewrite {
  if (!current || typeof current !== 'string') return { next: current ?? undefined, rewrote: false };
  if (!isProfileReference(current)) return { next: current, rewrote: false };
  const id = current.slice(PROFILE_PREFIX.length).trim();
  if (!id) return { next: current, rewrote: false };
  const profile = profilesById.get(id);
  if (!profile) return { next: current, rewrote: false };
  if (!isCodexAutoProfile(profile)) return { next: current, rewrote: false };
  const sibling = findShadowingConnectionManagedSibling(profile, allProfiles);
  if (!sibling) return { next: current, rewrote: false };
  return {
    next: `${PROFILE_PREFIX}${sibling.id}`,
    rewrote: true,
    rewrittenFromId: id,
    rewrittenToId: sibling.id,
  };
}

export function applyBtsAutoProfileRerouteMigration(
  settings: AppSettings,
  logger: Logger = log,
): { migrated: AppSettings; rewrites: number } {
  if (
    readCurrentBtsAutoProfileRerouteVersion(settings)
    >= CURRENT_BTS_AUTO_PROFILE_REROUTE_VERSION
  ) {
    return { migrated: settings, rewrites: 0 };
  }

  const profiles = Array.isArray(settings.localModel?.profiles)
    ? settings.localModel.profiles
    : [];
  const profilesById = new Map(profiles.map((p) => [p.id, p]));

  let rewrites = 0;
  const rewritesLog: Array<{ field: string; from: string; to: string }> = [];

  // eslint-disable-next-line bts-flow-shape/no-raw-bts-model-read -- migration owns the storage shape: it is rewriting the raw fields, not consuming them through the codec.
  let nextBts: string | undefined = settings.behindTheScenesModel;
  {
    // eslint-disable-next-line bts-flow-shape/no-raw-bts-model-read -- migration owns the storage shape: it is rewriting the raw field, not consuming via the codec.
    const r = rewriteResolverTargetField(settings.behindTheScenesModel, profilesById, profiles);
    if (r.rewrote) {
      nextBts = r.next;
      rewrites += 1;
      rewritesLog.push({ field: 'behindTheScenesModel', from: r.rewrittenFromId, to: r.rewrittenToId });
    }
  }

  // eslint-disable-next-line bts-flow-shape/no-raw-bts-model-read -- migration owns the storage shape: it is rewriting the raw map, not consuming through the codec.
  let nextOverrides = settings.behindTheScenesOverrides;
  if (nextOverrides && typeof nextOverrides === 'object') {
    const draft: Record<string, string> = { ...nextOverrides };
    let changed = false;
    for (const key of Object.keys(draft)) {
      const r = rewriteResolverTargetField(draft[key], profilesById, profiles);
      if (r.rewrote) {
        draft[key] = r.next;
        rewrites += 1;
        rewritesLog.push({ field: `behindTheScenesOverrides.${key}`, from: r.rewrittenFromId, to: r.rewrittenToId });
        changed = true;
      }
    }
    if (changed) nextOverrides = draft as typeof nextOverrides;
  }

  // models.workingProfileId / models.thinkingProfileId are unwrapped ids
  // (no `profile:` prefix). Wrap, rewrite via the same helper, unwrap.
  const wrapId = (raw: string | undefined): string | undefined =>
    raw ? `${PROFILE_PREFIX}${raw}` : undefined;
  const unwrapId = (encoded: string | undefined): string | undefined =>
    encoded?.startsWith(PROFILE_PREFIX) ? encoded.slice(PROFILE_PREFIX.length) : encoded;

  // eslint-disable-next-line no-restricted-properties -- migration owns the storage shape: it is rewriting the raw fields, not reading them for resolution.
  const nextModels = settings.models ? { ...settings.models } : settings.models;
  if (nextModels) {
    for (const key of ['workingProfileId', 'thinkingProfileId'] as const) {
      const r = rewriteResolverTargetField(wrapId(nextModels[key]), profilesById, profiles);
      if (r.rewrote) {
        nextModels[key] = unwrapId(r.next);
        rewrites += 1;
        rewritesLog.push({ field: `models.${key}`, from: r.rewrittenFromId, to: r.rewrittenToId });
      }
    }
  }

  // Heal stale capability flags on auto profiles (A4 first-boot guarantee).
  // mergeCodexProfiles only re-strips during repair / provider activation, so
  // users who already advanced past the codex-repair schema version and never
  // switched providers would otherwise carry persisted
  // `jsonCompatibility: 'incompatible'` (or chat/toolUse equivalents) forever.
  // The marker guards in behindTheScenesClient.ts (A0) prevent fresh writes;
  // this is the once-per-user heal for state created before those guards.
  let nextLocalModel = settings.localModel;
  let strippedAutoProfileFlags = 0;
  if (Array.isArray(nextLocalModel?.profiles)) {
    let mutated = false;
    const healedProfiles = nextLocalModel.profiles.map((profile) => {
      if (!isCodexAutoProfile(profile)) return profile;
      const stripped = stripAutoProfileCapabilityFlags(profile);
      if (stripped !== profile) {
        mutated = true;
        strippedAutoProfileFlags += 1;
      }
      return stripped;
    });
    if (mutated) {
      nextLocalModel = { ...nextLocalModel, profiles: healedProfiles };
    }
  }

  const migrated: AppSettings = {
    ...settings,
    behindTheScenesModel: nextBts,
    behindTheScenesOverrides: nextOverrides,
    models: nextModels,
    localModel: nextLocalModel,
    btsAutoProfileRerouteSchemaVersion: CURRENT_BTS_AUTO_PROFILE_REROUTE_VERSION,
  };

  if (rewrites > 0 || strippedAutoProfileFlags > 0) {
    logger.info(
      {
        migration: 'bts-auto-profile-reroute',
        rewrites,
        strippedAutoProfileFlags,
        details: rewritesLog,
      },
      `BTS auto-profile reroute rewrote ${rewrites} resolver target field(s) and stripped capability flags from ${strippedAutoProfileFlags} auto profile(s)`,
    );
  } else {
    logger.debug(
      { migration: 'bts-auto-profile-reroute', resolverTargetsChecked: RESOLVER_TARGETS_DESC.length },
      'BTS auto-profile reroute migration found nothing to rewrite (stamped version)',
    );
  }

  return { migrated, rewrites };
}

const bootstrapBtsAutoProfileRerouteMigration = (): void => {
  try {
    const loaded = withSingleSyncRetryOnEmfile(() => _rawSettingsStore.store);
    const { migrated } = applyBtsAutoProfileRerouteMigration(loaded, log);
    if (!deepEqual(loaded, migrated)) {
      if (isUserDataReadOnly()) {
        console.warn('[version-gate] Blocked BTS auto-profile reroute migration write on settingsStore — read-only mode');
        return;
      }
      withSingleSyncRetryOnEmfile(() => {
        _rawSettingsStore.store = migrated;
      });
    }
  } catch (err) {
    log.error(
      { err, migration: 'bts-auto-profile-reroute' },
      'BTS auto-profile reroute migration failed unexpectedly',
    );
    try {
      getErrorReporter().captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { migration: 'bts-auto-profile-reroute' },
        extra: { reason: 'unexpected-throw' },
      });
    } catch {
      // Telemetry best-effort.
    }
  }
};

// Wrap settingsStore with a write gate that blocks set/delete/clear/store=
// when global read-only mode is active (older app version detected).
// This store uses direct electron-store (see CRITICAL comment above), so it
// needs its own Proxy for the write gate.
//
// EMFILE mitigation (REBEL-1C8): The conf library's .store getter calls
// fs.readFileSync() on every access. With 738+ call sites (including hot
// paths like the renderer console-message handler), this exhausts Windows'
// file descriptor limit after prolonged runtime. The _settingsCache below
// eliminates disk reads on the hot path — reads come from memory, invalidated
// on every write.
const WRITE_METHODS = new Set(['set', 'delete', 'clear']);

let _settingsCache: AppSettings | null = null;
let _diagnosticsSnapshot: DiagnosticsSettings = DEFAULT_DIAGNOSTICS_SETTINGS;

const getSettingsStorePath = (): string | null => {
  const maybeStore = _rawSettingsStore as unknown as { path?: unknown };
  return typeof maybeStore.path === 'string' ? maybeStore.path : null;
};

export const hardenSettingsStoreFilePermissions = (): void => {
  if (process.platform === 'win32') return;
  const settingsPath = getSettingsStorePath();
  if (!settingsPath) return;
  try {
    if (!withSingleSyncRetryOnEmfile(() => fs.existsSync(settingsPath))) return;
    withSingleSyncRetryOnEmfile(() => fs.chmodSync(settingsPath, 0o600));
  } catch (error) {
    log.warn({ err: error }, 'Failed to harden app settings file permissions');
  }
};

const invalidateSettingsCache = (): void => {
  _settingsCache = null;
};

const getCachedSettings = (): AppSettings => {
  if (_settingsCache === null) {
    // EMFILE resilience (Stage 1.5, REBEL-1C8 crash site): the conf library's
    // `.store` getter calls `fs.readFileSync()` which graceful-fs cannot
    // patch. Single-attempt retry covers transient EMFILE; on double-EMFILE
    // the error propagates and the cache stays unset so the next caller
    // retries fresh.
    _settingsCache = Object.freeze(
      withSingleSyncRetryOnEmfile(() => _rawSettingsStore.store)
    ) as AppSettings;
  }
  return _settingsCache;
};

const refreshDiagnosticsSnapshot = (): void => {
  try {
    const cached = getCachedSettings();
    _diagnosticsSnapshot = cached.diagnostics ?? DEFAULT_DIAGNOSTICS_SETTINGS;
  } catch (error) {
    if (!isTooManyOpenFilesError(error)) throw error;
    tagFsExhaustion(error, 'diagnostics_snapshot_refresh');
    // Keep prior snapshot — fail-soft. _diagnosticsSnapshot is initialized to
    // DEFAULT_DIAGNOSTICS_SETTINGS, so cold-boot EMFILE still has a safe value.
  }
};

export function getDiagnosticsSnapshot(): DiagnosticsSettings {
  return _diagnosticsSnapshot;
}

// ─── Deferred bootstrap-migration runner (OSS boot-crash class fix) ──
//
// The five one-shot bootstrap migrations above used to run as module-scope
// calls at import time. In the OSS/packaged FORGE bundle this module's body can
// evaluate BEFORE src/main/bootstrap.ts calls setPlatformConfig(); the
// migrations' logging (createScopedLogger → first .info/.error → getRootLogger →
// ensureLogDirectory → getDataPath → getPlatformConfig) then throws
// "PlatformConfig not initialized" and the app dies before any window appears
// (the BUG #4 class — see docs-private/postmortems/260622_oss_toolindex_*). The
// store reads/writes themselves are import-safe (direct electron-store via
// Electron's app), so the fix is to DEFER the whole batch to first settings
// access, which is always after bootstrap.
//
// Lazy-on-first-read (rather than an explicit per-surface init call) preserves
// the "migrations run before the first settings read" guarantee on every surface
// (desktop / cloud / mobile) with zero per-surface wiring — avoiding the
// cross-surface-parity trap. It is triggered from the settingsStore Proxy .store
// get/set below (the universal EXTERNAL read funnel), NOT from getCachedSettings,
// which the import-time refreshDiagnosticsSnapshot() calls directly and must stay
// migration-free to keep this module import-safe. The migrations read
// `_rawSettingsStore` directly (bypassing the proxy) so they never re-enter here.
// (Defined here — after its migration/helper dependencies — so no use-before-define.)
let bootstrapMigrationsCompleted = false;

const ensureSettingsBootstrapMigrations = (): void => {
  if (bootstrapMigrationsCompleted) return;
  // Set the guard BEFORE running so any nested settings access during a
  // migration cannot re-enter this batch (belt-and-braces; the migrations use
  // _rawSettingsStore directly and so don't go through the triggering proxy).
  bootstrapMigrationsCompleted = true;
  bootstrapCodexRepairMigration();
  bootstrapOpenRouterProviderHeal();
  bootstrapModelsNamespaceMigration();
  bootstrapOpenRouterProfileSourceMigration();
  bootstrapBtsAutoProfileRerouteMigration();
  // The migrations write via `_rawSettingsStore.store =` (raw, bypassing the
  // proxy cache), so invalidate it; the triggering read below then recomputes
  // from the migrated store.
  invalidateSettingsCache();
  // Boot tasks formerly run at module scope, deferred here for import-safety:
  // refresh the diagnostics snapshot from the migrated store, then harden the
  // settings-file permissions. Both are individually fail-soft (internal
  // try/catch); they log via the scoped logger, so they must not run at import.
  try {
    refreshDiagnosticsSnapshot();
    hardenSettingsStoreFilePermissions();
  } catch {
    // Fail-soft boot initialization — DEFAULT_DIAGNOSTICS_SETTINGS stands.
  }
};

export const settingsStore: KeyValueStore<AppSettings> = new Proxy(_rawSettingsStore, {
  get(target, prop, _receiver) {
    // Intercept .store reads to return cached version (REBEL-1C8 EMFILE fix)
    if (prop === 'store') {
      // Run the deferred one-shot bootstrap migrations on first external read.
      // Import-safe — see ensureSettingsBootstrapMigrations above.
      ensureSettingsBootstrapMigrations();
      return getCachedSettings();
    }
    const value = Reflect.get(target, prop, target);
    if (typeof prop === 'string' && WRITE_METHODS.has(prop) && typeof value === 'function') {
      return (...args: unknown[]) => {
        if (isUserDataReadOnly()) {

          console.warn(`[version-gate] Blocked ${String(prop)}() on settingsStore — read-only mode`);
          return;
        }
        // Direct method writes (set/delete/clear) are also an external settings
        // funnel — ensure the deferred bootstrap migrations have run so a
        // first-touch method write merges onto migrated state, not the raw
        // pre-migration store (import-safe; see ensureSettingsBootstrapMigrations).
        ensureSettingsBootstrapMigrations();
        invalidateSettingsCache();
        const writeResult = (value as (...a: unknown[]) => unknown).apply(target, args);
        hardenSettingsStoreFilePermissions();
        refreshDiagnosticsSnapshot();
        return writeResult;
      };
    }
    return typeof value === 'function' ? (value as Function).bind(target) : value;
  },
  set(target, prop, value) {
    if (prop === 'store' && isUserDataReadOnly()) {
       
      console.warn('[version-gate] Blocked store= on settingsStore — read-only mode');
      return true;
    }
    // Invalidate BEFORE write so onDidAnyChange listeners see cache miss
    if (prop === 'store') {
      // Ensure deferred bootstrap migrations have run so a write merges onto
      // migrated state (import-safe; see ensureSettingsBootstrapMigrations).
      ensureSettingsBootstrapMigrations();
      invalidateSettingsCache();
      // EMFILE resilience (Stage 1.5, REBEL-1C8): belt-and-braces wrap of
      // the store= write path. electron-store's atomic-write goes through
      // callback-fs which graceful-fs covers, so this is unlikely to fire
      // in practice — but if conf surfaces a synchronous EMFILE here, the
      // single-attempt retry gives the FD pool one chance to drain.
      const writeResult = withSingleSyncRetryOnEmfile(() => Reflect.set(target, prop, value));
      hardenSettingsStoreFilePermissions();
      refreshDiagnosticsSnapshot();
      return writeResult;
    }
    return Reflect.set(target, prop, value);
  },
}) as KeyValueStore<AppSettings>;

// NOTE: the diagnostics-snapshot refresh + settings-file permission hardening
// that used to run here at module scope are now performed inside
// ensureSettingsBootstrapMigrations() (first settings access). Running them at
// import was the same import-time-side-effect anti-pattern as the migrations:
// hardenSettingsStoreFilePermissions() logs (via the scoped logger) on a chmod
// failure, which would read getPlatformConfig() before bootstrap initialised it.
// electron-store already creates the file with configFileMode 0o600, so deferred
// hardening is belt-and-braces; the diagnostics snapshot defaults to
// DEFAULT_DIAGNOSTICS_SETTINGS until the first settings read.

/**
 * Migrate onboardingCompletedAt → onboardingFirstCompletedAt.
 * This is a one-time migration that runs at startup BEFORE normalization.
 * Must run before normalize to avoid losing the old value.
 */
export const migrateOnboardingTimestampIfNeeded = (settings: AppSettings): AppSettings => {
  const settingsRecord = settings as unknown as Record<string, unknown>;
  const oldValue = settingsRecord.onboardingCompletedAt;
  const newValue = settingsRecord.onboardingFirstCompletedAt;

  // If old field doesn't exist, nothing to do
  if (oldValue === undefined) {
    return settings;
  }

  // Always drop the old field from the returned object
  const { onboardingCompletedAt: _dropped, ...rest } = settingsRecord;

  // If new field already has a real value (not null from defaults), keep it; just remove old field
  if (newValue !== undefined && newValue !== null) {
    return rest as unknown as AppSettings;
  }

  // Migrate: copy old value to new field (with type guard)
  return {
    ...rest,
    onboardingFirstCompletedAt: typeof oldValue === 'number' ? oldValue : null,
  } as unknown as AppSettings;
};

/**
 * Migrate old single-config localModel to new multi-profile format.
 * Converts {enabled, serverUrl, model, apiKey} → {profiles: [...], activeProfileId}
 */
export const migrateLocalModelProfilesIfNeeded = (settings: AppSettings): AppSettings => {
  const localModel = settings.localModel as Record<string, unknown> | undefined;

  // If no localModel or already migrated (has profiles array), nothing to do
  if (!localModel || Array.isArray(localModel.profiles)) {
    return settings;
  }

  // Check if this is old format (has serverUrl field)
  if (typeof localModel.serverUrl !== 'string' || localModel.serverUrl.trim().length === 0) {
    return settings;
  }

  // Generate a unique ID for the migrated profile
  const profileId = `migrated-${Date.now()}`;

  // Create profile from old settings
  const migratedProfile = {
    id: profileId,
    name: 'Migrated Profile',
    serverUrl: localModel.serverUrl,
    model: typeof localModel.model === 'string' ? localModel.model : undefined,
    apiKey: typeof localModel.apiKey === 'string' ? localModel.apiKey : undefined,
    createdAt: Date.now(),
  };

  // Determine if profile should be active
  const wasEnabled = localModel.enabled === true;

  return {
    ...settings,
    localModel: {
      profiles: [migratedProfile],
      activeProfileId: wasEnabled ? profileId : null,
    },
  };
};

/**
 * Migrate cloudInstance fields from Sprites naming to Fly Machine naming.
 * spriteUrl → cloudUrl, removes spriteId/spriteName/spritesApiToken/billingMode/cloudStorage*.
 */
export const migrateCloudInstanceFieldsIfNeeded = (settings: AppSettings): AppSettings => {
  const ci = (settings as unknown as Record<string, unknown>).cloudInstance as Record<string, unknown> | undefined;
  if (!ci) return settings;

  const spriteUrl = typeof ci.spriteUrl === 'string' ? ci.spriteUrl : undefined;

  // If already migrated (has cloudUrl) or no valid spriteUrl, nothing to do
  if (typeof ci.cloudUrl === 'string' || !spriteUrl) return settings;

  const { spriteUrl: _legacySpriteUrl, spriteId: _, spriteName: _s, spritesApiToken: _t, billingMode: _b,
    cloudStorageProvider: _p, cloudStoragePath: _pa, ...rest } = ci;
  const mode = ci.mode === 'local' || ci.mode === 'cloud' ? ci.mode : 'cloud';

  return {
    ...settings,
    cloudInstance: {
      ...(rest as Partial<AppSettings['cloudInstance']>),
      mode,
      // Never persist a local-mode config that still carries a live cloud URL —
      // that is the `mode:'local'` + live-URL drift state that strands the UI on
      // "Offline (queued)". In local mode the migrated URL is irrelevant, so drop
      // it; only carry it forward when the record is in cloud mode.
      cloudUrl: mode === 'local' ? undefined : spriteUrl,
    },
  };
};

/**
 * Backfill `cloudInstance.providerId` for legacy records that pre-date the
 * explicit field. The runtime already infers the provider from `provisionMode`
 * + `flyAppName` + `flyMachineId` (see `connectedProviderId` in CloudTab and
 * the IPC handler fallbacks), but six different code paths strict-check
 * `providerId === 'fly'` and silently fail when the field is undefined. Fixing
 * the data once at boot eliminates the whole class of bug.
 *
 * Inference is intentionally conservative — only stamp `providerId` when the
 * combination of fields makes the answer unambiguous:
 *
 *   - `provisionMode === 'byok'` + flyAppName + flyMachineId → 'fly'
 *     (BYOK + Fly Machine metadata can only come from the Fly provider; we
 *      never wrote those fields for any other BYOK provider.)
 *   - `provisionMode === 'managed'` + flyAppName + flyMachineId → 'mindstone'
 *     (Mindstone managed cloud is the only managed offering and runs on Fly.)
 *
 * Anything else (no cloudInstance, no flyApp/flyMachine, ambiguous shape) is
 * left untouched so we never fabricate state. Reports a Sentry breadcrumb so
 * we can size the legacy-data population.
 */
export const backfillCloudInstanceProviderIdIfNeeded = (
  settings: AppSettings,
  logger: Logger = log,
): AppSettings => {
  const ci = settings.cloudInstance;
  if (!ci) return settings;
  if (ci.providerId) return settings;
  if (!ci.flyAppName || !ci.flyMachineId) return settings;

  let inferredProviderId: 'fly' | 'mindstone' | null = null;
  if (ci.provisionMode === 'byok') {
    inferredProviderId = 'fly';
  } else if (ci.provisionMode === 'managed') {
    inferredProviderId = 'mindstone';
  }

  if (!inferredProviderId) return settings;

  logger.info(
    {
      migration: 'cloud-instance-provider-id-backfill',
      provisionMode: ci.provisionMode,
      inferredProviderId,
    },
    'Backfilling cloudInstance.providerId for legacy record',
  );

  // Breadcrumb (rides on the next real Sentry event) — was a raw info
  // captureMessage; one-time migration telemetry doesn't warrant issue-stream
  // volume and the logger.info above is the durable record. See 260610
  // improve-sentry-noise Stage 5.
  try {
    getErrorReporter().addBreadcrumb({
      category: 'settings.migration',
      message: 'cloudInstance providerId backfilled',
      level: 'info',
      data: {
        migration: 'cloud-instance-provider-id-backfill',
        provisionMode: ci.provisionMode,
        inferredProviderId,
      },
    });
  } catch {
    // best-effort observability — never block migration on reporting failure
  }

  return {
    ...settings,
    cloudInstance: {
      ...ci,
      providerId: inferredProviderId,
    },
  };
};

/**
 * One-shot migration: stamp oauthMigratedAt for users who had OAuth tokens.
 * normalizeSettings() clears the OAuth artifacts, but the timestamp must be written
 * BEFORE normalization runs (since normalization can only detect artifacts on first read).
 * This runs once at startup on the raw store, so the flag persists for the renderer banner.
 */
export const migrateOAuthTimestampIfNeeded = (settings: AppSettings): AppSettings => {
  const modelSettings = materializeModelsForLegacyBootstrap(settings);
  if (Object.keys(modelSettings).length === 0) return settings;

  // Already stamped — nothing to do
  if (modelSettings.oauthMigratedAt) return settings;

  // Check for any OAuth artifact (same predicate as normalizeSettings migration)
  const hasOAuthArtifacts =
    modelSettings.authMethod === 'oauth-token' ||
    !!modelSettings.oauthToken ||
    !!modelSettings.oauthRefreshToken;

  if (!hasOAuthArtifacts) return settings;

  return {
    ...settings,
    models: { ...modelSettings, oauthMigratedAt: new Date().toISOString() } as AppSettings['models'],
  };
};

// ---------------------------------------------------------------------------
// Settings normalization observability — tracks how often ensureNormalizedSettings
// is called and whether it triggers a write. After the write-on-read fix this
// should show 0 calls/writes outside startup.
// ---------------------------------------------------------------------------
let _normalizeCallCount = 0;
let _normalizeWriteCount = 0;
const normalizeCallWindowedCounter = new WindowedCounter();
const normalizeWriteWindowedCounter = new WindowedCounter();

interface NormalizationDiffPaths {
  undefinedOnly: string[];
  real: string[];
}

const hasOwn = (value: unknown, key: string): boolean =>
  typeof value === 'object' &&
  value !== null &&
  Object.prototype.hasOwnProperty.call(value, key);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value);

const formatDiffPath = (path: string[]): string =>
  path.length > 0 ? path.join('.') : '(root)';

const walkNormalizationDiffPaths = (
  currentValue: unknown,
  normalizedValue: unknown,
  path: string[],
  acc: NormalizationDiffPaths,
  hasCurrent: boolean,
  hasNormalized: boolean,
): void => {
  if (hasCurrent && hasNormalized && deepEqual(currentValue, normalizedValue)) {
    return;
  }

  const isUndefinedVsMissing =
    (!hasCurrent && hasNormalized && normalizedValue === undefined) ||
    (hasCurrent && !hasNormalized && currentValue === undefined);

  if (isUndefinedVsMissing) {
    acc.undefinedOnly.push(formatDiffPath(path));
    return;
  }

  if (hasCurrent && hasNormalized && Array.isArray(currentValue) && Array.isArray(normalizedValue)) {
    const maxLength = Math.max(currentValue.length, normalizedValue.length);
    for (let index = 0; index < maxLength; index += 1) {
      walkNormalizationDiffPaths(
        currentValue[index],
        normalizedValue[index],
        [...path, String(index)],
        acc,
        index in currentValue,
        index in normalizedValue,
      );
    }
    return;
  }

  if (hasCurrent && hasNormalized && isPlainRecord(currentValue) && isPlainRecord(normalizedValue)) {
    const keys = new Set([...Object.keys(currentValue), ...Object.keys(normalizedValue)]);
    for (const key of keys) {
      walkNormalizationDiffPaths(
        currentValue[key],
        normalizedValue[key],
        [...path, key],
        acc,
        hasOwn(currentValue, key),
        hasOwn(normalizedValue, key),
      );
    }
    return;
  }

  acc.real.push(formatDiffPath(path));
};

const collectNormalizationDiffPaths = (
  currentValue: unknown,
  normalizedValue: unknown,
): NormalizationDiffPaths => {
  const acc: NormalizationDiffPaths = { undefinedOnly: [], real: [] };
  walkNormalizationDiffPaths(currentValue, normalizedValue, [], acc, true, true);
  return acc;
};

export const ensureNormalizedSettings = (): void => {
  _normalizeCallCount++;
  normalizeCallWindowedCounter.increment();
  const current = settingsStore.store;
  // Stage 4: the boot-path normalisation is the only `bootPhase: 'boot'` site.
  // All other callers (updateSettings, IPC handlers) default to `'save'`.
  const normalized = normalizeSettings(current, 'boot');
  if (!deepEqual(current, normalized)) {
    _normalizeWriteCount++;
    normalizeWriteWindowedCounter.increment();
    if (process.env.REBEL_PERF_MODE === '1') {
      const diffPaths = collectNormalizationDiffPaths(current, normalized);
      if (diffPaths.undefinedOnly.length > 0 && diffPaths.real.length === 0) {
        log.warn(
          {
            keyPath: diffPaths.undefinedOnly,
            profilerChannel: 'perf-summary',
          },
          'normalize diff was undefined-vs-missing only — possible new emitter regression'
        );
      }
    }
    settingsStore.store = normalized;
  }
};

/** Read-only snapshot of normalization counters for diagnostics. */
export const getSettingsNormalizationStats = (): { calls: number; writes: number } => ({
  calls: _normalizeCallCount,
  writes: _normalizeWriteCount,
});

/** Rolling-window + cumulative normalization counters for perf diagnostics. */
export const getSettingsNormalizationWindowedStats = (): {
  calls: WindowedCounterSnapshot;
  writes: WindowedCounterSnapshot;
} => ({
  calls: normalizeCallWindowedCounter.snapshot(),
  writes: normalizeWriteWindowedCounter.snapshot(),
});

/**
 * Update settings by merging partial changes into current settings.
 * Handles normalization automatically.
 */
export const updateSettings = (partial: Partial<AppSettings>): void => {
  const current = settingsStore.store;

  // Diagnostic: detect if a partial update could overwrite an existing OpenRouter token.
  // Shallow merge of { openRouter: { ... } } replaces the entire object — if the partial
  // omits oauthToken, the token is lost. Log when this happens so we can diagnose.
  if (partial.openRouter && current.openRouter?.oauthToken && !partial.openRouter.oauthToken) {
    log.warn({
      hadToken: true,
      partialHasToken: !!partial.openRouter.oauthToken,
      partialKeys: Object.keys(partial.openRouter),
    }, 'updateSettings: openRouter partial may overwrite existing oauthToken');
  }

  settingsStore.store = normalizeSettings({ ...current, ...partial });
};

/**
 * Get current app settings. This is the single source of truth for settings access.
 * All code that needs settings should use this function rather than accessing
 * settingsStore.store directly.
 *
 * Settings are normalized at startup (coreStartup.ts) and on every write via
 * updateSettings(). This read path is intentionally cheap — no normalization,
 * no deep-equal, no disk write.
 */
export const getSettings = (): AppSettings => {
  return settingsStore.store;
};

/**
 * One-shot, version-gated BOOT heal. Runs as a POST-bootstrap startup step
 * (after store/secure-token/codex-auth/managed-key wiring) — NOT an import-time
 * migration, because it reads live Codex token + managed-key state (C-F2).
 * Rescues users already stranded by a prior version on upgrade. Persists via
 * the durable settings store. Idempotent (version-stamped). Declared here (after
 * `getSettings`/`updateSettings`) because it consumes those runtime accessors.
 */
export function runCodexProviderHealAtBoot(deps: CodexProviderHealDeps): {
  healed: boolean;
  from: ActiveProvider | undefined | null;
} {
  const logger = deps.logger ?? log;
  const current = getSettings();

  if (readCurrentCodexProviderHealVersion(current) >= CURRENT_CODEX_PROVIDER_HEAL_VERSION) {
    return { healed: false, from: current.activeProvider ?? null };
  }

  // Defer the heal telemetry — read-only boot must not report a heal it can't
  // persist (F4/S1). We emit below, only after the durable write succeeds.
  const { migrated, healed, from } = applyCodexProviderHeal(current, {
    ...deps,
    deferTelemetry: true,
  });

  if (isUserDataReadOnly()) {
    // Don't stamp the version when we couldn't persist — let the next writable
    // boot retry the heal rather than silently marking it done. No telemetry: no
    // durable heal occurred.
    logger.warn('[version-gate] Blocked Codex provider heal at boot — read-only mode');
    return { healed: false, from };
  }

  updateSettings({
    ...(healed ? { activeProvider: migrated.activeProvider } : {}),
    codexProviderHealVersion: CURRENT_CODEX_PROVIDER_HEAL_VERSION,
  });

  if (healed) {
    emitProviderHealApplied(from, logger);
  }

  return { healed, from };
}

/**
 * Detect meeting bot usage from the meeting-history store.
 * Reads the store directly via createStore (avoid circular deps with meetingHistoryStore).
 * Safe to call before meetingHistoryStore is fully initialized — createStore reads
 * synchronously from disk.
 *
 * If any entry has `botScheduled === true` or `transcriptStatus === 'captured'`,
 * and the user isn't already unlocked, sets `meetingBotUnlocked = true`.
 */
export function detectMeetingBotUsageFromHistory(): void {
  // One-shot: only act when meetingBotUnlocked has never been evaluated (undefined).
  // Do NOT override an explicit opt-out (false) — the user toggled it off deliberately.
  if (settingsStore.store.meetingBotUnlocked !== undefined) return;

  const store = createStore<{ version: number; entries: Record<string, { botScheduled: boolean; transcriptStatus: string }> }>({
    name: 'meeting-history',
    defaults: { version: 1, entries: {} },
  });
  const entries = Object.values(store.store?.entries ?? {});
  const hasUsage = entries.some(e => e.botScheduled === true || e.transcriptStatus === 'captured');
  if (hasUsage) {
    updateSettings({ meetingBotUnlocked: true });
  }
}
