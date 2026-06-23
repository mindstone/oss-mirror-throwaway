import { describe, expect, it, vi } from 'vitest';

import type { ActiveProvider } from '@shared/types/settings';
import type { ProfileConnectivityState } from '@shared/utils/connectivityHelpers';
import { PROVIDER_CATALOGS, normalizeCatalogModelId } from '@shared/data/providerCatalogs';
import type { CatalogProviderType } from '@shared/data/providerCatalogs';
import { normalizeModelId as canonicalizeCatalogId } from '@shared/data/modelCatalog';

import { isProviderConnectionLive } from '@shared/utils/connectivityHelpers';
import type { ModelProviderType } from '@shared/types';

import { recommendModels, compareRecommendationRanking } from './recommendModels';
import type { RankingFacts } from './recommendModels';
import type { RecommendationInput, RecommendationResult, RecommendedModel } from './types';
import { getRecommendationMetadata } from './recommendationMetadata';
import { isRecommendationExcluded } from './recommendationExclusions';
import * as exclusionsModule from './recommendationExclusions';

/** Captured BEFORE any spy so the synthetic-unaccounted test can delegate to it. */
const realIsExcluded = exclusionsModule.isRecommendationExcluded;

// ---------------------------------------------------------------------------
// Builders + helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: {
  activeProvider?: ActiveProvider | undefined;
  connectivity?: ProfileConnectivityState;
  managedAllowedModels?: readonly string[];
  options?: RecommendationInput['options'];
}): RecommendationInput {
  return {
    activeProvider: overrides.activeProvider,
    connectivity: overrides.connectivity ?? {},
    managedAllowedModels: overrides.managedAllowedModels ?? [],
    options: overrides.options,
  };
}

const NOTHING = makeInput({ activeProvider: undefined, connectivity: {} });
const CODEX = makeInput({ activeProvider: 'codex', connectivity: { codexConnected: true } });
const OR_ONLY = makeInput({ activeProvider: 'openrouter', connectivity: { openRouterConnected: true } });
const ANTHROPIC_ONLY = makeInput({ activeProvider: 'anthropic', connectivity: { hasAnthropicAuth: true } });
const ALL_CONNECTED = makeInput({
  activeProvider: 'codex',
  connectivity: {
    codexConnected: true,
    openRouterConnected: true,
    hasAnthropicAuth: true,
    hasGeminiAuth: true,
  },
});

const ALL_PROVIDERS: (ActiveProvider | undefined)[] = [
  'anthropic',
  'openrouter',
  'codex',
  'mindstone',
  undefined,
];

const ALL_CONNECTIVITY: ProfileConnectivityState[] = [
  {},
  { hasAnthropicAuth: true },
  { codexConnected: true },
  { openRouterConnected: true },
  { openRouterConnected: true, hasAnthropicAuth: true },
  { codexConnected: true, openRouterConnected: true, hasAnthropicAuth: true, hasGeminiAuth: true },
];

function families(result: RecommendationResult): string[] {
  return result.recommended.map((m) => m.family);
}

function buckets(result: RecommendationResult): string[] {
  return result.recommended.map((m) => m.bucket);
}

function find(result: RecommendationResult, predicate: (m: RecommendedModel) => boolean) {
  return result.recommended.find(predicate);
}

// ---------------------------------------------------------------------------
// (a) Subscription flip — codex-connected ⇒ GPT-5.5 effective-flat ranks above
//     a raw-USD peer.
// ---------------------------------------------------------------------------

describe('subscription flip (a)', () => {
  it('codex-connected ⇒ GPT-5.5 is flat AND wins the intelligence slot over raw-USD peers', () => {
    const result = recommendModels(CODEX);
    const intelligence = find(result, (m) => m.bucket === 'intelligence');
    expect(intelligence?.family).toBe('gpt');
    expect(intelligence?.effectiveCost).toEqual({ kind: 'flat' });
    // The first pick overall is the intelligence slot.
    expect(result.recommended[0]?.family).toBe('gpt');
  });

  it('codexConnected:false keeps GPT-5.5 paid even with activeProvider:codex (negative)', () => {
    const result = recommendModels(
      makeInput({ activeProvider: 'codex', connectivity: { codexConnected: false } }),
    );
    const gpt = find(result, (m) => m.family === 'gpt');
    // Bare gpt-5.5 with codex disconnected stays pay-per-use.
    if (gpt) expect(gpt.effectiveCost.kind).toBe('paid');
  });

  it('a flat GPT-5.5 ranks above a paid Claude Opus peer of the same (frontier) tier', () => {
    const result = recommendModels(CODEX);
    const gptIdx = result.recommended.findIndex((m) => m.family === 'gpt');
    const opusIdx = result.recommended.findIndex((m) => m.family === 'claude-opus');
    expect(gptIdx).toBeGreaterThanOrEqual(0);
    if (opusIdx >= 0) expect(gptIdx).toBeLessThan(opusIdx);
  });
});

// ---------------------------------------------------------------------------
// (b) No duplicate family.
// ---------------------------------------------------------------------------

describe('family dedup (b)', () => {
  it('never returns two picks from the same family — across the full matrix', () => {
    for (const activeProvider of ALL_PROVIDERS) {
      for (const connectivity of ALL_CONNECTIVITY) {
        for (const managedAllowedModels of [[], ['openai/gpt-5.5', 'deepseek/deepseek-v4-flash']]) {
          const result = recommendModels(
            makeInput({ activeProvider, connectivity, managedAllowedModels, options: { includeMiddle: true, includeSecondIntelligent: true } }),
          );
          const fams = families(result);
          expect(new Set(fams).size).toBe(fams.length);
        }
      }
    }
  });

  it('best-form-selection: a family with bare + slash rows yields exactly one pick', () => {
    // OR + codex both connected — GPT exists as bare (codex/subscription) AND slash (pool).
    const result = recommendModels(
      makeInput({ activeProvider: 'codex', connectivity: { codexConnected: true, openRouterConnected: true } }),
    );
    expect(result.recommended.filter((m) => m.family === 'gpt')).toHaveLength(1);
    // The surviving GPT form is the flat (codex) one, not the metered (pool) one.
    expect(find(result, (m) => m.family === 'gpt')?.effectiveCost).toEqual({ kind: 'flat' });
  });

  it('best-form-selection precedence is availability-class → familyRank → effective-cost (Stage 3, DECISION B)', () => {
    // REWRITTEN for Stage 3 (DECISION G): the claude-opus family now carries two
    // VERSIONS (4.7 + 4.8) each in two routing forms. Anthropic-only ⇒ both bare
    // (api-key) rows are usable-now+`paid`; both slash (OpenRouter pool) rows are
    // `metered` (cheaper-kind) but needs-connection (OR not connected).
    //
    // The dedup precedence is now: availability class FIRST (usable-now beats
    // needs-connection — so the usable-now bare form survives EVEN THOUGH the
    // needs-connection slash form is the cheaper effective-cost kind: a cost-first
    // rule would have kept the metered slash form), THEN familyRank within that
    // class (4.8 > 4.7 — the LATEST usable version wins), THEN effective cost.
    const result = recommendModels(ANTHROPIC_ONLY);
    const opus = find(result, (m) => m.family === 'claude-opus');
    expect(opus).toBeDefined();
    // Availability-first: the usable-now bare row survives over the cheaper-kind
    // (metered) needs-connection slash form.
    expect(opus!.availability).toBe('usable-now');
    expect(opus!.effectiveCost.kind).toBe('paid'); // the bare/api-key form, not the metered pool slash form
    expect(opus!.catalogKey.routeSurface).toBe('api-key');
    // familyRank within the usable-now class: the LATEST version (4.8) is the survivor.
    expect(opus!.modelId).toBe('claude-opus-4-8');
  });
});

// ---------------------------------------------------------------------------
// (c) Never empty.
// ---------------------------------------------------------------------------

describe('never empty (c)', () => {
  it('returns a non-empty set even when nothing is connected', () => {
    const result = recommendModels(NOTHING);
    expect(result.recommended.length).toBeGreaterThan(0);
    // All picks are needs-connection (nothing usable yet).
    expect(result.recommended.every((m) => m.availability === 'needs-connection')).toBe(true);
    expect(result.rationale.notes.join(' ')).toMatch(/No provider connected/i);
  });

  it('is non-empty across the entire provider × connectivity matrix', () => {
    for (const activeProvider of ALL_PROVIDERS) {
      for (const connectivity of ALL_CONNECTIVITY) {
        const result = recommendModels(makeInput({ activeProvider, connectivity }));
        expect(result.recommended.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (d) Vision coverage — including the negative case (a separate vision pick when
//     the cheap model lacks vision).
// ---------------------------------------------------------------------------

describe('vision coverage (d)', () => {
  it('always fills a vision pick whose model is vision-capable', () => {
    for (const input of [NOTHING, CODEX, OR_ONLY, ANTHROPIC_ONLY, ALL_CONNECTED]) {
      const result = recommendModels(input);
      const vision = find(result, (m) => m.bucket === 'vision');
      // A vision slot is filled (no warning) and the model isn't a verified text-only one.
      const visionWarn = result.diagnostics.warnings.some((w) => /vision/i.test(w));
      expect(visionWarn).toBe(false);
      expect(vision).toBeDefined();
      const meta = getRecommendationMetadata(vision!.optionValue) ?? getRecommendationMetadata(vision!.modelId);
      expect(meta?.visionStrength).not.toBe('none');
    }
  });

  it('negative: the cheap pick can be a text-only model — a SEPARATE vision pick still appears', () => {
    // OR-only: cheapest capable rows include text-only DeepSeek; vision must be a
    // distinct pick from a vision-capable family.
    const result = recommendModels(OR_ONLY);
    const cheap = find(result, (m) => m.bucket === 'cheap');
    const vision = find(result, (m) => m.bucket === 'vision');
    expect(cheap).toBeDefined();
    expect(vision).toBeDefined();
    expect(vision!.family).not.toBe(cheap!.family);
    // At least one of the cheap picks in the matrix is genuinely text-only,
    // proving the vision slot is filled independently.
    const cheapMeta = getRecommendationMetadata(cheap!.optionValue) ?? getRecommendationMetadata(cheap!.modelId);
    const visionMeta = getRecommendationMetadata(vision!.optionValue) ?? getRecommendationMetadata(vision!.modelId);
    expect(visionMeta?.visionStrength).not.toBe('none');
    // Guard the intended negative shape: DeepSeek (text-only) commonly fills cheap.
    if (cheap!.family === 'deepseek') {
      expect(cheapMeta?.visionStrength).toBe('none');
    }
  });
});

// ---------------------------------------------------------------------------
// (e) Editorial / provenance treatment — eval-grounded beats editorial on the
//     same axis (DECISION D), plus the 3 carve-out tests.
// ---------------------------------------------------------------------------

describe('provenance load-bearing + carve-out (e / DECISION D)', () => {
  it('latest-in-family: Opus-4.8 wins the claude-opus slot with HONEST editorial provenance + inherited frontier tier (Stage 3, DECISIONS B/C/D)', () => {
    // REWRITTEN for Stage 3 (DECISION G): the OLD assertion (eval-grounded 4.7 beats
    // editorial 4.8) encoded the intended PRE-Fix-3 behaviour, now superseded. Greg
    // wants the LATEST available version. Anthropic-only, no subscription: every
    // Claude is pay-per-use. The claude-opus survivor is now 4.8 (latest, usable-now),
    // ranked at the lineage's inherited PROVEN frontier tier — but its EMITTED
    // provenance stays the honest `editorial` (the inheritance lives in the selector's
    // RankingFacts, never on the row's metadata/output).
    const result = recommendModels(ANTHROPIC_ONLY);
    const opus = find(result, (m) => m.family === 'claude-opus');
    expect(opus?.modelId).toBe('claude-opus-4-8');
    // HONEST emitted provenance — NOT rewritten to eval-grounded (DECISION C).
    expect(opus?.provenance).toBe('editorial');
    // The inherited frontier ranking tier lets 4.8 take the intelligence slot.
    expect(opus?.bucket).toBe('intelligence');
    // The metadata proof source is auditable.
    expect(getRecommendationMetadata('claude-opus-4-8')?.provenTierSourceCatalogId).toBe(
      'claude-opus-4-7',
    );

    // Fable half UNCHANGED (DECISION D): editorial Fable (no same-family eval-grounded
    // sibling ⇒ no inheritance) is never picked ahead of the inherited-frontier Opus
    // for the first intelligence slot.
    const intelligence = result.recommended.filter((m) => m.bucket === 'intelligence');
    const fable = intelligence.find((m) => m.family === 'claude-fable');
    if (fable) {
      expect(result.recommended[0]?.family).toBe('claude-opus');
    }
  });

  // The 3 dedicated carve-out tests exercise the load-bearing sort key directly
  // (`compareRecommendationRanking`). Note (findings): in the CURRENT catalog/billing
  // model the carve-out essentially never fires through the public selector — the only
  // `flat` path for an editorial family (Gemini/Fable) is mindstone-active, which makes
  // EVERY slash row flat (so the eval-grounded peer is flat too → no fire). The
  // comparator is nonetheless exercised directly so the rule is correct if a future
  // subscription covers an editorial family but not an eval-grounded peer.
  const editorial = (cost: RankingFacts['effectiveCost'], tier: RankingFacts['qualityTier'] = 'mid'): RankingFacts => ({
    provenance: 'editorial',
    qualityTier: tier,
    effectiveCost: cost,
    keyString: 'z:editorial',
  });
  const grounded = (cost: RankingFacts['effectiveCost'], tier: RankingFacts['qualityTier'] = 'frontier'): RankingFacts => ({
    provenance: 'eval-grounded',
    qualityTier: tier,
    effectiveCost: cost,
    keyString: 'a:grounded',
  });

  it('(i) monotone: eval-grounded (paid) beats editorial (paid) on the same axis — provenance wins', () => {
    const e = editorial({ kind: 'paid', usd: 1 }, 'frontier');
    const g = grounded({ kind: 'paid', usd: 1 }, 'frontier');
    // grounded (g) sorts first (negative when g is first arg).
    expect(compareRecommendationRanking(g, e)).toBeLessThan(0);
    expect(compareRecommendationRanking(e, g)).toBeGreaterThan(0);
  });

  it('(ii) carve-out FIRES: editorial flat outranks an eval-grounded paid peer', () => {
    const e = editorial({ kind: 'flat' }, 'mid');
    const g = grounded({ kind: 'paid', usd: 1 }, 'frontier');
    // Editorial (e) wins despite worse tier + editorial provenance.
    expect(compareRecommendationRanking(e, g)).toBeLessThan(0);
    expect(compareRecommendationRanking(g, e)).toBeGreaterThan(0);
    // Also fires against a metered (pool) peer.
    const gMetered = grounded({ kind: 'metered' }, 'frontier');
    expect(compareRecommendationRanking(e, gMetered)).toBeLessThan(0);
  });

  it('(iii) carve-out does NOT fire when the editorial model is also paid/metered', () => {
    const ePaid = editorial({ kind: 'paid', usd: 1 }, 'frontier');
    const gPaid = grounded({ kind: 'paid', usd: 1 }, 'frontier');
    expect(compareRecommendationRanking(gPaid, ePaid)).toBeLessThan(0); // provenance wins

    const eMetered = editorial({ kind: 'metered' }, 'frontier');
    const gFlat = grounded({ kind: 'flat' }, 'frontier');
    // editorial is metered (not flat/free) → carve-out does NOT promote it; the
    // cheaper-for-user eval-grounded flat peer wins.
    expect(compareRecommendationRanking(gFlat, eMetered)).toBeLessThan(0);
  });

  it('(iv) availability is a LOW-priority tiebreak: usable-now wins only when tier/provenance/cost all tie', () => {
    // Two same-tier, same-provenance, same-cost candidates differing only in
    // availability — the usable-now one sorts first (negative when it's the first arg).
    const usableNow = grounded({ kind: 'paid', usd: 1 }, 'frontier');
    const needsConn = grounded({ kind: 'paid', usd: 1 }, 'frontier');
    const a: RankingFacts = { ...usableNow, availability: 'usable-now', keyString: 'z:usable' };
    const b: RankingFacts = { ...needsConn, availability: 'needs-connection', keyString: 'a:needs' };
    expect(compareRecommendationRanking(a, b)).toBeLessThan(0);
    expect(compareRecommendationRanking(b, a)).toBeGreaterThan(0);
    // It must NOT override effective cost: a needs-connection cheaper peer still wins.
    const cheaperNeedsConn: RankingFacts = {
      ...grounded({ kind: 'flat' }, 'frontier'),
      availability: 'needs-connection',
      keyString: 'a:flat',
    };
    const pricierUsableNow: RankingFacts = {
      ...grounded({ kind: 'paid', usd: 1 }, 'frontier'),
      availability: 'usable-now',
      keyString: 'z:paid',
    };
    expect(compareRecommendationRanking(cheaperNeedsConn, pricierUsableNow)).toBeLessThan(0);
    // And it must NOT override quality tier: a needs-connection higher-tier peer wins.
    const betterTierNeedsConn: RankingFacts = {
      ...grounded({ kind: 'paid', usd: 1 }, 'frontier'),
      availability: 'needs-connection',
      keyString: 'a:frontier',
    };
    const worseTierUsableNow: RankingFacts = {
      ...grounded({ kind: 'paid', usd: 1 }, 'strong'),
      availability: 'usable-now',
      keyString: 'z:strong',
    };
    expect(compareRecommendationRanking(betterTierNeedsConn, worseTierUsableNow)).toBeLessThan(0);
  });

  it('through the public API, the first intelligence pick carries an eval-grounded(-equivalent) ranking tier (Stage 3, DECISION C)', () => {
    // RESTATED for Stage 3 (DECISION G): the OLD assertion (provenance:eval-grounded
    // AND modelId:claude-opus-4-7) is superseded — the survivor is now editorial 4.8.
    // The invariant the test guards is unchanged in SPIRIT: the first intelligence
    // pick must rank at a proven (or inherited-proven) level — read via the selector's
    // RankingFacts (effectiveRankingTier / rankingTierBasis), NOT the emitted honest
    // editorial provenance.
    const result = recommendModels(ANTHROPIC_ONLY);
    const firstIntelligence = result.recommended.find((m) => m.bucket === 'intelligence');
    expect(firstIntelligence?.modelId).toBe('claude-opus-4-8');
    // Emitted provenance stays honest editorial (DECISION C).
    expect(firstIntelligence?.provenance).toBe('editorial');
    // The proof source the selector inherits from is a same-family eval-grounded member.
    const proofSourceId = getRecommendationMetadata('claude-opus-4-8')?.provenTierSourceCatalogId;
    expect(proofSourceId).toBe('claude-opus-4-7');
    const proofSource = getRecommendationMetadata(proofSourceId!);
    expect(proofSource?.provenance).toBe('eval-grounded');
    expect(proofSource?.tierBasis).toBe('best-config');
    expect(proofSource?.family).toBe(getRecommendationMetadata('claude-opus-4-8')?.family);
  });
});

// ---------------------------------------------------------------------------
// Stage 3 — latest-available-in-family inherits the proven tier at the selector
// (DECISIONS B / C / D). Positive + negatives.
// ---------------------------------------------------------------------------

describe('latest-in-family selector inheritance (Stage 3, DECISIONS B/C/D)', () => {
  it('POSITIVE: anthropic-only ⇒ claude-opus slot is 4.8, intelligence bucket, honest editorial provenance, proof source 4.7', () => {
    const result = recommendModels(ANTHROPIC_ONLY);
    const opus = find(result, (m) => m.family === 'claude-opus');
    expect(opus?.modelId).toBe('claude-opus-4-8');
    expect(opus?.bucket).toBe('intelligence');
    // Inheritance is internal — the emitted provenance is the honest editorial value.
    expect(opus?.provenance).toBe('editorial');
    expect(opus?.qualityTier).toBe('frontier'); // 4.8's own honest metadata tier (floored)
    expect(getRecommendationMetadata('claude-opus-4-8')?.provenTierSourceCatalogId).toBe(
      'claude-opus-4-7',
    );
    // 4.8 ranks ahead of (or replaces) 4.7 — 4.7 must not also appear (dedup).
    expect(result.recommended.filter((m) => m.family === 'claude-opus')).toHaveLength(1);
  });

  it('NEGATIVE (i, DECISION D): an editorial NEW family (Fable 5 — no same-family eval-grounded sibling) does NOT inherit and does NOT outrank a proven different family', () => {
    // Anthropic-only: Fable 5 (editorial, mid, NO eval-grounded claude-fable sibling)
    // must never become the first intelligence pick ahead of the proven/inherited
    // claude-opus lineage. Its lack of a same-family proof source means the inheritance
    // gate cannot fire (it has no provenTierSourceCatalogId).
    expect(getRecommendationMetadata('claude-fable-5')?.provenTierSourceCatalogId).toBeUndefined();
    const result = recommendModels(ANTHROPIC_ONLY);
    const firstIntelligence = result.recommended.find((m) => m.bucket === 'intelligence');
    expect(firstIntelligence?.family).not.toBe('claude-fable');
    // Fable, if present at all, never outranks the claude-opus pick.
    const fableIdx = result.recommended.findIndex((m) => m.family === 'claude-fable');
    const opusIdx = result.recommended.findIndex((m) => m.family === 'claude-opus');
    if (fableIdx >= 0) {
      expect(opusIdx).toBeGreaterThanOrEqual(0);
      expect(opusIdx).toBeLessThan(fableIdx);
    }
  });

  it('NEGATIVE (ii, DECISION B): a needs-connection latest 4.8 does NOT hide a usable-now predecessor 4.7', () => {
    // Construct the case via the comparator over the route-aware survivor: 4.8 lands
    // needs-connection while 4.7 is usable-now. The dedup MUST keep the usable-now 4.7
    // (availability class beats familyRank), so the surviving claude-opus row is the
    // usable predecessor. We exercise this at the betterForm precedence directly: the
    // ranking comparator must put the usable-now predecessor first when the latest is
    // only reachable via a dead route.
    const usable47: RankingFacts = {
      provenance: 'eval-grounded',
      qualityTier: 'frontier',
      effectiveCost: { kind: 'paid', usd: 1 },
      availability: 'usable-now',
      keyString: 'a:opus-4-7',
    };
    const needs48: RankingFacts = {
      provenance: 'editorial',
      qualityTier: 'frontier',
      effectiveRankingTier: 'frontier',
      rankingTierBasis: 'inherited-eval-grounded',
      effectiveCost: { kind: 'paid', usd: 1 },
      availability: 'needs-connection',
      keyString: 'z:opus-4-8',
    };
    // The usable-now predecessor sorts first (the inheritance-usability carve-out
    // fires: reachable-free? no — both paid. So it falls to the availability tiebreak,
    // which still favours the usable-now row at equal tier/cost).
    expect(compareRecommendationRanking(usable47, needs48)).toBeLessThan(0);
    // And the dedup-level guard: betterForm prefers availability class over familyRank
    // is covered by the public matrix; here we assert the comparator ordering holds.
  });

  it('inheritance gate fires ONLY for an editorial row with a same-family eval-grounded proof source', () => {
    // The comparator: an inherited-eval-grounded editorial frontier ranks ALONGSIDE a
    // genuine eval-grounded frontier (same tier + provenance axis), beating a plain
    // editorial mid peer.
    const inheritedFrontier: RankingFacts = {
      provenance: 'editorial',
      qualityTier: 'frontier',
      effectiveRankingTier: 'frontier',
      rankingTierBasis: 'inherited-eval-grounded',
      effectiveCost: { kind: 'paid', usd: 1 },
      keyString: 'a:inherited',
    };
    const plainEditorialMid: RankingFacts = {
      provenance: 'editorial',
      qualityTier: 'mid',
      effectiveCost: { kind: 'paid', usd: 1 },
      keyString: 'z:editorial-mid',
    };
    expect(compareRecommendationRanking(inheritedFrontier, plainEditorialMid)).toBeLessThan(0);

    // A NON-inherited editorial frontier-tier row (no rankingTierBasis) still loses the
    // provenance axis to a genuine eval-grounded peer of equal tier — inheritance is
    // what flips the provenance-equivalence, and it is gated.
    const nonInheritedEditorialFrontier: RankingFacts = {
      provenance: 'editorial',
      qualityTier: 'frontier',
      effectiveCost: { kind: 'paid', usd: 1 },
      keyString: 'a:plain-editorial-frontier',
    };
    const groundedFrontier: RankingFacts = {
      provenance: 'eval-grounded',
      qualityTier: 'frontier',
      effectiveCost: { kind: 'paid', usd: 1 },
      keyString: 'z:grounded',
    };
    expect(
      compareRecommendationRanking(groundedFrontier, nonInheritedEditorialFrontier),
    ).toBeLessThan(0);
  });

  it('inheritance-usability carve-out: a reachable-free plan row beats an UNREACHABLE inherited-frontier peer (but NOT a genuinely-proven unreachable peer)', () => {
    const reachableMidPlan: RankingFacts = {
      provenance: 'editorial',
      qualityTier: 'mid',
      effectiveCost: { kind: 'flat' },
      availability: 'usable-now',
      keyString: 'a:gemini-pro',
    };
    const unreachableInheritedFrontier: RankingFacts = {
      provenance: 'editorial',
      qualityTier: 'frontier',
      effectiveRankingTier: 'frontier',
      rankingTierBasis: 'inherited-eval-grounded',
      effectiveCost: { kind: 'paid', usd: 1 },
      availability: 'needs-connection',
      keyString: 'z:opus-4-8',
    };
    // The reachable-free plan row wins — restoring the "core buckets filled by
    // reachable plan rows" invariant.
    expect(compareRecommendationRanking(reachableMidPlan, unreachableInheritedFrontier)).toBeLessThan(0);

    // But a GENUINELY-proven (non-inherited eval-grounded) unreachable frontier peer is
    // NOT displaced by a reachable weak row — quality-first fall-through (DECISION F).
    const reachableWeakPlan: RankingFacts = {
      provenance: 'eval-grounded',
      qualityTier: 'background',
      effectiveCost: { kind: 'flat' },
      availability: 'usable-now',
      keyString: 'a:haiku',
    };
    const unreachableGenuineFrontier: RankingFacts = {
      provenance: 'eval-grounded',
      qualityTier: 'frontier',
      effectiveCost: { kind: 'paid', usd: 1 },
      availability: 'needs-connection',
      keyString: 'z:opus-4-7',
    };
    expect(compareRecommendationRanking(unreachableGenuineFrontier, reachableWeakPlan)).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// (f) No unavailable pick mis-projected as usable-now.
// ---------------------------------------------------------------------------

describe('availability integrity (f / j)', () => {
  it("a usable-now pick is always backed by its OWN route being live (not merely 'some connection')", () => {
    for (const activeProvider of ALL_PROVIDERS) {
      for (const connectivity of ALL_CONNECTIVITY) {
        const result = recommendModels(
          makeInput({ activeProvider, connectivity, managedAllowedModels: ['openai/gpt-5.5'] }),
        );
        for (const pick of result.recommended) {
          if (pick.availability !== 'usable-now') continue;
          // Mindstone-active managed (openrouter pool) rows route via the managed key,
          // so they are usable-now without a personal connection on that route.
          const mindstoneManaged =
            activeProvider === 'mindstone' && pick.catalogKey.providerType === 'openrouter';
          if (mindstoneManaged) continue;
          // Otherwise the pick's OWN route must be live — a Google row must NOT be
          // usable-now when only Anthropic is connected. This guards route-specificity,
          // not merely "any connection exists".
          const ownRouteLive = isProviderConnectionLive(
            pick.catalogKey.providerType as ModelProviderType,
            pick.catalogKey.routeSurface,
            connectivity,
          );
          expect(ownRouteLive).toBe(true);
        }
      }
    }
  });

  it('a non-active route is never usable-now: anthropic-only ⇒ no google/codex/openrouter usable-now pick', () => {
    const result = recommendModels(
      makeInput({ activeProvider: 'anthropic', connectivity: { hasAnthropicAuth: true } }),
    );
    for (const pick of result.recommended) {
      if (pick.catalogKey.providerType === 'anthropic') continue;
      // Every non-anthropic route is unreachable here, so it can't be usable-now.
      expect(pick.availability).not.toBe('usable-now');
    }
  });

  it('nothing-connected never yields a usable-now pick', () => {
    const result = recommendModels(NOTHING);
    expect(result.recommended.some((m) => m.availability === 'usable-now')).toBe(false);
  });

  // Fix 2 (Stage 2): a live PERSONAL route beats a managed shadow. A managed-listed
  // model reachable via the user's own (live) OpenRouter connection is usable-now even
  // off-Mindstone — before the fix it was wrongly marked on-plan (managed membership
  // shadowed the live personal route).
  it('Fix 2: a managed-listed model with a LIVE personal route is usable-now (not on-plan), off-mindstone', () => {
    const result = recommendModels(
      makeInput({
        activeProvider: 'codex',
        connectivity: { codexConnected: true, openRouterConnected: true },
        managedAllowedModels: ['deepseek/deepseek-v4-flash'],
        options: { includeMiddle: true },
      }),
    );
    const flash = find(result, (m) => m.modelId.includes('deepseek-v4-flash'));
    expect(flash).toBeDefined();
    expect(flash!.catalogKey.providerType).toBe('openrouter');
    expect(flash!.availability).toBe('usable-now');
    // No managed-listed row should read on-plan when its personal route is live.
    expect(flash!.availability).not.toBe('on-plan');
  });

  it('Fix 2 negative: a managed-listed model with NO live personal route stays on-plan, off-mindstone', () => {
    const result = recommendModels(
      makeInput({
        activeProvider: 'codex',
        connectivity: { codexConnected: true }, // OpenRouter NOT connected
        managedAllowedModels: ['deepseek/deepseek-v4-flash'],
        options: { includeMiddle: true },
      }),
    );
    const flash = find(result, (m) => m.modelId.includes('deepseek-v4-flash'));
    expect(flash).toBeDefined();
    expect(flash!.catalogKey.providerType).toBe('openrouter');
    // Dead personal route + off-mindstone ⇒ managed shadow applies ⇒ on-plan, never usable-now.
    expect(flash!.availability).toBe('on-plan');
  });
});

// ---------------------------------------------------------------------------
// (g) Determinism.
// ---------------------------------------------------------------------------

describe('determinism (g)', () => {
  it('produces a deep-equal result when run twice', () => {
    for (const activeProvider of ALL_PROVIDERS) {
      for (const connectivity of ALL_CONNECTIVITY) {
        const input = makeInput({ activeProvider, connectivity, options: { includeMiddle: true, includeSecondIntelligent: true } });
        expect(recommendModels(input)).toEqual(recommendModels(input));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (h) Managed-ready but activeProvider !== 'mindstone' ⇒ on-plan AND a complete
//     usable-now set still produced from the active side.
// ---------------------------------------------------------------------------

describe('managed footgun guard (h)', () => {
  it('off-mindstone managed rows are on-plan (never usable-now) AND the active side still produces usable-now picks', () => {
    const result = recommendModels(
      makeInput({
        activeProvider: 'codex',
        connectivity: { codexConnected: true },
        managedAllowedModels: ['openai/gpt-5.5', 'deepseek/deepseek-v4-flash', 'anthropic/claude-haiku-4-5'],
      }),
    );
    // No managed (openrouter pool) row is usable-now off-mindstone.
    const managedRows = result.recommended.filter(
      (m) => m.catalogKey.providerType === 'openrouter',
    );
    for (const row of managedRows) {
      expect(row.availability).not.toBe('usable-now');
    }
    // But the active (codex) side still yields a usable-now intelligence pick.
    expect(result.recommended.some((m) => m.availability === 'usable-now')).toBe(true);
  });

  it('on-mindstone, managed rows become usable-now', () => {
    const result = recommendModels(
      makeInput({
        activeProvider: 'mindstone',
        connectivity: { openRouterConnected: true },
        managedAllowedModels: ['openai/gpt-5.5', 'deepseek/deepseek-v4-flash'],
      }),
    );
    expect(result.recommended.some((m) => m.availability === 'usable-now')).toBe(true);
    expect(result.recommended.some((m) => m.availability === 'on-plan')).toBe(false);
  });

  // F1 (Stage 5): the only-Mindstone scenario must NOT float non-allowlisted
  // OpenRouter slash rows above the usable plan rows. Before the fix, the billing
  // helper priced EVERY slash row `flat` under mindstone, so quality-first ranking
  // put high-quality-but-unusable rows (Opus-4-7, Sonnet, Kimi, DeepSeek-Pro) into
  // the core buckets ahead of the genuine plan rows. After the fix, non-allowlisted
  // slash rows are priced as the route the user would actually need
  // (pay-per-use / pool), so the core buckets are filled by plan-USABLE rows when
  // the allow-list can satisfy them.
  it('only-Mindstone: the core picks are plan-usable when the allow-list can satisfy the buckets (F1)', () => {
    const result = recommendModels(
      makeInput({
        activeProvider: 'mindstone',
        connectivity: {},
        // Mirrors evals/fixtures/recommended-models/01_only-mindstone.json: the
        // allow-list covers intelligence (GPT-5.5), cheap (DeepSeek Flash), and a
        // vision model (Gemini Pro).
        managedAllowedModels: [
          'openai/gpt-5.5',
          'deepseek/deepseek-v4-flash',
          'anthropic/claude-haiku-4-5',
          'google/gemini-3.1-pro-preview',
        ],
        options: { includeMiddle: true },
      }),
    );

    // No non-allowlisted slash row may be priced `flat` (the F1 defect).
    const allowSet = new Set(
      ['openai/gpt-5.5', 'deepseek/deepseek-v4-flash', 'anthropic/claude-haiku-4-5', 'google/gemini-3.1-pro-preview'].map(
        (id) => normalizeCatalogModelId(id),
      ),
    );
    for (const m of result.recommended) {
      const normalized = normalizeCatalogModelId(m.optionValue);
      if (m.catalogKey.providerType === 'openrouter' && !allowSet.has(normalized)) {
        expect(m.effectiveCost.kind).not.toBe('flat');
        expect(m.availability).not.toBe('usable-now');
      }
    }

    // The core buckets (intelligence / cheap / vision) the allow-list CAN satisfy
    // are filled by plan-usable rows (usable-now + flat), not crowded out.
    for (const bucket of ['intelligence', 'cheap', 'vision'] as const) {
      const pick = result.recommended.find((m) => m.bucket === bucket);
      expect(pick, `expected a ${bucket} pick`).toBeDefined();
      expect(pick!.availability).toBe('usable-now');
      expect(pick!.effectiveCost.kind).toBe('flat');
    }

    // Every usable-now pick is a flat plan row (no metered/paid usable row sneaks in).
    const usable = result.recommended.filter((m) => m.availability === 'usable-now');
    expect(usable.every((m) => m.effectiveCost.kind === 'flat')).toBe(true);
  });

  it('only-Mindstone: a bucket with no allowlisted model gracefully falls to needs-connection (scope guardrail)', () => {
    // Allow-list has NO vision model (Haiku is vision-none in the seed) — the vision
    // slot must fall to a needs-connection editorial/eval row, NOT crash and NOT be
    // a flat unusable row.
    const result = recommendModels(
      makeInput({
        activeProvider: 'mindstone',
        connectivity: {},
        managedAllowedModels: ['openai/gpt-5.5', 'deepseek/deepseek-v4-flash', 'anthropic/claude-haiku-4-5'],
        options: { includeMiddle: true },
      }),
    );
    const vision = result.recommended.find((m) => m.bucket === 'vision');
    expect(vision).toBeDefined();
    expect(vision!.availability).toBe('needs-connection');
    expect(vision!.effectiveCost.kind).not.toBe('flat');
  });
});

// ---------------------------------------------------------------------------
// Cap + options behaviour.
// ---------------------------------------------------------------------------

describe('cap + options', () => {
  it('respects the default cap of 6', () => {
    expect(recommendModels(ALL_CONNECTED).recommended.length).toBeLessThanOrEqual(6);
  });

  it('respects an explicit cap', () => {
    const result = recommendModels(makeInput({ activeProvider: 'codex', connectivity: { codexConnected: true }, options: { cap: 3 } }));
    expect(result.recommended.length).toBeLessThanOrEqual(3);
    // The three core buckets are prioritised.
    expect(buckets(result)).toEqual(expect.arrayContaining(['intelligence', 'cheap', 'vision']));
  });

  it('includeSecondIntelligent adds a 2nd cross-family intelligence pick', () => {
    const withSecond = recommendModels(makeInput({ activeProvider: 'openrouter', connectivity: { openRouterConnected: true }, options: { includeSecondIntelligent: true } }));
    const intel = withSecond.recommended.filter((m) => m.bucket === 'intelligence');
    expect(intel.length).toBeGreaterThanOrEqual(2);
    // The two intelligence picks are from different families.
    expect(new Set(intel.map((m) => m.family)).size).toBe(intel.length);
  });

  it('includeMiddle adds a middle pick when cap allows', () => {
    const result = recommendModels(makeInput({ activeProvider: 'openrouter', connectivity: { openRouterConnected: true }, options: { includeMiddle: true } }));
    expect(buckets(result)).toContain('middle');
  });

  it('cap:0 returns an empty set with no crash', () => {
    const result = recommendModels(makeInput({ activeProvider: 'codex', connectivity: { codexConnected: true }, options: { cap: 0 } }));
    expect(result.recommended).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Diagnostics (PURE — engine never logs).
// ---------------------------------------------------------------------------

describe('diagnostics', () => {
  it('records a managed allow-list id with no catalog entry as unmatched (caller logs)', () => {
    const result = recommendModels(
      makeInput({ activeProvider: 'mindstone', connectivity: {}, managedAllowedModels: ['some/unknown-model-9'] }),
    );
    expect(result.diagnostics.unmatched).toHaveLength(1);
    expect(result.diagnostics.unmatched[0]).toMatchObject({
      modelId: 'some/unknown-model-9',
      source: 'managed-allow-list',
    });
    // Known ids do not produce unmatched records.
    const clean = recommendModels(
      makeInput({ activeProvider: 'mindstone', connectivity: {}, managedAllowedModels: ['openai/gpt-5.5'] }),
    );
    expect(clean.diagnostics.unmatched).toHaveLength(0);
  });

  it('does NOT emit the carve-out note when no carve-out fired (truthful note — Claude-F2)', () => {
    // codex-connected: GPT-5.5 is `flat` (effectively-free) and fills a slot, but it
    // is eval-grounded and won on tier/cost, NOT via the editorial-vs-eval carve-out.
    // The old always-on note fired on any effectively-free pick (factually false for
    // every subscription user); the truthful note must stay silent here.
    const result = recommendModels(CODEX);
    expect(result.recommended.some((m) => m.effectiveCost.kind === 'flat')).toBe(true);
    expect(result.rationale.notes.join(' ')).not.toMatch(/carve-out|Subscription-preference/i);

    // On-mindstone with ONLY the managed allow-list (no personal OR token), the
    // picks the allow-list can satisfy are all flat AND there is no usable
    // eval-grounded paid/metered peer to lose to — so no carve-out fires. (F1:
    // non-allowlisted slash rows are now needs-connection, so they don't crowd in
    // as usable peers.)
    const onMindstone = recommendModels(
      makeInput({
        activeProvider: 'mindstone',
        connectivity: {},
        managedAllowedModels: ['openai/gpt-5.5', 'deepseek/deepseek-v4-flash', 'anthropic/claude-haiku-4-5'],
      }),
    );
    // All usable-now picks must be flat (effectively-free plan rows).
    const usable = onMindstone.recommended.filter((m) => m.availability === 'usable-now');
    expect(usable.length).toBeGreaterThan(0);
    expect(usable.every((m) => m.effectiveCost.kind === 'flat')).toBe(true);
  });

  it('emits a SelectorTrace pick entry for every recommendation', () => {
    const result = recommendModels(CODEX);
    expect(result.rationale.picks).toHaveLength(result.recommended.length);
    for (const pick of result.rationale.picks) {
      expect(pick.reason.length).toBeGreaterThan(0);
    }
  });

  // F2 (Stage 5): a row with an explicit exclusion record is ACCOUNTED FOR and must
  // NOT be reported as missing metadata. Before the fix, every no-metadata row
  // (prior GPTs, Grok, o3, etc.) landed in `missingMetadata`, burying real drift for
  // a future logging consumer (DECISION E). The inverted rot-guard proves every
  // addable catalog row has metadata OR an exclusion, so across ALL provider/
  // connectivity states `missingMetadata` must be empty.
  it('missingMetadata is empty in normal scenarios — explicit exclusions are NOT false positives (F2)', () => {
    for (const activeProvider of ALL_PROVIDERS) {
      for (const connectivity of ALL_CONNECTIVITY) {
        const result = recommendModels(
          makeInput({ activeProvider, connectivity, managedAllowedModels: ['openai/gpt-5.5'] }),
        );
        expect(
          result.diagnostics.missingMetadata,
          `missingMetadata should be empty for ${activeProvider}/${JSON.stringify(connectivity)}`,
        ).toEqual([]);
      }
    }
  });

  // F2 (the diagnostic still WORKS): a genuinely-unaccounted row (no metadata AND no
  // exclusion) must still surface in `missingMetadata`. We simulate an unaccounted
  // catalog row by making one currently-excluded id (gpt-5.4) read as NOT excluded —
  // it then becomes a true omission and the diagnostic correctly reports it.
  it('a truly-unaccounted row (no metadata, no exclusion) DOES appear in missingMetadata (F2)', () => {
    const spy = vi
      .spyOn(exclusionsModule, 'isRecommendationExcluded')
      .mockImplementation((id: string) => id !== 'gpt-5.4' && realIsExcluded(id));
    try {
      const result = recommendModels(CODEX);
      expect(result.diagnostics.missingMetadata).toContain('gpt-5.4');
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Inverted catalog-rot guard (DECISION E) — the real "did someone add a model
// without curating it" guard. Enumerates every addable PROVIDER_CATALOGS row and
// requires metadata OR an explicit exclusion record with a reason.
// ---------------------------------------------------------------------------

describe('inverted catalog-rot guard (DECISION E)', () => {
  const PROVIDER_TYPES: CatalogProviderType[] = ['anthropic', 'openai', 'google', 'openrouter'];

  /** Same metadata-join logic the selector uses (direct, normalized, canonical). */
  function rowHasMetadata(model: string): boolean {
    const normalized = normalizeCatalogModelId(model);
    return (
      Boolean(getRecommendationMetadata(model)) ||
      Boolean(getRecommendationMetadata(normalized)) ||
      Boolean(getRecommendationMetadata(canonicalizeCatalogId(model)))
    );
  }

  it('every addable catalog row is either covered by metadata or explicitly excluded', () => {
    const uncovered: string[] = [];
    for (const providerType of PROVIDER_TYPES) {
      for (const entry of PROVIDER_CATALOGS[providerType]) {
        const normalized = normalizeCatalogModelId(entry.model);
        if (!rowHasMetadata(entry.model) && !isRecommendationExcluded(normalized)) {
          uncovered.push(`${providerType}:${entry.routeSurface}:${normalized}`);
        }
      }
    }
    // If this fails, a model was added to the catalog without recommendation
    // metadata or an explicit exclusion — add one (see recommendationExclusions.ts /
    // NEW_MODEL_SUPPORT_PROCESS).
    expect(uncovered).toEqual([]);
  });

  it('no exclusion entry collides with a metadata-covered id (exclusions are genuine omissions)', () => {
    for (const providerType of PROVIDER_TYPES) {
      for (const entry of PROVIDER_CATALOGS[providerType]) {
        const normalized = normalizeCatalogModelId(entry.model);
        if (rowHasMetadata(entry.model)) {
          expect(isRecommendationExcluded(normalized)).toBe(false);
        }
      }
    }
  });
});
