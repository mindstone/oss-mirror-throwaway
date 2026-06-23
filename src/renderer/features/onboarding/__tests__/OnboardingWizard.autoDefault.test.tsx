// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { OnboardingFlowActions, OnboardingFlowState } from '../hooks/useOnboardingFlow';
import { OnboardingWizard } from '../OnboardingWizard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settingsContext = vi.hoisted(() => ({
  value: null as unknown,
}));

const flowContext = vi.hoisted(() => ({
  state: null as unknown,
  actions: null as unknown,
}));

vi.mock('../../settings', () => ({
  useSettings: () => settingsContext.value,
}));

vi.mock('../hooks', () => ({
  DISPLAY_STEPS: ['welcome', 'googleDrive', 'api', 'voiceSetup', 'toolAuth'],
  STEP_ACCESSIBLE_LABELS: {
    welcome: 'Welcome',
    googleDrive: 'Library',
    api: 'API',
    voiceSetup: 'Voice',
    toolAuth: 'Tools',
  },
  STEP_LABELS: {
    welcome: 'Welcome',
    googleDrive: 'Library',
    api: 'API',
    voiceSetup: 'Voice',
    toolAuth: 'Tools',
  },
  useOnboardingFlow: () => ({
    state: flowContext.state,
    actions: flowContext.actions,
  }),
}));

vi.mock('../hooks/useEscapeHatchHotkey', () => ({
  useEscapeHatchHotkey: vi.fn(),
}));

vi.mock('@renderer/hooks/useTimeoutRef', () => ({
  useTimeoutRef: () => ({
    clear: vi.fn(),
    set: vi.fn(),
  }),
}));

vi.mock('@renderer/src/tracking', () => ({
  tracking: {
    onboarding: {
      completed: vi.fn(),
      escapeHatchCancelled: vi.fn(),
      escapeHatchConfirmed: vi.fn(),
      escapeHatchTriggered: vi.fn(),
      microphonePermissionDenied: vi.fn(),
      microphonePermissionGranted: vi.fn(),
      microphonePermissionRequested: vi.fn(),
      stepCompleted: vi.fn(),
    },
  },
}));

vi.mock('../components', () => ({
  SideAnnotation: ({ children }: { children: React.ReactNode }) => <aside>{children}</aside>,
  StepPill: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));

vi.mock('../steps', () => ({
  ApiStep: () => <div data-testid="api-step" />,
  GoogleDriveStep: () => <div data-testid="google-drive-step" />,
  ToolAuthStep: () => <div data-testid="tool-auth-step" />,
  VoiceSetupStep: () => <div data-testid="voice-setup-step" />,
  WelcomeStep: () => <div data-testid="welcome-step" />,
}));

type Mounted = {
  root: Root;
  container: HTMLDivElement;
  unmount: () => void;
};

function makeDraftSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    activeProvider: 'anthropic',
    claude: { apiKey: null },
    coreDirectory: null,
    onboardingCompleted: false,
    voice: {
      provider: 'local-parakeet',
      openaiApiKey: null,
      elevenlabsApiKey: null,
    },
    ...overrides,
  } as AppSettings;
}

function makeState(): OnboardingFlowState {
  return {
    stepIndex: 1,
    activeStep: 'googleDrive',
    totalSteps: 5,
    canProceed: true,
    triedContinue: false,
    stepSequence: ['welcome', 'googleDrive', 'api', 'voiceSetup', 'toolAuth'],
    apiKeyValidationStatus: 'idle',
    canSkipApiStep: false,
    microphoneStatus: 'granted',
    isCompleting: false,
    completionError: null,
    canSkipToolAuth: true,
    toolAuthStates: [],
    isGeneratingAuthLinks: false,
    isVerifyingAuth: false,
    toolAuthReady: true,
    activeAuthTool: null,
    userFirstName: null,
    fetchingUserName: false,
    workspaceReady: false,
    workspaceValidation: { checking: false, errors: [], warnings: [] },
    claudeReady: true,
    voiceReady: true,
    voiceProvider: 'local-parakeet',
    googleDriveInstalled: false,
    companyName: '',
    googleDriveError: null,
    googleDriveReady: true,
    connectedSpaces: [],
    orgCompanyDisplayName: null,
    orgHasSpaces: false,
    orgSharedDriveProvider: null,
    oneDriveInstalled: false,
    oneDriveConfigured: false,
    useCaseGenerationStatus: 'idle',
    useCaseGenerationError: null,
    generatedUseCases: [],
    useCasesReady: true,
    eulaAccepted: true,
    setupGuidance: {
      guidance: null,
      isOpen: false,
      handleResult: () => false,
      open: () => undefined,
      setOpen: () => undefined,
      close: () => undefined,
    },
  };
}

function makeActions(): OnboardingFlowActions {
  return {
    setStepIndex: vi.fn(),
    goNext: vi.fn(),
    goBack: vi.fn(),
    completeOnboardingWithOrganisationSeed: vi.fn(),
    setMicrophoneStatus: vi.fn(),
    setIsCompleting: vi.fn(),
    setCompletionError: vi.fn(),
    updateToolAuthState: vi.fn(),
    setToolAuthStatusForTest: vi.fn(),
    clearToolAuthError: vi.fn(),
    observeCatalogConnection: vi.fn(),
    markToolAuthConnected: vi.fn(),
    disconnectToolAuth: vi.fn(),
    generateAuthLink: vi.fn(),
    startOAuthFlow: vi.fn(),
    verifyToolAuth: vi.fn(),
    skipTool: vi.fn(),
    setUserFirstName: vi.fn(),
    setFetchingUserName: vi.fn(),
    handleFinish: vi.fn(),
    setGoogleDriveInstalled: vi.fn(),
    setCompanyName: vi.fn(),
    setGoogleDriveError: vi.fn(),
    addConnectedSpace: vi.fn(),
    removeConnectedSpace: vi.fn(),
    refreshConnectedSpaces: vi.fn(),
    startUseCaseGeneration: vi.fn(),
    retryUseCaseGeneration: vi.fn(),
    setEulaAccepted: vi.fn(),
    startMigrationImportBranch: vi.fn(),
    startStandardSetupBranch: vi.fn(),
  };
}

function mountWizard(): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <OnboardingWizard
        isOpen
        completeOnboarding={vi.fn().mockResolvedValue(undefined)}
      />,
    );
  });

  return {
    root,
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitForAssertion(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flushEffects();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

describe('OnboardingWizard auto-default workspace gate', () => {
  let mounted: Mounted | null = null;
  const suggestedWorkspace = '/home/user/Mindstone Rebel';
  const updateDraft = vi.fn();
  const saveSettings = vi.fn();
  const updateVoice = vi.fn();
  const validateWorkspaceAccess = vi.fn();

  beforeEach(() => {
    updateDraft.mockReset();
    saveSettings.mockReset();
    saveSettings.mockResolvedValue(undefined);
    updateVoice.mockReset();
    validateWorkspaceAccess.mockReset();
    flowContext.state = makeState();
    flowContext.actions = makeActions();
    settingsContext.value = {
      draftSettings: makeDraftSettings(),
      updateDraft,
      updateClaude: vi.fn(),
      updateVoice,
      saveSettings,
    };

    Object.defineProperty(window, 'electronEnv', {
      configurable: true,
      value: { platform: 'linux' },
    });
    Object.defineProperty(window, 'settingsApi', {
      configurable: true,
      value: {
        getDefaultWorkspace: vi.fn().mockResolvedValue(suggestedWorkspace),
        validateClaudeKey: vi.fn(),
        validateOpenaiKey: vi.fn(),
        validateElevenlabsKey: vi.fn(),
      },
    });
    Object.defineProperty(window, 'systemHealthApi', {
      configurable: true,
      value: {
        validateWorkspaceAccess,
      },
    });
    Object.defineProperty(window, 'permissionsApi', {
      configurable: true,
      value: {
        getMicrophoneStatus: vi.fn().mockResolvedValue('granted'),
        openSystemPreferences: vi.fn(),
        requestMicrophone: vi.fn().mockResolvedValue({ granted: true }),
      },
    });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it.each([
    ['denied', { accessible: false, code: 'EACCES' }],
    ['invalid', { accessible: false, code: 'ENOENT' }],
  ])('does not persist the suggested default workspace when validation returns %s', async (_caseName, response) => {
    validateWorkspaceAccess.mockResolvedValue(response);

    mounted = mountWizard();

    await waitForAssertion(() => {
      expect(validateWorkspaceAccess).toHaveBeenCalledWith({
        path: suggestedWorkspace,
        createIfMissing: true,
      });
    });
    await flushEffects();

    expect(updateDraft).not.toHaveBeenCalledWith('coreDirectory', suggestedWorkspace);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('persists and eagerly saves the suggested default workspace when validation is accessible', async () => {
    validateWorkspaceAccess.mockResolvedValue({ accessible: true });

    mounted = mountWizard();

    await waitForAssertion(() => {
      expect(validateWorkspaceAccess).toHaveBeenCalledWith({
        path: suggestedWorkspace,
        createIfMissing: true,
      });
    });
    await waitForAssertion(() => {
      expect(updateDraft).toHaveBeenCalledWith('coreDirectory', suggestedWorkspace);
    });

    expect(saveSettings).toHaveBeenCalledTimes(1);
  });
});
