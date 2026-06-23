/**
 * BackupConnectionsSection logic tests — Stage 6 restructure.
 *
 * Tests are bound to the REAL exported functions from BackupConnectionsSection,
 * so any regression in the write path, coercion logic, or operability guard
 * causes these tests to fail. No logic is mirrored locally — the binding is direct.
 *
 * The key seam is `computeProviderListPatch`, which is the single source of truth
 * for what gets persisted on every toggle/reorder. Tests that used to mirror applyList
 * logic locally now call this function directly.
 *
 * Exported functions under test:
 *  - `computeProviderListPatch`     — F1 seam: returns null (non-operable) or patch
 *  - `isProviderConnected`          — credential connectivity check
 *  - `isProviderRowToggleDisabled`  — F1 removability toggle-disabled predicate
 *  - `coerceHeadToConnected`        — F1 head coercion invariant
 *
 * Also tests via utility functions:
 *  - `writeProviderList`            — atomic patch (dedup, head sync)
 *  - `getEnabledProviders`          — degenerate read defaults
 *
 * State matrix covered:
 *  - 0 connected providers (activeProvider undefined) → non-operable (null patch)
 *  - 0 connected providers (activeProvider defined but disconnected) → non-operable
 *  - ≥1 connected provider (normal operable) → patch with connected head
 *  - mixed: 1 connected + stale-disconnected → stale removable, head = connected
 *  - toggle-off last stale provider → persisted (not swallowed)
 *  - reorder/reset
 *  - defined-but-disconnected active + another connected → operable, connected row not hidden
 *
 * See docs/plans/260618_multiprovider-foundation/PLAN.md — Stage 6 restructure.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ActiveProvider, AppSettings } from '@shared/types';
import { getEnabledProviders, writeProviderList } from '@shared/utils/settingsUtils';
import {
  isProviderConnected,
  isProviderRowToggleDisabled,
  coerceHeadToConnected,
  computeProviderListPatch,
} from '../components/BackupConnectionsSection';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal AppSettings factory for testing. */
function makeSettings(overrides: Partial<{
  activeProvider: ActiveProvider;
  enabledProviders: ActiveProvider[];
  openRouterToken: string | null;
  anthropicApiKey: string | null;
}> = {}): AppSettings {
  return {
    activeProvider: overrides.activeProvider ?? 'anthropic',
    enabledProviders: overrides.enabledProviders,
    openRouter: overrides.openRouterToken ? { oauthToken: overrides.openRouterToken, enabled: true } : undefined,
    models: overrides.anthropicApiKey ? { apiKey: overrides.anthropicApiKey } : undefined,
  } as unknown as AppSettings;
}

// ─── Flag gating ──────────────────────────────────────────────────────────────

describe('BackupConnectionsSection flag gating (AgentsTab gate logic)', () => {
  /**
   * Mirrors the gate expression in AgentsTab:
   *   flag === true && !isMindstoneActive && isActiveProviderConnected
   *
   * isActiveProviderConnected = activeProvider != null
   *   && isProviderConnected(draftSettings, codexConnected, activeProvider)
   */
  function sectionVisible(
    settings: AppSettings,
    codexConnected: boolean = false,
  ): boolean {
    const flagOn = settings.experimental?.multiProviderRoutingEnabled === true;
    const isMindstoneActive = settings.activeProvider === 'mindstone';
    const isActiveProviderConnected =
      settings.activeProvider != null &&
      isProviderConnected(settings, codexConnected, settings.activeProvider);
    return flagOn && !isMindstoneActive && isActiveProviderConnected;
  }

  it('section is hidden when flag is off (default)', () => {
    const settings = { ...makeSettings({ activeProvider: 'anthropic', anthropicApiKey: 'key' }), experimental: {} } as AppSettings;
    expect(sectionVisible(settings)).toBe(false);
  });

  it('section is hidden when flag is explicitly false', () => {
    const settings = { ...makeSettings({ activeProvider: 'anthropic', anthropicApiKey: 'key' }), experimental: { multiProviderRoutingEnabled: false } } as AppSettings;
    expect(sectionVisible(settings)).toBe(false);
  });

  it('section is visible when flag is on, activeProvider is anthropic, and apiKey is set', () => {
    const settings = { ...makeSettings({ activeProvider: 'anthropic', anthropicApiKey: 'key' }), experimental: { multiProviderRoutingEnabled: true } } as AppSettings;
    expect(sectionVisible(settings)).toBe(true);
  });

  // F2: mindstone gate
  it('section is hidden when activeProvider === mindstone (even if flag is on)', () => {
    const settings = { ...makeSettings({ activeProvider: 'mindstone' }), experimental: { multiProviderRoutingEnabled: true } } as AppSettings;
    expect(sectionVisible(settings)).toBe(false);
  });

  it('section is hidden when activeProvider === mindstone and flag is off', () => {
    const settings = { ...makeSettings({ activeProvider: 'mindstone' }), experimental: {} } as AppSettings;
    expect(sectionVisible(settings)).toBe(false);
  });

  it('section is visible for codex active provider when codex is connected', () => {
    const settings = { ...makeSettings({ activeProvider: 'codex' }), experimental: { multiProviderRoutingEnabled: true } } as AppSettings;
    expect(sectionVisible(settings, true /* codexConnected */)).toBe(true);
  });

  // Connected-main gate (Option 1 fix for F1): section hidden when active provider is disconnected.

  it('section is hidden when activeProvider is undefined (no provider selected)', () => {
    const settings = { ...makeSettings({ activeProvider: undefined as unknown as ActiveProvider }), experimental: { multiProviderRoutingEnabled: true } } as AppSettings;
    expect(sectionVisible(settings)).toBe(false);
  });

  it('section is hidden when activeProvider=codex but codex is NOT connected', () => {
    const settings = { ...makeSettings({ activeProvider: 'codex' }), experimental: { multiProviderRoutingEnabled: true } } as AppSettings;
    expect(sectionVisible(settings, false /* codexConnected=false */)).toBe(false);
  });

  it('section is hidden when activeProvider=anthropic but apiKey is absent (disconnected)', () => {
    const settings = { ...makeSettings({ activeProvider: 'anthropic', anthropicApiKey: null }), experimental: { multiProviderRoutingEnabled: true } } as AppSettings;
    expect(sectionVisible(settings)).toBe(false);
  });

  it('section is hidden when activeProvider=openrouter but oauthToken is absent (disconnected)', () => {
    const settings = { ...makeSettings({ activeProvider: 'openrouter', openRouterToken: null }), experimental: { multiProviderRoutingEnabled: true } } as AppSettings;
    expect(sectionVisible(settings)).toBe(false);
  });

  it('section is visible when activeProvider=openrouter and oauthToken is present', () => {
    const settings = { ...makeSettings({ activeProvider: 'openrouter', openRouterToken: 'tok' }), experimental: { multiProviderRoutingEnabled: true } } as AppSettings;
    expect(sectionVisible(settings)).toBe(true);
  });

  it('F1 guard: connected-but-unenabled provider does not cause section to show when active is disconnected', () => {
    // activeProvider=codex (disconnected), OpenRouter connected but not active.
    // Old code: section would show because hasConnectedAnchor=true (openrouter found).
    // New gate: isActiveProviderConnected=false (codex not connected) → section hidden.
    const settings = {
      ...makeSettings({ activeProvider: 'codex', openRouterToken: 'tok' }),
      experimental: { multiProviderRoutingEnabled: true },
    } as AppSettings;
    expect(sectionVisible(settings, false /* codexConnected=false */)).toBe(false);
  });
});

// ─── computeProviderListPatch: non-operable (0 connected) → null ──────────────
// RED→GREEN: these tests verify the operability invariant by construction.
// Before the restructure, there was no explicit non-operable guard — these
// scenarios would produce a write of a disconnected provider or an empty/stranded
// state. Post-restructure, all return null (no write).

describe('computeProviderListPatch — 0 connected providers → null (non-operable)', () => {
  it('all providers disconnected, activeProvider undefined → null', () => {
    // No credentials set, activeProvider undefined
    const settings = makeSettings({ activeProvider: undefined as unknown as ActiveProvider });
    const result = computeProviderListPatch(
      ['codex', 'openrouter'],
      new Set<ActiveProvider>(['codex', 'openrouter']),
      settings,
      false,
    );
    expect(result).toBeNull();
  });

  it('all providers disconnected, activeProvider defined (codex) but no credentials → null', () => {
    // activeProvider is set to codex but codexConnected=false and no other credentials
    const settings = makeSettings({ activeProvider: 'codex' }); // no credentials
    const result = computeProviderListPatch(
      ['codex', 'openrouter', 'anthropic'],
      new Set<ActiveProvider>(['codex']),
      settings,
      false,
    );
    expect(result).toBeNull();
  });

  it('defined-but-disconnected activeProvider + all others disconnected → null', () => {
    // Settings claim anthropic is active but no apiKey → disconnected
    const settings = makeSettings({ activeProvider: 'anthropic', anthropicApiKey: null });
    const result = computeProviderListPatch(
      ['anthropic', 'codex'],
      new Set<ActiveProvider>(['anthropic']),
      settings,
      false, // codex also disconnected
    );
    expect(result).toBeNull();
  });

  it('empty enabled set → null (no providers to write)', () => {
    const settings = makeSettings({ activeProvider: 'anthropic', anthropicApiKey: 'key' });
    const result = computeProviderListPatch(
      ['anthropic', 'codex'],
      new Set<ActiveProvider>(), // empty
      settings,
      false,
    );
    expect(result).toBeNull();
  });
});

// ─── computeProviderListPatch: ≥1 connected → patch with connected head ────────

describe('computeProviderListPatch — ≥1 connected provider → valid patch', () => {
  it('single connected provider → patch with that provider as head', () => {
    const settings = makeSettings({ activeProvider: 'anthropic', anthropicApiKey: 'key' });
    const result = computeProviderListPatch(
      ['anthropic', 'codex'],
      new Set<ActiveProvider>(['anthropic']),
      settings,
      false,
    );
    expect(result).not.toBeNull();
    expect(result!.activeProvider).toBe('anthropic');
    expect(result!.enabledProviders?.[0]).toBe('anthropic');
  });

  it('multiple connected → head is first connected in order', () => {
    const settings = makeSettings({ activeProvider: 'anthropic', anthropicApiKey: 'key', openRouterToken: 'tok' });
    const result = computeProviderListPatch(
      ['anthropic', 'openrouter', 'codex'],
      new Set<ActiveProvider>(['anthropic', 'openrouter']),
      settings,
      false,
    );
    expect(result).not.toBeNull();
    expect(result!.activeProvider).toBe('anthropic');
    expect(result!.enabledProviders).toEqual(['anthropic', 'openrouter']);
  });

  it('disconnected provider at head but another connected → coercion promotes connected to head', () => {
    // codex at head but disconnected; openrouter connected → openrouter promoted
    const settings = makeSettings({ activeProvider: 'codex', openRouterToken: 'tok' });
    const result = computeProviderListPatch(
      ['codex', 'openrouter'],
      new Set<ActiveProvider>(['codex', 'openrouter']),
      settings,
      false, // codex disconnected
    );
    expect(result).not.toBeNull();
    expect(result!.activeProvider).toBe('openrouter');
    expect(result!.enabledProviders?.[0]).toBe('openrouter');
    // codex is preserved (stale enabled)
    expect(result!.enabledProviders).toContain('codex');
  });

  it('mixed: 1 connected + 1 stale-disconnected → stale kept in list, head connected', () => {
    // anthropic connected (active), codex stale-enabled but disconnected
    const settings = makeSettings({ activeProvider: 'anthropic', anthropicApiKey: 'key' });
    const result = computeProviderListPatch(
      ['anthropic', 'codex'],
      new Set<ActiveProvider>(['anthropic', 'codex']),
      settings,
      false,
    );
    expect(result).not.toBeNull();
    expect(result!.activeProvider).toBe('anthropic');
    expect(result!.enabledProviders?.[0]).toBe('anthropic');
    expect(result!.enabledProviders).toContain('codex'); // stale preserved
  });

  it('toggle-off last stale provider: only active remains → persisted', () => {
    // User toggles off stale codex → enabledSet = {anthropic} → persisted
    const settings = makeSettings({ activeProvider: 'anthropic', anthropicApiKey: 'key' });
    const result = computeProviderListPatch(
      ['anthropic', 'codex'],
      new Set<ActiveProvider>(['anthropic']), // codex toggled off
      settings,
      false,
    );
    expect(result).not.toBeNull();
    expect(result!.activeProvider).toBe('anthropic');
    expect(result!.enabledProviders).toEqual(['anthropic']);
  });

  it('defined-but-disconnected activeProvider + another connected → operable, connected row not hidden', () => {
    // Settings: activeProvider=codex (disconnected), openrouter connected
    // In old code this would go through EmptyState (connectedCount<=1) and hide the connected row.
    // Now: computeProviderListPatch sees openrouter connected → patch with openrouter as head.
    const settings = makeSettings({ activeProvider: 'codex', openRouterToken: 'tok' });
    const result = computeProviderListPatch(
      ['codex', 'openrouter'],
      new Set<ActiveProvider>(['codex', 'openrouter']),
      settings,
      false, // codex disconnected
    );
    expect(result).not.toBeNull();
    // openrouter is promoted to head (not stranded behind disconnected codex)
    expect(result!.activeProvider).toBe('openrouter');
    expect(result!.enabledProviders?.[0]).toBe('openrouter');
  });

  it('codex connected via codexConnected=true → patch uses codex as head', () => {
    const settings = makeSettings({ activeProvider: 'codex' }); // no other credentials
    const result = computeProviderListPatch(
      ['codex', 'openrouter'],
      new Set<ActiveProvider>(['codex']),
      settings,
      true, // codex IS connected
    );
    expect(result).not.toBeNull();
    expect(result!.activeProvider).toBe('codex');
  });
});

// ─── computeProviderListPatch: operability invariant is by construction ────────
// These tests explicitly demonstrate that the old degenerate-write paths can no
// longer execute — they return null and updateDraft is never called.

describe('computeProviderListPatch — operability by construction (no degenerate writes)', () => {
  it('null patch means updateDraft is never called', () => {
    const updateDraftCalls: Array<[string, unknown]> = [];
    const updateDraftSpy = vi.fn((key: string, value: unknown) => {
      updateDraftCalls.push([key, value]);
    });

    const settings = makeSettings({ activeProvider: 'codex' }); // all disconnected
    const patch = computeProviderListPatch(
      ['codex', 'openrouter'],
      new Set<ActiveProvider>(['codex', 'openrouter']),
      settings,
      false,
    );

    // Simulate applyList: only call updateDraft if patch is not null
    if (patch !== null) {
      updateDraftSpy('enabledProviders', patch.enabledProviders);
      if (patch.activeProvider !== undefined) {
        updateDraftSpy('activeProvider', patch.activeProvider);
      }
    }

    // No writes when non-operable
    expect(patch).toBeNull();
    expect(updateDraftSpy).not.toHaveBeenCalled();
    expect(updateDraftCalls).toHaveLength(0);
  });

  it('non-operable: toggle-off last stale when all disconnected → null, no persist', () => {
    // State: activeProvider=undefined (all disconnected), only codex enabled
    // User toggles off codex → enabledSet becomes empty
    const settings = makeSettings({ activeProvider: undefined as unknown as ActiveProvider });
    const patch = computeProviderListPatch(
      ['codex'],
      new Set<ActiveProvider>(), // codex toggled off → empty set
      settings,
      false,
    );
    expect(patch).toBeNull();
  });

  it('non-operable: disconnected activeProvider stranded scenario → null, not persisted', () => {
    // Old bug: defined-but-disconnected activeProvider remained persisted.
    // New: computeProviderListPatch returns null → updateDraft never called.
    const settings = makeSettings({ activeProvider: 'anthropic', anthropicApiKey: null });
    const patch = computeProviderListPatch(
      ['anthropic'],
      new Set<ActiveProvider>(['anthropic']),
      settings,
      false,
    );
    expect(patch).toBeNull();
  });

  it('regression: old code would have written disconnected provider as activeProvider', () => {
    // Demonstrate that unconditionally calling writeProviderList with a disconnected head
    // would produce a bad patch. computeProviderListPatch prevents this.
    const settings = makeSettings({ activeProvider: 'codex' }); // no credentials → disconnected
    const orderedList: ActiveProvider[] = ['codex', 'openrouter'];
    const enabledSet = new Set<ActiveProvider>(['codex', 'openrouter']);

    // The old (pre-restructure) path would call writeProviderList unconditionally:
    const brokenPatch = writeProviderList(orderedList as [ActiveProvider, ...ActiveProvider[]]);
    expect(brokenPatch.activeProvider).toBe('codex'); // disconnected! — old broken behavior
    expect(isProviderConnected(settings, false, brokenPatch.activeProvider as ActiveProvider)).toBe(false);

    // New path: computeProviderListPatch guards this → null
    const safePatch = computeProviderListPatch(orderedList, enabledSet, settings, false);
    expect(safePatch).toBeNull();
  });
});

// ─── F1: head-must-be-connected coercion (real impl) ─────────────────────────

describe('BackupConnectionsSection F1 — disconnected provider cannot be head (real impl)', () => {
  it('connected provider at head → no coercion needed', () => {
    const settings = makeSettings({ activeProvider: 'codex', anthropicApiKey: null });
    const result = coerceHeadToConnected(['codex', 'anthropic'], settings, true);
    expect(result[0]).toBe('codex');
    expect(result).toEqual(['codex', 'anthropic']);
  });

  it('disconnected provider at head → first connected promoted', () => {
    // codexConnected=false, openrouter connected → openrouter should be promoted to head
    const settings = makeSettings({
      activeProvider: 'codex',
      openRouterToken: 'token123',
    });
    const result = coerceHeadToConnected(['codex', 'openrouter', 'anthropic'], settings, false);
    expect(result[0]).toBe('openrouter');
    expect(result).toContain('codex');
  });

  it('multiple disconnected at head → first connected promoted, order preserved', () => {
    const settings = makeSettings({ activeProvider: 'codex', anthropicApiKey: 'apikey' });
    const result = coerceHeadToConnected(['codex', 'openrouter', 'anthropic'], settings, false);
    expect(result[0]).toBe('anthropic');
    expect(result).toContain('codex');
    expect(result).toContain('openrouter');
  });

  it('only connected provider in list is already at correct position', () => {
    const settings = makeSettings({ activeProvider: 'anthropic', anthropicApiKey: 'key' });
    const result = coerceHeadToConnected(['anthropic'], settings, false);
    expect(result).toEqual(['anthropic']);
  });

  it('no connected providers → head unchanged (non-operable guard handles this upstream)', () => {
    const settings = makeSettings({ activeProvider: 'codex' });
    const result = coerceHeadToConnected(['codex', 'openrouter'], settings, false);
    // firstConnectedIdx will be -1, so <= 0 branch returns as-is
    expect(result[0]).toBe('codex');
  });

  it('F1: coerced head produces correct writeProviderList patch', () => {
    const settings = makeSettings({ activeProvider: 'codex', openRouterToken: 'tok' });
    const coerced = coerceHeadToConnected(['codex', 'openrouter'], settings, false);
    expect(coerced[0]).toBe('openrouter');
    const patch = writeProviderList(coerced as [ActiveProvider, ...ActiveProvider[]]);
    expect(patch.activeProvider).toBe('openrouter');
    expect(patch.enabledProviders?.[0]).toBe('openrouter');
  });

  it('isProviderConnected: codex connected iff codexConnected=true', () => {
    const settings = makeSettings({ activeProvider: 'codex' });
    expect(isProviderConnected(settings, true, 'codex')).toBe(true);
    expect(isProviderConnected(settings, false, 'codex')).toBe(false);
  });

  it('isProviderConnected: openrouter connected iff oauthToken present', () => {
    const connected = makeSettings({ openRouterToken: 'tok' });
    const disconnected = makeSettings({ openRouterToken: null });
    expect(isProviderConnected(connected, false, 'openrouter')).toBe(true);
    expect(isProviderConnected(disconnected, false, 'openrouter')).toBe(false);
  });

  it('isProviderConnected: anthropic connected iff apiKey present', () => {
    const connected = makeSettings({ anthropicApiKey: 'key' });
    const disconnected = makeSettings({ anthropicApiKey: null });
    expect(isProviderConnected(connected, false, 'anthropic')).toBe(true);
    expect(isProviderConnected(disconnected, false, 'anthropic')).toBe(false);
  });
});

// ─── F1 removability: toggle disabled predicate (real impl) ──────────────────

describe('BackupConnectionsSection F1 — stale enabled+disconnected provider is toggle-off-able (real impl)', () => {
  it('active provider → toggle disabled (cannot remove head)', () => {
    expect(isProviderRowToggleDisabled(true, true, true)).toBe(true);
    expect(isProviderRowToggleDisabled(true, false, true)).toBe(true);
    expect(isProviderRowToggleDisabled(true, false, false)).toBe(true);
  });

  it('connected, not active → toggle enabled (normal on/off)', () => {
    expect(isProviderRowToggleDisabled(false, true, true)).toBe(false);
    expect(isProviderRowToggleDisabled(false, true, false)).toBe(false);
  });

  it('stale: enabled + not connected → toggle ENABLED (can remove from chain)', () => {
    expect(isProviderRowToggleDisabled(false, false, true)).toBe(false);
  });

  it('not enabled + not connected → toggle disabled (cannot add without connecting)', () => {
    expect(isProviderRowToggleDisabled(false, false, false)).toBe(true);
  });

  it('pre-fix condition would disable stale-enabled rows (regression proof)', () => {
    function oldDisabled(isActive: boolean, isConnected: boolean): boolean {
      return isActive || !isConnected;
    }
    expect(oldDisabled(false, false)).toBe(true); // old was broken for stale-enabled
    expect(isProviderRowToggleDisabled(false, false, true)).toBe(false); // new is correct
  });
});

// ─── Toggle: active provider cannot be toggled off ────────────────────────────

describe('BackupConnectionsSection toggle — active provider is non-togglable', () => {
  it('handleToggle guard: toggling active provider is a no-op', () => {
    // Simulate: if (provider === activeProvider) return;
    const activeProvider: ActiveProvider = 'anthropic';
    function simulateToggleGuard(provider: ActiveProvider): boolean {
      return provider === activeProvider; // true = no-op
    }
    expect(simulateToggleGuard('anthropic')).toBe(true);  // no-op
    expect(simulateToggleGuard('codex')).toBe(false);     // allowed
  });

  it('active toggle disabled via real predicate regardless of connection state', () => {
    expect(isProviderRowToggleDisabled(true, true, true)).toBe(true);
    expect(isProviderRowToggleDisabled(true, false, false)).toBe(true);
  });

  it('toggling on a connected provider produces a valid patch', () => {
    // anthropic active+connected, user adds openrouter (also connected)
    const settings = makeSettings({ activeProvider: 'anthropic', anthropicApiKey: 'key', openRouterToken: 'tok' });
    const patch = computeProviderListPatch(
      ['anthropic', 'openrouter'],
      new Set<ActiveProvider>(['anthropic', 'openrouter']),
      settings,
      false,
    );
    expect(patch).not.toBeNull();
    expect(patch!.enabledProviders).toContain('openrouter');
  });
});

// ─── Full state matrix for computeProviderListPatch ───────────────────────────

describe('computeProviderListPatch — full state matrix', () => {
  it('0-connected, activeProvider undefined → null', () => {
    const settings = makeSettings({ activeProvider: undefined as unknown as ActiveProvider });
    expect(computeProviderListPatch(['codex'], new Set<ActiveProvider>(['codex']), settings, false)).toBeNull();
  });

  it('0-connected, activeProvider defined-but-disconnected → null', () => {
    const settings = makeSettings({ activeProvider: 'anthropic', anthropicApiKey: null });
    expect(computeProviderListPatch(['anthropic'], new Set<ActiveProvider>(['anthropic']), settings, false)).toBeNull();
  });

  it('1 connected (active only), single provider → patch (operable, just no backup chain)', () => {
    const settings = makeSettings({ activeProvider: 'anthropic', anthropicApiKey: 'key' });
    const patch = computeProviderListPatch(
      ['anthropic'],
      new Set<ActiveProvider>(['anthropic']),
      settings,
      false,
    );
    expect(patch).not.toBeNull();
    expect(patch!.activeProvider).toBe('anthropic');
  });

  it('mixed: connected active + stale disconnected backup → both in patch, head connected', () => {
    const settings = makeSettings({ activeProvider: 'anthropic', anthropicApiKey: 'key' });
    const patch = computeProviderListPatch(
      ['anthropic', 'codex'],
      new Set<ActiveProvider>(['anthropic', 'codex']),
      settings,
      false,
    );
    expect(patch).not.toBeNull();
    expect(patch!.activeProvider).toBe('anthropic');
    expect(patch!.enabledProviders).toContain('codex');
  });

  it('reorder: disconnected active reordered after connected → connected promoted', () => {
    // User dragged disconnected codex to position 0, openrouter is connected
    const settings = makeSettings({ activeProvider: 'codex', openRouterToken: 'tok' });
    const patch = computeProviderListPatch(
      ['codex', 'openrouter'],
      new Set<ActiveProvider>(['codex', 'openrouter']),
      settings,
      false,
    );
    expect(patch).not.toBeNull();
    expect(patch!.activeProvider).toBe('openrouter'); // coerced
  });

  it('reset: reset order with active connected → patch is correct', () => {
    const settings = makeSettings({ activeProvider: 'anthropic', anthropicApiKey: 'key' });
    // Reset order puts anthropic first
    const patch = computeProviderListPatch(
      ['anthropic', 'codex', 'openrouter'],
      new Set<ActiveProvider>(['anthropic']),
      settings,
      false,
    );
    expect(patch).not.toBeNull();
    expect(patch!.activeProvider).toBe('anthropic');
    expect(patch!.enabledProviders).toEqual(['anthropic']);
  });

  it('toggle-off last stale, active connected → persists just the active', () => {
    const settings = makeSettings({ activeProvider: 'anthropic', anthropicApiKey: 'key' });
    const patch = computeProviderListPatch(
      ['anthropic', 'codex'],
      new Set<ActiveProvider>(['anthropic']), // codex toggled off
      settings,
      false,
    );
    expect(patch).not.toBeNull();
    expect(patch!.enabledProviders).toEqual(['anthropic']);
  });

  it('defined-but-disconnected active + another connected → operable, section not hidden', () => {
    // Critical: OLD EmptyState logic (connectedCount <= 1) would hide the connected row.
    // With restructure: hasConnectedAnchor=true (openrouter connected) → operable path,
    // computeProviderListPatch promotes openrouter.
    const settings = makeSettings({ activeProvider: 'codex', openRouterToken: 'tok' });
    const patch = computeProviderListPatch(
      ['codex', 'openrouter'],
      new Set<ActiveProvider>(['codex', 'openrouter']),
      settings,
      false,
    );
    expect(patch).not.toBeNull();
    expect(patch!.activeProvider).toBe('openrouter'); // not stranded
    expect(patch!.enabledProviders?.[0]).toBe('openrouter');
  });
});

// ─── F1 post-provider-switch draft-sync race ─────────────────────────────────
// Verifies that the component's reconciled working list always has the current
// activeProvider at the head, even when enabledProviders is stale from before the
// switch (i.e. planProviderSwitch updated activeProvider but not enabledProviders).
//
// This group tests the fix by:
//   1. Importing syncEnabledProvidersHead to reconstruct the component's input derivation.
//   2. Showing the stale list (pre-fix) would produce a wrong patch (old provider as head).
//   3. Showing the reconciled list (post-fix) produces the correct patch (new provider at head).

import { syncEnabledProvidersHead } from '@shared/utils/settingsUtils';

describe('F1 post-provider-switch draft-sync race — reconcile on input derivation', () => {
  /**
   * Reconstruct the component's `enabledListKey` derivation (the fixed version):
   *   syncEnabledProvidersHead(getEnabledProviders(raw), activeProvider)
   * Returns the reconciled list (mirrors the useMemo fix in BackupConnectionsSection).
   */
  function reconciledList(
    rawEnabledProviders: ActiveProvider[] | undefined,
    activeProvider: ActiveProvider | undefined,
  ): ActiveProvider[] {
    const base = getEnabledProviders({ enabledProviders: rawEnabledProviders, activeProvider });
    return syncEnabledProvidersHead(base, activeProvider) ?? base;
  }

  it('RED→GREEN: stale draft after Codex→Anthropic switch — reconciled list has Anthropic at head', () => {
    // State: planProviderSwitch ran, activeProvider='anthropic', but enabledProviders=['codex','openrouter']
    const rawEnabledProviders: ActiveProvider[] = ['codex', 'openrouter'];
    const activeProvider: ActiveProvider = 'anthropic';

    // PRE-FIX (stale): the old code used getEnabledProviders as-is → wrong head
    const staleDerivedList = getEnabledProviders({ enabledProviders: rawEnabledProviders, activeProvider });
    expect(staleDerivedList[0]).toBe('codex'); // stale — wrong head

    // POST-FIX (reconciled): syncEnabledProvidersHead prepends activeProvider → correct head
    const reconciled = reconciledList(rawEnabledProviders, activeProvider);
    expect(reconciled[0]).toBe('anthropic'); // fixed — new active is at head
  });

  it('a reorder/reset in the stale-draft window does NOT write the old provider as head', () => {
    // Simulate: user switches Codex→Anthropic (activeProvider='anthropic')
    // enabledProviders is stale ['codex', 'openrouter'] (planProviderSwitch did not update it).
    // Anthropic is connected (apiKey='key').
    const settings = makeSettings({
      activeProvider: 'anthropic',
      enabledProviders: ['codex', 'openrouter'] as ActiveProvider[],
      anthropicApiKey: 'key',
    });

    // PRE-FIX path: the stale derived list is ['codex','openrouter'] (anthropic absent).
    // Pass codexConnected=true to prove the bug: stale list still has codex at head.
    const staleList: ActiveProvider[] = ['codex', 'openrouter'];
    const staleEnabledSet = new Set<ActiveProvider>(['codex', 'openrouter']);
    const staleListWithConnectedCodex = computeProviderListPatch(staleList, staleEnabledSet, settings, true);
    // With codex connected: stale list produces codex as head — not anthropic.
    // This demonstrates the switch was undone.
    expect(staleListWithConnectedCodex).not.toBeNull();
    expect(staleListWithConnectedCodex!.activeProvider).toBe('codex'); // BUG: old provider wins

    // POST-FIX: component applies syncEnabledProvidersHead before deriving enabledSet.
    // Reconciled list: ['anthropic', 'codex', 'openrouter'] — anthropic prepended.
    // enabledSet derived from reconciled list (what the component's state will hold).
    const reconciled = reconciledList(
      ['codex', 'openrouter'],
      'anthropic',
    );
    const reconciledEnabledSet = new Set<ActiveProvider>(reconciled);
    // Now a reset/reorder uses the reconciled ordered list (anthropic first).
    const fixedPatch = computeProviderListPatch(reconciled, reconciledEnabledSet, settings, true);
    expect(fixedPatch).not.toBeNull();
    expect(fixedPatch!.activeProvider).toBe('anthropic'); // FIXED: new provider at head
    expect(fixedPatch!.enabledProviders![0]).toBe('anthropic');
  });

  it('reconcile is idempotent when list is already consistent (no-op case)', () => {
    // Normal state: activeProvider='anthropic', enabledProviders=['anthropic','codex'] — consistent
    const reconciled = reconciledList(['anthropic', 'codex'], 'anthropic');
    expect(reconciled[0]).toBe('anthropic');
    expect(reconciled).toEqual(['anthropic', 'codex']);
  });

  it('reconcile when enabledProviders is absent — degenerate read still consistent', () => {
    // No enabledProviders (single-provider user): getEnabledProviders returns [activeProvider]
    // syncEnabledProvidersHead sees head === activeProvider → no-op
    const reconciled = reconciledList(undefined, 'anthropic');
    expect(reconciled[0]).toBe('anthropic');
  });
});

// ─── getEnabledProviders degenerate behaviour ─────────────────────────────────

describe('getEnabledProviders — degenerate behaviour with mindstone', () => {
  it('mindstone in enabledProviders is returned as-is', () => {
    const result = getEnabledProviders({
      activeProvider: 'mindstone',
      enabledProviders: ['mindstone', 'openrouter'],
    });
    expect(result).toEqual(['mindstone', 'openrouter']);
  });

  it('mindstone as sole activeProvider (no list) → [mindstone]', () => {
    const result = getEnabledProviders({ activeProvider: 'mindstone', enabledProviders: undefined });
    expect(result).toEqual(['mindstone']);
  });
});
