import { describe, it, expect } from 'vitest';

import { resolveContributionRelayEnabled } from '../contributionRelayFlag';

// ─── 260427 graduation (Tranche A — submit-transport hardening) ─────
// The Stage 5a channel-aware defaults (stable off, beta+dev on) were
// graduated to a UNIVERSAL default of `true` on 260427 once Stage 1+2+3
// of the submit-transport hardening closed the 12 submission-flow
// footguns that originally motivated the conservative stable rollout.
// See `docs/plans/260427_contribution_flow_followon_submission_auth.md`.
//
// The resolution rules are non-negotiable:
//
//   - A user-set boolean ALWAYS wins, regardless of channel. Users
//     who opted out before the graduation keep their opt-out; users
//     can still disable the experiment in settings if the relay
//     breaks for them.
//   - `undefined` setting → universal default `true` (every channel,
//     plus null/undefined channels).

describe('resolveContributionRelayEnabled', () => {
  describe('user-set boolean wins over the universal default', () => {
    it.each([
      ['stable', true],
      ['beta', true],
      ['dev', true],
      ['stable', false],
      ['beta', false],
      ['dev', false],
    ] as const)(
      'setting=%s on %s channel returns the setting verbatim',
      (channel, setting) => {
        expect(resolveContributionRelayEnabled(setting, channel)).toBe(setting);
      },
    );

    it('user opt-out on stable returns false (preserves pre-graduation override)', () => {
      expect(resolveContributionRelayEnabled(false, 'stable')).toBe(false);
    });

    it('user opt-out on beta returns false', () => {
      expect(resolveContributionRelayEnabled(false, 'beta')).toBe(false);
    });

    it('user opt-in on any channel returns true', () => {
      expect(resolveContributionRelayEnabled(true, 'stable')).toBe(true);
      expect(resolveContributionRelayEnabled(true, 'beta')).toBe(true);
      expect(resolveContributionRelayEnabled(true, 'dev')).toBe(true);
    });
  });

  describe('universal default of true when setting is undefined', () => {
    it('stable channel defaults to true (graduated 260427)', () => {
      expect(resolveContributionRelayEnabled(undefined, 'stable')).toBe(true);
    });

    it('beta channel defaults to true', () => {
      expect(resolveContributionRelayEnabled(undefined, 'beta')).toBe(true);
    });

    it('dev channel defaults to true', () => {
      expect(resolveContributionRelayEnabled(undefined, 'dev')).toBe(true);
    });
  });

  describe('missing / unrecognized channel still gets the universal default', () => {
    it('null channel returns true (matches all other channels post-graduation)', () => {
      expect(resolveContributionRelayEnabled(undefined, null)).toBe(true);
    });

    it('undefined channel returns true', () => {
      expect(resolveContributionRelayEnabled(undefined, undefined)).toBe(true);
    });

    it('user opt-out still wins when channel is null', () => {
      expect(resolveContributionRelayEnabled(false, null)).toBe(false);
    });

    it('user opt-in still wins when channel is null', () => {
      expect(resolveContributionRelayEnabled(true, null)).toBe(true);
    });
  });
});
