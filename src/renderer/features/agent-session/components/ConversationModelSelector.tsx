/**
 * ConversationModelSelector
 *
 * Segmented quality-tier control shown at the top of a new conversation,
 * above the message list. Replaces the previous two-dropdown UI with an
 * outcome-oriented slider: Quick ($) | Balanced ($$) | Thorough ($$$) | Maximum ($$$$).
 *
 * For restored sessions that already have messages AND overrides, shows a compact
 * read-only label. Hidden entirely if no override was set or overrides match global default.
 *
 * Visibility controlled by `isExpanded` prop (toggle button in ConversationActionsMenu).
 * Auto-expands when any override is active.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsSafe } from '@renderer/features/settings';
import { getModelDisplayName } from '@shared/utils/modelNormalization';
import { Tooltip } from '@renderer/components/ui';
import type { AppSettings, ModelProfile, ThinkingEffort } from '@shared/types';
import { isProfileSelectable } from '@shared/utils/profileHelpers';
import {
  createProfileConnectivity,
  getProfileConnectivityStateFromSettings,
  isProfileFunctional,
} from '@shared/utils/connectivityHelpers';
import { resolveModelSettings } from '@shared/utils/modelSettingsResolver';
import { getApiKey } from '@renderer/features/settings/utils/modelAuthAccessors';
import { buildModelChoiceOptions } from '@renderer/features/settings/utils/buildModelChoiceOptions';
import { ModelChoicePicker } from '@renderer/features/settings/components/models/ModelChoicePicker';
import {
  decodeSessionModelChoice,
  encodeSessionModelChoice,
} from '../utils/sessionOverrides';
import {
  getQualityTiers,
  matchOverridesToTier,
  overridesMatchGlobalDefault,
  type QualityTier,
  type QualityTierId,
  type QualityTierResolvedGlobalDefault,
} from '@shared/data/qualityTiers';
import { resolveAllRoleAssignments } from '@core/rebelCore/roleAssignment';
import styles from './ConversationModelSelector.module.css';

// ── Effort display helpers ───────────────────────────────────────────────────

const EFFORT_LABELS: Record<ThinkingEffort, string> = {
  xhigh: 'Extra High',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/**
 * Human phrasing for an effort-only qualifier appended to a tier label, e.g.
 * "Using: Balanced · Extended thinking". This is intentionally fuller than the
 * dropdown's `EFFORT_LABELS` ("High", "Low") — as a standalone qualifier a bare
 * level word reads as ambiguous, so we spell out what it means. Never leak the
 * raw enum (`high`/`low`) into the UI. Single source of truth for this phrasing.
 */
const EFFORT_QUALIFIER_LABELS: Record<ThinkingEffort, string> = {
  xhigh: 'Maximum thinking',
  high: 'Extended thinking',
  medium: 'Standard thinking',
  low: 'Light thinking',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Filter profiles that have a model configured AND are selectable (routable).
 * Stage 2: also gates on `isProfileSelectable` so auto-created profiles
 * without `serverUrl` don't appear in conversation overrides. */
const getRoutableProfiles = (profiles: ModelProfile[]): ModelProfile[] =>
  profiles.filter((p) => !!p.model?.trim() && isProfileSelectable(p));

/** Resolve a human-readable label for an active override */
function resolveOverrideLabel(
  modelOverride: string | undefined,
  profileOverride: string | undefined,
  profiles: ModelProfile[],
): string | null {
  if (profileOverride) {
    const profile = profiles.find((p) => p.id === profileOverride);
    return profile?.name ?? profileOverride;
  }
  if (modelOverride) {
    return getModelDisplayName(modelOverride);
  }
  return null;
}

type RoleAssignmentMap = ReturnType<typeof resolveAllRoleAssignments>;

function profileRefFromAssignment(assignment: RoleAssignmentMap['working']): string | undefined {
  return assignment.primary.kind === 'profile' ? assignment.primary.profileId : undefined;
}

function hasExplicitModelChoice(assignment: RoleAssignmentMap['working']): boolean {
  return assignment.primary.kind === 'model' || assignment.primary.kind === 'profile';
}

// ── SECTION: QualitySlider — segmented control ───────────────────────────────

interface QualitySliderProps {
  tiers: QualityTier[];
  activeTierId: QualityTierId | null;
  defaultTierId: QualityTierId | null;
  onSelectTier: (tier: QualityTier) => void;
}

function QualitySlider({ tiers, activeTierId, defaultTierId, onSelectTier }: QualitySliderProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      let nextIndex: number | null = null;

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        nextIndex = (index + 1) % tiers.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        nextIndex = (index - 1 + tiers.length) % tiers.length;
      }

      if (nextIndex !== null && containerRef.current) {
        const buttons = containerRef.current.querySelectorAll<HTMLButtonElement>('[role="radio"]');
        buttons[nextIndex]?.focus();
      }
    },
    [tiers.length],
  );

  return (
    <div
      ref={containerRef}
      className={styles.sliderContainer}
      role="radiogroup"
      aria-label="Quality level"
      data-testid="quality-slider"
    >
      {tiers.map((tier, index) => {
        const isActive = activeTierId === tier.id;
        const isDefault = defaultTierId === tier.id;

        return (
          <Tooltip key={tier.id} content={tier.description} placement="bottom">
            <button
              role="radio"
              aria-checked={isActive}
              aria-label={`${tier.name} quality — ${tier.costIndicator}`}
              className={`${styles.segment} ${isActive ? styles.segmentActive : ''} ${isDefault ? styles.segmentDefault : ''}`}
              data-testid={`quality-tier-${tier.id}`}
              tabIndex={isActive ? 0 : (activeTierId === null && index === 0) ? 0 : -1}
              onClick={() => onSelectTier(tier)}
              onKeyDown={(e) => handleKeyDown(e, index)}
            >
              <span className={styles.segmentName}>{tier.name}</span>
              <span className={styles.costIndicator}>{tier.costIndicator}</span>
            </button>
          </Tooltip>
        );
      })}

      {activeTierId === null && (
        <span className={styles.customLabel}>Custom</span>
      )}
    </div>
  );
}

// ── SECTION: LockedStateLabel — compact read-only display ────────────────────

interface LockedStateLabelProps {
  activeTierId: QualityTierId | null;
  tiers: QualityTier[];
  sessionWorkingModel: string | undefined;
  sessionThinkingModel: string | undefined;
  sessionWorkingProfileId: string | undefined;
  sessionThinkingProfileId: string | undefined;
  profiles: ModelProfile[];
  /** Human qualifier (e.g. "Extended thinking") appended to the tier label when
   * the only override is a non-default thinking effort. Undefined otherwise. */
  thinkingEffortLabel?: string;
}

function LockedStateLabel({
  activeTierId,
  tiers,
  sessionWorkingModel,
  sessionThinkingModel,
  sessionWorkingProfileId,
  sessionThinkingProfileId,
  profiles,
  thinkingEffortLabel,
}: LockedStateLabelProps) {
  if (activeTierId) {
    const tier = tiers.find((t) => t.id === activeTierId);
    if (tier) {
      const tierLabel = thinkingEffortLabel ? `${tier.name} · ${thinkingEffortLabel}` : tier.name;
      return (
        <div className={styles.container} role="status" aria-label="Model overrides" data-testid="locked-state-label">
          <span className={styles.readOnlyLabel}>Using: {tierLabel}</span>
        </div>
      );
    }
  }

  // Custom: show model summary
  const workingLabel = resolveOverrideLabel(sessionWorkingModel, sessionWorkingProfileId, profiles);
  const thinkingLabel = resolveOverrideLabel(sessionThinkingModel, sessionThinkingProfileId, profiles);

  const parts: string[] = [];
  if (workingLabel) parts.push(workingLabel);
  if (thinkingLabel && thinkingLabel !== workingLabel) parts.push(thinkingLabel);

  return (
    <div className={styles.container} role="status" aria-label="Model overrides" data-testid="locked-state-label">
      <span className={styles.readOnlyLabel}>
        Using: Custom{parts.length > 0 ? ` (${parts.join(' + ')})` : ''}
      </span>
    </div>
  );
}

// ── ConversationModelSelector — outer wrapper ────────────────────────────────

interface ConversationModelSelectorProps {
  /** Whether the current session has messages (locks the selector) */
  hasMessages: boolean;
  /** Whether the selector panel is expanded (controlled by toggle button) */
  isExpanded?: boolean;
}

export const ConversationModelSelector = memo(function ConversationModelSelector({
  hasMessages,
  isExpanded = false,
}: ConversationModelSelectorProps) {
  const sessionWorkingModel = useSessionStore((s) => s.sessionWorkingModel);
  const sessionThinkingModel = useSessionStore((s) => s.sessionThinkingModel);
  const sessionWorkingProfileId = useSessionStore((s) => s.sessionWorkingProfileId);
  const sessionThinkingProfileId = useSessionStore((s) => s.sessionThinkingProfileId);
  const sessionThinkingEffort = useSessionStore((s) => s.sessionThinkingEffort);
  const setSessionModelOverrides = useSessionStore((s) => s.setSessionModelOverrides);

  // ── Settings & profiles ─────────────────────────────────────────────────
  const settings = useSettingsSafe();
  const [codexConnected, setCodexConnected] = useState(false);
  const profiles = useMemo(
    () => settings?.draftSettings?.localModel?.profiles ?? [],
    [settings?.draftSettings?.localModel?.profiles],
  );
  const billingSettings = settings?.draftSettings ?? settings?.settings ?? undefined;
  const profileConnectivity = useMemo(
    () =>
      createProfileConnectivity(
        getProfileConnectivityStateFromSettings(billingSettings, { codexConnected }),
      ),
    [billingSettings, codexConnected],
  );
  const routableProfiles = useMemo(
    () => getRoutableProfiles(profiles).filter((profile) =>
      isProfileFunctional(profile, profileConnectivity),
    ),
    [profileConnectivity, profiles],
  );

  useEffect(() => {
    async function loadCodexStatus() {
      if (!window.codexApi?.status) {
        return;
      }

      try {
        const status = await window.codexApi.status();
        setCodexConnected(status.connected);
      } catch {
        // Best-effort UI hint only.
      }
    }

    void loadCodexStatus();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadCodexStatus();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const modelChoiceSettings = useMemo(
    () => ({
      ...(billingSettings ?? {}),
      localModel: {
        ...(billingSettings?.localModel ?? {}),
        profiles,
      },
    }) as AppSettings,
    [billingSettings, profiles],
  );
  const modelChoiceOptions = useMemo(
    () => buildModelChoiceOptions({
      role: 'working',
      settings: modelChoiceSettings,
      activeProvider: billingSettings?.activeProvider,
      hasAnthropicCredentials: !!(billingSettings && getApiKey(billingSettings)),
      hasOpenRouterCredentials: !!billingSettings?.openRouter?.oauthToken,
      hasCodexCredentials: codexConnected,
      hasGeminiCredentials: !!billingSettings?.providerKeys?.google?.trim(),
      catalogMode: 'connected-providers',
      profileFilter: (profile) => !!profile.model?.trim() && isProfileFunctional(profile, profileConnectivity),
    }),
    [billingSettings, codexConnected, modelChoiceSettings, profileConnectivity],
  );
  const catalogModels = modelChoiceOptions.catalogModels;

  // ── Multi-model toggle state ─────────────────────────────────────────────
  const hasThirdPartyProfiles = routableProfiles.length > 0;
  const [isMultiModel, setIsMultiModel] = useState(hasThirdPartyProfiles);
  // NOTE: If user has NO Claude models (profile-only), toggle would be forced off.
  // Currently Claude is always available, so this is a future consideration.
  const multiModelEnabled = isMultiModel && hasThirdPartyProfiles;

  // ── Advanced panel state ────────────────────────────────────────────────
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);

  // ── Tier computation (memoized) ─────────────────────────────────────────
  // Stable profile signature for useMemo deps
  const profileSignature = useMemo(
    () => routableProfiles.map((p) => `${p.id}:${p.model}`).join('|'),
    [routableProfiles],
  );

  const tiers = useMemo(
    () => getQualityTiers(routableProfiles, multiModelEnabled),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- profileSignature is a stable proxy for routableProfiles content
    [routableProfiles, multiModelEnabled, profileSignature],
  );

  const rawActiveTierId = useMemo(
    () =>
      matchOverridesToTier(tiers, {
        workingModel: sessionWorkingModel,
        thinkingModel: sessionThinkingModel,
        workingProfileId: sessionWorkingProfileId,
        thinkingProfileId: sessionThinkingProfileId,
        thinkingEffort: sessionThinkingEffort,
      }),
    [tiers, sessionWorkingModel, sessionThinkingModel, sessionWorkingProfileId, sessionThinkingProfileId, sessionThinkingEffort],
  );

  // ── Global default detection ────────────────────────────────────────────
  const resolvedDefaults = useMemo(
    () => resolveModelSettings(settings?.draftSettings),
    [settings?.draftSettings],
  );

  const globalRoleAssignments = useMemo(
    () => resolveAllRoleAssignments(settings?.draftSettings, {
      profiles,
      activeProvider: billingSettings?.activeProvider,
      codexConnected,
      connectivity: profileConnectivity,
    }),
    [settings?.draftSettings, profiles, billingSettings?.activeProvider, codexConnected, profileConnectivity],
  );

  const resolvedGlobalDefaults = useMemo<QualityTierResolvedGlobalDefault>(
    () => ({
      workingEffectiveModelId: globalRoleAssignments.working.effectiveModelId,
      thinkingEffectiveModelId: globalRoleAssignments.thinking.effectiveModelId,
      workingProfileRef: profileRefFromAssignment(globalRoleAssignments.working),
      thinkingProfileRef: profileRefFromAssignment(globalRoleAssignments.thinking),
      thinkingEffort: resolvedDefaults.thinkingEffort,
    }),
    [globalRoleAssignments, resolvedDefaults.thinkingEffort],
  );

  const isGlobalDefault = useMemo(
    () =>
      overridesMatchGlobalDefault(
        {
          workingModel: sessionWorkingModel,
          thinkingModel: sessionThinkingModel,
          workingProfileId: sessionWorkingProfileId,
          thinkingProfileId: sessionThinkingProfileId,
          thinkingEffort: sessionThinkingEffort,
        },
        resolvedGlobalDefaults,
      ),
    [sessionWorkingModel, sessionThinkingModel, sessionWorkingProfileId, sessionThinkingProfileId, sessionThinkingEffort, resolvedGlobalDefaults],
  );

  // ── Determine which tier matches the global default settings ────────────
  const defaultTierId = useMemo(() => {
    const globalEffort = resolvedDefaults.thinkingEffort || 'high';
    return matchOverridesToTier(tiers, {
      workingModel: resolvedGlobalDefaults.workingEffectiveModelId ?? undefined,
      thinkingModel: (resolvedGlobalDefaults.thinkingEffectiveModelId ?? resolvedGlobalDefaults.workingEffectiveModelId) ?? undefined,
      workingProfileId: resolvedGlobalDefaults.workingProfileRef,
      thinkingProfileId: resolvedGlobalDefaults.thinkingProfileRef,
      thinkingEffort: globalEffort,
    });
  }, [tiers, resolvedDefaults.thinkingEffort, resolvedGlobalDefaults]);

  // ── Override detection ──────────────────────────────────────────────────
  const hasAnyOverride = (
    sessionWorkingModel !== undefined ||
    sessionThinkingModel !== undefined ||
    sessionWorkingProfileId !== undefined ||
    sessionThinkingProfileId !== undefined ||
    sessionThinkingEffort !== undefined
  );

  // Effort-only override: every model/profile override is cleared but a thinking
  // effort remains. This is the post-FOX-3494 recovery state (recovery deliberately
  // preserves `sessionThinkingEffort`). It must NOT render as "Custom" — "Custom"
  // is strictly for a genuine model/profile override. Instead we treat it as the
  // default tier and surface the effort as a qualifier on the tier label.
  const effortOnlyOverride = (
    sessionWorkingModel === undefined &&
    sessionThinkingModel === undefined &&
    sessionWorkingProfileId === undefined &&
    sessionThinkingProfileId === undefined &&
    sessionThinkingEffort !== undefined
  );

  // When no overrides are set, show the default tier as visually selected.
  // For an effort-only override, also anchor on the default tier so the normal
  // tier label renders (with an effort qualifier) rather than the empty Custom branch.
  const activeTierId = (!hasAnyOverride || effortOnlyOverride) ? defaultTierId : rawActiveTierId;

  // Effort qualifier shown only when it actually differs from the global default
  // effort (a no-op effort that matches the default adds no information).
  const thinkingEffortLabel = useMemo(() => {
    if (!effortOnlyOverride || sessionThinkingEffort === undefined) return undefined;
    const defaultEffort = resolvedDefaults.thinkingEffort ?? 'high';
    if (sessionThinkingEffort === defaultEffort) return undefined;
    return EFFORT_QUALIFIER_LABELS[sessionThinkingEffort];
  }, [effortOnlyOverride, sessionThinkingEffort, resolvedDefaults.thinkingEffort]);

  // ── SECTION: AdvancedPanel — detailed model controls ────────────────────

  // Resolve global model names for "Global (...)" dropdown display
  const globalWorkingName = useMemo(() => {
    if (!settings?.draftSettings) return '';
    return globalRoleAssignments.working.display.modelLabel
      || getModelDisplayName(resolvedGlobalDefaults.workingEffectiveModelId ?? 'claude-sonnet-4-6');
  }, [settings?.draftSettings, globalRoleAssignments, resolvedGlobalDefaults.workingEffectiveModelId]);

  const globalThinkingName = useMemo(() => {
    if (!settings?.draftSettings) return '';
    if (hasExplicitModelChoice(globalRoleAssignments.thinking)) {
      return globalRoleAssignments.thinking.display.modelLabel
        || getModelDisplayName(resolvedGlobalDefaults.thinkingEffectiveModelId ?? '');
    }
    return globalWorkingName;
  }, [settings?.draftSettings, globalRoleAssignments, resolvedGlobalDefaults.thinkingEffectiveModelId, globalWorkingName]);

  const workingChoice = useMemo(
    () => decodeSessionModelChoice(sessionWorkingModel, sessionWorkingProfileId),
    [sessionWorkingModel, sessionWorkingProfileId],
  );
  const thinkingChoice = useMemo(
    () => decodeSessionModelChoice(sessionThinkingModel, sessionThinkingProfileId),
    [sessionThinkingModel, sessionThinkingProfileId],
  );

  // ── Dropdown change handlers (preserve other fields) ────────────────────

  const handleWorkingChange = useCallback(
    (choice: Parameters<typeof encodeSessionModelChoice>[0]) => {
      const encoded = encodeSessionModelChoice(choice, routableProfiles);
      setSessionModelOverrides({
        workingModel: encoded.model,
        workingProfileId: encoded.profileId,
        thinkingModel: sessionThinkingModel,
        thinkingProfileId: sessionThinkingProfileId,
        thinkingEffort: sessionThinkingEffort,
      });
    },
    [setSessionModelOverrides, sessionThinkingModel, sessionThinkingProfileId, sessionThinkingEffort, routableProfiles],
  );

  const handleThinkingChange = useCallback(
    (choice: Parameters<typeof encodeSessionModelChoice>[0]) => {
      const encoded = encodeSessionModelChoice(choice, routableProfiles);
      setSessionModelOverrides({
        workingModel: sessionWorkingModel,
        workingProfileId: sessionWorkingProfileId,
        thinkingModel: encoded.model,
        thinkingProfileId: encoded.profileId,
        thinkingEffort: sessionThinkingEffort,
      });
    },
    [setSessionModelOverrides, sessionWorkingModel, sessionWorkingProfileId, sessionThinkingEffort, routableProfiles],
  );

  // ── Thinking effort dropdown ─────────────────────────────────────────────

  const globalEffortName = useMemo(() => {
    const effort = resolvedDefaults.thinkingEffort ?? 'high';
    return EFFORT_LABELS[effort];
  }, [resolvedDefaults.thinkingEffort]);

  const handleEffortChange = useCallback(
    (value: string) => {
      const effortValue = value === '' ? undefined : (value as ThinkingEffort);
      setSessionModelOverrides({
        workingModel: sessionWorkingModel,
        workingProfileId: sessionWorkingProfileId,
        thinkingModel: sessionThinkingModel,
        thinkingProfileId: sessionThinkingProfileId,
        thinkingEffort: effortValue,
      });
    },
    [setSessionModelOverrides, sessionWorkingModel, sessionWorkingProfileId, sessionThinkingModel, sessionThinkingProfileId],
  );

  // ── "Save as default" button ──────────────────────────────────────────
  const [saveDefaultState, setSaveDefaultState] = useState<'idle' | 'saved'>('idle');
  const saveDefaultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (saveDefaultTimerRef.current) clearTimeout(saveDefaultTimerRef.current);
    };
  }, []);

  const handleSaveAsDefault = useCallback(async () => {
    try {
      const current = await window.settingsApi.get();
      const currentModels = resolveModelSettings(current);

      const updates = {
        ...currentModels,
        model: sessionWorkingModel ?? currentModels.model,
        workingProfileId: sessionWorkingProfileId ?? null,
        thinkingModel: sessionThinkingModel ?? currentModels.thinkingModel,
        thinkingProfileId: sessionThinkingProfileId ?? null,
        thinkingEffort: sessionThinkingEffort ?? currentModels.thinkingEffort,
      };

      // Also clear legacy activeProfileId when saving a default with no working
      // profile override — profiles take precedence via getWorkingModelProfile fallback.
      const localModel = current?.localModel;
      const localModelUpdates = (!sessionWorkingProfileId && localModel?.activeProfileId)
        ? { ...localModel, activeProfileId: null }
        : localModel;

      await window.settingsApi.update({ ...current, models: updates, localModel: localModelUpdates });

      setSaveDefaultState('saved');
      if (saveDefaultTimerRef.current) clearTimeout(saveDefaultTimerRef.current);
      saveDefaultTimerRef.current = setTimeout(() => setSaveDefaultState('idle'), 1500);
    } catch {
      // Silently fail — the button will remain clickable
    }
  }, [sessionWorkingModel, sessionWorkingProfileId, sessionThinkingModel, sessionThinkingProfileId, sessionThinkingEffort]);

  // ── Tier selection handler ──────────────────────────────────────────────
  const handleSelectTier = useCallback(
    (tier: QualityTier) => {
      // Clicking already-selected tier that matches global → clear overrides
      if (activeTierId === tier.id && isGlobalDefault) {
        setSessionModelOverrides({
          workingModel: undefined,
          workingProfileId: undefined,
          thinkingModel: undefined,
          thinkingProfileId: undefined,
          thinkingEffort: undefined,
        });
        return;
      }

      setSessionModelOverrides({
        workingModel: tier.workingModel,
        workingProfileId: tier.workingProfileId,
        thinkingModel: tier.thinkingModel,
        thinkingProfileId: tier.thinkingProfileId,
        thinkingEffort: tier.thinkingEffort,
      });
    },
    [activeTierId, isGlobalDefault, setSessionModelOverrides],
  );

  // ── Locked state: after first message ───────────────────────────────────
  if (hasMessages) {
    if (!hasAnyOverride || isGlobalDefault) return null;

    return (
      <LockedStateLabel
        activeTierId={activeTierId}
        tiers={tiers}
        sessionWorkingModel={sessionWorkingModel}
        sessionThinkingModel={sessionThinkingModel}
        sessionWorkingProfileId={sessionWorkingProfileId}
        sessionThinkingProfileId={sessionThinkingProfileId}
        profiles={profiles}
        thinkingEffortLabel={thinkingEffortLabel}
      />
    );
  }

  // ── For new conversations: show only when expanded or has overrides ─────
  if (!isExpanded && !hasAnyOverride) return null;

  // ── Interactive segmented control ───────────────────────────────────────
  return (
    <div className={`${styles.container} ${isAdvancedOpen ? styles.containerWithAdvanced : ''}`} role="group" aria-label="Conversation quality level" data-testid="model-selector">
      <QualitySlider
        tiers={tiers}
        activeTierId={activeTierId}
        defaultTierId={defaultTierId}
        onSelectTier={handleSelectTier}
      />
      {hasThirdPartyProfiles && !hasMessages && (
        <Tooltip content="Use models from multiple providers for best results" placement="bottom">
          <label className={styles.multiModelToggle}>
            <input
              type="checkbox"
              className={styles.multiModelCheckbox}
              checked={isMultiModel}
              onChange={(e) => setIsMultiModel(e.target.checked)}
              data-testid="multi-model-checkbox"
            />
            <span className={styles.multiModelLabel}>Multi-model</span>
          </label>
        </Tooltip>
      )}
      {!hasMessages && (
        <button
          className={styles.advancedToggle}
          onClick={() => setIsAdvancedOpen(!isAdvancedOpen)}
          type="button"
        >
          {isAdvancedOpen ? 'Hide details ▾' : 'Show details ▸'}
        </button>
      )}
      {!hasMessages && (
        <div className={`${styles.advancedPanel} ${isAdvancedOpen ? styles.advancedPanelOpen : ''}`} aria-hidden={!isAdvancedOpen}>
          <div className={styles.dropdownGroup}>
            <label className={styles.advancedLabel} htmlFor="conv-working-model">
              Working
            </label>
            <ModelChoicePicker
              role="working"
              value={workingChoice}
              onChange={handleWorkingChange}
              profiles={routableProfiles}
              catalogModels={catalogModels}
              settings={(billingSettings ?? {}) as AppSettings}
              codexConnected={codexConnected}
              activeProvider={billingSettings?.activeProvider}
              htmlFor="conv-working-model"
              className={styles.advancedSelect}
              tabIndex={isAdvancedOpen ? 0 : -1}
              includeOffOption
              offLabel={`Global (${globalWorkingName})`}
            />
          </div>

          <div className={styles.dropdownGroup}>
            <label className={styles.advancedLabel} htmlFor="conv-thinking-model">
              Thinking
            </label>
            <ModelChoicePicker
              role="thinking"
              value={thinkingChoice}
              onChange={handleThinkingChange}
              profiles={routableProfiles}
              catalogModels={catalogModels}
              settings={(billingSettings ?? {}) as AppSettings}
              codexConnected={codexConnected}
              activeProvider={billingSettings?.activeProvider}
              htmlFor="conv-thinking-model"
              className={styles.advancedSelect}
              tabIndex={isAdvancedOpen ? 0 : -1}
              includeOffOption
              offLabel={`Global (${globalThinkingName})`}
            />
          </div>

          <div className={styles.dropdownGroup}>
            <label className={styles.advancedLabel} htmlFor="conv-thinking-effort">
              Effort
            </label>
            <select
              id="conv-thinking-effort"
              className={styles.advancedSelect}
              value={sessionThinkingEffort ?? ''}
              onChange={(e) => handleEffortChange(e.target.value)}
              tabIndex={isAdvancedOpen ? 0 : -1}
            >
              <option value="">Global ({globalEffortName})</option>
              <option value="xhigh">Extra High</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
        </div>
      )}
      {!hasMessages && hasAnyOverride && !isGlobalDefault && (
        <button
          className={styles.saveDefaultButton}
          onClick={handleSaveAsDefault}
          type="button"
          disabled={saveDefaultState === 'saved'}
          data-testid="save-as-default-button"
        >
          {saveDefaultState === 'saved' ? 'Saved ✓' : 'Save as default'}
        </button>
      )}
    </div>
  );
});
