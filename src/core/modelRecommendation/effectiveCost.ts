/**
 * Route-aware, provider-conditional EFFECTIVE COST for a recommendation candidate.
 *
 * This is the central nuance of the recommendation engine (Greg's "all-you-can-eat"
 * point): a model's cost to THIS user depends on how they reach it. The catalog
 * carries two routing forms of the same conceptual model — a bare/direct id
 * (`gpt-5.5`, `claude-opus-4-8`) and an OpenRouter slash-id (`openai/gpt-5.5`,
 * `anthropic/claude-opus-4-8`) — with DIFFERENT economics. So cost is computed per
 * route-aware candidate ROW (DECISION A), keyed on its `optionValue`.
 *
 * DECISION B: this consumes the PURE `resolveBillingSourceForModel(...)` directly —
 * no synthetic `AppSettings`.
 *
 * DECISION C (billing-source → effective-cost mapping):
 *  - `subscription`  → `flat`   (ChatGPT-Pro GPT-5.5, Mindstone-plan models)
 *  - `local`         → `free`
 *  - `pool`          → `metered` (personal OpenRouter credits — discounted, below
 *                                 `flat`, above `paid`)
 *  - `pay-per-use`   → `{ kind: 'paid', usd: <representative-turn proxy> }`
 *
 * PURE: no electron, no I/O, no logging. Same inputs → same output.
 */

import {
  resolveBillingSourceForModel,
  type BillingSource,
} from '@shared/utils/billingSource';
import { getCatalogPricingMap } from '@shared/data/modelCatalog';
import type { ModelPricingInfo } from '@shared/data/modelCatalog';
import { normalizeCatalogModelId } from '@shared/data/providerCatalogs';

import type { EffectiveCost, RecommendationCandidateKey, RecommendationInput } from './types';

/**
 * Whether a slash-id candidate under `activeProvider:'mindstone'` is NOT in the
 * managed allow-list — i.e. the mindstone-subscription billing flip fired but the
 * model is not actually usable on the plan. Normalizes both the candidate's
 * `optionValue` and the allow-list ids via `normalizeCatalogModelId` so membership
 * is computed EXACTLY as `computeAvailability` (recommendModels.ts) does (which is
 * what marks such rows `on-plan`/`needs-connection`). Used to gate F1's re-pricing.
 */
function isUnmanagedMindstoneSlashRow(
  candidate: RecommendationCandidateKey,
  input: RecommendationInput,
): boolean {
  // Only OpenRouter slash-id rows hit the mindstone-subscription flip in the
  // billing helper (`optionValue.includes('/')`). Bare `gpt-` rows reach
  // `subscription` via the codex path, NOT this one — they must NOT be re-priced.
  if (!candidate.optionValue.includes('/')) {
    return false;
  }
  const normalized = normalizeCatalogModelId(candidate.optionValue);
  return !input.managedAllowedModels.some(
    (id) => normalizeCatalogModelId(id) === normalized,
  );
}

/**
 * Representative-turn input:output weighting for the raw-USD proxy (Cost-F2).
 *
 * `getCatalogPricingMap()` returns per-MILLION-token prices (`ModelPricingInfo`),
 * not a single scalar. We collapse that vector to one comparable number using a
 * documented 4:1 input:output turn proxy — mirroring the cost ledger's
 * `inputRate*inputTokens + outputRate*outputTokens` shape. This is intentionally a
 * coarse ORDERING proxy for intra-bucket ranking, NOT a billing-accurate estimate;
 * it is NOT `getModelCostTier` (output-only + too coarse to order within a bucket).
 */
const REPRESENTATIVE_INPUT_WEIGHT = 4;
const REPRESENTATIVE_OUTPUT_WEIGHT = 1;

/**
 * The documented representative-turn weighted raw-USD proxy:
 * `4 * pricing.input + 1 * pricing.output` (per-MTok prices).
 */
export function rawUsdScalar(pricing: ModelPricingInfo): number {
  return REPRESENTATIVE_INPUT_WEIGHT * pricing.input + REPRESENTATIVE_OUTPUT_WEIGHT * pricing.output;
}

const BILLING_SOURCE_TO_COST_KIND: Record<
  Exclude<BillingSource, 'pay-per-use'>,
  Exclude<EffectiveCost, { kind: 'paid' }>
> = {
  subscription: { kind: 'flat' },
  local: { kind: 'free' },
  pool: { kind: 'metered' },
};

/**
 * Thrown when an eligible candidate hits the `pay-per-use` path but the catalog has
 * no pricing for it — that would silently produce an `undefined` USD scalar, hiding
 * a real data gap. Surfacing it loudly is the point ("silent failure is a bug").
 */
export class MissingPricingError extends Error {
  constructor(
    readonly optionValue: string,
    readonly normalizedModelId: string,
  ) {
    super(
      `effectiveCost: candidate "${optionValue}" (normalized "${normalizedModelId}") resolved to ` +
        `pay-per-use but has no pricing in getCatalogPricingMap(). An eligible recommendation ` +
        `candidate on the paid path must have catalog pricing.`,
    );
    this.name = 'MissingPricingError';
  }
}

/**
 * Compute the user-conditional effective cost of reaching a candidate via its
 * route-aware row.
 *
 * @throws {MissingPricingError} if a `pay-per-use` candidate has no catalog pricing.
 */
export function effectiveCost(
  candidate: RecommendationCandidateKey,
  input: RecommendationInput,
): EffectiveCost {
  // Defensive `routeSurface:'local'` short-circuit (Cost-F3): the option-string
  // helper only returns `local` for `ollama:`/`ollama/` ids, so a `provider:'local'`
  // catalog row (e.g. bare `deepseek-v4-flash`, zero pricing) would otherwise
  // mis-map. Local routes have no marginal cost — short-circuit BEFORE the helper.
  if (candidate.routeSurface === 'local') {
    return { kind: 'free' };
  }

  const hasOpenRouterOAuth = input.connectivity.openRouterConnected === true;

  const billingSource = resolveBillingSourceForModel({
    optionValue: candidate.optionValue,
    activeProvider: input.activeProvider,
    // `openRouterConnected` is derived from `openRouter.oauthToken` presence
    // (connectivityHelpers.getProfileConnectivityStateFromSettings) — exactly the
    // `hasOpenRouterOAuth` signal the billing flip keys on.
    hasOpenRouterOAuth,
    codexConnected: input.connectivity.codexConnected === true,
  });

  // F1 (Stage 5 fix — engine-side, NOT the shipped billing adapter): the billing
  // helper correctly returns `subscription` for ANY OpenRouter slash row under
  // `activeProvider === 'mindstone'` (managed billing semantics). But only models
  // in the server-authoritative managed allow-list are actually USABLE on the plan
  // (`computeAvailability` marks the rest `on-plan`/`needs-connection`). Pricing a
  // NON-allowlisted slash row `flat` would let quality-first ranking float an
  // unusable row above the genuine plan rows — defeating Greg's "prefer the
  // all-you-can-eat subscription" intent in the exact subscription scenario.
  //
  // So when the mindstone-subscription flip fired for a slash row that is NOT in
  // the allow-list, re-price it as the route the user would actually have to use
  // to reach it: `pool` (metered) if they have a personal OpenRouter token, else
  // `pay-per-use` (the raw-USD scalar). Allowlisted slash rows under mindstone stay
  // `flat`. This only touches the mindstone-slash path — the bare `gpt-` codex
  // flat path and genuine pool/pay-per-use are untouched.
  if (
    billingSource === 'subscription' &&
    input.activeProvider === 'mindstone' &&
    isUnmanagedMindstoneSlashRow(candidate, input)
  ) {
    if (hasOpenRouterOAuth) {
      return { kind: 'metered' };
    }
    const pricing = lookupPricing(candidate);
    if (!pricing) {
      throw new MissingPricingError(candidate.optionValue, candidate.normalizedModelId);
    }
    return { kind: 'paid', usd: rawUsdScalar(pricing) };
  }

  if (billingSource === undefined || billingSource === 'pay-per-use') {
    // `undefined` only for an empty option value, which an eligible candidate row
    // never has; treat both as the paid path and require pricing.
    const pricing = lookupPricing(candidate);
    if (!pricing) {
      throw new MissingPricingError(candidate.optionValue, candidate.normalizedModelId);
    }
    return { kind: 'paid', usd: rawUsdScalar(pricing) };
  }

  return BILLING_SOURCE_TO_COST_KIND[billingSource];
}

/**
 * Cheapness rank of an effective-cost KIND (lower = cheaper for this user):
 * `free` < `flat` < `metered` < `paid`.
 *
 * `flat` (all-you-can-eat subscription, zero marginal cost) is cheaper than
 * `metered` (personal OpenRouter credits — discounted but still per-token), which
 * is cheaper than `paid` (full pay-per-use). Within `paid`, `usd` breaks the tie
 * (handled by {@link compareEffectiveCost}). This is the ordering Greg's "prefer
 * the all-you-can-eat subscription" point depends on (DECISION C).
 */
const COST_KIND_RANK: Record<EffectiveCost['kind'], number> = {
  free: 0,
  flat: 1,
  metered: 2,
  paid: 3,
};

/**
 * Total ordering over effective costs: cheaper-for-this-user sorts first.
 * `free` < `flat` < `metered` < `paid`; ties within `paid` broken by `usd`.
 * Returns <0 if `a` is cheaper, >0 if `b` is cheaper, 0 if equal.
 */
export function compareEffectiveCost(a: EffectiveCost, b: EffectiveCost): number {
  const rankDelta = COST_KIND_RANK[a.kind] - COST_KIND_RANK[b.kind];
  if (rankDelta !== 0) {
    return rankDelta;
  }
  if (a.kind === 'paid' && b.kind === 'paid') {
    return a.usd - b.usd;
  }
  return 0;
}

/**
 * Look up catalog pricing for a candidate. `getCatalogPricingMap()` keys on the
 * canonical `MODEL_CATALOG` id, and both routing forms of a model are present as
 * distinct catalog ids (`gpt-5.5` AND `openai/gpt-5.5`), so the candidate's
 * `optionValue` is the primary key; fall back to the normalized id.
 */
function lookupPricing(candidate: RecommendationCandidateKey): ModelPricingInfo | undefined {
  const pricingMap = getCatalogPricingMap();
  return pricingMap[candidate.optionValue] ?? pricingMap[candidate.normalizedModelId];
}
