import { describe, expect, it, vi } from 'vitest';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type { ActiveProvider, ModelProfile } from '@shared/types';
import { ProviderRouter, type ProviderRouteSettings } from '../providerRouting';
import { isTerminalDecision, isDispatchableDecision } from '../providerRouteDecision';

/**
 * Memory-BTS route mismatch (rebel://conversation/mobile-1782164402735-51bh8pna).
 *
 * Root cause: the `case 'codex'` arm of `routeDecision` gates only on
 * `isCodexModelSupported` (a deny-list that admits every id except `gpt-5.5-pro`),
 * with NO check that the model is a dialect codex can actually serve. A foreign-
 * dialect override model (`deepseek/deepseek-v4-flash`, an OpenRouter id) — or a
 * bare non-OpenAI id (`gemini-2.5-flash`, which classifies `bare-non-claude`, NOT
 * `foreign-dialect`) — therefore falls through to a DISPATCHABLE codex-proxy
 * decision. The codex proxy builds a non-passthrough AnthropicClient (`x-codex-turn`,
 * `isOpenRouterPassthrough=false`), and the slash model throws at the wire
 * (`anthropicClient.ts:802`, `resolveAnthropicWireModel`) while the bare-non-OpenAI
 * id dispatches SILENTLY to the wrong proxy.
 *
 * The fix adds a "codex-servable?" guard (keyed on dialect, NOT on slash) so the
 * codex arm can only produce a dispatchable proxy route for a bare OpenAI-compatible
 * model — anything else emits a clean `codex-unsupported-model` terminal.
 */

const ENABLED_PROVIDERS: ActiveProvider[] = ['openrouter', 'codex', 'mindstone', 'anthropic'];

// The incident user's shape: active provider codex, multi-provider routing LIVE,
// codex connected. No anthropic/openrouter keys (managed-deactivated user).
const codexMultiProviderSettings: ProviderRouteSettings = {
  activeProvider: 'codex',
  enabledProviders: ENABLED_PROVIDERS,
  experimental: { multiProviderRoutingEnabled: true },
  models: { apiKey: null, oauthToken: null },
  openRouter: { enabled: false, oauthToken: null, selectedModel: 'anthropic/claude-sonnet-4.6' },
  localModel: { activeProfileId: null, profiles: [] },
  providerKeys: {},
};

describe('codex arm — terminals for models codex cannot serve (memory-BTS route mismatch)', () => {
  describe('RED → green: non-codex-servable models under connected codex terminate cleanly', () => {
    it('slash foreign-dialect (deepseek/deepseek-v4-flash) → clean codex-unsupported terminal', () => {
      const decision = ProviderRouter.forTurn({
        settings: codexMultiProviderSettings,
        model: 'deepseek/deepseek-v4-flash',
        codexConnectivity: 'connected',
      });
      expect(isTerminalDecision(decision)).toBe(true);
      expect(isDispatchableDecision(decision)).toBe(false);
      expect(decision.provider).toBe('codex');
      expect(decision.invalidReason).toBe('codex-unsupported-model');
    });

    it('bare non-OpenAI (gemini-2.5-flash, bare-non-claude) → clean codex-unsupported terminal (the SILENT variant)', () => {
      const decision = ProviderRouter.forTurn({
        settings: codexMultiProviderSettings,
        model: 'gemini-2.5-flash',
        codexConnectivity: 'connected',
      });
      expect(isTerminalDecision(decision)).toBe(true);
      expect(isDispatchableDecision(decision)).toBe(false);
      expect(decision.provider).toBe('codex');
      expect(decision.invalidReason).toBe('codex-unsupported-model');
    });
  });

  describe('positive controls — these must already PASS today and keep passing', () => {
    it('bare codex model (gpt-5.5) under connected codex → dispatchable codex-proxy', () => {
      const decision = ProviderRouter.forTurn({
        settings: codexMultiProviderSettings,
        model: 'gpt-5.5',
        codexConnectivity: 'connected',
      });
      expect(isDispatchableDecision(decision)).toBe(true);
      expect(decision.provider).toBe('codex');
      expect(decision.transport).toBe('codex-proxy');
    });

    it('bare codex auxiliary model (gpt-5.4-mini) under connected codex → dispatchable codex-proxy', () => {
      const decision = ProviderRouter.forTurn({
        settings: codexMultiProviderSettings,
        model: 'gpt-5.4-mini',
        codexConnectivity: 'connected',
      });
      expect(isDispatchableDecision(decision)).toBe(true);
      expect(decision.provider).toBe('codex');
      expect(decision.transport).toBe('codex-proxy');
    });

    it('openrouter-active deepseek/deepseek-v4-flash → dispatchable openrouter-proxy (passthrough, NOT terminal)', () => {
      const openrouterActive: ProviderRouteSettings = {
        ...codexMultiProviderSettings,
        activeProvider: 'openrouter',
        enabledProviders: ['openrouter'],
        openRouter: { enabled: true, oauthToken: 'or-token', selectedModel: 'deepseek/deepseek-v4-flash' },
      };
      const decision = ProviderRouter.forTurn({
        settings: openrouterActive,
        model: 'deepseek/deepseek-v4-flash',
        codexConnectivity: 'unknown',
      });
      expect(isDispatchableDecision(decision)).toBe(true);
      expect(decision.provider).toBe('openrouter');
      expect(decision.transport).toBe('openrouter-proxy');
    });

    it('native-claude divert (bare claude-* + anthropic key under codex) → still diverts to anthropic dispatchable', () => {
      const codexWithAnthropicKey: ProviderRouteSettings = {
        ...codexMultiProviderSettings,
        models: { apiKey: 'fake-anthropic-key', authMethod: 'api-key', oauthToken: null },
      };
      const decision = ProviderRouter.forTurn({
        settings: codexWithAnthropicKey,
        model: 'claude-opus-4-8',
        codexConnectivity: 'connected',
      });
      expect(isDispatchableDecision(decision)).toBe(true);
      expect(decision.provider).toBe('anthropic');
    });
  });

  describe('o*-precision: bare non-codex `o*` ids must NOT dispatch codex-proxy', () => {
    // `toModelDialect` classifies any bare id starting with `o` as openai-compatible
    // (broad `startsWith('o')`), so `ollama:…`/`omni-*` would have wrongly dispatched
    // codex-proxy. The shared `isCodexServableModel` predicate uses the PRECISE
    // `^o\d` o-series check, so these terminal cleanly.
    it('bare `ollama:llama3` under connected codex → clean codex-unsupported terminal', () => {
      const decision = ProviderRouter.forTurn({
        settings: codexMultiProviderSettings,
        model: 'ollama:llama3',
        codexConnectivity: 'connected',
      });
      expect(isTerminalDecision(decision)).toBe(true);
      expect(isDispatchableDecision(decision)).toBe(false);
      expect(decision.provider).toBe('codex');
      expect(decision.invalidReason).toBe('codex-unsupported-model');
    });

    it('bare `omni-foo` under connected codex → clean codex-unsupported terminal', () => {
      const decision = ProviderRouter.forTurn({
        settings: codexMultiProviderSettings,
        model: 'omni-foo',
        codexConnectivity: 'connected',
      });
      expect(isTerminalDecision(decision)).toBe(true);
      expect(isDispatchableDecision(decision)).toBe(false);
      expect(decision.provider).toBe('codex');
      expect(decision.invalidReason).toBe('codex-unsupported-model');
    });

    it('true o-series `o3` under connected codex → still dispatchable codex-proxy (positive control)', () => {
      const decision = ProviderRouter.forTurn({
        settings: codexMultiProviderSettings,
        model: 'o3',
        codexConnectivity: 'connected',
      });
      expect(isDispatchableDecision(decision)).toBe(true);
      expect(decision.provider).toBe('codex');
      expect(decision.transport).toBe('codex-proxy');
    });
  });
});

/**
 * Stage 2b: the codex SUBSCRIPTION-PROFILE arm (`profileDecision`,
 * providerRouting.ts:991-1018) had the SAME hole as the active-provider arm —
 * gated only on `isCodexModelSupported`, with NO servable-dialect guard AND NO
 * native-Claude divert. A codex-subscription profile carrying a foreign
 * `profile.model` was empirically dispatchable: slash → wire throw, bare non-OpenAI
 * → silent wrong proxy, claude-* → Claude body on the codex proxy (broader-broken
 * than the active arm). Reachable via the sibling aux turns' `workingProfileOverrideId`.
 */
const codexSubscriptionProfile = (model: string): ModelProfile => ({
  id: 'codex-sub',
  name: 'Codex Subscription',
  providerType: 'openai',
  serverUrl: 'https://api.openai.com/v1',
  model,
  authSource: 'codex-subscription',
  createdAt: 0,
});

const profileSettings = (profile: ModelProfile, overrides?: Partial<ProviderRouteSettings>): ProviderRouteSettings => ({
  ...codexMultiProviderSettings,
  localModel: { activeProfileId: null, profiles: [profile] },
  ...overrides,
});

describe('codex SUBSCRIPTION-PROFILE arm — terminals for models codex cannot serve (Stage 2b)', () => {
  describe('RED → green: non-codex-servable profile models terminate cleanly', () => {
    it('profile.model = deepseek/deepseek-v4-flash (slash) → clean codex-unsupported terminal', () => {
      const profile = codexSubscriptionProfile('deepseek/deepseek-v4-flash');
      const decision = ProviderRouter.forTurn({
        settings: profileSettings(profile),
        model: 'profile:codex-sub',
        codexConnectivity: 'connected',
      });
      expect(isTerminalDecision(decision)).toBe(true);
      expect(isDispatchableDecision(decision)).toBe(false);
      expect(decision.provider).toBe('codex');
      expect(decision.invalidReason).toBe('codex-unsupported-model');
    });

    it('profile.model = gemini-2.5-flash (bare non-OpenAI) → clean codex-unsupported terminal', () => {
      const profile = codexSubscriptionProfile('gemini-2.5-flash');
      const decision = ProviderRouter.forTurn({
        settings: profileSettings(profile),
        model: 'profile:codex-sub',
        codexConnectivity: 'connected',
      });
      expect(isTerminalDecision(decision)).toBe(true);
      expect(isDispatchableDecision(decision)).toBe(false);
      expect(decision.provider).toBe('codex');
      expect(decision.invalidReason).toBe('codex-unsupported-model');
    });

    it('profile.model = ollama:llama3 (bare `o*` non-codex) → clean codex-unsupported terminal (o*-precision)', () => {
      const profile = codexSubscriptionProfile('ollama:llama3');
      const decision = ProviderRouter.forTurn({
        settings: profileSettings(profile),
        model: 'profile:codex-sub',
        codexConnectivity: 'connected',
      });
      expect(isTerminalDecision(decision)).toBe(true);
      expect(isDispatchableDecision(decision)).toBe(false);
      expect(decision.provider).toBe('codex');
      expect(decision.invalidReason).toBe('codex-unsupported-model');
    });
  });

  describe('native-Claude divert from the profile arm', () => {
    it('profile.model = claude-opus-4-8 WITH anthropic key → diverts to anthropic dispatchable (no Claude body on codex proxy)', () => {
      const profile = codexSubscriptionProfile('claude-opus-4-8');
      const decision = ProviderRouter.forTurn({
        settings: profileSettings(profile, {
          models: { apiKey: 'fake-anthropic-key', authMethod: 'api-key', oauthToken: null },
        }),
        model: 'profile:codex-sub',
        codexConnectivity: 'connected',
      });
      expect(isDispatchableDecision(decision)).toBe(true);
      expect(decision.provider).toBe('anthropic');
    });

    it('profile.model = claude-opus-4-8 WITHOUT anthropic key → clean anthropic terminal (NOT codex-proxy with a Claude body)', () => {
      const profile = codexSubscriptionProfile('claude-opus-4-8');
      const decision = ProviderRouter.forTurn({
        settings: profileSettings(profile),
        model: 'profile:codex-sub',
        codexConnectivity: 'connected',
      });
      expect(isTerminalDecision(decision)).toBe(true);
      expect(isDispatchableDecision(decision)).toBe(false);
      expect(decision.provider).toBe('anthropic');
    });
  });

  describe('positive control — codex-servable profile model still dispatches', () => {
    it('profile.model = gpt-5.5 under connected codex → dispatchable codex-proxy', () => {
      const profile = codexSubscriptionProfile('gpt-5.5');
      const decision = ProviderRouter.forTurn({
        settings: profileSettings(profile),
        model: 'profile:codex-sub',
        codexConnectivity: 'connected',
      });
      expect(isDispatchableDecision(decision)).toBe(true);
      expect(decision.provider).toBe('codex');
      expect(decision.transport).toBe('codex-proxy');
    });
  });
});
