---
description: "Process for triaging and implementing prior postmortem and plan recommendations — lifecycle states, weekly staleness scan, clustering, the generated shortlist, and the drain loop"
last_updated: "2026-06-12"
---

# Implementing Prior Postmortem & Plan Recommendations

Closing the **action gap**: we diagnose recurring failure modes precisely (postmortem `[BUG-PREVENTION]` trailers, prevention ideas buried in old plans) and then ship the next instance of the same bug anyway. This doc is the process for *keeping the recommendation queue honest and actually implementing the highest-leverage items*.

> **Origin.** Triggered by the Chief Pathologist 30-day unified report's **qa13** ("prior-recommendations half-life"): of 67 augmented bugs in a 30-day window, 35 (52%) had a prior postmortem recommendation that would have prevented them, and only 4 (11% of present) were implemented. The 2026-05-15 deep-dive found an even starker 27/79 with **zero** implemented. qa13's own commentary calls a persistent red bar here *"the single highest-leverage process improvement on the board."* This doc operationalizes that.

> **Terminology — this is NOT a "trawl" in the repo's sense.** [`CHIEF_PATHOLOGIST_TRAWL`](../../coding-agent-instructions/workflows/CHIEF_PATHOLOGIST_TRAWL.md) funnels for bug *fixes missing postmortems* (backfill). This process is the inverse-direction sibling: it funnels for *recommendations missing implementations*. Early rounds did this by hand-mining the index ("recommendation mining"); since the 2026-06-12 bulk triage the funnel below maintains a generated shortlist, so drains **pick, not mine**.

---

## The source of truth

The recommendations index is **regenerate-on-analysis** (since 2026-06-07): the full index is *not* committed. Run `npm run regenerate:postmortem-recommendations` to build it to `docs-private/postmortems/_index_recommendations.generated.yaml` (gitignored) via [`scripts/postmortem-recommendations-tracker.ts`](../../scripts/postmortem-recommendations-tracker.ts), which extracts `[BUG-PREVENTION]` JSON trailers across the postmortem corpus and merges the curated overrides. Two files are **committed** curation:

- `docs-private/postmortems/_recommendations_overrides.yaml` — the hand-curated `manual_overrides`, keyed by recommendation fingerprint (`bug_id + action_type + description` hash). Carries status transitions, their typed metadata, and row-level `cluster_id` assignments (a curation-only entry — `cluster_id` with no status change — is valid for open rows).
- `docs-private/postmortems/_recommendations_clusters.yaml` — the cluster catalog: **metadata only** (`cluster_id`, `title`, `canonical_statement`, optional `surface_hint`). Member lists are *generated* by the tracker from the row-level `cluster_id` entries; never maintain them in the catalog.

Parity is gated in `validate:fast` (`npm run validate:postmortem-recommendations`): overrides must parse as strict YAML with the per-status required metadata below, every fingerprint must match exactly one live recommendation, every row-level `cluster_id` must exist in the catalog (fail), and a catalog cluster with zero live members warns (prune signal). (For current scale and status mix, regenerate the index and read its summary block — any counts recorded in this doc would be stale within days.)

### Lifecycle states

`open` is the *default*, not a verified claim: **anything never curated reads `open` regardless of whether it was already implemented**, so `open` is not proof a recommendation is unimplemented — that's why the verify-not-done gate below is mandatory. Every status override also carries `last_revisited: <YYMMDD>`.

| Status | Meaning | Required metadata |
|---|---|---|
| `open` | Default. Never curated, or curated-and-verified-still-todo. | — |
| `implemented` | Verified shipped, with artifact evidence (commit/file/test, not the row's own claim). | — |
| `rejected` | Evaluated and declined. | `rejection_reason` + typed `reason_kind` (`target-gone`, `superseded`, `over-engineering`, `covered-elsewhere`, `other`) |
| `wont-do` | Evaluated; not worth doing (duplicate claim, noise, vague). | `rejection_reason` |
| `absorbed` | Durable content folded into a doc or represented by a cluster; the row exits the queue. | `absorbed_into` (doc path, `cluster_id`, or fingerprint) |
| `blocked-on-signal` | Right action is to wait for a named trigger, not implement now. | `revisit_signal` (+ optional `owner`) |

**Live queue definition:** `status == open && !is_quarantined` — the tracker's `live_queue_count` in the generated summary. Use this definition everywhere; older "re-score excluding `status: implemented`" mining language is obsolete and would misread the newer states (a `blocked-on-signal` or `absorbed` row is not workable inventory). Quarantined rows (synthetic no-recommendation placeholders, freeform off-vocabulary action types) are flagged `is_quarantined` by the tracker and are never scored, clustered, or bulk-routed.

Plans (`docs/plans/<YYMMDD_slug>/`) remain a **secondary, fuzzier source** of unimplemented good ideas (deferred stages, `Discovered Improvements`, reviewer suggestions that never landed). They are not structured like the recommendation index and require GPT-assisted mining; still pending a de-risk sample (see Run history).

---

## The funnel

```
weekly: scan → verify candidates → close with evidence
        regenerate clusters + hot-list + shortlist
drain:  pick assigned slice from the generated top-50 (clusters = the unit; claims demote the shortlist)
        → verify-not-done → evaluate → APPROVE → implement (CHIEF_ENGINEER2) → signpost back
```

### 1. Weekly staleness scan → verified closures

Run `npx tsx scripts/recs-staleness-scan.ts` (report-only; never writes overrides; also reports stale in-flight claims as GC candidates). Four detectors: **shipped-language** (closure phrasing / commit SHAs in open descriptions), **dead-target** (every referenced repo path gone), **family-supersession** (open row whose cluster has an implemented member), **stale-blocked** (`blocked-on-signal` rows past the revisit threshold — see the no-second-deferral rule below). Candidates are *not* closures: each requires per-row artifact verification (the SHA exists and contains the claimed work; the target is genuinely gone) before an override is written, using the lifecycle vocabulary above (`implemented` / `rejected`+`reason_kind` / `absorbed`).

### 2. Clusters are the drain unit

Many recommendations restate the same structural fix. The cluster catalog gives each such family one `cluster_id` and a canonical statement; the tracker generates member lists and the shortlist surfaces a cluster as **one item**. Implementing the canonical fix closes the whole cluster (member rows → `implemented` or `absorbed: <cluster_id>` as evidence warrants). When triaging a new rec that restates an existing cluster, attach `cluster_id` rather than treating it as new work. Clusters are **queue entries, not stage descriptions**: a drain that picks one must split it into crisp executable stages in its own plan — broad clusters are scoping containers, not implementable as-is.

### 3. Demand-driven hot-list

`npx tsx scripts/recs-hotlist.ts` reads the newest pathologist run (override: `--reports-root` / `RECS_HOTLIST_REPORTS_ROOT`) and emits the fingerprints implicated in *recent bugs* to `docs-private/postmortems/_recs_hotlist.generated.json` (gitignored). The signal source is the optional `prior_recommendation_fingerprints` field on `[BUG-POSTMORTEM-AUGMENT]` lines (see [`CHIEF_PATHOLOGIST`](../../coding-agent-instructions/workflows/CHIEF_PATHOLOGIST.md) Phase 8) — a recommendation a fresh bug just implicated is recurrence evidence and jumps the queue. Forward-only by design: older augment lines lack the field, so an empty hot-list is normal, not an error.

### 4. Generated shortlist (the top-50)

`npx tsx scripts/recs-shortlist.ts [--hotlist <path>] [--top <n>]` ranks the live queue deterministically — hot-listed items first, then `drain_ready`, then type tier (`type_constraint`/`ci_check`/`lint_rule` > `test_coverage` > rest), then priority, then recency — with a per-item rationale field saying which rule placed it. The `drain_ready` flag demotes rows whose own text marks them "NOT drain-now" / spike-first / design-pass: they sink below drain-ready items and need an explicit readiness decision (spike or design pass) before earning an implementation slot. **Drains pick from this list instead of mining the index.** (A numeric weighted score was deliberately rejected; revisit only if the baseline ordering demonstrably misorders against drain picks twice.) The pathologist data files (`qt3_surfaces`, `qa15_bug_families`, `qa16_intervention_roi` under the latest `droid-pathologist-reports` run) still inform *judgment among* the top items — a rec on a surface that's actively bleeding beats an equal-ranked one that isn't.

**Parallel drains — claims.** Whoever launches parallel drains batch-claims each run's assignment in **one commit at launch** (`npx tsx scripts/recs-claim.ts claim <ids...> --run <slug>`) — that claim commit *is* the dispatch manifest, no separate artifact. Drains never write claims mid-run: release is implicit (closing the rows in step 8 makes a claim inert) and TTL expiry covers abandoned runs. The shortlist demotes claimed units below all unclaimed ones — demote-don't-hide, with claimant + claim age in the rationale — so a late or ad-hoc drain regenerating the shortlist sees who already owns what. Schema, TTL, and merge-resolution rules live in the claims-file header (`docs-private/postmortems/_recommendations_claims.yaml`) and the `recs-claim` CLI help, not here.

### 5. Verify-not-done (gate)

For each pick, **prove it is genuinely unimplemented** by searching the live codebase (the lint rule, test, CI job, type, doc, or guard it asks for). Use GPT (Codex CLI read-only) + a Claude subagent for a cross-family check. If already done → mark `implemented` in `manual_overrides`, skip. Mandatory because `open` is unverified (see Lifecycle states).

> **Expect a high already-done rate when draining same-week CE2 `bug_mode` bugs.** Heavy fix sessions increasingly ship their own `implement_now` prevention recs in-run, so the gate's job is often to *close* (mark implemented) rather than build — that closure is the value (it shuts the qa13 action gap and prevents a redundant drain). The cross-family check is not optional polish: a single-name `grep` can miss an implementation whose marker is shaped differently than the rec's prose (e.g. a predicate `isResultAffectingStreamEvent()` rather than a `resultAffecting` field), and Codex/Claude reading the actual code catches that — in both directions (it also catches a rec you think is done but isn't, e.g. a raw `JSON.parse(...) as AgentSession` hidden inside a nested call your regex skipped).

### 6. Evaluate → APPROVE

For survivors, assess with **GPT + Claude subagent review (cross-family)**: is it actually a good idea (not over-engineering, not a band-aid)? feasible? cost? regression risk? Then present a shortlist (volume set per run; the weekly drain is ~3–5 items) with rationale, hotspot linkage, cost estimate, and grouping — batching several small items on one surface into one run is cheaper. **Stop for user approval before implementing** unless the run's scope was pre-delegated.

**No-second-deferral rule.** A drain that *evaluates* a recommendation and decides not to implement it must not leave it `open` for the next drain to re-evaluate. Transition it: `blocked-on-signal` with a **named, checkable** `revisit_signal` (e.g. "revisit when X recurs / when Y ships"), or `rejected` with `reason_kind`. The scanner's stale-blocked detector is the mechanical backstop — deferred rows past the threshold resurface as a repeated-deferral report rather than silently rotting.

### 7. Implement

Each approved item (or batched group/cluster) runs through [`CHIEF_ENGINEER2`](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) — default-on **worktree**, planning folder, and **heavy GPT + cross-family subagent review**. Each gets its own `docs/plans/<YYMMDD_slug>/`.

### 8. Signpost back (definition of done)

When a recommendation is implemented, **two updates** close the loop:

1. **`_recommendations_overrides.yaml`** — add a `manual_overrides:` entry keyed by fingerprint with `status: implemented` and `last_revisited: <YYMMDD>` (other statuses need their typed metadata per the Lifecycle states table). For a cluster, close every member with evidence. The parity gate fails if a fingerprint no longer matches a live recommendation, so keep entries current.
2. **The source postmortem (or plan)** — append an implementation signpost near its `[BUG-PREVENTION]` trailers / Augmentation section, e.g.:
   > `### Recommendation Implemented (260531)` — *"lint_rule (RC2): extended known-condition selector — implemented in `docs/plans/260531_known-condition-lint-companion/`."*

   This makes the postmortem self-documenting: a future reader (or the next qa13 run) sees the prevention action was actually shipped, and where.

After a batch, regenerate the index and run the parity check so the committed curation stays in lockstep. Closure quality rules (replay the incident topology; track deferred residuals) are in [`CHIEF_PATHOLOGIST`](../../coding-agent-instructions/workflows/CHIEF_PATHOLOGIST.md) § Closure rules.

---

## Tooling reference

| Tool | One-liner |
|---|---|
| [`scripts/postmortem-recommendations-tracker.ts`](../../scripts/postmortem-recommendations-tracker.ts) | Index generator (`npm run regenerate:postmortem-recommendations`): extracts `[BUG-PREVENTION]` trailers, merges overrides + cluster catalog, emits per-status counts, `live_queue_count`, quarantine flags, and generated cluster member lists. |
| [`scripts/check-postmortem-recommendations-parity.ts`](../../scripts/check-postmortem-recommendations-parity.ts) | Parity gate in `validate:fast` (`npm run validate:postmortem-recommendations`): strict overrides schema + typed per-status metadata, orphan fingerprints, cluster_id↔catalog integrity. |
| [`scripts/recs-staleness-scan.ts`](../../scripts/recs-staleness-scan.ts) | Weekly report-only candidate detector (shipped-language, dead-target, family-supersession, stale-blocked) + stale in-flight claims (GC candidates); `--index` / `--out` / `--stale-days` / `--claims`. |
| [`scripts/recs-hotlist.ts`](../../scripts/recs-hotlist.ts) | Demand-driven hot-list from the newest pathologist run's `prior_recommendation_fingerprints`; degrades to empty with exit 0. |
| [`scripts/recs-shortlist.ts`](../../scripts/recs-shortlist.ts) | Baseline-ordered top-N over the live queue (hot-list → type tier → priority → recency), clusters as one unit, per-item rationale; actively-claimed units are demoted (claimant + age in the rationale). |
| [`scripts/recs-claim.ts`](../../scripts/recs-claim.ts) | In-flight claim coordination for parallel drains (`claim` / `release` / `list`): the launcher batch-claims a run's assignment at launch; the shortlist demotes active claims. Schema + rules in the claims-file header and CLI help. |
| [`scripts/recs-batch-pipeline.ts`](../../scripts/recs-batch-pipeline.ts) | Mechanical `emit` / `validate` / `apply` contract for LLM bulk-triage batches — no hand-pasting into overrides; apply re-validates, writes entries, regenerates + parity-checks, restores on failure. |
| `docs-private/postmortems/_recommendations_clusters.yaml` | Committed cluster catalog — metadata only; member lists are generated. |

---

## Run history

Drains recur — dedicated rounds, plus the small weekly drain (step C3 of [`WEEKLY_AUTOMATED_REVIEW.md`](./WEEKLY_AUTOMATED_REVIEW.md)). **Don't look to this doc for current numbers or status.** The live state of any recommendation is the regenerated index merged with the committed curation files; each round's full record lives in its planning folder (search `docs/plans/` for `recs` / `recs-drain` slugs, or use the overrides file's `last_revisited` stamps to find recent activity). Rounds after Round 2 are deliberately *not* chronicled here. **2026-06-12:** the bulk triage that built this funnel (lifecycle states, scan, clusters, shortlist) and routed/closed/clustered the backlog at scale is recorded in [`docs/plans/260611_recs-triage-system/`](../plans/260611_recs-triage-system/PLAN.md). The sections below are dated snapshots of the first two rounds, kept for their narrative lessons (high already-done rates at the verify-not-done gate; test-coverage recs twice uncovering live security holes); any counts in them were true only on their date.

### Round 1 parameters (2026-05-31)

Set with Greg up front:

| Decision | Choice |
|---|---|
| **Source scope** | Postmortem recommendation index first; plan-idea mining is a follow-up run. |
| **Corpus / ranking** | Full index, ranked by **hotspot × priority × leverage × recency**, with recency weighting recent 30d and 7d recs higher. |
| **Volume this run** | Implement **~8–12** recommendations. |
| **Checkpoint** | **Approve the evaluated shortlist before implementing.** Then run autonomously, report at milestones. |

---

### Round 1 outcome (2026-05-31)

Implemented the approved shortlist **A–G + C40**, ~13 recommendations across the hottest surfaces, each Codex-implemented + cross-family reviewed (Claude + GPT-5.5, extra rounds where defects surfaced) + signposted; tracker moved from **0 → 44** recs marked `implemented` (the 13 built + an H backfill of dual-verified already-done recs + concurrent peer activity). Headline: Run A's typed safety-cache work **uncovered + closed a live HIGH-sev permission-bypass** (email/calendar/slack safety-allows were subset-keyed → now non-memoizable). The verify-not-done gate correctly **dropped C12** (already implemented). Plan folders (the fuzzier second source) were left to a follow-up.

#### Deferred-backlog disposition — NOT pursuing (decided 2026-05-31)

After Round 1, a GPT-5.5 Arbiter-prioritized backlog remained; assessed by ease × value, **Greg decided not to pursue any of them**:

| Deferred item | Ease | Value | Disposition |
|---|---|---|---|
| D-(b) `publicBroadcastSafetyHook` variable-substitution test | M | Med-high (only one guarding a distinct gap — the hook layer) | **Dropped** (the strongest, but not pursued per decision) |
| Plan-folder mining run | L | Unknown / high ceiling | **Not now** — if revisited, de-risk with a ~50-folder sampling pass to estimate hit-rate first |
| H-remainder (~16 single-pass-confirmed already-done) | M | Low-med (accounting; asymmetric risk if mis-marked) | **Dropped** — only via a broader curation pass with per-rec spot-checks |
| D-(a) broaden prompt reverse-coverage to all prompts | S-M | Low (critical-only is the right minimum; noise risk) | **Dropped** |
| G AST-based appBridgeSubscriptions extraction | M | Low (hardens a working check vs hypothetical future) | **Dropped** |
| C discourse exception self-check | S | Low (guard-on-a-guard) | **Dropped** |

**Highest remaining leverage is NOT the polish backlog** — it's the **next tranche of still-open `priority:high` recs in the index** (≈500 open; Round 1 took only the top-45 scored). Round 2 applies this same process to that next tranche. (Plan-folder mining remains the wildcard, pending a de-risk sample.)

### Round 2 parameters (2026-05-31)

| Decision | Choice |
|---|---|
| **Source** | Same index, re-scored excluding `status: implemented`; next tranche below Round 1's top-45 cut. |
| **Checkpoint** | **None** — prioritise + implement autonomously (Greg delegated scope), report at milestones. |
| **Volume** | ~8–12 genuinely-unimplemented, high-leverage recs (verify-not-done gate applies). |

### Round 2 outcome (2026-05-31)

Planning folder: `docs/plans/260531_recs-round2-next-tranche/`. Re-scored the index excluding `status: implemented`; GPT-5.5 verify-prioritise found the same high already-done rate as Round 1, leaving a small genuine-missing set. **Shipped 6 recs**, each Codex-implemented + cross-family reviewed (GPT-5.5 × Claude) + signposted:

| Rec | What | Outcome |
|---|---|---|
| **R20** | Bash safe-skip prefilter (`isBashCommandSafeToSkip`) adversarial corpus | **Live security fix** — the corpus uncovered the prior "surgical" fix was incomplete; ~10 distinct allowlist-bypass classes (quoted/concat/ANSI-C/brace/line-continuation flags; narrow sensitive-path regexes; empty-brace fail-open) still skipped LLM safety eval. Closed across **3** adversarial review rounds. |
| **R14** | Typed latch-outcome discriminant (`waitUntilResumeOrDegraded`) | Kill-by-construction: degraded-reason travels with the result; removed side-channel. |
| **R10** | Memory-history read-boundary normalization | Malformed legacy entries normalized at the producer boundary; shared types stay honest. |
| **R16** | Validation-runner lifecycle tests (`run-validate-fast.ts`) | Artefact-written-exactly-once on failure / rejection / SIGINT / SIGTERM / success; behavior-preserving testability refactor. |
| **R21** | Worker esbuild smoke (`validate:worker-build-smoke`) | `validate:fast` now executes the custom worker build when worker/startup files change (was static-only in Round-1 F). |
| **R1** | Positional image-ref failure matrix (5 boundaries) | first/last/multiple positions × materializer/sanitizer/compaction/lean-DTO/handler; test-only, no bug exposed (fix confirmed robust); reviewer mutation-verified non-vacuous. |

**Headline (again):** a *test-coverage* recommendation (R20) became the round's highest-value work by exposing live security holes — the same pattern as Round 1's Run A. **Deferred/skipped:** R2 (typed trust-policy metadata — large refactor vs marginal prevention, behavior already tested; weighed + dropped in Round 1); provider-bookkeeping recs (subsumed by the separate model-provider-hardening effort, but not marked — no findable fingerprints + asymmetric mis-mark risk per the honest-assessment discipline). Round 2 avoided provider-router files throughout (clientFactory/providerRouting/providerRouteDecision/rebelCoreQuery/agentTurnExecute) to prevent collision with any Slice-3 provider-architecture agent. **Stopping point:** remaining open index recs are lower marginal value than the shipped 6 — per don't-grind-tails, this closes the index-mining rounds. Plan-folder mining (the fuzzier second source) remains the open wildcard, pending a de-risk sample.

---

## See also

- [`BIG_FILE_REFACTOR_CANDIDATES`](./BIG_FILE_REFACTOR_CANDIDATES.md) — the structural-debt sibling of this process: a refreshable, ease×value-ranked shortlist of oversized files worth splitting (drains *file-size* debt; this doc drains *bug-prevention* recommendations).
- [`CHIEF_PATHOLOGIST_ANALYSIS`](../../coding-agent-instructions/workflows/CHIEF_PATHOLOGIST_ANALYSIS.md) — produces qa13 (the action-gap metric this process targets).
- [`CHIEF_PATHOLOGIST`](../../coding-agent-instructions/workflows/CHIEF_PATHOLOGIST.md) — produces the `[BUG-PREVENTION]` trailers the index is built from, and the `prior_recommendation_fingerprints` augment field the hot-list consumes.
- [`CHIEF_ENGINEER2`](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) — the implementation workflow used in step 7.
- [`CODEX_CLI_AS_SUBAGENT`](../../coding-agent-instructions/docs/CODEX_CLI_AS_SUBAGENT.md) — how GPT participates in verification, evaluation, and review.
- [`WEEKLY_AUTOMATED_REVIEW`](./WEEKLY_AUTOMATED_REVIEW.md) — step C3 runs the weekly scan + small drain on this funnel.
- `docs/project/CODING_PRINCIPLES.md` — where many `agent_instructions`-type recommendations get absorbed.
