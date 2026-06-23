/**
 * Tests for the desktop-decorated agentEventDispatcher.
 *
 * Focus: the `showAutomationOutcomeNotification` helper added to support
 * scheduler-owned automation notifications (fixes silent-automation-failure,
 * REBEL-1BK). See docs/plans/260415_automation_silent_failure_fix.md.
 */

const {
  getSettingsMock,
  showDesktopNotificationMock,
  showUnreadDotMock,
  getSessionMock,
  isDefaultOrFallbackTitleMock,
  resolveModelSettingsMock,
  isCodexConnectedMock,
  getCodexAuthProviderMock,
} = vi.hoisted(() => {
  const isCodexConnected = vi.fn().mockReturnValue(false);
  return {
    getSettingsMock: vi.fn(),
    showDesktopNotificationMock: vi.fn(),
    showUnreadDotMock: vi.fn(),
    getSessionMock: vi.fn(),
    isDefaultOrFallbackTitleMock: vi.fn().mockReturnValue(false),
    resolveModelSettingsMock: vi.fn().mockReturnValue({}),
    isCodexConnectedMock: isCodexConnected,
    getCodexAuthProviderMock: vi.fn(() => ({ isConnected: isCodexConnected })),
  };
});

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('@core/services/agentEventDispatcher', () => ({
  dispatchAgentEvent: vi.fn(),
  dispatchAgentErrorEvent: vi.fn(),
  sanitizeEventForMainAccumulation: vi.fn((e) => e),
}));

// NOTE: vi.mock resolves paths from THIS test file's perspective. The
// dispatcher imports `../settingsStore` (resolves to src/main/settingsStore
// from its location at src/main/services/). From this test file at
// src/main/services/__tests__/, that same module is at `../../settingsStore`.
vi.mock('../../settingsStore', () => ({
  getSettings: getSettingsMock,
}));

vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getRendererSession: vi.fn(),
    getTurnCategory: vi.fn(),
  },
}));

vi.mock('../dockBadgeService', () => ({
  showUnreadDot: showUnreadDotMock,
}));

vi.mock('../desktopNotificationService', () => ({
  showDesktopNotification: showDesktopNotificationMock,
}));

vi.mock('../incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({
    getSession: getSessionMock,
  }),
}));

vi.mock('../conversationTitleService', () => ({
  isDefaultOrFallbackTitle: isDefaultOrFallbackTitleMock,
}));

vi.mock('@core/codexAuth', () => ({
  getCodexAuthProvider: getCodexAuthProviderMock,
}));

vi.mock('@shared/utils/modelSettingsResolver', () => ({
  resolveModelSettings: resolveModelSettingsMock,
}));

import { buildAgentErrorSettingsContext, showAutomationOutcomeNotification } from '../agentEventDispatcher';

describe('showAutomationOutcomeNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingsMock.mockReturnValue({
      notifications: { enabled: true, automationComplete: true },
    });
    getSessionMock.mockResolvedValue({ title: 'My automation', messages: [] });
    isDefaultOrFallbackTitleMock.mockReturnValue(false);
  });

  it('shows "needs attention" notification for failure status', async () => {
    await showAutomationOutcomeNotification({
      status: 'failure',
      errorMessage: "The automation couldn't complete — all 3 tool calls failed.",
      sessionId: 'session-1',
    });

    expect(showUnreadDotMock).toHaveBeenCalled();
    expect(showDesktopNotificationMock).toHaveBeenCalledWith({
      title: 'Rebel automation needs attention',
      body: "My automation — The automation couldn't complete — all 3 tool calls failed.",
      sessionId: 'session-1',
    });
  });

  it('uses errorMessage in body when no session title is available', async () => {
    getSessionMock.mockResolvedValue(null);

    await showAutomationOutcomeNotification({
      status: 'failure',
      errorMessage: 'Tool calls failed',
      sessionId: 'session-2',
    });

    expect(showDesktopNotificationMock).toHaveBeenCalledWith({
      title: 'Rebel automation needs attention',
      body: 'Tool calls failed',
      sessionId: 'session-2',
    });
  });

  it('shows "complete" notification for success status', async () => {
    await showAutomationOutcomeNotification({
      status: 'success',
      errorMessage: null,
      sessionId: 'session-3',
    });

    expect(showDesktopNotificationMock).toHaveBeenCalledWith({
      title: 'Rebel automation complete',
      body: 'My automation',
      sessionId: 'session-3',
    });
  });

  it('shows "complete" notification for completed_with_blocks status', async () => {
    await showAutomationOutcomeNotification({
      status: 'completed_with_blocks',
      errorMessage: null,
      sessionId: 'session-4',
    });

    expect(showDesktopNotificationMock).toHaveBeenCalledWith({
      title: 'Rebel automation complete',
      body: 'My automation',
      sessionId: 'session-4',
    });
  });

  it('shows "blocked" notification for blocked_by_security status', async () => {
    await showAutomationOutcomeNotification({
      status: 'blocked_by_security',
      errorMessage: 'Automation blocked by security policies',
      sessionId: 'session-5',
    });

    expect(showDesktopNotificationMock).toHaveBeenCalledWith({
      title: 'Rebel automation blocked',
      body: 'My automation — approval needed',
      sessionId: 'session-5',
    });
  });

  it('does NOT notify for cancelled status (user initiated the stop)', async () => {
    await showAutomationOutcomeNotification({
      status: 'cancelled',
      errorMessage: 'Automation was stopped by user',
      sessionId: 'session-6',
    });

    expect(showDesktopNotificationMock).not.toHaveBeenCalled();
    expect(showUnreadDotMock).not.toHaveBeenCalled();
  });

  it('does NOT notify for pending or running statuses', async () => {
    await showAutomationOutcomeNotification({
      status: 'pending',
      errorMessage: null,
      sessionId: 'session-7',
    });
    await showAutomationOutcomeNotification({
      status: 'running',
      errorMessage: null,
      sessionId: 'session-7',
    });

    expect(showDesktopNotificationMock).not.toHaveBeenCalled();
  });

  it('does NOT notify when notifications are disabled globally', async () => {
    getSettingsMock.mockReturnValue({
      notifications: { enabled: false, automationComplete: true },
    });

    await showAutomationOutcomeNotification({
      status: 'failure',
      errorMessage: 'anything',
      sessionId: 'session-8',
    });

    expect(showDesktopNotificationMock).not.toHaveBeenCalled();
  });

  it('does NOT notify when automationComplete is explicitly disabled', async () => {
    getSettingsMock.mockReturnValue({
      notifications: { enabled: true, automationComplete: false },
    });

    await showAutomationOutcomeNotification({
      status: 'failure',
      errorMessage: 'anything',
      sessionId: 'session-9',
    });

    expect(showDesktopNotificationMock).not.toHaveBeenCalled();
  });

  it('does NOT notify when sessionId is missing', async () => {
    await showAutomationOutcomeNotification({
      status: 'failure',
      errorMessage: 'anything',
      sessionId: '',
    });

    expect(showDesktopNotificationMock).not.toHaveBeenCalled();
  });

  it('falls back gracefully when session title fetch throws', async () => {
    getSessionMock.mockRejectedValue(new Error('store unavailable'));

    await showAutomationOutcomeNotification({
      status: 'failure',
      errorMessage: 'Tool calls failed',
      sessionId: 'session-10',
    });

    // Without session title, uses errorMessage as body
    expect(showDesktopNotificationMock).toHaveBeenCalledWith({
      title: 'Rebel automation needs attention',
      body: 'Tool calls failed',
      sessionId: 'session-10',
    });
  });

  it('ignores default/fallback session titles and uses errorMessage instead', async () => {
    isDefaultOrFallbackTitleMock.mockReturnValue(true);

    await showAutomationOutcomeNotification({
      status: 'failure',
      errorMessage: 'Tool calls failed',
      sessionId: 'session-11',
    });

    expect(showDesktopNotificationMock).toHaveBeenCalledWith({
      title: 'Rebel automation needs attention',
      body: 'Tool calls failed',
      sessionId: 'session-11',
    });
  });
});

describe('buildAgentErrorSettingsContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingsMock.mockReturnValue({});
    resolveModelSettingsMock.mockReturnValue({});
    isCodexConnectedMock.mockReturnValue(false);
    getCodexAuthProviderMock.mockReturnValue({ isConnected: isCodexConnectedMock });
  });

  it('defaults activeProvider to anthropic when settings have no provider', () => {
    const ctx = buildAgentErrorSettingsContext();

    expect(ctx).toEqual({
      activeProvider: 'anthropic',
      hasAnthropicCredentials: false,
      hasOpenRouterCredentials: false,
      hasCodexSubscription: false,
    });
  });

  it('marks Anthropic credentials present when modelSettings.apiKey is set', () => {
    resolveModelSettingsMock.mockReturnValue({ apiKey: 'fake-ant-test' });

    const ctx = buildAgentErrorSettingsContext();

    expect(ctx?.hasAnthropicCredentials).toBe(true);
  });

  it('marks OpenRouter credentials present via openRouter.oauthToken', () => {
    getSettingsMock.mockReturnValue({
      openRouter: { oauthToken: 'or-oauth-test' },
    });

    const ctx = buildAgentErrorSettingsContext();

    expect(ctx?.hasOpenRouterCredentials).toBe(true);
  });

  it('falls back to providerKeys.openrouter when oauthToken is absent', () => {
    getSettingsMock.mockReturnValue({
      providerKeys: { openrouter: 'or-key-test' },
    });

    const ctx = buildAgentErrorSettingsContext();

    expect(ctx?.hasOpenRouterCredentials).toBe(true);
  });

  it('marks Codex subscription present when auth provider reports connected', () => {
    isCodexConnectedMock.mockReturnValue(true);

    const ctx = buildAgentErrorSettingsContext();

    expect(ctx?.hasCodexSubscription).toBe(true);
  });

  it('treats Codex provider exceptions as not-connected without failing the build', () => {
    getCodexAuthProviderMock.mockImplementation(() => {
      throw new Error('codex provider not registered');
    });

    const ctx = buildAgentErrorSettingsContext();

    expect(ctx).toEqual({
      activeProvider: 'anthropic',
      hasAnthropicCredentials: false,
      hasOpenRouterCredentials: false,
      hasCodexSubscription: false,
    });
  });

  it('passes modelSettings.model through as currentModel when it is a string', () => {
    resolveModelSettingsMock.mockReturnValue({ model: 'claude-sonnet-4-5' });

    const ctx = buildAgentErrorSettingsContext();

    expect(ctx?.currentModel).toBe('claude-sonnet-4-5');
  });

  // Review F1: recoveryProfiles must be credential-reachable, not merely selectable —
  // offering a keyless profile would lead the user into a second credentials terminal.
  it('recoveryProfiles includes a keyed custom-provider profile and excludes a keyless one', () => {
    getSettingsMock.mockReturnValue({
      customProviders: [{ id: 'cp', name: 'GW', serverUrl: 'https://gw/v1', apiKey: 'gw-key', createdAt: 1 }],
      localModel: {
        activeProfileId: null,
        profiles: [
          { id: 'reachable', name: 'Reachable GW', providerType: 'other', customProviderId: 'cp', serverUrl: 'https://gw/v1', model: 'claude-opus-4-8', enabled: true, createdAt: 1 },
          { id: 'keyless', name: 'Keyless GW', providerType: 'other', serverUrl: 'https://gw2/v1', model: 'claude-opus-4-8', enabled: true, createdAt: 1 },
        ],
      },
    });

    const ctx = buildAgentErrorSettingsContext();

    expect(ctx?.recoveryProfiles).toEqual([
      { id: 'reachable', name: 'Reachable GW', model: 'claude-opus-4-8' },
    ]);
  });

  it('recoveryProfiles includes a local profile (no key required)', () => {
    getSettingsMock.mockReturnValue({
      localModel: {
        activeProfileId: null,
        profiles: [
          { id: 'local', name: 'Local', providerType: 'local', serverUrl: 'http://localhost:11434/v1', model: 'llama-3.1', enabled: true, createdAt: 1 },
        ],
      },
    });

    const ctx = buildAgentErrorSettingsContext();

    expect(ctx?.recoveryProfiles).toEqual([{ id: 'local', name: 'Local', model: 'llama-3.1' }]);
  });

  it('returns undefined and logs when getSettings throws', () => {
    getSettingsMock.mockImplementation(() => {
      throw new Error('settings store unavailable');
    });

    const ctx = buildAgentErrorSettingsContext();

    expect(ctx).toBeUndefined();
  });
});
