// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, SubscriptionState } from '@shared/types';
import type { OnboardingFlowActions, OnboardingFlowState } from '../../hooks/useOnboardingFlow';
import { ApiStep } from '../ApiStep';
import type { ApiStepProps } from '../types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mutable OSS signal — flipped per test. Mirrors the production seam: in the OSS
// build `rendererIsOss()` returns true (managed subscription backend absent).
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

/** DOM order of the three provider cards, by their testid suffix. */
function providerOrder(container: HTMLElement): string[] {
  const grid = container.querySelector('[aria-label="AI provider"]');
  if (!grid) return [];
  return Array.from(grid.querySelectorAll('[data-testid$="-card"]')).map((el) =>
    el.getAttribute('data-testid') ?? ''
  );
}

/** The provider card testid that contains the "(recommended)" tag, if any. */
function recommendedCard(container: HTMLElement): string | null {
  const spans = Array.from(container.querySelectorAll('span'));
  const tag = spans.find((s) => s.textContent === '(recommended)');
  return tag?.closest('[data-testid]')?.getAttribute('data-testid') ?? null;
}

function connectionRequiredBannerText(container: HTMLElement): string {
  const banner = Array.from(container.querySelectorAll('p')).find((el) =>
    el.textContent?.startsWith('Connect a model provider to continue')
  );
  expect(banner).toBeDefined();
  return banner?.textContent ?? '';
}

describe('ApiStep — OSS gating of the managed subscription panel', () => {
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
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    isOssMock.value = false;
    vi.clearAllMocks();
  });

  it('OSS build: hides the managed subscription panel and divider, leads with Anthropic (recommended)', async () => {
    isOssMock.value = true;
    // OSS has no managed backend → not entitled.
    useSubscriptionStateMock.mockReturnValue({
      subscription: makeSubscription({ status: 'inactive', routingAvailable: false }),
      phase: 'ready',
      isActive: false,
      isPastDueWithinGrace: false,
      refresh: vi.fn(),
    });

    mounted = mount(<ApiStep {...makeProps()} />);
    await flushEffects();
    const { container } = mounted;

    // Dead-end managed cards must be gone.
    expect(container.querySelector('[data-testid="onboarding-subscription-dash-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-subscription-rogue-card"]')).toBeNull();
    // The orphaned "or bring your own AI" divider must be gone, replaced by a real heading.
    expect(container.textContent).not.toContain('or bring your own AI');
    expect(container.textContent).toContain('Bring your own AI');

    // BYO path is the whole step; Anthropic leads and carries the recommendation.
    expect(providerOrder(container)).toEqual([
      'onboarding-anthropic-card',
      'onboarding-openrouter-card',
      'onboarding-codex-card',
    ]);
    expect(recommendedCard(container)).toBe('onboarding-anthropic-card');
  });

  it('commercial build: managed panel + divider present, ChatGPT Pro leads and is recommended (unchanged)', async () => {
    isOssMock.value = false;
    useSubscriptionStateMock.mockReturnValue({
      subscription: makeSubscription({ status: 'inactive', routingAvailable: false }),
      phase: 'ready',
      isActive: false,
      isPastDueWithinGrace: false,
      refresh: vi.fn(),
    });

    mounted = mount(<ApiStep {...makeProps()} />);
    await flushEffects();
    const { container } = mounted;

    // Managed offer + divider still render in the commercial build.
    expect(container.querySelector('[data-testid="onboarding-subscription-dash-card"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="onboarding-subscription-rogue-card"]')).not.toBeNull();
    expect(container.textContent).toContain('or bring your own AI');
    expect(container.textContent).not.toContain('Bring your own AI');

    // Original BYO order + recommendation preserved.
    expect(providerOrder(container)).toEqual([
      'onboarding-codex-card',
      'onboarding-openrouter-card',
      'onboarding-anthropic-card',
    ]);
    expect(recommendedCard(container)).toBe('onboarding-codex-card');
  });

  it('orders the connection-required banner providers by build mode', async () => {
    useSubscriptionStateMock.mockReturnValue({
      subscription: makeSubscription({ status: 'inactive', routingAvailable: false }),
      phase: 'ready',
      isActive: false,
      isPastDueWithinGrace: false,
      refresh: vi.fn(),
    });
    const blockedState = { ...makeState(), triedContinue: true, claudeReady: false };

    isOssMock.value = true;
    mounted = mount(<ApiStep {...makeProps({ state: blockedState })} />);
    await flushEffects();
    let bannerText = connectionRequiredBannerText(mounted.container);
    expect(bannerText).toContain('Anthropic API key');
    expect(bannerText).toContain('ChatGPT Pro');
    expect(bannerText.indexOf('Anthropic API key')).toBeLessThan(bannerText.indexOf('ChatGPT Pro'));

    mounted.unmount();
    mounted = null;

    isOssMock.value = false;
    mounted = mount(<ApiStep {...makeProps({ state: blockedState })} />);
    await flushEffects();
    bannerText = connectionRequiredBannerText(mounted.container);
    expect(bannerText).toContain('ChatGPT Pro');
    expect(bannerText).toContain('Anthropic API key');
    expect(bannerText.indexOf('ChatGPT Pro')).toBeLessThan(bannerText.indexOf('Anthropic API key'));
  });
});
