// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { act, cleanupFakeTimers, flushAsync, renderHook } from '@renderer/test-utils/hookTestHarness';
import { useOnboardingFlow, type OnboardingFlowActions, type OnboardingFlowState } from '../useOnboardingFlow';

// Behavior-preserving wire-in coverage for the API-key validation slice now
// backed by the pure `apiKeyValidationMachine`. These exercise the SIX cases in
// PLAN Verification Notes (S2): both-valid-on-welcome, valid-but-past-welcome
// (I9/I10), one-key-invalid, no-keys (I2), parakeet+claude (I3), and close (I11).
// The pure machine + boundary fold are unit/property-tested separately
// (apiKeyValidationMachine.{test,property.test}.ts); this file asserts the hook
// wiring, derivation, and tracking side-effects.

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

type VoiceProvider = 'openai-whisper' | 'local-parakeet' | 'elevenlabs';

type KeyOverrides = {
  claudeApiKey?: string | null;
  voiceProvider?: VoiceProvider;
  openaiApiKey?: string | null;
  elevenlabsApiKey?: string | null;
};

function makeSettings(overrides: KeyOverrides = {}): AppSettings {
  return {
    onboardingCompleted: false,
    coreDirectory: null,
    companyName: 'Acme',
    activeProvider: 'anthropic',
    claude: { apiKey: null },
    openRouter: { oauthToken: null },
    models: { apiKey: overrides.claudeApiKey ?? null },
    voice: {
      provider: overrides.voiceProvider ?? 'openai-whisper',
      openaiApiKey: overrides.openaiApiKey ?? null,
      elevenlabsApiKey: overrides.elevenlabsApiKey ?? null,
    },
  } as unknown as AppSettings;
}

// A validate-key result the renderer's `withRendererTimeout(promise)` will await.
type ValidateResult = { ok: boolean; reason: string; message?: string };

function installWindowApis(settingsApi: Record<string, unknown>) {
  Object.defineProperty(window, 'settingsApi', { configurable: true, value: settingsApi });
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
    value: { getConfig: vi.fn().mockResolvedValue(null) },
  });
  Object.defineProperty(window, 'dashboardApi', {
    configurable: true,
    value: { generateUseCases: vi.fn().mockResolvedValue({ success: true, useCases: [] }) },
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
      getToolAuthUrl: vi.fn().mockResolvedValue({ success: true, authUrl: 'https://auth.example.test/gmail' }),
      verifyToolAuth: vi.fn().mockResolvedValue({ success: true, isAuthenticated: false }),
    },
  });
  Object.defineProperty(window, 'appApi', {
    configurable: true,
    value: { openUrl: vi.fn().mockResolvedValue(undefined) },
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

function makeSettingsApi(overrides: {
  claude?: () => Promise<ValidateResult>;
  openai?: () => Promise<ValidateResult>;
  elevenlabs?: () => Promise<ValidateResult>;
} = {}) {
  const ok = async (): Promise<ValidateResult> => ({ ok: true, reason: 'ok' });
  return {
    validateClaudeKey: vi.fn(overrides.claude ?? ok),
    validateOpenaiKey: vi.fn(overrides.openai ?? ok),
    validateElevenlabsKey: vi.fn(overrides.elevenlabs ?? ok),
  };
}

function renderHookWith(props: { isOpen: boolean; draftSettings: AppSettings | null }) {
  return renderHook<HookApi, { isOpen: boolean; draftSettings: AppSettings | null }>(
    ({ isOpen, draftSettings }) =>
      useOnboardingFlow({ isOpen, draftSettings, completeOnboarding: vi.fn().mockResolvedValue(undefined) }),
    { initialProps: props },
  );
}

describe('useOnboardingFlow API-key validation wire-in', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('DEV', false);
    mockFetchSpaces.mockReset();
    mockFetchSpaces.mockResolvedValue(undefined);
    mockGetSpacesSnapshotFor.mockReset();
    mockGetSpacesSnapshotFor.mockReturnValue({ spaces: [], ready: true, error: false, parseWarnings: [] });
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

  // Case (1): both keys valid + on welcome step → valid, canSkip true, apiStepSkipped once.
  it('valid keys on welcome → status valid, canSkip true, apiStepSkipped(provider) once', async () => {
    installWindowApis(makeSettingsApi());
    const { result, unmount } = renderHookWith({
      isOpen: true,
      draftSettings: makeSettings({ claudeApiKey: 'fake-claude-key', voiceProvider: 'openai-whisper', openaiApiKey: 'fake-openai-key' }),
    });

    await flushAsync();

    expect(result.current.state.apiKeyValidationStatus).toBe('valid');
    expect(result.current.state.canSkipApiStep).toBe(true);
    expect(mockTracking.onboarding.apiStepSkipped).toHaveBeenCalledTimes(1);
    expect(mockTracking.onboarding.apiStepSkipped).toHaveBeenCalledWith('openai-whisper');
    expect(mockTracking.onboarding.apiStepValidationFailed).not.toHaveBeenCalled();

    unmount();
  });

  // Case (2): valid keys but stepIndex advanced past welcome before the IPC resolves →
  // status valid, canSkip FALSE, no apiStepSkipped (I9/I10). Driven by deferring the
  // Claude validate resolution, navigating to step 1, then resolving — so the effect
  // reads stepIndexRef.current === 1 at settle time. Non-vacuous: the deferred resolve
  // is the only thing that completes validation.
  it('valid but navigated past welcome before resolve → valid, canSkip FALSE, no apiStepSkipped', async () => {
    let resolveClaude: (r: ValidateResult) => void = () => undefined;
    const claudePromise = new Promise<ValidateResult>((resolve) => {
      resolveClaude = resolve;
    });
    installWindowApis(makeSettingsApi({ claude: () => claudePromise }));

    const { result, unmount } = renderHookWith({
      isOpen: true,
      draftSettings: makeSettings({ claudeApiKey: 'fake-claude-key', voiceProvider: 'openai-whisper', openaiApiKey: 'fake-openai-key' }),
    });

    await flushAsync();
    // Validation is in flight (validating); voice leg already resolved ok, Claude is pending.
    expect(result.current.state.apiKeyValidationStatus).toBe('validating');

    // User navigates past welcome while Claude validation is still pending.
    await act(async () => {
      result.current.actions.setStepIndex(1);
    });
    await flushAsync();

    // Now resolve Claude — both legs valid, but stepIndexRef.current === 1 at settle.
    await act(async () => {
      resolveClaude({ ok: true, reason: 'ok' });
      await flushAsync();
    });

    expect(result.current.state.apiKeyValidationStatus).toBe('valid');
    expect(result.current.state.canSkipApiStep).toBe(false);
    expect(mockTracking.onboarding.apiStepSkipped).not.toHaveBeenCalled();
    expect(mockTracking.onboarding.apiStepValidationFailed).not.toHaveBeenCalled();

    unmount();
  });

  // Case (2c): wizard CLOSED mid-flight (abandoned session) → the funnel analytics
  // emit is suppressed (isOpenRef recheck). The state write still lands (it's local +
  // self-corrects on reopen), but apiStepSkipped MUST NOT fire — emitting it would
  // over-count skips for a wizard the user already closed. Non-vacuous: without the
  // isOpenRef guard, the deferred resolve below fires apiStepSkipped.
  it('wizard closed before validation resolves → no apiStepSkipped funnel event', async () => {
    let resolveClaude: (r: ValidateResult) => void = () => undefined;
    const claudePromise = new Promise<ValidateResult>((resolve) => {
      resolveClaude = resolve;
    });
    installWindowApis(makeSettingsApi({ claude: () => claudePromise }));

    const { result, rerender, unmount } = renderHookWith({
      isOpen: true,
      draftSettings: makeSettings({ claudeApiKey: 'fake-claude-key', voiceProvider: 'openai-whisper', openaiApiKey: 'fake-openai-key' }),
    });

    await flushAsync();
    expect(result.current.state.apiKeyValidationStatus).toBe('validating');

    // User closes the wizard while Claude validation is still in flight.
    await act(async () => {
      rerender({
        isOpen: false,
        draftSettings: makeSettings({ claudeApiKey: 'fake-claude-key', voiceProvider: 'openai-whisper', openaiApiKey: 'fake-openai-key' }),
      });
      await flushAsync();
    });

    // Now the in-flight validation resolves — both legs valid — but the wizard is closed.
    await act(async () => {
      resolveClaude({ ok: true, reason: 'ok' });
      await flushAsync();
    });

    // The closed-window funnel event is suppressed.
    expect(mockTracking.onboarding.apiStepSkipped).not.toHaveBeenCalled();
    expect(mockTracking.onboarding.apiStepValidationFailed).not.toHaveBeenCalled();

    unmount();
  });

  // Case (3): one key invalid → status invalid, apiStepValidationFailed('claude_invalid').
  it('invalid Claude key → status invalid, apiStepValidationFailed(claude_invalid)', async () => {
    installWindowApis(
      makeSettingsApi({ claude: async () => ({ ok: false, reason: 'invalid', message: 'bad key' }) }),
    );
    const { result, unmount } = renderHookWith({
      isOpen: true,
      draftSettings: makeSettings({ claudeApiKey: 'fake-bad-key', voiceProvider: 'openai-whisper', openaiApiKey: 'fake-openai-key' }),
    });

    await flushAsync();

    expect(result.current.state.apiKeyValidationStatus).toBe('invalid');
    expect(result.current.state.canSkipApiStep).toBe(false);
    expect(mockTracking.onboarding.apiStepValidationFailed).toHaveBeenCalledTimes(1);
    expect(mockTracking.onboarding.apiStepValidationFailed).toHaveBeenCalledWith('claude_invalid');
    expect(mockTracking.onboarding.apiStepSkipped).not.toHaveBeenCalled();

    unmount();
  });

  // Case (4): no keys → stays idle, no tracking, guard ref NOT consumed (I2): a later
  // draftSettings change with keys must still trigger validation.
  it('no keys → idle, no tracking, guard ref not consumed (later run can proceed)', async () => {
    const settingsApi = makeSettingsApi();
    installWindowApis(settingsApi);
    const { result, rerender, unmount } = renderHookWith({
      isOpen: true,
      draftSettings: makeSettings({ claudeApiKey: null, voiceProvider: 'openai-whisper', openaiApiKey: null }),
    });

    await flushAsync();

    expect(result.current.state.apiKeyValidationStatus).toBe('idle');
    expect(result.current.state.canSkipApiStep).toBe(false);
    expect(settingsApi.validateClaudeKey).not.toHaveBeenCalled();
    expect(mockTracking.onboarding.apiStepSkipped).not.toHaveBeenCalled();
    expect(mockTracking.onboarding.apiStepValidationFailed).not.toHaveBeenCalled();

    // I2: guard ref not consumed — supplying keys later still runs validation.
    await act(async () => {
      rerender({
        isOpen: true,
        draftSettings: makeSettings({ claudeApiKey: 'fake-claude-key', voiceProvider: 'openai-whisper', openaiApiKey: 'fake-openai-key' }),
      });
      await flushAsync();
    });

    expect(settingsApi.validateClaudeKey).toHaveBeenCalledTimes(1);
    expect(result.current.state.apiKeyValidationStatus).toBe('valid');
    expect(result.current.state.canSkipApiStep).toBe(true);

    unmount();
  });

  // Case (5): local-parakeet voice + valid Claude → valid (I3): the voice leg resolves
  // ok without an IPC call; only the Claude key needs validating.
  it('local-parakeet + valid Claude → status valid, canSkip true (no voice IPC)', async () => {
    const settingsApi = makeSettingsApi();
    installWindowApis(settingsApi);
    const { result, unmount } = renderHookWith({
      isOpen: true,
      draftSettings: makeSettings({ claudeApiKey: 'fake-claude-key', voiceProvider: 'local-parakeet' }),
    });

    await flushAsync();

    expect(result.current.state.apiKeyValidationStatus).toBe('valid');
    expect(result.current.state.canSkipApiStep).toBe(true);
    expect(settingsApi.validateOpenaiKey).not.toHaveBeenCalled();
    expect(settingsApi.validateElevenlabsKey).not.toHaveBeenCalled();
    expect(mockTracking.onboarding.apiStepSkipped).toHaveBeenCalledWith('local-parakeet');

    unmount();
  });

  // Case (6): close (isOpen → false) resets to idle / canSkip false (I11).
  it('closing the wizard resets validation to idle / canSkip false', async () => {
    installWindowApis(makeSettingsApi());
    const { result, rerender, unmount } = renderHookWith({
      isOpen: true,
      draftSettings: makeSettings({ claudeApiKey: 'fake-claude-key', voiceProvider: 'openai-whisper', openaiApiKey: 'fake-openai-key' }),
    });

    await flushAsync();
    expect(result.current.state.apiKeyValidationStatus).toBe('valid');
    expect(result.current.state.canSkipApiStep).toBe(true);

    await act(async () => {
      rerender({
        isOpen: false,
        draftSettings: makeSettings({ claudeApiKey: 'fake-claude-key', voiceProvider: 'openai-whisper', openaiApiKey: 'fake-openai-key' }),
      });
      await flushAsync();
    });

    expect(result.current.state.apiKeyValidationStatus).toBe('idle');
    expect(result.current.state.canSkipApiStep).toBe(false);

    unmount();
  });

  // Case (7) / I1: at-most-once per wizard open. The validation effect's dep array
  // is [isOpen, draftSettings], so a new `draftSettings` object identity (same keys)
  // re-runs the effect — but the `hasValidatedApiKeysRef` single-shot guard must
  // prevent it from re-validating (no duplicate IPC, no duplicate `apiStepSkipped`).
  // Without the guard this would re-fire on every draftSettings change, silently
  // double-counting the skip analytic and re-calling validate IPC.
  it('does not re-validate on a draftSettings identity change while open (I1 single-shot guard)', async () => {
    const settingsApi = makeSettingsApi();
    installWindowApis(settingsApi);
    const { result, rerender, unmount } = renderHookWith({
      isOpen: true,
      draftSettings: makeSettings({ claudeApiKey: 'fake-claude-key', voiceProvider: 'openai-whisper', openaiApiKey: 'fake-openai-key' }),
    });

    await flushAsync();
    expect(result.current.state.apiKeyValidationStatus).toBe('valid');
    expect(settingsApi.validateClaudeKey).toHaveBeenCalledTimes(1);
    expect(mockTracking.onboarding.apiStepSkipped).toHaveBeenCalledTimes(1);

    // Re-render with a fresh settings object (new identity, SAME keys) — effect re-runs.
    await act(async () => {
      rerender({
        isOpen: true,
        draftSettings: makeSettings({ claudeApiKey: 'fake-claude-key', voiceProvider: 'openai-whisper', openaiApiKey: 'fake-openai-key' }),
      });
      await flushAsync();
    });

    // The single-shot guard must hold: no second IPC call, no second skip analytic.
    expect(settingsApi.validateClaudeKey).toHaveBeenCalledTimes(1);
    expect(mockTracking.onboarding.apiStepSkipped).toHaveBeenCalledTimes(1);

    unmount();
  });
});
