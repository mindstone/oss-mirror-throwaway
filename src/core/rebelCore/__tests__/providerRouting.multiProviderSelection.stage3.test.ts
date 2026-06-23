/**
 * Stage 3 — flag-gated multi-provider selection over `enabledProviders`.
 *
 * Exercises the provider-choice point (`enumerateProviderModeCandidates` →
 * `pickProviderMode`) reached by `routeDecision`'s no-routable-profile arm, via
 * the public `ProviderRouter.forTurn` seam.
 *
 * The contract under test (behaviour only changes when the
 * `experimental.multiProviderRoutingEnabled` flag is on AND a configured
 * `enabledProviders` list differs from the implicit `[activeProvider]`; nothing
 * writes that list until Stage 6, so it is inert in production today):
 *   - FLAG OFF ⇒ the list is ignored; `activeProvider` decides exactly as before.
 *   - FLAG ON, empty enabled list ⇒ fall back to legacy `selectProviderMode`
 *     (Stage 2 GPT carry-forward invariant (1) — fresh users do NOT fail-closed).
 *   - FLAG ON, multi list ⇒ pick the highest-priority provider that is USABLE
 *     (credentials present; for Codex, connection live), skipping unusable ones;
 *     if none is usable, the head's `missing-*` terminal surfaces.
 *   - Malformed list items are filtered (invariant (2) — don't trust persisted
 *     data); duplicates are de-duped preserving order.
 *
 * NOTE on scope: selection is on the CREDENTIAL + Codex-CONNECTIVITY axes, not
 * per-model capability (a Claude model on Codex diverts to Anthropic; a foreign
 * dialect on Anthropic is a terminal). Those are the eligibility/failover layer's
 * job (`routeEligibility.eligible()` + Stage 4) — see the row that picks Anthropic
 * for a model Anthropic can't serve, which asserts on the PROVIDER chosen.
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

import type { ActiveProvider } from '@shared/types';
import { ProviderRouter, type ProviderRouteSettings } from '../providerRouting';
import { isDispatchableDecision, type CodexConnectivity } from '../providerRouteDecision';
import { registerManagedKeyAvailability } from '../managedKeyAvailability';

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const GPT_MODEL = 'gpt-5.5';

function multiSettings(opts: {
  activeProvider?: ActiveProvider;
  enabledProviders?: ActiveProvider[];
  flag?: boolean;
  apiKey?: string | null;
  openRouterToken?: string | null;
  hasManagedKey?: boolean;
}): ProviderRouteSettings {
  return {
    activeProvider: opts.activeProvider,
    ...(opts.enabledProviders ? { enabledProviders: opts.enabledProviders } : {}),
    ...(opts.flag !== undefined ? { experimental: { multiProviderRoutingEnabled: opts.flag } } : {}),
    models: { apiKey: opts.apiKey ?? null, authMethod: 'api-key', model: CLAUDE_MODEL },
    openRouter: {
      enabled: Boolean(opts.openRouterToken),
      oauthToken: opts.openRouterToken ?? null,
      selectedModel: 'anthropic/claude-sonnet-4.6',
    },
    localModel: { activeProfileId: null, profiles: [] },
    providerKeys: {},
    ...(opts.hasManagedKey !== undefined ? { hasManagedKey: opts.hasManagedKey } : {}),
  };
}

function route(settings: ProviderRouteSettings, model = CLAUDE_MODEL, codexConnectivity: CodexConnectivity = 'unknown') {
  return ProviderRouter.forTurn({ settings, model, codexConnectivity });
}

describe('Stage 3 — multi-provider selection (flag-gated)', () => {
  afterEach(() => {
    registerManagedKeyAvailability(() => false);
  });

  describe('doubly-gated: the list is inert without the flag', () => {
    it('FLAG OFF + multi enabledProviders ⇒ ignores the list; activeProvider decides (legacy)', () => {
      // openrouter is first in the list and usable, but the flag is off, so the
      // active provider (anthropic) must still win — exactly today's behaviour.
      const decision = route(
        multiSettings({
          activeProvider: 'anthropic',
          enabledProviders: ['openrouter', 'anthropic'],
          flag: false,
          apiKey: 'fake-anthropic-key',
          openRouterToken: 'or-token',
        }),
      );
      expect(decision.provider).toBe('anthropic');
      expect(isDispatchableDecision(decision)).toBe(true);
    });

    it('NO experimental block at all + multi list ⇒ still legacy (flag absent = off)', () => {
      const decision = route(
        multiSettings({
          activeProvider: 'anthropic',
          enabledProviders: ['openrouter', 'anthropic'],
          apiKey: 'fake-anthropic-key',
          openRouterToken: 'or-token',
        }),
      );
      expect(decision.provider).toBe('anthropic');
    });
  });

  describe('flag on, degenerate list ⇒ identical to legacy', () => {
    it('FLAG ON + no enabledProviders, activeProvider set ⇒ activeProvider mode (degenerate [activeProvider])', () => {
      const decision = route(
        multiSettings({ activeProvider: 'openrouter', flag: true, openRouterToken: 'or-token' }),
      );
      expect(decision.provider).toBe('openrouter');
      expect(isDispatchableDecision(decision)).toBe(true);
    });

    it('FLAG ON + activeProvider UNDEFINED + no list ⇒ falls back to legacy selectProviderMode (Anthropic/default) — invariant (1)', () => {
      // getEnabledProviders(undefined activeProvider, no list) returns [] →
      // enumerate must fall back to selectProviderMode, NOT fail closed.
      const decision = route(multiSettings({ activeProvider: undefined, flag: true, apiKey: 'fake-anthropic-key' }));
      expect(decision.provider).toBe('anthropic');
      expect(decision.credentialSource).toBe('anthropic-api-key');
      expect(isDispatchableDecision(decision)).toBe(true);
    });
  });

  describe('flag on, multi list ⇒ highest-priority USABLE provider', () => {
    it('[anthropic, openrouter] both usable ⇒ picks the head (anthropic)', () => {
      const decision = route(
        multiSettings({
          enabledProviders: ['anthropic', 'openrouter'],
          flag: true,
          apiKey: 'fake-anthropic-key',
          openRouterToken: 'or-token',
        }),
      );
      expect(decision.provider).toBe('anthropic');
      expect(isDispatchableDecision(decision)).toBe(true);
    });

    it('[openrouter, anthropic] both usable ⇒ picks the head (openrouter)', () => {
      const decision = route(
        multiSettings({
          enabledProviders: ['openrouter', 'anthropic'],
          flag: true,
          apiKey: 'fake-anthropic-key',
          openRouterToken: 'or-token',
        }),
      );
      expect(decision.provider).toBe('openrouter');
      expect(isDispatchableDecision(decision)).toBe(true);
    });

    it('[openrouter, anthropic] but openrouter UNUSABLE (no token) ⇒ skips to anthropic', () => {
      // Proves the SKIP: without it the head (openrouter) would yield a
      // missing-openrouter terminal; with it, anthropic is chosen and dispatchable.
      const decision = route(
        multiSettings({
          enabledProviders: ['openrouter', 'anthropic'],
          flag: true,
          apiKey: 'fake-anthropic-key',
          openRouterToken: null,
        }),
      );
      expect(decision.provider).toBe('anthropic');
      expect(isDispatchableDecision(decision)).toBe(true);
    });

    it('all candidates UNUSABLE ⇒ head terminal surfaces (missing-openrouter)', () => {
      const decision = route(
        multiSettings({
          enabledProviders: ['openrouter', 'anthropic'],
          flag: true,
          apiKey: null,
          openRouterToken: null,
        }),
      );
      expect(decision.provider).toBe('openrouter');
      expect(decision.kind).toBe('terminal');
      expect(decision.invalidReason).toBe('missing-openrouter-credentials');
    });
  });

  describe('Codex connectivity is part of usability', () => {
    it('[codex, anthropic] codex CONNECTED ⇒ picks codex', () => {
      const decision = route(
        multiSettings({ enabledProviders: ['codex', 'anthropic'], flag: true, apiKey: 'fake-anthropic-key' }),
        GPT_MODEL,
        'connected',
      );
      expect(decision.provider).toBe('codex');
    });

    it('[codex, openrouter] codex DISCONNECTED ⇒ skips codex, picks openrouter (dispatchable)', () => {
      // Clean discriminator: with the connectivity-aware skip, openrouter serves
      // the Claude model via the proxy. Without it, the head (codex) would divert
      // the Claude model to Anthropic and — with no Anthropic key — terminal.
      const decision = route(
        multiSettings({ enabledProviders: ['codex', 'openrouter'], flag: true, openRouterToken: 'or-token' }),
        CLAUDE_MODEL,
        'disconnected',
      );
      expect(decision.provider).toBe('openrouter');
      expect(isDispatchableDecision(decision)).toBe(true);
    });
  });

  describe('mindstone mapping + list validation', () => {
    // Managed-billing invariant (WS4b billing-correctness): `mindstone` = MANAGED billing
    // and must be used ONLY when it is the EXPLICIT primary `activeProvider` — never
    // auto-selected as a failover/backup candidate. See `excludeManagedFromFailover` in
    // providerRouting.ts and the dedicated invariant block in
    // providerRouting.cooldownFailover.stage4.test.ts.
    it('[mindstone, anthropic] + activeProvider=MINDSTONE (explicit primary) + managed key ⇒ picks mindstone (managed)', () => {
      const decision = route(
        multiSettings({ activeProvider: 'mindstone', enabledProviders: ['mindstone', 'anthropic'], flag: true, apiKey: 'fake-anthropic-key', hasManagedKey: true }),
      );
      expect(decision.provider).toBe('openrouter');
      expect(decision.credentialSource).toBe('mindstone-managed-key');
    });

    it('[mindstone, anthropic] + activeProvider!=mindstone (managed NOT primary) ⇒ mindstone excluded as a candidate, picks anthropic', () => {
      // Even with a provisioned managed key, mindstone is dropped from the candidate set
      // because it is not the explicit primary — managed billing is never auto-selected.
      // (Without the invariant this picked mindstone-managed-key — the billing-flip bug.)
      const decision = route(
        multiSettings({ activeProvider: 'anthropic', enabledProviders: ['mindstone', 'anthropic'], flag: true, apiKey: 'fake-anthropic-key', hasManagedKey: true }),
      );
      expect(decision.provider).toBe('anthropic');
      expect(decision.credentialSource).not.toBe('mindstone-managed-key');
      expect(isDispatchableDecision(decision)).toBe(true);
    });

    it('[mindstone, anthropic] + activeProvider=mindstone WITHOUT managed key ⇒ mindstone unusable, skips to anthropic', () => {
      const decision = route(
        multiSettings({ activeProvider: 'mindstone', enabledProviders: ['mindstone', 'anthropic'], flag: true, apiKey: 'fake-anthropic-key', hasManagedKey: false }),
      );
      expect(decision.provider).toBe('anthropic');
      expect(isDispatchableDecision(decision)).toBe(true);
    });

    it('malformed list item is filtered (no throw), valid remainder is used — invariant (2)', () => {
      const decision = route(
        multiSettings({
          // A bogus id must be dropped before it reaches providerModeFor's assertNever.
          enabledProviders: ['totally-not-a-provider' as ActiveProvider, 'anthropic'],
          flag: true,
          apiKey: 'fake-anthropic-key',
        }),
      );
      expect(decision.provider).toBe('anthropic');
      expect(isDispatchableDecision(decision)).toBe(true);
    });

    it('duplicate list items are de-duped (order preserved) and do not crash', () => {
      const decision = route(
        multiSettings({
          enabledProviders: ['anthropic', 'anthropic', 'openrouter'],
          flag: true,
          apiKey: 'fake-anthropic-key',
          openRouterToken: 'or-token',
        }),
      );
      expect(decision.provider).toBe('anthropic');
      expect(isDispatchableDecision(decision)).toBe(true);
    });
  });

  describe('GPT Stage 3 review hardening', () => {
    it('SINGLE-element list that DIFFERS from activeProvider still changes routing (the gate is list-presence, not length ≥2)', () => {
      // GPT review Q2: a one-element enabledProviders list ≠ [activeProvider]
      // re-routes when the flag is on. Production stays inert only because nothing
      // writes the list yet (Stage 6) — NOT because of a ≥2 length threshold.
      const decision = route(
        multiSettings({
          activeProvider: 'anthropic',
          enabledProviders: ['openrouter'],
          flag: true,
          apiKey: 'fake-anthropic-key',
          openRouterToken: 'or-token',
        }),
      );
      expect(decision.provider).toBe('openrouter');
      expect(isDispatchableDecision(decision)).toBe(true);
    });

    it('off-type activeProvider: null does NOT throw — defaults to Anthropic like undefined (deliberate hardening)', () => {
      // GPT review Q1: `null` (off-type; only from malformed persisted/cast data)
      // used to reach the old switch default → assertNever → throw. Via `?? 'anthropic'`
      // it now defaults to Anthropic. Pin that this is a safe non-throwing default.
      const settings = multiSettings({ apiKey: 'fake-anthropic-key' });
      (settings as { activeProvider?: unknown }).activeProvider = null;
      const decision = route(settings);
      expect(decision.provider).toBe('anthropic');
      expect(decision.credentialSource).toBe('anthropic-api-key');
      expect(isDispatchableDecision(decision)).toBe(true);
    });

    it('genuinely unknown activeProvider string still reaches assertNever (throws) — only null/undefined default', () => {
      // The hardening is narrow: garbage strings are NOT silently defaulted.
      const settings = multiSettings({ apiKey: 'fake-anthropic-key' });
      (settings as { activeProvider?: unknown }).activeProvider = 'bogus-provider';
      expect(() => route(settings)).toThrow();
    });
  });
});
