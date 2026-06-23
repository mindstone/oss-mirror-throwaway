import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import {
  CODEX_BTS_PROFILE_ID,
  CODEX_DEFAULT_MODEL,
  CODEX_WORKING_PROFILE_ID,
  repairCodexProfileState,
} from '@shared/utils/codexDefaults';

let persistedStore: Record<string, unknown> | null = null;
let seedStore: Record<string, unknown> = {};
let storeWriteCount = 0;
let readErrorCodesQueue: string[] = [];
let writeErrorCodesQueue: string[] = [];
let readOnly = false;

const makeFsError = (code: string): NodeJS.ErrnoException => {
  const err = new Error(`${code}: too many open files`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
};

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// Faithful to electron-store's `conf` bootstrap, which does a SHALLOW top-level
// merge: `Object.assign({}, defaults, fileStore)` (node_modules/conf/dist/source/index.js
// #initializeStore). A top-level key present in the file/seed (e.g. `models`) wins
// ENTIRELY — it is NOT deep-filled from defaults. A previous deep-merge here was
// unfaithful: now that DEFAULT_SETTINGS ships a `models` block, deep-merge would
// back-fill the full default `models` into partial/absent seeded `models`, masking
// the default-injected-models codex-repair guard under test.
const shallowMerge = (
  base: Record<string, unknown>,
  overrides: Record<string, unknown>
): Record<string, unknown> => ({ ...base, ...deepClone(overrides) });

const codexLegacyProfile = (): ModelProfile => ({
  id: 'codex-gpt-5.4',
  name: 'GPT-5.4 (ChatGPT Pro)',
  authSource: 'codex-subscription',
  model: 'gpt-5.4',
  providerType: 'openai',
  serverUrl: 'https://api.openai.com/v1',
  createdAt: 0,
});

const codexWorkingProfile = (): ModelProfile => ({
  id: CODEX_WORKING_PROFILE_ID,
  name: 'GPT-5.5 (ChatGPT Pro)',
  authSource: 'codex-subscription',
  model: CODEX_DEFAULT_MODEL,
  providerType: 'openai',
  profileSource: 'auto',
  serverUrl: 'https://api.openai.com/v1',
  reasoningEffort: 'high',
  createdAt: 0,
});

const codexWorkingCurrentProdProfile = (): ModelProfile => ({
  id: CODEX_WORKING_PROFILE_ID,
  name: 'GPT-5.5 (ChatGPT Pro)',
  authSource: 'codex-subscription',
  model: CODEX_DEFAULT_MODEL,
  providerType: 'openai',
  routeSurface: 'subscription',
  serverUrl: 'https://api.openai.com/v1',
  reasoningEffort: 'high',
  createdAt: 0,
});

const codexBtsProfile = (): ModelProfile => ({
  id: CODEX_BTS_PROFILE_ID,
  name: 'GPT-5.4 mini (ChatGPT Pro)',
  authSource: 'codex-subscription',
  model: 'gpt-5.4-mini',
  providerType: 'openai',
  profileSource: 'auto',
  serverUrl: 'https://api.openai.com/v1',
  createdAt: 0,
});

const userProfile = (): ModelProfile => ({
  id: 'user-custom-openai',
  name: 'Custom OpenAI',
  providerType: 'openai',
  serverUrl: 'https://example.com/v1',
  model: 'custom-model',
  apiKey: 'profile-key',
  createdAt: 123,
});

 
vi.mock('electron-store', () => ({
  default: class MockStore {
    constructor(opts?: { defaults?: Record<string, unknown> }) {
      if (persistedStore === null) {
        persistedStore = shallowMerge(deepClone(opts?.defaults ?? {}), seedStore);
      }
    }

    get store(): Record<string, unknown> {
      const code = readErrorCodesQueue.shift();
      if (code) throw makeFsError(code);
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
  injection: { readErrors?: string[]; writeErrors?: string[] } = {}
) => {
  vi.resetModules();
  persistedStore = null;
  seedStore = deepClone(seed as Record<string, unknown>);
  storeWriteCount = 0;
  readErrorCodesQueue = [...(injection.readErrors ?? [])];
  writeErrorCodesQueue = [...(injection.writeErrors ?? [])];
  const mod = await import('../settingsStore');
  // The one-shot bootstrap migrations used to run at module-load time; they are
  // now DEFERRED to first settings access (the OSS boot-crash fix —
  // ensureSettingsBootstrapMigrations runs on the first settingsStore.store read).
  // Trigger that first access here so these tests observe boot-migration behaviour
  // exactly as before the import→first-access refactor: a migration that throws
  // (malformed settings / persistent EMFILE / read-only) surfaces from this call,
  // so callers using `await expect(loadSettingsStore(...)).rejects` still work.
  mod.getSettings();
  return mod;
};

const reloadSettingsStoreWithExistingDisk = async () => {
  vi.resetModules();
  storeWriteCount = 0;
  readErrorCodesQueue = [];
  writeErrorCodesQueue = [];
  return import('../settingsStore');
};

describe('settingsStore Codex provider repair migration', () => {
  beforeEach(() => {
    persistedStore = null;
    seedStore = {};
    storeWriteCount = 0;
    readErrorCodesQueue = [];
    writeErrorCodesQueue = [];
    readOnly = false;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('repairs the exact legacy Codex disk state', async () => {
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'codex',
      claude: {
        workingProfileId: null,
        model: 'gpt-5.5',
      } as unknown as AppSettings['claude'],
      localModel: {
        profiles: [codexLegacyProfile()],
        activeProfileId: null,
      },
      behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}`,
    });

    const settings = getSettings();
    const profileIds = settings.localModel?.profiles?.map((profile) => profile.id) ?? [];

    expect(settings.models?.workingProfileId).toBe(CODEX_WORKING_PROFILE_ID);
    expect(settings.models?.model).toBe('gpt-5.5');
    expect(settings.behindTheScenesModel).toBe(`profile:${CODEX_BTS_PROFILE_ID}`);
    expect(profileIds).toContain(CODEX_WORKING_PROFILE_ID);
    expect(profileIds).toContain(CODEX_BTS_PROFILE_ID);
    expect(profileIds).not.toContain('codex-gpt-5.4');
    expect(settings.codexRepairSchemaVersion).toBe(2);
    expect(settings.codexProviderRepairedAt).toEqual(expect.any(Number));
    // 5 writes: codex repair migration + OR provider-heal stamp + models namespace bootstrap
    // (which also runs migrateProfileRouteSurfaces against the post-codex-merge profiles) +
    // OR profileSource migration version stamp (no eligible legacy OR profiles) +
    // BTS auto-profile reroute migration version stamp (260521 BTS Haiku-fallback A3).
    expect(storeWriteCount).toBe(5);
  });

  it('stamps an already-current Codex install once and is a no-op on second boot', async () => {
    const firstLoad = await loadSettingsStore({
      activeProvider: 'codex',
      claude: {
        workingProfileId: CODEX_WORKING_PROFILE_ID,
        model: CODEX_DEFAULT_MODEL,
      } as unknown as AppSettings['claude'],
      localModel: {
        profiles: [codexWorkingProfile(), codexBtsProfile()],
        activeProfileId: null,
      },
      behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}`,
    });

    const firstSettings = deepClone(firstLoad.getSettings());
    expect(firstSettings.codexRepairSchemaVersion).toBe(2);
    expect(firstSettings.codexProviderRepairedAt).toBeUndefined();
    // 5 writes: codex repair stamp + OR provider-heal stamp + models namespace bootstrap
    // (claude→models + routeSurface migration on the seeded profiles) + OR profileSource
    // migration version stamp (no eligible legacy OR profiles) + BTS auto-profile reroute
    // migration version stamp (260521 BTS Haiku-fallback A3).
    expect(storeWriteCount).toBe(5);

    const secondLoad = await reloadSettingsStoreWithExistingDisk();
    expect(secondLoad.getSettings()).toEqual(firstSettings);
    expect(storeWriteCount).toBe(0);
  });

  it('stamps current-prod Codex profiles with profileSource auto without changing other fields', async () => {
    const currentProdProfile = codexWorkingCurrentProdProfile();
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'codex',
      claude: {
        workingProfileId: CODEX_WORKING_PROFILE_ID,
        model: CODEX_DEFAULT_MODEL,
      } as unknown as AppSettings['claude'],
      localModel: {
        profiles: [currentProdProfile],
        activeProfileId: null,
      },
    });

    const workingProfile = getSettings().localModel?.profiles?.find(
      (profile) => profile.id === CODEX_WORKING_PROFILE_ID,
    );
    expect(workingProfile).toEqual({
      ...currentProdProfile,
      profileSource: 'auto',
    });
    expect(getSettings().codexRepairSchemaVersion).toBe(2);
  });

  it('stamps a non-Codex install without repairing provider state', async () => {
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'anthropic',
      claude: {
        model: 'claude-sonnet-4-6',
      } as unknown as AppSettings['claude'],
      localModel: {
        profiles: [codexLegacyProfile()],
        activeProfileId: null,
      },
    });

    const settings = getSettings();
    expect(settings.claude!.model).toBe('claude-sonnet-4-6');
    expect(settings.localModel?.profiles?.map((profile) => profile.id)).toContain('codex-gpt-5.4');
    expect(settings.codexRepairSchemaVersion).toBe(2);
    expect(settings.codexProviderRepairedAt).toBeUndefined();
    // 5 writes: codex repair stamp (no merge for non-Codex provider) + OR provider-heal
    // stamp + models namespace bootstrap (claude→models + routeSurface on seeded legacy profile) +
    // OR profileSource migration version stamp (no eligible legacy OR profiles) + BTS
    // auto-profile reroute migration version stamp (260521 BTS Haiku-fallback A3).
    expect(storeWriteCount).toBe(5);

    await reloadSettingsStoreWithExistingDisk();
    expect(storeWriteCount).toBe(0);
  });

  it('treats the legacy v1 flag as version 1 and still repairs broken Codex state', async () => {
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'codex',
      codexStaleClaudeRepaired: true,
      claude: {
        workingProfileId: null,
        model: 'claude-opus-4-7',
        thinkingModel: 'claude-sonnet-4-6',
      } as unknown as AppSettings['claude'],
      localModel: {
        profiles: [codexLegacyProfile()],
        activeProfileId: null,
      },
      behindTheScenesModel: 'claude-haiku-4-5',
    });

    const settings = getSettings();
    expect(settings.models?.workingProfileId).toBe(CODEX_WORKING_PROFILE_ID);
    expect(settings.models?.model).toBe(CODEX_DEFAULT_MODEL);
    expect(settings.models?.thinkingModel).toBeUndefined();
    expect(settings.behindTheScenesModel).toBe(`profile:${CODEX_BTS_PROFILE_ID}`);
    expect(settings.codexRepairSchemaVersion).toBe(2);
    expect(settings.codexProviderRepairedAt).toEqual(expect.any(Number));
  });

  it('handles a settings file with no claude field', async () => {
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'codex',
      claude: undefined,
    } as unknown as Partial<AppSettings>);

    const settings = getSettings();
    expect(settings.models?.model).toBe(CODEX_DEFAULT_MODEL);
    expect(settings.models?.workingProfileId).toBe(CODEX_WORKING_PROFILE_ID);
    expect(settings.codexRepairSchemaVersion).toBe(2);
    expect(settings.codexProviderRepairedAt).toEqual(expect.any(Number));
  });

  it('preserves user-customized non-auto profiles', async () => {
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'codex',
      claude: {
        workingProfileId: null,
        model: CODEX_DEFAULT_MODEL,
      } as unknown as AppSettings['claude'],
      localModel: {
        profiles: [userProfile(), codexLegacyProfile()],
        activeProfileId: null,
      },
    });

    const profiles = getSettings().localModel?.profiles ?? [];
    expect(profiles.some((profile) => profile.id === 'user-custom-openai')).toBe(true);
    expect(profiles.some((profile) => profile.id === 'codex-gpt-5.4')).toBe(false);
    expect(profiles.some((profile) => profile.id === CODEX_WORKING_PROFILE_ID)).toBe(true);
    expect(profiles.some((profile) => profile.id === CODEX_BTS_PROFILE_ID)).toBe(true);
  });

  it('is idempotent on concurrent-style repeated module loads', async () => {
    const firstLoad = await loadSettingsStore({
      activeProvider: 'codex',
      claude: {
        workingProfileId: null,
        model: 'gpt-5.4',
      } as unknown as AppSettings['claude'],
      localModel: {
        profiles: [codexLegacyProfile()],
        activeProfileId: null,
      },
    });
    const firstSettings = deepClone(firstLoad.getSettings());
    // 5 writes: codex repair migration + OR provider-heal stamp + models namespace bootstrap
    // (routeSurface migration on the post-codex-merge profiles) + OR profileSource migration
    // version stamp (no eligible legacy OR profiles) + BTS auto-profile reroute migration
    // version stamp (260521 BTS Haiku-fallback A3).
    expect(storeWriteCount).toBe(5);

    const secondLoad = await reloadSettingsStoreWithExistingDisk();
    expect(secondLoad.getSettings()).toEqual(firstSettings);
    expect(storeWriteCount).toBe(0);
  });

  it('does not stamp the schema version when read-only mode blocks the migration write', async () => {
    readOnly = true;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await loadSettingsStore({
      activeProvider: 'codex',
      claude: {
        workingProfileId: null,
        model: 'gpt-5.4',
      } as unknown as AppSettings['claude'],
      localModel: {
        profiles: [codexLegacyProfile()],
        activeProfileId: null,
      },
    });

    expect(storeWriteCount).toBe(0);
    expect((persistedStore ?? {}).codexRepairSchemaVersion).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      '[version-gate] Blocked Codex repair migration write on settingsStore — read-only mode'
    );
  });

  it.each<[string, unknown, string]>([
    ['null', null, 'null'],
    ['string', 'not-an-array', 'string'],
  ])('fails closed when localModel.profiles is present but malformed (%s)', async (
    _label,
    profilesValue,
    expectedType
  ) => {
    const expectedError =
      `repairCodexProfileState: localModel.profiles is not an array, got ${expectedType}`;

    await expect(loadSettingsStore({
      activeProvider: 'codex',
      localModel: {
        profiles: profilesValue,
      } as unknown as AppSettings['localModel'],
    })).rejects.toThrow(expectedError);

    expect((persistedStore ?? {}).codexRepairSchemaVersion).toBeUndefined();
    expect(() => repairCodexProfileState({
      activeProvider: 'codex',
      localModel: { profiles: profilesValue } as unknown as AppSettings['localModel'],
    } as AppSettings)).toThrow(expectedError);
  });

  it('throws a structured helper error for malformed localModel.profiles and does not stamp', async () => {
    await expect(loadSettingsStore({
      activeProvider: 'codex',
      localModel: {
        profiles: 'not-an-array',
      } as unknown as AppSettings['localModel'],
    })).rejects.toThrow('repairCodexProfileState: localModel.profiles is not an array, got string');

    expect((persistedStore ?? {}).codexRepairSchemaVersion).toBeUndefined();
    expect(() => repairCodexProfileState({
      activeProvider: 'codex',
      localModel: { profiles: 'not-an-array' } as unknown as AppSettings['localModel'],
    } as AppSettings)).toThrow('repairCodexProfileState: localModel.profiles is not an array, got string');
  });

  it('retries an EMFILE migration write once and stamps after the retry succeeds', async () => {
    await loadSettingsStore({
      activeProvider: 'codex',
      claude: {
        workingProfileId: null,
        model: 'gpt-5.4',
      } as unknown as AppSettings['claude'],
      localModel: {
        profiles: [codexLegacyProfile()],
        activeProfileId: null,
      },
    }, {
      writeErrors: ['EMFILE'],
    });

    // 6 writes: codex EMFILE attempt (counted before the throw) + codex retry
    // success + OR provider-heal stamp + models namespace bootstrap (routeSurface
    // stamp on the merged profiles) + OR profileSource migration version stamp +
    // BTS auto-profile reroute migration version stamp (260521 BTS Haiku-fallback A3).
    expect(storeWriteCount).toBe(6);
    expect((persistedStore ?? {}).codexRepairSchemaVersion).toBe(2);
  });

  it('propagates persistent EMFILE migration write failures without stamping', async () => {
    await expect(loadSettingsStore({
      activeProvider: 'codex',
      claude: {
        workingProfileId: null,
        model: 'gpt-5.4',
      } as unknown as AppSettings['claude'],
      localModel: {
        profiles: [codexLegacyProfile()],
        activeProfileId: null,
      },
    }, {
      writeErrors: ['EMFILE', 'EMFILE'],
    })).rejects.toMatchObject({ code: 'EMFILE' });

    expect(storeWriteCount).toBe(2);
    expect((persistedStore ?? {}).codexRepairSchemaVersion).toBeUndefined();
  });
});

describe('settingsStore Codex thinking-field preservation policy', () => {
  beforeEach(() => {
    persistedStore = null;
    seedStore = {};
    storeWriteCount = 0;
    readErrorCodesQueue = [];
    writeErrorCodesQueue = [];
    readOnly = false;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('preserves a non-Claude thinkingModel during Codex repair migration', async () => {
    // Use a slash-formatted model with a matching profile so the value also
    // survives `normalizeSettings`'s downstream bare-string validation
    // (`settingsUtils.ts:869–905`). Bare unrecognised model names like
    // 'gemini-3.1-pro-preview' would be preserved here but stripped by
    // normalize on next read; this seed mirrors what the UI persists when
    // the user picks a routing-eligible profile.
    const routingProfile: ModelProfile = {
      id: 'profile-deepseek',
      name: 'DeepSeek V4 Pro',
      providerType: 'openai',
      serverUrl: 'https://example.com/v1',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      apiKey: 'fake-key',
      createdAt: 1,
    };
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'codex',
      claude: {
        workingProfileId: null,
        model: 'gpt-5.5',
        thinkingModel: 'deepseek-ai/DeepSeek-V4-Pro',
      } as unknown as AppSettings['claude'],
      localModel: {
        profiles: [routingProfile, codexLegacyProfile()],
        activeProfileId: null,
      },
    });

    const settings = getSettings();
    expect(settings.models?.thinkingModel).toBe('deepseek-ai/DeepSeek-V4-Pro');
    expect(settings.models?.workingProfileId).toBe(CODEX_WORKING_PROFILE_ID);
    expect(settings.codexRepairSchemaVersion).toBe(2);
  });

  it('preserves a thinkingProfileId pointing at a non-Claude profile that survives mergeCodexProfiles', async () => {
    const routingProfile: ModelProfile = {
      id: 'profile-routing-X',
      name: 'Gemini 3.1 Pro',
      providerType: 'openai',
      serverUrl: 'https://example.com/v1',
      model: 'gemini-3.1-pro-preview',
      apiKey: 'fake-key',
      createdAt: 1,
    };
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'codex',
      claude: {
        workingProfileId: null,
        model: 'gpt-5.5',
        thinkingProfileId: 'profile-routing-X',
      } as unknown as AppSettings['claude'],
      localModel: {
        profiles: [routingProfile, codexLegacyProfile()],
        activeProfileId: null,
      },
    });

    const settings = getSettings();
    expect(settings.models?.thinkingProfileId).toBe('profile-routing-X');
    expect(settings.models?.thinkingModel).toBeUndefined();
  });

  it('clears thinkingProfileId when the referenced profile points at a surviving Claude-typed profile', async () => {
    const claudeProfile: ModelProfile = {
      id: 'profile-claude-X',
      name: 'My Claude',
      providerType: 'anthropic',
      serverUrl: 'https://api.anthropic.com',
      model: 'claude-opus-4-7',
      apiKey: 'fake-anthropic-key',
      createdAt: 1,
    };
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'codex',
      claude: {
        workingProfileId: null,
        model: 'gpt-5.5',
        thinkingProfileId: 'profile-claude-X',
      } as unknown as AppSettings['claude'],
      localModel: {
        profiles: [claudeProfile, codexLegacyProfile()],
        activeProfileId: null,
      },
    });

    const settings = getSettings();
    expect(settings.models?.thinkingProfileId).toBeUndefined();
    // The Claude profile itself is preserved — only the selection is cleared.
    const profileIds = settings.localModel?.profiles?.map((p) => p.id) ?? [];
    expect(profileIds).toContain('profile-claude-X');
  });

  it('clears thinkingProfileId when the referenced profile is dropped by mergeCodexProfiles', async () => {
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'codex',
      claude: {
        workingProfileId: null,
        model: 'gpt-5.5',
        thinkingProfileId: 'codex-gpt-5.4',
      } as unknown as AppSettings['claude'],
      localModel: {
        profiles: [codexLegacyProfile()],
        activeProfileId: null,
      },
    });

    const settings = getSettings();
    expect(settings.models?.thinkingProfileId).toBeUndefined();
  });

  it('clears thinkingModel when it names a stale Codex default', async () => {
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'codex',
      claude: {
        workingProfileId: null,
        model: 'gpt-5.5',
        thinkingModel: 'gpt-5.4',
      } as unknown as AppSettings['claude'],
      localModel: {
        profiles: [codexLegacyProfile()],
        activeProfileId: null,
      },
    });

    const settings = getSettings();
    expect(settings.models?.thinkingModel).toBeUndefined();
  });

  it('preserves a non-Claude thinkingModel when migration runs against already-current state', async () => {
    // Do NOT seed codexRepairSchemaVersion — the migration must run so the
    // helper actually executes. With currently-correct working profile/model
    // and a valid non-Claude thinkingProfileId+thinkingModel, the helper
    // should return false (preserve), and `repairCodexProfileState` should
    // detect no diff in working/model and emit no `changes.models` write.
    // The version stamp is the only write — and since `result?.repaired`
    // stays false, `codexProviderRepairedAt` remains undefined.
    const routingProfile: ModelProfile = {
      id: 'profile-deepseek',
      name: 'DeepSeek V4 Pro',
      providerType: 'openai',
      serverUrl: 'https://example.com/v1',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      apiKey: 'fake-key',
      createdAt: 1,
    };
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'codex',
      claude: {
        workingProfileId: CODEX_WORKING_PROFILE_ID,
        model: CODEX_DEFAULT_MODEL,
        thinkingProfileId: 'profile-deepseek',
        thinkingModel: 'deepseek-ai/DeepSeek-V4-Pro',
      } as unknown as AppSettings['claude'],
      localModel: {
        profiles: [routingProfile, codexWorkingProfile(), codexBtsProfile()],
        activeProfileId: null,
      },
      behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}`,
    });

    const settings = getSettings();
    expect(settings.models?.thinkingProfileId).toBe('profile-deepseek');
    expect(settings.models?.thinkingModel).toBe('deepseek-ai/DeepSeek-V4-Pro');
    expect(settings.codexRepairSchemaVersion).toBe(2);
    expect(settings.codexProviderRepairedAt).toBeUndefined();
  });

  it('clears both thinking fields when thinkingProfileId is dangling and thinkingModel is otherwise valid (mixed-trigger)', async () => {
    // Conservative-clear policy: if any reference is broken, clear both.
    // Pinned by a test so future "minor" refactors can't silently regress
    // to a per-field decision that would leave one stale field around.
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'codex',
      claude: {
        workingProfileId: null,
        model: 'gpt-5.5',
        thinkingProfileId: 'codex-gpt-5.4',
        thinkingModel: 'deepseek-ai/DeepSeek-V4-Pro',
      } as unknown as AppSettings['claude'],
      localModel: {
        profiles: [codexLegacyProfile()],
        activeProfileId: null,
      },
    });

    const settings = getSettings();
    expect(settings.models?.thinkingProfileId).toBeUndefined();
    expect(settings.models?.thinkingModel).toBeUndefined();
  });
});
