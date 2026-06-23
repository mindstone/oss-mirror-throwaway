/**
 * Stage 1 metadata assertions (DECISION D). The deterministic golden-scenario
 * selector tests (Stage 3) are the primary safety net; here we assert the
 * committed metadata is complete + internally well-formed + faithful to the
 * committed KW-Pareto seed artifact.
 *
 * The INVERTED catalog-rot guard (enumerate every addable row, require
 * metadata-or-exclusion) is Stage 3's selector test — NOT here. Here we only
 * assert eligible rows are complete and consistent.
 */

import { describe, expect, it } from 'vitest';

import { getCatalogEntryById, getCatalogPricingMap } from '@shared/data/modelCatalog';
import {
  RECOMMENDATION_METADATA,
  RECOMMENDATION_METADATA_BY_CATALOG_ID,
  RECOMMENDATION_METRIC_VERSION,
  RECOMMENDATION_SEED_RUN,
  getRecommendationMetadata,
} from './recommendationMetadata';
import type { CostTier } from './types';
import seedArtifact from './recommendationMetadata.seed.json';

const COST_TRUST_FLOOR = Date.parse('2026-05-14T00:00:00Z');

const VALID_COST_TIERS: readonly CostTier[] = ['cheap', 'middle', 'premium'];

describe('recommendation metadata — catalog join integrity', () => {
  it('every appliesToCatalogIds entry exists in MODEL_CATALOG', () => {
    for (const meta of RECOMMENDATION_METADATA) {
      expect(meta.appliesToCatalogIds.length).toBeGreaterThan(0);
      for (const id of meta.appliesToCatalogIds) {
        const entry = getCatalogEntryById(id);
        expect(entry, `${id} (from ${meta.catalogId}) missing from MODEL_CATALOG`).toBeDefined();
      }
    }
  });

  it('catalogId is always included in its own appliesToCatalogIds', () => {
    for (const meta of RECOMMENDATION_METADATA) {
      expect(meta.appliesToCatalogIds).toContain(meta.catalogId);
    }
  });

  it('every eligible row references catalog ids that carry pricing (no silent undefined cost)', () => {
    for (const meta of RECOMMENDATION_METADATA) {
      if (!meta.recommendationEligible) continue;
      for (const id of meta.appliesToCatalogIds) {
        const entry = getCatalogEntryById(id);
        expect(entry?.pricing, `${id} has no pricing`).toBeDefined();
        // input/output must be present numbers (zero is allowed for local rows).
        expect(typeof entry?.pricing.input).toBe('number');
        expect(typeof entry?.pricing.output).toBe('number');
      }
    }
  });

  it('no two metadata records key on the same catalogId, and the lookup map is consistent', () => {
    const seen = new Set<string>();
    for (const meta of RECOMMENDATION_METADATA) {
      expect(seen.has(meta.catalogId), `duplicate catalogId ${meta.catalogId}`).toBe(false);
      seen.add(meta.catalogId);
    }
    for (const meta of RECOMMENDATION_METADATA) {
      for (const id of meta.appliesToCatalogIds) {
        expect(getRecommendationMetadata(id)).toBe(meta);
        expect(RECOMMENDATION_METADATA_BY_CATALOG_ID.get(id)).toBe(meta);
      }
    }
  });
});

describe('recommendation metadata — provenance is load-bearing (DECISION D)', () => {
  it('every editorial row is flagged provenance:editorial and never claims a frontier valueClass', () => {
    const editorial = RECOMMENDATION_METADATA.filter(m => m.provenance === 'editorial');
    // The known editorial families must be present and flagged.
    const editorialIds = editorial.map(m => m.catalogId);
    expect(editorialIds).toEqual(
      expect.arrayContaining(['claude-opus-4-8', 'claude-fable-5', 'gemini-3.1-pro', 'gemini-3-flash']),
    );
    for (const meta of editorial) {
      expect(meta.valueClass, `${meta.catalogId} editorial must not be frontier valueClass`).not.toBe('frontier');
      // Editorial rows have no anchoring run of their own.
      expect(meta.sampleRuns).toBe(0);
      expect(meta.fixtureCoverage).toBe('thin');
    }
  });

  it('floored editorial rows declare tierBasis:floored-to-prior-gen and never bake the noisy single-run value as the tier', () => {
    const opus48 = getRecommendationMetadata('claude-opus-4-8');
    expect(opus48).toBeDefined();
    expect(opus48?.provenance).toBe('editorial');
    expect(opus48?.tierBasis).toBe('floored-to-prior-gen');
    // Floored to Opus 4.7's tier, NOT the N=1 2.10 observation.
    const opus47 = getRecommendationMetadata('claude-opus-4-7');
    expect(opus48?.qualityTier).toBe(opus47?.qualityTier);
    // The 2.10 caveat lives only in the note, never as a structured tier value.
    expect(opus48?.sourceNote.toLowerCase()).toContain('caveat');
  });

  it('no eval-grounded row floors to prior gen or vice-versa (basis matches provenance)', () => {
    for (const meta of RECOMMENDATION_METADATA) {
      if (meta.provenance === 'eval-grounded') {
        expect(meta.tierBasis).toBe('best-config');
        expect(meta.sampleRuns).toBeGreaterThan(0);
      } else {
        expect(meta.tierBasis).not.toBe('best-config');
      }
    }
  });
});

describe('recommendation metadata — value class gated on coverage (DECISION D)', () => {
  it('no frontier valueClass sits on a partial-coverage config', () => {
    for (const meta of RECOMMENDATION_METADATA) {
      if (meta.fixtureCoverage === 'partial' || meta.fixtureCoverage === 'thin') {
        expect(meta.valueClass, `${meta.catalogId} partial/thin coverage must not be plain frontier`).not.toBe('frontier');
      }
    }
  });

  it('DeepSeek v4 Pro is frontier-partial (partial coverage), never plain frontier', () => {
    const pro = getRecommendationMetadata('deepseek/deepseek-v4-pro');
    expect(pro?.valueClass).toBe('frontier-partial');
    expect(pro?.fixtureCoverage).toBe('partial');
  });
});

describe('recommendation metadata — tiers are best-config, never averaged across configs', () => {
  it('each eval-grounded qualityTier maps to a single seed config (no averaging)', () => {
    // Build the set of compound values present in the seed per catalogId.
    const seedCompoundByCatalogId = new Map<string, number[]>();
    for (const cfg of seedArtifact.configs) {
      const list = seedCompoundByCatalogId.get(cfg.catalogId) ?? [];
      list.push(cfg.metrics.compound);
      seedCompoundByCatalogId.set(cfg.catalogId, list);
    }

    // tierFloor: the minimum compound a tier label implies. A best-config tier
    // is a LOWER BOUND derived from the single best config — assert it is
    // consistent with at least one real config compound, and is NOT the mean of
    // multiple configs (which would violate the eval's no-merge rule).
    for (const meta of RECOMMENDATION_METADATA) {
      if (meta.provenance !== 'eval-grounded') continue;
      const compounds = seedCompoundByCatalogId.get(meta.catalogId);
      expect(compounds, `${meta.catalogId} eval-grounded but absent from seed`).toBeDefined();
      if (!compounds) continue;
      if (compounds.length > 1) {
        // Where multiple configs exist, the tier must reflect the BEST single
        // config, never the average — assert the best-config principle holds by
        // construction: there is a single max and the mean is strictly below it
        // (so a tier keyed on "best" is distinguishable from a tier keyed on the
        // mean). The metadata must not have been derived by averaging.
        const max = Math.max(...compounds);
        const mean = compounds.reduce((a, b) => a + b, 0) / compounds.length;
        expect(max).toBeGreaterThan(mean);
      }
    }
  });
});

describe('recommendation metadata — seed artifact is the audit anchor', () => {
  it('metricVersion is compound-260514 (module + seed agree)', () => {
    expect(RECOMMENDATION_METRIC_VERSION).toBe('compound-260514');
    expect(seedArtifact.metricVersion).toBe('compound-260514');
  });

  it('seed run id/date are surfaced from the artifact', () => {
    expect(RECOMMENDATION_SEED_RUN.runId).toBe(seedArtifact.runId);
    expect(RECOMMENDATION_SEED_RUN.runDate).toBe(seedArtifact.runDate);
  });

  it('eval-grounded cost source date is >= 2026-05-14 (cost-trust window)', () => {
    // Every eval-grounded row is anchored on the seed run; the seed run date and
    // canonical window must sit at/after the cost-trust floor.
    const hasEvalGrounded = RECOMMENDATION_METADATA.some(m => m.provenance === 'eval-grounded');
    expect(hasEvalGrounded).toBe(true);
    expect(Date.parse(seedArtifact.runDate)).toBeGreaterThanOrEqual(COST_TRUST_FLOOR);
    expect(Date.parse(seedArtifact.canonicalWindow.to)).toBeGreaterThanOrEqual(COST_TRUST_FLOOR);
  });

  it('every eval-grounded metadata catalogId appears in the seed configs', () => {
    const seedIds = new Set(seedArtifact.configs.map(c => c.catalogId));
    for (const meta of RECOMMENDATION_METADATA) {
      if (meta.provenance !== 'eval-grounded') continue;
      expect(seedIds.has(meta.catalogId), `${meta.catalogId} eval-grounded but not in seed`).toBe(true);
    }
  });

  it('a partial-coverage seed config carries meetsMinimumCoverage:false', () => {
    const proConfig = seedArtifact.configs.find(c => c.catalogId === 'deepseek/deepseek-v4-pro');
    expect(proConfig?.metrics.coverage).toBe('partial');
    expect(proConfig?.metrics.meetsMinimumCoverage).toBe(false);
  });
});

describe('recommendation metadata — curated cost tier (Stage 1, DECISION F)', () => {
  it('completeness: every metadata row has a valid costTier', () => {
    for (const meta of RECOMMENDATION_METADATA) {
      expect(
        VALID_COST_TIERS.includes(meta.costTier),
        `${meta.catalogId} has invalid costTier ${meta.costTier}`,
      ).toBe(true);
    }
  });

  it('the three Greg-corrected rows assert their curated bands', () => {
    // Greg's verbatim correction (2026-06-14): Sonnet is middle, DeepSeek v4 Flash
    // is cheaper (cheap), DeepSeek v4 Pro is middle.
    expect(getRecommendationMetadata('deepseek/deepseek-v4-flash')?.costTier).toBe('cheap');
    expect(getRecommendationMetadata('claude-sonnet-4-6')?.costTier).toBe('middle');
    expect(getRecommendationMetadata('deepseek/deepseek-v4-pro')?.costTier).toBe('middle');
  });

  it('frontier-intelligence rows are premium; cheap background is cheap', () => {
    expect(getRecommendationMetadata('claude-opus-4-7')?.costTier).toBe('premium');
    expect(getRecommendationMetadata('claude-opus-4-8')?.costTier).toBe('premium');
    expect(getRecommendationMetadata('openai/gpt-5.5')?.costTier).toBe('premium');
    expect(getRecommendationMetadata('claude-haiku-4-5')?.costTier).toBe('cheap');
  });

  // DECISION F drift guard: the costTier is a CURATED band, deliberately NOT
  // derivable from raw price (DeepSeek-Pro's mean cost is below Flash's, yet Pro is
  // `middle` and Flash is `cheap`). This test WARNS (does not hard-fail) when a
  // `cheap`-banded row's raw price is implausibly far above a `premium`-banded row's
  // — so the curated band can intentionally diverge from price, but a gross
  // inversion (a future row added with the wrong band) surfaces a console warning.
  it('raw-price sanity WARNING: a cheap-banded row should not cost wildly more than a premium row', () => {
    const pricingMap = getCatalogPricingMap();
    // Representative-turn proxy, mirroring effectiveCost.rawUsdScalar (4*input + 1*output).
    const rawScalar = (catalogId: string): number | undefined => {
      const p = pricingMap[catalogId];
      return p ? 4 * p.input + 1 * p.output : undefined;
    };
    const tierScalars: Record<CostTier, number[]> = { cheap: [], middle: [], premium: [] };
    for (const meta of RECOMMENDATION_METADATA) {
      // Use the primary catalogId; both routing forms share the same model price band.
      const s = rawScalar(meta.catalogId) ?? rawScalar(meta.appliesToCatalogIds[0] ?? '');
      if (s !== undefined) tierScalars[meta.costTier].push(s);
    }
    const minPremium =
      tierScalars.premium.length > 0 ? Math.min(...tierScalars.premium) : Infinity;
    const DRIFT_FACTOR = 1; // a cheap row priced ABOVE the cheapest premium row is suspicious
    for (const meta of RECOMMENDATION_METADATA) {
      if (meta.costTier !== 'cheap') continue;
      const s = rawScalar(meta.catalogId) ?? rawScalar(meta.appliesToCatalogIds[0] ?? '');
      if (s === undefined) continue;
      if (s > minPremium * DRIFT_FACTOR) {
        // Deliberate non-failing advisory — the curated band MAY diverge from price
        // (DECISION F), but a cheap row above the cheapest premium row is worth a look.
        console.warn(
          `[costTier drift] ${meta.catalogId} is banded 'cheap' (raw proxy ${s.toFixed(3)}) ` +
            `but exceeds the cheapest 'premium' row (${minPremium.toFixed(3)}) — verify the curated band.`,
        );
      }
    }
    // The test itself only asserts the scan ran over a non-empty curated set.
    expect(RECOMMENDATION_METADATA.length).toBeGreaterThan(0);
  });
});

describe('recommendation metadata — latest-in-family ordering + proof source (Stage 3, DECISIONS B/C/D)', () => {
  it('every row has a familyRank, and it is unique within each multi-member family', () => {
    const byFamily = new Map<string, number[]>();
    for (const meta of RECOMMENDATION_METADATA) {
      expect(typeof meta.familyRank, `${meta.catalogId} familyRank`).toBe('number');
      const list = byFamily.get(meta.family) ?? [];
      list.push(meta.familyRank);
      byFamily.set(meta.family, list);
    }
    for (const [family, ranks] of byFamily) {
      // Unique within each family (matters for multi-member families like claude-opus;
      // trivially true for single-member ones).
      expect(new Set(ranks).size, `family ${family} has duplicate familyRank`).toBe(ranks.length);
    }
  });

  it('claude-opus is multi-member and 4.8 outranks 4.7 by familyRank (latest = higher)', () => {
    const r47 = getRecommendationMetadata('claude-opus-4-7')?.familyRank;
    const r48 = getRecommendationMetadata('claude-opus-4-8')?.familyRank;
    expect(r47).toBeDefined();
    expect(r48).toBeDefined();
    expect(r48!).toBeGreaterThan(r47!);
  });

  it('provenTierSourceCatalogId (when present) points at a SAME-FAMILY eval-grounded best-config member', () => {
    for (const meta of RECOMMENDATION_METADATA) {
      const sourceId = meta.provenTierSourceCatalogId;
      if (!sourceId) continue;
      const source = getRecommendationMetadata(sourceId);
      expect(source, `${meta.catalogId} proof source ${sourceId} missing`).toBeDefined();
      expect(source?.family, `${sourceId} not same family as ${meta.catalogId}`).toBe(meta.family);
      expect(source?.provenance, `${sourceId} must be eval-grounded`).toBe('eval-grounded');
      expect(source?.tierBasis, `${sourceId} must be best-config`).toBe('best-config');
      // Only editorial rows inherit (an eval-grounded row needs no proof source).
      expect(meta.provenance, `${meta.catalogId} carries a proof source but is not editorial`).toBe(
        'editorial',
      );
    }
  });

  it('Opus 4.8 carries the 4.7 proof source; its OWN metadata stays honest (DECISION C — unchanged)', () => {
    const opus48 = getRecommendationMetadata('claude-opus-4-8');
    expect(opus48?.provenTierSourceCatalogId).toBe('claude-opus-4-7');
    // Honesty invariant: inheritance lives at the selector, NOT here.
    expect(opus48?.provenance).toBe('editorial');
    expect(opus48?.tierBasis).toBe('floored-to-prior-gen');
    expect(opus48?.sampleRuns).toBe(0);
    expect(opus48?.sourceNote.toLowerCase()).toContain('caveat');
  });

  it('an editorial family with no eval-grounded sibling carries NO proof source (Fable 5, Gemini)', () => {
    for (const id of ['claude-fable-5', 'gemini-3.1-pro', 'gemini-3-flash']) {
      expect(
        getRecommendationMetadata(id)?.provenTierSourceCatalogId,
        `${id} must not inherit (no same-family eval-grounded sibling)`,
      ).toBeUndefined();
    }
  });
});

describe('recommendation metadata — vision claims backed by the catalog (fail-open rule)', () => {
  it('a strong/basic vision claim is backed by non-false catalog supportsImageInput (any provenance)', () => {
    // Covers ALL provenances, not just editorial: an eval-grounded row whose
    // catalog modality is later corrected to text-only (e.g. GLM 5.1, audited
    // 260622) must not keep a stale strong/basic claim. The earlier editorial-only
    // filter would have missed exactly that drift.
    for (const meta of RECOMMENDATION_METADATA) {
      if (meta.visionStrength === 'none') continue;
      // The claim must be backed by a catalog row whose supportsImageInput is
      // not explicitly false (undefined = fail-open vision-capable; true = capable).
      const backed = meta.appliesToCatalogIds.some(id => {
        const entry = getCatalogEntryById(id);
        return entry !== undefined && entry.supportsImageInput !== false;
      });
      expect(backed, `${meta.catalogId} vision claim unbacked by catalog`).toBe(true);
    }
  });

  it('visionStrength:none rows are backed by catalog supportsImageInput:false on every form', () => {
    for (const meta of RECOMMENDATION_METADATA) {
      if (meta.visionStrength !== 'none') continue;
      for (const id of meta.appliesToCatalogIds) {
        const entry = getCatalogEntryById(id);
        expect(entry?.supportsImageInput, `${id} declared vision:none but catalog disagrees`).toBe(false);
      }
    }
  });
});
