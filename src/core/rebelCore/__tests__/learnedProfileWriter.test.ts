import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  recordContextOverflowOnProfile,
  computeSafeLearnedWindow,
  recordOutputCapOnProfile,
} from '../learnedProfileWriter';
import { setSettingsStoreAdapter } from '@core/services/settingsStore';
import type { AppSettings, ModelProfile } from '@shared/types';
import type { BroadcastService } from '@core/broadcastService';
import { getRegistryMaxOutputForModel } from '@shared/data/modelProviderPresets';

// The context-window auto-learn writer is gated behind a default-off flag
// (`models.learnedContextWindowEnabled`). The existing behavioral tests below
// exercise the learning path, so they opt the flag ON via `models`. Flag-off
// and registry-guard behavior is covered by the dedicated describe blocks at the
// end of this file. Output-cap learning is independent of the flag.
const baseSettings = (overrides?: { learnedContextWindowEnabled?: boolean }): AppSettings =>
  ({
    coreDirectory: '/tmp',
    localModel: { profiles: [], activeProfileId: null },
    models: { learnedContextWindowEnabled: overrides?.learnedContextWindowEnabled ?? true },
  }) as unknown as AppSettings;

function withProfiles(
  profiles: ModelProfile[],
  overrides?: { learnedContextWindowEnabled?: boolean },
): AppSettings {
  return {
    ...baseSettings(overrides),
    localModel: { profiles, activeProfileId: profiles[0]?.id ?? null },
  } as unknown as AppSettings;
}

function makeStore(initial: AppSettings) {
  let state = initial;
  return {
    getState: () => state,
    install: () => {
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
    },
  };
}

describe('computeSafeLearnedWindow', () => {
  it('applies a 10% safety margin on first overflow', () => {
    expect(computeSafeLearnedWindow(100_000, 1)).toBe(90_000);
  });

  it('tightens by 2% per subsequent event up to 5 events', () => {
    expect(computeSafeLearnedWindow(100_000, 2)).toBe(88_000);
    expect(computeSafeLearnedWindow(100_000, 3)).toBe(86_000);
    expect(computeSafeLearnedWindow(100_000, 6)).toBe(80_000);
    expect(computeSafeLearnedWindow(100_000, 100)).toBe(80_000);
  });

  it('floors at 10K tokens', () => {
    expect(computeSafeLearnedWindow(5_000, 1)).toBe(10_000);
  });
});

describe('recordContextOverflowOnProfile', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('skips zero / negative input', () => {
    const store = makeStore(withProfiles([]));
    store.install();
    recordContextOverflowOnProfile({ model: 'm', profileId: null, lastKnownInputTokens: 0 });
    recordContextOverflowOnProfile({ model: 'm', profileId: null, lastKnownInputTokens: -1 });
    expect(store.getState().localModel?.profiles).toEqual([]);
  });

  it('updates the profile resolved by id', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'gpt-test',
      providerType: 'other',
      serverUrl: 'https://example.test',
      createdAt: 1,
    };
    const store = makeStore(withProfiles([profile]));
    store.install();

    recordContextOverflowOnProfile({
      model: 'gpt-test',
      profileId: 'p1',
      lastKnownInputTokens: 100_000,
    });

    const updated = store.getState().localModel!.profiles![0];
    expect(updated.contextWindow).toBe(90_000);
    expect(updated.contextWindowSource).toBe('auto');
    expect(updated.contextWindowOverflowCount).toBe(1);
    expect(updated.lastLearnedContextWindow).toBe(90_000);
    expect(typeof updated.contextWindowLearnedAt).toBe('number');
  });

  it('falls back to model match when no id is provided', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'gpt-test',
      providerType: 'other',
      serverUrl: 'https://example.test',
      createdAt: 1,
    };
    const store = makeStore(withProfiles([profile]));
    store.install();

    recordContextOverflowOnProfile({
      model: 'gpt-test',
      profileId: null,
      lastKnownInputTokens: 100_000,
    });

    expect(store.getState().localModel!.profiles![0].contextWindow).toBe(90_000);
  });

  it('auto-creates a hidden virtual stub when no profile matches', () => {
    const store = makeStore(withProfiles([]));
    store.install();

    recordContextOverflowOnProfile({
      model: 'unknown-model',
      profileId: null,
      lastKnownInputTokens: 100_000,
    });

    const profiles = store.getState().localModel!.profiles!;
    expect(profiles).toHaveLength(1);
    const stub = profiles[0];
    expect(stub.id).toBe('auto:unknown-model');
    expect(stub.serverUrl).toBe('');
    expect(stub.enabled).toBe(false);
    expect(stub.isVirtual).toBe(true);
    expect(stub.contextWindow).toBe(90_000);
    expect(stub.contextWindowSource).toBe('auto');
  });

  it('updates an existing auto-created stub on subsequent overflow events (no duplicate stubs)', () => {
    const store = makeStore(withProfiles([]));
    store.install();

    recordContextOverflowOnProfile({
      model: 'unknown-model',
      profileId: null,
      lastKnownInputTokens: 100_000,
    });

    recordContextOverflowOnProfile({
      model: 'unknown-model',
      profileId: null,
      lastKnownInputTokens: 90_000,
    });

    const profiles = store.getState().localModel!.profiles!;
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe('auto:unknown-model');
    expect(profiles[0].contextWindowOverflowCount).toBe(2);
  });

  it('does not overwrite a user-set contextWindow', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'gpt-test',
      providerType: 'other',
      serverUrl: 'https://example.test',
      contextWindow: 200_000,
      contextWindowSource: 'user',
      createdAt: 1,
    };
    const store = makeStore(withProfiles([profile]));
    store.install();

    recordContextOverflowOnProfile({
      model: 'gpt-test',
      profileId: 'p1',
      lastKnownInputTokens: 100_000,
    });

    const updated = store.getState().localModel!.profiles![0];
    expect(updated.contextWindow).toBe(200_000);
    expect(updated.contextWindowSource).toBe('user');
    expect(updated.lastLearnedContextWindow).toBe(90_000);
    expect(updated.contextWindowOverflowCount).toBe(1);
  });

  it('skips company-managed profiles', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'gpt-test',
      providerType: 'other',
      serverUrl: 'https://example.test',
      companyManaged: true,
      createdAt: 1,
    };
    const store = makeStore(withProfiles([profile]));
    store.install();

    recordContextOverflowOnProfile({
      model: 'gpt-test',
      profileId: 'p1',
      lastKnownInputTokens: 100_000,
    });

    const updated = store.getState().localModel!.profiles![0];
    expect(updated.contextWindow).toBeUndefined();
    expect(updated.contextWindowSource).toBeUndefined();
  });

  it('tightens an inflated user-set value when learned ceiling is below user value but above registry', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'unknown-model',
      providerType: 'other',
      serverUrl: 'https://example.test',
      contextWindow: 500_000,
      contextWindowSource: 'user',
      createdAt: 1,
    };
    const store = makeStore(withProfiles([profile]));
    store.install();

    recordContextOverflowOnProfile({
      model: 'unknown-model',
      profileId: 'p1',
      lastKnownInputTokens: 100_000,
    });

    const updated = store.getState().localModel!.profiles![0];
    expect(updated.contextWindow).toBe(500_000);
    expect(updated.contextWindowSource).toBe('user');
    expect(updated.lastLearnedContextWindow).toBe(90_000);
  });

  it('tie-breaks by oldest createdAt when multiple enabled+routing-eligible profiles match (DO-NOW 5, cycle 3)', () => {
    const newer: ModelProfile = {
      id: 'p-newer',
      name: 'Newer',
      model: 'gpt-multi',
      providerType: 'other',
      serverUrl: 'https://newer.test',
      enabled: true,
      routingEligible: true,
      createdAt: 2000,
    };
    const older: ModelProfile = {
      id: 'p-older',
      name: 'Older',
      model: 'gpt-multi',
      providerType: 'other',
      serverUrl: 'https://older.test',
      enabled: true,
      routingEligible: true,
      createdAt: 1000,
    };
    // Insert in non-createdAt order to ensure the tiebreak isn't accidentally
    // satisfied by array order.
    const store = makeStore(withProfiles([newer, older]));
    store.install();

    recordContextOverflowOnProfile({
      model: 'gpt-multi',
      profileId: null,
      lastKnownInputTokens: 100_000,
    });

    const profiles = store.getState().localModel!.profiles!;
    const olderAfter = profiles.find((p) => p.id === 'p-older')!;
    const newerAfter = profiles.find((p) => p.id === 'p-newer')!;
    expect(olderAfter.contextWindow).toBe(90_000);
    expect(olderAfter.contextWindowSource).toBe('auto');
    expect(newerAfter.contextWindow).toBeUndefined();
  });

  it('prefers the routing-eligible enabled profile when multiple match by model id', () => {
    const inactive: ModelProfile = {
      id: 'p-inactive',
      name: 'Inactive',
      model: 'gpt-multi',
      providerType: 'other',
      serverUrl: 'https://inactive.test',
      enabled: false,
      createdAt: 1,
    };
    const active: ModelProfile = {
      id: 'p-active',
      name: 'Active',
      model: 'gpt-multi',
      providerType: 'other',
      serverUrl: 'https://active.test',
      enabled: true,
      routingEligible: true,
      createdAt: 2,
    };
    const store = makeStore(withProfiles([inactive, active]));
    store.install();

    recordContextOverflowOnProfile({
      model: 'gpt-multi',
      profileId: null,
      lastKnownInputTokens: 100_000,
    });

    const profiles = store.getState().localModel!.profiles!;
    const activeAfter = profiles.find((p) => p.id === 'p-active')!;
    const inactiveAfter = profiles.find((p) => p.id === 'p-inactive')!;
    expect(activeAfter.contextWindow).toBe(90_000);
    expect(activeAfter.contextWindowSource).toBe('auto');
    expect(inactiveAfter.contextWindow).toBeUndefined();
  });

  it('survives concurrent writes to different models in the same tick (atomic updater)', () => {
    const profileA: ModelProfile = {
      id: 'p-a',
      name: 'A',
      model: 'model-a',
      providerType: 'other',
      serverUrl: 'https://a.test',
      enabled: true,
      createdAt: 1,
    };
    const profileB: ModelProfile = {
      id: 'p-b',
      name: 'B',
      model: 'model-b',
      providerType: 'other',
      serverUrl: 'https://b.test',
      enabled: true,
      createdAt: 2,
    };
    const store = makeStore(withProfiles([profileA, profileB]));
    store.install();

    recordContextOverflowOnProfile({
      model: 'model-a',
      profileId: 'p-a',
      lastKnownInputTokens: 100_000,
    });
    recordContextOverflowOnProfile({
      model: 'model-b',
      profileId: 'p-b',
      lastKnownInputTokens: 80_000,
    });

    const profiles = store.getState().localModel!.profiles!;
    const a = profiles.find((p) => p.id === 'p-a')!;
    const b = profiles.find((p) => p.id === 'p-b')!;
    expect(a.contextWindow).toBe(90_000);
    expect(b.contextWindow).toBe(72_000);
  });

  it('logs and recovers when the underlying settings store throws (does not propagate)', () => {
    setSettingsStoreAdapter({
      getSettings: () => baseSettings(),
      updateSettings: () => {
        throw new Error('disk full');
      },
      updateSettingsAtomic: () => {
        throw new Error('disk full');
      },
    });

    expect(() =>
      recordContextOverflowOnProfile({
        model: 'gpt-test',
        profileId: null,
        lastKnownInputTokens: 100_000,
      }),
    ).not.toThrow();
  });
});

describe('recordContextOverflowOnProfile — feature flag (default-off kill-switch)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('is a complete no-op when the flag is absent (default-off) for an unknown model', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'unknown-model',
      providerType: 'other',
      serverUrl: 'https://example.test',
      createdAt: 1,
    };
    // No `models.learnedContextWindowEnabled` at all => default off.
    const store = makeStore({
      ...withProfiles([profile]),
      models: {},
    } as unknown as AppSettings);
    store.install();

    recordContextOverflowOnProfile({
      model: 'unknown-model',
      profileId: 'p1',
      lastKnownInputTokens: 100_000,
    });

    const updated = store.getState().localModel!.profiles![0];
    expect(updated.contextWindow).toBeUndefined();
    expect(updated.contextWindowSource).toBeUndefined();
    expect(updated.contextWindowOverflowCount).toBeUndefined();
    // No stub creation either.
    expect(store.getState().localModel!.profiles).toHaveLength(1);
  });

  it('is a no-op when the flag is explicitly false, even on an unknown model', () => {
    const store = makeStore(withProfiles([], { learnedContextWindowEnabled: false }));
    store.install();

    recordContextOverflowOnProfile({
      model: 'some-exotic-local-model',
      profileId: null,
      lastKnownInputTokens: 100_000,
    });

    // No auto: stub minted, no write.
    expect(store.getState().localModel!.profiles).toEqual([]);
  });

  it('does not emit settings:external-update when the flag is off', async () => {
    const broadcastModule = await import('@core/broadcastService');
    const original = broadcastModule.getBroadcastService();
    const captured: string[] = [];
    broadcastModule.setBroadcastService({
      sendToAllWindows: (channel: string) => {
        captured.push(channel);
      },
      sendToFocusedWindow: () => {},
    });

    try {
      const store = makeStore(withProfiles([], { learnedContextWindowEnabled: false }));
      store.install();

      recordContextOverflowOnProfile({
        model: 'some-exotic-local-model',
        profileId: null,
        lastKnownInputTokens: 100_000,
      });

      expect(captured).toEqual([]);
    } finally {
      broadcastModule.setBroadcastService(original);
    }
  });

  it('still learns for a genuinely-unknown model when the flag is ON', () => {
    const store = makeStore(withProfiles([], { learnedContextWindowEnabled: true }));
    store.install();

    recordContextOverflowOnProfile({
      model: 'some-exotic-local-model',
      profileId: null,
      lastKnownInputTokens: 100_000,
    });

    const profiles = store.getState().localModel!.profiles!;
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe('auto:some-exotic-local-model');
    expect(profiles[0].contextWindow).toBe(90_000);
    expect(profiles[0].contextWindowSource).toBe('auto');
  });
});

describe('recordContextOverflowOnProfile — registry-authoritative guard (flag ON)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  // Each variant normalizes to the catalogued claude-opus-4-7 (real ceiling 1M),
  // so the writer must never learn a context window for it even with the flag on.
  const catalogued = [
    'claude-opus-4-7',
    'anthropic/claude-opus-4-7',
    'claude-opus-4.7',
    'claude-opus-4-7[1m]',
  ];

  for (const model of catalogued) {
    it(`does not write a context-window sidecar for catalogued model "${model}"`, () => {
      const profile: ModelProfile = {
        id: 'p1',
        name: 'P1',
        model,
        providerType: 'anthropic',
        serverUrl: '',
        createdAt: 1,
      };
      const store = makeStore(withProfiles([profile], { learnedContextWindowEnabled: true }));
      store.install();

      recordContextOverflowOnProfile({
        model,
        profileId: 'p1',
        lastKnownInputTokens: 96_450,
      });

      const updated = store.getState().localModel!.profiles![0];
      expect(updated.contextWindow).toBeUndefined();
      expect(updated.contextWindowSource).toBeUndefined();
      expect(updated.contextWindowOverflowCount).toBeUndefined();
      expect(updated.lastLearnedContextWindow).toBeUndefined();
      // No extra/auto stub profile is minted for a catalogued model.
      expect(store.getState().localModel!.profiles).toHaveLength(1);
    });
  }

  it('reproduces the original bug shape (opus-4-7, 96450 input → would have learned 84876) but writes nothing', () => {
    // computeSafeLearnedWindow(96450, 2) === 84876 — the exact poisoned value.
    expect(computeSafeLearnedWindow(96_450, 2)).toBe(84_876);

    const profile: ModelProfile = {
      id: '__virtual-working',
      name: 'Working',
      model: 'claude-opus-4-7',
      providerType: 'anthropic',
      serverUrl: '',
      isVirtual: true,
      contextWindowOverflowCount: 1,
      createdAt: 1,
    };
    const store = makeStore(withProfiles([profile], { learnedContextWindowEnabled: true }));
    store.install();

    recordContextOverflowOnProfile({
      model: 'claude-opus-4-7',
      profileId: '__virtual-working',
      lastKnownInputTokens: 96_450,
    });

    const updated = store.getState().localModel!.profiles![0];
    expect(updated.contextWindow).toBeUndefined();
    expect(updated.contextWindowSource).toBeUndefined();
  });

  it('does not emit settings:external-update for a catalogued model (flag on)', async () => {
    const broadcastModule = await import('@core/broadcastService');
    const original = broadcastModule.getBroadcastService();
    const captured: string[] = [];
    broadcastModule.setBroadcastService({
      sendToAllWindows: (channel: string) => {
        captured.push(channel);
      },
      sendToFocusedWindow: () => {},
    });

    try {
      const profile: ModelProfile = {
        id: 'p1',
        name: 'P1',
        model: 'claude-opus-4-7',
        providerType: 'anthropic',
        serverUrl: '',
        createdAt: 1,
      };
      const store = makeStore(withProfiles([profile], { learnedContextWindowEnabled: true }));
      store.install();

      recordContextOverflowOnProfile({
        model: 'claude-opus-4-7',
        profileId: 'p1',
        lastKnownInputTokens: 96_450,
      });

      expect(captured).toEqual([]);
    } finally {
      broadcastModule.setBroadcastService(original);
    }
  });
});

describe('recordOutputCapOnProfile', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('updates the profile resolved by id', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'gpt-test',
      providerType: 'other',
      serverUrl: 'https://example.test',
      createdAt: 1,
    };
    const store = makeStore(withProfiles([profile]));
    store.install();

    const result = recordOutputCapOnProfile({
      model: 'gpt-test',
      profileId: 'p1',
      observedCap: 8_192,
    });

    expect(result).toEqual({ ok: true, observedCap: 8_192, profileId: 'p1' });
    const updated = store.getState().localModel!.profiles![0];
    expect(updated.maxOutputTokens).toBe(8_192);
    expect(updated.outputTokensSource).toBe('auto');
    expect(updated.outputTokensOverflowCount).toBe(1);
    expect(typeof updated.outputTokensLearnedAt).toBe('number');
    expect(updated.lastLearnedOutputTokens).toBe(8_192);
  });

  it('clamps observedCap to registry max when parsed cap exceeds it', () => {
    const model = 'claude-haiku-4-5-20251001';
    const registryMax = getRegistryMaxOutputForModel(model);
    expect(registryMax).toBeDefined();

    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model,
      providerType: 'anthropic',
      serverUrl: '',
      createdAt: 1,
    };
    const store = makeStore(withProfiles([profile]));
    store.install();

    const result = recordOutputCapOnProfile({
      model,
      profileId: 'p1',
      observedCap: 500_000,
    });

    expect(result).toEqual({ ok: true, observedCap: registryMax!, profileId: 'p1' });
    const updated = store.getState().localModel!.profiles![0];
    expect(updated.maxOutputTokens).toBe(registryMax);
    expect(updated.lastLearnedOutputTokens).toBe(registryMax);
  });

  it('falls back to model match when no id is provided', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'gpt-test',
      providerType: 'other',
      serverUrl: 'https://example.test',
      createdAt: 1,
    };
    const store = makeStore(withProfiles([profile]));
    store.install();

    const result = recordOutputCapOnProfile({
      model: 'gpt-test',
      profileId: null,
      observedCap: 4_096,
    });

    expect(result).toEqual({ ok: true, observedCap: 4_096, profileId: 'p1' });
    expect(store.getState().localModel!.profiles![0].maxOutputTokens).toBe(4_096);
  });

  it('accepts unbounded observedCap when registry max is unknown', () => {
    const model = 'vendor/unknown-model-v1';
    expect(getRegistryMaxOutputForModel(model)).toBeUndefined();

    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model,
      providerType: 'other',
      serverUrl: 'https://example.test',
      createdAt: 1,
    };
    const store = makeStore(withProfiles([profile]));
    store.install();

    const result = recordOutputCapOnProfile({
      model,
      profileId: 'p1',
      observedCap: 500_000,
    });

    expect(result).toEqual({ ok: true, observedCap: 500_000, profileId: 'p1' });
    expect(store.getState().localModel!.profiles![0].maxOutputTokens).toBe(500_000);
  });

  it('auto-creates a non-selectable stub when no profile matches', () => {
    const store = makeStore(withProfiles([]));
    store.install();

    const result = recordOutputCapOnProfile({
      model: 'unknown-model',
      profileId: null,
      observedCap: 8_192,
    });

    expect(result).toEqual({ ok: true, observedCap: 8_192, profileId: 'auto:unknown-model' });
    const profiles = store.getState().localModel!.profiles!;
    expect(profiles).toHaveLength(1);
    const stub = profiles[0];
    expect(stub.id).toBe('auto:unknown-model');
    expect(stub.serverUrl).toBe('');
    expect(stub.enabled).toBe(false);
    expect(stub.outputTokensSource).toBe('auto');
    expect(stub.maxOutputTokens).toBe(8_192);
    expect(stub.lastLearnedOutputTokens).toBe(8_192);
  });

  it('returns user-source and does not write when output tokens are user-managed', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'gpt-test',
      providerType: 'other',
      serverUrl: 'https://example.test',
      maxOutputTokens: 12_000,
      outputTokensSource: 'user',
      createdAt: 1,
    };
    const store = makeStore(withProfiles([profile]));
    store.install();

    const result = recordOutputCapOnProfile({
      model: 'gpt-test',
      profileId: 'p1',
      observedCap: 8_192,
    });

    expect(result).toEqual({ ok: false, reason: 'user-source' });
    const updated = store.getState().localModel!.profiles![0];
    expect(updated.maxOutputTokens).toBe(12_000);
    expect(updated.outputTokensSource).toBe('user');
    expect(updated.outputTokensOverflowCount).toBeUndefined();
    expect(updated.outputTokensLearnedAt).toBeUndefined();
    expect(updated.lastLearnedOutputTokens).toBeUndefined();
  });

  it('returns company-managed and does not write on company-managed profiles', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'gpt-test',
      providerType: 'other',
      serverUrl: 'https://example.test',
      companyManaged: true,
      createdAt: 1,
    };
    const store = makeStore(withProfiles([profile]));
    store.install();

    const result = recordOutputCapOnProfile({
      model: 'gpt-test',
      profileId: 'p1',
      observedCap: 8_192,
    });

    expect(result).toEqual({ ok: false, reason: 'company-managed' });
    const updated = store.getState().localModel!.profiles![0];
    expect(updated.maxOutputTokens).toBeUndefined();
    expect(updated.outputTokensSource).toBeUndefined();
  });

  it('returns invalid-input for non-positive observedCap', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'gpt-test',
      providerType: 'other',
      serverUrl: 'https://example.test',
      createdAt: 1,
    };
    const store = makeStore(withProfiles([profile]));
    store.install();

    expect(recordOutputCapOnProfile({
      model: 'gpt-test',
      profileId: 'p1',
      observedCap: 0,
    })).toEqual({ ok: false, reason: 'invalid-input' });
    expect(recordOutputCapOnProfile({
      model: 'gpt-test',
      profileId: 'p1',
      observedCap: -10,
    })).toEqual({ ok: false, reason: 'invalid-input' });

    const updated = store.getState().localModel!.profiles![0];
    expect(updated.maxOutputTokens).toBeUndefined();
    expect(updated.outputTokensSource).toBeUndefined();
  });

  it('uses atomic min semantics under concurrent writes', async () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'gpt-test',
      providerType: 'other',
      serverUrl: 'https://example.test',
      createdAt: 1,
    };
    const store = makeStore(withProfiles([profile]));
    store.install();

    await Promise.all([
      Promise.resolve().then(() =>
        recordOutputCapOnProfile({
          model: 'gpt-test',
          profileId: 'p1',
          observedCap: 8_192,
        }),
      ),
      Promise.resolve().then(() =>
        recordOutputCapOnProfile({
          model: 'gpt-test',
          profileId: 'p1',
          observedCap: 4_096,
        }),
      ),
    ]);

    const updated = store.getState().localModel!.profiles![0];
    expect(updated.maxOutputTokens).toBe(4_096);
    expect(updated.lastLearnedOutputTokens).toBe(4_096);
  });

  it('returns persistence-failed when settings persistence throws and does not throw upward', () => {
    setSettingsStoreAdapter({
      getSettings: () => baseSettings(),
      updateSettings: () => {
        throw new Error('disk full');
      },
      updateSettingsAtomic: () => {
        throw new Error('disk full');
      },
    });

    expect(() =>
      recordOutputCapOnProfile({
        model: 'gpt-test',
        profileId: null,
        observedCap: 8_192,
      }),
    ).not.toThrow();

    const result = recordOutputCapOnProfile({
      model: 'gpt-test',
      profileId: null,
      observedCap: 8_192,
    });
    expect(result).toEqual({ ok: false, reason: 'persistence-failed' });
  });

  it('records the output cap regardless of the learnedContextWindowEnabled flag (flag off)', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'gpt-test',
      providerType: 'other',
      serverUrl: 'https://example.test',
      createdAt: 1,
    };
    // Context-window learning is OFF, but output-cap learning is independent.
    const store = makeStore(withProfiles([profile], { learnedContextWindowEnabled: false }));
    store.install();

    const result = recordOutputCapOnProfile({
      model: 'gpt-test',
      profileId: 'p1',
      observedCap: 8_192,
    });

    expect(result).toEqual({ ok: true, observedCap: 8_192, profileId: 'p1' });
    const updated = store.getState().localModel!.profiles![0];
    expect(updated.maxOutputTokens).toBe(8_192);
    expect(updated.outputTokensSource).toBe('auto');
  });

  it('skips legacy user-set maxOutputTokens that lacks an explicit outputTokensSource flag', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'unknown-model',
      providerType: 'other',
      serverUrl: 'https://example.test',
      maxOutputTokens: 24_000,
      createdAt: 1,
    };
    const store = makeStore(withProfiles([profile]));
    store.install();

    const result = recordOutputCapOnProfile({
      model: 'unknown-model',
      profileId: 'p1',
      observedCap: 8_192,
    });

    expect(result).toEqual({ ok: false, reason: 'user-source' });
    const updated = store.getState().localModel!.profiles![0];
    expect(updated.maxOutputTokens).toBe(24_000);
    expect(updated.outputTokensSource).toBeUndefined();
  });
});

describe('settings:external-update broadcast emission', () => {
  let originalBroadcast: BroadcastService | null = null;
  let captured: string[] = [];

  beforeEach(async () => {
    captured = [];
    const broadcastModule = await import('@core/broadcastService');
    originalBroadcast = broadcastModule.getBroadcastService();
    broadcastModule.setBroadcastService({
      sendToAllWindows: (channel: string) => {
        captured.push(channel);
      },
      sendToFocusedWindow: () => {},
    });
  });

  afterEach(async () => {
    if (originalBroadcast) {
      const broadcastModule = await import('@core/broadcastService');
      broadcastModule.setBroadcastService(originalBroadcast);
    }
  });

  it('emits settings:external-update after a successful output-cap write', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'gpt-test',
      providerType: 'other',
      serverUrl: 'https://example.test',
      createdAt: 1,
    };
    const store = makeStore(withProfiles([profile]));
    store.install();

    const result = recordOutputCapOnProfile({
      model: 'gpt-test',
      profileId: 'p1',
      observedCap: 8_192,
    });

    expect(result.ok).toBe(true);
    expect(captured).toEqual(['settings:external-update']);
  });

  it('does NOT emit settings:external-update when output-cap write is skipped (user-source)', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'gpt-test',
      providerType: 'other',
      serverUrl: 'https://example.test',
      maxOutputTokens: 12_000,
      outputTokensSource: 'user',
      createdAt: 1,
    };
    const store = makeStore(withProfiles([profile]));
    store.install();

    recordOutputCapOnProfile({
      model: 'gpt-test',
      profileId: 'p1',
      observedCap: 8_192,
    });

    expect(captured).toEqual([]);
  });

  it('emits settings:external-update after a successful context-overflow write', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'gpt-test',
      providerType: 'other',
      serverUrl: 'https://example.test',
      createdAt: 1,
    };
    const store = makeStore(withProfiles([profile]));
    store.install();

    recordContextOverflowOnProfile({
      model: 'gpt-test',
      profileId: 'p1',
      lastKnownInputTokens: 100_000,
    });

    expect(captured).toEqual(['settings:external-update']);
  });

  it('does NOT emit settings:external-update when context-overflow write is a no-op (user-source, not trapped)', () => {
    const profile: ModelProfile = {
      id: 'p1',
      name: 'P1',
      model: 'gpt-test',
      providerType: 'other',
      serverUrl: 'https://example.test',
      contextWindow: 80_000,
      contextWindowSource: 'user',
      createdAt: 1,
    };
    const store = makeStore(withProfiles([profile]));
    store.install();

    recordContextOverflowOnProfile({
      model: 'gpt-test',
      profileId: 'p1',
      lastKnownInputTokens: 100_000,
    });

    expect(captured).toEqual([]);
  });
});
