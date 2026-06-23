import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';

let persistedStore: Record<string, unknown> | null = null;
let seedStore: Record<string, unknown> = {};
const captureExceptionSpy = vi.fn();

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// Faithful to electron-store's `conf` bootstrap, which does a SHALLOW top-level
// merge: `Object.assign({}, defaults, fileStore)` (node_modules/conf/dist/source/index.js
// #initializeStore). A top-level key present in the file/seed wins ENTIRELY — it is
// NOT deep-filled from defaults. Now that DEFAULT_SETTINGS ships a `models` block,
// a deep-merge would back-fill the default `models` into a malformed-claude seed
// (no `models`), masking the malformed-claude degrade path under test.
const shallowMerge = (
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> => ({ ...base, ...deepClone(overrides) });

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    captureException: captureExceptionSpy,
  }),
}));

vi.mock('electron-store', () => ({
  default: class MockStore {
    constructor(opts?: { defaults?: Record<string, unknown> }) {
      if (persistedStore === null) {
        persistedStore = shallowMerge(deepClone(opts?.defaults ?? {}), seedStore);
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

const loadSettingsStore = async (seed: Partial<AppSettings> = {}) => {
  vi.resetModules();
  persistedStore = null;
  seedStore = deepClone(seed as Record<string, unknown>);
  captureExceptionSpy.mockClear();
  return import('../settingsStore');
};

describe('settingsStore models migration failure observability', () => {
  beforeEach(() => {
    persistedStore = null;
    seedStore = {};
    captureExceptionSpy.mockClear();
    vi.resetModules();
  });

  it('records degraded state and captures exception when claude block is malformed', async () => {
    const { getSettings } = await loadSettingsStore({
      codexRepairSchemaVersion: 2,
      claude: 'malformed' as unknown as AppSettings['claude'],
    });

    const settings = getSettings();
    expect(settings.models).toBeUndefined();
    expect(settings.modelsNamespaceSchemaVersion).toBeUndefined();
    expect(settings.settingsMigrationDegraded?.reason).toBe('malformed-claude-block');
    expect(typeof settings.settingsMigrationDegraded?.timestamp).toBe('number');
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
  });

  it('recovers from valid claude when models block is malformed', async () => {
    const { migrateClaudeToModelsNamespace } = await loadSettingsStore({
      codexRepairSchemaVersion: 2,
    });

    const result = migrateClaudeToModelsNamespace({
      claude: {
        model: 'claude-sonnet-4-6',
        learnedContextWindowEnabled: true,
      } as unknown as AppSettings['claude'],
      models: 'malformed' as unknown as AppSettings['models'],
    } as AppSettings);

    expect(result.migrated).toBe(true);
    expect(result.changes.modelsNamespaceSchemaVersion).toBe(2);
    expect(result.changes.models?.model).toBe('claude-sonnet-4-6');
    expect(result.changes.models?.learnedContextWindowEnabled).toBe(true);
    expect(result.changes.settingsMigrationDegraded?.reason).toBe('malformed-models-block');
    expect(typeof result.changes.settingsMigrationDegraded?.timestamp).toBe('number');
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
  });

  it('recovers from valid models when claude block is malformed', async () => {
    const { migrateClaudeToModelsNamespace } = await loadSettingsStore({
      codexRepairSchemaVersion: 2,
    });

    const result = migrateClaudeToModelsNamespace({
      claude: 'malformed' as unknown as AppSettings['claude'],
      models: {
        apiKey: null,
        model: 'claude-opus-4-7',
        learnedContextWindowEnabled: false,
      } as unknown as AppSettings['models'],
    } as AppSettings);

    expect(result.migrated).toBe(true);
    expect(result.changes.modelsNamespaceSchemaVersion).toBe(2);
    expect(result.changes.models?.apiKey).toBeNull();
    expect(result.changes.models?.model).toBe('claude-opus-4-7');
    expect(result.changes.models?.learnedContextWindowEnabled).toBe(false);
    expect(result.changes.settingsMigrationDegraded?.reason).toBe('malformed-claude-block');
    expect(typeof result.changes.settingsMigrationDegraded?.timestamp).toBe('number');
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
  });
});
