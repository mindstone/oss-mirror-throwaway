/**
 * Stage 0 characterization — `bestNonCodexProvider` precedence (providerRouting.ts:~265).
 *
 * `bestNonCodexProvider` is a private helper, so this pins its behaviour through
 * the only public seam that consults it: the `codex-rate-limit-provider`
 * fallback rebuild (`forTurnWithFallback` → `fallbackInputForHint`). That branch
 * calls `bestNonCodexProvider(settings)` ONLY when the current `activeProvider`
 * is `codex` (or unset); a non-codex active provider short-circuits and is kept
 * as-is (pinned by I7 "respects pre-set activeProvider" in
 * providerRouting.invariants.test.ts).
 *
 * The precedence to lock (per PLAN.md seam 2): with BOTH OpenRouter and
 * Anthropic credentials present, `bestNonCodexProvider` returns **OpenRouter**
 * (OpenRouter-wins). Otherwise it falls back to whichever single credential is
 * present, and to null when neither is.
 *
 * The existing I7 tests cover the OpenRouter-wins case once (both creds →
 * openrouter) and the pre-set-activeProvider short-circuit, but always with
 * `forceNonCodexTransport: true`. This file pins the full precedence TABLE
 * (both / openrouter-only / anthropic-only / neither) so the Stage 1–2
 * restructure cannot silently reorder it.
 *
 * `forceNonCodexTransport: true` is set throughout so connectivity is driven to
 * `disconnected` and we read the rebuilt provider directly without the codex
 * connectivity snapshot interfering. The null case (no non-codex provider) is
 * pinned by observing the rebuild keeps the original codex settings (no
 * provider swap), which under disconnected connectivity yields a codex
 * `missing-codex-connection` terminal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { forTurnWithFallback, ProviderRouter, type ProviderRouteSettings } from '../providerRouting';
import { materializePlanRuntime } from '../providerRoutePlan';
import { registerManagedKeyAvailability } from '../managedKeyAvailability';

const RATE_LIMIT_PROVIDER_HINT = {
  kind: 'codex-rate-limit-provider' as const,
  forceNonCodexTransport: true as const,
};

function codexSettings(overrides: {
  apiKey?: string | null;
  oauthToken?: string | null;
  authMethod?: 'api-key' | 'oauth-token';
  openRouterToken?: string | null;
}): ProviderRouteSettings {
  return {
    activeProvider: 'codex',
    models: {
      apiKey: overrides.apiKey ?? null,
      oauthToken: overrides.oauthToken ?? null,
      authMethod: overrides.authMethod ?? 'api-key',
      model: 'gpt-5.5',
    },
    openRouter: {
      enabled: false,
      oauthToken: overrides.openRouterToken ?? null,
      selectedModel: 'anthropic/claude-sonnet-4.6',
    },
    localModel: { activeProfileId: null, profiles: [] },
    providerKeys: {},
  };
}

/**
 * Rebuilds a fresh in-flight codex plan, then applies the
 * `codex-rate-limit-provider` rebuild against the given settings.
 *
 * The rebuild model is `'gpt-5.5'` (a bare non-claude model). This is
 * deliberate: a native-claude model (e.g. `claude-sonnet-4-6`) would hit the
 * codex arm's claude→Anthropic divert in `routeDecision` REGARDLESS of
 * `bestNonCodexProvider`, masking the precedence under test. With a non-claude
 * model the rebuilt provider reflects `bestNonCodexProvider`'s choice directly:
 * a swap to openrouter/anthropic when a credential exists, or codex left
 * unchanged (failing closed under disconnected) when none does.
 */
async function rebuildAfterCodexRateLimit(settings: ProviderRouteSettings) {
  const inFlightDecision = ProviderRouter.forTurn({
    settings,
    model: 'gpt-5.5',
    codexConnectivity: 'connected',
  });
  const inFlightPlan = await materializePlanRuntime(inFlightDecision);
  return forTurnWithFallback(
    { settings, model: 'gpt-5.5', codexConnectivity: 'disconnected' },
    RATE_LIMIT_PROVIDER_HINT,
    inFlightPlan,
  );
}

describe('bestNonCodexProvider precedence (via codex-rate-limit-provider fallback) — Stage 0 characterization', () => {
  afterEach(() => {
    registerManagedKeyAvailability(() => false);
  });

  it('BOTH OpenRouter + Anthropic credentials present → OpenRouter wins', async () => {
    const decision = await rebuildAfterCodexRateLimit(
      codexSettings({ apiKey: 'fake-anthropic-key', openRouterToken: 'or-token' }),
    );
    expect(decision.provider).toBe('openrouter');
    expect(decision.transport).toBe('openrouter-proxy');
    expect(decision.credentialSource).toBe('openrouter-oauth-token');
    expect(decision.codexConnectivity).toBe('disconnected');
  });

  it('OpenRouter credential only (no Anthropic) → OpenRouter', async () => {
    const decision = await rebuildAfterCodexRateLimit(
      codexSettings({ apiKey: null, openRouterToken: 'or-token' }),
    );
    expect(decision.provider).toBe('openrouter');
    expect(decision.transport).toBe('openrouter-proxy');
    expect(decision.credentialSource).toBe('openrouter-oauth-token');
  });

  it('Anthropic credential only (no OpenRouter) → Anthropic', async () => {
    const decision = await rebuildAfterCodexRateLimit(
      codexSettings({ apiKey: 'fake-anthropic-key', openRouterToken: null }),
    );
    expect(decision.provider).toBe('anthropic');
    expect(decision.transport).toBe('anthropic-direct');
    expect(decision.credentialSource).toBe('anthropic-api-key');
  });

  it('Anthropic via OAuth-token only (api key absent, authMethod oauth-token) → Anthropic', async () => {
    const decision = await rebuildAfterCodexRateLimit(
      codexSettings({ apiKey: null, oauthToken: 'oauth-tok', authMethod: 'oauth-token', openRouterToken: null }),
    );
    expect(decision.provider).toBe('anthropic');
    expect(decision.transport).toBe('anthropic-direct');
    expect(decision.credentialSource).toBe('anthropic-oauth-token');
  });

  it('NEITHER credential present → no non-codex provider; settings stay codex and fail closed (missing-codex-connection under disconnected)', async () => {
    // bestNonCodexProvider returns null, so fallbackInputForHint leaves the
    // codex settings unchanged. With connectivity forced to disconnected, the
    // codex arm of routeDecision fails closed.
    const decision = await rebuildAfterCodexRateLimit(
      codexSettings({ apiKey: null, openRouterToken: null }),
    );
    expect(decision.provider).toBe('codex');
    expect(decision.kind).toBe('terminal');
    expect(decision.invalidReason).toBe('missing-codex-connection');
  });

  it('whitespace-only OpenRouter token does NOT count as a credential (Anthropic wins when it has a real key)', async () => {
    const decision = await rebuildAfterCodexRateLimit(
      codexSettings({ apiKey: 'fake-anthropic-key', openRouterToken: '   ' }),
    );
    expect(decision.provider).toBe('anthropic');
  });

  it('activeProvider UNSET also consults bestNonCodexProvider (OpenRouter-wins) — not only codex (F5 from GPT review)', async () => {
    // fallbackInputForHint's codex-rate-limit-provider branch is
    // `currentProvider && currentProvider !== 'codex' ? currentProvider :
    // bestNonCodexProvider(settings)`. An UNSET activeProvider is falsy, so it
    // ALSO falls into bestNonCodexProvider. Pin that the unset branch behaves
    // like the codex branch (both creds → OpenRouter-wins).
    const settings: ProviderRouteSettings = {
      activeProvider: undefined,
      models: { apiKey: 'fake-anthropic-key', authMethod: 'api-key', model: 'gpt-5.5' },
      openRouter: { enabled: false, oauthToken: 'or-token', selectedModel: 'anthropic/claude-sonnet-4.6' },
      localModel: { activeProfileId: null, profiles: [] },
      providerKeys: {},
    };
    const inFlightDecision = ProviderRouter.forTurn({ settings, model: 'gpt-5.5', codexConnectivity: 'connected' });
    const inFlightPlan = await materializePlanRuntime(inFlightDecision);
    const decision = forTurnWithFallback(
      { settings, model: 'gpt-5.5', codexConnectivity: 'disconnected' },
      RATE_LIMIT_PROVIDER_HINT,
      inFlightPlan,
    );
    expect(decision.provider).toBe('openrouter');
    expect(decision.transport).toBe('openrouter-proxy');
    expect(decision.credentialSource).toBe('openrouter-oauth-token');
  });
});
