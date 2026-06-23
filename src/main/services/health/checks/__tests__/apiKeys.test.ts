import { describe, it, expect, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { checkClaudeApiKeyValid } from '../apiKeys';

vi.mock('../../../codexAuthService', () => ({
  isCodexConnected: vi.fn(() => false),
}));

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    claude: { apiKey: '', workingProfileId: undefined },
    localModel: { profiles: [] },
    activeProvider: undefined,
    openRouter: undefined,
    providerKeys: {},
    customProviders: [],
    ...overrides,
  } as unknown as AppSettings;
}

describe('checkClaudeApiKeyValid', () => {
  it('passes when activeProvider is openrouter (even without full OpenRouter credentials)', () => {
    const settings = makeSettings({
      activeProvider: 'openrouter',
      openRouter: { enabled: false, oauthToken: null, selectedModel: '' },
    });
    const result = checkClaudeApiKeyValid(settings);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('OpenRouter');
  });

  it('passes when activeProvider is openrouter with valid credentials', () => {
    const settings = makeSettings({
      activeProvider: 'openrouter',
      openRouter: { enabled: true, oauthToken: 'sk-or-test', selectedModel: 'anthropic/claude-sonnet-4' },
    });
    const result = checkClaudeApiKeyValid(settings);
    expect(result.status).toBe('pass');
  });

  it('passes when activeProvider is codex', () => {
    const settings = makeSettings({ activeProvider: 'codex' });
    const result = checkClaudeApiKeyValid(settings);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('ChatGPT Pro');
  });

  it('fails when no provider set and no API key configured', () => {
    const settings = makeSettings();
    const result = checkClaudeApiKeyValid(settings);
    expect(result.status).toBe('fail');
  });

  it('passes when Anthropic API key is valid', () => {
    const settings = makeSettings({
      models: { apiKey: 'sk-ant-api-test-key-1234567890abcdefghijk' } as AppSettings['models'],
    });
    const result = checkClaudeApiKeyValid(settings);
    expect(result.status).toBe('pass');
  });

  it('fails with "API key not configured" when anthropic provider has no key', () => {
    const settings = makeSettings({ activeProvider: 'anthropic' });
    const result = checkClaudeApiKeyValid(settings);
    expect(result.status).toBe('fail');
  });

  it('passes via legacy path when activeProvider is unset but OpenRouter credentials exist', () => {
    const settings = makeSettings({
      activeProvider: undefined,
      openRouter: { enabled: true, oauthToken: 'sk-or-legacy-token', selectedModel: 'anthropic/claude-sonnet-4' },
    });
    const result = checkClaudeApiKeyValid(settings);
    expect(result.status).toBe('pass');
  });

  it('passes for openrouter even when oauthToken is absent (mid-refresh scenario)', () => {
    const settings = makeSettings({
      activeProvider: 'openrouter',
      openRouter: { enabled: true, oauthToken: null, selectedModel: 'anthropic/claude-sonnet-4' },
    });
    const result = checkClaudeApiKeyValid(settings);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('OpenRouter');
  });
});
