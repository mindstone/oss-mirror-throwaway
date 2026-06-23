---
description: "Reusable knowledge-work eval analysis protocol — scripts, HTML report structure, metrics, trends, recommendation scoring"
last_updated: "2026-05-12"
---

# Chief Optimiser Analysis — Reusable Analysis Protocol

How to run, interpret, and update the knowledge-work eval longitudinal analysis. This is the **analysis companion** to [CHIEF_OPTIMISER](./CHIEF_OPTIMISER.md) (the optimization workflow).

---

## See Also

- [CHIEF_OPTIMISER](./CHIEF_OPTIMISER.md) — the optimization workflow that uses this analysis
- [WRITING_EVALS](./WRITING_EVALS.md) — eval harness overview, available suites, how to run
- [CHIEF_PATHOLOGIST_ANALYSIS](../../coding-agent-instructions/workflows/CHIEF_PATHOLOGIST_ANALYSIS.md) — companion longitudinal analysis for bugs
- [CHIEF_ENGINEER_ANALYSIS](../../coding-agent-instructions/workflows/CHIEF_ENGINEER_ANALYSIS.md) — reviewer/implementer performance analysis (similar dual-mode pattern)
- `evals/knowledge-work.ts` — the knowledge-work eval harness
- `evals/knowledge-work-scoring.ts` — scoring dimensions, weights, pass thresholds
- `evals/fixtures/knowledge-work-reproducible/` — reproducible fixtures with hermetic corpus
- `coding-agent-instructions/scripts/analyze_kw_evals.py` — data extraction and analysis script
- `coding-agent-instructions/scripts/generate_kw_eval_html.py` — HTML report generator with Chart.js

---

## Quick Start

### Generate Fresh Analysis

```bash
# Step 1: Extract and analyze all results
python3 coding-agent-instructions/scripts/analyze_kw_evals.py

# Step 2: Generate HTML report (saves to Google Drive)
python3 coding-agent-instructions/scripts/generate_kw_eval_html.py
```

The HTML report is saved to:
```
Google Drive → Shared drives/Product/evals/analysis/YYMMDD_HHMM_kw_eval_analysis.html
```

### Run with Subagent Analysis

For deeper analysis with multi-model perspectives, run the full CHIEF_OPTIMISER workflow (Phase 0-7). The analysis script provides the data; the subagent prompts in CHIEF_OPTIMISER.md provide the interpretive depth.

---

## HTML Report Philosophy

The generated HTML report is the primary output. It should be **readable as a self-contained briefing** — someone opening it should understand what's working, what's broken, and what to do about it without needing to read this doc or run scripts.

### Report Structure (top to bottom)

The report follows a **narrative arc**: situation → diagnosis → action.

1. **Executive Summary** (the headline) — 5-8 bullet points answering: What's the overall state? What's the single biggest problem? What are the top 3 things to do? Written in plain language, not metric-speak. This is the only section many readers will read.

2. **The Execution Gap** (the big story) — The dominant pattern right now is quality-pass-exec-fail: the agent produces good output but fails brittle evidence checks. This section leads with the divergence doughnut chart and the "execution gap" metric (quality pass rate minus overall pass rate). It names the worst-offending fixtures and explains *why* they fail (tool ordering patterns, exact file path expectations, regex wording sensitivity). This is the most actionable chart because it tells you whether to fix the agent or fix the evals.

3. **Prioritized Recommendations** — A scored table of improvements ordered by `Value × Ease × Confidence`. Each recommendation is tagged with its category (Fixture, Prompt, Scoring, Agent, Routing). The table makes it clear what to work on next.

4. **Where the Agent Struggles** (family and fixture breakdown) — Family performance bar chart + fixture scorecard. Emphasize the *interpretation*: which families cluster together, what the common failure mode is within each cluster, and which fixtures are closest to flipping from fail to pass ("almost passing" table). The narrative should call out patterns like "cross-channel fixtures score 3.9 avg but 0% pass because the execution contract requires reading specific file paths the agent doesn't discover."

5. **Dimension Analysis** (what specifically is weak) — Discovery coverage as the bottleneck, evidence correlation, weakest-dimension doughnut. The narrative frames this as: "The agent can synthesize well — the problem is finding the right data to synthesize."

6. **Trends and Trajectory** — Time series chart. Interpret it: is the trend positive? What caused dips? How does recent performance compare to the prior regime? This section is less actionable than the above but provides context for whether things are getting better or worse.

7. **Supporting Detail** (collapsible) — Model comparison, cost effectiveness, run-to-run variance, showrunner A/B, data quality breakdown, methodology caveats, glossary. These are important but secondary — they support the narrative rather than driving it. Keep behind `<details>` to reduce visual noise for casual readers.

### Narrative Interpretation Guidelines

Every chart and table in the report must have an **interpretation paragraph** immediately below it. The interpretation should:

- **Say what the data means**, not just what it shows. "The execution contract is failing 63% of quality-passing runs" not "63% of runs are in the quality-pass-exec-fail category."
- **Name the root cause** when known. "This happens because the evidence check for `multi-turn-refine-analysis-02` requires tool calls in a specific order (search → read → synthesize), but the agent sometimes reads before searching."
- **State what to do about it.** "Marking the tool-ordering check as `critical: false` would flip this fixture from 0% to ~80% pass." If the action isn't clear, say so: "Root cause unclear — needs investigation with specific failing runs."
- **Flag when data is insufficient.** "Only 4 opus runs — this ranking is directional, not definitive."

### Chart Priority (dynamic)

The report generator should use these heuristics to decide what's most prominent:

- If the **execution gap** (quality pass rate minus overall pass rate) is > 20pp, lead with the divergence chart and execution gap callout. This means the eval contracts are the bottleneck, not the agent.
- If the **execution gap** is < 10pp but **pass rate** is below 40%, lead with the dimension analysis and family breakdown. This means the agent genuinely needs improvement.
- If **pass rate** is above 60%, lead with trends and cost efficiency. The system is working; optimize for cost and trajectory.
- If **infra error rate** is above 15%, lead with a data quality warning. The numbers can't be trusted.

When the data doesn't clearly match one heuristic, default to the execution gap chart — it's the most common actionable story.

### Recommendation Scoring

Each recommendation in the prioritized table is scored on three axes (1-5 each):

| Axis | What it means |
|------|---------------|
| **Value (V)** | How many fixtures/families would improve if this were implemented? |
| **Ease (E)** | How hard is the implementation? 5 = config change, 1 = major architecture work |
| **Confidence (C)** | How certain is the root cause? 5 = proven by data, 1 = speculative |

Priority score = V × E × C (max 125). Sort descending.

Each recommendation must be tagged with one of: `Fixture` (eval contract fix), `Prompt` (system prompt change), `Scoring` (judge/scoring methodology), `Agent` (agent runtime behavior), `Routing` (task routing/dispatch).

---

## Analysis Architecture

### Data Pipeline

```
Google Drive results/        →  analyze_kw_evals.py     →  kw_eval_analysis.json
  (195+ JSON result files)       (extraction + stats)        (structured metrics)
                                                          →  kw_eval_records.json
                                                              (flat per-run records)
                                                                    ↓
                                                          generate_kw_eval_html.py
                                                              (Chart.js report)
                                                                    ↓
                                                          evals/analysis/
                                                              (Google Drive HTML)
```

### Data Sources

| Source | Location | Format |
|--------|----------|--------|
| Eval results (canonical) | `~/Library/CloudStorage/GoogleDrive-.../Shared drives/Product/evals/results/knowledge-work/` | Per-fixture JSON + markdown |
| Fixtures | `evals/fixtures/knowledge-work-reproducible/` | JSON with prompt, corpus, evidence |
| Scoring code | `evals/knowledge-work-scoring.ts` | TypeScript (dimensions, weights, thresholds) |
| Analysis output | `tmp/agent-tests/kw_eval_analysis.json` | Structured metrics JSON (gitignored, regenerated on each run) |
| HTML reports | `Google Drive → Shared drives/Product/evals/analysis/` | Self-contained HTML with Chart.js |

### Result File Naming Convention

```
YYMMDD_HHMMSS_model_engine_fixture.json
```

Examples:
- `260409_185011_sonnet-4-6_rc_cross-channel-meridian-qbr-prep-01.json` — single fixture
- `260409_001001_sonnet-4-6_rc_all.json` — batch run (all fixtures)
- `260402_140231_run01_working-claude-sonnet-4-6_thinking-claude-opus-4-6_background-claude-haiku-4-5_sdk.json` — multi-model dispatch

---

## Key Metrics

### The Single Ranking Number

**Value Score** — combines quality, reliability, and cost:

```
value_score = 100 × (0.8 × pass_rate + 0.2 × normalized_score) / (1 + ln(1 + cost/median_cost))
```

- `pass_rate`: Lower 95% confidence bound of effective pass rate (penalizes small samples)
- `normalized_score`: `(avg_score - 1) / 4` mapped to 0-1
- `cost/median_cost`: Log-scaled cost penalty

### Dashboard Metrics (compute after every run)

| # | Metric | Alert Threshold | Purpose |
|---|--------|----------------|---------|
| 1 | **Pass Rate** (with CI) | < 40% or drop > 10pp | Overall health |
| 2 | **Execution Gap** | Quality pass - Overall pass > 20pp | Execution contract calibration |
| 3 | **Catastrophic Rate** | Score < 1.5 in > 5% of runs | Infrastructure problems |
| 4 | **Cost Efficiency** | Score/$ drops > 20% | Model pricing changes |
| 5 | **Fixture Instability** | Variance > 2.0 on any fixture | Flaky fixtures or agent |
| 6 | **Evidence Hit Rate** | Overall < 70% | Discovery problems |
| 7 | **Data Quality Rate** | Genuine < 80% of total | Eval harness reliability |
| 8 | **Infra Error Rate** | > 10% of runs | Eval infra needs fixing |

---

## Run Classification & Filtering

Every run is classified before analysis. Only `genuine` runs are included in performance metrics.

### Classification Taxonomy

| Category | Classes | Description | Action |
|----------|---------|-------------|--------|
| **Genuine** | `genuine` | Clean agent result, completed normally | Include in analysis |
| **Infrastructure** | `infra_semantic_index`, `infra_corpus_copy`, `infra_prompt_file`, `infra_workspace`, `infra_code_bug`, `infra_incident_apr56` | Eval harness bugs (workspace copy failed, indexing failed, missing files, known incident window) | Exclude |
| **Network/API** | `network_timeout`, `network_connection`, `network_auth` | API timeouts, connection errors, auth failures | Exclude |
| **Suspect** | `suspect_no_tools`, `suspect_no_evidence` | Agent completed but with suspicious patterns (zero tool calls with low score, zero evidence) | Exclude |
| **Other** | `agent_generic_error`, `other_error`, `incomplete_unknown` | Generic errors, unclassified failures | Exclude |

### Why This Matters

In the initial analysis (Apr 9, 2026), only **68% of all runs were genuine** -- 32% were infrastructure noise. Without classification, pass rates and model rankings are significantly distorted:
- Infrastructure errors artificially lower pass rates
- Different models/dates may have different infrastructure failure rates
- Mixing genuine failures with infra errors makes root cause analysis impossible

---

## Regime-Based Segmentation

The codebase evolves rapidly. Results from different periods are **not directly comparable** due to scoring changes, fixture additions, evidence contract tightening, and infrastructure incidents.

### Defined Regimes

| Regime | Dates | Description | Comparability |
|--------|-------|-------------|---------------|
| `pre_overhaul` | Mar 29 | Before scoring overhaul | Historical only |
| `post_overhaul` | Mar 30 - Apr 4 | Post-overhaul, pre-incident. Mixed models (sonnet, opus, haiku) | Historical; model mix inflates pass rate |
| `incident` | Apr 5-6 | Infrastructure incident (schema gate timeouts, worker contamination) | Exclude from trending |
| `current` | Apr 7+ | Current regime (post-fix, current fixtures, current evidence contract) | **Primary analysis window** |

### Regime Rules

1. **Headline metrics** use only `current` regime genuine runs
2. **Trend charts** show all regimes but with regime annotations
3. **Model comparisons** require matched-fixture analysis within the same regime
4. **Cross-regime comparisons** are explicitly labeled "not directly comparable"
5. The `incident` regime data is annotated but excluded from pass-rate trending

### Recency Guidance (from GPT-5.5 analysis)

- **Default headline**: current regime (expanding window from Apr 7)
- **Once volume is sufficient** (150+ runs): switch to rolling 7 days or 150 runs, whichever is larger
- **Value Score**: compute only on current regime data, never blended with historical
- **Trend monitoring**: EWMA (exponential weighted moving average) on genuine current-regime runs

### Dimension Weights (current)

| Dimension | Weight | Purpose |
|-----------|--------|---------|
| `discovery_coverage` | 35% | Did the agent find all relevant sources? |
| `grounded_accuracy` | 35% | Are claims supported by discovered data? |
| `deliverable_quality` | 30% | Is the output professional and actionable? |

### Verdict Logic

```
pass     = quality score ≥ 3.0 AND execution contract passes
partial  = one passes, one fails
fail     = both fail (or quality forced-fail due to accuracy floor)
```

---

## Subagent Analysis Protocol

When running the full analysis with subagents, use 4 parallel researchers:

| Role | Droid | Focus |
|------|-------|-------|
| Quality & Scoring | `researcher-gpt5.5-high` | Deliverable quality, scoring system, composite metrics |
| Trends & Progress | `researcher-gemini3.1-pro` | Temporal patterns, commit impact, A/B tests |
| Devil's Advocate | `reviewer-gpt5.3-codex` | Challenge assumptions, find methodology flaws |
| Cross-Fixture | `worker` | Evidence patterns, family clustering, correlation analysis |

### Prompt Templates

Each subagent receives:
1. **Data summary** with key metrics (paste from `analyze_kw_evals.py` output)
2. **File paths** to analysis JSON, records JSON, fixtures, and scoring code
3. **Specific analysis tasks** (5-7 questions per subagent)
4. **Return format** request (structured findings with data references)

See CHIEF_OPTIMISER.md Phase 4 for the canonical prompt templates.

---

## Known Patterns & Historical Findings

### Execution Contract Brittleness Is the Dominant Bottleneck (confirmed Apr 9-10, 86 runs)

The single biggest issue suppressing pass rates is not agent quality — it's execution contract brittleness. In the Apr 9-10 window:
- **86% quality pass rate** vs **31% execution pass rate** — a 55pp execution gap
- **63% of all genuine runs** are quality-pass-exec-fail ("partial" verdict)
- Only **6% are genuine failures** (both quality and execution fail)

Concrete examples of brittle checks:
- `multi-turn-refine-analysis-02`: 5 runs, avg score 4.04, 0% exec pass. The single failing check is `t1-e6` ("Searches before synthesizing") which requires a specific tool call ordering pattern via regex. The agent produces excellent output but calls tools in a slightly different order.
- `cross-channel-board-strategy-brief-02`: 3 runs, avg score 3.96, 100% quality pass, 0% exec pass. Similar pattern — evidence checks expect specific discovery paths.
- `meeting-prep-exec-meeting-01`: 3 runs, avg 3.34, 0% exec pass. Critical checks require the agent to read two specific workspace file paths (`Chief-of-Staff/memory/recurring/weekly-exec-meeting.md` and `Chief-of-Staff/skills/productivity/meeting-prep/SKILL.md`). The agent does adequate meeting prep but doesn't discover these exact files.

**What to do about it:** Audit all evidence checks on 0%-exec-pass fixtures. For each, ask: "Is this testing whether the agent did the right thing, or whether it did it in the exact way I expected?" Demote checks that test tool ordering, exact file paths, or specific wording to `critical: false`. Keep checks that test whether the agent actually discovered the information.

### Discovery Is the Bottleneck for Quality (confirmed across 4 models, 525 runs)

When the execution contract *isn't* the issue, discovery coverage is what separates good runs from bad:
- Weakest dimension in **70%** of completed runs
- Evidence score correlates **r=0.71** with quality score — the strongest predictor
- Families with worst discovery: email_triage (2.32), output_format (2.42), email_drafting (2.90)
- Root cause: agent drafts before completing source discovery

**What to do about it:** The agent needs a discovery-forcing mechanism. The system prompt should include a source checklist for knowledge work tasks: check connected tools → search memories → search conversations → verify claims → then draft. The `security-prompt-injection-01` fixture (7 runs, 0% exec pass, avg 3.35) is a good test case: the agent needs to discover real priorities from email/calendar before responding to the injection.

### Run-to-Run Variance Undermines Single-Run Confidence

- Many fixtures swing 2-3+ points between identical runs
- Sources: agent trajectory bifurcation, brittle evidence regex, adaptive judge panel, infrastructure variance
- Single-run scores are unreliable for ranking; need 5-10 runs per fixture

**What to do about it:** Freeze a benchmark slice of 15-20 core fixtures. Require 5-10 reruns per fixture per configuration change. Use fixture-normalized reporting (each fixture contributes equally to the aggregate, regardless of how many times it was run). Disable adaptive judge panel for benchmark runs — use a fixed 3-judge panel.

### Showrunner Orchestration Shows Promise (early signal, insufficient data)

Two fixtures tested with the Showrunner workflow:
- `cross-channel-board-strategy-brief-02`: showrunner avg 4.36 vs standard avg 3.96 (+0.39)
- `judgment-techforward-rescue-01`: showrunner avg 4.65 vs standard avg 4.14 (+0.51)

Both are complex multi-source tasks where staged orchestration would be expected to help. But only 1-2 showrunner runs per fixture — far too few for significance. Need 5+ paired runs.

### April 5-6 Infrastructure Dip (resolved)

- Scores dropped from avg 4.3 to avg 2.9
- Caused by schema gate timeouts (fc1176c36) and worker contamination (171a8e7be)
- Not a model regression; confirmed by recovery on Apr 7+

---

## How to Extend

### Adding New Metrics

1. Add extraction logic to `analyze_kw_evals.py` in `extract_result_data()` or `compute_analysis()`
2. Add chart/table to `generate_kw_eval_html.py` in the relevant section
3. Update the Dashboard Metrics table above if it's a tracked metric

### Adding New Fixture Families

No changes needed to analysis scripts — they auto-discover families from results.

### Comparing New Models

1. Run evals with the new model: `npx tsx --tsconfig tsconfig.node.json evals/knowledge-work.ts --model <model-name> --parallel 4 --tier 0`
2. Re-run `analyze_kw_evals.py` — it auto-discovers new model names from filenames
3. The HTML report will include the new model in all charts/tables

### Running A/B Tests

1. Create `-showrunner` fixture variants (or other suffixed variants)
2. Run both standard and variant
3. The analysis script auto-detects `-showrunner` suffix and produces A/B comparisons
4. Need minimum 5 paired runs for significance

---

## Comparability Checklist

Before making any leaderboard claim or model comparison, verify:

- [ ] Same fixture set across compared configurations
- [ ] Same judge protocol (fixed panel, not adaptive)
- [ ] Same time window (avoid infrastructure incidents)
- [ ] Minimum 5 runs per fixture per configuration
- [ ] Report confidence intervals, not just point estimates
- [ ] Empty/incomplete runs accounted for in denominator
- [ ] No known infrastructure incidents in the time window

---

## Updating This Document

When findings change or new patterns emerge:
1. Update the "Known Patterns & Historical Findings" section with concrete data and "what to do about it" actions
2. Add new dashboard metrics to the table if needed
3. Update the analysis scripts if new data fields are available
4. Keep the Quick Start section current with any script path changes
5. Update the "HTML Report Philosophy" section if the report structure needs to evolve
