import { describe, expect, it } from 'vitest';
import type { ModelProfile } from '@shared/types';
import { resolveModelAgentInfo } from '../modelAgentLabels';

const createProfile = (overrides: Partial<ModelProfile>): ModelProfile => ({
  id: 'profile-1',
  name: 'Test Profile',
  serverUrl: 'https://api.example.com/v1',
  createdAt: 1,
  ...overrides
});

describe('resolveModelAgentInfo', () => {
  it('resolves council model using profile + preset lookup', () => {
    const profiles = [
      createProfile({
        name: 'GPT-5.2',
        model: 'gpt-5.2',
        providerType: 'openai'
      })
    ];

    const result = resolveModelAgentInfo('council-gpt-5-2', profiles);

    expect(result).toEqual({
      label: 'GPT-5.2',
      provider: 'OpenAI',
      providerType: 'openai',
      isModelAgent: true,
      isCouncil: true
    });
  });

  it('resolves ad-hoc model using profile + preset lookup', () => {
    const profiles = [
      createProfile({
        name: 'Gemini 3.1 Pro Preview',
        model: 'gemini-3.1-pro-preview',
        providerType: 'google'
      })
    ];

    const result = resolveModelAgentInfo('model-gemini-3.1-pro-preview', profiles);

    expect(result).toEqual({
      label: 'Gemini 3.1 Pro',
      provider: 'Google Gemini',
      providerType: 'google',
      isModelAgent: true,
      isCouncil: false
    });
  });

  it('strips profile collision suffixes before matching', () => {
    const profiles = [
      createProfile({
        name: 'GPT-5.2',
        model: 'gpt-5.2',
        providerType: 'openai'
      })
    ];

    const result = resolveModelAgentInfo('council-gpt-5-2-profile-1', profiles);

    expect(result.label).toBe('GPT-5.2');
    expect(result.provider).toBe('OpenAI');
    expect(result.isCouncil).toBe(true);
  });

  it('falls back to prettified slug when no profile or preset matches', () => {
    const result = resolveModelAgentInfo('council-custom-thing', []);

    expect(result).toEqual({
      label: 'Custom Thing',
      isModelAgent: true,
      isCouncil: true
    });
  });

  it('passes non-model agents through formatSubAgentName behavior', () => {
    const result = resolveModelAgentInfo('implementer');

    expect(result).toEqual({
      label: 'Implementer',
      isModelAgent: false,
      isCouncil: false
    });
  });

  it('uses matching profile slug to resolve canonical preset label', () => {
    const profiles = [
      createProfile({
        name: 'Fast GPT',
        model: 'gpt-5.2',
        providerType: 'openai'
      })
    ];

    const result = resolveModelAgentInfo('council-fast-gpt', profiles);

    expect(result).toEqual({
      label: 'GPT-5.2',
      provider: 'OpenAI',
      providerType: 'openai',
      isModelAgent: true,
      isCouncil: true
    });
  });

  it('handles empty and undefined subagent types gracefully', () => {
    const emptyResult = resolveModelAgentInfo('');
    const undefinedResult = resolveModelAgentInfo(undefined as unknown as string);

    expect(emptyResult).toEqual({
      label: 'Sub-agent',
      isModelAgent: false,
      isCouncil: false
    });

    expect(undefinedResult).toEqual({
      label: 'Sub-agent',
      isModelAgent: false,
      isCouncil: false
    });
  });

  it('resolves from presets when profiles are not provided', () => {
    const presetResult = resolveModelAgentInfo('model-gpt-5-2');
    const fallbackResult = resolveModelAgentInfo('model-some-model');

    // GPT-5.2 label exists in both OpenAI and OpenRouter presets;
    // iteration order means OpenRouter (last writer) wins for the slug-based fallback.
    expect(presetResult).toEqual({
      label: 'GPT-5.2',
      provider: 'OpenRouter',
      providerType: 'openrouter',
      isModelAgent: true,
      isCouncil: false
    });

    expect(fallbackResult).toEqual({
      label: 'Some Model',
      isModelAgent: true,
      isCouncil: false
    });
  });

  it('handles profile with providerType "other" and unknown model', () => {
    const profiles = [
      createProfile({
        name: 'My Local Model',
        model: 'llama-custom-finetune',
        providerType: 'other'
      })
    ];

    const result = resolveModelAgentInfo('council-my-local-model', profiles);

    expect(result.label).toBe('My Local Model');
    expect(result.provider).toBeUndefined();
    expect(result.providerType).toBe('other');
    expect(result.isModelAgent).toBe(true);
  });

  it('accepts undefined subagentType (widened signature)', () => {
    const result = resolveModelAgentInfo(undefined);

    expect(result.isModelAgent).toBe(false);
    expect(result.label).toBe('Sub-agent');
  });

  it('tries original slug before stripping collision suffix', () => {
    // A profile whose name legitimately ends with "profile-x"
    const profiles = [
      createProfile({
        name: 'Test Profile-X',
        model: 'gpt-5.2',
        providerType: 'openai'
      })
    ];

    const result = resolveModelAgentInfo('council-test-profile-x', profiles);

    expect(result.label).toBe('GPT-5.2');
    expect(result.isModelAgent).toBe(true);
  });
});
