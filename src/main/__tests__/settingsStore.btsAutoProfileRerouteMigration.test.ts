import type { AppSettings, ModelProfile } from '@shared/types';
import type { Logger } from '@core/logger';
import {
  CODEX_BTS_PROFILE_ID,
  CODEX_WORKING_PROFILE_ID,
} from '@shared/utils/codexDefaults';

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

const migrationLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

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
      persistedStore = deepClone(value);
    }

    get(key: string): unknown {
      return (persistedStore ?? {})[key];
    }

    set(key: string, value: unknown): void {
      persistedStore = { ...(persistedStore ?? {}), [key]: deepClone(value) };
    }

    delete(key: string): void {
      const next = { ...(persistedStore ?? {}) };
      delete next[key];
      persistedStore = next;
    }

    clear(): void {
      persistedStore = {};
    }
  },
}));

const loadSettingsStore = async () => {
  vi.resetModules();
  persistedStore = null;
  seedStore = {};
  return import('../settingsStore');
};

const makeAutoProfile = (
  id: string,
  overrides: Partial<ModelProfile> = {},
): ModelProfile => ({
  id,
  name: 'GPT-5.4 mini (ChatGPT Pro)',
  authSource: 'codex-subscription',
  model: 'gpt-5.4-mini',
  providerType: 'openai',
  serverUrl: 'https://api.openai.com/v1',
  createdAt: 0,
  ...overrides,
});

const makeConnectionSibling = (
  id: string,
  overrides: Partial<ModelProfile> = {},
): ModelProfile => ({
  id,
  name: 'GPT-5.4 mini',
  authSource: 'codex-subscription',
  model: 'gpt-5.4-mini',
  providerType: 'openai',
  profileSource: 'connection',
  routeSurface: 'subscription',
  serverUrl: 'https://api.openai.com/v1',
  jsonCompatibility: 'compatible',
  chatCompatibility: 'compatible',
  toolUseCompatibility: 'compatible',
  createdAt: 1_700_000_000_000,
  ...overrides,
});

const makeWorkingAutoProfile = (
  overrides: Partial<ModelProfile> = {},
): ModelProfile => ({
  id: CODEX_WORKING_PROFILE_ID,
  name: 'GPT-5.5 (ChatGPT Pro)',
  authSource: 'codex-subscription',
  model: 'gpt-5.5',
  providerType: 'openai',
  profileSource: 'auto',
  serverUrl: 'https://api.openai.com/v1',
  createdAt: 0,
  ...overrides,
});

const makeWorkingConnectionSibling = (
  id: string,
  overrides: Partial<ModelProfile> = {},
): ModelProfile => ({
  id,
  name: 'GPT-5.5',
  authSource: 'codex-subscription',
  model: 'gpt-5.5',
  providerType: 'openai',
  profileSource: 'connection',
  routeSurface: 'subscription',
  serverUrl: 'https://api.openai.com/v1',
  jsonCompatibility: 'compatible',
  chatCompatibility: 'compatible',
  toolUseCompatibility: 'compatible',
  createdAt: 1_700_000_000_000,
  ...overrides,
});

const makeSettings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
  activeProvider: 'codex',
  modelsNamespaceSchemaVersion: 2,
  codexRepairSchemaVersion: 2,
  openRouterProviderHealVersion: 1,
  openRouterProfileSourceMigrationVersion: 1,
  localModel: {
    activeProfileId: null,
    profiles: [],
  },
  ...overrides,
} as AppSettings);

describe('applyBtsAutoProfileRerouteMigration', () => {
  beforeEach(() => {
    persistedStore = null;
    seedStore = {};
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('reroutes resolver target fields when sibling is healthy', () => {
    it('rewrites behindTheScenesModel from auto to sibling', async () => {
      const { applyBtsAutoProfileRerouteMigration } = await loadSettingsStore();
      const sibling = makeConnectionSibling('connection-bts-1');
      const input = makeSettings({
        behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}`,
        localModel: {
          activeProfileId: null,
          profiles: [makeAutoProfile(CODEX_BTS_PROFILE_ID), sibling],
        },
      });

      const { migrated, rewrites } = applyBtsAutoProfileRerouteMigration(input, migrationLog);

      expect(rewrites).toBe(1);
      expect(migrated.behindTheScenesModel).toBe(`profile:${sibling.id}`);
      expect(migrated.btsAutoProfileRerouteSchemaVersion).toBe(1);
    });

    it('rewrites all 5 resolver target slots in one pass (BTS + 2 overrides + working + thinking)', async () => {
      const { applyBtsAutoProfileRerouteMigration } = await loadSettingsStore();
      const btsSibling = makeConnectionSibling('connection-bts-1');
      const workingSibling = makeWorkingConnectionSibling('connection-working-1');
      const input = makeSettings({
        behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}`,
        behindTheScenesOverrides: {
          memory: `profile:${CODEX_BTS_PROFILE_ID}`,
          coaching: `profile:${CODEX_WORKING_PROFILE_ID}`,
        },
        models: {
          workingProfileId: CODEX_WORKING_PROFILE_ID,
          thinkingProfileId: CODEX_WORKING_PROFILE_ID,
        } as NonNullable<AppSettings['models']>,
        localModel: {
          activeProfileId: null,
          profiles: [
            makeAutoProfile(CODEX_BTS_PROFILE_ID),
            makeWorkingAutoProfile(),
            btsSibling,
            workingSibling,
          ],
        },
      });

      const { migrated, rewrites } = applyBtsAutoProfileRerouteMigration(input, migrationLog);

      expect(rewrites).toBe(5);
      expect(migrated.behindTheScenesModel).toBe(`profile:${btsSibling.id}`);
      expect(migrated.behindTheScenesOverrides?.memory).toBe(`profile:${btsSibling.id}`);
      expect(migrated.behindTheScenesOverrides?.coaching).toBe(`profile:${workingSibling.id}`);
      expect(migrated.models?.workingProfileId).toBe(workingSibling.id);
      expect(migrated.models?.thinkingProfileId).toBe(workingSibling.id);
    });
  });

  describe('leaves resolver target untouched when sibling is unsuitable', () => {
    it('no sibling exists', async () => {
      const { applyBtsAutoProfileRerouteMigration } = await loadSettingsStore();
      const input = makeSettings({
        behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}`,
        localModel: {
          activeProfileId: null,
          profiles: [makeAutoProfile(CODEX_BTS_PROFILE_ID)],
        },
      });

      const { migrated, rewrites } = applyBtsAutoProfileRerouteMigration(input, migrationLog);

      expect(rewrites).toBe(0);
      expect(migrated.behindTheScenesModel).toBe(`profile:${CODEX_BTS_PROFILE_ID}`);
      expect(migrated.btsAutoProfileRerouteSchemaVersion).toBe(1);
    });

    it('sibling is disabled', async () => {
      const { applyBtsAutoProfileRerouteMigration } = await loadSettingsStore();
      const sibling = makeConnectionSibling('connection-bts-1', { enabled: false });
      const input = makeSettings({
        behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}`,
        localModel: {
          activeProfileId: null,
          profiles: [makeAutoProfile(CODEX_BTS_PROFILE_ID), sibling],
        },
      });

      const { migrated, rewrites } = applyBtsAutoProfileRerouteMigration(input, migrationLog);

      expect(rewrites).toBe(0);
      expect(migrated.behindTheScenesModel).toBe(`profile:${CODEX_BTS_PROFILE_ID}`);
    });

    it('sibling is JSON-incompatible', async () => {
      const { applyBtsAutoProfileRerouteMigration } = await loadSettingsStore();
      const sibling = makeConnectionSibling('connection-bts-1', {
        jsonCompatibility: 'incompatible',
      });
      const input = makeSettings({
        behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}`,
        localModel: {
          activeProfileId: null,
          profiles: [makeAutoProfile(CODEX_BTS_PROFILE_ID), sibling],
        },
      });

      const { migrated, rewrites } = applyBtsAutoProfileRerouteMigration(input, migrationLog);

      expect(rewrites).toBe(0);
      expect(migrated.behindTheScenesModel).toBe(`profile:${CODEX_BTS_PROFILE_ID}`);
    });

    it('sibling is chat-incompatible (defensive parity check)', async () => {
      const { applyBtsAutoProfileRerouteMigration } = await loadSettingsStore();
      const sibling = makeConnectionSibling('connection-bts-1', {
        chatCompatibility: 'incompatible',
      });
      const input = makeSettings({
        behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}`,
        localModel: {
          activeProfileId: null,
          profiles: [makeAutoProfile(CODEX_BTS_PROFILE_ID), sibling],
        },
      });

      const { migrated, rewrites } = applyBtsAutoProfileRerouteMigration(input, migrationLog);

      expect(rewrites).toBe(0);
      expect(migrated.behindTheScenesModel).toBe(`profile:${CODEX_BTS_PROFILE_ID}`);
    });

    it('sibling has no serverUrl (not selectable)', async () => {
      const { applyBtsAutoProfileRerouteMigration } = await loadSettingsStore();
      const sibling = makeConnectionSibling('connection-bts-1', { serverUrl: undefined });
      const input = makeSettings({
        behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}`,
        localModel: {
          activeProfileId: null,
          profiles: [makeAutoProfile(CODEX_BTS_PROFILE_ID), sibling],
        },
      });

      const { migrated, rewrites } = applyBtsAutoProfileRerouteMigration(input, migrationLog);

      expect(rewrites).toBe(0);
      expect(migrated.behindTheScenesModel).toBe(`profile:${CODEX_BTS_PROFILE_ID}`);
    });
  });

  describe('legacy auto profiles without profileSource', () => {
    it('reroutes BTS resolver when the auto profile carries no profileSource field', async () => {
      const { applyBtsAutoProfileRerouteMigration } = await loadSettingsStore();
      const legacyAutoProfile: ModelProfile = {
        id: CODEX_BTS_PROFILE_ID,
        name: 'GPT-5.4 mini (ChatGPT Pro)',
        authSource: 'codex-subscription',
        model: 'gpt-5.4-mini',
        providerType: 'openai',
        serverUrl: 'https://api.openai.com/v1',
        createdAt: 0,
        jsonCompatibility: 'incompatible',
      };
      const sibling = makeConnectionSibling('connection-bts-1');
      const input = makeSettings({
        behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}`,
        localModel: {
          activeProfileId: null,
          profiles: [legacyAutoProfile, sibling],
        },
      });

      const { migrated, rewrites } = applyBtsAutoProfileRerouteMigration(input, migrationLog);

      expect(rewrites).toBe(1);
      expect(migrated.behindTheScenesModel).toBe(`profile:${sibling.id}`);
    });

    it('strips capability flags from a legacy auto profile even when no sibling exists', async () => {
      const { applyBtsAutoProfileRerouteMigration } = await loadSettingsStore();
      const legacyAutoProfile: ModelProfile = {
        id: CODEX_BTS_PROFILE_ID,
        name: 'GPT-5.4 mini (ChatGPT Pro)',
        authSource: 'codex-subscription',
        model: 'gpt-5.4-mini',
        providerType: 'openai',
        serverUrl: 'https://api.openai.com/v1',
        createdAt: 0,
        jsonCompatibility: 'incompatible',
        jsonCompatibilityCheckedAt: '2026-05-07T18:14:41.861Z',
      };
      const input = makeSettings({
        behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}`,
        localModel: {
          activeProfileId: null,
          profiles: [legacyAutoProfile],
        },
      });

      const { migrated } = applyBtsAutoProfileRerouteMigration(input, migrationLog);
      const healed = migrated.localModel?.profiles.find((p) => p.id === CODEX_BTS_PROFILE_ID);

      expect(healed?.jsonCompatibility).toBeUndefined();
      expect(healed?.jsonCompatibilityCheckedAt).toBeUndefined();
    });

    it('preserves capability flags on user / connection profiles', async () => {
      const { applyBtsAutoProfileRerouteMigration } = await loadSettingsStore();
      const userProfile: ModelProfile = {
        id: 'user-profile-1',
        name: 'My local model',
        model: 'mistral-small',
        providerType: 'local',
        profileSource: 'user',
        serverUrl: 'http://localhost:11434',
        createdAt: 1_700_000_000_000,
        jsonCompatibility: 'incompatible',
      };
      const connectionProfile = makeConnectionSibling('connection-1', {
        jsonCompatibility: 'incompatible',
      });
      const input = makeSettings({
        behindTheScenesModel: 'claude-haiku-4-5',
        localModel: {
          activeProfileId: null,
          profiles: [userProfile, connectionProfile],
        },
      });

      const { migrated } = applyBtsAutoProfileRerouteMigration(input, migrationLog);
      const userAfter = migrated.localModel?.profiles.find((p) => p.id === 'user-profile-1');
      const connectionAfter = migrated.localModel?.profiles.find((p) => p.id === 'connection-1');

      expect(userAfter?.jsonCompatibility).toBe('incompatible');
      expect(connectionAfter?.jsonCompatibility).toBe('incompatible');
    });
  });

  describe('idempotency / version stamping', () => {
    it('stamps the version even when nothing rewrites and nothing strips', async () => {
      const { applyBtsAutoProfileRerouteMigration } = await loadSettingsStore();
      const input = makeSettings({});

      const { migrated, rewrites } = applyBtsAutoProfileRerouteMigration(input, migrationLog);

      expect(rewrites).toBe(0);
      expect(migrated.btsAutoProfileRerouteSchemaVersion).toBe(1);
    });

    it('does nothing when version is already current', async () => {
      const { applyBtsAutoProfileRerouteMigration } = await loadSettingsStore();
      const sibling = makeConnectionSibling('connection-bts-1');
      const input = makeSettings({
        btsAutoProfileRerouteSchemaVersion: 1,
        behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}`,
        localModel: {
          activeProfileId: null,
          profiles: [
            makeAutoProfile(CODEX_BTS_PROFILE_ID, { jsonCompatibility: 'incompatible' }),
            sibling,
          ],
        },
      });

      const { migrated, rewrites } = applyBtsAutoProfileRerouteMigration(input, migrationLog);

      expect(rewrites).toBe(0);
      expect(migrated).toBe(input);
    });
  });
});
