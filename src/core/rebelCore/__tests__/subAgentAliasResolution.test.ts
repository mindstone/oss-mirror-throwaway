import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
/**
 * Cross-provider sub-agent model alias resolution tests.
 *
 * These tests verify that sub-agent model aliases resolve to the user's
 * configured models (via profiles and settings) rather than being hardcoded
 * to Claude model names.
 *
 * Primary semantic names: 'thinking', 'working', 'fast'
 * Deprecated Anthropic-branded names (backward compat): 'opus', 'sonnet', 'haiku'
 *
 * Tests the exported resolveModelAlias and resolveSubagentModel from agentTool.ts.
 */
import { describe, expect, it } from 'vitest';
import type { AppSettings } from '@shared/types';
import { resolveModelAlias, resolveSubagentModel } from '../agentTool';
import { ModelError } from '../modelErrors';

function makeSettings(overrides: {
  apiKey?: string | null;
  model?: string;
  thinkingModel?: string;
  behindTheScenesModel?: string;
  workingProfileId?: string | null;
  thinkingProfileId?: string | null;
  profiles?: Array<{
    id: string;
    name: string;
    providerType?: 'openai' | 'google' | 'together' | 'cerebras' | 'other';
    serverUrl: string;
    apiKey?: string;
    model?: string;
  }>;
} = {}): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: { enabled: false },
    models: {
      apiKey: overrides.apiKey ?? 'fake-ant-test',
      oauthToken: null,
      authMethod: 'api-key',
      model: overrides.model ?? 'claude-sonnet-4-20250514',
      permissionMode: 'plan',
      executablePath: null,
      planMode: true,
      extendedContext: false,
      thinkingModel: overrides.thinkingModel ?? 'claude-opus-4-7',
      workingProfileId: overrides.workingProfileId ?? null,
      thinkingProfileId: overrides.thinkingProfileId ?? null,
    },
    behindTheScenesModel: overrides.behindTheScenesModel ?? 'claude-haiku-4-20250414',
    diagnostics: { enabled: false },
    localModel: {
      profiles: (overrides.profiles ?? []).map((p) => ({
        ...p,
        createdAt: Date.now(),
      })),
      activeProfileId: null,
    },
  } as unknown as AppSettings;
}

describe('cross-provider sub-agent alias resolution', () => {
  describe('main agent with GPT-5.5, sub-agent requests "sonnet"', () => {
    it('resolves "sonnet" to working profile model (GPT-5.5)', () => {
      const settings = makeSettings({
        workingProfileId: 'openai-gpt55',
        profiles: [
          {
            id: 'openai-gpt55',
            name: 'GPT-5.5',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            apiKey: 'fake-openai-key',
            model: unsafeAssertRoutingModelId('gpt-5.5'),
          },
        ],
      });

      const resolved = resolveModelAlias('sonnet', settings);
      expect(resolved).toBe('gpt-5.5');
    });
  });

  describe('no profile configured -> uses explicit settings strings', () => {
    it('resolves "sonnet" to configured working model when no working profile is set', () => {
      const settings = makeSettings();
      const resolved = resolveModelAlias('sonnet', settings);
      expect(resolved).toBe('claude-sonnet-4-20250514');
    });

    it('resolves "opus" to configured thinking model when no thinking profile is set', () => {
      const settings = makeSettings();
      const resolved = resolveModelAlias('opus', settings);
      expect(resolved).toBe('claude-opus-4-7');
    });

    it('resolves "haiku" to configured fast model when no fast profile is set', () => {
      const settings = makeSettings();
      const resolved = resolveModelAlias('haiku', settings);
      expect(resolved).toBe('claude-haiku-4-20250414');
    });
  });

  describe('"inherit" resolves to parent model', () => {
    it('resolves "inherit" to the parent model', () => {
      const settings = makeSettings();
      const resolved = resolveSubagentModel('inherit', unsafeAssertRoutingModelId('gpt-5.5'), settings);
      expect(resolved).toBe('gpt-5.5');
    });

    it('resolves undefined to the parent model', () => {
      const settings = makeSettings();
      const resolved = resolveSubagentModel(undefined, unsafeAssertRoutingModelId('gpt-5.5'), settings);
      expect(resolved).toBe('gpt-5.5');
    });
  });

  describe('thinking tier resolution', () => {
    it('resolves "opus" to thinking profile model when profile is set', () => {
      const settings = makeSettings({
        thinkingProfileId: 'openai-o4',
        profiles: [
          {
            id: 'openai-o4',
            name: 'o4-mini',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            apiKey: 'fake-openai',
            model: unsafeAssertRoutingModelId('o4-mini'),
          },
        ],
      });

      const resolved = resolveModelAlias('opus', settings);
      expect(resolved).toBe('o4-mini');
    });

    it('falls back to claude.thinkingModel when no thinking profile', () => {
      const settings = makeSettings({
        thinkingModel: 'claude-opus-4-20250514',
      });

      const resolved = resolveModelAlias('opus', settings);
      expect(resolved).toBe('claude-opus-4-20250514');
    });
  });

  describe('background tier resolution', () => {
    it('resolves "haiku" to configured behindTheScenesModel', () => {
      const settings = makeSettings({
        behindTheScenesModel: 'gpt-4o-mini',
      });

      const resolved = resolveModelAlias('haiku', settings);
      expect(resolved).toBe('gpt-4o-mini');
    });

    it('haiku resolves via profile: prefix to local model profile', () => {
      const settings = makeSettings({
        behindTheScenesModel: 'profile:local-llama',
        profiles: [
          {
            id: 'local-llama',
            name: 'Local Llama',
            providerType: 'other',
            serverUrl: 'http://localhost:11434/v1',
            model: unsafeAssertRoutingModelId('llama-3.1-70b'),
          },
        ],
      });

      const resolved = resolveModelAlias('haiku', settings);
      expect(resolved).toBe('llama-3.1-70b');
    });

    it('haiku throws when a profile reference points to a missing profile', () => {
      const settings = makeSettings({
        behindTheScenesModel: 'profile:nonexistent',
      });

      expect(() => resolveModelAlias('haiku', settings)).toThrow(ModelError);
    });

    it('haiku falls back to DEFAULT_AUXILIARY_MODEL when no fast model is configured (legacy-settings recovery)', () => {
      const settings = makeSettings({
        behindTheScenesModel: '',
      });

      expect(resolveModelAlias('haiku', settings)).toBe('claude-haiku-4-5');
    });
  });

  describe('unknown aliases pass through', () => {
    it('returns the alias as-is if not a recognized tier', () => {
      const settings = makeSettings();
      const resolved = resolveModelAlias('llama-3.1-70b', settings);
      expect(resolved).toBe('llama-3.1-70b');
    });
  });

  describe('semantic tier names — primary aliases', () => {
    it('resolves "thinking" to Claude Opus with default settings', () => {
      const settings = makeSettings();
      expect(resolveModelAlias('thinking', settings)).toBe('claude-opus-4-7');
    });

    it('resolves "working" to Claude Sonnet with default settings', () => {
      const settings = makeSettings();
      expect(resolveModelAlias('working', settings)).toBe('claude-sonnet-4-20250514');
    });

    it('resolves "fast" to Claude Haiku with default settings', () => {
      const settings = makeSettings();
      expect(resolveModelAlias('fast', settings)).toBe('claude-haiku-4-20250414');
    });

    it('resolves "thinking" to thinking profile model when profile is set', () => {
      const settings = makeSettings({
        thinkingProfileId: 'openai-o4',
        profiles: [
          {
            id: 'openai-o4',
            name: 'o4-mini',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            apiKey: 'fake-openai',
            model: unsafeAssertRoutingModelId('o4-mini'),
          },
        ],
      });

      expect(resolveModelAlias('thinking', settings)).toBe('o4-mini');
    });

    it('resolves "working" to working profile model when profile is set', () => {
      const settings = makeSettings({
        workingProfileId: 'openai-gpt55',
        profiles: [
          {
            id: 'openai-gpt55',
            name: 'GPT-5.5',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            apiKey: 'fake-openai-key',
            model: unsafeAssertRoutingModelId('gpt-5.5'),
          },
        ],
      });

      expect(resolveModelAlias('working', settings)).toBe('gpt-5.5');
    });

    it('resolves "fast" to configured behindTheScenesModel', () => {
      const settings = makeSettings({
        behindTheScenesModel: 'gpt-4o-mini',
      });

      expect(resolveModelAlias('fast', settings)).toBe('gpt-4o-mini');
    });

    it('"fast" resolves via profile: prefix to local model profile', () => {
      const settings = makeSettings({
        behindTheScenesModel: 'profile:local-llama',
        profiles: [
          {
            id: 'local-llama',
            name: 'Local Llama',
            providerType: 'other',
            serverUrl: 'http://localhost:11434/v1',
            model: unsafeAssertRoutingModelId('llama-3.1-70b'),
          },
        ],
      });

      expect(resolveModelAlias('fast', settings)).toBe('llama-3.1-70b');
    });

    it('resolveSubagentModel maps semantic aliases to full model names', () => {
      const settings = makeSettings({
        model: unsafeAssertRoutingModelId('claude-sonnet-4-6'),
        thinkingModel: 'claude-opus-4-7',
        behindTheScenesModel: 'claude-haiku-4-5',
      });
      expect(resolveSubagentModel('thinking', unsafeAssertRoutingModelId('parent-model'), settings)).toBe('claude-opus-4-7');
      expect(resolveSubagentModel('working', unsafeAssertRoutingModelId('parent-model'), settings)).toBe('claude-sonnet-4-6');
      expect(resolveSubagentModel('fast', unsafeAssertRoutingModelId('parent-model'), settings)).toBe('claude-haiku-4-5');
    });
  });

  describe('old and new names resolve to the same models', () => {
    it('thinking === opus with default settings', () => {
      const settings = makeSettings();
      expect(resolveModelAlias('thinking', settings)).toBe(resolveModelAlias('opus', settings));
    });

    it('working === sonnet with default settings', () => {
      const settings = makeSettings();
      expect(resolveModelAlias('working', settings)).toBe(resolveModelAlias('sonnet', settings));
    });

    it('fast === haiku with default settings', () => {
      const settings = makeSettings();
      expect(resolveModelAlias('fast', settings)).toBe(resolveModelAlias('haiku', settings));
    });

    it('thinking === opus with custom profiles', () => {
      const settings = makeSettings({
        thinkingProfileId: 'openai-o4',
        profiles: [
          {
            id: 'openai-o4',
            name: 'o4-mini',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            apiKey: 'fake-openai',
            model: unsafeAssertRoutingModelId('o4-mini'),
          },
        ],
      });
      expect(resolveModelAlias('thinking', settings)).toBe(resolveModelAlias('opus', settings));
    });

    it('working === sonnet with custom profiles', () => {
      const settings = makeSettings({
        workingProfileId: 'openai-gpt55',
        profiles: [
          {
            id: 'openai-gpt55',
            name: 'GPT-5.5',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            apiKey: 'fake-openai-key',
            model: unsafeAssertRoutingModelId('gpt-5.5'),
          },
        ],
      });
      expect(resolveModelAlias('working', settings)).toBe(resolveModelAlias('sonnet', settings));
    });

    it('fast === haiku with custom BTS model', () => {
      const settings = makeSettings({
        behindTheScenesModel: 'gpt-4o-mini',
      });
      expect(resolveModelAlias('fast', settings)).toBe(resolveModelAlias('haiku', settings));
    });
  });

  describe('Claude @-mention subagent alias resolution', () => {
    // Claude @-mention subagents (Stage 5) use Anthropic SDK aliases: 'haiku', 'sonnet', 'opus'.
    // When Rebel Core processes these, resolveModelAlias must resolve them to actual
    // Claude model names for direct API calls (no subprocess to handle aliases).

    it('resolves "haiku" to Claude Haiku with default settings', () => {
      const settings = makeSettings();
      const resolved = resolveModelAlias('haiku', settings);
      expect(resolved).toBe('claude-haiku-4-20250414');
    });

    it('resolves "sonnet" to Claude Sonnet with default settings', () => {
      const settings = makeSettings();
      const resolved = resolveModelAlias('sonnet', settings);
      expect(resolved).toBe('claude-sonnet-4-20250514');
    });

    it('resolves "opus" to Claude Opus with default settings', () => {
      const settings = makeSettings();
      const resolved = resolveModelAlias('opus', settings);
      expect(resolved).toBe('claude-opus-4-7');
    });

    it('resolves aliases to configured Claude models when explicitly set', () => {
      const settings = makeSettings({
        model: unsafeAssertRoutingModelId('claude-sonnet-4-6'),
        thinkingModel: 'claude-opus-4-7',
        behindTheScenesModel: 'claude-haiku-4-5',
      });
      expect(resolveModelAlias('haiku', settings)).toBe('claude-haiku-4-5');
      expect(resolveModelAlias('sonnet', settings)).toBe('claude-sonnet-4-6');
      expect(resolveModelAlias('opus', settings)).toBe('claude-opus-4-7');
    });

    it('passes through full Claude model names unchanged', () => {
      const settings = makeSettings();
      // Full model names are not recognized aliases — they pass through as-is.
      // This ensures Rebel Core can use direct model names for API calls.
      expect(resolveModelAlias('claude-haiku-4-5', settings)).toBe('claude-haiku-4-5');
      expect(resolveModelAlias('claude-sonnet-4-6', settings)).toBe('claude-sonnet-4-6');
      expect(resolveModelAlias('claude-opus-4-7', settings)).toBe('claude-opus-4-7');
    });

    it('resolveSubagentModel maps Claude alias to full model name', () => {
      const settings = makeSettings({
        model: unsafeAssertRoutingModelId('claude-sonnet-4-6'),
        thinkingModel: 'claude-opus-4-7',
        behindTheScenesModel: 'claude-haiku-4-5',
      });
      // End-to-end: resolveSubagentModel → resolveModelAlias → full Claude model name
      expect(resolveSubagentModel('haiku', unsafeAssertRoutingModelId('parent-model'), settings)).toBe('claude-haiku-4-5');
      expect(resolveSubagentModel('sonnet', unsafeAssertRoutingModelId('parent-model'), settings)).toBe('claude-sonnet-4-6');
      expect(resolveSubagentModel('opus', unsafeAssertRoutingModelId('parent-model'), settings)).toBe('claude-opus-4-7');
    });
  });
});
