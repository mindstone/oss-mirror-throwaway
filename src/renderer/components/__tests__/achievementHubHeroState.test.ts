import { describe, expect, it } from 'vitest';
import { selectTimeSavedHeroState } from '../achievementHubHeroState';

/**
 * Regression coverage for docs-private/investigations/260520_time_saved_zero_or_missing.md.
 *
 * The Overview hero must distinguish four trust-sensitive states. Before this
 * fix the hero unconditionally showed weekly time and read `0 min` for any of:
 *   - weekly aggregate present but zero (real zero this week)
 *   - weekly aggregate missing because no current-week entries were written
 *     (estimation failed silently — see BTS structured-output broadening)
 *   - aggregate fetch itself rejected (modal request all-or-nothing failure)
 *
 * Showing a numeric `0 min` for the second and third cases reads as data loss
 * to users who have many tracked hours overall. The selector is the single
 * source of truth for which copy the hero renders.
 */
describe('selectTimeSavedHeroState', () => {
  it('renders the weekly variant when this week has positive minutes', () => {
    expect(selectTimeSavedHeroState(120, 13_366, false)).toEqual({ kind: 'weekly', minutes: 120 });
  });

  it('renders the all-time variant when this week is zero but all-time is positive', () => {
    // Mirrors the user-reported state in the investigation doc: 0 current-week
    // entries, ~222.8h all-time. Must NOT fall through to the empty/zero copy.
    expect(selectTimeSavedHeroState(0, 13_366, false)).toEqual({ kind: 'allTime', minutes: 13_366 });
  });

  it('renders the empty variant when both this week and all-time are zero', () => {
    expect(selectTimeSavedHeroState(0, 0, false)).toEqual({ kind: 'empty' });
  });

  it('renders the error variant on fetch failure, even when both values are zero', () => {
    expect(selectTimeSavedHeroState(0, 0, true)).toEqual({ kind: 'error' });
  });

  it('renders the error variant on fetch failure even when stale values would suggest data', () => {
    // Defensive: aggregates state may briefly hold prior values when a refetch
    // fails. Fetch failure always wins so we never present "Couldn't load" with
    // a stale numeric next to it.
    expect(selectTimeSavedHeroState(45, 100, true)).toEqual({ kind: 'error' });
  });

  it('treats non-positive minutes as no-data (defensive)', () => {
    expect(selectTimeSavedHeroState(-5, -10, false)).toEqual({ kind: 'empty' });
  });
});
