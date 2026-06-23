import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateLearnedLimitsIfNeeded } from '../learnedLimitsMigration';
import { resolveModelLimits } from '../modelLimits';
import { setSettingsStoreAdapter } from '@core/services/settingsStore';
import { setStoreFactory } from '@core/storeFactory';
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
  readonly path = 'in-memory://learnedContextWindowPoisonReset.test';
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

/**
 * Build settings with the two upstream migration timestamps already set, so
 * Part A (provenance disambiguation) and Part B (legacy import) are no-ops and
 * we isolate Part C (the poison reset) under test. Mirrors a real already-
 * migrated install (incl. Greg's machine).
 */
function withProfiles(profiles: ModelProfile[]): AppSettings {
  return {
    coreDirectory: '/tmp',
    localModel: {
      profiles,
      activeProfileId: null,
      registryStampMigratedAt: 1,
      learnedLimitsMigratedAt: 1,
    },
  } as unknown as AppSettings;
}

function setup(initial: AppSettings): { getState: () => AppSettings } {
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
    const fresh = new InMemoryStore({ ...(opts.defaults ?? {}) } as Record<string, unknown>);
    stores.set(opts.name, fresh);
    return fresh as never;
  });

  return { getState: () => state };
}

function profileById(state: AppSettings, id: string): ModelProfile {
  const found = state.localModel!.profiles!.find((p) => p.id === id);
  if (!found) throw new Error(`profile ${id} not found`);
  return found;
}

describe('learned context-window poison reset (Part C)', () => {
  beforeEach(() => {
    stores.clear();
    loggerInfoSpy.mockClear();
  });

  it('clears the real __virtual-working poison so the resolver returns 1M', () => {
    // Mirrors the exact live poison on Greg's machine.
    const poisoned: ModelProfile = {
      id: '__virtual-working',
      name: 'Working',
      model: 'claude-opus-4-7',
      providerType: 'anthropic',
      serverUrl: '',
      isVirtual: true,
      contextWindow: 84_876,
      contextWindowSource: 'auto',
      contextWindowOverflowCount: 2,
      contextWindowLearnedAt: 123,
      lastLearnedContextWindow: 84_876,
      createdAt: 1,
    };
    const { getState } = setup(withProfiles([poisoned]));

    migrateLearnedLimitsIfNeeded();

    const updated = profileById(getState(), '__virtual-working');
    expect(updated.contextWindow).toBeUndefined();
    expect(updated.contextWindowSource).toBeUndefined();
    expect(updated.contextWindowOverflowCount).toBeUndefined();
    expect(updated.contextWindowLearnedAt).toBeUndefined();
    expect(updated.lastLearnedContextWindow).toBeUndefined();
    // Non-context-window fields untouched.
    expect(updated.isVirtual).toBe(true);
    expect(updated.model).toBe('claude-opus-4-7');
    expect(getState().localModel!.learnedContextWindowPoisonResetAt).toBeTypeOf('number');

    // Behavioral: resolution now falls back to the registry ceiling (1M).
    const limits = resolveModelLimits({
      model: 'claude-opus-4-7',
      profileContextWindow: updated.contextWindow,
      profileContextWindowSource: updated.contextWindowSource,
      allProfiles: getState().localModel!.profiles,
    });
    expect(limits.contextWindow).toBe(1_000_000);
  });

  it('preserves a legitimately user-set catalogued contextWindow; clears only stray learned sidecar', () => {
    const userSet: ModelProfile = {
      id: 'user-set',
      name: 'User Set',
      model: 'claude-sonnet-4-6',
      providerType: 'anthropic',
      serverUrl: '',
      contextWindow: 500_000,
      contextWindowSource: 'user',
      // Stray learned-sidecar provenance a prior learn/migration could have left.
      contextWindowOverflowCount: 3,
      contextWindowLearnedAt: 999,
      lastLearnedContextWindow: 84_876,
      createdAt: 1,
    };
    const { getState } = setup(withProfiles([userSet]));

    migrateLearnedLimitsIfNeeded();

    const updated = profileById(getState(), 'user-set');
    // User's intentional override is preserved.
    expect(updated.contextWindow).toBe(500_000);
    expect(updated.contextWindowSource).toBe('user');
    // Stray learned sidecar is cleared.
    expect(updated.contextWindowOverflowCount).toBeUndefined();
    expect(updated.contextWindowLearnedAt).toBeUndefined();
    expect(updated.lastLearnedContextWindow).toBeUndefined();

    // Behavioral: user override still wins the cascade.
    const limits = resolveModelLimits({
      model: 'claude-sonnet-4-6',
      profileContextWindow: updated.contextWindow,
      profileContextWindowSource: updated.contextWindowSource,
      allProfiles: getState().localModel!.profiles,
    });
    expect(limits.contextWindow).toBe(500_000);
  });

  it('leaves a genuinely-unknown-model auto profile completely untouched', () => {
    const unknownAuto: ModelProfile = {
      id: 'exotic',
      name: 'Exotic Local',
      model: 'some-exotic-local-v9',
      providerType: 'other',
      serverUrl: 'https://example.test',
      contextWindow: 50_000,
      contextWindowSource: 'auto',
      contextWindowOverflowCount: 1,
      contextWindowLearnedAt: 42,
      lastLearnedContextWindow: 50_000,
      createdAt: 1,
    };
    const { getState } = setup(withProfiles([unknownAuto]));

    migrateLearnedLimitsIfNeeded();

    const updated = profileById(getState(), 'exotic');
    // The legit unknown-model auto-learn feature is preserved.
    expect(updated.contextWindow).toBe(50_000);
    expect(updated.contextWindowSource).toBe('auto');
    expect(updated.contextWindowOverflowCount).toBe(1);
    expect(updated.contextWindowLearnedAt).toBe(42);
    expect(updated.lastLearnedContextWindow).toBe(50_000);
  });

  it('treats a broad-pattern Anthropic-ish model (claude-opus-4-custom) as catalogued (200K) and clears its auto sidecar', () => {
    // `claude-opus-4-custom` normalizes to itself and matches the broad
    // `/^claude-opus-4(?:-|$)/i` rule (200K) in anthropicModelLimits, so it IS
    // catalogued — its auto sidecar is poison and gets cleared.
    const broad: ModelProfile = {
      id: 'broad',
      name: 'Broad',
      model: 'claude-opus-4-custom',
      providerType: 'anthropic',
      serverUrl: '',
      contextWindow: 70_000,
      contextWindowSource: 'auto',
      contextWindowOverflowCount: 1,
      lastLearnedContextWindow: 70_000,
      createdAt: 1,
    };
    const { getState } = setup(withProfiles([broad]));

    migrateLearnedLimitsIfNeeded();

    const updated = profileById(getState(), 'broad');
    expect(updated.contextWindow).toBeUndefined();
    expect(updated.contextWindowSource).toBeUndefined();
    expect(updated.lastLearnedContextWindow).toBeUndefined();

    // Resolution falls back to the broad-pattern registry ceiling (200K).
    const limits = resolveModelLimits({
      model: 'claude-opus-4-custom',
      profileContextWindow: updated.contextWindow,
      profileContextWindowSource: updated.contextWindowSource,
      allProfiles: getState().localModel!.profiles,
    });
    expect(limits.contextWindow).toBe(200_000);
  });

  it('is idempotent: a second run makes no further changes', () => {
    const poisoned: ModelProfile = {
      id: '__virtual-working',
      name: 'Working',
      model: 'claude-opus-4-7',
      providerType: 'anthropic',
      serverUrl: '',
      isVirtual: true,
      contextWindow: 84_876,
      contextWindowSource: 'auto',
      contextWindowOverflowCount: 2,
      lastLearnedContextWindow: 84_876,
      createdAt: 1,
    };
    const { getState } = setup(withProfiles([poisoned]));

    migrateLearnedLimitsIfNeeded();
    const firstAt = getState().localModel!.learnedContextWindowPoisonResetAt;
    expect(firstAt).toBeTypeOf('number');

    // Simulate poison re-appearing (e.g. flag-on re-learn). A second run must
    // NOT touch it — the stamp gates the migration off.
    getState().localModel!.profiles![0].contextWindow = 12_345;
    getState().localModel!.profiles![0].contextWindowSource = 'auto';

    migrateLearnedLimitsIfNeeded();

    const updated = profileById(getState(), '__virtual-working');
    expect(updated.contextWindow).toBe(12_345);
    expect(updated.contextWindowSource).toBe('auto');
    expect(getState().localModel!.learnedContextWindowPoisonResetAt).toBe(firstAt);
  });

  it('never modifies output-cap sidecar fields', () => {
    const withOutputCap: ModelProfile = {
      id: '__virtual-working',
      name: 'Working',
      model: 'claude-opus-4-7',
      providerType: 'anthropic',
      serverUrl: '',
      isVirtual: true,
      contextWindow: 84_876,
      contextWindowSource: 'auto',
      contextWindowOverflowCount: 2,
      lastLearnedContextWindow: 84_876,
      // Output-cap sidecar — must survive untouched.
      maxOutputTokens: 96_000,
      outputTokensSource: 'auto',
      lastLearnedOutputTokens: 96_000,
      outputTokensLearnedAt: 555,
      createdAt: 1,
    };
    const { getState } = setup(withProfiles([withOutputCap]));

    migrateLearnedLimitsIfNeeded();

    const updated = profileById(getState(), '__virtual-working');
    // Context-window sidecar cleared...
    expect(updated.contextWindow).toBeUndefined();
    expect(updated.contextWindowSource).toBeUndefined();
    // ...but output-cap sidecar is fully preserved.
    expect(updated.maxOutputTokens).toBe(96_000);
    expect(updated.outputTokensSource).toBe('auto');
    expect(updated.lastLearnedOutputTokens).toBe(96_000);
    expect(updated.outputTokensLearnedAt).toBe(555);
  });

  it('emits the Part C audit fields', () => {
    const poisoned: ModelProfile = {
      id: '__virtual-working',
      name: 'Working',
      model: 'claude-opus-4-7',
      providerType: 'anthropic',
      serverUrl: '',
      isVirtual: true,
      contextWindow: 84_876,
      contextWindowSource: 'auto',
      createdAt: 1,
    };
    const userSet: ModelProfile = {
      id: 'user-set',
      name: 'User Set',
      model: 'claude-sonnet-4-6',
      providerType: 'anthropic',
      serverUrl: '',
      contextWindow: 500_000,
      contextWindowSource: 'user',
      lastLearnedContextWindow: 84_876,
      createdAt: 1,
    };
    const { getState } = setup(withProfiles([poisoned, userSet]));

    migrateLearnedLimitsIfNeeded();
    void getState();

    const auditCall = loggerInfoSpy.mock.calls.find(
      ([, msg]) => typeof msg === 'string' && msg.includes('learned-limits unified'),
    );
    expect(auditCall).toBeDefined();
    const auditFields = auditCall![0] as Record<string, number>;
    expect(auditFields).toMatchObject({
      contextWindowPoisonAutoCleared: 1,
      contextWindowPoisonUserSidecarCleared: 1,
    });
  });
});
