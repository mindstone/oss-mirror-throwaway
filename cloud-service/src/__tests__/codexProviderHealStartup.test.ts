/**
 * FOX-3494 (F1 follow-up) — cloud-STARTUP codex provider heal.
 *
 * A cloud/mobile-primary user whose codex tokens are ALREADY present but whose
 * `activeProvider` drifted off 'codex' (e.g. to 'anthropic'/undefined) has no
 * heal trigger: the cloud token-POST heal (routes/codexTokens.ts) only fires
 * when desktop re-POSTs a token. The cloud bootstrap now runs the SAME
 * version-gated `runCodexProviderHealAtBoot` core helper as the desktop boot
 * heal, after `ensureNormalizedSettings()`, using the cloud seams
 * (`hasCodexTokens()` + `getManagedKeyAvailability()`).
 *
 * These tests exercise that exact startup step against the real cloud settings
 * + token stores (the `cloud-service` vitest project wires both), with NO token
 * POST — proving the gap the token-POST heal leaves is closed.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mirror src/core/rebelCore/__tests__/managedKeyAvailability.test.ts: spy on the
// leaf module's scoped logger so we can assert the `managed-key-availability-unwired`
// error marker is NOT emitted while the cloud startup heal reads the seam (proving
// the bootstrap wires the seam BEFORE the heal). The marker is the ONLY signal that
// a surface read the seam before registering its provider.
const { managedKeyErrorSpy } = vi.hoisted(() => ({ managedKeyErrorSpy: vi.fn() }));
vi.mock('@core/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/logger')>();
  return {
    ...actual,
    createScopedLogger: (bindings: Record<string, unknown>) => {
      const child = actual.createScopedLogger(bindings);
      // Only intercept the leaf module's logger; everything else logs as usual.
      if (bindings.service === 'managedKeyAvailability') {
        return { ...child, error: managedKeyErrorSpy } as typeof child;
      }
      return child;
    },
  };
});

import {
  saveCodexTokens,
  clearCodexTokens,
  hasCodexTokens,
} from '@core/services/codexTokenStorage';
import {
  getSettings,
  updateSettings,
  runCodexProviderHealAtBoot,
  applyCodexProviderHeal,
  CURRENT_CODEX_PROVIDER_HEAL_VERSION,
} from '@core/services/settingsStore/index';
import {
  getManagedKeyAvailability,
  registerManagedKeyAvailability,
  __resetManagedKeyAvailabilityForTesting,
} from '@core/rebelCore/managedKeyAvailability';

/** Seed valid codex tokens (the "already connected" precondition). */
function seedCodexTokens(): void {
  saveCodexTokens(
    {
      accessToken: 'access-startup-heal',
      refreshToken: 'refresh-startup-heal',
      expiresAt: Date.now() + 60_000,
      accountId: 'acct_startup_heal',
    },
    { cause: 'sync_update', source: 'codex_sync_route' },
  );
}

/**
 * Run the cloud bootstrap's startup heal step exactly as `bootstrap()` does —
 * same helper, same cloud seams (`hasCodexTokens()` + `getManagedKeyAvailability()`).
 */
function runStartupHeal() {
  return runCodexProviderHealAtBoot({
    codexConnected: hasCodexTokens(),
    hasManagedKey: getManagedKeyAvailability(),
  });
}

/**
 * Put settings into the F1 "stranded" shape: an unusable `openrouter`-no-token
 * selection. openrouter is preferred over anthropic because its credential check
 * reads ONLY `settings.openRouter.oauthToken` — no env-var (`ANTHROPIC_API_KEY`)
 * dependence — so the test is deterministic regardless of the runner's env (the
 * cloud test env may carry a live ANTHROPIC_API_KEY, which would make an
 * anthropic-no-key shape legitimately usable via the C-F2 runtime seam).
 */
function strandOnOpenRouterNoToken(): void {
  updateSettings({
    activeProvider: 'openrouter',
    openRouter: { enabled: true, oauthToken: null, selectedModel: '' },
  });
}

describe('FOX-3494 (F1) cloud-startup codex provider heal', () => {
  const originalAnthropicEnvKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    clearCodexTokens({ cause: 'manual_logout', source: 'codex_auth_core' });
    // Reset the one-shot version gate so each test exercises a fresh boot.
    updateSettings({ codexProviderHealVersion: undefined });
    managedKeyErrorSpy.mockClear();
    // Faithfully model the cloud bootstrap ordering: the managed-key seam is
    // registered (fail-closed `() => false`) BEFORE the startup heal reads it.
    __resetManagedKeyAvailabilityForTesting();
    registerManagedKeyAvailability(() => false);
  });

  afterEach(() => {
    if (originalAnthropicEnvKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicEnvKey;
    __resetManagedKeyAvailabilityForTesting();
  });

  it('codex tokens present + stale activeProvider + NO token POST → startup heals to codex', () => {
    // The exact F1 state: tokens already there (no POST in this test), provider
    // drifted to an unusable selection.
    strandOnOpenRouterNoToken();
    seedCodexTokens();
    expect(getSettings().activeProvider).toBe('openrouter');

    const { healed } = runStartupHeal();

    expect(healed).toBe(true);
    expect(getSettings().activeProvider).toBe('codex');
    // One-shot: the version is stamped so a later boot does not re-heal.
    expect(getSettings().codexProviderHealVersion).toBe(CURRENT_CODEX_PROVIDER_HEAL_VERSION);
  });

  it('startup heal reads a WIRED managed-key seam → no `managed-key-availability-unwired` error', () => {
    // The fix: cloud bootstrap registers `registerManagedKeyAvailability(() => false)`
    // BEFORE the startup heal. So when the heal reads `getManagedKeyAvailability()`,
    // the seam is wired and the leaf module's unwired error marker never fires.
    // This FAILS on the old ordering (registration only in the later BTS block),
    // where the heal-time read hit the unwired branch on every boot.
    strandOnOpenRouterNoToken();
    seedCodexTokens();

    const { healed } = runStartupHeal();

    expect(healed).toBe(true);
    expect(getSettings().activeProvider).toBe('codex');
    // The seam was wired before the heal read it → no unwired error.
    const unwiredCalls = managedKeyErrorSpy.mock.calls.filter(
      ([arg]) =>
        typeof arg === 'object' &&
        arg !== null &&
        (arg as { marker?: unknown }).marker === 'managed-key-availability-unwired',
    );
    expect(unwiredCalls).toHaveLength(0);
  });

  it('guard: an UNWIRED seam read DOES fire the marker (proves the assertion bites)', () => {
    // Sanity: with the seam left unwired (the old cloud ordering), the same
    // heal-time read trips the marker — so the no-unwired assertion above is a
    // real guard, not a vacuous one.
    __resetManagedKeyAvailabilityForTesting();
    strandOnOpenRouterNoToken();
    seedCodexTokens();

    runStartupHeal();

    const unwiredCalls = managedKeyErrorSpy.mock.calls.filter(
      ([arg]) =>
        typeof arg === 'object' &&
        arg !== null &&
        (arg as { marker?: unknown }).marker === 'managed-key-availability-unwired',
    );
    expect(unwiredCalls.length).toBeGreaterThan(0);
  });

  it('stale anthropic-no-key + NO env key (C-F2 runtime seam) → startup heals to codex', () => {
    // Honest exercise of the anthropic arm: with no persisted key AND no env
    // ANTHROPIC_API_KEY, the runtime credential seam (C-F2) reports it unusable.
    delete process.env.ANTHROPIC_API_KEY;
    updateSettings({
      activeProvider: 'anthropic',
      claude: { ...getSettings().models, apiKey: null, oauthToken: null },
      openRouter: { enabled: false, oauthToken: null, selectedModel: '' },
    });
    seedCodexTokens();

    const { healed } = runStartupHeal();

    expect(healed).toBe(true);
    expect(getSettings().activeProvider).toBe('codex');
  });

  it('no-heal guard: usable provider (openrouter WITH token) → startup does NOT heal', () => {
    updateSettings({
      activeProvider: 'openrouter',
      openRouter: { enabled: true, oauthToken: 'real-or-token', selectedModel: '' },
    });
    seedCodexTokens();

    const { healed } = runStartupHeal();

    expect(healed).toBe(false);
    expect(getSettings().activeProvider).toBe('openrouter');
  });

  it('no-heal guard: no codex tokens → startup does NOT heal (codexConnected false)', () => {
    strandOnOpenRouterNoToken();
    // No tokens seeded → hasCodexTokens() is false.
    expect(hasCodexTokens()).toBe(false);

    const { healed } = runStartupHeal();

    expect(healed).toBe(false);
  });

  it('parity: cloud startup heal uses the same helper + verdict as desktop boot', () => {
    // Behavioural parity (Runtime-Safety T-3): the startup step and the desktop
    // boot heal both call the identical exported `applyCodexProviderHeal`, so an
    // identical stranded input yields an identical verdict regardless of surface.
    strandOnOpenRouterNoToken();
    const stranded = getSettings();
    const { migrated, healed } = applyCodexProviderHeal(stranded, {
      codexConnected: true,
      hasManagedKey: false,
    });
    expect(healed).toBe(true);
    expect(migrated.activeProvider).toBe('codex');
  });

  it('source-order guard: bootstrap registers the managed-key seam BEFORE the startup heal reads it (FOX-3497)', () => {
    // The behavior tests above register the seam in `beforeEach`, so they would
    // NOT catch a future move of `registerManagedKeyAvailability(...)` to AFTER
    // `runCodexProviderHealAtBoot(...)` in the real `bootstrap()`. That move is
    // the exact regression a genuine-GPT review flagged: an unwired managed-key
    // read at heal time logs a spurious error-level marker on every cloud boot.
    // This static guard pins the real source ordering deterministically.
    // (Layer 3: the registrant is now `() => hasManagedOpenRouterKey()`, the
    // live store read — match on the call name, not the old `() => false` stub.)
    const bootstrapSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'bootstrap.ts'),
      'utf8',
    );
    const registerIdx = bootstrapSrc.indexOf('registerManagedKeyAvailability(() => hasManagedOpenRouterKey())');
    const healIdx = bootstrapSrc.indexOf('runCodexProviderHealAtBoot(');
    expect(registerIdx).toBeGreaterThan(-1);
    expect(healIdx).toBeGreaterThan(-1);
    expect(registerIdx).toBeLessThan(healIdx);
  });
});
