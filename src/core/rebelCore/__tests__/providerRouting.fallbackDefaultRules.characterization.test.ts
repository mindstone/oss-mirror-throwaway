/**
 * Stage 0 characterization — `forTurnWithFallback` resolves no-provider hints via
 * the same default rules (seam 5, light "don't-regress" guard).
 *
 * PLAN seam 5: "a fallback hint WITHOUT an explicit provider resolves via the
 * same default rules." `alt-model` and `thinking-downgrade` carry no provider;
 * the rebuild re-runs `routeDecision` against the unchanged settings, so the
 * provider is re-derived from `activeProvider` exactly as a fresh turn would be.
 *
 * The provider-resolution parity matrix already pins `alt-model` staying on
 * Codex (providerResolution.parityMatrix.test.ts "alt-model stays on Codex
 * provider") and invariants.test.ts pins the codex-rate-limit-* and
 * long-context/configured-role rebuilds (I7/I8). This file adds the explicit,
 * self-contained statement of the invariant for the anthropic and openrouter
 * active-provider arms so the Stage 1 restructure can't silently let a
 * no-provider fallback resolve through a different default path.
 */
import { describe, expect, it, vi } from 'vitest';

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

async function inFlightPlan(settings: ProviderRouteSettings, model: string, connectivity: 'connected' | 'disconnected' | 'unknown') {
  return materializePlanRuntime(
    ProviderRouter.forTurn({ settings, model, codexConnectivity: connectivity, role: 'execution' }),
  );
}

describe('forTurnWithFallback no-provider hints use default rules — Stage 0 characterization', () => {
  it('alt-model under anthropic activeProvider re-resolves the alt model via the Anthropic default arm', async () => {
    const settings: ProviderRouteSettings = {
      activeProvider: 'anthropic',
      models: { apiKey: 'fake-anthropic-key', authMethod: 'api-key', model: 'claude-opus-4-7' },
      localModel: { activeProfileId: null, profiles: [] },
      providerKeys: {},
    };
    const plan = await inFlightPlan(settings, 'claude-opus-4-7', 'unknown');

    const decision = forTurnWithFallback(
      { settings, model: 'claude-opus-4-7', codexConnectivity: 'unknown', role: 'execution' },
      { kind: 'alt-model', model: 'claude-haiku-4-5' },
      plan,
    );

    expect(decision.provider).toBe('anthropic');
    expect(decision.transport).toBe('anthropic-direct');
    expect(decision.wireModelId).toBe('claude-haiku-4-5');
    expect(decision.resolvedFrom).toBe('settings');
    expect(decision.fallbackHint).toEqual({ kind: 'alt-model', model: 'claude-haiku-4-5' });
  });

  it('alt-model under openrouter activeProvider re-resolves the alt model via the OpenRouter default arm', async () => {
    const settings: ProviderRouteSettings = {
      activeProvider: 'openrouter',
      models: { apiKey: 'fake-anthropic-lingering', authMethod: 'api-key' },
      openRouter: { enabled: true, oauthToken: 'or-token', selectedModel: 'anthropic/claude-sonnet-4.6' },
      localModel: { activeProfileId: null, profiles: [] },
      providerKeys: {},
    };
    const plan = await inFlightPlan(settings, 'anthropic/claude-sonnet-4.6', 'unknown');

    const decision = forTurnWithFallback(
      { settings, model: 'anthropic/claude-sonnet-4.6', codexConnectivity: 'unknown', role: 'execution' },
      { kind: 'alt-model', model: 'deepseek/deepseek-v4-flash' },
      plan,
    );

    expect(decision.provider).toBe('openrouter');
    expect(decision.transport).toBe('openrouter-proxy');
    expect(decision.wireModelId).toBe('deepseek/deepseek-v4-flash');
  });

  it('thinking-downgrade clears ONLY profile (keeps the passed model) and re-resolves via the active-provider default arm', async () => {
    // F2 from GPT review: production `thinking-downgrade` clears `profile` but
    // NOT `model` (providerRouting.ts:323-324). So with a passed model the
    // rebuild keeps that exact model — it does NOT fall back to the role-default
    // model. Pin that CURRENT behaviour (wireModelId stays the passed model).
    const settings: ProviderRouteSettings = {
      activeProvider: 'anthropic',
      models: {
        apiKey: 'fake-anthropic-key',
        authMethod: 'api-key',
        model: 'claude-sonnet-4-6',
        thinkingModel: 'claude-opus-4-7',
      },
      localModel: { activeProfileId: null, profiles: [] },
      providerKeys: {},
    };
    const plan = await inFlightPlan(settings, 'claude-opus-4-7', 'unknown');

    const decision = forTurnWithFallback(
      { settings, model: 'claude-opus-4-7', codexConnectivity: 'unknown', role: 'planning' },
      { kind: 'thinking-downgrade', reason: 'thinking-not-supported' },
      plan,
    );

    expect(decision.provider).toBe('anthropic');
    expect(decision.transport).toBe('anthropic-direct');
    expect(decision.wireModelId).toBe('claude-opus-4-7');
    expect(decision.resolvedFrom).toBe('settings');
    expect(decision.fallbackHint).toEqual({ kind: 'thinking-downgrade', reason: 'thinking-not-supported' });
  });

  it('thinking-downgrade with model: null DOES resolve the role-default model (role planning → thinkingModel) via the default arm', async () => {
    // The complementary edge: when no model is passed, the rebuild resolves the
    // role default. For role 'planning' the route-role maps to 'thinking', so
    // resolveInputModel returns the configured thinkingModel. Pin that CURRENT
    // behaviour so a restructure can't silently change no-model default routing.
    const settings: ProviderRouteSettings = {
      activeProvider: 'anthropic',
      models: {
        apiKey: 'fake-anthropic-key',
        authMethod: 'api-key',
        model: 'claude-sonnet-4-6',
        thinkingModel: 'claude-opus-4-7',
      },
      localModel: { activeProfileId: null, profiles: [] },
      providerKeys: {},
    };
    const plan = await inFlightPlan(settings, 'claude-opus-4-7', 'unknown');

    const decision = forTurnWithFallback(
      { settings, model: null, codexConnectivity: 'unknown', role: 'planning' },
      { kind: 'thinking-downgrade', reason: 'thinking-not-supported' },
      plan,
    );

    expect(decision.provider).toBe('anthropic');
    expect(decision.transport).toBe('anthropic-direct');
    expect(decision.wireModelId).toBe('claude-opus-4-7');
    expect(decision.resolvedFrom).toBe('settings');
  });
});
