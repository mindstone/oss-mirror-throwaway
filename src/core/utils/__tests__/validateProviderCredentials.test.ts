import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSettings } from '@core/__tests__/builders/settingsBuilder';
import type { AppSettings, ModelProfile } from '@shared/types/settings';
import { classifyErrorUx } from '@rebel/shared/utils/classifyErrorUx';
import {
  credentialStateToErrorKind,
  type ProviderCredentialState,
  type UnconfiguredCredentialState,
  validateProviderCredentials,
} from '../validateProviderCredentials';

const cloudProfile: ModelProfile = {
  id: 'openai-profile',
  name: 'OpenAI profile',
  providerType: 'openai',
  serverUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.5',
  apiKey: 'profile-openai-key',
  createdAt: 1,
};

const localProfile: ModelProfile = {
  id: 'local-profile',
  name: 'Local profile',
  providerType: 'local',
  serverUrl: 'http://localhost:11434/v1',
  model: 'llama3.2',
  createdAt: 1,
};

const byoRouteSurfaceLocalProfile: ModelProfile = {
  id: 'byo-route-local',
  name: 'BYO local route surface',
  providerType: 'other',
  routeSurface: 'local',
  serverUrl: 'https://api.openai.com/v1',
  model: 'deepseek-v4-flash',
  createdAt: 1,
};

const byoLoopbackUrlProfile: ModelProfile = {
  id: 'byo-loopback-url',
  name: 'BYO loopback URL',
  providerType: 'other',
  serverUrl: 'http://127.0.0.1:8000/v1',
  model: 'deepseek-v4-flash',
  createdAt: 1,
};

const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

function settingsWithProfile(profile: ModelProfile, overrides: Partial<AppSettings> = {}): AppSettings {
  const base = buildSettings();
  return buildSettings({
    ...overrides,
    claude: {
      ...base.claude,
      apiKey: null,
      workingProfileId: profile.id,
      ...(overrides.claude ?? {}),
    },
    localModel: {
      profiles: [profile],
      activeProfileId: null,
      ...(overrides.localModel ?? {}),
    },
  });
}

describe('validateProviderCredentials', () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
    }
  });

  it('returns anthropic valid when a direct API key is configured', () => {
    const settings = buildSettings({
      claude: { ...buildSettings().models, apiKey: ' fake-\nkey ' },
    });

    expect(validateProviderCredentials(settings, false)).toEqual({
      kind: 'anthropic',
      status: 'valid',
      apiKey: 'fake-key',
    });
  });

  it('returns anthropic missing when no direct or profile API key is configured', () => {
    const settings = buildSettings({
      claude: { ...buildSettings().models, apiKey: null },
      localModel: { profiles: [], activeProfileId: null },
    });

    expect(validateProviderCredentials(settings, false)).toEqual({
      kind: 'anthropic',
      status: 'missing',
    });
  });

  it('returns openrouter valid when OpenRouter has an OAuth token', () => {
    const settings = buildSettings({
      activeProvider: 'openrouter',
      openRouter: {
        enabled: true,
        oauthToken: 'or-token',
        selectedModel: 'anthropic/claude-sonnet-4.6',
      },
    });

    expect(validateProviderCredentials(settings, false)).toEqual({
      kind: 'openrouter',
      status: 'valid',
      oauthToken: 'or-token',
    });
  });

  it('returns openrouter missing when OpenRouter is selected without an OAuth token', () => {
    const settings = buildSettings({
      activeProvider: 'openrouter',
      openRouter: {
        enabled: true,
        oauthToken: null,
        selectedModel: 'anthropic/claude-sonnet-4.6',
      },
    });

    expect(validateProviderCredentials(settings, false)).toEqual({
      kind: 'openrouter',
      status: 'missing',
    });
  });

  it('returns codex connected with the resolved working profile when Codex is connected', () => {
    const settings = settingsWithProfile(cloudProfile, { activeProvider: 'codex' });

    expect(validateProviderCredentials(settings, true)).toEqual({
      kind: 'codex',
      status: 'connected',
      profile: cloudProfile,
    });
  });

  it('returns codex disconnected when Codex is selected but not connected', () => {
    const settings = settingsWithProfile(cloudProfile, { activeProvider: 'codex' });

    expect(validateProviderCredentials(settings, false)).toEqual({
      kind: 'codex',
      status: 'disconnected',
    });
  });

  it('codex disconnected with stale openRouter config still returns codex disconnected (no masking)', () => {
    const settings = {
      activeProvider: 'codex',
      openRouter: { enabled: true, oauthToken: 'or-token' },
    } as AppSettings;

    expect(validateProviderCredentials(settings, false)).toEqual({
      kind: 'codex',
      status: 'disconnected',
    });
  });

  it('returns local valid when the working profile is local regardless of active provider', () => {
    const settings = settingsWithProfile(localProfile, { activeProvider: 'codex' });

    expect(validateProviderCredentials(settings, false)).toEqual({
      kind: 'local',
      status: 'valid',
      profile: localProfile,
    });
  });

  it('admits BYO local-route profiles without requiring credentials', () => {
    const settings = settingsWithProfile(byoRouteSurfaceLocalProfile, {
      activeProvider: 'anthropic',
      claude: { ...buildSettings().models, apiKey: null },
    });

    expect(validateProviderCredentials(settings, false)).toEqual({
      kind: 'local',
      status: 'valid',
      profile: byoRouteSurfaceLocalProfile,
    });
  });

  it('admits BYO loopback URL profiles without requiring routeSurface', () => {
    const settings = settingsWithProfile(byoLoopbackUrlProfile, {
      activeProvider: 'anthropic',
      claude: { ...buildSettings().models, apiKey: null },
    });

    expect(validateProviderCredentials(settings, false)).toEqual({
      kind: 'local',
      status: 'valid',
      profile: byoLoopbackUrlProfile,
    });
  });

  it('treats empty settings as missing Anthropic credentials', () => {
    expect(validateProviderCredentials({} as AppSettings, false)).toEqual({
      kind: 'anthropic',
      status: 'missing',
    });
  });

  it('treats a missing claude object as missing Anthropic credentials', () => {
    const settings = buildSettings({ claude: undefined as unknown as AppSettings['claude'] });

    expect(validateProviderCredentials(settings, false)).toEqual({
      kind: 'anthropic',
      status: 'missing',
    });
  });

  it('returns codex connected with a null profile when no working profile resolves', () => {
    const settings = buildSettings({
      activeProvider: 'codex',
      claude: { ...buildSettings().models, apiKey: null, workingProfileId: undefined },
      localModel: { profiles: [], activeProfileId: null },
    });

    expect(validateProviderCredentials(settings, true)).toEqual({
      kind: 'codex',
      status: 'connected',
      profile: null,
    });
  });

  it('handles an undefined profile collection without crashing', () => {
    const settings = buildSettings({
      claude: { ...buildSettings().models, apiKey: null, workingProfileId: 'missing-profile' },
      localModel: undefined as unknown as AppSettings['localModel'],
    });

    expect(validateProviderCredentials(settings, false)).toEqual({
      kind: 'anthropic',
      status: 'missing',
    });
  });

  it('treats a whitespace-only API key as malformed and missing', () => {
    const settings = buildSettings({
      claude: { ...buildSettings().models, apiKey: ' \n\t ' },
    });

    expect(validateProviderCredentials(settings, false)).toEqual({
      kind: 'anthropic',
      status: 'missing',
    });
  });

  it('uses a resolvable non-local profile API key for direct profile auth', () => {
    const settings = settingsWithProfile(cloudProfile);

    expect(validateProviderCredentials(settings, false)).toEqual({
      kind: 'anthropic',
      status: 'valid',
      apiKey: 'profile-openai-key',
    });
  });

  it('forces exhaustive switches over ProviderCredentialState', () => {
    function missingLocalArm(state: ProviderCredentialState): string {
      switch (state.kind) {
        case 'anthropic':
          return state.status;
        case 'openrouter':
          return state.status;
        case 'codex':
          return state.status;
        default: {
          // @ts-expect-error — omitting the `local` arm leaves `state` non-never.
          const _exhaustive: never = state;
          return _exhaustive;
        }
      }
    }

    expect(missingLocalArm({ kind: 'anthropic', status: 'missing' })).toBe('missing');
  });
});

describe('credentialStateToErrorKind — seam contract (REBEL: disconnected-provider-toast)', () => {
  // Every not-connected / not-configured credential state. Enumerated exhaustively
  // so a future provider/status added to the union forces this table to be updated
  // (the `satisfies` below + the `never` guard inside the function are the teeth).
  const UNCONFIGURED_STATES = [
    { kind: 'anthropic', status: 'missing' },
    { kind: 'openrouter', status: 'missing' },
    { kind: 'codex', status: 'disconnected' },
  ] as const satisfies readonly UnconfiguredCredentialState[];

  it('maps EVERY not-connected/missing state to connection-not-configured (never auth)', () => {
    for (const state of UNCONFIGURED_STATES) {
      expect(credentialStateToErrorKind(state)).toBe('connection-not-configured');
    }
  });

  it('NEVER produces a "rejected the credentials" toast for any not-connected/missing state', () => {
    // Negative invariant: drive each unconfigured state through the full chain
    // (credentialState → errorKind → classifyErrorUx body) for every provider the
    // toast can be rendered under, and assert the user never sees the false
    // "rejected the credentials" claim. This is the test that would have caught
    // the original incident — it encodes what must NEVER appear.
    const renderedUnder: ReadonlyArray<'codex' | 'anthropic' | 'openrouter' | 'mindstone' | 'local'> = [
      'codex',
      'anthropic',
      'openrouter',
      'mindstone',
      'local',
    ];

    for (const state of UNCONFIGURED_STATES) {
      const errorKind = credentialStateToErrorKind(state);
      for (const activeProvider of renderedUnder) {
        const toast = classifyErrorUx({
          errorKind,
          rawMessage: 'Provider was never connected.',
          settingsContext: {
            activeProvider,
            hasAnthropicCredentials: false,
            hasOpenRouterCredentials: false,
            hasCodexSubscription: false,
          },
        });
        expect(toast.body, `${state.kind}/${state.status} under ${activeProvider}`).not.toMatch(
          /rejected the credentials/i,
        );
        expect(toast.kind).toBe('connection-not-configured');
      }
    }
  });

  it("mindstone managed-key-missing toast says 'not ready', never 'rejected'", () => {
    // The mindstone managed-key path is a runtime storage probe (not modelled by
    // ProviderCredentialState), but it is the same class and uses the same kind.
    const toast = classifyErrorUx({
      errorKind: 'connection-not-configured',
      rawMessage: 'Your Mindstone subscription key is not available.',
      settingsContext: {
        activeProvider: 'mindstone',
        hasAnthropicCredentials: false,
        hasOpenRouterCredentials: false,
        hasCodexSubscription: false,
      },
    });

    expect(toast.body).not.toMatch(/rejected the credentials/i);
    expect(toast.title).toBe('Mindstone subscription not ready.');
  });

  // ---------------------------------------------------------------------------
  // FOX-3494 Mechanism A — documents the CURRENT (broken) admission behaviour
  // for a ChatGPT-Pro user whose `activeProvider` drifted off 'codex'. These
  // pass today (red-in-spirit: they assert the bug). Stage 3 adds a separate
  // `applyCodexProviderHeal` that runs BEFORE admission, so admission never sees
  // the drifted state — validateProviderCredentials itself is unchanged.
  // ---------------------------------------------------------------------------
  describe('FOX-3494 Mechanism A — activeProvider drift (current broken behaviour)', () => {
    it("activeProvider 'anthropic' + valid codex tokens + no anthropic key → admission dead-ends on Anthropic (the bug)", () => {
      const settings = buildSettings({
        activeProvider: 'anthropic',
        claude: { ...buildSettings().models, apiKey: null },
        localModel: { profiles: [], activeProfileId: null },
      });
      // codexConnected=true, yet admission gates on the anthropic arm and fails.
      expect(validateProviderCredentials(settings, true)).toEqual({
        kind: 'anthropic',
        status: 'missing',
      });
    });

    it('activeProvider undefined + valid codex tokens + no anthropic key → admission dead-ends on Anthropic (the bug)', () => {
      const settings = buildSettings({
        activeProvider: undefined,
        claude: { ...buildSettings().models, apiKey: null },
        localModel: { profiles: [], activeProfileId: null },
      });
      expect(validateProviderCredentials(settings, true)).toEqual({
        kind: 'anthropic',
        status: 'missing',
      });
    });
  });

  // GREEN AFTER STAGE 3: once `applyCodexProviderHeal` heals the drifted
  // `activeProvider` back to 'codex' on reconnect/boot, admission sees a usable
  // codex state. The heal itself (and its guard) is unit-tested in
  // src/main/__tests__/settingsStore.codexProviderHeal.test.ts; these assert
  // that the POST-heal settings shape admits as expected.
  describe('FOX-3494 Mechanism A — post-heal admission (Stage 3 landed)', () => {
    it("healed activeProvider 'codex' + connected → admission returns codex connected", () => {
      const healed = buildSettings({
        activeProvider: 'codex',
        claude: { ...buildSettings().models, apiKey: null },
        localModel: { profiles: [], activeProfileId: null },
      });
      expect(validateProviderCredentials(healed, true)).toMatchObject({
        kind: 'codex',
        status: 'connected',
      });
    });

    it('a deliberate Anthropic user WITH a key is NOT healed to codex (guard)', () => {
      const anthropicUser = buildSettings({
        activeProvider: 'anthropic',
        claude: { ...buildSettings().models, apiKey: 'real-anthropic-key' },
      });
      // Post-heal: still anthropic (heal only fires on unusable states).
      expect(validateProviderCredentials(anthropicUser, true)).toMatchObject({
        kind: 'anthropic',
        status: 'valid',
      });
    });
  });
});
