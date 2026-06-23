import { describe, it, expect } from 'vitest';
import {
  applyOpenRouterModelDefaults,
  OR_DEFAULT_THINKING_MODEL,
  OR_DEFAULT_WORKING_MODEL,
  OR_DEFAULT_BTS_MODEL,
} from '../openRouterDefaults';
import type { AppSettings } from '../../types';

const makeSettings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
  coreDirectory: null,
  mcpConfigFile: null,
  onboardingCompleted: false,
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
  models: {
    apiKey: 'fake-test',
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-sonnet-4-6',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: true,
    thinkingEffort: 'high',
  },
  claude: {
    apiKey: 'fake-test',
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-sonnet-4-6',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: true,
    thinkingEffort: 'high',
  },
  diagnostics: { debugBreadcrumbsUntil: null },
  ...overrides,
});

describe('applyOpenRouterModelDefaults', () => {
  it('sets all three model roles correctly', () => {
    const result = applyOpenRouterModelDefaults(makeSettings());
    expect(result.models?.model).toBe(OR_DEFAULT_WORKING_MODEL);
    expect(result.models?.thinkingModel).toBe(OR_DEFAULT_THINKING_MODEL);
    expect(result.behindTheScenesModel).toBe(OR_DEFAULT_BTS_MODEL);
  });

  it('sets activeProvider to openrouter', () => {
    const result = applyOpenRouterModelDefaults(makeSettings());
    expect(result.activeProvider).toBe('openrouter');
  });

  it('sets the managed-provider opt-out marker (so the /api/config reconcile cannot re-activate Mindstone over a direct OpenRouter connect/heal)', () => {
    const result = applyOpenRouterModelDefaults(makeSettings());
    expect(result.managedProviderDeactivated).toBe(true);
  });

  it('does not include openRouter in result to prevent token clobbering', () => {
    const result = applyOpenRouterModelDefaults(makeSettings());
    expect(result.openRouter).toBeUndefined();
  });

  it('clears profile IDs but leaves fallbacks for providerSwitch to evaluate', () => {
    const settings = makeSettings({
      models: {
        ...makeSettings().models!,
        thinkingProfileId: 'some-profile',
        workingProfileId: 'some-other-profile',
        thinkingFallback: 'model:claude-sonnet-4-6',
        workingFallback: 'model:claude-haiku-4-5',
        longContextFallbackModel: 'claude-haiku-4-5',
        longContextFallbackProfileId: 'some-profile',
      },
    });
    const result = applyOpenRouterModelDefaults(settings);
    expect(result.models?.thinkingProfileId).toBeUndefined();
    expect(result.models?.workingProfileId).toBeUndefined();
    expect(result.models?.thinkingFallback).toBe('model:claude-sonnet-4-6');
    expect(result.models?.workingFallback).toBe('model:claude-haiku-4-5');
    expect(result.models?.longContextFallbackModel).toBe('claude-haiku-4-5');
    expect(result.models?.longContextFallbackProfileId).toBe('some-profile');
    expect(result.backgroundFallback).toBeUndefined();
  });

  it('does not touch openRouter token (callers manage it separately)', () => {
    const settings = makeSettings({
      openRouter: {
        enabled: false,
        oauthToken: 'fake-or-test-token',
        selectedModel: 'anthropic/claude-sonnet-4.6',
      },
    });
    const result = applyOpenRouterModelDefaults(settings);
    // openRouter is intentionally excluded from defaults to prevent
    // dirty-key preservation from clobbering the OAuth token
    expect(result.openRouter).toBeUndefined();
  });

  it('clears localModel.activeProfileId to prevent legacy profile routing', () => {
    const settings = makeSettings({
      localModel: {
        profiles: [{ id: 'legacy-profile', name: 'Legacy', serverUrl: 'http://localhost', createdAt: 0 }],
        activeProfileId: 'legacy-profile',
      },
    });
    const result = applyOpenRouterModelDefaults(settings);
    expect(result.localModel?.activeProfileId).toBeNull();
    expect(result.localModel?.profiles).toHaveLength(1);
  });

  it('preserves non-model settings fields when sourced from legacy claude namespace', () => {
    const settings = makeSettings();
    const result = applyOpenRouterModelDefaults(settings);
    expect(result.models?.apiKey).toBe('fake-test');
    expect(result.models?.thinkingEffort).toBe('high');
    expect(result.models?.authMethod).toBe('api-key');
  });

  it('exports correct constant values', () => {
    expect(OR_DEFAULT_THINKING_MODEL).toBe('anthropic/claude-opus-4-8');
    expect(OR_DEFAULT_WORKING_MODEL).toBe('openai/gpt-5.5');
    expect(OR_DEFAULT_BTS_MODEL).toBe('deepseek/deepseek-v4-flash');
  });
});
