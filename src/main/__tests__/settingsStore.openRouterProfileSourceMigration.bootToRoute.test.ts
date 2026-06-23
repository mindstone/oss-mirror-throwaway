import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import { ProviderRouter } from '@core/rebelCore/providerRouting';

let persistedStore: Record<string, unknown> | null = null;
let seedStore: Record<string, unknown> = {};

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const deepMerge = (
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> => {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = deepMerge(merged[key] as Record<string, unknown>, value);
      continue;
    }
    merged[key] = deepClone(value);
  }
  return merged;
};

const makeLegacyOpenRouterProfile = (id: string): ModelProfile => ({
  id,
  name: `OpenRouter ${id}`,
  providerType: 'openrouter',
  routeSurface: 'pool',
  serverUrl: 'https://openrouter.ai/api/v1',
  model: 'anthropic/claude-sonnet-4-6',
  createdAt: 1_700_000_000_000,
});

const makeSettings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
  activeProvider: 'openrouter',
  codexRepairSchemaVersion: 2,
  modelsNamespaceSchemaVersion: 2,
  openRouterProviderHealVersion: 1,
  openRouter: {
    enabled: true,
    oauthToken: 'fake-or-token',
    selectedModel: 'anthropic/claude-sonnet-4-6',
  },
  providerKeys: {},
  claude: {
    apiKey: null,
    model: 'claude-sonnet-4-6',
    authMethod: 'api-key',
  } as AppSettings['claude'],
  localModel: {
    activeProfileId: null,
    profiles: [makeLegacyOpenRouterProfile('legacy-or')],
  },
  ...overrides,
} as AppSettings);

const installElectronStoreMock = (): void => {
   
  vi.doMock('electron-store', () => ({
    default: class MockStore {
      constructor(opts?: { defaults?: Record<string, unknown> }) {
        if (persistedStore === null) {
          persistedStore = deepMerge(deepClone(opts?.defaults ?? {}), seedStore);
        }
      }

      get store(): Record<string, unknown> {
        return deepClone(persistedStore ?? {});
      }

      set store(value: Record<string, unknown>) {
        persistedStore = deepClone(value);
      }
    },
  }));
};

const loadSettingsStore = async (seed: Partial<AppSettings>) => {
  vi.resetModules();
  persistedStore = null;
  seedStore = deepClone(seed as Record<string, unknown>);
  installElectronStoreMock();
  const settingsStoreModule = await import('@main/settingsStore');
  if (
    typeof (settingsStoreModule as { bootstrapOpenRouterProfileSourceMigration?: unknown })
      .bootstrapOpenRouterProfileSourceMigration !== 'function'
  ) {
    throw new TypeError('bootstrapOpenRouterProfileSourceMigration is not a function');
  }
  return settingsStoreModule;
};

const getMigratedProfile = (settings: AppSettings): ModelProfile => {
  const profile = settings.localModel?.profiles?.find((entry) => entry.id === 'legacy-or');
  if (!profile) throw new Error('Missing legacy-or profile');
  return profile;
};

describe('settingsStore OR profileSource migration boot-to-route matrix', () => {
  beforeEach(() => {
    persistedStore = null;
    seedStore = {};
    vi.resetModules();
  });

  it('state a: activeProvider=openrouter + oauth token stamps and routes via openrouter-oauth-token', async () => {
    const settingsStoreModule = await loadSettingsStore(makeSettings());
    const settings = settingsStoreModule.getSettings();
    const profile = getMigratedProfile(settings);

    expect(profile.profileSource).toBe('connection');
    expect(settings.openRouterProfileSourceMigrationVersion).toBe(1);

    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings,
      model: 'profile:legacy-or',
    });

    expect(decision.kind).toBe('dispatchable');
    if (decision.kind !== 'dispatchable') {
      return;
    }
    expect(decision.transport).toBe('openrouter-proxy');
    expect(decision.credentialSource).toBe('openrouter-oauth-token');
  });

  it('state b: heal + migration chain routes via OAuth after heal flips activeProvider', async () => {
    const settingsStoreModule = await loadSettingsStore(makeSettings({
      activeProvider: 'anthropic',
      openRouterProviderHealVersion: undefined,
      claude: {
        apiKey: null,
        model: 'claude-sonnet-4-6',
        authMethod: 'api-key',
      } as AppSettings['claude'],
    }));
    const settings = settingsStoreModule.getSettings();
    const profile = getMigratedProfile(settings);

    expect(settings.activeProvider).toBe('openrouter');
    expect(profile.profileSource).toBe('connection');
    expect(settings.openRouterProfileSourceMigrationVersion).toBe(1);

    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings,
      model: 'profile:legacy-or',
    });

    expect(decision.kind).toBe('dispatchable');
    if (decision.kind !== 'dispatchable') {
      return;
    }
    expect(decision.transport).toBe('openrouter-proxy');
    expect(decision.credentialSource).toBe('openrouter-oauth-token');
  });

  it('state c: BYOK key present keeps legacy profile unstamped and falls through to resolveProfileApiKey', async () => {
    const settingsStoreModule = await loadSettingsStore(makeSettings({
      providerKeys: {
        openrouter: 'shared-openrouter-key',
      },
    }));
    const settings = settingsStoreModule.getSettings();
    const profile = getMigratedProfile(settings);

    expect(profile.profileSource).toBeUndefined();
    expect(settings.openRouterProfileSourceMigrationVersion).toBeUndefined();

    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings,
      model: 'profile:legacy-or',
    });

    expect(decision.kind).toBe('dispatchable');
    if (decision.kind !== 'dispatchable') {
      return;
    }
    expect(decision.provider).toBe('profile');
    expect(decision.transport).toBe('openai-compatible-http');
    expect(decision.credentialSource).toBe('profile-api-key');
  });
});
