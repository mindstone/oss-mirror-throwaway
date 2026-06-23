import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG } from '../modelCatalog';
import {
  OR_MODEL_CATALOG,
  OR_MODEL_MAP,
  OR_TO_SDK_MAP,
  LEGACY_OR_MODEL_REMAP,
  resolveOrModelToSdkId,
} from '../openRouterModels';
import { PROVIDER_PRESETS, _deriveOpenRouterPresetModelsForTesting } from '../modelProviderPresets';
import { getCatalogEntryById, getCatalogAliasMap } from '../modelCatalog';

function resolveCatalogTarget(target: string): boolean {
  if (getCatalogEntryById(target)) return true;
  const alias = getCatalogAliasMap()[target];
  return alias !== undefined && getCatalogEntryById(alias) !== undefined;
}

/**
 * Stage 1 (docs/plans/260428_kw_eval_infra_and_model_registry.md) made
 * `MODEL_CATALOG` the single source of truth for OpenRouter routing,
 * pricing, and dropdown metadata. These tests enforce the derivation
 * invariants so that adding/removing a catalog entry can never silently
 * desync `OR_MODEL_CATALOG`, `LEGACY_OR_MODEL_REMAP`, `OR_TO_SDK_MAP`,
 * `OR_MODEL_MAP`, `PROVIDER_PRESETS.openrouter.models`, or `MODEL_OPTIONS`.
 */
describe('MODEL_CATALOG → derivation invariants (Stage 1)', () => {
  const catalogOrEntries = MODEL_CATALOG.filter(
    e => e.provider === 'openrouter' && e.openRouter,
  );

  it('OR_MODEL_CATALOG length matches catalog OR entries with openRouter block', () => {
    expect(OR_MODEL_CATALOG.length).toBe(catalogOrEntries.length);
  });

  it('OR_MODEL_CATALOG order matches MODEL_CATALOG iteration order', () => {
    const expected = catalogOrEntries.map(e => e.id);
    const actual = OR_MODEL_CATALOG.map(e => e.id);
    expect(actual).toEqual(expected);
  });

  it('OR_MODEL_CATALOG entries copy fields verbatim from openRouter block', () => {
    for (const catalogEntry of catalogOrEntries) {
      const orEntry = OR_MODEL_MAP.get(catalogEntry.id);
      expect(orEntry).toBeDefined();
      const routing = catalogEntry.openRouter!;
      expect(orEntry!.label).toBe(routing.label);
      expect(orEntry!.isMainModel).toBe(routing.isMainModel);
      expect(orEntry!.isAuxiliaryModel).toBe(routing.isAuxiliaryModel);
      expect(orEntry!.sdkModel).toBe(routing.sdkModel);
      expect(orEntry!.auxiliaryHint).toBe(routing.auxiliaryHint);
    }
  });

  it('LEGACY_OR_MODEL_REMAP is derived from per-entry legacyIds, no collisions', () => {
    const seen = new Map<string, string>();
    for (const e of catalogOrEntries) {
      const legacy = e.openRouter!.legacyIds;
      if (!legacy) continue;
      for (const id of legacy) {
        expect(seen.has(id)).toBe(false);
        seen.set(id, e.id);
      }
    }
    for (const [legacy, target] of seen.entries()) {
      expect(LEGACY_OR_MODEL_REMAP.get(legacy)).toBe(target);
    }
    expect(LEGACY_OR_MODEL_REMAP.size).toBe(seen.size);
  });

  it('OR_TO_SDK_MAP combines sdkModel and pricingFollows from catalog', () => {
    for (const e of catalogOrEntries) {
      const routing = e.openRouter!;
      const expected = routing.sdkModel ?? routing.pricingFollows;
      if (expected) {
        expect(OR_TO_SDK_MAP.get(e.id)).toBe(expected);
      } else {
        expect(OR_TO_SDK_MAP.has(e.id)).toBe(false);
      }
    }
  });

  it('every pricingFollows target resolves to a non-OR catalog entry (direct or alias)', () => {
    for (const e of catalogOrEntries) {
      const target = e.openRouter!.pricingFollows;
      if (!target) continue;
      expect(
        resolveCatalogTarget(target),
        `pricingFollows target '${target}' (from ${e.id}) must resolve in catalog`,
      ).toBe(true);
    }
  });

  it('every sdkModel target on Claude OR entries resolves in catalog', () => {
    for (const e of catalogOrEntries) {
      const sdkModel = e.openRouter!.sdkModel;
      if (!sdkModel) continue;
      expect(
        resolveCatalogTarget(sdkModel),
        `sdkModel '${sdkModel}' (from ${e.id}) must resolve in catalog`,
      ).toBe(true);
    }
  });

  it('PROVIDER_PRESETS.openrouter.models is the derived list (referential equality)', () => {
    const derived = _deriveOpenRouterPresetModelsForTesting();
    const consumed = PROVIDER_PRESETS.openrouter.models;
    // Same length and same order
    expect(consumed.length).toBe(derived.length);
    for (let i = 0; i < consumed.length; i++) {
      expect(consumed[i]?.value).toBe(derived[i]?.value);
      expect(consumed[i]?.label).toBe(derived[i]?.label);
    }
  });

  it('every preset entry maps back to its catalog id', () => {
    const presetIds = new Set(PROVIDER_PRESETS.openrouter.models.map(m => m.value));
    for (const id of presetIds) {
      const catalog = MODEL_CATALOG.find(e => e.id === id);
      expect(catalog, `preset entry '${id}' must exist in MODEL_CATALOG`).toBeDefined();
      expect(catalog!.provider).toBe('openrouter');
      expect(catalog!.openRouter).toBeDefined();
    }
  });

  it('resolveOrModelToSdkId still works for both Claude and pricingFollows entries', () => {
    expect(resolveOrModelToSdkId('anthropic/claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(resolveOrModelToSdkId('google/gemini-3.1-pro-preview')).toBe('gemini-3.1-pro');
    expect(resolveOrModelToSdkId('deepseek/deepseek-r1-0528')).toBe('deepseek-r1');
    // Unknown OR id with provider prefix falls back to suffix-stripping
    expect(resolveOrModelToSdkId('openai/gpt-5.5')).toBe('gpt-5.5');
  });

  it('historical-only OR entries (no openRouter block) still have pricing and stay out of dropdowns', () => {
    const historical = MODEL_CATALOG.filter(
      e => e.provider === 'openrouter' && !e.openRouter,
    );
    // At least one historical entry expected today (minimax/minimax-m2.5)
    expect(historical.length).toBeGreaterThanOrEqual(1);
    for (const e of historical) {
      expect(e.pricing.input).toBeGreaterThanOrEqual(0);
      expect(OR_MODEL_MAP.has(e.id)).toBe(false);
      // Their id must be reachable via LEGACY_OR_MODEL_REMAP (otherwise the
      // entry is effectively dead weight — Stage 0 / consistency check would
      // already flag this).
      const isLegacyTarget = Array.from(LEGACY_OR_MODEL_REMAP.keys()).includes(e.id);
      expect(isLegacyTarget, `historical OR entry '${e.id}' should be a LEGACY_OR_MODEL_REMAP key`).toBe(true);
    }
  });
});
