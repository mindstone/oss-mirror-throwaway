import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isUsingOAuth,
  getApiKeyAuthEnvVars,
  getProviderKeyEnvVars,
  getAuthForDirectUse,
  hasDirectAuth,
  isDirectAnthropicConfig,
  getAuthEnvVars,
  hasValidAuth,
  isUsingOpenRouter,
  getAuthMethodDescription,
  AUTH_SHAPE_HELPERS,
} from '@core/utils/authEnvUtils';
import * as authEnvUtils from '@core/utils/authEnvUtils';
import { buildSettings } from '@core/__tests__/builders/settingsBuilder';
import { setCodexAuthProvider } from '@core/codexAuth';
import type { AppSettings, ActiveProvider } from '@shared/types';

const createMockSettings = (overrides: Partial<AppSettings['claude']> = {}): AppSettings => {
  const models = {
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
  };

  return {
    claude: models,
    models,
    voice: {
      ttsProvider: 'openai',
      ttsVoice: 'alloy',
      sttProvider: 'openai',
      openaiApiKey: null,
      elevenLabsApiKey: null,
      elevenLabsVoiceId: null,
      autoPlayResponse: false,
    } as any,
    coreDirectory: '/test/core',
    mcpConfigFile: null,
    onboardingCompleted: true,
    appearance: { theme: 'system' },
    privacy: { allowTelemetry: true },
    diagnostics: { sentryEnabled: true } as any,
  } as unknown as AppSettings;
};

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

  it('returns true when OpenRouter is active', () => {
    const settings = {
      ...createMockSettings(),
      openRouter: { enabled: true, oauthToken: 'or-token', selectedModel: 'anthropic/claude-sonnet-4.6' },
    } as unknown as AppSettings;
    expect(isUsingOAuth(settings)).toBe(true);
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

describe('getProviderKeyEnvVars', () => {
  it('returns empty object when providerKeys is undefined', () => {
    expect(getProviderKeyEnvVars(undefined)).toEqual({});
  });

  it('returns empty object when providerKeys is empty', () => {
    expect(getProviderKeyEnvVars({})).toEqual({});
  });

  it('maps provider key IDs to uppercase env var names', () => {
    expect(getProviderKeyEnvVars({
      openai: 'fake-openai-key',
      google: 'AIza-google-key',
    })).toEqual({
      OPENAI_API_KEY: 'fake-openai-key',
      GOOGLE_API_KEY: 'AIza-google-key',
    });
  });

  it('maps all known providers', () => {
    const result = getProviderKeyEnvVars({
      openai: 'fake-openai',
      google: 'AIza-google',
      together: 'tog-key',
      cerebras: 'cer-key',
    });
    expect(result).toEqual({
      OPENAI_API_KEY: 'fake-openai',
      GOOGLE_API_KEY: 'AIza-google',
      TOGETHER_API_KEY: 'tog-key',
      CEREBRAS_API_KEY: 'cer-key',
    });
  });

  it('skips null values', () => {
    expect(getProviderKeyEnvVars({ openai: null, google: 'AIza-key' })).toEqual({
      GOOGLE_API_KEY: 'AIza-key',
    });
  });

  it('skips empty and whitespace-only values', () => {
    expect(getProviderKeyEnvVars({ openai: '', google: '   ' })).toEqual({});
  });

  it('trims whitespace from values', () => {
    expect(getProviderKeyEnvVars({ openai: '  fake-key  ' })).toEqual({
      OPENAI_API_KEY: 'fake-key',
    });
  });
});

describe('getAuthForDirectUse', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns API key when API key is available', () => {
    const settings = createMockSettings({ apiKey: 'fake-settings-key' });
    expect(getAuthForDirectUse(settings)).toEqual({ apiKey: 'fake-settings-key' });
  });

  it('returns empty when only OAuth token is present (OAuth deprecated)', () => {
    const settings = createMockSettings({ oauthToken: 'oauth-settings-token' });
    expect(getAuthForDirectUse(settings)).toEqual({});
  });

  it('returns only API key when both API key and OAuth token are present', () => {
    const settings = createMockSettings({
      apiKey: 'fake-settings-key',
      oauthToken: 'oauth-settings-token',
    });
    expect(getAuthForDirectUse(settings)).toEqual({
      apiKey: 'fake-settings-key',
    });
  });

  it('falls back to env var ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_API_KEY = 'fake-env-key';
    const settings = createMockSettings({});
    expect(getAuthForDirectUse(settings)).toEqual({
      apiKey: 'fake-env-key',
    });
  });
});

describe('hasDirectAuth', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns false when no credentials exist (empty object truthiness guard)', () => {
    const settings = createMockSettings({});
    expect(hasDirectAuth(settings)).toBe(false);
  });

  it('returns true when API key is set', () => {
    const settings = createMockSettings({ apiKey: 'fake-ant-test' });
    expect(hasDirectAuth(settings)).toBe(true);
  });

  it('returns false when only OAuth token is set (OAuth deprecated)', () => {
    const settings = createMockSettings({ oauthToken: 'oauth-token' });
    expect(hasDirectAuth(settings)).toBe(false);
  });

  it('returns true when env var API key is set', () => {
    process.env.ANTHROPIC_API_KEY = 'fake-env-key';
    const settings = createMockSettings({});
    expect(hasDirectAuth(settings)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Provider matrix — one row per provider, asserting the EXPECTED return of each
// provider-varying function. Consolidates the per-provider happy-path cases that
// used to live in authEnvUtils.{mindstone,openrouter}.test.ts plus the codex/
// anthropic happy rows from the standalone blocks below.
//
// Settings are built via buildSettings (the repo's source-of-truth factory) so
// the whole matrix uses ONE settings style. process.env is snapshotted/cleared
// per-test because getAuthEnvVars/hasValidAuth read it.
// ---------------------------------------------------------------------------
describe('provider matrix', () => {
  const anthropicWithKey = (key: string): AppSettings =>
    buildSettings({
      activeProvider: 'anthropic',
      openRouter: undefined,
      claude: { ...buildSettings().models, apiKey: key },
    });

  const orSettings = (): AppSettings =>
    buildSettings({
      activeProvider: 'openrouter',
      openRouter: {
        enabled: true,
        oauthToken: 'fake-or-test-token',
        selectedModel: 'anthropic/claude-sonnet-4.6',
      },
    });

  const codexWithKey = (key: string): AppSettings =>
    buildSettings({
      activeProvider: 'codex',
      claude: { ...buildSettings().models, apiKey: key },
    });

  // Env isolation: getAuthEnvVars/hasValidAuth consult process.env, so snapshot
  // and strip the relevant vars before each case and restore after (merges the
  // backup patterns from the old openrouter.test.ts + main env helpers).
  const envBackup: Record<string, string | undefined> = {};
  beforeEach(() => {
    envBackup.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    envBackup.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    // Codex disconnected stub — the codex matrix row is the DISCONNECTED case.
    setCodexAuthProvider({
      isConnected: () => false,
      getAccessToken: async () => null,
      getAccountId: () => null,
      forceRefreshToken: async () => null,
      getStatus: () => ({ connected: false }),
    });
  });
  afterEach(() => {
    if (envBackup.ANTHROPIC_API_KEY !== undefined) {
      process.env.ANTHROPIC_API_KEY = envBackup.ANTHROPIC_API_KEY;
    }
    if (envBackup.CLAUDE_CODE_OAUTH_TOKEN !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = envBackup.CLAUDE_CODE_OAUTH_TOKEN;
    }
  });

  type MatrixCase = {
    name: string;
    settings: () => AppSettings;
    isDirectAnthropicConfig: boolean;
    isUsingOpenRouter: boolean;
    isUsingOAuth: boolean;
    getAuthEnvVars: Record<string, string>;
    hasValidAuth: boolean;
    authMethodDescription: string;
  };

  const cases: MatrixCase[] = [
    {
      name: 'anthropic',
      settings: () => anthropicWithKey('fake-ant-key'),
      isDirectAnthropicConfig: true,
      isUsingOpenRouter: false,
      isUsingOAuth: false,
      getAuthEnvVars: { ANTHROPIC_API_KEY: 'fake-ant-key' },
      hasValidAuth: true,
      authMethodDescription: 'API Key',
    },
    {
      name: 'openrouter',
      settings: () => orSettings(),
      isDirectAnthropicConfig: false,
      isUsingOpenRouter: true,
      isUsingOAuth: true,
      getAuthEnvVars: { ANTHROPIC_API_KEY: '' },
      hasValidAuth: true,
      authMethodDescription: 'OpenRouter',
    },
    {
      name: 'codex (disconnected, with backup key)',
      settings: () => codexWithKey('fake-ant-backup'),
      isDirectAnthropicConfig: false,
      isUsingOpenRouter: false,
      isUsingOAuth: false,
      // Disconnected codex falls through to the Anthropic key, NOT '' —
      // see authEnvUtils.ts lines 112-114 (the '' branch requires isConnected()).
      getAuthEnvVars: { ANTHROPIC_API_KEY: 'fake-ant-backup' },
      // Codex active/disconnected => not valid even with a stale backup key.
      hasValidAuth: false,
      authMethodDescription: 'API Key',
    },
    {
      name: 'mindstone',
      settings: () => buildSettings({ activeProvider: 'mindstone' }),
      isDirectAnthropicConfig: false,
      // Mindstone managed mode routes through OpenRouter (authEnvUtils.ts line 79).
      isUsingOpenRouter: true,
      isUsingOAuth: true,
      getAuthEnvVars: { ANTHROPIC_API_KEY: '' },
      hasValidAuth: true,
      authMethodDescription: 'OpenRouter',
    },
  ];

  describe.each(cases)('$name', (c) => {
    it('isDirectAnthropicConfig', () => {
      expect(isDirectAnthropicConfig(c.settings())).toBe(c.isDirectAnthropicConfig);
    });

    it('isUsingOpenRouter', () => {
      expect(isUsingOpenRouter(c.settings())).toBe(c.isUsingOpenRouter);
    });

    it('isUsingOAuth', () => {
      expect(isUsingOAuth(c.settings())).toBe(c.isUsingOAuth);
    });

    it('getAuthEnvVars', () => {
      const env = getAuthEnvVars(c.settings());
      expect(env).toEqual(c.getAuthEnvVars);
      // No row should ever set CLAUDE_CODE_OAUTH_TOKEN (OAuth deprecated;
      // OR/mindstone route via proxy). Preserves the old openrouter.test.ts case.
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('hasValidAuth', () => {
      expect(hasValidAuth(c.settings())).toBe(c.hasValidAuth);
    });

    it('getAuthMethodDescription', () => {
      expect(getAuthMethodDescription(c.settings())).toBe(c.authMethodDescription);
    });
  });

  // Mindstone server-managed auth: valid even with no API keys at all
  // (migrated from authEnvUtils.mindstone.test.ts).
  describe('mindstone server-managed', () => {
    it('hasValidAuth stays true even with apiKey:null and oauthToken:null', () => {
      const settings = buildSettings({
        activeProvider: 'mindstone',
        claude: { ...buildSettings().models, apiKey: null, oauthToken: null },
      });
      expect(hasValidAuth(settings)).toBe(true);
    });
  });

  // OpenRouter sync/stale-flag edge cases that don't fit a per-provider row
  // (migrated from authEnvUtils.openrouter.test.ts).
  describe('isUsingOpenRouter edge cases', () => {
    const createMockSettingsOR = (overrides: Partial<AppSettings> = {}): AppSettings =>
      buildSettings({ ...overrides });

    it('returns false when enabled but no token', () => {
      const settings = createMockSettingsOR({
        openRouter: { enabled: true, oauthToken: null, selectedModel: 'anthropic/claude-sonnet-4.6' },
      });
      expect(isUsingOpenRouter(settings)).toBe(false);
    });

    it('returns false when disabled with token but activeProvider is not openrouter', () => {
      const settings = createMockSettingsOR({
        openRouter: { enabled: false, oauthToken: 'fake-or-test-token', selectedModel: 'anthropic/claude-sonnet-4.6' },
      });
      expect(isUsingOpenRouter(settings)).toBe(false);
    });

    it('returns true when disabled but activeProvider is openrouter and token present', () => {
      // Covers stale enabled flag: user switched to OR via activeProvider but
      // enabled wasn't synced. The authoritative activeProvider takes precedence.
      const settings = createMockSettingsOR({
        activeProvider: 'openrouter',
        openRouter: { enabled: false, oauthToken: 'fake-or-test-token', selectedModel: 'anthropic/claude-opus-4.7' },
      });
      expect(isUsingOpenRouter(settings)).toBe(true);
    });

    it('returns false when activeProvider is openrouter but no token', () => {
      const settings = createMockSettingsOR({
        activeProvider: 'openrouter',
        openRouter: { enabled: false, oauthToken: null, selectedModel: '' },
      });
      expect(isUsingOpenRouter(settings)).toBe(false);
    });

    it('returns false when openRouter settings missing', () => {
      expect(isUsingOpenRouter(createMockSettingsOR({ openRouter: undefined }))).toBe(false);
    });
  });

  // hasValidAuth for OpenRouter without a token is an edge case (the with-token
  // case is the matrix openrouter row). Migrated from openrouter.test.ts.
  describe('hasValidAuth — OpenRouter edge cases', () => {
    it('returns false when OR enabled without token', () => {
      const settings = buildSettings({
        activeProvider: 'openrouter',
        openRouter: { enabled: true, oauthToken: null, selectedModel: 'anthropic/claude-sonnet-4.6' },
      });
      expect(hasValidAuth(settings)).toBe(false);
    });
  });
});

describe('isDirectAnthropicConfig — edge & defensive cases', () => {
  it('returns false when OpenRouter is active', () => {
    const settings = buildSettings({
      activeProvider: 'openrouter',
      openRouter: {
        enabled: true,
        oauthToken: 'fake-or-test-token',
        selectedModel: 'openai/gpt-5.5',
      },
    });

    expect(isDirectAnthropicConfig(settings)).toBe(false);
  });

  it('returns false when activeProvider is openrouter even without an oauthToken (partial config)', () => {
    // Defensive: a misconfigured user could have activeProvider='openrouter'
    // without a valid OpenRouter oauth token. isUsingOpenRouter would return
    // false in that case, but we must still refuse to route as direct Anthropic
    // because the user's model IDs will be OpenRouter-style.
    const settings = buildSettings({
      activeProvider: 'openrouter',
      openRouter: {
        enabled: false,
        oauthToken: null,
        selectedModel: '',
      },
    });

    expect(isDirectAnthropicConfig(settings)).toBe(false);
  });

  it('returns false for the exact failure shape: OpenRouter active + Anthropic API key present + OpenRouter-style model IDs', () => {
    // This is the observed bug scenario from 260419 — a legacy Anthropic key
    // is still in claude.apiKey, but the user's effective provider is
    // OpenRouter and the model IDs are in provider/slug form.
    const settings = buildSettings({
      activeProvider: 'openrouter',
      openRouter: {
        enabled: true,
        oauthToken: 'fake-or-token-for-test',
        selectedModel: 'openai/gpt-5.5',
      },
      claude: {
        apiKey: 'fake-anthropic-key-for-test',
        oauthToken: null,
        authMethod: 'api-key',
        model: 'openai/gpt-5.5',
        thinkingModel: 'anthropic/claude-opus-4.7',
        permissionMode: 'bypassPermissions',
        executablePath: null,
        planMode: true,
        extendedContext: true,
        thinkingEffort: 'high',
      },
    });

    expect(isDirectAnthropicConfig(settings)).toBe(false);
  });

  it('returns false for nullish settings', () => {
    expect(isDirectAnthropicConfig(null as unknown as AppSettings)).toBe(false);
    expect(isDirectAnthropicConfig(undefined as unknown as AppSettings)).toBe(false);
  });

  it('fails closed at runtime when activeProvider is an unknown literal (defends type-narrowing escape)', () => {
    // Defensive: corrupted settings JSON or a future provider string that
    // hasn't been added to the ActiveProvider union should refuse direct-
    // Anthropic rather than silently allowing the call. Pairs with the
    // compile-time `const _exhaustive: never` check inside the helper.
    const settings = buildSettings({
      // Cast through unknown — the runtime default branch is what's under test.
      activeProvider: 'mystery-provider' as unknown as ActiveProvider,
      openRouter: undefined,
    });

    expect(isDirectAnthropicConfig(settings)).toBe(false);
  });
});

describe('Codex-aware auth resolution', () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    setCodexAuthProvider({
      isConnected: () => false,
      getAccessToken: async () => null,
      getAccountId: () => null,
      forceRefreshToken: async () => null,
      getStatus: () => ({ connected: false }),
    });
  });

  // The disconnected-with-backup-key hasValidAuth=false and the getAuthEnvVars
  // fall-through cases now live in the provider matrix codex row. What remains
  // here is the distinct no-backup variant: apiKey:null AND empty localModel
  // profiles (no resolvable auth of any kind).
  it('returns false from hasValidAuth when Codex is active but disconnected and no backup auth exists', () => {
    const settings = buildSettings({
      activeProvider: 'codex',
      claude: {
        ...buildSettings().models,
        apiKey: null,
      },
      localModel: {
        profiles: [],
        activeProfileId: null,
      },
    });

    expect(hasValidAuth(settings)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AUTH_SHAPE_HELPERS classification drift (260419 D3, follow-up #5)
// ---------------------------------------------------------------------------

/**
 * Sibling registry to {@link AUTH_SHAPE_HELPERS}: every helper exported
 * from `authEnvUtils.ts` that is NOT auth-shape-only must be classified
 * here. Auth-shape-only helpers go in `AUTH_SHAPE_HELPERS` (the export
 * itself); everything else (provider-aware helpers, the provider-shape
 * predicate `isDirectAnthropicConfig`, and other utilities) goes here.
 *
 * **This list lives in the test file on purpose** — adding a new helper
 * to `authEnvUtils.ts` should force the author to make an explicit
 * classification decision (auth-shape-only vs provider-aware/other),
 * because forgetting to update `AUTH_SHAPE_HELPERS` would silently
 * bypass the integration-test gate check (A3b) for the new helper.
 *
 * Inclusion criterion: the helper MUST consult `activeProvider`,
 * `isUsingOpenRouter`, `getCodexAuthProvider`, or any other provider-
 * routing signal — OR be a routing/utility helper that doesn't return
 * pure auth-shape state. If neither is true, the helper belongs in
 * `AUTH_SHAPE_HELPERS` instead.
 *
 * @see AUTH_SHAPE_HELPERS in `src/core/utils/authEnvUtils.ts`
 * @see scripts/check-integration-test-provider-gates.ts (A3b consumer)
 * @see docs/plans/260419_prepush_followups_roadmap.md (D3, Follow-up #5)
 */
const PROVIDER_AWARE_OR_OTHER_HELPERS = [
  'isUsingOpenRouter',
  'hasOpenRouterCredentials',
  'getAuthEnvVars',
  'hasValidAuth',
  'getAuthMethodDescription',
  'isDirectAnthropicConfig',
  'isUsingOAuth',
  'getProviderKeyEnvVars',
  'resolveTierFallback',
  'getRateLimitFallbackTarget',
  // Test-only seam (storage-prefix truth-table pin); an "other" utility helper,
  // not auth-shape state. See btsStoragePrefixParsers.truthTable.test.ts.
  '__parseFallbackEncodingAuthEnvForTests',
] as const;

describe('AUTH_SHAPE_HELPERS classification drift guard', () => {
  it('every exported function is classified as either auth-shape-only or provider-aware/other', () => {
    const exportedFunctionNames = Object.entries(authEnvUtils)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name);

    const authShapeSet = new Set<string>(AUTH_SHAPE_HELPERS);
    const otherSet = new Set<string>(PROVIDER_AWARE_OR_OTHER_HELPERS);

    const unclassified: string[] = [];
    for (const name of exportedFunctionNames) {
      if (authShapeSet.has(name)) continue;
      if (otherSet.has(name)) continue;
      unclassified.push(name);
    }

    if (unclassified.length > 0) {
      const summary = unclassified
        .map(
          (n) =>
            `Function "${n}" exported from authEnvUtils.ts is not classified. ` +
            `Add to AUTH_SHAPE_HELPERS (in src/core/utils/authEnvUtils.ts, if ` +
            `auth-shape-only) or to PROVIDER_AWARE_OR_OTHER_HELPERS in this ` +
            `test file (if provider-aware/other).`,
        )
        .join('\n');
      throw new Error(`Unclassified helper(s) in authEnvUtils.ts:\n${summary}`);
    }

    expect(unclassified).toEqual([]);
  });

  it('AUTH_SHAPE_HELPERS and PROVIDER_AWARE_OR_OTHER_HELPERS are disjoint (a helper cannot be both)', () => {
    const intersection = (AUTH_SHAPE_HELPERS as readonly string[]).filter((name) =>
      (PROVIDER_AWARE_OR_OTHER_HELPERS as readonly string[]).includes(name),
    );
    expect(intersection).toEqual([]);
  });

  it('PROVIDER_AWARE_OR_OTHER_HELPERS has no stale names (every entry is an actually-exported function)', () => {
    // Stage 5 Phase-6 hardening (Gemini suggestion): a stale entry here
    // would silently widen the "classified" set, defeating the guard above
    // when a helper is renamed/removed without updating this list.
    const stale = PROVIDER_AWARE_OR_OTHER_HELPERS.filter(
      (name) => typeof (authEnvUtils as Record<string, unknown>)[name] !== 'function',
    );
    expect(stale).toEqual([]);
  });
});
