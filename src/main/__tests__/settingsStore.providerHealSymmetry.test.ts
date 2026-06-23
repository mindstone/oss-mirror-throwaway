import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { ActiveProvider } from '@shared/types/settings';
import { buildSettings } from '@core/__tests__/builders/settingsBuilder';

// FOX-3494 (#4 prevention) — Provider-heal SYMMETRY contract.
//
// The bug: OpenRouter shipped a reconnect/boot provider-heal
// (`applyOpenRouterProviderHeal`, commit 049c700f6) but codex never got the
// symmetric one. A ChatGPT-Pro user whose `activeProvider` drifted off `'codex'`
// (to anthropic / undefined) while valid codex tokens remained was stranded for
// a week — Settings said "connected" but every turn dead-ended on a provider
// with no credential. The class was named in the 260429 postmortems but the
// heal-symmetry was never wired into a gate.
//
// This contract test enumerates the FULL `ActiveProvider` union via a
// TS-exhaustive classification: every value must be classified as either a
// reconnect-healable subscription (must have a heal) or a non-healable provider
// (with a documented reason). A NEW provider added to the union without being
// classified here fails TO COMPILE (the `satisfies Record<ActiveProvider, …>`
// below), forcing the author to decide "does this provider need a heal?" rather
// than silently repeating the codex omission. For the healable providers it also
// pins the fire-only-on-unusable contract (never clobber a working selection).

let persistedStore: Record<string, unknown> | null = null;
let seedStore: Record<string, unknown> = {};
let readOnly = false;

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

vi.mock('@core/userDataWriteGate', () => ({
  isUserDataReadOnly: () => readOnly,
}));

const loadSettingsStore = async (seed: Partial<AppSettings> = {}) => {
  vi.resetModules();
  persistedStore = null;
  seedStore = deepClone(seed as Record<string, unknown>);
  return import('../settingsStore');
};

type SettingsStoreModule = Awaited<ReturnType<typeof loadSettingsStore>>;

/**
 * How a provider participates in the reconnect/boot heal contract.
 * - `codex` / `openrouter`: OAuth-reconnect subscriptions — a reconnect refreshes
 *   only the token, so the heal restores `activeProvider` when it drifted off a
 *   usable selection. These MUST have a heal.
 * - `anthropic`: BYOK API key — no OAuth reconnect flow, so no heal-TO target.
 * - `mindstone`: plan-managed (not an OAuth subscription the user reconnects);
 *   its credential is the managed-key probe, and there is no reconnect event to
 *   hang a heal on. Both are valid heal-FROM states (the codex heal yanks OFF
 *   them when unusable), but neither is a heal-TO subscription.
 */
type ProviderHealClass =
  | { kind: 'healable'; healExport: keyof SettingsStoreModule; reason: string }
  | { kind: 'no-heal'; reason: string };

// EXHAUSTIVE over `ActiveProvider`: a new provider added to the union forces a
// compile error here (`satisfies Record<ActiveProvider, …>`), so the omission
// that stranded the codex user cannot recur silently.
const PROVIDER_HEAL_CLASSIFICATION = {
  codex: {
    kind: 'healable',
    healExport: 'applyCodexProviderHeal',
    reason: 'ChatGPT Pro OAuth subscription — reconnect refreshes only the token',
  },
  openrouter: {
    kind: 'healable',
    healExport: 'applyOpenRouterProviderHeal',
    reason: 'OpenRouter OAuth subscription — the baseline heal (049c700f6)',
  },
  anthropic: {
    kind: 'no-heal',
    reason: 'BYOK API key — no OAuth reconnect flow, so no heal-TO target',
  },
  mindstone: {
    kind: 'no-heal',
    reason: 'plan-managed — no user-driven reconnect event to hang a heal on',
  },
} satisfies Record<ActiveProvider, ProviderHealClass>;

const healableProviders = Object.entries(PROVIDER_HEAL_CLASSIFICATION)
  .filter(([, cls]) => cls.kind === 'healable')
  .map(([provider, cls]) => ({
    provider: provider as ActiveProvider,
    healExport: (cls as Extract<ProviderHealClass, { kind: 'healable' }>).healExport,
  }));

describe('FOX-3494 provider-heal symmetry contract', () => {
  beforeEach(() => {
    persistedStore = null;
    seedStore = {};
    readOnly = false;
    delete process.env.ANTHROPIC_API_KEY;
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('classifies every ActiveProvider (new providers fail to compile until classified)', () => {
    // The `satisfies Record<ActiveProvider, …>` above is the real enforcement;
    // this assertion documents the runtime expectation and guards against an
    // empty/duplicated map.
    expect(Object.keys(PROVIDER_HEAL_CLASSIFICATION).sort()).toEqual(
      ['anthropic', 'codex', 'mindstone', 'openrouter'],
    );
    // At least one subscription must be healable, else the contract is vacuous.
    expect(healableProviders.length).toBeGreaterThan(0);
  });

  it('every reconnect-healable subscription provider exports a heal', async () => {
    const mod = await loadSettingsStore();
    for (const { provider, healExport } of healableProviders) {
      expect(
        typeof mod[healExport],
        `Provider '${provider}' is classified reconnect-healable but '${String(
          healExport,
        )}' is not exported from settingsStore — wire its provider-heal (the codex stranding was exactly this omission).`,
      ).toBe('function');
    }
  });

  describe('healable providers fire ONLY on an unusable / undefined / null state', () => {
    // codex heal: pure helper keyed on codexConnected + current-provider usability.
    it("codex: heals an unusable selection (anthropic + no key) but NOT a working one", async () => {
      const mod = await loadSettingsStore();
      const noKey = buildSettings({
        activeProvider: 'anthropic',
        claude: { ...buildSettings().models, apiKey: null, oauthToken: null },
        localModel: { profiles: [], activeProfileId: null },
        providerKeys: {},
      });

      // Unusable → heals to codex.
      expect(
        mod.applyCodexProviderHeal(noKey, { codexConnected: true, hasManagedKey: false }).healed,
      ).toBe(true);

      // undefined selection (drifted) → heals.
      expect(
        mod.applyCodexProviderHeal(
          { ...noKey, activeProvider: undefined },
          { codexConnected: true, hasManagedKey: false },
        ).healed,
      ).toBe(true);

      // null selection → heals.
      expect(
        mod.applyCodexProviderHeal(
          { ...noKey, activeProvider: null as unknown as undefined },
          { codexConnected: true, hasManagedKey: false },
        ).healed,
      ).toBe(true);

      // Working selection (anthropic WITH a key) → never clobbered.
      const working = buildSettings({
        activeProvider: 'anthropic',
        claude: { ...buildSettings().models, apiKey: 'real-anthropic-key' },
      });
      expect(
        mod.applyCodexProviderHeal(working, { codexConnected: true, hasManagedKey: false }).healed,
      ).toBe(false);

      // No usable subscription to heal TO (codex disconnected) → never fires.
      expect(
        mod.applyCodexProviderHeal(noKey, { codexConnected: false, hasManagedKey: false }).healed,
      ).toBe(false);
    });

    // openrouter heal: version-gated; fires on anthropic + no anthropic key + OR token.
    it('openrouter: heals an unusable anthropic selection with an OR token but NOT a working one', async () => {
      const mod = await loadSettingsStore();

      const stranded = buildSettings({
        activeProvider: 'anthropic',
        openRouter: { enabled: true, oauthToken: 'real-or-token', selectedModel: '' },
        claude: { ...buildSettings().models, apiKey: null, oauthToken: null },
        localModel: { profiles: [], activeProfileId: null },
        providerKeys: {},
        // version unstamped so the (one-shot) heal is eligible to run.
        openRouterProviderHealVersion: 0,
      } as Partial<AppSettings>);

      const healedResult = mod.applyOpenRouterProviderHeal(stranded);
      expect(healedResult.healed).toBe(true);

      // Working anthropic selection (has a key) → never clobbered even with an OR token.
      const working = buildSettings({
        activeProvider: 'anthropic',
        openRouter: { enabled: true, oauthToken: 'real-or-token', selectedModel: '' },
        claude: { ...buildSettings().models, apiKey: 'real-anthropic-key' },
        openRouterProviderHealVersion: 0,
      } as Partial<AppSettings>);
      expect(mod.applyOpenRouterProviderHeal(working).healed).toBe(false);

      // No OR token to heal TO → never fires.
      const noToken = buildSettings({
        activeProvider: 'anthropic',
        openRouter: { enabled: false, oauthToken: null, selectedModel: '' },
        claude: { ...buildSettings().models, apiKey: null, oauthToken: null },
        localModel: { profiles: [], activeProfileId: null },
        providerKeys: {},
        openRouterProviderHealVersion: 0,
      } as Partial<AppSettings>);
      expect(mod.applyOpenRouterProviderHeal(noToken).healed).toBe(false);
    });
  });
});
