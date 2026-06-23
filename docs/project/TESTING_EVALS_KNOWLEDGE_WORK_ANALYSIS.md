---
description: "Knowledge-work eval results analyzer: HTML report generation, canonical corpus filtering, model variant comparison, and cost observability."
last_updated: "2026-06-04"
---

# Knowledge-Work Eval Analysis

Reads knowledge-work eval result JSON files, computes aggregations across models, engines, families, fixtures, and scoring dimensions, and generates a self-contained interactive HTML report with charts and filterable tables.

## See Also

- [WRITING_EVALS](WRITING_EVALS.md) — all eval harnesses, shared infrastructure, CLI flags
- [TESTING_EVALS_KNOWLEDGE_WORK](TESTING_EVALS_KNOWLEDGE_WORK.md) — the knowledge-work eval runner itself (fixtures, judging, scoring)
- [EVAL_CORPUS_IDENTITY.md](EVAL_CORPUS_IDENTITY.md) — `fixtureCorpusHash`, score-field fingerprints, equivalence classes, and `analysisSchemaVersion` comparability policy

## Quick Start

```bash
# Default: last 30 days, auto-detect Google Drive
npx tsx evals/analyze-knowledge-work.ts

# Via npm script
npm run eval:analyze -- --since 2026-03-29

# Dry run — show files that would be processed
npx tsx evals/analyze-knowledge-work.ts --dry-run

# Custom output location
npx tsx evals/analyze-knowledge-work.ts --output-dir /tmp/reports
```

No external dependencies — Node.js stdlib only.

## CLI Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--since YYYY-MM-DD` | 30 days ago | Only include results from this date onwards |
| `--until YYYY-MM-DD` | today | Upper bound (inclusive) |
| `--results-dir <path>` | Auto-detect (see below) | Override results directory |
| `--output-dir <path>` | Auto-detect (see below) | Override output directory |
| `--dry-run` | off | Show what files would be processed without generating report |
| `--strict-version` | off | Restrict to runs whose `analysisSchemaVersion` exactly matches the current version. Default remains permissive within the current major (includes prior minors + legacy `1.0`). |
| `--include-all-versions` | off | Deprecated no-op alias (same behavior as `--include-prior-versions`). Does **not** bypass major-version gating. Retained only for backward compatibility with legacy scripts. |
| `--include-ignored-models` | off | Include models listed in `IGNORED_MODELS` (see [Dataset Filters](#dataset-filters)). |
| `--canonical-fixtures-dir <path>` | `evals/fixtures/knowledge-work-reproducible/` | Override the directory scanned for canonical fixture IDs. Useful for testing canonical-restriction against synthetic corpora. |
| `--no-canonical-restriction` | off | Include result files for fixtures outside the canonical 30-fixture corpus. Use when measuring coverage gaps for non-canonical fixtures or experimental fixture variants. |
| `--no-collapse-repeats` | off | Keep every raw run as its own row instead of averaging repeats of the same `(model, fixture)` into a single cell. |
| `--prefer-rerun-pass` | off | Fail→pass substitution: when collapsing a `(variant, fixture)` cell, if the latest run is a fail AND an earlier run is a pass (per [pass criterion](#--prefer-rerun-pass-policy)), substitute the latest passing prior for the merged cell. **Never overrides a latest pass; never invents a pass when no prior pass exists.** Suppressed latest-fail is preserved in `_priorRunsSummary.suppressedLatestFail` for audit. See [`--prefer-rerun-pass` policy](#--prefer-rerun-pass-policy) below. |

## Directory Resolution

Uses the shared Mindstone Google Drive resolution. See [GOOGLE_DRIVE_PATH_RESOLUTION](GOOGLE_DRIVE_PATH_RESOLUTION.md) for full details.

**Results directory**:
1. `--results-dir` CLI arg
2. `EVAL_RESULTS_DIR` env var → `<value>/knowledge-work/`
3. Mindstone Google Drive → `Shared drives/Product/evals/results/knowledge-work/`
4. Repo fallback: `evals/results/knowledge-work/`

**Output directory**:
1. `--output-dir` CLI arg
2. Mindstone Google Drive → `Shared drives/Product/evals/analysis/`
3. Repo fallback: `evals/results/analysis/`

Output filename: `YYMMDD_HHMM_knowledge_work_analysis.html`

## Report Sections

1. **Executive Summary** — dataset scope, overall pass rate, best/worst model and family, engine comparison, cost insights. Renders two "most failed" callout cards side-by-side: `most_failed_fixture` (all-fixture hardest) and `most_failed_canonical_fixture` (canonical-only hardest); both cards appear even when they match, with the canonical card first. The `summary.cheapest_passing` best-value callout is sourced from canonical-restricted metrics (see [The canonical corpus](#the-canonical-corpus)).
2. **Dataset Filters banner** — see [Dataset Filters](#dataset-filters). Surfaces which `analysisSchemaVersion` runs were kept/dropped, which models are in `IGNORED_MODELS`, and whether repeats were collapsed. Read this before trusting any number further down.
3. **Model Performance** — bar chart + table: pass rate, avg score, evidence%, duration, cost per model. Only variants whose entire canonical fixture set is in a clean "completed + judged + non-degraded" state appear (see [Full-coverage filter](#full-coverage-filter) below). This filter is reused by every other variant-vs-variant comparison view so the report stays self-consistent. Internally, all compare-view surfaces source from `AggregatedData.comparison_views.canonical` (type in [`evals/analyze-knowledge-work-types.ts`](../../evals/analyze-knowledge-work-types.ts)); the `all` subtree mirrors the top-level fields and exists for consistency checks. Sub-charts below Model Performance:
   - **Cost-adjusted compound** — single ranking number combining capability and cost in compound-point units via an additive log penalty. See [Cost-adjusted compound](#cost-adjusted-compound-additive-log-penalty) for the formula, intuition, and history.
   - **Cost per role (Working / Thinking / Background)** — average per-run agent cost, broken down by tier. Useful for "what does a typical fixture cost on this variant?"
   - **Total agent cost per configuration (Working / Thinking / Background)** *(NEW 2026-05-14)* — corpus-total agent cost, summed across collapsed-cell fixtures, broken down by tier. Useful for "what would a full corpus pass cost on this variant?" See [Cost-by-role provenance](#cost-by-role-provenance) for the load-time backfill and `(estimated)` badge semantics.
4. **Cost–Capability Frontier** — scatter plot (cost vs compound) with the Pareto frontier line. **X-axis is log-scale** since cost spreads in this dataset are routinely 10–100× and collapse unreadably on a linear axis. Scatter points are restricted to the same full-coverage variant set as Model Performance so cost-vs-compound is compared apples-to-apples. Frontier dominance is computed in linear cost space — the log axis is a display choice only and doesn't change which points are on the frontier. The collapsible details table below the scatter stays unfiltered so partial-coverage configs are still visible alongside their `Status` and `Dominated By` column.
5. **Family Breakdown** — stacked pass/fail chart + table: per-family stats, hardest/easiest fixtures
6. **Fixture Detail** — filterable table (collapsed by default): per-fixture pass rate, score, evidence, models tested
7. **Dimension Scores** — one or more rubric-specific sections (current 3-dim, legacy 5-dim, legacy 10-dim), each with radar chart (top 4 models) + heatmap table: scoring dimensions × models. Also filtered to the full-coverage variant set.
8. **Evidence Analysis** — chart ranks the top 15 highest-impact misses (`miss_rate × total`) among checks seen at least 3 times, with rank-number labels and hover-for-description. Full check-by-check detail lives in a collapsible table below.
9. **Completion & Failure Taxonomy** — completion rates by model/engine, failure type breakdown with cross-references. The by-model-variant completion table is restricted to the full-coverage variant set; the by-engine table is not (engines aggregate across all variants).
10. **Adaptive Judge Economics** *(conditional — only when adaptive judging data exists)* — early-stop rate, escalation rate, estimated judge spend savings
11. **Tool Usage** — collapsible table: tool call counts and usage frequency
12. **Trends Over Time** — default view: scatter with one latest-snapshot point per variant (date vs Compound score); `--full-trends` restores the per-date Compound line chart (requires ≥2 dates). Y-axis is the canonical Compound performance score (`avg_score × (effective_pass_rate / 100)`, 0-5) for both views, matching Model Performance and Pareto.
13. **Improvement Suggestions** — auto-generated observations based on data patterns
14. **Appendices** — full run details, metrics glossary, dimension weights, file list

### Full-coverage filter

Variant-vs-variant comparison views share a single coverage filter: only variants whose entire canonical fixture set (all 30 fixtures) landed in a clean "completed + judged + non-degraded" state are eligible. A fixture run that timed out, crashed, was never judged, or ended with a degraded verdict (primaries disagreed and the arbitrator failed to resolve) does NOT count toward the 30.

The filter is the same `getFullCoverageOrder()` helper in [`evals/analyze-knowledge-work-html.ts`](../../evals/analyze-knowledge-work-html.ts) used by Model Performance; it is threaded into:

- Model Performance bar chart + cost-adjusted compound chart (and the partial-coverage table for everything below the bar)
- **Cost per role (Working / Thinking / Background)** stacked-bar sub-chart
- **Total agent cost per configuration (Working / Thinking / Background)** stacked-bar sub-chart
- Cost–Capability Pareto **scatter** (the details table below the scatter stays unfiltered so partial-coverage configs are still visible alongside their Pareto status)
- Per-Family Breakdown table
- Judge Variability **by-variant** chart and table (the by-fixture view is not gated on variant coverage)
- Dimension Scores radar + heatmap
- Completion & Failure Taxonomy **by-variant** table (by-engine is not filtered — engines aggregate across variants)
- Best-Model Failure Deep-Dive (the "winner" being dissected is picked from the full-coverage set; falls back to the canonical order when no variant has cleared the bar yet)

Sections whose job is specifically to show incomplete or historical state are intentionally NOT filtered: the partial-coverage table under Model Performance, Trends Over Time (historical line chart), the Showrunner A/B section (compares a `+SR` variant to its baseline regardless of canonical coverage), the Variant × Fixture Coverage Matrix, and the Appendices.

### The canonical corpus

The **canonical corpus** is the deterministic fixture set used as the apples-to-apples comparison universe for variant ranking in the Model Performance chart, Pareto frontier, family/engine rollups, trends-over-time, and all other cross-variant comparison views. In prose we also call this the **static-response** set — these fixtures use pre-scripted user messages and run in a single static turn by default, with no LLM-driven follow-up. Contrast with the **persona-overlay** set (the 9 `defaultDisabled: true` fixtures), which require `--personas` to opt-in to LLM-driven multi-turn follow-up simulation. Note: `persona_overlay` is also the schema literal used by `multiTurnSimulation.kind` inside individual fixture JSON, including some static-response defaults that *can* be replayed under persona-overlay simulation when `--personas` is set; the prose names categorise default behaviour, not the schema field.

**What it is:** a snapshot of `evals/fixtures/knowledge-work-reproducible/` filtered to `*.json` files (no underscore prefix), excluding fixtures with `defaultDisabled: true` or `calibration: true`. The count is dynamic (currently 30 static-response defaults; 9 persona-overlay fixtures sit behind `--personas`) — it reflects whatever is in the directory today, not a hard-coded constant.

**Where it lives:** `evals/fixtures/knowledge-work-reproducible/` scanned recursively for runner-shape JSON fixtures. Today the canonical set comes entirely from top-level `*.json` files because the subdirectories under that path (`corpus/`, `personal-workspace/`, etc.) contain non-runner-shape data, but the helper does not enforce top-level-only scanning. If a future fixture lands in a subdirectory and matches runner-shape, it will be included automatically. The `corpusHash` is computed top-level-only and so identifies the source directory rather than acting as a cryptographic checksum of the full recursive set — see the JSDoc on `CanonicalCorpus` in `evals/knowledge-work-canonical-corpus.ts`.

**How the analyzer resolves it:** at startup, [`loadCanonicalKnowledgeWorkFixtureIds()`](../../evals/knowledge-work-canonical-corpus.ts) in `evals/knowledge-work-canonical-corpus.ts` scans the directory, parses each JSON fixture, and returns a `CanonicalCorpus { fixtureIds: ReadonlySet<string>, sourceDir, corpusHash }`. The canonical set is injected into `aggregateData()` via `FilterSummary.canonicalCorpus` (optional for backward compatibility with locked test files).

**FilterSummary.canonicalCorpus fields** (signposted here, detailed in the planning doc):

| Field | Meaning |
|---|---|
| `sourceDir` | Directory the corpus was loaded from |
| `corpusHash` | SHA-256 of the corpus at load time |
| `fixtureCount` | Number of canonical fixtures (dynamic; not hard-coded 30) |
| `fixtureIds` | Sorted array of canonical fixture IDs |
| `missingFromDataset` | Canonical fixture IDs that no loaded result file touched |
| `nonCanonicalInDataset` | Non-canonical fixture IDs that appear in the loaded results |

The canonical set is **the one defined by the directory on disk at analyze time**, not by any historical manifest. This means analyzing older result files against a refreshed fixture directory surfaces drift automatically (see "What happens when the canonical corpus changes" below).

### Why some variants don't appear on the headline chart

Only variants whose **entire canonical fixture set** landed in a clean "completed + judged + non-degraded" state appear in the Model Performance bar chart and other compare-view surfaces. A variant that ran only organisation-suite fixtures, persona-overlay fixtures, or any non-canonical subset appears in the **partial-coverage table** below the chart instead — with `Clean`, `Run`, `Missing`, and `Non-canonical` columns plus a `Reason` column explaining the gap.

The `Reason` column handles edge cases:

- **"no canonical fixtures judged"** — the variant ran exclusively with `--suite knowledge-work-organisation` or only persona-overlay fixtures (via `--personas`); it has zero static-response canonical fixtures and cannot appear in the chart at all.
- **"canonical fixtures partially judged"** — some canonical fixtures cleanly completed but others were missing or errored.

The `--no-canonical-restriction` flag reverts to the pre-canonical-restriction behaviour (all loaded fixtures count as canonical); in bypass mode, tooltips use `"loaded"` instead of `"canonical"` and the Filter Summary shows an amber bypass banner.

See the [Full-coverage filter](#full-coverage-filter) section for the full list of which sections use the filter and which intentionally don't.

### What happens when the canonical corpus changes

**Historical-file drift:** When running the analyzer against old result files captured before a fixture was renamed, removed, or added, the `FilterSummary.canonicalCorpus` telemetry banner surfaces the gap:

- `missingFromDataset` — canonical fixtures that were in the directory when results were captured but aren't in today's directory (removed or renamed).
- `nonCanonicalInDataset` — fixture IDs in the historical results that aren't in today's canonical corpus (organisation fixtures, persona overlays, or fixtures removed before the current run).

The Filter Summary banner renders the **counts** of both arrays so the operator can distinguish "this variant didn't run this fixture" from "this fixture no longer exists in the canonical set". The full ID lists are available in the underlying `FilterSummary.canonicalCorpus` payload (consume the JSON sidecar or run the analyzer with stdout capture) when investigating specific drift.

**When the canonical corpus grows:** if the static-response corpus grows (for example by un-gating persona-overlay fixtures into the default set), variants that previously had full coverage may now appear in the partial-coverage table — this is intentional honesty. A variant that cleanly ran 30/30 canonical fixtures in April 2026 still has `fixtures_fully_complete_and_judged = 30`; if the corpus grew to 39 in May, the same variant now appears as `30/39 clean canonical` in the partial-coverage table. The chart-side metrics for variants that re-ran all 39 fixtures correctly reflect the larger denominator.

**When the canonical corpus shrinks:** a fixture removed from the directory drops out of `canonicalFixtureIds` immediately. Historical results that included that fixture now contribute to `nonCanonicalInDataset` and are excluded from compare-view aggregates. The per-fixture surfaces (Fixture Detail, Most-Failed Fixture) still show the fixture with an explicit "not in canonical set" badge — it remains visible, just not in the comparison chart.

**Recovery:** the `--no-canonical-restriction` flag is available as a temporary escape hatch to fall back to the pre-restriction behaviour for legacy comparisons. Prefer re-running the eval against the canonical corpus over relying on the bypass flag for ongoing analysis.

### Cost-by-role provenance

The two cost-by-role stacked-bar sub-charts (`modelCostByRoleChart` for per-run avg, `totalCostByRoleChart` for corpus total) read `metrics.efficiency.estimatedCostByRole` written by the runner. Two provenance markers may appear next to a variant label:

- **`(estimated)` total-cost badge** — set by Stage 4 of `docs/plans/260513_kw_eval_cost_and_analyzer_extensions.md` when the eval-LLM totalUsd was load-time estimated. Tracked via `_costEstimatedAtLoad` (or `evalLlmCosts.costProvenance === 'estimated'`) and shown across the variant-vs-variant total-cost surfaces (Model Performance label and table, Pareto frontier, family breakdown, etc.). Also applied to the **Stage 6a per-run-avg role-cost chart** (since that chart already inherits the broader cost-estimation set), but **NOT** to the new corpus-total role-cost chart (which only badges when the role split itself is estimated, since `_costEstimatedAtLoad` affects eval-LLM totals — orthogonal to the per-role agent costs the chart plots).
- **`(estimated)` role-attribution badge** — set by Stage 1 of `docs/plans/260514_kw_per_config_total_cost_chart.md` when the per-role split is a load-time single-tier backfill rather than runtime data. Tracked via `_costByRoleEstimatedAtLoad` and shown on both role-cost charts. A variant can carry one badge, the other, both, or neither — the two markers track distinct estimation paths.

The asymmetry is intentional: Stage 6a chart's badge condition is `estimatedCostVariants.has(variant) || costByRoleEstimatedVariants.has(variant)` (analyze-knowledge-work-html.ts line ~1363); new total-cost chart's badge condition is `costByRoleEstimatedVariants.has(variant)` only (line ~1455). The new chart visualizes summed per-role agent costs — only `_costByRoleEstimatedAtLoad` is semantically relevant to that data.

**Load-time role backfill rules** (`estimateHistoricalCostByRole` in [`evals/analyze-knowledge-work-data.ts`](../../evals/analyze-knowledge-work-data.ts)): only fires for **true single-tier configurations** where `normalizeModelId(working) === thinking === background` AND the per-result `actualModels` (or `metadata.actualModelsUsed` as fallback) has length 1 matching that tier. Multi-tier historical runs that lost their `perModelUsage` payload render as striped fallback bars instead. Skip codes (`skipped_not_single_tier`, `skipped_multi_model`, etc.) are logged once per kind per file for telemetry.

**Why agent-only, not total cost:** `estimatedCostByRole` is the **agent-API cost only**, not the total fixture cost (agent + eval-LLM). The new "Total agent cost per configuration" chart sums `estimatedCostUsd` (agent-only) consistently for both stacks and the striped fallback. Eval-LLM cost is tracked separately under Cost Telemetry — don't conflate the two when reading the chart.

**Total chart semantic (since 2026-05-14):** the corpus total sums collapsed (mean-of-repeats) per-fixture cells across the canonical fixture set. Reads as "estimated agent-API cost of one full corpus pass at this variant's quality level". For raw-spend totals across every repeat run, re-run the analyzer with `--no-collapse-repeats`.

## Cost Observability — when graphs show "n/a" instead of dollar values

The analyzer now treats cost visibility as a strict observability gate:

- `_costEstimatedAtLoad` means the eval-LLM total was load-time backfilled. This path is unreliable and **cost values are suppressed**.
- `_costByRoleEstimatedAtLoad` means the per-role split was inferred for a true single-tier run. This path is tautologically correct and **not suppressed** (it still uses the role-attribution `(estimated)` badge).

### Why `_costEstimatedAtLoad` is suppressed

Historical validation showed the load-time backfill can under-count by roughly **10×** versus native runner capture, and about **34%** of the Apr–May 2026 corpus used that path. The heuristic cannot recover cache-token reuse or full multi-tier routing behavior, so those dollar values are treated as non-observable for decision-making.

### Where suppression appears (14 report surfaces)

Anywhere a chart/table/callout would otherwise show a dollar value derived from suppressed data, the report renders `n/a` with a tooltip ("Observed cost unavailable; legacy backfill suppressed."):

1. Executive Summary — Best Value fallback state
2. Model Performance table — Avg Cost cell
3. Model Performance chart tooltip — Cost/run line
4. Cost-adjusted ranking chart
5. Cost overlay experiment charts
6. Cost-by-role per-run chart (amber-hatched suppression marker)
7. Pareto scatter plot points
8. Pareto details table (`cost-suppressed` + `n/a`)
9. Per-family breakdown — Mean Cost column
10. Per-family breakdown — Cost/Conf column
11. Partial-coverage table — Avg Cost column
12. Showrunner A/B panel — baseline/SR cost cells + multiplier
13. Cost Telemetry caption + invalid-count row (observed-only distributions)
14. Dataset Filters banner — Cost Observability row (global summary)

### Recovery and non-suppressed metrics

- **To recover cost visibility:** rerun the eval with native pricing capture enabled (current runner path). Do not use backfilled bundles for cost analysis.
- **What is not suppressed:** pass rates, completion rates, latencies/durations, rubric scores (including Compound), and other non-cost quality metrics.
- **Cross-reference:** see [Cost-by-role provenance](#cost-by-role-provenance) for the two-flag semantics, and [Report Sections](#report-sections) for where **Cost Telemetry** and **Eval Budget Proposal** appear in the generated report.

### Model Variants

The analyzer buckets by **model variant**, not by working model. A variant is the full configuration of a run — (Working, Thinking, Background) tier triplet plus any A/B-style overlays (Showrunner, context-management-disabled, …). So `opus-4-7` and `opus-4-7 +SR` appear as distinct rows in every comparison view.

**Why:** the previous behaviour keyed only on the working model, so a showrunner A/B experiment or a thinking-tier override would silently fold into the same bucket as the baseline — making the A/B signal invisible. Seen from the other side: running the same working model twice with different overlays is not a "repeat run" — it's a different experiment and must not be averaged together.

**Display label rules:**

Variant labels **always** spell out the full Working · T · B triplet plus any active overlays, even for "baseline" runs (Thinking == Working, default Background). There is no implicit collapse: every label tells the reader exactly which models served which tier.

| Case | Example label |
|------|---------------|
| Baseline | `claude-opus-4-7 · T:opus-4-7 · B:haiku-4-5` |
| Showrunner overlay | `claude-opus-4-7 · T:opus-4-7 · B:haiku-4-5 +SR` |
| Non-default Thinking tier | `claude-opus-4-7 · T:sonnet-4-7 · B:haiku-4-5` |
| Non-default Background tier | `claude-opus-4-7 · T:opus-4-7 · B:5.4-nano` |
| Multiple overlays | `claude-opus-4-7 · T:opus-4-7 · B:5.4-nano +SR +NoCtx` |

The Working slot keeps its family prefix (`claude-`, `gpt-`, …) so the reader can tell at a glance which family the row belongs to; the Thinking/Background slots are shortened (prefix stripped, trailing date stamps trimmed) so chart legends stay readable.

**Why always show the triplet (since 2026-05):** a previous "explicit but equal counts as baseline" rule meant `claude-sonnet-4-6 +SR` (haiku background) and `claude-sonnet-4-6 +B:sonnet-4-6` (sonnet background) looked superficially similar — the former rendering as just `claude-sonnet-4-6 +SR`. Readers comparing the two missed that the background tier was the real variable changing, not the overlay. Spelling out the full triplet removes that apples-to-oranges trap.

The full triplet and A/B state are also rendered in a **Configuration** column on the Model Performance and Cost–Capability Frontier tables, and in the Full Run Details appendix, so the long-form description backs up the inline label.

**A/B flag registry:** lives in `AB_FLAG_REGISTRY` in [`evals/analyze-knowledge-work-aggregate.ts`](../../evals/analyze-knowledge-work-aggregate.ts). Add a new A/B knob to the registry and the variant key, display label, Configuration column, and Dataset Filters banner all pick it up — no other wiring required.

**Mixed-configs warning:** when a working model has more than one variant in the filtered dataset (e.g. a baseline AND a `+T:opus-4-6` run), the Dataset Filters banner calls it out explicitly. This prevents a future "working-model rollup" view from silently blending A/B legs.

### Coverage Warning

A leading **⚠** in front of a variant label means the variant did not run every fixture in the filtered dataset — its headline metrics (pass rate, avg score, evidence%, …) are computed over a smaller fixture set than its peers, so it should not be compared apples-to-apples to fully-covered variants.

- **How it's computed:** the analyzer takes the union of all fixture IDs in the filtered dataset and, for each variant, sets `incomplete_coverage = true` when `fixtures_tested < |fixture-union|`. The number of missing fixtures is on `ModelStats.missing_fixture_count` for tooltips.
- **Where it appears:** Model Performance chart x-axis labels and table, Pareto scatter point labels and frontier table, Per-Family breakdown table, Dimension heatmap headers and radar legend, Completion table, Trends legend, Coverage Matrix column headers, Best-Model Deep-Dive heading, Showrunner A/B headings.
- **How to fix the warning:** run the missing fixtures for that variant, or filter the report down to a date range where coverage is even. The Coverage Matrix at the bottom of the report shows exactly which (variant, fixture) cells are unfilled.

### Canonical Model Ordering

Wherever the report compares or lists models (model bar chart, completion tables, dimension heatmap columns, trend legend, Pareto table), every variant is rendered in the **same order**: highest **Compound score** first, so the strongest configuration sits leftmost in charts and topmost in tables.

**Compound score is the primary "best performance" metric** used throughout the analysis:

```
compound_score = avg_score × (effective_pass_rate / 100)
```

Range 0-5 (same scale as `avg_score`, easy to read). It combines the two existing quality signals — magnitude (avg score) and reliability (pass rate) — into a single ranking number. The product weighting means:

- A model averaging 4.5/5 that only passes 30% of fixtures has a compound of **1.35** — correctly downranked despite the high raw score, because the rubric threshold is missed two-thirds of the time.
- A model averaging 3.5/5 that passes 90% of fixtures has a compound of **3.15** — correctly outranks the previous one despite a lower raw score, because it actually delivers passing work most of the time.
- A model averaging 4.0/5 at 100% pass rate has a compound of **4.0** — the headline number reads as "4.0 worth of quality per fixture on average, accounting for misses".

Uses `effective_pass_rate` (counts crashes/unjudged as misses) rather than nominal, matching `primaryPassRate()` everywhere else in the analyzer.

The compound score is surfaced as a dedicated **Compound** column on the Model Performance detail table (initial sort) and the partial-coverage table, with a tooltip explaining the formula. Every aggregate-level chart on the page plots compound on its quality axis so the same ranking story runs through the whole report:

- **Model Performance chart** — Compound line (Y2, orange) overlays Pass Rate bars (Y, blue). Pass Rate is also one of the two compound inputs, so seeing them side-by-side tells you whether a low compound is driven by quality or reliability. The per-fixture amber dots stay on raw avg-score (per-fixture quality is a different question from aggregate ranking).
- **Pareto frontier** — Y-axis is mean compound (0-5). A high-quality-but-unreliable variant that used to anchor the frontier on raw avg-score may now sit below a steadier mid-quality competitor — that's the intended correction.
- **Trends Over Time** (both full-history and single-point default) — Y-axis is compound. A variant whose pass rate improves from 50% to 80% while avg-score stays flat now shows a real upward trend; under the old avg-score-only view it looked flat.
- **Cost-adjusted compound** — additive log cost penalty in compound-point units (`compound − λ·log₂(cost_mult)`). Replaced the earlier sqrt/cube-root multiplicative damping. Full rationale and examples in [Cost-adjusted compound](#cost-adjusted-compound-additive-log-penalty).

Tables still expose Avg Score and Pass Rate as separate columns for diagnosis; the migration is about chart Y-axes, not removal of the underlying inputs.

Sort keys, in priority order:

1. **Compound score** — descending. Primary "best performance" metric.
2. **Observed avg judge score** — descending. Quality-only tiebreak.
3. **Observed effective pass rate** — descending. Reliability tiebreak.
4. **Catalog output price ($/MTok)** — ascending (from `src/shared/data/modelCatalog.ts` via `getModelPricing()`). At equal quality and reliability, cheaper is better; nulls sort last.
5. **Catalog input price ($/MTok)** — ascending. Secondary price tiebreak.
6. **Observed avg cost per run** — ascending. Fallback for unknown/local models with no catalog pricing.
7. **Earliest-seen timestamp** — older first. Breaks absolute ties.
8. **Model name (alphabetical)** — final deterministic fallback.

**Why compound (since 2026-05-14):** Avg Score alone was the previous primary key; it ignored reliability and overrated variants that scored well on the fixtures they passed but rarely cleared the rubric threshold. Pass rate alone ignored quality magnitude — a model that barely cleared the threshold every time looked identical to one that nailed every fixture. The product weights both equally on the 0-5 scale and is simple enough to read off without a calculator. (Earlier 2026-05 history: order was switched from "cheap → expensive" to "Avg Score first" so the best performer sits where the reader's eye lands, with the cost-comparison story handled separately in the Cost–Capability Frontier section.)

Every chart and table downstream consumes the SAME canonical ordered list (`canonical_model_order`), so a reader can scan top-to-bottom and left-to-right across the report without re-mapping rows.

**Note on chart consistency (since 2026-05-14):** All aggregate-level chart Y-axes now plot Compound (not raw Avg Score). The earlier carve-out for the Pareto frontier — "Y stays on raw Avg Score because cost-vs-quality is a per-fixture question" — was reversed after a deeper review: the Pareto frontier's purpose is to answer "what's the cheapest variant for a given level of *useful* performance", and useful performance has to mean shipped-quality (quality × reliability), not best-case fixture quality. Folding pass rate into the Y-axis is exactly the question being asked, not a contamination of it. A variant that scores 4.5 on its passing fixtures but only passes 30% of the time isn't actually delivering 4.5 worth of value per dollar — it's delivering ~1.35.

Collapsible tables hide long diagnostic content (Fixture Detail, Evidence detail, Tool Usage, Pareto frontier table, Appendices) by default while keeping charts and headline summaries visible.

### Cost-adjusted compound (additive log penalty)

The single-number cost-vs-capability ranking metric. Formula:

```
cost_mult              = avg_cost / cheapest_avg_cost      (≥ 1; cheapest variant = 1)
cost_penalty           = λ · log₂(cost_mult)               (compound points, ≥ 0)
cost_adjusted_compound = compound_score − cost_penalty     (compound points, can dip < 0)

λ = 0.3 compound points per doubling of cost      (COST_PENALTY_LAMBDA in analyze-knowledge-work-html.ts)
```

**Intuition.** Express the trade-off in the same units as the metric. Each 2× price increase deducts λ compound points. Reading off the penalty table the analyzer renders:

| Cost multiple | Penalty |
|---|---|
| 1× (cheapest)  | 0.00 |
| 2× | 0.30 |
| 4× | 0.60 |
| 10× | 1.00 |
| 30× | 1.47 |
| 100× | 1.99 |

So a 10× more expensive model needs to deliver ~1.00 more compound points to break even on this metric. On the 0-5 compound scale that's a substantial quality jump (roughly the gap between "passes 60% of fixtures at 3.3 quality" and "passes 100% at 4.0 quality"), reflecting the "your model has to clear a category, not just nudge ahead, to justify the spend" stance. Capability still dominates at small cost spreads; cost is a transparent, tunable secondary signal.

**Why this replaced sqrt / cube-root damping (since 2026-05-14).** The earlier ranking number was `compound ÷ cost_mult^EXP` with EXP = 0.5 (sqrt) and EXP = 1/3 (cube root). The multiplicative form has a structural pathology when cost spreads exceed ~4×: the cheapest variant always gets denominator = 1, so any other variant has to overcome the damping on raw compound magnitude alone — and compound is bounded at 5, so it often can't. Worked example with our real-world spread:

| Variant | Compound | cost_mult | / √cost | / cost^(1/3) | compound − 0.3·log₂(cost) |
|---|---|---|---|---|---|
| cheap-and-mediocre | 2.0 | 1 | **2.00** | **2.00** | **2.00** |
| expensive-and-excellent | 4.0 | 10 | 1.27 | 1.86 | **3.00** ← wins |

Under sqrt and cube-root damping cheap-and-mediocre wins the chart even though the expensive model delivers 2× the combined quality+reliability. Under the additive log form the expensive model still wins, by 1.00 compound point, which is the answer we actually want. Full discussion with GPT input lives in the conversation export at `Shared drives/Product/droid-conversations/rebel-app/2026/05/` (search for "cost-weighting").

**Tuning λ.** λ = 0.3 was picked to make a 10× price increase cost ~1.0 compound point — a "substantial quality jump" hurdle on the 0-5 compound scale (the gap between passing 60% of fixtures at 3.3 quality and passing 100% at 4.0 quality). Higher λ → cost matters more; λ = 0 collapses to ranking by compound alone. Reasonable values are roughly 0.1–0.4 — anything above ~0.5 effectively bans variants past 3-4× cost regardless of quality, and anything below ~0.1 makes cost decorative. **λ history:** the first version (2026-05-14) landed at 0.12 so that 10× cost = ~0.4 penalty; bumped to 0.3 on 2026-05-15 after the real-world chart kept the most-expensive variants on top even when 5× cheaper siblings delivered ~90% of their compound. Update `COST_PENALTY_LAMBDA` in `analyze-knowledge-work-html.ts` and re-run.

**Anti-recommendations.** Things that look reasonable but go wrong:
- `compound / cost` — pure ratio, dominated by cheapest.
- `compound / log(1 + cost_mult)` — awkward normalization; cheapest gets inflated relative to others.
- `compound^k / cost` with k ≥ 3 — to make 4.0 @ 10× beat 2.0 @ 1× you need k > 3.32; that exaggerates small differences at the top of the 0-5 scale where judge noise dominates.

For Pareto frontier visualization (which doesn't force a single weighting), see [Cost–Capability Frontier](#report-sections).

## Interpreting Results

**Healthy signs:**
- Overall pass rate ≥ 60%
- All dimensions scoring ≥ 3.0 on average (current rubric: `discovery_coverage`, `grounded_accuracy`, `deliverable_quality`)
- Evidence hit rate ≥ 50% across most checks (telemetry — not gated)
- Agreement ratio ≥ 70% (judges largely agree)
- Composite score ≥ 70 on average

**Red flags:**
- Any fixture with 0% pass rate across multiple runs — may indicate a broken fixture or fundamental agent limitation
- Dimension score < 2.5 — investigate system prompts for that capability
- Evidence checks with < 30% hit rate — either the check is unrealistic or the agent has a blind spot
- Large gap between engine pass rates — engine-specific bugs
- Constraint failures — indicates safety-critical issues (fabrication, privacy violations)

**Color coding in tables:**
- 🟢 Green: score ≥ 3.0 or pass rate ≥ 60%
- 🟡 Amber: score 2.5–3.0 or pass rate 40–60%
- 🔴 Red: score < 2.5 or pass rate < 40%

## Dataset Filters

The analyzer applies three layers of dataset hygiene *before* aggregation, and surfaces what happened in a "Dataset Filters" banner at the top of the HTML report. Knowing what was excluded is as important as knowing what passed.

### 0. Errored-fixture classification (NEW 2026-04-28)

When a fixture fails (`completed: false`), the runner now writes an
`errorCategory` field — one of `rate_limit`, `watchdog_stall`,
`mcp_tool_arg_validation`, `mcp_server_error`, `auth`, or `unknown`. The
analyzer surfaces a per-category breakdown in `summary.errored_total`
and `summary.errored_by_category`, so you can read off "10 errored
fixtures: 6 rate_limit, 3 watchdog_stall, 1 mcp_tool_arg_validation"
without spelunking into per-fixture event logs. Older v1.2 result files
without the field roll into the `unknown` bucket. The field is set by
`classifyErrorCategory()` in `evals/knowledge-work.ts` (priority order:
rate_limit > watchdog > auth > mcp_arg > mcp_server > unknown).

Per-fixture results also carry `retryCount` and `retryReasons` (added
in Stage 4 of the same plan) when the runner retried for transient
errors before settling on the final verdict.

### 1. Version gating (major-version match)

The knowledge-work runner writes an `analysisSchemaVersion` (`major.minor`) into every result file. Version gating is one part of corpus identity; see [EVAL_CORPUS_IDENTITY.md](EVAL_CORPUS_IDENTITY.md#analysisschemaversion) for the canonical major/minor bump policy and comparability rules.

- **Default behaviour:** runs whose major differs from the current major are excluded. This prevents silently mixing incomparable data after a rubric change, threshold tweak, or judge-panel shakeup.
- **Grandfather clause:** files with no `analysisSchemaVersion` field (legacy runs) are treated as `1.0`.
- **Optional tighten-up:** `--strict-version` keeps only exact-version matches (same `major.minor`) after major-version gating.
- **Deprecated aliases:** `--include-prior-versions` and `--include-all-versions` are retained as backward-compatible no-ops. They no longer bypass major-version gating.

### 2. `IGNORED_MODELS` list

Defined in [`evals/analyze-knowledge-work-aggregate.ts`](../../evals/analyze-knowledge-work-aggregate.ts). Models in this list are dropped from aggregation by default because their coverage is too sparse or their test history is no longer representative.

- Currently excluded: `claude-opus-4-6` (partial fixture coverage, not being backfilled).
- **Opt out:** `--include-ignored-models` when you genuinely want to see them.

### 3. Repeat-run collapsing (latest-wins)

Multiple runs of the same `(model, fixture)` pair are collapsed into a single synthetic "cell". **The default policy is latest-wins, not averaging:** every merged field — `consensus.meanScore`, `dimensionScores`, `finalVerdict`, `completed`, `metrics.efficiency.estimatedCostUsd`, `durationMs`, and `degradedVerdict` — is taken verbatim from the most-recent run (recency key: `runMetadata.timestamp` → filename-derived date → deterministic source-file tie-break). Older runs surface in `_priorRunsSummary` (count, date window, score range) for context only — they do **not** influence the cell's headline fields. The pinned regression test in [`analyze-knowledge-work-aggregate.test.ts`](../../evals/__tests__/analyze-knowledge-work-aggregate.test.ts) is the authoritative contract; see also `mergeCellRuns` JSDoc in [`evals/analyze-knowledge-work-aggregate.ts`](../../evals/analyze-knowledge-work-aggregate.ts) and [`docs-private/postmortems/260514_eval_collapse_degraded_propagation.md`](../../docs-private/postmortems/260514_eval_collapse_degraded_propagation.md) § Stage A.

- **Why latest-wins (not averaging):** otherwise a fixture retried 10× dominates per-model aggregates that should give each fixture equal weight, and an old infrastructure-degraded run would silently drag down a clean rerun.
- **Opt out:** `--no-collapse-repeats` for the raw-per-row view.

### `--prefer-rerun-pass` policy

The default `latest-wins` policy has one operator-pain mode: when an operator reruns a fixture standalone after a parent-run failure, then accidentally introduces a regression in *another* rerun, the latest fail dominates and the earlier successful recovery is hidden. `--prefer-rerun-pass` (opt-in) is the explicit fail→pass-substitution policy for the recovery flow.

**Pass criterion (mechanical, all four required):**

```
result.completed === true
&& result.finalVerdict === 'pass'
&& Number.isFinite(result.consensus?.meanScore)
&& !isDegradedResult(result)
```

A `finalVerdict === 'pass'` without a finite consensus mean is a degenerate / unjudged result and is **not** treated as a substitution candidate. A `degradedVerdict: true` run is **not** a pass even if `finalVerdict === 'pass'`. This prevents an unjudged or infrastructure-degraded "pass" from masking a real downstream fail.

**Precedence table:**

| Scenario | Default `latest-wins` | `--prefer-rerun-pass` |
|---|---|---|
| Latest = pass | pass (latest) | pass (latest) — same |
| Latest = fail, earlier pass exists | fail (latest) | latest passing prior wins |
| Latest = fail, no earlier pass | fail (latest) | fail (latest) — no false attestation |

**Audit trail (never silent suppression):**

When the policy substitutes, the suppressed latest-fail's recency label and verdict are preserved in `_priorRunsSummary.suppressedLatestFail`. The analyzer also emits a single end-of-collapse summary log:

```
[rerun-cell] --prefer-rerun-pass enabled: substituted N latest-fail(s) with earlier passing prior(s) across M multi-run cell(s). Suppressed latest-fails are visible in _priorRunsSummary.suppressedLatestFail.
```

**Recency-key requirement:** the substitution only fires when at least one run in the cell has a real recency key (`_runTimestampMs` or `_fileDate`). Without recency keys, the policy degrades to latest-wins; source-file alphabetic ordering is too arbitrary to drive a verdict substitution.

**Cost convention:** the merged cell carries the *chosen* run's `estimatedCostUsd` — not a sum, not a max. Cumulative spend across reruns belongs in a separate cost-tracking surface; this field is a per-cell cost-of-attestation reading.

**When to enable:** post-incident debugging of a specific cell where you know a recovery rerun passed but a follow-up rerun regressed for an unrelated reason. Not for routine analyses — strict latest-wins is the right default because it makes regressions visible.

Plan: [`docs/plans/260518_kw_eval_canonical_drift_and_rerun_cells.md`](../plans/260518_kw_eval_canonical_drift_and_rerun_cells.md) § Stage C.

## Known Limitations & Open Design Questions

- **Unequal fixture coverage across models.** Headline model metrics still macro-average over the cells that exist, so a model tested on a different fixture mix can look better/worse than it really is. The report does not yet render per-model coverage, matched/common-subset scores, or confidence intervals. Open question: do we want a fair-comparison view against a chosen baseline model, a coverage column, both, or neither?
- **Rubric-schema mix within a single major.** Major-version gating is intentionally coarse. Reports can still contain a mix of 3-dim, 5-dim, and 10-dim rubric runs inside the same major if both were in flight during the window. Dimension sections render per-schema, but summary tables mix them. Open question: should we also version-gate by rubric schema, or keep the current behaviour of showing everything and letting dimension sections separate out?
- **No per-cell confidence bounds.** Collapsed cells show the mean but not variance or run count in the main tables yet. A single run and a 10-run average look identical in most views. Open question: do we surface `N` and a standard-error column, or fold it into tooltips?

Until these are resolved, treat cross-model comparisons as directional rather than authoritative, especially when coverage looks uneven in the Fixture Detail table.

## Running a backfill

Use the backfill orchestrator at [`evals/backfill-knowledge-work.ts`](../../evals/backfill-knowledge-work.ts) when you need to fill missing fixture cells for specific variants. Start from the example manifest [`evals/backfill-knowledge-work-manifest.example.json`](../../evals/backfill-knowledge-work-manifest.example.json), then run `npm run eval:backfill:knowledge-work -- --manifest evals/backfill-knowledge-work-manifest.example.json --dry-run` to preview the plan. Drop `--dry-run` and add `--execute` when you're ready to launch runs.

## Keeping Analysis Current

Re-run the analysis after each eval batch to track trends. The `--since` parameter lets you focus on recent results while `--until` can create point-in-time snapshots. Reports accumulate in the output directory with timestamped filenames — old reports are never overwritten.

For CI integration, run with explicit `--results-dir` and `--output-dir` to control paths.
