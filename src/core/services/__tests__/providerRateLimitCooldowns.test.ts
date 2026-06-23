/**
 * Stage 4 — per-credential-source rate-limit cooldown store.
 * Deterministic via the injectable `now` parameter (no fake timers).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { ProviderRateLimitCooldownStore, providerRateLimitCooldowns } from '../providerRateLimitCooldowns';

const T0 = 1_000_000;

describe('ProviderRateLimitCooldownStore', () => {
  let store: ProviderRateLimitCooldownStore;
  beforeEach(() => {
    store = new ProviderRateLimitCooldownStore();
  });

  it('a fresh source is not in cooldown', () => {
    expect(store.isInCooldown('anthropic-api-key', T0)).toBe(false);
    expect(store.remainingMs('anthropic-api-key', T0)).toBe(0);
    expect(store.cooledDownSources(T0).size).toBe(0);
  });

  it('records a default cooldown when no retryAfter is given', () => {
    store.recordRateLimit('openrouter-oauth-token', undefined, T0);
    expect(store.isInCooldown('openrouter-oauth-token', T0)).toBe(true);
    expect(store.remainingMs('openrouter-oauth-token', T0)).toBe(30_000);
    expect(store.isInCooldown('openrouter-oauth-token', T0 + 29_999)).toBe(true);
    expect(store.isInCooldown('openrouter-oauth-token', T0 + 30_000)).toBe(false);
  });

  it('honours retryAfter, capped at the max', () => {
    store.recordRateLimit('codex-subscription', 60_000, T0);
    expect(store.remainingMs('codex-subscription', T0)).toBe(60_000);
    store.recordRateLimit('anthropic-api-key', 10 * 60_000, T0);
    expect(store.remainingMs('anthropic-api-key', T0)).toBe(5 * 60_000); // capped
  });

  it('only EXTENDS, never shortens, an existing cooldown', () => {
    store.recordRateLimit('openrouter-oauth-token', 60_000, T0);
    store.recordRateLimit('openrouter-oauth-token', 5_000, T0); // shorter — ignored
    expect(store.remainingMs('openrouter-oauth-token', T0)).toBe(60_000);
    store.recordRateLimit('openrouter-oauth-token', 120_000, T0); // longer — extends
    expect(store.remainingMs('openrouter-oauth-token', T0)).toBe(120_000);
  });

  it('keys are independent across credential sources', () => {
    store.recordRateLimit('openrouter-oauth-token', 60_000, T0);
    expect(store.isInCooldown('openrouter-oauth-token', T0)).toBe(true);
    // A 429 on the managed OpenRouter key does NOT cool down a personal OpenRouter token, etc.
    expect(store.isInCooldown('mindstone-managed-key', T0)).toBe(false);
    expect(store.isInCooldown('anthropic-api-key', T0)).toBe(false);
  });

  it('recordSuccess clears a source cooldown', () => {
    store.recordRateLimit('codex-subscription', 60_000, T0);
    expect(store.isInCooldown('codex-subscription', T0)).toBe(true);
    store.recordSuccess('codex-subscription');
    expect(store.isInCooldown('codex-subscription', T0)).toBe(false);
  });

  it('cooledDownSources returns only the currently-active set and prunes expired entries', () => {
    store.recordRateLimit('openrouter-oauth-token', 60_000, T0);
    store.recordRateLimit('anthropic-api-key', 10_000, T0);
    const atT0 = store.cooledDownSources(T0);
    expect(new Set(atT0)).toEqual(new Set(['openrouter-oauth-token', 'anthropic-api-key']));
    // After anthropic expires, only openrouter remains.
    const later = store.cooledDownSources(T0 + 20_000);
    expect(new Set(later)).toEqual(new Set(['openrouter-oauth-token']));
  });

  it('clearAll drops every cooldown', () => {
    store.recordRateLimit('openrouter-oauth-token', 60_000, T0);
    store.recordRateLimit('codex-subscription', 60_000, T0);
    store.clearAll();
    expect(store.cooledDownSources(T0).size).toBe(0);
  });

  it('exports a process-wide singleton', () => {
    providerRateLimitCooldowns.clearAll();
    providerRateLimitCooldowns.recordRateLimit('anthropic-api-key', 60_000, T0);
    expect(providerRateLimitCooldowns.isInCooldown('anthropic-api-key', T0)).toBe(true);
    providerRateLimitCooldowns.clearAll();
  });
});
