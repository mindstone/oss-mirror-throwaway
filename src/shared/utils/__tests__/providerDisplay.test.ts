import { describe, expect, it } from 'vitest';
import type { ModelProfile, ModelProviderType } from '@shared/types';
import { CODEX_WORKING_PROFILE_ID } from '../codexDefaults';
import {
  getProfileProviderSubtitle,
  getProviderDisplayName,
} from '../providerDisplay';

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: overrides.id ?? 'profile-1',
    name: overrides.name ?? 'Catalog profile',
    providerType: overrides.providerType ?? 'openai',
    routeSurface: overrides.routeSurface ?? 'api-key',
    serverUrl: 'https://api.openai.com/v1',
    model: overrides.model ?? 'gpt-5.5',
    createdAt: 1,
    enabled: true,
    profileSource: 'connection',
    ...overrides,
  };
}

describe('providerDisplay', () => {
  it('falls back to Custom for unknown provider display names', () => {
    expect(getProviderDisplayName('unknown-provider' as ModelProviderType)).toBe('Custom');
  });

  it.each([
    ['openai', 'openai' as const, 'api-key' as const, 'From your OpenAI connection'],
    ['anthropic', 'anthropic' as const, 'api-key' as const, 'From your Anthropic connection'],
    ['google', 'google' as const, 'api-key' as const, 'From your Gemini connection'],
    ['openrouter', 'openrouter' as const, 'pool' as const, 'From your OpenRouter connection'],
    ['other', 'other' as const, 'api-key' as const, 'From your Custom connection'],
  ])('formats %s managed-profile subtitles', (_label, providerType, routeSurface, expected) => {
    expect(getProfileProviderSubtitle(profile({ providerType, routeSurface }))).toBe(expected);
  });

  it('formats Codex auto-profile subtitles as ChatGPT Pro', () => {
    expect(
      getProfileProviderSubtitle(
        profile({
          id: CODEX_WORKING_PROFILE_ID,
          profileSource: 'auto',
          providerType: 'openai',
          routeSurface: 'subscription',
          authSource: 'codex-subscription',
        }),
      ),
    ).toBe('From ChatGPT Pro');
  });

  it('omits subtitles for user-added profiles', () => {
    expect(getProfileProviderSubtitle(profile({ profileSource: 'user' }))).toBe('');
  });
});
