/**
 * Stage 0 characterization — `selectProviderMode` (providerRouting.ts:~158).
 *
 * Pins CURRENT behaviour of the provider-CHOICE resolution that `routeDecision`
 * falls into when no profile is resolved. These are the seam-1 cases the
 * multi-provider restructure (Stages 1–2) must preserve byte-for-byte: the
 * `activeProvider === undefined` → Anthropic default, and the per-provider
 * resolution for `anthropic` / `openrouter` / `codex` / `mindstone`.
 *
 * Existing direct coverage was limited to the Mindstone managed-key arm
 * (providerRouting.invariants.test.ts → "Mindstone managed-key central
 * resolver", I5a) and the integration-level ProviderRouter matrix
 * (providerRouting.routingPrecedence.test.ts). This file pins the pure
 * `selectProviderMode` output for the anthropic/undefined/openrouter/codex arms
 * that were only exercised indirectly.
 *
 * NOTE: asserts what the code does NOW. `selectProviderMode` is a pure mapping
 * from settings → {provider, credentialSource}; it does NOT validate that a
 * model can be served. The Codex arm in particular returns
 * `codex-subscription` UNCONDITIONALLY (it never inspects connectivity or
 * model support — that gating lives downstream in `routeDecision`).
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

import { selectProviderMode, type ProviderRouteSettings } from '../providerRouting';
import { registerManagedKeyAvailability } from '../managedKeyAvailability';

describe('selectProviderMode — Stage 0 characterization', () => {
  afterEach(() => {
    // Reset the global managed-key resolver so a `mindstone` test cannot leak
    // its registration into a later case.
    registerManagedKeyAvailability(() => false);
  });

  describe('activeProvider undefined / "anthropic" → Anthropic default arm', () => {
    it('undefined + api key present → anthropic / anthropic-api-key', () => {
      const settings: ProviderRouteSettings = {
        activeProvider: undefined,
        models: { apiKey: 'fake-anthropic-test', authMethod: 'api-key' },
      };
      expect(selectProviderMode(settings)).toEqual({
        provider: 'anthropic',
        credentialSource: 'anthropic-api-key',
      });
    });

    it('undefined + no api key + oauth token + authMethod oauth-token → anthropic / anthropic-oauth-token', () => {
      const settings: ProviderRouteSettings = {
        activeProvider: undefined,
        models: { apiKey: null, oauthToken: 'oauth-abc', authMethod: 'oauth-token' },
      };
      expect(selectProviderMode(settings)).toEqual({
        provider: 'anthropic',
        credentialSource: 'anthropic-oauth-token',
      });
    });

    it('undefined + no credentials → anthropic / missing-anthropic', () => {
      const settings: ProviderRouteSettings = {
        activeProvider: undefined,
        models: { apiKey: null, oauthToken: null, authMethod: 'api-key' },
      };
      expect(selectProviderMode(settings)).toEqual({
        provider: 'anthropic',
        credentialSource: 'missing-anthropic',
      });
    });

    it('explicit "anthropic" behaves identically to undefined (same default arm)', () => {
      const apiKey: ProviderRouteSettings = {
        activeProvider: 'anthropic',
        models: { apiKey: 'fake-anthropic-test', authMethod: 'api-key' },
      };
      expect(selectProviderMode(apiKey)).toEqual({
        provider: 'anthropic',
        credentialSource: 'anthropic-api-key',
      });

      const missing: ProviderRouteSettings = {
        activeProvider: 'anthropic',
        models: { apiKey: null, oauthToken: null, authMethod: 'api-key' },
      };
      expect(selectProviderMode(missing)).toEqual({
        provider: 'anthropic',
        credentialSource: 'missing-anthropic',
      });
    });

    it('api key WINS over oauth token when both are present (api-key checked first)', () => {
      const settings: ProviderRouteSettings = {
        activeProvider: 'anthropic',
        models: { apiKey: 'fake-anthropic-test', oauthToken: 'oauth-abc', authMethod: 'oauth-token' },
      };
      expect(selectProviderMode(settings)).toEqual({
        provider: 'anthropic',
        credentialSource: 'anthropic-api-key',
      });
    });

    it('oauth token present but authMethod is NOT "oauth-token" → falls through to missing-anthropic', () => {
      // The oauth branch is gated on BOTH authMethod === 'oauth-token' AND a
      // present token. A token with the wrong/absent authMethod is ignored.
      const settings: ProviderRouteSettings = {
        activeProvider: 'anthropic',
        models: { apiKey: null, oauthToken: 'oauth-abc', authMethod: 'api-key' },
      };
      expect(selectProviderMode(settings)).toEqual({
        provider: 'anthropic',
        credentialSource: 'missing-anthropic',
      });
    });

    it('whitespace-only api key is treated as missing (sanitize strips whitespace)', () => {
      const settings: ProviderRouteSettings = {
        activeProvider: 'anthropic',
        models: { apiKey: '   ', oauthToken: null, authMethod: 'api-key' },
      };
      expect(selectProviderMode(settings)).toEqual({
        provider: 'anthropic',
        credentialSource: 'missing-anthropic',
      });
    });

    it('undefined IGNORES OpenRouter credentials — goes through the Anthropic/default arm (raw seam, no auto-derive)', () => {
      // ODD-BUT-REAL current behaviour (F3 from GPT review): `selectProviderMode`
      // is the RAW provider-choice seam. With `activeProvider === undefined` it
      // never inspects OpenRouter credentials — it falls straight into the
      // Anthropic/default arm. (The OpenRouter auto-derive lives separately in
      // `normalizeSettings`, which runs BEFORE routing.) A provider-choice
      // restructure could accidentally "fix" this by folding the auto-derive in;
      // pin the current raw behaviour so that change is caught.
      const noAnthropicKey: ProviderRouteSettings = {
        activeProvider: undefined,
        models: { apiKey: null, oauthToken: null, authMethod: 'api-key' },
        openRouter: { enabled: true, oauthToken: 'or-token' },
      };
      expect(selectProviderMode(noAnthropicKey)).toEqual({
        provider: 'anthropic',
        credentialSource: 'missing-anthropic',
      });

      const withAnthropicKey: ProviderRouteSettings = {
        activeProvider: undefined,
        models: { apiKey: 'fake-anthropic-key', authMethod: 'api-key' },
        openRouter: { enabled: true, oauthToken: 'or-token' },
      };
      expect(selectProviderMode(withAnthropicKey)).toEqual({
        provider: 'anthropic',
        credentialSource: 'anthropic-api-key',
      });
    });
  });

  describe('activeProvider "openrouter" arm', () => {
    it('present (non-whitespace) oauth token → openrouter / openrouter-oauth-token', () => {
      const settings: ProviderRouteSettings = {
        activeProvider: 'openrouter',
        openRouter: { enabled: true, oauthToken: 'or-token' },
      };
      expect(selectProviderMode(settings)).toEqual({
        provider: 'openrouter',
        credentialSource: 'openrouter-oauth-token',
      });
    });

    it('missing oauth token → openrouter / missing-openrouter (does NOT fall back to a lingering Anthropic key)', () => {
      const settings: ProviderRouteSettings = {
        activeProvider: 'openrouter',
        models: { apiKey: 'fake-anthropic-lingering' },
        openRouter: { enabled: true, oauthToken: null },
      };
      expect(selectProviderMode(settings)).toEqual({
        provider: 'openrouter',
        credentialSource: 'missing-openrouter',
      });
    });

    it('whitespace-only oauth token is treated as missing (sanitize)', () => {
      const settings: ProviderRouteSettings = {
        activeProvider: 'openrouter',
        openRouter: { enabled: true, oauthToken: '   ' },
      };
      expect(selectProviderMode(settings)).toEqual({
        provider: 'openrouter',
        credentialSource: 'missing-openrouter',
      });
    });
  });

  describe('activeProvider "codex" arm', () => {
    it('ALWAYS returns codex / codex-subscription (no connectivity or model gating at this seam)', () => {
      const settings: ProviderRouteSettings = {
        activeProvider: 'codex',
        models: { apiKey: null, oauthToken: null },
      };
      expect(selectProviderMode(settings)).toEqual({
        provider: 'codex',
        credentialSource: 'codex-subscription',
      });
    });

    it('returns codex-subscription even with a lingering Anthropic key present', () => {
      const settings: ProviderRouteSettings = {
        activeProvider: 'codex',
        models: { apiKey: 'fake-anthropic-lingering', authMethod: 'api-key' },
      };
      expect(selectProviderMode(settings)).toEqual({
        provider: 'codex',
        credentialSource: 'codex-subscription',
      });
    });
  });

  describe('activeProvider "mindstone" arm (routes through OpenRouter with a managed key)', () => {
    it('explicit hasManagedKey:true → openrouter / mindstone-managed-key', () => {
      const settings: ProviderRouteSettings = {
        activeProvider: 'mindstone',
        hasManagedKey: true,
      };
      expect(selectProviderMode(settings)).toEqual({
        provider: 'openrouter',
        credentialSource: 'mindstone-managed-key',
      });
    });

    it('explicit hasManagedKey:false → openrouter / missing-mindstone (fail-closed, never falls back to a personal key)', () => {
      const settings: ProviderRouteSettings = {
        activeProvider: 'mindstone',
        hasManagedKey: false,
        openRouter: { enabled: true, oauthToken: 'or-personal-token' },
      };
      expect(selectProviderMode(settings)).toEqual({
        provider: 'openrouter',
        credentialSource: 'missing-mindstone',
      });
    });

    it('hasManagedKey omitted → consults the central managed-key resolver (resolver=true)', () => {
      registerManagedKeyAvailability(() => true);
      const settings: ProviderRouteSettings = { activeProvider: 'mindstone' };
      expect(selectProviderMode(settings)).toEqual({
        provider: 'openrouter',
        credentialSource: 'mindstone-managed-key',
      });
    });

    it('hasManagedKey omitted → consults the central managed-key resolver (resolver=false)', () => {
      registerManagedKeyAvailability(() => false);
      const settings: ProviderRouteSettings = { activeProvider: 'mindstone' };
      expect(selectProviderMode(settings)).toEqual({
        provider: 'openrouter',
        credentialSource: 'missing-mindstone',
      });
    });

    it('explicit hasManagedKey wins over the resolver (explicit false beats resolver=true)', () => {
      registerManagedKeyAvailability(() => true);
      const settings: ProviderRouteSettings = { activeProvider: 'mindstone', hasManagedKey: false };
      expect(selectProviderMode(settings).credentialSource).toBe('missing-mindstone');
    });
  });
});
