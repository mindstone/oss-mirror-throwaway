---
description: "Runbook for adding a new OpenRouter model to Rebel — catalog entry, CN/SGP provider allowlist, and knowledge-work eval verification."
last_updated: "2026-06-11"
---

# Adding an OpenRouter Model

Intent-first runbook for adding a new OpenRouter model quickly and correctly. The two hard-to-discover failure modes are documented in **Gotchas** below — read that section before your first attempt.

For a full frontier-model rollout (new Anthropic Opus, replacing defaults across quality tiers, bumping eval judges, etc.) use the comprehensive checklist in [NEW_MODEL_SUPPORT_PROCESS](./NEW_MODEL_SUPPORT_PROCESS.md) instead. This doc is the fast path for third-party OR models that don't need default-model or eval-judge changes.

## Checklist

### 1. Add a `MODEL_CATALOG` entry (the only mandatory code change)

Add one entry in the OpenRouter section of `src/shared/data/modelCatalog.ts` (`MODEL_CATALOG`). All downstream registries derive from it automatically at module load — you do **not** hand-edit `openRouterModels.ts`, `modelProviderPresets.ts`, or anything else for OR routing.

The required fields:

```ts
{
  id: 'vendor/model-slug',          // OpenRouter catalog ID (slashed form)
  provider: 'openrouter',
  pricing: { input, output, cacheRead, cacheCreation }, // base price × 1.055 (OR 5.5% fee)
  openRouter: {
    label: 'Human-readable name',
    isMainModel: true,               // shows in main conversation dropdown
    isAuxiliaryModel: true,          // shows in BTS/auxiliary dropdown
  },
  presets: {
    description: 'Short UI blurb',
    contextWindow: <tokens>,
    maxOutputTokens: <tokens>,       // required — prevents silent 0-token fallback
  },
}
```

Place the entry in the appropriate vendor group inside the `// OpenRouter` section. Pricing source: `openrouter.ai/<vendor>/<model>` list price × 1.055.

If the model does **not** accept image input (text-only, e.g. the DeepSeek family), also set `supportsImageInput: false` — omitted means assumed vision-capable, and image blocks will be sent to it (consumed via `modelSupportsImageInput()`).

Symbol references: `MODEL_CATALOG` (exported array), `OpenRouterRouting` interface (the `openRouter` block shape).

### 1b. Add routing notes for any new MAIN model

If the model is a **main** model (`isMainModel: true`), add a one-line entry to `MODEL_CAPABILITY_DEFAULTS` in `src/shared/data/modelProviderPresets.ts` — a curated 1-2 sentence note the planner uses as per-model routing guidance. This is **not** auto-derived from the catalog; a new main model without it slips through silently (the GLM 5.2 omission). The `validate:model-routing-notes` CI guard (in `validate:fast`) now fails if any main model lacks a resolvable entry. Auxiliary-only models don't need one.

### 2. Verify derivation is correct

```bash
npm run validate:model-registry-consistency
```

This script (`scripts/check-model-registry-consistency.ts`) checks that `OR_MODEL_CATALOG`, `OR_MODEL_MAP`, and `PROVIDER_PRESETS.openrouter.models` all agree with the catalog. It runs inside `npm run validate:fast`.

### 3. Check the CN/SGP provider allowlist (CRITICAL — see Gotchas)

If the model's vendor is CN/SGP-origin (MiniMax, DeepSeek, MoonshotAI, z-ai/GLM, SiliconFlow, etc.), open `openrouter.ai/models/<vendor>/<model>` and check which providers carry it.

- If at least one non-CN/SGP reseller carries it, add or update the entry for its prefix in `src/shared/openrouterProviderAllowlists.ts` (`CHINA_ORIGIN_PROVIDER_ALLOWLISTS`) — `providers` must list only the non-CN/SGP providers.
- If **no** non-CN/SGP reseller carries it yet, you have two options: (a) temporarily prepend the first-party CN provider to the `providers` list with a `// TEMPORARY` comment and a revert instruction (see the existing `minimax/` example in that file), or (b) wait until a reseller picks it up. Option (a) loosens the compliance guardrail; document it clearly.

After editing, run the optional network validator:

```bash
npx tsx scripts/check-openrouter-providers.ts
```

(Not in `validate:fast` — requires network. Run manually or in release CI.)

### 4. Run a knowledge-work eval to confirm routing works end-to-end

```bash
# One-time: capture eval API keys (provider key for the model + judge keys)
npm run eval:capture-keys -- --apply
set -a; source evals/configs/.local/keys.env; set +a

# Quick smoke: one fixture, single judge — confirms routing only (cheap)
npm run eval -- knowledge-work --model vendor/model-slug --tier 0 \
  --fixture vague-status-update-01 --single-judge

# Full canonical 30-fixture run for the cross-model comparison report
npm run eval -- knowledge-work --model vendor/model-slug \
  --thinking vendor/model-slug --background vendor/model-slug \
  --tier 0 --no-personas
```

- `--tier 0 --no-personas` = the canonical **30 static-response** fixtures. The runner's `parsePersonasArg()` defaults personas **ON**, which would add the 26 `defaultDisabled` persona-overlay fixtures (56 total). The wizard now always forwards an explicit `--no-personas` when no persona selector is set, so a default wizard run gives the 30 — but pass it yourself if invoking the built runner directly.
- **Use the default 3-judge canonical panel** (Opus 4.7 + GPT-5.4 primaries, Gemini 3.1 Pro arbitrator). `--single-judge` is fine for the routing smoke but **not** for a comparison run — the Model Performance chart only plots variants judged by the canonical panel.
- **Adaptive judging (the default) is fine** — don't disable it. The arbitrator (3rd judge) is escalated only when the two primaries disagree (`shouldTriggerArbitrator()`); when they agree the run is still adequate (the adequacy policy requires the 2 primaries when the arbitrator wasn't triggered, all 3 when it was). `--no-adaptive-judges` just forces the arbitrator on every fixture — more cost, no comparison benefit.

Then generate the cross-model comparison report (restricted to the canonical corpus + matching judge-panel signature):

```bash
npm run eval:analyze    # writes a dated *_knowledge_work_analysis.html
```

See [TESTING_EVALS_KNOWLEDGE_WORK](./TESTING_EVALS_KNOWLEDGE_WORK.md) for the full eval harness docs, and Gotcha 3 below for the adequacy gate.

---

## Gotchas

### Gotcha 1 — `[eval-bootstrap] Unroutable bundle` error

**Symptom:** The eval throws `[eval-bootstrap] Unroutable bundle: thinking=vendor/model ... model is not in Rebel's OpenRouter catalog (OR_MODEL_MAP)`.

**Cause:** The model string you passed to `--model` is not present in `OR_MODEL_MAP`, which derives from `MODEL_CATALOG` entries with an `openRouter` block.

**Fix:** Add the catalog entry (Step 1 above), then re-run. This error is actionable — it names the missing key.

### Gotcha 2 — OpenRouter `404 "No allowed providers are available for the selected model"` (the hard one)

**Symptom:** The eval runs but every fixture fails with an HTTP 404 from OpenRouter: `No allowed providers are available for the selected model`.

**Cause:** The proxy (`src/main/services/localModelProxyServer.ts` → `injectProviderRouting()`) injects `provider.only` from `CHINA_ORIGIN_PROVIDER_ALLOWLISTS` for any model whose ID prefix matches a CN/SGP-origin vendor. If the model's only available provider is its first-party CN endpoint (not yet picked up by any reseller), the allowlist excludes every provider OpenRouter would normally try — OpenRouter returns 404.

The 404 does **not** mention the allowlist. Nothing in the error points to this file. You have to trace it manually.

**Fix:** See Step 3 above — either add a temporary first-party provider exception or wait for a reseller.

**Files involved:**
- `src/shared/openrouterProviderAllowlists.ts` — `CHINA_ORIGIN_PROVIDER_ALLOWLISTS` (edit here)
- `src/main/services/localModelProxyServer.ts` — `injectProviderRouting()` (reads the allowlist; do not edit for this fix)
- `scripts/check-openrouter-providers.ts` — validates allowlist entries against live OR endpoints

### Gotcha 3 — analyzer blocks (`rejudge_canonical`), or your model is missing from the Model Performance chart

Two distinct failure modes, usually from the **same root cause: a fixture that didn't complete or wasn't fully judged.**

**3a — `eval:analyze` fail-fatals** with *"Inadequate judging gate blocked analyzer ingest"*, listing your run as `rejudge_canonical` (`panel_below_canonical_size`, `panel_succeeded_below_required`, `consensus_meanscore_missing`). A fixture where the agent produced **no output** (0 turns → 0 judges → no consensus) trips all three. A judge that **errored** on some fixtures lowers `succeeded` below the required count. Note: this is **not** caused by adaptive judging — the adequacy policy accepts adaptive runs (2 primaries when the arbitrator didn't fire, 3 when it did).

**Fix 3a:** backfill missing judges on existing transcripts — `npm run eval:remediate-inadequate report` then `… apply --cost-cap-usd <N>` (costs judge tokens, no agent re-run). Pre-existing unrelated junk runs are quarantined as `quarantine_corpus_drift` by the same command. A fixture with *no agent output at all* can't be rejudged — re-run that fixture (see 3b).

**3b — the report renders, but your model is absent from the Model Performance chart** (it sits in the partial-coverage table with a `⚠`). That chart only plots variants with **clean full coverage** — every canonical fixture completed and judged, none errored/degraded/unjudged. One failed fixture → 29/30 → excluded.

**Fix 3b:** re-run the offending fixture(s) for that model (`--fixture <id>`); the analyzer unions fixtures across runs of the same variant, so a successful re-run restores full coverage. Use `--prefer-rerun-pass` on `eval:analyze` if a prior errored entry for that fixture needs superseding.

---

## See also

- [MODEL_REGISTRIES](./MODEL_REGISTRIES.md) — which registries derive from `MODEL_CATALOG` and which are hand-maintained
- [NEW_MODEL_SUPPORT_PROCESS](./NEW_MODEL_SUPPORT_PROCESS.md) — comprehensive checklist for frontier-model rollouts
- [MODEL_AND_PROVIDER_OVERVIEW](./MODEL_AND_PROVIDER_OVERVIEW.md) — the hub doc for the full model/provider territory
- [TESTING_EVALS_KNOWLEDGE_WORK](./TESTING_EVALS_KNOWLEDGE_WORK.md) — knowledge-work eval harness docs
- `docs/research/260414_openrouter_non_china_routing.md` — research on CN/SGP provider compliance; covers DeepSeek, MiniMax, MoonshotAI, xAI provider lists
- `docs/plans/260428_kw_eval_infra_and_model_registry.md` — rationale for collapsing OR registries into `MODEL_CATALOG` (Stage 1 derivation)
