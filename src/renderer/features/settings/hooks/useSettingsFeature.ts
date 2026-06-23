import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTimeoutRef } from '@renderer/hooks/useTimeoutRef';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';
import type {
  AppSettings,
  McpConfigSummary,
  McpServerUpsertPayload,
  McpRouterPathPatchPayload,
  McpServerConfigDetails,
  AnalyticsStatusPayload
} from '@shared/types';
import type { ModelSettings } from '@shared/types';
import { normalizeSettings, resolveModelSettings } from '@shared/utils/settingsUtils';
import { DEFAULT_MODEL } from '@shared/utils/modelNormalization';
import { tracking } from '@renderer/src/tracking';
import type { EmitLogFn } from '@renderer/contexts/AppContext';
import { resolveSettingsTabId, type SettingsTabId } from '@shared/navigation/types';
import { resolveSettingsNavigation } from '@shared/navigation/settingsNavigationContract';
import { useRouteLabelCacheStore } from '../store/routeLabelCacheStore';

export type SettingsSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** Passed to `tracking.settings.opened` (ingress). */
export type SettingsOpenedAnalyticsSource = 'nav_click' | 'link' | 'keyboard' | 'auto' | 'deep_link';

/** Drives `Settings Destination Switched.interactionType` when the user changes top-level destination. */
export type SettingsNavigationInteractionType = 'sidebar' | 'search' | 'deep_link' | 'programmatic';

export type OpenSettingsDialogOptions = {
  source?: SettingsOpenedAnalyticsSource;
  interactionType?: SettingsNavigationInteractionType;
};

export type PendingSpacesAction = {
  id: string;
  action: 'add';
};

const AUTO_SAVE_DEBOUNCE_MS = 800;
const SAVED_INDICATOR_DURATION_MS = 2000;

type ModelSettingsLike = NonNullable<AppSettings['models']>;

function createPendingSpacesActionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `spaces-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Renderer pre-load seed for the settings model block.
 *
 * The `model: DEFAULT_MODEL` field is intentionally Anthropic-flavored: it only
 * surfaces when `settings.models` is entirely absent (first run, before settings
 * have been hydrated from main). As soon as `readModelSettings()` runs against
 * populated settings, `resolveModelSettings(settings)` returns the
 * provider-aware model and the spread below overrides this default. Provider-
 * aware resolution lives in `getDefaultModelForProvider()` and is invoked from
 * `resolveModelSettings` — do NOT route this constant through it, because the
 * renderer cannot synchronously know `activeProvider` at module eval time.
 *
 * Tracked under the Stage 6 ESLint widening (allowlisted): the renderer seed
 * is one of the three intentional `DEFAULT_MODEL` references that the
 * rebel/no-hardcoded-default-model rule will whitelist.
 */
const DEFAULT_MODEL_SETTINGS: ModelSettingsLike = {
  apiKey: null,
  oauthToken: null,
  authMethod: 'api-key',
  model: DEFAULT_MODEL,
  permissionMode: 'bypassPermissions',
  executablePath: null,
  planMode: false,
  extendedContext: true,
  thinkingEffort: 'high',
};

function readModelSettings(settings: Pick<AppSettings, 'models' | 'claude'> | null | undefined): ModelSettingsLike {
  return { ...DEFAULT_MODEL_SETTINGS, ...resolveModelSettings(settings ?? {}) };
}

type UseSettingsFeatureOptions = {
  emitLog: EmitLogFn;
  showToast: (options: { title: string }) => void;
  onError?: (message: string | null) => void;
  onConfigurationComplete?: () => void;
};

export const useSettingsFeature = ({
  emitLog,
  showToast,
  onError,
  onConfigurationComplete
}: UseSettingsFeatureOptions) => {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draftSettings, setDraftSettings] = useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTabId>('tools');
  const [targetSection, setTargetSection] = useState<string | undefined>(undefined);
  const [pendingSpacesAction, setPendingSpacesAction] = useState<PendingSpacesAction | null>(null);

  const [mcpSummary, setMcpSummary] = useState<McpConfigSummary | null>(null);
  const [mcpSummaryLoading, setMcpSummaryLoading] = useState(false);
  const [mcpSummaryError, setMcpSummaryError] = useState<string | null>(null);
  const [mcpHealthLoading] = useState(false);
  const [mcpMutationPending, setMcpMutationPending] = useState(false);
  const [analyticsStatus, setAnalyticsStatus] = useState<AnalyticsStatusPayload | null>(null);
  const [analyticsStatusLoading, setAnalyticsStatusLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SettingsSaveStatus>('idle');
  const autoSaveTimer = useTimeoutRef();
  const savedIndicatorTimer = useTimeoutRef();
  const draftSettingsRef = useRef<AppSettings | null>(null);
  const pendingSettingsNavInteractionRef = useRef<SettingsNavigationInteractionType | null>(null);
  const pendingOpenResolutionMetaRef = useRef<{ redirectedFrom?: { tab?: SettingsTabId; section?: string } } | null>(null);
  const hasLoadedMcpSummaryForSessionRef = useRef(false);
  // Track whether an auto-save is pending (scheduled but not yet executed)
  // Used by closeSettingsDialog to flush pending saves before closing
  const hasPendingAutoSaveRef = useRef(false);
  // Track which top-level AppSettings keys the user has edited since the last auto-save.
  // Used to preserve user-edited draft values when onAuthConfigReceived triggers a refresh.
  const dirtyKeysRef = useRef(new Set<keyof AppSettings>());
  // Keys that should remain "dirty" even after auto-save clears them.
  // Used when the user explicitly removes a value (e.g. API key) and we must
  // prevent refreshSettings from overwriting the draft with the re-provisioned value.
  const stickyDirtyKeysRef = useRef(new Set<keyof AppSettings>());

  const refreshSettings = useCallback(async (options?: { preserveDraftKeys?: (keyof AppSettings)[] }) => {
    try {
      const value = await window.settingsApi.get();
      const normalized = normalizeSettings(value);
      setSettings(normalized);
      if (options?.preserveDraftKeys?.length && draftSettingsRef.current) {
        // Preserve specified draft-local keys that may not have been auto-saved yet.
        // This prevents race conditions where a settings refresh (e.g. from auth config)
        // overwrites draft values set by onboarding (e.g. coreDirectory, eulaAcceptedAt).
        const preserved: Partial<AppSettings> = {};
        for (const key of options.preserveDraftKeys) {
          if (draftSettingsRef.current[key] !== undefined && draftSettingsRef.current[key] !== null) {
            (preserved as Record<string, unknown>)[key] = draftSettingsRef.current[key];
          }
        }
        const merged = { ...normalized, ...preserved };
        setDraftSettings(merged);
        draftSettingsRef.current = merged;
      } else {
        setDraftSettings(normalized);
        draftSettingsRef.current = normalized;
      }
    } catch (reason) {
      const errorMessage = reason instanceof Error ? reason.message : String(reason);
      onError?.(errorMessage);
    }
  }, [onError]);

  // Only refresh settings on initial mount, not when refreshSettings callback changes
   
  useEffect(() => {
    void refreshSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional mount-only effect; refreshSettings is stable but not needed as dep
  }, []);

  // Auto-refresh settings when demo mode changes
  useIpcEvent(window.api.onDemoModeChange, () => {
    void refreshSettings();
  }, [refreshSettings]);

  // Auto-refresh settings when MCP bridge updates settings externally
  useIpcEvent(window.api.onSettingsExternalUpdate, () => {
    void refreshSettings({ preserveDraftKeys: ['coreDirectory', 'eulaAcceptedAt', ...dirtyKeysRef.current] });
  }, [refreshSettings]);

  // Auto-refresh settings when auth config is received after login
  // (main process applies API keys from server config to settings store).
  // Preserve draft-local keys that onboarding may have set but not yet auto-saved.
  // Always preserves coreDirectory/eulaAcceptedAt (set during onboarding before auth arrives),
  // plus any keys the user has actively edited (tracked via dirtyKeysRef) to prevent the race
  // where auth config refresh overwrites unsaved draft values (e.g. elevenlabsApiKey).
  // Dirty keys are cleared after each successful auto-save, so server-provisioned values
  // (e.g. enterprise claude.apiKey) flow through once the user's edits are persisted.
  useIpcEvent(window.api.onAuthConfigReceived, () => {
    void refreshSettings({ preserveDraftKeys: ['coreDirectory', 'eulaAcceptedAt', ...dirtyKeysRef.current] });
  }, [refreshSettings]);

  // Cache canonical route labels emitted by the executor at turn-start.
  useIpcEvent(window.api.onAgentRoutePlanResolved, (event) => {
    useRouteLabelCacheStore.getState().set({
      sessionId: event.sessionId,
      turnAuthLabel: event.turnAuthLabel,
      observedAt: event.resolvedAt,
      ...(event.profileName ? { profileName: event.profileName } : {}),
    });
  }, []);

  // Mark route-status as in-flight (Checking…) when a turn starts; the
  // route-plan-resolved listener above clears it via the cache store's `set`.
  useIpcEvent(window.api.onAgentEvent, ({ event, sessionId }) => {
    if (event.type === 'turn_started' && sessionId) {
      useRouteLabelCacheStore.getState().setInflight(sessionId);
    }
  }, []);

  // Route-label cache is ephemeral UI state and should be wiped on sign-out.
  useIpcEvent(window.api.onAuthStateChange, ({ isAuthenticated }) => {
    if (!isAuthenticated) {
      useRouteLabelCacheStore.getState().clearAll();
    }
  }, []);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }
    setAnalyticsStatusLoading(true);
    window.api
      .getAnalyticsStatus()
      .then((status) => {
        setAnalyticsStatus(status);
      })
      .catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        emitLog({
          level: 'error',
          message: 'Failed to load analytics status',
          context: { error: errorMessage },
          timestamp: Date.now()
        });
      })
      .finally(() => {
        setAnalyticsStatusLoading(false);
      });
  }, [emitLog, settingsOpen]);

  const openSettingsDialog = useCallback(async (tab?: string, section?: string, options?: OpenSettingsDialogOptions) => {
    // Set tab, section, and open state synchronously BEFORE the async refresh.
    // This prevents a race with the activeSurface sync effect in App.tsx which
    // calls openSettingsDialog() without a tab when it sees activeSurface='settings'
    // but settingsOpen=false. By marking settingsOpen=true immediately, the effect's
    // guard (!settingsOpen) prevents a second, tab-less call from clobbering navigation.
    const hasExplicitTarget = tab !== undefined || section !== undefined;
    if (hasExplicitTarget) {
      const canonicalTab = tab ? resolveSettingsTabId(tab) : undefined;
      const devMode = draftSettingsRef.current?.diagnostics?.developerMode ?? false;
      const resolved = resolveSettingsNavigation(
        { tab: canonicalTab, section },
        { developerModeEnabled: devMode },
      );
      pendingSettingsNavInteractionRef.current = options?.interactionType ?? 'programmatic';
      pendingOpenResolutionMetaRef.current = resolved.redirectedFrom
        ? { redirectedFrom: resolved.redirectedFrom }
        : null;
      setActiveTab(resolved.leafTab);
      setTargetSection(resolved.section);
    } else {
      pendingSettingsNavInteractionRef.current = null;
      pendingOpenResolutionMetaRef.current = null;
    }
    setSettingsOpen(true);
    tracking.settings.opened(options?.source ?? 'auto');

    // Refresh settings from main process to catch external changes
    // (e.g., MCP tools updating vocabulary, auth config changes, etc.)
    try {
      await refreshSettings();
    } catch (error) {
      emitLog({
        level: 'warn',
        message: 'Failed to refresh settings on dialog open, using cached values',
        context: { error: error instanceof Error ? error.message : String(error) },
        timestamp: Date.now()
      });
      if (settings) {
        const draft = structuredClone(settings);
        setDraftSettings(draft);
        draftSettingsRef.current = draft;
      }
    }
  }, [emitLog, refreshSettings, settings]);

  const consumePendingSettingsNavigationInteraction = useCallback((): SettingsNavigationInteractionType | undefined => {
    const v = pendingSettingsNavInteractionRef.current;
    pendingSettingsNavInteractionRef.current = null;
    return v ?? undefined;
  }, []);

  const consumePendingOpenResolutionMeta = useCallback((): { redirectedFrom?: { tab?: SettingsTabId; section?: string } } | null => {
    const m = pendingOpenResolutionMetaRef.current;
    pendingOpenResolutionMetaRef.current = null;
    return m;
  }, []);

  const setSettingsLeafTab = useCallback(
    (next: SettingsTabId, interaction: SettingsNavigationInteractionType) => {
      pendingSettingsNavInteractionRef.current = interaction;
      setActiveTab(next);
    },
    [],
  );

  // NOTE: performAutoSave must be defined BEFORE closeSettingsDialog because
  // closeSettingsDialog references it in its dependency array
  const performAutoSave = useCallback(async () => {
    // Clear pending flag at start - we're now executing the save
    hasPendingAutoSaveRef.current = false;
    // Read directly from ref to get latest draft settings
    const currentDraft = draftSettingsRef.current;
    if (!currentDraft) {
      return;
    }
    // Snapshot which keys are dirty BEFORE the async IPC call.
    // Any keys added during the await (user changed another setting) must survive.
    const keysBeforeSave = new Set(dirtyKeysRef.current);
    setSaveStatus('saving');
    try {
      // Call API directly instead of going through saveSettingsWith to avoid stale closure issues
      const next = await window.settingsApi.update(currentDraft);
      const normalized = normalizeSettings(next);
      setSettings(normalized);
      setDraftSettings(normalized);
      draftSettingsRef.current = normalized;
      // Only clear keys that were dirty when we started saving.
      // Keys added during the async window stay dirty so refreshSettings
      // (e.g. from onAuthConfigReceived) preserves those in-flight changes.
      for (const key of keysBeforeSave) {
        dirtyKeysRef.current.delete(key);
      }
      // Re-add sticky keys so refreshSettings continues to preserve them
      for (const key of stickyDirtyKeysRef.current) {
        dirtyKeysRef.current.add(key);
      }
      
      setSaveStatus('saved');
      savedIndicatorTimer.set(() => {
        setSaveStatus('idle');
      }, SAVED_INDICATOR_DURATION_MS);
    } catch {
      setSaveStatus('error');
    }
  }, [savedIndicatorTimer]);

  const closeSettingsDialog = useCallback(() => {
    // Flush any pending auto-save before closing to prevent data loss
    // (user may close settings within the 800ms debounce window)
    if (hasPendingAutoSaveRef.current) {
      // Clear timer FIRST to prevent race condition where timer fires during flush
      autoSaveTimer.clear();
      // Flush the pending save synchronously (fire-and-forget, matches existing pattern)
      void performAutoSave();
    } else {
      autoSaveTimer.clear();
    }
    savedIndicatorTimer.clear();
    setSaveStatus('idle');
    setTargetSection(undefined);
    pendingSettingsNavInteractionRef.current = null;
    pendingOpenResolutionMetaRef.current = null;
    stickyDirtyKeysRef.current.clear();
    setSettingsOpen(false);
  }, [autoSaveTimer, performAutoSave, savedIndicatorTimer]);

  // Clear target section after scroll completes (called from SettingsSurface)
  const clearTargetSection = useCallback(() => {
    setTargetSection(undefined);
  }, []);

  const requestPendingSpacesAction = useCallback((action: PendingSpacesAction['action']) => {
    setPendingSpacesAction({
      id: createPendingSpacesActionId(),
      action,
    });
  }, []);

  const consumePendingSpacesAction = useCallback((actionId: string) => {
    setPendingSpacesAction((current) => (current?.id === actionId ? null : current));
  }, []);

  const saveSettingsWith = useCallback(
    async (override?: (draft: AppSettings) => AppSettings, options?: { keepOpen?: boolean }) => {
      // Use ref instead of state to avoid stale closure issues.
      // Long-running async operations (like use case generation) can hold stale
      // draftSettings references, causing them to overwrite changes made by other
      // saves (e.g., onboardingCompleted getting reset to false).
      let current = draftSettingsRef.current;
      
      // If draft ref isn't populated yet (e.g., called before refreshSettings completes),
      // fetch current settings to avoid silent failure. This ensures settings can be
      // saved even during early lifecycle events like onboarding completion.
      if (!current) {
        emitLog({
          level: 'warn',
          message: 'saveSettingsWith: draft ref was null, fetching fresh settings',
          timestamp: Date.now()
        });
        try {
          const freshSettings = await window.settingsApi.get();
          current = normalizeSettings(freshSettings);
          draftSettingsRef.current = current;
          setDraftSettings(current);
          // Also update settings state so subsequent logic uses correct baseline
          setSettings(current);
        } catch (err) {
          emitLog({
            level: 'error',
            message: 'saveSettingsWith: Failed to fetch settings when draft was null',
            context: { error: err instanceof Error ? err.message : String(err) },
            timestamp: Date.now()
          });
          return;
        }
      }
      const draftToSave = override ? override(current) : current;
      const draftModels = readModelSettings(draftToSave);
      // Snapshot dirty keys before the async IPC call (same guard as performAutoSave).
      const keysBeforeSave = new Set(dirtyKeysRef.current);
      try {
        // Use current as baseline when settings state isn't populated yet (early lifecycle)
        const baseline = settings ?? current;
        const baselineModels = readModelSettings(baseline);
        const wasConfigured = Boolean(baseline?.coreDirectory && baselineModels.apiKey);
        const willBeConfigured = Boolean(draftToSave.coreDirectory && draftModels.apiKey);
        const isNowConfigured = !wasConfigured && willBeConfigured;

        // Track which fields changed
        const changedFields: string[] = [];
        if (settings) {
          const settingsModels = readModelSettings(settings);
          if (draftToSave.coreDirectory !== settings.coreDirectory) {
            changedFields.push('coreDirectory');
            tracking.settings.libraryDirectoryChanged();
          }
          if (draftModels.model !== settingsModels.model) {
            changedFields.push('model');
            tracking.settings.modelChanged(draftModels.model);
          }
          if (draftModels.permissionMode !== settingsModels.permissionMode) {
            changedFields.push('permissionMode');
            tracking.settings.permissionModeChanged(draftModels.permissionMode);
          }
        }

        const next = await window.settingsApi.update({
          ...draftToSave,
          models: draftModels,
        });
        const normalized = normalizeSettings(next);
        setSettings(normalized);
        setDraftSettings(normalized);
        // Also update the ref to keep it in sync
        draftSettingsRef.current = normalized;
        // Only clear keys that were dirty when we started saving (see performAutoSave).
        for (const key of keysBeforeSave) {
          dirtyKeysRef.current.delete(key);
        }

        // Track settings saved with changed fields
        if (changedFields.length > 0) {
          tracking.settings.saved(changedFields);
        }

        if (!options?.keepOpen) {
          setSettingsOpen(false);
        }
        onError?.(null);

        if (isNowConfigured) {
          onConfigurationComplete?.();
        }
      } catch (updateError) {
        const errorMessage = updateError instanceof Error ? updateError.message : String(updateError);
        onError?.(errorMessage);
        emitLog({
          level: 'error',
          message: 'Failed to save settings',
          context: { error: errorMessage },
          timestamp: Date.now()
        });
        throw updateError;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps intentionally narrowed to specific settings fields to avoid cascading callback recreation on every settings change
    [emitLog, onConfigurationComplete, onError, readModelSettings(settings).apiKey, settings?.coreDirectory]
  );

  const scheduleAutoSave = useCallback(() => {
    // Mark that a save is pending - used by closeSettingsDialog to flush on close
    hasPendingAutoSaveRef.current = true;
    autoSaveTimer.set(() => {
      void performAutoSave();
    }, AUTO_SAVE_DEBOUNCE_MS);
  }, [autoSaveTimer, performAutoSave]);

  const updateDraft = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    // Update ref synchronously BEFORE scheduling auto-save (setState callback is async/batched)
    if (draftSettingsRef.current) {
      draftSettingsRef.current = { ...draftSettingsRef.current, [key]: value };
    }
    // Also update state for UI
    setDraftSettings((prev) => prev ? { ...prev, [key]: value } : prev);
    dirtyKeysRef.current.add(key);
    scheduleAutoSave();
  }, [scheduleAutoSave]);

  const updateClaude = useCallback(<K extends keyof ModelSettings>(key: K, value: ModelSettings[K]) => {
    // Update ref synchronously BEFORE scheduling auto-save
    if (draftSettingsRef.current) {
      const currentModels = readModelSettings(draftSettingsRef.current);
      draftSettingsRef.current = {
        ...draftSettingsRef.current,
        models: { ...currentModels, [key]: value },
      };
    }
    setDraftSettings((prev) => prev ? {
      ...prev,
      models: { ...readModelSettings(prev), [key]: value },
    } : prev);
    dirtyKeysRef.current.add('models');
    scheduleAutoSave();
  }, [scheduleAutoSave]);

  const markKeySticky = useCallback((key: keyof AppSettings) => {
    stickyDirtyKeysRef.current.add(key);
    dirtyKeysRef.current.add(key);
  }, []);

  const updateVoice = useCallback(<K extends keyof AppSettings['voice']>(key: K, value: AppSettings['voice'][K]) => {
    // Update ref synchronously BEFORE scheduling auto-save
    if (draftSettingsRef.current) {
      draftSettingsRef.current = { ...draftSettingsRef.current, voice: { ...draftSettingsRef.current.voice, [key]: value } };
    }
    setDraftSettings((prev) => prev ? { ...prev, voice: { ...prev.voice, [key]: value } } : prev);
    dirtyKeysRef.current.add('voice');
    scheduleAutoSave();
  }, [scheduleAutoSave]);

  const saveSettings = useCallback(async () => {
    await saveSettingsWith();
  }, [saveSettingsWith]);

  const chooseDirectory = useCallback(async () => {
    const selection = await window.settingsApi.chooseDirectory();
    if (selection) {
      updateDraft('coreDirectory', selection);
    }
  }, [updateDraft]);

  const chooseSafetyGuardSkill = useCallback(async () => {
    const coreDir = draftSettingsRef.current?.coreDirectory;
    if (!coreDir) {
      showToast({ title: 'Configure Library directory first' });
      return;
    }
    
    const rebelSystemDir = `${coreDir}/rebel-system`;
    const selection = await window.settingsApi.chooseFileInDirectory({
      baseDir: rebelSystemDir,
      filters: [
        { name: 'Skill files', extensions: ['md'] },
        { name: 'All files', extensions: ['*'] }
      ],
      returnRelative: true
    });
    if (selection) {
      // Update ref synchronously BEFORE scheduling auto-save (setState callback is async/batched)
      if (draftSettingsRef.current) {
        draftSettingsRef.current = {
          ...draftSettingsRef.current,
          systemSkills: {
            ...draftSettingsRef.current.systemSkills,
            safetyGuardPath: selection
          }
        };
      }
      setDraftSettings((prev) => prev ? {
        ...prev,
        systemSkills: {
          ...prev.systemSkills,
          safetyGuardPath: selection
        }
      } : prev);
      dirtyKeysRef.current.add('systemSkills');
      scheduleAutoSave();
    }
  }, [scheduleAutoSave, showToast]);

  const chooseMemoryUpdateSkill = useCallback(async () => {
    const coreDir = draftSettingsRef.current?.coreDirectory;
    if (!coreDir) {
      showToast({ title: 'Configure Library directory first' });
      return;
    }
    
    const rebelSystemDir = `${coreDir}/rebel-system`;
    const selection = await window.settingsApi.chooseFileInDirectory({
      baseDir: rebelSystemDir,
      filters: [
        { name: 'Skill files', extensions: ['md'] },
        { name: 'All files', extensions: ['*'] }
      ],
      returnRelative: true
    });
    if (selection) {
      // Update ref synchronously BEFORE scheduling auto-save (setState callback is async/batched)
      if (draftSettingsRef.current) {
        draftSettingsRef.current = {
          ...draftSettingsRef.current,
          systemSkills: {
            ...draftSettingsRef.current.systemSkills,
            memoryUpdatePath: selection
          }
        };
      }
      setDraftSettings((prev) => prev ? {
        ...prev,
        systemSkills: {
          ...prev.systemSkills,
          memoryUpdatePath: selection
        }
      } : prev);
      dirtyKeysRef.current.add('systemSkills');
      scheduleAutoSave();
    }
  }, [scheduleAutoSave, showToast]);

  const openChiefOfStaffReadme = useCallback(async () => {
    const coreDir = draftSettingsRef.current?.coreDirectory;
    if (!coreDir) {
      showToast({ title: 'Configure Library directory first' });
      return;
    }
    const cosSpace = draftSettingsRef.current?.spaces?.find(s =>
      s.type === 'chief-of-staff' || s.path.toLowerCase().replace(/\/$/, '') === 'chief-of-staff'
    );
    const cosDir = cosSpace?.path.replace(/\/$/, '') || 'Chief-of-Staff';
    const readmePath = `${coreDir}/${cosDir}/README.md`;
    try {
      await window.appApi.openPath(readmePath);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showToast({ title: `Failed to open ${cosDir}/README.md: ${errorMessage}` });
    }
  }, [showToast]);

  const chooseExecutable = useCallback(async () => {
    const selection = await window.settingsApi.chooseExecutable();
    if (selection) {
      updateClaude('executablePath', selection);
    }
  }, [updateClaude]);

  const refreshMcpSummary = useCallback(async (override?: AppSettings) => {
    setMcpSummaryLoading(true);
    setMcpSummaryError(null);
    const effectiveSettings = override ?? draftSettings ?? settings ?? undefined;
    
    try {
      // Phase 1: Fast load without health data (shows list quickly)
      const summary = await window.settingsApi.mcpSummary({ settings: effectiveSettings, skipMetadata: true });
      setMcpSummary(summary);
      setMcpSummaryLoading(false);
      
      tracking.tools.mcpSummaryLoaded(
        summary.status,
        summary.mode,
        summary.servers?.length ?? 0,
        summary.upstreamCount ?? 0,
        summary.managed?.isManaged ?? false
      );
      
      if (summary.error) {
        tracking.tools.mcpConfigError('load_error', summary.error);
      }
      
      // NOTE: We intentionally do not auto-fetch router metadata / health for Super-MCP.
      // That path spawns MCP processes (and can cause severe CPU spikes if a server is misconfigured).
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setMcpSummaryError(errorMessage);
      setMcpSummaryLoading(false);
      tracking.tools.mcpConfigError('load_failed', errorMessage);
      emitLog({
        level: 'error',
        message: 'Failed to load MCP summary',
        context: { error: errorMessage },
        timestamp: Date.now()
      });
    }
  }, [draftSettings, emitLog, settings]);

  const reloadConnectors = useCallback(async () => {
    try {
      const result = await window.settingsApi.mcpRestartSuperMcp();
      if (!result.success) {
        showToast({ title: `Failed to reload connectors${result.error ? `: ${result.error}` : ''}` });
        emitLog({
          level: 'error',
          message: 'Failed to restart Super-MCP during connector reload',
          context: { error: result.error },
          timestamp: Date.now()
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showToast({ title: `Failed to reload connectors: ${errorMessage}` });
      emitLog({
        level: 'error',
        message: 'Failed to restart Super-MCP during connector reload',
        context: { error: errorMessage },
        timestamp: Date.now()
      });
    }
    await refreshMcpSummary();
  }, [emitLog, refreshMcpSummary, showToast]);

  // chooseMcpFile must be defined AFTER refreshMcpSummary to avoid TDZ error
  const chooseMcpFile = useCallback(async () => {
    const currentPath = draftSettingsRef.current?.mcpConfigFile;
    // Get directory of current config to open picker there
    const currentDir = currentPath ? currentPath.substring(0, currentPath.lastIndexOf('/')) || currentPath.substring(0, currentPath.lastIndexOf('\\')) : undefined;
    
    let selection: string | null = null;
    if (currentDir) {
      // Open picker in current config's directory
      selection = await window.settingsApi.chooseFileInDirectory({
        baseDir: currentDir,
        filters: [
          { name: 'MCP config', extensions: ['json', 'jsonc', 'yaml', 'yml'] },
          { name: 'All files', extensions: ['*'] }
        ],
        returnRelative: false
      });
    } else {
      // No current config - use default picker
      selection = await window.settingsApi.chooseFile([
        { name: 'MCP config', extensions: ['json', 'jsonc', 'yaml', 'yml'] },
        { name: 'All files', extensions: ['*'] }
      ]);
    }
    
    if (selection) {
      updateDraft('mcpConfigFile', selection);
      // Refresh MCP summary with the new path - pass override to ensure we use the latest value
      // (draftSettings state may not be updated yet due to React batching)
      const updatedSettings = { ...draftSettingsRef.current, mcpConfigFile: selection };
      await refreshMcpSummary(updatedSettings as AppSettings);
    }
  }, [updateDraft, refreshMcpSummary]);

  useEffect(() => {
    if (!settingsOpen) {
      // Reset when settings close so next open will re-fetch
      hasLoadedMcpSummaryForSessionRef.current = false;
      return;
    }
    // Only load once per settings session to prevent alternating loading/no-mcp states
    // caused by refreshMcpSummary reference changes during auto-save
    if (hasLoadedMcpSummaryForSessionRef.current) {
      return;
    }
    hasLoadedMcpSummaryForSessionRef.current = true;
    void refreshMcpSummary();
  }, [settingsOpen, refreshMcpSummary]);

  // Router-first model: Ensure the router exists but don't change mcpConfigFile
  // The pointer should already be on the router from app startup migration
  // See docs/plans/finished/251130a_super_mcp_router_always_on.md
  const ensureManagedMcpConfig = useCallback(async () => {
    try {
      setMcpMutationPending(true);
      // This now creates the Super-MCP router (not managed.json)
      // We don't update mcpConfigFile - it should already point to router from startup
      await window.settingsApi.mcpEnsureManaged();
      await refreshMcpSummary();
      showToast({ title: 'Super-MCP router ready' });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showToast({ title: `Failed to prepare router config: ${errorMessage}` });
      emitLog({
        level: 'error',
        message: 'Failed to create Super-MCP router config',
        context: { error: errorMessage },
        timestamp: Date.now()
      });
    } finally {
      setMcpMutationPending(false);
    }
  }, [emitLog, refreshMcpSummary, showToast]);

  /** @deprecated Alias kept for compatibility - "RebelInternal" was split into 7 MCPs in v0.3.26 */
  const addRebelInternalServer = useCallback(async () => {
    try {
      setMcpMutationPending(true);
      const result = await window.settingsApi.mcpAddRebelServer();
      setMcpSummary(result.summary);
      tracking.tools.inboxConnected();
      showToast({ title: 'Rebel tools connected' });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      tracking.tools.connectionFailed('rebel-inbox', 'stdio', 'ADD_FAILED', 'internal_error');
      showToast({ title: `Failed to add Rebel tools: ${errorMessage}` });
      emitLog({
        level: 'error',
        message: 'Failed to add Rebel tools',
        context: { error: errorMessage },
        timestamp: Date.now()
      });
    } finally {
      setMcpMutationPending(false);
    }
  }, [emitLog, showToast]);

  const upsertMcpServer = useCallback(
    async (payload: McpServerUpsertPayload) => {
      try {
        setMcpMutationPending(true);
        const result = await window.settingsApi.mcpUpsertServer(payload);
        setMcpSummary(result.summary);
        tracking.tools.connected(
          payload.name,
          payload.transport ?? 'stdio',
          'custom',
          false
        );
        showToast({ title: 'MCP server saved' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        tracking.tools.connectionFailed(
          payload.name,
          payload.transport ?? 'stdio',
          'UPSERT_FAILED',
          'server_config_error'
        );
        showToast({ title: `Failed to save server: ${errorMessage}` });
        emitLog({
          level: 'error',
          message: 'Failed to save MCP server',
          context: { error: errorMessage },
          timestamp: Date.now()
        });
        throw error instanceof Error ? error : new Error(errorMessage);
      } finally {
        setMcpMutationPending(false);
      }
    },
    [emitLog, showToast]
  );

  const removeMcpServer = useCallback(
    async (serverName: string) => {
      try {
        setMcpMutationPending(true);
        const result = await window.settingsApi.mcpRemoveServer(serverName);
        setMcpSummary(result.summary);
        tracking.tools.disconnected(serverName, 'custom');
        showToast({ title: `Removed ${serverName}` });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showToast({ title: `Failed to remove server: ${errorMessage}` });
        emitLog({
          level: 'error',
          message: 'Failed to remove MCP server',
          context: { error: errorMessage },
          timestamp: Date.now()
        });
        throw error instanceof Error ? error : new Error(errorMessage);
      } finally {
        setMcpMutationPending(false);
      }
    },
    [emitLog, showToast]
  );

  const patchRouterPaths = useCallback(
    async (payload: McpRouterPathPatchPayload) => {
      try {
        setMcpMutationPending(true);
        const result = await window.settingsApi.mcpRouterPath(payload);
        setMcpSummary(result.summary);
        showToast({ title: 'Router paths updated' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showToast({ title: `Failed to update router paths: ${errorMessage}` });
        emitLog({
          level: 'error',
          message: 'Failed to update Super-MCP router paths',
          context: { error: errorMessage },
          timestamp: Date.now()
        });
        throw error instanceof Error ? error : new Error(errorMessage);
      } finally {
        setMcpMutationPending(false);
      }
    },
    [emitLog, showToast]
  );

  const loadMcpServer = useCallback(
    async (serverName: string): Promise<McpServerConfigDetails> => {
      try {
        return await window.settingsApi.mcpGetServer(serverName);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showToast({ title: `Failed to load server details: ${errorMessage}` });
        emitLog({
          level: 'error',
          message: 'Failed to load MCP server details',
          context: { error: errorMessage, serverName },
          timestamp: Date.now()
        });
        throw error;
      }
    },
    [emitLog, showToast]
  );

  const settingsMigrationDegraded =
    Boolean(draftSettings?.settingsMigrationDegraded ?? settings?.settingsMigrationDegraded);

  return useMemo(
    () => ({
      settings,
      draftSettings,
      settingsMigrationDegraded,
      settingsOpen,
      activeTab,
      setActiveTab,
      targetSection,
      clearTargetSection,
      pendingSpacesAction,
      requestPendingSpacesAction,
      consumePendingSpacesAction,
      saveStatus,
      mcpSummary,
      mcpSummaryLoading,
      mcpSummaryError,
      mcpHealthLoading,
      mcpMutationPending,
      analyticsStatus,
      analyticsStatusLoading,
      openSettingsDialog,
      closeSettingsDialog,
      consumePendingSettingsNavigationInteraction,
      consumePendingOpenResolutionMeta,
      setSettingsLeafTab,
      updateDraft,
      updateClaude,
      updateVoice,
      markKeySticky,
      saveSettings,
      saveSettingsWith,
      chooseDirectory,
      chooseExecutable,
      chooseSafetyGuardSkill,
      chooseMemoryUpdateSkill,
      chooseMcpFile,
      openChiefOfStaffReadme,
      refreshMcpSummary,
      reloadConnectors,
      ensureManagedMcpConfig,
      addRebelInternalServer,
      upsertMcpServer,
      removeMcpServer,
      patchRouterPaths,
      loadMcpServer,
      refreshSettings,
    }),
    [
      settings,
      draftSettings,
      settingsMigrationDegraded,
      settingsOpen,
      activeTab,
      targetSection,
      clearTargetSection,
      pendingSpacesAction,
      requestPendingSpacesAction,
      consumePendingSpacesAction,
      saveStatus,
      mcpSummary,
      mcpSummaryLoading,
      mcpSummaryError,
      mcpHealthLoading,
      mcpMutationPending,
      analyticsStatus,
      analyticsStatusLoading,
      openSettingsDialog,
      closeSettingsDialog,
      consumePendingSettingsNavigationInteraction,
      consumePendingOpenResolutionMeta,
      setSettingsLeafTab,
      updateDraft,
      updateClaude,
      updateVoice,
      markKeySticky,
      saveSettings,
      saveSettingsWith,
      chooseDirectory,
      chooseExecutable,
      chooseSafetyGuardSkill,
      chooseMemoryUpdateSkill,
      chooseMcpFile,
      openChiefOfStaffReadme,
      refreshMcpSummary,
      reloadConnectors,
      ensureManagedMcpConfig,
      addRebelInternalServer,
      upsertMcpServer,
      removeMcpServer,
      patchRouterPaths,
      loadMcpServer,
      refreshSettings,
    ]
  );
};
