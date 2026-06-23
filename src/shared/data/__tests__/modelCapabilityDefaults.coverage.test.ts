import { describe, it, expect } from 'vitest';
import { MODEL_CATALOG } from '../modelCatalog';
import {
  PROVIDER_PRESETS,
  LOCAL_INFERENCE_PRESETS,
  getModelCapabilityDefaults,
} from '../modelProviderPresets';

/**
 * Coverage pin for planner routing notes (Stage 1 of
 * docs/plans/260623_model-routing-notes-guard/PLAN.md, widened by the fix stage).
 *
 * Mirrors `scripts/check-model-routing-notes.ts`. The guard's scope is the union
 * of two selectable surfaces; per CE2 §8.1 (guard-amendment), this test asserts
 * BOTH lists explicitly:
 *
 *   - MUST COVER: catalog main models (`isMainModel` OR `openRouter.isMainModel`)
 *     ∪ the model `value`s of the HOSTED first-party providers in
 *     `PROVIDER_PRESETS` (openai, openrouter, google, cerebras). This includes
 *     the direct-OpenAI o-series bare ids (`o3`/`o3-pro`/`o4-mini`) and the
 *     Cerebras preset ids — selectable in the wizard picker but NOT catalog
 *     `isMainModel`.
 *   - OUT OF SCOPE: `local:`-prefixed / self-hosted providers
 *     (`LOCAL_INFERENCE_PRESETS`) carry user-supplied model ids the catalog
 *     cannot ship notes for — exactly the unknown-model case the runtime
 *     "Research this model" enrich button serves. They are deliberately NOT in
 *     `PROVIDER_PRESETS`; this test pins that they stay out of the guarded set.
 *
 * This is the in-process safety net for the CI guard — it fails the same way
 * (e.g. if the GLM 5.2 or o3 entry is removed) and keeps the class dead by
 * construction inside the unit suite.
 */

const HOSTED_PRESET_PROVIDERS = ['openai', 'openrouter', 'google', 'cerebras'] as const;

function isMainModel(entry: (typeof MODEL_CATALOG)[number]): boolean {
  return entry.isMainModel === true || entry.openRouter?.isMainModel === true;
}

/** The full in-scope selectable surface: catalog main ∪ hosted preset pickers. */
function collectInScopeModels(): { id: string; label: string }[] {
  const byId = new Map<string, string>();
  for (const entry of MODEL_CATALOG) {
    if (!isMainModel(entry)) continue;
    byId.set(entry.id, entry.openRouter?.label ?? entry.displayLabel ?? entry.id);
  }
  for (const provider of HOSTED_PRESET_PROVIDERS) {
    const preset = PROVIDER_PRESETS[provider];
    for (const model of preset.models) {
      if (!byId.has(model.value)) byId.set(model.value, model.label);
    }
  }
  return [...byId.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.id.localeCompare(b.id));
}

describe('MODEL_CAPABILITY_DEFAULTS — selectable-main-model routing-notes coverage', () => {
  const inScope = collectInScopeModels();

  it('has a non-trivial in-scope set (sanity)', () => {
    // Guards against an accidental empty enumeration silently passing.
    expect(inScope.length).toBeGreaterThan(40);
  });

  // --- List 1: models the guard MUST cover ---
  it.each(inScope.map((m) => [m.id, m.label]))(
    'in-scope model %s (%s) resolves to non-empty routing notes',
    (id) => {
      const resolved = getModelCapabilityDefaults(id);
      expect(resolved, `${id} has no MODEL_CAPABILITY_DEFAULTS entry`).toBeDefined();
      expect(resolved?.modelNotes.trim().length, `${id} has empty routing notes`).toBeGreaterThan(0);
    },
  );

  it('covers GLM 5.2 specifically (the omission this guard was built for)', () => {
    // Red->green pin: removing the `z-ai/glm-5.2` entry from
    // MODEL_CAPABILITY_DEFAULTS makes this (and the .each above) fail.
    const resolved = getModelCapabilityDefaults('z-ai/glm-5.2');
    expect(resolved?.modelNotes.trim()).toBeTruthy();
  });

  it('covers direct-OpenAI o-series bare ids (the widening this fix added)', () => {
    // Red->green pin: removing the bare `o3` entry makes this fail. These are
    // selectable in PROVIDER_PRESETS.openai but are NOT catalog isMainModel.
    expect(getModelCapabilityDefaults('o3')?.modelNotes.trim()).toBeTruthy();
    expect(getModelCapabilityDefaults('o3-pro')?.modelNotes.trim()).toBeTruthy();
    expect(getModelCapabilityDefaults('o4-mini')?.modelNotes.trim()).toBeTruthy();
    // The bare key also resolves the OR-prefixed sibling via strip-fallback.
    expect(getModelCapabilityDefaults('openai/o3')?.modelNotes.trim()).toBeTruthy();
  });

  it('covers Cerebras preset ids (selectable but not catalog isMainModel)', () => {
    expect(getModelCapabilityDefaults('gpt-oss-120b')?.modelNotes.trim()).toBeTruthy();
    expect(getModelCapabilityDefaults('llama3.1-8b')?.modelNotes.trim()).toBeTruthy();
  });

  it('resolves Anthropic-direct bare ids (not just OR-prefixed)', () => {
    // The bare-key fix: an Anthropic-direct profile carries the bare model id.
    expect(getModelCapabilityDefaults('claude-opus-4-8')?.modelNotes.trim()).toBeTruthy();
    // ...and the OR-prefixed sibling still resolves via the strip-fallback.
    expect(getModelCapabilityDefaults('anthropic/claude-opus-4-8')?.modelNotes.trim()).toBeTruthy();
  });

  // --- List 2: surfaces that are intentionally OUT of scope ---
  it('does NOT require notes for local/self-hosted preset providers', () => {
    // LOCAL_INFERENCE_PRESETS are user-supplied endpoints with arbitrary model
    // ids; the catalog cannot ship notes for them and the enrich button is the
    // legitimate fill path. Assert they are not part of PROVIDER_PRESETS (so the
    // guard's hosted-provider enumeration can never pull them in).
    const inScopeIds = new Set(inScope.map((m) => m.id));
    const providerPresetKeys = new Set(Object.keys(PROVIDER_PRESETS));
    for (const localPreset of LOCAL_INFERENCE_PRESETS) {
      expect(providerPresetKeys.has(localPreset.key)).toBe(false);
      expect(providerPresetKeys.has(localPreset.presetKey)).toBe(false);
      // Their default model ids (when present) are not silently force-covered.
      if (localPreset.defaultModel) {
        // Not an assertion that they LACK notes (a shared id like a deepseek
        // variant might coincidentally carry one) — only that local presets are
        // not enumerated INTO the guarded set.
        expect(inScopeIds.has(localPreset.presetKey)).toBe(false);
      }
    }
  });

  it('excludes the empty `together` preset from the hosted-provider scope', () => {
    // `together` ships an empty models array; it must not be in the scoped list.
    expect(HOSTED_PRESET_PROVIDERS).not.toContain('together');
    expect(PROVIDER_PRESETS.together.models.length).toBe(0);
  });
});
