/**
 * Canonical model identity — the single source of truth for deciding whether two
 * model-id strings refer to the *same model*, independent of how they were spelled.
 *
 * Why this exists: model ids reach us in several shapes — a configured catalog alias
 * (`claude-opus-4-8`), a provider-served dated snapshot (`anthropic/claude-4.8-opus-20260528`),
 * an OpenRouter `provider/model` form, or a `[1m]` extended-context suffix. Comparing these
 * as raw strings is the load-bearing bug behind the Turn Usage tooltip showing one model as
 * two rows (see docs/plans/260601_diagnose-model-tier-tooltip/PLAN.md). Role↔usage matching and
 * row dedup must compare on a *canonical* key, never the raw string.
 *
 * Layering: this is the public identity contract. It delegates to the pricing catalog's alias
 * resolver internally (the catalog is the unified model registry) but exposes explicit
 * unknown/local semantics — it NEVER returns null, so callers can always key/dedup on `canonical`.
 * Pricing concerns stay in pricingCalculator; identity concerns live here. Consumers that need a
 * canonical model key should import from this module, not from pricingCalculator.
 *
 * @see src/shared/utils/pricingCalculator.ts (resolveModelAlias — internal delegate)
 * @see src/shared/data/modelCatalog.ts (the unified registry the alias map derives from)
 */

import { resolveModelAlias } from './pricingCalculator';

/** How a raw id was resolved to its canonical form. */
export type CanonicalizationSource =
  /** Matched a known catalog alias / dated snapshot (e.g. `claude-opus-4-8`). */
  | 'alias'
  /** Matched via an OpenRouter `provider/model` form (e.g. `anthropic/claude-4.8-opus-...`). */
  | 'openrouter'
  /** Not in the catalog (local / unknown model) — canonical is a lightly-normalized raw id. */
  | 'raw';

export interface CanonicalModelId {
  /** Canonical key for equality/dedup. Lowercased; stable across spellings of the same model. */
  canonical: string;
  /** Provenance of the canonicalization. `'raw'` means the model is unknown to the catalog. */
  source: CanonicalizationSource;
  /** The original input, preserved verbatim for display/debugging. */
  raw: string;
}

/**
 * Resolve a raw model-id string to a canonical identity. Never throws, never returns null.
 *
 * Known catalog models (and their dated snapshots / `[1m]` / OpenRouter forms) collapse to the
 * shared catalog alias. Unknown/local models fall back to a lightly-normalized form of the raw id
 * (lowercased, `[1m]` suffix stripped) so they still dedup against themselves without being
 * conflated with anything else.
 */
export function toCanonicalModelId(raw: string): CanonicalModelId {
  const trimmed = (raw ?? '').trim();
  const hadSlash = trimmed.includes('/');

  // Lightly normalize (lowercase, drop the [1m] extended-context suffix).
  const normalized = trimmed.toLowerCase().replace(/\[1m\]$/i, '');

  // (1) Resolve via the pricing alias map (handles dated snapshots and the OpenRouter
  //     `provider/model` forms the catalog knows).
  const alias = resolveModelAlias(normalized);

  if (alias) {
    // KNOWN model. Some catalog pricing keys are themselves provider-prefixed (e.g.
    // `anthropic/claude-opus-4-8` resolves to itself); reduce such a result to its bare id and
    // re-resolve so every spelling of a known model — bare alias, dated snapshot, provider/model —
    // converges to one canonical key.
    if (alias.includes('/')) {
      const bare = alias.slice(alias.lastIndexOf('/') + 1);
      const bareAlias = resolveModelAlias(bare);
      return { canonical: bareAlias ?? bare, source: 'openrouter', raw };
    }
    return { canonical: alias, source: hadSlash ? 'openrouter' : 'alias', raw };
  }

  // UNKNOWN / local model. Do NOT strip a `provider/` prefix here: two different unknown models
  // such as `providerA/foo` and `providerB/foo` must stay distinct (stripping would collapse both
  // to `foo` and mis-bind role→usage). Keep the full normalized form as its own canonical key.
  return { canonical: normalized, source: 'raw', raw };
}

/** True when two model-id strings refer to the same model regardless of spelling. */
export function isSameModel(a: string, b: string): boolean {
  return toCanonicalModelId(a).canonical === toCanonicalModelId(b).canonical;
}
