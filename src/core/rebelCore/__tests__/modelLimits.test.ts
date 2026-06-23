/**
 * Cascade-priority matrix tests for `resolveModelLimits`.
 *
 * Stage 2 (260503_unify_learned_limits_into_profiles.md). Resolution order:
 *   1. user-set profile.contextWindow
 *   2. Anthropic registry
 *   3. cross-provider preset
 *   4. profile-auto (in-scope profile, source='auto')
 *   5. model-scoped auto-learn (any matching profile, source='auto')
 *   6. DEFAULT_CONTEXT_WINDOW (200K)
 */
import { describe, it, expect, vi } from 'vitest';
import {
  resolveModelLimits,
  getAutoLearnedContextWindowForModel,
  getAutoLearnedOutputCapForModel,
  isExtendedContextModel,
  isAlwaysOnThinkingModel,
  isSamplingParamsForbiddenModel,
} from '../modelLimits';
import { modelSupportsExtendedContext } from '@shared/utils/modelNormalization';
import {
  MODEL_CATALOG,
  isAlwaysOnThinkingCatalogModel,
  isSamplingParamsForbiddenCatalogModel,
} from '@shared/data/modelCatalog';
import type { ModelProfile } from '@shared/types';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const baseProfile: Omit<ModelProfile, 'id' | 'name' | 'model'> = {
  providerType: 'other',
  serverUrl: 'https://example.test',
  createdAt: 1,
};

function makeProfile(overrides: Partial<ModelProfile> & { id: string; model: string }): ModelProfile {
  return {
    ...baseProfile,
    name: overrides.id,
    ...overrides,
  } as ModelProfile;
}

const ANTHROPIC_REGISTRY_MODEL = 'claude-opus-4-7';
const ANTHROPIC_REGISTRY_WINDOW = 1_000_000;
const PRESET_MODEL = 'openai/gpt-5.5';
const PRESET_MODEL_WINDOW = 1_050_000;

describe('resolveModelLimits — cascade priority matrix', () => {
  it('user-set on a profile beats the Anthropic registry', () => {
    const limits = resolveModelLimits({
      model: ANTHROPIC_REGISTRY_MODEL,
      profileContextWindow: 1_500_000,
      profileContextWindowSource: 'user',
    });
    expect(limits.contextWindow).toBe(1_500_000);
  });

  it('Anthropic registry wins when no user value is provided', () => {
    const limits = resolveModelLimits({ model: ANTHROPIC_REGISTRY_MODEL });
    expect(limits.contextWindow).toBe(ANTHROPIC_REGISTRY_WINDOW);
  });

  it('preset wins for non-Anthropic when no user value is provided', () => {
    const limits = resolveModelLimits({ model: PRESET_MODEL });
    expect(limits.contextWindow).toBeGreaterThan(0);
    expect(limits.contextWindow).not.toBe(200_000);
  });

  it('profile-auto wins when neither user nor registry/preset has data', () => {
    const limits = resolveModelLimits({
      model: 'unknown-model',
      profileContextWindow: 720_000,
      profileContextWindowSource: 'auto',
    });
    expect(limits.contextWindow).toBe(720_000);
  });

  it('model-scoped auto-learn wins when no profile-auto or registry data is in scope', () => {
    const profiles: ModelProfile[] = [
      makeProfile({
        id: 'p1',
        model: 'unknown-model',
        contextWindow: 600_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: 5_000,
      }),
    ];
    const limits = resolveModelLimits({
      model: 'unknown-model',
      allProfiles: profiles,
    });
    expect(limits.contextWindow).toBe(600_000);
  });

  it('falls back to DEFAULT_CONTEXT_WINDOW when nothing matches', () => {
    const limits = resolveModelLimits({ model: 'unknown-model' });
    expect(limits.contextWindow).toBe(200_000);
  });

  it("treats source='user' on the profile-auto field as user-set (beats registry)", () => {
    const limits = resolveModelLimits({
      model: ANTHROPIC_REGISTRY_MODEL,
      profileContextWindow: 800_000,
      profileContextWindowSource: 'user',
    });
    expect(limits.contextWindow).toBe(800_000);
  });

  it("treats source='auto' on the profile-auto field as below the registry", () => {
    const limits = resolveModelLimits({
      model: ANTHROPIC_REGISTRY_MODEL,
      profileContextWindow: 800_000,
      profileContextWindowSource: 'auto',
    });
    expect(limits.contextWindow).toBe(ANTHROPIC_REGISTRY_WINDOW);
  });

  it('legacy callers (no source) still treat profileContextWindow as user-set', () => {
    const limits = resolveModelLimits({
      model: ANTHROPIC_REGISTRY_MODEL,
      profileContextWindow: 1_300_000,
    });
    expect(limits.contextWindow).toBe(1_300_000);
  });

  it('user-set 1.5M beats the cross-provider preset (priority 1 over 3)', () => {
    const limits = resolveModelLimits({
      model: PRESET_MODEL,
      profileContextWindow: 1_500_000,
      profileContextWindowSource: 'user',
    });
    expect(limits.contextWindow).toBe(1_500_000);
  });

  it('preset wins over an in-scope profile-auto value (priority 3 over 4)', () => {
    const limits = resolveModelLimits({
      model: PRESET_MODEL,
      profileContextWindow: 720_000,
      profileContextWindowSource: 'auto',
    });
    expect(limits.contextWindow).toBe(PRESET_MODEL_WINDOW);
  });

  it('profile-auto in scope wins over a model-scoped auto-learn from another profile (priority 4 over 5)', () => {
    const profiles: ModelProfile[] = [
      makeProfile({
        id: 'sibling',
        model: 'unknown-model',
        contextWindow: 600_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: 9_000,
      }),
    ];
    const limits = resolveModelLimits({
      model: 'unknown-model',
      profileContextWindow: 720_000,
      profileContextWindowSource: 'auto',
      allProfiles: profiles,
    });
    expect(limits.contextWindow).toBe(720_000);
  });

  it('prefers profile-auto output cap over catalog defaults', () => {
    const limits = resolveModelLimits({
      model: ANTHROPIC_REGISTRY_MODEL,
      profileMaxOutput: 8_192,
      profileMaxOutputSource: 'auto',
    });
    expect(limits.maxOutputTokens).toBe(8_192);
  });

  it('profile-user output cap wins over both profile-auto and catalog defaults', () => {
    const limits = resolveModelLimits({
      model: ANTHROPIC_REGISTRY_MODEL,
      profileMaxOutput: 12_000,
      profileMaxOutputSource: 'user',
      allProfiles: [
        makeProfile({
          id: 'auto-sibling',
          model: ANTHROPIC_REGISTRY_MODEL,
          outputTokensSource: 'auto',
          outputTokensLearnedAt: 10_000,
          lastLearnedOutputTokens: 6_000,
        }),
      ],
    });
    expect(limits.maxOutputTokens).toBe(12_000);
  });
});

/**
 * Stage 4 (260529_fix-learned-context-window): 1m is the reliable default for
 * Opus/Sonnet. Greg: "I think we pretty much always want to be using the 1m
 * version of Opus and Sonnet if available. Can we set that as the default?"
 *
 * These pin the contract at the two pure seams the turn path relies on:
 *
 *  - `agentTurnExecute.ts` enables 1m per turn via
 *    `extendedContextEnabled = modelSupportsExtendedContext(model) || hasThinkingModel`
 *    (NOT gated on the `extendedContext` setting — capability alone enables it).
 *  - `resolveModelLimits` returns the 1M ceiling for these models, both from the
 *    Anthropic registry directly AND via the `extendedContext` doubling branch.
 *
 * If a future model rename or catalog edit drops `supportsExtendedContext` (or a
 * registry ceiling regresses below 1M) for the current Opus/Sonnet, these fail.
 */
describe('Stage 4 — 1m is the default for current Opus/Sonnet', () => {
  // The largest-context Claude variants that must default to 1M.
  const ONE_M_MODELS = ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6'] as const;

  describe('modelSupportsExtendedContext (drives extendedContextEnabled per turn)', () => {
    for (const model of ONE_M_MODELS) {
      it(`${model} supports extended (1m) context`, () => {
        expect(modelSupportsExtendedContext(model)).toBe(true);
      });
      it(`${model}[1m] (suffixed) still reports support`, () => {
        expect(modelSupportsExtendedContext(`${model}[1m]`)).toBe(true);
      });
    }

    it('does NOT enable 1m for non-extended Claude (haiku-4-5)', () => {
      expect(modelSupportsExtendedContext('claude-haiku-4-5')).toBe(false);
    });
  });

  describe('resolveModelLimits returns the 1M ceiling for Opus/Sonnet', () => {
    for (const model of ONE_M_MODELS) {
      // The Anthropic registry already catalogues these at 1M, so even without
      // the extendedContext flag the resolver returns 1M. This is the bare
      // (no-profile, no-flag) default path.
      it(`${model} resolves to 1M with no profile and no extendedContext flag`, () => {
        expect(resolveModelLimits({ model }).contextWindow).toBe(1_000_000);
      });

      // The turn path passes extendedContext: true for these models; pin that it
      // still yields 1M (the doubling branch is a no-op here but must not regress).
      it(`${model} resolves to 1M with extendedContext: true`, () => {
        expect(
          resolveModelLimits({ model, extendedContext: true }).contextWindow,
        ).toBe(1_000_000);
      });
    }
  });
});

describe('getAutoLearnedContextWindowForModel — tiebreak', () => {
  it('returns the most-recently-learned value when multiple profiles match', () => {
    const profiles: ModelProfile[] = [
      makeProfile({
        id: 'older',
        model: 'unknown-model',
        contextWindow: 500_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: 1_000,
      }),
      makeProfile({
        id: 'newer',
        model: 'unknown-model',
        contextWindow: 700_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: 5_000,
      }),
    ];
    const value = getAutoLearnedContextWindowForModel(profiles, 'unknown-model');
    expect(value).toBe(700_000);
  });

  it('ignores profiles whose source is not auto', () => {
    const profiles: ModelProfile[] = [
      makeProfile({
        id: 'user',
        model: 'unknown-model',
        contextWindow: 1_500_000,
        contextWindowSource: 'user',
      }),
    ];
    expect(getAutoLearnedContextWindowForModel(profiles, 'unknown-model')).toBeUndefined();
  });

  it('returns undefined when no profile matches the model id', () => {
    const profiles: ModelProfile[] = [
      makeProfile({
        id: 'p',
        model: 'other-model',
        contextWindow: 800_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: 5_000,
      }),
    ];
    expect(getAutoLearnedContextWindowForModel(profiles, 'unknown-model')).toBeUndefined();
  });

  it('picks the most-recently-learned across three matches at distinct epochs', () => {
    const profiles: ModelProfile[] = [
      makeProfile({
        id: 'oldest',
        model: 'unknown-model',
        contextWindow: 400_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: 1_000,
      }),
      makeProfile({
        id: 'middle',
        model: 'unknown-model',
        contextWindow: 600_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: 5_000,
      }),
      makeProfile({
        id: 'newest',
        model: 'unknown-model',
        contextWindow: 800_000,
        contextWindowSource: 'auto',
        contextWindowLearnedAt: 9_000,
      }),
    ];
    expect(getAutoLearnedContextWindowForModel(profiles, 'unknown-model')).toBe(800_000);
  });
});

describe('getAutoLearnedOutputCapForModel', () => {
  it('returns most-recent auto-learned output cap for matching model', () => {
    const profiles: ModelProfile[] = [
      makeProfile({
        id: 'older-auto',
        model: 'unknown-model',
        outputTokensSource: 'auto',
        outputTokensLearnedAt: 1_000,
        lastLearnedOutputTokens: 16_384,
      }),
      makeProfile({
        id: 'newer-auto',
        model: 'unknown-model',
        outputTokensSource: 'auto',
        outputTokensLearnedAt: 5_000,
        lastLearnedOutputTokens: 8_192,
      }),
      makeProfile({
        id: 'user',
        model: 'unknown-model',
        outputTokensSource: 'user',
        maxOutputTokens: 32_768,
      }),
    ];

    expect(getAutoLearnedOutputCapForModel(profiles, 'unknown-model')).toBe(8_192);
  });
});

describe('extended-context predicate parity (F1, STAGE0)', () => {
  // Two extended-context predicates exist:
  //   - isExtendedContextModel()        (modelLimits.ts; catalog + getCatalogCapabilityForModel,
  //                                       incl. normalizeForCapabilityCheck — strips the `anthropic/`
  //                                       dialect prefix + dated suffix — and a legacy-regex fallback).
  //                                       This is the resolver `resolveModelLimits` itself uses to
  //                                       gate the 1M window, and the SSOT this Stage adopts.
  //   - modelSupportsExtendedContext()  (modelNormalization.ts). Since the capability/visibility
  //                                       decouple (260618) it resolves from the catalog capability set
  //                                       EXTENDED_CONTEXT_MODEL_IDS (anthropic rows with
  //                                       supportsExtendedContext, INDEPENDENT of isMainModel / picker
  //                                       visibility), with `[1m]`-strip + `provider/`-strip + dot→dash
  //                                       normalization. (It used to resolve from the isMainModel-
  //                                       filtered MODEL_OPTIONS, which conflated visibility with
  //                                       capability — hiding a model silently dropped its 1M support.)
  //
  // Because BOTH now derive from the same catalog `supportsExtendedContext` capability, they CONVERGE:
  // they agree over direct-Anthropic ids, over OR-dialect ids (`anthropic/claude-*`, via prefix-strip),
  // AND over HIDDEN-but-capable rows (e.g. the withdrawn Fable, isMainModel:false) — capability is no
  // longer dropped by hiding a model. This block pins that convergence; the earlier F1 "intentional
  // divergence" for OR-dialect rows is resolved (see the converged test below).
  const DIRECT_ANTHROPIC_MAIN_IDS = MODEL_CATALOG.filter(
    (e) => e.provider === 'anthropic' && e.isMainModel,
  ).map((e) => e.id);

  it('has at least one direct-Anthropic main model to compare', () => {
    expect(DIRECT_ANTHROPIC_MAIN_IDS.length).toBeGreaterThan(0);
  });

  for (const id of DIRECT_ANTHROPIC_MAIN_IDS) {
    it(`agrees on direct-Anthropic main model '${id}' (bare + [1m])`, () => {
      expect(isExtendedContextModel(id)).toBe(modelSupportsExtendedContext(id));
      expect(isExtendedContextModel(`${id}[1m]`)).toBe(modelSupportsExtendedContext(`${id}[1m]`));
    });
  }

  it('converged (Greg 260614 "1M by default always"): both predicates grant 1M to OR-routed Anthropic', () => {
    // Capability follows the underlying model, not the route. OR-dialect Anthropic ids
    // (`anthropic/claude-opus-4-8`) now resolve to extended-context on BOTH predicates:
    // isExtendedContextModel via catalog prefix-strip, modelSupportsExtendedContext via the
    // provider-prefix strip added to the MODEL_OPTIONS match.
    const orDialectExtended = MODEL_CATALOG.filter(
      (e) =>
        e.provider === 'openrouter' &&
        e.id.startsWith('anthropic/') &&
        // The underlying direct-provider row supports 1M (so the strip-and-resolve sees true).
        // NB: this now holds for HIDDEN rows too (e.g. the withdrawn Fable, isMainModel:false):
        // modelSupportsExtendedContext resolves capability from the catalog, not the
        // visibility-filtered MODEL_OPTIONS, so capability ⟺ isExtendedContextModel regardless
        // of picker visibility. (Earlier this was scoped to offered rows to dodge the conflation;
        // the decouple removed the need.)
        isExtendedContextModel(e.id),
    );
    // If this fixture empties (e.g. the catalog drops all OR-Anthropic rows), surface it.
    expect(
      orDialectExtended.length,
      'expected at least one OR-dialect anthropic/ row resolving to extended-context',
    ).toBeGreaterThan(0);
    for (const entry of orDialectExtended) {
      expect(isExtendedContextModel(entry.id)).toBe(true);
      expect(modelSupportsExtendedContext(entry.id)).toBe(true);
      // and with the [1m] suffix already applied
      expect(modelSupportsExtendedContext(`${entry.id}[1m]`)).toBe(true);
    }
  });

  it('does NOT grant 1M to non-Anthropic OpenRouter ids (no false positive from prefix-strip)', () => {
    // Stripping the `provider/` segment must not make e.g. openai/deepseek OR ids match the
    // Anthropic-only MODEL_OPTIONS. Pick OR rows that are NOT extended-context-capable.
    const nonAnthropicOr = MODEL_CATALOG.filter(
      (e) => e.provider === 'openrouter' && !e.id.startsWith('anthropic/'),
    );
    for (const entry of nonAnthropicOr) {
      expect(modelSupportsExtendedContext(entry.id)).toBe(false);
    }
  });
});

describe('always-on-thinking predicate parity (F4, STAGE0)', () => {
  // Two always-on-thinking predicates exist, kept separate BY DESIGN (different semantic contexts):
  //   - isAlwaysOnThinkingModel()        (modelLimits.ts) — feeds the wire-shape sanitizers; src/shared
  //                                        must not import it. Resolves via the alias map only.
  //   - isAlwaysOnThinkingCatalogModel() (modelCatalog.ts) — feeds cost-consent on src/shared surfaces;
  //                                        additionally resolves openRouter.legacyIds + the sdkModel hop.
  // The catalog one can in principle see OR-shaped spellings the core one misses, but over every
  // current catalog entry id they AGREE. This block pins that agreement so a divergence surfaces
  // loudly (a model that one path treats as always-on and the other does not would mis-shape the
  // wire OR mis-gate cost consent). See STAGE0_PLAN.md (Step 6) + both docstrings.
  for (const entry of MODEL_CATALOG) {
    it(`agrees on '${entry.id}'`, () => {
      expect(isAlwaysOnThinkingModel(entry.id)).toBe(isAlwaysOnThinkingCatalogModel(entry.id));
    });
  }

  it('agrees on the [1m] suffixed spelling of an always-on model', () => {
    const alwaysOn = MODEL_CATALOG.find((e) => e.thinkingAlwaysOn === true);
    expect(alwaysOn, 'expected at least one thinkingAlwaysOn catalog entry').toBeDefined();
    if (!alwaysOn) return;
    expect(isAlwaysOnThinkingModel(`${alwaysOn.id}[1m]`)).toBe(
      isAlwaysOnThinkingCatalogModel(`${alwaysOn.id}[1m]`),
    );
  });
});

describe('sampling-params-forbidden predicate', () => {
  it.each([
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-fable-5',
  ])('returns true for %s', (model) => {
    expect(isSamplingParamsForbiddenModel(model)).toBe(true);
  });

  it.each([
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ])('returns false for %s', (model) => {
    expect(isSamplingParamsForbiddenModel(model)).toBe(false);
  });
});

describe('sampling-params-forbidden predicate parity', () => {
  for (const entry of MODEL_CATALOG) {
    it(`agrees on '${entry.id}'`, () => {
      expect(isSamplingParamsForbiddenModel(entry.id)).toBe(
        isSamplingParamsForbiddenCatalogModel(entry.id),
      );
    });
  }
});
