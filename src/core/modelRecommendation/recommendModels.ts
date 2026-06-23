/**
 * The deterministic "Recommended for most people" SELECTOR (Stage 3).
 *
 * Ranked slot-filling (DECISION G — NOT constraint-satisfaction) over route-aware
 * catalog ROWS (DECISION A). Given the providers/connections a user has, it picks a
 * small, well-rounded, near-optimal SET — one highly-intelligent model, one cheap,
 * one with good vision, optionally a middle and a 2nd cross-family intelligence pick.
 *
 * Design intent (see docs/plans/260614_recommended-models-engine/PLAN.md, DECISIONS
 * D/E/F/G):
 *  - PURE: no electron / electron-store import, no logging, no I/O. Same inputs →
 *    same output (a hard testability requirement). The engine returns typed
 *    `diagnostics`; the CALLER logs them (DECISION E — never silently drop drift).
 *  - Candidate identity is the route-aware catalog ROW
 *    `(providerType, routeSurface, normalizedModelId, optionValue)` (DECISION A).
 *  - Effective cost is computed BEFORE bucket predicates (`isCheap` depends on it).
 *  - `availability` is encoded in the output so an unavailable pick cannot be
 *    silently consumed as a routing pool (DECISION F).
 *  - Provenance is a LOAD-BEARING sort key (DECISION D): an editorial model never
 *    outranks an eval-grounded peer on the same axis EXCEPT the operationalised
 *    "latest successor on an effectively-free subscription" carve-out.
 *  - NEVER empty: nothing-connected returns the editorial near-optimal set marked
 *    `needs-connection`.
 */

import { PROVIDER_CATALOGS, normalizeCatalogModelId } from '@shared/data/providerCatalogs';
import type { CatalogEntry, CatalogProviderType } from '@shared/data/providerCatalogs';
import { isProviderConnectionLive } from '@shared/utils/connectivityHelpers';
import { normalizeModelId as canonicalizeCatalogId } from '@shared/data/modelCatalog';
import { isManagedRouteUsable } from '@shared/types/managedProvider';
import type { ModelProviderType } from '@shared/types';

import type {
  EffectiveCost,
  RecommendationAvailability,
  RecommendationBucket,
  RecommendationCandidateKey,
  RecommendationInput,
  RecommendationMetadata,
  RecommendationResult,
  RecommendedModel,
  SelectorPickTrace,
  UnmatchedRecord,
} from './types';
import { compareEffectiveCost, effectiveCost } from './effectiveCost';
import {
  RECOMMENDATION_METADATA,
  getRecommendationMetadata,
} from './recommendationMetadata';
import { isRecommendationExcluded } from './recommendationExclusions';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default shortlist cap (mirrors today's `RECOMMENDED_CAP` in ChoosePathStep). */
const DEFAULT_CAP = 6;

/** Availability is ranked best-first when choosing the surviving form of a family. */
const AVAILABILITY_RANK: Record<RecommendationAvailability, number> = {
  'usable-now': 0,
  'needs-connection': 1,
  'on-plan': 2,
};

// Bucket fill priority (intelligence → cheap → vision → middle) is expressed
// directly by the sequential slot-fill order in `recommendModels`, not via a
// comparator axis — there is no cross-bucket sort, so no priority table is needed.

/** Quality-tier ordering for the sort key (lower = better). */
const QUALITY_TIER_RANK: Record<RecommendationMetadata['qualityTier'], number> = {
  frontier: 0,
  strong: 1,
  mid: 2,
  background: 3,
  unknown: 4,
};

// ---------------------------------------------------------------------------
// Same-family PROVEN-tier index (Fix 3, DECISION C/D — static, precomputed once)
// ---------------------------------------------------------------------------

/**
 * Per-family best PROVEN ranking tier — the highest-ranked `qualityTier` among the
 * family's `eval-grounded` `best-config` members. This is the tier an editorial
 * latest-in-family successor INHERITS at the selector (DECISION C), gated on the
 * existence of such a same-family proven member (DECISION D — an editorial NEW
 * family with no proven sibling has no entry here, so it cannot inherit).
 *
 * Static (derived from the committed metadata table, independent of availability or
 * the request), computed once at module load.
 */
const FAMILY_BEST_PROVEN_TIER: ReadonlyMap<string, RecommendationMetadata['qualityTier']> =
  (() => {
    const map = new Map<string, RecommendationMetadata['qualityTier']>();
    for (const meta of RECOMMENDATION_METADATA) {
      // Only an eval-grounded best-config member counts as "proven" (DECISION D).
      if (meta.provenance !== 'eval-grounded' || meta.tierBasis !== 'best-config') continue;
      const current = map.get(meta.family);
      if (current === undefined || QUALITY_TIER_RANK[meta.qualityTier] < QUALITY_TIER_RANK[current]) {
        map.set(meta.family, meta.qualityTier);
      }
    }
    return map;
  })();

// ---------------------------------------------------------------------------
// Candidate row (internal, materialised once)
// ---------------------------------------------------------------------------

interface CandidateRow {
  readonly key: RecommendationCandidateKey;
  readonly metadata: RecommendationMetadata;
  readonly availability: RecommendationAvailability;
  readonly effectiveCost: EffectiveCost;
}

// ---------------------------------------------------------------------------
// Step 1 — materialise candidate rows
// ---------------------------------------------------------------------------

/**
 * Map a catalog provider type + route surface to the connectivity flag that gates
 * it. `CatalogProviderType` is a subset of `ModelProviderType`, so this delegates to
 * the canonical `isProviderConnectionLive` (single source of truth, used by the
 * billing badges) rather than reinventing the gate.
 */
function isCatalogRowConnected(
  providerType: CatalogProviderType,
  routeSurface: CatalogEntry['routeSurface'],
  input: RecommendationInput,
): boolean {
  return isProviderConnectionLive(
    providerType as ModelProviderType,
    routeSurface,
    input.connectivity,
  );
}

/**
 * Compute the availability of a catalog row. Own-route liveness and managed
 * membership are evaluated INDEPENDENTLY, then resolved by precedence
 * (Fix 2, Stage 2):
 *
 *   usable-now  >  on-plan  >  needs-connection
 *
 *  - **usable-now** when the row's OWN personal route is live (`isProviderConnectionLive`),
 *    OR when it's a managed-listed row and managed routing is usable
 *    (`isManagedRouteUsable` — today `activeProvider === 'mindstone'`). A live personal
 *    route therefore BEATS a managed shadow: a managed-listed model reachable via the
 *    user's own connection (e.g. DeepSeek Flash via personal OpenRouter) is `usable-now`,
 *    NOT `on-plan` — even off-Mindstone. (Before Fix 2, managed membership was checked
 *    first and unconditionally returned `on-plan` off-Mindstone, shadowing the live route.)
 *  - **on-plan** when the row is managed-listed but managed routing is not usable
 *    (off-Mindstone) AND the personal route is dead — informational, NEVER `usable-now`
 *    (the footgun guard — managed routing only works on Mindstone today,
 *    `localModelProxyServer.ts:2074`).
 *  - **needs-connection** otherwise (no live route, not on a plan).
 *
 * The managed gate uses the shared `isManagedRouteUsable` predicate (the single
 * Stage-1 swap-point for the smart-model-routing plan — DECISION A); the COST side
 * stays byte-identical this run, so a `usable-now` managed row is never priced
 * `pool`/`paid`.
 */
function computeAvailability(
  entry: CatalogEntry,
  input: RecommendationInput,
  managedAllowedSet: ReadonlySet<string>,
): RecommendationAvailability {
  const ownRouteLive = isCatalogRowConnected(entry.providerType, entry.routeSurface, input);
  if (ownRouteLive) return 'usable-now';

  const normalized = normalizeCatalogModelId(entry.model);
  const isManaged = entry.providerType === 'openrouter' && managedAllowedSet.has(normalized);
  if (isManaged) {
    return isManagedRouteUsable({ activeProvider: input.activeProvider })
      ? 'usable-now'
      : 'on-plan';
  }
  return 'needs-connection';
}

/**
 * Materialise candidate ROWS from addable `PROVIDER_CATALOGS` × recommendation
 * metadata. Rows with no metadata are recorded as diagnostics (missing-metadata) and
 * excluded from selection — the inverted catalog-rot guard (test) ensures every
 * addable row is either covered by metadata or explicitly excluded with a reason.
 */
function materialiseCandidates(
  input: RecommendationInput,
  managedAllowedSet: ReadonlySet<string>,
  missingMetadata: Set<string>,
): CandidateRow[] {
  const rows: CandidateRow[] = [];
  const providerTypes: CatalogProviderType[] = ['anthropic', 'openai', 'google', 'openrouter'];
  for (const providerType of providerTypes) {
    for (const entry of PROVIDER_CATALOGS[providerType]) {
      const normalized = normalizeCatalogModelId(entry.model);
      // Join metadata by: the catalog model string as-is (covers slash-id forms
      // listed directly in metadata), then the catalog-canonical id (resolves
      // preview/dated aliases — e.g. google BYOK `gemini-3.1-pro-preview` →
      // canonical `gemini-3.1-pro`, which the metadata is keyed on).
      const metadata =
        getRecommendationMetadata(entry.model) ??
        getRecommendationMetadata(normalized) ??
        getRecommendationMetadata(canonicalizeCatalogId(entry.model));
      if (!metadata || !metadata.recommendationEligible) {
        // F2 (Stage 5 fix): a row with an explicit exclusion record is ACCOUNTED
        // FOR — it is intentionally omitted, not drift. Only genuinely-unaccounted
        // rows (no metadata AND no exclusion) belong in `missingMetadata` (DECISION
        // E — so a future logging consumer sees real drift, not dozens of curated
        // omissions like prior GPTs / Grok / o3). The inverted rot-guard test
        // ensures every addable row has metadata OR an exclusion, so a row landing
        // in `missingMetadata` here is a true unaccounted omission.
        if (!metadata && !isRecommendationExcluded(normalized)) missingMetadata.add(normalized);
        continue;
      }
      const key: RecommendationCandidateKey = {
        providerType: entry.providerType,
        routeSurface: entry.routeSurface,
        // Canonical catalog id (resolves preview/dated aliases) so pricing lookup
        // and the output `modelId` are stable — e.g. the google BYOK row
        // `gemini-3.1-pro-preview` carries the canonical `gemini-3.1-pro` here,
        // which `getCatalogPricingMap()` is keyed on.
        normalizedModelId: canonicalizeCatalogId(entry.model),
        // The option value is how the user reaches the model (bare id for direct
        // providers, slash-id for OpenRouter) — exactly what billing keys on, and
        // what the UI adds. Kept as the catalog wire form.
        optionValue: entry.model,
      };
      rows.push({
        key,
        metadata,
        availability: computeAvailability(entry, input, managedAllowedSet),
        effectiveCost: effectiveCost(key, input),
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Step 2 — family-dedup + best-form-selection
// ---------------------------------------------------------------------------

/**
 * Stable id tiebreak so ordering is fully deterministic. Compares the full
 * route-aware key string.
 */
function candidateKeyString(key: RecommendationCandidateKey): string {
  return `${key.providerType}:${key.routeSurface}:${key.normalizedModelId}:${key.optionValue}`;
}

/**
 * Pick the better of two rows of the SAME family — the form this user reaches more
 * cheaply / more readily, preferring the LATEST version among the best AVAILABLE
 * class. Resolution order (DECISION B, Stage 3):
 *
 *   1. availability class  (usable-now first — recency must NEVER hide a usable
 *      predecessor: a `needs-connection` latest member loses to a `usable-now`
 *      predecessor)
 *   2. `familyRank`         (within the SAME availability class, newer wins —
 *      e.g. Opus 4.8 beats Opus 4.7 when both are equally reachable)
 *   3. effective cost       (the cheaper-for-this-user form)
 *   4. a stable id tiebreak (same-version bare-vs-slash forms)
 *
 * This is the "best-form-selection" step (DECISION A / Reviewer-S1): when a family
 * has both a bare and a slash row — or multiple versions — the surviving row is the
 * one that's actually best for this user. Recency (step 2) only breaks ties WITHIN
 * an availability class, so a usable predecessor is never shadowed by a
 * needs-connection latest (DECISION B).
 */
function betterForm(a: CandidateRow, b: CandidateRow): CandidateRow {
  const availDelta = AVAILABILITY_RANK[a.availability] - AVAILABILITY_RANK[b.availability];
  if (availDelta !== 0) return availDelta < 0 ? a : b;
  // Within the same availability class, prefer the latest version (higher familyRank).
  const rankDelta = b.metadata.familyRank - a.metadata.familyRank;
  if (rankDelta !== 0) return rankDelta < 0 ? a : b;
  const costDelta = compareEffectiveCost(a.effectiveCost, b.effectiveCost);
  if (costDelta !== 0) return costDelta < 0 ? a : b;
  return candidateKeyString(a.key) <= candidateKeyString(b.key) ? a : b;
}

/**
 * Collapse candidate rows to one per family (no two picks from the same family),
 * keeping the best form for this user.
 */
function dedupByFamily(rows: readonly CandidateRow[]): CandidateRow[] {
  const byFamily = new Map<string, CandidateRow>();
  for (const row of rows) {
    const existing = byFamily.get(row.metadata.family);
    byFamily.set(row.metadata.family, existing ? betterForm(existing, row) : row);
  }
  // Deterministic family order (sorted) so downstream iteration is stable.
  return Array.from(byFamily.values()).sort((a, b) =>
    candidateKeyString(a.key) < candidateKeyString(b.key) ? -1 : 1,
  );
}

// ---------------------------------------------------------------------------
// Step 3 — bucket membership predicates (private)
// ---------------------------------------------------------------------------

/** Highly-intelligent: a frontier/strong working-role quality tier. */
function isHighlyIntelligent(row: CandidateRow): boolean {
  return row.metadata.qualityTier === 'frontier' || row.metadata.qualityTier === 'strong';
}

/**
 * Cheap: gated on the CURATED `costTier:'cheap'` band (DECISION F — robust in the
 * all-metered case where effective cost can't distinguish cheap from middle), AND
 * still effectively affordable for this user. The cost gate keeps a cheap-tier model
 * out of the cheap slot when this user can only reach it via an expensive `paid`
 * route above the documented threshold — i.e. a model is only "cheap" if it is both
 * curated-cheap and actually cheap to reach. This is why effective cost is computed
 * BEFORE bucket predicates.
 */
const CHEAP_PAID_USD_THRESHOLD = 5; // per representative-turn proxy (4*input + 1*output, $/MTok)
function isAffordable(cost: EffectiveCost): boolean {
  if (cost.kind === 'free' || cost.kind === 'flat' || cost.kind === 'metered') return true;
  return cost.usd <= CHEAP_PAID_USD_THRESHOLD;
}
function isCheap(row: CandidateRow): boolean {
  return row.metadata.costTier === 'cheap' && isAffordable(row.effectiveCost);
}

/** Strong vision (fail-open): `strong`/`basic` count; only verified `none` is excluded. */
function hasStrongVision(row: CandidateRow): boolean {
  return row.metadata.visionStrength !== 'none';
}

/** Middle: the curated `costTier:'middle'` band (DECISION F — a static band, not derived). */
function isMiddle(row: CandidateRow): boolean {
  return row.metadata.costTier === 'middle';
}

// ---------------------------------------------------------------------------
// Step 4 — ranking (DECISION D — provenance load-bearing sort key + carve-out)
// ---------------------------------------------------------------------------

/** Is this effective cost effectively-free for the user (all-you-can-eat / local)? */
function isEffectivelyFree(cost: EffectiveCost): boolean {
  return cost.kind === 'flat' || cost.kind === 'free';
}

/** Is this effective cost paid/metered (a marginal per-use cost)? */
function isPaidOrMetered(cost: EffectiveCost): boolean {
  return cost.kind === 'paid' || cost.kind === 'metered';
}

/**
 * The minimal shape the within-bucket ranking needs. Exposed so the
 * provenance/carve-out ordering rule (DECISION D) is directly unit-testable
 * without materialising whole catalog rows.
 */
export interface RankingFacts {
  /**
   * The HONEST emitted provenance (`editorial` for Opus 4.8). The carve-out
   * (`carveOutDirection`) keys on THIS — never the inherited ranking tier
   * (DECISION D, Stage 3 confirming-review nuance): latest-in-family inheritance
   * must NOT change the flat-vs-paid subscription carve-out semantics.
   */
  readonly provenance: RecommendationMetadata['provenance'];
  readonly qualityTier: RecommendationMetadata['qualityTier'];
  readonly effectiveCost: EffectiveCost;
  /**
   * The tier used for WITHIN-bucket quality ordering. Normally the row's own
   * `qualityTier`, but for a latest-in-family editorial successor it is the
   * family's best PROVEN tier INHERITED from a same-family eval-grounded member
   * (DECISION C — computed by `inheritedRankingFacts`). Optional so the carve-out
   * unit tests need not supply it; absent ⇒ falls back to `qualityTier`.
   */
  readonly effectiveRankingTier?: RecommendationMetadata['qualityTier'];
  /**
   * `true` when this row should be treated as eval-grounded-equivalent on the
   * WITHIN-FAMILY provenance ordering axis ONLY — set ATOMICALLY with
   * `effectiveRankingTier` by `inheritedRankingFacts` under the SAME same-family
   * eval-grounded-member gate (DECISION C). Does NOT change the emitted
   * `provenance` and is NEVER read by the carve-out. Optional; absent ⇒ the row's
   * own `provenance` decides the provenance axis.
   */
  readonly rankingTierBasis?: 'inherited-eval-grounded';
  /**
   * Availability of the candidate's route — a LOW-priority cross-slot tiebreak
   * (ranked after effective cost, before the id tiebreak). Optional so the carve-out
   * unit tests can exercise the higher-priority axes without supplying it; when
   * absent it is treated as best (`usable-now`), making it a no-op for those tests.
   */
  readonly availability?: RecommendationAvailability;
  /** Stable tiebreak id (the route-aware key string). */
  readonly keyString: string;
}

/**
 * Compute the latest-in-family inheritance facts for a surviving candidate row
 * (DECISION C, Stage 3). BOTH outputs are gated ATOMICALLY on the SAME predicate —
 * a same-family eval-grounded best-config member exists (proven via the row's
 * auditable `provenTierSourceCatalogId` resolving to such a member). When the gate
 * fires the row inherits:
 *   - `effectiveRankingTier` — the family's best PROVEN tier (eval-grounded
 *     best-config), so the editorial successor ranks at the lineage's proven level
 *     for the within-bucket quality axis.
 *   - `rankingTierBasis: 'inherited-eval-grounded'` — treats the row as
 *     eval-grounded-EQUIVALENT on the WITHIN-FAMILY provenance ordering axis only.
 *
 * When the gate does NOT fire (the row is itself eval-grounded, or its family has no
 * proven member — e.g. Fable 5, Gemini) both are `undefined`: the row ranks on its
 * own honest tier/provenance (DECISION D — an editorial new family never borrows
 * proof across families). The emitted `RecommendedModel.provenance` is unaffected.
 */
function inheritedRankingFacts(metadata: RecommendationMetadata): {
  readonly effectiveRankingTier?: RecommendationMetadata['qualityTier'];
  readonly rankingTierBasis?: 'inherited-eval-grounded';
} {
  // Only an editorial row needs (and is eligible for) inheritance.
  if (metadata.provenance === 'eval-grounded') return {};
  const sourceId = metadata.provenTierSourceCatalogId;
  if (!sourceId) return {};
  const source = getRecommendationMetadata(sourceId);
  // The proof source MUST be a same-family eval-grounded best-config member — the
  // atomic same-family-eval-grounded gate (DECISION C/D). A misconfigured source
  // (wrong family / not proven) does NOT fire the inheritance.
  if (
    !source ||
    source.family !== metadata.family ||
    source.provenance !== 'eval-grounded' ||
    source.tierBasis !== 'best-config'
  ) {
    return {};
  }
  const provenTier = FAMILY_BEST_PROVEN_TIER.get(metadata.family);
  if (provenTier === undefined) return {};
  return { effectiveRankingTier: provenTier, rankingTierBasis: 'inherited-eval-grounded' };
}

/**
 * The operationalised "latest successor on an effectively-free subscription"
 * carve-out (DECISION D). An editorial/provisional model MAY outrank an
 * eval-grounded peer for a slot IFF the editorial model is `flat`/`free` for THIS
 * user AND the eval-grounded peer is `metered`/`paid`. Subscription-preference
 * overrides provenance ONLY in the subscription-vs-paid case. Returns -1 if `a`
 * wins the carve-out, +1 if `b` wins, 0 if the carve-out does not apply.
 */
function carveOutDirection(a: RankingFacts, b: RankingFacts): number {
  const aEditorial = a.provenance === 'editorial';
  const bEditorial = b.provenance === 'editorial';
  // Carve-out only resolves an editorial-vs-eval-grounded contest.
  if (aEditorial === bEditorial) return 0;
  const editorial = aEditorial ? a : b;
  const grounded = aEditorial ? b : a;
  if (isEffectivelyFree(editorial.effectiveCost) && isPaidOrMetered(grounded.effectiveCost)) {
    return editorial === a ? -1 : 1;
  }
  return 0;
}

/**
 * Inheritance-usability carve-out (Stage 3 discovered-improvement). A candidate the
 * user can reach RIGHT NOW for free (`usable-now` + `flat`/`free`) outranks an
 * UNREACHABLE, pay-per-use peer (`needs-connection`/`on-plan` + `paid`/`metered`)
 * whose only ranking advantage is the latest-in-family INHERITED tier
 * (`rankingTierBasis === 'inherited-eval-grounded'`).
 *
 * Why this exists — and why it is gated on inheritance specifically: it restores
 * EXACTLY the product invariant Stage 3 otherwise removes, and nothing more. Before
 * Stage 3, an unreachable Opus 4.7 was eval-grounded+`paid` and lost a reachable
 * `flat` *editorial* plan row (e.g. Gemini Pro) via the subscription carve-out
 * (`carveOutDirection`) — so core buckets the plan could satisfy stayed reachable.
 * Stage 3 makes the surviving successor (Opus 4.8) editorial + frontier-EQUIVALENT
 * by inheritance, so that provenance proxy no longer fires and the unreachable
 * inherited row would crowd out a reachable plan pick (the recommend-a-model-you-
 * can't-use footgun). Gating on `rankingTierBasis === 'inherited-eval-grounded'`
 * keeps this surgical: it does NOT promote a reachable-but-weak model over a
 * GENUINELY proven (non-inherited eval-grounded) unreachable peer — that
 * quality-first fall-through (DECISION F) is preserved. Returns -1 if `a` wins, +1
 * if `b` wins, 0 if N/A.
 */
function isReachableFree(f: RankingFacts): boolean {
  return (f.availability ?? 'usable-now') === 'usable-now' && isEffectivelyFree(f.effectiveCost);
}
function isUnreachableInheritedPaid(f: RankingFacts): boolean {
  return (
    (f.availability ?? 'usable-now') !== 'usable-now' &&
    isPaidOrMetered(f.effectiveCost) &&
    f.rankingTierBasis === 'inherited-eval-grounded'
  );
}
function usabilityCarveOutDirection(a: RankingFacts, b: RankingFacts): number {
  if (isReachableFree(a) && isUnreachableInheritedPaid(b)) return -1;
  if (isReachableFree(b) && isUnreachableInheritedPaid(a)) return 1;
  return 0;
}

/**
 * Provenance-aware ranking comparator (DECISION D). Lower sorts first:
 *  1. carve-out (editorial flat/free beats eval-grounded paid/metered) — keys on the
 *     HONEST `provenance`, NEVER the inherited ranking tier (Stage 3 nuance).
 *  1b. inheritance-usability carve-out (reachable-free beats an UNREACHABLE-paid
 *     peer whose advantage is only the inherited tier) — restores the "core buckets
 *     filled by reachable plan rows" invariant that Stage 3's inheritance otherwise
 *     removes from the provenance proxy, without promoting weak reachable models
 *     over genuinely-proven unreachable ones.
 *  2. effective ranking tier (the inherited proven tier for a latest-in-family
 *     editorial successor — DECISION C — else the row's own quality tier)
 *  3. provenance axis (eval-grounded — or inherited-eval-grounded-equivalent — before
 *     plain editorial)
 *  4. effective cost (cheaper-for-this-user first)
 *  5. availability (usable-now before needs-connection/on-plan) — a low-priority
 *     cross-slot tiebreak so a usable-now pick doesn't lose its slot to a
 *     marginally-equal needs-connection peer (DOES NOT override quality / provenance
 *     / effective-cost — quality-first remains the default per DECISION-F).
 *  6. stable id tiebreak
 *
 * The carve-out is checked FIRST so it can override the provenance axis exactly as
 * specified — but only in the flat/free-vs-paid case it gates on. Exported as the
 * load-bearing sort key so the 3 carve-out cases are directly testable.
 *
 * Latest-in-family inheritance (DECISION C): `effectiveRankingTier` /
 * `rankingTierBasis` (computed by `inheritedRankingFacts`) substitute for the raw
 * tier / provenance on the within-family ordering axes ONLY. The carve-out (step 1)
 * and the emitted `RecommendedModel.provenance` stay on the honest value.
 */
export function compareRecommendationRanking(a: RankingFacts, b: RankingFacts): number {
  const carve = carveOutDirection(a, b);
  if (carve !== 0) return carve;

  const usabilityCarve = usabilityCarveOutDirection(a, b);
  if (usabilityCarve !== 0) return usabilityCarve;

  // The effective ranking tier (inherited proven tier for a latest-in-family
  // editorial successor; else the row's own tier).
  const aTier = a.effectiveRankingTier ?? a.qualityTier;
  const bTier = b.effectiveRankingTier ?? b.qualityTier;
  const tierDelta = QUALITY_TIER_RANK[aTier] - QUALITY_TIER_RANK[bTier];
  if (tierDelta !== 0) return tierDelta;

  // Provenance axis: an inherited-eval-grounded-equivalent row ranks alongside a
  // genuine eval-grounded one (DECISION C) — but the emitted provenance + carve-out
  // stay honest.
  const aGrounded =
    a.provenance === 'eval-grounded' || a.rankingTierBasis === 'inherited-eval-grounded' ? 0 : 1;
  const bGrounded =
    b.provenance === 'eval-grounded' || b.rankingTierBasis === 'inherited-eval-grounded' ? 0 : 1;
  if (aGrounded !== bGrounded) return aGrounded - bGrounded;

  const costDelta = compareEffectiveCost(a.effectiveCost, b.effectiveCost);
  if (costDelta !== 0) return costDelta;

  // Availability tiebreak (low priority — only when all higher keys tie). Prefer a
  // model the user can use right now over one needing a connection / on a plan, so a
  // usable-now pick keeps its slot against a marginally-equal needs-connection peer.
  // `availability` is optional on RankingFacts so the carve-out unit tests need not
  // supply it; absent ⇒ treated as best (rank 0), a no-op for those facts-only tests.
  const aAvail = a.availability ? AVAILABILITY_RANK[a.availability] : 0;
  const bAvail = b.availability ? AVAILABILITY_RANK[b.availability] : 0;
  if (aAvail !== bAvail) return aAvail - bAvail;

  return a.keyString < b.keyString ? -1 : a.keyString > b.keyString ? 1 : 0;
}

/** Build the within-bucket ranking facts for a materialised row (incl. inheritance). */
function rankingFactsFor(row: CandidateRow): RankingFacts {
  const inherited = inheritedRankingFacts(row.metadata);
  return {
    provenance: row.metadata.provenance,
    qualityTier: row.metadata.qualityTier,
    effectiveRankingTier: inherited.effectiveRankingTier,
    rankingTierBasis: inherited.rankingTierBasis,
    effectiveCost: row.effectiveCost,
    availability: row.availability,
    keyString: candidateKeyString(row.key),
  };
}

/** Within-bucket comparator over materialised candidate rows. */
function compareWithinBucket(a: CandidateRow, b: CandidateRow): number {
  return compareRecommendationRanking(rankingFactsFor(a), rankingFactsFor(b));
}

/** Best candidate (under the within-bucket comparator) from a list, or undefined. */
function best(rows: readonly CandidateRow[]): CandidateRow | undefined {
  if (rows.length === 0) return undefined;
  return [...rows].sort(compareWithinBucket)[0];
}

/**
 * Did the editorial-flat-vs-eval-paid carve-out (DECISION D) actually DECIDE this
 * pick? True iff the chosen row is editorial + effectively-free AND the pool it beat
 * contained an eval-grounded paid/metered peer that would have won absent the
 * carve-out (i.e. the carve-out is what flipped the winner). Used only to emit a
 * TRUTHFUL trace note — the note must NOT fire on every effectively-free pick (a
 * subscription user's whole set is effectively-free), which is always-on and false.
 */
function carveOutFiredFor(chosen: CandidateRow, pool: readonly CandidateRow[]): boolean {
  if (chosen.metadata.provenance !== 'editorial' || !isEffectivelyFree(chosen.effectiveCost)) {
    return false;
  }
  return pool.some(
    (peer) =>
      peer !== chosen &&
      peer.metadata.provenance === 'eval-grounded' &&
      isPaidOrMetered(peer.effectiveCost),
  );
}

// ---------------------------------------------------------------------------
// Step 5 — fill slots + assemble result
// ---------------------------------------------------------------------------

function toRecommended(row: CandidateRow, bucket: RecommendationBucket): RecommendedModel {
  return {
    catalogKey: row.key,
    modelId: row.key.normalizedModelId,
    optionValue: row.key.optionValue,
    family: row.metadata.family,
    bucket,
    availability: row.availability,
    effectiveCost: row.effectiveCost,
    provenance: row.metadata.provenance,
    qualityTier: row.metadata.qualityTier,
    valueClass: row.metadata.valueClass,
  };
}

/**
 * Select the deterministic "Recommended for most people" set. PURE.
 *
 * @throws never for normal inputs — a bucket that can't be filled is skipped with a
 *   `diagnostics.warnings` entry (never crashes — graceful slot-skip per the scope
 *   guardrail). `effectiveCost` may throw `MissingPricingError` only if an eligible
 *   metadata row references a catalog id with no pricing (a data bug the Stage 2
 *   guard + tests prevent).
 */
export function recommendModels(input: RecommendationInput): RecommendationResult {
  const cap = Math.max(0, input.options?.cap ?? DEFAULT_CAP);
  const includeMiddle = input.options?.includeMiddle ?? false;
  const includeSecondIntelligent = input.options?.includeSecondIntelligent ?? false;

  const managedAllowedSet = new Set(
    input.managedAllowedModels.map((id) => normalizeCatalogModelId(id)),
  );

  const missingMetadata = new Set<string>();
  const warnings: string[] = [];

  // Diagnostics: managed-allow-list ids with no MODEL_CATALOG entry (catalog drift).
  const unmatched: UnmatchedRecord[] = [];
  const catalogNormalizedIds = new Set<string>();
  for (const providerType of ['anthropic', 'openai', 'google', 'openrouter'] as CatalogProviderType[]) {
    for (const entry of PROVIDER_CATALOGS[providerType]) {
      catalogNormalizedIds.add(normalizeCatalogModelId(entry.model));
    }
  }
  for (const id of managedAllowedSet) {
    if (!catalogNormalizedIds.has(id)) {
      unmatched.push({
        modelId: id,
        source: 'managed-allow-list',
        reason: 'Managed allow-list id has no entry in the bundled provider catalogs (catalog drift).',
      });
    }
  }

  const allRows = materialiseCandidates(input, managedAllowedSet, missingMetadata);
  const candidates = dedupByFamily(allRows);

  const picks: RecommendedModel[] = [];
  const trace: SelectorPickTrace[] = [];
  const usedFamilies = new Set<string>();
  // Tracks whether the editorial-flat-vs-eval-paid carve-out (DECISION D) ACTUALLY
  // decided any slot — so the trace note below is truthful, not always-on.
  let carveOutFired = false;

  const remaining = (): CandidateRow[] =>
    candidates.filter((r) => !usedFamilies.has(r.metadata.family));

  /**
   * Take the best of `pool` for `bucket`. Records the carve-out only when it was the
   * deciding factor for THIS slot (the chosen row beat an eval-grounded paid peer in
   * the same pool purely on the subscription carve-out).
   */
  const takeBest = (
    pool: readonly CandidateRow[],
    bucket: RecommendationBucket,
    reason: string,
  ): boolean => {
    const row = best(pool);
    if (!take(row, bucket, reason)) return false;
    if (row && carveOutFiredFor(row, pool)) carveOutFired = true;
    return true;
  };

  function take(
    row: CandidateRow | undefined,
    bucket: RecommendationBucket,
    reason: string,
  ): boolean {
    if (!row) return false;
    if (picks.length >= cap) return false;
    if (usedFamilies.has(row.metadata.family)) return false;
    usedFamilies.add(row.metadata.family);
    picks.push(toRecommended(row, bucket));
    trace.push({ catalogKey: row.key, bucket, reason });
    return true;
  }

  // 4a. best intelligence
  if (!takeBest(remaining().filter(isHighlyIntelligent), 'intelligence', 'Highest-ranked highly-intelligent model for this user.')) {
    warnings.push('No highly-intelligent model available to fill the intelligence slot.');
  }

  // optional 5. 2nd cross-family intelligence pick (Greg's "perhaps two to compare").
  if (includeSecondIntelligent && picks.length < cap) {
    takeBest(remaining().filter(isHighlyIntelligent), 'intelligence', 'Second cross-family highly-intelligent model (compare across families).');
  }

  // 4b. best cheap
  if (!takeBest(remaining().filter(isCheap), 'cheap', 'Cheapest capable model for this user.')) {
    warnings.push('No cheap model available to fill the cheap slot.');
  }

  // 4c. best vision
  if (!takeBest(remaining().filter(hasStrongVision), 'vision', 'Best vision-capable model for this user.')) {
    warnings.push('No vision-capable model available to fill the vision slot.');
  }

  // 4d. optional middle
  if (includeMiddle && picks.length < cap) {
    if (!takeBest(remaining().filter(isMiddle), 'middle', 'Balanced "middle" model.')) {
      warnings.push('Middle slot requested but no suitable middle model available.');
    }
  }

  // 4e. fill the remaining cap by overall score (best first), excluding duplicate families.
  while (picks.length < cap) {
    const pool = remaining();
    const next = best(pool);
    if (!next) break;
    // Bucket the fill pick by its dominant capability for a coherent trace.
    const bucket: RecommendationBucket = isHighlyIntelligent(next)
      ? 'intelligence'
      : isCheap(next)
        ? 'cheap'
        : hasStrongVision(next)
          ? 'vision'
          : 'middle';
    take(next, bucket, 'Fills remaining capacity by overall rank.');
    if (carveOutFiredFor(next, pool)) carveOutFired = true;
  }

  const notes: string[] = [];
  if (picks.length > 0 && picks.every((p) => p.availability !== 'usable-now')) {
    notes.push(
      'No provider connected — returning the editorial near-optimal set marked needs-connection/on-plan.',
    );
  }
  // Truthful carve-out note — fires ONLY when the subscription carve-out actually
  // decided a slot (an editorial effectively-free model outranked an eval-grounded
  // paid/metered peer), NOT on every effectively-free pick. (Claude-F2.)
  if (carveOutFired) {
    notes.push('Subscription-preference applied: an editorial model was favoured over an eval-grounded paid peer because it is effectively-free on your subscription (carve-out).');
  }

  return {
    recommended: picks,
    rationale: { picks: trace, notes },
    diagnostics: {
      unmatched,
      missingMetadata: Array.from(missingMetadata).sort(),
      warnings,
    },
  };
}

/**
 * The set of normalized catalog ids the metadata table covers (either routing
 * form). Exposed for the inverted catalog-rot guard test (DECISION E).
 */
export function getRecommendationCoveredCatalogIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const meta of RECOMMENDATION_METADATA) {
    for (const id of meta.appliesToCatalogIds) {
      ids.add(normalizeCatalogModelId(id));
    }
  }
  return ids;
}
