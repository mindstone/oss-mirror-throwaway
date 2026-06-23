import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import type { Logger } from '@core/logger';

let persistedStore: Record<string, unknown> | null = null;
let seedStore: Record<string, unknown> = {};
let storeWriteCount = 0;
let writeErrorCodesQueue: string[] = [];
let readOnly = false;

const makeFsError = (code: string): NodeJS.ErrnoException => {
  const err = new Error(`${code}: too many open files`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
};

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

const migrationLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

const makeLegacyOpenRouterProfile = (
  id: string,
  overrides: Partial<ModelProfile> = {},
): ModelProfile => ({
  id,
  name: `OpenRouter ${id}`,
  providerType: 'openrouter',
  routeSurface: 'pool',
  serverUrl: 'https://openrouter.ai/api/v1',
  model: 'anthropic/claude-sonnet-4-6',
  createdAt: 1_700_000_000_000,
  enabled: true,
  ...overrides,
});

const makeSettings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
  activeProvider: 'openrouter',
  codexRepairSchemaVersion: 2,
  openRouterProviderHealVersion: 1,
  modelsNamespaceSchemaVersion: 2,
  openRouter: {
    enabled: true,
    oauthToken: 'fake-or-token',
    selectedModel: 'anthropic/claude-sonnet-4-6',
  },
  providerKeys: {},
  localModel: {
    activeProfileId: null,
    profiles: [],
  },
  ...overrides,
} as AppSettings);

const profileById = (settings: AppSettings, id: string): ModelProfile => {
  const profile = settings.localModel?.profiles?.find((entry) => entry.id === id);
  if (!profile) {
    throw new Error(`Missing profile ${id}`);
  }
  return profile;
};

const expectProfileUnchanged = (after: ModelProfile, original: ModelProfile): void => {
  expect(after.apiKey).toBe(original.apiKey);
  expect(after.customProviderId).toBe(original.customProviderId);
  expect(after.routeSurface).toBe(original.routeSurface);
  expect(after.model).toBe(original.model);
  expect(after.providerType).toBe(original.providerType);
  expect(after.createdAt).toBe(original.createdAt);
  expect(after.enabled).toBe(original.enabled);
  expect(after.id).toBe(original.id);
  expect((after as unknown as Record<string, unknown>).updatedAt).toBeUndefined();
  expect(after).toEqual(original);
};

const expectOnlyProfileSourceChangedToConnection = (
  after: ModelProfile,
  original: ModelProfile,
): void => {
  expect(after.profileSource).toBe('connection');
  expect(after.apiKey).toBe(original.apiKey);
  expect(after.customProviderId).toBe(original.customProviderId);
  expect(after.routeSurface).toBe(original.routeSurface);
  expect(after.model).toBe(original.model);
  expect(after.providerType).toBe(original.providerType);
  expect(after.createdAt).toBe(original.createdAt);
  expect(after.enabled).toBe(original.enabled);
  expect(after.id).toBe(original.id);
  expect((after as unknown as Record<string, unknown>).updatedAt).toBeUndefined();
  expect(after).toEqual({ ...original, profileSource: 'connection' });
};

 
vi.mock('electron-store', () => ({
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
      storeWriteCount++;
      const code = writeErrorCodesQueue.shift();
      if (code) throw makeFsError(code);
      persistedStore = deepClone(value);
    }

    get(key: string): unknown {
      return (persistedStore ?? {})[key];
    }

    set(key: string, value: unknown): void {
      persistedStore = { ...(persistedStore ?? {}), [key]: deepClone(value) };
      storeWriteCount++;
    }

    delete(key: string): void {
      const next = { ...(persistedStore ?? {}) };
      delete next[key];
      persistedStore = next;
      storeWriteCount++;
    }

    clear(): void {
      persistedStore = {};
      storeWriteCount++;
    }
  },
}));

 
vi.mock('@core/userDataWriteGate', () => ({
  isUserDataReadOnly: () => readOnly,
}));

const loadSettingsStore = async (
  seed: Partial<AppSettings> = {},
  injection: { writeErrors?: string[] } = {},
) => {
  vi.resetModules();
  persistedStore = null;
  seedStore = deepClone(seed as Record<string, unknown>);
  storeWriteCount = 0;
  writeErrorCodesQueue = [...(injection.writeErrors ?? [])];
  const mod = await import('../settingsStore');
  // Bootstrap migrations are now DEFERRED to first settings access (OSS
  // boot-crash fix) instead of running at module load. Trigger them here so the
  // boot migration (and any injected write-error queue) is consumed at this
  // point, exactly as it was at import before the refactor.
  mod.getSettings();
  return mod;
};

const reloadSettingsStoreWithExistingDisk = async () => {
  vi.resetModules();
  storeWriteCount = 0;
  writeErrorCodesQueue = [];
  const mod = await import('../settingsStore');
  // Same deferred-boot trigger as loadSettingsStore: fire the first settings
  // access so the second-boot migration runs before counts are inspected.
  mod.getSettings();
  return mod;
};

describe('settingsStore OpenRouter profileSource migration', () => {
  beforeEach(() => {
    persistedStore = null;
    seedStore = {};
    storeWriteCount = 0;
    writeErrorCodesQueue = [];
    readOnly = false;
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('applyOpenRouterProfileSourceMigration', () => {
    it('stamps Angus-shape legacy OpenRouter profiles and migration version', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        localModel: {
          activeProfileId: null,
          profiles: [
            makeLegacyOpenRouterProfile('or-1'),
            makeLegacyOpenRouterProfile('or-2'),
            makeLegacyOpenRouterProfile('or-3'),
            makeLegacyOpenRouterProfile('or-4'),
          ],
        },
      });
      const originals = (input.localModel?.profiles ?? []).map((profile) => deepClone(profile));

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);

      expect(result.stamped).toBe(4);
      expect(result.migrated.openRouterProfileSourceMigrationVersion).toBe(1);
      const migratedProfiles = result.migrated.localModel?.profiles ?? [];
      expect(migratedProfiles).toHaveLength(4);
      migratedProfiles.forEach((profile, index) => {
        expectOnlyProfileSourceChangedToConnection(profile, originals[index] as ModelProfile);
      });
    });

    it('is idempotent when re-run after version is already stamped', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        openRouterProfileSourceMigrationVersion: 1,
        localModel: {
          activeProfileId: null,
          profiles: [
            makeLegacyOpenRouterProfile('already-migrated', { profileSource: 'connection' }),
          ],
        },
      });
      const originalProfile = deepClone(input.localModel?.profiles?.[0]) as ModelProfile;

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);

      expect(result.stamped).toBe(0);
      expect(result.migrated.localModel?.profiles).toEqual(input.localModel?.profiles);
      expect(result.migrated.openRouterProfileSourceMigrationVersion)
        .toBe(input.openRouterProfileSourceMigrationVersion);
      expectProfileUnchanged(profileById(result.migrated, 'already-migrated'), originalProfile);
    });

    it('does not stamp profiles with explicit apiKey values', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        localModel: {
          activeProfileId: null,
          profiles: [
            makeLegacyOpenRouterProfile('excluded-api-key', { apiKey: 'profile-byok' }),
            makeLegacyOpenRouterProfile('eligible'),
          ],
        },
      });
      const excludedOriginal = deepClone(profileById(input, 'excluded-api-key'));
      const eligibleOriginal = deepClone(profileById(input, 'eligible'));

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);
      const excludedAfter = profileById(result.migrated, 'excluded-api-key');
      const eligibleAfter = profileById(result.migrated, 'eligible');

      expect(result.stamped).toBe(1);
      expectProfileUnchanged(excludedAfter, excludedOriginal);
      expectOnlyProfileSourceChangedToConnection(eligibleAfter, eligibleOriginal);
    });

    it('does not stamp profiles with customProviderId values', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        localModel: {
          activeProfileId: null,
          profiles: [
            makeLegacyOpenRouterProfile('excluded-custom-provider', { customProviderId: 'custom-provider-1' }),
            makeLegacyOpenRouterProfile('eligible'),
          ],
        },
      });
      const excludedOriginal = deepClone(profileById(input, 'excluded-custom-provider'));
      const eligibleOriginal = deepClone(profileById(input, 'eligible'));

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);
      const excludedAfter = profileById(result.migrated, 'excluded-custom-provider');
      const eligibleAfter = profileById(result.migrated, 'eligible');

      expect(result.stamped).toBe(1);
      expectProfileUnchanged(excludedAfter, excludedOriginal);
      expectOnlyProfileSourceChangedToConnection(eligibleAfter, eligibleOriginal);
    });

    it('treats whitespace-only customProviderId as absent and stamps', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        localModel: {
          activeProfileId: null,
          profiles: [
            makeLegacyOpenRouterProfile('whitespace-custom-provider', { customProviderId: '   ' }),
          ],
        },
      });
      const original = deepClone(profileById(input, 'whitespace-custom-provider'));

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);

      expect(result.stamped).toBe(1);
      expectOnlyProfileSourceChangedToConnection(
        profileById(result.migrated, 'whitespace-custom-provider'),
        original,
      );
    });

    it('does not stamp profiles already marked as user, connection, or auto', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        localModel: {
          activeProfileId: null,
          profiles: [
            makeLegacyOpenRouterProfile('already-user', { profileSource: 'user' }),
            makeLegacyOpenRouterProfile('already-connection', { profileSource: 'connection' }),
            makeLegacyOpenRouterProfile('already-auto', { profileSource: 'auto' }),
            makeLegacyOpenRouterProfile('eligible'),
          ],
        },
      });
      const alreadyUserOriginal = deepClone(profileById(input, 'already-user'));
      const alreadyConnectionOriginal = deepClone(profileById(input, 'already-connection'));
      const alreadyAutoOriginal = deepClone(profileById(input, 'already-auto'));
      const eligibleOriginal = deepClone(profileById(input, 'eligible'));

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);
      const alreadyUserAfter = profileById(result.migrated, 'already-user');
      const alreadyConnectionAfter = profileById(result.migrated, 'already-connection');
      const alreadyAutoAfter = profileById(result.migrated, 'already-auto');
      const eligibleAfter = profileById(result.migrated, 'eligible');

      expect(result.stamped).toBe(1);
      expectProfileUnchanged(alreadyUserAfter, alreadyUserOriginal);
      expectProfileUnchanged(alreadyConnectionAfter, alreadyConnectionOriginal);
      expectProfileUnchanged(alreadyAutoAfter, alreadyAutoOriginal);
      expectOnlyProfileSourceChangedToConnection(eligibleAfter, eligibleOriginal);
    });

    it('treats profileSource null as unset and stamps it', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        localModel: {
          activeProfileId: null,
          profiles: [
            makeLegacyOpenRouterProfile('null-source', { profileSource: null as unknown as ModelProfile['profileSource'] }),
          ],
        },
      });
      const original = deepClone(profileById(input, 'null-source'));

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);

      expect(result.stamped).toBe(1);
      expectOnlyProfileSourceChangedToConnection(profileById(result.migrated, 'null-source'), original);
    });

    it('does not stamp non-openrouter provider profiles', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        localModel: {
          activeProfileId: null,
          profiles: [
            makeLegacyOpenRouterProfile('non-or', {
              providerType: 'openai',
              apiKey: undefined,
            }),
          ],
        },
      });
      const original = deepClone(profileById(input, 'non-or'));

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);

      expect(result.stamped).toBe(0);
      expectProfileUnchanged(profileById(result.migrated, 'non-or'), original);
      expect(result.migrated.openRouterProfileSourceMigrationVersion).toBe(1);
    });

    it('honors BYOK precedence and leaves legacy OR profiles untouched when providerKeys.openrouter is set', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        providerKeys: { openrouter: 'shared-openrouter-key' },
        localModel: {
          activeProfileId: null,
          profiles: [
            makeLegacyOpenRouterProfile('legacy-or'),
          ],
        },
      });
      const original = deepClone(profileById(input, 'legacy-or'));

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);

      expect(result.stamped).toBe(0);
      expectProfileUnchanged(profileById(result.migrated, 'legacy-or'), original);
      expect(result.migrated.openRouterProfileSourceMigrationVersion).toBeUndefined();
    });

    it('whitespace-only providerKeys.openrouter is treated as missing — does NOT trigger BYOK precedence', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        providerKeys: { openrouter: '   ' },
        localModel: {
          activeProfileId: null,
          profiles: [makeLegacyOpenRouterProfile('legacy-or')],
        },
      });
      const original = deepClone(profileById(input, 'legacy-or'));

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);

      expect(result.stamped).toBe(1);
      expectOnlyProfileSourceChangedToConnection(profileById(result.migrated, 'legacy-or'), original);
      expect(result.migrated.openRouterProfileSourceMigrationVersion).toBe(1);
    });

    it('does not stamp or version-bump when OAuth token is missing and eligible profiles remain', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        openRouter: {
          enabled: false,
          oauthToken: null,
          selectedModel: 'anthropic/claude-sonnet-4-6',
        },
        localModel: {
          activeProfileId: null,
          profiles: [makeLegacyOpenRouterProfile('legacy-or')],
        },
      });
      const original = deepClone(profileById(input, 'legacy-or'));

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);

      expect(result.stamped).toBe(0);
      expectProfileUnchanged(profileById(result.migrated, 'legacy-or'), original);
      expect(result.migrated.openRouterProfileSourceMigrationVersion).toBeUndefined();
    });

    it('whitespace-only openRouter.oauthToken is treated as missing — no profiles stamped', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        openRouter: {
          enabled: true,
          oauthToken: '   ',
          selectedModel: 'anthropic/claude-sonnet-4-6',
        },
        localModel: {
          activeProfileId: null,
          profiles: [makeLegacyOpenRouterProfile('legacy-or')],
        },
      });
      const original = deepClone(profileById(input, 'legacy-or'));

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);

      expect(result.stamped).toBe(0);
      expectProfileUnchanged(profileById(result.migrated, 'legacy-or'), original);
      expect(result.migrated.openRouterProfileSourceMigrationVersion).toBeUndefined();
    });

    it('whitespace-only profile.apiKey is treated as missing — profile IS stamped (eligible)', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        localModel: {
          activeProfileId: null,
          profiles: [makeLegacyOpenRouterProfile('whitespace-api-key', { apiKey: '   ' })],
        },
      });
      const original = deepClone(profileById(input, 'whitespace-api-key'));

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);

      expect(result.stamped).toBe(1);
      expectOnlyProfileSourceChangedToConnection(
        profileById(result.migrated, 'whitespace-api-key'),
        original,
      );
      expect(result.migrated.openRouterProfileSourceMigrationVersion).toBe(1);
    });

    it('version-bumps when there are no eligible profiles and no token', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        openRouter: {
          enabled: false,
          oauthToken: null,
          selectedModel: 'anthropic/claude-sonnet-4-6',
        },
        localModel: {
          activeProfileId: null,
          profiles: [
            makeLegacyOpenRouterProfile('already-user', { profileSource: 'user' }),
            makeLegacyOpenRouterProfile('already-connection', { profileSource: 'connection' }),
          ],
        },
      });
      const alreadyUserOriginal = deepClone(profileById(input, 'already-user'));
      const alreadyConnectionOriginal = deepClone(profileById(input, 'already-connection'));

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);

      expect(result.stamped).toBe(0);
      expectProfileUnchanged(profileById(result.migrated, 'already-user'), alreadyUserOriginal);
      expectProfileUnchanged(profileById(result.migrated, 'already-connection'), alreadyConnectionOriginal);
      expect(result.migrated.openRouterProfileSourceMigrationVersion).toBe(1);
    });

    it('stamps only legacy OR rows in mixed lists', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        localModel: {
          activeProfileId: null,
          profiles: [
            makeLegacyOpenRouterProfile('legacy-1'),
            makeLegacyOpenRouterProfile('already-connection', { profileSource: 'connection' }),
            makeLegacyOpenRouterProfile('user', { profileSource: 'user' }),
            makeLegacyOpenRouterProfile('non-or', {
              providerType: 'openai',
              apiKey: undefined,
            }),
          ],
        },
      });
      const legacyOriginal = deepClone(profileById(input, 'legacy-1'));
      const alreadyConnectionOriginal = deepClone(profileById(input, 'already-connection'));
      const userOriginal = deepClone(profileById(input, 'user'));
      const nonOrOriginal = deepClone(profileById(input, 'non-or'));

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);

      expect(result.stamped).toBe(1);
      expectOnlyProfileSourceChangedToConnection(profileById(result.migrated, 'legacy-1'), legacyOriginal);
      expectProfileUnchanged(profileById(result.migrated, 'already-connection'), alreadyConnectionOriginal);
      expectProfileUnchanged(profileById(result.migrated, 'user'), userOriginal);
      expectProfileUnchanged(profileById(result.migrated, 'non-or'), nonOrOriginal);
    });

    it('stamps disabled legacy OR profiles', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        localModel: {
          activeProfileId: null,
          profiles: [
            makeLegacyOpenRouterProfile('disabled', { enabled: false }),
          ],
        },
      });
      const original = deepClone(profileById(input, 'disabled'));

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);

      expect(result.stamped).toBe(1);
      expectOnlyProfileSourceChangedToConnection(profileById(result.migrated, 'disabled'), original);
    });

    it('stamps profiles even when createdAt is missing', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        localModel: {
          activeProfileId: null,
          profiles: [
            {
              id: 'missing-created-at',
              name: 'Missing createdAt',
              providerType: 'openrouter',
              routeSurface: 'pool',
              serverUrl: 'https://openrouter.ai/api/v1',
              model: 'anthropic/claude-sonnet-4-6',
              enabled: true,
            } as ModelProfile,
          ],
        },
      });
      const original = deepClone(profileById(input, 'missing-created-at'));

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);

      expect(result.stamped).toBe(1);
      expectOnlyProfileSourceChangedToConnection(
        profileById(result.migrated, 'missing-created-at'),
        original,
      );
    });

    it('stamps legacy OR profiles regardless of routeSurface value', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        localModel: {
          activeProfileId: null,
          profiles: [
            makeLegacyOpenRouterProfile('route-surface-api-key', { routeSurface: 'api-key' }),
          ],
        },
      });
      const original = deepClone(profileById(input, 'route-surface-api-key'));

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);

      expect(result.stamped).toBe(1);
      expectOnlyProfileSourceChangedToConnection(
        profileById(result.migrated, 'route-surface-api-key'),
        original,
      );
    });

    it('profile referencing a model not in the current OR catalog is still stamped', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        localModel: {
          activeProfileId: null,
          profiles: [
            makeLegacyOpenRouterProfile('unknown-model', { model: 'openrouter/nonexistent-model-v999' }),
          ],
        },
      });
      const original = deepClone(profileById(input, 'unknown-model'));

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);

      expect(result.stamped).toBe(1);
      expectOnlyProfileSourceChangedToConnection(profileById(result.migrated, 'unknown-model'), original);
    });

    it.each([
      {
        label: 'localModel is undefined',
        settings: makeSettings({ localModel: undefined }),
      },
      {
        label: 'localModel.profiles is undefined',
        settings: makeSettings({
          localModel: { activeProfileId: null, profiles: undefined } as unknown as AppSettings['localModel'],
        }),
      },
      {
        label: 'localModel.profiles is empty',
        settings: makeSettings({ localModel: { activeProfileId: null, profiles: [] } }),
      },
    ])('handles defensive shape: $label', async ({ settings }) => {
      const settingsStoreModule = await loadSettingsStore();
      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(settings, migrationLog);
      expect(result.stamped).toBe(0);
      expect(result.migrated.localModel?.profiles).toEqual(settings.localModel?.profiles);
      expect(result.migrated.openRouterProfileSourceMigrationVersion).toBe(1);
    });

    it('handles defensive shape: localModel.profiles includes a null row', async () => {
      const settingsStoreModule = await loadSettingsStore();
      const input = makeSettings({
        localModel: {
          activeProfileId: null,
          profiles: [null] as unknown as ModelProfile[],
        },
      });

      const result = settingsStoreModule.applyOpenRouterProfileSourceMigration(input, migrationLog);
      expect(result.stamped).toBe(0);
      expect(result.migrated.localModel?.profiles).toEqual(input.localModel?.profiles);
      expect(result.migrated.openRouterProfileSourceMigrationVersion).toBe(1);
    });
  });

  describe('bootstrapOpenRouterProfileSourceMigration', () => {
    it('is exported for direct invocation and no-ops when already stamped', async () => {
      const settingsStoreModule = await loadSettingsStore({
        ...makeSettings(),
        openRouterProfileSourceMigrationVersion: 1,
      });
      storeWriteCount = 0;

      settingsStoreModule.bootstrapOpenRouterProfileSourceMigration();

      expect(storeWriteCount).toBe(0);
    });

    it('does not write in read-only mode', async () => {
      readOnly = true;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await loadSettingsStore({
          ...makeSettings(),
          localModel: {
            activeProfileId: null,
            profiles: [makeLegacyOpenRouterProfile('legacy-or')],
          },
        });

        expect(storeWriteCount).toBe(0);
        expect((persistedStore ?? {}).openRouterProfileSourceMigrationVersion).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(
          '[version-gate] Blocked OR profileSource migration write on settingsStore — read-only mode',
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('retries once on EMFILE and persists the migration write', async () => {
      await loadSettingsStore({
        ...makeSettings(),
        localModel: {
          activeProfileId: null,
          profiles: [makeLegacyOpenRouterProfile('legacy-or')],
        },
      }, {
        writeErrors: ['EMFILE'],
      });

      // 1 OR migration write attempt, 1 EMFILE retry, 1 BTS auto-profile
      // reroute migration write (260521 BTS Haiku-fallback A3, stamps
      // version on first boot).
      expect(storeWriteCount).toBe(3);
      expect((persistedStore ?? {}).openRouterProfileSourceMigrationVersion).toBe(1);
      const profiles = ((persistedStore ?? {}).localModel as { profiles?: Array<{ profileSource?: string }> } | undefined)?.profiles ?? [];
      expect(profiles[0]?.profileSource).toBe('connection');
    });

    it('stamps after OAuth token appears on a later boot when eligible profiles remained unstamped', async () => {
      const firstBoot = await loadSettingsStore({
        ...makeSettings({
          openRouter: {
            enabled: false,
            oauthToken: null,
            selectedModel: 'anthropic/claude-sonnet-4-6',
          },
          localModel: {
            activeProfileId: null,
            profiles: [makeLegacyOpenRouterProfile('legacy-or')],
          },
        }),
      });

      expect(firstBoot.getSettings().openRouterProfileSourceMigrationVersion).toBeUndefined();
      expect(profileById(firstBoot.getSettings(), 'legacy-or').profileSource).toBeUndefined();

      const currentDisk = deepClone(persistedStore ?? {});
      persistedStore = deepMerge(currentDisk, {
        openRouter: {
          enabled: true,
          oauthToken: 'fake-new-token',
          selectedModel: 'anthropic/claude-sonnet-4-6',
        },
      });

      const secondBoot = await reloadSettingsStoreWithExistingDisk();
      expect(secondBoot.getSettings().openRouterProfileSourceMigrationVersion).toBe(1);
      expect(profileById(secondBoot.getSettings(), 'legacy-or').profileSource).toBe('connection');

      await reloadSettingsStoreWithExistingDisk();
      expect(storeWriteCount).toBe(0);
    });

    it('stamps after BYOK key is removed on a later boot', async () => {
      const firstBoot = await loadSettingsStore({
        ...makeSettings({
          providerKeys: { openrouter: 'shared-openrouter-key' },
          localModel: {
            activeProfileId: null,
            profiles: [makeLegacyOpenRouterProfile('legacy-or')],
          },
        }),
      });

      expect(firstBoot.getSettings().openRouterProfileSourceMigrationVersion).toBeUndefined();
      expect(profileById(firstBoot.getSettings(), 'legacy-or').profileSource).toBeUndefined();

      const currentDisk = deepClone(persistedStore ?? {});
      persistedStore = deepMerge(currentDisk, {
        providerKeys: {
          openrouter: '',
        },
      });

      const secondBoot = await reloadSettingsStoreWithExistingDisk();
      expect(secondBoot.getSettings().openRouterProfileSourceMigrationVersion).toBe(1);
      expect(profileById(secondBoot.getSettings(), 'legacy-or').profileSource).toBe('connection');
    });
  });
});
