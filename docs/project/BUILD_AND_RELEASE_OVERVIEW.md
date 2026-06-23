---
description: "Territory hub for build, CI, beta/production releases, rollback, and distribution — routes to every release-family runbook"
last_updated: "2026-06-14"
---

# Build and Release Overview

This document provides a quick orientation to how Mindstone Rebel is built, released, and distributed to users.

## See also

### Project Documentation

| Doc | Purpose |
|-----|---------|
| [DEPLOYMENT_GUIDE](./DEPLOYMENT_GUIDE.md) | All deployment surfaces (desktop, cloud, mobile), rollout management, CI/CD plans |
| [BUILDING](./BUILDING.md) | npm scripts, build outputs, bundled Node, local testing |
| [CI_PIPELINE](./CI_PIPELINE.md) | CI automation, branch rules, GCS artifacts |
| [DISTRIBUTION](./DISTRIBUTION.md) | Auto-updates, code signing, platform-specific details |
| [AUTO_UPDATE](./AUTO_UPDATE.md) | Auto-update architecture, Squirrel behavior, troubleshooting |
| [RELEASE_TO_BETA](./RELEASE_TO_BETA.md) | Runbook: push to the beta channel (watch + fix-in-ceiling loop) |
| [RELEASE_TO_MOBILE](./RELEASE_TO_MOBILE.md) | Runbook: the mobile (iOS + Android) EAS pipeline — TestFlight/Play, credentials, watch/diagnose, Hermes bundle gotchas. **Separate pipeline from the desktop beta.** |
| [RELEASE_TO_PRODUCTION](./RELEASE_TO_PRODUCTION.md) | **Production-release policy** + emergency escape hatch |
| [PROMOTE_BETA_TO_PRODUCTION](./PROMOTE_BETA_TO_PRODUCTION.md) | **Normal production path**: promote a beta-certified commit (on explicit user request) |
| [PROD_INCIDENT_ROLLBACK](./PROD_INCIDENT_ROLLBACK.md) | **Bad build reached stable**: stop-the-bleed feed freeze, forward-only roll-forward |
| [FREEZE_UPDATE_FEED](./FREEZE_UPDATE_FEED.md) | **Stop-the-bleed runbook**: the concrete GCS procedure to freeze the stable update feed at a previous good version (executable detail behind PROD_INCIDENT_ROLLBACK Option B) |
| [GITHUB_CLI_AND_ACTIONS_CHECK](./GITHUB_CLI_AND_ACTIONS_CHECK.md) | Detect, classify, and reproduce CI failures (`npm run ci:investigate`; wrapped by the [`/ci-check`](../../.factory/commands/ci-check.md) command) |
| [CI_WORKFLOW_GOTCHAS](./CI_WORKFLOW_GOTCHAS.md) | Known CI failure classes + diagnostic playbook (Windows publish chokepoint, embedded-shell parse traps, beta-E2E stale-test drift) |
| [RELEASING](./RELEASING.md) | Step-by-step runbook for releasing new versions |
| [REBEL_SYSTEM_SYNC](./REBEL_SYSTEM_SYNC.md) | How rebel-system instructions are bundled with releases |
| [CHANGELOG_UPDATE_PROCESS](./CHANGELOG_UPDATE_PROCESS.md) | How to update the changelogs (user-facing + internal; required before version bumps) |
| [INTERNAL_CHANGELOG_PIPELINE](./INTERNAL_CHANGELOG_PIPELINE.md) | Auto-generated per-beta internal release notes (`INTERNAL_CHANGELOG.md` → Slack `#general`) |
| [WINDOWS_SUPPORT](./WINDOWS_SUPPORT.md) | Windows-specific implementation details |
| [`scripts/release-to-production.ts`](../../scripts/release-to-production.ts) | CLI script automating production releases (driven by [`/release-to-production`](../../.factory/commands/release-to-production.md)) |

### Research Documentation (Installer/Updater)

| Doc | Purpose |
|-----|---------|
| [260202_Squirrel_vs_NSIS_Deep_Dive](../research/260202_Squirrel_vs_NSIS_Windows_Installer_Deep_Dive.md) | **Squirrel vs NSIS comparison, migration recommendation** |
| [260127_Installer_Updater_Recommendation](../research/260127_Installer_Updater_Recommendation.md) | NSIS + electron-updater analysis |
| [260127_Bulletproof_Auto_Update_Analysis](../research/260127_Bulletproof_Auto_Update_Analysis.md) | Graceful shutdown patterns, race conditions |

## Quick reference

### "I want to..."

| Task | Start here |
|------|------------|
| Build the app locally | [BUILDING.md](./BUILDING.md) |
| Understand what CI does | [CI_PIPELINE.md](./CI_PIPELINE.md) |
| Check the cloud-service CI lane | [CI_PIPELINE.md](./CI_PIPELINE.md) — `cloud-ci` is neither on the release-publish path nor a required check, so it can rot red on `dev` unnoticed; mirror it locally in ~25s with `npm run test:cloud:ci-local`, or confirm green on `dev` per [DAILY_AUTOMATED_REVIEW.md § A](./DAILY_AUTOMATED_REVIEW.md) |
| Push to the beta channel | [RELEASE_TO_BETA.md](./RELEASE_TO_BETA.md) — note: a beta deploy is now gated on a **pre-beta `dev-checks-green`** check (`npm run check:dev-checks-green`) so a red `dev` doesn't ship to beta (2026-06-14) |
| Release to production | [RELEASE_TO_PRODUCTION.md](./RELEASE_TO_PRODUCTION.md) → promote a beta-certified commit ([PROMOTE_BETA_TO_PRODUCTION.md](./PROMOTE_BETA_TO_PRODUCTION.md)), on explicit user request |
| Release / diagnose the mobile app (iOS + Android) | [RELEASE_TO_MOBILE.md](./RELEASE_TO_MOBILE.md) — Expo EAS → TestFlight / Google Play; a separate pipeline from the desktop beta |
| Release mechanics / version bump steps | [RELEASING.md](./RELEASING.md) |
| Respond to a bad build on stable | [PROD_INCIDENT_ROLLBACK.md](./PROD_INCIDENT_ROLLBACK.md) |
| Freeze the update feed at a previous version | [FREEZE_UPDATE_FEED.md](./FREEZE_UPDATE_FEED.md) |
| Diagnose a failed CI run | [GITHUB_CLI_AND_ACTIONS_CHECK.md](./GITHUB_CLI_AND_ACTIONS_CHECK.md), then [CI_WORKFLOW_GOTCHAS.md](./CI_WORKFLOW_GOTCHAS.md) for known failure classes |
| Update the changelogs | [CHANGELOG_UPDATE_PROCESS.md](./CHANGELOG_UPDATE_PROCESS.md) |
| Fix a Gatekeeper/install issue | [DISTRIBUTION.md](./DISTRIBUTION.md) |
| Update rebel-system instructions | [REBEL_SYSTEM_SYNC.md](./REBEL_SYSTEM_SYNC.md) |
| Understand the OSS-mirror publish gates (incl. the Linux boot-smoke publish gate) | [CI_PIPELINE.md § OSS mirror publish](./CI_PIPELINE.md#oss-mirror-publish); boot-smoke detail in [OSS_BUILD_SMOKE_RUNBOOK.md](./OSS_BUILD_SMOKE_RUNBOOK.md) |

### Key concepts

- **Two release channels**: Beta (`dev` branch) and Stable (`main` branch) are separate apps that can coexist on the same machine.
- **Auto-updates**: Users receive updates automatically via GCS-hosted manifests.
- **Bundled Node.js**: The packaged app includes a complete Node.js environment for MCP servers.
- **Signed but not notarized**: macOS builds are Developer ID-signed but trigger Gatekeeper warnings on first launch.

### Release-engineering invariants

- **Sentry-pipeline changes get a live canary.** Any change to the Sentry delivery pipeline includes a real-app envelope/sink validation in the beta-push path, and the first post-change beta includes a live canary event confirmed to index before the pipeline counts as healthy.
- **OS/CPU-conditional native binaries need a full lockfile.** When adding packages with platform-conditional native binaries, regenerate `package-lock.json` with `--include=optional` and validate cross-platform install, so optional platform deps aren't omitted from the lockfile.
- **`extraResources` must be codesign-safe.** No broken symlinks, no nested unsigned binaries, no host-specific dangling paths — any of these breaks signing on the packaging machine.

### Build commands

```bash
npm run build        # Compile TypeScript bundles
npm run package      # Create app bundle for local testing
npm run package:run  # Package + open .app (one-command production-quality local run)
npm run make         # Create distributable installer (DMG/exe)
```


