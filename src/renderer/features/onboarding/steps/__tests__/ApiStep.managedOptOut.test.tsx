// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, SubscriptionState } from '@shared/types';
import type { OnboardingFlowActions, OnboardingFlowState } from '../../hooks/useOnboardingFlow';
import { ApiStep } from '../ApiStep';
import type { ApiStepProps } from '../types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const useSubscriptionStateMock = vi.hoisted(() => vi.fn());

vi.mock('@renderer/hooks/useSubscriptionState', () => ({
  useSubscriptionState: () => useSubscriptionStateMock(),
}));

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(ui);
  });

  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function makeState(): OnboardingFlowState {
  return {
    stepIndex: 2,
    activeStep: 'api',
    totalSteps: 4,
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
    workspaceReady: true,
    workspaceValidation: { checking: false, errors: [], warnings: [] },
    claudeReady: true,
    voiceReady: true,
    voiceProvider: 'local-parakeet',
    googleDriveInstalled: true,
    companyName: 'Acme',
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

function makeDraftSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    coreDirectory: '/workspace',
    mcpConfigFile: null,
    onboardingCompleted: false,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: {},
    claude: {},
    diagnostics: {},
    ...overrides,
  } as AppSettings;
}

function makeSubscription(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    tier: 'dash',
    status: 'active',
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    pastDueSince: null,
    graceEndsAt: null,
    routingAvailable: true,
    ...overrides,
  };
}

function makeProps(overrides: Partial<ApiStepProps> = {}): ApiStepProps {
  return {
    state: makeState(),
    actions: makeActions(),
    draftSettings: makeDraftSettings(),
    isDevMode: false,
    updateDraft: vi.fn(),
    updateClaude: vi.fn(),
    isValidatingClaude: false,
    claudeValidationMessage: null,
    claudeValidationOk: false,
    validateClaudeKey: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

describe('ApiStep managed provider opt-out', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    useSubscriptionStateMock.mockReturnValue({
      subscription: makeSubscription(),
      phase: 'ready',
      isActive: true,
      isPastDueWithinGrace: false,
      refresh: vi.fn(),
    });

    Object.defineProperty(window, 'codexApi', {
      configurable: true,
      value: {
        status: vi.fn().mockResolvedValue({ connected: false }),
        login: vi.fn(),
      },
    });

    Object.defineProperty(window, 'subscriptionApi', {
      configurable: true,
      value: {
        createCheckout: vi.fn(),
      },
    });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('does not snap back to Mindstone after the user opted out of the managed provider', async () => {
    const updateDraft = vi.fn<ApiStepProps['updateDraft']>();
    const props = makeProps({
      draftSettings: makeDraftSettings({
        activeProvider: 'openrouter',
        managedProviderDeactivated: true,
      }),
      updateDraft,
    });

    mounted = mount(<ApiStep {...props} />);
    await flushEffects();

    expect(updateDraft).not.toHaveBeenCalledWith('activeProvider', 'mindstone');
  });

  it('auto-selects Mindstone on first-time entitled setup when the opt-out flag is unset', async () => {
    const updateDraft = vi.fn<ApiStepProps['updateDraft']>();
    const props = makeProps({
      draftSettings: makeDraftSettings({
        activeProvider: undefined,
        managedProviderDeactivated: undefined,
      }),
      updateDraft,
    });

    mounted = mount(<ApiStep {...props} />);
    await flushEffects();

    expect(updateDraft).toHaveBeenCalledWith('activeProvider', 'mindstone');
  });
});
