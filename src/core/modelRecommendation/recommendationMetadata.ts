/**
 * Committed per-model recommendation metadata (Stage 1, DECISION D).
 *
 * A sibling committed module (NOT inline in `modelCatalog.ts`) so the hot
 * bundled catalog stays lean and the eval-derived / editorial fields live
 * together with their provenance. This is the data the deterministic selector
 * (Stage 3) reasons over.
 *
 * PURE: no electron / electron-store import. Importable from desktop, cloud,
 * and mobile alike.
 *
 * Provenance, coverage, and sample size are LOAD-BEARING, not decorative
 * (DECISION D): an unproven editorial model must never become a non-technical
 * user's default ahead of an eval-grounded peer (that ordering rule is enforced
 * in Stage 3's sort key; here we record the inputs to it).
 *
 * The eval-grounded rows are transcribed from the authoritative consolidated
 * `260609_2005_knowledge_work_analysis` run; the committed seed artifact
 * (`recommendationMetadata.seed.json`) records each config's raw metrics so the
 * `eval-grounded` provenance is AUDITABLE and a future Pareto refresh is a
 * script re-derivation, not archaeology.
 *
 * Flooring rules applied (DECISION D):
 *  - `claude-opus-4-8` — no trustworthy KW data (one N=1 run, compound ~2.10);
 *    FLOORED to Opus 4.7's `frontier`/`strong` tier (`floored-to-prior-gen`).
 *    The single-run 2.10 is recorded ONLY as a caveat note, never as the tier.
 *  - `deepseek/deepseek-v4-pro` — frontier point but PARTIAL coverage; a
 *    separate run scored 0.00 (a crash, not a quality signal) — NOT ingested.
 *    `valueClass:'frontier-partial'`, never plain `frontier`.
 *  - `claude-fable-5`, Gemini 3.x — no family anchor → `mid`/`unknown`
 *    editorial, NEVER `frontier`.
 *
 * @see docs/plans/260614_recommended-models-engine/PLAN.md (Stage 1, DECISION D)
 * @see ./recommendationMetadata.seed.json (the reduced KW-Pareto seed artifact)
 */

import type { RecommendationMetadata } from './types';
import seedArtifact from './recommendationMetadata.seed.json';

/**
 * The metric version the eval-grounded seed is computed under
 * (`avg_score * pass_rate/100`, on the post-2026-05-14 cost-trust window).
 * Re-exported from the seed artifact's single source of truth.
 */
export const RECOMMENDATION_METRIC_VERSION = seedArtifact.metricVersion;

/** The seed run id / date the eval-grounded rows are transcribed from. */
export const RECOMMENDATION_SEED_RUN = Object.freeze({
  runId: seedArtifact.runId,
  runDate: seedArtifact.runDate,
});

/**
 * Per-model recommendation metadata, keyed by canonical `MODEL_CATALOG` id.
 *
 * NOTE on completeness: this table covers the recommendation-eligible models
 * for the "Recommended for most people" shortlist. The full INVERTED
 * catalog-rot guard — enumerate every addable `PROVIDER_CATALOGS` row and
 * require metadata-or-explicit-exclusion — is Stage 3's selector concern; the
 * Stage 1 test only asserts these rows are complete + internally well-formed.
 */
const RECOMMENDATION_METADATA_LIST: readonly RecommendationMetadata[] = [
  // ===========================================================================
  // EVAL-GROUNDED (anchored on the 260609 KW Pareto frontier — see seed JSON)
  // ===========================================================================

  // DeepSeek v4 Flash — best VALUE point on the frontier (~Sonnet-class at ~1/7
  // cost). Recommended via the OpenRouter slash-id form (the bare provider:'local'
  // row carries zero pricing and is not an addable candidate). Text-only.
  {
    catalogId: 'deepseek/deepseek-v4-flash',
    appliesToCatalogIds: ['deepseek/deepseek-v4-flash', 'deepseek-v4-flash'],
    family: 'deepseek',
    valueClass: 'frontier',
    costTier: 'cheap',
    familyRank: 1,
    qualityTier: 'strong',
    tierBasis: 'best-config',
    visionStrength: 'none',
    provenance: 'eval-grounded',
    sampleRuns: 1,
    fixtureCoverage: 'full',
    recommendationEligible: true,
    sourceNote:
      'Best value point on the 260609 frontier (compound 3.85, $0.057, RE:[low,low,low] config). Text-only (catalog supportsImageInput:false).',
  },

  // Claude Opus 4.7 — the quality ceiling on the frontier (capable working model
  // + cheap Haiku background). Eval-grounded intelligence anchor.
  {
    catalogId: 'claude-opus-4-7',
    appliesToCatalogIds: ['claude-opus-4-7', 'anthropic/claude-opus-4-7'],
    family: 'claude-opus',
    valueClass: 'frontier',
    costTier: 'premium',
    familyRank: 1,
    qualityTier: 'frontier',
    tierBasis: 'best-config',
    visionStrength: 'strong',
    provenance: 'eval-grounded',
    sampleRuns: 1,
    fixtureCoverage: 'full',
    recommendationEligible: true,
    sourceNote:
      'Quality ceiling on the 260609 frontier (compound 4.12, $0.316, opus-4-7 working + haiku-4-5 background). Vision-capable (catalog fail-open).',
  },

  // Claude Sonnet 4.6 — strong middle model, dominated by Opus-4-7+haiku but a
  // sensible "middle" pick.
  {
    catalogId: 'claude-sonnet-4-6',
    appliesToCatalogIds: ['claude-sonnet-4-6', 'anthropic/claude-sonnet-4-6'],
    family: 'claude-sonnet',
    valueClass: 'dominated',
    costTier: 'middle',
    familyRank: 1,
    qualityTier: 'strong',
    tierBasis: 'best-config',
    visionStrength: 'strong',
    provenance: 'eval-grounded',
    sampleRuns: 1,
    fixtureCoverage: 'full',
    recommendationEligible: true,
    sourceNote:
      'Strong (compound 4.01, $0.395) but dominated by Opus-4-7+haiku-background. Good "middle" pick. Vision-capable (catalog fail-open).',
  },

  // Claude Haiku 4.5 — weak as a working model, excellent cheap background tier.
  {
    catalogId: 'claude-haiku-4-5',
    appliesToCatalogIds: ['claude-haiku-4-5', 'anthropic/claude-haiku-4-5'],
    family: 'claude-haiku',
    valueClass: 'dominated',
    costTier: 'cheap',
    familyRank: 1,
    qualityTier: 'background',
    tierBasis: 'best-config',
    visionStrength: 'strong',
    provenance: 'eval-grounded',
    sampleRuns: 1,
    fixtureCoverage: 'full',
    recommendationEligible: true,
    sourceNote:
      'Weak as a working model (compound 1.28, 33-43% pass) but excellent cheap background tier. Vision-capable (catalog fail-open).',
  },

  // GPT-5.5 — strong quality, dominated PURELY on raw cost (~26x frontier). Its
  // cost domination FLIPS when the user has an effectively-free subscription
  // (ChatGPT Pro / Mindstone) — handled at effective-cost time (Stage 2), not in
  // this static quality figure.
  {
    catalogId: 'openai/gpt-5.5',
    appliesToCatalogIds: ['openai/gpt-5.5', 'gpt-5.5'],
    family: 'gpt',
    valueClass: 'dominated',
    costTier: 'premium',
    familyRank: 1,
    qualityTier: 'frontier',
    tierBasis: 'best-config',
    visionStrength: 'strong',
    provenance: 'eval-grounded',
    sampleRuns: 1,
    fixtureCoverage: 'full',
    recommendationEligible: true,
    sourceNote:
      'Strong quality (compound 3.69) dominated PURELY on raw cost ($8.14/fixture); cost flips when an all-you-can-eat subscription is in play (Greg\'s point). Vision-capable (catalog fail-open).',
  },

  // Kimi K2.6 — dominated standout.
  {
    catalogId: 'moonshotai/kimi-k2.6',
    appliesToCatalogIds: ['moonshotai/kimi-k2.6'],
    family: 'kimi',
    valueClass: 'dominated',
    costTier: 'middle',
    familyRank: 1,
    qualityTier: 'strong',
    tierBasis: 'best-config',
    visionStrength: 'strong',
    provenance: 'eval-grounded',
    sampleRuns: 1,
    fixtureCoverage: 'full',
    recommendationEligible: true,
    sourceNote:
      'Dominated standout (compound 3.50, $0.412). Vision strength not verified — fail-open from catalog.',
  },

  // GLM 5.1 — dominated standout (mid quality, cheap).
  {
    catalogId: 'z-ai/glm-5.1',
    appliesToCatalogIds: ['z-ai/glm-5.1'],
    family: 'glm',
    valueClass: 'dominated',
    costTier: 'cheap',
    familyRank: 1,
    qualityTier: 'mid',
    tierBasis: 'best-config',
    visionStrength: 'none',
    provenance: 'eval-grounded',
    sampleRuns: 1,
    fixtureCoverage: 'full',
    recommendationEligible: true,
    sourceNote:
      'Dominated standout (compound 2.98, $0.202). Text-only (catalog supportsImageInput:false, verified against OR input_modalities 260622).',
  },

  // MiniMax M3 — dominated standout (lower quality, cheap).
  {
    catalogId: 'minimax/minimax-m3',
    appliesToCatalogIds: ['minimax/minimax-m3'],
    family: 'minimax',
    valueClass: 'dominated',
    costTier: 'cheap',
    familyRank: 1,
    qualityTier: 'mid',
    tierBasis: 'best-config',
    visionStrength: 'strong',
    provenance: 'eval-grounded',
    sampleRuns: 1,
    fixtureCoverage: 'full',
    recommendationEligible: true,
    sourceNote:
      'Dominated standout (compound 2.21, $0.108). Vision strength not verified — fail-open from catalog.',
  },

  // DeepSeek v4 Pro — frontier point but PARTIAL coverage; a separate run scored
  // 0.00 (a crash, NOT a quality signal — explicitly not ingested). Never plain
  // 'frontier'. Text-only.
  {
    catalogId: 'deepseek/deepseek-v4-pro',
    appliesToCatalogIds: ['deepseek/deepseek-v4-pro'],
    family: 'deepseek-pro',
    valueClass: 'frontier-partial',
    familyRank: 1,
    // Curated `middle` (DECISION F) despite the cheapest raw price ($0.022 < Flash's
    // $0.057) — Greg's explicit product call: Pro is a deliberately mid-positioned
    // model, Flash is the best-value cheap entry point. This is the canonical
    // raw-price/band inversion the curated tier exists to express.
    costTier: 'middle',
    qualityTier: 'mid',
    tierBasis: 'best-config',
    visionStrength: 'none',
    provenance: 'eval-grounded',
    sampleRuns: 1,
    fixtureCoverage: 'partial',
    recommendationEligible: true,
    sourceNote:
      'Cheapest frontier point (compound 2.39, $0.022) but PARTIAL coverage; a separate run scored 0.00 (a crash, not ingested). frontier-partial, never plain frontier. Text-only.',
  },

  // ===========================================================================
  // EDITORIAL (no trustworthy KW data — floored / baseline; flagged)
  // ===========================================================================

  // Claude Opus 4.8 — Anthropic's current frontier. No trustworthy KW data (one
  // N=1 run, compound ~2.10, likely routing/access noise). FLOORED to Opus 4.7's
  // tier; the 2.10 is a caveat note only, never the tier value.
  {
    catalogId: 'claude-opus-4-8',
    appliesToCatalogIds: ['claude-opus-4-8', 'anthropic/claude-opus-4-8'],
    family: 'claude-opus',
    valueClass: 'unknown',
    costTier: 'premium',
    // Newer than Opus 4.7 (familyRank 1) — family-ORDERING only, never proof.
    familyRank: 2,
    // Auditable same-family proof source: the selector inherits 4.7's PROVEN
    // (eval-grounded best-config) ranking tier WITHOUT rewriting 4.8's honest
    // metadata below (provenance stays editorial, tierBasis floored-to-prior-gen).
    provenTierSourceCatalogId: 'claude-opus-4-7',
    qualityTier: 'frontier',
    tierBasis: 'floored-to-prior-gen',
    visionStrength: 'strong',
    provenance: 'editorial',
    sampleRuns: 0,
    fixtureCoverage: 'thin',
    recommendationEligible: true,
    sourceNote:
      'No trustworthy KW data; FLOORED to Opus 4.7 (frontier/strong). CAVEAT only: a single noisy 29-fixture run scored ~2.10 ($0.90/fixture), likely routing/access issues — NOT used as the tier. Vision-capable (catalog fail-open).',
  },

  // Claude Fable 5 — Anthropic's tier above Opus 4.8. Access-gated; no KW data
  // anywhere. No family anchor → mid/unknown editorial, NOT frontier.
  {
    catalogId: 'claude-fable-5',
    appliesToCatalogIds: ['claude-fable-5', 'anthropic/claude-fable-5'],
    family: 'claude-fable',
    valueClass: 'unknown',
    // Premium band (Anthropic's tier above Opus 4.8, access-gated) — a curated
    // editorial position, not a quality/eval claim (qualityTier stays mid; DECISION F).
    costTier: 'premium',
    // No same-family eval-grounded member exists (claude-fable has only this row),
    // so NO provenTierSourceCatalogId — the selector inheritance gate cannot fire
    // (DECISION D: an editorial NEW family does not borrow proof across families).
    familyRank: 1,
    qualityTier: 'mid',
    tierBasis: 'editorial',
    visionStrength: 'strong',
    provenance: 'editorial',
    sampleRuns: 0,
    fixtureCoverage: 'thin',
    recommendationEligible: true,
    sourceNote:
      'No KW data (access-gated, 404 "use Opus 4.8"); no family anchor → mid/unknown editorial, NOT frontier. Vision-capable (catalog fail-open).',
  },

  // Gemini 3.1 Pro — Google's frontier. No KW data anywhere → mid/unknown
  // editorial, NOT frontier.
  {
    catalogId: 'gemini-3.1-pro',
    appliesToCatalogIds: ['gemini-3.1-pro', 'google/gemini-3.1-pro-preview'],
    family: 'gemini-pro',
    valueClass: 'unknown',
    costTier: 'middle',
    familyRank: 1,
    qualityTier: 'mid',
    tierBasis: 'editorial',
    visionStrength: 'strong',
    provenance: 'editorial',
    sampleRuns: 0,
    fixtureCoverage: 'thin',
    recommendationEligible: true,
    sourceNote:
      'No KW data anywhere → mid/unknown editorial, NOT frontier. Vision-capable (catalog fail-open).',
  },

  // Gemini 3 Flash — Google's cheap frontier-class. No KW data → mid/unknown
  // editorial. Recommended as a cheap+vision candidate.
  {
    catalogId: 'gemini-3-flash',
    appliesToCatalogIds: ['gemini-3-flash', 'google/gemini-3-flash-preview'],
    family: 'gemini-flash',
    valueClass: 'unknown',
    costTier: 'cheap',
    familyRank: 1,
    qualityTier: 'mid',
    tierBasis: 'editorial',
    visionStrength: 'strong',
    provenance: 'editorial',
    sampleRuns: 0,
    fixtureCoverage: 'thin',
    recommendationEligible: true,
    sourceNote:
      'No KW data → mid/unknown editorial. Cheap + vision-capable (catalog fail-open).',
  },
];

/** All committed recommendation metadata records (frozen). */
export const RECOMMENDATION_METADATA: readonly RecommendationMetadata[] =
  Object.freeze(RECOMMENDATION_METADATA_LIST);

/**
 * Lookup table from any covered `MODEL_CATALOG` id (either routing form) to its
 * recommendation metadata. Built from `appliesToCatalogIds`.
 */
export const RECOMMENDATION_METADATA_BY_CATALOG_ID: ReadonlyMap<string, RecommendationMetadata> =
  (() => {
    const map = new Map<string, RecommendationMetadata>();
    for (const meta of RECOMMENDATION_METADATA_LIST) {
      for (const id of meta.appliesToCatalogIds) {
        map.set(id, meta);
      }
    }
    return map;
  })();

/** Resolve recommendation metadata for a catalog id (either routing form). */
export function getRecommendationMetadata(
  catalogId: string,
): RecommendationMetadata | undefined {
  return RECOMMENDATION_METADATA_BY_CATALOG_ID.get(catalogId);
}
