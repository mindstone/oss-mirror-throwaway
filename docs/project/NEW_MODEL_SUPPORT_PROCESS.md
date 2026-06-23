---
description: "Comprehensive checklist for adding a new frontier model to the app — catalog, defaults, OpenRouter, tests, CI, and docs"
last_updated: "2026-06-18"
---

# New Frontier Model Support Process

Step-by-step process for when a new frontier model (e.g., a new Claude Opus, Sonnet, or third-party model) is released and needs full app support.

## See Also

- [ADDING_AN_OPENROUTER_MODEL](ADDING_AN_OPENROUTER_MODEL.md) — the **OpenRouter-only fast path**. When the new model only needs OpenRouter support (no first-party provider work), follow that focused runbook instead of this full process.
- [SUBAGENT_MODEL_UPGRADE_PROCESS](SUBAGENT_MODEL_UPGRADE_PROCESS.md) — covers **droid/subagent** model upgrades (`.factory/droids/`, `.cursor/agents/`, workflow docs). Do this **in addition** when the model is also used by coding droids.
- [MODEL_CONSTANTS](MODEL_CONSTANTS.md) — current model constants, normalization rules, and the "Adding New Models" quickstart
- `src/shared/data/modelCatalog.ts` — the single source of truth for model metadata
- [MODEL_ROSTER](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/MODEL_ROSTER.md) — **coding-agent** model routing: harness dispatch matrix + a dated price ladder. When a new frontier model lands or catalog pricing changes materially, refresh its "Current tier & pricing" section (it cites this doc and the catalog as the live pricing SSOT).
- [MODEL_AND_PROVIDER_OVERVIEW](MODEL_AND_PROVIDER_OVERVIEW.md) — territory hub for model selection/routing/billing, including the `src/core/modelRecommendation/` "Recommended for most people" engine whose per-model metadata you MUST refresh when adding a model (step 14d below — CI-guarded).


## When to Use This Process

Use this whenever:
- Anthropic releases a new Claude model that should become a default
- A non-Anthropic model needs to be added to the OpenRouter catalog or quality tiers
- An existing model needs to be deprecated with automatic migration

For minor model updates (alias changes, pricing updates), only the relevant subset of steps applies.


## When a User Reports a Missing/Broken Model

Triage before re-running the full checklist or adding code:

1. **Check the reporter's app version.** In Sentry, query events by `user.email` and read the `release` tag — models ship with app releases. Most "missing model" reports are stale installs or a fix on `dev` not yet released.
2. **Check whether a fix already landed on `dev`.** `git log origin/main..origin/dev -- <affected paths>` before investigating from scratch.
3. **Check which dropdown(s) are affected.** A model can be in the catalog but suppressed per-role in the picker (June 2026 incident: Opus 4.8 in Planner but absent from Main work / Behind the scenes).
4. **Managed-subscription users are a separate system.** Mindstone dash/rogue tiers get models from rebel-platform tier config ([admin UI](https://rebel.mindstone.com/platform/tier-models); server `../rebel-platform/server/routes/admin-tier-models.ts`), **not** the app catalog. **Current policy (June 2026):** managed tiers offer GPT + DeepSeek only — no Claude. An empty tier-models DB uses hardcoded fallbacks from `../rebel-platform/server/services/openRouterAdapter.ts`. Adding a model for managed users = admin-UI change there, not app code.


## Pre-Work: Gather Model Details

Before writing any code, confirm:

| Detail | Where to find it | Example |
|--------|-----------------|---------|
| **SDK model ID** | [Anthropic models overview](https://platform.claude.com/docs/en/about-claude/models/overview) | `claude-opus-4-8` |
| **Dated snapshot alias** | Same page, or model API response | `claude-opus-4-8-20260528` (may not exist yet on release day) |
| **Pricing** (input/output/cache) | [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) | $5/$25 per MTok |
| **Context window** | Models overview | 1,000,000 tokens |
| **Max output tokens** | Models overview | 128,000 tokens |
| **Thinking support** | Models overview (extended vs adaptive) | Adaptive thinking |
| **Thinking mode constraints** | Models overview + release notes: always-on? Is `thinking: {type:"disabled"}` rejected? `budget_tokens` rejected? Is the `thinking.display` param available? | Fable 5: always-on adaptive; `disabled`/`budget_tokens` → 400; `display` exists (default `"omitted"`). If always-on, set `thinkingAlwaysOn: true` (step 1) and follow step 8c |
| **Sampling-param constraints** | Release notes + API spike: does it reject `temperature`/`top_p`/`top_k`? Under what conditions? | Fable 5: rejected unconditionally. Opus 4.7/4.8 reject them only when the request enables thinking — so "works on Opus today" does not mean a new model accepts them |
| **Refusal behavior** | Release notes: can it emit `stop_reason: "refusal"` (+ `stop_details.category`)? | Fable 5: yes — safety classifiers, HTTP 200; pre-output refusal = empty content, unbilled. If yes, follow step 9b |
| **Data-retention / ZDR constraints** | Release notes / trust center | Fable 5: requires 30-day retention; ZDR orgs get 400 on every request (no code change — note it in the catalog entry comment) |
| **Tokenizer change** | Release notes | Fable 5: new tokenizer, ~30% more tokens than Opus-tier. Only skews the chars/4 client-side preflight estimate — accepted risk; runtime thresholds self-correct from real `usage` |
| **Extended context** | Does it support the `[1m]` suffix? | Yes |
| **OpenRouter availability** | Live check — see "OpenRouter availability & ID check" below | May lag by hours/days on release day |
| **OpenRouter model ID** | OpenRouter model page | `anthropic/claude-opus-4.8` (catalog `id` uses the dashed `anthropic/claude-opus-4-8`; keep the dotted spelling as a `legacyIds` entry — OpenRouter rejects dotted Claude 4.x IDs, REBEL-1G9) |
| **OpenRouter canonical slug** | OR API response (`GET /api/v1/models`) — the OR-internal slug behind the external ID | `anthropic/claude-5-fable-20260609` for `anthropic/claude-fable-5` — see below |
| **OpenRouter pricing** | OpenRouter (includes 5.5% OR fee) | Compute from base + 5.5% |

### OpenRouter availability & ID check

Don't trust the website cache or training data — check the live API:

```bash
curl -s https://openrouter.ai/api/v1/models | jq '.data[] | select(.id | test("fable")) | {id, canonical_slug, context_length, pricing}'
```

- **External ID vs canonical slug**: the OR catalog entry's top-level `id` uses the external ID (e.g. `anthropic/claude-fable-5`). OR also has an internal **canonical slug** (e.g. `anthropic/claude-5-fable-20260609`) that can be echoed in OR responses. Add it as a legacy/alias id on the OR block **and add a pricing-resolution test** asserting the canonical slug resolves to the SDK id — otherwise `resolveOrModelToSdkId()`'s regex fallback misses it and OR-routed usage goes untracked (`MODEL_PRICING` miss). The dashed-vs-dotted REBEL-1G9 note is NOT the only alias hazard.
- **Dashed IDs**: newer Anthropic models are all-dashed on OR (no dotted form exists for Fable 5) — `legacyIds` for the dotted spelling is only needed where a dotted form actually existed.
- **Pricing semantics**: the OR API reports *base* per-token pricing; the catalog's `openRouter.pricing` block stores base × 1.055 (5.5% OR platform fee), rounded to the existing 2dp catalog convention. Canonical-slug/alias ids resolve to SDK base pricing.

### API Spike Checklist (do this for brand-new models)

A 10-minute spike beats designing around an unverified wire assumption. Base call:

```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-fable-5","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'
```

Then vary it through this checklist (the Fable 5 run, `docs/plans/260611_fable-5-support/`, is the worked example):

1. **Bare request** (no `thinking`, no sampling params) → expect 200. Asserts no Rebel path *needs* to send a `thinking` param at all.
2. **`temperature: 0`** → record 200 vs 400. **If 400, capture the VERBATIM error text** and check it against `isTemperatureRejectionError` in `src/core/services/safety/btsSafetyEvalService.ts` — that regex-gated retry-without-temperature self-heal is the backstop if the sanitizer chokepoint (step 8c) ever misses a path, and provider wording drifts (Fable says "`temperature` is deprecated for this model.", which the pre-Fable regex did NOT match — it needed a `|deprecated` arm).
3. **Thinking-config variants** the new code will send (e.g. `{type:"adaptive", display:"summarized"}`) → expect 200. Spike the shapes your *new* code will produce, not current behavior.
4. **`output_config.effort: "max"`** (or the highest supported level) → expect 200.
5. **Models-endpoint cross-check**: `GET /v1/models/<id>?beta=true` — verify context window, max output, vision, and the compact/effort/adaptive flags against the planned catalog entry (same check `scripts/check-model-capabilities.ts` automates).
6. **Small-`max_tokens` floor probe** (always-on-thinking models): send a tiny budget (e.g. 256) with a short JSON-shaped prompt and record whether thinking exhausts the budget (`stop_reason: "max_tokens"`, zero text blocks). Note: a single sample of non-deterministic thinking proves little — treat "text present" as weak evidence and prefer the conservative floor (step 8c).

> **Prefer encoding the checklist as a permanent gated live-API test over a one-off spike.** The curl spike above is for day-0, before any code exists. Once the model brings new wire constraints (always-on thinking, rejected sampling params, new request params), turn the checklist into a gated test in `tests/live-api/` — worked example: [`tests/live-api/alwaysOnThinkingWireContract.live.integration.test.ts`](../../tests/live-api/alwaysOnThinkingWireContract.live.integration.test.ts) (Fable 5; parameterized so the next always-on model is a one-line addition). The weekly live run (`npm run test:live`, [RELEASE_TO_BETA §5.1](RELEASE_TO_BETA.md)) then re-validates the wire premises continuously — error-wording drift (e.g. the `isTemperatureRejectionError` "deprecated" arm), capability flips, limit changes — instead of only on launch day.


## Pre-Code Decision: Selectability Policy

Before writing code, decide how the **old model** should be treated:

| Policy | Catalog behavior | User impact |
|--------|-----------------|-------------|
| **Keep selectable** | Old model stays in "Current models" with `isMainModel: true`. No `migratesTo`. New model becomes the default everywhere. | Users who explicitly chose the old model keep it. New users get the new model. |
| **Fully deprecate** | Old model moves to "Deprecated models" with `migratesTo: <new>`. Loses `isMainModel`/`isAuxiliaryModel`/`displayLabel`. | Old model vanishes from all Anthropic dropdowns. Saved settings force-migrate on every load. Users on OpenRouter can still select it if OR keeps it. |

> **Warning:** `migratesTo` has two effects: (1) adds the model to the migration map so `normalizeModel()` rewrites it, and (2) removing `isMainModel` drops it from `MODEL_OPTIONS`, which drives all Anthropic UI dropdowns. "Deprecate" means "invisible in UI + force-migrated in settings."
>
> **Lesson learned (Opus 4.7, April 2026):** Fully deprecating Opus 4.6 removed it from all Anthropic dropdowns, surprising users who preferred it. It was restored as selectable in a follow-up. Consider keeping the predecessor selectable for at least one release cycle when models are at the same price point.

Document the decision in the planning doc and apply the corresponding catalog changes in Phase 1.

### Withdrawal / hide-from-selection (access lapses)

When API access to a model is **temporarily withdrawn** (not a full deprecation), hide it from pickers without stripping capability metadata:

| Action | Catalog behavior | User impact |
|--------|-----------------|-------------|
| **Hide from selection** | Set `isMainModel: false` and `isAuxiliaryModel: false` on the direct entry **and** the nested `openRouter` block (if present). **Keep** capability flags (`supportsExtendedContext`, `thinkingAlwaysOn`, etc.) — those stay catalog-backed and are **not** gated by `isMainModel`. Do **not** set `migratesTo` unless you intend force-migration. | Model vanishes from role dropdowns and OR pickers; saved settings that already reference it may still route (and fail at the provider) until the user changes model. |

**Precedent:** Claude Fable 5 (2026-06) — `isMainModel`/`isAuxiliaryModel` flipped to `false` on both the `claude-fable-5` and `anthropic/claude-fable-5` rows while `supportsExtendedContext` and other flags remained; restore selectability flags when access returns. See [MODEL_REGISTRIES](./MODEL_REGISTRIES.md) for how capability vs visibility axes diverge.


## Pre-Code Decision: Quality-Tier Placement

When the new model sits **above the existing top tier** (price, capability, or both), the quality-tier question is a separate explicit decision — don't silently defer it:

| Option | Consequence |
|--------|-------------|
| **Repoint the top tier** (e.g. "Maximum" → new model) | Every tier user silently gets the new model — effectively a defaults change (price, refusal behavior). Needs the same scrutiny as bumping `ANTHROPIC_DEFAULT_THINKING_MODEL`. |
| **Add a new tier** | Reshapes the slider UI, the MCP `/settings/set-quality-tier` route, and E2E pins — a product decision, not a checklist item. |
| **Leave it out of tiers** | Model is reachable only via the three role dropdowns and presets. Cheapest, reversible; fine for premium-priced additive adds. |

**Fable 5 (2026-06-11) chose "out of tiers"**: repointing "Maximum" would have silently 2×'d costs and added refusal behavior for every maximum-tier user. Record the choice and rationale in the planning doc alongside the selectability policy.


## Code Changes Checklist

### Phase 1: Model Catalog + Constants (Source of Truth)

These files define the model — everything else derives from them.

> **The Phase-1 set is CI-atomic — land it as one commit.** The catalog
> entry alone trips five hard test gates, so these must move together:
> catalog entry (step 1) + limits row (step 8) + `model-labels.json`
> (step 13) + provider-catalog blurbs (step 14b) + the matching test
> pins (`modelCatalog.test.ts` sorted-id pin, `anthropicModelLimits.test.ts`,
> the flag-lock `it.each` in `modelLimits.openrouter.test.ts`,
> `providerCatalogs.descriptions.test.ts`, `mcpModelLabels.test.ts`,
> `pricingCalculator.test.ts` expectations). Splitting these across
> commits leaves CI red in between; bundling them is a feature — the
> model cannot land half-wired.

> **2026-04-28 update — registry derivation:** Following the eval
> infra refactor (`docs/plans/260428_kw_eval_infra_and_model_registry.md`),
> `src/shared/data/openRouterModels.ts` and the OR-models block in
> `src/shared/data/modelProviderPresets.ts` are now eagerly derived from
> `MODEL_CATALOG` at module load time. **The single source of truth is
> the catalog entry's nested `openRouter` block + optional
> `presets` block.** Adding a new OR-routed model is a one-place
> change: add the catalog entry with the nested blocks, and the OR
> registry + provider presets pick it up automatically. The CI guard
> `scripts/check-model-registry-consistency.ts` (run via
> `validate:model-registry-consistency`, also wired into `validate:fast`)
> blocks merges that drift the three registries.

> **2026-04-29 update — catalog hygiene:** Set `maxOutputTokens` on
> every catalog entry. `KNOWN_MODEL_MAX_OUTPUT` and
> `KNOWN_MODEL_CONTEXT_WINDOWS` derive from `MODEL_CATALOG`, not from
> `PROVIDER_PRESETS`. An entry whose only provider hint is `'other'` or
> `'local'` (e.g. cohere via OpenRouter) still needs the catalog entry
> to get the right cap. See commit `859da72c3` for the bug that
> motivated this rule (`command-a-03-2025` returned 0 turns / 0 tokens
> because its context window fell back to a tiny default).

| # | File | What to change |
|---|------|---------------|
| 1 | `src/shared/data/modelCatalog.ts` | Add new model entry in "Current models" section (entry order drives dropdown order — a new top tier lists first). **Also add the OR catalog entry** (a separate entry with top-level `id: 'anthropic/<model>'`, `provider: 'openrouter'`, ×1.055 `pricing`): its nested `openRouter` block carries `label`, `sdkModel`, `isMainModel`/`isAuxiliaryModel`, and any `legacyIds` (include the OR canonical slug — see Pre-Work); its top-level `presets` block (`description`, `contextWindow`, `maxOutputTokens`) feeds the OR provider presets. **Set the capability flags** (`supportsExtendedContext`, `supportsCompact`, `supportsMaxEffort`, `thinkingAlwaysOn` for models whose thinking cannot be disabled; plus `supportsImageInput: false` for text-only models — omitted ⇒ assumed vision-capable, consumed via `modelSupportsImageInput()`) — the catalog is the SSOT for capability gating (see steps 8b/8c); verify each against `GET /v1/models/<id>?beta=true`. Capability flags go on the **Anthropic-direct row only** — OR wire ids normalize via `normalizeForCapabilityCheck()`, so don't duplicate them on the OR entry. If deprecating old model: apply the selectability policy decided above — either move to "Deprecated" with `migratesTo` or keep in "Current" without it. Update ALL older deprecated entries of same tier to point `migratesTo` directly to the new model. |
| 2 | `src/shared/utils/modelNormalization.ts` | Opus-tier: update `ANTHROPIC_DEFAULT_THINKING_MODEL` in step 2b (`PREFERRED_PLANNING_MODEL` derives from it). Sonnet-tier: update `DEFAULT_MODEL`. Haiku-tier: update `DEFAULT_AUXILIARY_MODEL`. |
| 2b | `src/shared/utils/providerDefaultConstants.ts` | **Leaf source-of-truth for the per-provider default constants** — `ANTHROPIC_DEFAULT_THINKING_MODEL` (Opus), `OR_DEFAULT_THINKING_MODEL` (derived `anthropic/${ANTHROPIC_DEFAULT_THINKING_MODEL}`), `ANTHROPIC_DEFAULT_WORKING_MODEL`/`OR_DEFAULT_WORKING_MODEL`/`*_BACKGROUND_MODEL` as applicable. `PREFERRED_PLANNING_MODEL` in `modelNormalization.ts` **imports** `ANTHROPIC_DEFAULT_THINKING_MODEL`; `openRouterDefaults.ts`/`codexDefaults.ts` re-export from here. Bump the Opus default here only. |
| 3 | ~~`src/shared/data/openRouterModels.ts`~~ | **No longer hand-edited** — derived from catalog `openRouter` blocks. Verify the new model appears in `OR_MODEL_CATALOG` via the catalog change in step 1. |
| 4 | ~~`src/shared/utils/openRouterDefaults.ts`~~ | **No longer the value source** — `OR_DEFAULT_THINKING_MODEL` / `OR_DEFAULT_WORKING_MODEL` are now defined in `providerDefaultConstants.ts` (step 2b) and re-exported here. |
| 5 | ~~`src/shared/data/modelProviderPresets.ts`~~ | **No longer hand-edited for OR models** — `PROVIDER_PRESETS.openrouter.models` is derived from catalog entries with a `presets` block. Anthropic-direct preset labels and non-OR providers still live here. |

### Phase 2: Core Runtime

| # | File | What to change |
|---|------|---------------|
| 6 | `src/core/rebelCore/planningMode.ts`, `src/core/rebelCore/agentTool.ts` | **Usually no change** — these now import `PREFERRED_PLANNING_MODEL`/`PLAN_MODE_ALIAS` rather than hardcoding a fallback. Grep to confirm there's no stray literal `claude-opus-*` before assuming clean. |
| 8 | `src/shared/data/anthropicModelLimits.ts` | Add a new entry to `ANTHROPIC_MODEL_LIMITS` (before the generic `claude-opus-4` / `claude-3` patterns) with `contextWindow`/`maxOutputTokens`. **The limits table lives here** (single source of truth for both `modelLimits.ts` and `modelProviderPresets.ts`), NOT in `modelLimits.ts`. |
| 8b | Capability gates (catalog flags — refactor `5e0a457db`) | For rostered models, capability gating (`supportsMaxEffort()`, `isExtendedContextModel()`, `supportsCompact()`, `isAlwaysOnThinkingModel()`) reads **catalog flags** via `getCatalogCapabilityForModel()` — set `supportsExtendedContext` / `supportsCompact` / `supportsMaxEffort` / `thinkingAlwaysOn` on the step-1 entry only. **`supportsMaxEffort` is load-bearing, not an effort-level nicety**: it drives `resolveThinkingConfig()`'s adaptive branch — without it an adaptive-thinking model falls to the `budget_tokens` branch and (for models that reject `budget_tokens`, e.g. Fable 5) every effort≥medium turn 400s. It also implies effort support: `supportsEffort()` short-circuits on `supportsMaxEffort` (since 260611), so flag-carrying models need no regex change; a new effort-supporting model *without* max-effort still needs the family regex in `modelLimits.ts` (the one capability that spans non-Claude families and isn't catalog-driven). **Do not edit the other capability regexes** — `legacyCapabilityRegexMatch()` is automatic fallback for *un-rostered* ids only. Then: (a) add the model to the flag-lock `it.each` in `src/core/rebelCore/__tests__/modelLimits.openrouter.test.ts`; (b) `scripts/check-model-capabilities.ts` cross-checks catalog flags vs `GET /v1/models/<id>?beta=true` (needs `TEST_CLAUDE_API_KEY`/`ANTHROPIC_API_KEY`; skips otherwise). |
| 8c | Always-on-thinking wire safety (BTS + clients — mechanism shipped 260611, plan `260611_fable-5-support`) | **For models with `thinkingAlwaysOn: true`, the standing mechanism handles wire constraints — setting the catalog flag is the whole job.** What the flag drives: (a) `sanitizeBtsOptionsForWireModel()` (`src/core/services/bts/transports/shared.ts`) strips `temperature`/`top_p`/`top_k` and applies the BTS max-tokens floor (`ALWAYS_ON_THINKING_BTS_MIN_MAX_TOKENS` — always-on thinking can eat tiny BTS budgets, leaving zero text blocks) per-dispatch; its branded `WireSafeBtsOptions` output type makes an unsanitized transport dispatch a compile error; (b) `assertWireSafeForAlwaysOnThinking()` (`src/core/rebelCore/alwaysOnThinkingWireSafety.ts`) asserts the final body at the anthropicClient and BTS-transport seams (throws in dev/test, Sentry-captures + strips in prod); (c) `scripts/check-bts-transport-symmetry.ts` lists the sanitizer in `requiredBehaviors`, so a future transport can't ship without it; (d) `resolveThinkingConfig()` adds `thinking.display: 'summarized'` for always-on models only (never send `display` to models where it's unverified). **Verify, don't re-build**: spike the new model's actual 400 text for sampling params and confirm `isTemperatureRejectionError` (`btsSafetyEvalService.ts`) matches it — that self-heal regex is the backstop if a path misses the chokepoint, and wording drifts per model. |
| 9 | `src/main/services/turnErrorRecovery.ts` + `src/shared/utils/modelNormalization.ts` | Review handler comment and user-facing messages. The actual fallback target is determined by `downgradeThinkingModelConfig()` in `modelNormalization.ts`, so log messages and status text should reference the model dynamically, not hardcode model names. **When adding a model ABOVE the default thinking tier, add it to `THINKING_MODEL_DOWNGRADE_TARGETS`** (consumed via `getThinkingModelDowngradeTarget()`) so unavailability degrades down the ladder (e.g. Fable 5 → Opus 4.8 → Sonnet 4.6) instead of soft-failing with a false "already on fallback" log. |
| 9b | Refusal handling (models with safety classifiers — mechanism shipped 260611) | Any model that can emit `stop_reason: 'refusal'` requires the refusal pieces to exist (they do, since the Fable 5 run — verify, don't re-build): agent-loop terminality (`agentLoop.ts` exits on `refusal` BEFORE executing tool_use blocks from a refused response), no-futile-retry + honest user message in `turnErrorRecovery.ts` (branches on the typed `EmptyResultAnomalyError.stopReason` field — do NOT extend the message string-match), mid-turn refusal status event in `agentMessageHandler.ts`, `stop_details.category` logging in `anthropicClient.ts`, and distinct refusal classification at the BTS parse layer (`btsSafetyEvalService` + `watchdogJudge` — refusals must not masquerade as `parse_failed`) with a Sentry `refusal` known-condition classification so frequency is measurable. |
| 10 | `src/shared/utils/modelNormalization.ts` | Update permission-error detection logic (`mentionsKnownThinkingModel` in `isThinkingModelUnavailableError()`, formerly `mentionsOpus`) to include the new model ID — otherwise permission errors on the new model spuriously `console.warn`. |

### Phase 3: UI + MCP + Evals

| # | File | What to change |
|---|------|---------------|
| 11 | `src/shared/data/qualityTiers.ts` | Update `CLAUDE_TIERS` model references. This is the canonical home (since plan 260503); the renderer slider and the `bundledInboxBridge` `/settings/set-quality-tier` MCP route both consume it. |
| 12 | ~~`src/main/services/bundledInboxBridge.ts`~~ | **No longer hand-edited for tier configs** — derived from `CLAUDE_TIERS` via the shared import (since plan 260503). Verify by running the route test in `src/main/services/__tests__/bundledInboxBridge.test.ts`. |
| 13 | `resources/mcp/rebel-automations/model-labels.json` | Add `id` → `displayLabel` entry (loaded by `server.cjs`; raw-id fallback if missing). CI asserts JSON covers every anthropic `isMainModel` catalog id. |
| 14 | `resources/mcp/rebel-settings/server.cjs` | Update schema description examples. |
| 14b | `src/shared/data/providerCatalogs.ts` | Add the new model to `ANTHROPIC_CATALOG_DESCRIPTIONS` and `OPENROUTER_CATALOG_DESCRIPTIONS` (short UI blurbs); demote the predecessor's blurb to "Previous…". |
| 14c | `src/shared/data/modelProviderPresets.ts` | Two hand-curated edits here (OR-routed *catalog* entries derive automatically): (1) the Anthropic/OR onboarding preset **template** (`label`/`name`/`model` of the "Deep Reasoning" preset → new model); (2) **`MODEL_CAPABILITY_DEFAULTS` routing notes — REQUIRED for every main model.** Add a curated 1-2 sentence entry (and demote the predecessor's). This is the planner's per-model routing guidance (read at `planningMode.ts` via `getModelCapabilityDefaults()`); a main model added without it slips through silently — the GLM 5.2 omission. **CI-guarded:** `scripts/check-model-routing-notes.ts` (`validate:fast`) fails if any main model lacks a resolvable entry. |
| 14d | `src/core/modelRecommendation/recommendationMetadata.ts` (+ `recommendationExclusions.ts`) | **Recommendation metadata (REQUIRED for any addable model — CI-guarded).** The "Recommended for most people" engine (`src/core/modelRecommendation/`, plan `260614_recommended-models-engine`) selects its set from per-model recommendation metadata. The **inverted catalog-rot guard** (`recommendModels.test.ts`) enumerates `MODEL_CATALOG` + addable `PROVIDER_CATALOGS` rows and **fails CI** unless each main/addable candidate has **either** a `RECOMMENDATION_METADATA` record **or** an explicit `RECOMMENDATION_EXCLUSIONS` entry with a reason. So when adding/upgrading a model you MUST do one of: **(a) add/refresh a metadata record** — `valueClass`, `qualityTier`, `tierBasis`, `provenance`, `visionStrength`, `recommendationEligible`, `sampleRuns`/`fixtureCoverage`, `sourceNote`, and `appliesToCatalogIds` listing **both** routing forms (bare + slash-id). **Newer required/optional fields (plan `260614_recommended-models-followup`):** also set `costTier` (the **curated** cheap/middle/premium recommendation band — a hand-picked product choice, NOT a price derivation; e.g. DeepSeek v4 Pro is `middle` even though its mean cost sits *below* Flash's `cheap`) and `familyRank` (an ordinal within the model's `family`, higher = newer — family **ordering** only, never proof of quality; unique within a multi-member family). When the model is the **latest in an existing family** but lacks its own eval data (editorial), set `provenTierSourceCatalogId` to the same-family eval-grounded predecessor it inherits its ranking tier from (e.g. `claude-opus-4-8` carries `'claude-opus-4-7'`) — this is the auditable proof source; the inheritance is applied at the **selector** (internal `RankingFacts`), so the metadata stays honest (keep `provenance:'editorial'`/`tierBasis:'floored-to-prior-gen'`/`sampleRuns:0` — there is **no** `'inherited-from-family-latest'` basis value). The metadata tests assert every row has a valid `costTier`, `familyRank` is set+unique-within-family, and any `provenTierSourceCatalogId` resolves to a same-family eval-grounded best-config member. Set `provenance:'eval-grounded'` only if a real KW run covers it (eval-grounded cost ⇒ run date ≥ 2026-05-14), else `provenance:'editorial'` **floored to the prior proven generation** (`tierBasis:'floored-to-prior-gen'`) with the single-run observation as a caveat note, never as the tier value (DECISION D); **or (b) add an exclusion record** stating why the model shouldn't be recommended. If the model is genuinely eval-grounded, also append its config to the committed seed artifact (`RECOMMENDATION_SEED_RUN`) so "eval-grounded" stays auditable. **Editorial rows must never outrank an eval-grounded peer** on the same axis — verify the provenance sort-key test still passes. **Follow-up (known debt, plan `260614`):** the current editorial rows (Opus 4.8 / Fable 5 / Gemini 3.x) should be re-derived editorial→eval-grounded once a fresh KW sweep covers them (a Pareto-refinement pass); and the seed artifact is hand-transcribed today — a full seed-extraction script (re-derive `RECOMMENDATION_SEED_RUN` from the analysis HTML rather than by hand) is a deferred follow-up. |
| 15–19 | `evals/configs/*.json`, `evals/rebel-core-loop.ts`, `evals/knowledge-work.ts`, `evals/memory-update-quality.ts`, `evals/memory-update-ab.ts` | **⚠️ DO NOT bundle the eval-judge bump with the catalog add.** Bumping the judge in `evals/configs/default.json` changes the **canonical judge-panel signature**, which the adequacy gate compares against every committed result fixture — flipping it trips `panel_signature_mismatch` across the whole corpus (~18 eval/script test failures: `analyze-knowledge-work*`, `aggregate*`, `canonicalPanel`, `check-eval-corpus-clean`). The corpus has to be migrated in the **same** change via `npx tsx evals/manage-stale-results.ts --epoch <YYMMDD>_<label> --apply` (see `docs/plans/260514_stale_eval_results_management.md`). Because that's a deliberate, separate operation, **leave the eval judge constants on the prior model when you're only adding a product-catalog model** — cycle the eval judge + corpus in its own follow-up change. (The `*_BACKGROUND`/working tier bumps that don't feed the canonical panel are safe, but the simplest rule is: touch evals separately.) |

> **Runtime AI-research enrich (optional assist, NOT a substitute for step 14c).** Settings → Models has a per-profile **"Research this model"** button that fills a profile's `modelNotes` via background AI web-research. It's a user-facing runtime affordance, **gated to models that genuinely lack routing notes** (custom/local/self-hosted ids the catalog doesn't know) — built-in models use their curated `MODEL_CAPABILITY_DEFAULTS` notes as the default source, so the button is hidden for them. When you ship a model, still add the catalog routing-notes entry (step 14c); the enrich button does not replace it.

### Phase 4: Comment/JSDoc Updates

Update model references in comments and JSDoc across:
- `src/shared/types/agent.ts`, `src/shared/types/settings.ts`
- `src/shared/ipc/schemas/agent.ts`
- `src/shared/utils/codexDefaults.ts`, `src/shared/utils/pricingCalculator.ts`
- `src/main/services/agentTurnExecutor.ts`, `src/main/services/localModelProxyServer.ts`
- `src/main/services/agentMessageHandler.ts`, `src/main/services/cloud/cloudWorkspaceSync.ts`

### Phase 5: Test Updates

Run a comprehensive grep to find ALL test references:
```bash
rg 'old-model-id' src/ tests/ evals/ -l --sort path | grep -E '__tests__|\.test\.|\.spec\.'
```

Update in this order:
1. **Test harness/builder files** first (`settingsBuilder.ts`, `eventBuilder.ts`, `testHarness.ts`)
2. **Model catalog and migration tests** (verify new migration paths) — including `mcpModelLabels.test.ts` (asserts `model-labels.json` covers every anthropic `isMainModel` catalog id) alongside `modelCatalog.test.ts`, `anthropicModelLimits.test.ts`, `modelLimits.openrouter.test.ts`, `providerCatalogs.descriptions.test.ts`, `pricingCalculator.test.ts`
3. **Bulk mechanical replacement** across remaining test files
4. **E2E tests** (`tests/e2e/test-utils.ts`, relevant `.spec.ts` files)

**Exceptions — do NOT replace:**
- Pricing tests for the deprecated model (still needed for historical cost calculation)
- Backward-compatibility tests (model still exists, just deprecated)
- Fallback TARGET references (old model is the correct fallback for the new one)
- Non-existent model tests (e.g., `claude-opus-4-60` testing regex boundaries)


## Verification Checklist

```bash
# 0. Registry consistency (NEW April 2026) — runs as part of validate:fast
npm run validate:model-registry-consistency

# 1. Fast validation (lint, IPC contracts, store versions, TS ratchet,
#    registry consistency)
npm run validate:fast

# 2. Full unit test suite
npm run test -- --run

# 3. Grep for remaining old-model references (should only be in expected places)
rg 'old-model-id' src/ --no-filename -c | paste -sd+ - | bc
# Expected: deprecated catalog entry, backward-compat patterns, fallback targets, comments about history

# 4. Optional: E2E tests
npm run test:e2e
```

### Settings normalization paths

Verify that ALL persisted model fields in `settingsUtils.ts` → `normalizeSettings()` handle deprecated model IDs. These fields store raw model strings and must migrate deprecated values:

| Field | Normalization | Location in `settingsUtils.ts` |
|-------|--------------|-------------------------------|
| `claude.model` | `normalizeModel()` at top of function | ~line 251 |
| `claude.thinkingModel` | `normalizeModel()` before `MODEL_OPTIONS` check | ~line 699 |
| `claude.longContextFallbackModel` | `normalizeModel()` after whitespace check | ~line 748 |
| `claude.thinkingFallback` | `normalizeTierFallback()` handles `model:` prefix | ~line 767 |
| `claude.workingFallback` | `normalizeTierFallback()` handles `model:` prefix | ~line 768 |
| `backgroundFallback` | `normalizeTierFallback()` handles `model:` prefix | ~line 769 |

If adding a new persisted model field, ensure it also gets normalization.

> **Legacy `planMode` migration is self-limiting — new top-tier models need no branch.** The legacy-`planMode` normalization branch in `settingsUtils.ts` requires `legacyPlanMode && !thinkingModel`, but normalized output *derives* `planMode` from `thinkingModel`, so persisted `planMode: true` implies `thinkingModel` is set — the branch only fires for pre-derivation stale data, which predates any newly added model. Verified during the Fable 5 run (260611); don't add per-model special cases there.

### OpenRouter pricing verification

After adding OR pricing entries, verify:
- All four pricing fields are updated (input, output, cacheRead, cacheCreation)
- Values match base pricing × 1.055 (5.5% OR platform fee)
- `pricingCalculator.test.ts` has expectations for the new OR model

### Local eval config warning

Updating committed templates in `evals/configs/` does **not** update existing local operator configs under `evals/configs/.local/*.json` (gitignored). After changing eval defaults, manually review any local configs used with `--config`.

### All three role dropdowns (manual)

After adding a main Anthropic model, open Settings → Models and confirm it appears in **Planner**, **Main work**, and **Behind the scenes** with each relevant credential setup (direct Anthropic API key at minimum). Catalog correctness does not guarantee per-role picker visibility — hidden `__virtual-thinking` glue profiles, disabled/auto-managed profiles, and role-asymmetric shadowing can hide a model from one or two roles while Planner still shows it (June 2026 Opus 4.8 incident; fixed `b908b882e`, role-symmetric invariant `d98a41d4e`). CI catches role-asymmetry; this eyeball check is cheap and catches whole-picker misses.

### Multi-model review (recommended for frontier upgrades)

For major model tier changes (e.g., new Opus), run a 3-reviewer audit across different model families to catch:
- Stale model IDs in code, comments, and tests
- Selectability/migration semantic issues
- OpenRouter pricing inconsistencies
- Hidden persisted settings not covered by normalization


## Living Docs to Update

| File | What to update |
|------|---------------|
| `docs/project/MODEL_CONSTANTS.md` | Constants table, "Adding New Models" section |
| `rebel-system/help-for-humans/AI-models.md` | Add new model, note deprecation |
| `docs/project/SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md` | If it references specific model IDs |

**Do NOT update** historical docs: `docs/plans/`, `docs-private/postmortems/`, `docs-private/investigations/`, `docs/research/`, `docs-private/reports/`, `CHANGELOG.md`, `memory/`.


## Companion Process: Droid/Subagent Upgrades

If the new model is also used by coding droids (e.g., Claude Opus used by Factory droids), also follow [SUBAGENT_MODEL_UPGRADE_PROCESS](SUBAGENT_MODEL_UPGRADE_PROCESS.md). That covers:
- Renaming droid files in `.factory/droids/`, `.cursor/agents/`, `coding-agent-instructions/droids/models/`
- Updating workflow references in `CHIEF_ENGINEER2/CHIEF_ENGINEER2.md`, `CHIEF_BUGFIXER.md`, etc.
- Updating `SUBAGENT_REFERENCE.md`, `PROJECT_OVERRIDES.md`

Both processes should be done together when a frontier model is upgraded.

**Out of scope for THIS runbook (don't "helpfully" update them in an app-catalog run):** model references in `scripts/sentry-autopilot/`, `evals/autopilot-prompt.ts`, and `scripts/cloud-vm-provision.sh` are coding-droid scope — they belong to [SUBAGENT_MODEL_UPGRADE_PROCESS](SUBAGENT_MODEL_UPGRADE_PROCESS.md), as do `.factory/droids/`, `.cursor/agents/`, and workflow docs.


## Discovery: Finding All References

The most reliable approach is a comprehensive grep. Model IDs are stringly-typed and scattered across the codebase.

```bash
# Find all files referencing the old model (case-insensitive)
rg -i 'old-model-id|old.model.id' src/ tests/ evals/ resources/ docs/project/ rebel-system/help-for-humans/ -l

# Count total matches
rg -i 'old-model-id|old.model.id' src/ --no-filename -c | paste -sd+ - | bc
```

Cross-reference results against the checklist above. Any file NOT in the checklist is a potential gap.


## What's Guarded vs Convention-Only

**Fail red in CI when missed** (this run + prior guards):

| Surface | Guard |
|---------|-------|
| OR three-registry consistency | `scripts/check-model-registry-consistency.ts` (`validate:fast`) |
| Catalog capability flags | `scripts/check-model-capabilities.ts` + flag-lock tests in `modelLimits.openrouter.test.ts` |
| Provider-catalog picker blurbs | `providerCatalogs.descriptions.test.ts` |
| Anthropic limits per main model | `anthropicModelLimits.test.ts` loop (explicit row before generic fallback) |
| Quality-tier model ids | `qualityTiers.test.ts` loop via `getCatalogEntryById` |
| Main-model roster | `modelCatalog.test.ts` sorted-id-list pin (failure → this doc) |
| Main-model routing notes | `scripts/check-model-routing-notes.ts` (`validate:fast`) — every main model needs a resolvable `MODEL_CAPABILITY_DEFAULTS` entry |
| Default thinking-model constant | `ANTHROPIC_DEFAULT_THINKING_MODEL` → `PREFERRED_PLANNING_MODEL` / `OR_DEFAULT_THINKING_MODEL` |
| MCP automation display labels | `resources/mcp/rebel-automations/model-labels.json` + catalog coverage test |
| Always-on-thinking wire safety | `WireSafeBtsOptions` compile-time brand + `assertWireSafeForAlwaysOnThinking` (dev/test throw; prod capture+strip) + `check-bts-transport-symmetry.ts` requiredBehaviors |

**Still manual / deliberate** (no red gate): this runbook; eval judge bumps (corpus migration — steps 15–19); E2E `CLAUDE_DEFAULTS`; help docs (`rebel-system/help-for-humans/AI-models.md`); managed-tier rebel-platform admin config.


## Past Upgrades

| Date | Change | Scope |
|------|--------|-------|
| 2026-06-11 | Fable 5 added (additive) | **Additive add — new top tier above Opus 4.8; defaults unchanged; NO deprecations** (2× Opus price, safety-classifier refusals, 30-day retention requirement, and a new tokenizer made default-promotion a separate product decision; Opus 4.8/4.7/4.6 stay selectable). First model with `thinkingAlwaysOn` — the always-on-thinking mechanism shipped alongside: BTS sanitizer + branded `WireSafeBtsOptions` + transport-symmetry guard (step 8c), `assertWireSafeForAlwaysOnThinking` wire assertion, `thinking.display: 'summarized'` opt-in (always-on models only), `stop_reason: 'refusal'` handling (loop terminality, no futile retry, honest message, BTS classification — step 9b), Fable→Opus downgrade map (step 9), and `supportsEffort()` derived from `supportsMaxEffort` (step 8b). OR canonical-slug alias + pricing-resolution test (REBEL-1G9's dotted-form note isn't the only alias hazard). **Eval judges deliberately untouched** (steps 15–19). Quality tiers untouched ("out of tiers" — see Pre-Code Decision). Plan: `docs/plans/260611_fable-5-support/`. |
| 2026-06-10 | Opus 4.8 availability complaints — triage + guard hardening | **No new model; process/docs reaction.** Named complainants on 0.4.44/0.4.45 had a real picker bug (4.8 in Planner but missing from Main work / BTS — hidden profile shadowing; fixed on dev `b908b882e` + role-symmetric invariant `d98a41d4e`, unreleased). Separate stale-build cohort (~30% on ≤0.4.43). Managed tiers use rebel-platform tier config (empty DB → GPT+DeepSeek fallbacks, no Claude) — unrelated to API-key complainants. Lessons: triage app version + dev-vs-released first; verify all three role dropdowns; managed tier ≠ app catalog. Guards added: single-sourced default constants, limits coverage, tier existence, main-model id-list pin, MCP labels JSON. Plan: `docs/plans/260610_opus48-availability/`. |
| 2026-05-30 | Opus 4.7 → Opus 4.8 | **Additive + product-only.** Added `claude-opus-4-8` as the new default planning/thinking model everywhere; kept Opus 4.7 **and** 4.6 selectable (no new deprecations, applying the "keep predecessor selectable" lesson); retargeted older deprecated opus entries (4-5/4-1/4/opus-3) `migratesTo` → 4-8. ~21 files: catalog (Anthropic + OR entry, identical metadata to 4.7 — $5/$25, 1M ctx, 128k out), `providerDefaultConstants.ts` defaults, `anthropicModelLimits.ts` + catalog capability flags, quality tiers, MCP servers, provider presets/catalog blurbs, and the matching test fixtures (incl. `tests/e2e/test-utils.ts` CLAUDE_DEFAULTS). **Eval judge models deliberately left on 4-7** — see steps 15–19: bumping them invalidates the canonical-panel fixture corpus and is a separate operation. Doc updated to point steps at the real SoT files (`providerDefaultConstants.ts`, `anthropicModelLimits.ts`) and to add the eval-corpus warning. |
| 2026-04-17 | Opus 4.6 restored as selectable | Follow-up: 4.6 was over-deprecated (removed from dropdowns). Restored `isMainModel`, removed `migratesTo`, fixed thinkingModel/fallback normalization gaps, fixed OR pricing. Led to "Selectability Policy" section above. |
| 2026-04-16 | Opus 4.6 → Opus 4.7 | ~60 files: catalog, constants, runtime, UI, MCP, evals, tests, docs. All older opus entries updated to migrate directly to 4.7. |
| 2026-02-05 | Opus 4.5 → Opus 4.6 | Similar scope. Established the migration pattern. |
