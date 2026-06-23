/**
 * Stage 2 (multi-provider foundation) — `getEnabledProviders` read helper.
 *
 * Pins the pure read semantics of the Phase-2 ordered enabled-provider list:
 *   - present + non-empty  → returns the list verbatim (order preserved)
 *   - absent / empty / undefined activeProvider → degenerate default
 *
 * IMPORTANT: this is the DATA accessor only. It is NOT wired into routing —
 * Stage 3 (flag-gated) maps the list to ProviderMode candidates. These tests
 * therefore assert the helper's output, not any routing behaviour.
 */
import { describe, it, expect } from 'vitest';
import { getEnabledProviders } from '../settingsUtils';
import type { AppSettings, ActiveProvider } from '../../types';

type ProviderSettings = Pick<AppSettings, 'enabledProviders' | 'activeProvider'>;

describe('getEnabledProviders', () => {
  describe('explicit list present and non-empty', () => {
    it('returns the list verbatim when present (order preserved)', () => {
      const settings: ProviderSettings = {
        activeProvider: 'anthropic',
        enabledProviders: ['codex', 'openrouter', 'anthropic'],
      };
      expect(getEnabledProviders(settings)).toEqual(['codex', 'openrouter', 'anthropic']);
    });

    it('returns the list verbatim even when it conflicts with activeProvider', () => {
      // The helper is a pure read of `enabledProviders`; it does NOT reconcile
      // against `activeProvider`. (The list↔activeProvider write-sync contract is
      // deferred — nothing writes the list yet.)
      const settings: ProviderSettings = {
        activeProvider: 'anthropic',
        enabledProviders: ['mindstone'],
      };
      expect(getEnabledProviders(settings)).toEqual(['mindstone']);
    });

    it('returns a single-element list as-is', () => {
      const settings: ProviderSettings = {
        activeProvider: 'codex',
        enabledProviders: ['openrouter'],
      };
      expect(getEnabledProviders(settings)).toEqual(['openrouter']);
    });
  });

  describe('degenerate default → [activeProvider]', () => {
    it('absent list + activeProvider set → [activeProvider]', () => {
      const settings: ProviderSettings = { activeProvider: 'anthropic' };
      expect(getEnabledProviders(settings)).toEqual(['anthropic']);
    });

    it('empty list + activeProvider set → [activeProvider] (empty is treated as absent)', () => {
      const settings: ProviderSettings = { activeProvider: 'openrouter', enabledProviders: [] };
      expect(getEnabledProviders(settings)).toEqual(['openrouter']);
    });

    it.each<ActiveProvider>(['anthropic', 'openrouter', 'codex', 'mindstone'])(
      'absent list degenerates to the single active provider: %s',
      (activeProvider) => {
        expect(getEnabledProviders({ activeProvider })).toEqual([activeProvider]);
      },
    );
  });

  describe('fresh-user edge (activeProvider undefined)', () => {
    it('absent list + undefined activeProvider → [] (no provider is enabled yet)', () => {
      // A fresh/onboarding user has no active provider; the type is ActiveProvider[],
      // so [] is the only type-correct + honest degenerate (NOT [undefined]).
      const settings: ProviderSettings = { activeProvider: undefined };
      expect(getEnabledProviders(settings)).toEqual([]);
    });

    it('empty list + undefined activeProvider → []', () => {
      const settings: ProviderSettings = { activeProvider: undefined, enabledProviders: [] };
      expect(getEnabledProviders(settings)).toEqual([]);
    });

    it('a non-empty list still wins even when activeProvider is undefined', () => {
      const settings: ProviderSettings = {
        activeProvider: undefined,
        enabledProviders: ['anthropic', 'codex'],
      };
      expect(getEnabledProviders(settings)).toEqual(['anthropic', 'codex']);
    });
  });

  it('is pure — does not mutate the input list', () => {
    const list: ActiveProvider[] = ['anthropic', 'codex'];
    const settings: ProviderSettings = { activeProvider: 'anthropic', enabledProviders: list };
    const result = getEnabledProviders(settings);
    expect(result).toEqual(['anthropic', 'codex']);
    // Same reference returned (no copy needed for a read helper), but unchanged.
    expect(list).toEqual(['anthropic', 'codex']);
  });
});
