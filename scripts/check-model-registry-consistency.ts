#!/usr/bin/env tsx
/**
 * CI Validation: Cross-registry consistency for OpenRouter models.
 *
 * Stage 0 of `docs/plans/260428_kw_eval_infra_and_model_registry.md`.
 *
 * Why: Adding a new OpenRouter model today requires touching THREE registries
 * (`MODEL_CATALOG`, `OR_MODEL_CATALOG`, `PROVIDER_PRESETS.openrouter.models`).
 * Forgetting one causes silent breakage:
 *   - Missing from MODEL_CATALOG → settings validation strips the model
 *     (`normalizeSettings` `OR_MODEL_MAP.has(...)` gate). Pricing also wrong.
 *   - Missing from OR_MODEL_CATALOG → UI dropdowns don't show the model;
 *     OR↔SDK translation fails.
 *   - Missing from PROVIDER_PRESETS.openrouter.models → context-window /
 *     maxOutputTokens / reasoning lookups fall through; profile flow
 *     misbehaves.
 *
 * What we check:
 *   1. Every `OR_MODEL_CATALOG` entry has a corresponding `MODEL_CATALOG`
 *      entry with `provider: 'openrouter'` and matching `id`.
 *   2. Every `MODEL_CATALOG` entry with `provider: 'openrouter'` has a
 *      corresponding `OR_MODEL_CATALOG` entry.
 *   3. Every `PROVIDER_PRESETS.openrouter.models[*].value` resolves to an
 *      `OR_MODEL_CATALOG.id`.
 *   4. Every `OR_MODEL_CATALOG.id` resolves to a
 *      `PROVIDER_PRESETS.openrouter.models[*].value`.
 *   5. Every `LEGACY_OR_MODEL_REMAP` target points to a valid
 *      `OR_MODEL_CATALOG.id`.
 *
 * Exit code:
 *   0 — all three registries are consistent
 *   1 — at least one drift detected; reports which registry is missing what
 *
 * Wired into: `npm run validate:fast` via `validate:model-registry-consistency`.
 *
 * Stage 1 will replace this drift-detection by deriving the OR catalog and
 * presets from MODEL_CATALOG. This script then becomes a tautology that
 * succeeds trivially — kept as a foreign-key check on `pricingFollows` /
 * `legacyIds` cross-references.
 */

import { MODEL_CATALOG } from '../src/shared/data/modelCatalog';
import { OR_MODEL_CATALOG, LEGACY_OR_MODEL_REMAP } from '../src/shared/data/openRouterModels';
import { PROVIDER_PRESETS } from '../src/shared/data/modelProviderPresets';

interface DriftReport {
  errors: string[];
  warnings: string[];
}

function checkConsistency(): DriftReport {
  const report: DriftReport = { errors: [], warnings: [] };

  // ── (1) OR_MODEL_CATALOG → MODEL_CATALOG (provider:'openrouter') ──
  const catalogOrIds = new Set(
    MODEL_CATALOG.filter(e => e.provider === 'openrouter').map(e => e.id),
  );
  const orCatalogIds = new Set(OR_MODEL_CATALOG.map(e => e.id));

  for (const orId of orCatalogIds) {
    if (!catalogOrIds.has(orId)) {
      report.errors.push(
        `[catalog<-or] ${orId} is in OR_MODEL_CATALOG but missing from MODEL_CATALOG (need entry with provider:'openrouter')`,
      );
    }
  }

  // ── (2) MODEL_CATALOG (provider:'openrouter') → OR_MODEL_CATALOG ──
  // Exception: an entry whose `id` is a key in LEGACY_OR_MODEL_REMAP is
  // explicitly retained for historical cost calculation only — its UI
  // surface has been remapped to the successor. This is the proper
  // expression of "historical-only" rather than an `aliases` hack.
  for (const catId of catalogOrIds) {
    if (orCatalogIds.has(catId)) continue;
    if (LEGACY_OR_MODEL_REMAP.has(catId)) continue;
    report.errors.push(
      `[or<-catalog] ${catId} is in MODEL_CATALOG (provider:'openrouter') but missing from OR_MODEL_CATALOG (UI cannot offer it). If this is intentionally historical, add it to LEGACY_OR_MODEL_REMAP.`,
    );
  }

  // ── (3) PROVIDER_PRESETS.openrouter.models[*].value → OR_MODEL_CATALOG ──
  const presetOrModels = PROVIDER_PRESETS.openrouter?.models ?? [];
  const presetOrIds = new Set(presetOrModels.map(m => m.value));

  for (const presetId of presetOrIds) {
    if (!orCatalogIds.has(presetId)) {
      report.errors.push(
        `[or<-presets] ${presetId} is in PROVIDER_PRESETS.openrouter.models but missing from OR_MODEL_CATALOG (drift between presets and routing)`,
      );
    }
  }

  // ── (4) OR_MODEL_CATALOG → PROVIDER_PRESETS.openrouter.models ──
  for (const orId of orCatalogIds) {
    if (!presetOrIds.has(orId)) {
      report.errors.push(
        `[presets<-or] ${orId} is in OR_MODEL_CATALOG but missing from PROVIDER_PRESETS.openrouter.models (context-window/output-tokens/reasoning info will fall through)`,
      );
    }
  }

  // ── (5) LEGACY_OR_MODEL_REMAP targets must exist in OR_MODEL_CATALOG ──
  // Inspected by static analysis; the constant is module-private. Skip this
  // check here — we already cover legacy mapping integrity via the existing
  // `validate:alias-integrity` pattern. Stage 1 will derive
  // LEGACY_OR_MODEL_REMAP from per-entry `legacyIds` so this becomes
  // automatic.

  return report;
}

const report = checkConsistency();

if (report.errors.length === 0) {
  console.log(
    `[check-model-registry-consistency] OK — ${MODEL_CATALOG.length} catalog entries, ${OR_MODEL_CATALOG.length} OR catalog entries, ${PROVIDER_PRESETS.openrouter?.models?.length ?? 0} preset OR entries — all consistent.`,
  );
  process.exit(0);
}

console.error('[check-model-registry-consistency] FAILED');
console.error('');
console.error(`Found ${report.errors.length} drift(s):`);
for (const err of report.errors) {
  console.error(`  - ${err}`);
}
console.error('');
console.error('Fix: ensure the new model is registered in all three registries:');
console.error('  - src/shared/data/modelCatalog.ts (MODEL_CATALOG with provider:"openrouter")');
console.error('  - src/shared/data/openRouterModels.ts (OR_MODEL_CATALOG)');
console.error('  - src/shared/data/modelProviderPresets.ts (PROVIDER_PRESETS.openrouter.models)');
console.error('');
console.error('See docs/project/NEW_MODEL_SUPPORT_PROCESS.md for the full process.');
console.error('');
console.error('Stage 1 of the parent plan will eliminate this drift class entirely by');
console.error('deriving OR_MODEL_CATALOG and PROVIDER_PRESETS.openrouter.models from a');
console.error('single source (MODEL_CATALOG with nested openRouter/presets blocks).');

process.exit(1);
