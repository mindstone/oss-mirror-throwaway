import { describe, expect, it, vi } from 'vitest';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type { ModelProfile } from '@shared/types';
import { ProviderRouter, type ProviderRouteSettings } from '../providerRouting';
import { isTerminalDecision } from '../providerRouteDecision';

/**
 * FOX-3494 — Mechanism B: a native-Claude (`claude-*`) model selected while the
 * active provider is a connected ChatGPT Pro (Codex) subscription and no
 * Anthropic credential exists. The deliberate `claude-*`→Anthropic divert
 * dead-ends. For a PRIMARY user turn this must surface as an ACTIONABLE terminal
 * (`missing-anthropic-credentials-for-claude-model`) — not the misleading
 * generic Anthropic "needs a key" terminal — while BTS/subagent KEEP the generic
 * terminal (load-bearing for the 260501 auto-title fix).
 */

const CLAUDE_MODEL = 'claude-opus-4-8';

// Active provider = codex, no Anthropic key anywhere.
const codexNoAnthropicSettings: ProviderRouteSettings = {
  activeProvider: 'codex',
  models: { apiKey: null, oauthToken: null },
};

// An anthropic-typed profile pinned for working role; no global Anthropic key.
const anthropicProfile: ModelProfile = {
  id: 'anthropic-claude-profile',
  name: 'Claude (Anthropic)',
  providerType: 'anthropic',
  serverUrl: 'https://api.anthropic.com',
  model: CLAUDE_MODEL,
  createdAt: 1,
};

const codexWithAnthropicProfileSettings: ProviderRouteSettings = {
  activeProvider: 'codex',
  models: { apiKey: null, oauthToken: null, workingProfileId: anthropicProfile.id },
  localModel: { activeProfileId: null, profiles: [anthropicProfile] },
};

describe('FOX-3494 Mechanism B — codex + claude-* primary turn divert', () => {
  describe('B-settings arm (case "codex", claude-* model, no anthropic key)', () => {
    it('PRIMARY (execution) turn → actionable terminal reason', () => {
      const decision = ProviderRouter.forTurn({
        settings: codexNoAnthropicSettings,
        model: CLAUDE_MODEL,
        codexConnectivity: 'connected',
        role: 'execution',
      });
      expect(isTerminalDecision(decision)).toBe(true);
      expect(decision.invalidReason).toBe('missing-anthropic-credentials-for-claude-model');
      expect(decision.provider).toBe('anthropic');
    });

    it('PRIMARY (planning) turn → actionable terminal reason', () => {
      const decision = ProviderRouter.forTurn({
        settings: codexNoAnthropicSettings,
        model: CLAUDE_MODEL,
        codexConnectivity: 'connected',
        role: 'planning',
      });
      expect(isTerminalDecision(decision)).toBe(true);
      expect(decision.invalidReason).toBe('missing-anthropic-credentials-for-claude-model');
    });

    it('does NOT apply when codex is NOT connected (keeps generic Anthropic terminal)', () => {
      const decision = ProviderRouter.forTurn({
        settings: codexNoAnthropicSettings,
        model: CLAUDE_MODEL,
        codexConnectivity: 'disconnected',
        role: 'execution',
      });
      expect(isTerminalDecision(decision)).toBe(true);
      expect(decision.invalidReason).toBe('missing-anthropic-credentials');
    });
  });

  describe('B-profile arm (anthropic-typed profile, claude-* model, no anthropic key)', () => {
    it('PRIMARY (execution) turn → actionable terminal reason', () => {
      const decision = ProviderRouter.forTurn({
        settings: codexWithAnthropicProfileSettings,
        model: null,
        profile: anthropicProfile,
        codexConnectivity: 'connected',
        role: 'execution',
      });
      expect(isTerminalDecision(decision)).toBe(true);
      expect(decision.invalidReason).toBe('missing-anthropic-credentials-for-claude-model');
      expect(decision.provider).toBe('anthropic');
    });

    it('does NOT apply when codex is NOT connected (keeps generic Anthropic terminal)', () => {
      const decision = ProviderRouter.forTurn({
        settings: codexWithAnthropicProfileSettings,
        model: null,
        profile: anthropicProfile,
        codexConnectivity: 'disconnected',
        role: 'execution',
      });
      expect(isTerminalDecision(decision)).toBe(true);
      expect(decision.invalidReason).toBe('missing-anthropic-credentials');
    });

    // FOX-3494 (F2): a genuine-Anthropic / openrouter / mindstone user who happens
    // to have codex connected in the background, with an Anthropic profile selected
    // and no Anthropic key, must NOT be mis-attributed to "ChatGPT Pro". The
    // profile arm gates on activeProvider==='codex', so a non-codex active provider
    // keeps the generic Anthropic terminal even though codex is connected.
    it('NON-codex active provider + codex connected → keeps generic Anthropic terminal (no false ChatGPT-Pro attribution)', () => {
      const openrouterActiveWithAnthropicProfile: ProviderRouteSettings = {
        ...codexWithAnthropicProfileSettings,
        activeProvider: 'openrouter',
      };
      const decision = ProviderRouter.forTurn({
        settings: openrouterActiveWithAnthropicProfile,
        model: null,
        profile: anthropicProfile,
        codexConnectivity: 'connected',
        role: 'execution',
      });
      expect(isTerminalDecision(decision)).toBe(true);
      expect(decision.invalidReason).toBe('missing-anthropic-credentials');
    });
  });

  // FOX-3494 (F5): primary-ness keys on the ROLE (execution|planning), NOT the
  // route SCOPE. A future scope-logic change must not silently invert this, so
  // assert the actionable reason fires for an execution role across every scope.
  describe('route-scope matrix — actionable reason keys on role, not scope', () => {
    const SCOPES = ['normal-turn', 'council', 'ad-hoc', 'retry', 'fallback', 'eval'] as const;
    it.each(SCOPES)('execution role + %s scope → actionable terminal reason', (routeScope) => {
      const decision = ProviderRouter.forTurn({
        settings: codexNoAnthropicSettings,
        model: CLAUDE_MODEL,
        codexConnectivity: 'connected',
        role: 'execution',
        routeScope,
      });
      expect(isTerminalDecision(decision)).toBe(true);
      expect(decision.invalidReason).toBe('missing-anthropic-credentials-for-claude-model');
    });
  });

  describe('GREEN must stay — BTS / subagent divert preservation (260501 auto-title)', () => {
    it('BTS claude-* under connected codex, no anthropic key → KEEPS generic Anthropic terminal', () => {
      const decision = ProviderRouter.forBTS({
        settings: codexNoAnthropicSettings,
        model: CLAUDE_MODEL,
        codexConnectivity: 'connected',
      });
      expect(isTerminalDecision(decision)).toBe(true);
      expect(decision.invalidReason).toBe('missing-anthropic-credentials');
    });

    it('subagent claude-* under connected codex, no anthropic key → KEEPS generic Anthropic terminal', () => {
      const decision = ProviderRouter.forSubagent({
        settings: codexNoAnthropicSettings,
        model: CLAUDE_MODEL,
        codexConnectivity: 'connected',
      });
      expect(isTerminalDecision(decision)).toBe(true);
      expect(decision.invalidReason).toBe('missing-anthropic-credentials');
    });

    it('BTS via anthropic-typed profile under connected codex → KEEPS generic Anthropic terminal', () => {
      const decision = ProviderRouter.forBTS({
        settings: codexWithAnthropicProfileSettings,
        model: `profile:${anthropicProfile.id}`,
        profile: anthropicProfile,
        codexConnectivity: 'connected',
      });
      expect(isTerminalDecision(decision)).toBe(true);
      expect(decision.invalidReason).toBe('missing-anthropic-credentials');
    });
  });
});
