---
description: "How the knowledge-work reproducible eval calculates per-fixture cost — provider-agnostic canonical pricing, the agent-vs-judge distinction, the accurate-or-null invariant, caching semantics, price provenance, and how to verify against a provider canonical."
last_updated: "2026-06-05"
---

# Knowledge-Work Eval — Cost Calculations

How the knowledge-work reproducible eval turns token usage into the per-fixture **cost** shown on the
analyzer's Pareto frontier and rankings. This is the canonical home for the *cost policy* and the *why*;
the code is the source of truth for *how*.

## See also
- [TESTING_EVALS_KNOWLEDGE_WORK.md](./TESTING_EVALS_KNOWLEDGE_WORK.md) — the eval harness overall
- [TESTING_EVALS_KNOWLEDGE_WORK_ANALYSIS.md](./TESTING_EVALS_KNOWLEDGE_WORK_ANALYSIS.md) — the analyzer/report this cost feeds
- [WRITING_EVALS.md](./WRITING_EVALS.md) — eval infrastructure overview
- `evals/eval-model-pricing.ts` — **canonical eval pricing** (the SSOT for eval cost): `EVAL_CANONICAL_PRICING`, `canonicalModelKey()`, `calculateEvalCost()`
- `evals/analyze-knowledge-work-aggregate.ts` — `getAgentRunCostUsd()` is the single seam all analyzer cost surfaces flow through
- `src/shared/utils/pricingCalculator.ts` + `src/shared/data/modelCatalog.ts` — the **app's** per-provider pricing (deliberately different — see below)
- `docs/plans/260604_kw-eval-cost-accuracy/` — the investigation + decisions behind this doc (root-cause analysis of an implausible cost ordering)

## The two pricing worlds (do not conflate)

| | Eval cost | App cost |
|---|---|---|
| **Question** | "What's the model-level capability/cost tradeoff?" (pick Pareto points) | "What did this actually cost the user right now?" |
| **Pricing** | **Provider-agnostic canonical** — one price per *base model*, from OpenRouter standard list prices | **Actual per-provider** — real price paid, incl. subscriptions / BYOK / promos |
| **Source** | `evals/eval-model-pricing.ts` | `src/shared/data/modelCatalog.ts` |

**Why eval cost is provider-agnostic.** The same model is offered by many providers at very different prices
(e.g. DeepSeek V4 Pro is ~$0.44/Mtok input on OpenRouter but ~$2.10 on Together; and under **BYOK** OpenRouter
reports `cost: 0`). For a *model-level* capability/cost comparison we must hold the provider constant, or the
frontier ranks "which provider we happened to route through," not "which model is efficient." So the eval prices
**every** model at OpenRouter's standard list price, collapsing provider prefixes and dated suffixes
(`deepseek/…`, `deepseek-ai/…`, `…-20260423`) to one base key via `canonicalModelKey()`. The app, by contrast,
must report the real money spent, so it keeps per-provider pricing.

## What the cost number is (and isn't)

- The eval cost on the frontier is the **agent run cost** only — the cost of the production agent loop (working
  + thinking + background tier models) executing the fixture. It is what you'd pay to *run that config*.
- It deliberately **excludes the eval-LLM (judge/claim-audit/arbitrator) cost**. Judge cost is an artifact of
  *measuring* quality, not of *running* the model, and it scales with the agent's transcript length — including
  it scrambles the model-selection ordering. Judge/eval-LLM cost is not shown on any analyzer cost surface.

## The accurate-or-null invariant

**We never show an inaccurate cost.** The analyzer recomputes each run's agent cost from its **per-model token
usage × canonical price** (`getAgentRunCostUsd`); it does not trust the historically-stored `estimatedCostUsd`
(older runs computed that with per-provider prices). A run is priced only when it can be priced *accurately*:

- Per-model token usage present → `Σ calculateEvalCost(model, perModelUsage[model])`.
- No per-model usage but a single model → aggregate usage × that model's canonical price.
- **Mixed-tier run with no per-model usage → cost is `null`** (surfaced as "un-repriceable — re-run to
  measure"), never guessed. Pricing all tiers at one model's rate is wrong, so we refuse to.
- Any model missing from the canonical table → `null` (never silently $0).

### Older runs are less reliable
Per-model token usage (`perModelUsage`) was added on **2026-05-16** (analysis schema ≥ 1.5). Before that,
mixed-tier configs were priced at a single model's rate — wrong. Such runs are now `null` (excluded from the
frontier, counted in the "un-repriceable" tally) and must be re-run to get a real number. Single-model older
runs are still accurately repriceable from aggregate usage.

## Caching semantics

Cost prices four token classes separately: input, output, cache-read, cache-creation (`calculateEvalCost`).
OpenRouter reports cache reads **disjointly** from input tokens (verified empirically across deepseek / minimax
/ glm / openai: cache-read frequently exceeds input, which is impossible if input were inclusive), so input and
cache-read are summed without double-counting. The OpenAI-compatible proxy maps
`input = prompt_tokens, cache_read = cached_tokens` (`src/main/services/localModelProxyServer.ts`); this is
correct for OpenRouter because OpenRouter normalizes cache reads as a separate quantity. A provider that instead
reported `prompt_tokens` *inclusive* of cached tokens would be double-charged — guard/test documents this
assumption; revisit if a non-OpenRouter OpenAI-compatible provider is added.

## Price provenance (required)

Every canonical price carries provenance — `EVAL_PRICING_PROVENANCE` (`source`, `url`, `capturedAt`) in
`evals/eval-model-pricing.ts`. When updating prices: pull from OpenRouter (`GET https://openrouter.ai/api/v1/models`,
public), prefer the **permanent/standard** price over temporary launch promos, and update `capturedAt`. Note any
per-entry override. Keep the table comment's policy statement intact.

## Verifying against a provider canonical (to the penny)

OpenRouter exposes `GET /api/v1/generation?id=<id>` returning the *actual billed cost* of a generation — the
strongest empirical check for OpenRouter-routed models (capture the generation id to use it). **Caveat:** under
**BYOK** OpenRouter returns `cost: 0` (you pay upstream directly), so that field can't be used as ground truth;
use `cost_details.upstream_inference_cost` or the canonical table instead. For Anthropic-direct there is no
per-call billed-cost API — ground truth is usage × published price, which the canonical table encodes.
