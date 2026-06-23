/**
 * Stage 6a (multi-provider foundation) — write contract + head-sync invariant.
 *
 * Covers:
 *  - `syncEnabledProvidersHead` directly (pure function, all cases)
 *  - `writeProviderList` writer (both fields set atomically)
 *  - `normalizeSettings` head-sync integration (via the real function)
 *
 * Behaviour-preservation check: every user today has `enabledProviders` UNSET.
 * All tests involving an absent list must confirm `normalizeSettings` output is
 * byte-identical on the `enabledProviders` key (i.e. still absent) — so no
 * existing user gets an unexpected settings write.
 *
 * See docs/plans/260618_multiprovider-foundation/PLAN.md — Stage 6a.
 */
import { describe, it, expect } from 'vitest';
import {
  syncEnabledProvidersHead,
  writeProviderList,
  normalizeSettings,
} from '../settingsUtils';
import type { AppSettings, ActiveProvider } from '../../types';

// ---------------------------------------------------------------------------
// Minimal settings factory for normalizeSettings tests
// ---------------------------------------------------------------------------
function makeSettings(overrides: {
  activeProvider?: ActiveProvider;
  enabledProviders?: ActiveProvider[];
} = {}): AppSettings {
  return {
    activeProvider: overrides.activeProvider,
    enabledProviders: overrides.enabledProviders,
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'gpt-4o-mini-transcribe-2025-12-15',
      ttsVoice: 'nova',
      activationHotkey: 'CommandOrControl+Shift+Space',
      activationHotkeyVoiceMode: true,
    },
    // Minimal required fields
  } as unknown as AppSettings;
}

// ---------------------------------------------------------------------------
// syncEnabledProvidersHead — pure function tests
// ---------------------------------------------------------------------------
describe('syncEnabledProvidersHead', () => {
  describe('zero-write migration — no list present', () => {
    it('undefined list + undefined activeProvider → undefined (no-op)', () => {
      expect(syncEnabledProvidersHead(undefined, undefined)).toBeUndefined();
    });

    it('undefined list + defined activeProvider → undefined (no-op)', () => {
      expect(syncEnabledProvidersHead(undefined, 'anthropic')).toBeUndefined();
    });

    it('empty list + defined activeProvider → empty array (no-op, preserves emptiness)', () => {
      // An explicitly empty array is treated as "no list" — returned as-is.
      expect(syncEnabledProvidersHead([], 'anthropic')).toEqual([]);
    });

    it('empty list + undefined activeProvider → empty array (no-op)', () => {
      expect(syncEnabledProvidersHead([], undefined)).toEqual([]);
    });
  });

  describe('fresh user (activeProvider undefined) with a list', () => {
    it('list present + undefined activeProvider → list unchanged', () => {
      // Don't fabricate a list or reorder when we don't have a known active provider.
      const list: ActiveProvider[] = ['anthropic', 'codex'];
      expect(syncEnabledProvidersHead(list, undefined)).toEqual(['anthropic', 'codex']);
    });
  });

  describe('already consistent — head matches activeProvider', () => {
    it('activeProvider is already the head → returns same list (no reorder)', () => {
      const list: ActiveProvider[] = ['codex', 'openrouter', 'anthropic'];
      const result = syncEnabledProvidersHead(list, 'codex');
      expect(result).toBe(list); // Same reference — no copy made when already consistent
    });

    it('single-element list whose element is activeProvider → same list', () => {
      const list: ActiveProvider[] = ['anthropic'];
      const result = syncEnabledProvidersHead(list, 'anthropic');
      expect(result).toBe(list);
    });
  });

  describe('reorder — activeProvider is in the list but not at head', () => {
    it('activeProvider ∈ list (not head) → reorders to put activeProvider first', () => {
      // e.g. user had ['codex', 'openrouter', 'anthropic'] + legacy switch set activeProvider='anthropic'
      const result = syncEnabledProvidersHead(
        ['codex', 'openrouter', 'anthropic'],
        'anthropic',
      );
      expect(result).toEqual(['anthropic', 'codex', 'openrouter']);
    });

    it('activeProvider is the last element → moved to head, rest order preserved', () => {
      const result = syncEnabledProvidersHead(
        ['openrouter', 'codex', 'mindstone'],
        'mindstone',
      );
      expect(result).toEqual(['mindstone', 'openrouter', 'codex']);
    });

    it('two-element list, activeProvider is second → swapped', () => {
      const result = syncEnabledProvidersHead(['codex', 'openrouter'], 'openrouter');
      expect(result).toEqual(['openrouter', 'codex']);
    });
  });

  describe('prepend — activeProvider NOT in list at all', () => {
    it('activeProvider ∉ list → prepended, existing order preserved', () => {
      // Legacy providerSwitch set activeProvider to a value not in the list.
      const result = syncEnabledProvidersHead(
        ['codex', 'openrouter'],
        'anthropic',
      );
      expect(result).toEqual(['anthropic', 'codex', 'openrouter']);
    });

    it('single-element list, different activeProvider → prepend creates [active, original]', () => {
      const result = syncEnabledProvidersHead(['openrouter'], 'codex');
      expect(result).toEqual(['codex', 'openrouter']);
    });
  });

  describe('idempotency — running twice = running once', () => {
    it('reorder case is idempotent', () => {
      const first = syncEnabledProvidersHead(['codex', 'openrouter', 'anthropic'], 'anthropic');
      const second = syncEnabledProvidersHead(first!, 'anthropic');
      expect(second).toEqual(first);
      // Second call hits the "already consistent" early-return path.
      expect(second).toBe(first);
    });

    it('prepend case is idempotent', () => {
      const first = syncEnabledProvidersHead(['codex', 'openrouter'], 'anthropic');
      const second = syncEnabledProvidersHead(first!, 'anthropic');
      expect(second).toEqual(first);
      expect(second).toBe(first);
    });

    it('no-op (undefined list) is idempotent', () => {
      const first = syncEnabledProvidersHead(undefined, 'anthropic');
      const second = syncEnabledProvidersHead(first, 'anthropic');
      expect(first).toBeUndefined();
      expect(second).toBeUndefined();
    });
  });

  describe('does not mutate the input list', () => {
    it('reorder case: original array is unchanged', () => {
      const original: ActiveProvider[] = ['codex', 'openrouter', 'anthropic'];
      const copy = [...original];
      syncEnabledProvidersHead(original, 'anthropic');
      expect(original).toEqual(copy);
    });

    it('prepend case: original array is unchanged', () => {
      const original: ActiveProvider[] = ['codex', 'openrouter'];
      const copy = [...original];
      syncEnabledProvidersHead(original, 'anthropic');
      expect(original).toEqual(copy);
    });
  });
});

// ---------------------------------------------------------------------------
// writeProviderList — writer tests
// ---------------------------------------------------------------------------
describe('writeProviderList', () => {
  it('sets both enabledProviders and activeProvider from the head', () => {
    const patch = writeProviderList(['openrouter', 'codex', 'anthropic']);
    expect(patch.enabledProviders).toEqual(['openrouter', 'codex', 'anthropic']);
    expect(patch.activeProvider).toBe('openrouter');
  });

  it('single-provider list: activeProvider = the single element', () => {
    const patch = writeProviderList(['codex']);
    expect(patch.enabledProviders).toEqual(['codex']);
    expect(patch.activeProvider).toBe('codex');
  });

  it('invariant: activeProvider === enabledProviders[0] always holds', () => {
    const lists: Array<[ActiveProvider, ...ActiveProvider[]]> = [
      ['anthropic'],
      ['codex', 'openrouter'],
      ['openrouter', 'codex', 'anthropic'],
      ['mindstone', 'openrouter'],
    ];
    for (const list of lists) {
      const patch = writeProviderList(list);
      expect(patch.activeProvider).toBe(patch.enabledProviders?.[0]);
    }
  });

  // 6a-F2: duplicate dedup
  describe('6a-F2 dedup — duplicate entries are removed (first-occurrence order preserved)', () => {
    it('duplicate head is deduplicated', () => {
      // e.g. if the UI somehow produces ['codex', 'codex', 'openrouter']
      const patch = writeProviderList(['codex', 'codex', 'openrouter'] as unknown as [ActiveProvider, ...ActiveProvider[]]);
      expect(patch.enabledProviders).toEqual(['codex', 'openrouter']);
      expect(patch.activeProvider).toBe('codex');
    });

    it('duplicate tail entry is deduplicated (first occurrence wins)', () => {
      const patch = writeProviderList(['codex', 'openrouter', 'anthropic', 'openrouter'] as unknown as [ActiveProvider, ...ActiveProvider[]]);
      expect(patch.enabledProviders).toEqual(['codex', 'openrouter', 'anthropic']);
    });

    it('all-duplicate list is collapsed to single entry', () => {
      const patch = writeProviderList(['anthropic', 'anthropic', 'anthropic'] as unknown as [ActiveProvider, ...ActiveProvider[]]);
      expect(patch.enabledProviders).toEqual(['anthropic']);
      expect(patch.activeProvider).toBe('anthropic');
    });

    it('no-duplicate list is unchanged', () => {
      const patch = writeProviderList(['codex', 'openrouter', 'anthropic']);
      expect(patch.enabledProviders).toEqual(['codex', 'openrouter', 'anthropic']);
    });
  });
});

// ---------------------------------------------------------------------------
// normalizeSettings integration — head-sync invariant enforcement
// ---------------------------------------------------------------------------
describe('normalizeSettings — Stage 6a head-sync invariant', () => {
  describe('behaviour-preservation: no enabledProviders list (all existing users)', () => {
    it('absent list is preserved absent → no unexpected settings write', () => {
      const result = normalizeSettings(makeSettings({ activeProvider: 'anthropic' }));
      // Must NOT have enabledProviders key — this is the byte-identical requirement.
      expect(result.enabledProviders).toBeUndefined();
    });

    it('anthropic user — output byte-identical on enabledProviders key', () => {
      const result = normalizeSettings(makeSettings({ activeProvider: 'anthropic' }));
      expect(result.enabledProviders).toBeUndefined();
    });

    it('codex user — output byte-identical on enabledProviders key', () => {
      const result = normalizeSettings(makeSettings({ activeProvider: 'codex' }));
      expect(result.enabledProviders).toBeUndefined();
    });

    it('openrouter user — output byte-identical on enabledProviders key', () => {
      const result = normalizeSettings(makeSettings({ activeProvider: 'openrouter' }));
      expect(result.enabledProviders).toBeUndefined();
    });

    it('fresh user (undefined activeProvider) — output byte-identical on enabledProviders key', () => {
      const result = normalizeSettings(makeSettings({ activeProvider: undefined }));
      expect(result.enabledProviders).toBeUndefined();
    });
  });

  describe('consistent list (no reorder needed) → passes through unchanged', () => {
    it('single-provider list consistent with activeProvider → unchanged', () => {
      const result = normalizeSettings(
        makeSettings({ activeProvider: 'anthropic', enabledProviders: ['anthropic'] }),
      );
      expect(result.enabledProviders).toEqual(['anthropic']);
      expect(result.activeProvider).toBe('anthropic');
    });

    it('multi-provider list with activeProvider at head → unchanged', () => {
      const result = normalizeSettings(
        makeSettings({
          activeProvider: 'codex',
          enabledProviders: ['codex', 'openrouter', 'anthropic'],
        }),
      );
      expect(result.enabledProviders).toEqual(['codex', 'openrouter', 'anthropic']);
      expect(result.activeProvider).toBe('codex');
    });
  });

  describe('head-sync reorder — activeProvider in list but not at head', () => {
    it('reorders list to put activeProvider first; remaining order preserved', () => {
      // Simulates: user had ['codex', 'openrouter'] and a legacy providerSwitch
      // wrote activeProvider='openrouter'. normalizeSettings must reconcile.
      const result = normalizeSettings(
        makeSettings({
          activeProvider: 'openrouter',
          enabledProviders: ['codex', 'openrouter', 'anthropic'],
        }),
      );
      expect(result.enabledProviders).toEqual(['openrouter', 'codex', 'anthropic']);
      expect(result.activeProvider).toBe('openrouter');
    });

    it('invariant holds after normalizeSettings: activeProvider === enabledProviders[0]', () => {
      const result = normalizeSettings(
        makeSettings({
          activeProvider: 'anthropic',
          enabledProviders: ['codex', 'openrouter', 'anthropic'],
        }),
      );
      expect(result.activeProvider).toBe(result.enabledProviders?.[0]);
    });
  });

  describe('head-sync prepend — legacy providerSwitch sets activeProvider not in list', () => {
    it('prepends activeProvider to list', () => {
      const result = normalizeSettings(
        makeSettings({
          activeProvider: 'anthropic',
          enabledProviders: ['codex', 'openrouter'],
        }),
      );
      expect(result.enabledProviders).toEqual(['anthropic', 'codex', 'openrouter']);
      expect(result.activeProvider).toBe('anthropic');
    });
  });

  describe('idempotency — normalizeSettings∘normalizeSettings == normalizeSettings', () => {
    it('reorder case is idempotent through normalizeSettings', () => {
      const input = makeSettings({
        activeProvider: 'openrouter',
        enabledProviders: ['codex', 'openrouter', 'anthropic'],
      });
      const once = normalizeSettings(input);
      const twice = normalizeSettings(once);
      expect(twice.enabledProviders).toEqual(once.enabledProviders);
      expect(twice.activeProvider).toEqual(once.activeProvider);
    });

    it('prepend case is idempotent through normalizeSettings', () => {
      const input = makeSettings({
        activeProvider: 'anthropic',
        enabledProviders: ['codex', 'openrouter'],
      });
      const once = normalizeSettings(input);
      const twice = normalizeSettings(once);
      expect(twice.enabledProviders).toEqual(once.enabledProviders);
      expect(twice.activeProvider).toEqual(once.activeProvider);
    });
  });

  describe('legacy providerSwitch consistency', () => {
    it('after a legacy activeProvider-only write, normalizeSettings reconciles the list', () => {
      // Scenario: user had enabledProviders=['codex','openrouter'], then called
      // providerSwitch which writes only activeProvider='anthropic'. On the next
      // normalizeSettings call, the list must be reconciled.
      const settingsAfterSwitch = makeSettings({
        activeProvider: 'anthropic',     // providerSwitch wrote this
        enabledProviders: ['codex', 'openrouter'],  // list was already present
      });
      const result = normalizeSettings(settingsAfterSwitch);
      // anthropic should be prepended (it wasn't in the list)
      expect(result.enabledProviders?.[0]).toBe('anthropic');
      expect(result.activeProvider).toBe('anthropic');
      // The invariant holds
      expect(result.activeProvider).toBe(result.enabledProviders?.[0]);
    });
  });
});
