import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyValueStore } from '@core/store';
import type { StoreFactoryOptions } from '@core/storeFactory';
import { initTestPlatformConfig } from './testHelpers';

const deepClone = <T>(value: T): T => {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
};

function createInMemoryStore<T extends Record<string, unknown>>(initialState: T): KeyValueStore<T> {
  let data = deepClone(initialState);
  const getValue: KeyValueStore<T>['get'] = ((key: keyof T & string, defaultValue?: T[keyof T]) => {
    const value = data[key as keyof T];
    return value === undefined ? defaultValue : deepClone(value);
  }) as KeyValueStore<T>['get'];

  const store: KeyValueStore<T> = {
    get: getValue,

    set<K extends keyof T & string>(keyOrValues: K | Partial<T>, value?: T[K]): void {
      if (typeof keyOrValues === 'string') {
        if (value !== undefined) {
          data[keyOrValues] = deepClone(value);
        }
        return;
      }

      data = {
        ...data,
        ...deepClone(keyOrValues),
      };
    },

    has(key: string): boolean {
      return Object.prototype.hasOwnProperty.call(data, key);
    },

    delete(key: string): void {
      delete data[key as keyof T];
    },

    clear(): void {
      data = {} as T;
    },

    get store(): T {
      return deepClone(data);
    },

    set store(value: T) {
      data = deepClone(value);
    },

    get path(): string {
      return '/tmp/safety-prompt-store.test.json';
    },
  };

  return store;
}

describe('safetyPromptStore', () => {
  let storeModule: typeof import('@core/safetyPromptStore');

  beforeEach(async () => {
    vi.resetModules();
    await initTestPlatformConfig();

    const { setStoreFactory } = await import('@core/storeFactory');
    setStoreFactory(<T extends Record<string, unknown>>(options: StoreFactoryOptions<T>) => {
      const defaults = options.defaults ?? ({} as T);
      return createInMemoryStore(defaults);
    });

    storeModule = await import('@core/safetyPromptStore');
    storeModule.resetStoreForTesting();
    vi.useRealTimers();
  });

  it('getSafetyPrompt returns default prompt on fresh store', () => {
    const prompt = storeModule.getSafetyPrompt();

    expect(prompt).toContain('# Safety Principles');
    expect(prompt).toContain('- Never share passwords, API keys, or other credentials.');
  });

  it('getSafetyPromptVersion returns 0 on fresh store', () => {
    expect(storeModule.getSafetyPromptVersion()).toBe(0);
  });

  it('getSafetyPromptWithMeta maps safetyPrompt to prompt and includes migrationComplete', () => {
    const meta = storeModule.getSafetyPromptWithMeta();

    expect(meta.prompt).toContain('# Safety Principles');
    expect(meta.version).toBe(0);
    expect(meta.migrationComplete).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(meta, 'safetyPrompt')).toBe(false);
  });

  it('updateSafetyPrompt increments version on each update', () => {
    storeModule.updateSafetyPrompt('Prompt v1', 'user');
    storeModule.updateSafetyPrompt('Prompt v2', 'system');

    expect(storeModule.getSafetyPromptVersion()).toBe(2);
    expect(storeModule.getSafetyPrompt()).toBe('Prompt v2');
  });

  it('updateSafetyPrompt pushes previous prompt to history', () => {
    const defaultPrompt = storeModule.getSafetyPrompt();

    storeModule.updateSafetyPrompt('Prompt v1', 'user');

    const history = storeModule.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      prompt: defaultPrompt,
      version: 0,
      updatedBy: 'system',
    });
  });

  it('updateSafetyPrompt caps history at 10 entries', () => {
    for (let i = 1; i <= 12; i += 1) {
      storeModule.updateSafetyPrompt(`Prompt v${i}`, 'user');
    }

    const history = storeModule.getHistory();
    expect(history).toHaveLength(10);
    expect(history[0]?.version).toBe(2);
    expect(history[9]?.version).toBe(11);
  });

  it('updateSafetyPrompt updates lastUpdatedAt and lastUpdatedBy', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-24T10:00:00.000Z'));

    storeModule.updateSafetyPrompt('Prompt with timestamp', 'migration');

    const meta = storeModule.getSafetyPromptWithMeta();
    expect(meta.lastUpdatedAt).toBe(new Date('2026-02-24T10:00:00.000Z').getTime());
    expect(meta.lastUpdatedBy).toBe('migration');

    vi.useRealTimers();
  });

  it('revertToVersion restores from history and keeps version monotonic', () => {
    storeModule.updateSafetyPrompt('Prompt v1', 'user');
    storeModule.updateSafetyPrompt('Prompt v2', 'user');

    const reverted = storeModule.revertToVersion(1);

    expect(reverted).toBe(true);

    const meta = storeModule.getSafetyPromptWithMeta();
    expect(meta.prompt).toBe('Prompt v1');
    expect(meta.version).toBe(3);
    expect(meta.lastUpdatedBy).toBe('user');
  });

  it('revertToVersion returns false when target version is not found', () => {
    storeModule.updateSafetyPrompt('Prompt v1', 'user');

    const reverted = storeModule.revertToVersion(999);

    expect(reverted).toBe(false);
    expect(storeModule.getSafetyPrompt()).toBe('Prompt v1');
    expect(storeModule.getSafetyPromptVersion()).toBe(1);
  });

  it('isMigrationComplete defaults to false', () => {
    expect(storeModule.isMigrationComplete()).toBe(false);
  });

  it('setMigrationComplete toggles migration gate state', () => {
    storeModule.setMigrationComplete(true);
    expect(storeModule.isMigrationComplete()).toBe(true);

    storeModule.setMigrationComplete(false);
    expect(storeModule.isMigrationComplete()).toBe(false);
  });

  it('resetToDefaults clears history and resets version/prompt', () => {
    storeModule.updateSafetyPrompt('Prompt v1', 'user');
    storeModule.updateSafetyPrompt('Prompt v2', 'system');
    storeModule.setMigrationComplete(true);

    storeModule.resetToDefaults();

    const meta = storeModule.getSafetyPromptWithMeta();
    expect(meta.prompt).toContain('# Safety Principles');
    expect(meta.version).toBe(0);
    expect(meta.history).toEqual([]);
    expect(meta.lastUpdatedAt).toBe(0);
    expect(meta.lastUpdatedBy).toBe('system');
    expect(meta.migrationComplete).toBe(false);
  });
});
