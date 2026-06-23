/**
 * Regression tests for pendingCheckoutTier.
 *
 * Covers record/get/clear behavior, session-id correlation, latest-slot
 * fallback, TTL eviction, and the Stripe session-id parser.
 *
 * Context: docs-private/investigations/260520_pro_to_expert_upgrade_not_reflected.md
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  }),
}));

import {
  __resetPendingCheckoutTierForTests,
  clearPendingCheckout,
  getPendingCheckout,
  parseStripeSessionId,
  recordPendingCheckout,
} from '../pendingCheckoutTier';

describe('pendingCheckoutTier', () => {
  beforeEach(() => {
    __resetPendingCheckoutTierForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records and returns a session-keyed expectation, clearing on read', () => {
    recordPendingCheckout({ tier: 'rogue', sessionId: 'cs_test_abc' });
    expect(getPendingCheckout('cs_test_abc')).toBe('rogue');
    expect(getPendingCheckout('cs_test_abc')).toBeNull();
  });

  it('returns the latest-slot expectation when sessionId is unknown or missing', () => {
    recordPendingCheckout({ tier: 'dash', sessionId: 'cs_test_abc' });
    expect(getPendingCheckout('cs_test_other')).toBe('dash');
    expect(getPendingCheckout()).toBeNull();
  });

  it('falls back to latest when no sessionId is provided', () => {
    recordPendingCheckout({ tier: 'rogue' });
    expect(getPendingCheckout()).toBe('rogue');
    expect(getPendingCheckout()).toBeNull();
  });

  it('prefers session-id match over latest', () => {
    recordPendingCheckout({ tier: 'dash', sessionId: 'cs_test_first' });
    recordPendingCheckout({ tier: 'rogue', sessionId: 'cs_test_second' });
    expect(getPendingCheckout('cs_test_first')).toBe('dash');
    expect(getPendingCheckout('cs_test_second')).toBe('rogue');
  });

  it('expires entries after TTL', () => {
    recordPendingCheckout({ tier: 'rogue', sessionId: 'cs_test_abc' });
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(getPendingCheckout('cs_test_abc')).toBeNull();
    expect(getPendingCheckout()).toBeNull();
  });

  it('keeps entries within TTL', () => {
    recordPendingCheckout({ tier: 'rogue', sessionId: 'cs_test_abc' });
    vi.advanceTimersByTime(10 * 60 * 1000 - 1);
    expect(getPendingCheckout('cs_test_abc')).toBe('rogue');
  });

  it('respects custom ttlMs override', () => {
    recordPendingCheckout({ tier: 'dash', sessionId: 'cs_test_abc', ttlMs: 1000 });
    vi.advanceTimersByTime(1001);
    expect(getPendingCheckout('cs_test_abc')).toBeNull();
  });

  it('clearPendingCheckout removes session-keyed and latest entries', () => {
    recordPendingCheckout({ tier: 'rogue', sessionId: 'cs_test_abc' });
    clearPendingCheckout('cs_test_abc');
    expect(getPendingCheckout('cs_test_abc')).toBeNull();
    expect(getPendingCheckout()).toBeNull();
  });

  it('clearPendingCheckout without sessionId clears the latest slot', () => {
    recordPendingCheckout({ tier: 'dash' });
    clearPendingCheckout();
    expect(getPendingCheckout()).toBeNull();
  });

  it('clearPendingCheckout(sessionId) preserves latest when latest belongs to a different checkout', () => {
    // Two interleaved checkouts: clearing the first should NOT wipe the
    // second's latest-slot fallback. Without this guard, a defensive clear
    // on one flow trampled the other when its deep link was missing
    // session_id.
    recordPendingCheckout({ tier: 'dash', sessionId: 'cs_test_first' });
    getPendingCheckout('cs_test_first'); // simulate read clearing latest
    recordPendingCheckout({ tier: 'rogue', sessionId: 'cs_test_second' });
    clearPendingCheckout('cs_test_first');
    expect(getPendingCheckout()).toBe('rogue');
  });

  describe('parseStripeSessionId', () => {
    it('extracts cs_test_* from a Stripe checkout URL', () => {
      const url = 'https://checkout.stripe.com/c/pay/cs_test_abc123XYZ#fid_12345';
      expect(parseStripeSessionId(url)).toBe('cs_test_abc123XYZ');
    });

    it('extracts cs_live_* from a Stripe checkout URL', () => {
      const url = 'https://checkout.stripe.com/c/pay/cs_live_DEF456#trail';
      expect(parseStripeSessionId(url)).toBe('cs_live_DEF456');
    });

    it('returns null for URLs without a Stripe session id', () => {
      expect(parseStripeSessionId('https://example.com/some/path')).toBeNull();
    });

    it('returns null for malformed-but-similar prefixes', () => {
      expect(parseStripeSessionId('cs_demo_abc')).toBeNull();
    });
  });
});
