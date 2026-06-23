/**
 * Stage 4a — cooldown-aware multi-provider selection (the routing-side half of
 * failover). The route caller threads a snapshot of cooled-down credential
 * sources into the router input; `isUsableProviderMode` skips them so selection
 * fails over to the next usable provider. Pure: the cooldown set is an INPUT, not
 * a store read inside the router.
 *
 * Stage 4b — `getFailoverCredentialCandidates` (the cap helper that the recovery
 * handler uses to enumerate which credentials are usable ignoring cooldown).
 *
 * (The live 429→record→retry wiring — Stage 4b — lives in turnErrorRecovery /
 * agentTurnExecute and is tested separately; this file pins the selection seam
 * and the new cap helper.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import type { ActiveProvider } from '@shared/types';
import { ProviderRouter, getFailoverCredentialCandidates, type ProviderRouteSettings } from '../providerRouting';
import { isDispatchableDecision, type CodexConnectivity, type ProviderCredentialSource } from '../providerRouteDecision';
import { registerManagedKeyAvailability } from '../managedKeyAvailability';
import { providerRateLimitCooldowns } from '@core/services/providerRateLimitCooldowns';

const CLAUDE_MODEL = 'claude-sonnet-4-6';

function settings(opts: {
  activeProvider?: ActiveProvider;
  enabledProviders?: ActiveProvider[];
  flag?: boolean;
  apiKey?: string | null;
  openRouterToken?: string | null;
}): ProviderRouteSettings {
  return {
    activeProvider: opts.activeProvider,
    ...(opts.enabledProviders ? { enabledProviders: opts.enabledProviders } : {}),
    ...(opts.flag !== undefined ? { experimental: { multiProviderRoutingEnabled: opts.flag } } : {}),
    models: { apiKey: opts.apiKey ?? null, authMethod: 'api-key', model: CLAUDE_MODEL },
    openRouter: { enabled: Boolean(opts.openRouterToken), oauthToken: opts.openRouterToken ?? null, selectedModel: 'anthropic/claude-sonnet-4.6' },
    localModel: { activeProfileId: null, profiles: [] },
    providerKeys: {},
  };
}

function route(
  s: ProviderRouteSettings,
  cooledDown: ProviderCredentialSource[],
  codexConnectivity: CodexConnectivity = 'unknown',
) {
  return ProviderRouter.forTurn({
    settings: s,
    model: CLAUDE_MODEL,
    codexConnectivity,
    cooledDownCredentialSources: new Set(cooledDown),
  });
}

describe('Stage 4a — cooldown-aware multi-provider selection', () => {
  afterEach(() => registerManagedKeyAvailability(() => false));

  it('flag on, [openrouter, anthropic] both usable but openrouter-oauth-token cooled down ⇒ fails over to anthropic', () => {
    const decision = route(
      settings({ enabledProviders: ['openrouter', 'anthropic'], flag: true, apiKey: 'fake-anthropic-key', openRouterToken: 'or-token' }),
      ['openrouter-oauth-token'],
    );
    expect(decision.provider).toBe('anthropic');
    expect(isDispatchableDecision(decision)).toBe(true);
  });

  it('flag on, [openrouter, anthropic] with anthropic cooled down ⇒ keeps the head (openrouter)', () => {
    const decision = route(
      settings({ enabledProviders: ['openrouter', 'anthropic'], flag: true, apiKey: 'fake-anthropic-key', openRouterToken: 'or-token' }),
      ['anthropic-api-key'],
    );
    expect(decision.provider).toBe('openrouter');
    expect(isDispatchableDecision(decision)).toBe(true);
  });

  it('flag on, ALL candidates cooled down ⇒ still routes to the head (least-bad; recovery owns the re-try)', () => {
    const decision = route(
      settings({ enabledProviders: ['openrouter', 'anthropic'], flag: true, apiKey: 'fake-anthropic-key', openRouterToken: 'or-token' }),
      ['openrouter-oauth-token', 'anthropic-api-key'],
    );
    expect(decision.provider).toBe('openrouter'); // head
    expect(isDispatchableDecision(decision)).toBe(true);
  });

  it('SINGLE-provider user is never blocked by cooldown (single-element list ⇒ head fallback)', () => {
    // No enabledProviders list; activeProvider openrouter; its credential is cooled down.
    const decision = route(
      settings({ activeProvider: 'openrouter', flag: true, openRouterToken: 'or-token' }),
      ['openrouter-oauth-token'],
    );
    expect(decision.provider).toBe('openrouter');
    expect(isDispatchableDecision(decision)).toBe(true);
  });

  it('FLAG OFF ⇒ cooldown set is ignored (single legacy path, head fallback)', () => {
    const decision = route(
      settings({ activeProvider: 'anthropic', enabledProviders: ['openrouter', 'anthropic'], flag: false, apiKey: 'fake-anthropic-key', openRouterToken: 'or-token' }),
      ['anthropic-api-key'],
    );
    expect(decision.provider).toBe('anthropic');
  });

  it('no cooledDownCredentialSources input ⇒ behaves exactly like Stage 3 (no skipping)', () => {
    const decision = ProviderRouter.forTurn({
      settings: settings({ enabledProviders: ['openrouter', 'anthropic'], flag: true, apiKey: 'fake-anthropic-key', openRouterToken: 'or-token' }),
      model: CLAUDE_MODEL,
      codexConnectivity: 'unknown',
    });
    expect(decision.provider).toBe('openrouter'); // head, unskipped
  });
});

// ---------------------------------------------------------------------------
// Stage 4b — getFailoverCredentialCandidates (the cap helper)
// ---------------------------------------------------------------------------
describe('Stage 4b — getFailoverCredentialCandidates', () => {
  afterEach(() => registerManagedKeyAvailability(() => false));

  it('returns distinct credential sources for all usable providers (ignoring cooldown)', () => {
    const s = settings({ enabledProviders: ['openrouter', 'anthropic'], flag: true, apiKey: 'fake-anthropic-key', openRouterToken: 'or-token' });
    const result = getFailoverCredentialCandidates(s, { codexConnectivity: 'unknown' });
    // Both providers are usable (credentials present); openrouter → openrouter-oauth-token, anthropic → anthropic-api-key
    expect(result.size).toBe(2);
    expect(result.has('openrouter-oauth-token' as ProviderCredentialSource)).toBe(true);
    expect(result.has('anthropic-api-key' as ProviderCredentialSource)).toBe(true);
  });

  it('excludes providers with missing credentials (no cooldown — purely credential-based)', () => {
    // openrouter has no token → missing-openrouter → isUsableProviderMode returns false
    const s = settings({ enabledProviders: ['openrouter', 'anthropic'], flag: true, apiKey: 'fake-anthropic-key', openRouterToken: null });
    const result = getFailoverCredentialCandidates(s, { codexConnectivity: 'unknown' });
    // Only anthropic is usable
    expect(result.size).toBe(1);
    expect(result.has('anthropic-api-key' as ProviderCredentialSource)).toBe(true);
    expect(result.has('missing-openrouter' as ProviderCredentialSource)).toBe(false);
  });

  it('includes Codex as a candidate when codexConnectivity is "connected"', () => {
    // `codex` IS in enabledProviders, so a connected codex MUST surface as a
    // candidate. (Without `codex` in the list this assertion would be vacuous —
    // it could never appear regardless of connectivity.)
    const s = settings({ enabledProviders: ['codex', 'anthropic'], flag: true, apiKey: 'fake-anthropic-key' });
    const result = getFailoverCredentialCandidates(s, { codexConnectivity: 'connected' });
    expect(result.has('codex-subscription' as ProviderCredentialSource)).toBe(true);
    // Anthropic is also usable, so the set has both.
    expect(result.has('anthropic-api-key' as ProviderCredentialSource)).toBe(true);
    expect(result.size).toBe(2);
  });

  it('excludes Codex (but keeps other usable providers) when codexConnectivity is not "connected"', () => {
    // Discriminating: `codex` IS in enabledProviders this time. With connectivity
    // 'disconnected', codex-subscription must be filtered out by isUsableProviderMode
    // while the other usable provider (anthropic) survives. The earlier version of
    // this test put codex OUTSIDE the enabledProviders list, so the assertion was
    // vacuously true.
    const s = settings({ enabledProviders: ['codex', 'anthropic'], flag: true, apiKey: 'fake-anthropic-key' });
    const result = getFailoverCredentialCandidates(s, { codexConnectivity: 'disconnected' });
    expect(result.has('codex-subscription' as ProviderCredentialSource)).toBe(false);
    // Anthropic remains usable → still exactly one candidate.
    expect(result.has('anthropic-api-key' as ProviderCredentialSource)).toBe(true);
    expect(result.size).toBe(1);
  });

  it('single-provider → size 1', () => {
    // flag on + single provider
    const s = settings({ activeProvider: 'anthropic', flag: true, apiKey: 'fake-anthropic-key' });
    const result = getFailoverCredentialCandidates(s, { codexConnectivity: 'unknown' });
    expect(result.size).toBe(1);
    expect(result.has('anthropic-api-key' as ProviderCredentialSource)).toBe(true);
  });

  it('flag OFF → falls back to single selectProviderMode result (degenerate list)', () => {
    const s = settings({ activeProvider: 'anthropic', enabledProviders: ['openrouter', 'anthropic'], flag: false, apiKey: 'fake-anthropic-key', openRouterToken: 'or-token' });
    // With flag off, enumerateProviderModeCandidates returns [selectProviderMode(settings)] = anthropic
    const result = getFailoverCredentialCandidates(s, { codexConnectivity: 'unknown' });
    expect(result.size).toBe(1);
    expect(result.has('anthropic-api-key' as ProviderCredentialSource)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Store→seam end-to-end skip (Testing MA-2): real store cooled → router skips
// ---------------------------------------------------------------------------
describe('Stage 4a+4b end-to-end: real providerRateLimitCooldownStore → router skip', () => {
  // These tests use the REAL providerRateLimitCooldowns singleton (not a mock) and
  // call store.cooledDownSources() exactly as agentTurnExecute does to build the union:
  //   cooledDownCredentialSources: new Set([...store.cooledDownSources(), ...turnAttempted])
  // This discriminates the skip logic: if cooledDownSources() were not called (or the
  // union were skipped), the router would select anthropic-api-key (the cooled one) —
  // and the test would FAIL.

  beforeEach(() => {
    providerRateLimitCooldowns.clearAll();
    registerManagedKeyAvailability(() => false);
  });
  afterEach(() => {
    providerRateLimitCooldowns.clearAll();
    registerManagedKeyAvailability(() => false);
  });

  // F2 fix: anthropic is the HEAD — without the skip logic, the router would pick
  // anthropic-api-key (the head). The discriminating positive test verifies that when
  // anthropic-api-key is cooled, the store-fed skip actively redirects to openrouter.
  // Before this fix, enabledProviders was ['openrouter', 'anthropic'] — openrouter was
  // the head and won regardless of the skip, making the test vacuous.
  const twoProviderSettings = () => settings({
    enabledProviders: ['anthropic', 'openrouter'],
    flag: true,
    apiKey: 'fake-anthropic-key',
    openRouterToken: 'or-token',
  });

  it('real store: anthropic-api-key cooled → router picks openrouter-oauth-token (NOT anthropic)', () => {
    // Record a real cooldown for anthropic-api-key in the singleton store.
    providerRateLimitCooldowns.recordRateLimit('anthropic-api-key' as ProviderCredentialSource);

    // Build the union as agentTurnExecute does (MUST-FIX-1a path):
    //   cooledDownCredentialSources: new Set([...store.cooledDownSources(), ...turnAttempted])
    const turnAttempted: ProviderCredentialSource[] = [];
    const cooledDownCredentialSources = new Set<ProviderCredentialSource>([
      ...providerRateLimitCooldowns.cooledDownSources(),
      ...turnAttempted,
    ]);

    // cooledDownSources() MUST report anthropic-api-key — if this fires, the real store is broken.
    expect(cooledDownCredentialSources.has('anthropic-api-key' as ProviderCredentialSource)).toBe(true);

    const decision = ProviderRouter.forTurn({
      settings: twoProviderSettings(),
      model: CLAUDE_MODEL,
      codexConnectivity: 'unknown',
      cooledDownCredentialSources,
    });

    // Discriminating assertion: must be openrouter-oauth-token, NOT anthropic-api-key.
    // anthropic is the HEAD — without the store-fed skip, the router would pick
    // anthropic-api-key and this test would FAIL.
    expect(decision.credentialSource).toBe('openrouter-oauth-token');
    expect(decision.provider).toBe('openrouter');
    expect(isDispatchableDecision(decision)).toBe(true);
  });

  it('negative: empty store + empty attempted → no skipping; head (anthropic) wins', () => {
    // Precondition: store is empty (beforeEach cleared it).
    const cooledDownCredentialSources = new Set<ProviderCredentialSource>([
      ...providerRateLimitCooldowns.cooledDownSources(),
      ...[] as ProviderCredentialSource[],
    ]);
    expect(cooledDownCredentialSources.size).toBe(0);

    const decision = ProviderRouter.forTurn({
      settings: twoProviderSettings(),
      model: CLAUDE_MODEL,
      codexConnectivity: 'unknown',
      cooledDownCredentialSources,
    });

    // anthropic is the head in enabledProviders → selected when nothing is cooled.
    // Discriminating: if twoProviderSettings had openrouter as the head, this assertion
    // would be vacuous (openrouter wins regardless). With anthropic as head, this proves
    // the negative case correctly.
    expect(decision.credentialSource).toBe('anthropic-api-key');
    expect(decision.provider).toBe('anthropic');
    expect(isDispatchableDecision(decision)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F1/F3 regression — Codex→native-Claude divert: router-level skip proof
// ---------------------------------------------------------------------------
describe('F1 regression — Codex→Claude divert: both codex-subscription + anthropic-api-key cooled → router picks openrouter', () => {
  // This test corresponds to Test B in the Stage 4c spec.
  // Scenario: enabledProviders=[codex, openrouter, anthropic], Codex connected, Claude model.
  // Recovery handler (after F1 fix) adds BOTH 'anthropic-api-key' AND 'codex-subscription'
  // to the attempted set. This test proves the ROUTER correctly skips both and picks openrouter
  // — the F3 router-level proof that the skip set fully covers the divert case.
  //
  // Red→green: without the F1 fix in the recovery handler, 'codex-subscription' would NOT
  // be in the attempted set → the router sees codex as unskipped → picks codex (Codex would
  // then re-divert to the same cooled Anthropic credential). With both in the cooled set,
  // the router skips codex AND anthropic and picks openrouter.

  afterEach(() => {
    registerManagedKeyAvailability(() => false);
  });

  it('Codex connected + Claude model: codex-subscription + anthropic-api-key both cooled → router picks openrouter-oauth-token', () => {
    const s = settings({
      enabledProviders: ['codex', 'openrouter', 'anthropic'],
      flag: true,
      apiKey: 'fake-anthropic-key',
      openRouterToken: 'or-token',
    });

    // Both codex-subscription AND anthropic-api-key are in the attempted/cooled set
    // (as the F1-fixed recovery handler would produce after a Codex→Anthropic divert 429).
    const decision = route(s, ['codex-subscription', 'anthropic-api-key'], 'connected');

    // Discriminating: without the full skip set, the router would pick codex (or anthropic).
    // With both cooled, the only remaining usable candidate is openrouter.
    expect(decision.provider).toBe('openrouter');
    expect(decision.credentialSource).toBe('openrouter-oauth-token');
    expect(isDispatchableDecision(decision)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Managed-billing invariant (WS4b billing-correctness, GPT-5.5-extra-high MUST-ADDRESS)
//
// `mindstone` = MANAGED billing (Mindstone pays, via `mindstone-managed-key`). It must be
// used ONLY when the user has EXPLICITLY chosen it as their primary `activeProvider` — it is
// NEVER auto-selected as a failover/backup candidate. The router enforces this (the UI hides
// it from the backup chooser, but a persisted/cloud-synced/hand-edited `enabledProviders`
// list could still contain it). See `excludeManagedFromFailover` in providerRouting.ts.
// ---------------------------------------------------------------------------
describe('Managed-billing invariant — mindstone is never an auto-failover candidate', () => {
  afterEach(() => registerManagedKeyAvailability(() => false));

  it('(i) enabledProviders contains mindstone + activeProvider!=mindstone + primary 429 ⇒ failover candidates EXCLUDE managed', () => {
    // Managed key IS provisioned — so the ONLY thing keeping it out of the failover set is the
    // router invariant, not a missing credential (discriminating: without the filter,
    // mindstone-managed-key would be a usable candidate).
    registerManagedKeyAvailability(() => true);
    const s = settings({
      activeProvider: 'anthropic',
      enabledProviders: ['anthropic', 'openrouter', 'mindstone'],
      flag: true,
      apiKey: 'fake-anthropic-key',
      openRouterToken: 'or-token',
    });
    const candidates = getFailoverCredentialCandidates(s, { codexConnectivity: 'unknown' });
    // managed is excluded; the two real backups remain.
    expect(candidates.has('mindstone-managed-key' as ProviderCredentialSource)).toBe(false);
    expect(candidates.has('anthropic-api-key' as ProviderCredentialSource)).toBe(true);
    expect(candidates.has('openrouter-oauth-token' as ProviderCredentialSource)).toBe(true);
    expect(candidates.size).toBe(2);
  });

  it('(i-route) primary (anthropic) 429-cooled + mindstone enabled ⇒ router fails over to openrouter, NEVER managed', () => {
    registerManagedKeyAvailability(() => true);
    // anthropic is head + active; it is cooled. mindstone is in the list but must be skipped;
    // the next usable NON-managed provider is openrouter.
    const decision = route(
      settings({
        activeProvider: 'anthropic',
        enabledProviders: ['anthropic', 'mindstone', 'openrouter'],
        flag: true,
        apiKey: 'fake-anthropic-key',
        openRouterToken: 'or-token',
      }),
      ['anthropic-api-key'],
    );
    expect(decision.provider).toBe('openrouter');
    expect(decision.credentialSource).toBe('openrouter-oauth-token');
    expect(decision.credentialSource).not.toBe('mindstone-managed-key');
    expect(isDispatchableDecision(decision)).toBe(true);
  });

  it('(i-edge) mindstone enabled as ONLY backup but primary cooled ⇒ managed still excluded (routes to least-bad head, never managed)', () => {
    registerManagedKeyAvailability(() => true);
    // No non-managed backup exists; managed must STILL be excluded → the only candidate left
    // is the cooled head (anthropic). The router returns the head (recovery owns the re-try),
    // and crucially it is NOT mindstone-managed-key.
    const decision = route(
      settings({
        activeProvider: 'anthropic',
        enabledProviders: ['anthropic', 'mindstone'],
        flag: true,
        apiKey: 'fake-anthropic-key',
      }),
      ['anthropic-api-key'],
    );
    expect(decision.credentialSource).not.toBe('mindstone-managed-key');
    expect(decision.provider).not.toBe('openrouter'); // managed routes through openrouter — must not happen
    expect(decision.credentialSource).toBe('anthropic-api-key'); // head fallback
  });

  it('(ii) activeProvider=mindstone (explicit primary) ⇒ primary STILL resolves managed normally', () => {
    registerManagedKeyAvailability(() => true);
    // Explicit primary managed turn — flag ON, mindstone is the head/active. The invariant
    // keeps mindstone because it IS the active provider, so the primary resolves managed.
    const s = settings({
      activeProvider: 'mindstone',
      enabledProviders: ['mindstone', 'anthropic'],
      flag: true,
      apiKey: 'fake-anthropic-key',
    });
    const decision = ProviderRouter.forTurn({
      settings: { ...s, hasManagedKey: true },
      model: CLAUDE_MODEL,
      codexConnectivity: 'unknown',
    });
    expect(decision.provider).toBe('openrouter');
    expect(decision.credentialSource).toBe('mindstone-managed-key');
    expect(isDispatchableDecision(decision)).toBe(true);
  });

  it('(ii-flagoff) activeProvider=mindstone, flag OFF ⇒ degenerate primary path resolves managed unchanged', () => {
    registerManagedKeyAvailability(() => true);
    const decision = ProviderRouter.forTurn({
      settings: { ...settings({ activeProvider: 'mindstone', flag: false }), hasManagedKey: true },
      model: CLAUDE_MODEL,
      codexConnectivity: 'unknown',
    });
    expect(decision.credentialSource).toBe('mindstone-managed-key');
    expect(isDispatchableDecision(decision)).toBe(true);
  });

  it('(ii-mindstone-failover) activeProvider=mindstone ⇒ managed IS a legitimate failover candidate (explicit primary)', () => {
    // When the user explicitly chose mindstone as primary, the failover cap helper legitimately
    // includes mindstone-managed-key (the primary IS managed). The invariant only excludes
    // mindstone when it is NOT the active provider.
    registerManagedKeyAvailability(() => true);
    const s = settings({
      activeProvider: 'mindstone',
      enabledProviders: ['mindstone', 'anthropic'],
      flag: true,
      apiKey: 'fake-anthropic-key',
    });
    const candidates = getFailoverCredentialCandidates(
      { ...s, hasManagedKey: true },
      { codexConnectivity: 'unknown' },
    );
    expect(candidates.has('mindstone-managed-key' as ProviderCredentialSource)).toBe(true);
    expect(candidates.has('anthropic-api-key' as ProviderCredentialSource)).toBe(true);
  });

  it('(iii) non-mindstone failover chain is unchanged (behaviour preservation)', () => {
    const s = settings({
      activeProvider: 'anthropic',
      enabledProviders: ['anthropic', 'openrouter'],
      flag: true,
      apiKey: 'fake-anthropic-key',
      openRouterToken: 'or-token',
    });
    const candidates = getFailoverCredentialCandidates(s, { codexConnectivity: 'unknown' });
    expect(candidates.size).toBe(2);
    expect(candidates.has('anthropic-api-key' as ProviderCredentialSource)).toBe(true);
    expect(candidates.has('openrouter-oauth-token' as ProviderCredentialSource)).toBe(true);
    // And the cooled-head failover still picks the next non-managed provider exactly as before.
    const decision = route(s, ['anthropic-api-key']);
    expect(decision.provider).toBe('openrouter');
  });
});
