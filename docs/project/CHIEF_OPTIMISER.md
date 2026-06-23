---
description: "Chief Optimiser workflow for improving knowledge-work eval scores — data analysis, multi-model diagnosis, prioritised fixes"
last_updated: "2026-05-18"
---

# Chief Optimiser Workflow

Instructions for systematically improving knowledge-work eval scores — you analyze results, diagnose patterns, and produce prioritized improvement recommendations for [CHIEF_ENGINEER2](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) to implement.

---

## See Also

- **[CHIEF_OPTIMISER_ANALYSIS](./CHIEF_OPTIMISER_ANALYSIS.md)** — reusable analysis protocol, scripts, key metrics, historical findings, and comparability checklist. **Start here** for running or interpreting analysis results.
- [CHIEF_ENGINEER2](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) — implements the recommended changes (handoff target)
- [CHIEF_BUGFIXER](../../coding-agent-instructions/workflows/CHIEF_BUGFIXER.md) — if analysis reveals a specific bug causing failures
- [CHIEF_PATHOLOGIST_ANALYSIS](../../coding-agent-instructions/workflows/CHIEF_PATHOLOGIST_ANALYSIS.md) — companion longitudinal analysis (bugs); this workflow is its eval-focused counterpart
- [WRITING_EVALS](../../docs/project/WRITING_EVALS.md) — eval harness overview, available suites, how to run
- `evals/knowledge-work.ts` — the knowledge-work eval harness
- `evals/knowledge-work-scoring.ts` — scoring dimensions, weights, pass thresholds
- `evals/knowledge-work-helpers.ts` — fixture loading, evidence checking, workspace helpers
- `evals/fixtures/knowledge-work-reproducible/` — reproducible fixtures with hermetic corpus
- `evals/results/knowledge-work/RESULTS_REGISTRY.md` — lightweight run history for trend tracking
- `coding-agent-instructions/scripts/analyze_kw_evals.py` — data extraction and analysis script (parses all Google Drive results)
- `coding-agent-instructions/scripts/generate_kw_eval_html.py` — HTML report generator with Chart.js visualizations
- HTML reports: `Google Drive → Shared drives/Product/evals/analysis/YYMMDD_HHMM_kw_eval_analysis.html`

---

## Overview

| Role | Responsibility |
|------|----------------|
| **Main Agent (You)** | Coordinates workflow, extracts and structures data, runs cross-tabulations, synthesizes subagent findings, produces prioritized recommendations. |
| **Researcher (Discovery & Tool Usage)** | Diagnoses why the agent fails to find workspace files, emails, Slack messages. Analyzes tool routing, MCP twin fidelity, search strategies. |
| **Researcher (Deliverable Quality)** | Diagnoses why output quality is low even when discovery succeeds. Analyzes synthesis, formatting, tone, actionability, professional quality. |
| **Researcher (Execution Contract)** | Diagnoses why evidence checks fail. Analyzes fixture design vs agent behavior, deterministic check reliability, claim audit contradictions. |
| **Researcher (Cross-Fixture Patterns)** | Identifies family-level trends, difficulty curve anomalies, common failure modes across fixtures, and fixture quality issues. |
| **CHIEF_ENGINEER** | Implements the recommended changes (handoff target, not part of this workflow). |

**Why this workflow exists:**
- Eval scores reflect end-to-end agent quality — improving them improves the product
- Individual fixture failures have diverse root causes (prompts, tool routing, MCP twins, agent loop, fixture design)
- Multi-model analysis prevents single-viewpoint blind spots in diagnosis
- Prioritization by ease x value ensures the highest-impact changes ship first
- Tracked optimization cycles enable measurement of improvement velocity

---

## Available Droids

| Role | Droid | Model | Analytical Focus |
|------|-------|-------|------------------|
| Discovery & Tool Usage | `researcher-opus4.7` | claude-opus-4-7 | Tool routing, MCP twin fidelity, search strategy gaps, workspace exploration |
| Deliverable Quality | `researcher-gpt5.5-high` | gpt-5.5 | Synthesis quality, output structure, tone, actionability, professional polish |
| Execution Contract | `researcher-gemini3.1-pro` | gemini-3.1-pro-preview | Evidence check design, deterministic vs judge scoring, claim audit reliability |
| Cross-Fixture Patterns | `worker` | inherit | Family trends, difficulty curves, fixture quality assessment, common failure modes |

---

## Key Principles

- **Data first, narrative second** — all claims must reference specific fixture IDs, scores, and evidence
- **Ease x value x confidence** — every recommendation gets scored on all three dimensions
- **Root cause, not symptom** — distinguish agent failures from fixture/harness issues
- **Preserve what works** — changes to improve weak fixtures must not regress strong ones
- **Measure before and after** — every optimization cycle starts and ends with an eval run

---

## Default Scope

**Primary focus:** Knowledge-work eval suite (`evals/knowledge-work.ts`, reproducible fixtures in `evals/fixtures/knowledge-work-reproducible/`).

**Other suites:** Run if the user specifies, or if analysis reveals issues that affect other eval domains (e.g., a system prompt change that could impact safety-prompt or done-safety evals). Available suites: safety-prompt, auto-continue, public-channel-safety, done-safety, narration, content-summary, onboarding-coach, conversation-search, rebel-core-loop.

**Model scope:** By default, analyze the working model resolved from the active `--config <path>` file (typically `evals/configs/default.json`). The user may specify a different model or request comparison runs.

---

## Workflow Phases

### Phase 0: Eval Freshness Check

**You do this.**

1. Check for existing results in the Google Drive results directory:
   ```
   ~/Library/CloudStorage/[Mindstone-email]/Shared drives/Product/evals/results/knowledge-work/
   ```
   Look for files matching the current model and `rebel-core` engine, sorted by date.

2. Also check the in-repo results directory: `evals/results/knowledge-work/`

3. **Freshness rules:**
   - Results < 7 days old on the same git branch with no relevant code changes since → **use existing results**
   - Results > 7 days old, OR relevant code has changed (check `git log --since=<result-date> -- src/core/ src/main/services/ evals/`) → **re-run evals**
   - No results exist → **run evals**
   - User explicitly requests a re-run → **run evals**
   - User says "skip evals" or "use existing" → **use whatever exists**

4. **If re-running evals:**
   ```bash
   npx tsx --tsconfig tsconfig.node.json evals/knowledge-work.ts --parallel 4 --tier 0
   ```
   - `--tier 0` runs only reproducible (synthetic) fixtures (hermetic, no external workspace dependency)
   - `--parallel 4` balances speed vs API rate limits
   - Monitor for worker hangs (context-stress fixtures can stall); kill and re-run if needed
   - The harness saves results to Google Drive automatically

5. **If the user specifies a subset:**
   - `--family <name>` to run a specific family (e.g., `email_drafting`, `judgment`, `cross_channel`)
   - `--fixture <id>` to run a single fixture
   - `--tier 1` to include workspace fixtures (requires configured workspace path)

6. Log: `[OPTIMISER] Eval freshness: <using existing results from YYYY-MM-DD | re-running N fixtures>`

Proceed to Phase 1.

### Phase 1: Data Extraction & Structuring

**You do this.**

Parse the results JSON file to extract structured data for analysis. The JSON contains an array of fixture results, each with:

| Field | Description |
|-------|-------------|
| `fixtureId` | Fixture identifier |
| `family` | Fixture family (e.g., `email_drafting`, `cross_channel`) |
| `difficulty` | `easy`, `medium`, `hard`, `fiendish` |
| `completed` | Whether the agent finished without error |
| `finalVerdict` | `pass`, `fail`, `partial` |
| `evidence` | Array of evidence checks with `found: boolean` |
| `consensus` | Judge consensus: `meanScore`, `agreement`, `spread` |
| `judgeResults` | Per-judge scores with dimension breakdowns and rationale |
| `claimAudit` | Supported/unsupported/contradicted claim counts |
| `metrics.tools` | Tool call counts, blocked attempts, unique tools |
| `metrics.tokens` | Input/output/cache token counts |
| `metrics.timing` | Duration, per-turn timing |
| `mustNotDoViolations` | Constraint violations (trusted tool boundaries) |
| `executionContract` | Pass/fail with critical evidence counts |

**Build these structured tables:**

1. **Fixture summary table:** fixture ID, family, difficulty, verdict, score, evidence %, tool calls, duration, cost
2. **Dimension score matrix:** fixture x dimension (discovery_coverage, grounded_accuracy, deliverable_quality, and cost_efficiency if present)
3. **Family aggregates:** per-family pass rate, avg score, avg evidence %, fixture count
4. **Difficulty aggregates:** per-difficulty pass rate, avg score
5. **Evidence detail:** per-fixture evidence item hit/miss rates

Log: `[OPTIMISER] Data extracted: N fixtures, M families, avg score X/5, pass rate Y%`

Proceed to Phase 2.

### Phase 2: Single-Dimension Analysis

**You do this.**

Compute frequency tables and distributions. Each table must include a **1-2 sentence interpretive blurb**.

| Distribution | Purpose |
|-------------|---------|
| Verdict distribution | Pass/fail/partial split — overall health |
| Score histogram | 1-2, 2-3, 3-4, 4-5 buckets — where scores cluster |
| Evidence hit rate | Per-fixture % of evidence checks passing |
| Dimension scores | Per-dimension averages across all fixtures |
| Tool call distribution | Min/max/mean/median tool calls, correlation with score |
| Duration distribution | Fast vs slow fixtures, correlation with score |
| Cost distribution | Per-fixture estimated cost |
| Family performance | Ranked by avg score within each family |
| Difficulty curve | Score by difficulty level — does harder = lower scores? |

**Critical metric: Execution vs Quality divergence.** Many fixtures score "PARTIAL" — execution contract fails but quality passes (or vice versa). Analyze:
- How many fixtures pass execution but fail quality?
- How many pass quality but fail execution?
- What does this divergence reveal about the scoring system vs the agent?

Log: `[OPTIMISER] Distributions computed. Key signal: <1-line finding>`

Proceed to Phase 3.

### Phase 3: Cross-Tabulations

**You do this.**

These cross-tabs reveal non-obvious patterns. Each must include an **interpretive blurb**.

| Cross-Tab | What It Reveals |
|-----------|-----------------|
| Family x verdict | Which task categories the agent handles well vs poorly |
| Family x difficulty x score | Whether difficulty predicts failure, or if some hard fixtures pass while easy ones fail |
| Evidence hit rate x final score | Is evidence collection the bottleneck, or can fixtures pass with low evidence? |
| Tool call count x score | Is the agent over-exploring (too many calls, low score) or under-exploring (too few calls, low discovery)? |
| Discovery_coverage x verdict | Is discovery the primary bottleneck? |
| Dimension score heatmap | Which dimensions consistently drag down scores — discovery, accuracy, or deliverable quality? |
| Judge agreement x score | Do judges agree more on clear passes/fails? High disagreement signals ambiguous fixtures. |
| Claim audit x score | Do claim contradictions predict failure? Are unsupported claims tolerated by judges? |

**The "Almost Passing" table (critical):** For every fixture that scored 2.5-3.2 (near the pass threshold), list:

| Fixture | Score | Verdict | Weakest Dimension | Key Evidence Misses | Potential Quick Win |

These are the highest-leverage fixtures — small improvements could flip them to passing.

Log: `[OPTIMISER] Cross-tabs computed. "Almost passing" fixtures: N`

Proceed to Phase 4.

### Phase 4: Parallel Subagent Analysis

**Delegate to 4 researcher subagents in parallel.**

Provide each subagent with:
- The full results JSON file path
- The markdown report file path
- Access to fixture definitions in `evals/fixtures/knowledge-work-reproducible/`
- Access to eval harness code in `evals/`
- The structured tables and cross-tabs from Phases 2-3

#### Researcher 1: Discovery & Tool Usage

Droid: `researcher-opus4.7`

> "You are analyzing knowledge-work eval results to diagnose **discovery and tool usage** failures. The agent runs through Rebel Core against realistic knowledge-work tasks with a hermetic MCP twin corpus (emails, Slack, calendar) and a workspace of memory files.
>
> **Results:** `<path to JSON>` and `<path to markdown report>`
> **Fixtures:** `evals/fixtures/knowledge-work-reproducible/`
> **Eval harness:** `evals/knowledge-work.ts`, `evals/knowledge-work-helpers.ts`
> **MCP twins:** `evals/mcp-twins/`
> **Corpus:** `evals/fixtures/knowledge-work-reproducible/corpus/`
>
> Read the results, then investigate:
>
> 1. **Which fixtures fail primarily on discovery?** Identify fixtures where `discovery_coverage` is the lowest dimension and evidence checks for "searched X" or "read Y file" fail.
> 2. **Tool routing analysis:** When the agent needs email/Slack/calendar data, does it find the right MCP tools? Are there package-not-found errors? Does it use `list_tool_packages` effectively?
> 3. **Workspace exploration strategy:** When files are in the workspace (memory/, documents/), does the agent find them? Does it rely on search vs directory traversal? Does it explore broadly or get stuck in one area?
> 4. **MCP twin fidelity:** Read the twin server code (`evals/mcp-twins/server.ts`, `email-tools.ts`, `slack-tools.ts`, `calendar-tools.ts`). Are there tool behaviors that mislead the agent? Are search results formatted in a way the agent misinterprets?
> 5. **Hermetic vs non-hermetic divergence:** Some workers bootstrap with hermetic MCP (128 tools) while others get the full user MCP config (826+ tools). Does tool count correlate with performance?
>
> Return:
> - **Root causes** ranked by frequency (how many fixtures affected)
> - **Specific fixture examples** for each root cause
> - **Recommended fixes** categorized as: prompt change, tool routing fix, MCP twin fix, agent loop change, corpus fix
> - **Confidence** (0-100%) for each diagnosis"

#### Researcher 2: Deliverable Quality

Droid: `researcher-gpt5.5-high`

> "You are analyzing knowledge-work eval results to diagnose **deliverable quality** failures. Even when the agent discovers relevant information, the final output may be poorly structured, incomplete, unprofessional, or lacking actionability.
>
> **Results:** `<path to JSON>` and `<path to markdown report>`
> **Fixtures:** `evals/fixtures/knowledge-work-reproducible/`
> **System prompt assembly:** `src/main/services/mcpService.ts` (search for system prompt), `src/core/rebelCore/`
>
> Read the results (especially judge rationales for quality dimensions), then investigate:
>
> 1. **Deliverable quality failures:** For fixtures where `deliverable_quality` is the weakest dimension, what are judges criticizing? Common patterns: too verbose, not structured for audience, missing executive summary, not send-ready, includes process narration.
> 2. **Grounded accuracy failures:** When judges score `grounded_accuracy` low, is the agent fabricating, or is it citing information it didn't actually verify? Check claim audit results for contradictions vs unsupported claims.
> 3. **Output format issues:** Do fixtures that specify a format (email draft, briefing, audit report) get it right? Is the agent producing the wrong deliverable type?
> 4. **Task completion failures:** Does the agent sometimes ask clarifying questions instead of completing the task? Does it say "I couldn't find X" when X is available? Does it prematurely mark tasks as done?
> 5. **System prompt influence:** Read the system prompt assembly to understand what instructions the agent receives about output quality. Are there gaps in the prompt that would help?
>
> Return:
> - **Quality failure patterns** ranked by frequency
> - **Specific fixture examples** with judge quotes
> - **Recommended fixes** categorized as: system prompt change, persona/tone adjustment, output format instruction, task completion logic
> - **Confidence** (0-100%) for each diagnosis"

#### Researcher 3: Execution Contract

Droid: `researcher-gemini3.1-pro`

> "You are analyzing knowledge-work eval results to diagnose **execution contract** failures. The execution contract is a set of deterministic evidence checks per fixture — things like 'searched emails for X', 'read file Y', 'output mentions Z'. These are binary pass/fail checks independent of judge scoring.
>
> **Results:** `<path to JSON>` and `<path to markdown report>`
> **Fixtures:** `evals/fixtures/knowledge-work-reproducible/`
> **Evidence checking:** `evals/knowledge-work-helpers.ts` (search for `checkEvidence`)
> **Scoring:** `evals/knowledge-work-scoring.ts`
>
> Read the results and fixture definitions, then investigate:
>
> 1. **Evidence check reliability:** Are deterministic evidence checks actually deterministic? Do some checks fail even when the agent did the right thing (false negatives)? Read the check implementations — are regex patterns too strict or too loose?
> 2. **Execution vs quality divergence:** For 'PARTIAL' fixtures (execution fails but quality passes), is the execution contract too strict, or is quality scoring too lenient? Which specific evidence items cause the most failures?
> 3. **Claim audit patterns:** When claims are marked 'contradicted', are they genuine fabrications, or is the claim auditor being too strict? When claims are 'unsupported', is the source data actually available but not linked?
> 4. **Fixture design issues:** Are any fixtures testing the wrong thing? Are evidence checks measuring process (did the agent search X?) rather than outcome (did the agent find the answer?)? Are expected key evidence items achievable given the corpus data?
> 5. **Scoring dimension analysis:** The current dimensions are discovery_coverage, grounded_accuracy, deliverable_quality (plus cost_efficiency for dispatch fixtures). Is this the right decomposition? Would different or additional dimensions capture quality better?
>
> Return:
> - **Evidence check issues** ranked by impact on pass rate
> - **Fixture improvements** with specific changes to evidence items or checks
> - **Scoring system recommendations** if the dimensions or weights need adjustment
> - **Confidence** (0-100%) for each diagnosis"

#### Researcher 4: Cross-Fixture Patterns

Droid: `worker`

> "You are analyzing knowledge-work eval results to identify **cross-fixture patterns** — trends that span multiple fixtures and reveal systemic issues rather than per-fixture quirks.
>
> **Results:** `<path to JSON>` and `<path to markdown report>`
> **Fixtures:** `evals/fixtures/knowledge-work-reproducible/`
>
> Read the results and fixture definitions, then investigate:
>
> 1. **Family-level patterns:** Which fixture families consistently perform well/poorly? Is `email_drafting` always weak while `prefetch_validation` is strong? Why?
> 2. **Difficulty curve analysis:** Do easy fixtures always pass? Do fiendish fixtures always fail? Or are there surprising reversals? What makes a "hard" fixture actually hard vs what makes it easy despite the label?
> 3. **Common failure modes:** Across all failing fixtures, what are the top 3-5 recurring failure patterns? (e.g., "agent doesn't explore workspace directories", "agent asks clarifying questions instead of acting", "agent uses wrong tool package")
> 4. **Run-to-run variance:** If multiple runs exist for the same fixtures, how much do scores vary? Which fixtures are stable vs volatile? High variance suggests the fixture is testing something non-deterministic or fragile.
> 5. **Fixture quality assessment:** Are any fixtures poorly designed? (Unrealistic tasks, ambiguous success criteria, evidence checks that don't match the task, corpus data that's insufficient for the task)
> 6. **Bright spots:** Which fixtures consistently score well? What do they have in common? Can weaker fixtures learn from their design?
>
> Return:
> - **Systemic patterns** ranked by breadth (number of fixtures affected)
> - **Family-level recommendations** (which families need the most work)
> - **Fixture-specific quality issues** (fixtures that should be redesigned or retired)
> - **Bright spot analysis** (what works and how to replicate it)
> - **Confidence** (0-100%) for each finding"

**After receiving all 4 subagent responses:**

Log: `[OPTIMISER] Subagent analysis complete. Discovery: N findings, Quality: N findings, Contract: N findings, Patterns: N findings`

Proceed to Phase 5.

### Phase 5: Synthesis & Prioritization

**You do this.**

Merge all subagent findings with your own cross-tabulation insights into a unified diagnosis.

**For each identified issue, score on three dimensions:**

| Dimension | Scale | Description |
|-----------|-------|-------------|
| **Value** | 1-5 | How many fixtures would improve? How much would scores increase? (5 = affects 10+ fixtures significantly) |
| **Ease** | 1-5 | How easy is the fix? (5 = prompt tweak or config change; 1 = architecture overhaul) |
| **Confidence** | 1-5 | How sure are we this is the actual root cause? (5 = clear evidence across multiple fixtures; 1 = speculative) |

**Priority score = Value x Ease x Confidence** (max 125).

**Categorize each recommendation:**

| Category | Examples | Typical Ease |
|----------|----------|--------------|
| System prompt changes | Add "always explore workspace directory structure first", improve output format instructions | 4-5 |
| Tool routing / MCP fixes | Fix package discovery, improve tool search, fix MCP twin response formats | 3-4 |
| Eval fixture improvements | Fix unreliable evidence checks, update expected evidence, adjust corpus data | 3-4 |
| Agent loop changes | Modify turn execution, tool calling patterns, context management behavior | 2-3 |
| Workspace / corpus fixes | Add missing corpus data, fix corpus formatting, update workspace structure | 3-4 |
| Scoring system changes | Adjust dimension weights, modify pass thresholds, update judge prompts | 2-3 |
| Architecture changes | Fundamental changes to how the agent discovers or processes information | 1-2 |

**Produce the prioritized recommendations table:**

| Rank | Issue | Category | Value | Ease | Conf | Priority | Fixtures Affected |
|------|-------|----------|-------|------|------|----------|-------------------|

Include a brief description and rationale for each recommendation.

**Executive summary (5-8 bullet points):**

1. Dataset scope and key metrics
2. Dominant failure mode
3. Highest-leverage improvement opportunity
4. "Almost passing" fixtures that could flip with small changes
5. Systemic discovery/quality/contract issues
6. Fixture design concerns (if any)
7. Comparison to previous run (if available)
8. Estimated impact of top 3 recommendations

Log: `[OPTIMISER] Synthesis complete. N recommendations, top priority: <brief description>`

Proceed to Phase 6.

### Phase 6: Handoff to CHIEF_ENGINEER

**You do this.**

#### Context-safe output format

CHIEF_ENGINEER has a ~200K token context limit. The planning doc + AGENTS.md + CHIEF_ENGINEER workflow already consume most of that budget. To avoid overflow:

1. **Slim planning doc** at `docs/plans/YYMMDD_eval_optimisation_cycle_N.md` (~3-5KB max):
   - Baseline metrics (5 lines)
   - Executive summary (5-8 bullets)
   - Prioritized recommendations table (compact: rank, issue, fix location, V×E×C, fixture count)
   - Staged implementation plan (which recs per stage)
   - Success criteria and validation command
   - User intent (2-3 lines)

2. **Per-recommendation detail files** in `docs/plans/YYMMDD_eval_optimisation_cycle_N/`:
   - One file per recommendation: `rec01_short_name.md`, `rec02_short_name.md`, ...
   - Plus `cross_cutting_analysis.md` for patterns that span recommendations
   - Each file contains: root cause, evidence, fix approach, affected files
   - CHIEF_ENGINEER reads these on demand (per stage), not all at once

3. **The slim planning doc must include** at the top:
   ```
   > Detailed analysis: `docs/plans/YYMMDD_eval_optimisation_cycle_N/` folder
   > (one file per recommendation). Read individual rec files as needed.
   ```

Do NOT put all detailed findings in the planning doc itself. The planning doc is a compact index; the folder holds the depth.

#### Hard checkpoint (CRITICAL)

**CHIEF_ENGINEER must NOT implement any changes before the user has reviewed and approved the plan.** Eval optimisation changes can have wide-ranging effects on prompts, scoring, agent behavior, and fixture contracts.

When handing off to CHIEF_ENGINEER:
1. Explicitly instruct it to use `hard-checkpoint` autonomy (not adaptive)
2. Include this directive in the planning doc header AND in the delegation prompt:
   > "This task was generated by the CHIEF_OPTIMISER workflow. Use `hard-checkpoint` autonomy — you MUST present the plan to the user and get explicit approval before implementing any changes. Do not proceed to implementation automatically."
3. **After creating the planning doc, STOP.** Present the planning doc path to the user. Do NOT invoke CHIEF_ENGINEER yourself. The user will decide when to invoke it.

Log: `[OPTIMISER] Planning doc created: <path>`

Proceed to Phase 7.

### Phase 7: Results Registry Update

**You do this.**

Append to `evals/results/knowledge-work/RESULTS_REGISTRY.md`:

```markdown
| Date | Git | Model | Engine | Fixtures | Pass | Fail | Partial | Rate | Avg Score | Cost | Results File | Notes |
```

The registry is lightweight and reconstructable from the raw JSON results files on Google Drive. Its purpose is quick trend visibility without parsing JSON.

Log: `[OPTIMISER] Registry updated`

---

## Optimization Cycles

The CHIEF_OPTIMISER is designed for iterative improvement. Each cycle follows the pattern:

```
Analyze → Recommend → [CHIEF_ENGINEER implements] → Re-run evals → Compare → Next cycle
```

**Cycle tracking:**
- Each cycle gets a number (Cycle 1, Cycle 2, ...)
- The planning doc references the baseline from the start of the cycle
- The results registry tracks before/after metrics per cycle
- Over time, the registry reveals improvement velocity

**V1 scope:** Single pass (analyze and recommend). The CHIEF_ENGINEER re-runs evals as part of its completion phase. Future versions may automate the full loop.

**When to run a new cycle:**
- After CHIEF_ENGINEER completes an optimization round and re-runs evals
- When a significant codebase change lands that might affect eval scores (new model, system prompt update, tool routing change)
- Periodic check-in (weekly or bi-weekly recommended)

---

## Results Registry Format

The registry lives at `evals/results/knowledge-work/RESULTS_REGISTRY.md` and tracks all eval runs:

```markdown
# Knowledge Work Eval Results Registry

Lightweight run history for trend tracking. Canonical data is in the raw JSON results files.

## Runs

| Date | Git Hash | Branch | Model | Engine | Tier | Fixtures | Pass | Fail | Partial | Pass% | Avg Score | Est Cost | Results File | Cycle | Notes |
|------|----------|--------|-------|--------|------|----------|------|------|---------|-------|-----------|----------|--------------|-------|-------|
```

**Fields:**
- **Cycle**: Optimization cycle number (blank if ad-hoc run)
- **Notes**: Brief context (e.g., "baseline for cycle 1", "post-prompt-change", "regression check")

---

## Checklist

- [ ] Eval freshness checked; results are < 7 days old or re-run completed
- [ ] Results JSON parsed and structured tables built
- [ ] Single-dimension distributions computed with interpretive blurbs
- [ ] Cross-tabulations computed, "Almost Passing" table produced
- [ ] 4 subagents launched with distinct analytical lenses
- [ ] Subagent findings synthesized
- [ ] Each recommendation scored on Value x Ease x Confidence
- [ ] Prioritized recommendations table produced
- [ ] Executive summary written with specific data points
- [ ] Planning doc created for CHIEF_ENGINEER handoff
- [ ] Results registry updated
- [ ] Log lines emitted for each phase
- [ ] HTML report generated and saved to Google Drive

---

## Reusable Analysis Infrastructure

The analysis scripts and protocols are documented in [CHIEF_OPTIMISER_ANALYSIS](./CHIEF_OPTIMISER_ANALYSIS.md). Key reusable components:

| Component | Location | Purpose |
|-----------|----------|---------|
| Data extraction script | `coding-agent-instructions/scripts/analyze_kw_evals.py` | Parses all Google Drive results into structured JSON |
| HTML report generator | `coding-agent-instructions/scripts/generate_kw_eval_html.py` | Chart.js dashboard with all analysis sections |
| Dashboard metrics | CHIEF_OPTIMISER_ANALYSIS.md § Dashboard Metrics | 6 key metrics to compute after every run |
| Comparability checklist | CHIEF_OPTIMISER_ANALYSIS.md § Comparability Checklist | Required before making model comparisons |
| Value Score formula | CHIEF_OPTIMISER_ANALYSIS.md § Single Ranking Number | Composite metric accounting for quality, reliability, and cost |
| Known patterns | CHIEF_OPTIMISER_ANALYSIS.md § Historical Findings | Discovery bottleneck, execution divergence, variance sources |
| Subagent prompts | This doc, Phase 4 | 4-researcher parallel analysis templates |
