import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AppSettings, PersonalizedUseCase } from '@shared/types';
import type { ValidateWorkspaceAccessResponse } from '@shared/ipc/channels/health';
import { redactSensitiveString } from '@shared/utils/sentryRedaction';
import { workspaceAccessStateFromResponse } from '@shared/workspace/workspaceAccessState';
import { getApiKey } from '@renderer/features/settings/utils/modelAuthAccessors';
import { useSettings } from '../settings';
import { tracking } from '../../src/tracking';
import { rendererIsOss } from '../../src/rendererIsOss';
import { fireOssLeadCaptureOnContinue } from './ossLeadCaptureOnContinue';
import { useTimeoutRef } from '@renderer/hooks/useTimeoutRef';
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '@renderer/components/ui';
import {
  useOnboardingFlow,
  DISPLAY_STEPS,
  STEP_LABELS,
  STEP_ACCESSIBLE_LABELS,
  isTrackedOnboardingStep,
  type ToolAuthState,
} from './hooks';
import { useEscapeHatchHotkey } from './hooks/useEscapeHatchHotkey';
import { ConnectorSetupDialog } from '@renderer/features/settings/components/ConnectorSetupDialog';
import {
  isConnectedStatus,
  isErrorStatus,
  isGeneratingStatus,
  isPendingStatus,
  isPollingStatus,
  isReadyToConnectStatus,
  isVerifyingStatus,
} from './hooks/toolAuthMachine';
import styles from './OnboardingWizard.module.css';
import introStyles from './OnboardingShared.module.css';
import loadingGif from '@renderer/assets/animations/loading.gif';

// Extracted components
import { StepPill, SideAnnotation } from './components';
import {
  WelcomeStep,
  GoogleDriveStep,
  ApiStep,
  ToolAuthStep,
  VoiceSetupStep,
  MigrationImportStep,
} from './steps';

type OnboardingWizardProps = {
  isOpen: boolean;
  completeOnboarding: (options?: { skipAudioIntro?: boolean }) => Promise<void>;
  onUserNameFetched?: (firstName: string | null) => void;
  onUseCasesGenerated?: (useCases: PersonalizedUseCase[]) => void;
  onUseCaseGenerationFailed?: () => void;
  onDraftElevenlabsKeyChange?: (key: string | null) => void;
  /** Called when user enters the final setup step (toolAuth) - App.tsx uses this to start use case generation at the App level (survives wizard unmount) */
  onFinalSetupStepEntered?: () => void;
};

export const OnboardingWizard = ({
  isOpen,
  completeOnboarding,
  onUserNameFetched,
  onUseCasesGenerated,
  onUseCaseGenerationFailed,
  onDraftElevenlabsKeyChange,
  onFinalSetupStepEntered,
}: OnboardingWizardProps) => {
  // Get settings from context
  const {
    draftSettings,
    updateDraft,
    updateClaude,
    updateVoice,
    saveSettings,
  } = useSettings();
  const { state, actions } = useOnboardingFlow({
    isOpen,
    draftSettings,
    completeOnboarding,
    onUserNameFetched,
  });

  const {
    stepIndex,
    activeStep,
    totalSteps,
    canProceed,
    isCompleting,
    canSkipToolAuth,
    toolAuthStates,
    isGeneratingAuthLinks,
    toolAuthReady,
    activeAuthTool,
    companyName,
    googleDriveError,
    useCaseGenerationStatus,
    generatedUseCases,
    voiceProvider,
  } = state;

  const {
    setStepIndex,
    goNext,
    goBack,
    generateAuthLink,
    startOAuthFlow,
    verifyToolAuth,
    completeOnboardingWithOrganisationSeed,
    setCompletionError,
    setIsCompleting,
    startMigrationImportBranch,
    startStandardSetupBranch,
  } = actions;

  // API key validation state
  const [isValidatingClaude, setIsValidatingClaude] = useState(false);
  const [claudeValidationMessage, setClaudeValidationMessage] = useState<string | null>(null);
  const [claudeValidationOk, setClaudeValidationOk] = useState<boolean | null>(null);
  const [isValidatingOpenAI, setIsValidatingOpenAI] = useState(false);
  const [openAiValidationMessage, setOpenAiValidationMessage] = useState<string | null>(null);
  const [openAiValidationOk, setOpenAiValidationOk] = useState<boolean | null>(null);
  const [openAiValidationReason, setOpenAiValidationReason] = useState<string | null>(null);
  const [isValidatingElevenLabs, setIsValidatingElevenLabs] = useState(false);
  const [elevenLabsValidationMessage, setElevenLabsValidationMessage] = useState<string | null>(null);
  const [elevenLabsValidationOk, setElevenLabsValidationOk] = useState<boolean | null>(null);

  const clearOpenAiValidation = useCallback(() => {
    setOpenAiValidationMessage(null);
    setOpenAiValidationOk(null);
    setOpenAiValidationReason(null);
  }, []);

  const clearElevenLabsValidation = useCallback(() => {
    setElevenLabsValidationMessage(null);
    setElevenLabsValidationOk(null);
  }, []);

  // Escape hatch and UI state
  const [showEscapeConfirm, setShowEscapeConfirm] = useState(false);
  const [showMoreToolsTip, setShowMoreToolsTip] = useState(false);

  const connectedToolCount = useMemo(
    () => toolAuthStates.filter((t) => isConnectedStatus(t.status)).length,
    [toolAuthStates]
  );

  useEffect(() => {
    if (connectedToolCount >= 3) {
      setShowMoreToolsTip(true);
    }
  }, [connectedToolCount]);

  const stepStartTimeRef = useRef<number>(Date.now());
  const onboardingStartTimeRef = useRef<number>(Date.now());
  const hasNotifiedUseCasesRef = useRef(false);
  const slowConnectionHintTimer = useTimeoutRef();
  const [showSlowConnectionHint, setShowSlowConnectionHint] = useState(false);

  const isDevMode = import.meta.env.DEV;

  // Validation callbacks (return boolean for use in handleContinue)
  const validateClaudeKey = useCallback(async (apiKey: string | null | undefined): Promise<boolean> => {
    const key = apiKey?.trim();
    if (!key) {
      setClaudeValidationMessage(null);
      setClaudeValidationOk(null);
      return false;
    }
    setIsValidatingClaude(true);
    setClaudeValidationMessage('Validating Claude key…');
    setClaudeValidationOk(null);
    try {
      const result = await window.settingsApi.validateClaudeKey({ apiKey: key });
      setClaudeValidationMessage(result.ok ? result.message || 'Claude key is valid.' : result.message || 'Claude key validation failed.');
      setClaudeValidationOk(result.ok);
      return result.ok;
    } catch (error: unknown) {
      const message = error instanceof Error ? redactSensitiveString(error.message) : 'Claude key validation failed.';
      setClaudeValidationMessage(message);
      setClaudeValidationOk(false);
      return false;
    } finally {
      setIsValidatingClaude(false);
    }
  }, []);

  const validateOpenAiKey = useCallback(async (apiKey: string | null | undefined): Promise<boolean> => {
    const key = apiKey?.trim();
    if (!key) {
      setOpenAiValidationMessage(null);
      setOpenAiValidationOk(null);
      setOpenAiValidationReason(null);
      return false;
    }
    setIsValidatingOpenAI(true);
    setOpenAiValidationMessage('Validating OpenAI key…');
    setOpenAiValidationOk(null);
    setOpenAiValidationReason(null);
    try {
      const result = await window.settingsApi.validateOpenaiKey({ apiKey: key, deepValidate: true });
      setOpenAiValidationMessage(result.ok ? result.message || 'OpenAI key is valid.' : result.message || 'OpenAI key validation failed.');
      setOpenAiValidationOk(result.ok);
      setOpenAiValidationReason(result.reason ?? null);
      return result.ok;
    } catch (error: unknown) {
      const message = error instanceof Error ? redactSensitiveString(error.message) : 'OpenAI key validation failed.';
      setOpenAiValidationMessage(message);
      setOpenAiValidationOk(false);
      setOpenAiValidationReason(null);
      return false;
    } finally {
      setIsValidatingOpenAI(false);
    }
  }, []);

  const validateElevenLabsKey = useCallback(async (apiKey: string | null | undefined): Promise<boolean> => {
    const key = apiKey?.trim();
    if (!key) {
      setElevenLabsValidationMessage(null);
      setElevenLabsValidationOk(null);
      return false;
    }
    setIsValidatingElevenLabs(true);
    setElevenLabsValidationMessage('Validating ElevenLabs key…');
    setElevenLabsValidationOk(null);
    try {
      const result = await window.settingsApi.validateElevenlabsKey({ apiKey: key });
      setElevenLabsValidationMessage(result.ok ? result.message || 'ElevenLabs key is valid.' : result.message || 'ElevenLabs key validation failed.');
      setElevenLabsValidationOk(result.ok);
      return result.ok;
    } catch (error: unknown) {
      const message = error instanceof Error ? redactSensitiveString(error.message) : 'ElevenLabs key validation failed.';
      setElevenLabsValidationMessage(message);
      setElevenLabsValidationOk(false);
      return false;
    } finally {
      setIsValidatingElevenLabs(false);
    }
  }, []);

  // Track step timing
  useEffect(() => {
    stepStartTimeRef.current = Date.now();
  }, [stepIndex]);

  // Migrate voice provider to local-parakeet on supported platforms (FOX-2921)
  // For new users the store default is already local-parakeet, but returning users
  // who re-enter onboarding (or enter via demo mode) may still have the old
  // openai-whisper default. Switch them to local regardless of whether they have
  // voice API keys — having a key doesn't mean they deliberately chose openai-whisper
  // (keys may have been provisioned by auth config or copied by demo mode).
  // Users can still select openai-whisper manually in the dropdown.
  const voiceProviderMigratedRef = useRef(false);
  useEffect(() => {
    if (!isOpen || !draftSettings) {
      voiceProviderMigratedRef.current = false;
      return;
    }
    if (voiceProviderMigratedRef.current) return;
    voiceProviderMigratedRef.current = true;

    const supportsLocal = window.electronEnv?.platform === 'darwin' || window.electronEnv?.platform === 'win32';
    const isOldDefault = draftSettings.voice.provider === 'openai-whisper';

    if (supportsLocal && isOldDefault) {
      updateVoice('provider', 'local-parakeet');
      updateVoice('model', 'parakeet-v3');
    }
  }, [isOpen, draftSettings, updateVoice]);

  // Notify App.tsx when entering the final setup step (toolAuth) so it can start
  // use case generation. This ensures generation survives wizard unmount.
  const finalSetupStepNotifiedRef = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      finalSetupStepNotifiedRef.current = false;
      return;
    }
    if (activeStep === 'toolAuth' && !finalSetupStepNotifiedRef.current) {
      finalSetupStepNotifiedRef.current = true;
      onFinalSetupStepEntered?.();
    }
  }, [isOpen, activeStep, onFinalSetupStepEntered]);

  // Notify parent when use cases are generated
  useEffect(() => {
    if (useCaseGenerationStatus === 'success' && generatedUseCases.length > 0 && onUseCasesGenerated && !hasNotifiedUseCasesRef.current) {
      hasNotifiedUseCasesRef.current = true;
      onUseCasesGenerated(generatedUseCases);
    }
  }, [useCaseGenerationStatus, generatedUseCases, onUseCasesGenerated]);

  useEffect(() => {
    if (useCaseGenerationStatus === 'error' && onUseCaseGenerationFailed) {
      onUseCaseGenerationFailed();
    }
  }, [useCaseGenerationStatus, onUseCaseGenerationFailed]);

  // Notify parent of ElevenLabs API key changes for audio prefetch
  // This allows App.tsx to start prefetching before wizard closes
  useEffect(() => {
    if (!onDraftElevenlabsKeyChange) return;
    
    const isElevenLabs = voiceProvider === 'elevenlabs-scribe';
    const key = draftSettings?.voice.elevenlabsApiKey;
    
    if (isElevenLabs && key) {
      onDraftElevenlabsKeyChange(key);
    } else {
      onDraftElevenlabsKeyChange(null);
    }
  }, [voiceProvider, draftSettings?.voice.elevenlabsApiKey, onDraftElevenlabsKeyChange]);

  // Escape hatch hotkey
  const handleEscapeHatchTriggered = useCallback(() => {
    const timeSpentMs = Date.now() - onboardingStartTimeRef.current;
    if (isTrackedOnboardingStep(activeStep)) {
      tracking.onboarding.escapeHatchTriggered(activeStep, stepIndex, timeSpentMs);
    }
    setShowEscapeConfirm(true);
  }, [activeStep, stepIndex]);

  useEscapeHatchHotkey({ isActive: isOpen, onTrigger: handleEscapeHatchTriggered });

  const handleEscapeConfirm = useCallback(async () => {
    const timeSpentMs = Date.now() - onboardingStartTimeRef.current;
    const completedSteps = state.stepSequence.slice(0, stepIndex).filter(isTrackedOnboardingStep);
    if (isTrackedOnboardingStep(activeStep)) {
      tracking.onboarding.escapeHatchConfirmed(activeStep, stepIndex, timeSpentMs, completedSteps);
    }
    setShowEscapeConfirm(false);
    try {
      await completeOnboardingWithOrganisationSeed({ skipAudioIntro: true });
    } catch (error) {
      if (error instanceof Error && error.name === 'WorkspaceValidationError') {
        const apiStepIndex = state.stepSequence.indexOf('api');
        if (apiStepIndex >= 0) {
          setStepIndex(apiStepIndex);
        }
      }
      setCompletionError(error instanceof Error ? error.message : 'Failed to finish onboarding.');
    }
  }, [activeStep, stepIndex, completeOnboardingWithOrganisationSeed, setCompletionError, setStepIndex, state.stepSequence]);

  const handleEscapeCancel = useCallback(() => {
    if (isTrackedOnboardingStep(activeStep)) {
      tracking.onboarding.escapeHatchCancelled(activeStep, stepIndex);
    }
    setShowEscapeConfirm(false);
  }, [activeStep, stepIndex]);

  // Auto-generate auth link when activeAuthTool is set and tool is pending
  const lastProcessedToolRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen || activeStep !== 'toolAuth' || !activeAuthTool) {
      lastProcessedToolRef.current = null;
      return;
    }

    const toolState = toolAuthStates.find((t) => t.tool === activeAuthTool);
    if (!toolState) {
      return;
    }

    // Only auto-generate if tool is pending and we haven't already processed this tool
    // Status check handles: connected (background verify succeeded), generating/awaiting_auth (already processing)
    if (!isPendingStatus(toolState.status) || lastProcessedToolRef.current === activeAuthTool) {
      return;
    }

    lastProcessedToolRef.current = activeAuthTool;

    void generateAuthLink(activeAuthTool);
  }, [isOpen, activeStep, activeAuthTool, toolAuthStates, generateAuthLink]);

  // Show a hint if auth link generation takes a while (user may be seeing macOS dev tools prompt)
  useEffect(() => {
    // Clear any existing timer
    slowConnectionHintTimer.clear();

    // Only show hint on toolAuth step when actively generating
    if (activeStep !== 'toolAuth' || !isGeneratingAuthLinks) {
      setShowSlowConnectionHint(false);
      return;
    }

    // Start timer - show hint after 8 seconds
    slowConnectionHintTimer.set(() => {
      setShowSlowConnectionHint(true);
    }, 8000);
  }, [activeStep, isGeneratingAuthLinks, slowConnectionHintTimer]);

  // Use refs for action methods to avoid recreating callbacks
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const coreDirectoryRef = useRef(draftSettings?.coreDirectory);
  coreDirectoryRef.current = draftSettings?.coreDirectory;
  const draftSettingsRef = useRef(draftSettings);
  draftSettingsRef.current = draftSettings;
  const updateDraftRef = useRef(updateDraft);
  updateDraftRef.current = updateDraft;
  const saveSettingsRef = useRef(saveSettings);
  saveSettingsRef.current = saveSettings;

  // Auto-set default workspace path.
  // Uses refs for draftSettings/updateDraft to avoid re-running (and cancelling
  // in-flight async work) when unrelated draft mutations change the object reference.
  // The boolean `hasDraftSettings` ensures we fire once settings load.
  const defaultWorkspaceInitializedRef = useRef(false);
  const defaultWorkspaceInFlightRef = useRef(false);
  const hasDraftSettings = !!draftSettings;
  useEffect(() => {
    if (!isOpen || !hasDraftSettings) {
      defaultWorkspaceInitializedRef.current = false;
      return;
    }
    if (defaultWorkspaceInitializedRef.current) return;
    if (defaultWorkspaceInFlightRef.current) return;
    if (draftSettingsRef.current?.coreDirectory) {
      defaultWorkspaceInitializedRef.current = true;
      return;
    }

    defaultWorkspaceInFlightRef.current = true;

    let cancelled = false;
    void (async () => {
      try {
        const suggested = await window.settingsApi.getDefaultWorkspace();
        if (cancelled) return;
        // Avoid racing with user input that sets coreDirectory while we were awaiting.
        if (coreDirectoryRef.current) return;

        // Validate the default folder exists and is accessible before persisting.
        // On Windows with Controlled Folder Access (CFA), writes to Documents may be
        // blocked. We must NOT save an inaccessible path as coreDirectory — that causes
        // a UX deadlock where onboarding can never complete (FOX-2873).
        let validationResult: ValidateWorkspaceAccessResponse = { accessible: false };
        try {
          validationResult = await window.systemHealthApi.validateWorkspaceAccess({ path: suggested, createIfMissing: true });
        } catch {
          // Validation call itself failed — treat as inaccessible
        }

        if (cancelled) return;
        // Re-check after await — user may have picked a directory via chooseDirectory
        if (coreDirectoryRef.current) return;

        const accessState = workspaceAccessStateFromResponse(validationResult);
        if (accessState.status !== 'accessible') {
          // Don't save the inaccessible path — the ApiStep library pre-confirmation
          // will show "Change" so the user can pick an accessible location.
          // Mark as initialized to prevent re-running this effect on re-render.
          defaultWorkspaceInitializedRef.current = true;
          defaultWorkspaceInFlightRef.current = false;
          return;
        }

        updateDraftRef.current('coreDirectory', suggested as AppSettings['coreDirectory']);
        defaultWorkspaceInitializedRef.current = true;

        // Eagerly persist coreDirectory so main-process IPC handlers (e.g.
        // library:create-space, library:scan-spaces) can use it immediately.
        // Without this, the 800ms auto-save debounce may not have fired by the
        // time the user reaches the Spaces step and tries to add a space,
        // causing "Core directory is not configured" errors.
        try {
          await saveSettingsRef.current();
        } catch {
          // Non-fatal — auto-save will eventually persist it
        }
      } catch {
        // ignore
      } finally {
        defaultWorkspaceInFlightRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hasDraftSettings, isOpen]);

  // Permission checking
  const probeMicrophoneAccess = useCallback(async (): Promise<boolean> => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      return true;
    } catch {
      return false;
    }
  }, []);

  const microphoneAttemptRef = useRef(0);

  const checkMicrophone = useCallback(async () => {
    try {
      actionsRef.current.setMicrophoneStatus('checking');
      const status = await window.permissionsApi.getMicrophoneStatus();
      if (status === 'granted') {
        const usable = await probeMicrophoneAccess();
        const finalStatus = usable ? 'granted' : 'denied';
        actionsRef.current.setMicrophoneStatus(finalStatus);
        if (finalStatus === 'granted') {
          tracking.onboarding.microphonePermissionGranted(microphoneAttemptRef.current);
        } else {
          tracking.onboarding.microphonePermissionDenied(microphoneAttemptRef.current);
        }
      } else {
        actionsRef.current.setMicrophoneStatus(status);
        if (status === 'denied') {
          tracking.onboarding.microphonePermissionDenied(microphoneAttemptRef.current);
        }
      }
    } catch {
      actionsRef.current.setMicrophoneStatus('not-determined');
    }
  }, [probeMicrophoneAccess]);

  const openSystemPrefs = useCallback(async (type: 'microphone' | 'files') => {
    try {
      await window.permissionsApi.openSystemPreferences(type);
    } catch {
      // ignore
    }
  }, []);

  const microphoneStatusRef = useRef(state.microphoneStatus);
  useEffect(() => { microphoneStatusRef.current = state.microphoneStatus; }, [state.microphoneStatus]);

  const startPolling = useCallback(
    (checkFn: () => Promise<void>, isDone: () => boolean, options?: { intervalMs?: number; timeoutMs?: number }) => {
      const intervalMs = options?.intervalMs ?? 1200;
      const timeoutMs = options?.timeoutMs ?? 15000;
      let cleared = false;
      const id = window.setInterval(() => {
        void checkFn();
        if (isDone()) {
          window.clearInterval(id);
          cleared = true;
        }
      }, intervalMs);
      window.setTimeout(() => {
        if (!cleared) window.clearInterval(id);
      }, timeoutMs);
    },
    []
  );

  const openPrefsAndPoll = useCallback(
    async (type: 'microphone' | 'files') => {
      if (type !== 'microphone') return;
      const initialMic = microphoneStatusRef.current;
      microphoneAttemptRef.current += 1;
      tracking.onboarding.microphonePermissionRequested(microphoneAttemptRef.current);
      
      // On macOS, we need to actually request microphone access to trigger the permission dialog.
      // Opening System Preferences alone does NOT prompt the user.
      // - If status is 'not-determined', requestMicrophone() triggers the OS dialog
      // - If status is 'denied', we must direct users to System Preferences (macOS won't re-prompt)
      const currentStatus = await window.permissionsApi.getMicrophoneStatus();
      if (currentStatus === 'not-determined') {
        const result = await window.permissionsApi.requestMicrophone();
        if (result.granted) {
          await checkMicrophone();
          return;
        }
      }
      await openSystemPrefs(type);
      startPolling(checkMicrophone, () => microphoneStatusRef.current !== initialMic);
    },
    [checkMicrophone, openSystemPrefs, startPolling]
  );

  useEffect(() => {
    if (!isOpen || activeStep !== 'voiceSetup') return;
    void checkMicrophone();
  }, [activeStep, checkMicrophone, isOpen]);

  useEffect(() => {
    if (!isOpen || activeStep !== 'voiceSetup') return;
    const handleFocus = () => {
      void checkMicrophone();
    };
    const handleVisibility = () => {
      if (!document.hidden) handleFocus();
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [activeStep, isOpen, checkMicrophone]);

  // NOTE: User name fetching has been moved to use case generation (useCaseGeneratorService.ts)
  // The use case generator already accesses email data and extracts the user's first name
  // as a byproduct, which is more reliable than a separate 15-second fetch.
  // App.tsx handles the userFirstName field from generateUseCases() result.

  // Handle finish
  const handleFinish = useCallback(async () => {
    if (isCompleting) return;
    setIsCompleting(true);
    setCompletionError(null);
    try {
      const durationOnStepMs = Date.now() - stepStartTimeRef.current;
      if (isTrackedOnboardingStep(activeStep)) {
        tracking.onboarding.stepCompleted(activeStep, durationOnStepMs, false);
      }
      const totalDurationMs = Date.now() - onboardingStartTimeRef.current;
      tracking.onboarding.completed(totalDurationMs, state.stepSequence.filter(isTrackedOnboardingStep));
      
      // Note: Email identification is now handled by App.tsx during use case generation.
      // The use case generator extracts the email as a byproduct of crawling the user's email,
      // eliminating the need for a separate 6+ minute agent call here.
      await completeOnboardingWithOrganisationSeed();
      setIsCompleting(false);
    } catch (error) {
      if (error instanceof Error && error.name === 'WorkspaceValidationError') {
        const apiStepIndex = state.stepSequence.indexOf('api');
        if (apiStepIndex >= 0) {
          setStepIndex(apiStepIndex);
        }
      }
      setCompletionError(error instanceof Error ? error.message : 'Failed to finish onboarding.');
      setIsCompleting(false);
    }
  }, [isCompleting, activeStep, completeOnboardingWithOrganisationSeed, setIsCompleting, setCompletionError, setStepIndex, state.stepSequence]);

  // Particles for welcome/wizard background - enhanced starfield
  const twinkleParticles = useMemo(() => {
    const count = 280;
    return new Array(count).fill(0).map((_, i) => ({
      key: i,
      left: Math.random() * 100,
      top: Math.random() * 100,
      delay: Math.random() * 4.5,
      // Particle type: 0=normal, 1=blue-tinted, 2=purple-tinted, 3=large glow
      type: i < 200 ? 0 : i < 230 ? 1 : i < 260 ? 2 : 3,
    }));
  }, []);

  // Compute visible display steps based on current step sequence
  // This ensures step pills only show steps that are actually in the flow
  // (e.g., API step may be skipped for returning users with valid keys)
  const displaySteps = useMemo(
    () => DISPLAY_STEPS.filter((step) => state.stepSequence.includes(step)),
    [state.stepSequence]
  );

  // Shooting stars - rare, magical moments
  const shootingStars = useMemo(() => {
    return new Array(3).fill(0).map((_, i) => ({
      key: `shoot-${i}`,
      startLeft: 10 + Math.random() * 60,
      startTop: Math.random() * 40,
      delay: i * 18 + Math.random() * 8, // ~18-26 seconds between each
    }));
  }, []);

  // Tool auth status renderer (kept here because it uses actions)
  const renderToolStatus = useCallback(
    (toolState: ToolAuthState) => {
      const { status } = toolState;

      if (isPendingStatus(status)) {
        // Required tools (gmail): show skeleton - AutoGenEffect will auto-generate
        // Optional tools: show "Set up" button - user initiates
        if (toolState.required) {
          return <div className={styles.skeletonButton} />;
        }
        // Optional tool: show "Set up" button
        return (
          <Button
            variant="outline"
            onClick={() => void generateAuthLink(toolState.tool)}
          >
            Set up
          </Button>
        );
      }

      if (isGeneratingStatus(status)) {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
            <div className={styles.skeletonButton} />
            {showSlowConnectionHint && (
              <p className={styles.slowConnectionHint}>
                Taking a moment... If you see a system dialog about developer tools, you can dismiss it—Rebel works great without it.
              </p>
            )}
          </div>
        );
      }

      if (isReadyToConnectStatus(status)) {
        return (
          <Button variant="outline" onClick={() => startOAuthFlow(toolState.tool)}>Connect</Button>
        );
      }

      if (isPollingStatus(status)) {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
            <span className={styles.statusChecking}><span className={styles.spinner}></span>Waiting for authorization…</span>
            <Button variant="ghost" size="sm" onClick={() => void verifyToolAuth(toolState.tool)}>I've done it</Button>
          </div>
        );
      }

      if (isVerifyingStatus(status)) {
        return <span className={styles.statusChecking}><span className={styles.spinner}></span>Connecting…</span>;
      }

      if (isConnectedStatus(status)) {
        return <span className={`${styles.statusLine} ${styles.statusGranted}`}><span className={styles.statusIcon}>✓</span>Connected</span>;
      }

      if (isErrorStatus(status)) {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
            <Button
              variant="outline"
              onClick={() => void generateAuthLink(toolState.tool)}
            >
              Retry
            </Button>
            <span className={styles.toolErrorHint}>{toolState.error || 'Connection failed. Try again.'}</span>
          </div>
        );
      }

      return null;
    },
    [generateAuthLink, startOAuthFlow, verifyToolAuth, showSlowConnectionHint]
  );

  // Handle Continue button click
  const handleContinue = useCallback(async () => {
    // Validate Claude key before proceeding from the api step — but only when
    // Anthropic is the active provider. If the user connected Codex/OpenRouter
    // but had a stale key in the input, skip validation so Continue isn't blocked.
    if (activeStep === 'api' && draftSettings?.activeProvider === 'anthropic') {
      const claudeKey = getApiKey(draftSettings)?.trim();

      const needsClaudeKeyValidation = claudeKey && claudeValidationOk !== true && !isValidatingClaude;

      if (needsClaudeKeyValidation) {
        const ok = await validateClaudeKey(claudeKey);
        if (!ok) return;
      }
    }
    // OSS lead-capture egress: on explicit Continue from the api step, fire a
    // best-effort POST of the optional identity the user typed into the "About
    // you" block. Consent is tied to this explicit action. FIRE-AND-FORGET (see
    // the helper) — never awaited, so a hung/failing endpoint cannot block or
    // delay onboarding. OSS-only; skipped when no email was provided.
    if (activeStep === 'api') {
      fireOssLeadCaptureOnContinue({
        isOss: rendererIsOss(),
        draft: draftSettings,
        api: window.identityApi,
      });
    }
    // Spaces are created immediately via AddSpaceWizard, no batch creation needed
    if (activeStep === 'googleDrive' && companyName.trim()) {
      updateDraft('companyName', companyName.trim());
    }
    // Persist settings before toolAuth step so use case generation can read them
    // (use case gen reads from main process store, not renderer draft state)
    if (activeStep === 'voiceSetup') {
      await saveSettings();
    }
    await goNext();
  }, [activeStep, companyName, goNext, updateDraft, draftSettings, claudeValidationOk, isValidatingClaude, validateClaudeKey, saveSettings]);

  const isToolAuthContinueBlocked = activeStep === 'toolAuth' && !toolAuthReady && !canSkipToolAuth;

  // Welcome step "Continue" - persists draft settings before advancing.
  // Always flushes to ensure coreDirectory (set by the default workspace effect)
  // is available in the main process store before the Spaces step.
  const handleWelcomeContinue = useCallback(async () => {
    startStandardSetupBranch();
    if (state.eulaAccepted && !draftSettings?.eulaAcceptedAt) {
      updateDraft('eulaAcceptedAt', Date.now());
    }
    // Persist draft settings so coreDirectory and eulaAcceptedAt are available
    // in the main process store. Non-fatal if it fails.
    try {
      await saveSettings();
    } catch {
      // ignore
    }
    await goNext();
  }, [goNext, state.eulaAccepted, draftSettings?.eulaAcceptedAt, updateDraft, saveSettings, startStandardSetupBranch]);

  // Don't render if settings aren't loaded yet
  if (!draftSettings) return null;

  // If wizard is closed, don't render anything
  if (!isOpen) return null;

  // Render step content
  const renderStepContent = () => {
    switch (activeStep) {
      case 'welcome':
        return null; // Handled separately
      case 'migrationImport':
        return (
          <MigrationImportStep
            onBackToWelcome={goBack}
          />
        );
      case 'googleDrive':
        return (
          <GoogleDriveStep
            state={state}
            actions={actions}
            draftSettings={draftSettings}
            isDevMode={isDevMode}
          />
        );
      case 'api':
        return (
          <ApiStep
            state={state}
            actions={actions}
            draftSettings={draftSettings}
            isDevMode={isDevMode}
            updateDraft={updateDraft}
            updateClaude={updateClaude}
            isValidatingClaude={isValidatingClaude}
            claudeValidationMessage={claudeValidationMessage}
            claudeValidationOk={claudeValidationOk}
            validateClaudeKey={validateClaudeKey}
          />
        );
      case 'voiceSetup':
        return (
          <VoiceSetupStep
            state={state}
            actions={actions}
            draftSettings={draftSettings}
            isDevMode={isDevMode}
            updateDraft={updateDraft}
            updateVoice={updateVoice}
            isValidatingOpenAI={isValidatingOpenAI}
            openAiValidationMessage={openAiValidationMessage}
            openAiValidationOk={openAiValidationOk}
            openAiValidationReason={openAiValidationReason}
            validateOpenAiKey={validateOpenAiKey}
            clearOpenAiValidation={clearOpenAiValidation}
            isValidatingElevenLabs={isValidatingElevenLabs}
            elevenLabsValidationMessage={elevenLabsValidationMessage}
            elevenLabsValidationOk={elevenLabsValidationOk}
            validateElevenLabsKey={validateElevenLabsKey}
            clearElevenLabsValidation={clearElevenLabsValidation}
            openPrefsAndPoll={openPrefsAndPoll}
          />
        );
      case 'toolAuth':
        return (
          <ToolAuthStep
            state={state}
            actions={actions}
            draftSettings={draftSettings}
            isDevMode={isDevMode}
            renderToolStatus={renderToolStatus}
          />
        );
      default:
        return null;
    }
  };

  // Welcome step is full-bleed with integrated system checks
  if (activeStep === 'welcome') {
    return (
      <>
        <WelcomeStep
          goNext={handleWelcomeContinue}
          startMigrationImport={startMigrationImportBranch}
          twinkleParticles={twinkleParticles}
          shootingStars={shootingStars}
          eulaAccepted={state.eulaAccepted}
          setEulaAccepted={actions.setEulaAccepted}
        />
        <Dialog open={showEscapeConfirm} onOpenChange={(open) => !open && handleEscapeCancel()}>
          <DialogContent>
            <DialogHeader><DialogTitle>Skip setup?</DialogTitle></DialogHeader>
            <DialogBody>
              <p style={{ marginBottom: '1rem' }}>Some features may not work until you complete configuration manually in Settings.</p>
              <p style={{ opacity: 0.7, fontSize: '0.9em' }}>You can return to setup anytime from Settings → Relaunch Onboarding.</p>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={handleEscapeCancel}>Continue setup</Button>
              <Button onClick={() => void handleEscapeConfirm()}>Skip anyway</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <>
    <div className={`${styles.overlay} dark`} style={showEscapeConfirm ? { pointerEvents: 'none' } : undefined}>
      <div className={introStyles.particles} aria-hidden>
        {twinkleParticles.map((p) => (
          <div key={p.key} className={introStyles.particle} style={{ left: `${p.left}%`, top: `${p.top}%`, animationDelay: `${p.delay}s` }} />
        ))}
      </div>
      <div className={styles.wizard} role="dialog" aria-modal data-testid="onboarding-wizard">
        {activeStep !== 'migrationImport' && (
        <div className={styles.stepsFloating}>
          <div className={styles.stepsPill} role="list" aria-label="Onboarding steps" data-testid="onboarding-steps-nav">
            {displaySteps.map((step, displayIndex) => {
              // displayIndex is 0-based within displaySteps (filtered to only include active steps)
              const actualStepIndex = state.stepSequence.indexOf(step);
              const stepNumber = displayIndex + 1; // Display as 1-based index
              const pillState: 'done' | 'active' | 'upcoming' = actualStepIndex < stepIndex ? 'done' : actualStepIndex === stepIndex ? 'active' : 'upcoming';
              // Returning users (have completed onboarding before) can jump to any step
              const isReturningUser = Boolean(draftSettings?.onboardingFirstCompletedAt);
              const canJump = isReturningUser || actualStepIndex <= stepIndex;
              return (
                <StepPill
                  key={step}
                  index={stepNumber}
                  total={displaySteps.length}
                  label={STEP_LABELS[step]}
                  ariaLabel={STEP_ACCESSIBLE_LABELS[step]}
                  state={pillState}
                  onClick={canJump ? () => setStepIndex(actualStepIndex) : undefined}
                  disabled={!canJump}
                />
              );
            })}
          </div>
        </div>
        )}
        <div className={styles.stepScroll} data-testid={`onboarding-step-${activeStep}`}>
          {renderStepContent()}
        </div>
        {/* Side annotation tips — floating to the right of the card */}

        {activeStep === 'api' && !!getApiKey(draftSettings) && (
          <SideAnnotation id="tip-api-connected" top={310}>
            You're connected. Your API key is all you need.
          </SideAnnotation>
        )}
        {activeStep === 'toolAuth' && !showMoreToolsTip && (
          <SideAnnotation id="tip-tools-three" onDismiss={() => setShowMoreToolsTip(true)}>
            Connect 3 or more connectors to get the most out of Rebel. Users who connect more get significantly better results from day one.
          </SideAnnotation>
        )}
        {activeStep === 'toolAuth' && showMoreToolsTip && (
          <SideAnnotation id="tip-tools-more" bottom={80}>
            Why not connect more now? The more you connect, the better Rebel works from day one.
          </SideAnnotation>
        )}
        {activeStep !== 'migrationImport' && (
        <div className={styles.footerActions} data-testid="onboarding-footer">
          <Button variant="ghost" size="lg" onClick={goBack} disabled={stepIndex === 0} data-testid="onboarding-back-button">
            Back
          </Button>
          {googleDriveError && activeStep === 'googleDrive' && (
            <p className={`${styles.footnote} ${styles.validationText}`}>{googleDriveError}</p>
          )}
          {stepIndex !== totalSteps - 1 ? (
            <div className={styles.continueButtonWrapper}>
              <Button
                size="lg"
                onClick={() => void handleContinue()}
                disabled={(activeStep === 'api' && isValidatingClaude) || (activeStep === 'voiceSetup' && (isValidatingOpenAI || isValidatingElevenLabs))}
                className={isToolAuthContinueBlocked ? styles.continueButtonDisabledLook : undefined}
                data-testid="onboarding-continue-button"
              >
                {(activeStep === 'api' && isValidatingClaude) || (activeStep === 'voiceSetup' && (isValidatingOpenAI || isValidatingElevenLabs)) ? 'Validating…' : 'Continue'}
              </Button>
            </div>
          ) : (
            <Button size="lg" onClick={() => void handleFinish()} disabled={isCompleting || !canProceed} data-testid="onboarding-finish-button">
              {isCompleting ? (
                <>
                  <img 
                    src={loadingGif} 
                    alt="Loading" 
                    style={{ height: '20px', marginRight: '8px' }} 
                  />
                  Finishing…
                </>
              ) : 'Start using Mindstone Rebel'}
            </Button>
          )}
        </div>
        )}

      </div>
    </div>

    <Dialog open={showEscapeConfirm} onOpenChange={(open) => !open && handleEscapeCancel()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Skip setup?</DialogTitle></DialogHeader>
        <DialogBody>
          <p style={{ marginBottom: '1rem' }}>Some features may not work until you complete configuration manually in Settings.</p>
          <p style={{ opacity: 0.7, fontSize: '0.9em' }}>You can return to setup anytime from Settings → Relaunch Onboarding.</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={handleEscapeCancel}>Continue setup</Button>
          <Button onClick={() => void handleEscapeConfirm()}>Skip anyway</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Broken-by-default OAuth setup guidance. `generateAuthLink` routes a not-configured
        start-auth result through `state.setupGuidance.handleResult`, opening this dialog. */}
    <ConnectorSetupDialog
      guidance={state.setupGuidance.guidance}
      open={state.setupGuidance.isOpen}
      onOpenChange={state.setupGuidance.setOpen}
    />
    </>
  );
};
