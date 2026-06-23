import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Loader2, Library, Check, Plus, Pencil, Trash2 } from 'lucide-react';
import { OpenRouterLogo, OpenAILogo, AnthropicLogo } from '../ProviderLogos';
import { Button, RichSelect, Tooltip, useToast } from '@renderer/components/ui';
import type { DailySparkMode } from '@core/dailySparkTypes';
import { useOpenRouterSetup } from '@renderer/hooks/useOpenRouterSetup';
import { ClaudeMaxSetupDialog } from '../ClaudeMaxSetupDialog';

import { OpenRouterPrivacyModal } from '@renderer/components/OpenRouterPrivacyModal';
import { LocalModelSection } from '../LocalModelSection';
import { LocalInferenceSection } from '../LocalInferenceSection';
import { BtsTaskOverrides } from '../BtsTaskOverrides';
import { SettingRow } from '../SettingRow';
import { SettingSection } from '../SettingSection';
import { SubscriptionSection } from '../SubscriptionSection';
import { useSubscriptionState } from '@renderer/hooks/useSubscriptionState';
import { useManagedDefaults } from '@renderer/hooks/useManagedDefaults';
import { ModelTeamSection, pluralizeModel } from '../models/ModelTeamSection';
import { RoleRow } from '../models/RoleRow';
import { choiceToPickerValue } from '../models/ModelChoicePicker';
import type { TestResult, TestStateEntry } from '../models/useProfileTester';
import type { BtsTaskGroup } from '@shared/utils/btsModelResolver';
import { LocalSttModelSection as _LocalSttModelSection } from '../LocalSttModelSection';
import { BackupConnectionsSection, isProviderConnected } from '../BackupConnectionsSection';
import { useFlowPanels } from '@renderer/features/flow-panels/FlowPanelsProvider';
import {
  BTS_DETAILS_HAS_RENDERED_KEY,
  BTS_DETAILS_USER_PREFERENCE_KEY,
  useFirstRenderOpenState,
} from '../../hooks/useFirstRenderOpenState';
import { DEFAULT_LOCAL_MODEL_SETTINGS, DEFAULT_OPENROUTER_SETTINGS, type ModelProfile, type CustomProvider, type ModelSettings } from '@shared/types';
import type { AppSettings, ActiveProvider, SubscriptionTier } from '@shared/types';
import { getManagedAllowListState } from '@shared/types/managedProvider';
import { isCodexAutoProfile } from '@shared/utils/codexDefaults';
import {
  isAutoProfileShadowedBySibling,
  isConnectionManagedProfile,
} from '@shared/utils/profileHelpers';
import { isProfileFunctional } from '@shared/utils/connectivityHelpers';
import { getCouncilProfiles } from '@shared/utils/councilProfiles';
import { getRoutingEligibleProfiles } from '@shared/utils/routingProfiles';
import { redactSensitiveString } from '@shared/utils/sentryRedaction';
import {
  formatActiveProviderLabel,
  pickFallbackProvider,
  planProviderSwitch,
} from '@shared/utils/providerSwitch';
import { resolveAllRoleAssignments, type RoleAssignment } from '@core/rebelCore/roleAssignment';
import { encodeRoleChoice, encodeRoleFallback } from '@shared/utils/modelChoiceCodec';
import type { ModelChoice, RoleId } from '@shared/types/modelChoice';
import { cleanupOrphanedProfileReferences } from '@shared/utils/cleanupOrphanedProfileReferences';
import { buildModelChoiceOptions } from '../../utils/buildModelChoiceOptions';
import { useProfileConnectivity } from '../../hooks/useProfileConnectivity';
import styles from '../SettingsSurface.module.css';
import type { AgentsTabProps } from './types';

/** Strip all whitespace from API key input (consistent with onboarding) */
const sanitizeApiKey = (value: string): string => value.replace(/\s/g, '');

const TIER_LABEL: Record<SubscriptionTier, string> = {
  dash: 'Dash',
  rogue: 'Rogue',
};
const hasOpenRouterCredentials = (settings: AppSettings): boolean => !!settings.openRouter?.oauthToken;
const RECOVERY_FALLBACK_PICKER_ID = 'long-context-fallback-model';
const BTS_DETAILS_OPEN_STATE_OPTIONS = {
  hasRenderedKey: BTS_DETAILS_HAS_RENDERED_KEY,
  userPreferenceKey: BTS_DETAILS_USER_PREFERENCE_KEY,
};

type RoleModelRequest = {
  nonce: number;
  role: RoleId;
  hint: 'pick' | 'finish-setup' | 'review-profile';
  profileId?: string;
};

type SettingsPlanUpdates = Omit<Partial<AppSettings>, 'models'> & {
  models?: Partial<NonNullable<AppSettings['models']>>;
};

type InlineRoleTestStateEntry = TestStateEntry & {
  modelKey: string;
};

function recoverySecondaryFallbackWarning(status: RoleAssignment['status']): {
  warning: string | null;
  warningCta: string | null;
} {
  switch (status.kind) {
    case 'missing-profile':
      return {
        warning: 'Recovery fallback is unavailable. Pick another fallback for long conversations.',
        warningCta: 'Pick fallback',
      };
    case 'incomplete-profile':
      return {
        warning: 'Recovery profile needs setup.',
        warningCta: 'Pick fallback',
      };
    case 'assigned-but-disconnected':
      return {
        warning: "Recovery profile's connection needs attention.",
        warningCta: null,
      };
    case 'ok':
    case 'auto':
    case 'off':
    case 'no-selection':
    // Recovery maps to no runtime role, so runtime-precedence decoration cannot produce this.
    // This arm exists only to keep the status switch exhaustive.
    case 'profile-unavailable-model-active':
      return { warning: null, warningCta: null };
  }
}

export const AgentsTab = ({
  draftSettings,
  updateDraft,
  updateClaude,
  updateVoice,
  markKeySticky,
}: AgentsTabProps) => {
  // Navigation for opening Library with indexing panel
  const { navigateToLibraryLens } = useFlowPanels();
  const { showToast } = useToast();
  const {
    managedAllowedModels,
    defaultModels: managedDefaultModels,
    managedProvider,
  } = useManagedDefaults();
  const managedAllowListState = useMemo(
    () => getManagedAllowListState(managedProvider),
    [managedProvider],
  );

  const handleOpenLibraryIndexing = useCallback(() => {
    navigateToLibraryLens({ filter: 'spaces' }, { expandIndexingPanel: true });
  }, [navigateToLibraryLens]);

  const handleBtsOverrideChange = useCallback((group: BtsTaskGroup, value: string | undefined) => {
    const current = draftSettings.behindTheScenesOverrides ?? {};
    if (value) {
      updateDraft('behindTheScenesOverrides', { ...current, [group]: value });
    } else {
      const { [group]: _, ...rest } = current;
      updateDraft('behindTheScenesOverrides', Object.keys(rest).length > 0 ? rest : undefined);
    }
  }, [draftSettings.behindTheScenesOverrides, updateDraft]);

  const modelSettings = useMemo<Partial<NonNullable<AppSettings['models']>>>(
    () => draftSettings.models ?? {},
    [draftSettings.models],
  );
  const localModelProfiles = useMemo(
    () => draftSettings.localModel?.profiles ?? [],
    [draftSettings.localModel?.profiles]
  );
  const userManagedLocalModelProfiles = useMemo(
    () => localModelProfiles.filter(profile => !profile.isVirtual),
    [localModelProfiles]
  );
  const activeProvider: ActiveProvider | undefined = draftSettings.activeProvider;
  const visibleLocalModelProfiles = useMemo(
    () => userManagedLocalModelProfiles.filter((profile) => {
      if (!isCodexAutoProfile(profile)) return true;
      // Hide auto profiles when a usable connection-managed sibling exists —
      // showing both produces the "three same-model entries" picker confusion
      // documented in the 260521 BTS Haiku-fallback investigation. When no
      // sibling exists (e.g. before the user has materialised a connection
      // catalog row) we still need to surface the auto profile while the
      // ChatGPT Pro provider is active so the picker has something to render.
      if (isAutoProfileShadowedBySibling(profile, userManagedLocalModelProfiles)) return false;
      return activeProvider === 'codex';
    }),
    [activeProvider, userManagedLocalModelProfiles]
  );
  const hasOrToken = !!draftSettings.openRouter?.oauthToken;
  const isAnthropicActive = activeProvider === 'anthropic';
  const isCodexActive = activeProvider === 'codex';
  const isOpenRouterActive = activeProvider === 'openrouter';
  const hasAnthropicCredentials = !!modelSettings.apiKey;
  const canSelectOpenRouter = !!draftSettings.openRouter?.oauthToken;
  const canSelectAnthropic = hasAnthropicCredentials;
  // Codex OAuth state
  const [codexStatus, setCodexStatus] = useState<{ connected: boolean; accountEmail?: string }>({ connected: false });
  const [codexLoading, setCodexLoading] = useState(false);
  const [codexError, setCodexError] = useState<string | null>(null);
  const profileConnectivity = useProfileConnectivity({
    settings: draftSettings,
    codexConnected: codexStatus.connected,
  });
  const hasMaterialisedCodexProfile = useMemo(
    () => userManagedLocalModelProfiles.some((profile) =>
      isConnectionManagedProfile(profile) &&
      profile.providerType === 'openai' &&
      (profile.routeSurface === 'subscription' || profile.authSource === 'codex-subscription')),
    [userManagedLocalModelProfiles],
  );
  const hasMaterialisedOpenRouterProfile = useMemo(
    () => userManagedLocalModelProfiles.some((profile) =>
      isConnectionManagedProfile(profile) && profile.providerType === 'openrouter'),
    [userManagedLocalModelProfiles],
  );
  const codexNeedsReconnect = !codexStatus.connected && hasMaterialisedCodexProfile;
  const openRouterNeedsReconnect = !hasOrToken && hasMaterialisedOpenRouterProfile;
  const thinkingModelChoiceOptions = useMemo(
    () => buildModelChoiceOptions({
      role: 'thinking',
      settings: draftSettings,
      activeProvider,
      hasAnthropicCredentials,
      hasOpenRouterCredentials: hasOpenRouterCredentials(draftSettings),
      managedAllowedModels,
      profileFilter: (profile) => !!profile.model?.trim() && isProfileFunctional(profile, profileConnectivity),
    }),
    [activeProvider, draftSettings, hasAnthropicCredentials, managedAllowedModels, profileConnectivity],
  );
  const workingModelChoiceOptions = useMemo(
    () => buildModelChoiceOptions({
      role: 'working',
      settings: draftSettings,
      activeProvider,
      hasAnthropicCredentials,
      hasOpenRouterCredentials: hasOpenRouterCredentials(draftSettings),
      managedAllowedModels,
      profileFilter: (profile) => !!profile.model?.trim() && isProfileFunctional(profile, profileConnectivity),
    }),
    [activeProvider, draftSettings, hasAnthropicCredentials, managedAllowedModels, profileConnectivity],
  );
  const recoveryModelChoiceOptions = useMemo(
    () => buildModelChoiceOptions({
      role: 'recovery',
      settings: draftSettings,
      activeProvider,
      hasAnthropicCredentials,
      hasOpenRouterCredentials: hasOpenRouterCredentials(draftSettings),
      managedAllowedModels,
      profileFilter: (profile) => !!profile.model?.trim() && isProfileFunctional(profile, profileConnectivity),
    }),
    [activeProvider, draftSettings, hasAnthropicCredentials, managedAllowedModels, profileConnectivity],
  );
  const backgroundModelChoiceOptions = useMemo(
    () => buildModelChoiceOptions({
      role: 'background',
      settings: draftSettings,
      activeProvider,
      hasAnthropicCredentials,
      hasOpenRouterCredentials: hasOpenRouterCredentials(draftSettings),
      managedAllowedModels,
      profileFilter: (profile) => !!profile.model?.trim() && isProfileFunctional(profile, profileConnectivity),
    }),
    [activeProvider, draftSettings, hasAnthropicCredentials, managedAllowedModels, profileConnectivity],
  );

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [btsDetailsOpen, setBtsDetailsOpen] = useFirstRenderOpenState(BTS_DETAILS_OPEN_STATE_OPTIONS);
  const [showClaudeMaxSetup, setShowClaudeMaxSetup] = useState(false);
  const [showAnthropicKeyInput, setShowAnthropicKeyInput] = useState(false);
  const [roleModelRequest, setRoleModelRequest] = useState<RoleModelRequest | null>(null);
  const [inlineRoleTestState, setInlineRoleTestState] = useState<Partial<Record<RoleId, InlineRoleTestStateEntry>>>({});
  const inlineRoleTestRequestIdsRef = useRef<Map<RoleId, number>>(new Map());
  const mountedRef = useRef(true);

  // API key validation state
  // Uses request IDs to guard against stale responses from overlapping validations
  const [isValidatingClaude, setIsValidatingClaude] = useState(false);
  const [claudeValidationMessage, setClaudeValidationMessage] = useState<string | null>(null);
  const [claudeValidationOk, setClaudeValidationOk] = useState<boolean | null>(null);
  const claudeRequestIdRef = useRef(0);
  const lastValidatedClaudeKeyRef = useRef<string | null>(null);

  const visibleRoutableProfiles = useMemo(
    // Keep role pickers open to all selectable profiles, but drop connection-
    // managed profiles whose source connection is currently unavailable.
    () => visibleLocalModelProfiles.filter(profile =>
      !!profile.model?.trim() && isProfileFunctional(profile, profileConnectivity)),
    [profileConnectivity, visibleLocalModelProfiles]
  );

  const roleAssignments = useMemo(
    () => resolveAllRoleAssignments(draftSettings, {
      profiles: visibleLocalModelProfiles,
      activeProvider,
      codexConnected: codexStatus.connected,
      connectivity: profileConnectivity,
    }),
    [activeProvider, codexStatus.connected, draftSettings, profileConnectivity, visibleLocalModelProfiles],
  );
  const longContextFallbackChoice = useMemo<ModelChoice>(
    () => roleAssignments.recovery.primary.kind === 'auto'
      ? { kind: 'off' }
      : roleAssignments.recovery.primary,
    [roleAssignments.recovery.primary],
  );
  const recoveryFallbackWarning = recoverySecondaryFallbackWarning(roleAssignments.recovery.status);
  const [modelTeamOpen, setModelTeamOpen] = useState(() => {
    const adaptiveRoutingEnabled = draftSettings.experimental?.adaptiveRoutingEnabled === true;
    const teamHasMembers = (
      getRoutingEligibleProfiles(draftSettings).length +
      getCouncilProfiles(draftSettings).length
    ) > 0;
    return adaptiveRoutingEnabled || teamHasMembers;
  });
  const modelTeamSummaryLine = useMemo(() => {
    const adaptiveRoutingEnabled = draftSettings.experimental?.adaptiveRoutingEnabled === true;
    const routingProfiles = getRoutingEligibleProfiles(draftSettings);
    const councilProfiles = getCouncilProfiles(draftSettings);
    const benchProfileIds = new Set<string>();
    for (const profile of routingProfiles) benchProfileIds.add(profile.id);
    for (const profile of councilProfiles) benchProfileIds.add(profile.id);
    const benchCount = benchProfileIds.size;
    if (adaptiveRoutingEnabled) {
      return `Smart model picking on · ${routingProfiles.length} ${pluralizeModel(routingProfiles.length)} · Council: ${councilProfiles.length}`;
    }
    return benchCount > 0
      ? `Smart model picking off · ${benchCount} ${pluralizeModel(benchCount)} on bench`
      : 'Smart model picking off · Just your main model';
  }, [draftSettings]);
  const handleRoleStatusCtaClick = useCallback((assignment: RoleAssignment) => {
    const status = assignment.status;
    const hint = status.kind === 'incomplete-profile'
      ? 'finish-setup'
      : status.kind === 'profile-unavailable-model-active'
        ? 'review-profile'
        : 'pick';
    setRoleModelRequest({
      nonce: Date.now(),
      role: assignment.role,
      hint,
      profileId:
        status.kind === 'incomplete-profile'
          || status.kind === 'missing-profile'
          || status.kind === 'profile-unavailable-model-active'
          ? status.profileId
          : undefined,
    });
  }, []);
  const handleRecoveryWarningCtaClick = useCallback(() => {
    const picker = document.getElementById(RECOVERY_FALLBACK_PICKER_ID);
    picker?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    picker?.focus();
  }, []);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleInlineRoleTest = useCallback(async (choice: ModelChoice, assignment: RoleAssignment): Promise<TestResult> => {
    if (choice.kind !== 'model') {
      return { success: false, error: 'There is no specific model to test for this choice.' };
    }

    const role = assignment.role;
    const modelKey = choiceToPickerValue(choice);
    const requestId = (inlineRoleTestRequestIdsRef.current.get(role) ?? 0) + 1;
    inlineRoleTestRequestIdsRef.current.set(role, requestId);
    setInlineRoleTestState((prev) => ({ ...prev, [role]: { testing: true, modelKey } }));

    let result: TestResult;
    try {
      result = await window.settingsApi.testModelChoice({
        role,
        choice,
        settings: draftSettings,
      });
    } catch (error) {
      result = {
        success: false,
        error: error instanceof Error && error.message.trim().length > 0
          ? error.message
          : 'Model test failed.',
      };
    }

    if (!mountedRef.current) {
      return result;
    }

    if (inlineRoleTestRequestIdsRef.current.get(role) === requestId) {
      setInlineRoleTestState((prev) => ({ ...prev, [role]: { testing: false, result, modelKey } }));
    }
    return result;
  }, [draftSettings]);

  useEffect(() => {
    const refreshCodexStatus = () => {
      window.codexApi?.status().then(setCodexStatus).catch(() => {});
    };

    refreshCodexStatus();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshCodexStatus();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const canSelectCodex = codexStatus.connected;

  const applyModelState = useCallback((nextModels: Partial<ModelSettings>) => {
    for (const key of Object.keys(nextModels) as Array<keyof ModelSettings>) {
      if (Object.is(modelSettings[key], nextModels[key])) {
        continue;
      }
      updateClaude(key, nextModels[key] as ModelSettings[typeof key]);
    }
  }, [modelSettings, updateClaude]);

  const applyPlanUpdates = useCallback((updates: SettingsPlanUpdates) => {
    for (const [key, value] of Object.entries(updates) as Array<[keyof AppSettings, AppSettings[keyof AppSettings]]>) {
      if (key === 'models') {
        applyModelState(value as ModelSettings);
        continue;
      }
      updateDraft(key, value as never);
    }
  }, [applyModelState, updateDraft]);

  const applyRoleChoice = useCallback((role: RoleId, choice: ModelChoice) => {
    const encoding = encodeRoleChoice(role, choice);
    applyPlanUpdates(
      encoding.scope === 'models'
        ? { models: encoding.fields as AppSettings['models'] }
        : encoding.fields,
    );

    if (role === 'working' && choice.kind === 'model') {
      updateDraft('localModel', {
        ...(draftSettings.localModel ?? DEFAULT_LOCAL_MODEL_SETTINGS),
        activeProfileId: null,
      });
    }
  }, [applyPlanUpdates, draftSettings.localModel, updateDraft]);

  const applyRoleFallback = useCallback((role: RoleId, choice: ModelChoice | null) => {
    const encoding = encodeRoleFallback(role, choice);
    applyPlanUpdates(
      encoding.scope === 'models'
        ? { models: encoding.fields as AppSettings['models'] }
        : encoding.fields,
    );
  }, [applyPlanUpdates]);

  const handleProfilesChange = useCallback((profiles: ModelProfile[]) => {
    const nextProfiles = [
      ...profiles,
      ...localModelProfiles.filter(profile => profile.isVirtual),
    ];
    const nextLocalModel = { ...(draftSettings.localModel ?? DEFAULT_LOCAL_MODEL_SETTINGS), profiles: nextProfiles };
    updateDraft('localModel', nextLocalModel);
    applyPlanUpdates(cleanupOrphanedProfileReferences({
      ...draftSettings,
      localModel: nextLocalModel,
    }, nextProfiles));
  }, [applyPlanUpdates, draftSettings, localModelProfiles, updateDraft]);

  const handleAddModelToTeam = useCallback(() => {
    setRoleModelRequest({
      nonce: Date.now(),
      role: 'working',
      hint: 'pick',
    });
  }, []);

  const handleOpenTeamProfileManager = useCallback((profileId: string) => {
    setRoleModelRequest({
      nonce: Date.now(),
      role: 'working',
      hint: 'finish-setup',
      profileId,
    });
  }, []);

  const mergePlanUpdates = useCallback((updates: Partial<AppSettings>): AppSettings => {
    const mergedModels = updates.models;
    return {
      ...draftSettings,
      ...updates,
      ...(mergedModels ? { models: mergedModels as AppSettings['models'] } : {}),
      ...(updates.localModel !== undefined ? { localModel: updates.localModel as AppSettings['localModel'] } : {}),
      ...(updates.openRouter !== undefined ? { openRouter: updates.openRouter as AppSettings['openRouter'] } : {}),
      ...(updates.providerKeys !== undefined ? { providerKeys: updates.providerKeys } : {}),
    };
  }, [draftSettings]);

  const focusAiModelsSection = useCallback(() => {
    const target = document.querySelector<HTMLElement>(
      '[data-section="providerKeys"] [data-section-focus-target], [data-section="providerKeys"]'
    );
    if (!target) {
      return;
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (typeof target.focus === 'function') {
      target.focus();
    }
  }, []);

  const onProviderChange = useCallback((to: ActiveProvider) => {
    if (draftSettings.activeProvider === to) {
      return;
    }

    const plan = planProviderSwitch({
      to,
      settings: draftSettings,
      codexConnected: codexStatus.connected,
      managedDefaults: managedDefaultModels,
    });

    applyPlanUpdates(plan.updates);

    // Persist the provider switch immediately rather than relying on the 800ms
    // auto-save debounce. Two reasons:
    //  - Codex tokens live in a separate encrypted store, so there's no
    //    main-process updateSettings() that durably saves the switch otherwise.
    //  - More importantly, the debounce leaves a window where a /api/config
    //    refresh (e.g. SubscriptionSection's mount → requestServerRefresh) runs
    //    the managed-provider reconcile and clobbers the draft before it saves —
    //    the "switch reverts to Mindstone" bug. Writing the switch (incl. the
    //    managedProviderDeactivated opt-out marker) immediately closes that race.
    void window.settingsApi.update(mergePlanUpdates(plan.updates));

    const providerName = formatActiveProviderLabel(to);
    const keptCount = plan.preservedSlots.length;
    const clearedCount = plan.clearedSlots.length;
    const title =
      keptCount === 0 && clearedCount === 0
        ? `Switched to ${providerName}.`
        : `Switched to ${providerName}. Kept ${keptCount} fallback${keptCount === 1 ? '' : 's'}. Cleared ${clearedCount} that couldn't route.`;

    showToast({
      title,
      action: {
        label: 'Review',
        onClick: focusAiModelsSection,
      },
    });
  }, [applyPlanUpdates, codexStatus.connected, draftSettings, focusAiModelsSection, managedDefaultModels, mergePlanUpdates, showToast]);

  const handleCodexConnect = useCallback(async () => {
    setCodexLoading(true);
    setCodexError(null);
    try {
      const result = await window.codexApi.login();
      if (result.success) {
        setCodexStatus({ connected: true, accountEmail: result.email });
        onProviderChange('codex');
      } else {
        setCodexError(result.error ?? "Couldn't connect. Please try again.");
      }
    } catch {
      setCodexError("Couldn't connect. Please try again.");
    } finally {
      setCodexLoading(false);
    }
  }, [onProviderChange]);

  const handleCodexDisconnect = useCallback(async () => {
    try {
      await window.codexApi.logout();
      setCodexStatus({ connected: false });
      setCodexError(null);

      if (draftSettings.activeProvider === 'codex') {
        const fallback = pickFallbackProvider({
          disconnecting: 'codex',
          hasAnthropicKey: !!modelSettings.apiKey,
          hasOpenRouterToken: !!draftSettings.openRouter?.oauthToken,
          codexConnected: false,
        });
        if (fallback) {
          // Call planProviderSwitch directly with codexConnected=false to avoid
          // stale closure (codexStatus.connected hasn't re-rendered yet).
          const plan = planProviderSwitch({
            to: fallback,
            settings: draftSettings,
            codexConnected: false,
            managedDefaults: managedDefaultModels,
          });
          applyPlanUpdates(plan.updates);
        } else {
          updateDraft('activeProvider', undefined as never);
        }
      }
    } catch {
      // Ignore disconnect errors
    }
  }, [applyPlanUpdates, draftSettings, managedDefaultModels, modelSettings.apiKey, updateDraft]);

  // OpenRouter OAuth state
  const orSetup = useOpenRouterSetup(hasOrToken);

  // Auto-select OpenRouter when OAuth completes. The mount-guard ref prevents
  // auto-switching on initial render for users who have an existing OR token
  // but chose a different active provider.
  const orAutoSelectGuardRef = useRef(hasOrToken);
  useEffect(() => {
    if (orAutoSelectGuardRef.current) return;
    if (orSetup.phase === 'success' && hasOrToken && draftSettings.activeProvider !== 'openrouter') {
      onProviderChange('openrouter');
    }
    if (orSetup.phase === 'success' && hasOrToken) {
      orAutoSelectGuardRef.current = true;
    }
  }, [orSetup.phase, hasOrToken, draftSettings.activeProvider, onProviderChange]);

  const [showOrPrivacy, setShowOrPrivacy] = useState(false);

  const handleOrConnect = useCallback(() => {
    if (hasOrToken) return;
    setShowOrPrivacy(true);
  }, [hasOrToken]);

  const handleOrPrivacyAccept = useCallback(() => {
    setShowOrPrivacy(false);
    void orSetup.handleConnect();
  }, [orSetup]);

  const handleOrDisconnect = useCallback(async () => {
    const disconnectedOpenRouter = {
      ...(draftSettings.openRouter ?? DEFAULT_OPENROUTER_SETTINGS),
      enabled: false,
      oauthToken: null,
    } as AppSettings['openRouter'];

    const needsSwitch = draftSettings.activeProvider === 'openrouter';
    const targetProvider = needsSwitch
      ? pickFallbackProvider({
          disconnecting: 'openrouter',
          hasAnthropicKey: !!modelSettings.apiKey,
          hasOpenRouterToken: false,
          codexConnected: codexStatus.connected,
        })
      : draftSettings.activeProvider;

    // Update draft BEFORE the async IPC call. Any pending auto-save that fires
    // during the await would otherwise write the old oauthToken back to the main
    // process, undoing the disconnect (the auto-save response then overwrites
    // draftSettingsRef, permanently restoring the token).
    updateDraft('openRouter', disconnectedOpenRouter);

    if (targetProvider) {
      const switchSourceSettings: AppSettings = {
        ...draftSettings,
        activeProvider: draftSettings.activeProvider === targetProvider ? undefined : draftSettings.activeProvider,
        openRouter: disconnectedOpenRouter,
      };
      const plan = planProviderSwitch({
        to: targetProvider,
        settings: switchSourceSettings,
        codexConnected: codexStatus.connected,
        managedDefaults: managedDefaultModels,
      });
      applyPlanUpdates(plan.updates);
    } else {
      updateDraft('activeProvider', undefined as never);
    }

    // Reset the auto-select guard so reconnecting OR in the same session auto-selects
    orAutoSelectGuardRef.current = false;
    await orSetup.handleDisconnect();
  }, [applyPlanUpdates, codexStatus.connected, draftSettings, managedDefaultModels, modelSettings.apiKey, orSetup, updateDraft]);

  // Custom provider state
  const customProviders = useMemo(() => draftSettings.customProviders ?? [], [draftSettings.customProviders]);
  const [editingProvider, setEditingProvider] = useState<CustomProvider | null>(null);
  const [addingProvider, setAddingProvider] = useState(false);
  const [deleteProviderConfirm, setDeleteProviderConfirm] = useState<string | null>(null);

  const generateProviderId = () => `provider-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  const handleSaveProvider = useCallback((provider: CustomProvider) => {
    const existing = customProviders.find(p => p.id === provider.id);
    const updated = existing
      ? customProviders.map(p => p.id === provider.id ? provider : p)
      : [...customProviders, provider];
    updateDraft('customProviders', updated);
    setEditingProvider(null);
    setAddingProvider(false);
  }, [customProviders, updateDraft]);

  const handleDeleteProvider = useCallback((providerId: string) => {
    updateDraft('customProviders', customProviders.filter(p => p.id !== providerId));
    setDeleteProviderConfirm(null);
  }, [customProviders, updateDraft]);

  // Validation callbacks using request IDs to guard against stale responses
  const validateClaudeKey = useCallback(async (apiKey: string | null | undefined) => {
    const key = apiKey ? sanitizeApiKey(apiKey) : '';
    if (!key) {
      setClaudeValidationMessage(null);
      setClaudeValidationOk(null);
      return;
    }
    // Skip if we already validated this exact key
    if (lastValidatedClaudeKeyRef.current === key && claudeValidationOk !== null) {
      return;
    }
    // Increment request ID to invalidate any in-flight requests
    const requestId = ++claudeRequestIdRef.current;
    setIsValidatingClaude(true);
    setClaudeValidationMessage('Validating...');
    setClaudeValidationOk(null);
    try {
      const result = await window.settingsApi.validateClaudeKey({ apiKey: key });
      // Guard against stale response using request ID
      if (requestId !== claudeRequestIdRef.current) return;
      lastValidatedClaudeKeyRef.current = key;
      setClaudeValidationMessage(result.ok ? 'Claude key is valid.' : result.message || 'Claude key validation failed.');
      setClaudeValidationOk(result.ok);
      if (result.ok) {
        if (draftSettings.activeProvider !== 'anthropic') {
          onProviderChange('anthropic');
        }
        setTimeout(() => {
          if (requestId === claudeRequestIdRef.current) {
            setShowAnthropicKeyInput(false);
          }
        }, 1500);
      }
    } catch (error: unknown) {
      if (requestId !== claudeRequestIdRef.current) return;
      const message = error instanceof Error ? redactSensitiveString(error.message) : 'Validation failed.';
      setClaudeValidationMessage(message);
      setClaudeValidationOk(false);
    } finally {
      // Only clear loading state if this is still the latest request
      if (requestId === claudeRequestIdRef.current) {
        setIsValidatingClaude(false);
      }
    }
  }, [claudeValidationOk, draftSettings.activeProvider, onProviderChange]);

  const isMindstoneActive = activeProvider === 'mindstone';
  // Whether the currently-selected active provider has valid credentials.
  // Used to gate the Backup connections section — backups presuppose a working
  // main connection, so we hide the section until the main is connected.
  // Reuses isProviderConnected from BackupConnectionsSection (single source of truth).
  const isActiveProviderConnected = activeProvider != null
    && isProviderConnected(draftSettings, codexStatus.connected, activeProvider);
  const { subscription: subState } = useSubscriptionState();

  const activeProviderLabel = isMindstoneActive
    ? subState ? `Mindstone ${TIER_LABEL[subState.tier]}` : 'Mindstone'
    : isCodexActive
      ? 'ChatGPT Pro'
      : isOpenRouterActive
        ? 'OpenRouter'
        : isAnthropicActive
          ? 'Anthropic'
          : null;

  return (
  <>
    <SettingSection
      title="AI provider"
      description="Choose how Rebel gets its AI. You can connect more than one, but only one is used at a time."
      data-section="providerKeys"
    >
      {activeProviderLabel && (
        <p className={styles.subscriptionRoutingHint} data-testid="settings-active-provider-summary">
          In use: <strong>{activeProviderLabel}</strong>
        </p>
      )}

      <div className={styles.subscriptionGroup}>
        <h3 className={styles.subscriptionGroupHeading}>Let Mindstone handle it</h3>
        <p className={styles.subscriptionGroupSubheading}>
          No API keys, no separate AI accounts. Powered by OpenRouter.
        </p>
        <SubscriptionSection
          embedded
          isMindstoneActive={isMindstoneActive}
          onSelectMindstone={() => onProviderChange('mindstone')}
        />
      </div>

      <div className={styles.subscriptionDivider}>
        <span className={styles.subscriptionDividerLabel}>or bring your own AI</span>
      </div>

      <div className={styles.providerCardGrid} role="listbox" aria-label="AI provider">
        {/* ChatGPT Pro — recommended */}
        <div
          className={`${styles.providerCard} ${isCodexActive ? styles.providerCardSelected : ''}`}
          onClick={() => {
            if (canSelectCodex && !isCodexActive) onProviderChange('codex');
          }}
          role="option"
          aria-selected={isCodexActive}
          tabIndex={0}
          data-section="codex"
        >
          <div className={styles.providerCardHeader}>
            <OpenAILogo size={20} className={styles.providerCardIcon} />
            <Tooltip
              content="ChatGPT Pro is OpenAI's $200/month subscription that includes unlimited access to their most capable models. If you already have a Pro account, you can connect it here at no extra cost."
              maxWidth="280px"
            >
              <span className={styles.providerCardTitle}>ChatGPT Pro</span>
            </Tooltip>
            <span className={styles.providerCardRecommended}>(recommended)</span>
          </div>
          <div className={styles.providerCardBody}>
            <p className={styles.providerCardDescription}>
              Use your existing ChatGPT Pro subscription ($200/month) to power Rebel with OpenAI&apos;s best models. No extra API costs.
            </p>
          </div>
          <div className={styles.providerCardFooter}>
            <div className={styles.providerCardFooterLeft}>
              {codexStatus.connected ? (
                <button
                  type="button"
                  className={styles.providerCardDisconnectLink}
                  onClick={(e) => { e.stopPropagation(); void handleCodexDisconnect(); }}
                  data-testid="settings-codex-disconnect-button"
                >
                  Disconnect
                </button>
              ) : (
                <a
                  href="https://chatgpt.com/pricing"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.providerCardFooterLink}
                  onClick={(e) => e.stopPropagation()}
                >
                  Create a Pro account
                </a>
              )}
            </div>
            <div className={styles.providerCardFooterRight} onClick={(e) => e.stopPropagation()}>
              {codexStatus.connected ? (
                <Tooltip
                  content={codexStatus.accountEmail ? `Connected as ${codexStatus.accountEmail}` : 'Connected to ChatGPT Pro'}
                  placement="top"
                >
                  <span className={styles.providerCardConnectedBadge}>
                    <Check size={12} aria-hidden />
                    Connected
                  </span>
                </Tooltip>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(e: React.MouseEvent) => { e.stopPropagation(); void handleCodexConnect(); }}
                  disabled={codexLoading}
                  data-testid="settings-codex-connect-button"
                  className={styles.providerCardConnectBtn}
                >
                  {codexLoading && <Loader2 size={12} className={styles.spinnerIcon} />}
                  {codexLoading ? 'Connecting...' : 'Connect'}
                </Button>
              )}
            </div>
            {codexError && (
              <p className={styles.errorMessage} style={{ margin: 0, fontSize: '0.72rem', gridColumn: '1 / -1' }}>{codexError}</p>
            )}
          </div>
        </div>

        {/* OpenRouter */}
        <div
          className={`${styles.providerCard} ${isOpenRouterActive ? styles.providerCardSelected : ''}`}
          onClick={() => {
            if (canSelectOpenRouter && !isOpenRouterActive) onProviderChange('openrouter');
          }}
          role="option"
          aria-selected={isOpenRouterActive}
          tabIndex={0}
          data-section="openrouter"
        >
          <div className={styles.providerCardHeader}>
            <OpenRouterLogo size={20} className={styles.providerCardIcon} />
            <Tooltip
              content="OpenRouter is a service that gives you access to AI models from multiple providers (Anthropic, Google, OpenAI) through a single account. It handles billing across all of them."
              maxWidth="280px"
            >
              <span className={styles.providerCardTitle}>OpenRouter</span>
            </Tooltip>
          </div>
          <div className={styles.providerCardBody}>
            <p className={styles.providerCardDescription}>
              Access Claude, GPT, Gemini, and other models through one account. OpenRouter handles billing for all providers in one place.
              {' '}
              <Tooltip
                content="If your company uses an OpenRouter organization, switch to that organization in OpenRouter before connecting here. This ensures billing goes to your company account."
                maxWidth="280px"
              >
                <span className={styles.apiKeyQuestion}>Company account?</span>
              </Tooltip>
            </p>
            {hasOrToken && (
              <div className={styles.providerCardHelpLinks}>
                <span className={styles.providerCardStepsLabel}>Next steps:</span>
                <a
                  href="https://openrouter.ai/credits"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.providerCardFooterLink}
                  onClick={(e) => e.stopPropagation()}
                >
                  1. Add credits to your account
                </a>
                <a
                  href="https://openrouter.ai/settings/credits"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.providerCardFooterLink}
                  onClick={(e) => e.stopPropagation()}
                >
                  2. Set up auto top-up (optional)
                </a>
              </div>
            )}
          </div>
          <div className={styles.providerCardFooter}>
            <div className={styles.providerCardFooterLeft}>
              {hasOrToken ? (
                <button
                  type="button"
                  className={styles.providerCardDisconnectLink}
                  onClick={(e) => { e.stopPropagation(); void handleOrDisconnect(); }}
                  data-testid="settings-openrouter-disconnect-button"
                >
                  Disconnect
                </button>
              ) : (
                <a
                  href="https://openrouter.ai/docs/faq"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.providerCardFooterLink}
                  onClick={(e) => e.stopPropagation()}
                >
                  Learn more
                </a>
              )}
            </div>
            <div className={styles.providerCardFooterRight} onClick={(e) => e.stopPropagation()}>
              {hasOrToken ? (
                <span className={styles.providerCardConnectedBadge}>
                  <Check size={12} aria-hidden />
                  Connected
                </span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleOrConnect(); }}
                  disabled={orSetup.isLoading}
                  data-testid="settings-openrouter-connect-button"
                  className={styles.providerCardConnectBtn}
                >
                  {orSetup.isLoading && <Loader2 size={12} className={styles.spinnerIcon} />}
                  {orSetup.buttonLabel}
                </Button>
              )}
            </div>
            {orSetup.isLoading && (
              <button
                type="button"
                className={styles.providerCardDisconnectLink}
                onClick={(e) => { e.stopPropagation(); orSetup.handleCancel(); }}
                data-testid="settings-openrouter-cancel-button"
                style={{ gridColumn: '1 / -1', justifySelf: 'end' }}
              >
                Cancel
              </button>
            )}
            {orSetup.error && (
              <p className={styles.errorMessage} style={{ margin: 0, fontSize: '0.72rem', gridColumn: '1 / -1' }}>{orSetup.error}</p>
            )}
            {orSetup.waitingMessage && (
              <p className={styles.connectionCardHint} style={{ gridColumn: '1 / -1' }}>{orSetup.waitingMessage}</p>
            )}
            {orSetup.phase === 'waiting' && (
              <Button
                variant="outline"
                size="sm"
                onClick={(e: React.MouseEvent) => { e.stopPropagation(); orSetup.handleRetry(); }}
                data-testid="settings-openrouter-retry-button"
                className={styles.providerCardConnectBtn}
                style={{ gridColumn: '1 / -1', justifySelf: 'end' }}
              >
                Try again
              </Button>
            )}
          </div>
        </div>

        {/* Anthropic */}
        <div
          className={`${styles.providerCard} ${isAnthropicActive ? styles.providerCardSelected : ''}`}
          onClick={() => {
            if (canSelectAnthropic && !isAnthropicActive) onProviderChange('anthropic');
          }}
          role="option"
          aria-selected={isAnthropicActive}
          tabIndex={0}
          data-section="apiKey"
        >
          <div className={styles.providerCardHeader}>
            <AnthropicLogo size={20} className={styles.providerCardIcon} />
            <Tooltip
              content="Anthropic makes Claude, one of the most capable AI models. With an API key, you connect directly to Anthropic and pay per use based on how much you use Rebel."
              maxWidth="280px"
            >
              <span className={styles.providerCardTitle}>Anthropic</span>
            </Tooltip>
          </div>
          <div className={styles.providerCardBody}>
            <p className={styles.providerCardDescription}>
              Connect directly to Claude with an API key. You pay per use based on how much you use Rebel.{' '}
              <Tooltip
                content="An API key is a unique passcode from Anthropic that lets Rebel access Claude on your behalf. You paste it here once and Rebel handles the rest."
                maxWidth="260px"
              >
                <span className={styles.apiKeyQuestion}>What is an API key?</span>
              </Tooltip>
            </p>
          </div>
          <div className={styles.providerCardFooter}>
            {modelSettings.apiKey && !showAnthropicKeyInput ? (
              <>
                <div className={styles.providerCardFooterLeft}>
                  <button
                    type="button"
                    className={styles.providerCardDisconnectLink}
                    onClick={(e) => {
                      e.stopPropagation();
                      updateClaude('apiKey', null);
                      markKeySticky('claude');
                      markKeySticky('models');
                      setClaudeValidationMessage(null);
                      setClaudeValidationOk(null);
                      setShowAnthropicKeyInput(false);
                      lastValidatedClaudeKeyRef.current = null;

                      if (draftSettings.activeProvider === 'anthropic') {
                        const fallback = pickFallbackProvider({
                          disconnecting: 'anthropic',
                          hasAnthropicKey: false,
                          hasOpenRouterToken: !!draftSettings.openRouter?.oauthToken,
                          codexConnected: codexStatus.connected,
                        });
                        if (fallback) {
                          // Call planProviderSwitch directly with apiKey=null to avoid
                          // stale closure (modelSettings.apiKey hasn't re-rendered yet).
                          const correctedSettings = {
                            ...draftSettings,
                            models: { ...modelSettings, apiKey: null } as AppSettings['models'],
                          };
                          const plan = planProviderSwitch({
                            to: fallback,
                            settings: correctedSettings,
                            codexConnected: codexStatus.connected,
                            managedDefaults: managedDefaultModels,
                          });
                          applyPlanUpdates(plan.updates);
                        } else {
                          updateDraft('activeProvider', undefined as never);
                        }
                      }
                    }}
                    data-testid="settings-claude-remove-key-button"
                  >
                    Remove
                  </button>
                </div>
                <div className={styles.providerCardFooterRight}>
                  <span className={styles.providerCardConnectedBadge}>
                    <Check size={12} aria-hidden />
                    Key added
                  </span>
                </div>
              </>
            ) : showAnthropicKeyInput ? (
              <div className={styles.providerCardKeyInputExpanded} onClick={(e) => e.stopPropagation()}>
                <div className={styles.providerCardKeyRow}>
                  <input
                    id="claude-api-key"
                    data-testid="settings-claude-api-key-input"
                    type="text"
                    inputMode="text"
                    autoComplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                    data-form-type="other"
                    value={modelSettings.apiKey ?? ''}
                    onChange={(event) => {
                      const sanitized = sanitizeApiKey(event.currentTarget.value) || null;
                      updateClaude('apiKey', sanitized);
                      updateClaude('authMethod', 'api-key');
                      if (sanitized !== lastValidatedClaudeKeyRef.current) {
                        setClaudeValidationMessage(null);
                        setClaudeValidationOk(null);
                        claudeRequestIdRef.current += 1;
                      }
                    }}
                    onBlur={() => void validateClaudeKey(modelSettings.apiKey)}
                    placeholder="sk-ant-..."
                    autoFocus
                    style={{ WebkitTextSecurity: 'disc' } as React.CSSProperties}
                  />
                </div>
                <div className={styles.providerCardKeyInputHelp}>
                  <a
                    href="https://console.anthropic.com/settings/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.providerCardFooterLink}
                  >
                    Get API key
                  </a>
                  <span className={styles.providerCardFooterLinkDot}>·</span>
                  <button
                    type="button"
                    className={styles.providerCardFooterLink}
                    onClick={() => setShowClaudeMaxSetup(true)}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                  >
                    Setup guide
                  </button>
                </div>
                {claudeValidationMessage && !isValidatingClaude && (
                  <p className={claudeValidationOk ? styles.successMessage : styles.errorMessage} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.72rem', margin: 0 }}>
                    {claudeValidationOk ? <Check size={12} /> : null}
                    {claudeValidationMessage}
                  </p>
                )}
              </div>
            ) : (
              <>
                <div className={styles.providerCardFooterLeft}>
                  <button
                    type="button"
                    className={styles.providerCardFooterLink}
                    onClick={(e) => { e.stopPropagation(); setShowClaudeMaxSetup(true); }}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                  >
                    Setup guide
                  </button>
                </div>
                <div className={styles.providerCardFooterRight}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); setShowAnthropicKeyInput(true); }}
                    data-testid="settings-claude-add-key-button"
                    className={styles.providerCardConnectBtn}
                  >
                    Add API Key
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <OpenRouterPrivacyModal
        open={showOrPrivacy}
        onAccept={handleOrPrivacyAccept}
        onCancel={() => setShowOrPrivacy(false)}
      />

      <ClaudeMaxSetupDialog
        open={showClaudeMaxSetup}
        onOpenChange={setShowClaudeMaxSetup}
      />

      <SettingSection
        title="Other Providers"
        description="Optional — connect additional AI services for specific features."
        advanced
        defaultExpanded={!!(draftSettings.providerKeys?.openai || draftSettings.providerKeys?.google || draftSettings.providerKeys?.together || draftSettings.providerKeys?.cerebras)}
        data-section="otherProviders"
      >
        <SettingRow
          label="OpenAI"
          description="Voice, image generation, and GPT models"
          htmlFor="provider-openai-key"
          data-section="openai"
        >
          <input
            id="provider-openai-key"
            data-testid="settings-provider-openai-key-input"
            type="password"
            value={draftSettings.providerKeys?.openai ?? ''}
            onChange={(event) => {
              const sanitized = sanitizeApiKey(event.target.value) || null;
              updateDraft('providerKeys', { ...draftSettings.providerKeys, openai: sanitized });
              updateVoice('openaiApiKey', sanitized);
            }}
            placeholder="sk-..."
          />
        </SettingRow>
        <div style={{ padding: '0 0 4px' }}>
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className={styles.apiKeyTutorialLink} style={{ fontSize: '0.78rem' }}>
            Get API key
          </a>
        </div>

        <SettingRow
          label="Google Gemini"
          description="Image generation and Gemini models"
          htmlFor="provider-google-key"
          data-section="google"
        >
          <input
            id="provider-google-key"
            data-testid="settings-provider-google-key-input"
            type="password"
            value={draftSettings.providerKeys?.google ?? ''}
            onChange={(event) => {
              const sanitized = sanitizeApiKey(event.target.value) || null;
              updateDraft('providerKeys', { ...draftSettings.providerKeys, google: sanitized });
            }}
            placeholder="AIza..."
          />
        </SettingRow>
        <div style={{ padding: '0 0 4px' }}>
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className={styles.apiKeyTutorialLink} style={{ fontSize: '0.78rem' }}>
            Get API key
          </a>
        </div>

        <SettingRow
          label="Together AI"
          description="Open-source models (Llama, DeepSeek)"
          htmlFor="provider-together-key"
          data-section="together"
        >
          <input
            id="provider-together-key"
            type="password"
            value={draftSettings.providerKeys?.together ?? ''}
            onChange={(event) => {
              const sanitized = sanitizeApiKey(event.target.value) || null;
              updateDraft('providerKeys', { ...draftSettings.providerKeys, together: sanitized });
            }}
            placeholder="Your Together API key"
          />
        </SettingRow>
        <div style={{ padding: '0 0 4px' }}>
          <a href="https://api.together.ai/settings/api-keys" target="_blank" rel="noopener noreferrer" className={styles.apiKeyTutorialLink} style={{ fontSize: '0.78rem' }}>
            Get API key
          </a>
        </div>

        <SettingRow
          label="Cerebras"
          description="Ultra-fast inference"
          htmlFor="provider-cerebras-key"
          data-section="cerebras"
        >
          <input
            id="provider-cerebras-key"
            type="password"
            value={draftSettings.providerKeys?.cerebras ?? ''}
            onChange={(event) => {
              const sanitized = sanitizeApiKey(event.target.value) || null;
              updateDraft('providerKeys', { ...draftSettings.providerKeys, cerebras: sanitized });
            }}
            placeholder="Your Cerebras API key"
          />
        </SettingRow>
        <div style={{ padding: '0 0 4px' }}>
          <a href="https://cloud.cerebras.ai/platform" target="_blank" rel="noopener noreferrer" className={styles.apiKeyTutorialLink} style={{ fontSize: '0.78rem' }}>
            Get API key
          </a>
        </div>
      </SettingSection>

      <SettingSection
        title="Custom Providers"
        description="Add your own gateways and OpenAI-compatible endpoints."
        advanced
        defaultExpanded={customProviders.length > 0 || addingProvider}
        data-section="customProviders"
      >
        {customProviders.map((cp) => (
          <div key={cp.id} style={{ marginTop: '8px' }}>
            {editingProvider?.id === cp.id ? (
              <CustomProviderForm
                provider={editingProvider}
                onChange={setEditingProvider}
                onSave={handleSaveProvider}
                onCancel={() => setEditingProvider(null)}
              />
            ) : (
              <SettingRow
                label={cp.name}
                description={cp.serverUrl}
                htmlFor={`custom-provider-${cp.id}`}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <input
                    id={`custom-provider-${cp.id}`}
                    type="password"
                    value={cp.apiKey ?? ''}
                    onChange={(event) => {
                      const sanitized = sanitizeApiKey(event.target.value) || undefined;
                      handleSaveProvider({ ...cp, apiKey: sanitized });
                    }}
                    placeholder="API key"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingProvider({ ...cp })}
                    style={{ padding: '4px', flexShrink: 0 }}
                  >
                    <Pencil size={12} />
                  </Button>
                  {deleteProviderConfirm === cp.id ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteProvider(cp.id)}
                      className={styles.deleteConfirmButton}
                    >
                      Delete?
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteProviderConfirm(cp.id)}
                      style={{ padding: '4px', flexShrink: 0 }}
                    >
                      <Trash2 size={12} />
                    </Button>
                  )}
                </div>
              </SettingRow>
            )}
          </div>
        ))}

        {addingProvider && editingProvider && (
          <div style={{ marginTop: '8px' }}>
            <CustomProviderForm
              provider={editingProvider}
              onChange={setEditingProvider}
              onSave={handleSaveProvider}
              onCancel={() => { setAddingProvider(false); setEditingProvider(null); }}
            />
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' }}>
          {!addingProvider && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const newProvider: CustomProvider = {
                  id: generateProviderId(),
                  name: '',
                  serverUrl: '',
                  createdAt: Date.now(),
                };
                setEditingProvider(newProvider);
                setAddingProvider(true);
              }}
              style={{
                gap: '4px',
                border: '1px solid rgba(139, 92, 246, 0.18)',
                backgroundColor: 'rgba(139, 92, 246, 0.04)',
              }}
            >
              <Plus size={14} />
              Add provider
            </Button>
          )}
          <p style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
            All keys stored locally on your device.
          </p>
        </div>
      </SettingSection>
    </SettingSection>

    {/* Backup connections — Stage 6b, flag-gated (Option B: absent when flag is off).
        Placed directly below the "AI provider" section: providers → backup providers →
        models is the natural reading order, since backups are about which connections
        Rebel falls back to.
        Also hidden when:
          - activeProvider === 'mindstone' (managed subscription is Phase 3, out of scope).
            PROVIDER_META omits 'mindstone', so rendering for a managed-subscription user
            would produce a null head row.
          - The active provider is disconnected. Backup connections presuppose a working
            main connection; the user fixes/switches their main first, then backups become
            available. This eliminates the degenerate-state class (F1) where a connected
            provider outside `enabledProviders` could be hidden by the EmptyState predicate.
            Enforced via isActiveProviderConnected (delegates to isProviderConnected from
            BackupConnectionsSection). The component documents this as its precondition.
        Deliberate: section is fully invisible to production users until Greg promotes
        the flag. See docs/plans/260618_multiprovider-foundation/PLAN.md § Stage 6. */}
    {draftSettings.experimental?.multiProviderRoutingEnabled === true && !isMindstoneActive && isActiveProviderConnected && (
      <BackupConnectionsSection
        draftSettings={draftSettings}
        codexConnected={codexStatus.connected}
        updateDraft={updateDraft}
      />
    )}

    <SettingSection
      title="Available models"
      description="Choose which connected models and profiles Rebel can use."
      data-section="model"
    >
      {draftSettings.experimental?.localInferenceEnabled && (
        <LocalInferenceSection
          draftSettings={draftSettings}
          onSettingsChange={(updates) => {
            for (const [key, value] of Object.entries(updates)) {
              updateDraft(key as keyof AppSettings, value);
            }
          }}
          profiles={visibleLocalModelProfiles}
        />
      )}

      <LocalModelSection
        profiles={userManagedLocalModelProfiles}
        claudeSettings={modelSettings}
        onModelEffortChange={(modelId, effort) => {
          const current = modelSettings.modelEfforts ?? {};
          updateClaude('modelEfforts', { ...current, [modelId]: effort });
        }}
        onProfilesChange={handleProfilesChange}
        providerKeys={draftSettings.providerKeys}
        customProviders={customProviders}
        openRouterConnected={hasOrToken}
        settings={draftSettings}
        codexConnected={codexStatus.connected}
        codexNeedsReconnect={codexNeedsReconnect}
        openRouterNeedsReconnect={openRouterNeedsReconnect}
        profileConnectivity={profileConnectivity}
        roleModelRequest={roleModelRequest}
        workingAssignment={roleAssignments.working}
        onSmartPickingSettingsChange={applyPlanUpdates}
        onSmartPickingAddModel={handleAddModelToTeam}
        onSmartPickingOpenProfileManager={handleOpenTeamProfileManager}
        onReconnectCodex={handleCodexConnect}
        onReconnectOpenRouter={handleOrConnect}
        managedAllowedModels={managedAllowedModels}
        isMindstoneActive={isMindstoneActive}
      />

      {isOpenRouterActive && (
        <p className={styles.modelConfigHint} style={{ marginTop: '4px' }}>
          For OpenRouter model costs,{' '}
          <a
            href="https://openrouter.ai/models"
            target="_blank"
            rel="noopener noreferrer"
            className={styles.apiKeyTutorialLink}
            style={{ fontSize: 'inherit' }}
          >
            click here
          </a>.
        </p>
      )}
    </SettingSection>

    <SettingSection
      title="Model jobs"
      description="Set the main jobs Rebel assigns to models."
      data-section="defaultModelJobs"
    >
      <RoleRow
        role="thinking"
        assignment={roleAssignments.thinking}
        settings={draftSettings}
        codexConnected={codexStatus.connected}
        label="Planner"
        tooltip="An optional separate model used to plan complex tasks before Main work executes them. When off, Rebel skips the separate planning phase and only uses your Main work model."
        htmlFor="thinking-model"
        onChangePrimary={(next) => applyRoleChoice('thinking', next)}
        onChangeFallback={(next) => applyRoleFallback('thinking', next)}
        catalogModels={thinkingModelChoiceOptions.catalogModels}
        additionalModelGroups={thinkingModelChoiceOptions.additionalModelGroups}
        fallbackCatalogModels={thinkingModelChoiceOptions.fallbackCatalogModels}
        additionalFallbackGroups={thinkingModelChoiceOptions.additionalFallbackGroups}
        profiles={visibleRoutableProfiles}
        activeProvider={activeProvider}
        onStatusCtaClick={handleRoleStatusCtaClick}
        onInlineTest={handleInlineRoleTest}
        inlineTestState={inlineRoleTestState.thinking}
      />

      <RoleRow
        role="working"
        assignment={roleAssignments.working}
        settings={draftSettings}
        codexConnected={codexStatus.connected}
        label="Main work"
        tooltip="The main AI model Rebel uses for conversations. This model writes, edits, and responds to your messages."
        htmlFor="claude-model"
        onChangePrimary={(next) => applyRoleChoice('working', next)}
        onChangeFallback={(next) => applyRoleFallback('working', next)}
        catalogModels={workingModelChoiceOptions.catalogModels}
        additionalModelGroups={workingModelChoiceOptions.additionalModelGroups}
        fallbackCatalogModels={workingModelChoiceOptions.fallbackCatalogModels}
        additionalFallbackGroups={workingModelChoiceOptions.additionalFallbackGroups}
        profiles={visibleRoutableProfiles}
        activeProvider={activeProvider}
        onStatusCtaClick={handleRoleStatusCtaClick}
        onInlineTest={handleInlineRoleTest}
        inlineTestState={inlineRoleTestState.working}
        secondaryFallback={{
          label: 'When conversations get long, fall back to:',
          picker: {
            role: 'recovery',
            value: longContextFallbackChoice,
            htmlFor: RECOVERY_FALLBACK_PICKER_ID,
            catalogModels: recoveryModelChoiceOptions.catalogModels,
            additionalModelGroups: recoveryModelChoiceOptions.additionalModelGroups,
            profiles: visibleRoutableProfiles,
            offLabel: 'Off',
          },
          onChange: (next) => applyRoleChoice('recovery', next),
          warning: recoveryFallbackWarning.warning,
          warningCta: recoveryFallbackWarning.warningCta,
          onWarningCtaClick: handleRecoveryWarningCtaClick,
        }}
      />

      <RoleRow
        role="background"
        assignment={roleAssignments.background}
        settings={draftSettings}
        codexConnected={codexStatus.connected}
        label="Behind the Scenes"
        tooltip="Model used for safety checks, memory updates, file indexing, and conversation titles."
        htmlFor="behind-the-scenes-model"
        onChangePrimary={(next) => applyRoleChoice('background', next)}
        onChangeFallback={(next) => applyRoleFallback('background', next)}
        catalogModels={backgroundModelChoiceOptions.catalogModels}
        additionalModelGroups={backgroundModelChoiceOptions.additionalModelGroups}
        fallbackCatalogModels={backgroundModelChoiceOptions.fallbackCatalogModels}
        additionalFallbackGroups={backgroundModelChoiceOptions.additionalFallbackGroups}
        profiles={visibleRoutableProfiles}
        activeProvider={activeProvider}
        onStatusCtaClick={handleRoleStatusCtaClick}
        onInlineTest={handleInlineRoleTest}
        inlineTestState={inlineRoleTestState.background}
      />

      <SettingSection
        advanced
        title="Optional model team"
        description={modelTeamSummaryLine}
        open={modelTeamOpen}
        onOpenChange={setModelTeamOpen}
        data-section="modelTeamDisclosure"
        data-testid="settings-model-team-disclosure"
      >
        <ModelTeamSection
          settings={draftSettings}
          workingAssignment={roleAssignments.working}
          profiles={userManagedLocalModelProfiles}
          onSettingsChange={(updates) => applyPlanUpdates(updates)}
          onProfilesChange={handleProfilesChange}
          onAddModel={handleAddModelToTeam}
          onOpenProfileManager={handleOpenTeamProfileManager}
          managedAllowListState={managedAllowListState}
        />
      </SettingSection>
    </SettingSection>

    <SettingSection
      title="Behind the Scenes details"
      description="Optional per-task overrides for background work."
      advanced
      open={btsDetailsOpen}
      onOpenChange={setBtsDetailsOpen}
      data-section="behindTheScenesDetails"
      data-testid="settings-bts-details-section"
    >
      <BtsTaskOverrides
        settings={draftSettings}
        overrides={draftSettings.behindTheScenesOverrides}
        onOverrideChange={handleBtsOverrideChange}
        localModelProfiles={visibleRoutableProfiles}
        activeProvider={activeProvider}
        codexConnected={codexStatus.connected}
        additionalAuxGroups={isCodexActive ? backgroundModelChoiceOptions.additionalModelGroups : undefined}
      />
    </SettingSection>

    <div className={styles.advancedSection} data-advanced-section data-section="advancedModelOptions">
        <button
          type="button"
          className={styles.advancedToggle}
          data-advanced-toggle
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          <span className={`${styles.advancedChevron} ${showAdvanced ? styles.advancedChevronExpanded : ''}`}>
            ▶
          </span>
          <span className={styles.advancedToggleText}>
            {showAdvanced ? 'Hide' : 'Show'} advanced options
          </span>
        </button>
        {showAdvanced && (
        <div className={styles.advancedContent} data-advanced-content data-expanded>
          <SettingRow
            label="Permission mode"
            tooltip="Controls whether Rebel can execute tools or only suggest them. 'Bypass all' executes freely (safety checks still apply). 'Plan only' suggests actions without executing."
            htmlFor="permission-mode"
          >
            <select
              id="permission-mode"
              value={modelSettings.permissionMode}
              onChange={(event) =>
                updateClaude('permissionMode', event.target.value as ModelSettings['permissionMode'])
              }
            >
              <option value="bypassPermissions">Bypass all</option>
              <option value="plan">Plan only (experimental)</option>
            </select>
          </SettingRow>
          <SettingRow
            label="Auto memory updates"
            tooltip="Automatically save relevant facts from your conversations to memory, so Rebel remembers what matters."
            htmlFor="memory-update-enabled"
          >
            <input
              id="memory-update-enabled"
              type="checkbox"
              checked={draftSettings.memoryUpdateEnabled !== false}
              onChange={(event) => updateDraft('memoryUpdateEnabled', event.target.checked)}
            />
          </SettingRow>

          <SettingRow
            label="Expose keys in agent shell"
            tooltip="Make your AI provider API keys (e.g. OPENAI_API_KEY, GOOGLE_API_KEY) available as environment variables in agent shell sessions. Only affects shells started by Rebel — does not modify your system environment."
            htmlFor="expose-provider-keys"
          >
            <input
              id="expose-provider-keys"
              type="checkbox"
              checked={draftSettings.exposeProviderKeysInShell === true}
              onChange={(event) => updateDraft('exposeProviderKeysInShell', event.target.checked)}
            />
          </SettingRow>

          <SettingSection
            title="File Indexing"
            description="Configure how Rebel indexes your files for semantic search."
            data-section="fileIndexing"
          >
            <SettingRow label="Use GPU to speed up file indexing" htmlFor="gpu-embeddings">
              <input
                id="gpu-embeddings"
                data-testid="settings-gpu-embeddings-toggle"
                type="checkbox"
                checked={draftSettings.gpuEmbeddingEnabled !== false}
                onChange={(event) => updateDraft('gpuEmbeddingEnabled', event.target.checked)}
              />
              <p className={styles.modelConfigHint} style={{ marginTop: '4px' }}>
                {draftSettings.gpuEmbeddingEnabled !== false
                  ? 'GPU acceleration enabled. Falls back to CPU if unavailable.'
                  : 'GPU acceleration disabled. File indexing will use CPU only.'}
              </p>
            </SettingRow>

            <div style={{ marginTop: '16px' }}>
              <p className={styles.modelConfigHint}>
                Control indexing, pause/resume, and view progress in the Library panel.
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleOpenLibraryIndexing}
                style={{ marginTop: '8px' }}
              >
                <Library size={16} style={{ marginRight: '6px' }} />
                Manage indexing settings
              </Button>
            </div>
          </SettingSection>

        </div>
        )}
      </div>

    {/* Daily recommendations — user-facing control, outside Advanced */}
    <SettingSection
      title="Daily recommendations"
      description="Rebel analyses your conversations, calendar, and goals to rank what matters most."
      data-section="heroChoiceRunMode"
    >
      <SettingRow
        label="Daily recommendations"
        description={
          draftSettings.efficiencyMode === 'on'
            ? 'Managed by Efficiency Mode'
            : undefined
        }
        tooltip="One API call per day - cost depends on your selected model."
        htmlFor="hero-choice-run-mode"
      >
        <select
          id="hero-choice-run-mode"
          value={draftSettings.heroChoiceRunMode ?? 'ask'}
          disabled={draftSettings.efficiencyMode === 'on'}
          onChange={(e) => updateDraft('heroChoiceRunMode', e.target.value as 'ask' | 'automatic' | 'off')}
        >
          <option value="ask">Ask me each time</option>
          <option value="automatic">Run automatically</option>
          <option value="off">Off</option>
        </select>
      </SettingRow>
      <p className={styles.modelConfigHint} style={{ marginTop: '4px' }}>
        {draftSettings.heroChoiceRunMode === 'automatic'
          ? 'Generates fresh recommendations every morning.'
          : draftSettings.heroChoiceRunMode === 'off'
            ? 'No personalised recommendations on the homepage.'
            : 'Shows a card on the homepage — you decide when to generate.'}
      </p>
    </SettingSection>

    {/* Personalisation — Daily Spark control. Section name + copy verbatim
        from designer brief; mirrors heroChoiceRunMode's `data-section`
        deep-link pattern. */}
    <SettingSection
      title="Personalisation"
      data-section="dailySparkMode"
      data-testid="settings-section-daily-spark-mode"
    >
      <SettingRow
        label="Daily Spark"
        description={
          draftSettings.efficiencyMode === 'on'
            ? 'Managed by Efficiency Mode'
            : 'A short personal note on Home, based on the shape of your recent work. Stays inside Rebel.'
        }
        variant="stacked"
      >
        <RichSelect<DailySparkMode>
          value={draftSettings.dailySparkMode ?? 'on'}
          onChange={(value) => updateDraft('dailySparkMode', value)}
          disabled={draftSettings.efficiencyMode === 'on'}
          options={[
            {
              value: 'on',
              label: 'Every day',
              description: 'One personal note a day, starting after day three.',
            },
            {
              value: 'subtle',
              label: 'Mondays only',
              description: 'A weekly note. The quiet version, wearing sensible shoes.',
            },
            {
              value: 'off',
              label: 'Off',
              description: 'No Daily Spark on Home. A dignified silence.',
            },
          ]}
        />
      </SettingRow>
    </SettingSection>


  </>
  );
};

function CustomProviderForm({
  provider,
  onChange,
  onSave,
  onCancel,
}: {
  provider: CustomProvider;
  onChange: (p: CustomProvider) => void;
  onSave: (p: CustomProvider) => void;
  onCancel: () => void;
}) {
  const canSave = provider.name.trim().length > 0 && provider.serverUrl.trim().length > 0;
  return (
    <div style={{
      padding: '12px',
      backgroundColor: 'rgba(139, 92, 246, 0.04)',
      borderRadius: '6px',
      border: '1px solid rgba(139, 92, 246, 0.2)',
    }}>
      <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '10px' }}>
        {provider.createdAt ? 'Edit provider' : 'New provider'}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div>
          <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', color: 'var(--color-text-muted)' }}>
            Name
          </label>
          <input
            type="text"
            value={provider.name}
            onChange={(e) => onChange({ ...provider, name: e.target.value })}
            placeholder="e.g., My Gateway, LiteLLM Proxy"
            style={{ width: '100%', maxWidth: '260px' }}
            autoFocus
          />
        </div>
        <div>
          <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', color: 'var(--color-text-muted)' }}>
            Base URL
          </label>
          <input
            type="text"
            value={provider.serverUrl}
            onChange={(e) => onChange({ ...provider, serverUrl: e.target.value })}
            placeholder="https://my-gateway.example.com/v1"
            style={{ width: '100%', maxWidth: '360px' }}
          />
        </div>
        <div>
          <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', color: 'var(--color-text-muted)' }}>
            API Key <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            type="password"
            value={provider.apiKey ?? ''}
            onChange={(e) => onChange({ ...provider, apiKey: e.target.value.replace(/\s/g, '') || undefined })}
            placeholder="Shared across profiles using this provider"
            style={{ width: '100%', maxWidth: '260px' }}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
        <Button size="sm" onClick={() => onSave(provider)} disabled={!canSave}>
          Save
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
