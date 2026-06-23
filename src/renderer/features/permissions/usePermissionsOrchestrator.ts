import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, AutomationStoreState } from '@shared/types';
import { AutomationSchedule } from '@shared/utils/automationSchedule';
import { normalizeAutomationStoreStateFromBoundary } from '@shared/utils/automationBoundaryNormalization';
import { workspaceAccessStateFromResponse } from '@shared/workspace/workspaceAccessState';
import { clearCoachCompletionState } from '@renderer/features/onboarding/utils/coachCompletionState';
import type { EmitLogFn } from '@renderer/contexts';

type UsePermissionsOrchestratorOptions = {
  settings: AppSettings | null;
  saveSettingsWith: (override?: (draft: AppSettings) => AppSettings) => Promise<void>;
  emitLog: EmitLogFn;
  showToast: (message: { title: string }) => void;
};

class WorkspaceValidationError extends Error {
  code?: string;

  constructor(message: string, options?: { code?: string }) {
    super(message);
    this.name = 'WorkspaceValidationError';
    this.code = options?.code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type OnboardingSystemType = 'use-case-refresh' | 'wins-learnings-uncover' | 'source-capture';

function findQuarantinedSystemAutomationId(
  state: AutomationStoreState,
  systemType: OnboardingSystemType,
): string | undefined {
  for (const entry of state.quarantined) {
    if (!isRecord(entry.definition)) {
      continue;
    }

    const definition = entry.definition;
    if (definition.isSystem !== true || definition.systemType !== systemType) {
      continue;
    }

    const definitionId = definition.id;
    if (typeof definitionId === 'string' && definitionId.trim().length > 0) {
      return definitionId;
    }
  }

  return undefined;
}

export type PermissionsOrchestratorApi = {
  showPermissionOnboarding: boolean;
  openPermissionOnboarding: () => void;
  closePermissionOnboarding: () => void;
  showOnboardingWizard: boolean;
  handleConfigurationComplete: () => void;
  completeOnboardingFlow: (options?: { skipAudioIntro?: boolean }) => Promise<void>;
  handleRelaunchOnboarding: () => Promise<void>;
};

let onboardingWizardOverrideSnapshot: boolean | null = null;

export const usePermissionsOrchestrator = ({
  settings,
  saveSettingsWith,
  emitLog,
  showToast
}: UsePermissionsOrchestratorOptions): PermissionsOrchestratorApi => {
  const [showPermissionOnboarding, setShowPermissionOnboarding] = useState(false);
  // Initialize to null (undetermined) until settings are loaded.
  // This prevents flashing the main app while we determine onboarding state.
  const [showOnboardingWizardOverride, setShowOnboardingWizardOverrideInternal] = useState<boolean | null>(
    () => onboardingWizardOverrideSnapshot
  );
  const setShowOnboardingWizardOverride = useCallback((value: boolean | null) => {
    onboardingWizardOverrideSnapshot = value;
    setShowOnboardingWizardOverrideInternal(value);
  }, []);
  const suppressPermissionOnboardingRef = useRef(false);
  
  // Derive showOnboardingWizard synchronously from settings when no override exists.
  // If settings aren't loaded yet, default to true to avoid flashing the main app.
  // Once explicitly set (e.g., after completing onboarding), use the override value.
  const needsOnboarding = showOnboardingWizardOverride ?? (settings ? !settings.onboardingCompleted : true);
  
  // Show wizard whenever onboarding is needed
  const showOnboardingWizard = needsOnboarding;

  // Guard against race conditions: Only reset the override if onboarding was truly never completed.
  // The onboardingFirstCompletedAt timestamp is more reliable than onboardingCompleted boolean during
  // settings refresh cycles. This prevents the wizard from re-appearing during post-onboarding
  // flows (UseCaseReveal) due to transient settings state.
  useEffect(() => {
    if (settings && !settings.onboardingCompleted && !settings.onboardingFirstCompletedAt && showOnboardingWizardOverride === false) {
      setShowOnboardingWizardOverride(null);
    }
  }, [settings, showOnboardingWizardOverride, setShowOnboardingWizardOverride]);

  const needsPermissionOnboarding = useCallback(async () => {
    try {
      const micStatus = await window.permissionsApi.getMicrophoneStatus();
      if (micStatus !== 'granted') {
        return true;
      }
    } catch (error) {
      emitLog({
        level: 'warn',
        message: 'Failed to retrieve microphone permission status',
        context: { error: error instanceof Error ? error.message : String(error) },
        timestamp: Date.now()
      });
      return true;
    }

    try {
      const fileAccessResult = await window.permissionsApi.checkFileAccess();
      if (!fileAccessResult.hasAccess) {
        if (fileAccessResult.reason === 'no-workspace-configured') {
          return false;
        }
        return true;
      }
    } catch (error) {
      emitLog({
        level: 'warn',
        message: 'Failed to verify library folder access',
        context: { error: error instanceof Error ? error.message : String(error) },
        timestamp: Date.now()
      });
      return true;
    }

    return false;
  }, [emitLog]);

  const checkAndShowPermissionOnboarding = useCallback(async () => {
    if (suppressPermissionOnboardingRef.current) {
      return false;
    }

    const onboardingShown = localStorage.getItem('permission-onboarding-shown');
    if (onboardingShown) {
      return false;
    }

    const shouldPrompt = await needsPermissionOnboarding();
    if (!shouldPrompt || suppressPermissionOnboardingRef.current) {
      return false;
    }

    setShowPermissionOnboarding(true);
    localStorage.setItem('permission-onboarding-shown', 'true');
    return true;
  }, [needsPermissionOnboarding]);

  const handleConfigurationComplete = useCallback(() => {
    if (suppressPermissionOnboardingRef.current) {
      return;
    }

    setTimeout(() => {
      void checkAndShowPermissionOnboarding();
    }, 300);
  }, [checkAndShowPermissionOnboarding]);

  const completeOnboardingFlow = useCallback(async (options?: { skipAudioIntro?: boolean }) => {
    emitLog({ level: 'info', message: 'Onboarding: completeOnboardingFlow started', context: { skipAudioIntro: options?.skipAudioIntro ?? false }, timestamp: Date.now() });
    suppressPermissionOnboardingRef.current = true;
    let didPersistOnboardingCompletion = false;
    try {
      const coreDirectory = settings?.coreDirectory;
      if (!coreDirectory) {
        showToast({ title: 'Choose a Library folder to continue' });
        throw new WorkspaceValidationError('Library folder not configured.');
      }

      const workspaceCheck = await window.systemHealthApi.validateWorkspaceAccess({
        path: coreDirectory,
        createIfMissing: true,
      });
      const accessState = workspaceAccessStateFromResponse(workspaceCheck);
      if (accessState.status !== 'accessible') {
        emitLog({
          level: 'error',
          message: 'Onboarding: Workspace not accessible at completion',
          context: {
            coreDirectory,
            code: workspaceCheck.code,
            error: workspaceCheck.error,
            resolvedPath: workspaceCheck.resolvedPath,
          },
          timestamp: Date.now(),
        });
        const toastTitle = accessState.status === 'denied'
          ? "Your organisation's security policy may be blocking folder access. Choose a different location."
          : "Can't access your Library folder. Choose a different location.";
        showToast({ title: toastTitle });
        throw new WorkspaceValidationError(
          workspaceCheck.error ?? "Can't access your Library folder.",
          { code: workspaceCheck.code }
        );
      }

      emitLog({ level: 'debug', message: 'Onboarding: Saving settings with onboardingCompleted=true', timestamp: Date.now() });
      await saveSettingsWith((current) => ({
        ...current,
        onboardingCompleted: true,
        // Only set if null - preserves first completion timestamp on re-onboarding
        onboardingFirstCompletedAt: current.onboardingFirstCompletedAt ?? Date.now(),
        // Initialize checklist for new users (step 1); preserve existing state on re-onboarding
        onboardingChecklist: current.onboardingChecklist ?? { step: 1 }
      }));
      didPersistOnboardingCompletion = true;
      emitLog({ level: 'debug', message: 'Onboarding: Settings saved successfully', timestamp: Date.now() });
      localStorage.setItem('permission-onboarding-shown', 'true');
      setShowPermissionOnboarding(false);

      // Ensure workspace symlinks are created during onboarding.
      // This awaits completion instead of the fire-and-forget approach in settings:update.
      if (!options?.skipAudioIntro) {
        try {
          await window.settingsApi.ensureWorkspaceSymlinks();
        } catch (symlinkError) {
          // Log but don't fail onboarding if symlink creation fails
          emitLog({
            level: 'warn',
            message: 'Failed to ensure library symlinks during onboarding',
            context: { error: symlinkError instanceof Error ? symlinkError.message : String(symlinkError) },
            timestamp: Date.now()
          });
        }
      }

      // Create or update the daily use case refresh system automation
      try {
        // Check if one already exists to avoid duplicates on re-onboarding
        const currentState = normalizeAutomationStoreStateFromBoundary(await window.automationsApi.state());
        const existing = currentState.definitions.find(
          (def) => def.isSystem && def.systemType === 'use-case-refresh'
        );
        const existingId = existing?.id ?? findQuarantinedSystemAutomationId(currentState, 'use-case-refresh');

        await window.automationsApi.upsert({
          id: existingId, // Reuse existing ID (including quarantined entries) to avoid duplicate system defaults
          name: 'Workflow Refresh',
          description: 'Discovers new workflows by analysing your emails, calendar, and messages daily',
          filePath: '',
          schedule: AutomationSchedule.daily({ time: '17:00' }),
          enabled: existing?.enabled ?? true, // Preserve user's enabled preference if they toggled it off
          catchUpIfMissed: true,
          isSystem: true,
          systemType: 'use-case-refresh'
        });
      } catch (automationError) {
        // Log but don't fail onboarding if automation creation fails
        emitLog({
          level: 'warn',
          message: 'Failed to create workflow refresh automation',
          context: { error: automationError instanceof Error ? automationError.message : String(automationError) },
          timestamp: Date.now()
        });
      }

      // Create or update the daily wins & learnings system automation
      try {
        const currentState = normalizeAutomationStoreStateFromBoundary(await window.automationsApi.state());
        const existingWinsLearnings = currentState.definitions.find(
          (def) => def.isSystem && def.systemType === 'wins-learnings-uncover'
        );
        const existingId = existingWinsLearnings?.id ??
          findQuarantinedSystemAutomationId(currentState, 'wins-learnings-uncover');

        await window.automationsApi.upsert({
          id: existingId,
          name: 'Daily Wins & Learnings',
          description: 'Uncover your most impactful wins and learnings from the past 24 hours',
          filePath: 'rebel-system/skills/operations/wins-and-learnings-uncover/SKILL.md',
          schedule: AutomationSchedule.daily({ time: '09:30' }),
          enabled: existingWinsLearnings?.enabled ?? true,
          catchUpIfMissed: true,
          isSystem: true,
          systemType: 'wins-learnings-uncover'
        });
      } catch (automationError) {
        emitLog({
          level: 'warn',
          message: 'Failed to create wins & learnings automation',
          context: { error: automationError instanceof Error ? automationError.message : String(automationError) },
          timestamp: Date.now()
        });
      }

      // Create or update the source-capture system automation (runs twice daily)
      try {
        const currentState = normalizeAutomationStoreStateFromBoundary(await window.automationsApi.state());
        const existingSourceCapture = currentState.definitions.find(
          (def) => def.isSystem && def.systemType === 'source-capture'
        );
        const existingId = existingSourceCapture?.id ?? findQuarantinedSystemAutomationId(currentState, 'source-capture');

        await window.automationsApi.upsert({
          id: existingId,
          name: 'Source Capture',
          description: 'Capture citable sources (meetings, documents, files) into memory with provenance metadata',
          filePath: 'rebel-system/skills/memory/source-capture/AUTOMATION.md',
          schedule: AutomationSchedule.daily({ time: '12:30', additionalTimes: ['09:30', '15:00', '17:30'] }),
          enabled: existingSourceCapture?.enabled ?? true,
          catchUpIfMissed: true,
          model: (existingSourceCapture as { model?: string })?.model ?? 'claude-sonnet-4-6',
          isSystem: true,
          systemType: 'source-capture'
        } as Parameters<typeof window.automationsApi.upsert>[0]);
      } catch (automationError) {
        emitLog({
          level: 'warn',
          message: 'Failed to create source-capture automation',
          context: { error: automationError instanceof Error ? automationError.message : String(automationError) },
          timestamp: Date.now()
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      emitLog({
        level: 'error',
        message: 'Onboarding: Failed to complete onboarding flow',
        context: { error: errorMessage },
        timestamp: Date.now()
      });
      showToast({ title: 'Failed to finish onboarding. Please try again.' });
      throw error;
    } finally {
      // Defensive: only hide the wizard after onboarding completion is persisted.
      // If persistence fails, keep the wizard visible so the user can retry.
      if (didPersistOnboardingCompletion) {
        suppressPermissionOnboardingRef.current = false;
        setShowOnboardingWizardOverride(false);
      }
      emitLog({ level: 'info', message: 'Onboarding: completeOnboardingFlow finished', timestamp: Date.now() });
    }
  }, [emitLog, saveSettingsWith, setShowOnboardingWizardOverride, settings?.coreDirectory, showToast]);

  const handleRelaunchOnboarding = useCallback(async () => {
    suppressPermissionOnboardingRef.current = true;
    try {
      // Reset all onboarding-related settings. clearCoachCompletionState is
      // the SSOT for which coach completion/resume signals must be cleared —
      // a hand-rolled field list here drifted from the App.tsx suppression
      // signals once already, leaving relaunching users with no activation
      // card and no coach.
      await saveSettingsWith((current) => ({
        ...clearCoachCompletionState(current),
        // Reopen the wizard — relaunch-specific, not a coach completion signal
        onboardingCompleted: false
      }));
      
      // Reset the 14-day journey state in achievements store
      // (completedDays, journeyStartedAt, graduationModalShown)
      if (window.api.resetOnboardingJourney) {
        try {
          await window.api.resetOnboardingJourney();
        } catch (journeyError) {
          // Log but don't fail the overall reset
          emitLog({
            level: 'warn',
            message: 'Failed to reset onboarding journey state',
            context: { error: journeyError instanceof Error ? journeyError.message : String(journeyError) },
            timestamp: Date.now()
          });
        }
      } else {
        emitLog({
          level: 'warn',
          message: 'resetOnboardingJourney API not available - journey state not reset',
          timestamp: Date.now()
        });
      }
      
      localStorage.removeItem('permission-onboarding-shown');
      setShowPermissionOnboarding(false);
      setShowOnboardingWizardOverride(true);
      showToast({ title: 'Onboarding relaunched' });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showToast({ title: 'Failed to relaunch onboarding' });
      emitLog({
        level: 'error',
        message: 'Failed to relaunch onboarding',
        context: { error: errorMessage },
        timestamp: Date.now()
      });
    } finally {
      suppressPermissionOnboardingRef.current = false;
    }
  }, [emitLog, saveSettingsWith, setShowOnboardingWizardOverride, showToast]);

  // No longer need an effect to initialize showOnboardingWizard - it's derived synchronously above.
  // The derivation uses settings.onboardingCompleted directly when no override is set.

  useEffect(() => {
    suppressPermissionOnboardingRef.current = showOnboardingWizard;
  }, [showOnboardingWizard]);

  const openPermissionOnboarding = useCallback(() => {
    setShowPermissionOnboarding(true);
  }, []);

  const closePermissionOnboarding = useCallback(() => {
    setShowPermissionOnboarding(false);
  }, []);

  return {
    showPermissionOnboarding,
    openPermissionOnboarding,
    closePermissionOnboarding,
    showOnboardingWizard,
    handleConfigurationComplete,
    completeOnboardingFlow,
    handleRelaunchOnboarding
  };
};
