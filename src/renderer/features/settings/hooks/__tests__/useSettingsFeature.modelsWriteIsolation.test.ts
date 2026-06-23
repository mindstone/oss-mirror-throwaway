// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanupFakeTimers, flushAsync, renderHook, setupFakeTimers } from '@renderer/test-utils';
import type { AppSettings } from '@shared/types';
import { useSettingsFeature } from '../useSettingsFeature';

const makeSettings = (): AppSettings => ({
  coreDirectory: '/tmp/library',
  mcpConfigFile: null,
  onboardingCompleted: true,
  userEmail: null,
  onboardingFirstCompletedAt: null,
  voice: {
    provider: 'openai-whisper',
    openaiApiKey: null,
    elevenlabsApiKey: null,
    model: 'gpt-4o-mini-transcribe-2025-12-15',
    ttsVoice: null,
    activationHotkey: null,
    activationHotkeyVoiceMode: true,
  },
  claude: {
    apiKey: 'fake-legacy-key',
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-sonnet-4-6',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: true,
    thinkingEffort: 'high',
  },
  models: {
    apiKey: 'fake-models-key',
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-opus-4-7',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: true,
    thinkingEffort: 'high',
  },
  diagnostics: {
    debugBreadcrumbsUntil: null,
  },
  localModel: {
    profiles: [],
    activeProfileId: null,
  },
  openRouter: {
    enabled: false,
    oauthToken: null,
    selectedModel: 'openai/gpt-5.5',
  },
  activeProvider: 'anthropic',
} as AppSettings);

describe('useSettingsFeature updateClaude migration write isolation', () => {
  let updateMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setupFakeTimers();
    updateMock = vi.fn(async (next: AppSettings) => next);

    Object.assign(window, {
      api: {
        onDemoModeChange: vi.fn(() => () => {}),
        onSettingsExternalUpdate: vi.fn(() => () => {}),
        onAuthConfigReceived: vi.fn(() => () => {}),
        getAnalyticsStatus: vi.fn(async () => null),
      },
      settingsApi: {
        get: vi.fn(async () => makeSettings()),
        update: updateMock,
      },
    });
  });

  afterEach(() => {
    cleanupFakeTimers();
    vi.restoreAllMocks();
  });

  it('writes models namespace only and does not emit legacy claude namespace', async () => {
    const { result, unmount } = renderHook(() => useSettingsFeature({
      emitLog: vi.fn(),
      showToast: vi.fn(),
    }));

    await flushAsync();
    await flushAsync();

    expect(result.current.draftSettings?.models?.apiKey).toBe('fake-models-key');
    expect(result.current.draftSettings).not.toHaveProperty('claude');

    act(() => {
      result.current.updateClaude('apiKey', 'fake-new-models-key');
    });

    expect(result.current.draftSettings?.models?.apiKey).toBe('fake-new-models-key');
    expect(result.current.draftSettings).not.toHaveProperty('claude');

    act(() => {
      vi.advanceTimersByTime(900);
    });
    await flushAsync();

    expect(updateMock).toHaveBeenCalledTimes(1);
    const writePayload = updateMock.mock.calls[0]?.[0] as AppSettings;
    expect(writePayload.models?.apiKey).toBe('fake-new-models-key');
    expect(writePayload).not.toHaveProperty('claude');

    unmount();
  });
});
