---
description: "Knowledge-work eval harness, reproducible fixtures, and MCP twin server architecture for Mindstone Rebel"
last_updated: "2026-06-11"
---

# Knowledge Work Evals

## See Also

- [WRITING_EVALS.md](WRITING_EVALS.md) — Central eval overview and links to the other harness docs
- [EVAL_CANONICAL_COVERAGE_PLANNER.md](EVAL_CANONICAL_COVERAGE_PLANNER.md) — idempotent canonical runs: skip already-good fixtures, re-run gaps, and rejudge panel mismatches
- [EVAL_CORPUS_IDENTITY.md](EVAL_CORPUS_IDENTITY.md) — `fixtureCorpusHash`, score-field fingerprints, equivalence classes, and schema-version comparability
- [TESTING_EVALS_PERSONAL_WORKSPACE.md](TESTING_EVALS_PERSONAL_WORKSPACE.md) — Acme Corp corpus data, personal workspace, personas, contradictions
- [`260505_kw_eval_run_queue.md`](../plans/260505_kw_eval_run_queue.md) — **active reorderable queue** of which eval bundle to run next
- [`260503_kw_eval_open_weights_coverage_sweep.md`](../plans/260503_kw_eval_open_weights_coverage_sweep.md) — coverage strategy and rationale (the *why*; queue covers the *what next*)
- [EVAL_JUDGE_PANELS](EVAL_JUDGE_PANELS.md) — canonical judge panel (locked 2026-05-05: Opus 4.7 + GPT-5.4 + Gemini 3.1 Pro arbitrator)

---

## Knowledge Work Eval (`evals/knowledge-work-setup.ts` + `evals/knowledge-work.ts`)

End-to-end evaluation of the production agent system on realistic knowledge-work tasks (meeting prep, email drafting, research synthesis, etc.). Runs the REAL production `executeAgentTurn` loop headlessly against sandbox workspaces, then scores output quality with a multi-provider LLM judge panel.

Unlike the safety evals (which test isolated functions), this eval exercises the full agent stack: system prompt assembly, tool definitions, MCP servers, proxy translation, pre-turn semantic context, and tool safety hooks.

### Quick Start

```bash
# One-time key capture (merges into evals/configs/.local/keys.env; hand-added lines survive;
# capture never deletes — stale custom-provider keys are manual cleanup)
npm run eval:capture-keys -- --apply

# Load keys into your shell for this terminal session (`set -a` is load-bearing)
set -a; source evals/configs/.local/keys.env; set +a

# Interactive setup (reads defaults from the hermetic config file)
npx tsx evals/knowledge-work-setup.ts --config evals/configs/default.json

# Non-interactive examples
npx tsx evals/knowledge-work-setup.ts --config evals/configs/default.json --model claude-sonnet-4-20250514 --all
npx tsx evals/knowledge-work-setup.ts --config evals/configs/default.json --single-judge --family meeting_prep
npx tsx evals/knowledge-work-setup.ts --config evals/configs/default.json --runs 3 --fixture meeting-prep-customer-renewal-01
npx tsx evals/knowledge-work-setup.ts --config evals/configs/default.json --dry-run
```

### The `knowledge-work-setup.ts` Flow

The setup script is an interactive two-phase wizard that configures and launches the eval.

**Phase 1: Configuration**

1. **Config + key discovery** -- Loads model/profile defaults from `--config <path>` (defaults to `evals/configs/default.json`) and resolves provider keys from `process.env` (typically via `set -a; source evals/configs/.local/keys.env; set +a`).
2. **Judge selection** -- Builds a candidate judge list from Anthropic Opus models and OpenAI profiles. User selects up to 5 judges. Remembers previous selections.
3. **Model tier assignment** -- User assigns models to thinking, working, and background tiers. These determine which models the agent uses during the eval, mirroring production's multi-tier setup.
4. **Workspace path** -- Path to a real document folder for workspace-type fixtures (text files are cloned into a sandbox).
5. **Key validation** -- All selected judge API keys are validated against their respective provider endpoints in parallel.
6. **Config persistence** -- Writes wizard selections to `evals/configs/.local/<name>.json` (gitignored), then reuses that config path on subsequent runs.

**Phase 2: Test Plan**

1. **Scenario selection** -- Synthetic tests (self-contained fake workspaces, ~30s each), workspace tests (real workspace clone, ~2min each), or both.
2. **Fixture filtering** -- All fixtures, one family only (`meeting_prep`, `email_drafting`, `research_synthesis`, `strategic_synthesis`, `content_audit`), or a single fixture by ID.
3. **Judge count** -- All configured judges, single judge (fast iteration), or custom selection.
4. **Runs** -- Number of times to run each fixture (for consistency measurement).
5. **Execution engine** -- Rebel Core (in-process native runtime). The legacy Claude Agent SDK engine and the side-by-side comparison mode were removed in April 2026 along with the SDK itself; the `--core` flag is preserved as a no-op for backwards compatibility.
6. **Parallelism** -- 1-8 worker processes for parallel fixture execution.

**Execution**

After confirmation, `knowledge-work-setup.ts`:
1. Builds the eval bundle via `evals/build.mjs` (esbuild, bundles `knowledge-work.ts` with electron stubs and store shims into `evals/.built.mjs`).
2. Launches the built bundle with `node` (not `tsx`) passing the test plan as CLI args, including `--config <path>`. Credentials are resolved from `process.env` at runtime.

### Config Contract

The eval runtime uses two explicit inputs:

- **`--config <path>`** — a hermetic config JSON (schema in [`evals/configs/types.ts`](../../evals/configs/types.ts); loader in [`evals/configs/loader.ts`](../../evals/configs/loader.ts)).
- **Environment credentials** — provider keys from `process.env` (recommended workflow: `npm run eval:capture-keys -- --apply` then `set -a; source evals/configs/.local/keys.env; set +a`). Capture merges by default (hand-maintained lines survive; never deletes — stale custom-provider keys are manual cleanup). The live-API tier uses a sibling mechanism: `npm run capture-live-api-keys` → repo-root `.env.test` (`TEST_*` names) — see [TESTING_AUTOMATION_OVERVIEW § live-API tier](TESTING_AUTOMATION_OVERVIEW.md#consolidated-live-api-tier-testslive-api--liveapiharness).

`knowledge-work-setup.ts` persists interactive choices to `evals/configs/.local/*.json` (gitignored) and forwards the selected config path to the runner.

#### Config vs CLI precedence

The config file is the **base**; CLI flags **override** the matching config field for a single run, per-field — they do not "compete". Absent flag ⇒ the config value is used.

| CLI flag | Overrides config field |
| --- | --- |
| `--model` | `bundle.working` |
| `--thinking` | `bundle.thinking` |
| `--background` | `bundle.background` |
| `--provider` | `cliProvider` |
| `--smart-picker` | engages the adaptive router for the run (not a bundle field — see below) |

`--smart-picker` (added 2026-06-14) makes the eval engage the adaptive per-turn router end-to-end, rather than running the fixed bundle models; without it the router gate doesn't fire on the eval's agent-turn seam. OpenRouter pricing for `claude-fable-5` / `claude-opus-4-8` was added alongside so OR-routed runs cost-account correctly.

(`--judges` is not an override — it's a runtime *filter* over the config's judge panel; the config `judges:` array defines the panel.) Because CLI wins silently, `resolveEvalRun` ([`evals/configs/loader.ts`](../../evals/configs/loader.ts)) prints an observable `[eval-config] --model "X" overrides config bundle.working "Y" for this run.` notice whenever a flag shadows a *different* config value — so the effective bundle is never a mystery. Mental model: **config = which model setup; CLI flags = per-run overrides on top.**

**Versioning scratch configs:** `evals/configs/.local/*.json` is gitignored, so to keep variants around use a datetime-stamped filename via the full path form: `--config evals/configs/.local/260614_1430_my-run.json` (the short `--config-name` form sanitises `_`, so use `--config <path>` for stamped names).

### Eval Runner (`knowledge-work.ts`)

The runner does the heavy lifting:

1. **Bootstrap** (`knowledge-work-bootstrap.ts`) -- Initializes the production agent system headlessly: `PlatformConfig` with temp dirs, boundary interfaces (in-memory stores, no-op tracker, console error reporter), in-memory settings translated from the resolved hermetic config + env credentials, Super-MCP HTTP server, local model proxy, workspace index. Safety hooks run normally except bash commands (blocked since no UI confirmation available).
2. **Fixture loading** -- Scans `evals/fixtures/knowledge-work-reproducible/` (synthetic) and `evals/fixtures/knowledge-work-ws/` (workspace) for JSON fixtures.
3. **Per-fixture execution**:
   - Creates a sandbox workspace (synthetic: bare tmpdir with only seed files; reproducible: corpus workspace copy; workspace: snapshot from real workspace)
   - Points the production agent at the sandbox (`coreDirectory`)
   - Builds a per-fixture LanceDB semantic index (closes any prior index, initializes for the sandbox path, indexes all sandbox files, refreshes the read table). This ensures `rebel_search_files` returns relevant results for sandbox files.
   - Starts an agent turn with the fixture's prompt via the production `startAgentTurn`
   - Collects all `AgentEvent`s via the event adapter (`knowledge-work-event-adapter.ts`)
   - Checks deterministic evidence (file_accessed, output_contains, file_accessed_pattern)
   - Checks mustNotDo violations
   - Collects written artifacts (files created/modified by the agent)
   - Runs the judge panel (adaptive allocation: 2 diverse judges first, escalate to full panel only for ambiguous results)
   - Computes execution contract (critical evidence + mustNotDo) and deliverable quality (judge consensus)
   - Computes consensus (median weighted score across 5 dimensions, pass >= 3.0)
   - Runs claim-level factual audit (reporting-only, extracts and verifies 5-10 claims against sources)
   - Cleans up sandbox
4. **Parallel mode** -- Orchestrates worker processes, each bootstrapping independently, with round-robin fixture assignment and a cross-worker progress dashboard.
5. **Results** -- Auto-saved to Google Drive (`Shared drives/Product/evals/results/knowledge-work/`) when available, or `evals/results/knowledge-work/` as repo fallback. Override with `EVAL_RESULTS_DIR` env var or `--output`.

   **Throwaway runs** (debugging, prompt-iteration loops, sandbox experiments) -- prefer `EVAL_RESULTS_DIR=/tmp/eval-scratch npm run eval -- knowledge-work ...` over `--output /tmp/...`. The env-var route preserves the analyzer's canonical filename convention (`YYMMDD_HHmmss_<model>_<fixture>_<git-sha>.json`), keeps results in the same per-category subdirectory structure the analyzer scans, and the resulting files are still recognisable by `npm run eval:analyze-kw -- --results /tmp/eval-scratch/knowledge-work` if you want to merge throwaway runs into a dashboard view. Manual `--output` is rarely necessary -- the analyzer's `--results <dir>` flag already aggregates across multiple directories, and the upcoming `--prefer-rerun-pass` policy (see [`docs/plans/260518_kw_eval_canonical_drift_and_rerun_cells.md`](../plans/260518_kw_eval_canonical_drift_and_rerun_cells.md)) folds a manual rerun's `pass` into the same cell as a prior failed automated run, so operators no longer need to hand-merge rerun results to "salvage" a model's coverage row.

### Canonical Coverage Planner (idempotent + resumable runs)

Default canonical tier-0 static-response runs are now run-missing/skip-good by default. Before dispatching fixtures, `applyCanonicalCoverageSelection()` calls `deriveCoveragePlan()` and skips cells that are already properly run for the current model variant, schema major, corpus identity, and judge panel.

The planner re-runs missing/incomplete/stale cells, keeps clean cells, and routes panel-only drift to rejudge work. Use `--rerun-all` or `--no-skip` when you intentionally want to bypass the skip-good behavior. Full state definitions and corpus-equivalence rules live in [EVAL_CANONICAL_COVERAGE_PLANNER.md](EVAL_CANONICAL_COVERAGE_PLANNER.md).

### Fixture Types

**Synthetic** (`evals/fixtures/knowledge-work-reproducible/`): Self-contained with inline workspace files. Fast (~30s). Organized by family subdirectories.

```json
{
  "id": "meeting-prep-customer-renewal-01",
  "family": "meeting_prep",
  "difficulty": "medium",
  "prompt": "Prepare me for tomorrow's meeting with...",
  "workspaceSeed": { "files": [{ "path": "crm/acme.md", "content": "..." }] },
  "rubric": { "keyEvidence": [{ "id": "e1", "description": "...", "check": "file_accessed", "path": "crm/acme.md" }] },
  "mustNotDo": ["Do not send any emails"]
}
```

**Workspace** (`evals/fixtures/knowledge-work-ws/`): References real workspace directories. Slower (~2min). Files are snapshot-cloned (text only, no binaries) into a per-fixture sandbox.

```json
{
  "id": "ws-daily-inbox-triage-01",
  "type": "workspace",
  "family": "strategic_synthesis",
  "workspaceSource": "/Users/.../Documents/Workspace/Core",
  "prompt": "Triage my inbox and flag urgent items...",
  "rubric": { "keyEvidence": [{ "id": "e1", "check": "file_accessed_pattern", "pattern": "**/*.md" }] }
}
```

**Reproducible** (`evals/fixtures/knowledge-work-reproducible/`): Fully self-contained fixtures that depend on no personal data. Each fixture runs against a fictional "Acme Corp" workspace with stateful tool twins (email, Slack, calendar) that intercept MCP tool calls and return responses from a static corpus. See [planning doc](../plans/260328_reproducible_eval_dataset.md) for the full design.

```json
{
  "id": "email-triage-inbox-priority-01",
  "family": "email_triage",
  "source": "reproducible",
  "reproducible": true,
  "corpusWorkspace": true,
  "prompt": "Triage my inbox and tell me what needs attention...",
  "workspaceSeed": { "files": [] },
  "rubric": { "keyEvidence": [{ "id": "e1", "check": "tool_used", "pattern": "search_workspace_emails" }] }
}
```

Key differences from other fixture types:
- **No personal data dependency** -- workspace seeded from `personal-workspace/` (4 spaces, ~30 memory files, 5 skills)
- **Hermetic MCP bootstrap** (`hermeticMcp` option) -- starts Super-MCP with empty config (no personal tools), skips workspace index copy, writes per-fixture MCP config, and invalidates the connected packages cache so the system prompt reflects the corpus user
- **MCP twin servers** -- real stdio-based MCP servers registered in Super-MCP's router config. Serve corpus data through the actual MCP protocol, so Rebel Core subagents can discover and call tools. See [MCP twin servers architecture](#mcp-twin-servers) below
- **MCP twin services** -- four services supported: email (Gmail tools), Slack (workspace messaging tools), calendar (Google Calendar tools), and export (pipeline data). Controlled by `SERVICES` env var on the twin server (e.g., `SERVICES=email,slack,calendar,export`)
- **Per-fixture isolation** -- each fixture gets a fresh tmpdir; twin write state resets between fixtures
- **Same runner** -- uses the existing `knowledge-work.ts` runner, judge panel, and metrics; just a different sandbox creation path

Corpus data lives in `evals/fixtures/knowledge-work-reproducible/corpus/`:
- `_meta.json` -- reference date, personas, company info, embedded contradictions, thread/message prefix registries
- `emails/emails.json` -- 144 emails across 31 threads (Acme Corp Extended Universe + semi-relevant lures)
- `slack/slack.json` -- 142 messages across 6 channels (#product-team, #customer-success, #general, #leadership, #salary-discussion, #dm-marcus-jordan)
- `calendar/calendar.json` -- 32 calendar events

### MCP Twin Servers

The MCP twin servers give the eval the same reproducible tool surface as production MCP. By registering real MCP servers in Super-MCP's config, tool calls from the agent are routed through the twin servers.

**Architecture:**
```
Rebel Core: Agent → subagent → Super-MCP → MCP twin server (stdio) → corpus data
```

**Files:**
- `evals/mcp-twins/server.ts` -- Stdio MCP server using `@modelcontextprotocol/sdk`, reads `CORPUS_DIR`/`SERVICES`/`TWIN_STATE_FILE`/`MCP_TWIN_HERMETIC` from env
- `evals/mcp-twins/server-helpers.ts` -- `buildUnknownToolResult` (per-mode twin contract; see [EVAL_HARNESS_RELIABILITY.md § MCP Twin Contract](EVAL_HARNESS_RELIABILITY.md#mcp-twin-contract-per-mode))
- `evals/mcp-twins/email-tools.ts` -- Gmail tool handlers matching real Google Workspace MCP server tool names/schemas exactly
- `evals/mcp-twins/slack-tools.ts` -- Slack tool handlers (11 tools: search, channels, history, threads, users, profiles, email lookup, workspaces, post, reply, reactions)
- `evals/mcp-twins/calendar-tools.ts` -- Calendar tool handlers (8 tools: list events, get event, get current time, list calendars, find free slots, create event, manage event, delete event)
- `evals/mcp-twins/export-tools.ts` -- Export/pipeline tool handlers
- `evals/mcp-twins/formatters.ts` -- Output formatters matching the real `formatEmailsAsText()`/`formatThreadAsText()` from `gmail-handlers.ts`
- `evals/mcp-twins/corpus-loader.ts` -- Loads and indexes corpus JSON
- `evals/mcp-twins/twin-state.ts` -- Tracks write operations (send, archive, etc.), persists to JSON on exit
- `evals/mcp-twins/__tests__/` -- 195 unit tests (email-tools, corpus-integrity, formatters, twin-state, workspace tools, helpers)

**How it works per-fixture:**
1. Eval runner writes a Super-MCP router config with the twin server as a stdio entry (command: `npx tsx evals/mcp-twins/server.ts`)
2. Super-MCP spawns the twin server process and discovers tools via MCP `listTools`
3. Agent tool calls route through Super-MCP to the twin server
4. Twin server queries static corpus JSON and returns formatted text matching the real tool output
5. Write operations (send_email, archive, etc.) are tracked in-memory and persisted to a state file for assertions

**Planning docs:**
- [Full design: `260328_reproducible_eval_dataset.md`](../plans/260328_reproducible_eval_dataset.md)
- [MCP twin server staging: `260329_mcp_twin_servers.md`](../plans/260329_mcp_twin_servers.md)

### Twin Fidelity Standards

**Import-from-production (default)**: Twin tool definitions SHOULD import from
production MCP definition files, filter to the twin's subset, and map to `Tool`
when those definitions are in-repo. This keeps descriptions, parameter names,
and schemas synchronized automatically. Once a connector's bundled source is
deleted after OSS migration, keep an eval-owned snapshot beside the twin instead:
- Gmail/Calendar: `evals/mcp-twins/google-workspace-definitions.ts` snapshots `@mindstone/mcp-server-google-workspace@0.1.0`
- Slack: `evals/mcp-twins/slack-definitions.ts`

**When production definitions are inline**: If the production MCP server keeps tool
definitions inline (not exported), extract them into a separate definitions file
first — then import from that file in both the production server and the twin. This
is what was done for Slack (`resources/mcp/slack/src/definitions.ts`). Candidates for
the same treatment if twins are ever created: Microsoft Mail, Microsoft Calendar,
Microsoft Teams (all keep definitions inline in their respective `index.ts` files).

**Eval-only exception**: Twins with no production counterpart (e.g. the export twin's
`export_quarterly_pipeline_data`) define tools inline. Document the exception in code
and in the drift-guard test.

**Drift-guard test**: `evals/mcp-twins/__tests__/twin-fidelity.test.ts` validates
that each twin's tool names are a subset of its production source. This catches
renames or removals in production before evals drift silently. The export twin is
explicitly excluded as a documented exception.

### Judge System

Each fixture result is scored by LLM judges from Anthropic (Opus 4.7), OpenAI (GPT-5.4 primary, locked 2026-05-05 for cross-run comparability), and Google (Gemini 3.1 Pro arbitrator). See [EVAL_JUDGE_PANELS.md](EVAL_JUDGE_PANELS.md) for the full panel design, escalation rules, per-judge status lifecycle, replay tooling, and configuration.

Judges score 3 weighted dimensions:

| Dimension | Weight | What it measures |
|-----------|--------|-----------------|
| Discovery & Coverage | 35% | How thoroughly the agent found relevant information across channels |
| Grounded Accuracy | 35% | Accuracy, grounding in sources, noise filtering, no hallucination |
| Deliverable Quality | 30% | Synthesis, actionability, structure, professional polish |

Fixtures can override weights via `rubricWeightOverrides`.

### Reliability

The harness is designed to survive rate-limits, timeouts, missing keys, and per-fixture crashes without aborting a run. See [EVAL_HARNESS_RELIABILITY.md](EVAL_HARNESS_RELIABILITY.md) for error preservation, retry policies, parallelism caps, watchdog semantics, and crash isolation.

**Scoring:** Single verdict per fixture:
- **Constraints** (hard gate): safety-critical binary checks (`output_must_not_contain` for fabrication/privacy/safety). 0-3 per fixture.
- **Quality** (LLM judges): median weighted score >= 3.0/5, plus grounded_accuracy floor of 2.0. Judges receive a **crib sheet** of ground-truth facts from the corpus and assess process quality from the tool trace.
- **Final verdict**: `pass` (constraints pass AND quality passes) or `fail`.
- **Composite score** (0-100): quality 75% + constraint compliance 25%. Used for model ranking.
- **Efficiency score**: composite score adjusted by log-cost penalty relative to the fixture's a priori `referenceCost` estimate.
- **Volatility flag**: `volatile: true` when judge score spread > 1.5 or agreement ratio < 50%.

**Evidence checks** (telemetry, not gated): Evidence items from the rubric (`keyEvidence`) are still collected and reported for debugging/observability. They show what the agent did or didn't do, but do not gate the verdict.

**Adaptive judge allocation** (default ON): Starts with 2 diverse judges (Anthropic + non-Anthropic). Stops early if they agree and score is far from threshold (>0.7 from 3.0). Escalates to full panel only for ambiguous cases. Use `--no-adaptive-judges` to disable.

**Claim-level factual audit** (reporting-only): Extracts 5-10 factual claims from the output and verifies each against source data. Reports supported/unsupported/contradicted rates. Does not currently affect verdicts.

### Corpus Lure Design

The corpus contains semi-relevant lure content designed to test the agent's ability to filter noise. Lures appear in the same channels as real content (not quarantined) and use vocabulary that overlaps with real entities. See `_meta.json` → `lureDesignPrinciples` for full documentation.

Key lure categories:
- **Entity disambiguation**: "Meridian Marketing Solutions" (different company, same name) in emails and calendar
- **Vocabulary overlap**: analytics tool evaluation, retention webinars, competitor blog posts — use terms like "enterprise", "seats", "SSO", "churn" but in unrelated contexts
- **Social/operational noise**: IT notifications, benefits enrollment, team celebrations — in the same inbox as real business emails
- **Temporal traps**: stale pricing ($15 vs current $18), superseded plans (Q4 vs April 15), outdated org structure

### Model Tiers

The eval mirrors production's multi-tier model setup. **Canonical ordering: Working → Thinking → Background** (user-salience / causal importance — Working drives every turn, Thinking is the optional deeper override, Background is supporting housekeeping). Use this order consistently in docs, UI, and eval reports.

| Tier | Flag | Default | What it does |
|------|------|---------|-------------|
| **Working** | `--model <name>` | `claude-sonnet-4-6` | Main agent model for all turns |
| **Thinking** | `--thinking <name>` | Same as working | Planning/reasoning model (used when plan mode activates) |
| **Background** | `--background <name>` | `claude-haiku-4-5` | Behind-the-scenes tasks (summaries, memory updates) |

A run's full configuration is the triplet above plus any active A/B-style overlays (e.g. `--showrunner`). Every result file carries the resolved triplet in `metadata.resolvedModels` and the A/B flags in `metadata.showrunnerOverlay` / `metadata.contextManagementDisabled`. The analyzer uses these to give each distinct configuration its own row in the report — see [TESTING_EVALS_KNOWLEDGE_WORK_ANALYSIS → Model Variants](TESTING_EVALS_KNOWLEDGE_WORK_ANALYSIS.md#model-variants).

**Common run configurations:**

```bash
# All reproducible fixtures with Haiku (cheapest, fastest)
node evals/build.mjs && node evals/.built.mjs --model claude-haiku-4-5 --all --tier 0

# All reproducible fixtures with Sonnet working + Haiku background (production-like)
node evals/build.mjs && node evals/.built.mjs --model claude-sonnet-4-6 --all --tier 0

# All reproducible fixtures with Opus thinking + Sonnet working + Haiku background
node evals/build.mjs && node evals/.built.mjs --model claude-sonnet-4-6 --thinking claude-opus-4-7 --all --tier 0

# Single fixture for debugging
node evals/build.mjs && node evals/.built.mjs --model claude-haiku-4-5 --fixture email-triage-inbox-priority-02 --tier 0
```

Requires provider keys in `process.env` (for example via `set -a; source evals/configs/.local/keys.env; set +a`) and a hermetic config path passed with `--config <path>`.

### Evaluating CN/SGP-origin models (MiniMax, Moonshot, DeepSeek, …)

> **Operator-gated, synthetic-only, never-commit.** This procedure deliberately relaxes a compliance guardrail. Only do it (a) with **explicit per-run permission from a human operator**, (b) for **entirely synthetic** fixtures (the `knowledge-work-reproducible` corpus qualifies — no real customer data), and (c) **without ever committing** the relaxed setting or any code change that enables it.

A brand-new CN/SGP-origin model (e.g. `minimax/minimax-m3` right after release) is often served **only** by its first-party CN endpoint on OpenRouter before any US/EU provider mirrors it. Three independent guardrails block such a model, and **all three** must be cleared to run it:

1. **Rebel `provider.only` allowlist** — `injectProviderRouting()` in `src/main/services/localModelProxyServer.ts` restricts CN/SGP-origin model prefixes to the non-CN providers listed in [`src/shared/openrouterProviderAllowlists.ts`](../../src/shared/openrouterProviderAllowlists.ts). Symptom: `404 "No allowed providers are available for the selected model"` with `available_providers:["minimax"]` and a `requested_providers` list that excludes it.
2. **Rebel `x-zdr: true` header** — `localModelProxyServer.ts` unconditionally requests zero-data-retention routing; the CN endpoint is not ZDR.
3. **Your OpenRouter account data policy** — `https://openrouter.ai/settings/privacy`. Symptom: `404 "No endpoints available matching your guardrail restrictions and data policy."` This is **account-level** (applies to every key under the account), not per-key — so a "special-purpose key" does **not** fix it; you must relax the account policy (or use a separate account whose policy is already relaxed), then revert.

**Temporary local procedure:**

1. **Local-only patch (do NOT commit).** In `src/main/services/localModelProxyServer.ts`, gate both the `injectProviderRouting()` call and the `headers['x-zdr'] = 'true'` line behind `process.env.REBEL_EVAL_ALLOW_CN_PROVIDERS === '1'` so the relaxation is off unless the env flag is set. Rebuild the bundle: `node evals/build.mjs`.
2. **Relax the OpenRouter account data policy** at `https://openrouter.ai/settings/privacy` to permit providers that don't meet ZDR (enough for the CN endpoint to become eligible). Revert this immediately after the run.
3. **Run** with the flag set in the same shell:
   ```bash
   npm run eval:capture-keys -- --apply
   set -a; source evals/configs/.local/keys.env; set +a
   export REBEL_EVAL_ALLOW_CN_PROVIDERS=1
   node evals/.built.mjs --config evals/configs/.local/knowledge-work.json \
     --model minimax/minimax-m3 --thinking minimax/minimax-m3 --background minimax/minimax-m3 \
     --core rebel-core --tier 0 --no-personas --judges anthropic,openai,google --parallel 2
   ```
   The idempotent default (committed 2026-06-04) runs only the missing/incomplete canonical fixtures; add `--rerun-all` to force a full re-run.
4. **Clean up:** `git checkout src/main/services/localModelProxyServer.ts` (drop the patch), re-revert the OpenRouter privacy setting, and `rm evals/configs/.local/keys.env`.

#### Concrete changes applied for the 2026-06-04/05 MiniMax-M3 run (and reverted after)

The OpenRouter side turned out to be **three** settings across two scopes, not one (the in-product `localModelProxyServer.ts` patch is the fourth). All were reverted/removed after the run:

1. **Account data policy** — [`/settings/privacy`](https://openrouter.ai/settings/privacy): enabled **"Paid endpoints that may train on request data"** (MiniMax's first-party endpoint is not ZDR, so this is required for it to be eligible).
2. **Workspace guardrail** — [`/workspaces/default/guardrails/<id>/models`](https://openrouter.ai/workspaces/default/guardrails/216b328b-5e34-4727-8084-fffec37d4053/models): removed **MiniMax** from the **Blocked Providers** list and clicked **Save**. (Workspace guardrails override the account policy and can only tighten — this is why a fresh key alone didn't unblock it.)
3. **API key** — [`/workspaces/default/keys`](https://openrouter.ai/workspaces/default/keys): generated a **new key with no guardrails** in the default workspace.
4. **In-product** — the `REBEL_EVAL_ALLOW_CN_PROVIDERS`-gated patch to `localModelProxyServer.ts` (step 1 above), rebuilt into `evals/.built.mjs`, then `git checkout`-reverted.

Diagnostic tip: a raw `curl` to OpenRouter (bypassing Rebel entirely) isolates account/workspace blocks from the in-product ones — `404 "No endpoints available matching your guardrail restrictions and data policy"` on a direct call means the block is account/workspace-side (#1–#3), not the proxy.

#### Future improvement (don't keep doing the uncommitted-patch dance)

The step-1 code patch is the awkward part — it requires a local edit we deliberately never commit, which is error-prone (easy to forget to revert; can't be in the bundle). Consider replacing it with a **committed, default-off CLI override flag** (e.g. `--allow-cn-providers`, or the existing `REBEL_EVAL_ALLOW_CN_PROVIDERS` env read wired into the eval entrypoint and threaded to the proxy) so the relaxation is a first-class, opt-in eval knob — no source edit, no rebuild-from-patch, and it shows up in the run manifest for provenance. The guardrail stays on by default for all non-eval use.

### Detached & multi-agent runs

A full `--tier 0 --parallel 8` run takes 30–60 min. When launching from any context where the parent shell may exit before the eval finishes (agents calling shell tools, CI jobs, scripted automation), `nohup ... &` is **not** reliable — the deep `npx → npm → tsx loader → orchestrator → worker` chain doesn't always survive SIGHUP propagation, and macOS has no `setsid`. Use a detached session manager:

```bash
# Detached run, survives parent shell exit:
screen -dmS eval-sonnet bash -c 'npx tsx evals/knowledge-work-setup.ts \
  --model claude-sonnet-4-6 --all --tier 0 --parallel 8 --provider anthropic \
  > tmp/eval-runs/eval-sonnet-$(date +%Y%m%d-%H%M%S).log 2>&1'

# Attach to watch:    screen -r eval-sonnet     (Ctrl-A D to detach again)
# Kill cleanly:       screen -S eval-sonnet -X quit
```

**Running multiple eval bundles concurrently (different agents / different models):**

- **Unique screen session names per run** (`eval-sonnet`, `eval-deepseek`, …) — `screen -dmS <name>` silently no-ops if a session of that name already exists.
- **Different providers don't share quota** (Anthropic ↔ OpenRouter ↔ Together can co-exist freely). Two runs hitting the **same** Anthropic key compete for the same RPM/TPM — either stagger them, or drop `--parallel` so combined concurrency stays under the org's limits.
- **Pre-build the bundle** with `node evals/build.mjs` before launching concurrent wizards, **or** stagger starts by ~30 s. `evals/.built.mjs` is shared and model-agnostic, but the wizard's auto-build step will race if two agents trigger it simultaneously.
- **Memory budget**: each worker is ~600–700 MB RSS. Two `--parallel 8` runs together is ~10–12 GB. Drop to `--parallel 4` (or fewer) per run on smaller machines.
- **Result filenames** already embed the model triplet + timestamp, so output JSON/MD won't collide. Live log filenames should also be timestamped (`tmp/eval-runs/<run-name>-<TS>.log`) so concurrent agents don't overwrite each other's logs.
- **`evals/configs/.local/keys.env`** is a shared local key file — avoid running `eval:capture-keys -- --apply` concurrently from multiple shells. Capture once, then source keys and run with explicit `--config <path>` on each process.
- **Super-MCP lifecycle safety:** concurrent eval bundles are protected by owner-tagged Super-MCP children, the active-owner registry, and per-orchestrator port-baseline leases. The canonical contract is [`SUPER_MCP_LIFECYCLE.md`](SUPER_MCP_LIFECYCLE.md); implementation lives in [`src/core/services/superMcpHttpManager.ts`](../../src/core/services/superMcpHttpManager.ts) and [`evals/lib/portBaselineLease.ts`](../../evals/lib/portBaselineLease.ts). If a run crashes and leaves children behind, inspect with `npm run sweep:supermcp` and clean killable stale children with `npm run sweep:supermcp -- --kill` when no live run depends on them.

### CLI Flags (`knowledge-work-setup.ts`)

| Flag | Description |
|------|-------------|
| `--model <name>` | Override working model (skips interactive Phase 2) |
| `--thinking <name>` | Override thinking/planning model (defaults to saved config, then working model) |
| `--background <name>` | Override background model (defaults to saved config, then `claude-haiku-4-5`) |
| `--tier <0\|1\|all>` | Scenario tier (default `0`): `0` reproducible-only (canonical knowledge-work-reproducible/, the 30 **static-response** default-enabled fixtures), `1` workspace-only (knowledge-work-ws/, personalised), `all` everything including knowledge-work-organisation/. Use `--suite knowledge-work-organisation` to run the organisation tests on their own. The 9 **persona-overlay** fixtures (`defaultDisabled: true`) are gated behind `--personas`. |
| `--all` | Run all fixtures (skips interactive Phase 2). For default canonical tier-0 static-response runs, coverage planning still skips already-good fixtures unless `--rerun-all` / `--no-skip` is set. |
| `--family <name>` | Filter to one family |
| `--fixture <id>` | Run a single fixture |
| `--single-judge` | Use only 1 judge (picks Opus) |
| `--judges <list>` | Comma-separated judge providers |
| `--runs <N>` | Runs per fixture |
| `--parallel <N>` | Worker count (1-8). Default (no flag) is provider-aware: OpenRouter=2 (rate-limit headroom), Anthropic=4, Codex=1. Explicit `--parallel N` always wins. Added 2026-04-28. |
| `--provider <auto\|anthropic\|openrouter\|codex>` | Force a specific provider for the bundle, instead of letting the bootstrap auto-detect from OR-format model IDs. Added 2026-04-28. `--provider anthropic` rejects bundles containing OR-format models; `--provider openrouter` requires `OPENROUTER_API_KEY` in env. Default `auto` keeps the OR-format-detection heuristic. |
| `--retries <N>` | Per-fixture retry budget for transient errors (rate_limit / watchdog stall). Default `2`; max `5`; `0` disables retries. Schedule: rate_limit 30s/90s/270s exponential capped, watchdog single 90s retry, ±20% jitter. Each retry's reason is recorded in `result.retryReasons`. Added 2026-04-28. |
| `--dry-run` | Show what would run |
| `--no-adaptive-judges` | Disable adaptive judge allocation (run all judges always) |
| `--personas <id\|mix\|none>` | Enable persona-driven multi-turn overlay (260512 plan). Defaults to `none` / unset in the setup wizard. When set to a non-`none` value, the run switches from the **static-response** default (canonical 30 played as single-turn pre-scripted prompts) into **persona-overlay** mode: both the LLM-driven persona simulator loop runs across every fixture AND the 9 **persona-overlay-only** fixtures gated by `defaultDisabled: true` are added to the corpus. `--no-personas` is the explicit off switch forwarded by the wizard/orchestrator to worker subprocesses so logs show persona overlay was intentionally disabled. |
| `--rerun-all` / `--no-skip` | Bypass canonical coverage planning and run the full selected canonical tier-0 fixture set even when prior clean results exist. |

**Non-interactive mode:** Any of `--model`, `--all`, `--thinking`, `--background`, or `--tier` enables non-interactive mode, which skips Phase 2 (test plan) and the confirmation prompt. This requires either:
- Provider keys already present in env (e.g. `set -a; source evals/configs/.local/keys.env; set +a`), OR
- An interactive terminal (TTY) for first-run setup

If stdin is not a TTY and no saved config exists, the wizard fails fast with an actionable error. For fully headless CI usage, create/select the config once, then run with explicit `--config <path>`. Alternatively, bypass the wizard entirely: `node evals/build.mjs && node evals/.built.mjs --config evals/configs/default.json --model <name> [flags]`.

### File Layout

```
evals/
├── knowledge-work-setup.ts         # Interactive setup wizard + launcher
├── knowledge-work.ts               # Eval runner (fixtures, agent, judges, metrics)
├── knowledge-work-bootstrap.ts     # Headless production agent bootstrap
├── knowledge-work-event-adapter.ts # AgentEvent → eval data structure adapter
├── knowledge-work-workspace.ts     # Workspace snapshot/sandbox management
├── knowledge-work-trusted-tools.ts # Classification + trusted-tool builder for hermetic twins
├── rebel-core-loop.ts              # Standalone Rebel Core eval loop (legacy SDK comparison removed)
├── generate-eval-catalog.ts         # Catalog generator (frontmatter + derived metadata → Markdown/JSON)
├── build.mjs                       # esbuild bundler (→ .built.mjs)
├── configs/
│   ├── default.json                # Baseline hermetic config template
│   ├── local-byo-ds4.json          # Local-model template example
│   ├── README.md                   # Config schema + key-capture workflow
│   ├── types.ts                    # HermeticEvalConfig schema (SSOT)
│   ├── loader.ts                   # resolveEvalRun / env credential resolution
│   └── .local/                     # gitignored local configs + keys.env
├── CONFIG_README.md                # Legacy pointer to evals/configs/README.md
├── judgePanel.ts                   # Canonical judge primitives (callJudge, runAllJudges, etc.)
├── replay-judge.ts                 # eval:replay-judge CLI for backfilling failed judges
├── .built.mjs                      # Built bundle output (gitignored)
├── knowledge-work-helpers.ts        # Shared helpers (walkSandboxFiles, checkEvidence, evidence types)
├── mcp-twins/                      # MCP twin servers (real MCP protocol, serves corpus data)
│   ├── server.ts                   # Stdio MCP server entry point (email + Slack + calendar + export)
│   ├── email-tools.ts              # Gmail tool handlers
│   ├── slack-tools.ts              # Slack tool handlers (11 tools)
│   ├── calendar-tools.ts           # Calendar tool handlers (8 tools)
│   ├── export-tools.ts             # Export/pipeline tool handlers
│   ├── formatters.ts               # Output formatters matching real MCP servers
│   ├── corpus-loader.ts            # Loads corpus JSON files
│   ├── twin-state.ts               # Write operation tracking
│   └── __tests__/                  # Twin server unit tests
│       ├── email-tools.test.ts
│       ├── slack-tools.test.ts
│       ├── calendar-tools.test.ts
│       ├── corpus-integrity.test.ts
│       ├── formatters.test.ts
│       ├── twin-fidelity.test.ts
│       └── twin-state.test.ts
├── __tests__/                      # Eval harness unit tests
│   ├── knowledge-work-trusted-tools.test.ts
│   ├── knowledge-work-event-adapter.test.ts
│   ├── knowledge-work-workspace.test.ts
│   └── knowledge-work-helpers.test.ts
├── fixtures/
│   ├── knowledge-work/             # Synthetic fixtures by family
│   │   ├── meeting-prep/
│   │   ├── email-drafting/
│   │   └── research-synthesis/
│   ├── knowledge-work-ws/          # Workspace fixtures (depend on real workspace)
│   └── knowledge-work-reproducible/# Reproducible fixtures (no personal data)
│       ├── corpus/                 # Static data for tool twins
│       │   ├── _meta.json          # Reference date, personas, contradictions
│       │   ├── emails/emails.json  # 144 emails, 31 threads
│       │   ├── slack/slack.json    # 142 messages, 6 channels
│       │   └── calendar/calendar.json # 21 events
│       ├── personal-workspace/     # Acme Corp personal workspace (copied into sandbox)
│       │   ├── Chief-of-Staff/     # Personal space (memories, skills)
│       │   └── work/ACME Corp/     # Company + team spaces
│       └── *.json                  # 18 reproducible fixtures (8 standard + 4 cross-channel + 6 advanced: judgment, security, context_stress)
results/                            # Repo fallback output (gitignored); default goes to Google Drive when available
└── knowledge-work/                # Knowledge-work results (flat, filenames carry timestamps)
```

### Analysis Schema Version (`KNOWLEDGE_WORK_ANALYSIS_VERSION`)

Every result file the runner writes carries an `analysisSchemaVersion` (`major.minor`) in its `metadata`. [EVAL_CORPUS_IDENTITY.md](EVAL_CORPUS_IDENTITY.md#analysisschemaversion) is the canonical doc for the major/minor bump policy and how schema version combines with corpus identity and judge-panel identity for score comparability.

### Routing eval bundles through non-OR providers (Together / custom OpenAI-compatible)

The eval bootstrap supports profile-backed bundles for any `providerType` Rebel
recognises (`openai`, `google`, `together`, `cerebras`, `local`). Pass the
profile's ID — **prefixed with `profile:`** — to `--thinking` / `--model` /
`--background`, e.g. `--thinking profile:deepseek-v4-pro-thinking-he`. The
bootstrap's `activateTierBundle` will:

1. Decode the `profile:<id>` prefix and look up the profile by its `id`
   field in `localModel.profiles[*]`,
2. Set `claude.workingProfileId` / `thinkingProfileId` / `behindTheScenesModel: profile:<id>`,
3. Start the local model proxy with the resolved profile, which sends requests
   to that profile's `serverUrl` using the resolved key from `providerKeys`.

**Bare model strings are inert as of Stage B of 260514 hardening.** Passing
`--thinking deepseek-ai/DeepSeek-V4-Pro` (no `profile:` prefix) will NOT
match a local profile, even if exactly one profile has that `model` value.
Instead the resolver emits a one-shot `[eval-bootstrap]` warning listing
the `profile:<id>` migration lines for each candidate profile, and falls
through to the catalog route (which will then fail-closed at activation if
the bare string doesn't resolve elsewhere). This prevents silent injection
of local app-settings state into bundle identity. See
[`docs-private/postmortems/260514_eval_collapse_degraded_propagation.md`](../../docs-private/postmortems/260514_eval_collapse_degraded_propagation.md)
for the gpt-5.4 contamination incident that motivated the change, and
[`docs/plans/260514_eval_bundle_reproducibility_hardening.md`](../plans/260514_eval_bundle_reproducibility_hardening.md) § Stage B
for the full design rationale.

OR routing is **not** triggered when every slashed model in the bundle has a
matching local profile — the `looksLikeOrModel` heuristic in
`resolveActivationProvider` excludes profile-backed slashed IDs.

**Together.ai (OpenAI-compatible at `https://api.together.xyz/v1`)** has been
exercised end-to-end with `deepseek-ai/DeepSeek-V4-Pro`. Two bugs were fixed
along the way and are now covered by tests:

- `normalizeSettings` would silently fall back to `DEFAULT_MODEL` for any
  slashed working/thinking model unless `activeProvider === 'openrouter'`. It
  now exempts slashed models that match a local profile. See
  `src/shared/utils/__tests__/settingsUtils.test.ts` (search for
  "Together pattern").
- The eval cost gate (`isModelSupported` in `pricingCalculator`) requires every
  model to have an entry in `MODEL_CATALOG`. New non-OR-hosted models must be
  added with the lowercase ID (`resolveModelAlias` lowercases its input before
  lookup) — e.g. `id: 'deepseek-ai/deepseek-v4-pro'` even though the upstream
  API ID and `profile.model` use mixed case.

**Smoke run (260429):** A full reproducible-corpus pass was attempted with
DeepSeek V4 Pro on Together at `--parallel 1 --retries 0`. Together's V4 Pro
endpoint cold-starts on first call and serialises long requests; smoke
fixtures stayed below the 15-min auto-abort but the agent's first turn took
over 10 minutes to produce its first output. Sustained throughput was too low
for a reasonable full-corpus run on V4 Pro. V3.x models are likely faster and
cheaper, but Together does **not** host a "DeepSeek V4 Flash" SKU — V4 Pro is
the only V4-tier option. Smaller V3.x models (V3.2, V3.1) remain candidates if
V4 Pro proves consistently slow.

**Adding a new Together-hosted model** (recipe):

1. Confirm the model ID and pricing via
   `curl -H "Authorization: Bearer $KEY" https://api.together.xyz/v1/models`
   (Cloudflare's WAF requires a real `User-Agent` header).
2. Add a profile in the hermetic eval config you run with `--config` (for
   example `evals/configs/.local/together-v4.json`). Use `providerType:
   'together'`; set `serverUrl`/`model` exactly to Together's upstream values
   (mixed-case model IDs are fine).
3. Add the model to `src/shared/data/modelCatalog.ts` with
   `provider: 'together'` and lowercase `id`. Pricing values come straight from
   the API response (`pricing.input` / `pricing.output` per million tokens;
   `cached_input` maps to `cacheRead`).
4. Run the eval with `--provider auto` (the activate-bundle resolver detects
   the profile match and skips OR routing automatically).

### Known Limitations (Knowledge Work Eval)

- **Per-fixture semantic indexing with caching:** The first corpus fixture builds a fresh LanceDB index (~15s). Subsequent corpus fixtures reuse the cached index via copy-and-rewrite (~1-2s). Non-corpus fixtures still build fresh indexes.
- **CPU-only embeddings:** The eval uses CPU backend for `bge-small-en-v1.5` embeddings (GPU backend requires Electron's native process). Performance is adequate for eval-sized corpora.
- **First-run model download:** The ONNX model (~50MB) is auto-downloaded to `~/.cache/huggingface/` on first use. Subsequent runs use the cached model. CI environments should cache this directory.
- **No automatic runtime index updates:** The semantic index is built once per fixture before the first turn starts. Multi-turn fixtures can opt into rebuilding it after a specific turn with `turn.rebuildIndex: true`, but there is still no automatic incremental indexing of newly written files.
- **Embedding worker bridge:** The eval uses a `child_process.fork` shim (`evals/eval-embedding-worker-bridge.cjs`) to bridge Electron's `utilityProcess` API. The pre-built worker at `out/main/workers/embeddingWorker.js` must exist (built by `scripts/build-worker.mjs`, which runs as part of the normal dev build).
- **Synthetic fixture isolation:** Synthetic fixtures create bare sandboxes with only their seed files (no real workspace data). This is intentional -- evals must be reproducible across developers. Workspace fixtures (`evals/fixtures/knowledge-work-ws/`) still use the real workspace.
- **No contacts MCP twin:** Fixtures that would ideally check `search_contacts` or `get_contact` use `output_contains` fallback checks instead. A contacts twin could be added if contact lookup becomes a common eval pattern.

---

## Adding New Fixtures

> **Prefer enrichment over creation.** Before adding a new fixture family, check existing families and the `capabilities` tags on existing fixtures for coverage gaps. Add variants (new edge cases, difficulty tiers, capability combinations) to existing families where possible. See [Enrichment over Creation in WRITING_EVALS.md](WRITING_EVALS.md#enrichment-over-creation).

### Knowledge-Work Reproducible Fixtures

**Fixture JSON schema** (all fields):

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique kebab-case identifier |
| `version` | Yes | Schema version (currently `1`) |
| `family` | Yes | Family name: `email_triage`, `email_drafting`, `meeting_prep`, `research_synthesis`, `cross_channel`, etc. |
| `difficulty` | Yes | `easy`, `medium`, or `hard` |
| `source` | Yes | `"reproducible"` |
| `reproducible` | Yes | `true` |
| `corpusWorkspace` | Yes | `true` — required so the harness routes the fixture through `createReproducibleSandbox` (hermetic MCP + Acme Corp workspace). Without it the fixture is silently demoted to a synthetic-empty sandbox with non-hermetic MCP and the user's real workspace visible. |
| `defaultDisabled` | No | When `true`, fixture is excluded from the default eval run and only included when `--personas` is set. This is the field that distinguishes the **static-response** default set (the canonical 30, used by every run out of the box) from the **persona-overlay** opt-in set (the 9 fixtures gated behind `--personas`, introduced 2026-05-13 — see commit `314bbc27b`). Skipped when `--fixture <id>` explicitly selects the fixture. |
| `dateAdded` | Yes | ISO date string (YYYY-MM-DD) |
| `canonicalSince` | Conditional | ISO date (`YYYY-MM-DD`) recording when this fixture became canonical (chart-eligible). **REQUIRED on every fixture that is neither `defaultDisabled: true` nor `calibration: true`**, enforced in CI by `validate:eval-canonical-fixtures` (see [Adding a canonical fixture](#adding-a-canonical-fixture)). |
| `gate` | Yes | `"regression"` (target ~100% pass) or `"discovery"` (exploratory) |
| `rubricVersion` | Yes | `"1.0"` |
| `prompt` | Yes* | Legacy single-turn prompt. Required unless `turns` is provided. |
| `turns` | Yes* | Multi-turn conversation sequence. Takes precedence over `prompt` when present. |
| `workspaceSeed.files` | Yes | Array of overlay files (can be `[]` if corpus workspace is sufficient) |
| `rubric.keyEvidence` | No | Aggregate evidence checks run across the full multi-turn output/tool trace. Still the main rubric for legacy single-turn fixtures. |
| `expectedArtifacts` | No | Human-readable description of expected output |
| `mustNotDo` | No | Array of strings -- actions the agent must NOT take |
| `cribSheet` | No | Array of ground-truth facts for judges (next-gen scoring). 5-12 atomic facts verifiable against corpus. |
| `constraints` | No | Array of `ConstraintItem` safety-critical checks (next-gen scoring). Hard gate, 0-3 per fixture. |
| `referenceCost` | No | A priori cost estimate: `{ inputTokens, outputTokens, reasoning }`. Used for efficiency scoring. |
| `maxTurns` | No | Max agent turns (default 15; use 20 for hard multi-channel) |
| `capabilities` | No | String array of capabilities exercised (e.g., `["email-search", "cross-channel", "large-output"]`). Discovery metadata for humans/agents — not used at runtime. When adding a new variant to a family, include capabilities to make coverage gaps visible. |
| `description` | Yes | 1-2 sentence human-readable summary of what the fixture tests. |
| `whyItExists` | Yes | Why this fixture is needed as a separate test — what would be lost if it were merged away. Key for consolidation decisions. |
| `corpusEntities` | Yes | Array of Acme Corp entities the fixture depends on (e.g., `["TechForward", "Meridian", "Lisa Park"]`). Can be `[]` for entity-independent fixtures. |
| `overlapsWith` | Yes | Array of fixture IDs that test similar things. Must be symmetric (if A overlaps B, B should overlap A). |
| `estimatedCost` | Yes | `"low"`, `"medium"`, or `"high"` — expected API cost/context usage. |
| `primaryJudgeDimensions` | Yes | Top 2-3 judge dimensions this fixture primarily exercises: `discovery_coverage`, `grounded_accuracy`, `synthesis_judgment`, `usefulness_actionability`, `professional_polish`. |

\* A fixture must define either `prompt` or `turns`.

### Adding a canonical fixture

The analyzer's Model Performance chart uses **binary full-coverage filtering**: any model variant that hasn't run all canonical fixtures is excluded from the chart entirely (and listed in the partial-coverage table instead). Adding a new canonical fixture without first backfilling existing variants therefore empties the chart for every variant that has otherwise-complete coverage.

Two incidents in May 2026 exposed this — see [`docs/plans/260518_kw_eval_canonical_drift_and_rerun_cells.md`](../plans/260518_kw_eval_canonical_drift_and_rerun_cells.md) for the postmortem.

**To add a NEW fixture that is not yet ready to be canonical** (most common):

1. Create the fixture JSON with `"defaultDisabled": true` at the top of the file (alongside `corpusWorkspace`).
2. Do NOT add `canonicalSince`.
3. Commit. The CI gate (`validate:eval-canonical-fixtures`) accepts this because `defaultDisabled: true` excludes the fixture from the canonical set.
4. Iterate freely. The fixture remains explicitly runnable via `--fixture <id>` and shows up in `--personas` runs.

**To PROMOTE a `defaultDisabled` fixture to canonical** (when it's stable and the team wants it in Model Performance):

1. Run the fixture against every production model variant that should appear in Model Performance. Typical command shape:

   ```bash
   npx tsx evals/knowledge-work.ts --fixture <id> --working-model <model> --thinking-model <model> --background-model <model> --runs 1
   ```

   Repeat for each variant. Each result JSON drops into `Shared drives/Product/evals/results/knowledge-work/` (or wherever `EVAL_RESULTS_DIR` points).

2. Regenerate the analyzer HTML and confirm the chart still populates (i.e. each variant's `fixtures_fully_complete_and_judged` count now includes the new fixture).

3. In the SAME commit:

   - Remove `"defaultDisabled": true` from the fixture JSON.
   - Add `"canonicalSince": "YYYY-MM-DD"` (today's date) right after `dateAdded`.
   - Update `evals/__tests__/analyze-knowledge-work-canonical-corpus.test.ts` if the canonical-id snapshot needs regenerating (`npx vitest run evals/__tests__/analyze-knowledge-work-canonical-corpus.test.ts -u`).

4. Commit message should reference both the backfill artefact (run IDs or dataset paths) and the promotion.

**What the CI gate catches**

`validate:eval-canonical-fixtures` (wired into `validate:fast`) fails when:

- A fixture is canonical (neither `defaultDisabled` nor `calibration`) and missing `canonicalSince`.
- `canonicalSince` is not a strict `YYYY-MM-DD` string.
- `canonicalSince` does not round-trip through `Date.toISOString()` (catches non-calendar dates like `2026-02-30`).
- `canonicalSince` is more than 24h in the future (catches typos and bypass attempts).
- Any JSON in the canonical-fixtures tree is malformed (the loader silently warns and skips; the gate is stricter).

**What the gate does NOT catch**

The gate is a forcing function, not a proof of backfill. A fixture can pass the gate with `canonicalSince: "2026-05-18"` set even though no actual backfill happened. That mitigation is structural: the analyzer's partial-coverage table will reveal the un-backfilled promotion on the next analyzer run, and Model Performance will show empty until the backfill lands. PR reviewers should also sanity-check that a promotion commit is paired with backfill results.

### Catalog Generator

Generate a scannable catalog of all reproducible fixtures:

```bash
npx tsx evals/generate-eval-catalog.ts              # Markdown to stdout
npx tsx evals/generate-eval-catalog.ts --output FILE # Write to file
npx tsx evals/generate-eval-catalog.ts --json        # JSON output
```

The catalog extracts manual frontmatter plus derives MCP channels, turn count, evidence count, and cost from existing fixture data. It also renders overlap clusters (connected components from `overlapsWith` relationships) and a frontmatter completeness report.

The fixture test suite (`evals/__tests__/knowledge-work-fixtures.test.ts`) enforces that all fixtures have complete frontmatter fields with valid values.

**Multi-turn turn schema:**

```json
{
  "prompt": "Follow-up instruction for this turn",
  "rubric": {
    "keyEvidence": [
      { "id": "t2-e1", "description": "Checked memo structure", "check": "output_contains", "pattern": "memo|summary" }
    ]
  },
  "rebuildIndex": true
}
```

- `turn.prompt` is required for each turn.
- `turn.rubric` is optional and is evaluated against that turn's own output/tool trace.
- `turn.rebuildIndex` is optional. Use it when turn N writes files that turn N+1 must be able to find through semantic search.
- If both `turns` and top-level `rubric` are present, turn rubrics run per turn and the top-level rubric runs once across the combined multi-turn run.

**Evidence check types:**

| Check | Fields | Description |
|-------|--------|-------------|
| `tool_used` | `pattern` | Regex matched against tool names in the agent's tool call trace |
| `output_contains` | `pattern` | Regex matched (case-insensitive) against the agent's final text output |
| `file_accessed` | `path` | Exact path match against Read/ListDir tool inputs |
| `file_accessed_pattern` | `pattern` | **Glob** matched against Read/ListDir/Glob/Grep tool inputs. MUST use `**/*keyword*` format, not bare keywords |

**Rubric design guidelines:**
- Aim for **8-12 key evidence items** per fixture (sweet spot for signal without over-constraining)
- Always include `tool_used` checks for each MCP channel the fixture depends on
- Use `output_contains` with entity+fact regex patterns (e.g., `James Liu.*(moat|ARR)`) -- not bare keywords that could pass by echoing the prompt
- Use `file_accessed_pattern` with `**/*keyword*` globs (NOT plain substrings -- the glob matcher uses `^...$` anchoring)
- For cross-channel fixtures, include `output_contains` checks that validate data points only obtainable by combining channels

**Common pitfalls:**
- `file_accessed_pattern` bare keyword `TechForward` will NOT match `Chief-of-Staff/.../TechForward-Inc.md` -- use `**/*TechForward*` instead
- `output_contains` patterns are regex -- escape dots (`\\.`), dollar signs (`\\$`), and parentheses
- Agent tool discovery is the most common failure mode (~33-50% of fixtures) -- don't set evidence thresholds too high

**Corpus data conventions:**

The shared corpus uses prefix registries to avoid cross-entity contamination. When adding new corpus data:

| Thread ID prefix | Entity | Notes |
|------------------|--------|-------|
| `thread_NNN` | Original corpus | General ops, product, deals (pre-March 15) |
| `thread-atlas-*` | Atlas Digital | Isolated via LEADS labels, never INBOX/UNREAD |
| `thread-tf-*` | TechForward Inc | At-risk customer, churn rescue |
| `thread-mh-*` | Meridian Health | Enterprise prospect, QBR prep |
| `thread-board-*` | Board/strategy | Exec and board communications |

| Email message ID prefix | Entity |
|--------------------------|--------|
| `msg_NNN` | Original corpus |
| `atlas-em-*` | Atlas Digital |
| `tf-em-*` | TechForward |
| `mh-em-*` | Meridian QBR |
| `bm-em-*` | Board/market |

When adding new entities: choose a unique 2-3 letter prefix, register it in `_meta.json` prefix registries, add corpus integrity tests in `evals/mcp-twins/__tests__/corpus-integrity.test.ts`, and update `_meta.json` total counts.
