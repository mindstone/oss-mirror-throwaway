---
description: "What to do when a bad build reaches the stable/production channel — the forward-only constraint, stop-the-bleed feed freeze, and roll-forward fix"
last_updated: "2026-06-10"
---

# Production Incident & Rollback

> **Goal:** the recovery runbook for "we shipped a dud to stable." The push docs are all
> one-directional (how code *reaches* stable); this doc owns backing *out* of a bad release.

## See also

- [`FREEZE_UPDATE_FEED.md`](FREEZE_UPDATE_FEED.md) — the **concrete, validated GCS procedure** for Option B below (backups, the two-feed model, Mac/Windows commands, verification, and how a forward release lifts the freeze).
- [`RELEASE_TO_PRODUCTION.md`](RELEASE_TO_PRODUCTION.md) — production-release **policy** + the emergency direct-cut escape hatch (the roll-forward mechanism in §3 below).
- [`PROMOTE_BETA_TO_PRODUCTION.md`](PROMOTE_BETA_TO_PRODUCTION.md) — the normal promotion path; the preferred way to ship a fix forward when it can go through beta first.
- [`AUTO_UPDATE.md`](AUTO_UPDATE.md) — how clients receive updates (hourly poll, GCS feed, the `RELEASES.json` cache-control gotcha that governs how fast a freeze/fix propagates). Source: `src/main/services/autoUpdateService.ts`.
- [`CI_PIPELINE.md`](CI_PIPELINE.md) — channel/version/feed-URL matrix; stable feed lives at `gs://mindstone-rebel/updates/`.
- [`SENTRY_TRIAGE.md`](SENTRY_TRIAGE.md) — confirm blast radius / severity before choosing an option.
- [`DISTRIBUTION.md`](DISTRIBUTION.md) — feed URLs, signing, Linux manual-download path.

---

## The constraint that shapes everything

Auto-update is **forward-only**: `autoUpdateService.ts` sets `electronUpdater.allowDowngrade = false`
(Squirrel.Mac behaves the same), and there is **no kill-switch / remote-config / forced-minimum-version**
mechanism — `versionCheckService.ts` is a purely informational "you're N versions behind" banner.

Consequences:

- **There is no true rollback.** Clients already on the dud cannot be pulled back; the version number can only go *up*. Only a higher-versioned fix reaches them.
- **A re-publish of the same version reaches no one** — clients think they're current. Any fix must bump the patch above the dud.
- **Linux is manual-download only** — no auto-update; those users need separate comms.

## Option B — Stop the bleed (cap who catches it)

Clients poll **hourly** and there's a GCS cache TTL, so a fresh dud has only reached a fraction of users.
Repoint the stable update feed back at the previous good version so no *further* clients download the dud:

- macOS: `gs://mindstone-rebel/updates/darwin/<arch>/RELEASES.json` (`currentRelease`)
- Windows: `gs://mindstone-rebel/updates/<...>/latest.yml`

This is a **manual GCS object edit — there is no scripted yank** in `scripts/release-to-production.ts`.
It does nothing for already-updated clients (forward-only); it caps the spread while you prepare the fix.

> **Step-by-step procedure:** [`FREEZE_UPDATE_FEED.md`](FREEZE_UPDATE_FEED.md) — exact commands (backups, Mac `currentRelease` flip, Windows `latest.yml` reconstruction with a safe hash, `releases/latest.json` vs the `updates/` updater feed), post-write verification, and the no-manual-undo rule when the forward release lands.

> ⚠️ **Cache gotcha (the same one in [`AUTO_UPDATE.md`](AUTO_UPDATE.md)):** `RELEASES.json` uploads
> default to `cache-control: public, max-age=3600`, so a feed edit may not propagate for up to an hour.
> Re-upload with `-h "Cache-Control:no-cache,no-store,max-age=0,must-revalidate"` to make it land fast.
> The same TTL throttles how quickly Option C reaches users.

## Option C — Roll forward (the only real remedy)

Ship a **new stable release with a higher version** carrying the fix — the only thing that helps users
already on the dud. Two flavours:

- **Promote a fixed beta-certified commit** — [`PROMOTE_BETA_TO_PRODUCTION.md`](PROMOTE_BETA_TO_PRODUCTION.md). Safest; requires the fix to go through beta first.
- **Emergency direct cut** — the escape hatch in [`RELEASE_TO_PRODUCTION.md`](RELEASE_TO_PRODUCTION.md): full validation, explicit permission, from a clean release-owned `dev` checkout.

Gotchas: the emergency cut ships **latest `dev`** (and `--commit` requires the SHA be an ancestor of
`origin/dev`), so the fix must be on `dev` and `dev` must be shippable — if `dev` has moved on with risky
work, land just the fix cleanly first. The `## v<version>` changelog-heading gate applies here too (see
[`PROMOTE_BETA_TO_PRODUCTION.md`](PROMOTE_BETA_TO_PRODUCTION.md) §3).

## Recommended sequence

1. **Triage** severity + blast radius (Sentry, `source:user-bug-report`); confirm it's worth an out-of-band release.
2. **Option B** — freeze the feed at the last good version (with no-cache headers) to limit who catches it.
3. **Option C** — roll a higher-versioned fix forward (promotion if it can wait for beta; emergency cut if not).
4. Watch the stable run to terminal and report per [`RELEASE_TO_BETA.md`](RELEASE_TO_BETA.md) §5–§7 (reused by both production paths).

Nothing re-releases automatically (no scheduled promotion), so the system won't worsen on its own while you work.
