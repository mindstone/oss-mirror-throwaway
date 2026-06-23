// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { CreateSpaceOptions, SpaceInfo } from '@shared/ipc/schemas/library';
import type { OnboardingFlowActions, OnboardingFlowState } from '../../hooks/useOnboardingFlow';
import { GoogleDriveStep } from '../GoogleDriveStep';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

 
vi.mock('@renderer/hooks/useFeatureGate', () => ({
  useFeatureGate: () => ({ isFeatureEnabled: () => true }),
}));

const mockInvalidateSpaces = vi.hoisted(() => vi.fn());

 
vi.mock('@renderer/hooks/useSpacesData', () => ({
  invalidateSpaces: mockInvalidateSpaces,
}));

 
vi.mock('@renderer/features/spaces', () => ({
  AddSpaceWizard: ({
    open,
    onComplete,
  }: {
    open: boolean;
    onComplete: (spaceConfig: CreateSpaceOptions) => void;
  }) => open ? (
    <button
      type="button"
      onClick={() => onComplete({
        name: 'General',
        type: 'company',
        location: 'workspace',
      })}
    >
      Mock complete space
    </button>
  ) : null,
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

function makeState(): OnboardingFlowState {
  return {
    stepIndex: 1,
    activeStep: 'googleDrive',
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

describe('GoogleDriveStep onboarding organisation seed', () => {
  let mounted: Mounted | null = null;
  const createSpace = vi.fn();
  const removeSpace = vi.fn();

  beforeEach(() => {
    createSpace.mockReset();
    createSpace.mockResolvedValue({
      success: true,
      space: {
        name: 'General',
        path: 'work/Acme/General',
      } as SpaceInfo,
    });
    removeSpace.mockReset();
    removeSpace.mockResolvedValue({ success: true });
    mockInvalidateSpaces.mockReset();
    Object.defineProperty(window, 'libraryApi', {
      configurable: true,
      value: {
        createSpace,
        removeSpace,
      },
    });
    Object.defineProperty(window, 'appApi', {
      configurable: true,
      value: {
        openUrl: vi.fn(),
        openPath: vi.fn(),
      },
    });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('passes the onboarding company name as create-space organisation for work spaces', async () => {
    const actions = makeActions();
    mounted = mount(
      <GoogleDriveStep
        state={makeState()}
        actions={actions}
        draftSettings={{ companyName: 'Acme' } as AppSettings}
        isDevMode
      />,
    );

    const addSpaceButton = [...mounted.container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Add space'));
    await act(async () => {
      addSpaceButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const completeButton = [...mounted.container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Mock complete space'));
    await act(async () => {
      completeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(createSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'General',
        type: 'company',
        organisation: 'Acme',
      }),
    );
  });

  it('invalidates the shared Spaces cache after removing a connected space', async () => {
    const actions = makeActions();
    const state = {
      ...makeState(),
      connectedSpaces: [{
        name: 'General',
        path: 'work/Acme/General',
        absolutePath: '/workspace/work/Acme/General',
        type: 'company',
        isSymlink: false,
        hasReadme: true,
        sharing: 'company-wide',
        status: 'ok',
      } as SpaceInfo],
    };
    mounted = mount(
      <GoogleDriveStep
        state={state}
        actions={actions}
        draftSettings={{ companyName: 'Acme', coreDirectory: '/workspace' } as AppSettings}
        isDevMode
      />,
    );

    const removeButton = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Remove General"]');
    await act(async () => {
      removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(removeSpace).toHaveBeenCalledWith({ spacePath: 'work/Acme/General', removeSymlinkOnly: true });
    expect(mockInvalidateSpaces).toHaveBeenCalledWith('/workspace');
    expect(actions.removeConnectedSpace).toHaveBeenCalledWith('work/Acme/General');
  });

  it('surfaces remove-space failures without invalidating or removing local onboarding state', async () => {
    removeSpace.mockResolvedValueOnce({ success: false, error: 'mocked write failure' });
    const removeConnectedSpace = vi.fn();
    const initialState = {
      ...makeState(),
      connectedSpaces: [{
        name: 'General',
        path: 'work/Acme/General',
        absolutePath: '/workspace/work/Acme/General',
        type: 'company',
        isSymlink: false,
        hasReadme: true,
        sharing: 'company-wide',
        status: 'ok',
      } as SpaceInfo],
    };

    const TestHarness = () => {
      const [currentState, setCurrentState] = React.useState(initialState);
      const actions = {
        ...makeActions(),
        setGoogleDriveError: (googleDriveError: string | null) => {
          setCurrentState(prev => ({ ...prev, googleDriveError }));
        },
        removeConnectedSpace,
      };

      return (
        <GoogleDriveStep
          state={currentState}
          actions={actions}
          draftSettings={{ companyName: 'Acme', coreDirectory: '/workspace' } as AppSettings}
          isDevMode
        />
      );
    };

    mounted = mount(<TestHarness />);

    const removeButton = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Remove General"]');
    await act(async () => {
      removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(removeSpace).toHaveBeenCalledWith({ spacePath: 'work/Acme/General', removeSymlinkOnly: true });
    expect(mockInvalidateSpaces).not.toHaveBeenCalled();
    expect(removeConnectedSpace).not.toHaveBeenCalled();
    expect(mounted.container.textContent).toContain('mocked write failure');
    expect(mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Remove General"]')).not.toBeNull();
  });
});
