---
description: "Runbook for a daily automated health & release-pipeline review. A thin signposting hub an agent can be pointed at each day — fast-moving 'are users OK / is the pipeline healthy' signals where a 7-day lag is too long. Complements WEEKLY_AUTOMATED_REVIEW (trend/debt/bug-feedback)."
last_updated: 2026-06-18
---

# Daily Automated Review

A **runbook for a single daily pass** over the fast-moving health and release-pipeline signals. Point an agent at this doc each day; it walks the checklist and follows the signpost to each tool's canonical home for the how-to.

Like [WEEKLY_AUTOMATED_REVIEW](WEEKLY_AUTOMATED_REVIEW.md), this doc is deliberately **thin** — it owns the **sequence and the signposts**, not the details. Every "how" lives in a single source of truth linked inline. When a step's mechanics change, update the linked doc, not this one.

> **Cron/CI wiring is out of scope here.** This is the human-or-agent runbook. Promoting steps to a scheduled job comes later; model them on the weekly doc's guidance (a `cron` workflow, `continue-on-error`, artifact + step-summary + Slack post).

## What belongs on the daily list (vs weekly)

One question decides daily-vs-weekly for any candidate: **"does same-day matter for this signal, *and* is it cheap enough to run every day?"**

- **Daily** = live health ("are users OK *today*?") + release-pipeline warmth (did the last release ship; is the gate that blocks publish still green) — signals where a week's lag is a real cost.
- **Weekly** ([WEEKLY_AUTOMATED_REVIEW](WEEKLY_AUTOMATED_REVIEW.md)) = trends, debt, ratchets, and the **bug-feedback loop** (its window genuinely *is* 7 days).
- **Neither** = anything already enforced on **every PR** ([CODE_HEALTH_TOOLS](CODE_HEALTH_TOOLS.md)). Re-running per-PR gates daily is pure redundancy — the daily "code health" slice is only the bits that *aren't* per-PR and *can rot on `dev`* (integration tests, the live-API tier).

**Fan out the fix work** (same as the weekly doc): sections A–C are fast read-and-confirm. Anything that needs *fixing* — a Sentry regression, a stuck job, a stale gate — gets dispatched as its own background [CHIEF_ENGINEER2](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) run (cheap tier for mechanical items, frontier for judgment-heavy), not hand-fixed in sequence.

## See Also

- [WEEKLY_AUTOMATED_REVIEW](WEEKLY_AUTOMATED_REVIEW.md) — the weekly trend/debt/bug-feedback pass; this daily run is its fast-cadence sibling.
- [RELEASE_TO_BETA](RELEASE_TO_BETA.md) — the beta runbook (section C wraps it); [CI_PIPELINE](CI_PIPELINE.md) — release matrix + E2E gating + flake policy.
- [ERROR_MONITORING_AND_SENTRY](ERROR_MONITORING_AND_SENTRY.md) / [SENTRY_TRIAGE](SENTRY_TRIAGE.md) — Sentry intake + the outcome monitor (section A).
- [TESTING_AUTOMATION_OVERVIEW § live-API tier](TESTING_AUTOMATION_OVERVIEW.md#consolidated-live-api-tier-testslive-api--liveapiharness) — the real-LLM harness (section B).
- [APP_PERFORMANCE_AND_MEMORY § high-signal alarm lines](APP_PERFORMANCE_AND_MEMORY.md#high-signal-alarm-lines-grep-these--they-fire-into-log-files-not-at-anyone) — the leak/perf alarm grep (section A).

---

## A. Live health — "are users OK today?" (~10 min, read-and-confirm)

- [ ] **`dev` is green right now.** Confirm the latest [`dev-checks`](../../.github/workflows/dev-checks.yml) run on the current `dev` tip concluded `success` — `npm run check:dev-checks-green` (defaults to `HEAD`; don't pipe through `tail`/`head` — it masks the exit code). A broken base caught same-day saves everyone downstream a day of building on red. (On a fast-churning afternoon, runs get **cancelled** by newer pushes — confirm against a *settled* tip, not a cancelled run.)
- [ ] **`cloud-ci` is green on `dev` right now.** The [`cloud-ci`](../../.github/workflows/cloud-ci.yml) lane (cloud-service build + `--project=cloud-service` tests + cloud-client unit/e2e) is **not** on any release-publish path and is **not** a required check, so it can sit red for days unnoticed — a *detector outage*: once a lane is red for one reason, every later regression lands there unseen, so restoring green is itself a fix. Confirm the latest run concluded `success`: `gh run list --workflow=cloud-ci.yml --branch dev --limit 1 --json conclusion,headSha,createdAt`. If red, dispatch a fix run (cheap tier for mechanical, frontier for judgment). Reproduce/triage locally with `npm run test:cloud:ci-local` (~25s) — **but** the *submodule-absence* failure class only reproduces in CI (the local checkout always has `rebel-system`), so a green local run does not certify the CI lane. *(Until a prolonged-red alerter exists — see Gaps — this daily eyeball is the watch.)*
- [ ] **Sentry — new / spiking issues + crash-free trend.** Glance at issues first-seen in the last 24h, sorted by frequency, **per surface** (`client_surface` is now tagged — desktop / cloud / mobile). Triage anything with a real user count or a sharp slope; dispatch a fix run for genuine regressions. This is the *fast glance* — the deeper weekly source-intake triage stays in [WEEKLY_AUTOMATED_REVIEW § C4](WEEKLY_AUTOMATED_REVIEW.md). SSOT: [SENTRY_TRIAGE](SENTRY_TRIAGE.md).
- [ ] **Sentry outcome monitor healthy.** Confirm the latest scheduled `sentry-outcome-monitor` run is green AND yesterday's daily digest appeared in `#rebel-monitoring` (a missing digest IS the dead-man signal). While the workflow hasn't reached `main` (crons only schedule from the default branch), run it explicitly: `node scripts/sentry-outcome-monitor.mjs --dry-run`. SSOT: [ERROR_MONITORING_AND_SENTRY § outgoing-event monitoring](ERROR_MONITORING_AND_SENTRY.md). *(Moved here from the weekly pass 2026-06-18 — a dead-man watcher only works if it's checked daily.)*
- [ ] **Background-job / integration error spikes.** Skim Sentry/cloud for spikes in the ambient subsystems users don't see fail: meeting-bot, calendar sync, automations, MCP connectors, cloud self-update. A new spike here is daily-cadence (a stuck outbox or failed self-update shouldn't wait a week).
- [ ] **Renderer/main leak alarm grep** (near-free). Grep the day's logs for the high-signal alarm lines — `grep -hiE "sustained heap growth|slopeMBPerHr|growthRateMBPerHour" ~/Library/Application\ Support/mindstone-rebel/logs/*.log`. A fired line is a real signal (recipe + thresholds: [APP_PERFORMANCE_AND_MEMORY](APP_PERFORMANCE_AND_MEMORY.md#high-signal-alarm-lines-grep-these--they-fire-into-log-files-not-at-anyone)); confirm it's not already fixed in the latest beta before opening a diagnosis run.
- [ ] **Cost / usage anomaly** *(no script yet — see Gaps)*. Glance at the PostHog `Cost Incurred` daily delta (and per-`client_surface`); a runaway loop or pricing change should be caught in a day, not a month.

## B. Heavy tests that rot on `dev` (~15–25 min)

These are *not* per-PR gates and *do* silently rot on `dev` — the reason they're daily, not weekly.

- [ ] **Live-API tier on `dev`.** `npm run test:live` (real-LLM cells + connector-smoke; ~10–20 min, pennies — haiku-class, tiny maxTokens, read-only connector ops). Needs `.env.test` populated (`npm run capture-live-api-keys -- --apply`; in a worktree copy `.env.test` from the primary first, and run `node node_modules/electron/install.js` if the Codex cell fails on a missing `electron/path.txt`). **Do NOT pipe through `tail`/`head`** — it masks the exit code and defeats the ran-check. Why daily: the CI cron ([`live-eval.yml`](../../.github/workflows/live-eval.yml)) only exercises `main`, so dev-side rot is invisible until release — the 260607 cutover silently broke every fixture on `dev` for 4 days. SSOT: [TESTING_AUTOMATION_OVERVIEW § live-API tier](TESTING_AUTOMATION_OVERVIEW.md#consolidated-live-api-tier-testslive-api--liveapiharness). *(Moved here from [WEEKLY_AUTOMATED_REVIEW § A](WEEKLY_AUTOMATED_REVIEW.md) 2026-06-18 — 4 days of silent rot is a daily-cadence gap, not weekly.)*
- [ ] **Integration tests on `dev`** *(optional / if a cross-cutting refactor landed)*. `npm run verify:agent` — `*.integration.test.ts` are excluded from `validate:fast`/pre-push, so a cross-cutting refactor can leave a red integration test on `dev` that a green push never revealed. (Skip on quiet days; it overlaps the weekly confirm.)

## C. Release-pipeline health + the conditional daily beta

- [ ] **Did the last release actually ship, and is the update feed serving?** Check the most recent [`release.yml`](../../.github/workflows/release.yml) run's `Publish to Google Cloud Storage` job (`success` = shipped, `skipped` = blocked — see [RELEASE_TO_BETA § 3](RELEASE_TO_BETA.md#3-definition-of-success--and-the-publishconclusion-divergence)), and that `releases-beta/latest.json` is fresh and reachable. A silently-stale update manifest is urgent *and* invisible.
- [ ] **E2E flake digest + escalation.** Read the `E2E flake summary` (`scripts/ci/summarize-e2e-results.ts`) from the latest release run; quarantine/ticket any spec flaky on **≥2 of the last 5** runs (the rolling predicate in [CI_PIPELINE § E2E flake policy](CI_PIPELINE.md#e2e-flake-policy--gate-readiness)). Daily keeps the gate-readiness signal honest instead of letting flakes rot into the blocking gate.
- [ ] **Conditional daily beta — cut one *iff* `dev` is green AND has new commits since the last beta.** This is the anchor of the daily run: a daily beta catches **chronic-E2E staleness within a day** (it runs the chronic publish gate), keeps the Windows-build/signing path from rotting between releases, and dogfoods the latest build — much of the value of running the chronic gate in PRs, using the pipeline you already have. Follow [RELEASE_TO_BETA](RELEASE_TO_BETA.md) end-to-end (its §5.1 pre-push ladder is the preflight; the watch-and-fix loop and risk ceiling apply). **Gate honestly:** if `dev` is churning and `dev-checks` hasn't settled green on a tip, or a beta shipped very recently with nothing new, **hold** — don't cut a redundant beta onto an unverified tip (that's the conditional, and the careful default).

## D. Explicitly NOT daily

Keep these off the daily run so it stays lean; they live in [WEEKLY_AUTOMATED_REVIEW](WEEKLY_AUTOMATED_REVIEW.md) (or rarer):

- The **bug-feedback loop** — weekly pathologist report + prevention-recommendation drain (its window *is* 7 days).
- **Ratchet tightening, full knip / dead-code, doc reachability, big-file refactor, Dependabot drain, deferred-cleanup ledger** — weekly trend/debt.
- **Anything already gated on every PR** ([CODE_HEALTH_TOOLS](CODE_HEALTH_TOOLS.md)) — re-running it daily is redundant.
- **Pathologist deep-dive / systematic health sweep / bundle visualizer** — quarterly / pre-release.

## Gaps / future wiring

- **No cost/usage-anomaly script** (section A) — a report-only PostHog `Cost Incurred` daily delta would close it.
- **No release-shipped / update-manifest freshness script** (section C) — could be a thin check on `releases-beta/latest.json`.
- **Conditional-beta trigger isn't automated** — section C is a manual decision today; a scheduled "dev green + new commits since last beta → dispatch beta" job is the natural promotion (coordinate with the release-process-hardening plans).
- **No prolonged-red CI alerter** (the gap behind the §A `cloud-ci`/`dev-checks` eyeball). A non-gating, non-required lane can stay red for days with no forcing function — the daily confirm above catches it within ~1 day, but an alert would catch it within hours. Two complementary options, neither built yet:
  - **(A) Cron monitor + Slack** — a scheduled workflow + script (sibling to [`scripts/sentry-outcome-monitor.mjs`](../../scripts/sentry-outcome-monitor.mjs), which already posts to `#rebel-monitoring`) that uses the GitHub API to find key `dev` workflows (`cloud-ci`, `dev-checks`) whose latest conclusion is `failure` *and* whose first-red run is older than N hours, then posts an alert. This is the real automated alerter and fits the existing monitoring pattern. Same caveat as the Sentry monitor: crons only schedule from the default branch (`main`), so until it reaches `main` it must be run explicitly. Latency ~1–2h.
  - **(C) Required status check on `dev`** — branch protection makes `cloud-ci` green a *precondition for merging*, so red can't accumulate unseen in the first place (prevention, not alerting). Needs repo-admin action plus a small workflow tweak: because `cloud-ci` is path-filtered, a PR that touches no cloud paths skips it, and GitHub reads a skipped-but-required check as *missing → blocked*; the fix is a tiny always-runs "gate" job that reports success-on-skip (or merge-queue "skipped counts as success" semantics). Highest-leverage of the two, but not a one-click toggle.
  - These stack: **(C)** stops red landing; **(A)** catches red that lands anyway (e.g. a direct `dev` push, or a lane not made required); the §A daily eyeball is the zero-cost interim covering both until either is wired.
