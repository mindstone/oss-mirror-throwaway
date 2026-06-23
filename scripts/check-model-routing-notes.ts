#!/usr/bin/env tsx
/**
 * CI Validation: every selectable MAIN model must ship planner routing notes.
 *
 * Stage 1 of `docs/plans/260623_model-routing-notes-guard/PLAN.md`.
 *
 * Why: `MODEL_CAPABILITY_DEFAULTS` (src/shared/data/modelProviderPresets.ts) is
 * the source of truth for the planner's per-model routing guidance — what to
 * route TO a model and what to route AWAY. The planner reads it via
 * `getModelCapabilityDefaults(profile.model)` in
 * `src/core/rebelCore/planningMode.ts`. When a main catalog model has no entry,
 * a fresh profile routes with ZERO capability guidance, and the renderer's
 * "Enrich this profile's description with AI research?" prompt nags for it.
 *
 * GLM 5.2 (`z-ai/glm-5.2`) was added to MODEL_CATALOG (commit 86bc732c9b) without
 * a routing-notes entry — the omission passed review and CI because nothing tied
 * main-model catalog membership to routing-notes coverage. This guard kills that
 * class by construction: a main model can no longer ship without notes.
 *
 * SCOPE (predicate): the union of two selectable-surface sources must each
 * resolve through `getModelCapabilityDefaults(id)` to a NON-EMPTY `modelNotes`
 * string:
 *
 *   (A) CATALOG MAIN MODELS — every MODEL_CATALOG entry selectable as a MAIN
 *       conversation model: `isMainModel === true` (Anthropic-direct entries)
 *       OR `openRouter.isMainModel === true` (OpenRouter entries).
 *
 *   (B) HOSTED-PROVIDER PRESET PICKERS — every model `value` listed under the
 *       HOSTED first-party providers in `PROVIDER_PRESETS`
 *       (`HOSTED_PRESET_PROVIDERS` below). This is the surface the
 *       provider-setup wizard actually renders in its model picker
 *       (ModelStep.tsx → `filterModelsByRole(preset.models, …)`; the default
 *       "working" role applies NO main-model filter). The OpenRouter preset is
 *       derived metadata that intentionally also includes hidden/auxiliary ids
 *       (see deriveOpenRouterPresetModels), so for `openrouter` those auxiliary
 *       ids ARE user-selectable in the wizard — they belong in scope and the
 *       "Research this model" button fires for them otherwise.
 *
 *   Why (B) is needed (the gap this widening closed): (A) alone missed direct
 *   OpenAI o-series (`o3`/`o3-pro`/`o4-mini`) and the Cerebras preset models
 *   (`gpt-oss-120b`/`llama3.1-8b`), which are selectable in the picker but are
 *   NOT catalog `isMainModel`. They routed with zero notes and nagged with the
 *   enrich prompt. (A)+(B) closes that.
 *
 * OUT OF SCOPE — documented, NOT silently skipped:
 *   - `local:`-prefixed / self-hosted providers (DS4, LM Studio, Ollama,
 *     llama.cpp — `LOCAL_INFERENCE_PRESETS`, NOT in `PROVIDER_PRESETS`): the
 *     user brings their own arbitrary model id, so the catalog cannot ship
 *     notes for it. This is EXACTLY the unknown-model case the runtime
 *     "Research this model" enrich button legitimately serves. Requiring notes
 *     here would be impossible by construction.
 *   - `together` preset: ships an EMPTY `models` array (no curated picker), so
 *     it contributes nothing — excluded from `HOSTED_PRESET_PROVIDERS` to make
 *     that explicit rather than relying on the empty list.
 *   - Auxiliary-only / behind-the-scenes catalog models that are neither main
 *     NOR exposed in a hosted preset picker: not offered as conversation
 *     models, so the planner never advertises them and the enrich prompt does
 *     not fire. (Many DO carry notes; this guard simply doesn't require it.)
 *   - There are currently NO documented exclusions WITHIN the in-scope set: the
 *     audit reached 100% coverage. If a future in-scope model legitimately
 *     cannot have notes, DO NOT silently skip it — CE2 forbids fail-open. Add
 *     it to `MODEL_NOTE_EXCLUSIONS` below WITH a reason, so the exclusion is
 *     explicit and reviewable.
 *
 * The routing id used for resolution is the catalog entry `id` / preset `value`:
 *   - OpenRouter entries are prefix-keyed (`anthropic/...`, `openai/...`, ...) and
 *     resolve via exact match or the resolver's provider-prefix strip.
 *   - Direct-provider ids are bare (`claude-opus-4-8`, `o3`, `gpt-oss-120b`); the
 *     matching MODEL_CAPABILITY_DEFAULTS keys are bare too, so they resolve by
 *     exact match (and any OR-prefixed sibling resolves via strip-fallback).
 *
 * Exit code:
 *   0 — every in-scope model resolves to non-empty routing notes
 *   1 — at least one in-scope model is missing routing notes; reports which
 *
 * Wired into: `npm run validate:fast` via `validate:model-routing-notes`
 * (alongside `validate:model-registry-consistency`).
 */

import { MODEL_CATALOG } from '../src/shared/data/modelCatalog';
import {
  PROVIDER_PRESETS,
  getModelCapabilityDefaults,
} from '../src/shared/data/modelProviderPresets';

/**
 * HOSTED first-party providers whose preset model pickers are in scope (source
 * (B) above). `anthropic` is NOT a `PROVIDER_PRESETS` key (Anthropic-direct is
 * the special-cased provider) — its direct ids are covered by catalog source
 * (A) via `isMainModel`. `gemini` is keyed as `google`. `together` (empty
 * models) and the `local:*` self-hosted providers are intentionally excluded —
 * see the OUT OF SCOPE notes in the file header.
 */
const HOSTED_PRESET_PROVIDERS = ['openai', 'openrouter', 'google', 'cerebras'] as const;

/**
 * Explicit, reviewable exclusions WITHIN the in-scope set. Empty by design —
 * the audit reached 100% coverage. If you must exclude an in-scope model, add
 * its id here with a clear reason. NEVER skip silently: an unexplained gap is a
 * fail-open the planner can't recover from.
 */
const MODEL_NOTE_EXCLUSIONS: Record<string, string> = {
  // (none — every in-scope model currently ships routing notes)
};

function isMainModel(entry: (typeof MODEL_CATALOG)[number]): boolean {
  return entry.isMainModel === true || entry.openRouter?.isMainModel === true;
}

/**
 * The full in-scope selectable surface: catalog main models (A) UNION hosted
 * preset picker ids (B). Returns a stable sorted, de-duplicated list of routing
 * ids paired with a human label for error messages.
 */
function collectInScopeModels(): { id: string; label: string }[] {
  const byId = new Map<string, string>();

  // (A) catalog main models
  for (const entry of MODEL_CATALOG) {
    if (!isMainModel(entry)) continue;
    byId.set(entry.id, entry.openRouter?.label ?? entry.displayLabel ?? entry.id);
  }

  // (B) hosted-provider preset picker ids
  for (const provider of HOSTED_PRESET_PROVIDERS) {
    const preset = PROVIDER_PRESETS[provider];
    for (const model of preset.models) {
      if (!byId.has(model.value)) {
        byId.set(model.value, `${preset.label} · ${model.label}`);
      }
    }
  }

  return [...byId.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function checkRoutingNotes(inScope: { id: string; label: string }[]): string[] {
  const errors: string[] = [];

  for (const { id, label } of inScope) {
    if (id in MODEL_NOTE_EXCLUSIONS) {
      // Excluded on purpose — surfaced as a note, not silently dropped.
      console.warn(
        `[check-model-routing-notes] NOTE — ${id} excluded: ${MODEL_NOTE_EXCLUSIONS[id]}`,
      );
      continue;
    }

    const resolved = getModelCapabilityDefaults(id);
    if (!resolved || !resolved.modelNotes.trim()) {
      errors.push(
        `${id} (${label}) is a selectable main model but has no resolvable routing notes in MODEL_CAPABILITY_DEFAULTS.`,
      );
    }
  }

  return errors;
}

const inScopeModels = collectInScopeModels();
const errors = checkRoutingNotes(inScopeModels);

if (errors.length === 0) {
  console.log(
    `[check-model-routing-notes] OK — all ${inScopeModels.length} selectable main models (catalog main ∪ hosted preset pickers) resolve to non-empty routing notes.`,
  );
  process.exit(0);
}

console.error('[check-model-routing-notes] FAILED');
console.error('');
console.error(`Found ${errors.length} main model(s) missing routing notes:`);
for (const err of errors) {
  console.error(`  - ${err}`);
}
console.error('');
console.error('Fix: add a curated 1-2 sentence entry to MODEL_CAPABILITY_DEFAULTS in');
console.error('  src/shared/data/modelProviderPresets.ts');
console.error('keyed by the catalog id (bare id for Anthropic-direct; provider-prefixed');
console.error('for OpenRouter). Follow the file\'s writing guidelines: relative capability');
console.error('vs the pool, what to route TO and what to route AWAY.');
console.error('');
console.error('See docs/project/NEW_MODEL_SUPPORT_PROCESS.md for the full process.');

process.exit(1);
