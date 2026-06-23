// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { act, cleanupFakeTimers, flushAsync, renderHook } from '@renderer/test-utils/hookTestHarness';
import {
  useOnboardingFlow,
  type OnboardingFlowActions,
  type OnboardingFlowState,
  type ToolType,
} from '../useOnboardingFlow';

const mockFetchSpaces = vi.hoisted(() => vi.fn());
const mockGetSpacesSnapshotFor = vi.hoisted(() => vi.fn());
const mockInvalidateSpaces = vi.hoisted(() => vi.fn());
const mockTracking = vi.hoisted(() => ({
  onboarding: {
    started: vi.fn(),
    stageEntered: vi.fn(),
    stepViewed: vi.fn(),
    stepCompleted: vi.fn(),
    completed: vi.fn(),
    spacesStepSkipped: vi.fn(),
    apiStepSkipped: vi.fn(),
    apiStepValidationFailed: vi.fn(),
    toolAuthLinkGenerated: vi.fn(),
    toolAuthVerified: vi.fn(),
    toolAuthError: vi.fn(),
  },
}));

vi.mock('@renderer/hooks/useSpacesData', () => ({
  fetchSpaces: mockFetchSpaces,
  getSpacesSnapshotFor: mockGetSpacesSnapshotFor,
  invalidateSpaces: mockInvalidateSpaces,
}));

vi.mock('@renderer/src/tracking', () => ({
  tracking: mockTracking,
}));

vi.mock('@renderer/src/sentry', () => ({
  recordRendererBreadcrumb: vi.fn(),
}));

vi.mock('@renderer/components/ui', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('@renderer/hooks/useSubscriptionState', () => ({
  useSubscriptionState: () => ({
    subscription: null,
    phase: 'ready',
    isActive: false,
    isPastDueWithinGrace: false,
    refresh: vi.fn(),
  }),
}));

type HookApi = {
  state: OnboardingFlowState;
  actions: OnboardingFlowActions;
};

function makeSettings(): AppSettings {
  return {
    onboardingCompleted: false,
    coreDirectory: null,
    companyName: 'Acme',
    activeProvider: 'anthropic',
    claude: { apiKey: null },
    openRouter: { oauthToken: null },
    voice: {
      provider: 'local-parakeet',
      openaiApiKey: null,
      elevenlabsApiKey: null,
    },
  } as AppSettings;
}

function installWindowApis() {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      onAuthConfigReceived: vi.fn(() => vi.fn()),
      onSubscriptionCallback: vi.fn(() => vi.fn()),
    },
  });
  Object.defineProperty(window, 'libraryApi', {
    configurable: true,
    value: {
      detectGoogleDrive: vi.fn().mockResolvedValue({ installed: false }),
      detectOnedrive: vi.fn().mockResolvedValue({ installed: false, configured: false }),
      validatePath: vi.fn().mockResolvedValue({ errors: [], warnings: [] }),
      updateSpaceFrontmatter: vi.fn().mockResolvedValue({ success: true }),
    },
  });
  Object.defineProperty(window, 'authApi', {
    configurable: true,
    value: {
      getConfig: vi.fn().mockResolvedValue(null),
    },
  });
  Object.defineProperty(window, 'dashboardApi', {
    configurable: true,
    value: {
      generateUseCases: vi.fn().mockResolvedValue({ success: true, useCases: [] }),
    },
  });
  Object.defineProperty(window, 'permissionsApi', {
    configurable: true,
    value: {
      getMicrophoneStatus: vi.fn().mockResolvedValue('granted'),
      checkFileAccess: vi.fn().mockResolvedValue({ hasAccess: true }),
    },
  });
  Object.defineProperty(window, 'googleWorkspaceApi', {
    configurable: true,
    value: {
      getAccounts: vi.fn().mockResolvedValue({ accounts: [] }),
      startAuth: vi.fn().mockResolvedValue({ success: true }),
    },
  });
  Object.defineProperty(window, 'miscApi', {
    configurable: true,
    value: {
      getToolAuthUrl: vi.fn().mockResolvedValue({
        success: true,
        authUrl: 'https://auth.example.test/gmail',
      }),
      verifyToolAuth: vi.fn().mockResolvedValue({
        success: true,
        isAuthenticated: false,
      }),
    },
  });
  Object.defineProperty(window, 'appApi', {
    configurable: true,
    value: {
      openUrl: vi.fn().mockResolvedValue(undefined),
    },
  });
  Object.defineProperty(window, 'slackApi', {
    configurable: true,
    value: {
      startAuth: vi.fn().mockResolvedValue({ success: true, teamName: 'Acme Slack' }),
      getWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    },
  });
  Object.defineProperty(window, 'microsoftApi', {
    configurable: true,
    value: {
      startAuth: vi.fn().mockResolvedValue({ success: true, email: 'user@example.test' }),
      isConnected: vi.fn().mockResolvedValue({ connected: false }),
    },
  });
}

function renderOnboardingHook() {
  return renderHook<HookApi>(() =>
    useOnboardingFlow({
      isOpen: true,
      draftSettings: makeSettings(),
      completeOnboarding: vi.fn().mockResolvedValue(undefined),
    }),
  );
}

async function advanceTimers(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flushAsync();
}

async function enterToolAuthStep(result: { current: HookApi }) {
  await act(async () => {
    result.current.actions.setStepIndex(4);
  });
  await flushAsync();
  expect(result.current.state.activeStep).toBe('toolAuth');
}

async function driveToolToReady(result: { current: HookApi }, tool: ToolType = 'gmail') {
  await act(async () => {
    result.current.actions.setToolAuthStatusForTest(tool, 'generating', { error: null });
  });
  await flushAsync();
  await act(async () => {
    result.current.actions.setToolAuthStatusForTest(tool, 'ready_to_connect', {
      authUrl: `https://auth.example.test/${tool}`,
    });
  });
  await flushAsync();
  expect(result.current.state.toolAuthStates.find((state) => state.tool === tool)?.status).toBe('ready_to_connect');
}

async function driveToolToAwaiting(result: { current: HookApi }, tool: ToolType = 'gmail') {
  await driveToolToReady(result, tool);
  await act(async () => {
    result.current.actions.startOAuthFlow(tool);
  });
  await flushAsync();
  expect(result.current.state.toolAuthStates.find((state) => state.tool === tool)?.status).toBe('awaiting_auth');
}

describe('useOnboardingFlow tool-auth timer integration', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('DEV', false);
    installWindowApis();
    mockFetchSpaces.mockReset();
    mockFetchSpaces.mockResolvedValue(undefined);
    mockGetSpacesSnapshotFor.mockReset();
    mockGetSpacesSnapshotFor.mockReturnValue({
      spaces: [],
      ready: true,
      error: false,
      parseWarnings: [],
    });
    mockInvalidateSpaces.mockReset();
    Object.values(mockTracking.onboarding).forEach((fn) => fn.mockClear());
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    cleanupFakeTimers();
    vi.unstubAllEnvs();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('sanity-checks fake timers intercept the hook timeout and interval registrations', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const { result, unmount } = renderOnboardingHook();

    await enterToolAuthStep(result);
    await driveToolToAwaiting(result);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60000);
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);

    await advanceTimers(5000);

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
    expect(window.miscApi.verifyToolAuth).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('does not poll when a tool is ready_to_connect but the user has not clicked connect', async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderOnboardingHook();

    await enterToolAuthStep(result);
    await driveToolToReady(result);
    await advanceTimers(5000);

    expect(window.miscApi.verifyToolAuth).not.toHaveBeenCalled();
    expect(result.current.state.toolAuthStates.find((state) => state.tool === 'gmail')?.status).toBe('ready_to_connect');

    unmount();
  });

  it('connects from an awaiting_auth poll and ignores polling after the tool leaves awaiting_auth', async () => {
    vi.useFakeTimers();
    window.miscApi.verifyToolAuth = vi.fn().mockResolvedValue({
      success: true,
      isAuthenticated: true,
    });
    const { result, unmount } = renderOnboardingHook();

    await enterToolAuthStep(result);
    await driveToolToAwaiting(result);
    await advanceTimers(5000);

    expect(window.miscApi.verifyToolAuth).toHaveBeenCalledTimes(1);
    expect(result.current.state.toolAuthStates.find((state) => state.tool === 'gmail')?.status).toBe('connected');
    expect(mockTracking.onboarding.toolAuthVerified).toHaveBeenCalledWith('email', true);

    window.miscApi.verifyToolAuth = vi.fn().mockResolvedValue({
      success: true,
      isAuthenticated: true,
    });
    await act(async () => {
      result.current.actions.setToolAuthStatusForTest('outlook-mail', 'generating', { error: null });
    });
    await flushAsync();
    await act(async () => {
      result.current.actions.setToolAuthStatusForTest('outlook-mail', 'ready_to_connect', {
        authUrl: 'https://auth.example.test/outlook-mail',
      });
    });
    await flushAsync();
    await act(async () => {
      result.current.actions.startOAuthFlow('outlook-mail');
    });
    await flushAsync();
    await act(async () => {
      result.current.actions.setToolAuthStatusForTest('outlook-mail', 'connected', {
        error: null,
        awaitingSince: null,
      });
    });
    await flushAsync();
    await advanceTimers(5000);

    expect(window.miscApi.verifyToolAuth).not.toHaveBeenCalled();
    expect(result.current.state.toolAuthStates.find((state) => state.tool === 'outlook-mail')?.status).toBe('connected');

    unmount();
  });

  it('polls at 5s, repeats after another 5s, and times out at 60s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pollTimes: number[] = [];
    window.miscApi.verifyToolAuth = vi.fn().mockImplementation(async () => {
      pollTimes.push(Date.now());
      return { success: true, isAuthenticated: false };
    });
    const { result, unmount } = renderOnboardingHook();

    await enterToolAuthStep(result);
    await driveToolToAwaiting(result);

    await advanceTimers(4999);
    expect(window.miscApi.verifyToolAuth).not.toHaveBeenCalled();

    await advanceTimers(1);
    expect(pollTimes).toEqual([5000]);

    await advanceTimers(4999);
    expect(pollTimes).toEqual([5000]);

    await advanceTimers(1);
    expect(pollTimes).toEqual([5000, 10000]);

    await advanceTimers(49999);
    expect(result.current.state.toolAuthStates.find((state) => state.tool === 'gmail')?.status).toBe('awaiting_auth');

    await advanceTimers(1);
    const gmail = result.current.state.toolAuthStates.find((state) => state.tool === 'gmail');
    expect(gmail?.status).toBe('error');
    expect(gmail?.error).toBe('Timed out waiting for authentication — try again.');
    expect(gmail?.authUrl).toBeNull();

    unmount();
  });

  it('does not reset the polling timeout after a malformed poll no-op response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    window.miscApi.verifyToolAuth = vi.fn().mockResolvedValue({
      success: true,
    });
    const { result, unmount } = renderOnboardingHook();

    await enterToolAuthStep(result);
    await driveToolToAwaiting(result);

    await advanceTimers(5000);
    expect(window.miscApi.verifyToolAuth).toHaveBeenCalledTimes(1);
    expect(result.current.state.toolAuthStates.find((state) => state.tool === 'gmail')?.status).toBe('awaiting_auth');

    await advanceTimers(54999);
    expect(result.current.state.toolAuthStates.find((state) => state.tool === 'gmail')?.status).toBe('awaiting_auth');

    await advanceTimers(1);
    const gmail = result.current.state.toolAuthStates.find((state) => state.tool === 'gmail');
    expect(gmail?.status).toBe('error');
    expect(gmail?.error).toBe('Timed out waiting for authentication — try again.');
    expect(gmail?.authUrl).toBeNull();

    unmount();
  });
});

describe('useOnboardingFlow tool-auth readiness gate', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('DEV', false);
    installWindowApis();
    mockFetchSpaces.mockReset();
    mockFetchSpaces.mockResolvedValue(undefined);
    mockGetSpacesSnapshotFor.mockReset();
    mockGetSpacesSnapshotFor.mockReturnValue({
      spaces: [],
      ready: true,
      error: false,
      parseWarnings: [],
    });
    mockInvalidateSpaces.mockReset();
    Object.values(mockTracking.onboarding).forEach((fn) => fn.mockClear());
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    cleanupFakeTimers();
    vi.unstubAllEnvs();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('is true when any email tool errored, true when one is connected, and false when all email tools are pending', async () => {
    const { result, unmount } = renderOnboardingHook();

    await enterToolAuthStep(result);
    expect(result.current.state.canSkipToolAuth).toBe(false);
    expect(result.current.state.toolAuthReady).toBe(false);

    await act(async () => {
      result.current.actions.setToolAuthStatusForTest('gmail', 'generating', { error: null });
    });
    await flushAsync();
    await act(async () => {
      result.current.actions.setToolAuthStatusForTest('gmail', 'error', {
        error: 'Email auth failed',
        awaitingSince: null,
      });
    });
    await flushAsync();
    expect(result.current.state.toolAuthReady).toBe(true);

    await act(async () => {
      result.current.actions.setToolAuthStatusForTest('gmail', 'generating', {
        error: null,
      });
    });
    await flushAsync();
    await act(async () => {
      result.current.actions.setToolAuthStatusForTest('gmail', 'ready_to_connect', {
        authUrl: 'https://auth.example.test/gmail',
      });
    });
    await flushAsync();
    expect(result.current.state.toolAuthReady).toBe(false);

    await act(async () => {
      result.current.actions.startOAuthFlow('gmail');
    });
    await flushAsync();
    await act(async () => {
      result.current.actions.setToolAuthStatusForTest('gmail', 'connected', {
        error: null,
        awaitingSince: null,
      });
    });
    await flushAsync();
    expect(result.current.state.toolAuthReady).toBe(true);

    unmount();
  });
});
