---
description: Promote a beta-certified SHA to production by fast-forwarding main to it (auto-triggers the stable release.yml build)
argument-hint: --commit <certified-sha> [--dry-run] [--explain-json] [--confirm-changelog-current <version>]
---

# Promote to Production

> **What this is.** The **primary** way a beta-certified build reaches production. It advances `main`
> to an already-frozen, already-beta-tested SHA via a single **fast-forward `git push`**
> (`git push origin <sha>:refs/heads/main`), which auto-triggers the stable `release.yml` build. No
> `dev` checkout, no branch switch, no merge commit — so it is **concurrency-safe** (dev keeps moving).
> It's a `git push` and **not** a `gh api` refs PATCH because on a ruleset-protected `main` GitHub
> honors the bypass for the **user's** push (receive-pack), not for the gh OAuth-app API call (which
> 404s). **Phase 1** is therefore a laptop-authenticated push (CI does the build); true off-laptop
> promotion (Phase 2) needs a GitHub App installation token added as an explicit ruleset bypass actor.
> The local [`scripts/release-to-production.ts`](../../scripts/release-to-production.ts) remains the emergency/fallback path.

The driver is [`scripts/promote-to-production.ts`](../../scripts/promote-to-production.ts). The policy
("when may we promote") lives in [`PROMOTE_BETA_TO_PRODUCTION.md`](../../docs/project/PROMOTE_BETA_TO_PRODUCTION.md)
and [`RELEASE_TO_PRODUCTION.md`](../../docs/project/RELEASE_TO_PRODUCTION.md); this is the *how*.

## ⛔ This advances PRODUCTION — the one hard gate

**Promoting to production requires the user's explicit per-turn authorisation, every time.** There is
**no standing authorisation** and **no automated/scheduled/time-based promotion**. Unlike `/git-safe-sync-and-push`,
**invoking this command is NOT the authorisation** — the user must explicitly ask to promote *this* build.

The driver enforces a **hard human checkpoint in code** (not just in this doc): it stops and asks for
`y` on an interactive terminal. The only non-interactive bypass is an exact-version
`--confirm-changelog-current <version>` that must match the SHA's version — `--yes` does **not** skip it.
This checkpoint is the *only* thing standing between an agent that can push `main` and production, so it
is fail-closed on a non-TTY. (The push itself DOES run the local pre-push hook — the certified-promote
fast path via `REBEL_CERTIFIED_PROMOTE_SHA`, never `--no-verify` — but the hook gates the tree, not the
intent; only this checkpoint gates the *decision to ship*.)

## How to run

1. **Identify the certified SHA.** The user names the beta version/SHA, or read it from
   `releases-beta/latest.json`. It must be a build that already shipped green to beta.
2. **Preview first (read-only — never advances main):**
   ```bash
   npx tsx scripts/promote-to-production.ts --commit <certified-sha> --dry-run
   ```
   This runs the full fail-closed pre-flight, prints the per-gate verdict, and logs the **exact** push
   it *would* make — without executing it. `--explain-json` instead dumps the gathered facts +
   verdict as JSON (also a preview; useful for backtesting).

   > **What "preview" guarantees.** `--dry-run` and `--explain-json` **never advance `main`, never
   > push, and never modify the working tree.** They *do* perform **read-only remote-ref fetches**
   > (`git fetch` of `origin/main` + `origin/dev`, and submodule remote refspecs) so the preview is
   > computed against **live** state, not a stale local checkout — that is intentional and desirable.
   > "Touches nothing" means *no production/working-tree change*, not "issues zero git commands".
3. **Promote (real — requires the checkpoint):**
   ```bash
   npx tsx scripts/promote-to-production.ts --commit <certified-sha>
   ```
   The driver: hard-binds `origin` to `mindstone/rebel-app` → gathers facts (refreshing
   `origin/main`/`origin/dev` from the remote first) → evaluates the pre-flight → **stops at the human
   checkpoint** → does the fast-forward push (with the pre-push gate; can take a few min) → says
   *"ref update complete; confirming CI trigger…"* + a calibrated ETA → **confirms a stable run
   actually started**, and only *then* emits **"✅ handoff complete — local work done, safe to close
   your laptop"** → watches the GCS manifest to terminal and reports (run id, version, manifest advanced).

   > **NOTE — watch window vs build time.** The driver's GCS watch is bounded (45 min). A full stable
   > build (macOS+Windows+Linux+E2E) can run longer, so the watch may exit `PUBLISH_NOT_CONFIRMED` as a
   > *soft "still running"* before the build publishes — that is **not** a failure (main advanced + run
   > started = the laptop-closable bar was met); confirm the GCS manifest / run to terminal separately.

   **Exit 0 means *shipped*, not "the push returned":** after `main` advances, if no stable run
   starts the driver exits non-zero (`RUN_NOT_TRIGGERED` = *main advanced but no stable run
   triggered — investigate*); if the GCS manifest never advances it exits `PUBLISH_NOT_CONFIRMED`.
   Both make clear `main` **has** advanced, so you know the live state.

## The pre-flight gates (all fail-closed)

The promote is **not eligible** — and `main` is **never touched** — unless **every** gate affirmatively
passes (any "could-not-determine" blocks):

- **sha-valid** — a canonical full git oid AND a real commit object.
- **sha-on-dev** — the SHA is an ancestor of `origin/dev`.
- **beta-certified** — the beta `release.yml` run for *this exact SHA* had validate-and-test + all
  platform builds + `publish-to-gcs` green.
- **changelog-heading** — a `## v<version>` heading exists in the changelog **at the SHA** (stable
  hard-requires it; beta doesn't, so a certified SHA can still be under `## Unreleased`).
- **fast-forward** — `origin/main` is an ancestor of the SHA (a clean fast-forward; the production tree
  becomes *exactly* the beta-tested tree, no merge commit).
- **submodules-resolve** — every submodule pointer the SHA pins still resolves on its remote (catches
  the OSS-squash orphan class — *"cut a fresh beta"* when this blocks).
- **version-ahead** — the SHA's `package.json` version is a canonical `X.Y.Z` and `> origin/main`.

## Fast-forward safety (why `main` can't ship an un-certified tree)

The advance is a plain `git push` refspec (no `+`, no `--force`), so **git rejects a non-fast-forward**
— and the repo's `non_fast_forward` ruleset rule is a server-side backstop (belt + braces). If `main`
moved since pre-flight (e.g. a direct hotfix), the driver maps git's `! [rejected] … (non-fast-forward)`
status line to a human-legible **"main moved — re-run"** and exits non-zero. A `[remote rejected]`
ruleset/permission decline is classified separately as `REF_UPDATE_FAILED` (never mislabelled "main
moved"). It **never** retries or forces. A non-fast-forward is not a promotion — re-brief the user (it
would be an emergency direct cut per `RELEASE_TO_PRODUCTION.md`).

## After the ref update

`main` advancing auto-triggers the stable `release.yml` build (~25–30 min: stable identity, signing,
notarization, publish — beta never exercised these). The driver watches the GCS manifest and reports.
**Watch the stable run to terminal** per [`RELEASE_TO_BETA.md`](../../docs/project/RELEASE_TO_BETA.md)
§5–§7 (watch cadence, 🟢/🟡/🔴 risk ceiling, reporting shapes — reused by reference). A transient CI
infra failure or one-off flake the beta already passed is 🟢: `gh run rerun --failed <run-id>` (the
commit is already on `main` — no re-push), then back to watching.

## See also

- [`PROMOTE_BETA_TO_PRODUCTION.md`](../../docs/project/PROMOTE_BETA_TO_PRODUCTION.md) — the runbook + the pre-flight scan philosophy.
- [`RELEASE_TO_PRODUCTION.md`](../../docs/project/RELEASE_TO_PRODUCTION.md) — the production-release policy + the emergency direct-cut escape hatch.
- [`scripts/release-to-production.ts`](../../scripts/release-to-production.ts) — the retained emergency/fallback local promote.
- [`CI_PIPELINE.md`](../../docs/project/CI_PIPELINE.md) — the dual-channel release matrix and stable-only gates.
