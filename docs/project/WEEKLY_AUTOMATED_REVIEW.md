---
description: "Runbook for a weekly automated code-health & bug-feedback review. A signposting hub an agent can be pointed at on a schedule — it sequences existing checks and links to each canonical source rather than duplicating them."
last_updated: 2026-06-18
---

# Weekly Automated Review

A **runbook for a single weekly pass** over the codebase's health and bug-feedback signals. Point an agent at this doc on a schedule; it walks the checklist below and follows the signpost to each tool's canonical home for the actual how-to.

This doc is deliberately thin — it owns the **sequence and the signposts**, not the details. Every "how" lives in a single source of truth linked inline. When a step's mechanics change, update the linked doc, not this one.

> **Cron/CI wiring is out of scope here.** This is the human-or-agent runbook. Promoting individual mechanical steps to a scheduled job comes later; when it does, model them on [`.github/workflows/docs-link-check.yml`](../../.github/workflows/docs-link-check.yml) (weekly `cron`, `continue-on-error`, artifact + step-summary).

## See Also

- [DAILY_AUTOMATED_REVIEW](DAILY_AUTOMATED_REVIEW.md) — the fast-cadence sibling: live health ("are users OK today?") + release-pipeline warmth + the live-API/dev and Sentry-monitor steps that moved out of this weekly pass (2026-06-18)
- [CODE_HEALTH_TOOLS](CODE_HEALTH_TOOLS.md) — the catalog of every code-health tool + the deep/quarterly sweep this run draws from
- [IMPLEMENT_PRIOR_POSTMORTEM_AND_PLAN_RECOMMENDATIONS](IMPLEMENT_PRIOR_POSTMORTEM_AND_PLAN_RECOMMENDATIONS.md) — the recommendation-drain process (step C3 below)
- [IMPROVE_DEFECT_DEFENSES_FROM_POSTMORTEMS_AND_BUGS](../../coding-agent-instructions/workflows/IMPROVE_DEFECT_DEFENSES_FROM_POSTMORTEMS_AND_BUGS.md) — the broader defect-defense sibling of the recommendation drain: when a *class* of defect is systematically leaking (red qa13, a recurring family), improve *how* we defend (prevention *and* detection) rather than only draining filed recs (step C2 below)
- [BIG_FILE_REFACTOR_CANDIDATES](BIG_FILE_REFACTOR_CANDIDATES.md) — the ease×value-ranked oversized-file shortlist (structural-debt sibling of the recommendation drain)
- [CHIEF_PATHOLOGIST_ANALYSIS](../../coding-agent-instructions/workflows/CHIEF_PATHOLOGIST_ANALYSIS.md) — the weekly bug-forensics report (step C1); its default window **is** 7 days
- [CODE_HEALTH_STATUS](CODE_HEALTH_STATUS.md) — current ratchet baselines this run reads and ratchets down
- [DEPENDENCY_UPGRADES_AND_DEPENDABOT (general, cross-repo)](../../coding-agent-instructions/docs/DEPENDENCY_UPGRADES_AND_DEPENDABOT.md) — risk tiers, bake-time policy, and cheap-vs-frontier model dispatch for the dependency-security step (B) and the Dependabot drain (Rebel-specific blockers: [docs/project version](DEPENDENCY_UPGRADES_AND_DEPENDABOT.md))
- [SENTRY_TRIAGE](SENTRY_TRIAGE.md) — Sentry / in-app user-bug-report intake (step C4)
- [RELEASE_TO_MOBILE](RELEASE_TO_MOBILE.md) — the mobile (iOS + Android) release-pipeline runbook; the mobile-build-green check in section A signposts here for the fix path
- [`live-eval.yml`](../../.github/workflows/live-eval.yml) + [TESTING_AUTOMATION_OVERVIEW § live-API tier](TESTING_AUTOMATION_OVERVIEW.md#consolidated-live-api-tier-testslive-api--liveapiharness) — the gated real-LLM harness-health tier; CI cron covers `main`, this runbook runs it explicitly on `dev` (step A)

## The point of this run

The repo is already heavily gated on every PR (see [CODE_HEALTH_TOOLS](CODE_HEALTH_TOOLS.md)), so the weekly pass is **not** about re-discovering drift. Its centre of gravity is the **bug-feedback loop (section C)** — reading the week's bug forensics and **closing the action gap** (filed-but-unimplemented prevention recommendations), which is the measured bottleneck, not detection. Sections A and B are fast confirmations; C is where the hour goes.

**Fan out the fix work.** Sections A–B are fast read-and-confirm steps — do them inline. But anything they surface that needs *fixing* — a ratchet with slack to tighten, a circular dep, a major Dependabot bump, or a bug/recommendation from section C — should be dispatched as its own background [CHIEF_ENGINEER2](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) run, one careful agent per area, rather than hand-fixed in sequence. That lets the remediation proceed in parallel, each with CE2's multi-model review, while you continue the sweep. Send the mechanical, low-risk items to the cheap tier (Composer via [CURSOR_CLI_AS_SUBAGENT](../../coding-agent-instructions/docs/CURSOR_CLI_AS_SUBAGENT.md)) and reserve frontier models for the judgment-heavy ones. (Distinct from the retired *index-mining* recs fan-outs in C3 — those mined a speculative backlog; this dispatches the concrete work the run just found.)

---

## A. Confirm green (~5 min)

The every-PR gates already enforce these; here we just confirm nothing red landed on `dev`.

- [ ] **`dev` is green.** Spot-run `npm run validate:fast` on a fresh `dev` checkout (or check the latest `dev-checks` CI run). Red here is usually a freshly-merged dev breakage, not your change — triage it in isolation before continuing.
- [ ] **Knip + tests green.** `npm run verify:agent`. **This (not `validate:fast`) is what confirms integration tests** — pre-push/`validate:fast` exclude `*.integration.test.ts`, so a cross-cutting refactor can leave a red integration test on `dev` that a green `validate:fast` won't reveal (see [CODE_HEALTH_TOOLS § Fast Validation](CODE_HEALTH_TOOLS.md#fast-validation)). Don't skip this step.
- [ ] **Agent UI testing router still current.** Run `npm run test:preflight`, the CLI free-tier commands, and one managed launch (`npx tsx scripts/ui-test/launch-rebel-test.ts` — auto-cleans) per [AGENT_UI_TESTING](AGENT_UI_TESTING.md); refresh its validated-on dates if budgets moved by >2x, then rerun its Drift Check grep.
- [ ] **Live-API tier on `dev` — now a DAILY step.** The explicit `dev`-side `npm run test:live` run **moved to [DAILY_AUTOMATED_REVIEW § B](DAILY_AUTOMATED_REVIEW.md)** (2026-06-18) — 4 days of silent dev-side rot (the 260607 cutover) is a daily-cadence gap, not weekly. The weekly pass keeps only the `main`-side confirmation: the latest scheduled [`live-eval.yml`](../../.github/workflows/live-eval.yml) run on `main` is green (or skipped-clean), and follow up if its anti-rot guard fired.

- [ ] **Sentry outcome monitor healthy — now a DAILY step.** Moved to [DAILY_AUTOMATED_REVIEW § A](DAILY_AUTOMATED_REVIEW.md) (2026-06-18) — a dead-man watcher (a missing daily digest *is* the signal) only works if it's checked daily. SSOT: [ERROR_MONITORING_AND_SENTRY § outgoing-event monitoring](ERROR_MONITORING_AND_SENTRY.md).

- [ ] **Mobile build green on `dev`.** Confirm the latest `mobile-preview.yml` run is green: `gh run list --workflow mobile-preview.yml --branch dev --limit 3`. If red, dispatch a fix per [RELEASE_TO_MOBILE](RELEASE_TO_MOBILE.md). The CI production-bundle check (in `mobile-runtime-integrity.yml`) is the **primary, fast** detection — this weekly confirmation is the human backstop, mainly for the path-excluded gap where a `src/core`/`src/shared` break doesn't rebuild mobile on its own PR.

See [CODE_HEALTH_TOOLS § Routine Checks](CODE_HEALTH_TOOLS.md#routine-checks-every-pr) for what these cover.

> **Live-API harness-health tier — CI cron covers `main`; the DAILY checklist covers `dev`.** The real-LLM `tests/live-api/` tier ([TESTING_AUTOMATION_OVERVIEW § live-API tier](TESTING_AUTOMATION_OVERVIEW.md#consolidated-live-api-tier-testslive-api--liveapiharness)) is **not** part of the every-PR gates — it makes paid provider calls. It runs automatically via [`live-eval.yml`](../../.github/workflows/live-eval.yml) (weekly `cron` + manual `workflow_dispatch`) against `main`, and explicitly via the **daily** checklist ([DAILY_AUTOMATED_REVIEW § B](DAILY_AUTOMATED_REVIEW.md)) against `dev`. **Skip-vs-fail policy:**
> - **In automation (cron/CI): absent keys ⇒ cells skip-green** — that's intended; a keyless run is a clean no-op. But the workflow's provider-aware **anti-rot guard** *fails* the job if a `TEST_*` secret **is** configured yet zero cells ran for that provider, so a silently-rotted gate gets noticed rather than passing green.
> - **On an explicit operator run (`npm run test:live`): absent keys do NOT skip-green silently.** The harness still skips each keyless cell by construction, but `test:live` runs [`scripts/check-live-api-ran.ts`](../../scripts/check-live-api-ran.ts) afterward, which **fails the run** if zero cells actually ran — the operator equivalent of CI's anti-rot guard. So an explicit run with no keys ends red with "run `npm run capture-live-api-keys`", not a misleading green. (A single-provider-key run still passes: its cells run, the absent providers skip.)
>
> The **daily** pass runs this tier explicitly on `dev` ([DAILY_AUTOMATED_REVIEW § B](DAILY_AUTOMATED_REVIEW.md)); the weekly pass only confirms the latest scheduled `live-eval` run on `main` is green (or skipped-clean), following up if its anti-rot guard fired.

## B. Trend reviews — read the baseline, ratchet down where there's slack (~15–20 min)

The ratchets **block increases** automatically; lowering them when debt is paid is manual and gets forgotten. For each, compare the live count to its baseline and tighten if there's slack. Baselines + current counts live in [CODE_HEALTH_STATUS](CODE_HEALTH_STATUS.md).

- [ ] **TypeScript errors** — `npm run lint:ts` vs baselines in `scripts/check-typescript-errors.ts`.
- [ ] **ESLint per-rule warnings** — `npm run validate:eslint-warnings` vs baselines in `scripts/check-eslint-warnings.ts`. **Do NOT reconcile a `rebel-silent-swallow/no-silent-swallow` count** — its count baselines (global + per-surface + file budgets) were retired 2026-06-12; it is now diff-scoped (`validate:eslint-new-warnings`) + the `--max-warnings 3000` cap (never ratchet that cap DOWN) + a rule-presence smoke. There is no silent-swallow number to drift or tighten. See [CODE_HEALTH_TOOLS § Silent-swallow gate](CODE_HEALTH_TOOLS.md).
- [ ] **Escape hatches** (`as any` / `@ts-ignore` / `eslint-disable`) — `npm run validate:escape-hatches`.
- [ ] **IPC schema strictness** (`z.any()` / `z.unknown()`) — `npm run validate:ipc-schema-strictness`.
- [ ] **Circular deps** — `npm run validate:circular-deps`.
- [ ] **Dead code (full)** — `NODE_OPTIONS=--max-old-space-size=8192 npx knip`; triage any new unused deps/exports. See [DEAD_CODE_DETECTION_AND_REMOVAL](DEAD_CODE_DETECTION_AND_REMOVAL.md).
- [ ] **Doc reachability** — `npm run audit:doc-reachability` (Stage 1, deterministic): triage **unreachable high-risk** code dirs (add a narrow signpost doc or a link from the nearest `[TOPIC]_OVERVIEW` hub) and fix any **stale code references** it flags. Then a broad doc-quality spot-check on a random sample — `npm run audit:doc-reachability:judge -- --random --limit 20` (Stage 2 LLM-traversal judge via Composer-2; every cited path is verified, so a hallucinated route is flagged) — and act on trustworthy `WEAK`/`FAIL` findings. SSOT: [DOC_REACHABILITY](DOC_REACHABILITY.md).
- [ ] **Deferred-cleanup ledger** — `npm run cleanup:list` (exit 2 = overdue). Execute the cut-over or re-defer with rationale. See [CODE_HEALTH_TOOLS § Deferred-Cleanup Ledger](CODE_HEALTH_TOOLS.md#deferred-cleanup-ledger).
- [ ] **Dependency security** *(currently no npm script — see Gaps below)* — `npm audit --omit=dev` + `npm outdated`; cross-check the open Dependabot PR queue (`gh pr list --label dependencies`). Dependabot itself runs monthly per [`.github/dependabot.yml`](../../.github/dependabot.yml).
  - [ ] **Dependabot PR queue — triage & drain.** `gh pr list --label dependencies` (add `--repo <owner>/<repo>` for the `mcp-servers` submodule). For each open PR: review the changelog/diff, confirm CI is green, then merge low-risk patch/minor bumps — dispatch the mechanical ones to the cheap tier (Composer via [CURSOR_CLI_AS_SUBAGENT](../../coding-agent-instructions/docs/CURSOR_CLI_AS_SUBAGENT.md)). For major or runtime-affecting bumps, follow the tiered process in [DEPENDENCY_UPGRADES_AND_DEPENDABOT](../../coding-agent-instructions/docs/DEPENDENCY_UPGRADES_AND_DEPENDABOT.md) (bake-time over newest, spike, test) and run them through CHIEF_ENGINEER2 (see *Fan out the fix work* above). A backlog here means security patches are sitting unmerged — don't let it grow between the monthly Dependabot runs.
  - [ ] **mcp-servers connectors — high-severity audit** *(moved here 2026-06-13 from the `mcp-servers` per-push CI matrix)*. **Why it moved:** `npm audit` queries the live advisory DB at run time, so running it on every push reddened `mcp-servers` `main` whenever a new upstream advisory dropped — misattributed to whatever commit happened to push next, and orthogonal to what that commit changed (the recurring `:red_circle: mcp-servers CI failed on main` Slack alerts). A weekly sweep matches the cadence at which advisories actually appear. **How:** in the `mcp-servers` submodule, run the high-severity audit per connector and clear any **high** finding by pinning the patched version via that connector's `overrides` block (refresh its `package-lock.json`; **no version bump** — dep fixes ride direct to `main` like catalogue regens):
    ```bash
    cd mcp-servers
    for d in connectors/*/; do echo "== $d =="; ( cd "$d" && npm audit --audit-level=high --omit=dev ) || true; done
    ```
    `npm audit` reads each connector's committed `package-lock.json` (no install needed). Moderates are below the gate — address opportunistically, not as a blocker. **Publish-time enforcement** (the point where a blocking gate actually belongs) lives in `mcp-servers` [`docs/PUBLISH_APPROVAL_PROCESS.md`](../../mcp-servers/docs/PUBLISH_APPROVAL_PROCESS.md); it is mechanically wired only for connectors with a `prepublishOnly` audit (today: hubspot). Closing that to all connectors is **FOX-3319 R7** ([`docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md`](../../mcp-servers/docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md)) — the durable fix, now unblocked.
- [ ] **Push-gate telemetry tripwires** *(active while listed — first evaluation w/c 2026-06-18)* — from the git-safe-sync timing logs, evaluate the guard-batching tripwire (same-host `lock-wait` p75 over **push runs only** + quiesced gate median) and the cross-machine race residual (exit-40s **plus** `push-retry` notes — a retried-won race still counts). Thresholds, queries, and what arming means: [PREPUSH_GATE_AND_RECEIPTS § tripwire](PREPUSH_GATE_AND_RECEIPTS.md). Remove this line once a decision is recorded there (armed or retired).

- [ ] **Renderer leak soak** (~60–90 min wall, runs in the background while you do section C; ~$2–3 API spend) — the scripted heap-slope check that would have caught REBEL-5D5 within a week of introduction. Recipe + pass/fail criterion: [APP_PERFORMANCE_AND_MEMORY § Renderer Leak Soak Check](APP_PERFORMANCE_AND_MEMORY.md#renderer-leak-soak-check-scripted-6090-min-agent-runnable). Failure = open a diagnosis run (snapshots + memlab per the recipe), not a ratchet tweak. While it runs, also grep the week's logs for the two [high-signal alarm lines](APP_PERFORMANCE_AND_MEMORY.md#high-signal-alarm-lines-grep-these--they-fire-into-log-files-not-at-anyone) — they detect what the soak's synthetic drive might miss.

Record anything notable (baseline lowered, new debt accepted) in [CODE_HEALTH_STATUS](CODE_HEALTH_STATUS.md).

## C. Bug-feedback loop — the heart of the run (~45–90 min)

This is the part with no other regular review. Full process docs are linked; this is the sequence.

- [ ] **C1 — Weekly pathologist report.** Run the v3 analysis (default 7-day window) and read it. Command + interpretation: [CHIEF_PATHOLOGIST_ANALYSIS](../../coding-agent-instructions/workflows/CHIEF_PATHOLOGIST_ANALYSIS.md). Run its **trawl-recency pre-flight** first; if the corpus is stale for the window, run a `light` trawl.
- [ ] **C2 — Read the prevention pages (qa11–qa17).** Note new hot surfaces and especially **qa13 (the action gap)** — the % of recurring failures whose prior recommendation was implemented. A red qa13 is the trigger for C3. When the signal is a *class* of defect systematically leaking — a persistently red action gap, a recurring postmortem family, or a cross-boundary escape cluster — rather than filed recs to drain, route it to [IMPROVE_DEFECT_DEFENSES_FROM_POSTMORTEMS_AND_BUGS](../../coding-agent-instructions/workflows/IMPROVE_DEFECT_DEFENSES_FROM_POSTMORTEMS_AND_BUGS.md) (its own brief → CHIEF_ENGINEER2), the broader defect-defense sibling of C3.
- [ ] **C3 — Scan, then drain prevention recommendations — hot-list first.** First run the staleness scan (`npx tsx scripts/recs-staleness-scan.ts`) and close *verified* candidates with evidence; the scan also reports stale in-flight claims (expired / closed-row) as GC candidates. Then **lead with the demand-driven hot-list, not the ranked backlog:**
  - **Hot-list (the high-signal picks).** Run `npx tsx scripts/recs-hotlist.ts`. Any fingerprint it surfaces is a recommendation a *fresh* bug just re-implicated — recurrence evidence that the prevention action would have paid off *now*. Drain these first; they are the items with demonstrated marginal value. (Forward-only by design: an empty hot-list is the normal, expected case — see the funnel doc.)
  - **Backlog drain = maintenance only, and small.** When the hot-list is empty (or thin), drain **at most ~1–3 items** from the generated shortlist (`npx tsx scripts/recs-shortlist.ts`; clusters count as one item) as light maintenance — not a sweep. **The broad scheduled index-mining fan-outs are retired (2026-06-14):** Round 7 (`docs/plans/260613_recs7-*`) hit a rising already-done rate and **zero live-bug discovery**, where the early rounds each uncovered a live HIGH-sev hole — the action gap that motivated this funnel (qa13) is substantially closed (0→300+ `implemented`). Index-mining is past the point where parallel drains pay for themselves; let the high-ranked provider/routing cluster be absorbed by the multiprovider effort rather than drained as singletons.
  - Ship whatever you pick via CHIEF_ENGINEER2, following [IMPLEMENT_PRIOR_POSTMORTEM_AND_PLAN_RECOMMENDATIONS](IMPLEMENT_PRIOR_POSTMORTEM_AND_PLAN_RECOMMENDATIONS.md) — the funnel doc owns the lifecycle states, the verify-not-done gate, the no-second-deferral rule, and signpost-back. Re-open the big opt-in rounds only if a future qa13 regresses (recurrence pressure returns).
- [ ] **C4 — Sentry / user-report intake.** Refresh the source-intake review and triage new `source:user-bug-report` rows. See [SENTRY_TRIAGE](SENTRY_TRIAGE.md) and `docs/pathologist-source-intake/`.

## D. Explicitly NOT weekly

Keep these off the weekly run so it stays lean; schedule separately. Details in [CODE_HEALTH_TOOLS § Deep Analysis](CODE_HEALTH_TOOLS.md#deep-analysis-before-releases--quarterly).

- **Bundle visualizer** and **renderer bundle singleton smoke** — pre-release / monthly (need a packaged build).
- **Madge full circular-dep detail** — monthly / when debugging (the per-PR ratchet already enforces the count).
- **Pathologist deep-dive** (`CHIEF_PATHOLOGIST_DEEP_DIVE`) — quarterly / after a spike / board prep. Its own doc says **do not run weekly**; it is the *producer* that feeds the weekly qa11–qa16.
- **Systematic Health Sweep** ([CODE_HEALTH_TOOLS § Systematic Health Sweep](CODE_HEALTH_TOOLS.md#systematic-health-sweep)) — quarterly / when debt feels heavy.

## Gaps / future wiring

Tracked here so a future cron pass can pick them up (none block the manual run):

- **No `npm audit` / `npm outdated` script or scheduled dependency-security signal** between monthly Dependabot runs — the clearest automation gap (step B). A report-only weekly cron modelled on `docs-link-check.yml` would close it. *(The `mcp-servers` connector slice of this is now a documented step B item — see "mcp-servers connectors — high-severity audit" — but is still a manual runbook step, not yet wired to a cron. A report-only scheduled job, or promoting the per-connector loop into a script, would close the remaining gap.)*
- **`cleanup:list --overdue` is not yet wired to a cron** (it already exits non-zero on overdue) — the easiest mechanical step to promote.
- **Sentry-triage cron is currently disabled** (manual `workflow_dispatch`); if C4 should feed the weekly report automatically, re-enable it.
- **Live-eval anti-rot guard is duplicated, not shared.** `npm run test:live` now fails loud on a keyless explicit run via [`scripts/check-live-api-ran.ts`](../../scripts/check-live-api-ran.ts) (closed 2026-06-07), but CI's `live-eval.yml` still carries its own inline provider-aware anti-rot guard. The local script is an aggregate backstop (zero cells ran); CI's is provider-aware (per-key). Folding both onto one shared checker — extending `check-live-api-ran.ts` with an optional per-provider mode CI can call — would remove the duplication. Low priority.
