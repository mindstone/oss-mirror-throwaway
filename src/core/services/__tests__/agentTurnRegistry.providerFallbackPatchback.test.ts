/**
 * Tests for the paid-fallback indicator patch-back primitive
 * (docs/plans/260621_paid-fallback-indicator/).
 *
 * `updatePendingProviderFallbackDestination` rewrites the placeholder
 * `to: 'auto-failover'` provider fallback (written at the 429 Stage-4b site) with
 * the REAL credential source + billing axis once the retry's fresh route resolves.
 *
 * Covers: basic patch-back, multi-hop (only the last pending placeholder is
 * rewritten), no-op when there is no pending placeholder, and no-op for an unknown
 * turn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/logger', () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    createTurnSessionLogger: () => mockLogger,
    createScopedLogger: () => mockLogger,
  };
});

vi.mock('../autoContinueCache', () => ({
  cleanupAutoContinueCache: vi.fn(),
}));

import { agentTurnRegistry } from '../agentTurnRegistry';

const TURN_IDS = ['pf-turn-1', 'pf-turn-2', 'pf-turn-3', 'pf-turn-multi'];

describe('agentTurnRegistry.updatePendingProviderFallbackDestination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const id of TURN_IDS) agentTurnRegistry.deleteTurnFallbacks(id);
  });

  afterEach(() => {
    for (const id of TURN_IDS) agentTurnRegistry.deleteTurnFallbacks(id);
  });

  it('rewrites a pending auto-failover provider record with the real destination + billingSource', () => {
    agentTurnRegistry.addTurnFallback('pf-turn-1', {
      type: 'provider',
      from: 'anthropic-api-key',
      to: 'auto-failover',
      reason: 'multi-provider-rate-limit-failover',
    });

    agentTurnRegistry.updatePendingProviderFallbackDestination('pf-turn-1', {
      to: 'openrouter-oauth-token',
      billingSource: 'pool',
    });

    const fallbacks = agentTurnRegistry.getTurnFallbacks('pf-turn-1');
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toMatchObject({
      type: 'provider',
      from: 'anthropic-api-key',
      to: 'openrouter-oauth-token',
      billingSource: 'pool',
      reason: 'multi-provider-rate-limit-failover',
    });
  });

  it('only patches the LAST pending auto-failover record (multi-hop safe)', () => {
    // First hop already patched (anthropic -> openrouter), then openrouter 429'd
    // so a new pending placeholder for the next hop was written.
    agentTurnRegistry.addTurnFallback('pf-turn-multi', {
      type: 'provider',
      from: 'anthropic-api-key',
      to: 'openrouter-oauth-token',
      billingSource: 'pool',
      reason: 'multi-provider-rate-limit-failover',
    });
    agentTurnRegistry.addTurnFallback('pf-turn-multi', {
      type: 'provider',
      from: 'openrouter-oauth-token',
      to: 'auto-failover',
      reason: 'multi-provider-rate-limit-failover',
    });

    agentTurnRegistry.updatePendingProviderFallbackDestination('pf-turn-multi', {
      to: 'mindstone-managed-key',
      billingSource: 'subscription',
    });

    const fallbacks = agentTurnRegistry.getTurnFallbacks('pf-turn-multi');
    expect(fallbacks).toHaveLength(2);
    // First (already-patched) hop is untouched.
    expect(fallbacks[0]).toMatchObject({ to: 'openrouter-oauth-token', billingSource: 'pool' });
    // Second hop's placeholder is rewritten.
    expect(fallbacks[1]).toMatchObject({ to: 'mindstone-managed-key', billingSource: 'subscription' });
  });

  it('LIVE SEQUENCE A→B(429)→C attributes A→B and B→C (patch at each resolution seam)', () => {
    // This reproduces the real interleaving of the Stage-4b write site and the
    // route-resolution-seam patch-back, hop by hop, to prove intermediate hops are
    // attributed (the success-block-only approach left A→auto-failover for A→B(429)→C).
    const id = 'pf-turn-multi'; // reuse a cleaned id

    // Hop A 429s → Stage-4b writes placeholder #1.
    agentTurnRegistry.addTurnFallback(id, {
      type: 'provider',
      from: 'anthropic-api-key',
      to: 'auto-failover',
      reason: 'multi-provider-rate-limit-failover',
    });
    // Retry's route RESOLVES to B → seam patches the last pending placeholder.
    agentTurnRegistry.updatePendingProviderFallbackDestination(id, {
      to: 'openrouter-oauth-token',
      billingSource: 'pool',
    });

    // Hop B (the destination A landed on) itself 429s → Stage-4b writes placeholder #2.
    agentTurnRegistry.addTurnFallback(id, {
      type: 'provider',
      from: 'openrouter-oauth-token',
      to: 'auto-failover',
      reason: 'multi-provider-rate-limit-failover',
    });
    // Retry's route RESOLVES to C → seam patches the last pending placeholder.
    agentTurnRegistry.updatePendingProviderFallbackDestination(id, {
      to: 'mindstone-managed-key',
      billingSource: 'subscription',
    });
    // Hop C succeeds → no further write.

    const fallbacks = agentTurnRegistry.getTurnFallbacks(id);
    expect(fallbacks).toHaveLength(2);
    // A landed on B (NOT left as auto-failover — the bug the success-block approach had).
    expect(fallbacks[0]).toMatchObject({
      from: 'anthropic-api-key',
      to: 'openrouter-oauth-token',
      billingSource: 'pool',
    });
    // B landed on C.
    expect(fallbacks[1]).toMatchObject({
      from: 'openrouter-oauth-token',
      to: 'mindstone-managed-key',
      billingSource: 'subscription',
    });
    // No placeholder survived.
    expect(fallbacks.some((fb) => fb.to === 'auto-failover')).toBe(false);
  });

  it('patches a Stage-3 server/transient placeholder the same way (multi-provider-server-error-failover)', () => {
    // Cross-file contract: the Stage-3 provider-chain recovery handler writes a
    // placeholder with reason 'multi-provider-server-error-failover' and to:'auto-failover'.
    // The patch-back must rewrite it identically to the 429 case so a server-error
    // switch to a PAID backup lands with a billing indicator (pre-flip gate item #3).
    agentTurnRegistry.addTurnFallback('pf-turn-1', {
      type: 'provider',
      from: 'openrouter-oauth-token',
      to: 'auto-failover',
      reason: 'multi-provider-server-error-failover',
    });

    agentTurnRegistry.updatePendingProviderFallbackDestination('pf-turn-1', {
      to: 'anthropic-api-key',
      billingSource: 'pay-per-use',
    });

    expect(agentTurnRegistry.getTurnFallbacks('pf-turn-1')[0]).toMatchObject({
      type: 'provider',
      from: 'openrouter-oauth-token',
      to: 'anthropic-api-key',
      billingSource: 'pay-per-use',
      reason: 'multi-provider-server-error-failover',
    });
  });

  it('writes a null billingSource when the resolved route has no billing identity', () => {
    agentTurnRegistry.addTurnFallback('pf-turn-2', {
      type: 'provider',
      from: 'anthropic-api-key',
      to: 'auto-failover',
      reason: 'multi-provider-rate-limit-failover',
    });

    agentTurnRegistry.updatePendingProviderFallbackDestination('pf-turn-2', {
      to: 'local-none',
      billingSource: null,
    });

    expect(agentTurnRegistry.getTurnFallbacks('pf-turn-2')[0]).toMatchObject({
      to: 'local-none',
      billingSource: null,
    });
  });

  it('is a no-op when there is no pending auto-failover record', () => {
    agentTurnRegistry.addTurnFallback('pf-turn-3', {
      type: 'model',
      from: 'claude-opus-4-7',
      to: 'claude-sonnet-4',
      reason: 'capacity',
    });

    agentTurnRegistry.updatePendingProviderFallbackDestination('pf-turn-3', {
      to: 'openrouter-oauth-token',
      billingSource: 'pool',
    });

    // The unrelated model fallback is untouched; nothing was patched.
    const fallbacks = agentTurnRegistry.getTurnFallbacks('pf-turn-3');
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toMatchObject({ type: 'model', to: 'claude-sonnet-4' });
    expect(fallbacks[0].billingSource).toBeUndefined();
  });

  it('is a no-op for an unknown turn (no fallbacks recorded)', () => {
    expect(() =>
      agentTurnRegistry.updatePendingProviderFallbackDestination('pf-turn-unknown', {
        to: 'openrouter-oauth-token',
        billingSource: 'pool',
      }),
    ).not.toThrow();
    expect(agentTurnRegistry.getTurnFallbacks('pf-turn-unknown')).toEqual([]);
  });
});
