import { describe, expect, it } from 'vitest';
import {
  AUTH_METHOD_DISPLAY,
  calculateSubscriptionSavings,
} from '../authMethodDisplay';

describe('AUTH_METHOD_DISPLAY', () => {
  it('exposes a mindstone entry marked as subscription', () => {
    const mindstone = AUTH_METHOD_DISPLAY['mindstone'];
    expect(mindstone).toBeDefined();
    expect(mindstone.isSubscription).toBe(true);
    expect(mindstone.label).toBe('Mindstone Subscription');
    expect(mindstone.description).toMatch(/Mindstone/i);
  });

  it('exposes a mindstone-managed entry marked as subscription (covered)', () => {
    // providerAuthPlan.ts emits resolvedAuthLabel:'mindstone-managed' for managed-key
    // paths; it must be classified as covered, not out-of-pocket. (374 ledger rows.)
    const managed = AUTH_METHOD_DISPLAY['mindstone-managed'];
    expect(managed).toBeDefined();
    expect(managed.isSubscription).toBe(true);
  });

  it('keeps codex-subscription and oauth-token entries marked as subscription', () => {
    expect(AUTH_METHOD_DISPLAY['codex-subscription'].isSubscription).toBe(true);
    expect(AUTH_METHOD_DISPLAY['oauth-token'].isSubscription).toBe(true);
  });

  it('keeps api-key, openrouter, profile-direct, local, and unknown as non-subscription', () => {
    expect(AUTH_METHOD_DISPLAY['api-key'].isSubscription).toBe(false);
    expect(AUTH_METHOD_DISPLAY['openrouter'].isSubscription).toBe(false);
    expect(AUTH_METHOD_DISPLAY['profile-direct'].isSubscription).toBe(false);
    expect(AUTH_METHOD_DISPLAY['local'].isSubscription).toBe(false);
    expect(AUTH_METHOD_DISPLAY['unknown'].isSubscription).toBe(false);
  });
});

describe('calculateSubscriptionSavings', () => {
  it('returns zeros and hasSubscriptionUsage=false for empty input', () => {
    expect(calculateSubscriptionSavings({})).toEqual({
      subscriptionCoveredUsd: 0,
      actualCostUsd: 0,
      freeUsd: 0,
      unclassifiedUsd: 0,
      hasSubscriptionUsage: false,
    });
  });

  it('attributes mindstone-only spend to subscriptionCoveredUsd', () => {
    const result = calculateSubscriptionSavings({ mindstone: 12.5 });
    expect(result).toEqual({
      subscriptionCoveredUsd: 12.5,
      actualCostUsd: 0,
      freeUsd: 0,
      unclassifiedUsd: 0,
      hasSubscriptionUsage: true,
    });
  });

  it('classifies mindstone-managed as covered, not out-of-pocket', () => {
    const result = calculateSubscriptionSavings({ 'mindstone-managed': 9.99 });
    expect(result.subscriptionCoveredUsd).toBeCloseTo(9.99);
    expect(result.actualCostUsd).toBe(0);
    expect(result.unclassifiedUsd).toBe(0);
    expect(result.hasSubscriptionUsage).toBe(true);
  });

  it('splits mindstone + api-key into subscription vs actual buckets', () => {
    const result = calculateSubscriptionSavings({
      mindstone: 8,
      'api-key': 2.25,
    });
    expect(result).toEqual({
      subscriptionCoveredUsd: 8,
      actualCostUsd: 2.25,
      freeUsd: 0,
      unclassifiedUsd: 0,
      hasSubscriptionUsage: true,
    });
  });

  it('routes mindstone + local into subscription and free buckets', () => {
    const result = calculateSubscriptionSavings({
      mindstone: 4,
      local: 1.75,
    });
    expect(result).toEqual({
      subscriptionCoveredUsd: 4,
      actualCostUsd: 0,
      freeUsd: 1.75,
      unclassifiedUsd: 0,
      hasSubscriptionUsage: true,
    });
  });

  it('accumulates all subscription methods (incl. mindstone-managed) into the covered bucket', () => {
    const result = calculateSubscriptionSavings({
      mindstone: 5,
      'mindstone-managed': 1,
      'codex-subscription': 3,
      'oauth-token': 2,
    });
    expect(result.subscriptionCoveredUsd).toBe(11);
    expect(result.actualCostUsd).toBe(0);
    expect(result.freeUsd).toBe(0);
    expect(result.unclassifiedUsd).toBe(0);
    expect(result.hasSubscriptionUsage).toBe(true);
  });

  it('routes unknown / unmapped auth to unclassifiedUsd, NOT actualCostUsd (hero honesty)', () => {
    // The honest "You paid" number must not claim money for cost we cannot attribute.
    const result = calculateSubscriptionSavings({
      'made-up-method': 1.1,
      unknown: 2.5,
    });
    expect(result.unclassifiedUsd).toBeCloseTo(3.6);
    expect(result.actualCostUsd).toBe(0);
    expect(result.subscriptionCoveredUsd).toBe(0);
    expect(result.freeUsd).toBe(0);
    expect(result.hasSubscriptionUsage).toBe(false);
  });

  it('partitions a mixed wallet so the four buckets reconcile to the total', () => {
    const byAuth = {
      'codex-subscription': 1563,
      'api-key': 129,
      local: 5,
      unknown: 99,
      'made-up': 4,
    };
    const r = calculateSubscriptionSavings(byAuth);
    expect(r.subscriptionCoveredUsd).toBe(1563);
    expect(r.actualCostUsd).toBe(129); // known out-of-pocket only
    expect(r.freeUsd).toBe(5);
    expect(r.unclassifiedUsd).toBe(103); // unknown + unmapped
    const total = Object.values(byAuth).reduce((a, b) => a + b, 0);
    expect(
      r.subscriptionCoveredUsd + r.actualCostUsd + r.freeUsd + r.unclassifiedUsd,
    ).toBeCloseTo(total);
  });
});
