/**
 * Stage 0 characterization — Codex → Claude divert decision table (seam 4).
 *
 * `routeDecision`'s `codex` arm classifies the resolved model via
 * `resolveDirectAnthropicModel` and `codexDirectAnthropicDivertWireModel`:
 *
 *   - native-claude (`claude-*`)  → DIVERTS to Anthropic direct (this check runs
 *                                    BEFORE the connectivity guard, so it holds
 *                                    even when Codex is disconnected — as long as
 *                                    Anthropic credentials exist). Without
 *                                    Anthropic credentials it terminates
 *                                    `missing-anthropic-*`.
 *   - bare-non-claude (`gpt-5.5`) → stays on Codex (codex-proxy when connected).
 *   - foreign-dialect (slash IDs) → does NOT divert; stays on the Codex path.
 *
 * Individual arms of this are pinned across codexClaudeDivert.test.ts (FOX-3494
 * actionable-terminal) and invariants.test.ts (I2d bare-GPT-stays-codex, I10
 * REBEL-538 codexClaude→anthropic-capable, "260429 native Claude under Codex
 * disconnected diverts with real creds"). This file consolidates the THREE-WAY
 * distinction into one table so the Stage 1 restructure can't regress one leg
 * while another stays green. Pins CURRENT routing/terminal behaviour.
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

import { ProviderRouter, type ProviderRouteSettings } from '../providerRouting';

function codexSettings(apiKey: string | null): ProviderRouteSettings {
  return {
    activeProvider: 'codex',
    models: { apiKey, oauthToken: null, authMethod: 'api-key', model: 'gpt-5.5' },
    localModel: { activeProfileId: null, profiles: [] },
    providerKeys: {},
  };
}

describe('Codex divert decision table — Stage 0 characterization', () => {
  describe('native-claude model under codex', () => {
    it('WITH Anthropic credentials + connected → diverts to anthropic-direct', () => {
      const decision = ProviderRouter.forTurn({
        settings: codexSettings('fake-anthropic-key'),
        model: 'claude-sonnet-4-6',
        codexConnectivity: 'connected',
        role: 'execution',
      });
      expect(decision.provider).toBe('anthropic');
      expect(decision.transport).toBe('anthropic-direct');
      expect(decision.kind).toBe('dispatchable');
    });

    it('WITH Anthropic credentials + DISCONNECTED → still diverts to anthropic-direct (divert precedes connectivity guard)', () => {
      const decision = ProviderRouter.forTurn({
        settings: codexSettings('fake-anthropic-key'),
        model: 'claude-haiku-4-5',
        codexConnectivity: 'disconnected',
        role: 'execution',
      });
      expect(decision.provider).toBe('anthropic');
      expect(decision.transport).toBe('anthropic-direct');
    });

    it('WITHOUT Anthropic credentials + connected (PRIMARY) → actionable missing-anthropic-credentials-for-claude-model terminal', () => {
      const decision = ProviderRouter.forTurn({
        settings: codexSettings(null),
        model: 'claude-opus-4-8',
        codexConnectivity: 'connected',
        role: 'execution',
      });
      expect(decision.provider).toBe('anthropic');
      expect(decision.kind).toBe('terminal');
      expect(decision.invalidReason).toBe('missing-anthropic-credentials-for-claude-model');
    });
  });

  describe('bare non-claude model under codex', () => {
    it('connected → stays on codex (codex-proxy), does NOT divert to Anthropic', () => {
      const decision = ProviderRouter.forTurn({
        settings: codexSettings('fake-anthropic-lingering'),
        model: 'gpt-5.5',
        codexConnectivity: 'connected',
        role: 'execution',
      });
      expect(decision.provider).toBe('codex');
      expect(decision.transport).toBe('codex-proxy');
      expect(decision.modelDialect).toBe('openai-compatible');
    });

    it('disconnected → codex terminal missing-codex-connection (does NOT divert to Anthropic despite lingering key)', () => {
      const decision = ProviderRouter.forTurn({
        settings: codexSettings('fake-anthropic-lingering'),
        model: 'gpt-5.5',
        codexConnectivity: 'disconnected',
        role: 'execution',
      });
      expect(decision.provider).toBe('codex');
      expect(decision.kind).toBe('terminal');
      expect(decision.invalidReason).toBe('missing-codex-connection');
    });
  });

  describe('foreign-dialect (slash) model under codex', () => {
    it('does NOT divert to Anthropic; stays on the Codex path and fails closed when disconnected', () => {
      // openai/gpt-5.5 is a foreign dialect → codexDirectAnthropicDivertWireModel
      // returns null, so the claude-divert branch is skipped and the model stays
      // on the Codex arm.
      const decision = ProviderRouter.forTurn({
        settings: codexSettings('fake-anthropic-lingering'),
        model: 'openai/gpt-5.5',
        codexConnectivity: 'disconnected',
        role: 'execution',
      });
      expect(decision.provider).toBe('codex');
      expect(decision.kind).toBe('terminal');
      expect(decision.invalidReason).toBe('missing-codex-connection');
    });
  });
});
