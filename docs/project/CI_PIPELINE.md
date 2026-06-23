---
description: "How release and supporting CI workflows are triggered, including opt-in beta deploys"
last_updated: "2026-06-21"
---

# CI Pipeline

This document explains how CI builds are triggered and where artifacts are stored.

## See also

- [BUILD_AND_RELEASE_OVERVIEW](./BUILD_AND_RELEASE_OVERVIEW.md) — hub for all build/release docs
- [BUILDING](./BUILDING.md) — local build commands and outputs
- [DISTRIBUTION](./DISTRIBUTION.md) — how builds reach users (auto-updates, signing)
- [RELEASING](./RELEASING.md) — step-by-step runbook for releasing
- [REBEL_SYSTEM_SYNC](./REBEL_SYSTEM_SYNC.md) — how rebel-system is bundled with releases
- [CI_WORKFLOW_GOTCHAS](./CI_WORKFLOW_GOTCHAS.md) — failure classes we've hit (embedded-shell parse traps, local-vs-CI masking, the Windows publish chokepoint) and their guards


## Dual-channel release system

The CI pipeline supports two release channels:

| Channel | Trigger | Version format | Users |
|---------|---------|----------------|-------|
| **Beta** | Push to `dev` with `[deploy-beta]` in a commit **subject line** (or manual dispatch on `dev`) | `0.3.NNNNN` (numeric from commit count) | Internal testers |
| **Stable** | Push to `main` | `0.2.10` | External users |
| **OSS mirror** | Manual `workflow_dispatch` on `dev` | Single squashed public mirror commit | Public source mirror |

Both channels build for:
- macOS arm64 and x64
- Windows x64
- Linux x64 (manual download only, no auto-update)

> **Note:** Tags do NOT trigger releases. Stable releases run on pushes to `main`; beta releases are opt-in from `dev` via `[deploy-beta]` (or manual dispatch).


## How builds are triggered

### Beta builds (opt-in)

Beta builds are intentionally gated to reduce Actions spend. A push to `dev` only triggers a beta release when at least one commit's **subject line** includes `[deploy-beta]`.

Flow:
- `.github/workflows/beta-deploy-trigger.yml` watches `dev` pushes
- If `[deploy-beta]` is present, it triggers `.github/workflows/release.yml` on `dev`
- `release.yml` computes the numeric beta version and publishes to beta buckets

> **Marker detection is subject-line-only (2026-06-19).** `[deploy-beta]` / `[skip-tests]`-style commit markers are matched against the commit **subject** line only — never the body — so a prose mention in a commit body cannot trigger a real beta deploy (or skip tests in `.husky/pre-push`). `beta-deploy-trigger.yml` reads `split("\n")[0]` of each pushed commit message; an anti-rot guard (`scripts/check-commit-marker-detection.ts`, batched into `validate:fast`) locks this in across the workflow + `.husky/pre-push`, so a "simplification" back to whole-message matching fails the gate.

Behavior:

- Version gets a numeric patch from commit count (e.g., `0.3.63289`) — no `-beta` suffix due to Squirrel.Windows constraints
- App is named "Mindstone Rebel Beta" with separate bundle ID
- Uploads to `gs://mindstone-rebel/updates-beta/` for auto-updates
- Beta and stable apps can coexist on the same machine

**You do NOT need to bump `package.json` for beta releases** — the version suffix is auto-generated from commit count.

If you want to force a beta build without adding `[deploy-beta]`, run **Release Build and Publish** manually on the `dev` branch from GitHub Actions.

### Stable builds (merge to main)

When you merge `dev` → `main`:

- The `setup` job validates that `rebel-system/help-for-humans/changelog.md` contains a `## v<version>` heading matching `package.json`. If missing, the pipeline fails immediately — **before any platform builds start** — saving ~15-20 minutes of compute.
- CI builds using exactly what's in `package.json` (e.g., `0.2.27`)
- Uploads to `gs://mindstone-rebel/updates/` for auto-updates
- Generates download manifests at `releases/latest.json`

**Important:** You MUST bump the version in `package.json` **and** update the changelog before merging if you want users to receive an update. See [RELEASING](./RELEASING.md) for the full process.

#### How `main` is advanced (two paths)

Pushing/advancing `main` is what triggers a stable build. There are two sanctioned ways to do it; both keep the explicit human gate:

- **CI-triggered promote (preferred for promoting a beta-certified SHA).** `scripts/promote-to-production.ts` (the `/promote-to-production` command) fast-forwards `main` to the certified SHA via a plain FF `git push`, which auto-triggers the stable build here — concurrency-safe, with a fail-closed pre-flight + hard human checkpoint before it touches `main`. The phased zero-touch chain (`docs/plans/260619_ci-triggered-promote/PLAN.md`) keeps a human final tap for now. Mechanism (the FF-push refspec, certified pre-push) lives in [PROMOTE_BETA_TO_PRODUCTION](./PROMOTE_BETA_TO_PRODUCTION.md) §5; why it's a `git push` and not a refs-API PATCH, plus who may write `main`, in [RELEASE_TO_PRODUCTION](./RELEASE_TO_PRODUCTION.md) (policy + [§ Who can push to stable](./RELEASE_TO_PRODUCTION.md#who-can-push-to-stable-branch-protection)). **Do not restate the mechanism here.**
- **Local push primitive (non-CI alternative, two modes).** `scripts/release-to-production.ts --commit <sha>` is the **promote-fallback** (ships the frozen, beta-certified tree; [PROMOTE_BETA_TO_PRODUCTION §5.1](./PROMOTE_BETA_TO_PRODUCTION.md)); **bare** `release-to-production.ts` is the **emergency direct cut** (ships latest `dev`, never beta-tested; [RELEASE_TO_PRODUCTION § Emergency escape hatch](./RELEASE_TO_PRODUCTION.md#emergency-escape-hatch--direct-cut-to-stable)).

### CLI standalone binary (opt-in)

The standalone Node `rebel` binary (`@mindstone/rebel-cli`) is published to npm as part of a stable release. Publishing is gated by `[deploy-cli]` in a commit message on push to `main`.

Flow:
- `.github/workflows/release.yml` (or the publish sub-job) checks for `[deploy-cli]` in any commit in the push
- If present, the `publish-rebel-cli-npm` job builds the bundle, runs smoke tests, and publishes with `npm publish --provenance`
- npm provenance is attested via GitHub OIDC trusted publishing (no long-lived npm tokens in CI secrets)

Behavior:
- Package: `@mindstone/rebel-cli` on the public npm registry
- Version matches `package.json` version at push time
- Includes `engines.node >=20` declaration
- Super-MCP npx fallback is pinned to a specific version (no `@latest` at runtime)

**You do NOT need to bump `package.json` for CLI publishes** — the version comes from the superproject's `package.json` at push time.

```bash
# Example commit triggering both stable app release AND npm CLI publish:
git commit -m "feat: add session export [deploy-cli]"
git push origin main
```

If you want to publish the CLI without a full app release, run the **Release Build and Publish** workflow manually on `main` with `[deploy-cli]` in a commit message.


## Branch rules and safety

The CI pipeline enforces strict branch rules:

| Branch | Can publish to |
|--------|----------------|
| `main` | Stable channel only |
| `dev` | Beta channel only |
| Feature branches | ❌ Cannot release (will error) |
| Tags | ❌ Do not trigger releases |

This prevents accidental production releases from non-main branches.

## OSS mirror publish

Workflow: `.github/workflows/mirror-publish.yml`

The OSS mirror publish flow is manual-only until launch. It runs in two trust zones: an unprivileged build/scan job with `contents: read`, then an environment-gated publish job that re-attests the downloaded mirror artifact before loading push credentials.

The reusable gate workflow is `.github/workflows/reusable-mirror-validation.yml`. It runs the mirror transform, `validate:fast`, drift checks, OSS-surface checks, mirror-output validation, TruffleHog scans, public install smoke, and records the expected content digest/file count artifacts consumed by the publish job. The artifact crossing from the unprivileged job to the privileged job is worktree-only; `.git` is deliberately excluded and the publish job recreates git state with an empty template and hooks disabled before committing.

**OSS boot-smoke gate (Linux, fail-closed — 2026-06-23).** A `boot-smoke` job in the reusable workflow builds the faithful transformed-mirror FORGE bundle and **launches** it on headless Linux (`ubuntu-22.04`, xvfb), asserting the main process boots past bootstrap. It runs **parallel** to `validate`/`test`/`test-rest` and feeds the fail-closed `gate` aggregation: a skipped/failed/cancelled boot-smoke forces `gates_passed=false`, so a boot-crashing OSS build (the `import_time_boundary_read_bootstrap_crash` class — "the app won't even start") cannot publish. The job is fast (~3.5 min, well under the other gate jobs' wall-clock → effectively free in elapsed time). It is implemented via the composite action `.github/actions/oss-boot-smoke-linux/action.yml`, also reused by the standalone manual `.github/workflows/oss-boot-smoke.yml`. This Linux/mirror gate is **distinct from** `release.yml`'s macOS `Desktop Boot Smoke` (the non-blocking diagnostic on the *commercial* packaged app). Full wiring, the local repro command (`npm run validate:oss-boot-smoke`), and the out-of-scope note (Linux deliberately does not catch native-module-at-import issues): [OSS_BUILD_SMOKE_RUNBOOK § CI wiring](./OSS_BUILD_SMOKE_RUNBOOK.md).

Dry runs must resolve to the throwaway repository; the workflow fails before push if the throwaway destination resolves to the production repository.

TruffleHog configuration is split by responsibility. The workflow invokes TruffleHog with native arguments only (`--results=verified --fail`, plus a future native `--exclude-paths` file). Stage 11 must emit `.trufflehog-exclude-paths.txt` for TruffleHog-native path exclusions and separately maintain `.trufflehog-public-allowlist.yaml` as Rebel's `kind:`-classified validator input for `scripts/check-trufflehog-public-allowlist.ts`; that Rebel allowlist is not passed to TruffleHog as `--config`.

Rollback is gated on the classified remote state, not just the local push step result. If a push failed locally but the remote already matches the expected mirror commit, later verification failures still trigger rollback. When `oss-mirror-lkg` exists, rollback force-with-lease restores that commit. On the first bootstrap run, if no LKG exists and post-push verification fails, rollback deletes the remote mirror branch; production bootstraps require either a pre-existing LKG or a separately approved first-run exception.


## Reusable validation workflow

Workflow: `.github/workflows/reusable-validation.yml`

Both `dev-checks.yml` and `release.yml` call this single reusable workflow for static validation and unit tests. This ensures both pipelines run **identical** checks — adding or removing a validation step only requires editing one file.

**Inputs:**
| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `node-version` | string | (required) | Node.js version for setup-node |
| `use-retry` | boolean | `false` | Wrap `npm ci` in `nick-fields/retry` (for release reliability) |

**Checks run:** `validate:fast` (lint, TS ratchet, IPC, store versions, circular deps, MCP bundles, MCP lockfiles, core imports, settings, and more — see `package.json` for the full chain) + unit tests (desktop + evals projects).

**Node version:** Both callers use Node 20 (matching the release build environment) to avoid "passes on dev, fails on release" divergence.

**Windows install-step exception (2026-06-14):** the Windows build job in `release.yml` runs `npm ci` on **Node 22** (via `WINDOWS_BUILD_NODE_VERSION`) for the install step only, then restores Node 20 for the build runtime — `better-sqlite3` (a devDependency, post–Electron-42/Node-24 upgrade) ships no win32-x64 prebuild for Node 20, so a Node-20 `npm ci` falls back to a source build the runner can't complete. Don't widen this to the whole Windows job; only `npm ci` needs Node 22. See [CI_WORKFLOW_GOTCHAS § 4](CI_WORKFLOW_GOTCHAS.md) and `docs/plans/260614_ci-release-robustness/`.


## Desktop dev checks (fast validation)

Workflow: `.github/workflows/dev-checks.yml`

- **Triggers**: Push to `dev` **and** pull requests — when desktop-relevant paths change (`src/**`, `config/**`, `packages/**`, `scripts/**`, `evals/**`, config files, workflow files)
- **Calls**: `reusable-validation.yml` (Node 22, no retry) + a separate `knip-health` job for dead file detection
- **Concurrency**: Cancels in-progress runs on the same ref to avoid stale run accumulation
- **Runner**: `ubuntu-latest`, ~5-8 min
- **Purpose**: Catches lint errors, type regressions, IPC mismatches, circular deps, dead files, and test failures on every push to `dev` and on PRs — before they reach a release build.


## Release validation gate

The release pipeline (`release.yml`) calls `reusable-validation.yml` (Node 20, with retry) before all platform builds. This ensures hotfixes pushed directly to `main` — which bypass dev-checks — still pass static validation and unit tests before any build artifacts are produced. Failures also trigger Slack notifications via `notify-build-failure`.

- **Job**: `validate-and-test` (calls reusable-validation.yml)
- **Blocks**: All platform build jobs (`build-macos`, `build-linux`, `build-windows`)
- **Notifications**: Validation failures are reported to Slack alongside build failures


## CI coverage matrix

Key checks and where they run. For the full list of checks in `validate:fast`, see the script chain in `package.json`.

| Check | dev-checks (dev push + PR) | release.yml (main + beta) | cloud-ci | build-cloud |
|-------|:-:|:-:|:-:|:-:|
| ESLint (zero warnings) | Y | Y | - | - |
| TS error ratchet | Y | Y | - | - |
| IPC contracts | Y | Y | - | - |
| Store versions | Y | Y | - | - |
| Circular deps | Y | Y | - | - |
| MCP bundle schemas | Y | Y | - | - |
| MCP lockfiles | Y | Y | - | - |
| Core import boundary | Y | Y | - | - |
| Settings search sync | Y | Y | - | - |
| Desktop unit tests | Y | Y | - | - |
| Evals unit tests | Y | Y | - | - |
| Knip unused files | Y | - | - | - |
| Cloud-service build | - | - | Y | Y |
| Cloud-service tests | - | - | Y | - |
| Cloud-client tests | - | - | Y | - |
| Cloud-client E2E | - | - | Y* | - |
| Docker smoke test | - | - | - | Y |
| MCP smoke tests | - | Y | - | - |
| MCP integration tests | - | Y | - | - |
| Electron build | - | Y | - | - |
| Desktop boot-smoke (macOS) | - | Y‡ | - | - |
| E2E tests (macOS) | - | Y** | - | - |
| Perf regression tests | - | Y** | - | - |
| Real-boot agent-turn (`test:realboot`) | - | Y† | - | - |
| Code signing | - | Y | - | - |

*\* `continue-on-error: true` — failures don't block*
*\*\* E2E runs but does not yet block publishing (pending stability gate — see below)*
*† `realboot` job — runs on BOTH channels **OBSERVE-FIRST** (visible but NOT yet in `publish-to-gcs.needs`; flip to gating once proven green in CI); see [§ E2E gating criteria](#e2e-gating-criteria)*
*‡ `boot-smoke` job — **BLOCKS publish on BOTH channels** (in `publish-to-gcs.needs`, no `continue-on-error` since 2026-06-23); darwin-only; see [§ E2E gating criteria](#e2e-gating-criteria)*

> **Run the `cloud-ci` lane locally:** `npm run test:cloud:ci-local` mirrors the cloud-ci jobs (cloud-service build + `--project=cloud-service` tests + cloud-client unit/e2e) in ~25s (CI takes ~8.5 min, almost all cold `npm ci`). Worth knowing because `cloud-ci` is **neither on the release-publish path nor a required check**, so it can rot red on `dev` unnoticed (a *detector outage*). See [RELEASE_TO_BETA § 5.1](RELEASE_TO_BETA.md) (pre-push de-risk, cloud-path pushes) and [DAILY_AUTOMATED_REVIEW § A](DAILY_AUTOMATED_REVIEW.md) (daily green check + the prolonged-red alerting options under Gaps). **Caveat:** the local run has the `rebel-system` submodule present, so it can't reproduce the *submodule-absence* failure class — only `cloud-ci` itself can.

### E2E gating criteria

Two E2E jobs run in the beta release pipeline and gate publish **differently**:

- **`chronic-e2e-staleness` ("Chronic E2E Staleness Gate (macOS)") — BLOCKS beta publish in CI.** It's in `publish-to-gcs.needs` and enforcing since **2026-06-12** (rollback = re-add job-level `continue-on-error: true`), so a failure **skips `publish-to-gcs` — no beta artifact ships.** It runs a small fixed subset of historically-stale packaged specs — the spec list is single-sourced in the `test:e2e:chronic` npm script; the job/step gating lives in `release.yml`'s `chronic-e2e-staleness` job. On **stable**, its beta-only steps skip (cheap no-op), so it doesn't gate stable. **Local gate is different:** chronic E2E is **not** in `.husky/pre-push` / `npm run gate` (see [PREPUSH_GATE_AND_RECEIPTS](./PREPUSH_GATE_AND_RECEIPTS.md) — merge-integrity, submodule-availability, `validate:fast`, tiered vitest only). For beta pushes it is **runbook-mandatory** in [RELEASE_TO_BETA](./RELEASE_TO_BETA.md) §5.1: run `npm run test:e2e:chronic` locally after boot-smoke (reuses the packaged `out/` build); same script, not the husky hook. Background: `docs-private/postmortems/260607_update_three_stale_chronic_failing_specs_ab4822a_postmortem.md`.
- **Full `test-e2e` ("E2E Tests (macOS)") — does NOT yet block publish.** It runs but isn't in `publish-to-gcs.needs`; a non-chronic spec failure reds the run while the artifact still publishes (terminal state `published_with_test_flakes`). The promotion bar (≥95% clean-green) is in [§ E2E flake policy & gate-readiness](#e2e-flake-policy--gate-readiness) below. Track at: GitHub Actions → "Release Build and Publish" → filter by `test-e2e`.

Two more publish gates are **not** E2E but live here for proximity:

- **`boot-smoke` ("Desktop Boot Smoke (macOS)") — BLOCKS publish on BOTH channels in CI.** Promoted from advisory (`continue-on-error: true`, diagnostic-only) to enforcing on **2026-06-23**: it's in `publish-to-gcs.needs` and has no `continue-on-error`, so a packaged macOS app that fails to boot fails the job and **skips `publish-to-gcs` — no artifact ships** (beta or stable). It launches the already-packaged `.app` via Playwright and asserts `appReady` (plus the fsevents-interception + PDF sub-gates) — the single thing unit tests structurally cannot check: does the real bundled artifact boot? Catches the dominant packaged-boot crash class (bundling/minify, files-not-copied, `@core`/`@shared` alias not rewritten, missing native modules), all of which are deterministic. **Darwin-only** (`runs-on: macos-latest`, desktop scope) — there is no Windows/Linux boot-smoke; "blocking-on-darwin" is the whole job. Runs on both channels with **no job-level `if:`**, so — like `realboot` — it must NEVER get one (cascade-skip trap: a skipped needed job silently kills `publish-to-gcs`). The smoke step has a bounded 2-attempt retry for infra-flake tolerance (deterministic boot breakage fails both attempts, so masking risk is low). **Promotion evidence:** 12/12 consecutive green step conclusions in CI (2026-06-13 → 06-23), exceeding the "≥3 clean runs" bar used for the `chronic-e2e-staleness` flip. **Rollback (one line each):** re-add job-level `continue-on-error: true` AND remove `boot-smoke` from `publish-to-gcs.needs`. The local pre-push equivalent (`npm run preflight:desktop-packaged-boot`) remains runbook-mandatory in [RELEASE_TO_BETA](./RELEASE_TO_BETA.md) §5.1. See `docs/plans/260623_boot-smoke-blocking-gate/PLAN.md`.
- **`realboot` ("Real-Boot Agent-Turn") — runs on BOTH channels, currently OBSERVE-FIRST (NOT yet a publish gate).** It runs `npm run test:realboot` (a source-level vitest, not a packaged build — boots the real agent-turn service graph stubbing only the provider HTTP boundary) on beta AND stable with **no channel `if:`**, so it's visible on every release run. It is **NOT yet in `publish-to-gcs.needs`** — a gate that has never run in CI shouldn't block a release on its first exercise. **Flip it to a publish gate by adding `realboot` to `publish-to-gcs.needs` once it has passed green in CI over a few real runs.** **Why it runs on both channels:** the CI-triggered promote (`docs/plans/260619_ci-triggered-promote/PLAN.md`, Stage 3) advances `main` via a fast-forward `git push`. That push *does* run `.husky/pre-push` (the certified-promote path runs `realboot` locally) — but that local run is on the **promoter's machine**, not a CI gate, and the planned Phase-2 off-laptop path (a GitHub App token) runs **no** local hook at all. So `realboot` must run in CI on **both** channels: the beta CI run is the authoritative certification ("beta already certified it" has to be true *in CI*, not just on someone's laptop), and the stable re-run re-certifies on the stable channel — which is where this suite would otherwise never run. If it gated stable-only, the beta could never have run realboot in CI, so the "beta already certified it" claim the promote relies on would be hollow. Unlike `chronic-e2e-staleness` (which uses beta-only step-level `if:`s to stay a cheap no-op on stable), `realboot` does real work on both channels — so it has **no** job-level or step-level channel `if:`. **Do not add a job-level `if:` to it** (or any `publish-to-gcs` dependency): a skipped needed job cascade-skips `publish-to-gcs`, which has no overriding `if:`, silently killing publishes — the same trap documented on `chronic-e2e-staleness`. Fast (~seconds), deterministic cold-boot assert (soaked 50/50 green as a pre-push gate), so the flake concern that keeps `test-e2e` non-gating doesn't apply.

Before promoting any E2E job into `publish-to-gcs.needs`, require that stability evidence and document a demotion protocol (re-add `continue-on-error: true`) for temporarily lifting the gate.

### E2E flake policy & gate-readiness

The macOS `test-e2e` job runs `retries: 1` on CI (`playwright.config.ts`), which collapses the "a ~1% per-spec flake reds a monolithic ~115-spec × 1-worker job ~30% of the time" arithmetic. retries:1 (not 2) is deliberate: a single retry already kills the arithmetic, while a real regression — which fails *both* attempts — still surfaces as red fastest. Retries are a **net, not a cure**: the count shrinks as root-cause fixes land, and "passed only on retry" must be *tracked*, not silently greened. The `E2E flake summary` step (`scripts/ci/summarize-e2e-results.ts`) classifies every spec from the Playwright JSON report and surfaces the flaky set to the run summary + the release Slack thread. Intent + design: [`docs/plans/260617_deflake-ci-for-blocking-gates/PLAN.md`](../plans/260617_deflake-ci-for-blocking-gates/PLAN.md).

**Per-run verdict (the quantified escalation predicate):**

| Verdict | Condition | Counts toward green streak? | Action |
| --- | --- | --- | --- |
| **clean green** | 0 unexpected + 0 flaky | Yes | — |
| **shippable-but-flaky** | 0 unexpected + ≥1 flaky (passed only on retry) | **No** | Ticket each flaky spec |
| **red** | ≥1 unexpected (failed all attempts) | No | Real regression — fix |

**Rolling escalation:** a spec that goes flaky on **≥2 of the last 5** release runs is quarantined/ticketed (it is a suspected emerging flake, not noise) — so "tracked, not swallowed" has teeth and never degrades into a dashboard nobody reads.

**Gate-ready** (when `test-e2e` may be promoted into `publish-to-gcs.needs` — the sibling `release_outcome_observability` / `release-process-hardening` plans own the actual flip): **≥95% clean-green over 10+ runs AND no spec flaky on ≥2 of the last 5 runs**. The "consecutive green" criterion is measured against the *clean-green* verdict (not a bare green conclusion that silently retried every time) — otherwise retries would mask the very flakiness the gate is meant to exclude. This matches the `release.yml` `test-e2e` gate TODO.

**Deprecation:** retries:1 is a band-aid shipped *with* observability + this predicate (per the team's "a band-aid over an unproven root cause ships observability + deprecation criteria" principle). It is expected to matter less over time as Stage-2 root-cause cures (state-driven waits replacing timing sleeps) shrink the flaky set toward zero; revisit removing it once the flake-rate signal sits at clean-green.


## GCS bucket structure

```
gs://mindstone-rebel/
├── updates/                    # Stable auto-updates
│   ├── darwin/{arm64,x64}/     # RELEASES.json + ZIPs
│   └── win32/x64/              # RELEASES + nupkg
├── updates-beta/               # Beta auto-updates (same structure)
├── releases/                   # Stable download manifests
│   ├── latest.json
│   └── {version}/
│       └── manifest.json
└── releases-beta/              # Beta download manifests
```

### Public changelog access

Each stable release uploads `rebel-system/help-for-humans/changelog.md` to
`gs://mindstone-rebel/releases/changelog.md` (a single canonical URL). External consumers
(website, email cron) fetch `https://storage.googleapis.com/mindstone-rebel/releases/changelog.md`.
The file uses `Cache-Control: no-cache, no-store` so it is always fresh.


## Manual workflow dispatch

You can trigger builds manually via GitHub Actions:

1. Go to Actions → "Release Build and Publish"
2. Click "Run workflow"
3. Select branch: `main` for stable, `dev` for beta

**Important:** Only `main` and `dev` branches can be built. Attempting to trigger from other branches will fail with an error.


## Related CI workflows

### Daily UI Smoke Test

Workflow: `.github/workflows/ui-smoke-test.yml`

- Runs scheduled weekday UI smoke checks (or manual dispatch)
- Uses structured JSON assertions for step-level pass/fail reporting
- Captures screenshots automatically on failures (`take_screenshot`) for debugging

### Mobile CI

Mobile builds use Expo EAS (Expo Application Services) and run on `ubuntu-latest`. See [MOBILE_OVERVIEW.md](MOBILE_OVERVIEW.md) for full mobile architecture, and [RELEASE_TO_MOBILE.md](RELEASE_TO_MOBILE.md) for the release runbook (watch/diagnose, credentials, bundle gotchas).

#### Preview builds (auto-trigger)

Workflow: `.github/workflows/mobile-preview.yml` ("Mobile TestFlight Deploy")

- **Triggers**: Push to `dev` or `main` when paths change: `mobile/**`, `cloud-client/**`, `packages/shared/**`. Also supports manual `workflow_dispatch`. **Note**: the broad `src/core/**` and `src/shared/**` paths are deliberately excluded — they are core/cloud business logic touched by nearly every commit, which previously made this deploy fire on almost every push. A core/shared change that needs to reach mobile is shipped via manual `workflow_dispatch`. (Cloud, by contrast, *does* build on `src/core/**` changes via `build-cloud.yml`.)
- **Jobs**:
  - `build-ios` — Builds production iOS via `eas build`, submits to TestFlight via `eas submit`. On `main` branch, also assigns the build to the "External Beta" TestFlight group via App Store Connect API.
  - `build-android` — Builds production Android via `eas build`. Submits to the Google Play `alpha` track via `eas submit` when `GOOGLE_SERVICE_ACCOUNT_KEY` secret is configured; skips submission otherwise.
  - `notify` — Posts build status to associated PR (if any) and sends Slack notification.
- **Concurrency**: One build per branch (`mobile-testflight-{ref}`), cancels in-progress.

#### Production builds (manual dispatch)

Workflow: `.github/workflows/mobile-production.yml` ("Mobile Production Deploy")

- **Triggers**: Manual `workflow_dispatch` only, with a `platform` input (`all`, `ios`, or `android`).
- **Jobs**:
  - `build-ios` — Builds production iOS + submits to TestFlight.
  - `build-android` — Builds production Android + submits to Google Play when `GOOGLE_SERVICE_ACCOUNT_KEY` is configured.
  - `notify` — Slack notification with build results.
- **Concurrency**: `mobile-production` group, does NOT cancel in-progress (to avoid interrupting a deliberate production submit).

#### Runtime integrity

Workflow: `.github/workflows/mobile-runtime-integrity.yml`

- Verifies Expo runtime integrity and runs mobile unit tests.
- Also runs a `production-bundle-smoke` job — a production-mode `expo export` that catches Node-only / `import.meta` leaks into the RN bundle (which the dev-mode integrity check tolerates but the EAS production Hermes build rejects).

### Cloud service image build

Workflow: `.github/workflows/build-cloud.yml`

- Triggers on cloud-relevant paths, including `cloud-client/**`
- Builds the Docker image and runs a `/api/health` smoke test before push
- Publishes validated images to GHCR (`ghcr.io/mindstone/rebel-cloud`)


## Build steps

Each CI job runs these main steps:
1. **Checkout** — clone repo with submodules
2. **Setup Node** — install Node.js 20
3. **Install dependencies** — `npm ci` (wrapped in `nick-fields/retry@v3` with 3 attempts, 20s backoff, 15min timeout to handle transient network failures)
4. **Build bundled MCPs** — runs `node scripts/build-bundled-mcps.mjs` to compile TypeScript MCP servers in `resources/mcp/`
5. **Prebuild** — bundles Node runtime for the target architecture
6. **Build** — compiles main/preload/renderer
7. **Package/Make** — creates installers for the target platform
8. **Upload** — pushes artifacts to GCS


## Build times

Typical build times:
- Full CI build: ~15-20 minutes
- Includes: TypeScript compilation, bundled MCP builds, packaging for all platforms, upload to GCS


## Checking build status

- **GitHub Actions**: https://github.com/mindstone/rebel-app/actions
- **Live versions**:
  ```bash
  # Production (stable):
  curl -s https://storage.googleapis.com/mindstone-rebel/releases/latest.json | jq .version

  # Beta:
  curl -s https://storage.googleapis.com/mindstone-rebel/releases-beta/latest.json | jq .version
  ```
