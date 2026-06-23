/**
 * Public barrel for the deterministic "Recommended for most people" recommendation
 * engine (`src/core/modelRecommendation/`).
 *
 * The engine is PURE — no electron / electron-store import — so it runs identically
 * on desktop, cloud, and mobile. Consumers (the Add-a-model UI rewrite; a possible
 * future runtime-router usable-routing-pool projection) import from here.
 *
 * @see docs/plans/260614_recommended-models-engine/PLAN.md
 */

// --- Public entry point ---
export {
  recommendModels,
  getRecommendationCoveredCatalogIds,
  compareRecommendationRanking,
} from './recommendModels';
export type { RankingFacts } from './recommendModels';

// --- API contract types ---
export type {
  RecommendationInput,
  RecommendationOptions,
  RecommendationResult,
  RecommendationDiagnostics,
  RecommendedModel,
  RecommendationCandidateKey,
  RecommendationCandidateKeyString,
  RecommendationAvailability,
  RecommendationBucket,
  RecommendationProvenance,
  RecommendationMetadata,
  EffectiveCost,
  QualityTier,
  ValueClass,
  VisionStrength,
  QualityTierBasis,
  FixtureCoverage,
  SelectorTrace,
  SelectorPickTrace,
  UnmatchedRecord,
} from './types';

// --- Effective cost (route-aware, provider-conditional) ---
export {
  effectiveCost,
  compareEffectiveCost,
  rawUsdScalar,
  MissingPricingError,
} from './effectiveCost';

// --- Committed metadata + seed provenance ---
export {
  RECOMMENDATION_METADATA,
  RECOMMENDATION_METADATA_BY_CATALOG_ID,
  RECOMMENDATION_METRIC_VERSION,
  RECOMMENDATION_SEED_RUN,
  getRecommendationMetadata,
} from './recommendationMetadata';

// --- Explicit exclusions (inverted catalog-rot guard support) ---
export {
  RECOMMENDATION_EXCLUSIONS,
  isRecommendationExcluded,
} from './recommendationExclusions';
export type { RecommendationExclusion } from './recommendationExclusions';
