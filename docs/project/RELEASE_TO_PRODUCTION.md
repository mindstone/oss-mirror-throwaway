---
description: "Production release policy for Rebel — beta promotion as the normal path, explicit authorisation, emergency direct cut"
last_updated: "2026-06-21"
---

# Release to Production

> **Goal:** state the **policy** for how code reaches the stable/production channel, and own the one rare
> exception. The normal mechanics live in [`PROMOTE_BETA_TO_PRODUCTION.md`](PROMOTE_BETA_TO_PRODUCTION.md);
> this doc is the rules + the emergency escape hatch.

## See also

- [`PROMOTE_BETA_TO_PRODUCTION.md`](PROMOTE_BETA_TO_PRODUCTION.md) — **the procedure** for the normal path (the pre-flight safety scan, fast-forward check, and the CI-triggered `promote-to-production.ts` advance — with `release-to-production.ts --commit` as the fallback).
- [`RELEASE_TO_BETA.md`](RELEASE_TO_BETA.md) — get to beta first; production promotes a beta-certified commit.
- [`scripts/release-to-production.ts`](../../scripts/release-to-production.ts) — the local push primitive: `--commit <sha>` drives the **promote-fallback** ([`PROMOTE_BETA_TO_PRODUCTION.md`](PROMOTE_BETA_TO_PRODUCTION.md) §5.1), bare drives the **emergency direct cut** (below).
- [`scripts/promote-to-production.ts`](../../scripts/promote-to-production.ts) — the **CI-triggered** promote driver (FF-only `git push` advance of `main`); pre-flight verdict in [`scripts/promote-preflight.ts`](../../scripts/promote-preflight.ts) + [`scripts/promote-preflight-facts.ts`](../../scripts/promote-preflight-facts.ts).
- [`CI_PIPELINE.md`](CI_PIPELINE.md) — the canonical channel/trigger/gate matrix.
- [`CHANGELOG_UPDATE_PROCESS.md`](CHANGELOG_UPDATE_PROCESS.md) — both stable paths (promotion and the emergency cut below) need a `## v<version>` heading in the user-facing changelog that beta never required; see [`PROMOTE_BETA_TO_PRODUCTION.md`](PROMOTE_BETA_TO_PRODUCTION.md) §3.
- [`PROD_INCIDENT_ROLLBACK.md`](PROD_INCIDENT_ROLLBACK.md) — the reverse direction: what to do when a bad build *reaches* stable (forward-only constraint, stop-the-bleed feed freeze, roll-forward fix).

---

## Policy

**Normal production releases are reached in exactly one way: by promoting a beta-certified commit to
stable — and only because the user explicitly requested it.** See
[`PROMOTE_BETA_TO_PRODUCTION.md`](PROMOTE_BETA_TO_PRODUCTION.md). The only path that skips beta is the
emergency escape hatch below — and it **also** requires explicit permission for that release (the
permission gate is never the exception; only the "must go through beta first" part is).

- No automated, scheduled, or "it's been on beta a while" production releases.
- Both gates are explicit and human: pushing to **beta** and promoting to **production** each require the user's explicit go ([`RELEASE_TO_BETA.md`](RELEASE_TO_BETA.md) §2; [`PROMOTE_BETA_TO_PRODUCTION.md`](PROMOTE_BETA_TO_PRODUCTION.md) §2).

### How a promotion advances `main` (mechanism)

The normal promotion drives a **CI-triggered** advance of `main`: `promote-to-production.ts` fast-forwards `main` to the beta-certified SHA (a plain FF `git push`) and lets the existing stable `release.yml` do the build — no `dev` checkout, concurrency-safe. **This does not change the policy above:** before touching `main` it runs a fail-closed pre-flight ([`scripts/promote-preflight.ts`](../../scripts/promote-preflight.ts)) and the same hard human checkpoint (`scripts/lib/release-checkpoint.ts`), and the phased zero-touch chain (`docs/plans/260619_ci-triggered-promote/PLAN.md`) keeps a human final tap for now.

- **Full procedure** (the FF-push refspec, the certified-promote pre-push fast path, the watch loop): [`PROMOTE_BETA_TO_PRODUCTION.md`](PROMOTE_BETA_TO_PRODUCTION.md) §5.
- **Why a `git push` and not a refs-API PATCH** (the bypass mechanics): § [Who can push to stable](#who-can-push-to-stable-branch-protection), below.

The local `release-to-production.ts` is the non-CI alternative, in **two distinct modes** — don't conflate them:

- `release-to-production.ts --commit <sha>` — the **fallback for a normal promote**: it still ships the *frozen, beta-certified* tree, just driven locally instead of via CI. Documented in [`PROMOTE_BETA_TO_PRODUCTION.md`](PROMOTE_BETA_TO_PRODUCTION.md) §5.1.
- `release-to-production.ts` (**bare**, no `--commit`) — the **emergency direct cut**: it ships *latest `dev`* (never beta-tested), with full validation retained. The escape hatch below.

## Who can push to stable (branch protection)

`main` is protected by an active ruleset ("Protect main"): it **requires pull requests** and blocks
force-pushes and deletions. Both production-advance mechanisms write to `main` directly and so both
need a **bypass team** (`backend-engineer` / `frontend-engineer`) account: the CI-triggered
`promote-to-production.ts` (a fast-forward `git push origin <sha>:refs/heads/main`) and the fallback `release-to-production.ts`
(a direct `git push origin main`). Both are `git push` (receive-pack), where the bypass is honoured —
a low-level `gh api PATCH` of the refs API is **not** a bypass actor on protected `main` and is rejected even for a repo admin. If you are not in a bypass team, the write is rejected with a "Changes must be made
through a pull request" / `GH006` error — that's the ruleset doing its job, **not** a script bug; either
push from a bypass-holding account or go via a PR. (This is distinct from the local agent-harness blocking
a *raw* `git push` to `main`: the sanctioned path is always the release script, never a hand-rolled push.)

This was learned the hard way on **2026-06-19**: the first CI-promote tried a `gh api PATCH` of the refs
API and got a masked **403→404** on protected `main` *even from a repo admin*, because GitHub evaluates
refs-API bypass against the **gh OAuth-app identity**, not the user's bypass-team membership (a `git push`
goes through receive-pack under the user's identity, which the bypass *does* honour). The access-design
consequences: **Phase 1** promotes are laptop-authenticated `git push`es (the operator's bypass-team
membership is what's honoured); true off-laptop **Phase 2** automation needs a dedicated **GitHub App
installation token added as an explicit ruleset bypass actor** — not the broad gh OAuth app, and not a PAT
impersonating a user.

## Emergency escape hatch — direct cut to stable

> **Bare mode, not `--commit`.** This is `release-to-production.ts` run *without* `--commit` — it ships **latest `dev`** (never beta-tested), which is what makes it an emergency cut rather than a promotion. Contrast the `--commit <sha>` *promote-fallback* in [`PROMOTE_BETA_TO_PRODUCTION.md`](PROMOTE_BETA_TO_PRODUCTION.md) §5.1, which ships a frozen, beta-certified tree.

A production release that has **not** first gone through beta is allowed **only**:

- with the user's **explicit permission** for *this* release (same hard gate as a promotion), **and**
- when the normal beta-then-promote path isn't viable (e.g. a critical fix that must ship now and beta is unavailable/broken).

It runs the **same** push primitive in its standard (non-`--commit`) mode, from a clean release-owned
`dev` checkout, with **full validation retained** (no skipping — the tree was never beta-tested) and the
same mandatory human checkpoint:

```bash
npx tsx scripts/release-to-production.ts
```

> **This is the normal latest-`dev` release, not a minimal cut.** In bare (non-`--commit`) mode the
> script forward-integrates `origin/main` and **pushes `dev`**, bumps the version on `dev` and pushes,
> merges to `main`, and **post-release-bumps `dev` again** — so expect two `origin/dev` pushes as a side
> effect. The early `confirmReleaseCheckpoint` (not skippable by `--yes`) is the human stop.
>
> **Run from a clean, release-owned checkout.** The script permits a dirty working tree after a
> confirmation prompt — but in an emergency cut, do **not** confirm past a dirty tree: abort, provision a
> clean release-owned checkout, and restart, so no stray/concurrent-agent work rides into the release.

Then watch the stable run to terminal and report, per [`PROMOTE_BETA_TO_PRODUCTION.md`](PROMOTE_BETA_TO_PRODUCTION.md) §5
(which itself reuses [`RELEASE_TO_BETA.md`](RELEASE_TO_BETA.md)'s watch-loop and risk ceiling). Prefer the
normal promotion path whenever it is at all viable; the escape hatch is the exception, not a shortcut.
