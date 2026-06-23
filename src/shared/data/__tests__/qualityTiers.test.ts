import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { ModelProfile, ActiveProvider } from '@shared/types';
import {
  CLAUDE_TIERS,
  getQualityTiers,
  matchOverridesToTier,
  overridesMatchGlobalDefault,
  qualityTierModel,
  type QualityTier,
  type QualityTierRole,
} from '../qualityTiers';
import { getCatalogEntryById, getCatalogAliasMap } from '../modelCatalog';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeProfile = (overrides: Partial<ModelProfile> & Pick<ModelProfile, 'id' | 'model'>): ModelProfile => ({
  name: overrides.id,
  serverUrl: 'https://api.example.com/v1',
  createdAt: Date.now(),
  ...overrides,
});

const gpt55Profile = makeProfile({ id: 'profile-gpt55', name: 'GPT 5.5', model: 'gpt-5.5' });
const unknownProfile = makeProfile({ id: 'profile-custom', name: 'Custom Model', model: 'my-custom-model-v2' });
const gpt55MiniProfile = makeProfile({ id: 'profile-gpt55-mini', name: 'GPT 5.5 Mini', model: 'gpt-5.4-mini' });
// Premium always-on-thinking model in both spellings a user profile can carry:
// the direct Anthropic id and the OpenRouter wire id (its own catalog row,
// flagged via the openRouter.sdkModel hop to the direct-provider row).
const fableProfile = makeProfile({ id: 'profile-fable', name: 'Fable 5', model: 'claude-fable-5' });
const fableOrProfile = makeProfile({ id: 'profile-fable-or', name: 'Fable 5 (OpenRouter)', model: 'anthropic/claude-fable-5' });

// ---------------------------------------------------------------------------
// CLAUDE_TIERS
// ---------------------------------------------------------------------------

describe('CLAUDE_TIERS', () => {
  it('pins every canonical Claude tier field for shared bridge/UI parity', () => {
    expect(CLAUDE_TIERS).toHaveLength(4);
    expect(CLAUDE_TIERS[0]).toEqual({
      id: 'quick',
      name: 'Quick',
      costIndicator: '$',
      description: 'Fast responses for simple tasks',
      workingModel: 'claude-haiku-4-5',
      thinkingModel: 'claude-haiku-4-5',
      thinkingEffort: 'low',
    });
    expect(CLAUDE_TIERS[1]).toEqual({
      id: 'balanced',
      name: 'Balanced',
      costIndicator: '$$',
      description: 'Good balance of speed and quality',
      workingModel: 'claude-sonnet-4-6',
      thinkingModel: 'claude-sonnet-4-6',
      thinkingEffort: 'high',
    });
    expect(CLAUDE_TIERS[2]).toEqual({
      id: 'thorough',
      name: 'Thorough',
      costIndicator: '$$$',
      description: 'Deep reasoning for complex tasks',
      workingModel: 'claude-sonnet-4-6',
      thinkingModel: 'claude-opus-4-8',
      thinkingEffort: 'high',
    });
    expect(CLAUDE_TIERS[3]).toEqual({
      id: 'maximum',
      name: 'Maximum',
      costIndicator: '$$$$',
      description: 'Best available quality',
      workingModel: 'claude-opus-4-8',
      thinkingModel: 'claude-opus-4-8',
      thinkingEffort: 'xhigh',
    });
  });

  it('every tier workingModel and thinkingModel resolves in MODEL_CATALOG (see docs/project/NEW_MODEL_SUPPORT_PROCESS.md step 11)', () => {
    for (const tier of CLAUDE_TIERS) {
      for (const role of ['workingModel', 'thinkingModel'] as const) {
        const modelId = tier[role];
        expect(
          modelId,
          `tier "${tier.id}" ${role} is undefined — CLAUDE_TIERS entries must pin both models; see docs/project/NEW_MODEL_SUPPORT_PROCESS.md step 11`,
        ).toBeDefined();
        expect(
          getCatalogEntryById(modelId as string),
          `tier "${tier.id}" ${role} "${modelId}" missing from MODEL_CATALOG — see docs/project/NEW_MODEL_SUPPORT_PROCESS.md step 11`,
        ).toBeDefined();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// getQualityTiers
// ---------------------------------------------------------------------------

describe('getQualityTiers', () => {
  it('returns 4 Claude tiers when no profiles are provided', () => {
    const tiers = getQualityTiers([], false);
    expect(tiers).toHaveLength(4);
    expect(tiers.map(t => t.id)).toEqual(['quick', 'balanced', 'thorough', 'maximum']);
    expect(tiers[0].workingModel).toBe('claude-haiku-4-5');
    expect(tiers[3].workingModel).toBe('claude-opus-4-8');
    expect(tiers[3].thinkingModel).toBe('claude-opus-4-8');
  });

  it('enhances Maximum tier with best third-party profile when multi-model enabled', () => {
    const tiers = getQualityTiers([gpt55Profile], true);
    expect(tiers).toHaveLength(4);

    // Lower tiers unchanged
    expect(tiers[0].workingModel).toBe('claude-haiku-4-5');
    expect(tiers[1].workingModel).toBe('claude-sonnet-4-6');
    expect(tiers[2].workingModel).toBe('claude-sonnet-4-6');

    // Maximum: working swapped to GPT 5.5, thinking stays Opus
    const max = tiers[3];
    expect(max.workingModel).toBe('gpt-5.5');
    expect(max.workingProfileId).toBe('profile-gpt55');
    expect(max.thinkingModel).toBe('claude-opus-4-8');
    expect(max.thinkingEffort).toBe('xhigh');
  });

  it('picks highest-cost profile when multiple profiles available', () => {
    // gpt-5.5 output=$15, gpt-5.4-mini output=$4.50
    const tiers = getQualityTiers([gpt55MiniProfile, gpt55Profile], true);
    const max = tiers[3];
    expect(max.workingModel).toBe('gpt-5.5');
    expect(max.workingProfileId).toBe('profile-gpt55');
  });

  it('falls back to first routable profile when no profile has catalog pricing', () => {
    const tiers = getQualityTiers([unknownProfile], true);
    const max = tiers[3];
    expect(max.workingModel).toBe('my-custom-model-v2');
    expect(max.workingProfileId).toBe('profile-custom');
    expect(max.thinkingModel).toBe('claude-opus-4-8');
  });

  it('returns pure Claude tiers when multi-model is disabled even with profiles', () => {
    const tiers = getQualityTiers([gpt55Profile], false);
    const max = tiers[3];
    expect(max.workingModel).toBe('claude-opus-4-8');
    expect(max.workingProfileId).toBeUndefined();
  });

  it('returns shallow copies so callers cannot mutate the presets', () => {
    const tiers1 = getQualityTiers([], false);
    const tiers2 = getQualityTiers([], false);
    expect(tiers1[0]).not.toBe(tiers2[0]);
    expect(tiers1[0]).toEqual(tiers2[0]);
  });

  // Premium always-on exclusion (verification-audit F5, Stage 12): a routable
  // Fable profile is catalog-priced ABOVE every third-party model, so without
  // the thinkingAlwaysOn skip it would silently re-price the Maximum click.
  // (The Frontier tier that was the explicit opt-in is removed while Fable
  // access is withdrawn — 2026-06; the exclusion still matters because a user
  // can add a Fable profile directly.)
  describe('premium always-on exclusion from the Maximum swap', () => {
    it('never picks a routable Fable profile (direct id) even though it is the most expensive', () => {
      const tiers = getQualityTiers([gpt55Profile, fableProfile], true);
      const max = tiers[3];
      expect(max.workingModel).toBe('gpt-5.5');
      expect(max.workingProfileId).toBe('profile-gpt55');
    });

    it('never picks a routable Fable profile (anthropic/claude-fable-5 OpenRouter id) either', () => {
      const tiers = getQualityTiers([gpt55Profile, fableOrProfile], true);
      const max = tiers[3];
      expect(max.workingModel).toBe('gpt-5.5');
      expect(max.workingProfileId).toBe('profile-gpt55');
    });

    it('ranking among the remaining profiles is unchanged by the exclusion', () => {
      // gpt-5.5 ($15) still beats gpt-5.4-mini ($4.50) with Fable in the pool
      const tiers = getQualityTiers([gpt55MiniProfile, fableProfile, gpt55Profile], true);
      const max = tiers[3];
      expect(max.workingModel).toBe('gpt-5.5');
      expect(max.workingProfileId).toBe('profile-gpt55');
    });

    it('excludes premium profiles from the no-pricing fallback pool too', () => {
      // unknownProfile has no catalog pricing; the fallback must skip Fable
      // rather than reintroduce it as "first routable".
      const tiers = getQualityTiers([fableOrProfile, unknownProfile], true);
      const max = tiers[3];
      expect(max.workingModel).toBe('my-custom-model-v2');
      expect(max.workingProfileId).toBe('profile-custom');
    });

    it.each([
      ['direct id only', [fableProfile]],
      ['OpenRouter id only', [fableOrProfile]],
      ['both spellings', [fableProfile, fableOrProfile]],
    ])('Fable-only routable list (%s) leaves Maximum on the stock Opus preset', (_label, profiles) => {
      const tiers = getQualityTiers(profiles, true);
      const max = tiers[3];
      expect(max.workingModel).toBe('claude-opus-4-8');
      expect(max.thinkingModel).toBe('claude-opus-4-8');
      expect(max.workingProfileId).toBeUndefined();
    });

    // Alias-complete exclusion (GPT stage-12 review F1): a user profile can
    // carry ANY Fable-shaped spelling — `[1m]`-suffixed, dated, or the
    // OpenRouter legacy slug (which is in openRouter.legacyIds, NOT the alias
    // map). None of these have catalog pricing under their raw spelling, so
    // the live threat is the no-pricing FALLBACK (eligibleProfiles[0]); the
    // exclusion must drop them from ranking AND fallback.
    describe('alias-shaped premium spellings (GPT stage-12 review F1)', () => {
      const aliasShapedSpellings = [
        ['direct id with [1m] suffix', 'claude-fable-5[1m]'],
        ['OpenRouter id with [1m] suffix', 'anthropic/claude-fable-5[1m]'],
        ['dated direct spelling', 'claude-fable-5-20260609'],
        ['OpenRouter legacy slug', 'anthropic/claude-5-fable-20260609'],
      ] as const;

      it.each(aliasShapedSpellings)(
        'a Fable-only routable list (%s) leaves Maximum on the stock Opus preset',
        (_label, model) => {
          const tiers = getQualityTiers([makeProfile({ id: 'profile-fable-shaped', name: 'Fable shaped', model })], true);
          const max = tiers[3];
          expect(max.workingModel).toBe('claude-opus-4-8');
          expect(max.workingProfileId).toBeUndefined();
        },
      );

      it.each(aliasShapedSpellings)(
        'never wins the no-pricing fallback ahead of a custom profile (%s)',
        (_label, model) => {
          // Fable-shaped profile FIRST in line: without the exclusion the
          // fallback would return it as "first eligible routable".
          const tiers = getQualityTiers(
            [makeProfile({ id: 'profile-fable-shaped', name: 'Fable shaped', model }), unknownProfile],
            true,
          );
          const max = tiers[3];
          expect(max.workingModel).toBe('my-custom-model-v2');
          expect(max.workingProfileId).toBe('profile-custom');
        },
      );

      it('priced ranking is unaffected with every spelling in the pool', () => {
        const fableShapedProfiles = aliasShapedSpellings.map(([, model], i) =>
          makeProfile({ id: `profile-fable-shaped-${i}`, name: `Fable shaped ${i}`, model }));
        const tiers = getQualityTiers([...fableShapedProfiles, gpt55Profile], true);
        const max = tiers[3];
        expect(max.workingModel).toBe('gpt-5.5');
        expect(max.workingProfileId).toBe('profile-gpt55');
      });
    });
  });
});

// ---------------------------------------------------------------------------
// matchOverridesToTier
// ---------------------------------------------------------------------------

describe('matchOverridesToTier', () => {
  const tiers = getQualityTiers([], false);

  it('returns tier id on exact match (including effort)', () => {
    expect(matchOverridesToTier(tiers, {
      workingModel: 'claude-sonnet-4-6',
      thinkingModel: 'claude-opus-4-8',
      thinkingEffort: 'high',
    })).toBe('thorough');
  });

  it('returns null on partial match (wrong thinking model)', () => {
    expect(matchOverridesToTier(tiers, {
      workingModel: 'claude-sonnet-4-6',
      thinkingModel: 'claude-haiku-4-5',
      thinkingEffort: 'high',
    })).toBeNull();
  });

  it('returns null when all overrides are undefined (no overrides set)', () => {
    expect(matchOverridesToTier(tiers, {})).toBeNull();
  });

  it('matches Maximum tier with profile-enhanced tiers', () => {
    const multiTiers = getQualityTiers([gpt55Profile], true);
    expect(matchOverridesToTier(multiTiers, {
      workingModel: 'gpt-5.5',
      workingProfileId: 'profile-gpt55',
      thinkingModel: 'claude-opus-4-8',
      thinkingEffort: 'xhigh',
    })).toBe('maximum');
  });

  it('returns null when profileId does not match', () => {
    const multiTiers = getQualityTiers([gpt55Profile], true);
    expect(matchOverridesToTier(multiTiers, {
      workingModel: 'gpt-5.5',
      workingProfileId: 'wrong-profile-id',
      thinkingModel: 'claude-opus-4-8',
      thinkingEffort: 'xhigh',
    })).toBeNull();
  });

  it('returns null when effort differs from tier definition', () => {
    // Thorough tier has thinkingEffort: 'high' — changing to 'low' means "Custom"
    expect(matchOverridesToTier(tiers, {
      workingModel: 'claude-sonnet-4-6',
      thinkingModel: 'claude-opus-4-8',
      thinkingEffort: 'low',
    })).toBeNull();
  });

  it('returns null when effort is undefined (no match without explicit effort)', () => {
    expect(matchOverridesToTier(tiers, {
      workingModel: 'claude-sonnet-4-6',
      thinkingModel: 'claude-opus-4-8',
      // thinkingEffort omitted — undefined !== 'high', so no match
    })).toBeNull();
  });

  // Policy guard: persisted Opus overrides reverse-match 'maximum'. (The
  // Frontier tier that Fable overrides used to match is removed while Fable
  // access is withdrawn — 2026-06 — so Fable overrides now match no tier; the
  // next test pins that.)
  it('opus-4-8 overrides reverse-match Maximum', () => {
    expect(matchOverridesToTier(tiers, {
      workingModel: 'claude-opus-4-8',
      thinkingModel: 'claude-opus-4-8',
      thinkingEffort: 'xhigh',
    })).toBe('maximum');
  });

  it('fable-5 overrides match no tier while the Frontier tier is withdrawn (2026-06)', () => {
    expect(matchOverridesToTier(tiers, {
      workingModel: 'claude-fable-5',
      thinkingModel: 'claude-fable-5',
      thinkingEffort: 'xhigh',
    })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// overridesMatchGlobalDefault
// ---------------------------------------------------------------------------

describe('overridesMatchGlobalDefault', () => {
  it('returns true when no overrides are set (all inherit global)', () => {
    expect(overridesMatchGlobalDefault(
      {},
      { workingEffectiveModelId: 'claude-sonnet-4-6' },
    )).toBe(true);
  });

  it('returns true when overrides explicitly match global Claude model', () => {
    expect(overridesMatchGlobalDefault(
      { workingModel: 'claude-sonnet-4-6', thinkingModel: 'claude-opus-4-8' },
      { workingEffectiveModelId: 'claude-sonnet-4-6', thinkingEffectiveModelId: 'claude-opus-4-8' },
    )).toBe(true);
  });

  it('returns false when working model differs from global', () => {
    expect(overridesMatchGlobalDefault(
      { workingModel: 'claude-opus-4-8' },
      { workingEffectiveModelId: 'claude-sonnet-4-6' },
    )).toBe(false);
  });

  it('returns false when thinking model differs from global', () => {
    expect(overridesMatchGlobalDefault(
      { thinkingModel: 'claude-haiku-4-5' },
      { workingEffectiveModelId: 'claude-sonnet-4-6', thinkingEffectiveModelId: 'claude-opus-4-8' },
    )).toBe(false);
  });

  it('matches a caller-resolved global working profile model', () => {
    expect(overridesMatchGlobalDefault(
      { workingModel: 'gpt-5.5', workingProfileId: 'profile-gpt55' },
      { workingEffectiveModelId: 'gpt-5.5', workingProfileRef: 'profile-gpt55' },
    )).toBe(true);
  });

  it('does not match a raw profile model when the resolved global working profile has no effective model', () => {
    // Null effective model means the global profile will not resolve at runtime,
    // so it must not match a model-bearing tier or override even if the raw
    // profile still stores that model id.
    expect(overridesMatchGlobalDefault(
      { workingModel: 'gpt-5.5', workingProfileId: 'profile-gpt55' },
      { workingEffectiveModelId: null, workingProfileRef: 'profile-gpt55' },
    )).toBe(false);
  });

  it('returns false when profile override does not match global profile', () => {
    expect(overridesMatchGlobalDefault(
      { workingProfileId: 'profile-gpt55' },
      { workingEffectiveModelId: 'claude-sonnet-4-6' },
    )).toBe(false);
  });

  it('matches a caller-resolved global thinking profile model', () => {
    expect(overridesMatchGlobalDefault(
      { thinkingModel: 'gpt-5.5', thinkingProfileId: 'profile-gpt55' },
      { thinkingEffectiveModelId: 'gpt-5.5', thinkingProfileRef: 'profile-gpt55' },
    )).toBe(true);
  });

  it('resolves thinking=working in single-model mode (no explicit thinkingModel)', () => {
    // Global: Haiku with no separate thinking model → thinking inherits working
    // Override: Quick tier sets both to Haiku → should match
    expect(overridesMatchGlobalDefault(
      { workingModel: 'claude-haiku-4-5', thinkingModel: 'claude-haiku-4-5' },
      { workingEffectiveModelId: 'claude-haiku-4-5' },
    )).toBe(true);
  });

  it('handles deleted profile in global settings gracefully', () => {
    // Global references a profile that no longer exists in profiles array
    expect(overridesMatchGlobalDefault(
      { workingProfileId: 'deleted-profile' },
      { workingProfileRef: 'deleted-profile' },
    )).toBe(true);
  });

  it('returns false when override has empty settings (no global config)', () => {
    expect(overridesMatchGlobalDefault(
      { workingModel: 'claude-opus-4-8' },
      {},
    )).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge case coverage (per test plan)
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  describe('multi-model toggle behavior', () => {
    it('Maximum tier uses best profile when multi-model enabled with profiles', () => {
      const tiers = getQualityTiers([gpt55Profile], true);
      const max = tiers[3];
      expect(max.workingModel).toBe('gpt-5.5');
      expect(max.workingProfileId).toBe('profile-gpt55');
      expect(max.thinkingModel).toBe('claude-opus-4-8');
    });

    it('all tiers are Claude-only when multi-model disabled despite profiles existing', () => {
      const tiers = getQualityTiers([gpt55Profile, gpt55MiniProfile], false);
      for (const tier of tiers) {
        expect(tier.workingProfileId).toBeUndefined();
        expect(tier.workingModel).toMatch(/^claude-/);
        expect(tier.thinkingModel).toMatch(/^claude-/);
      }
    });

    it('multi-model with no profiles returns pure Claude tiers', () => {
      const tiers = getQualityTiers([], true);
      expect(tiers).toHaveLength(4);
      expect(tiers[3].workingModel).toBe('claude-opus-4-8');
      expect(tiers[3].workingProfileId).toBeUndefined();
    });
  });

  describe('tier selection clears overrides on re-click', () => {
    it('tier matching returns null when all overrides are cleared (undefined)', () => {
      const tiers = getQualityTiers([], false);
      // Simulates what happens after clearing overrides: all fields undefined
      expect(matchOverridesToTier(tiers, {
        workingModel: undefined,
        thinkingModel: undefined,
        workingProfileId: undefined,
        thinkingProfileId: undefined,
        thinkingEffort: undefined,
      })).toBeNull();
    });
  });

  describe('restored session global-default matching', () => {
    it('Thorough override matches global Sonnet+Opus default', () => {
      expect(overridesMatchGlobalDefault(
        { workingModel: 'claude-sonnet-4-6', thinkingModel: 'claude-opus-4-8' },
        { workingEffectiveModelId: 'claude-sonnet-4-6', thinkingEffectiveModelId: 'claude-opus-4-8' },
      )).toBe(true);
    });

    it('Quick override does NOT match global Sonnet default', () => {
      expect(overridesMatchGlobalDefault(
        { workingModel: 'claude-haiku-4-5', thinkingModel: 'claude-haiku-4-5' },
        { workingEffectiveModelId: 'claude-sonnet-4-6' },
      )).toBe(false);
    });
  });

  describe('effort-only change shows Custom', () => {
    it('Thorough tier models with different effort returns null (Custom)', () => {
      const tiers = getQualityTiers([], false);
      expect(matchOverridesToTier(tiers, {
        workingModel: 'claude-sonnet-4-6',
        thinkingModel: 'claude-opus-4-8',
        thinkingEffort: 'medium', // Thorough = 'high'
      })).toBeNull();
    });

    it('Maximum tier models with lower effort returns null (Custom)', () => {
      const tiers = getQualityTiers([], false);
      expect(matchOverridesToTier(tiers, {
        workingModel: 'claude-opus-4-8',
        thinkingModel: 'claude-opus-4-8',
        thinkingEffort: 'high', // Maximum = 'xhigh'
      })).toBeNull();
    });
  });

  describe('bidirectional sync (tier ↔ advanced)', () => {
    it('tier overrides map back to same tier via matchOverridesToTier', () => {
      const tiers = getQualityTiers([], false);
      for (const tier of tiers) {
        const matched = matchOverridesToTier(tiers, {
          workingModel: tier.workingModel,
          thinkingModel: tier.thinkingModel,
          workingProfileId: tier.workingProfileId,
          thinkingProfileId: tier.thinkingProfileId,
          thinkingEffort: tier.thinkingEffort,
        });
        expect(matched).toBe(tier.id);
      }
    });

    it('manual selection that matches a tier is correctly identified', () => {
      const tiers = getQualityTiers([], false);
      // User manually selects Haiku + Haiku + low = Quick
      expect(matchOverridesToTier(tiers, {
        workingModel: 'claude-haiku-4-5',
        thinkingModel: 'claude-haiku-4-5',
        thinkingEffort: 'low',
      })).toBe('quick');
    });

    it('manual selection that matches no tier returns Custom', () => {
      const tiers = getQualityTiers([], false);
      // Haiku working + Opus thinking = not a defined tier
      expect(matchOverridesToTier(tiers, {
        workingModel: 'claude-haiku-4-5',
        thinkingModel: 'claude-opus-4-8',
        thinkingEffort: 'high',
      })).toBeNull();
    });
  });

  describe('global default indicator accuracy', () => {
    it('global Sonnet+Sonnet+high matches Balanced tier', () => {
      const tiers = getQualityTiers([], false);
      const matched = matchOverridesToTier(tiers, {
        workingModel: 'claude-sonnet-4-6',
        thinkingModel: 'claude-sonnet-4-6',
        thinkingEffort: 'high',
      });
      expect(matched).toBe('balanced');
    });

    it('global custom combo (Haiku + Opus) matches no tier', () => {
      const tiers = getQualityTiers([], false);
      const matched = matchOverridesToTier(tiers, {
        workingModel: 'claude-haiku-4-5',
        thinkingModel: 'claude-opus-4-8',
        thinkingEffort: 'medium',
      });
      expect(matched).toBeNull();
    });

    it('global profile-based combo matches multi-model Maximum', () => {
      const tiers = getQualityTiers([gpt55Profile], true);
      const matched = matchOverridesToTier(tiers, {
        workingModel: 'gpt-5.5',
        workingProfileId: 'profile-gpt55',
        thinkingModel: 'claude-opus-4-8',
        thinkingEffort: 'xhigh',
      });
      expect(matched).toBe('maximum');
    });

    it('null-effective global profile does not match multi-model Maximum despite the profile ref', () => {
      const tiers = getQualityTiers([gpt55Profile], true);
      const matched = matchOverridesToTier(tiers, {
        workingModel: undefined,
        workingProfileId: 'profile-gpt55',
        thinkingModel: 'claude-opus-4-8',
        thinkingEffort: 'xhigh',
      });
      expect(matched).toBeNull();
    });
  });

  describe('thinking effort override in global default matching', () => {
    it('returns true when effort override matches global effort', () => {
      expect(overridesMatchGlobalDefault(
        { thinkingEffort: 'high' },
        { workingEffectiveModelId: 'claude-sonnet-4-6', thinkingEffort: 'high' },
      )).toBe(true);
    });

    it('returns false when effort override differs from global', () => {
      expect(overridesMatchGlobalDefault(
        { thinkingEffort: 'low' },
        { workingEffectiveModelId: 'claude-sonnet-4-6', thinkingEffort: 'high' },
      )).toBe(false);
    });

    it('undefined effort override inherits global (matches)', () => {
      expect(overridesMatchGlobalDefault(
        {},
        { workingEffectiveModelId: 'claude-sonnet-4-6', thinkingEffort: 'medium' },
      )).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// qualityTierModel (provider-aware role resolver)
// ---------------------------------------------------------------------------

describe('qualityTierModel', () => {
  const tiers = CLAUDE_TIERS;
  const providers: ActiveProvider[] = ['anthropic', 'openrouter', 'codex'];
  const roles: QualityTierRole[] = ['working', 'thinking', 'background'];

  describe('Anthropic provider uses tier canonical fields', () => {
    it.each(tiers.map(t => [t.id, t] as const))('%s tier — working role returns workingModel', (_id, tier) => {
      expect(qualityTierModel(tier, 'anthropic', 'working')).toBe(tier.workingModel);
    });

    it.each(tiers.map(t => [t.id, t] as const))('%s tier — thinking role returns thinkingModel', (_id, tier) => {
      expect(qualityTierModel(tier, 'anthropic', 'thinking')).toBe(tier.thinkingModel);
    });

    it.each(tiers.map(t => [t.id, t] as const))('%s tier — background role returns workingModel', (_id, tier) => {
      expect(qualityTierModel(tier, 'anthropic', 'background')).toBe(tier.workingModel);
    });

    it('ignores providerDefault for Anthropic provider', () => {
      const tier = CLAUDE_TIERS[1]; // Balanced
      expect(qualityTierModel(tier, 'anthropic', 'working', 'gpt-5.5')).toBe(tier.workingModel);
    });

    it('falls back to workingModel when thinkingModel is missing on Anthropic', () => {
      const tier: QualityTier = { ...CLAUDE_TIERS[0], thinkingModel: undefined };
      expect(qualityTierModel(tier, 'anthropic', 'thinking')).toBe(tier.workingModel);
    });
  });

  describe('non-Anthropic providers prefer providerDefault', () => {
    const nonAnthropicProviders: ActiveProvider[] = ['openrouter', 'codex'];

    it.each(
      nonAnthropicProviders.flatMap(provider =>
        tiers.flatMap(tier =>
          roles.map(role => [provider, tier.id, role, tier] as const),
        ),
      ),
    )('%s + %s tier + %s role uses providerDefault', (provider, _id, role, tier) => {
      const result = qualityTierModel(tier, provider, role, 'provider-default-model');
      expect(result).toBe('provider-default-model');
    });

    it('falls back to tier field when providerDefault omitted (defensive)', () => {
      const tier = CLAUDE_TIERS[3]; // Maximum
      expect(qualityTierModel(tier, 'openrouter', 'working')).toBe(tier.workingModel);
      expect(qualityTierModel(tier, 'openrouter', 'thinking')).toBe(tier.thinkingModel);
      expect(qualityTierModel(tier, 'openrouter', 'background')).toBe(tier.workingModel);
    });

    it('returns empty string when both providerDefault and tier fields are missing', () => {
      const tier: QualityTier = { ...CLAUDE_TIERS[0], workingModel: undefined, thinkingModel: undefined };
      expect(qualityTierModel(tier, 'openrouter', 'working')).toBe('');
      expect(qualityTierModel(tier, 'openrouter', 'thinking')).toBe('');
    });
  });

  describe('full provider × tier × role matrix (45 cases)', () => {
    // 3 providers × 5 tiers × 3 roles = 45 combinations
    const cases = providers.flatMap(provider =>
      tiers.flatMap(tier =>
        roles.map(role => [provider, tier, role] as const),
      ),
    );

    it.each(cases)('%s / %s / %s returns a non-undefined string', (provider, tier, role) => {
      const result = qualityTierModel(tier, provider, role, 'fallback-default');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Quick-tier monotonicity (Maximum >= Quick by catalog output cost)
// ---------------------------------------------------------------------------

describe('Quick-tier monotonicity', () => {
  it('Maximum tier working model output cost >= Quick tier working model output cost (per provider)', () => {
    // For Anthropic (Claude-only tiers), verify monotonicity directly via catalog
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const aliasMap = getCatalogAliasMap();

    try {
      const claudeTiers = getQualityTiers([], false);
      const quickModel = claudeTiers[0].workingModel;
      const maxModel = claudeTiers[3].workingModel;

      expect(quickModel).toBeTruthy();
      expect(maxModel).toBeTruthy();

      const quickCanonical = aliasMap[quickModel!] ?? quickModel!;
      const maxCanonical = aliasMap[maxModel!] ?? maxModel!;
      const quickCost = getCatalogEntryById(quickCanonical)?.pricing?.output;
      const maxCost = getCatalogEntryById(maxCanonical)?.pricing?.output;

      // NaN-skip: only assert when both costs are defined numbers
      if (typeof quickCost === 'number' && typeof maxCost === 'number') {
        expect(maxCost).toBeGreaterThanOrEqual(quickCost);
      } else {
        console.warn(
          `[qualityTiers.test] Skipping Anthropic monotonicity: missing catalog cost for quick=${quickModel} (${quickCost}) or maximum=${maxModel} (${maxCost})`,
        );
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('Maximum tier with multi-model profiles ranks at least as high as Quick (per provider)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const aliasMap = getCatalogAliasMap();

    try {
      const profile = makeProfile({ id: 'profile-gpt55', name: 'GPT 5.5', model: 'gpt-5.5' });
      const tiers = getQualityTiers([profile], true);
      const quickModel = tiers[0].workingModel;
      const maxModel = tiers[3].workingModel;

      expect(quickModel).toBeTruthy();
      expect(maxModel).toBeTruthy();

      const quickCanonical = aliasMap[quickModel!] ?? quickModel!;
      const maxCanonical = aliasMap[maxModel!] ?? maxModel!;
      const quickCost = getCatalogEntryById(quickCanonical)?.pricing?.output;
      const maxCost = getCatalogEntryById(maxCanonical)?.pricing?.output;

      if (typeof quickCost === 'number' && typeof maxCost === 'number') {
        expect(maxCost).toBeGreaterThanOrEqual(quickCost);
      } else {
        console.warn(
          `[qualityTiers.test] Skipping multi-model monotonicity: missing catalog cost for quick=${quickModel} (${quickCost}) or maximum=${maxModel} (${maxCost})`,
        );
      }
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Tier-surface parity lock (GPT review F2, Stage 11)
// ---------------------------------------------------------------------------
//
// CLAUDE_TIERS has two hand-maintained duplicates that cannot import it:
// the bundled RebelSettings MCP server (resources/mcp/rebel-settings/server.cjs
// — a standalone .cjs with no @shared import path) and the connector catalog
// copy of its tool description (resources/connector-catalog.json). The bridge
// route derives VALID_TIERS from CLAUDE_TIERS, so enum-vs-data drift fails at
// runtime — but only AFTER an agent has tried the tool. This lock makes the
// drift a test failure instead. When adding/removing a tier: update the
// z.enum + description bullets in server.cjs and the mirrored description in
// connector-catalog.json (see docs/project/NEW_MODEL_SUPPORT_PROCESS.md).
describe('tier surface parity (server.cjs + connector-catalog.json)', () => {
  const canonicalTierIds = CLAUDE_TIERS.map((t) => t.id);

  const serverCjsSource = readFileSync(
    join(process.cwd(), 'resources/mcp/rebel-settings/server.cjs'),
    'utf8',
  );

  /** The setQualityTier registerTool block (description + schema scope). */
  function extractSetQualityTierBlock(): string {
    const start = serverCjsSource.indexOf('server.registerTool(TOOL_NAMES.setQualityTier');
    expect(start).toBeGreaterThan(-1);
    const end = serverCjsSource.indexOf('}, async', start);
    expect(end).toBeGreaterThan(start);
    return serverCjsSource.slice(start, end);
  }

  /** Extract `- <id>: ...` bullet ids from a tool-description string. */
  function extractBulletIds(description: string): string[] {
    return [...description.matchAll(/^- ([a-z][a-z0-9_-]*):/gm)].map((m) => m[1]);
  }

  it('server.cjs z.enum for setQualityTier matches CLAUDE_TIERS ids exactly', () => {
    const enumMatch = serverCjsSource.match(/tier:\s*z\.enum\(\[([^\]]*)\]\)/);
    expect(enumMatch).not.toBeNull();
    const enumIds = [...enumMatch![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(enumIds).toEqual(canonicalTierIds);
  });

  it('server.cjs tool-description bullets match CLAUDE_TIERS ids exactly', () => {
    const bulletIds = extractBulletIds(extractSetQualityTierBlock());
    expect(bulletIds).toEqual(canonicalTierIds);
  });

  it('connector-catalog.json mirrored description bullets match CLAUDE_TIERS ids exactly', () => {
    const catalog = JSON.parse(
      readFileSync(join(process.cwd(), 'resources/connector-catalog.json'), 'utf8'),
    ) as { connectors: Array<{ id: string; tools?: Array<{ name: string; description?: string }> }> };
    const rebelSettings = catalog.connectors.find((c) => c.id === 'rebel-settings');
    expect(rebelSettings).toBeDefined();
    const tool = rebelSettings!.tools?.find((t) => t.name === 'rebel_settings_set_quality_tier');
    expect(tool).toBeDefined();
    expect(tool!.description).toBeTruthy();
    const bulletIds = extractBulletIds(tool!.description!);
    expect(bulletIds).toEqual(canonicalTierIds);
  });
});
