import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { CODEX_BTS_PROFILE_ID, CODEX_DEFAULT_MODEL } from '@shared/utils/codexDefaults';

let persistedStore: Record<string, unknown> | null = null;
let seedStore: Record<string, unknown> = {};
let storeWriteCount = 0;

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const deepMerge = (
  base: Record<string, unknown>,
  overrides: Record<string, unknown>
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

const loadSettingsStore = async (seed: Partial<AppSettings> = {}) => {
  vi.resetModules();
  persistedStore = null;
  seedStore = deepClone(seed as Record<string, unknown>);
  storeWriteCount = 0;
  return import('../settingsStore');
};

const reloadSettingsStoreWithExistingDisk = async () => {
  vi.resetModules();
  storeWriteCount = 0;
  return import('../settingsStore');
};

describe('settingsStore Codex stale-Claude repair migration', () => {
  beforeEach(() => {
    persistedStore = null;
    seedStore = {};
    storeWriteCount = 0;
    vi.resetModules();
  });

  it('sets the flag for non-Codex installs without changing model content', async () => {
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'anthropic',
      claude: {
        model: 'claude-sonnet-4-6',
      } as unknown as AppSettings['claude'],
    });

    const settings = getSettings();

    expect(settings.activeProvider).toBe('anthropic');
    expect(settings.claude!.model).toBe('claude-sonnet-4-6');
    expect(settings.codexRepairSchemaVersion).toBe(2);
    // 5 writes: codex repair stamp + OR provider-heal stamp + models namespace bootstrap
    // (claude→models migration since the seed only populates claude) + OR profileSource
    // migration version stamp (no eligible legacy OR profiles) + BTS auto-profile reroute
    // migration version stamp (260521 BTS Haiku-fallback A3, no auto-profile references
    // found so it just stamps the version).
    expect(storeWriteCount).toBe(5);
  });

  it('repairs legacy Codex installs with a stale Claude model and stamps the flag', async () => {
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'codex',
      claude: {
        model: 'claude-opus-4-7',
        thinkingModel: 'claude-sonnet-4-6',
        thinkingProfileId: 'profile-stale',
      } as unknown as AppSettings['claude'],
      behindTheScenesModel: 'claude-haiku-4-5',
    });

    const settings = getSettings();

    expect(settings.models?.model).toBe(CODEX_DEFAULT_MODEL);
    expect(settings.models?.thinkingModel).toBeUndefined();
    expect(settings.models?.thinkingProfileId).toBeUndefined();
    expect(settings.behindTheScenesModel).toBe(`profile:${CODEX_BTS_PROFILE_ID}`);
    expect(settings.codexRepairSchemaVersion).toBe(2);
    // 5 writes: codex repair migration + OR provider-heal stamp + models namespace bootstrap
    // (routeSurface stamp on the auto-generated Codex profiles) + OR profileSource migration
    // version stamp (no eligible legacy OR profiles) + BTS auto-profile reroute migration
    // version stamp (260521 BTS Haiku-fallback A3).
    expect(storeWriteCount).toBe(5);
  });

  it('treats the legacy v1 flag as version 1 and runs the v2 repair', async () => {
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'codex',
      codexStaleClaudeRepaired: true,
      claude: {
        model: 'claude-opus-4-7',
        thinkingModel: 'claude-sonnet-4-6',
      } as unknown as AppSettings['claude'],
    });

    const settings = getSettings();

    expect(settings.models?.model).toBe(CODEX_DEFAULT_MODEL);
    expect(settings.models?.thinkingModel).toBeUndefined();
    expect(settings.codexStaleClaudeRepaired).toBe(true);
    expect(settings.codexRepairSchemaVersion).toBe(2);
    // 5 writes: codex repair migration + OR provider-heal stamp + models namespace bootstrap
    // (routeSurface stamp on the auto-generated Codex profiles) + OR profileSource migration
    // version stamp (no eligible legacy OR profiles) + BTS auto-profile reroute migration
    // version stamp (260521 BTS Haiku-fallback A3).
    expect(storeWriteCount).toBe(5);
  });

  it('is idempotent once the bootstrap migration has stamped the flag', async () => {
    const firstLoad = await loadSettingsStore({
      activeProvider: 'codex',
      claude: {
        model: 'claude-opus-4-7',
      } as unknown as AppSettings['claude'],
    });

    const firstSettings = deepClone(firstLoad.getSettings());
    expect(firstSettings.codexRepairSchemaVersion).toBe(2);
    // 5 writes: codex repair migration + OR provider-heal stamp + models namespace bootstrap
    // (routeSurface stamp on the auto-generated Codex profiles) + OR profileSource migration
    // version stamp (no eligible legacy OR profiles) + BTS auto-profile reroute migration
    // version stamp (260521 BTS Haiku-fallback A3).
    expect(storeWriteCount).toBe(5);

    const secondLoad = await reloadSettingsStoreWithExistingDisk();
    const secondSettings = deepClone(secondLoad.getSettings());

    expect(secondSettings).toEqual(firstSettings);
    expect(storeWriteCount).toBe(0);
  });
});
