import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Tooltip } from '@renderer/components/ui';
import { Plus, Zap } from 'lucide-react';
import styles from './LocalModelSection.module.css';
import {
  type CustomProvider,
  type ModelProfile,
  type ProviderKeys,
  type RouteSurface,
  type ThinkingEffort,
} from '@shared/types';
import {
  isConnectionManagedProfile,
  isProfileSelectable,
  isUserAddedProfile,
} from '@shared/utils/profileHelpers';
import {
  isConnectionLive,
  type ProfileConnectivity,
} from '@shared/utils/connectivityHelpers';
import { isCodexAutoProfile } from '@shared/utils/codexDefaults';
import {
  normalizeCatalogModelId,
  PROVIDER_CATALOGS,
  type CatalogEntry,
} from '@shared/data/providerCatalogs';
import { findExistingManagedProfile } from '@shared/utils/catalogMaterialization';
import { isCodexSubscriptionProfile } from '@shared/utils/providerKeys';
import type { BillingSource } from '@shared/utils/billingSource';
import {
  getApiKey,
  type ModelSettingsAccessorSettings,
} from '../utils/modelAuthAccessors';
import { saveProfileWithResetGuard } from './models/profileHelpers';
import { useProfileTester } from './models/useProfileTester';
import { useProfileWizard } from './models/useProfileWizard';
import { useProfileLearnedEvents } from '../hooks/useProfileLearnedEvents';
import { ProfileWizardDialog } from './models/ProfileWizardDialog';
import { ProfileTable } from './models/ProfileTable';
import { SmartPickingToolbar } from './models/SmartPickingToolbar';
import { RouteStatusLine } from './RouteStatusLine';
import { SettingSection } from './SettingSection';
import { BillingSourceLegend } from './BillingSourceLegend';
import { CatalogProviderGroup } from './models/CatalogProviderGroup';
import { ProfileLearnedNotices } from './ProfileLearnedNotices';
import { dedupCatalogAgainstProfiles } from './models/dedupCatalog';
import type { ModelRole } from '@core/rebelCore/modelRoleResolver';
import type { RoleAssignment } from '@core/rebelCore/roleAssignment';
import type { AppSettings } from '@shared/types';
import type { RoleId } from '@shared/types/modelChoice';

const NEEDS_SETUP_VISIBLE_CAP = 5;

interface ConnectionProfileGroup {
  key: string;
  title: string;
  profiles: ModelProfile[];
}

const CONNECTION_GROUP_ORDER: Record<string, number> = {
  'openai-subscription': 0,
  openrouter: 1,
  anthropic: 2,
  google: 3,
  openai: 4,
  other: 5,
};

function mapRoleIdToModelRole(role: RoleId): ModelRole | null {
  switch (role) {
    case 'thinking':
      return 'thinking';
    case 'working':
      return 'working';
    case 'background':
      return 'background';
    case 'recovery':
      return null;
  }
}

interface LocalModelSectionProps {
  profiles: ModelProfile[];
  onProfilesChange: (profiles: ModelProfile[]) => void;
  /** Saved provider API keys for reuse in Quick Add */
  providerKeys?: ProviderKeys;
  /** User-defined custom providers */
  customProviders?: CustomProvider[];
  /** Claude settings for reading/writing per-model thinking effort */
  claudeSettings?: {
    apiKey?: string | null;
    model?: string | null;
    workingProfileId?: string | null;
    thinkingModel?: string | null;
    thinkingProfileId?: string | null;
    planMode?: boolean;
    thinkingEffort?: ThinkingEffort;
    modelEfforts?: Partial<Record<string, ThinkingEffort>>;
  };
  /** Callback to update a per-model thinking effort */
  onModelEffortChange?: (modelId: string, effort: ThinkingEffort) => void;
  /** Whether OpenRouter is connected (has OAuth token). Controls OpenRouter add flow. */
  openRouterConnected?: boolean;
  /** Full settings shape for provider auth gates. */
  settings?: ModelSettingsAccessorSettings & {
    localModel?: {
      activeProfileId?: string | null;
      profiles?: ModelProfile[];
    };
  };
  /** Whether ChatGPT Pro/Codex auth is currently healthy. */
  codexConnected?: boolean;
  /** Whether ChatGPT Pro auth exists but needs reconnecting. */
  codexNeedsReconnect?: boolean;
  /** Whether OpenRouter auth exists but needs reconnecting. */
  openRouterNeedsReconnect?: boolean;
  /** Connectivity state for connection-managed model profiles. */
  profileConnectivity?: ProfileConnectivity;
  /** Request from AgentsTab RoleRow status CTA to open the profile wizard. */
  roleModelRequest?: {
    nonce: number;
    role: RoleId;
    hint: 'pick' | 'finish-setup' | 'review-profile';
    profileId?: string;
  } | null;
  /** Working-role assignment used to mark the "Main" row and seed the Smart picking toolbar. */
  workingAssignment?: RoleAssignment;
  /** Apply settings/profile plan updates from the Smart picking toolbar (master toggle). */
  onSmartPickingSettingsChange?: (updates: Partial<AppSettings>) => void;
  /** "Add a model" deep-link used by the Smart picking toolbar's no-effect notice. */
  onSmartPickingAddModel?: () => void;
  /** Open the profile wizard from the Smart picking toolbar's duplicate-routing notice. */
  onSmartPickingOpenProfileManager?: (profileId: string) => void;
  onReconnectCodex?: () => void;
  onReconnectOpenRouter?: () => void;
  /** Managed allowed model IDs for the "Included with your Mindstone plan" group. */
  managedAllowedModels?: readonly string[];
  /** Whether the active provider is Mindstone. */
  isMindstoneActive?: boolean;
}

const TEST_ALL_FAILURE_DISPLAY_MS = 8000;

const catalogBillingSource = (entry: CatalogEntry): BillingSource => {
  switch (entry.routeSurface) {
    case 'subscription':
      return 'subscription';
    case 'pool':
      return 'pool';
    case 'local':
      return 'local';
    case 'api-key':
      return 'pay-per-use';
  }
};

const catalogBillingSourceFromFirstEntry = (
  entries: readonly CatalogEntry[],
  fallback: BillingSource,
): BillingSource => {
  const firstEntry = entries[0];
  return firstEntry ? catalogBillingSource(firstEntry) : fallback;
};

function inferRouteSurfaceForProfile(profile: ModelProfile): RouteSurface {
  if (profile.routeSurface) return profile.routeSurface;
  if (profile.providerType === 'local') return 'local';
  if (profile.providerType === 'openrouter') return 'pool';
  if (profile.authSource === 'codex-subscription') return 'subscription';
  return 'api-key';
}

function findExistingManagedProfileByProfileTuple(
  profiles: readonly ModelProfile[],
  profile: ModelProfile,
): ModelProfile | undefined {
  const providerType = profile.providerType;
  const model = profile.model;
  if (!providerType || !model) return undefined;
  const routeSurface = inferRouteSurfaceForProfile(profile);
  const normalizedModel = normalizeCatalogModelId(model);
  return profiles.find((candidate) => {
    if (!isConnectionManagedProfile(candidate) && candidate.profileSource !== 'auto') return false;
    return (
      candidate.providerType === providerType &&
      inferRouteSurfaceForProfile(candidate) === routeSurface &&
      normalizeCatalogModelId(candidate.model ?? '') === normalizedModel
    );
  });
}

export interface WizardSaveResolution {
  profiles: readonly ModelProfile[];
  justAddedId: string;
}

export function resolveWizardSaveProfiles(
  profile: ModelProfile,
  mode: 'add' | 'edit',
  latestProfiles: ModelProfile[],
): WizardSaveResolution {
  if (mode === 'edit') {
    const exists = latestProfiles.some((p) => p.id === profile.id);
    if (!exists) {
      throw new Error(
        'This profile no longer exists. It may have been deleted. Close and reopen settings.',
      );
    }
  }

  if (mode === 'add' && profile.profileSource === 'connection') {
    const existing = findExistingManagedProfileByProfileTuple(latestProfiles, profile);
    if (existing) {
      return { profiles: latestProfiles, justAddedId: existing.id };
    }
  }

  const normalized = saveProfileWithResetGuard(mode, profile, latestProfiles);
  if (mode === 'add') {
    return { profiles: [...latestProfiles, normalized], justAddedId: normalized.id };
  }
  return {
    profiles: latestProfiles.map((p) => (p.id === profile.id ? normalized : p)),
    justAddedId: normalized.id,
  };
}

const connectionProfileGroupMeta = (
  profile: ModelProfile,
): Pick<ConnectionProfileGroup, 'key' | 'title'> => {
  if (
    profile.providerType === 'openai' &&
    (profile.routeSurface === 'subscription' || profile.authSource === 'codex-subscription')
  ) {
    return { key: 'openai-subscription', title: 'From ChatGPT Pro' };
  }

  switch (profile.providerType) {
    case 'anthropic':
      return { key: 'anthropic', title: 'From Anthropic' };
    case 'google':
      return { key: 'google', title: 'From Gemini' };
    case 'openrouter':
      return { key: 'openrouter', title: 'From OpenRouter' };
    case 'openai':
      return { key: 'openai', title: 'From OpenAI' };
    default:
      return { key: 'other', title: 'From other connections' };
  }
};

export const LocalModelSection = ({
  profiles,
  onProfilesChange,
  providerKeys,
  customProviders,
  claudeSettings,
  onModelEffortChange,
  openRouterConnected,
  settings,
  codexConnected,
  codexNeedsReconnect,
  openRouterNeedsReconnect,
  profileConnectivity,
  roleModelRequest,
  workingAssignment,
  onSmartPickingSettingsChange,
  onSmartPickingAddModel,
  onSmartPickingOpenProfileManager,
  onReconnectCodex,
  onReconnectOpenRouter,
  managedAllowedModels,
  isMindstoneActive,
}: LocalModelSectionProps) => {
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [justAddedId, setJustAddedId] = useState<string | null>(null);
  const [testAllStatus, setTestAllStatus] = useState<string | null>(null);
  const [testAllFailureLabel, setTestAllFailureLabel] = useState<string | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const failureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [needsSetupExpanded, setNeedsSetupExpanded] = useState(false);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;

  useEffect(() => {
    return () => {
      if (failureTimerRef.current) clearTimeout(failureTimerRef.current);
    };
  }, []);

  const [wizardView, wizardActions] = useProfileWizard({
    providerKeys,
    customProviders,
  });
  const lastRoleModelRequestRef = useRef<number | null>(null);

  const { testState, runTest, runTests, isBatchRunning } = useProfileTester({
    profiles,
    onProfilesChange,
  });

  const enabledProfiles = useMemo(
    () => profiles.filter((p) => p.enabled !== false),
    [profiles],
  );

  // Stage 3 IA: bucket profiles into Active / Available / Needs setup. Virtual
  // profiles (managed thinking/working) bypass this grouping and stay hidden.
  // Codex auto-profiles (system plumbing for clientFactory routing — see
  // codexDefaults.ts) are also hidden here; they're already represented by
  // the curated ChatGPT Pro catalog accordion.
  const {
    activeProfiles,
    availableProfiles,
    needsSetupProfiles,
    connectionProfileGroups,
  } = useMemo(() => {
    const active: ModelProfile[] = [];
    const available: ModelProfile[] = [];
    const needsSetup: ModelProfile[] = [];
    const connectionGroups = new Map<string, ConnectionProfileGroup>();
    for (const profile of profiles) {
      if (profile.isVirtual) continue;
      if (isCodexAutoProfile(profile)) continue;
      if (isConnectionManagedProfile(profile)) {
        const meta = connectionProfileGroupMeta(profile);
        const existing = connectionGroups.get(meta.key);
        if (existing) {
          existing.profiles.push(profile);
        } else {
          connectionGroups.set(meta.key, { ...meta, profiles: [profile] });
        }
        continue;
      }
      if (!isUserAddedProfile(profile)) continue;
      const selectable = isProfileSelectable(profile);
      if (!selectable) {
        needsSetup.push(profile);
      } else if (profile.enabled !== false) {
        active.push(profile);
      } else {
        available.push(profile);
      }
    }
    needsSetup.sort((a, b) => {
      const aLearned = a.contextWindowLearnedAt ?? a.createdAt ?? 0;
      const bLearned = b.contextWindowLearnedAt ?? b.createdAt ?? 0;
      return bLearned - aLearned;
    });
    const groupedConnections = Array.from(connectionGroups.values()).sort((a, b) => {
      const aRank = CONNECTION_GROUP_ORDER[a.key] ?? CONNECTION_GROUP_ORDER.other;
      const bRank = CONNECTION_GROUP_ORDER[b.key] ?? CONNECTION_GROUP_ORDER.other;
      if (aRank !== bRank) return aRank - bRank;
      return a.title.localeCompare(b.title);
    });
    return {
      activeProfiles: active,
      availableProfiles: available,
      needsSetupProfiles: needsSetup,
      connectionProfileGroups: groupedConnections,
    };
  }, [profiles]);

  const connectionNeedsSetupProfileIds = useMemo(
    () =>
      new Set(
        profiles
          .filter((profile) =>
            isConnectionManagedProfile(profile) &&
            !isConnectionLive(profile, profileConnectivity),
          )
          .map((profile) => profile.id),
      ),
    [profileConnectivity, profiles],
  );

  const workingProfileId = useMemo<string | null>(() => {
    if (!workingAssignment) return null;
    const primary = workingAssignment.primary;
    if (primary.kind === 'profile') return primary.profileId;
    if (primary.kind === 'model') {
      const targetModel = primary.modelId.trim();
      if (!targetModel) return null;
      const match = profiles.find(
        (profile) =>
          !profile.isVirtual &&
          (profile.model ?? '').trim() === targetModel,
      );
      return match?.id ?? null;
    }
    return null;
  }, [profiles, workingAssignment]);

  const visibleNeedsSetup = useMemo(
    () =>
      needsSetupExpanded || needsSetupProfiles.length <= NEEDS_SETUP_VISIBLE_CAP
        ? needsSetupProfiles
        : needsSetupProfiles.slice(0, NEEDS_SETUP_VISIBLE_CAP),
    [needsSetupExpanded, needsSetupProfiles],
  );

  const {
    events: profileLearnedEvents,
    dismissEvent: dismissProfileLearnedEvent,
  } = useProfileLearnedEvents(profiles);

  const authSettings = settings ?? { models: claudeSettings };
  const hasAnthropicAuth = !!getApiKey(authSettings);
  const hasGeminiAuth = !!providerKeys?.google?.trim();
  const showCodexSection = !!codexConnected || !!codexNeedsReconnect;
  const showOpenRouterSection = !!openRouterConnected || !!openRouterNeedsReconnect;

  const codexCatalog = useMemo(
    () => dedupCatalogAgainstProfiles(PROVIDER_CATALOGS.openai, profiles),
    [profiles],
  );
  const openRouterCatalog = useMemo(
    () => dedupCatalogAgainstProfiles(PROVIDER_CATALOGS.openrouter, profiles),
    [profiles],
  );
  const reconnectCodexCatalog = useMemo(
    () => codexCatalog.filter((entry) => Boolean(findExistingManagedProfile(profiles, entry))),
    [codexCatalog, profiles],
  );
  const reconnectOpenRouterCatalog = useMemo(
    () => openRouterCatalog.filter((entry) => Boolean(findExistingManagedProfile(profiles, entry))),
    [openRouterCatalog, profiles],
  );
  const anthropicCatalog = useMemo(
    () => dedupCatalogAgainstProfiles(PROVIDER_CATALOGS.anthropic, profiles),
    [profiles],
  );
  const geminiCatalog = useMemo(
    () => dedupCatalogAgainstProfiles(PROVIDER_CATALOGS.google, profiles),
    [profiles],
  );
  const wizardCatalogEntries = useMemo(
    () => [
      ...codexCatalog,
      ...openRouterCatalog,
      ...anthropicCatalog,
      ...geminiCatalog,
    ],
    [anthropicCatalog, codexCatalog, geminiCatalog, openRouterCatalog],
  );
  const providerConnections = useMemo(
    () => ({
      codex: {
        connected: !!codexConnected,
        ...(onReconnectCodex ? { onConnect: onReconnectCodex } : {}),
      },
      openrouter: {
        connected: !!openRouterConnected,
        ...(onReconnectOpenRouter ? { onConnect: onReconnectOpenRouter } : {}),
      },
      anthropic: {
        connected: hasAnthropicAuth,
      },
      gemini: {
        connected: hasGeminiAuth,
      },
    }),
    [
      codexConnected,
      hasAnthropicAuth,
      hasGeminiAuth,
      onReconnectCodex,
      onReconnectOpenRouter,
      openRouterConnected,
    ],
  );
  const getReconnectHandler = useCallback(
    (profile: ModelProfile): (() => void) | undefined => {
      if (isCodexSubscriptionProfile(profile)) {
        return onReconnectCodex;
      }
      if (profile.providerType === 'openrouter') {
        return onReconnectOpenRouter;
      }
      return undefined;
    },
    [onReconnectCodex, onReconnectOpenRouter],
  );

  const hasSubscriptionSections = showCodexSection || showOpenRouterSection;
  const hasCatalogSections = hasSubscriptionSections || hasAnthropicAuth || hasGeminiAuth;
  const hasAnyModelSurface = hasCatalogSections || profiles.length > 0;
  const hasUserAddedSections =
    activeProfiles.length > 0 ||
    availableProfiles.length > 0 ||
    needsSetupProfiles.length > 0;

  const doneCount = useMemo(() => {
    if (!batchProgress) return 0;
    // Count how many of the batch's keys are NOT currently testing.
    // During runTests, `testState[id]?.testing` is true while in-flight.
    return batchProgress.total - enabledProfiles.filter((p) => testState[p.id]?.testing).length;
  }, [batchProgress, enabledProfiles, testState]);

  const handleToggleEnabled = useCallback(
    (profileId: string) => {
      onProfilesChange(
        profiles.map((p) => {
          if (p.id !== profileId) return p;
          return { ...p, enabled: p.enabled === false ? true : false };
        }),
      );
    },
    [profiles, onProfilesChange],
  );

  const handleTestProfile = useCallback(
    (profile: ModelProfile) => {
      // Re-running the test is the user's canonical recovery for stale
      // `*Compatibility: 'incompatible'` verdicts (260521 BTS Haiku-fallback
      // A6). Clear any prior incompatible flags first so a fresh test result
      // overwrites them. Capability probes that currently can't be evaluated
      // (e.g. network blip) leave the field undefined, which renders as
      // "unknown" — strictly better than leaving the stale "Not compatible"
      // badge stuck.
      const hasIncompatibleFlag =
        profile.chatCompatibility === 'incompatible'
        || profile.jsonCompatibility === 'incompatible'
        || profile.thinkingCompatibility === 'incompatible'
        || profile.toolUseCompatibility === 'incompatible';
      if (hasIncompatibleFlag) {
        const cleared = profiles.map((candidate) => {
          if (candidate.id !== profile.id) return candidate;
          const {
            chatCompatibility,
            chatCompatibilityCheckedAt,
            jsonCompatibility,
            jsonCompatibilityCheckedAt,
            thinkingCompatibility,
            thinkingCompatibilityCheckedAt,
            toolUseCompatibility,
            toolUseCompatibilityCheckedAt,
            ...rest
          } = candidate;
          return {
            ...rest,
            ...(chatCompatibility === 'compatible' ? { chatCompatibility, chatCompatibilityCheckedAt } : {}),
            ...(jsonCompatibility === 'compatible' ? { jsonCompatibility, jsonCompatibilityCheckedAt } : {}),
            ...(thinkingCompatibility === 'compatible' ? { thinkingCompatibility, thinkingCompatibilityCheckedAt } : {}),
            ...(toolUseCompatibility === 'compatible' ? { toolUseCompatibility, toolUseCompatibilityCheckedAt } : {}),
          };
        });
        onProfilesChange(cleared);
      }
      void runTest(profile.id, {
        serverUrl: profile.serverUrl,
        model: profile.model,
        apiKey: profile.apiKey,
        providerType: profile.providerType,
        customProviderId: profile.customProviderId,
      });
    },
    [onProfilesChange, profiles, runTest],
  );

  const handleEditProfile = useCallback(
    (profile: ModelProfile) => {
      // Let the wizard be the single gate — don't pre-filter here, otherwise the
      // fail-closed observability from open() never fires for managed profiles.
      const result = wizardActions.open({ mode: 'edit', profile });
      if (!result.opened) {
        // Defense-in-depth logging — the Edit button shouldn't even render for
        // managed profiles today, but a programmatic caller might hit this.
        console.warn('[LocalModelSection] Wizard refused to open.', {
          profileId: profile.id,
          reason: result.reason,
        });
      }
    },
    [wizardActions],
  );

  // "Finish setup" reuses the edit flow but always lands on Configure step.
  // The wizard's seedConfigureForEdit already drops the user there for
  // non-orphaned profiles; the helper exists as a separate identity so future
  // logic (e.g., deep-linking to a specific field) can branch on intent.
  const handleFinishSetup = handleEditProfile;

  const handleRequestDelete = useCallback((profileId: string) => {
    setDeleteConfirm(profileId);
  }, []);

  const handleConfirmDelete = useCallback(
    (profileId: string) => {
      onProfilesChange(profiles.filter((p) => p.id !== profileId));
      setDeleteConfirm(null);
    },
    [profiles, onProfilesChange],
  );

  const handleWizardSave = useCallback(
    (profile: ModelProfile, mode: 'add' | 'edit') => {
      const latestProfiles = profilesRef.current;
      const resolution = resolveWizardSaveProfiles(profile, mode, latestProfiles);
      if (resolution.profiles !== latestProfiles) {
        onProfilesChange([...resolution.profiles]);
      }
      setJustAddedId(resolution.justAddedId);
    },
    [onProfilesChange],
  );

  const handleWizardDelete = useCallback(
    (profile: ModelProfile) => {
      const latestProfiles = profilesRef.current;
      onProfilesChange(latestProfiles.filter((p) => p.id !== profile.id));
    },
    [onProfilesChange],
  );

  const handleHighlightDone = useCallback(() => {
    setJustAddedId(null);
  }, []);

  useEffect(() => {
    if (!roleModelRequest || lastRoleModelRequestRef.current === roleModelRequest.nonce) {
      return;
    }
    lastRoleModelRequestRef.current = roleModelRequest.nonce;

    if (
      (roleModelRequest.hint === 'finish-setup' || roleModelRequest.hint === 'review-profile')
      && roleModelRequest.profileId
    ) {
      const profile = profiles.find((candidate) => candidate.id === roleModelRequest.profileId);
      if (profile) {
        wizardActions.open({ mode: 'edit', profile });
        return;
      }
    }

    const rolePreference = mapRoleIdToModelRole(roleModelRequest.role);
    if (rolePreference) {
      wizardActions.open({ mode: 'add', rolePreference });
      return;
    }

    wizardActions.open({ mode: 'add' });
  }, [profiles, roleModelRequest, wizardActions]);

  const handleTestAll = useCallback(async () => {
    if (enabledProfiles.length === 0) return;
    if (failureTimerRef.current) {
      clearTimeout(failureTimerRef.current);
      failureTimerRef.current = null;
    }
    setTestAllFailureLabel(null);
    setBatchProgress({ done: 0, total: enabledProfiles.length });
    setTestAllStatus(`Testing ${enabledProfiles.length} profiles…`);

    const keys = enabledProfiles.map((p) => p.id);
    const paramsByKey: Record<
      string,
      {
        serverUrl: string;
        model?: string;
        apiKey?: string;
        providerType?: string;
        customProviderId?: string;
      }
    > = {};
    for (const profile of enabledProfiles) {
      paramsByKey[profile.id] = {
        serverUrl: profile.serverUrl,
        model: profile.model,
        apiKey: profile.apiKey,
        providerType: profile.providerType,
        customProviderId: profile.customProviderId,
      };
    }

    const results = await runTests(keys, paramsByKey);
    const failures = results.filter((r) => !r.success).length;
    const successes = results.length - failures;
    setBatchProgress(null);

    if (failures === 0) {
      setTestAllStatus('Test all complete. All models work.');
    } else {
      setTestAllStatus(
        `Test all complete. ${successes} work, ${failures} didn't.`,
      );
      setTestAllFailureLabel(`${failures} didn't work`);
      failureTimerRef.current = setTimeout(() => {
        setTestAllFailureLabel(null);
        failureTimerRef.current = null;
      }, TEST_ALL_FAILURE_DISPLAY_MS);
    }
  }, [enabledProfiles, runTests]);

  const testAllDisabled = enabledProfiles.length === 0 || isBatchRunning;

  const testAllLabel = isBatchRunning
    ? `Testing… (${doneCount}/${batchProgress?.total ?? enabledProfiles.length})`
    : testAllFailureLabel ?? 'Test all';

  return (
    <div className={styles.sectionWrapper} data-testid="settings-models-section">
      {/* ===== Model Profiles ===== */}
      <div className={styles.profilesContainer}>
        <RouteStatusLine
          codexConnected={codexConnected}
          codexNeedsReconnect={codexNeedsReconnect}
          openRouterConnected={openRouterConnected}
          openRouterNeedsReconnect={openRouterNeedsReconnect}
          hasAnthropicAuth={hasAnthropicAuth}
          onReconnectCodex={onReconnectCodex}
          onReconnectOpenRouter={onReconnectOpenRouter}
        />
        <BillingSourceLegend />
        <div className={styles.profilesHeader}>
          <div className={styles.profilesTitleGroup}>
            <div className={styles.profilesTitle}>Model profiles</div>
            <div className={styles.profilesDescription}>
              Enable, test, or add models below.
            </div>
          </div>
          <div className={styles.headerActions}>
            {testAllDisabled && enabledProfiles.length === 0 ? (
              // Disabled buttons swallow hover/focus, so wrap with a focusable
              // span that carries the tooltip and the testid. The button stays
              // visually disabled and is hidden from a11y to avoid duplication.
              <Tooltip content="Enable at least one profile to test">
                <span
                  tabIndex={0}
                  className={styles.disabledTooltipWrap}
                  role="button"
                  aria-disabled="true"
                  aria-label="Test all disabled — no profiles enabled"
                  data-testid="settings-models-test-all-button"
                >
                  <Button
                    variant="outline"
                    size="sm"
                    disabled
                    tabIndex={-1}
                    aria-hidden="true"
                  >
                    <Zap size={14} aria-hidden="true" />
                    Test all
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleTestAll()}
                disabled={testAllDisabled}
                data-testid="settings-models-test-all-button"
              >
                <Zap size={14} aria-hidden="true" />
                {testAllLabel}
              </Button>
            )}
            <Button
              variant="default"
              size="sm"
              onClick={() => wizardActions.open({ mode: 'add' })}
              data-testid="settings-models-add-button"
            >
              <Plus size={14} aria-hidden="true" />
              Add model
            </Button>
          </div>
        </div>

        {/* Hidden aria-live region for "Test all" completion announcements. */}
        <div role="status" aria-live="polite" className={styles.srOnly}>
          {testAllStatus}
        </div>

        {hasAnyModelSurface ? (
          <div className={styles.modelIaWrapper} data-testid="settings-models-ia">
            {profiles.length > 0 && (
              <div
                className={styles.profileSectionsWrapper}
                data-testid="settings-models-profile-sections"
              >
                {settings && onSmartPickingSettingsChange && onSmartPickingAddModel && onSmartPickingOpenProfileManager && (
                  <SmartPickingToolbar
                    settings={settings as AppSettings}
                    profiles={profiles}
                    workingAssignment={workingAssignment}
                    connectivity={profileConnectivity}
                    onSettingsChange={onSmartPickingSettingsChange}
                    onAddModel={onSmartPickingAddModel}
                    onOpenProfileManager={onSmartPickingOpenProfileManager}
                  />
                )}

                {profileLearnedEvents.length > 0 && (
                  <ProfileLearnedNotices
                    events={profileLearnedEvents}
                    onDismiss={dismissProfileLearnedEvent}
                  />
                )}

                {connectionProfileGroups.length > 0 && (
                  <ProfileSection
                    title="From your connections"
                    description="Models added from subscriptions or provider connections."
                    testId="settings-models-section-connections"
                    titleTestId="settings-models-section-title-connections"
                  >
                    <div
                      className={styles.connectionGroups}
                      data-testid="settings-models-connections-groups"
                    >
                      {connectionProfileGroups.map((group) => (
                        <div
                          key={group.key}
                          className={styles.connectionGroup}
                          data-testid={`settings-models-connections-group-${group.key}`}
                        >
                          <div
                            className={styles.connectionGroupTitle}
                            data-testid={`settings-models-connections-group-title-${group.key}`}
                          >
                            {group.title}
                          </div>
                          <ProfileTable
                            profiles={group.profiles}
                            customProviders={customProviders}
                            providerKeys={providerKeys}
                            testState={testState}
                            allProfiles={profiles}
                            workingProfileId={workingProfileId}
                            needsSetupProfileIds={connectionNeedsSetupProfileIds}
                            onProfilesChange={onProfilesChange}
                            justAddedId={justAddedId}
                            deleteConfirmId={deleteConfirm}
                            onToggleEnabled={handleToggleEnabled}
                            onTest={handleTestProfile}
                            onEdit={handleEditProfile}
                            onRequestDelete={handleRequestDelete}
                            onConfirmDelete={handleConfirmDelete}
                            getReconnectHandler={getReconnectHandler}
                            onHighlightDone={handleHighlightDone}
                          />
                        </div>
                      ))}
                    </div>
                  </ProfileSection>
                )}

                {hasUserAddedSections && (
                  <ProfileSection
                    title="Added by you"
                    description="Models you've added directly. Enable, test, or add more below."
                    testId="settings-models-section-user-added"
                    titleTestId="settings-models-section-title-user-added"
                  >
                    <div className={styles.userAddedProfileSections}>
                      {activeProfiles.length > 0 && (
                        <ProfileSection
                          title="Active"
                          description="Profiles in rotation. Rebel can route conversations to these."
                          testId="settings-models-section-active"
                          titleTestId="settings-models-section-title-active"
                        >
                          <ProfileTable
                            profiles={activeProfiles}
                            customProviders={customProviders}
                            providerKeys={providerKeys}
                            testState={testState}
                            allProfiles={profiles}
                            workingProfileId={workingProfileId}
                            onProfilesChange={onProfilesChange}
                            justAddedId={justAddedId}
                            deleteConfirmId={deleteConfirm}
                            onToggleEnabled={handleToggleEnabled}
                            onTest={handleTestProfile}
                            onEdit={handleEditProfile}
                            onRequestDelete={handleRequestDelete}
                            onConfirmDelete={handleConfirmDelete}
                            onHighlightDone={handleHighlightDone}
                          />
                        </ProfileSection>
                      )}

                      {availableProfiles.length > 0 && (
                        <ProfileSection
                          title="Available"
                          description="Configured but disabled. Toggle them on to put them back in rotation."
                          testId="settings-models-section-available"
                          titleTestId="settings-models-section-title-available"
                        >
                          <ProfileTable
                            profiles={availableProfiles}
                            customProviders={customProviders}
                            providerKeys={providerKeys}
                            testState={testState}
                            allProfiles={profiles}
                            workingProfileId={workingProfileId}
                            onProfilesChange={onProfilesChange}
                            justAddedId={justAddedId}
                            deleteConfirmId={deleteConfirm}
                            onToggleEnabled={handleToggleEnabled}
                            onTest={handleTestProfile}
                            onEdit={handleEditProfile}
                            onRequestDelete={handleRequestDelete}
                            onConfirmDelete={handleConfirmDelete}
                            onHighlightDone={handleHighlightDone}
                          />
                        </ProfileSection>
                      )}

                      {needsSetupProfiles.length > 0 && (
                        <ProfileSection
                          title="Needs setup"
                          description="Rebel noticed these models during a conversation, but needs connection details before it can use them."
                          testId="settings-models-section-needs-setup"
                          titleTestId="settings-models-section-title-needs-setup"
                        >
                          <NeedsSetupList
                            profiles={visibleNeedsSetup}
                            onFinishSetup={handleFinishSetup}
                            onRequestDelete={handleRequestDelete}
                            onConfirmDelete={handleConfirmDelete}
                            deleteConfirmId={deleteConfirm}
                          />
                          {needsSetupProfiles.length > NEEDS_SETUP_VISIBLE_CAP && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              onClick={() => setNeedsSetupExpanded((prev) => !prev)}
                              data-testid="settings-models-needs-setup-show-all"
                              className={styles.needsSetupShowAll}
                            >
                              {needsSetupExpanded
                                ? 'Show less'
                                : `Show all (${needsSetupProfiles.length})`}
                            </Button>
                          )}
                        </ProfileSection>
                      )}
                    </div>
                  </ProfileSection>
                )}
              </div>
            )}

            {hasCatalogSections && (
              <SettingSection
                advanced
                title="Included with your connections"
                description="Models we can call on directly because of your connections above."
                defaultExpanded={false}
                data-section="connectionCatalog"
              >
                {showCodexSection && (
                  <CatalogProviderGroup
                    title="ChatGPT Pro"
                    providerName="ChatGPT Pro"
                    dataSection="codexCatalog"
                    entries={codexConnected ? codexCatalog : reconnectCodexCatalog}
                    reconnectRequired={!!codexNeedsReconnect && !codexConnected}
                    onReconnect={onReconnectCodex}
                    claudeSettings={claudeSettings}
                    onModelEffortChange={onModelEffortChange}
                    existingProfiles={profiles}
                    onRemoveFromTeam={handleWizardDelete}
                    billingSource={catalogBillingSourceFromFirstEntry(
                      PROVIDER_CATALOGS.openai,
                      'subscription',
                    )}
                    defaultExpanded={!!codexNeedsReconnect && !codexConnected}
                  />
                )}
                {showOpenRouterSection && (
                  <CatalogProviderGroup
                    title="OpenRouter"
                    providerName="OpenRouter"
                    dataSection="openrouterCatalog"
                    entries={openRouterConnected ? openRouterCatalog : reconnectOpenRouterCatalog}
                    reconnectRequired={!!openRouterNeedsReconnect && !openRouterConnected}
                    onReconnect={onReconnectOpenRouter}
                    claudeSettings={claudeSettings}
                    onModelEffortChange={onModelEffortChange}
                    existingProfiles={profiles}
                    onRemoveFromTeam={handleWizardDelete}
                    billingSource={catalogBillingSourceFromFirstEntry(
                      PROVIDER_CATALOGS.openrouter,
                      'pool',
                    )}
                    defaultExpanded={!!openRouterNeedsReconnect && !openRouterConnected}
                  />
                )}
                {hasAnthropicAuth && (
                  <CatalogProviderGroup
                    title="Anthropic"
                    providerName="Anthropic"
                    dataSection="anthropicCatalog"
                    entries={anthropicCatalog}
                    claudeSettings={claudeSettings}
                    onModelEffortChange={onModelEffortChange}
                    existingProfiles={profiles}
                    onRemoveFromTeam={handleWizardDelete}
                    billingSource={catalogBillingSourceFromFirstEntry(
                      PROVIDER_CATALOGS.anthropic,
                      'pay-per-use',
                    )}
                    defaultExpanded={false}
                  />
                )}
                {hasGeminiAuth && (
                  <CatalogProviderGroup
                    title="Gemini"
                    providerName="Gemini"
                    dataSection="geminiCatalog"
                    entries={geminiCatalog}
                    claudeSettings={claudeSettings}
                    onModelEffortChange={onModelEffortChange}
                    existingProfiles={profiles}
                    onRemoveFromTeam={handleWizardDelete}
                    billingSource={catalogBillingSourceFromFirstEntry(
                      PROVIDER_CATALOGS.google,
                      'pay-per-use',
                    )}
                    defaultExpanded={false}
                  />
                )}
              </SettingSection>
            )}
          </div>
        ) : (
          <p className={styles.emptyState}>
            No models yet. Connect a provider above to get started.
          </p>
        )}
      </div>

      <ProfileWizardDialog
        view={wizardView}
        actions={wizardActions}
        customProviders={customProviders}
        providerKeys={providerKeys}
        openRouterConnected={!!openRouterConnected}
        connectorCatalogEntries={wizardCatalogEntries}
        existingProfiles={profiles}
        getLatestProfilesSnapshot={() => profilesRef.current}
        providerConnections={providerConnections}
        managedAllowedModels={managedAllowedModels}
        isMindstoneActive={isMindstoneActive}
        testState={testState}
        runTest={runTest}
        onSave={handleWizardSave}
        onCatalogEntryAlreadyOnTeam={setJustAddedId}
        onDelete={handleWizardDelete}
      />
    </div>
  );
};

interface ProfileSectionProps {
  title: string;
  description?: string;
  testId: string;
  titleTestId: string;
  children: ReactNode;
}

function ProfileSection({ title, description, testId, titleTestId, children }: ProfileSectionProps) {
  return (
    <section className={styles.profileSection} data-testid={testId}>
      <header className={styles.profileSectionHeader}>
        <h3 className={styles.profileSectionTitle} data-testid={titleTestId}>
          {title}
        </h3>
        {description && (
          <p className={styles.profileSectionDescription}>{description}</p>
        )}
      </header>
      {children}
    </section>
  );
}

interface NeedsSetupListProps {
  profiles: ModelProfile[];
  onFinishSetup: (profile: ModelProfile) => void;
  onRequestDelete: (profileId: string) => void;
  onConfirmDelete: (profileId: string) => void;
  deleteConfirmId: string | null;
}

function NeedsSetupList({
  profiles,
  onFinishSetup,
  onRequestDelete,
  onConfirmDelete,
  deleteConfirmId,
}: NeedsSetupListProps) {
  return (
    <ul className={styles.needsSetupList} data-testid="settings-models-needs-setup-list">
      {profiles.map((profile) => {
        const learnedAt = profile.contextWindowLearnedAt;
        const learnedTokens = profile.lastLearnedContextWindow ?? profile.contextWindow ?? null;
        const confirming = deleteConfirmId === profile.id;
        const hasMetadata = learnedTokens != null || learnedAt != null;
        return (
          <li
            key={profile.id}
            className={styles.needsSetupRow}
            data-testid={`settings-models-needs-setup-row-${profile.id}`}
          >
            <div className={styles.needsSetupMeta}>
              <span className={styles.needsSetupName}>{profile.name || profile.model}</span>
              <span
                className={styles.needsSetupExplanation}
                data-testid={`settings-models-needs-setup-explanation-${profile.id}`}
              >
                Rebel learned this model&rsquo;s conversation limit. Add connection details
                before using it in conversations.
              </span>
              {hasMetadata && (
                <span className={styles.needsSetupHint}>
                  {learnedTokens != null && `Learned context: ${formatLearnedTokens(learnedTokens)}`}
                  {learnedTokens != null && learnedAt != null && ' · '}
                  {learnedAt != null && `last seen ${formatNeedsSetupTime(learnedAt)}`}
                </span>
              )}
            </div>
            <div className={styles.needsSetupActions}>
              <Button
                variant="default"
                size="sm"
                onClick={() => onFinishSetup(profile)}
                data-testid={`settings-models-needs-setup-finish-${profile.id}`}
              >
                Finish setup
              </Button>
              {confirming ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => onConfirmDelete(profile.id)}
                  data-testid={`settings-models-needs-setup-confirm-delete-${profile.id}`}
                >
                  Click to confirm
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRequestDelete(profile.id)}
                  data-testid={`settings-models-needs-setup-delete-${profile.id}`}
                >
                  Remove
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function formatLearnedTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K tokens`;
  return `${tokens} tokens`;
}

function formatNeedsSetupTime(timestamp: number): string {
  if (typeof Intl?.RelativeTimeFormat === 'undefined') {
    return new Date(timestamp).toLocaleDateString();
  }
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const diffMs = timestamp - Date.now();
  const absSec = Math.abs(diffMs) / 1000;
  const units: Array<{ unit: Intl.RelativeTimeFormatUnit; seconds: number }> = [
    { unit: 'year', seconds: 365 * 24 * 60 * 60 },
    { unit: 'month', seconds: 30 * 24 * 60 * 60 },
    { unit: 'week', seconds: 7 * 24 * 60 * 60 },
    { unit: 'day', seconds: 24 * 60 * 60 },
    { unit: 'hour', seconds: 60 * 60 },
    { unit: 'minute', seconds: 60 },
    { unit: 'second', seconds: 1 },
  ];
  for (const { unit, seconds } of units) {
    if (absSec >= seconds || unit === 'second') {
      return formatter.format(Math.round(diffMs / 1000 / seconds), unit);
    }
  }
  return formatter.format(0, 'second');
}
