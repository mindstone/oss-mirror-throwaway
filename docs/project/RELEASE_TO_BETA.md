---
description: "Runbook for releasing Rebel to beta — authorised dev push, CI watch loop, failure triage, autonomous fix risk ceiling"
last_updated: "2026-06-21"
---

# Release to Beta

> **Goal:** make "push to beta" a single durable instruction. Say it once and trust that the change is pushed, the resulting CI run is watched to a terminal state, and any failures are diagnosed and fixed — within an explicit risk ceiling — until the run is green or the ceiling forces an escalation back to you.

This is a **runbook**, executed by an agent. There is no `/push-to-beta` slash command yet — invoke it by telling the agent to "push to beta" and pointing it here. A thin `.factory/commands/push-to-beta.md` wrapper can be added later (mirroring how [`/ci-check`](../../.factory/commands/ci-check.md) wraps [`GITHUB_CLI_AND_ACTIONS_CHECK.md`](GITHUB_CLI_AND_ACTIONS_CHECK.md)).

## See also

- [`/git-safe-sync-and-push`](../../.factory/commands/git-safe-sync-and-push.md) — the sanctioned push path. This runbook **wraps** it; it does not replace any of its safety rules.
- [`GITHUB_CLI_AND_ACTIONS_CHECK.md`](GITHUB_CLI_AND_ACTIONS_CHECK.md) + [`/ci-check`](../../.factory/commands/ci-check.md) / `npm run ci:investigate` — how to detect, classify, and reproduce a CI failure.
- [`CI_PIPELINE.md`](CI_PIPELINE.md) — canonical release matrix; **beta trigger rules**; the documented E2E-gate flip criterion.
- [`CI_WORKFLOW_GOTCHAS.md`](CI_WORKFLOW_GOTCHAS.md) — **known failure classes + diagnostic playbook**: the Windows-build publish chokepoint, embedded-shell parse traps, local-vs-CI env masking, `gh api` job-logs when `gh run view --log` is empty, and the repeat-N flake-characterisation spike. Read this when a beta job fails.
- [`CHIEF_ENGINEER2`](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) — orchestration workflow for non-trivial fixes (use **`bug_mode`** for failures that are bug-shaped); the **Phase 3 STOP rubric** is the escalation contract this runbook reuses.
- [`E2E_TEST_FIXING_GUIDELINES.md`](E2E_TEST_FIXING_GUIDELINES.md) — **STOP-gate before touching any E2E failure** — and [`WHY_E2E_TESTS_ARE_HARD_TO_FIX.md`](WHY_E2E_TESTS_ARE_HARD_TO_FIX.md), [`TESTING_E2E.md`](TESTING_E2E.md).
- [TESTING_AUTOMATION_OVERVIEW § live-API tier](TESTING_AUTOMATION_OVERVIEW.md#consolidated-live-api-tier-testslive-api--liveapiharness) + [WEEKLY_AUTOMATED_REVIEW §A](WEEKLY_AUTOMATED_REVIEW.md#a-confirm-green-5-min) — opt-in real-provider harness (`npm run test:live`); conditional pre-beta check in §5.1 below; weekly explicit run on `dev`.

---

## 1. What "push to beta" means

A beta release is triggered by pushing to `dev` with **`[deploy-beta]`** in any commit message in the push (or a manual `workflow_dispatch` of *Release Build and Publish* on `dev`). That fires [`release.yml`](../../.github/workflows/release.yml): validate → unit tests → 4 platform builds → **E2E Tests (macOS)** → publish to GCS → changelog/PostHog. See [`CI_PIPELINE.md`](CI_PIPELINE.md) § Dual-channel release system for the authoritative rules; do not duplicate them here.

**A full beta run takes ~1.5–2 hours.** The confirm-and-fix loop below is therefore long-running and self-paced — it is expected to span multiple turns / context windows.

## 2. Authorisation (what invoking this grants)

Invoking "push to beta" is a **standing, multi-cycle authorisation** for this turn and its self-paced continuations:

1. The push itself (the same authorisation [`/git-safe-sync-and-push`](../../.factory/commands/git-safe-sync-and-push.md) requires — see that doc's "Push Authorisation" section).
2. Watching the run to a terminal state.
3. **Diagnosing failures and applying fixes and re-pushing autonomously — but only within the risk ceiling in §4.** This is the one deliberate departure from the standing rule that auto-fix/auto-rerun/auto-push is forbidden (see the "Anti-patterns" note in [`GITHUB_CLI_AND_ACTIONS_CHECK.md`](GITHUB_CLI_AND_ACTIONS_CHECK.md)): that prohibition still governs *ordinary* CI checks; "push to beta" is the explicit per-turn opt-in that lifts it for the beta loop, bounded by §4.

It does **not** grant: force-pushing, anything tripping a [`git-safe-sync-and-push`](../../.factory/commands/git-safe-sync-and-push.md) escalation trigger (A–K), or any fix above the 🟡 tier in §4.

## 3. Definition of success — and the publish/conclusion divergence

**Success = the `release.yml` run reaches a green terminal state and the beta artifact actually published.** Watch both — they can diverge.

Beta publish **is** gated by **`chronic-e2e-staleness`** (a small fixed E2E subset) and by **`boot-smoke`** (does the packaged macOS app boot?), but **not** by the full `test-e2e` suite. Authoritative rules + spec list: [`CI_PIPELINE.md` § E2E gating criteria](CI_PIPELINE.md#e2e-gating-criteria). Operationally:
- **A chronic-spec failure SKIPS `publish-to-gcs` → nothing ships**, even if every other job is green (so a red run can mean "nothing shipped").
- **A `boot-smoke` failure SKIPS `publish-to-gcs` → nothing ships** (blocking on BOTH channels since 2026-06-23; darwin-only). The packaged app must reach `appReady`. This surfaces a won't-boot build *early* (~minutes), before the ~30+ min E2E jobs — but the local `npm run preflight:desktop-packaged-boot` (§5.1) catches it ~2h sooner still.
- **A non-chronic `test-e2e` failure does NOT block publish** — the run shows red but the artifact still publishes (terminal state `published_with_test_flakes`).

Consequences for this loop:
- **Always check the `Publish to Google Cloud Storage` job: `success` = shipped, `skipped` = blocked.** Report which — don't claim clean success on a red run, nor "nothing shipped" just because the run is red.
- Do **not** flip either E2E gate as part of this loop. That is a separate, documented risk decision (see CI_PIPELINE.md above).

## 4. The risk ceiling — autonomy ladder + hard caps

Before each autonomous fix-and-re-push, **diagnose first, then self-score** the fix on two axes (confidence it's correct × blast radius / reversibility) into one tier:

- **🟢 Autonomous (fix + re-push, no checkpoint).**
  - Flaky failure → re-run the run, no code change (see §6).
  - Fix confined to **test files or the failing spec**, or a clearly-diagnosed single-cause issue with a localized, obviously-correct fix.
  - Route through [`CHIEF_ENGINEER2`](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) *light*; re-push.
- **🟡 Autonomous, but announce + heavier review.**
  - Fix touches **product code** but is **single-subsystem, intent-preserving, and reversible**.
  - Route through `CHIEF_ENGINEER2` *medium* (in [`bug_mode`](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) if bug-shaped); post a brief recap per the [communication template](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/communication_to_user_template.md); re-push.
- **🔴 STOP and escalate to the user.** Any [`CHIEF_ENGINEER2` Phase 3 STOP trigger](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md#phase-3--user-checkpoint): guessing on a product call; a user-visible behaviour change not explicitly requested; a hard-to-reverse implication (schema, shared contract, prompt); the fundamental approach looks wrong; or unresolved unease another round won't settle.

**Complexity gate (applied before touching code):** if the diagnosed fix would exceed "single subsystem, intent-preserving, reversible," it auto-escalates to 🔴 *before* any edit — the loop does not attempt it.

**Hard caps (any breach → STOP and brief the user):**
1. **Cycle cap:** max **2** fix → push → re-check cycles (configurable up to 3, mirroring `CHIEF_ENGINEER2` §7's "3 cycles then escalate"). After the cap, stop and hand back with the diagnosis.
2. **Wall-clock / cost cap:** stop after roughly **one working day** of elapsed loop time (≈ 2 beta runs) or a stated token budget, whichever first.
3. **Repeated identical failure:** if the same failure recurs after a fix attempt, treat the diagnosis as wrong → STOP, don't keep grinding.

When you STOP, give a recap + importance flag + tutorial-quality brief + explicit ask, per the [communication template](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/communication_to_user_template.md).

## 5. The loop

```
push-to-beta:
  1. PRE-PUSH (§5.1)
  2. PUSH        → via /git-safe-sync-and-push, ensuring [deploy-beta]
  3. WATCH (§5.2)→ self-paced poll to terminal state
  4. TERMINAL?
       green  → DONE (report success; note artifact vs run if relevant)
       red    → DIAGNOSE (§5.3)
  5. DIAGNOSE → classify + risk-score (§4)
       flaky          → re-run run (§6), back to WATCH
       🟢/🟡 in ceiling → FIX, back to PUSH (cycle++)
       🔴 or cap hit   → STOP + brief user
```

### 5.1 Pre-push
- **Prefer a dedicated worktree, especially when other agents may be active.** A beta run is long (~1.5–2h) and the primary checkout is usually shared — committing/pushing there can entangle your work with a concurrent agent's in-progress commits (and vice versa). Provision one from the primary checkout with [`init-worktree.sh`](../../coding-agent-instructions/scripts/init-worktree.sh) (e.g. `coding-agent-instructions/scripts/init-worktree.sh push-beta`) and `cd` to the printed `WORKTREE_PATH`; its post-init installs deps and wires `push.default=upstream` so `/git-safe-sync-and-push` and the `[deploy-beta]` push target `dev` unchanged. One caveat: `.env.test` is gitignored, so copy it from the primary (`cp <primary-checkout>/.env.test .`) before the live-API tier. (The "don't run the Electron app from a worktree" rule doesn't apply to the packaged boot-smoke — it boots isolated with a temp `REBEL_USER_DATA`.)
- Handle the working tree exactly per [`/git-safe-sync-and-push`](../../.factory/commands/git-safe-sync-and-push.md) (commit-by-default, smell-test STOPs, submodule ordering). This runbook adds nothing to and overrides nothing in those safety rules.
- Ensure **`[deploy-beta]`** is in a commit message in the push (an empty `chore(release): Trigger beta deploy [deploy-beta]` commit is the established idiom — see recent history). Without it, `dev` pushes do **not** trigger a beta build.
- **De-risk the publish-blocking stages locally first — the cheapest way to avoid a dead ~2h run.** Publish gates on validate → unit tests → 4 platform builds **and the chronic E2E subset**; the full E2E suite does not (§3). Historically most beta failures died at validate/unit on a bug *already fixed on `dev`* — we simply hadn't run those stages locally before pushing. Run the local mirrors and push only when green:
  1. **dev-checks-green gate (CI-faithful — the single most reliable pre-beta signal).** Before spending a ~2h beta, confirm the [`dev-checks.yml`](../../.github/workflows/dev-checks.yml) workflow is **green on the exact tip you're shipping**: `npm run check:dev-checks-green` (defaults to current `HEAD` — prefer that; a *short* `--sha` won't match its full-SHA lookup, and don't pipe it through `tail`/`head`, which masks its exit code). It reads the latest dev-checks run for that SHA and exits 0 only if the `validate-and-test` jobs (the same Node-20 `reusable-validation.yml` tier release.yml's publish path transitively gates on) all concluded `success` — skipped/neutral jobs (e.g. the main-only changelog gate) don't count against you. **Why this matters:** the local mirrors below can't reproduce CI's *timing* (fork-pool contention, type-aware-lint worker budgets, CI-only timeouts) — two doomed betas died on a CI-only failure the local de-risk passed clean. dev-checks runs in the real CI environment, so it's the only cheap signal that catches that class. The empty `[deploy-beta]` commit changes no code, so green on the code tip is the green you need; push your fixes to `dev`, wait for dev-checks to finish, confirm green, *then* add `[deploy-beta]`. Non-zero exit blocks (red / still-running / no-run-for-SHA / `gh` error — it never assumes green); override with `--force` only for a failure genuinely unrelated to the publish path, and note it in the push. (**Scope / residual risk:** dev-checks-green certifies only the `validate-and-test` tier. The release-only jobs aren't in dev-checks and stay uncovered — the four platform builds, **MCP Integration**, gpu-worker-wasm-smoke, and E2E. The **Windows build/install is both the dominant residual failure and the publish chokepoint** — handled by-construction in release.yml but not locally reproducible on macOS — so it's the first job to watch once the run starts (§5.2). See [`CI_WORKFLOW_GOTCHAS.md`](CI_WORKFLOW_GOTCHAS.md) §3–4.)
  2. **Recent-failure check** — `gh run list --workflow=release.yml --branch dev --limit 8`, then `npm run ci:investigate -- --run-id <last-failed-id>`. Confirm the class that killed recent runs is fixed on current `dev`; don't blind-push into a since-fixed-but-unverified stage.
  3. **Unit tests** — `npm run test:fast` (the desktop+evals tier the CI unit job approximates).
  4. **validate:fast** — runs in the pre-push hook anyway; run it standalone first if iterating. It includes `validate:workflow-powershell-syntax`, the guard for the deterministic Windows-PowerShell parse class (the one publish-blocking stage you can't fully reproduce on macOS).
  - …then the **desktop boot-smoke** and **live-API tier** checks below.
- **Live-API tier (conditional pre-beta check):** confirm the live-API tier is green before a beta push — run `npm run test:live` if there is no recent green run (~24h) **or** the push touches provider/routing/settings-surface code. ~10–20 min wall-clock, pennies of provider spend; needs `.env.test` populated (`npm run capture-live-api-keys -- --apply` merges into existing `.env.test` — hand-maintained lines survive; for OAuth-auth Anthropic the script falls back to `evals/configs/.local/keys.env` automatically; in a worktree, copy `.env.test` from the primary checkout first — gitignored — and if the Codex live test fails on a missing `node_modules/electron/path.txt`, run `node node_modules/electron/install.js`, since a worktree's copy-on-write `node_modules` skips Electron's binary download). Don't pipe `npm run test:live` through `tail`/`head` — it masks the exit code; details in [WEEKLY_AUTOMATED_REVIEW §A](WEEKLY_AUTOMATED_REVIEW.md#a-confirm-green-5-min). **Why:** beta ships provider code; this tier is the only check that exercises real provider APIs, and it is **not** part of any per-push gate or the release workflow. How-to + skip-vs-fail policy: [TESTING_AUTOMATION_OVERVIEW § live-API tier](TESTING_AUTOMATION_OVERVIEW.md#consolidated-live-api-tier-testslive-api--liveapiharness). Same dev-side gap the weekly pass closes: [WEEKLY_AUTOMATED_REVIEW §A](WEEKLY_AUTOMATED_REVIEW.md#a-confirm-green-5-min).
- **Cloud-service surface (local, ~25s — only if the push touches cloud paths).** [`cloud-ci`](../../.github/workflows/cloud-ci.yml) (cloud-service build + `--project=cloud-service` tests + cloud-client unit/e2e) is **not** on the desktop beta's publish path — the cloud-service ships separately (sftp/Fly), so a red `cloud-ci` does **not** block the beta artifact — *and* it is not a per-PR-required gate, so it can rot red on `dev` unnoticed (a *detector outage* — see [DAILY_AUTOMATED_REVIEW § A](DAILY_AUTOMATED_REVIEW.md)). If this push touches cloud paths (`cloud-service/**`, `cloud-client/**`, `packages/shared/**`, `src/core/**`, `src/shared/**`, `src/main/ipc/**`, `src/main/services/**`), mirror that lane locally before pushing: `npm run test:cloud:ci-local` (build-independent suites in parallel; ~25s locally vs ~8.5 min on CI, which is mostly cold `npm ci`). This is a de-risk, not a publish gate — but it catches a cloud regression before it lands. **Caveat:** the local run has the `rebel-system` submodule present, so it can't reproduce the *submodule-absence* failure class — that one is only ever visible in `cloud-ci` itself.
- **Desktop boot-smoke (recommended local pre-push step):** run `npm run preflight:desktop-packaged-boot` — it packages the current HEAD, boots the packaged desktop app, and fails fast (non-zero) unless it reaches `appReady`. Cheapest guard against the biggest uncovered class: "compiles + passes unit tests in dev, crashes only when packaged." Without it, a won't-boot build surfaces only later as CI failures (the CI `boot-smoke` gate catches it and blocks publish — §3 — within minutes of the build, but still after a wasted build; the chronic E2E gate would also catch it ~2h in). Catches packaged load/bundle/alias failures; does NOT cover real-user recovery paths suppressed in test-mode. Skip only for a documented emergency or on explicit user direction, and note the skip in the push. (Desktop only.)
- **Chronic publish-gating E2E subset (run on every beta push — it's the gate most likely to block you).** The three chronic specs (`settings`, `quality-tier-selector`, `onboarding-organisation-grouping`) are the *only* E2E that blocks `publish-to-gcs` ([§3](#3-definition-of-success--and-the-publishconclusion-divergence)), and they run **only in the beta workflow — never on PRs or dev-checks**, so they go stale *silently*: a renderer / DOM / test-id / catalog-data change merges green on its PR and breaks one weeks before the beta that dies on it — and the agent pushing the beta is usually not the one who broke it (so "my change doesn't touch those surfaces" is *not* safety — the staleness is independent of your diff). **Run them unconditionally.** The boot-smoke step above already packaged HEAD, so `test:e2e:chronic` reuses that `out/` build — ~5–8 min, no second package: `set -a && source .env.test && set +a && npm run test:e2e:chronic` (the same single-source script the release gate runs — [`CI_PIPELINE.md` § E2E gating criteria](CI_PIPELINE.md#e2e-gating-criteria)). This validates the **stable-named** package boot-smoke built, which is equivalent for staleness / DOM regressions (these specs aren't channel-gated); it does *not* mirror the beta app identity (`Mindstone Rebel Beta`) — for exact parity, package *and* run with `BUILD_CHANNEL=beta` (you then can't reuse boot-smoke's package). If you skipped boot-smoke, `npm run package` first. Playwright uses `retries: 0` locally (CI uses 1), so **re-run the subset once before classifying a failure**: a deterministic repeat is stale/regression — fix it per §6 *before* pushing; a run-to-run difference is a local flake, not a push blocker.
- **Optional pre-flight for *non-chronic* E2E surfaces (`--preflight-e2e`):** the chronic subset above is unconditional; *additionally*, if the change obviously touches another E2E-covered surface (approval/inbox UI, other renderer DOM, test ids, IPC event names), consider running that **targeted spec subset** locally too — see §6. Off by default (slow, and a non-chronic failure doesn't block publish — §3); worth it when you already suspect a UI area.

### 5.2 Watch (self-paced)
- Find the run: `gh run list --branch dev --limit 5` → the *Release Build and Publish* run for your push; capture its `<run-id>`.
- **Watch the Windows build first.** It gates publish and is the most common blocker, but surfaces *late* (~60+ min in, after packaging) — so a doomed run looks healthy for over an hour. A red Windows build is publish-blocking even when every other job is green. Why: [`CI_WORKFLOW_GOTCHAS.md`](CI_WORKFLOW_GOTCHAS.md) §3.
- Poll with `npm run ci:investigate -- --run-id <id>` (deterministic packet; `status: in_progress | classified | no_failure | unknown | hard_error`) or `gh run watch <id>`.
- **Cadence** (mind the 5-min prompt-cache window): while builds/tests are early, sleep **~1200s** between checks (one cache miss buys a long wait — the run won't finish for ~1.5h). As the run nears the E2E/publish stages, tighten to **~270s** (stays in cache). Use `ScheduleWakeup` with a long fallback heartbeat so the loop survives a hung run; don't poll faster than the run can change.

### 5.3 Diagnose
- Run `npm run ci:investigate -- --run-id <id>` for the classified packet (workflow → failed job → local repro → suggested lens).
- **For an E2E failure, read the failed spec list directly** — the log names them (`✘ … some.spec.ts:line`). That list *is* your targeted local-repro set (§6); you don't have to guess.
- Classify real-regression vs stale-test vs flaky (see §6), then risk-score per §4.
- **Close the learning loop (after each terminal run).** If a run failed on a *new* class, add it to [`CI_WORKFLOW_GOTCHAS.md`](CI_WORKFLOW_GOTCHAS.md); and if a cheap local check would have caught it pre-push, add that check to the §5.1 de-risk ladder. This makes the ladder self-improving — it front-loads whatever has actually been blocking us, so the upfront checks keep getting better over time.

## 6. E2E handling (special-cased — read the STOP-gate first)

E2E is where beta runs most often fail, and where naive retries waste hours. **Before changing any E2E test or its target code, read [`E2E_TEST_FIXING_GUIDELINES.md`](E2E_TEST_FIXING_GUIDELINES.md)** (and [`WHY_E2E_TESTS_ARE_HARD_TO_FIX.md`](WHY_E2E_TESTS_ARE_HARD_TO_FIX.md) for prior attempts).

**Triage first — three buckets:**
- **Flaky:** failures that differ run-to-run, or are timing/teardown-shaped (`App close timeout`, worker teardown). Response: **re-run the run** (no code change), then back to Watch. This is the only "retry without diagnosis" path, and it is 🟢.
- **Real regression:** product behaviour or DOM actually changed and the test correctly catches it. Response: fix per the §4 tier (often 🟡).
- **Stale test:** an intentional product/DOM change the test wasn't updated for — a coherent *cluster* of related tests failing **identically across runs**, right after a change to that area, is the signature. Response: update the spec (usually 🟢/🟡, test-only).

> **Why E2E specifically drifts:** these specs run **only in the beta release workflow, not on PRs** ([`CI_PIPELINE.md`](CI_PIPELINE.md)). A renderer/DOM/test-id change merges green on its PR and the stale-test breakage stays invisible until the next `[deploy-beta]`. So a beta E2E failure is *frequently* a stale test from a change made weeks earlier — diagnose before assuming a fresh regression. (Worked example: 2026-06-01, the whole `approval-flows` suite failed because a drawer header changed from `<button aria-expanded>` to a `<div>` on 2026-05-18 but `expandFirstDrawerGroup()` was never updated — a single-file, test-only fix that a blind re-run would never have resolved.)

> **The chronic gate is the publish single-point-of-failure** — apply the same three buckets, but disambiguate by *where* it failed. A **CI** chronic-spec failure *skips* `publish-to-gcs` ([§3](#3-definition-of-success--and-the-publishconclusion-divergence)), so nothing ships: if it lost *both* Playwright attempts it's publish-blocking stale/regression — **fix it** (the §5.1 pre-push run should have caught a stale one); if its logs show infra noise (cloud-service / app-close timeout) it's the flaky bucket → re-run the beta. A **local** chronic failure (the §5.1 pre-push run, `retries: 0`) needs one local re-run before you classify it — a deterministic repeat is stale/regression to fix before pushing, a run-to-run difference is a local flake. **Never push past a deterministic local chronic failure** — that's the one bypass this runbook does not sanction.

**Running the targeted subset locally:**
- Reproduce only the named specs: `npm run package` then run Playwright against the failed spec file(s) / `--grep` (full suite is ~30+ min; the subset is far cheaper).
- Driving the packaged Electron app in this harness: it won't stay resident under a no-TTY shell — use `npm run package` + Playwright `_electron.launch` (see the project verification notes), not `electron-forge start`.
- Re-run the same subset locally **after** a fix to confirm green before re-pushing.

## 7. Reporting back

- **Green:** state it plainly — run id, beta version published (`releases-beta/latest.json`), cycles used.
- **Shipped-but-red:** state both facts (artifact live + run red on which job) and why they diverge (§3).
- **Escalation (🔴 / cap):** recap + importance flag + tutorial-quality brief (root cause, the fix you'd make, why it crossed the ceiling) + explicit ask. Don't soft-claim success.
