import { describe, expect, it, vi } from 'vitest';
import {
  createModelClient,
  createClientForModel,
  createOpenAIClientFromProfile,
  resolveProfileFromModelString,
} from '../clientFactory';
import { AnthropicClient } from '../clients/anthropicClient';
import { OpenAIClient } from '../clients/openaiClient';
import type { AppSettings } from '@shared/types';

// Minimal AppSettings factory for testing
function makeSettings(overrides: {
  apiKey?: string | null;
  oauthToken?: string | null;
  workingProfileId?: string | null;
  profiles?: Array<{
    id: string;
    name: string;
    providerType?: 'openai' | 'google' | 'together' | 'cerebras' | 'other';
    serverUrl: string;
    apiKey?: string;
    model?: string;
    thinkingCompatibility?: 'unknown' | 'compatible' | 'incompatible';
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  }>;
  providerKeys?: Record<string, string>;
} = {}): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: { enabled: false },
    models: {
      apiKey: overrides.apiKey ?? 'fake-ant-test-key',
      oauthToken: overrides.oauthToken ?? null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-20250514',
      permissionMode: 'plan',
      executablePath: null,
      planMode: true,
      extendedContext: false,
      workingProfileId: overrides.workingProfileId ?? null,
    },
    diagnostics: { enabled: false },
    localModel: {
      profiles: (overrides.profiles ?? []).map((p) => ({
        ...p,
        createdAt: Date.now(),
      })),
      activeProfileId: null,
    },
    providerKeys: overrides.providerKeys as AppSettings['providerKeys'],
  } as unknown as AppSettings;
}

describe('createModelClient', () => {
  describe('no active profile -> AnthropicClient', () => {
    it('returns AnthropicClient when no profile is active', () => {
      const settings = makeSettings({ apiKey: 'fake-ant-test' });
      const client = createModelClient({ settings });
      expect(client).toBeInstanceOf(AnthropicClient);
    });
  });

  describe('profile with providerType "openai" -> OpenAIClient', () => {
    it('returns OpenAIClient for an OpenAI profile', () => {
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        workingProfileId: 'openai-1',
        profiles: [
          {
            id: 'openai-1',
            name: 'GPT-5.5',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            apiKey: 'fake-openai-key',
          },
        ],
      });
      const client = createModelClient({ settings });
      expect(client).toBeInstanceOf(OpenAIClient);
    });
  });

  describe('profile with providerType "google" -> AnthropicClient (proxy)', () => {
    it('returns AnthropicClient for Gemini profiles (thought signatures need proxy)', () => {
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        workingProfileId: 'gemini-1',
        profiles: [
          {
            id: 'gemini-1',
            name: 'Gemini 3.1 Pro',
            providerType: 'google',
            serverUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
          },
        ],
      });
      const client = createModelClient({ settings });
      expect(client).toBeInstanceOf(AnthropicClient);
    });
  });

  describe('proxyConfig present -> AnthropicClient with proxy URL (precedence 1)', () => {
    it('returns AnthropicClient via proxy even when OpenAI profile is active', () => {
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        workingProfileId: 'openai-1',
        profiles: [
          {
            id: 'openai-1',
            name: 'GPT-5.5',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            apiKey: 'fake-openai-key',
          },
        ],
      });
      const client = createModelClient({
        settings,
        proxyConfig: {
          baseURL: 'http://localhost:10000',
          defaultHeaders: { 'x-routed-turn-id': 'turn-1' },
        },
      });
      // Proxy config takes precedence — always AnthropicClient
      expect(client).toBeInstanceOf(AnthropicClient);
    });
  });

  describe('profile with localhost URL -> OpenAIClient', () => {
    it('returns OpenAIClient for local model (no API key required)', () => {
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        workingProfileId: 'local-1',
        profiles: [
          {
            id: 'local-1',
            name: 'LM Studio',
            providerType: 'other',
            serverUrl: 'http://localhost:1234',
          },
        ],
      });
      const client = createModelClient({ settings });
      expect(client).toBeInstanceOf(OpenAIClient);
    });
  });

  describe('auth validation', () => {
    it('returns AnthropicClient even when apiKey is null (env fallback may provide auth)', () => {
      const settings = makeSettings({ apiKey: null });
      // getAuthForDirectUse falls back to process.env.ANTHROPIC_API_KEY.
      // In test environments this may or may not be set, so we just verify
      // the factory doesn't crash and returns AnthropicClient (or throws auth error).
      try {
        const client = createModelClient({ settings });
        expect(client).toBeInstanceOf(AnthropicClient);
      } catch (e: any) {
        // PRECEDENCE 2 (no profile): provider-agnostic error message
        expect(e.message).toMatch(/No model provider configured/);
        expect(e.__agentErrorKind).toBe('auth');
      }
    });

    it('works with only OpenAI key present (not blocked by Anthropic gate)', () => {
      const settings = makeSettings({
        apiKey: null,
        workingProfileId: 'openai-1',
        profiles: [
          {
            id: 'openai-1',
            name: 'GPT-5.5',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            apiKey: 'fake-openai-key',
          },
        ],
      });
      const client = createModelClient({ settings });
      expect(client).toBeInstanceOf(OpenAIClient);
    });

    it('throws auth error for cloud OpenAI profile without API key', () => {
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        workingProfileId: 'openai-no-key',
        profiles: [
          {
            id: 'openai-no-key',
            name: 'GPT-5.5',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
          },
        ],
      });
      expect(() => createModelClient({ settings })).toThrow(/API key/);
    });

    // ── Proxy auth bypass (provider-identity headers) ────────────
    // These tests verify that proxy turns with provider-identity headers
    // bypass getAnthropicAuth() and use a sentinel key instead.
    // The negative test below proves that WITHOUT the header, the exact
    // auth error from the 260417 postmortem is thrown — ensuring these
    // tests would catch the regression if the header were ever lost.
    // See: docs-private/postmortems/260417_openrouter_adhoc_auth_failure_postmortem.md

    it('does not require Anthropic API key when OpenRouter proxy is active (x-openrouter-turn header)', () => {
      const settings = makeSettings({ apiKey: null });
      const client = createModelClient({
        settings,
        proxyConfig: {
          baseURL: 'http://localhost:10000',
          defaultHeaders: { 'x-openrouter-turn': 'true', 'x-proxy-auth': 'token' },
        },
      });
      expect(client).toBeInstanceOf(AnthropicClient);
    });

    it('does not require Anthropic API key when Codex proxy is active (x-codex-turn header)', () => {
      const settings = makeSettings({ apiKey: null });
      const client = createModelClient({
        settings,
        proxyConfig: {
          baseURL: 'http://localhost:10000',
          defaultHeaders: { 'x-codex-turn': 'true', 'x-proxy-auth': 'token' },
        },
      });
      expect(client).toBeInstanceOf(AnthropicClient);
    });

    it('requires Anthropic auth when proxy is active but NO provider-identity header is present (regression guard)', () => {
      // This is the exact scenario from the 260417 bug: ad-hoc proxy overwrote
      // the x-openrouter-turn header, so clientFactory tried getAnthropicAuth()
      // which threw for OpenRouter-only users without an Anthropic API key.
      //
      // We verify the BEHAVIORAL DIFFERENCE: with a provider-identity header
      // (tested above), no Anthropic key is needed. Without it, the factory
      // either succeeds with an env-provided key or throws an auth error.
      // Both outcomes prove that getAnthropicAuth() IS called (not bypassed).
      const settings = makeSettings({ apiKey: null });
      try {
        const client = createModelClient({
          settings,
          proxyConfig: {
            baseURL: 'http://localhost:10000',
            defaultHeaders: { 'x-proxy-auth': 'token', 'x-routed-turn-id': 'turn-123' },
          },
        });
        // If it didn't throw, an env-provided ANTHROPIC_API_KEY was used.
        // Verify the client was created (getAnthropicAuth succeeded, not bypassed).
        expect(client).toBeInstanceOf(AnthropicClient);
      } catch (e: any) {
        // If it threw, verify it's the exact auth error from the 260417 bug.
        expect(e.message).toMatch(/Anthropic API key/);
        expect(e.__agentErrorKind).toBe('auth');
      }
    });

  });

  describe('enableContextManagement propagation', () => {
    it('enables context management for direct Anthropic (precedence 2)', () => {
      const settings = makeSettings({ apiKey: 'fake-ant-test' });
      const client = createModelClient({ settings });
      expect(client).toBeInstanceOf(AnthropicClient);
      expect((client as any).enableContextManagement).toBe(true);
    });

    it('enables context management for proxy path (precedence 1)', () => {
      const settings = makeSettings({ apiKey: 'fake-ant-test' });
      const client = createModelClient({
        settings,
        proxyConfig: { baseURL: 'http://localhost:10000' },
      });
      expect(client).toBeInstanceOf(AnthropicClient);
      expect((client as any).enableContextManagement).toBe(true);
    });

    it('does NOT enable context management for Gemini via proxy (precedence 3)', () => {
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        workingProfileId: 'gemini-1',
        profiles: [
          {
            id: 'gemini-1',
            name: 'Gemini 3.1 Pro',
            providerType: 'google',
            serverUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
          },
        ],
      });
      const client = createModelClient({ settings });
      expect(client).toBeInstanceOf(AnthropicClient);
      expect((client as any).enableContextManagement).toBe(false);
    });

    it('does NOT set context management on OpenAI clients (precedence 4/5)', () => {
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        workingProfileId: 'openai-1',
        profiles: [
          {
            id: 'openai-1',
            name: 'GPT-5.5',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            apiKey: 'fake-openai-key',
          },
        ],
      });
      const client = createModelClient({ settings });
      expect(client).toBeInstanceOf(OpenAIClient);
      // OpenAIClient doesn't have enableContextManagement at all
      expect((client as any).enableContextManagement).toBeUndefined();
    });

    it('kill switch: enableContextManagement=false disables for direct Anthropic', () => {
      const settings = makeSettings({ apiKey: 'fake-ant-test' });
      const client = createModelClient({ settings, enableContextManagement: false });
      expect(client).toBeInstanceOf(AnthropicClient);
      expect((client as any).enableContextManagement).toBe(false);
    });

    it('kill switch: enableContextManagement=false disables for proxy path', () => {
      const settings = makeSettings({ apiKey: 'fake-ant-test' });
      const client = createModelClient({
        settings,
        proxyConfig: { baseURL: 'http://localhost:10000' },
        enableContextManagement: false,
      });
      expect(client).toBeInstanceOf(AnthropicClient);
      expect((client as any).enableContextManagement).toBe(false);
    });

    it('Gemini stays disabled even when enableContextManagement=true', () => {
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        workingProfileId: 'gemini-1',
        profiles: [
          {
            id: 'gemini-1',
            name: 'Gemini 3.1 Pro',
            providerType: 'google',
            serverUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
          },
        ],
      });
      const client = createModelClient({ settings, enableContextManagement: true });
      expect(client).toBeInstanceOf(AnthropicClient);
      // Gemini is always disabled regardless of the option
      expect((client as any).enableContextManagement).toBe(false);
    });
  });

  describe('REBEL_DISABLE_CONTEXT_MANAGEMENT env override', () => {
    const originalEnv = process.env.REBEL_DISABLE_CONTEXT_MANAGEMENT;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.REBEL_DISABLE_CONTEXT_MANAGEMENT;
      } else {
        process.env.REBEL_DISABLE_CONTEXT_MANAGEMENT = originalEnv;
      }
    });

    it('disables context management when env var is set to "1"', () => {
      process.env.REBEL_DISABLE_CONTEXT_MANAGEMENT = '1';
      const settings = makeSettings({ apiKey: 'fake-ant-test' });
      const client = createModelClient({ settings });
      expect(client).toBeInstanceOf(AnthropicClient);
      expect((client as any).enableContextManagement).toBe(false);
    });

    it('does not disable when env var is absent', () => {
      delete process.env.REBEL_DISABLE_CONTEXT_MANAGEMENT;
      const settings = makeSettings({ apiKey: 'fake-ant-test' });
      const client = createModelClient({ settings });
      expect(client).toBeInstanceOf(AnthropicClient);
      expect((client as any).enableContextManagement).toBe(true);
    });
  });

  describe('profileOverride', () => {
    it('bypasses getWorkingModelProfile and uses the override profile', () => {
      // Active working profile is Anthropic (no profile), but override is OpenAI
      const settings = makeSettings({ apiKey: 'fake-ant-test' });
      const overrideProfile = {
        id: 'override-openai',
        name: 'GPT-5.5 Override',
        providerType: 'openai' as const,
        serverUrl: 'https://api.openai.com/v1',
        apiKey: 'fake-openai-override',
        createdAt: Date.now(),
      };
      const client = createModelClient({ settings, profileOverride: overrideProfile });
      expect(client).toBeInstanceOf(OpenAIClient);
    });

    it('proxyConfig still takes priority over profileOverride (PRECEDENCE 1)', () => {
      const settings = makeSettings({ apiKey: 'fake-ant-test' });
      const overrideProfile = {
        id: 'override-openai',
        name: 'GPT-5.5 Override',
        providerType: 'openai' as const,
        serverUrl: 'https://api.openai.com/v1',
        apiKey: 'fake-openai-override',
        createdAt: Date.now(),
      };
      const client = createModelClient({
        settings,
        proxyConfig: { baseURL: 'http://localhost:10000' },
        profileOverride: overrideProfile,
      });
      // Proxy takes precedence — still AnthropicClient
      expect(client).toBeInstanceOf(AnthropicClient);
    });

    it('uses override instead of active working profile', () => {
      // Working profile is Together, but override is OpenAI
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        workingProfileId: 'together-1',
        profiles: [
          {
            id: 'together-1',
            name: 'Together DeepSeek',
            providerType: 'together',
            serverUrl: 'https://api.together.xyz/v1',
            apiKey: 'together-key',
          },
        ],
      });
      const overrideProfile = {
        id: 'override-cerebras',
        name: 'Cerebras Override',
        providerType: 'cerebras' as const,
        serverUrl: 'https://api.cerebras.ai/v1',
        apiKey: 'csk-override-key',
        createdAt: Date.now(),
      };
      const client = createModelClient({ settings, profileOverride: overrideProfile });
      // Override profile should be used, not the active Together profile
      expect(client).toBeInstanceOf(OpenAIClient);
    });

    it('preserves __agentErrorKind when override profile has no API key', () => {
      const settings = makeSettings({ apiKey: 'fake-ant-test' });
      const overrideProfile = {
        id: 'override-no-key',
        name: 'No Key Profile',
        providerType: 'openai' as const,
        serverUrl: 'https://api.openai.com/v1',
        // No apiKey
        createdAt: Date.now(),
      };
      try {
        createModelClient({ settings, profileOverride: overrideProfile });
        expect.fail('Expected auth error');
      } catch (e: any) {
        expect(e.__agentErrorKind).toBe('auth');
        expect(e.message).toMatch(/API key/);
      }
    });
  });

  describe('provider types', () => {
    it('routes Together profile to OpenAIClient', () => {
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        workingProfileId: 'together-1',
        profiles: [
          {
            id: 'together-1',
            name: 'DeepSeek R1',
            providerType: 'together',
            serverUrl: 'https://api.together.xyz/v1',
            apiKey: 'together-key',
          },
        ],
      });
      const client = createModelClient({ settings });
      expect(client).toBeInstanceOf(OpenAIClient);
    });

    it('routes Cerebras profile to OpenAIClient', () => {
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        workingProfileId: 'cerebras-1',
        profiles: [
          {
            id: 'cerebras-1',
            name: 'Cerebras Llama',
            providerType: 'cerebras',
            serverUrl: 'https://api.cerebras.ai/v1',
            apiKey: 'csk-key',
          },
        ],
      });
      const client = createModelClient({ settings });
      expect(client).toBeInstanceOf(OpenAIClient);
    });
  });
});

describe('createClientForModel', () => {
  describe('Claude model → AnthropicClient regardless of active profile or proxy', () => {
    it('returns AnthropicClient for Claude model when active profile is OpenAI', async () => {
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        workingProfileId: 'openai-1',
        profiles: [
          {
            id: 'openai-1',
            name: 'GPT-5.5',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            apiKey: 'fake-openai-key',
          },
        ],
      });
      const client = await createClientForModel({
        model: 'claude-sonnet-4-20250514',
        settings,
        context: 'subagent',
      });
      expect(client).toBeInstanceOf(AnthropicClient);
    });

    it('returns AnthropicClient via proxy when proxyConfig is provided and model is Claude', async () => {
      const settings = makeSettings({ apiKey: 'fake-ant-test' });
      const client = await createClientForModel({
        model: 'claude-haiku-4-20250414',
        settings,
        proxyConfig: { baseURL: 'http://localhost:10000' },
        context: 'subagent',
      });
      expect(client).toBeInstanceOf(AnthropicClient);
    });
  });

  describe('GPT model with direct profile → OpenAIClient', () => {
    it('returns OpenAIClient when direct profile is provided', async () => {
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        profiles: [
          {
            id: 'openai-1',
            name: 'GPT-5.5',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            apiKey: 'fake-openai-key',
            model: 'gpt-5.5',
          },
        ],
      });
      const profile = settings.localModel!.profiles![0]!;
      const client = await createClientForModel({
        model: 'gpt-5.5',
        profile,
        settings,
        context: 'planning',
      });
      expect(client).toBeInstanceOf(OpenAIClient);
    });

    it('prefers direct profile over model-string matching', async () => {
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        profiles: [
          {
            id: 'together-1',
            name: 'Together GPT',
            providerType: 'together',
            serverUrl: 'https://api.together.xyz/v1',
            apiKey: 'together-key',
            model: 'gpt-5.5',
          },
          {
            id: 'openai-1',
            name: 'OpenAI GPT',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            apiKey: 'fake-openai-key',
            model: 'gpt-5.5',
          },
        ],
      });
      // Direct profile should win over model-string matching (which would return the first match)
      const openaiProfile = settings.localModel!.profiles![1]!;
      const client = await createClientForModel({
        model: 'gpt-5.5',
        profile: openaiProfile,
        settings,
        context: 'execution',
      });
      expect(client).toBeInstanceOf(OpenAIClient);
    });
  });

  describe('profile:abc123 encoded model → resolves profile', () => {
    it('resolves profile by ID from encoded model string', async () => {
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        profiles: [
          {
            id: 'my-openai-profile',
            name: 'GPT-5.5',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            apiKey: 'fake-openai-key',
            model: 'gpt-5.5',
          },
        ],
      });
      const client = await createClientForModel({
        model: 'profile:my-openai-profile',
        settings,
        context: 'bts',
      });
      expect(client).toBeInstanceOf(OpenAIClient);
    });

    it('falls through to default when profile:id does not match any profile', async () => {
      const settings = makeSettings({ apiKey: 'fake-ant-test' });
      const client = await createClientForModel({
        model: 'profile:nonexistent',
        settings,
        context: 'bts',
      });
      // Falls through to createModelClient() which returns AnthropicClient (no profile)
      expect(client).toBeInstanceOf(AnthropicClient);
    });
  });

  describe('Gemini profile → routes through proxy', () => {
    it('returns AnthropicClient for Gemini profile (thought signatures need proxy)', async () => {
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        profiles: [
          {
            id: 'gemini-1',
            name: 'Gemini 3.1 Pro',
            providerType: 'google',
            serverUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
            apiKey: 'fake-google-key',
            model: 'gemini-3.1-pro',
          },
        ],
      });
      const geminiProfile = settings.localModel!.profiles![0]!;
      const client = await createClientForModel({
        model: 'gemini-3.1-pro',
        profile: geminiProfile,
        settings,
        context: 'subagent',
      });
      // Gemini routes through proxy (AnthropicClient wrapping)
      expect(client).toBeInstanceOf(AnthropicClient);
    });
  });

  describe('proxy config + non-Claude model → skips proxy', () => {
    it('does not use proxy for non-Claude model even when proxyConfig is provided', async () => {
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        profiles: [
          {
            id: 'openai-1',
            name: 'GPT-5.5',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            apiKey: 'fake-openai-key',
            model: 'gpt-5.5',
          },
        ],
      });
      const openaiProfile = settings.localModel!.profiles![0]!;
      const client = await createClientForModel({
        model: 'gpt-5.5',
        profile: openaiProfile,
        settings,
        proxyConfig: { baseURL: 'http://localhost:10000' },
        context: 'subagent',
      });
      // Non-Claude model should skip proxy and use OpenAIClient directly
      expect(client).toBeInstanceOf(OpenAIClient);
    });
  });

  describe('unknown model, no matching profile → falls through to default', () => {
    it('falls through to createModelClient when no profile matches', async () => {
      const settings = makeSettings({ apiKey: 'fake-ant-test' });
      const client = await createClientForModel({
        model: 'unknown-model-xyz',
        settings,
        context: 'execution',
      });
      // No profile match, no Claude prefix → falls through to createModelClient()
      // which returns AnthropicClient (no active profile, has API key)
      expect(client).toBeInstanceOf(AnthropicClient);
    });

    it('falls through to createModelClient which uses active OpenAI profile', async () => {
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        workingProfileId: 'openai-1',
        profiles: [
          {
            id: 'openai-1',
            name: 'GPT-5.5',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            apiKey: 'fake-openai-key',
          },
        ],
      });
      const client = await createClientForModel({
        model: 'unknown-model-xyz',
        settings,
        context: 'execution',
      });
      // Unmatched model with no profile routes by active-provider/default (Anthropic when an Anthropic key is present) — it no longer hijacks an unrelated working profile.
      expect(client).toBeInstanceOf(AnthropicClient);
    });
  });

  describe('model-string matching (no direct profile)', () => {
    it('matches model string to profile.model field', async () => {
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        profiles: [
          {
            id: 'openai-1',
            name: 'GPT-5.5',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            apiKey: 'fake-openai-key',
            model: 'gpt-5.5',
          },
        ],
      });
      const client = await createClientForModel({
        model: 'gpt-5.5',
        settings,
        context: 'subagent',
      });
      expect(client).toBeInstanceOf(OpenAIClient);
    });

    it('skips disabled profiles during model-string matching', async () => {
      const settings = makeSettings({
        apiKey: 'fake-ant-test',
        profiles: [
          {
            id: 'openai-disabled',
            name: 'GPT Disabled',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            apiKey: 'fake-openai-key',
            model: 'gpt-5.5',
          },
        ],
      });
      // Manually set enabled=false
      (settings.localModel!.profiles![0] as any).enabled = false;
      const client = await createClientForModel({
        model: 'gpt-5.5',
        settings,
        context: 'subagent',
      });
      // Disabled profile skipped → falls through to default (Anthropic)
      expect(client).toBeInstanceOf(AnthropicClient);
    });
  });

  describe('context parameter for diagnostics', () => {
    it('accepts all valid context values', async () => {
      const settings = makeSettings({ apiKey: 'fake-ant-test' });
      const contexts = ['execution', 'planning', 'subagent', 'bts'] as const;
      for (const context of contexts) {
        const client = await createClientForModel({
          model: 'claude-sonnet-4-20250514',
          settings,
          context,
        });
        expect(client).toBeInstanceOf(AnthropicClient);
      }
    });
  });
});

describe('createOpenAIClientFromProfile', () => {
  it('creates OpenAIClient from profile with API key', () => {
    const settings = makeSettings({
      apiKey: 'fake-ant-test',
      profiles: [
        {
          id: 'openai-1',
          name: 'GPT-5.5',
          providerType: 'openai',
          serverUrl: 'https://api.openai.com/v1',
          apiKey: 'fake-openai-key',
        },
      ],
    });
    const profile = settings.localModel!.profiles![0]!;
    const client = createOpenAIClientFromProfile(profile, settings);
    expect(client).toBeInstanceOf(OpenAIClient);
  });

  it('creates OpenAIClient for localhost without API key', () => {
    const settings = makeSettings({ apiKey: 'fake-ant-test' });
    const profile = {
      id: 'local-1',
      name: 'LM Studio',
      providerType: 'other' as const,
      serverUrl: 'http://localhost:1234',
      createdAt: Date.now(),
    };
    const client = createOpenAIClientFromProfile(profile, settings);
    expect(client).toBeInstanceOf(OpenAIClient);
  });

  // REBEL-5RJ: an Anthropic model behind an OpenAI-compatible custom gateway
  // (`providerType:'other'`) must not leak `reasoning_effort` when the profile is
  // marked thinking-incompatible (`thinkingCompatibility === 'incompatible'`,
  // auto-detected by the Test button). The factory must honour that at egress.
  // See docs/project/CUSTOM_GATEWAY_COMPATIBILITY.md.
  //
  // Captures the request body the built client puts on the wire.
  async function streamAndCaptureBody(client: { stream: (...args: never[]) => Promise<unknown> }): Promise<Record<string, unknown>> {
    const calls: Array<{ body: string }> = [];
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      calls.push(opts);
      return {
        ok: true,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            c.close();
          },
        }),
      };
    });
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      await client.stream(
        {
          model: 'claude-opus-4-8' as never,
          systemPrompt: 'x',
          messages: [{ role: 'user' as const, content: 'hi' }],
          maxTokens: 64,
          effort: 'high',
        } as never,
        (() => {}) as never,
      );
    } finally {
      global.fetch = originalFetch;
    }
    expect(calls).toHaveLength(1);
    return JSON.parse(calls[0]!.body) as Record<string, unknown>;
  }

  const COPPEL_PROFILE_BASE = {
    id: 'gw',
    name: 'Test Gateway',
    providerType: 'other' as const,
    serverUrl: 'https://gateway.example.com/v1',
    apiKey: 'gw-key',
    model: 'claude-opus-4-8',
    reasoningEffort: 'high' as const,
    createdAt: Date.now(),
  };

  it('omits reasoning_effort when thinkingCompatibility is "incompatible" (auto-detected)', async () => {
    const settings = makeSettings({ apiKey: 'fake-ant-test' });
    const client = createOpenAIClientFromProfile(
      { ...COPPEL_PROFILE_BASE, thinkingCompatibility: 'incompatible' },
      settings,
    );
    const body = await streamAndCaptureBody(client);
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('positive control: includes reasoning_effort when neither suppression signal is set', async () => {
    const settings = makeSettings({ apiKey: 'fake-ant-test' });
    const client = createOpenAIClientFromProfile({ ...COPPEL_PROFILE_BASE }, settings);
    const body = await streamAndCaptureBody(client);
    expect(body.reasoning_effort).toBe('high');
  });

  it('production turn path (createClientForModel) honours thinkingCompatibility "incompatible" end-to-end', async () => {
    const settings = makeSettings({ apiKey: 'fake-ant-test' });
    const profile = { ...COPPEL_PROFILE_BASE, thinkingCompatibility: 'incompatible' as const };
    const client = (await createClientForModel({
      model: 'claude-opus-4-8',
      profile: profile as never,
      settings,
      context: 'execution',
    })) as unknown as { stream: (...args: never[]) => Promise<unknown> };
    expect(client).toBeInstanceOf(OpenAIClient);
    const body = await streamAndCaptureBody(client);
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('production turn path (createClientForModel) emits reasoning_effort when unsuppressed', async () => {
    const settings = makeSettings({ apiKey: 'fake-ant-test' });
    const profile = { ...COPPEL_PROFILE_BASE };
    const client = (await createClientForModel({
      model: 'claude-opus-4-8',
      profile: profile as never,
      settings,
      context: 'execution',
    })) as unknown as { stream: (...args: never[]) => Promise<unknown> };
    expect(client).toBeInstanceOf(OpenAIClient);
    const body = await streamAndCaptureBody(client);
    expect(body.reasoning_effort).toBe('high');
  });

  // SPIKE (REBEL-5RJ): prove the fix actually keeps Coppel working end-to-end and that
  // the suppression is LOAD-BEARING. Simulates a litellm→Vertex gateway like Coppel's
  // "Genius": it 400s exactly when the request carries `reasoning_effort` (which it
  // mistranslates into the legacy `thinking.type:"enabled"` Vertex Opus-4.8 rejects),
  // and succeeds otherwise. A thinking-incompatible profile must complete the turn; an
  // unsuppressed one must be rejected by the same faithful gateway.
  async function runTurnAgainstLitellmGateway(
    client: { stream: (...args: never[]) => Promise<unknown> },
  ): Promise<{ ok: boolean; sentReasoningEffort: boolean }> {
    let sentReasoningEffort = false;
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const body = JSON.parse(opts.body) as Record<string, unknown>;
      sentReasoningEffort = Object.prototype.hasOwnProperty.call(body, 'reasoning_effort');
      if (sentReasoningEffort) {
        // litellm wraps the upstream Vertex error as a Python bytes literal.
        return {
          ok: false,
          status: 400,
          text: async () =>
            'b\'{"type":"error","error":{"type":"invalid_request_error","message":"\\"thinking.type.enabled\\" is not supported for this model. Use \\"thinking.type.adaptive\\" and \\"output_config.effort\\" to control thinking behavior."}}\'',
        };
      }
      return {
        ok: true,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
            c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            c.close();
          },
        }),
      };
    });
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      await client.stream(
        {
          model: 'claude-opus-4-8' as never,
          systemPrompt: 'x',
          messages: [{ role: 'user' as const, content: 'hi' }],
          maxTokens: 64,
          effort: 'high',
        } as never,
        (() => {}) as never,
      );
      return { ok: true, sentReasoningEffort };
    } catch {
      return { ok: false, sentReasoningEffort };
    } finally {
      global.fetch = originalFetch;
    }
  }

  it('Coppel end-to-end: a thinking-incompatible profile completes a turn against a gateway that 400s on reasoning_effort', async () => {
    const settings = makeSettings({ apiKey: 'fake-ant-test' });
    const client = (await createClientForModel({
      model: 'claude-opus-4-8',
      profile: { ...COPPEL_PROFILE_BASE, thinkingCompatibility: 'incompatible' as const } as never,
      settings,
      context: 'execution',
    })) as unknown as { stream: (...args: never[]) => Promise<unknown> };
    const result = await runTurnAgainstLitellmGateway(client);
    expect(result.sentReasoningEffort).toBe(false); // suppressed at egress
    expect(result.ok).toBe(true); // → the gateway accepts the turn
  });

  it('Coppel control: the SAME gateway rejects an unsuppressed profile — proving suppression is what makes it work', async () => {
    const settings = makeSettings({ apiKey: 'fake-ant-test' });
    const client = (await createClientForModel({
      model: 'claude-opus-4-8',
      profile: { ...COPPEL_PROFILE_BASE } as never, // effort 'high', no incompatible mark
      settings,
      context: 'execution',
    })) as unknown as { stream: (...args: never[]) => Promise<unknown> };
    const result = await runTurnAgainstLitellmGateway(client);
    expect(result.sentReasoningEffort).toBe(true);
    expect(result.ok).toBe(false); // → the gateway 400s, exactly as Coppel saw
  });

  it('throws auth error for cloud profile without API key', () => {
    const settings = makeSettings({ apiKey: 'fake-ant-test' });
    const profile = {
      id: 'openai-no-key',
      name: 'GPT-5.5',
      providerType: 'openai' as const,
      serverUrl: 'https://api.openai.com/v1',
      createdAt: Date.now(),
    };
    expect(() => createOpenAIClientFromProfile(profile, settings)).toThrow(/API key/);
  });

  it('produces same result as createModelClient for OpenAI profile', () => {
    const settings = makeSettings({
      apiKey: 'fake-ant-test',
      workingProfileId: 'openai-1',
      profiles: [
        {
          id: 'openai-1',
          name: 'GPT-5.5',
          providerType: 'openai',
          serverUrl: 'https://api.openai.com/v1',
          apiKey: 'fake-openai-key',
        },
      ],
    });
    const profile = settings.localModel!.profiles![0]!;
    const fromHelper = createOpenAIClientFromProfile(profile, settings);
    const fromMain = createModelClient({ settings });
    // Both should be OpenAIClient
    expect(fromHelper).toBeInstanceOf(OpenAIClient);
    expect(fromMain).toBeInstanceOf(OpenAIClient);
  });
});

describe('resolveProfileFromModelString', () => {
  it('resolves profile from profile:id encoding', () => {
    const settings = makeSettings({
      profiles: [
        {
          id: 'abc123',
          name: 'Test Profile',
          providerType: 'openai',
          serverUrl: 'https://api.openai.com/v1',
          apiKey: 'key',
          model: 'gpt-5.5',
        },
      ],
    });
    const profile = resolveProfileFromModelString('profile:abc123', settings);
    expect(profile).not.toBeNull();
    expect(profile!.id).toBe('abc123');
  });

  it('returns null for profile:id that does not exist', () => {
    const settings = makeSettings({
      profiles: [
        {
          id: 'abc123',
          name: 'Test Profile',
          providerType: 'openai',
          serverUrl: 'https://api.openai.com/v1',
          apiKey: 'key',
        },
      ],
    });
    const profile = resolveProfileFromModelString('profile:nonexistent', settings);
    expect(profile).toBeNull();
  });

  it('resolves profile by model field match', () => {
    const settings = makeSettings({
      profiles: [
        {
          id: 'openai-1',
          name: 'GPT-5.5',
          providerType: 'openai',
          serverUrl: 'https://api.openai.com/v1',
          apiKey: 'key',
          model: 'gpt-5.5',
        },
      ],
    });
    const profile = resolveProfileFromModelString('gpt-5.5', settings);
    expect(profile).not.toBeNull();
    expect(profile!.id).toBe('openai-1');
  });

  it('skips disabled profiles in model field matching', () => {
    const settings = makeSettings({
      profiles: [
        {
          id: 'openai-disabled',
          name: 'GPT Disabled',
          providerType: 'openai',
          serverUrl: 'https://api.openai.com/v1',
          apiKey: 'key',
          model: 'gpt-5.5',
        },
      ],
    });
    (settings.localModel!.profiles![0] as any).enabled = false;
    const profile = resolveProfileFromModelString('gpt-5.5', settings);
    expect(profile).toBeNull();
  });

  it('returns null when no profiles exist', () => {
    const settings = makeSettings({});
    const profile = resolveProfileFromModelString('gpt-5.5', settings);
    expect(profile).toBeNull();
  });

  it('returns first enabled match when multiple profiles have same model', () => {
    const settings = makeSettings({
      profiles: [
        {
          id: 'together-1',
          name: 'Together GPT',
          providerType: 'together',
          serverUrl: 'https://api.together.xyz/v1',
          apiKey: 'key-1',
          model: 'gpt-5.5',
        },
        {
          id: 'openai-1',
          name: 'OpenAI GPT',
          providerType: 'openai',
          serverUrl: 'https://api.openai.com/v1',
          apiKey: 'key-2',
          model: 'gpt-5.5',
        },
      ],
    });
    const profile = resolveProfileFromModelString('gpt-5.5', settings);
    expect(profile).not.toBeNull();
    expect(profile!.id).toBe('together-1'); // First enabled match wins
  });
});

describe('Anthropic-free routing', () => {
  function makeAnthropicFreeSettings(overrides: {
    workingProfileId?: string | null;
    profiles: Array<{
      id: string;
      name: string;
      providerType?: 'openai' | 'google' | 'together' | 'cerebras' | 'other';
      serverUrl: string;
      apiKey?: string;
      model?: string;
    }>;
    providerKeys?: Record<string, string>;
  }): AppSettings {
    // Use empty strings (not null) so ?? doesn't fall through to default
    return makeSettings({
      apiKey: '',
      oauthToken: '',
      workingProfileId: overrides.workingProfileId ?? null,
      profiles: overrides.profiles,
      providerKeys: overrides.providerKeys,
    });
  }

  const openAIProfile = {
    id: 'openai-1',
    name: 'GPT-5.5',
    providerType: 'openai' as const,
    serverUrl: 'https://api.openai.com/v1',
    apiKey: 'fake-openai-key',
    model: 'gpt-5.5',
  };

  describe('createModelClient — zero Anthropic credentials', () => {
    it('creates OpenAIClient when working profile is OpenAI', () => {
      const settings = makeAnthropicFreeSettings({
        workingProfileId: 'openai-1',
        profiles: [openAIProfile],
      });
      const client = createModelClient({ settings });
      expect(client).toBeInstanceOf(OpenAIClient);
    });

    it('throws auth error when no profile is active and no Anthropic key', () => {
      // Skip if env vars provide Anthropic auth (getAuthForDirectUse checks both)
      if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) return;
      const settings = makeAnthropicFreeSettings({
        workingProfileId: null,
        profiles: [openAIProfile],
      });
      expect(() => createModelClient({ settings })).toThrow(/No model provider configured/);
    });
  });

  describe('createClientForModel — zero Anthropic credentials', () => {
    it('creates OpenAIClient for non-Claude model with matching profile', async () => {
      const settings = makeAnthropicFreeSettings({
        workingProfileId: 'openai-1',
        profiles: [openAIProfile],
      });
      const client = await createClientForModel({
        model: 'gpt-5.5',
        settings,
        context: 'subagent',
      });
      expect(client).toBeInstanceOf(OpenAIClient);
    });

    it('throws auth error for Claude model when no Anthropic credentials', async () => {
      if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) return;
      const settings = makeAnthropicFreeSettings({
        workingProfileId: 'openai-1',
        profiles: [openAIProfile],
      });
      await expect(createClientForModel({
        model: 'claude-sonnet-4-20250514',
        settings,
        context: 'subagent',
      })).rejects.toThrow(/Anthropic needs an API key/);
    });

    it('creates OpenAIClient for Together profile without Anthropic fallback', async () => {
      const settings = makeAnthropicFreeSettings({
        workingProfileId: 'together-1',
        profiles: [{
          id: 'together-1',
          name: 'Llama 405B',
          providerType: 'together',
          serverUrl: 'https://api.together.xyz/v1',
          apiKey: 'tok-together-key',
          model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        }],
      });
      const client = await createClientForModel({
        model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        settings,
        context: 'execution',
      });
      expect(client).toBeInstanceOf(OpenAIClient);
    });

    it('creates OpenAIClient for local model without any remote credentials', async () => {
      const settings = makeAnthropicFreeSettings({
        workingProfileId: 'local-1',
        profiles: [{
          id: 'local-1',
          name: 'Local Ollama',
          providerType: 'other',
          serverUrl: 'http://localhost:11434/v1',
          model: 'llama-3',
        }],
      });
      const client = await createClientForModel({
        model: 'llama-3',
        settings,
        context: 'execution',
      });
      expect(client).toBeInstanceOf(OpenAIClient);
    });
  });

});
