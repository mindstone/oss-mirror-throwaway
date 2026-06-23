import { describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import { createOpenAIClientFromProfile } from '../clientFactory';
import { OpenAIClient } from '../clients/openaiClient';
import type { CodexModeConfig } from '../codexModeTypes';

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    coreDirectory: process.cwd(),
    models: {
      model: 'claude-sonnet-4-5',
      thinkingModel: null,
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: false,
      thinkingEffort: 'medium',
      apiKey: 'fake-ant-test',
      longContextFallbackModel: null,
    },
    diagnostics: { debugBreadcrumbsUntil: null },
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'whisper-1',
      ttsVoice: null,
      activationHotkey: 'Alt+Space',
      activationHotkeyVoiceMode: 'Alt+Space',
    },
    providerKeys: { openai: 'fake-shared-openai' },
    localModel: { profiles: [], activeProfileId: null },
    ...overrides,
  } as AppSettings;
}

function makeCodexProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'codex-gpt-5.5',
    name: 'GPT-5.5 (ChatGPT Pro)',
    authSource: 'codex-subscription',
    model: 'gpt-5.5',
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    createdAt: 0,
    ...overrides,
  };
}

const codexMode: CodexModeConfig = {
  endpointUrl: 'https://chatgpt.com/backend-api/codex',
  getAccessToken: vi.fn(async () => 'codex-token'),
  getAccountId: vi.fn(() => 'org_123'),
  forceRefreshToken: vi.fn(async () => 'codex-token-refreshed'),
};

describe('createOpenAIClientFromProfile codex subscription routing', () => {
  it('uses codexMode for codex-tagged profiles even when providerKeys.openai is configured', () => {
    const client = createOpenAIClientFromProfile(makeCodexProfile(), makeSettings(), codexMode);

    expect(client).toBeInstanceOf(OpenAIClient);
    expect((client as unknown as { codexMode?: CodexModeConfig }).codexMode).toBe(codexMode);
  });

  it('still uses direct OpenAI auth for non-codex profiles with shared provider keys', () => {
    const client = createOpenAIClientFromProfile(
      makeCodexProfile({ id: 'shared-openai', authSource: undefined }),
      makeSettings(),
      codexMode,
    );

    expect(client).toBeInstanceOf(OpenAIClient);
    expect((client as unknown as { codexMode?: CodexModeConfig }).codexMode).toBeUndefined();
    expect((client as unknown as { apiKey?: string }).apiKey).toBe('fake-shared-openai');
  });
});
