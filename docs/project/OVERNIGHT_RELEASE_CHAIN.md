---
description: "Operator/maintainer doc for the overnight beta→prod release chain (scripts/overnight-release-chain.ts) — a deterministic, fail-closed, armed-off-by-default orchestrator. Built but NOT yet sanctioned for unattended go-live."
last_updated: "2026-06-21"
---

# Overnight Release Chain

> ## ⚠️ NOT YET SANCTIONED FOR UNATTENDED GO-LIVE
>
> The machinery is built and **inert** (armed-off-by-default): with no arming flags it runs a beta,
> evaluates the gates, and writes a morning report — and **never touches `main`.** Actually arming a real
> production advance requires **all** of the following, and **all are still pending**:
>
> 1. the **release-policy sign-off** ([draft](../plans/260621_overnight-release-chain/DRAFT_policy-and-signposts.md), not yet applied to live policy);
> 2. **S8a merged + green-in-CI** (the stable publish-blocking packaged-boot gate — deferred to the go-live package);
> 3. the [**go-live readiness checklist**](#go-live-readiness-checklist) below, all items true.
>
> Until those land, treat this as a tool you can run in `--dry-run` and as the default unattended
> beta+gates+report path — **not** as an auto-promoter. The policy still forbids unattended production
> advance ([`PROMOTE_BETA_TO_PRODUCTION.md` §2](PROMOTE_BETA_TO_PRODUCTION.md)).

## What this is

`scripts/overnight-release-chain.ts` chains: **cut a beta → watch it → run auto-blocking gates →
(optionally) advance production → watch stable → write a loud morning report**, so a maintainer can kick
off a beta→prod release once before bed and read the outcome in the morning. It is the
"laptop-only, look-in-the-morning" flavour of the long-planned overnight chain: the operator consciously
accepts **morning review as the response window**, so a *minimum* deterministic gate set replaces the
human's mid-chain "do I still want to ship this?" tap.

It is a **script, not an agent.** It makes no judgment calls, fixes nothing, and never re-cuts a beta.
A non-green beta or a failed gate simply **stops the chain and reports** — there is no overnight auto-fix
path, by design.

The full design, the two prior GPT safety reviews (41/100 → 84/100 with items F1–F12), the amendments
A1–A8, the failure-mode matrix, and the S8a-deferred decision live in
[`docs/plans/260621_overnight-release-chain/PLAN.md`](../plans/260621_overnight-release-chain/PLAN.md).
The proposed policy rewrite that would sanction the armed path is the
[DRAFT proposal](../plans/260621_overnight-release-chain/DRAFT_policy-and-signposts.md).

## See also

- [`PROMOTE_BETA_TO_PRODUCTION.md`](PROMOTE_BETA_TO_PRODUCTION.md) — the normal, human-driven promote runbook the armed advance reuses as a subprocess. Its §2 ("explicit user authorisation", "no automated/scheduled/time-based promotion") is the policy this chain is currently subordinate to.
- [`RELEASE_TO_PRODUCTION.md`](RELEASE_TO_PRODUCTION.md) — the production-release policy + the "Who can push to stable" bypass mechanics (why Phase 1 is laptop-authenticated).
- [`RELEASE_TO_BETA.md`](RELEASE_TO_BETA.md) — the beta runbook; the watch-loop / risk-ceiling / shipped-but-red reporting shapes originate there.
- [`CI_PIPELINE.md`](CI_PIPELINE.md) — the dual-channel release matrix; the `[deploy-beta]` → `beta-deploy-trigger.yml` → dispatched `release.yml` indirection the chain binds through, and the clean-green semantics the gate reads.
- [`scripts/promote-to-production.ts`](../../scripts/promote-to-production.ts) — the production advance driver the armed path shells out to.

---

## Architecture

### Chain flow

The orchestrator runs as a single, linear, fail-closed sequence (`runOvernightReleaseChain` in
`scripts/overnight-release-chain.ts`). Every gate is "pass → continue, anything else → STOP + report":

1. **Run-lock** — refuse a second concurrent chain. A lockfile (default `/tmp/mindstone-rebel-overnight-release-chain.lock`) with a PID + acquired-at timestamp and a stale-TTL (default 18h). A held, non-stale lock ⇒ exit `LOCK_HELD` (75) before any push or gate.
2. **Capture dev HEAD** — `git rev-parse HEAD`. The captured subject **must already contain `[deploy-beta]`** — the chain refuses to inject the marker implicitly.
3. **Pre-beta de-risk** — runs the configured pre-beta commands (default `npm run check:dev-checks-green` then `npm run validate:fast`). A failure ⇒ STOP (`beta-failed`).
4. **Push `[deploy-beta]`** — via the sanctioned path (default `npx tsx scripts/git-safe-sync.ts --validate`), which fires `beta-deploy-trigger.yml`. (Per-turn push permission still applies — the chain is *invoked by* an authorised operator.)
5. **Bind candidate** (S-CB) — find the dispatched `release.yml` run and freeze the exact candidate identity. Fail-closed on a skipped trigger or an ambiguous (>1) match.
6. **Watch beta** — poll the dispatched run to terminal within a bounded window (default 180 min). A non-`success` conclusion ⇒ STOP (`beta-failed`); still-running past the window ⇒ STOP (`stopped-beta-incomplete`).
7. **Gate: clean-green** (S-CG) — must be a true clean-green; anything else (incl. "could-not-determine") ⇒ STOP (`stopped-at-gate-clean-green`).
8. **Gate: Sentry** (S-SENTRY) — must be a clean release; anything else ⇒ STOP (`stopped-at-gate-sentry`).
9. **Gate: promote pre-flight** — `evaluatePromotePreflight` over the bound SHA (the same 7-gate verdict the manual promote uses). Not eligible ⇒ STOP (`stopped-at-gate-preflight`).
10. **ARMED?** (S-ARM verify against the binding):
    - **Not armed (default):** STOP at the boundary (`not-armed-stopped-before-advance`), emit the morning report with the exact one-command to finish manually, **never touch `main`.**
    - **Armed:** invoke the advance **as a subprocess** (see below).
11. **Watch stable** — delegated to the promote driver, which advances `main` (FF `git push`), confirms a stable run started, and watches publish.
12. **Morning report** (S-REPORT) — the structured, evidence-bundle outcome (terminal state + finish command).

The single advance call site is guarded by a documented **catastrophic invariant** (the only place in
the file that can move `main`): it is reachable **only** when *every* prior gate returned a pass **AND**
`verifyArming(...).armed === true` **AND** `--dry-run` is false. The chain uses `try/finally` (release
the lock) with no swallowing `catch`, so an unexpected error stops the chain rather than falling through
to an advance.

### The four gate libs

Each gate is a pure, dependency-injected helper under `scripts/lib/` (all git/gh/network calls are
injected, so unit tests run no live commands or network):

- **`release-candidate-binding.ts`** (S-CB) — captures and freezes the candidate the whole chain is *about*: dev HEAD SHA, the dispatched `release.yml` run (id/headSha/createdAt), the source package version, and the derived beta published version; every later gate is re-checked against this immutable `CandidateBinding`.
- **`ci-clean-green.ts`** (S-CG) — turns a finished beta run into `cleanGreen: boolean | null` by reading **step outcomes** (not bare job success), the `realboot` conclusion, the E2E `clean-green` flake verdict, and per-platform manifest completeness; any unknown ⇒ `null` (blocking).
- **`sentry-promote-gate.ts`** (S-SENTRY) — queries the Sentry project issues endpoint scoped to the exact beta release tag (`mindstone-rebel-beta@<betaVersion>`) for unresolved error/fatal issues; fail-closed on missing token / 401 / 403 / network / shape / unobserved-release, and ≥1 matching issue ⇒ block.
- **`release-arming.ts`** (S-ARM) — the off-by-default authorisation: a **pure verify** that the composed arming flags exactly match the frozen binding and fall within the wall-clock TTL; returns `armed` only when every field agrees. It imports no production-driver symbol.

### Why the advance is a subprocess

When armed, the orchestrator does **not** `import { runPromoteToProduction }`. It shells out:

```
npx tsx scripts/promote-to-production.ts --commit <boundSha> --confirm-changelog-current <boundSourceVersion>
```

(with `REBEL_CERTIFIED_PROMOTE_SHA=<boundSha>` in the subprocess env). This is Amendment **A2**, and it
is mandatory. The rationale is the **catastrophic invariant**: by holding no `main`-touching symbol in
its own address space, the orchestrator makes "advance without authorisation" *unrepresentable* rather
than merely guarded — the promote driver's own in-code, non-TTY checkpoint fail-closes **independently of
any orchestrator bug**. Outcome observability is preserved by the driver's distinct exit codes
(`run-not-triggered`, `publish-not-confirmed`, `0 == shipped`); the orchestrator treats **any non-zero
promote exit as "stopped, did NOT ship"** and reports that `main` MAY have advanced.

## The armed-off-by-default model

The default run is **inert with respect to production**: no arming flags ⇒ the chain runs the beta, the
gates, and the report, and stops at the arming boundary having never touched `main`. This is identical to
running the existing manual chain and reading the morning report yourself — the auto-advance code ships
disabled.

**Arming** is one-candidate, fail-closed, and expressed as composed exact-match flags (Amendment **A1** —
there is no minted/signed token, because the only actor who can arm is the operator on their own laptop
with their own bypass auth, and the FF advance is idempotent, so a nonce defends nothing). Arming
requires **all** of:

- `--arm-production`
- `--candidate-sha <sha>` — must equal the frozen candidate head SHA
- `--confirm-changelog-current <sourceVersion>` — must equal the frozen **source package** version (e.g. `0.4.49`, *not* the beta `0.4.49NNNN` — see A3)
- a fresh **wall-clock TTL window** (`--armed-at-iso <iso>`; default TTL 12h) — stale or future arming ⇒ not armed
- the recorded **attestations** (A6/A7), each a `--flag` the chain records into the evidence bundle:
  - `--attest-s8a-green-in-ci` — operator attests S8a is merged + green-in-CI (this *cannot* be runtime-verified at arming time because the stable run post-dates arming, so it is an honest recorded attestation, not a fakeable check)
  - `--attest-policy-signed-off` — operator attests the policy/go-live sign-off marker is present
  - `--accept-no-soak-no-paging` — the **named risk-acceptance clause**: *"No beta soak threshold and no automated paging/rollback are evaluated; I accept morning review as the response window."*

Any missing flag, any mismatch against the binding, or an expired window ⇒ **not armed** ⇒ the chain
runs beta + gates + report and never advances. The arming inputs are re-verified against the frozen
binding *immediately before* the advance.

## How to run it

All commands run from a release-owned checkout where `.env.local` (the Sentry token) is present.

**Default (inert) run** — cut a beta, gate it, report; never touches `main`:

```bash
npx tsx scripts/overnight-release-chain.ts
```

**Preview against a historical beta** — `--dry-run` evaluates a given or the latest historical beta run
and **touches nothing** (no `[deploy-beta]` push, no advance):

```bash
npx tsx scripts/overnight-release-chain.ts --dry-run --explain-json
npx tsx scripts/overnight-release-chain.ts --dry-run --dry-run-run-id <runId> --explain-json
```

`--explain-json` prints the gathered facts + each gate verdict + the would-be terminal decision as JSON
(otherwise the human-readable report is printed).

**Armed run (NOT YET SANCTIONED — for reference only):** once the go-live checklist is satisfied, an
armed invocation looks like:

```bash
npx tsx scripts/overnight-release-chain.ts \
  --arm-production \
  --candidate-sha <devHeadSha> \
  --confirm-changelog-current <sourceVersion> \
  --armed-at-iso <iso-now> \
  --attest-s8a-green-in-ci \
  --attest-policy-signed-off \
  --accept-no-soak-no-paging
```

Useful tuning flags: `--beta-dispatch-wait-minutes` (default 10), `--beta-watch-minutes` (default 180).

### Reading the morning report

The report (and the `--explain-json` object) leads with a **terminal status** and a **verdict line**, an
**evidence bundle**, the per-gate results, and a **manual finish/retry** section. Terminal states:

- `promoted` — the subprocess driver shipped (exit 0). No finish command needed.
- `not-armed-stopped-before-advance` — gates passed, no arming → stopped at the boundary. The report carries the **exact one-command** to finish manually (the bound SHA / version / run-ids are inlined).
- `stopped-at-gate-clean-green` / `stopped-at-gate-sentry` / `stopped-at-gate-preflight` — a gate blocked; the reason names the blocking input. The finish command is present once a binding exists.
- `beta-failed` — the beta run, the pre-beta de-risk, or the push failed.
- `stopped-beta-incomplete` — run-lock held, no `[deploy-beta]` subject, skipped/ambiguous dispatch, or the beta didn't reach terminal within the window.
- `promote-driver-<exitname>` — the advance subprocess returned non-zero. **`main` MAY have advanced** but the driver did NOT confirm a completed ship — investigate `main` / the stable run before re-running.

The verdict is **never a bare "GO."** When promoted it states "Promoted. Deterministic gates PASSED;
soak NOT evaluated; morning review is the response window," surfacing the F1 risk acceptance rather than
hiding it.

### Fail-closed posture

Every gate biases to STOP. "Could-not-determine" (a `null` from any gate — API down, token missing,
name-drifted job, unobtainable verdict) is treated as a **block**, never an optimistic pass. The default
chain never advances production; the advance is reached only when all gates pass AND armed-for-this-exact-candidate
AND not-dry-run. A non-green beta stops the chain; nothing in the script mutates the tree or re-cuts a
beta.

## GO-LIVE READINESS CHECKLIST

**All of these must be true before arming a real candidate.** They are deliberately outside the script
because the script cannot verify them at arming time (and must not pretend to).

- [ ] **Policy sign-off landed.** The [draft policy rewrite](../plans/260621_overnight-release-chain/DRAFT_policy-and-signposts.md) of `PROMOTE_BETA_TO_PRODUCTION.md` §2 and `RELEASE_TO_PRODUCTION.md` § Policy is reviewed, approved, and applied to the live docs.
- [ ] **S8a implemented + CI-verified.** The stable publish-blocking packaged-boot gate is merged, and verified in an authorized CI run to **(a) block publish on a synthetic mutation** and **(b) be green on a real build**. (Deferred to the go-live package; spec on the S8a stage in the PLAN. Without it, an armed advance has no automated catch for a stable-identity packaging/sign/notarize regression.)
- [ ] **Sentry release-scoped token confirmed.** One live read confirms the release-scoped `SENTRY_AUTH_TOKEN` can read the project releases-detail endpoint (`GET /api/0/projects/mindstone/rebel/releases/<tag>/`). The gate fail-closes on a 403 (so there is no false-green risk) — but an unreadable endpoint makes the Sentry gate a **permanent STOP**, so confirm it can read before relying on the chain.
- [~] **`--dry-run` real-historical backtest run** — *partially satisfied (2026-06-21).* Run `--dry-run` against actual recent betas of each shape — a clean-green published beta (would-promote-if-armed), a `published_with_test_flakes` beta (clean-green blocks), a cancelled run (fail-closed), a flaky-but-green run (E2E verdict blocks), a partial-publish run (publish-to-gcs ≠ success blocks) — and confirm each verdict matches expectation. The in-repo dry-run tests use synthetic fixtures; the real-data backtest is the central de-risker and needs live `gh`. **Done so far** ([`BACKTEST_REAL_HISTORICAL.md`](../plans/260621_overnight-release-chain/BACKTEST_REAL_HISTORICAL.md)): candidate-binding + the cancelled/failure fail-closed shapes validated on real `gh` data, and a real bug fixed (F-BT1: `realExec` lacked `maxBuffer`, so the multi-MB `gh run view --log` read overflowed Node's 1 MB default and made clean-green fail closed on every real run). **Still pending** the **happy-path arm** (F-BT2): no published beta yet carries the brand-new `realboot` job (added 2026-06-19), so "clean-green → would-promote-if-armed" must be re-run against the **first realboot-bearing beta** with `SENTRY_AUTH_TOKEN` present before this box is fully ticked.
- [ ] **Laptop-awake operational note.** The host must stay awake and networked for the chain's duration (`caffeinate` on the laptop is the simplest path). If it sleeps or drops network mid-chain, the chain fails closed (a beta may ship; the promote won't). **True off-laptop operation is deferred** (Phase-2 GitHub-App bypass-actor token — see [`RELEASE_TO_PRODUCTION.md` § Who can push to stable](RELEASE_TO_PRODUCTION.md#who-can-push-to-stable-branch-protection)).

## What is deliberately NOT built (deferred)

Per the PLAN's scope, these are explicitly out of scope and must not be quietly assumed complete:

- **F1 — soak/exposure threshold.** No minimum beta dwell / install-exposure gate. The Sentry gate is *basic*, not a soak; zero matching events is "no blocking signal in the window," not evidence of safety. Morning review is the accepted response window.
- **F7 — rollback / alerting / paging contract.** No automated paging on a bad ship, no freeze/rollback handoff. A bad auto-shipped stable build is already on users via auto-update by morning — which is exactly what the A7 named risk-acceptance clause makes the operator acknowledge.
- **True off-laptop host** (GitHub App token) and **real production go-live** — both Phase-2.
