import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isUsingOAuth, getApiKeyAuthEnvVars } from '../authEnvUtils';
import type { AppSettings } from '@shared/types';

const createMockSettings = (overrides: Partial<AppSettings['models']> = {}): AppSettings => ({
  models: {
    apiKey: null,
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-sonnet-4-20250514',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: true,
    extendedContext: true,
    thinkingEffort: 'high',
    ...overrides,
  },
  voice: {
    ttsProvider: 'openai',
    ttsVoice: 'alloy',
    sttProvider: 'openai',
    openaiApiKey: null,
    elevenLabsApiKey: null,
    elevenLabsVoiceId: null,
    autoPlayResponse: false,
  },
  coreDirectory: '/test/core',
  mcpConfigFile: null,
  onboardingCompleted: true,
  appearance: { theme: 'system' },
  privacy: { allowTelemetry: true },
  diagnostics: { sentryEnabled: true },
} as unknown as AppSettings);

describe('isUsingOAuth', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns false for Claude auth — Claude OAuth is deprecated', () => {
    const settings = createMockSettings({
      authMethod: 'oauth-token',
      oauthToken: 'test-oauth-token',
    });
    expect(isUsingOAuth(settings)).toBe(false);
  });

  it('returns false when authMethod is api-key with valid key', () => {
    const settings = createMockSettings({
      authMethod: 'api-key',
      apiKey: 'fake-test-key',
    });
    expect(isUsingOAuth(settings)).toBe(false);
  });

  it('returns false when no auth is configured', () => {
    const settings = createMockSettings();
    expect(isUsingOAuth(settings)).toBe(false);
  });
});

describe('getApiKeyAuthEnvVars', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns API key env vars when apiKey is in settings', () => {
    const settings = createMockSettings({
      apiKey: 'fake-settings-key',
    });
    expect(getApiKeyAuthEnvVars(settings)).toEqual({
      ANTHROPIC_API_KEY: 'fake-settings-key',
    });
  });

  it('returns API key env vars from process.env when not in settings', () => {
    process.env.ANTHROPIC_API_KEY = 'fake-env-key';
    const settings = createMockSettings();
    expect(getApiKeyAuthEnvVars(settings)).toEqual({
      ANTHROPIC_API_KEY: 'fake-env-key',
    });
  });

  it('prefers settings apiKey over process.env', () => {
    process.env.ANTHROPIC_API_KEY = 'fake-env-key';
    const settings = createMockSettings({
      apiKey: 'fake-settings-key',
    });
    expect(getApiKeyAuthEnvVars(settings)).toEqual({
      ANTHROPIC_API_KEY: 'fake-settings-key',
    });
  });

  it('returns null when no API key is available', () => {
    const settings = createMockSettings();
    expect(getApiKeyAuthEnvVars(settings)).toBeNull();
  });

  it('returns API key even when OAuth is the selected auth method', () => {
    const settings = createMockSettings({
      authMethod: 'oauth-token',
      oauthToken: 'test-oauth-token',
      apiKey: 'fake-backup-key',
    });
    expect(getApiKeyAuthEnvVars(settings)).toEqual({
      ANTHROPIC_API_KEY: 'fake-backup-key',
    });
  });
});
