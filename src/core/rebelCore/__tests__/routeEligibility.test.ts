/**
 * Stage 3 — typed model-eligibility authority (a pure view over routeDecision).
 *
 * Covers:
 *   - the F6 KILL contract: Codex active + Claude thinking model + no Anthropic
 *     key + working==thinking profile => typed `ineligible` with
 *     source:'credentials' / reason:<missing-anthropic>, NOT an eligible plan.
 *   - exhaustive, by-construction source mapping over ProviderRouteInvalidReason.
 *   - BTS `fast` + subagent unservable-Claude-under-Codex => typed ineligible
 *     (REBEL-538 symmetric surface, at the authority level).
 *   - servable cases stay eligible (behaviour-preserving).
 *   - `connectedProviders` is INERT (does not change the verdict).
 */
import { describe, expect, it } from 'vitest';
import type { AppSettings } from '@shared/types';
import { unsafeAssertRoutingModelId, type RoutingModelId } from '@shared/utils/modelChoiceCodec';
import type { ProviderRouteInvalidReason, ProviderRouteRole } from '../providerRouteDecision';
import type { ProviderRouteSettings } from '../providerRouting';
import {
  eligibilityFromDecision,
  eligible,
  type EligibilitySource,
  type ModelCandidate,
  type RouteEligibilityContext,
} from '../routeEligibility';
import { settings as harnessSettings } from './helpers/providerResolutionHarness';

// Route through the codec's branded construction API (not an `as` cast) per
// the no-model-brand-casts rule.
const asRoutingModelId = (value: string): RoutingModelId => unsafeAssertRoutingModelId(value);

function routeSettings(overrides: Parameters<typeof harnessSettings>[0] = {}): ProviderRouteSettings {
  return harnessSettings(overrides) as unknown as ProviderRouteSettings;
}

function candidate(model: string, role: ProviderRouteRole): ModelCandidate {
  return { model: asRoutingModelId(model), role };
}

describe('eligible() — F6 kill contract', () => {
  it('Codex active + Claude thinking model + no Anthropic key => ineligible/credentials, NOT an eligible plan', () => {
    const ctx: RouteEligibilityContext = {
      settings: routeSettings({
        activeProvider: 'codex',
        // No Anthropic credentials (working==thinking profile collapses to the same no-key state).
        models: { apiKey: null, oauthToken: null } as AppSettings['models'],
      }),
      activeProvider: 'codex',
      codexConnectivity: 'connected',
    };

    const result = eligible(candidate('claude-sonnet-4-6', 'planning'), ctx);

    expect(result.kind).toBe('ineligible');
    if (result.kind !== 'ineligible') throw new Error('expected ineligible');
    // FOX-3494: a PRIMARY (planning) claude-* turn under connected ChatGPT Pro is
    // now a route-level dead-end (the model can't run on this provider), not a
    // bare credentials gap — surfaced as an actionable "switch to a GPT model"
    // terminal. Still ineligible; the message names the (recoverable) provider.
    expect(result.source).toBe('route');
    expect(result.reason).toMatch(/Anthropic/i);
    expect(result.retryAfter).toBeUndefined();
  });

  it('does NOT silently produce an Anthropic-direct eligible plan for the kill scenario', () => {
    const ctx: RouteEligibilityContext = {
      settings: routeSettings({
        activeProvider: 'codex',
        models: { apiKey: null, oauthToken: null } as AppSettings['models'],
      }),
      codexConnectivity: 'connected',
    };
    const result = eligible(candidate('claude-sonnet-4-6', 'planning'), ctx);
    expect(result.kind).not.toBe('eligible');
  });
});

describe('eligible() — servable cases stay eligible (behaviour-preserving)', () => {
  it('Anthropic active + Claude model + key present => eligible', () => {
    const ctx: RouteEligibilityContext = {
      settings: routeSettings({ activeProvider: 'anthropic' }),
      codexConnectivity: 'unknown',
    };
    const result = eligible(candidate('claude-sonnet-4-6', 'execution'), ctx);
    expect(result.kind).toBe('eligible');
    if (result.kind !== 'eligible') throw new Error('expected eligible');
    expect(result.routePlan.kind).toBe('dispatchable');
    expect(result.routePlan.provider).toBe('anthropic');
  });

  it('Codex active + supported Codex model + connected => eligible', () => {
    const ctx: RouteEligibilityContext = {
      settings: routeSettings({ activeProvider: 'codex' }),
      codexConnectivity: 'connected',
    };
    const result = eligible(candidate('gpt-5-codex', 'execution'), ctx);
    expect(result.kind).toBe('eligible');
  });
});

describe('eligible() — REBEL-538 symmetric surface (BTS + subagent)', () => {
  const ctx: RouteEligibilityContext = {
    settings: routeSettings({
      activeProvider: 'codex',
      models: { apiKey: null, oauthToken: null } as AppSettings['models'],
    }),
    codexConnectivity: 'connected',
  };

  it('BTS fast unservable Claude under Codex => ineligible/credentials', () => {
    const result = eligible(candidate('claude-sonnet-4-6', 'bts'), ctx);
    expect(result.kind).toBe('ineligible');
    if (result.kind !== 'ineligible') throw new Error('expected ineligible');
    expect(result.source).toBe('credentials');
  });

  it('subagent unservable Claude under Codex => ineligible/credentials', () => {
    const result = eligible(candidate('claude-sonnet-4-6', 'subagent'), ctx);
    expect(result.kind).toBe('ineligible');
    if (result.kind !== 'ineligible') throw new Error('expected ineligible');
    expect(result.source).toBe('credentials');
  });
});

describe('eligible() — connectedProviders is INERT', () => {
  it('listing extra connected providers does NOT change the kill verdict', () => {
    const base = {
      settings: routeSettings({
        activeProvider: 'codex',
        models: { apiKey: null, oauthToken: null } as AppSettings['models'],
      }),
      codexConnectivity: 'connected' as const,
    };
    const withoutConnected = eligible(candidate('claude-sonnet-4-6', 'planning'), base);
    const withConnected = eligible(candidate('claude-sonnet-4-6', 'planning'), {
      ...base,
      // Anthropic is "connected" but NOT active — must not rescue the verdict.
      connectedProviders: ['anthropic', 'codex'],
    });
    expect(withConnected).toEqual(withoutConnected);
    expect(withConnected.kind).toBe('ineligible');
  });
});

describe('eligibilityFromDecision() — exhaustive source mapping', () => {
  // Table-driven: every ProviderRouteInvalidReason MUST have an expected source.
  // Adding a new reason without extending this table is a compile error
  // (the Record key set is checked against ProviderRouteInvalidReason).
  const EXPECTED_SOURCE: Record<ProviderRouteInvalidReason, EligibilitySource> = {
    'missing-anthropic-credentials': 'credentials',
    // FOX-3494: a claude-* model that can't run on the connected provider is a
    // route-level dead-end (mirrors codex-unsupported-model), not a creds gap.
    'missing-anthropic-credentials-for-claude-model': 'route',
    'missing-openrouter-credentials': 'credentials',
    'missing-mindstone-credentials': 'subscription',
    'missing-codex-connection': 'provider',
    'codex-disconnected-bts-blocked': 'provider',
    'codex-unsupported-model': 'route',
    'proxy-dialect-in-direct-anthropic': 'route',
    'missing-profile-credentials': 'profile',
  };

  const ALL_REASONS = Object.keys(EXPECTED_SOURCE) as ProviderRouteInvalidReason[];

  it.each(ALL_REASONS)('maps terminal reason %s to its source', (reason) => {
    const decision = {
      kind: 'terminal' as const,
      provider: 'anthropic' as const,
      modelDialect: 'anthropic-native' as const,
      role: 'execution' as ProviderRouteRole,
      routeScope: 'normal-turn' as const,
      routedModel: null,
      canonicalModelId: 'claude-sonnet-4-6',
      wireModelId: 'claude-sonnet-4-6' as never,
      profileId: null,
      resolvedFrom: 'settings' as const,
      codexConnectivity: 'unknown' as const,
      fallbackHint: null,
      credentialSource: 'missing-anthropic' as const,
      transport: 'no-credentials' as const,
      dispatchPath: 'none' as const,
      invalidReason: reason,
    };
    const result = eligibilityFromDecision(decision);
    expect(result.kind).toBe('ineligible');
    if (result.kind !== 'ineligible') throw new Error('expected ineligible');
    expect(result.source).toBe(EXPECTED_SOURCE[reason]);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('covers every ProviderRouteInvalidReason arm (no gaps)', () => {
    // FOX-3494 added 'missing-anthropic-credentials-for-claude-model' (8 → 9).
    expect(ALL_REASONS).toHaveLength(9);
  });

  it('maps a dispatchable decision to eligible carrying the route plan', () => {
    const decision = {
      kind: 'dispatchable' as const,
      provider: 'anthropic' as const,
      modelDialect: 'anthropic-native' as const,
      role: 'execution' as ProviderRouteRole,
      routeScope: 'normal-turn' as const,
      routedModel: null,
      canonicalModelId: 'claude-sonnet-4-6',
      wireModelId: 'claude-sonnet-4-6' as never,
      profileId: null,
      resolvedFrom: 'settings' as const,
      codexConnectivity: 'unknown' as const,
      fallbackHint: null,
      credentialSource: 'anthropic-api-key' as const,
      transport: 'anthropic-direct' as const,
      dispatchPath: 'direct-provider' as const,
      invalidReason: 'none' as const,
    };
    const result = eligibilityFromDecision(decision);
    expect(result.kind).toBe('eligible');
    if (result.kind !== 'eligible') throw new Error('expected eligible');
    expect(result.routePlan).toBe(decision);
  });
});
