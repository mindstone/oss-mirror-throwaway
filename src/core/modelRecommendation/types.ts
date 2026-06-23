/**
 * Locked Stage-0 public API contract for `src/core/modelRecommendation/`.
 *
 * This is the deterministic "Recommended for most people" recommendation engine
 * contract — every later stage (metadata, effective-cost, selector, eval harness)
 * and every future consumer (the Add-a-model UI rewrite; a possible runtime-router
 * usable-routing-pool projection) depends on these shapes.
 *
 * Design intent (see docs/plans/260614_recommended-models-engine/PLAN.md,
 * DECISIONS A–G):
 *  - PURE TYPES ONLY. No electron / electron-store import, no logic. This module
 *    must remain importable from desktop, cloud, and mobile alike.
 *  - Candidate identity is the ROUTE-AWARE catalog ROW
 *    `(providerType, routeSurface, normalizedModelId, optionValue)` — NOT `modelId`
 *    (DECISION A). The catalog carries two routing forms (bare vs slash-id) of the
 *    same model with different economics, so cost is computed per row.
 *  - `EffectiveCost` is a clean discriminated union, never stringly-typed
 *    (DECISION C maps billing-source → cost kind).
 *  - `availability` is encoded in the types so an unavailable pick cannot be
 *    silently consumed as a routing pool (DECISION F).
 *  - The engine is PURE and returns typed `diagnostics`; the CALLER logs them
 *    (DECISION E — never silently drop drift).
 */

import type { ActiveProvider, RouteSurface } from '@shared/types/settings';
import type { ProfileConnectivityState } from '@shared/utils/connectivityHelpers';
import type { CatalogProviderType } from '@shared/data/providerCatalogs';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Tunables for a recommendation request. All optional; the selector applies
 * documented defaults (e.g. a small cap) when omitted.
 */
export interface RecommendationOptions {
  /** Maximum number of models to return. */
  readonly cap?: number;
  /** Include a "middle" pick (e.g. Sonnet / DeepSeek v4 Pro) when cap allows. */
  readonly includeMiddle?: boolean;
  /**
   * Include an optional 2nd cross-family highly-intelligent pick
   * (Greg's "perhaps two to compare across families") when cap + a second
   * family allow it.
   */
  readonly includeSecondIntelligent?: boolean;
}

/**
 * Everything the engine needs to select a recommendation set. The engine is
 * pure: connectivity and the managed allow-list are passed-in SNAPSHOTS — the
 * engine never fetches them and must be re-run when they change.
 */
export interface RecommendationInput {
  /**
   * The single currently-active provider.
   *
   * DIRECTION (DECISION E): the product is evolving away from a single `activeProvider`
   * toward an *ordered list of available & enabled providers* (per-provider off-switch +
   * priority chain) — see the smart-model-routing plan
   * (`docs/plans/260614_smart-model-routing/PLAN.md`, Stage 5). We deliberately do NOT add
   * an `enabledProviders?` field this run (YAGNI — the priority semantics belong to that
   * plan, and a documented-but-ignored public field invites false caller assumptions). When
   * that lands, this field is the seam to widen; the engine already treats "any live route ⇒
   * usable-now" (see `computeAvailability`), so availability is forward-compatible.
   */
  readonly activeProvider: ActiveProvider | undefined;
  /** Canonical "what's connected" shape (connectivityHelpers.ts) — reused, not reinvented. */
  readonly connectivity: ProfileConnectivityState;
  /** Server-authoritative managed (Mindstone-plan) allow-list snapshot. */
  readonly managedAllowedModels: readonly string[];
  readonly options?: RecommendationOptions;
}

// ---------------------------------------------------------------------------
// Candidate identity (route-aware tuple — DECISION A)
// ---------------------------------------------------------------------------

/**
 * The structured route-aware identity of a candidate row. The catalog carries
 * two routing forms (bare `gpt-5.5` vs slash-id `openai/gpt-5.5`) of the same
 * model with different billing economics, so the unit of work is the ROW.
 */
export interface RecommendationCandidateKey {
  readonly providerType: CatalogProviderType;
  readonly routeSurface: RouteSurface;
  /** `normalizeCatalogModelId(model)` — strips `[1m]`, lowercased, trimmed. */
  readonly normalizedModelId: string;
  /**
   * The option-value string the user reaches the model by (bare id or slash-id).
   * This is what the billing/effective-cost resolution keys on.
   */
  readonly optionValue: string;
}

/**
 * Stable string form of a `RecommendationCandidateKey`, for map keys, dedup, and
 * 1:1 join with the UI's catalog rows. Format:
 * `${providerType}:${routeSurface}:${normalizedModelId}:${optionValue}`.
 */
export type RecommendationCandidateKeyString =
  `${CatalogProviderType}:${RouteSurface}:${string}:${string}`;

// ---------------------------------------------------------------------------
// Effective cost (discriminated union — DECISION C)
// ---------------------------------------------------------------------------

/**
 * The user-conditional effective cost of reaching a model via a given route.
 *  - `free`    — local / no marginal cost (defensive `routeSurface:'local'` short-circuit).
 *  - `flat`    — all-you-can-eat subscription (billing-source `subscription`):
 *                ChatGPT-Pro GPT-5.5, Mindstone-plan models.
 *  - `metered` — personal OpenRouter credits (billing-source `pool`): discounted,
 *                below `flat`, above `paid`.
 *  - `paid`    — pay-per-use (billing-source `pay-per-use`); `usd` is the
 *                documented representative-turn weighted proxy (see effectiveCost.ts).
 */
export type EffectiveCost =
  | { readonly kind: 'free' }
  | { readonly kind: 'flat' }
  | { readonly kind: 'metered' }
  | { readonly kind: 'paid'; readonly usd: number };

// ---------------------------------------------------------------------------
// Recommendation metadata classifications (consumed here; defined in Stage 1)
// ---------------------------------------------------------------------------

/** Capability/cost bucket a pick fills. */
export type RecommendationBucket = 'intelligence' | 'cheap' | 'vision' | 'middle';

/**
 * Whether the user can actually reach this pick right now.
 *  - `usable-now`       — provider connected; usable immediately.
 *  - `needs-connection` — recommended but requires connecting a provider first.
 *  - `on-plan`          — a Mindstone-plan model the user could use, but addable
 *                         only when `activeProvider === 'mindstone'` (footgun guard);
 *                         informational off-Mindstone, NEVER `usable-now`.
 */
export type RecommendationAvailability = 'usable-now' | 'needs-connection' | 'on-plan';

/** Where a model's quality signal comes from. */
export type RecommendationProvenance = 'eval-grounded' | 'editorial';

/**
 * Best-config WORKING-ROLE quality tier (NOT a context-free scalar — eval configs
 * must not be merged). Defined in Stage 1; surfaced on each pick.
 */
export type QualityTier = 'frontier' | 'strong' | 'mid' | 'background' | 'unknown';

/**
 * Pareto value classification.
 *  - `frontier`         — non-dominated AND meets minimum coverage.
 *  - `frontier-partial` — on the frontier but partial coverage (e.g. DeepSeek v4 Pro).
 *  - `dominated`        — dominated on the clean frontier.
 *  - `unknown`          — no trustworthy KW data (editorial baseline).
 */
export type ValueClass = 'frontier' | 'frontier-partial' | 'dominated' | 'unknown';

/**
 * CURATED recommendation cost band — the bucket a model fills in the shortlist
 * (cheap / middle / premium). **This is a hand-curated product choice, NOT a
 * value derivable from raw catalog price** (DECISION F, Stage 1).
 *
 * Why it can't be derived: `valueClass` + `qualityTier` cannot express the
 * desired buckets, and raw/seed price misclassifies — e.g. DeepSeek v4 Pro's
 * mean cost ($0.022) is *below* DeepSeek v4 Flash's ($0.057), yet the desired
 * product bucket for Pro is `middle` (a stronger, deliberately-positioned
 * model) and for Flash is `cheap` (the best-value entry point). So the band is
 * a curated editorial signal, kept honest by a raw-price *sanity warning* test
 * (it flags, doesn't hard-fail, when the curated band drifts implausibly far
 * from price — see recommendationMetadata.test.ts).
 *
 * @see docs/plans/260614_recommended-models-followup/PLAN.md (Stage 1, DECISION F)
 */
export type CostTier = 'cheap' | 'middle' | 'premium';

// ---------------------------------------------------------------------------
// Recommendation metadata (defined + seeded in Stage 1)
// ---------------------------------------------------------------------------

/**
 * Vision (image-input) strength of a model.
 *  - `strong` — verified / clearly capable of meaningful image understanding.
 *  - `basic`  — capable but limited (reserved; not used by the seed today).
 *  - `none`   — verified to reject image input (e.g. DeepSeek, text-only).
 *
 * Derived from the catalog's `supportsImageInput` with the fail-open rule
 * (`undefined` ⇒ vision-capable ⇒ `strong`) plus an editorial override where a
 * model is known to be strong/weak. An editorial `strong`/`basic` claim must be
 * backed by a non-`undefined` catalog `supportsImageInput !== false` (asserted
 * in the Stage 1 test).
 */
export type VisionStrength = 'strong' | 'basic' | 'none';

/**
 * How a model's `qualityTier` was derived — makes the provenance of the tier
 * explicit and testable (DECISION D). The tier is NEVER an average across a
 * model's eval configs (the eval forbids merging configs — `_modelVariantKey`).
 *  - `best-config`          — the best compound achieved by any eval config
 *                             whose WORKING model is this model (a lower bound).
 *  - `editorial`            — hand-assigned (no eval anchor; e.g. Fable 5).
 *  - `floored-to-prior-gen` — floored to the prior proven generation's tier
 *                             (e.g. Opus 4.8 → Opus 4.7) because the model's own
 *                             data is low-N / failed / absent.
 */
export type QualityTierBasis = 'best-config' | 'editorial' | 'floored-to-prior-gen';

/**
 * How much eval coverage backs an eval-grounded row (so an N=1 row can't
 * masquerade as robust).
 *  - `full`    — meets the eval's minimum-fixture-coverage threshold.
 *  - `partial` — on the frontier but below the coverage threshold.
 *  - `thin`    — very low N / single noisy run; treat with caution.
 */
export type FixtureCoverage = 'full' | 'partial' | 'thin';

/**
 * Committed per-model recommendation metadata. The data the selector reasons
 * over. Provenance / coverage / sample-size are LOAD-BEARING (DECISION D): an
 * unproven editorial model must never become a non-technical user's default
 * ahead of an eval-grounded peer.
 *
 * Keyed (in the metadata table) by a canonical `MODEL_CATALOG` id. A single
 * conceptual model can have two catalog routing forms (bare `gpt-5.5` and
 * slash-id `openai/gpt-5.5`); `appliesToCatalogIds` lists every catalog id this
 * one quality/provenance record covers so the route-aware selector (Stage 3)
 * joins either form to the same quality signal.
 */
export interface RecommendationMetadata {
  /** Canonical primary `MODEL_CATALOG` id this record is keyed on. */
  readonly catalogId: string;
  /**
   * Every `MODEL_CATALOG` id this record's quality/provenance applies to —
   * includes both routing forms of the same conceptual model. Always contains
   * `catalogId`. Each id must exist in `MODEL_CATALOG`.
   */
  readonly appliesToCatalogIds: readonly string[];
  /** Family handle for dedup (one pick per family in the selector). */
  readonly family: string;
  /** Pareto value classification (gated on coverage — DECISION D). */
  readonly valueClass: ValueClass;
  /**
   * CURATED recommendation cost band (cheap / middle / premium). A hand-curated
   * product choice, NOT derivable from raw price (DECISION F) — see {@link CostTier}.
   * Drives the `isCheap`/`isMiddle` bucket predicates in the selector.
   */
  readonly costTier: CostTier;
  /**
   * Within-family version ordinal — HIGHER = newer (e.g. Opus 4.8 = 2 > Opus 4.7 = 1).
   *
   * **This is family-ORDERING only — it is NEVER a proof/quality signal** (DECISION
   * D, Stage 3). It drives the dedup "latest among the best AVAILABLE class" rule
   * (`dedupByFamily`/`betterForm`): recency breaks ties only WITHIN an availability
   * class, never across one. Defaults to `1` for single-member families. Must be
   * unique within each multi-member family (asserted in the metadata test).
   */
  readonly familyRank: number;
  /**
   * The same-family catalog id whose PROVEN (eval-grounded best-config) tier this
   * row inherits at the SELECTOR (e.g. `claude-opus-4-8` carries `'claude-opus-4-7'`).
   * Present ONLY on inherited rows — an auditable proof source making the same-family
   * gate mechanical (DECISION C/D, Stage 3).
   *
   * **Honesty invariant:** this does NOT change this row's own `provenance` /
   * `tierBasis` / `qualityTier` / `sampleRuns` — those stay honest (4.8 remains
   * `editorial` / `floored-to-prior-gen` / `sampleRuns:0`). The inherited *ranking*
   * tier lives in the selector's internal `RankingFacts`, not here, and the emitted
   * `RecommendedModel.provenance` stays the honest per-model value.
   */
  readonly provenTierSourceCatalogId?: string;
  /** Best-config working-role quality tier (NOT a context-free scalar). */
  readonly qualityTier: QualityTier;
  /** How `qualityTier` was derived (explicit + testable — DECISION D). */
  readonly tierBasis: QualityTierBasis;
  /** Vision strength (fail-open from catalog `supportsImageInput` + override). */
  readonly visionStrength: VisionStrength;
  /** Where the quality signal comes from. */
  readonly provenance: RecommendationProvenance;
  /**
   * Number of eval runs backing the tier (best-config sample size). 0 for
   * editorial rows with no anchoring run of their own.
   */
  readonly sampleRuns: number;
  /** How much eval coverage backs the tier. */
  readonly fixtureCoverage: FixtureCoverage;
  /** Whether this model is eligible to be recommended at all. */
  readonly recommendationEligible: boolean;
  /** Human-readable provenance / flooring / caveat note. */
  readonly sourceNote: string;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** One selected recommendation. */
export interface RecommendedModel {
  readonly catalogKey: RecommendationCandidateKey;
  readonly modelId: string;
  readonly optionValue: string;
  readonly family: string;
  readonly bucket: RecommendationBucket;
  readonly availability: RecommendationAvailability;
  readonly effectiveCost: EffectiveCost;
  readonly provenance: RecommendationProvenance;
  readonly qualityTier: QualityTier;
  readonly valueClass: ValueClass;
}

/** Per-pick reason, for the advisory judge eval and debugging. */
export interface SelectorPickTrace {
  readonly catalogKey: RecommendationCandidateKey;
  readonly bucket: RecommendationBucket;
  /** Human-readable reason this row won its slot. */
  readonly reason: string;
}

/** Why the selector produced the set it did. */
export interface SelectorTrace {
  readonly picks: readonly SelectorPickTrace[];
  /** Free-form notes about ordering / carve-outs (e.g. subscription-preference). */
  readonly notes: readonly string[];
}

/**
 * A connected/allowed model id that has no `MODEL_CATALOG` entry (catalog drift).
 * Returned as a typed record — the engine NEVER silently drops it (DECISION E);
 * the caller logs it (mirrors ChoosePathStep's `[Renderer]` warn).
 */
export interface UnmatchedRecord {
  readonly modelId: string;
  /** Where the unmatched id came from (managed allow-list, connectivity, etc). */
  readonly source: 'managed-allow-list' | 'catalog';
  readonly reason: string;
}

/** Typed diagnostics the engine returns for the caller to surface/log. */
export interface RecommendationDiagnostics {
  /** Allowed/connected ids with no catalog entry. */
  readonly unmatched: readonly UnmatchedRecord[];
  /** Candidate ids that matched the catalog but lacked recommendation metadata. */
  readonly missingMetadata: readonly string[];
  /** Non-fatal advisories (e.g. cap could not be filled, editorial fallbacks used). */
  readonly warnings: readonly string[];
}

/** The engine's full result. */
export interface RecommendationResult {
  readonly recommended: readonly RecommendedModel[];
  readonly rationale: SelectorTrace;
  readonly diagnostics: RecommendationDiagnostics;
}
