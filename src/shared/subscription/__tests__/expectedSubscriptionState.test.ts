import { describe, it, expect } from 'vitest';
import {
  ENTITLED_STATUSES,
  isEntitledStatus,
  isExpectedSubscriptionState,
  type ExpectedSubscriptionCriteria,
} from '@shared/subscription/expectedSubscriptionState';

// Main-process criteria: active-only + managed-provider required (mirrors
// subscriptionCheckoutRetry.ts's inline predicate).
const MAIN: ExpectedSubscriptionCriteria = {
  tier: 'rogue',
  entitledStatuses: ['active'],
  requireManagedProvider: true,
};

// Renderer criteria: active∪trialing, no managed-provider gate (mirrors
// useSubscriptionState.ts's inline predicate).
const RENDERER: ExpectedSubscriptionCriteria = {
  tier: 'rogue',
  entitledStatuses: ENTITLED_STATUSES,
  requireManagedProvider: false,
};

describe('isExpectedSubscriptionState', () => {
  describe('the bug this kills: stale-tier upgrade short-circuit', () => {
    it('REJECTS a stale active subscription on the OLD tier during a dash→rogue upgrade (main)', () => {
      // This is the exact 260531_wait_for_tier_change_after_stripe failure: the
      // pre-existing active "dash" row used to satisfy `status === 'active'`.
      expect(
        isExpectedSubscriptionState({ tier: 'dash', status: 'active' }, MAIN, true),
      ).toBe(false);
    });

    it('REJECTS a stale active dash row during a dash→rogue upgrade (renderer)', () => {
      expect(
        isExpectedSubscriptionState({ tier: 'dash', status: 'active' }, RENDERER),
      ).toBe(false);
    });

    it('ACCEPTS once the observed tier flips to the expected rogue tier (main)', () => {
      expect(
        isExpectedSubscriptionState({ tier: 'rogue', status: 'active' }, MAIN, true),
      ).toBe(true);
    });

    it('ACCEPTS once the observed tier flips to the expected rogue tier (renderer)', () => {
      expect(
        isExpectedSubscriptionState({ tier: 'rogue', status: 'active' }, RENDERER),
      ).toBe(true);
    });
  });

  describe('absent / malformed observed state', () => {
    it.each([null, undefined])('returns false for %s observed', observed => {
      expect(isExpectedSubscriptionState(observed, MAIN, true)).toBe(false);
    });

    it('returns false when tier is missing', () => {
      expect(isExpectedSubscriptionState({ status: 'active' }, MAIN, true)).toBe(false);
    });

    it('returns false when status is missing', () => {
      expect(isExpectedSubscriptionState({ tier: 'rogue' }, MAIN, true)).toBe(false);
    });
  });

  describe('status membership', () => {
    it('main accepts only active, not trialing', () => {
      expect(isExpectedSubscriptionState({ tier: 'rogue', status: 'active' }, MAIN, true)).toBe(true);
      expect(isExpectedSubscriptionState({ tier: 'rogue', status: 'trialing' }, MAIN, true)).toBe(false);
    });

    it('renderer accepts active and trialing', () => {
      expect(isExpectedSubscriptionState({ tier: 'rogue', status: 'active' }, RENDERER)).toBe(true);
      expect(isExpectedSubscriptionState({ tier: 'rogue', status: 'trialing' }, RENDERER)).toBe(true);
    });

    it.each(['past_due', 'canceled', 'incomplete', 'inactive'])(
      'rejects non-entitled status %s on both criteria',
      status => {
        expect(isExpectedSubscriptionState({ tier: 'rogue', status }, MAIN, true)).toBe(false);
        expect(isExpectedSubscriptionState({ tier: 'rogue', status }, RENDERER)).toBe(false);
      },
    );
  });

  describe('managed-provider gate', () => {
    it('main rejects a matching tier/status when the managed provider is absent', () => {
      expect(isExpectedSubscriptionState({ tier: 'rogue', status: 'active' }, MAIN, false)).toBe(false);
      expect(isExpectedSubscriptionState({ tier: 'rogue', status: 'active' }, MAIN, undefined)).toBe(false);
    });

    it('renderer ignores managedProviderPresent entirely (gate off)', () => {
      expect(isExpectedSubscriptionState({ tier: 'rogue', status: 'active' }, RENDERER, false)).toBe(true);
      expect(isExpectedSubscriptionState({ tier: 'rogue', status: 'active' }, RENDERER, undefined)).toBe(true);
    });
  });

  describe('tier match for first-time dash checkout', () => {
    it('accepts dash when dash is expected', () => {
      expect(
        isExpectedSubscriptionState({ tier: 'dash', status: 'active' }, { ...MAIN, tier: 'dash' }, true),
      ).toBe(true);
    });
  });
});

describe('ENTITLED_STATUSES / isEntitledStatus', () => {
  it('contains exactly active and trialing', () => {
    expect([...ENTITLED_STATUSES].sort()).toEqual(['active', 'trialing']);
  });

  it.each(['active', 'trialing'])('isEntitledStatus(%s) is true', s => {
    expect(isEntitledStatus(s)).toBe(true);
  });

  it.each(['past_due', 'canceled', 'incomplete', 'inactive', '', null, undefined])(
    'isEntitledStatus(%s) is false',
    s => {
      expect(isEntitledStatus(s as string | null | undefined)).toBe(false);
    },
  );
});
