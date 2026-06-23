import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateLearnedLimitsIfNeeded } from '../learnedLimitsMigration';
import { normalizeForCapabilityCheck } from '../modelLimits';
import { setSettingsStoreAdapter } from '@core/services/settingsStore';
import { setStoreFactory } from '@core/storeFactory';
import {
  getKnownContextWindowForModel,
  getRegistryContextWindowForModel,
} from '@shared/data/modelProviderPresets';
import type { AppSettings, ModelProfile } from '@shared/types';
import type { KeyValueStore } from '@core/store';

const loggerInfoSpy = vi.fn();
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: (...args: unknown[]) => loggerInfoSpy(...args),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

class InMemoryStore<T extends Record<string, unknown>> implements KeyValueStore<T> {
  store: T;
  readonly path = 'in-memory://learnedLimitsMigration.test';
  constructor(defaults: T) {
    this.store = { ...defaults };
  }
  get<K extends keyof T & string>(key: K): T[K] | undefined;
  get<K extends keyof T & string>(key: K, defaultValue: T[K]): T[K];
  get<K extends keyof T & string>(key: K, defaultValue?: T[K]): T[K] | undefined {
    const value = this.store[key];
    return value === undefined ? (defaultValue as T[K]) : value;
  }
  set<K extends keyof T & string>(keyOrValues: K | Partial<T>, value?: T[K]): void {
    if (typeof keyOrValues === 'string') {
      this.store = { ...this.store, [keyOrValues]: value } as T;
    } else {
      this.store = { ...this.store, ...keyOrValues } as T;
    }
  }
  has(key: string): boolean {
    return key in this.store;
  }
  delete(key: string): void {
    const next = { ...this.store } as Record<string, unknown>;
    delete next[key];
    this.store = next as T;
  }
  clear(): void {
    this.store = {} as T;
  }
}

const stores = new Map<string, InMemoryStore<Record<string, unknown>>>();

function withProfiles(profiles: ModelProfile[]): AppSettings {
  return {
    coreDirectory: '/tmp',
    localModel: { profiles, activeProfileId: null },
  } as unknown as AppSettings;
}

function setup(initial: AppSettings, legacyLimits: Record<string, unknown> | null): {
  getState: () => AppSettings;
} {
  let state = initial;
  setSettingsStoreAdapter({
    getSettings: () => state,
    updateSettings: (partial) => {
      state = { ...state, ...partial } as AppSettings;
    },
    updateSettingsAtomic: (updater) => {
      const partial = updater(state);
      state = { ...state, ...partial } as AppSettings;
    },
  });

  stores.clear();
  setStoreFactory((opts) => {
    const existing = stores.get(opts.name);
    if (existing) return existing as never;
    const fresh = new InMemoryStore({
      ...(opts.defaults ?? {}),
      ...(legacyLimits && opts.name === 'rebel-core-learned-model-limits'
        ? { limits: legacyLimits }
        : {}),
    } as Record<string, unknown>);
    stores.set(opts.name, fresh);
    return fresh as never;
  });

  return { getState: () => state };
}

describe('migrateLearnedLimitsIfNeeded', () => {
  beforeEach(() => {
    stores.clear();
    loggerInfoSpy.mockClear();
  });

  it('disambiguates registry-stamped legacy contextWindow (Part A)', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'claude-sonnet-4-6',
      providerType: 'anthropic',
      serverUrl: '',
      contextWindow: 1_000_000,
      createdAt: 1,
    };
    const { getState } = setup(withProfiles([profile]), null);

    migrateLearnedLimitsIfNeeded();

    const updated = getState().localModel!.profiles![0];
    expect(updated.contextWindow).toBeUndefined();
    expect(updated.contextWindowSource).toBeUndefined();
    expect(getState().localModel!.registryStampMigratedAt).toBeTypeOf('number');
  });

  it('stamps user provenance when legacy contextWindow differs from the registry (Part A)', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'claude-sonnet-4-6',
      providerType: 'anthropic',
      serverUrl: '',
      contextWindow: 500_000,
      createdAt: 1,
    };
    const { getState } = setup(withProfiles([profile]), null);

    migrateLearnedLimitsIfNeeded();

    const updated = getState().localModel!.profiles![0];
    expect(updated.contextWindow).toBe(500_000);
    expect(updated.contextWindowSource).toBe('user');
  });

  it('imports a TTL-valid legacy entry onto the matching profile as auto (Part B)', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'unknown-model',
      providerType: 'other',
      serverUrl: 'https://example.test',
      createdAt: 1,
    };
    const { getState } = setup(withProfiles([profile]), {
      'unknown-model': {
        contextWindow: 90_000,
        learnedAt: Date.now(),
        overflowCount: 1,
      },
    });

    migrateLearnedLimitsIfNeeded();

    const updated = getState().localModel!.profiles![0];
    expect(updated.contextWindow).toBe(90_000);
    expect(updated.contextWindowSource).toBe('auto');
    expect(updated.contextWindowOverflowCount).toBe(1);
    expect(getState().localModel!.learnedLimitsMigratedAt).toBeTypeOf('number');
  });

  it('skips a legacy entry that is past TTL (Part B)', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'unknown-model',
      providerType: 'other',
      serverUrl: 'https://example.test',
      createdAt: 1,
    };
    const { getState } = setup(withProfiles([profile]), {
      'unknown-model': {
        contextWindow: 90_000,
        learnedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
        overflowCount: 1,
      },
    });

    migrateLearnedLimitsIfNeeded();

    const updated = getState().localModel!.profiles![0];
    expect(updated.contextWindow).toBeUndefined();
    expect(updated.contextWindowSource).toBeUndefined();
  });

  it('does not run twice (idempotent)', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'claude-sonnet-4-6',
      providerType: 'anthropic',
      serverUrl: '',
      contextWindow: 500_000,
      createdAt: 1,
    };
    const { getState } = setup(withProfiles([profile]), null);

    migrateLearnedLimitsIfNeeded();
    const firstAt = getState().localModel!.registryStampMigratedAt;
    expect(firstAt).toBeTypeOf('number');

    getState().localModel!.profiles![0].contextWindow = 999_999;
    migrateLearnedLimitsIfNeeded();
    const secondAt = getState().localModel!.registryStampMigratedAt;
    expect(secondAt).toBe(firstAt);
  });

  it('does NOT mark Part B complete when the legacy store fails to read; retries on next call', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'unknown-model',
      providerType: 'other',
      serverUrl: 'https://example.test',
      createdAt: 1,
    };
    let state: AppSettings = withProfiles([profile]);
    setSettingsStoreAdapter({
      getSettings: () => state,
      updateSettings: (partial) => {
        state = { ...state, ...partial } as AppSettings;
      },
      updateSettingsAtomic: (updater) => {
        const partial = updater(state);
        state = { ...state, ...partial } as AppSettings;
      },
    });

    let throwOnRead = true;
    setStoreFactory((opts) => {
      if (opts.name === 'rebel-core-learned-model-limits' && throwOnRead) {
        throw new Error('legacy store read failed');
      }
      const fresh = new InMemoryStore({
        ...(opts.defaults ?? {}),
        ...(opts.name === 'rebel-core-learned-model-limits'
          ? {
              limits: {
                'unknown-model': {
                  contextWindow: 90_000,
                  learnedAt: Date.now(),
                  overflowCount: 1,
                },
              },
            }
          : {}),
      } as Record<string, unknown>);
      stores.set(opts.name, fresh as InMemoryStore<Record<string, unknown>>);
      return fresh as never;
    });

    migrateLearnedLimitsIfNeeded();
    expect(state.localModel?.learnedLimitsMigratedAt).toBeUndefined();

    throwOnRead = false;
    migrateLearnedLimitsIfNeeded();
    expect(state.localModel?.learnedLimitsMigratedAt).toBeTypeOf('number');
    expect(state.localModel!.profiles![0].contextWindow).toBe(90_000);
    expect(state.localModel!.profiles![0].contextWindowSource).toBe('auto');
  });

  it('does NOT clobber a user-set context window during Part B', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'unknown-model',
      providerType: 'other',
      serverUrl: 'https://example.test',
      contextWindow: 1_500_000,
      contextWindowSource: 'user',
      createdAt: 1,
    };
    const { getState } = setup(withProfiles([profile]), {
      'unknown-model': {
        contextWindow: 90_000,
        learnedAt: Date.now(),
        overflowCount: 1,
      },
    });

    migrateLearnedLimitsIfNeeded();

    const updated = getState().localModel!.profiles![0];
    expect(updated.contextWindow).toBe(1_500_000);
    expect(updated.contextWindowSource).toBe('user');
  });

  it('skips virtual profiles in Part A', () => {
    const virtualProfile: ModelProfile = {
      id: 'virtual-1',
      name: 'Virtual',
      model: 'claude-sonnet-4-6',
      providerType: 'anthropic',
      serverUrl: '',
      contextWindow: 1_000_000,
      isVirtual: true,
      createdAt: 1,
    };
    const { getState } = setup(withProfiles([virtualProfile]), null);

    migrateLearnedLimitsIfNeeded();

    const updated = getState().localModel!.profiles![0];
    expect(updated.contextWindow).toBe(1_000_000);
    expect(updated.contextWindowSource).toBeUndefined();
  });

  // ---- Stage 5: Part B is registry-aware (no migration phase can mint a
  // catalogued source:'auto' context-window sidecar) ----

  it('does NOT import a catalogued legacy entry as an auto sidecar (Part B registry guard)', () => {
    // No existing profile for the catalogued model: Part B must NOT mint one.
    const { getState } = setup(withProfiles([]), {
      'claude-opus-4-7': {
        contextWindow: 84_876,
        learnedAt: Date.now(),
        overflowCount: 2,
      },
    });

    migrateLearnedLimitsIfNeeded();

    // No profile was created for the catalogued model -> no auto poison anywhere.
    const profiles = getState().localModel!.profiles ?? [];
    expect(profiles).toHaveLength(0);
    expect(getState().localModel!.learnedLimitsMigratedAt).toBeTypeOf('number');

    // And no catalogued source:'auto' context-window sidecar exists post-migration.
    const cataloguedAuto = profiles.filter(
      (p) => p.contextWindowSource === 'auto',
    );
    expect(cataloguedAuto).toHaveLength(0);
  });

  it('does NOT overwrite an existing catalogued profile with a legacy auto value (Part B registry guard)', () => {
    // An existing catalogued profile with no learned sidecar; Part B must leave it untouched.
    const profile: ModelProfile = {
      id: 'p1',
      name: 'Opus',
      model: 'claude-opus-4-7',
      providerType: 'anthropic',
      serverUrl: '',
      createdAt: 1,
    };
    const { getState } = setup(withProfiles([profile]), {
      'claude-opus-4-7': {
        contextWindow: 84_876,
        learnedAt: Date.now(),
        overflowCount: 2,
      },
    });

    migrateLearnedLimitsIfNeeded();

    const updated = getState().localModel!.profiles![0];
    expect(updated.contextWindow).toBeUndefined();
    expect(updated.contextWindowSource).toBeUndefined();
    expect(updated.lastLearnedContextWindow).toBeUndefined();
  });

  it('still imports an unknown-model legacy entry as auto while skipping a catalogued one (Part B contrast)', () => {
    const { getState } = setup(withProfiles([]), {
      'claude-opus-4-7': {
        contextWindow: 84_876,
        learnedAt: Date.now(),
        overflowCount: 2,
      },
      'some-exotic-local-v9': {
        contextWindow: 50_000,
        learnedAt: Date.now(),
        overflowCount: 1,
      },
    });

    migrateLearnedLimitsIfNeeded();

    const profiles = getState().localModel!.profiles ?? [];
    // Only the unknown model was imported.
    expect(profiles).toHaveLength(1);
    const imported = profiles[0];
    expect(imported.model).toBe('some-exotic-local-v9');
    expect(imported.contextWindow).toBe(50_000);
    expect(imported.contextWindowSource).toBe('auto');
    // No catalogued auto sidecar anywhere.
    expect(profiles.some((p) => p.model === 'claude-opus-4-7')).toBe(false);
  });

  it('full A/B/C run leaves NO catalogued source:auto context-window sidecar from a legacy catalogued entry', () => {
    // Legacy store has a catalogued poison entry. Part B skips it (Stage 5), so
    // Part C has nothing to clean for it either: invariant holds regardless of ordering.
    const { getState } = setup(withProfiles([]), {
      'claude-opus-4-7': {
        contextWindow: 84_876,
        learnedAt: Date.now(),
        overflowCount: 2,
      },
    });

    migrateLearnedLimitsIfNeeded();

    const profiles = getState().localModel!.profiles ?? [];
    const cataloguedAutos = profiles.filter((p) => {
      if (p.contextWindowSource !== 'auto') return false;
      if (!p.model) return false;
      const normalized = normalizeForCapabilityCheck(p.model);
      const reg =
        getRegistryContextWindowForModel(normalized) ??
        getKnownContextWindowForModel(normalized);
      return reg !== null;
    });
    expect(cataloguedAutos).toHaveLength(0);

    // All three parts ran and stamped.
    expect(getState().localModel!.registryStampMigratedAt).toBeTypeOf('number');
    expect(getState().localModel!.learnedLimitsMigratedAt).toBeTypeOf('number');
    expect(getState().localModel!.learnedContextWindowPoisonResetAt).toBeTypeOf('number');
  });

  it('retry hazard: Part B legacy-read fails first (C stamps), then B succeeds on a catalogued entry -> still no catalogued auto poison', () => {
    // Simulates: boot 1 Part B read throws (B does not stamp), Parts A & C run + stamp.
    // boot 2: Part B read succeeds with a catalogued legacy entry. Because Part B is
    // now registry-guarded (Stage 5), it does NOT import the catalogued poison even
    // though Part C already stamped complete and will never re-run to clean it.
    const profile: ModelProfile = {
      id: 'p1',
      name: 'Opus',
      model: 'claude-opus-4-7',
      providerType: 'anthropic',
      serverUrl: '',
      createdAt: 1,
    };
    let state: AppSettings = withProfiles([profile]);
    setSettingsStoreAdapter({
      getSettings: () => state,
      updateSettings: (partial) => {
        state = { ...state, ...partial } as AppSettings;
      },
      updateSettingsAtomic: (updater) => {
        const partial = updater(state);
        state = { ...state, ...partial } as AppSettings;
      },
    });

    let throwOnRead = true;
    setStoreFactory((opts) => {
      if (opts.name === 'rebel-core-learned-model-limits' && throwOnRead) {
        throw new Error('legacy store read failed');
      }
      const fresh = new InMemoryStore({
        ...(opts.defaults ?? {}),
        ...(opts.name === 'rebel-core-learned-model-limits'
          ? {
              limits: {
                'claude-opus-4-7': {
                  contextWindow: 84_876,
                  learnedAt: Date.now(),
                  overflowCount: 2,
                },
              },
            }
          : {}),
      } as Record<string, unknown>);
      stores.set(opts.name, fresh as InMemoryStore<Record<string, unknown>>);
      return fresh as never;
    });

    // Boot 1: Part B fails to read -> not stamped; Part C stamps.
    migrateLearnedLimitsIfNeeded();
    expect(state.localModel?.learnedLimitsMigratedAt).toBeUndefined();
    expect(state.localModel?.learnedContextWindowPoisonResetAt).toBeTypeOf('number');

    // Boot 2: Part B read now succeeds with the catalogued legacy entry.
    throwOnRead = false;
    migrateLearnedLimitsIfNeeded();
    expect(state.localModel?.learnedLimitsMigratedAt).toBeTypeOf('number');

    // The catalogued profile was NOT poisoned by the late Part B import.
    const updated = state.localModel!.profiles![0];
    expect(updated.contextWindow).toBeUndefined();
    expect(updated.contextWindowSource).toBeUndefined();
    expect(updated.lastLearnedContextWindow).toBeUndefined();
  });

  it('emits a structured audit log with the expected fields', () => {
    const registryProfile: ModelProfile = {
      id: 'reg',
      name: 'Reg',
      model: 'claude-sonnet-4-6',
      providerType: 'anthropic',
      serverUrl: '',
      contextWindow: 1_000_000,
      createdAt: 1,
    };
    const userProfile: ModelProfile = {
      id: 'user',
      name: 'User',
      model: 'claude-sonnet-4',
      providerType: 'anthropic',
      serverUrl: '',
      contextWindow: 500_000,
      createdAt: 2,
    };
    const { getState } = setup(withProfiles([registryProfile, userProfile]), {
      'unknown-model': {
        contextWindow: 90_000,
        learnedAt: Date.now(),
        overflowCount: 1,
      },
    });

    migrateLearnedLimitsIfNeeded();

    expect(getState().localModel!.profiles!.find((p) => p.id === 'reg')!.contextWindow).toBeUndefined();
    expect(getState().localModel!.profiles!.find((p) => p.id === 'user')!.contextWindowSource).toBe('user');

    const auditCall = loggerInfoSpy.mock.calls.find(
      ([, msg]) => typeof msg === 'string' && msg.includes('learned-limits unified'),
    );
    expect(auditCall).toBeDefined();
    const auditFields = auditCall![0] as Record<string, number>;
    expect(auditFields).toMatchObject({
      registryDisambiguated: 1,
      registryStamped: 1,
      migrated: 1,
      skippedExpired: 0,
      skippedUserOverride: 0,
      created: 1,
    });
  });
});
