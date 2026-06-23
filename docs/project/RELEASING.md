---
description: "Reference for stable and beta releases using the scripted production flow and CI pipelines"
last_updated: "2026-06-04"
dependencies:
  - "./BUILD_AND_RELEASE_OVERVIEW.md"
  - "./CI_PIPELINE.md"
  - "./CHANGELOG_UPDATE_PROCESS.md"
  - "../../scripts/release-to-production.ts"
  - "../../.github/workflows/release.yml"
  - "../../.github/workflows/beta-deploy-trigger.yml"
---

# Releasing Mindstone Rebel

## Why this doc exists

Production releases are intentionally scripted so we keep release safety checks consistent and avoid one-off manual flows. This doc captures the release intent and guardrails; script and workflow files remain the implementation source of truth.

## Source of truth

- [`scripts/release-to-production.ts`](../../scripts/release-to-production.ts) — production release orchestration and safety checks.
- [`.github/workflows/release.yml`](../../.github/workflows/release.yml) — build + publish workflow for stable/beta channels.
- [`.github/workflows/beta-deploy-trigger.yml`](../../.github/workflows/beta-deploy-trigger.yml) — opt-in beta trigger from `dev` pushes.
- [CI_PIPELINE](./CI_PIPELINE.md) — branch rules, channel behavior, artifact paths, and manual dispatch.
- [CHANGELOG_UPDATE_PROCESS](./CHANGELOG_UPDATE_PROCESS.md) — required changelog update flow before releases.
- [BUILD_AND_RELEASE_OVERVIEW](./BUILD_AND_RELEASE_OVERVIEW.md) — hub linking all release/build references.

## Runbooks (agent-executed procedures)

This doc captures release intent and guardrails. For the step-by-step procedures an agent follows:

- [RELEASE_TO_PRODUCTION](./RELEASE_TO_PRODUCTION.md) — production-release **policy** + the rare emergency direct-cut escape hatch.
- [PROMOTE_BETA_TO_PRODUCTION](./PROMOTE_BETA_TO_PRODUCTION.md) — the **normal path**: promote a beta-certified commit to stable (on explicit user request).
- [RELEASE_TO_BETA](./RELEASE_TO_BETA.md) — get a candidate onto the beta channel first.

## Release model (decision-level)

- **Stable channel**: push to `main` triggers release CI for external users.
- **Beta channel**: push to `dev` triggers a beta release only when `[deploy-beta]` appears in at least one pushed commit message (or when `release.yml` is manually dispatched on `dev`).
- **Versioning intent**:
  - Stable releases must move version forward relative to `main`.
  - Beta versions are computed in CI and do not require manual `package.json` bumps.

## Pre-release checklist (human-owned)

Before releasing to stable:

1. Update both changelogs via [CHANGELOG_UPDATE_PROCESS](./CHANGELOG_UPDATE_PROCESS.md).
2. Ensure `rebel-system/help-for-humans/changelog.md` includes `## v<package.json version>` for the target release (CI enforces this on `main`).
3. Confirm the candidate has been validated on `dev`/beta.
4. Confirm submodule commits are pushed (release script and CI both enforce this).
5. Choose bump strategy (`patch` default, or `--minor` / `--major`).

## Production release (recommended path)

Run from `dev`:

```bash
npx tsx scripts/release-to-production.ts
```

Common variants:

```bash
npx tsx scripts/release-to-production.ts --dry-run
npx tsx scripts/release-to-production.ts --minor
npx tsx scripts/release-to-production.ts --major
npx tsx scripts/release-to-production.ts --commit <sha>
```

What the script guarantees:

1. Validates repo safety (`dev` branch, fetch state, submodule safety, working tree policy).
2. Syncs local `dev`; in normal mode, forward-integrates `origin/main` into `dev` first.
3. Enforces version progression vs `origin/main` (bumps and pushes `dev` when needed).
4. Requires a **mandatory human checkpoint** (`y`) before continuing release-changing actions.
5. Merges to `main`, validates MCP lockfiles/builds, runs `npm run validate:fast`, then pushes `main`.
6. After successful push, auto-bumps `dev` patch version for the next cycle.

If conflicts or validators fail, the script intentionally stops and prints recovery steps; fix and rerun.

## Beta deploy

To trigger beta CI from `dev`, include `[deploy-beta]` in at least one commit message in the push.

This is picked up by [`.github/workflows/beta-deploy-trigger.yml`](../../.github/workflows/beta-deploy-trigger.yml), which dispatches [`.github/workflows/release.yml`](../../.github/workflows/release.yml) on `dev`.

Notes:

- No manual `package.json` bump is needed for beta.
- You can manually run `release.yml` on branch `dev` from GitHub Actions when needed.

## CI behavior after trigger

`release.yml` builds macOS/Windows/Linux artifacts, publishes channel-specific update feeds/manifests to GCS, and posts release/build notifications.

For stable (`main`) releases, CI also:

- Verifies the user-facing changelog contains the releasing version section.
- Uploads `rebel-system/help-for-humans/changelog.md` to `gs://mindstone-rebel/releases/changelog.md`.

See [CI_PIPELINE](./CI_PIPELINE.md) for full pipeline detail.

## Guardrails

- Tags do **not** trigger release builds.
- Release publishing is branch-gated: `main` (stable), `dev` (beta), plus temporary feature branches when needed (e.g., `feature/auto-update-nsis-migration` currently allowed for isolated auto-update testing).
- Prefer the production release script over manual merge/push sequences to preserve safety invariants.

## Post-release checks (manual)

- Monitor workflow status: <https://github.com/mindstone/rebel-app/actions>
- Verify published versions:

```bash
curl -s https://storage.googleapis.com/mindstone-rebel/releases/latest.json | jq .version
curl -s https://storage.googleapis.com/mindstone-rebel/releases-beta/latest.json | jq .version
```
