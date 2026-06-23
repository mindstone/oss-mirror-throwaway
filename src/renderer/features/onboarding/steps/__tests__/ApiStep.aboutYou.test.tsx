// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, SubscriptionState } from '@shared/types';
import type { OnboardingFlowState, OnboardingFlowActions } from '../../hooks/useOnboardingFlow';
import { ApiStep } from '../ApiStep';
import type { ApiStepProps } from '../types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const isOssMock = vi.hoisted(() => ({ value: false }));
vi.mock('../../../../src/rendererIsOss', () => ({
  rendererIsOss: () => isOssMock.value,
}));

const useSubscriptionStateMock = vi.hoisted(() => vi.fn());
vi.mock('@renderer/hooks/useSubscriptionState', () => ({
  useSubscriptionState: () => useSubscriptionStateMock(),
}));

type Mounted = { container: HTMLDivElement; root: Root; unmount: () => void };

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

function setInputValue(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
    status: 'inactive',
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    pastDueSince: null,
    graceEndsAt: null,
    routingAvailable: false,
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

const aboutYou = (c: HTMLElement) => c.querySelector('[data-testid="onboarding-about-you"]');
const nameInput = (c: HTMLElement) =>
  c.querySelector('[data-testid="onboarding-about-you-name"]') as HTMLInputElement | null;
const emailInput = (c: HTMLElement) =>
  c.querySelector('[data-testid="onboarding-about-you-email"]') as HTMLInputElement | null;

describe('ApiStep — OSS "About you (optional)" block', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    Object.defineProperty(window, 'codexApi', {
      configurable: true,
      value: { status: vi.fn().mockResolvedValue({ connected: false }), login: vi.fn() },
    });
    Object.defineProperty(window, 'subscriptionApi', {
      configurable: true,
      value: { createCheckout: vi.fn() },
    });
    useSubscriptionStateMock.mockReturnValue({
      subscription: makeSubscription(),
      phase: 'ready',
      isActive: false,
      isPastDueWithinGrace: false,
      refresh: vi.fn(),
    });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    isOssMock.value = false;
    vi.clearAllMocks();
  });

  it('renders the block only in the OSS build', async () => {
    isOssMock.value = true;
    mounted = mount(<ApiStep {...makeProps()} />);
    await flushEffects();
    expect(aboutYou(mounted.container)).not.toBeNull();
    // Disclosure is persistent text adjacent to the fields (point-of-entry consent).
    expect(mounted.container.textContent).toContain('lets Mindstone keep in touch about the open build');
    expect(mounted.container.textContent).toContain('Shared with Mindstone so we can keep in touch');
    // Must never claim nothing is sent.
    expect(mounted.container.textContent).not.toContain('never sent');
    expect(mounted.container.textContent).not.toContain('stays on your device');
  });

  it('is absent in the commercial build', async () => {
    isOssMock.value = false;
    mounted = mount(<ApiStep {...makeProps()} />);
    await flushEffects();
    expect(aboutYou(mounted.container)).toBeNull();
  });

  it('writes valid name + email to the draft via updateDraft', async () => {
    isOssMock.value = true;
    const updateDraft = vi.fn();
    mounted = mount(<ApiStep {...makeProps({ updateDraft })} />);
    await flushEffects();

    const name = nameInput(mounted.container)!;
    const email = emailInput(mounted.container)!;
    setInputValue(name, 'Alex');
    setInputValue(email, '[external-email]');

    expect(updateDraft).toHaveBeenCalledWith('userFirstName', 'Alex');
    // Email is normalised (trimmed + lowercased) by the shared validator.
    expect(updateDraft).toHaveBeenCalledWith('userEmail', 'jane.doe@example.com');
  });

  it('routes the raw validation error to a Details affordance, with a gentle inline hint on the surface', async () => {
    isOssMock.value = true;
    const updateDraft = vi.fn();
    mounted = mount(<ApiStep {...makeProps({ updateDraft })} />);
    await flushEffects();

    setInputValue(emailInput(mounted.container)!, 'not-an-email');

    // Invalid value is NOT written to the draft.
    expect(updateDraft).not.toHaveBeenCalledWith('userEmail', expect.anything());
    // Gentle inline hint on the surface.
    expect(mounted.container.textContent).toContain("That doesn't look like a valid email.");
    // Raw validator reason lives behind a native <details>.
    const detail = mounted.container.querySelector(
      '[data-testid="onboarding-about-you-email-detail"]',
    );
    expect(detail?.closest('details')).not.toBeNull();
    expect(detail?.textContent).toContain('email is not a valid email address.');
  });

  it('does not write to draft for a placeholder name and surfaces a Details affordance', async () => {
    isOssMock.value = true;
    const updateDraft = vi.fn();
    mounted = mount(<ApiStep {...makeProps({ updateDraft })} />);
    await flushEffects();

    setInputValue(nameInput(mounted.container)!, 'user');
    expect(updateDraft).not.toHaveBeenCalledWith('userFirstName', expect.anything());
    const detail = mounted.container.querySelector(
      '[data-testid="onboarding-about-you-name-detail"]',
    );
    expect(detail?.closest('details')).not.toBeNull();
  });
});
