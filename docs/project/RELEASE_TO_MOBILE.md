---
description: "Runbook for the mobile (iOS + Android) release pipeline — Expo EAS builds, TestFlight/Play submission, credentials, watch/diagnose, and the Hermes bundle gotchas behind the 2026-06 outage"
last_updated: "2026-06-22"
---

# Release to Mobile

> **Goal:** make the mobile (iOS + Android) release pipeline legible and recoverable. This is the durable home for how a mobile build is triggered, built, submitted, watched, and diagnosed — and for the gotchas that caused a real 5-day outage so the next person doesn't rediscover them the hard way.

This is a **runbook**, executed by an agent or a human. There is no `/release-to-mobile` slash command. One doc covers both platforms because **one shared Expo EAS pipeline builds both** — the iOS and Android jobs differ only in submit target. If a platform section grows large enough to warrant its own runbook, split it then (e.g. `RELEASE_TO_IOS.md` / `RELEASE_TO_ANDROID.md`); until then, keep it here.

> **Mobile is a separate pipeline, not part of the desktop beta.** [`RELEASE_TO_BETA.md`](RELEASE_TO_BETA.md) governs the desktop `release.yml` flow (GCS-hosted auto-update). Mobile ships via Expo EAS to TestFlight / Google Play — different infrastructure, different gates, different credentials. Don't conflate them.

## See also

- [BUILD_AND_RELEASE_OVERVIEW.md](BUILD_AND_RELEASE_OVERVIEW.md) — the release territory hub; start there for anything build/release-shaped.
- [RELEASE_TO_BETA.md](RELEASE_TO_BETA.md) — the **desktop** sibling (separate pipeline — see the note above).
- [CI_PIPELINE.md § Mobile CI](CI_PIPELINE.md#mobile-ci) — the canonical workflow/trigger description these docs both signpost.
- [MOBILE_OVERVIEW.md](MOBILE_OVERVIEW.md) — mobile architecture, cloud continuity, code-reuse layering.
- [MOBILE_QA.md](MOBILE_QA.md) — mobile E2E (Maestro flows), pairing gotchas, the three-lane test model.
- [MOBILE_TELEMETRY_KEYS.md](MOBILE_TELEMETRY_KEYS.md) — **SSOT** for the GitHub-secrets → EAS-env telemetry key sync.
- [MOBILE_IOS_CREDENTIALS.md](MOBILE_IOS_CREDENTIALS.md) — iOS App Store Connect API key setup.
- [`mobile/AGENTS.md`](../../mobile/AGENTS.md) — hard rules for the React Native surface (business logic belongs in `src/core/` / `cloud-client/`, not here).
- [`docs/plans/260622_mobile-pipeline-recovery/PLAN.md`](../plans/260622_mobile-pipeline-recovery/PLAN.md) — the incident write-up behind the gotchas in §5 (the `import.meta` / Hermes bundle break, the detection-gap fix).

---

## 1. How mobile releases work

Mobile builds use **Expo EAS** (Expo Application Services). The key fact that shapes everything else: **the actual app build runs off the GitHub runner, on Expo's servers.** The GitHub Actions job only invokes `eas build` / `eas submit`; the compile, the JavaScript bundle, and the native packaging happen remotely. Consequences:

- GitHub Actions secrets do **not** automatically reach the EAS build. Telemetry keys are bridged into the EAS environment by a prerequisite job (`sync-eas-telemetry-env`, see §3).
- Bundle failures (the "Bundle JavaScript" phase) surface on the **Expo dashboard** ([expo.dev](https://expo.dev)), not fully in the GitHub Actions log (see §4).

There are two release workflows plus two supporting checks.

### `mobile-preview.yml` — "Mobile TestFlight Deploy" (auto-trigger)

The everyday pipeline. **Auto-triggers** on push to `dev` or `main` when paths under `mobile/**`, `cloud-client/**`, or `packages/shared/**` change — and on manual `workflow_dispatch`. **It deliberately EXCLUDES `src/core/**` and `src/shared/**`** (those are touched by nearly every commit and would fire this expensive build constantly). That exclusion is also a known trap — see §5, gotcha 2.

Jobs (`.github/workflows/mobile-preview.yml`):

1. **`sync-eas-telemetry-env`** — pushes the 4 telemetry keys into the EAS `production` environment (prerequisite for both builds; §3).
2. **`build-ios`** — `eas build --profile production --platform ios` → `eas submit` to **TestFlight** (App Store Connect app id `6760136915`). On `main`, additionally assigns the build to the **"External Beta"** TestFlight group via the ASC API (`scripts/ci/assign-testflight-group.mjs`).
3. **`build-android`** — `eas build --profile production --platform android` → `eas submit` to the Google Play **`alpha`** track.
4. **`notify`** (`if: always()`) — comments build links on the associated PR (if any) and posts a Slack message via `scripts/ci/slack-notify.sh`.

`build-ios` and `build-android` run in parallel; each has a 45-minute timeout. Concurrency is one build per branch (`mobile-testflight-{ref}`, cancel-in-progress).

### `mobile-production.yml` — "Mobile Production Deploy" (manual only)

A **manual `workflow_dispatch`-only** store-release gate, with a `platform` input (`all` / `ios` / `android`). **It has never been run** — treat it as un-field-tested: the first real dispatch is itself a test, so watch it closely and expect to debug. To dispatch:

```bash
gh workflow run mobile-production.yml --ref main -f platform=all   # or ios / android
```

(or via the GitHub Actions UI → "Mobile Production Deploy" → Run workflow). Same `sync-eas-telemetry-env` prerequisite, same `eas build … --profile production` + `eas submit` shape as preview; the `build-ios` / `build-android` jobs are gated on the `platform` input. Its `notify` posts a Slack webhook; if `SLACK_WEBHOOK` is unset or the post fails it emits an **observable `::warning::`/`::error::` GitHub annotation** in the run but never blocks the deploy (see §6).

### Supporting checks

- **`mobile-runtime-integrity.yml`** — Metro runtime-integrity + mobile unit tests. Runs on PRs and pushes touching `mobile/**`, `cloud-client/**`, `packages/shared/**`, **`src/shared/**`, `src/core/**`** (note: this one *does* cover the core/shared paths `mobile-preview.yml` excludes). This is the fast PR-time gate and the primary backstop against the §5 bundle-break class.
- **`mobile-e2e.yml`** — deterministic Maestro E2E lane. **Authored but not yet exercised end-to-end in CI** (no Android SDK in the current environment); allowed-to-fail until median runtime + flake rate are known. See [MOBILE_QA.md](MOBILE_QA.md) for the three-lane model.

## 2. EAS configuration

- **Profiles** (`mobile/eas.json`): `development` / `preview` / `e2e` are `distribution: internal`. **`production`** is what every release build uses: `autoIncrement: true`, EAS `environment: production`, with submit targets — **iOS** `ascAppId: 6760136915`; **Android** `track: alpha`, `releaseStatus: completed`.
- **App config** (`mobile/app.json`): `version` `0.1.0`, `runtimeVersion.policy` `appVersion`, bundle ids `com.mindstone.rebel.mobile` (both iOS `bundleIdentifier` and Android `package`), EAS `projectId` `cd825d37-2dfe-42cf-82bd-888e6c6ee608`, owner `mindstone-learning-limited`.

## 3. Credentials & secrets

| Secret | Used for | SSOT |
|--------|----------|------|
| `EXPO_TOKEN` | Authenticates the runner to EAS (every job) | — |
| `SENTRY_DSN`, `SENTRY_AUTH_TOKEN` | Telemetry + symbolication, synced to EAS `production` env by `sync-eas-telemetry-env` — **required, fail-closed** (empty hard-fails the deploy) | [MOBILE_TELEMETRY_KEYS.md](MOBILE_TELEMETRY_KEYS.md) |
| `RUDDERSTACK_WRITE_KEY`, `RUDDERSTACK_DATA_PLANE_URL` | Analytics, synced to EAS env — **optional** (warn-and-continue; analytics ships inert if absent) | [MOBILE_TELEMETRY_KEYS.md](MOBILE_TELEMETRY_KEYS.md) |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY` | iOS App Store Connect API key (build/submit + External Beta group assignment) | [MOBILE_IOS_CREDENTIALS.md](MOBILE_IOS_CREDENTIALS.md) |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Android Google Play service account (submit) | **No doc yet — gap.** See below. |

**Why the telemetry sync exists:** EAS builds run off-runner, so GitHub secrets don't reach them. `sync-eas-telemetry-env` runs once before the builds and `eas env:create --force`s the keys into the EAS `production` environment. The Sentry keys are fail-closed (a telemetry-dark or unsymbolicated store build is the exact outage to prevent); RudderStack is best-effort. Full process — public-vs-secret classification, rotation, verification: [MOBILE_TELEMETRY_KEYS.md](MOBILE_TELEMETRY_KEYS.md).

> **Gap — no Android credentials doc.** There is an [MOBILE_IOS_CREDENTIALS.md](MOBILE_IOS_CREDENTIALS.md) for the ASC API key, but no equivalent for `GOOGLE_SERVICE_ACCOUNT_KEY` (the Play service account). If you set up or rotate the Android submit credential, that's the moment to write `MOBILE_ANDROID_CREDENTIALS.md` and link it here.

## 4. Watch / diagnose a run

The mobile pipeline is shorter than the desktop beta, but the watch/diagnose discipline is the same: find the run, read which leg failed, and know where the real error lives.

- **Find the run:** `gh run list --workflow mobile-preview.yml --branch dev --limit 5` (swap `mobile-production.yml` / branch as needed). Capture the `<run-id>`.
- **Read the failed leg:** `gh run view <run-id>` shows which job failed (`sync-eas-telemetry-env`, `build-ios`, `build-android`, `notify`). `gh run view <run-id> --log-failed` for the failing step's log.
- **EAS bundle/build errors live on the Expo dashboard.** The GitHub job invokes `eas build` and streams a build URL, but the **"Bundle JavaScript"** failure detail (the §5 gotcha 1 class) and full native build logs are on [expo.dev](https://expo.dev) — open the build URL from the job log (or the PR comment / Slack message) and read the build there. A GitHub job log that just says the build failed is not the whole story.
- **Classify before fixing:** a `sync-eas-telemetry-env` failure is a secrets/scoping problem (§3); an iOS-only failure on an otherwise-healthy run is often the Apple PLA (§5 gotcha 3) or a credential issue; a bundle failure on **both** platforms is almost always a JavaScript-bundle regression (§5 gotcha 1) — reproduce it locally (§5) before touching native config.

## 5. Gotchas (the 2026-06-17 → 22 outage, ~5 days)

The mobile pipeline was red on every run for ~5 days, unnoticed. Two independent root causes (a bundle regression and the iOS PLA), surfaced through a detection gap. Full incident: [`docs/plans/260622_mobile-pipeline-recovery/PLAN.md`](../plans/260622_mobile-pipeline-recovery/PLAN.md).

1. **Hermes can't parse `import.meta` / Node-only code in the RN bundle.** The EAS "Bundle JavaScript" phase uses Hermes + the production transform, which rejects `import.meta`, `createRequire`, and anything pulling `pino` / `node:fs` / `node:module`. `src/core` is core-first and **must be RN-safe**: a Node-only module leaking into the mobile import graph fails the build. (The outage was `src/core/logger.ts` reachable from `expo-router/entry.js`.) **Local repro — the only reliable one:**
   ```bash
   cd mobile && npx expo export --platform android   # and --platform ios
   ```
   This runs the production Hermes transform locally and reproduces the EAS failure. Fix by severing the import edge / putting Node-only mechanics behind a platform boundary — **not** a babel polyfill (that only fixes parsing; `node:fs`/`pino` would fail next, and it hides the boundary violation).

2. **The path-exclusion trap.** Because `mobile-preview.yml` excludes `src/core/**` / `src/shared/**` (§1), a core change that breaks the mobile bundle does **not** trigger a mobile rebuild on its own PR — it surfaces only when a later `mobile/**`-path change forces a build, often days later and attributed to the wrong commit. **Mitigation:** `mobile-runtime-integrity.yml` *does* run on those paths, and carries a production-mode bundle check that catches this class at PR time (added by the 260622 recovery — see the plan). That production-mode check is the structural fix; this doc records *why* it exists. There is now **also** an edit-time `validate:fast` complement — `scripts/check-mobile-core-rn-safety.ts` (`validate:mobile-core-rn-safety`) — that statically walks the mobile-reachable `@core`/`@shared`/cloud-client import graph and flags any path that reaches a Node-only API (`import.meta`/`createRequire`/`pino`/`node:`/bare builtins), catching the leak (including *transitive* ones) in seconds before any bundle runs. The `production-bundle-smoke` CI job remains the authoritative bundle-level backstop; the static check is the faster, edit-time signal.

3. **iOS Apple Program License Agreement (PLA).** An Apple `403` — "Account Holder must agree to the latest Program License Agreement" — blocks all iOS build/submit until the team's **Account Holder** accepts the new agreement in the [Apple Developer portal](https://developer.apple.com/account). This is an **admin action, not code** — no amount of pipeline fixing clears it. Android is unaffected. (In the 260622 incident, iOS was separately blocked on this while Android was blocked on the bundle regression.)

4. **Dev-vs-production bundle divergence.** Dev-mode Metro bundling (`dev=true`) tolerates syntax that production Hermes rejects. So a green dev build / dev-mode integrity check is **not** proof the production EAS build will bundle — only a production-mode export (`expo export`, gotcha 1) reproduces EAS failures. This is exactly why the pre-260622 integrity check (which bundled `dev=true`) passed while every production build errored.

## 6. Monitoring / ownership

Be honest about the state here: **there is currently no documented owner or on-call for the mobile pipeline.** Failure surfaces through:

- **Slack notify** — `mobile-preview.yml` posts via `scripts/ci/slack-notify.sh` (a `notify` job with `if: always()`, so it runs even when builds fail). `mobile-production.yml`'s notify surfaces a missing webhook or a failed post as an **observable `::warning::`/`::error::` GitHub annotation** in the run (visible in the run log) but doesn't block the deploy — don't rely on it as the sole signal.
- **The weekly review** — the human backstop. [WEEKLY_AUTOMATED_REVIEW.md § A](WEEKLY_AUTOMATED_REVIEW.md#a-confirm-green-5-min) now includes a check that the latest `mobile-preview.yml` run on `dev` is green.

The **CI production-bundle check** in `mobile-runtime-integrity.yml` (§5, gotcha 2) is the *primary, fast* detection — it catches the dominant break class at PR time. The weekly review is the slower human backstop for everything else (and for the path-excluded gap). If you find yourself owning a recurring mobile failure, that's the signal to assign a real owner / on-call.
