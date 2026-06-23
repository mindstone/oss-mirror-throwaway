/**
 * Tests for the one-shot OpenRouter provider-state heal migration.
 *
 * Repairs the broken settings shape that the pre-260511 OAuth flow could
 * leave behind on a fresh install:
 *   { activeProvider: 'anthropic', models.apiKey: null, openRouter.oauthToken: <set> }
 *
 * See: docs/plans/260511_openrouter_oauth_active_provider_fix.md
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import {
  OR_DEFAULT_BTS_MODEL,
  OR_DEFAULT_THINKING_MODEL,
  OR_DEFAULT_WORKING_MODEL,
} from '@shared/utils/openRouterDefaults';

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

describe('settingsStore OpenRouter provider-state heal migration', () => {
  beforeEach(() => {
    persistedStore = null;
    seedStore = {};
    storeWriteCount = 0;
    vi.resetModules();
  });

  it('heals the broken state: activeProvider=anthropic + no Anthropic key + OR token present', async () => {
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'anthropic',
      claude: { apiKey: null } as unknown as AppSettings['claude'],
      openRouter: {
        enabled: false,
        oauthToken: 'fake-or-broken',
        selectedModel: 'openai/gpt-5.5',
      },
    });

    const settings = getSettings();

    expect(settings.activeProvider).toBe('openrouter');
    expect(settings.openRouterProviderHealVersion).toBe(1);
    expect(settings.models?.model).toBe(OR_DEFAULT_WORKING_MODEL);
    expect(settings.models?.thinkingModel).toBe(OR_DEFAULT_THINKING_MODEL);
    expect(settings.behindTheScenesModel).toBe(OR_DEFAULT_BTS_MODEL);
    expect(settings.openRouter?.oauthToken).toBe('fake-or-broken');
    expect(settings.openRouter?.enabled).toBe(true);
  });

  it('does NOT heal when an Anthropic API key is present (legitimate Anthropic user)', async () => {
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'anthropic',
      claude: { apiKey: 'fake-ant-real-key' } as unknown as AppSettings['claude'],
      openRouter: {
        enabled: false,
        oauthToken: 'fake-or-also-present',
        selectedModel: 'openai/gpt-5.5',
      },
    });

    const settings = getSettings();

    expect(settings.activeProvider).toBe('anthropic');
    expect(settings.openRouterProviderHealVersion).toBe(1);
  });

  it('does NOT heal when no OR token is present (genuine Anthropic-no-key state)', async () => {
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'anthropic',
      claude: { apiKey: null } as unknown as AppSettings['claude'],
    });

    const settings = getSettings();

    expect(settings.activeProvider).toBe('anthropic');
    expect(settings.openRouterProviderHealVersion).toBe(1);
  });

  it('does NOT heal when activeProvider is already openrouter', async () => {
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'openrouter',
      claude: { apiKey: null } as unknown as AppSettings['claude'],
      openRouter: {
        enabled: true,
        oauthToken: 'fake-or-already-correct',
        selectedModel: 'openai/gpt-5.5',
      },
    });

    const settings = getSettings();

    expect(settings.activeProvider).toBe('openrouter');
    expect(settings.openRouterProviderHealVersion).toBe(1);
  });

  it('does NOT heal when activeProvider is codex', async () => {
    const { getSettings } = await loadSettingsStore({
      activeProvider: 'codex',
      claude: { apiKey: null } as unknown as AppSettings['claude'],
      openRouter: {
        enabled: false,
        oauthToken: 'fake-or-stale',
        selectedModel: 'openai/gpt-5.5',
      },
    });

    const settings = getSettings();

    expect(settings.activeProvider).toBe('codex');
    expect(settings.openRouterProviderHealVersion).toBe(1);
  });

  it('is idempotent — re-running after the version flag is set produces no further changes', async () => {
    const firstLoad = await loadSettingsStore({
      activeProvider: 'anthropic',
      claude: { apiKey: null } as unknown as AppSettings['claude'],
      openRouter: {
        enabled: false,
        oauthToken: 'fake-or-broken',
        selectedModel: 'openai/gpt-5.5',
      },
    });

    const firstSettings = deepClone(firstLoad.getSettings());
    expect(firstSettings.activeProvider).toBe('openrouter');
    expect(firstSettings.openRouterProviderHealVersion).toBe(1);

    const secondLoad = await reloadSettingsStoreWithExistingDisk();
    const secondSettings = deepClone(secondLoad.getSettings());

    expect(secondSettings.activeProvider).toBe('openrouter');
    expect(secondSettings.openRouterProviderHealVersion).toBe(1);
    expect(storeWriteCount).toBe(0);
  });
});
