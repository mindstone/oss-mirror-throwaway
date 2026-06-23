---
description: "Map of every model registry in Rebel — which derive from MODEL_CATALOG vs which are hand-maintained, which CI guard covers each, plus the orthogonal model-identity axes and the three distinct migration mechanisms."
last_updated: "2026-06-18"
---

# Model Registries

Rebel scatters model metadata across several files. This doc is the map: it says **which registry owns what**, **which derive from the single source of truth vs which are hand-maintained** (the drift surface), **what the CI guard actually covers**, and how to avoid conflating the orthogonal identity and migration concepts that live here.

To **add a new model**, do not improvise from this map — follow the SSOT checklist in [NEW_MODEL_SUPPORT_PROCESS](./NEW_MODEL_SUPPORT_PROCESS.md). This doc explains *why the registries are shaped this way*; that doc is the *what-to-touch* runbook.

## The single source of truth

`MODEL_CATALOG` in `src/shared/data/modelCatalog.ts` is the canonical model registry: one entry per model carrying `id`, `provider`, `pricing`, `aliases`, UI flags (`isMainModel` / `isAuxiliaryModel` / `displayLabel`), `supportsExtendedContext`, `migratesTo`, and two nested overlays — `openRouter` (`OpenRouterRouting`) and `presets` (`ModelPresetMetadata`). The intent (Stage 1 of `docs/plans/260428_kw_eval_infra_and_model_registry.md`) is that adding/changing a model is a single-place edit in this file, and everything downstream re-derives.

## Derived-at-module-load from the catalog

These are computed views — never edit them, edit the catalog:

- `src/shared/data/openRouterModels.ts` — `OR_MODEL_CATALOG`, `resolveOrModelToSdkId()`, and the OR↔SDK maps (`OR_MODEL_MAP`, `SDK_TO_OR_MAP`), all `.map()`/`.filter()`ed off `MODEL_CATALOG` entries with an `openRouter` block.
- `src/shared/data/modelProviderPresets.ts` — only the **OpenRouter** section of `PROVIDER_PRESETS` (`models: deriveOpenRouterPresetModels()`); the rest of that file is hand-maintained (see below).
- `src/shared/utils/modelNormalization.ts` — `MODEL_OPTIONS` (the user-selectable Anthropic dropdown) is derived from catalog entries with `isMainModel`. **`modelSupportsExtendedContext()` / `[1m]` resolution is separate:** it reads catalog `supportsExtendedContext` via `EXTENDED_CONTEXT_MODEL_IDS` **without** the `isMainModel` filter — a model hidden from pickers (`isMainModel: false`) can still carry the capability (e.g. Fable 5 while access is withdrawn).
- `src/shared/utils/pricingCalculator.ts` — `MODEL_PRICING` / `MODEL_ALIASES` (module-private) come from `getCatalogPricingMap()` / `getCatalogAliasMap()`.
- The legacy-migration maps (`LEGACY_MODEL_MIGRATIONS`, `LEGACY_OR_MODEL_REMAP`) are derived from catalog `migratesTo` / `openRouter.legacyIds`.

## Hand-maintained registries — the drift surface

These are **not** catalog-derived. Updating a model means editing them by hand, and nothing automatically keeps them in sync with `MODEL_CATALOG`. Treat them as the known drift risk:

- `src/shared/data/codexModels.ts` — `CODEX_MAIN_MODEL_OPTIONS` / `CODEX_AUXILIARY_MODEL_OPTIONS` (Codex / ChatGPT-Pro dropdowns, bare OpenAI ids).
- `src/shared/data/modelProviderPresets.ts` — the `openai`, `google`, and `cerebras` `models[]` arrays inside `PROVIDER_PRESETS`, plus `MODEL_CAPABILITY_DEFAULTS` (the `modelNotes` blurbs).
- `src/shared/data/qualityTiers.ts` — `CLAUDE_TIERS` (the quality-tier ladder; see [MULTI_MODEL_COUNCIL_MODE](./MULTI_MODEL_COUNCIL_MODE.md)).
- `src/shared/utils/providerDefaultConstants.ts` — per-provider default-id string literals (`CODEX_DEFAULT_MODEL`, `OR_DEFAULT_*`, `ANTHROPIC_DEFAULT_*`). Leaf module (zero downstream imports) that breaks an import cycle; see file header. `PREFERRED_PLANNING_MODEL` in `modelNormalization.ts` **derives** from `ANTHROPIC_DEFAULT_THINKING_MODEL` here; `DEFAULT_MODEL` / `DEFAULT_AUXILIARY_MODEL` remain separate literals in `modelNormalization.ts`.

> Do not hardcode the actual default-model strings when reasoning about this — the volatile values live in `PREFERRED_PLANNING_MODEL` etc. in `modelNormalization.ts` and the `*_DEFAULT_*` constants in `providerDefaultConstants.ts`. Signpost to the symbol, not the value.

## CI guard — and what it does NOT cover

`scripts/check-model-registry-consistency.ts` (npm `validate:model-registry-consistency`, run inside `validate:fast`) is a **foreign-key check across the catalog and its OpenRouter views only**: every `OR_MODEL_CATALOG` entry maps to an `openrouter` `MODEL_CATALOG` entry and vice-versa, every `PROVIDER_PRESETS.openrouter.models[*].value` resolves to an `OR_MODEL_CATALOG.id` and vice-versa, and every `LEGACY_OR_MODEL_REMAP` target is a valid OR id. The script's own header explains the silent-breakage failure modes it prevents.

It does **not** cover Codex, the openai/google/cerebras preset arrays, or `MODEL_CAPABILITY_DEFAULTS`. Other surfaces now have **separate** unit-test guards (limits coverage, quality-tier id resolution, main-model id-list pin, MCP label JSON, capability flag-locks, provider-catalog descriptions) — see [NEW_MODEL_SUPPORT_PROCESS § What's Guarded vs Convention-Only](./NEW_MODEL_SUPPORT_PROCESS.md#whats-guarded-vs-convention-only). For `CLAUDE_TIERS`, only id *existence* is guarded — which models each tier should point at (membership/semantics) remains a manual call, as do eval and E2E defaults.

## Identity axes (orthogonal — keep them separate)

A model is identified by several independent dimensions. Conflating them is a recurring bug source; each axis has one owning file:

- **Bare model id** — identity + version (e.g. the canonical `id` in `MODEL_CATALOG`). The base unit everything else decorates.
- **`[1m]` extended-context suffix** — an *id decoration* meaning "use the 1M-token window", gated by catalog `supportsExtendedContext` (not visibility-filtered `MODEL_OPTIONS`). Owned by `modelNormalization.ts`: `applyExtendedContextSuffix()` / `modelSupportsExtendedContext()` (backed by `EXTENDED_CONTEXT_MODEL_IDS`, built from all anthropic catalog rows with `supportsExtendedContext: true`). It is appended to / stripped from the id, never a separate field.
- **OpenRouter `provider/model` slash prefix** (e.g. `google/gemini-…`) — a **catalog namespace**, NOT the serving provider. It identifies the OR catalog row; it does not by itself tell you who serves the request. OR↔SDK translation lives in `openRouterModels.ts` (`resolveOrModelToSdkId()`, `SDK_TO_OR_MAP`).
- **`ThinkingEffort`** — a separate union (`'xhigh' | 'high' | 'medium' | 'low'`) in `src/shared/types/settings.ts`, carried in settings alongside the model id. It is **never encoded into the id string**. See [MODEL_CONSTANTS](./MODEL_CONSTANTS.md).
- **`model:` / `profile:` storage prefix codec** — how a stored model choice is tagged as a raw model vs a profile reference. Owned by `src/shared/utils/modelChoiceCodec.ts` (`MODEL_PREFIX`, `PROFILE_PREFIX`, `decodePrefixed()`, `normalizeStoredBtsModelValue()`). This is a storage-encoding axis, orthogonal to all of the above.

## Branded model-id lifecycle (the type that makes leaks impossible)

These axes are reflected in **branded TypeScript types** so a stored/un-normalized id cannot reach a provider wire by construction (the fix for the BTS prefix-leak class, postmortem 260529):

```
StoredModelChoice   raw settings value: `model:<id>` | `profile:<id>` | bare
   │ codec decode — the SOLE minter (modelChoiceCodec.ts)
   ├─ RoutingModelId   decoded in-app routing id (no storage prefix)
   └─ ProfileRef       a profile id; must be RESOLVED before it can route
RoutingModelId
   │ dialect minter — the SOLE WireModelId producer (wireModelId.ts)
   └─ WireModelId      normalized for a specific provider wire (what reaches the SDK)
```

- The codec is the **only** place that mints `RoutingModelId`/`ProfileRef` (`mintRoutingModelId` is private; `decodeRoutingModelId` / `decodeRoleChoice` / `stripStoredModelPrefix` are the public decode entry points). `unsafeAssertRoutingModelId` exists for codec-internal + test use only.
- The dialect minters (`mintAnthropicWireModel` — dot→dash on `anthropic/` strip; `mintOpenRouterPassthroughModel` — slash ids unchanged; `mintOpenAiWireModel`) are the **only** producers of `WireModelId`. `resolveAnthropicWireModel` orchestrates them with fail-closed validation.
- `RoutingModelId` originates only at the decode **chokepoints** (codec, `modelRoleResolver`, `resolveRuntimeModels`, the turn-synthesis layer, `agentTool` subagent routing) and flows down through `RebelCoreConfig.model` / `CreateParams.model` to the wire.
- **Guards (so the property can't erode):** ESLint `no-model-brand-casts` blocks `as <brand>` outside the codec/minter files; `scripts/check-no-routing-model-forge.ts` (in `validate:fast`) blocks production imports of `unsafeAssertRoutingModelId`. Pricing/catalog/capability consumers take the un-branded catalog id, **never** `WireModelId`.
- Cross-engine consistency (the two provider resolvers agree on provider/credential/dispatch) is pinned by `src/core/rebelCore/__tests__/providerResolution.parityMatrix.test.ts`. Design rationale: `docs/plans/260530_model-provider-hardening/STAGE1_DESIGN_typed_model_id_lifecycle.md`.

Related egress-body brand: `ValidatedChatCompletionsBody` is minted only by
`finalizeChatCompletionsBody` in
`src/core/services/chatCompletionsParamCapability.ts`. It applies the
Chat-Completions request-param strip chokepoint before any branded body reaches
`/chat/completions`; `scripts/check-chat-completions-chokepoint.ts` blocks brand
casts and new `buildCompletionsUrl` POST seams that skip the finalizer. Design
rationale: `docs/plans/260530_model-provider-hardening/STAGE2_DESIGN_typed_capability_matrix.md`.

## Three distinct migration mechanisms (easily conflated)

All three "rewrite an old model id", but they have different scopes and triggers:

- **`LEGACY_MODEL_MIGRATIONS`** (`modelNormalization.ts`, module-private, derived from `migratesTo`) — **Anthropic settings migration**: rewrites a deprecated Claude id (and its aliases) to its successor when normalizing user settings.
- **`LEGACY_OR_MODEL_REMAP`** (`openRouterModels.ts`, derived from `openRouter.legacyIds`) — **active OpenRouter id rewrite**: rewrites stale OR ids to the current OR id at resolution time (`resolveOrModelToSdkId()` follows it transitively).
- **`entry.aliases`** (`modelCatalog.ts`) — **pricing / identity equivalence**, not a rewrite: dated snapshots and alternate spellings that should resolve to the same pricing and identity. Used by `pricingCalculator.ts` for cost lookup.

## See also

- [MODEL_CONSTANTS](./MODEL_CONSTANTS.md) — the Anthropic-default constants and normalization rules that this map's registries feed; start here for "what's the current default".
- [NEW_MODEL_SUPPORT_PROCESS](./NEW_MODEL_SUPPORT_PROCESS.md) — SSOT runbook for actually adding a model across these registries.
- [ADDING_AN_OPENROUTER_MODEL](./ADDING_AN_OPENROUTER_MODEL.md) — the OpenRouter-only fast path (catalog entry + provider allowlist + eval verification) for a third-party model that needs no first-party provider work.
- [COST_TRACKING](./COST_TRACKING.md) — how `pricingCalculator.ts` (derived from the catalog) turns model ids + aliases into cost.
- `scripts/check-model-registry-consistency.ts` — the consistency guard; its header is the authoritative list of what it checks and why.
- `docs/plans/260428_kw_eval_infra_and_model_registry.md` — original rationale for collapsing the OR registries into `MODEL_CATALOG` (Stage 0 guard → Stage 1 derivation).
- `docs/plans/260514_openrouter_sonnet_bypass_remediation.md` — why `providerDefaultConstants.ts` exists as a leaf module (Stage 3).
