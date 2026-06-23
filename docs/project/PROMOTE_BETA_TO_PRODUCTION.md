---
description: "Runbook for promoting beta-certified builds to production — pre-flight checks, fast-forward safety, CI-triggered promote (FF git push)"
last_updated: "2026-06-21"
---

# Promote Beta to Production

> **Goal:** promote a **beta-certified** commit — one that already shipped to the beta channel and passed
> its release checks — to the **stable/production** channel. This is the **normal, preferred** way code
> reaches production. It is done **only when the user explicitly asks for it**, after a pre-flight safety
> scan surfaces anything worth knowing first.

This is a **runbook**, executed by an agent. The umbrella policy (and the rare emergency alternative)
lives in [`RELEASE_TO_PRODUCTION.md`](RELEASE_TO_PRODUCTION.md); this doc is the procedure for the normal path.

## See also

- [`RELEASE_TO_PRODUCTION.md`](RELEASE_TO_PRODUCTION.md) — the production-release **policy** + the emergency direct-cut escape hatch. Read it for *when* a production release is allowed; read this for *how* to promote.
- [`RELEASE_TO_BETA.md`](RELEASE_TO_BETA.md) — the sibling runbook. The **risk-ceiling, watch-loop, and shipped-but-red reporting shapes are defined there**; this doc reuses them by reference rather than restating.
- [`scripts/release-to-production.ts`](../../scripts/release-to-production.ts) — the local push primitive (via `--commit <sha>`), now the **fallback** to the CI-triggered promote below. The production analogue of [`/git-safe-sync-and-push`](../../.factory/commands/git-safe-sync-and-push.md).
- [`scripts/promote-to-production.ts`](../../scripts/promote-to-production.ts) + [`.factory/commands/promote-to-production.md`](../../.factory/commands/promote-to-production.md) — the **CI-triggered promote** driver/command (FF-only `git push` advance of `main`); pre-flight verdict in [`scripts/promote-preflight.ts`](../../scripts/promote-preflight.ts) (`evaluatePromotePreflight`) over facts from [`scripts/promote-preflight-facts.ts`](../../scripts/promote-preflight-facts.ts) (`gatherPromoteFacts`).
- [`CI_PIPELINE.md`](CI_PIPELINE.md) — the canonical dual-channel release matrix, gates, and version/identity rules. **Do not restate them here.**
- [`CHANGELOG_UPDATE_PROCESS.md`](CHANGELOG_UPDATE_PROCESS.md) — the changelog flow. Relevant here because stable hard-requires a `## v<version>` heading the beta build never needed; verify/fix it as a pre-flight (§3) so you don't confirm into a mid-run failure.
- [`SENTRY_TRIAGE.md`](SENTRY_TRIAGE.md) + [`CODE_HEALTH_TOOLS.md`](CODE_HEALTH_TOOLS.md) — the pre-flight scan signposts (§3).
- [`CHIEF_ENGINEER2`](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md#phase-3--user-checkpoint) Phase 3 STOP rubric — the escalation contract.

---

## 1. What this is

Promoting a **specific commit SHA** that already had a successful **beta** release (see §3 for what
"successful" means) to the stable channel, by running a fresh stable build/sign/publish of that exact
commit (a clean fast-forward of `main` in the normal case — §4). It is the preferred production path
because the code has already passed the full beta release pipeline and had real beta-user exposure.

It is **not** republishing the beta binary — the stable artifact is a different build (stable app
identity, bundle id, update feed; see [`CI_PIPELINE.md`](CI_PIPELINE.md)). The promotion runs a fresh
stable build; what it safely *avoids* is re-litigating whether the commit is good (beta + your
authorisation already settled that). The stable build and its validation still run (§4, §6).

## 2. The one hard gate — explicit user authorisation

**We promote beta → production *only* because the user explicitly requested/authorised it, every time.**

- There is **no standing authorisation** (contrast [`RELEASE_TO_BETA.md`](RELEASE_TO_BETA.md) §2, where invoking the runbook *is* the authorisation) and **no automated, scheduled, or time-based promotion**. "It's been on beta a while" is never, by itself, a reason to promote.
- Invoking this runbook authorises the *mechanics* below (the build watch-loop, transient-failure re-runs within the risk ceiling) — but **not** the decision to promote, which is the user's explicit ask, and **not** the shared production checkpoint (`scripts/lib/release-checkpoint.ts`, used by both the promote and fallback paths), which remains a hard human stop.

## 3. Pre-flight safety scan (surface concerns; the user decides)

**Identify and verify the candidate SHA first.** Get `<certified-sha>` (the user names the beta
version/SHA, or read it from `releases-beta/latest.json`). Then verify *that exact SHA* — not merely
the latest `dev` run — had a successful beta `release.yml` run:

```bash
gh run list --workflow release.yml --branch dev --commit <certified-sha> \
  --json databaseId,headSha,status,conclusion,url
gh run view <run-id> --json headSha,jobs,url   # confirm headSha == <certified-sha>
```

Require `validate-and-test`, all three platform builds (macOS / Windows / Linux), and `publish-to-gcs`
= **success** on that run. (E2E is recorded separately — see the bullet below.)

Then scan for reasons it might be a bad idea. **If anything below raises a concern, flag it to the user
and ask whether to proceed anyway — do not silently block, and do not silently proceed.**

- **Beta-certified (hard requirement).** The SHA's beta [`release.yml`](../../.github/workflows/release.yml) run must have had `validate-and-test` + all platform builds + `publish-to-gcs` **green** (i.e. the beta artifact actually published). Here, **"beta-certified" means the publish gate succeeded** — intentionally narrower than [`RELEASE_TO_BETA.md`](RELEASE_TO_BETA.md)'s preferred green-terminal-run, because E2E is ungated on both channels ([`CI_PIPELINE.md`](CI_PIPELINE.md)). If E2E was red, that is **not** automatically disqualifying and **not** a clean pass either — record it and raise it as a concern to the user. If the SHA was never beta-certified at all, this is not a promotion — see the emergency path in [`RELEASE_TO_PRODUCTION.md`](RELEASE_TO_PRODUCTION.md).
- **Stable changelog heading (verify-and-fix pre-flight, not just flag).** Stable releases hard-require a `## v<version>` heading (matching `package.json`) in `rebel-system/help-for-humans/changelog.md`; **beta does not** (see [`CI_PIPELINE.md`](CI_PIPELINE.md) § Stable builds). A beta-certified SHA can therefore still have its notes under `## Unreleased`, which the stable build — and `release-to-production.ts`'s pre-merge check — will reject. Verify the heading exists for the candidate version now; if it's still `## Unreleased`, fix it per [`CHANGELOG_UPDATE_PROCESS.md`](CHANGELOG_UPDATE_PROCESS.md) (rename `## Unreleased` → `## v<version> — <date range>`) **before** §5. This is a promotion of frozen code, so you're adjusting the heading, not writing new entries. The script catches this too and prints the rename steps — doing it here is the earlier, cheaper warning.
- **Sentry triage (flag-and-ask).** Per [`SENTRY_TRIAGE.md`](SENTRY_TRIAGE.md): scan for new SHOULD-FIX issues and `source:user-bug-report` entries since the beta shipped — especially any correlating with that beta version. Surface them; let the user weigh them.
- **Code health (flag-and-ask).** Mostly already covered by the beta run's `validate:fast` gate (see [`CODE_HEALTH_TOOLS.md`](CODE_HEALTH_TOOLS.md)); a full periodic sweep is not a per-promotion gate. Surface anything notable you already know.
- **Known problems (flag-and-ask).** Anything you or the team already know is wrong with this build/version.

## 4. Fast-forward check (agent pre-flight)

**Both promote paths enforce this by construction**, so this agent check is an *early* warning, not the
only guard: the preferred `promote-to-production.ts` blocks in its fail-closed pre-flight (the
clean-fast-forward gate, §5.0) and then advances FF-only (`git push origin <sha>:refs/heads/main` — git
rejects a non-fast-forward); the fallback `release-to-production.ts --commit` uses its
`--require-fast-forward` guard (on by default: re-checks `origin/main` is an ancestor of the SHA after its
post-checkpoint `main` pull, then merges with `--ff-only` so a non-fast-forward aborts rather than building
an un-certified merge commit). Still do the agent pre-flight check below — it catches a non-fast-forward
*early*, before you start the run, rather than mid-promotion:

```bash
git fetch origin main --quiet
expected_main=$(git rev-parse origin/main)   # remember for the checkpoint recheck (§5)
git merge-base --is-ancestor "$expected_main" <certified-sha> && echo "fast-forward" || echo "NOT a fast-forward"
```

- **Fast-forward (the normal case)** — `main` can advance directly to the SHA. The preferred path pushes
  the SHA straight to `refs/heads/main` (FF-only); the fallback `merge`s it with `--ff-only`. Either way
  `main`'s HEAD becomes *exactly* the SHA — so the production tree is *exactly* the beta-tested tree.
  Proceed.
- **Not a fast-forward** — `main` moved independently since the SHA (e.g. a prior hotfix on `main`). A
  merge would produce a tree that was **never beta-certified**, breaking the core invariant of a
  promotion. **STOP** — do not promote via this runbook; re-brief the user. If they still want to ship,
  that is an emergency direct cut (full validation, explicit permission) per
  [`RELEASE_TO_PRODUCTION.md`](RELEASE_TO_PRODUCTION.md) — not a promotion.

## 5. Promote

### 5.0 Preferred: CI-triggered promote (FF-only `git push` advance)

The preferred mechanism is `scripts/promote-to-production.ts` (the `/promote-to-production` command). It advances `main` to the frozen, beta-certified SHA via a **single fast-forward-only `git push`** — `git push origin <certified-sha>:refs/heads/main` (a plain refspec: no `--force`, no leading `+`, so git itself rejects a non-fast-forward; the repo's `non_fast_forward` ruleset backstops it). The push auto-triggers the stable `release.yml`, and runs `.husky/pre-push` on the **certified-promote fast path** (`REBEL_CERTIFIED_PROMOTE_SHA` set by the driver → `validate:fast` + `realboot` only, skipping the redundant `test:fast`/`test:perf`; never `--no-verify`). A non-fast-forward rejection maps to "main moved — re-run", never a retry or force. No `dev` checkout, no branch switch — concurrency-safe by construction.

> **Why a `git push`, not a `gh api PATCH`?** The ruleset bypass is honoured for `git push` (receive-pack) but **not** the low-level refs API, so a PATCH 404s on the protected `main` even for a repo admin — which is why **Phase 1** is laptop-authenticated (CI still does the build) and off-laptop **Phase 2** needs a GitHub App bypass-actor token. The bypass mechanics (and the 2026-06-19 incident that proved this) are canonical in [`RELEASE_TO_PRODUCTION.md` § Who can push to stable](RELEASE_TO_PRODUCTION.md#who-can-push-to-stable-branch-protection); the full code-level record is the [`scripts/promote-to-production.ts`](../../scripts/promote-to-production.ts) header.

Before touching `main`, the driver runs:

1. A pure, **fail-closed pre-flight verdict** — `gatherPromoteFacts` (live read-only refresh of `origin/main` + `origin/dev`) → `evaluatePromotePreflight` ([`scripts/promote-preflight.ts`](../../scripts/promote-preflight.ts)). It gates SHA-validity, on-dev, beta-certified, `## v<version>` changelog heading **at the SHA**, clean fast-forward, submodule-pointers-resolve, and version-ahead. Any gate that does not affirmatively pass — including any "could-not-determine" — blocks; it prints the verdict and exits non-zero **without touching `main`**. (`--explain-json` prints the facts + verdict; `--dry-run` previews the exact `git push` without making it.)
2. The same **hard human checkpoint** as the local script (`scripts/lib/release-checkpoint.ts`, enforced in code) — fail-closed on a non-TTY; the only non-interactive bypass is an exact-version `--confirm-changelog-current <version>`.

The §3 pre-flight scan and §4 fast-forward check above are still your responsibility — they surface concerns the user weighs *before* you invoke the driver. After the push, exit 0 means *shipped* (the driver confirms a stable run started, then watches publish), not merely "the push returned 0". Then watch the stable `release.yml` run and report exactly as in §5.1 step 4 below (the watch cadence, risk ceiling, and reporting shapes are identical).

### 5.1 Fallback: local `release-to-production.ts --commit`

If the CI-triggered path isn't viable, drive the local push primitive instead:

1. From a **clean, release-owned checkout** of `dev` (never a checkout another agent is committing into — see [`/git-safe-sync-and-push`](../../.factory/commands/git-safe-sync-and-push.md) working-tree rules).
2. Run the push primitive on the certified SHA:
   ```bash
   npx tsx scripts/release-to-production.ts --commit <certified-sha>
   ```
   Note what `--commit` validates: SHA format/object, ancestor-of-`origin/dev`, version >
   `origin/main`, and — by default — fast-forward safety (§4, the `--require-fast-forward` guard). It
   does **not** verify beta certification (§3); that remains your pre-flight responsibility above.
3. **The script pauses at a mandatory human checkpoint** — a hard stop, satisfied only by the explicit authorisation of §2. **Before confirming, re-check the fast-forward hasn't gone stale** — the script re-fetches `main` and `merge`s *after* the checkpoint, so if `main` advanced since §4 the merge would build an un-certified tree:
   ```bash
   git fetch origin main --quiet
   [ "$(git rev-parse origin/main)" = "$expected_main" ] \
     && git merge-base --is-ancestor origin/main <certified-sha> \
     && echo "still a fast-forward — OK to confirm" || echo "main MOVED — DO NOT confirm"
   ```
   If `main` moved, answer anything other than `y`, abort, and re-brief the user (it is no longer a clean promotion). *(The script's `--require-fast-forward` guard also enforces this by construction at merge time — this recheck is the human-facing early warning so you don't confirm into an abort.)*
4. **Watch the stable `release.yml` run to terminal** and report, exactly per [`RELEASE_TO_BETA.md`](RELEASE_TO_BETA.md) §5–§7 (watch cadence, the 🟢/🟡/🔴 risk ceiling, the publish/conclusion divergence, and the reporting shapes) — reused by reference. A transient CI infra failure (e.g. artifact `BlobNotFound`) or a one-off flaky test the beta run already passed is 🟢: **`gh run rerun --failed <run-id>`** (the commit is already on `main`; no re-push), then back to watching; re-diagnose if it recurs. **If instead the *script itself* aborted before pushing** (validator / MCP-build / push failure), there is **no CI run to rerun** — you are merged-but-unpushed on `main`; follow the script's on-screen recovery (fix → `git push origin main`, or `git reset --hard origin/main` to abort).

> **Certified-promote pre-push gate (since 2026-06).** Because a `--commit --ff-only` promote pushes a
> tree that was already beta-certified *and* is re-validated by stable CI before publish, the pre-push hook
> **skips the redundant local `test:fast` + `test:perf`** for this promote — it still runs `validate:fast`,
> `test:realboot` (stable CI now also runs this **observe-first** on both channels — see §6 — but the local hook run remains the gating one for this fallback path), and the always-on integrity gates. This is why a
> certified promote no longer OOMs a laptop running the full suite a third time. Any ambiguity (marker
> absent, not a fast-forward, not reachable from fresh `origin/dev`, parse/fetch failure) falls back to the
> **full** production suite, and a fresh **non-`--commit`** cut (the emergency escape hatch) always runs the
> full local suite. Mechanism: `REBEL_CERTIFIED_PROMOTE_SHA` set by the script + git proof in
> `.husky/pre-push` (see [`scripts/check-certified-promote.ts`](../../scripts/check-certified-promote.ts)).
>
> **Non-interactive checkpoint.** The human checkpoint (§5.0 step 2 / §5.1 step 3) can be satisfied without a TTY **only** via an
> explicit, version-matched `--confirm-changelog-current <version>` (e.g. `--confirm-changelog-current
> 0.4.49`) that must equal the release version exactly — a stale copied command can't acknowledge the wrong
> release. `--yes` does **not** skip the checkpoint.

## 6. What the promotion cannot skip

The stable build/sign/notarize/installer/update-metadata/publish steps **always run** — beta exercises
that machinery but not the stable app identity, update feed, or stable-only changelog validation (the
`## v<version>` heading gate — see [`CI_PIPELINE.md`](CI_PIPELINE.md) and the §3 pre-flight, fixed via
[`CHANGELOG_UPDATE_PROCESS.md`](CHANGELOG_UPDATE_PROCESS.md)). "Beta was green" makes a stable-publish failure unlikely, not
impossible — which is why §5 watches the run to terminal.

> **Real-boot agent-turn gate (observe-first).** The CI-triggered promote advances `main` via a
> fast-forward `git push` that **does** run `.husky/pre-push` (the certified-promote path runs `realboot`
> locally) — but that run is on the **promoter's machine**, not a CI gate, and the planned Phase-2
> off-laptop path runs no local hook at all. So the real-boot agent-turn suite (`npm run test:realboot`) —
> which used to run only in that pre-push hook (beta+ tier) — now also runs in `release.yml` on **both**
> channels, so the beta genuinely exercises it in CI. It is currently **OBSERVE-FIRST — visible on the run
> but NOT yet in `publish-to-gcs.needs`, so it does not block publish**. Don't treat it as a hard gate
> yet. See [`CI_PIPELINE.md` § E2E gating criteria](CI_PIPELINE.md#e2e-gating-criteria).
