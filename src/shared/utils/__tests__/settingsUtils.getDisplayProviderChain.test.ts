/**
 * Stage 7 (multi-provider foundation) — `getDisplayProviderChain` accessor.
 *
 * This accessor is for the settings UI's "main + backups" editor view: it returns
 * the provider list with `activeProvider` coerced to the head. It is explicitly NOT
 * for the router (`getEnabledProviders` serves that — raw list-priority).
 *
 * ## Dual semantic
 *   - Router (`getEnabledProviders`): raw list, `activeProvider` independent.
 *   - Editor (`getDisplayProviderChain`): `activeProvider` always at head.
 *
 * These tests verify that the accessor correctly reconciles the list and that
 * `getEnabledProviders`'s contract is NOT changed (it still returns the raw list).
 *
 * See docs/plans/260618_multiprovider-foundation/PLAN.md — Stage 7.
 */
import { describe, it, expect } from 'vitest';
import { getDisplayProviderChain, getEnabledProviders } from '../settingsUtils';
import type { AppSettings, ActiveProvider } from '../../types';

type ProviderSettings = Pick<AppSettings, 'enabledProviders' | 'activeProvider'>;

describe('getDisplayProviderChain', () => {
  describe('active provider already at head — unchanged', () => {
    it('returns the list unchanged when activeProvider is already the head', () => {
      const settings: ProviderSettings = {
        activeProvider: 'anthropic',
        enabledProviders: ['anthropic', 'openrouter', 'codex'],
      };
      expect(getDisplayProviderChain(settings)).toEqual(['anthropic', 'openrouter', 'codex']);
    });

    it('single-element list where active === head is unchanged', () => {
      const settings: ProviderSettings = {
        activeProvider: 'openrouter',
        enabledProviders: ['openrouter'],
      };
      expect(getDisplayProviderChain(settings)).toEqual(['openrouter']);
    });
  });

  describe('active provider in list but NOT at head — reordered to head', () => {
    it('promotes activeProvider to head when it is in the list', () => {
      // Dual-semantic critical case: raw list head = 'openrouter', active = 'anthropic'
      // Router (getEnabledProviders) picks 'openrouter' first (raw priority).
      // Editor (getDisplayProviderChain) shows 'anthropic' first (active-at-head).
      const settings: ProviderSettings = {
        activeProvider: 'anthropic',
        enabledProviders: ['openrouter', 'anthropic'],
      };
      expect(getDisplayProviderChain(settings)).toEqual(['anthropic', 'openrouter']);
    });

    it('promotes activeProvider to head preserving the rest of the order', () => {
      const settings: ProviderSettings = {
        activeProvider: 'codex',
        enabledProviders: ['anthropic', 'openrouter', 'codex'],
      };
      expect(getDisplayProviderChain(settings)).toEqual(['codex', 'anthropic', 'openrouter']);
    });
  });

  describe('active provider NOT in list — prepended', () => {
    it('prepends activeProvider when it is not in the list', () => {
      // This is the post-planProviderSwitch stale-draft case:
      // user switched to 'anthropic' but list still reflects the old order.
      const settings: ProviderSettings = {
        activeProvider: 'anthropic',
        enabledProviders: ['codex', 'openrouter'],
      };
      expect(getDisplayProviderChain(settings)).toEqual(['anthropic', 'codex', 'openrouter']);
    });
  });

  describe('degenerate / no-list cases', () => {
    it('unset list + defined activeProvider → [activeProvider] (degenerate default)', () => {
      const settings: ProviderSettings = { activeProvider: 'openrouter' };
      expect(getDisplayProviderChain(settings)).toEqual(['openrouter']);
    });

    it('empty list + defined activeProvider → [activeProvider]', () => {
      const settings: ProviderSettings = { activeProvider: 'codex', enabledProviders: [] };
      expect(getDisplayProviderChain(settings)).toEqual(['codex']);
    });

    it('undefined activeProvider + no list → [] (no provider yet; fresh user)', () => {
      const settings: ProviderSettings = { activeProvider: undefined };
      expect(getDisplayProviderChain(settings)).toEqual([]);
    });

    it('undefined activeProvider + non-empty list → list unchanged (list is source of truth)', () => {
      // When activeProvider is undefined but a list exists, no reconcile is possible;
      // the list is returned as-is (same as syncEnabledProvidersHead no-op path).
      const settings: ProviderSettings = {
        activeProvider: undefined,
        enabledProviders: ['anthropic', 'codex'],
      };
      expect(getDisplayProviderChain(settings)).toEqual(['anthropic', 'codex']);
    });
  });

  describe('post-planProviderSwitch stale-draft case (the motivating scenario)', () => {
    it('correctly places the new activeProvider at head when the draft list is stale', () => {
      // planProviderSwitch() sets activeProvider='anthropic' but does not touch
      // enabledProviders. The component reads the draft before normalizeSettings runs.
      // getDisplayProviderChain reconciles: active='anthropic' goes to head.
      const staleDraft: ProviderSettings = {
        activeProvider: 'anthropic',
        enabledProviders: ['codex', 'openrouter'],
      };
      expect(getDisplayProviderChain(staleDraft)).toEqual(['anthropic', 'codex', 'openrouter']);
    });
  });

  describe('purity', () => {
    it('does not mutate the input list', () => {
      const list: ActiveProvider[] = ['openrouter', 'anthropic'];
      const settings: ProviderSettings = { activeProvider: 'anthropic', enabledProviders: list };
      const result = getDisplayProviderChain(settings);
      expect(result).toEqual(['anthropic', 'openrouter']);
      // Original list is unchanged
      expect(list).toEqual(['openrouter', 'anthropic']);
    });
  });
});

// ─── Dual-semantic contract: getEnabledProviders UNCHANGED ──────────────────
//
// These tests document that `getEnabledProviders` still returns the RAW list
// (router semantics) and is NOT affected by Stage 7. The router's contract
// must be preserved; these are regression guards, not new behaviour.

describe('getEnabledProviders contract preserved after Stage 7 (router semantics)', () => {
  it('returns list verbatim — head is NOT coerced to activeProvider (router uses raw order)', () => {
    const settings: ProviderSettings = {
      activeProvider: 'anthropic',
      enabledProviders: ['openrouter', 'anthropic'],
    };
    // Router picks 'openrouter' (raw list head), not 'anthropic' (activeProvider).
    expect(getEnabledProviders(settings)).toEqual(['openrouter', 'anthropic']);
  });

  it('confirms the dual-semantic: same settings → different results for router vs editor', () => {
    // This is the scenario that motivated Stage 7:
    // router needs raw list order for failover priority;
    // editor needs activeProvider at head for the "main + backups" view.
    const settings: ProviderSettings = {
      activeProvider: 'anthropic',
      enabledProviders: ['openrouter', 'anthropic'],
    };
    const routerView = getEnabledProviders(settings);
    const editorView = getDisplayProviderChain(settings);

    expect(routerView[0]).toBe('openrouter');  // router: list head wins
    expect(editorView[0]).toBe('anthropic');   // editor: activeProvider wins
    expect(routerView).not.toEqual(editorView);
  });
});
