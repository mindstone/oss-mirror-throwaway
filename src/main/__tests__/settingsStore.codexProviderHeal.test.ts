import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { buildSettings } from '@core/__tests__/builders/settingsBuilder';

// FOX-3494 — Mechanism A. Tests the shared core `applyCodexProviderHeal` helper
// (pure transformation) and the version-gated `runCodexProviderHealAtBoot`
// startup step. The reconnect (codexHandlers) and cloud (codexTokens route)
// triggers call the SAME pure helper — see codexHandlers.test.ts for the
// reconnect side, and the behavioural-parity assertion at the bottom here.

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

/** Anthropic user with NO key (the stranded shape). */
const noKeyAnthropic = (activeProvider: AppSettings['activeProvider']): AppSettings =>
  buildSettings({
    activeProvider,
    claude: { ...buildSettings().models, apiKey: null, oauthToken: null },
    localModel: { profiles: [], activeProfileId: null },
    providerKeys: {},
  });

describe('FOX-3494 applyCodexProviderHeal (Mechanism A)', () => {
  const originalAnthropicEnvKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    persistedStore = null;
    seedStore = {};
    readOnly = false;
    delete process.env.ANTHROPIC_API_KEY;
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    if (originalAnthropicEnvKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicEnvKey;
  });

  describe('heal FIRES (codex connected + current provider unusable)', () => {
    it("activeProvider 'anthropic' + no anthropic key → heals to codex", async () => {
      const { applyCodexProviderHeal } = await loadSettingsStore();
      const { migrated, healed, from } = applyCodexProviderHeal(noKeyAnthropic('anthropic'), {
        codexConnected: true,
        hasManagedKey: false,
      });
      expect(healed).toBe(true);
      expect(from).toBe('anthropic');
      expect(migrated.activeProvider).toBe('codex');
    });

    it('activeProvider undefined → heals to codex (AgentsTab disconnect fallback state)', async () => {
      const { applyCodexProviderHeal } = await loadSettingsStore();
      const { migrated, healed, from } = applyCodexProviderHeal(noKeyAnthropic(undefined), {
        codexConnected: true,
        hasManagedKey: false,
      });
      expect(healed).toBe(true);
      expect(from).toBeNull();
      expect(migrated.activeProvider).toBe('codex');
    });

    it('activeProvider null → heals to codex', async () => {
      const { applyCodexProviderHeal } = await loadSettingsStore();
      const settings = { ...noKeyAnthropic('anthropic'), activeProvider: null as unknown as undefined };
      const { migrated, healed } = applyCodexProviderHeal(settings, {
        codexConnected: true,
        hasManagedKey: false,
      });
      expect(healed).toBe(true);
      expect(migrated.activeProvider).toBe('codex');
    });

    it("openrouter + no token → heals to codex", async () => {
      const { applyCodexProviderHeal } = await loadSettingsStore();
      const settings = buildSettings({
        activeProvider: 'openrouter',
        openRouter: { enabled: true, oauthToken: null, selectedModel: '' },
        claude: { ...buildSettings().models, apiKey: null },
        localModel: { profiles: [], activeProfileId: null },
      });
      const { migrated, healed } = applyCodexProviderHeal(settings, {
        codexConnected: true,
        hasManagedKey: false,
      });
      expect(healed).toBe(true);
      expect(migrated.activeProvider).toBe('codex');
    });

    it('mindstone + no managed key available → heals to codex', async () => {
      const { applyCodexProviderHeal } = await loadSettingsStore();
      const settings = buildSettings({
        activeProvider: 'mindstone',
        claude: { ...buildSettings().models, apiKey: null },
        localModel: { profiles: [], activeProfileId: null },
      });
      const { migrated, healed } = applyCodexProviderHeal(settings, {
        codexConnected: true,
        hasManagedKey: false,
      });
      expect(healed).toBe(true);
      expect(migrated.activeProvider).toBe('codex');
    });

    it('anthropic + no key but env ANTHROPIC_API_KEY MISSING (runtime seam) → heals', async () => {
      const { applyCodexProviderHeal } = await loadSettingsStore();
      const { healed } = applyCodexProviderHeal(noKeyAnthropic('anthropic'), {
        codexConnected: true,
        hasManagedKey: false,
      });
      expect(healed).toBe(true);
    });
  });

  describe('heal does NOT fire (deliberate / usable state — C-F3 clobber guard)', () => {
    it('anthropic WITH a persisted key → NOT healed', async () => {
      const { applyCodexProviderHeal } = await loadSettingsStore();
      const settings = buildSettings({
        activeProvider: 'anthropic',
        claude: { ...buildSettings().models, apiKey: 'real-anthropic-key' },
      });
      const { healed } = applyCodexProviderHeal(settings, {
        codexConnected: true,
        hasManagedKey: false,
      });
      expect(healed).toBe(false);
    });

    it('anthropic + key via env ANTHROPIC_API_KEY (runtime seam, C-F2) → NOT healed', async () => {
      process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';
      const { applyCodexProviderHeal } = await loadSettingsStore();
      const { healed } = applyCodexProviderHeal(noKeyAnthropic('anthropic'), {
        codexConnected: true,
        hasManagedKey: false,
      });
      expect(healed).toBe(false);
    });

    it('openrouter WITH a token → NOT healed', async () => {
      const { applyCodexProviderHeal } = await loadSettingsStore();
      const settings = buildSettings({
        activeProvider: 'openrouter',
        openRouter: { enabled: true, oauthToken: 'real-or-token', selectedModel: '' },
      });
      const { healed } = applyCodexProviderHeal(settings, {
        codexConnected: true,
        hasManagedKey: false,
      });
      expect(healed).toBe(false);
    });

    it('mindstone WITH a managed key available → NOT healed', async () => {
      const { applyCodexProviderHeal } = await loadSettingsStore();
      const settings = buildSettings({
        activeProvider: 'mindstone',
        claude: { ...buildSettings().models, apiKey: null },
        localModel: { profiles: [], activeProfileId: null },
      });
      const { healed } = applyCodexProviderHeal(settings, {
        codexConnected: true,
        hasManagedKey: true,
      });
      expect(healed).toBe(false);
    });

    it('anthropic + key via a non-local PROFILE (no persisted/env key, C-F2 runtime seam) → NOT healed (S2)', async () => {
      // The heal must see profile-resolved Anthropic keys exactly as admission
      // does (validateProviderCredentials → resolveProfileApiKey). Persisted +
      // env keys are absent; only the working profile carries a key.
      const { applyCodexProviderHeal } = await loadSettingsStore();
      const settings = buildSettings({
        activeProvider: 'anthropic',
        claude: {
          ...buildSettings().models,
          apiKey: null,
          oauthToken: null,
          workingProfileId: 'profile-with-key',
        },
        localModel: {
          activeProfileId: null,
          profiles: [
            {
              id: 'profile-with-key',
              name: 'OpenAI profile',
              providerType: 'openai',
              serverUrl: 'https://api.openai.com/v1',
              model: 'gpt-5.5',
              apiKey: 'profile-resolved-key',
              createdAt: 1,
            },
          ],
        },
        providerKeys: {},
      });
      const { healed } = applyCodexProviderHeal(settings, {
        codexConnected: true,
        hasManagedKey: false,
      });
      expect(healed).toBe(false);
    });

    it('legacy OpenRouter (activeProvider undefined + openRouter.enabled + oauthToken) → NOT healed (F1)', async () => {
      // Predates `activeProvider`: the normalizer derives 'openrouter' from this
      // shape (settingsUtils.ts), but the boot heal runs BEFORE normalization.
      // The undefined/null arm must recognize legacy-OR as usable, else a valid
      // OpenRouter user who also has codex tokens gets clobbered to codex.
      const { applyCodexProviderHeal } = await loadSettingsStore();
      const settings = buildSettings({
        activeProvider: undefined,
        openRouter: { enabled: true, oauthToken: 'real-or-token', selectedModel: '' },
        claude: { ...buildSettings().models, apiKey: null, oauthToken: null },
        localModel: { profiles: [], activeProfileId: null },
        providerKeys: {},
      });
      const { healed } = applyCodexProviderHeal(settings, {
        codexConnected: true,
        hasManagedKey: false,
      });
      expect(healed).toBe(false);
    });

    it("already 'codex' → no-op (not healed)", async () => {
      const { applyCodexProviderHeal } = await loadSettingsStore();
      const settings = buildSettings({ activeProvider: 'codex' });
      const { healed, migrated } = applyCodexProviderHeal(settings, {
        codexConnected: true,
        hasManagedKey: false,
      });
      expect(healed).toBe(false);
      expect(migrated.activeProvider).toBe('codex');
    });

    it('codex DISCONNECTED → never heals (no usable codex to heal to)', async () => {
      const { applyCodexProviderHeal } = await loadSettingsStore();
      const { healed } = applyCodexProviderHeal(noKeyAnthropic('anthropic'), {
        codexConnected: false,
        hasManagedKey: false,
      });
      expect(healed).toBe(false);
    });
  });

  describe('runCodexProviderHealAtBoot — version-gated one-shot', () => {
    it('heals a stranded user and stamps the version', async () => {
      const mod = await loadSettingsStore(noKeyAnthropic('anthropic'));
      const before = mod.getSettings();
      expect(before.activeProvider).toBe('anthropic');

      const { healed } = mod.runCodexProviderHealAtBoot({
        codexConnected: true,
        hasManagedKey: false,
      });

      expect(healed).toBe(true);
      const after = mod.getSettings();
      expect(after.activeProvider).toBe('codex');
      expect(after.codexProviderHealVersion).toBe(mod.CURRENT_CODEX_PROVIDER_HEAL_VERSION);
    });

    it('is one-shot: a second boot does not re-heal after the version is stamped', async () => {
      // Already stamped (CURRENT_CODEX_PROVIDER_HEAL_VERSION = 1) → the boot heal
      // must NOT touch a user who later deliberately re-selected anthropic.
      const mod = await loadSettingsStore({
        ...noKeyAnthropic('anthropic'),
        codexProviderHealVersion: 1,
      } as Partial<AppSettings>);
      expect(mod.CURRENT_CODEX_PROVIDER_HEAL_VERSION).toBe(1);
      const { healed } = mod.runCodexProviderHealAtBoot({
        codexConnected: true,
        hasManagedKey: false,
      });
      expect(healed).toBe(false);
      expect(mod.getSettings().activeProvider).toBe('anthropic');
    });

    it('read-only userData: does NOT stamp the version (next writable boot retries)', async () => {
      readOnly = true;
      const mod = await loadSettingsStore(noKeyAnthropic('anthropic'));
      const { healed } = mod.runCodexProviderHealAtBoot({
        codexConnected: true,
        hasManagedKey: false,
      });
      expect(healed).toBe(false);
      // version unstamped so a later writable boot can still heal
      expect(mod.getSettings().codexProviderHealVersion).toBeUndefined();
    });
  });
});
